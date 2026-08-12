/**
 * Face-aware Liquify: the sliders, not the detector.
 *
 * Photoshop's Face-Aware Liquify is two separable things — finding a face, and
 * warping its features. This module is the second. It takes a face **box** and
 * a set of slider values and writes displacements into the ordinary Liquify
 * mesh, so everything downstream (freezing, reconstruct, the single inverse
 * resample, the PSD round trip) works exactly as it already does.
 *
 * **Detection is deliberately absent, and the box is supplied by the caller.**
 * There is no `FaceDetector` in this engine, and a Haar cascade or a landmark
 * regressor is a table of trained coefficients — not something that can be
 * written out from first principles. Inventing numbers would produce a detector
 * that looks implemented and finds nothing, which is worse than not having one:
 * the user would blame their photograph. So the face is placed by hand and can
 * be seeded by a real detector later without any of this changing.
 *
 * The regions inside the box come from facial proportions that are ordinary
 * measured anthropometry rather than model weights — the eye line sits a little
 * above the middle of the head, the mouth about three-quarters down — so they
 * are safe to state plainly and easy to check against any portrait.
 *
 * Nothing is imported from `distort.js`, deliberately: that module imports this
 * one to put the sliders in the Liquify dialog, and a cycle that happens to
 * work because of evaluation order is a trap for whoever edits either file
 * next. The mesh is four lines to build.
 */

/** The Liquify mesh shape, built here so this module imports nothing. */
const MESH_N = 65;

function blankMesh(n = MESH_N) {
  return { n, dx: new Float32Array(n * n), dy: new Float32Array(n * n), frozen: new Float32Array(n * n) };
}

/**
 * Where each feature sits inside a face box, as fractions of its width and
 * height with the origin at the box's top-left.
 *
 * Only the numbers a slider actually needs. They are approximate by nature: a
 * face is not a diagram, and every displacement below falls off smoothly from
 * its centre, so being a few percent out softens the effect rather than moving
 * the wrong thing.
 */
export const FACE_PROPORTIONS = {
  eyeLine: 0.44,        // vertical centre of both eyes
  eyeOffset: 0.21,      // horizontal distance from face centre to each eye
  eyeRadiusX: 0.13,
  eyeRadiusY: 0.075,
  noseTip: 0.62,
  noseRadiusX: 0.11,
  noseRadiusY: 0.12,
  mouthLine: 0.755,
  mouthRadiusX: 0.20,
  mouthRadiusY: 0.085,
  jawLine: 0.86,
  chinLine: 0.98,
  foreheadLine: 0.12,
};

/** Every slider, with the range the dialog offers. All default to 0. */
export const FACE_SLIDERS = [
  { key: 'eyeSize', label: 'Eye Size', group: 'Eyes' },
  { key: 'eyeHeight', label: 'Eye Height', group: 'Eyes' },
  { key: 'eyeWidth', label: 'Eye Width', group: 'Eyes' },
  { key: 'eyeTilt', label: 'Eye Tilt', group: 'Eyes' },
  { key: 'eyeDistance', label: 'Eye Distance', group: 'Eyes' },
  { key: 'noseHeight', label: 'Nose Height', group: 'Nose' },
  { key: 'noseWidth', label: 'Nose Width', group: 'Nose' },
  { key: 'smile', label: 'Smile', group: 'Mouth' },
  { key: 'upperLip', label: 'Upper Lip', group: 'Mouth' },
  { key: 'lowerLip', label: 'Lower Lip', group: 'Mouth' },
  { key: 'mouthWidth', label: 'Mouth Width', group: 'Mouth' },
  { key: 'mouthHeight', label: 'Mouth Height', group: 'Mouth' },
  { key: 'forehead', label: 'Forehead', group: 'Face Shape' },
  { key: 'chinHeight', label: 'Chin Height', group: 'Face Shape' },
  { key: 'jawline', label: 'Jawline', group: 'Face Shape' },
  { key: 'faceWidth', label: 'Face Width', group: 'Face Shape' },
];

export function defaultFaceParams() {
  const out = {};
  for (const s of FACE_SLIDERS) out[s.key] = 0;
  return out;
}

/**
 * A face box centred in an image, as a starting place to drag from.
 *
 * Portrait framing, not a guess at where a face is — a head usually occupies
 * something like half the frame's height and sits above centre. Being a
 * starting position rather than a detection, it is honest for it to be wrong.
 */
