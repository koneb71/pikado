import { suite } from '../harness.js';
import {
  LIQUIFY_TOOLS, createLiquifyMesh, liquifyMeshIsEmpty, liquifyDab, applyLiquifyMesh,
} from '/src/filters/distort.js';

/**
 * Liquify.
 *
 * Liquify is not an ordinary filter: the dialog paints into a displacement mesh
 * and only the mesh gets applied, so "does it work" splits into two questions —
 * does each tool write the mesh it should, and does the mesh push pixels the way
 * the tool's name promises. Both are tested here, because a mesh that fills with
 * plausible numbers pointing the wrong way looks fine in a unit test and wrong
 * on screen.
 *
 * Two traps cost real time when these were written, so they are spelt out:
 *
 *  - `liquifyDab(mesh, o)` takes `u`/`v` as **normalised** brush centre, `radius`
 *    in **image pixels**, and `pressure`/`density` in **0..1**. Passing pixels
 *    and 0..100 (the units the dialog's sliders show) makes `o.u` undefined, the
 *    loop bounds NaN, and every assertion fail while the code is perfectly fine.
 *  - a ring is rotationally symmetric, so twirling one produces the *same ring*.
 *    Rotation has to be measured on an asymmetric mark, or straight off the
 *    mesh's tangential component.
 */

/* ------------------------------------------------------------------ */
/* Local helpers                                                       */
/* ------------------------------------------------------------------ */

const W = 200, H = 200, CX = 100, CY = 100;

/** A mesh with one dab of `mode` at the centre. */
function dabbed(mode, extra = {}) {
  const mesh = createLiquifyMesh();
  liquifyDab(mesh, {
    mode, u: 0.5, v: 0.5, radius: 60, pressure: 0.9, density: 0.5,
    aspectW: W, aspectH: H, vx: 0, vy: 0, ...extra,
  });
  return mesh;
}

/** A bright ring of radius 40, for measuring pucker and bloat. */
function ring() {
  const img = new ImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const on = Math.abs(Math.hypot(x - CX, y - CY) - 40) < 2.5;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = on ? 255 : 20;
      img.data[i + 3] = 255;
    }
  }
  return img;
}

/** One horizontal spoke to the right of centre — asymmetric, so rotation shows. */
function spoke() {
  const img = new ImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const on = Math.abs(y - CY) < 2 && x > CX && x < CX + 45;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = on ? 255 : 0;
      img.data[i + 3] = 255;
    }
  }
  return img;
}

/** Mean distance from centre of the bright pixels — the ring's radius. */
function meanRadius(data) {
  let sum = 0, n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4] > 160) { sum += Math.hypot(x - CX, y - CY); n++; }
    }
  }
  return n ? sum / n : NaN;
}

/** Centroid of the bright pixels. */
function centroid(data) {
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4] > 128) { sx += x; sy += y; n++; }
    }
  }
  return n ? { x: sx / n, y: sy / n, n } : { x: NaN, y: NaN, n: 0 };
}

/** Warp an image through a mesh and return the resulting pixel data. */
function warped(img, mesh) {
  const out = applyLiquifyMesh(img, mesh);
  return (out instanceof ImageData ? out : img).data;
}

/**
 * Mean tangential displacement over an annulus of the mesh: the z of
 * radius x displacement, so a positive value is anticlockwise on screen.
 */
function tangential(mesh) {
  const n = mesh.n;
  let sum = 0, cnt = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const rx = i / (n - 1) - 0.5, ry = j / (n - 1) - 0.5;
      const r = Math.hypot(rx, ry);
      if (r < 0.05 || r > 0.25) continue;
      sum += (rx * mesh.dy[k] - ry * mesh.dx[k]) / r;
      cnt++;
    }
  }
  return cnt ? sum / cnt : NaN;
}

/** Total displacement magnitude across a whole mesh. */
function totalDisplacement(mesh) {
  let s = 0;
  for (let i = 0; i < mesh.dx.length; i++) s += Math.hypot(mesh.dx[i], mesh.dy[i]);
  return s;
}

/* ------------------------------------------------------------------ */
/* Every tool writes something                                         */
/* ------------------------------------------------------------------ */

suite('liquify / every tool in the palette does its own job', async (t) => {
  t.ok(liquifyMeshIsEmpty(createLiquifyMesh()),
    'a fresh mesh is empty, which is why Liquify is one of the filters that is the identity at its defaults');

  const ids = LIQUIFY_TOOLS.map((x) => x.value);
  t.eq(ids.length, 10, 'all ten tools are registered');

  for (const mode of ids) {
    // Forward Warp and Push Left are the two that need a drag direction; the
    // rest work from a held brush alone.
    const drag = mode === 'push' || mode === 'push-left' ? { vx: 0.12, vy: 0 } : {};
    const mesh = dabbed(mode, drag);

    if (mode === 'freeze') {
      t.gt(mesh.frozen.filter((v) => v !== 0).length, 100, 'freeze paints protection into the mask');
      t.ok(liquifyMeshIsEmpty(mesh), 'and freeze moves nothing by itself');
    } else if (mode === 'thaw') {
      t.eq(mesh.frozen.filter((v) => v !== 0).length, 0, 'thaw over an unfrozen mesh leaves it unfrozen');
      t.ok(liquifyMeshIsEmpty(mesh), 'and thaw moves nothing either');
    } else if (mode === 'reconstruct' || mode === 'smooth') {
      // These two relax an *existing* deformation, so on an identity mesh they
      // are correctly a no-op. Their real behaviour is asserted further down.
      t.ok(liquifyMeshIsEmpty(mesh), `"${mode}" on an undeformed mesh is a no-op, as it should be`);
    } else {
      t.notOk(liquifyMeshIsEmpty(mesh), `"${mode}" writes displacement into the mesh`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* Directions — the part a unit test usually misses                    */
/* ------------------------------------------------------------------ */

suite('liquify / pucker pulls in and bloat pushes out', async (t) => {
  const base = meanRadius(ring().data);
  const pucker = meanRadius(warped(ring(), dabbed('pucker')));
  const bloat = meanRadius(warped(ring(), dabbed('bloat')));

  t.close(base, 40, 0.5, 'the test ring really is at radius 40 before anything touches it');
  t.lt(pucker, base - 0.5, `pucker pulls the ring inward (${base.toFixed(2)} -> ${pucker.toFixed(2)})`);
  t.gt(bloat, base + 0.5, `bloat pushes the ring outward (${base.toFixed(2)} -> ${bloat.toFixed(2)})`);
});

suite('liquify / the two twirls turn opposite ways', async (t) => {
  const cw = tangential(dabbed('twirl-cw'));
  const ccw = tangential(dabbed('twirl-ccw'));

  t.gt(Math.abs(cw), 1e-6, 'twirl clockwise produces a real tangential field');
  t.gt(Math.abs(ccw), 1e-6, 'and so does anticlockwise');
  t.eq(Math.sign(cw), -Math.sign(ccw), 'the two spin in opposite directions');
  t.close(Math.abs(cw), Math.abs(ccw), Math.abs(cw) * 0.02, 'and by the same amount');

  // Same claim again, this time in pixels on an asymmetric mark, because a mesh
  // can be right while the resampler that consumes it is not.
  const before = centroid(spoke().data);
  const after = { cw: centroid(warped(spoke(), dabbed('twirl-cw'))), ccw: centroid(warped(spoke(), dabbed('twirl-ccw'))) };
  t.gt(after.cw.y, before.y + 1, 'a spoke pointing right is bent downward by the clockwise twirl');
  t.lt(after.ccw.y, before.y - 1, 'and upward by the anticlockwise one');
});

suite('liquify / forward warp follows the drag', async (t) => {
  const right = dabbed('push', { vx: 0.2, vy: 0 });
  const down = dabbed('push', { vx: 0, vy: 0.2 });

  let sx = 0, sy = 0;
  for (let i = 0; i < right.dx.length; i++) { sx += right.dx[i]; sy += right.dy[i]; }
  t.gt(sx, 0, 'dragging right displaces the mesh right');
  t.close(sy, 0, Math.abs(sx) * 0.05, 'and barely at all vertically');

  let dx = 0, dy = 0;
  for (let i = 0; i < down.dx.length; i++) { dx += down.dx[i]; dy += down.dy[i]; }
  t.gt(dy, 0, 'dragging down displaces the mesh down');
  t.close(dx, 0, Math.abs(dy) * 0.05, 'and barely at all horizontally');

  // Push Left is the perpendicular tool: a horizontal drag moves pixels
  // vertically, which is exactly what makes it useful for straightening edges.
  const left = dabbed('push-left', { vx: 0.2, vy: 0 });
  let lx = 0, ly = 0;
  for (let i = 0; i < left.dx.length; i++) { lx += Math.abs(left.dx[i]); ly += Math.abs(left.dy[i]); }
  t.gt(ly, lx * 4, 'push left turns a horizontal drag into a vertical displacement');
});

/* ------------------------------------------------------------------ */
/* Freeze really protects                                              */
/* ------------------------------------------------------------------ */

suite('liquify / a frozen region cannot be moved at all', async (t) => {
  const mesh = createLiquifyMesh();
  const at = (mode, extra = {}) => liquifyDab(mesh, {
    mode, u: 0.5, v: 0.5, radius: 60, pressure: 1, density: 1, aspectW: W, aspectH: H, ...extra,
  });

  // Two passes at full pressure so the falloff saturates and the core reaches 1.
  at('freeze'); at('freeze');
  const core = [];
  for (let k = 0; k < mesh.frozen.length; k++) if (mesh.frozen[k] >= 0.999) core.push(k);
  t.gt(core.length, 100, 'freezing at full pressure gives a fully protected core');

  at('push', { vx: 0.25, vy: 0.15 });
  at('bloat');
  at('twirl-cw');
  const moved = core.filter((k) => mesh.dx[k] !== 0 || mesh.dy[k] !== 0);
  t.eq(moved.length, 0, 'not one fully frozen node moves under push, bloat and twirl — exactly zero, not merely small');
  t.notOk(liquifyMeshIsEmpty(mesh), 'while the unprotected surround did move, so the tools were genuinely working');

  at('thaw'); at('thaw');
  at('bloat');
  const released = core.filter((k) => mesh.dx[k] !== 0 || mesh.dy[k] !== 0);
  t.gt(released.length, core.length * 0.5, 'and thawing hands the region back');
});

/* ------------------------------------------------------------------ */
/* Reconstruct and smooth relax an existing mesh                       */
/* ------------------------------------------------------------------ */

suite('liquify / reconstruct undoes and smooth relaxes', async (t) => {
  const mesh = createLiquifyMesh();
  liquifyDab(mesh, { mode: 'push', u: 0.5, v: 0.5, radius: 60, pressure: 1, density: 1, aspectW: W, aspectH: H, vx: 0.3, vy: 0 });
  const deformed = totalDisplacement(mesh);
  t.gt(deformed, 1, 'the push left a deformation to reconstruct');

  for (let i = 0; i < 6; i++) {
    liquifyDab(mesh, { mode: 'reconstruct', u: 0.5, v: 0.5, radius: 60, pressure: 1, density: 1, aspectW: W, aspectH: H });
  }
  t.lt(totalDisplacement(mesh), deformed * 0.9,
    `reconstruct walks the mesh back toward identity (${deformed.toFixed(2)} -> ${totalDisplacement(mesh).toFixed(2)})`);

  // Smooth is about neighbour-to-neighbour variation, so measure that directly
  // on a deliberately jagged field.
  const rough = createLiquifyMesh();
  for (let i = 0; i < rough.dx.length; i++) rough.dx[i] = ((i % 7) - 3) * 0.004;
  const variation = (m) => {
    let s = 0;
    for (let j = 0; j < m.n; j++) for (let i = 1; i < m.n; i++) s += Math.abs(m.dx[j * m.n + i] - m.dx[j * m.n + i - 1]);
    return s;
  };
  const before = variation(rough);
  for (let i = 0; i < 4; i++) {
    liquifyDab(rough, { mode: 'smooth', u: 0.5, v: 0.5, radius: 90, pressure: 1, density: 1, aspectW: W, aspectH: H });
  }
  t.lt(variation(rough), before, `smooth reduces roughness in the field (${before.toFixed(2)} -> ${variation(rough).toFixed(2)})`);
});

/* ------------------------------------------------------------------ */
/* Face-aware sliders                                                  */
/* ------------------------------------------------------------------ */

suite('liquify / face sliders move the feature they name and nothing else', async (t) => {
  const {
    applyFaceLiquify, faceRegions, defaultFaceParams, defaultFaceBox, faceParamsAreNeutral,
  } = await import('/src/filters/face-liquify.js');

  const W = 200, H = 240;
  const box = { x: 40, y: 30, width: 120, height: 160 };
  const R = faceRegions(box);

  /** The mesh displacement nearest an image point, in normalised units. */
  const at = (mesh, px, py) => {
    const n = mesh.n;
    const i = Math.round((px / W) * (n - 1));
    const j = Math.round((py / H) * (n - 1));
    const k = j * n + i;
    return { dx: mesh.dx[k], dy: mesh.dy[k] };
  };
  const moved = (mesh, px, py) => Math.hypot(at(mesh, px, py).dx, at(mesh, px, py).dy);

  /*
   * Sliders are absolute settings, not strokes: dragging one back to zero has
   * to undo it exactly. Verified to fail by accumulating into the base mesh
   * instead of rebuilding from it.
   */
  const neutral = applyFaceLiquify(box, defaultFaceParams(), W, H);
  t.ok(faceParamsAreNeutral(defaultFaceParams()), 'the defaults are all at rest');
  t.eq(neutral.dx.reduce((a, b) => a + Math.abs(b), 0), 0, 'and move nothing at all');

  // --- each slider touches its own feature -----------------------
  const eyes = applyFaceLiquify(box, { ...defaultFaceParams(), eyeSize: 60 }, W, H);
  t.gt(moved(eyes, R.left.cx + R.left.rx * 0.5, R.left.cy), 0, 'Eye Size moves the left eye');
  t.gt(moved(eyes, R.right.cx - R.right.rx * 0.5, R.right.cy), 0, 'and the right one');
  t.eq(moved(eyes, R.mouth.cx, R.mouth.cy), 0, 'and leaves the mouth alone');
  t.eq(moved(eyes, 5, 5), 0, 'and the rest of the image entirely');

  const mouth = applyFaceLiquify(box, { ...defaultFaceParams(), mouthWidth: 70 }, W, H);
  t.gt(moved(mouth, R.mouth.cx + R.mouth.rx * 0.5, R.mouth.cy), 0, 'Mouth Width moves the mouth');
  t.eq(moved(mouth, R.left.cx, R.left.cy), 0, 'and not the eyes');

  /*
   * A smile lifts the corners, not the whole mouth. Verified to fail by giving
   * every point the same lift: the centre then moves as far as the corners,
   * which just slides the mouth up the face.
   */
  const smile = applyFaceLiquify(box, { ...defaultFaceParams(), smile: 80 }, W, H);
  const corner = Math.abs(at(smile, R.mouth.cx + R.mouth.rx * 0.75, R.mouth.cy).dy);
  const centre = Math.abs(at(smile, R.mouth.cx, R.mouth.cy).dy);
  t.gt(corner, centre * 2, `the corners lift much further than the centre (${corner.toFixed(4)} vs ${centre.toFixed(4)})`);
  t.lt(at(smile, R.mouth.cx + R.mouth.rx * 0.75, R.mouth.cy).dy, 0, 'and they lift upward');

  /*
   * Upper Lip must not move the lower one — they are separate sliders because
   * they are separate features. Verified to fail by dropping the half-plane
   * test and painting the whole mouth region.
   */
  const upper = applyFaceLiquify(box, { ...defaultFaceParams(), upperLip: 80 }, W, H);
  t.gt(Math.abs(at(upper, R.mouth.cx, R.mouth.cy - R.mouth.ry * 0.6).dy), 0, 'Upper Lip moves above the mouth line');
  t.eq(at(upper, R.mouth.cx, R.mouth.cy + R.mouth.ry * 0.6).dy, 0, 'and nothing below it');

  // --- direction and symmetry ------------------------------------
  const apart = applyFaceLiquify(box, { ...defaultFaceParams(), eyeDistance: 100 }, W, H);
  t.lt(at(apart, R.left.cx, R.left.cy).dx, 0, 'Eye Distance pushes the left eye left');
  t.gt(at(apart, R.right.cx, R.right.cy).dx, 0, 'and the right eye right');

  /*
   * Contributions add rather than one winning, which is what makes two sliders
   * on the same feature usable together.
   * Verified to fail by assigning into the mesh instead of adding.
   */
  const apartOnly = applyFaceLiquify(box, { ...defaultFaceParams(), eyeDistance: 100 }, W, H);
  const both = applyFaceLiquify(box, { ...defaultFaceParams(), eyeSize: 60, eyeDistance: 100 }, W, H);
  /*
   * Measured off-centre on purpose. At the eye's centre Eye Size displaces
   * nothing — it is radial — so a test there cannot tell adding from
   * overwriting, and passes either way.
   */
  const px = R.left.cx + R.left.rx * 0.5;
  const sum = at(eyes, px, R.left.cy).dx + at(apartOnly, px, R.left.cy).dx;
  t.ok(Math.abs(at(both, px, R.left.cy).dx - sum) < 1e-9,
    'two sliders on one feature add rather than one winning');
  t.ok(Math.abs(at(both, px, R.left.cy).dx - at(apartOnly, px, R.left.cy).dx) > 1e-9,
    'and the combined result is not simply the last one written');

  // --- freezing still protects -----------------------------------
  const frozen = applyFaceLiquify(box, defaultFaceParams(), W, H);
  frozen.frozen.fill(1);
  const guarded = applyFaceLiquify(box, { ...defaultFaceParams(), eyeSize: 80 }, W, H, frozen);
  t.eq(guarded.dx.reduce((a, b) => a + Math.abs(b), 0), 0,
    'a fully frozen mesh is untouched by the sliders, as it is by the brushes');

  const guess = defaultFaceBox(W, H);
  t.ok(guess.width > 0 && guess.height > 0, 'the starting box is usable');
  t.ok(guess.x >= 0 && guess.y >= 0 && guess.x + guess.width <= W, 'and inside the image');
});