export function defaultFaceBox(width, height) {
  const h = Math.min(height * 0.62, width * 0.78);
  const w = h * 0.78;
  return { x: (width - w) / 2, y: height * 0.5 - h * 0.55, width: w, height: h };
}

/** The feature regions implied by a face box, in image pixels. */
export function faceRegions(box) {
  const P = FACE_PROPORTIONS;
  const cx = box.x + box.width / 2;
  const at = (fy) => box.y + box.height * fy;
  const eyeDx = box.width * P.eyeOffset;
  return {
    left: { cx: cx - eyeDx, cy: at(P.eyeLine), rx: box.width * P.eyeRadiusX, ry: box.height * P.eyeRadiusY },
    right: { cx: cx + eyeDx, cy: at(P.eyeLine), rx: box.width * P.eyeRadiusX, ry: box.height * P.eyeRadiusY },
    nose: { cx, cy: at(P.noseTip), rx: box.width * P.noseRadiusX, ry: box.height * P.noseRadiusY },
    mouth: { cx, cy: at(P.mouthLine), rx: box.width * P.mouthRadiusX, ry: box.height * P.mouthRadiusY },
    jaw: { cx, cy: at(P.jawLine), rx: box.width * 0.46, ry: box.height * 0.20 },
    chin: { cx, cy: at(P.chinLine), rx: box.width * 0.24, ry: box.height * 0.12 },
    forehead: { cx, cy: at(P.foreheadLine), rx: box.width * 0.40, ry: box.height * 0.16 },
    face: { cx, cy: box.y + box.height * 0.55, rx: box.width * 0.52, ry: box.height * 0.48 },
  };
}

/**
 * Smooth falloff inside an elliptical region: 1 at the centre, 0 at the edge.
 *
 * Smoothstep rather than a linear ramp, so displacement arrives and leaves with
 * zero gradient. A linear falloff leaves a visible crease at the region
 * boundary, which on a face reads instantly as a retouching artefact.
 */
function falloff(px, py, region) {
  const dx = (px - region.cx) / region.rx;
  const dy = (py - region.cy) / region.ry;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d >= 1) return 0;
  const t = 1 - d;
  return t * t * (3 - 2 * t);
}

/**
 * Write one slider's contribution into the mesh.
 *
 * `fn` returns the displacement in image pixels for a node at (px, py) that is
 * `w` deep into the region. Contributions add, so two sliders touching the same
 * area combine rather than one winning — which is what makes Eye Size and Eye
 * Distance usable together.
 */
function paint(mesh, width, height, region, fn) {
  const n = mesh.n;
  for (let j = 0; j < n; j += 1) {
    const py = (j / (n - 1)) * height;
    for (let i = 0; i < n; i += 1) {
      const px = (i / (n - 1)) * width;
      const w = falloff(px, py, region);
      if (w <= 0) continue;
      const d = fn(px, py, w);
      if (!d) continue;
      const k = j * n + i;
      // Frozen nodes are protected here, at authorship, exactly as the brush
      // tools do it — so a frozen region stays byte-identical.
      const free = 1 - (mesh.frozen ? mesh.frozen[k] : 0);
      if (free <= 0) continue;
      mesh.dx[k] += (d[0] / width) * free;
      mesh.dy[k] += (d[1] / height) * free;
    }
  }
}

/** Scale a slider (-100..100) to a displacement in units of a region radius. */
const amt = (v) => Math.max(-100, Math.min(100, Number(v) || 0)) / 100;

/**
 * Apply the face sliders to a mesh.
 *
 * Rebuilt from zero each time rather than accumulated, because the sliders are
 * absolute settings and not strokes: dragging Smile back to 0 has to undo it
 * exactly, which an accumulating mesh could not do. Any brushwork the user did
 * by hand is preserved by passing it in as `base`.
 *
 * @param {{x,y,width,height}} box the face, in image pixels
 * @param {object} params slider values, -100..100
 * @param {number} width image width
 * @param {number} height image height
 * @param {object} [base] a mesh to add to — usually the hand-painted one
 * @returns {{n,dx,dy,frozen}} a new mesh
 */
export function applyFaceLiquify(box, params, width, height, base = null) {
  const mesh = blankMesh(base ? base.n : MESH_N);
  if (base) {
    mesh.dx.set(base.dx);
    mesh.dy.set(base.dy);
    if (base.frozen) mesh.frozen.set(base.frozen);
  }
  if (!box || !(box.width > 0) || !(box.height > 0)) return mesh;

  const p = params || {};
  const R = faceRegions(box);

  // --- Eyes ---------------------------------------------------------
  for (const [side, eye] of [[-1, R.left], [1, R.right]]) {
    const radial = (px, py, w, gain) => {
      const dx = px - eye.cx, dy = py - eye.cy;
      return [dx * gain * w, dy * gain * w];
    };
    if (p.eyeSize) paint(mesh, width, height, eye, (px, py, w) => radial(px, py, w, amt(p.eyeSize) * 0.35));
    if (p.eyeHeight) {
      paint(mesh, width, height, eye, (px, py, w) => [0, (py - eye.cy) * amt(p.eyeHeight) * 0.45 * w]);
    }
    if (p.eyeWidth) {
      paint(mesh, width, height, eye, (px, py, w) => [(px - eye.cx) * amt(p.eyeWidth) * 0.45 * w, 0]);
    }
    if (p.eyeTilt) {
      // Outer corner up, inner corner down — mirrored, so both eyes tilt the
      // same way as a pair rather than converging.
      paint(mesh, width, height, eye, (px, py, w) => [0, ((px - eye.cx) / eye.rx) * side * amt(p.eyeTilt) * eye.ry * 0.5 * w]);
    }
    if (p.eyeDistance) {
      paint(mesh, width, height, eye, (px, py, w) => [side * amt(p.eyeDistance) * eye.rx * 0.6 * w, 0]);
    }
  }

  // --- Nose ---------------------------------------------------------
  if (p.noseWidth) {
    paint(mesh, width, height, R.nose, (px, py, w) => [(px - R.nose.cx) * amt(p.noseWidth) * 0.5 * w, 0]);
  }
  if (p.noseHeight) {
    paint(mesh, width, height, R.nose, (px, py, w) => [0, (py - R.nose.cy) * amt(p.noseHeight) * 0.5 * w]);
  }

  // --- Mouth --------------------------------------------------------
  if (p.smile) {
    /*
     * A smile lifts the corners, not the whole mouth: the vertical lift is
     * weighted by how far a point is from the centre line, so the middle of the
     * lips barely moves and the corners travel furthest. Lifting uniformly just
     * slides the mouth up the face.
     */
    paint(mesh, width, height, R.mouth, (px, py, w) => {
      const t = Math.abs(px - R.mouth.cx) / R.mouth.rx;
      return [0, -amt(p.smile) * R.mouth.ry * 0.9 * t * w];
    });
  }
  if (p.mouthWidth) {
    paint(mesh, width, height, R.mouth, (px, py, w) => [(px - R.mouth.cx) * amt(p.mouthWidth) * 0.5 * w, 0]);
  }
  if (p.mouthHeight) {
    paint(mesh, width, height, R.mouth, (px, py, w) => [0, (py - R.mouth.cy) * amt(p.mouthHeight) * 0.5 * w]);
  }
  if (p.upperLip) {
    // Only above the mouth's centre line, or "upper lip" moves the lower one too.
    paint(mesh, width, height, R.mouth, (px, py, w) => (py <= R.mouth.cy
      ? [0, -amt(p.upperLip) * R.mouth.ry * 0.6 * w] : null));
  }
  if (p.lowerLip) {
    paint(mesh, width, height, R.mouth, (px, py, w) => (py >= R.mouth.cy
      ? [0, amt(p.lowerLip) * R.mouth.ry * 0.6 * w] : null));
  }

  // --- Face shape ---------------------------------------------------
  if (p.faceWidth) {
    paint(mesh, width, height, R.face, (px, py, w) => [(px - R.face.cx) * amt(p.faceWidth) * 0.30 * w, 0]);
  }
  if (p.jawline) {
    paint(mesh, width, height, R.jaw, (px, py, w) => [-(px - R.jaw.cx) * amt(p.jawline) * 0.35 * w, 0]);
  }
  if (p.chinHeight) {
    paint(mesh, width, height, R.chin, (px, py, w) => [0, amt(p.chinHeight) * R.chin.ry * 0.7 * w]);
  }
  if (p.forehead) {
    paint(mesh, width, height, R.forehead, (px, py, w) => [0, -amt(p.forehead) * R.forehead.ry * 0.7 * w]);
  }

  return mesh;
}

/** True when every slider is at rest. */
export function faceParamsAreNeutral(params) {
  if (!params) return true;
  return FACE_SLIDERS.every((s) => !Number(params[s.key]));
}
