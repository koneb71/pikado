import { app } from '../core/app.js';
import { isSmartLayer, getSmartTransform, setSmartTransform, matrixMultiply } from '../core/smart.js';
import { createCanvas, cloneCanvas, clamp, deg2rad, rad2deg } from '../core/util.js';
import { LayerType } from '../core/layer.js';
import { OVERLAY } from '../ui/brand.js';
import { cmd, sep } from '../ui/canvas-menu.js';

/**
 * The free-transform session.
 *
 * This is **not** a toolbar tool: it is a modal state stored on
 * `app.transformSession` and driven by whichever tool is active (the Move tool
 * forwards its pointer events here) plus the options bar, which reads and
 * writes the numeric fields through `get/setTransformNumeric`.
 *
 * Model
 * -----
 * `params` describes an affine transform about a movable pivot:
 *
 *     M = T(tx,ty) · T(p) · R(angle) · K(skewX,skewY) · S(sx,sy) · T(-p)
 *
 * `quad` holds the four destination corners of `bounds` (TL, TR, BR, BL) and is
 * what actually gets rendered. While the transform stays affine the quad is
 * derived from `params`; distort/perspective drags set `freeform` and edit the
 * quad directly. Warp mode replaces both with a 4×4 Bézier control mesh.
 */

const HIT = 7;        // handle hit radius in screen pixels
const ROT_PAD = 26;   // ring outside a corner that starts a rotation

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

function cornersOfRect(b) {
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.width, y: b.y },
    { x: b.x + b.width, y: b.y + b.height },
    { x: b.x, y: b.y + b.height },
  ];
}

function edgeMidsOfRect(b) {
  const c = cornersOfRect(b);
  return [mid(c[0], c[1]), mid(c[1], c[2]), mid(c[2], c[3]), mid(c[3], c[0])];
}

function mid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function applyM(m, p) {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

function pivotFor(s, pivotRel) {
  const pr = pivotRel || s.pivotRel;
  return { x: s.bounds.x + pr.x * s.bounds.width, y: s.bounds.y + pr.y * s.bounds.height };
}

/** Where the pivot currently sits in document space. */
function pivotDest(s) {
  if (s.warp) return evalPatch(s.warp.pts, s.pivotRel.x, s.pivotRel.y);
  if (s.freeform) return bilinearQuad(s.quad, s.pivotRel.x, s.pivotRel.y);
  const p = pivotFor(s);
  return { x: p.x + s.params.tx, y: p.y + s.params.ty };
}

/** Full transform matrix for a parameter set. */
function matrixFrom(s, params, pivotRel) {
  const p = pivotFor(s, pivotRel);
  const m = new DOMMatrix();
  m.translateSelf(params.tx, params.ty);
  m.translateSelf(p.x, p.y);
  if (params.angle) m.rotateSelf(params.angle);
  if (params.skewX || params.skewY) {
    m.multiplySelf(new DOMMatrix([1, Math.tan(deg2rad(params.skewY)), Math.tan(deg2rad(params.skewX)), 1, 0, 0]));
  }
  m.scaleSelf(params.sx, params.sy);
  m.translateSelf(-p.x, -p.y);
  return m;
}

/** Everything except the scale — used to map a pointer back into source space. */
function frameInverse(s, params, pivotRel) {
  const p = pivotFor(s, pivotRel);
  const m = new DOMMatrix();
  m.translateSelf(params.tx, params.ty);
  m.translateSelf(p.x, p.y);
  if (params.angle) m.rotateSelf(params.angle);
  if (params.skewX || params.skewY) {
    m.multiplySelf(new DOMMatrix([1, Math.tan(deg2rad(params.skewY)), Math.tan(deg2rad(params.skewX)), 1, 0, 0]));
  }
  m.translateSelf(-p.x, -p.y);
  return m.inverse();
}

function isAffineQuad(q) {
  const ex = q[0].x + q[2].x - q[1].x - q[3].x;
  const ey = q[0].y + q[2].y - q[1].y - q[3].y;
  return Math.abs(ex) < 0.02 && Math.abs(ey) < 0.02;
}

function affineFromRectToQuad(b, q) {
  const ux = (q[1].x - q[0].x) / b.width, uy = (q[1].y - q[0].y) / b.width;
  const vx = (q[3].x - q[0].x) / b.height, vy = (q[3].y - q[0].y) / b.height;
  return {
    a: ux, b: uy, c: vx, d: vy,
    e: q[0].x - ux * b.x - vx * b.y,
    f: q[0].y - uy * b.x - vy * b.y,
  };
}

/**
 * Projective map from the unit square onto `q` (Heckbert's formulation).
 * @returns {(u:number,v:number)=>{x:number,y:number}}
 */
function homographyToQuad(q) {
  const [p0, p1, p2, p3] = q;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  let a, b, c, d, e, f, g, h;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    a = p1.x - p0.x; b = p2.x - p1.x; c = p0.x;
    d = p1.y - p0.y; e = p2.y - p1.y; f = p0.y;
    g = 0; h = 0;
  } else {
    const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x;
    const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
    const den = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(den) < 1e-9) {
      a = p1.x - p0.x; b = p3.x - p0.x; c = p0.x;
      d = p1.y - p0.y; e = p3.y - p0.y; f = p0.y;
      g = 0; h = 0;
    } else {
      g = (sx * dy2 - dx2 * sy) / den;
      h = (dx1 * sy - sx * dy1) / den;
      a = p1.x - p0.x + g * p1.x;
      b = p3.x - p0.x + h * p3.x;
      c = p0.x;
      d = p1.y - p0.y + g * p1.y;
      e = p3.y - p0.y + h * p3.y;
      f = p0.y;
    }
  }
  return (u, v) => {
    const w = g * u + h * v + 1 || 1e-9;
    return { x: (a * u + b * v + c) / w, y: (d * u + e * v + f) / w };
  };
}

function bezierBasis(t) {
  const it = 1 - t;
  return [it * it * it, 3 * it * it * t, 3 * it * t * t, t * t * t];
}

/** Point on the 4×4 bicubic Bézier patch. */
function evalPatch(pts, u, v) {
  const bu = bezierBasis(u), bv = bezierBasis(v);
  let x = 0, y = 0;
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      const w = bu[i] * bv[j];
      x += pts[j][i].x * w;
      y += pts[j][i].y * w;
    }
  }
  return { x, y };
}

function bilinearQuad(q, u, v) {
  const tx = q[0].x + (q[1].x - q[0].x) * u, ty = q[0].y + (q[1].y - q[0].y) * u;
  const bx = q[3].x + (q[2].x - q[3].x) * u, by = q[3].y + (q[2].y - q[3].y) * u;
  return { x: tx + (bx - tx) * v, y: ty + (by - ty) * v };
}

/** Newton solve for the (u,v) that maps to `p` under `bilinearQuad`. */
function inverseBilinear(q, p) {
  let u = 0.5, v = 0.5;
  for (let k = 0; k < 8; k++) {
    const f = bilinearQuad(q, u, v);
    const ex = f.x - p.x, ey = f.y - p.y;
    if (Math.abs(ex) < 1e-6 && Math.abs(ey) < 1e-6) break;
    const dux = (1 - v) * (q[1].x - q[0].x) + v * (q[2].x - q[3].x);
    const duy = (1 - v) * (q[1].y - q[0].y) + v * (q[2].y - q[3].y);
    const dvx = (1 - u) * (q[3].x - q[0].x) + u * (q[2].x - q[1].x);
    const dvy = (1 - u) * (q[3].y - q[0].y) + u * (q[2].y - q[1].y);
    const det = dux * dvy - dvx * duy;
    if (Math.abs(det) < 1e-9) break;
    u -= (ex * dvy - dvx * ey) / det;
    v -= (dux * ey - ex * duy) / det;
  }
  return { x: u, y: v };
}

/* ------------------------------------------------------------------ */
/* Mesh rasterisation                                                  */
/* ------------------------------------------------------------------ */

/**
 * Draw one source triangle onto `ctx` through the affine map that takes it to
 * the destination triangle. Only the source cell rectangle is sampled, so the
 * cost scales with the mesh cell rather than the whole document.
 */
function drawTriangle(ctx, img, s0, s1, s2, d0, d1, d2, rect) {
  const u1x = s1.x - s0.x, u1y = s1.y - s0.y;
  const u2x = s2.x - s0.x, u2y = s2.y - s0.y;
  const det = u1x * u2y - u2x * u1y;
  if (!det) return;
  const v1x = d1.x - d0.x, v1y = d1.y - d0.y;
  const v2x = d2.x - d0.x, v2y = d2.y - d0.y;
  const a = (v1x * u2y - v2x * u1y) / det;
  const c = (u1x * v2x - u2x * v1x) / det;
  const b = (v1y * u2y - v2y * u1y) / det;
  const d = (u1x * v2y - u2x * v1y) / det;
  if (!isFinite(a) || !isFinite(b) || !isFinite(c) || !isFinite(d)) return;
  const e = d0.x - a * s0.x - c * s0.y;
  const f = d0.y - b * s0.x - d * s0.y;

  const bleed = 1.25;
  const sx = Math.max(0, Math.floor(rect.x - bleed));
  const sy = Math.max(0, Math.floor(rect.y - bleed));
  const sw = Math.min(img.width - sx, Math.ceil(rect.w + bleed * 2 + (rect.x - sx)));
  const sh = Math.min(img.height - sy, Math.ceil(rect.h + bleed * 2 + (rect.y - sy)));
  if (sw <= 0 || sh <= 0 || sx >= img.width || sy >= img.height) return;

  // Grow the clip outward from the centroid so adjacent cells overlap slightly
  // and no seam shows between triangles.
  const cx = (d0.x + d1.x + d2.x) / 3, cy = (d0.y + d1.y + d2.y) / 3;
  const grow = (p) => {
    const gx = p.x - cx, gy = p.y - cy;
    const L = Math.hypot(gx, gy) || 1;
    return { x: p.x + (gx / L) * 0.7, y: p.y + (gy / L) * 0.7 };
  };
  const g0 = grow(d0), g1 = grow(d1), g2 = grow(d2);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(g0.x, g0.y);
  ctx.lineTo(g1.x, g1.y);
  ctx.lineTo(g2.x, g2.y);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(img, sx, sy, sw, sh, sx, sy, sw, sh);
  ctx.restore();
}

function drawCell(ctx, img, rect, sq, dq) {
  drawTriangle(ctx, img, sq[0], sq[1], sq[2], dq[0], dq[1], dq[2], rect);
  drawTriangle(ctx, img, sq[0], sq[2], sq[3], dq[0], dq[2], dq[3], rect);
}

/** Walk an (N+1)² destination grid and draw every cell. */
function drawGrid(ctx, img, b, grid, N) {
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x0 = b.x + (b.width * i) / N, x1 = b.x + (b.width * (i + 1)) / N;
      const y0 = b.y + (b.height * j) / N, y1 = b.y + (b.height * (j + 1)) / N;
      const sq = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
      const dq = [grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]];
      drawCell(ctx, img, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, sq, dq);
    }
  }
}

function drawProjective(ctx, img, b, quad) {
  const N = clamp(Math.round(Math.max(b.width, b.height) / 40), 6, 18);
  const H = homographyToQuad(quad);
  const grid = [];
  for (let j = 0; j <= N; j++) {
    const row = [];
    for (let i = 0; i <= N; i++) row.push(H(i / N, j / N));
    grid.push(row);
  }
  drawGrid(ctx, img, b, grid, N);
}

function drawWarp(ctx, img, s) {
  const N = 14;
  const pts = s.warp.pts;
  const grid = [];
  for (let j = 0; j <= N; j++) {
    const row = [];
    for (let i = 0; i <= N; i++) row.push(evalPatch(pts, i / N, j / N));
    grid.push(row);
  }
  drawGrid(ctx, img, s.bounds, grid, N);
}

/** Render `img` through the session's current shape into `ctx`. */
function drawThrough(ctx, img, s) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (s.warp) { drawWarp(ctx, img, s); return; }
  if (isAffineQuad(s.quad)) {
    const m = affineFromRectToQuad(s.bounds, s.quad);
    if (!isFinite(m.a) || !isFinite(m.d) || Math.abs(m.a * m.d - m.b * m.c) < 1e-9) return;
    ctx.save();
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
    return;
  }
  drawProjective(ctx, img, s.bounds, s.quad);
}

/* ------------------------------------------------------------------ */
/* Session lifecycle                                                   */
/* ------------------------------------------------------------------ */

/** Recompute the quad from the affine parameters. */
function syncFromParams(s) {
  s.params.sx = Math.abs(s.params.sx) < 1e-4 ? (s.params.sx < 0 ? -1e-4 : 1e-4) : s.params.sx;
  s.params.sy = Math.abs(s.params.sy) < 1e-4 ? (s.params.sy < 0 ? -1e-4 : 1e-4) : s.params.sy;
  s.matrix = matrixFrom(s, s.params);
  if (!s.freeform && !s.warp) s.quad = cornersOfRect(s.bounds).map((p) => applyM(s.matrix, p));
}

/** Best-fit affine for the current quad, so the numeric fields stay meaningful. */
function syncFromQuad(s) {
  const m = affineFromRectToQuad(s.bounds, s.quad);
  s.matrix = new DOMMatrix([m.a, m.b, m.c, m.d, m.e, m.f]);
}

function rasterLayersOf(list) {
  const out = [];
  const walk = (l) => {
    if (l.type === LayerType.GROUP) {
      for (const c of l.children || []) walk(c);
      return;
    }
    if (l.canvas && !l.locked.all && !l.locked.pixels && !out.includes(l)) out.push(l);
  };
  for (const l of list) walk(l);
  return out;
}

function unionBounds(layers, doc) {
  let r = null;
  for (const l of layers) {
    const b = l.contentBounds();
    if (!b) continue;
    r = r ? {
      x: Math.min(r.x, b.x), y: Math.min(r.y, b.y),
      x2: Math.max(r.x2, b.x + b.width), y2: Math.max(r.y2, b.y + b.height),
    } : { x: b.x, y: b.y, x2: b.x + b.width, y2: b.y + b.height };
  }
  if (!r) return { x: 0, y: 0, width: doc.width, height: doc.height };
  return { x: r.x, y: r.y, width: Math.max(1, r.x2 - r.x), height: Math.max(1, r.y2 - r.y) };
}

/**
 * Begin a free-transform session.
 * @param {import('../core/document.js').PikaDocument} doc
 * @param {{layers?:object[], mode?:'free'|'scale'|'rotate'|'skew'|'distort'|'perspective'|'warp'}} [opts]
 * @returns {object|null} the session
 */
export function startTransform(doc, opts = {}) {
  if (!doc) return null;
  if (app.transformSession) commitTransform();

  const layers = rasterLayersOf(opts.layers && opts.layers.length ? opts.layers : doc.selectedLayers());
  if (!layers.length) {
    app.toast('Select a pixel layer to transform.');
    return null;
  }

  const bounds = unionBounds(layers, doc);
  doc.beginEdit(layers);

  const s = {
    doc,
    layers,
    mode: opts.mode || 'free',
    selectionMode: false,
    baseCanvases: layers.map((l) => cloneCanvas(l.canvas)),
    // A smart layer is transformed by composing matrices, never by resampling
    // its pixels, so repeated sessions cannot compound quality loss.
    baseSmart: layers.map((l) => (isSmartLayer(l) ? getSmartTransform(l) : null)),
    baseMasks: layers.map((l) => (l.mask && l.maskLinked ? cloneCanvas(l.mask) : null)),
    baseSelection: null,
    bounds,
    params: { tx: 0, ty: 0, sx: 1, sy: 1, angle: 0, skewX: 0, skewY: 0 },
    pivotRel: { x: 0.5, y: 0.5 },
    matrix: new DOMMatrix(),
    quad: cornersOfRect(bounds),
    freeform: false,
    warp: null,
    drag: null,
  };
  app.transformSession = s;
  syncFromParams(s);
  if (s.mode === 'warp') initWarp(s);

  installKeys();
  // The Move tool is what forwards pointer events into the session.
  if (!app.tool || app.tool.id !== 'move') app.setTool('move');
  app.emit('tool-options', app.tool);
  app.requestRender();
  return s;
}

/** Transform the *selection outline* rather than pixels (Select > Transform Selection). */
export function transformSelectionStart(doc) {
  if (!doc) return null;
  if (!doc.selection.active) {
    app.toast('Make a selection first.');
    return null;
  }
  if (app.transformSession) commitTransform();
  const b = doc.selection.bounds() || { x: 0, y: 0, width: doc.width, height: doc.height };
  const s = {
    doc,
    layers: [],
    mode: 'free',
    selectionMode: true,
    baseCanvases: [],
    baseMasks: [],
    baseSelection: new Uint8ClampedArray(doc.selection.mask),
    bounds: { x: b.x, y: b.y, width: Math.max(1, b.width), height: Math.max(1, b.height) },
    params: { tx: 0, ty: 0, sx: 1, sy: 1, angle: 0, skewX: 0, skewY: 0 },
    pivotRel: { x: 0.5, y: 0.5 },
    matrix: new DOMMatrix(),
    quad: cornersOfRect({ x: b.x, y: b.y, width: Math.max(1, b.width), height: Math.max(1, b.height) }),
    freeform: false,
    warp: null,
    drag: null,
  };
  app.transformSession = s;
  syncFromParams(s);
  installKeys();
  if (!app.tool || app.tool.id !== 'move') app.setTool('move');
  app.emit('tool-options', app.tool);
  app.requestRender();
  return s;
}

export function isTransforming() {
  return !!app.transformSession;
}

/**
 * Canvas-menu entries for a live session. The Move tool shows these instead of
 * its layer picker while a transform is in flight, which is what Photoshop does
 * when you right-click inside the transform box.
 *
 * The mode rows are radio-like: `edit.transform.*` switches an existing session
 * rather than starting a new one, so the current mode is ticked. Apply and
 * Cancel have no commands of their own — they are the Enter/Escape keys.
 *
 * @returns {Array<object>}
 */
export function transformContextMenu() {
  const s = app.transformSession;
  if (!s) return [];
  const mode = (id, m) => cmd(id, { checked: s.mode === m });
  return [
    { header: s.selectionMode ? 'Transform Selection' : 'Free Transform' },
    mode('edit.transform.scale', 'scale'),
    mode('edit.transform.rotate', 'rotate'),
    mode('edit.transform.skew', 'skew'),
    mode('edit.transform.distort', 'distort'),
    mode('edit.transform.perspective', 'perspective'),
    mode('edit.transform.warp', 'warp'),
    sep(),
    cmd('edit.transform.flip-h'),
    cmd('edit.transform.flip-v'),
    sep(),
    { label: 'Apply', accel: 'Enter', run: () => commitTransform() },
    { label: 'Cancel', accel: 'Esc', run: () => cancelTransform() },
  ];
}

/** Re-draw every layer in the session through the current transform. */
function renderSession(s) {
  if (s.selectionMode) {
    app.requestRender();
    return;
  }
  for (let i = 0; i < s.layers.length; i++) {
    const l = s.layers[i];
    // Warp and freeform quads are not expressible as an affine matrix, so those
    // stay on the destructive path.
    const bm = !s.freeform && !s.warp && s.baseSmart ? s.baseSmart[i] : null;
    if (bm) {
      const m = s.matrix;
      setSmartTransform(s.doc, s.layers[i], matrixMultiply([m.a, m.b, m.c, m.d, m.e, m.f], bm), { commit: false });
      continue;
    }
    const base = s.baseCanvases[i];
    if (l.canvas && base) {
      const c = l.canvas.getContext('2d');
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, l.canvas.width, l.canvas.height);
      drawThrough(c, base, s);
    }
    const mbase = s.baseMasks[i];
    if (l.mask && mbase) {
      const c = l.mask.getContext('2d');
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, l.mask.width, l.mask.height);
      drawThrough(c, mbase, s);
      l.touchMask();
    }
  }
  s.doc.touch('transform');
}

/** Bake the transform and record it in history. */
export function commitTransform() {
  const s = app.transformSession;
  if (!s) return false;
  app.transformSession = null;
  removeKeys();

  if (s.selectionMode) {
    const doc = s.doc;
    const src = createCanvas(doc.width, doc.height);
    const sc = src.getContext('2d');
    const img = new ImageData(doc.width, doc.height);
    for (let p = 0, i = 3; p < s.baseSelection.length; p++, i += 4) img.data[i] = s.baseSelection[p];
    sc.putImageData(img, 0, 0);

    const out = createCanvas(doc.width, doc.height);
    drawThrough(out.getContext('2d'), src, s);
    const d = out.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, doc.width, doc.height).data;
    const mask = new Uint8ClampedArray(doc.width * doc.height);
    for (let p = 0, i = 3; p < mask.length; p++, i += 4) mask[p] = d[i];
    doc.selection.set(mask);
    doc.commit('Transform Selection');
  } else {
    s.doc.commit(s.warp ? 'Warp' : 'Free Transform');
  }
  app.emit('tool-options', app.tool);
  app.requestRender();
  return true;
}

/** Throw the transform away and put the cached pixels back. */
export function cancelTransform() {
  const s = app.transformSession;
  if (!s) return false;
  app.transformSession = null;
  removeKeys();
  if (!s.selectionMode) {
    for (let i = 0; i < s.layers.length; i++) {
      const l = s.layers[i];
      if (s.baseCanvases[i]) l.canvas = cloneCanvas(s.baseCanvases[i]);
      if (s.baseMasks[i]) { l.mask = cloneCanvas(s.baseMasks[i]); l.touchMask(); }
    }
    s.doc.touch('transform-cancel');
  }
  app.emit('tool-options', app.tool);
  app.requestRender();
  return true;
}

/* ------------------------------------------------------------------ */
/* Warp mesh                                                           */
/* ------------------------------------------------------------------ */

function initWarp(s) {
  const pts = [];
  for (let j = 0; j < 4; j++) {
    const row = [];
    for (let i = 0; i < 4; i++) row.push(bilinearQuad(s.quad, i / 3, j / 3));
    pts.push(row);
  }
  s.warp = { pts };
}

/** Switch an in-flight session between transform kinds. */
export function setTransformMode(mode) {
  const s = app.transformSession;
  if (!s) return;
  s.mode = mode;
  if (mode === 'warp' && !s.warp) {
    initWarp(s);
    renderSession(s);
  } else if (mode !== 'warp' && s.warp) {
    // Collapse the mesh back to its corner quad.
    s.quad = [s.warp.pts[0][0], s.warp.pts[0][3], s.warp.pts[3][3], s.warp.pts[3][0]].map((p) => ({ ...p }));
    s.warp = null;
    s.freeform = !isAffineQuad(s.quad);
    if (s.freeform) syncFromQuad(s);
    renderSession(s);
  }
  app.emit('tool-options', app.tool);
  app.requestRender();
}

/* ------------------------------------------------------------------ */
/* Numeric entry (driven by the options bar)                           */
/* ------------------------------------------------------------------ */

/**
 * @returns {null|{x,y,width,height,scaleX,scaleY,angle,skewX,skewY,pivotX,pivotY,mode,freeform,bounds}}
 */
export function getTransformNumeric() {
  const s = app.transformSession;
  if (!s) return null;
  const p = pivotDest(s);
  return {
    x: Math.round(p.x * 100) / 100,
    y: Math.round(p.y * 100) / 100,
    width: Math.round(s.params.sx * 10000) / 100,
    height: Math.round(s.params.sy * 10000) / 100,
    scaleX: s.params.sx,
    scaleY: s.params.sy,
    angle: Math.round(s.params.angle * 100) / 100,
    skewX: Math.round(s.params.skewX * 100) / 100,
    skewY: Math.round(s.params.skewY * 100) / 100,
    pivotX: s.pivotRel.x,
    pivotY: s.pivotRel.y,
    mode: s.mode,
    freeform: !!(s.freeform || s.warp),
    bounds: { ...s.bounds },
  };
}

/**
 * Apply numeric fields. Accepts any subset of
 * `{x, y, width, height, scaleX, scaleY, angle, skewX, skewY, pivotX, pivotY}`
 * where width/height are percentages.
 */
export function setTransformNumeric(obj) {
  const s = app.transformSession;
  if (!s || !obj) return;

  if (obj.pivotX != null || obj.pivotY != null) {
    if (s.freeform || s.warp) {
      if (obj.pivotX != null) s.pivotRel.x = clamp(obj.pivotX, -2, 3);
      if (obj.pivotY != null) s.pivotRel.y = clamp(obj.pivotY, -2, 3);
    } else {
      const before = applyM(matrixFrom(s, s.params), { x: s.bounds.x, y: s.bounds.y });
      if (obj.pivotX != null) s.pivotRel.x = clamp(obj.pivotX, -2, 3);
      if (obj.pivotY != null) s.pivotRel.y = clamp(obj.pivotY, -2, 3);
      const after = applyM(matrixFrom(s, s.params), { x: s.bounds.x, y: s.bounds.y });
      s.params.tx += before.x - after.x;
      s.params.ty += before.y - after.y;
    }
  }

  const prev = { ...s.params };
  const pd0 = pivotDest(s);
  const freeform = !!(s.freeform || s.warp);
  if (obj.scaleX != null) s.params.sx = obj.scaleX;
  else if (obj.width != null) s.params.sx = obj.width / 100;
  if (obj.scaleY != null) s.params.sy = obj.scaleY;
  else if (obj.height != null) s.params.sy = obj.height / 100;
  if (obj.angle != null) s.params.angle = obj.angle;
  if (obj.skewX != null) s.params.skewX = clamp(obj.skewX, -85, 85);
  if (obj.skewY != null) s.params.skewY = clamp(obj.skewY, -85, 85);
  if (obj.x != null) s.params.tx = freeform ? prev.tx + (obj.x - pd0.x) : obj.x - pivotFor(s).x;
  if (obj.y != null) s.params.ty = freeform ? prev.ty + (obj.y - pd0.y) : obj.y - pivotFor(s).y;

  if (freeform) {
    // A distorted shape has no parameter decomposition, so apply the numeric
    // change as a delta matrix on the points we already have.
    applyDelta(s, matrixFrom(s, s.params).multiply(matrixFrom(s, prev).inverse()));
  } else {
    syncFromParams(s);
  }
  renderSession(s);
  app.requestRender();
}

/** Push a document-space matrix through the quad or the warp mesh. */
function applyDelta(s, m) {
  const go = (p) => applyM(m, p);
  if (s.warp) {
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) s.warp.pts[j][i] = go(s.warp.pts[j][i]);
  } else {
    s.quad = s.quad.map(go);
    syncFromQuad(s);
  }
}

/** Mirror the transform across the pivot. */
export function flipTransform(axis) {
  const s = app.transformSession;
  if (!s) return;
  if (s.warp || s.freeform) {
    const d = pivotDest(s);
    const m = axis === 'h'
      ? new DOMMatrix([-1, 0, 0, 1, 2 * d.x, 0])
      : new DOMMatrix([1, 0, 0, -1, 0, 2 * d.y]);
    applyDelta(s, m);
  } else {
    if (axis === 'h') s.params.sx = -s.params.sx;
    else s.params.sy = -s.params.sy;
    syncFromParams(s);
  }
  renderSession(s);
  app.emit('tool-options', app.tool);
  app.requestRender();
}

/** Rotate the transform by `degrees` about the pivot. */
export function rotateTransform(degrees) {
  const s = app.transformSession;
  if (!s || !degrees) return;
  if (s.warp || s.freeform) {
    const d = pivotDest(s);
    const m = new DOMMatrix();
    m.translateSelf(d.x, d.y);
    m.rotateSelf(degrees);
    m.translateSelf(-d.x, -d.y);
    applyDelta(s, m);
  } else {
    s.params.angle += degrees;
    syncFromParams(s);
  }
  renderSession(s);
  app.emit('tool-options', app.tool);
  app.requestRender();
}

/* ------------------------------------------------------------------ */
/* Pointer interaction                                                 */
/* ------------------------------------------------------------------ */

function screenHandles(s, view) {
  const q = s.quad.map((p) => view.toScreen(p.x, p.y));
  return [q[0], q[1], q[2], q[3], mid(q[0], q[1]), mid(q[1], q[2]), mid(q[2], q[3]), mid(q[3], q[0])];
}

function pointInQuad(p, q) {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const a = q[i], b = q[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function hitTest(s, e, view) {
  const pt = { x: e.sx, y: e.sy };
  const pd = pivotDest(s);
  const pv = view.toScreen(pd.x, pd.y);
  if (Math.hypot(pt.x - pv.x, pt.y - pv.y) <= HIT + 2) return { kind: 'pivot' };

  if (s.warp) {
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        const p = view.toScreen(s.warp.pts[j][i].x, s.warp.pts[j][i].y);
        if (Math.hypot(pt.x - p.x, pt.y - p.y) <= HIT) return { kind: 'warp', row: j, col: i };
      }
    }
  }

  const h = screenHandles(s, view);
  for (let i = 0; i < h.length; i++) {
    if (Math.hypot(pt.x - h[i].x, pt.y - h[i].y) <= HIT) {
      return { kind: i < 4 ? 'corner' : 'edge', index: i < 4 ? i : i - 4 };
    }
  }
  if (pointInQuad(pt, h.slice(0, 4))) return { kind: 'move' };
  // Anywhere outside rotates, exactly like Photoshop.
  for (let i = 0; i < 4; i++) {
    if (Math.hypot(pt.x - h[i].x, pt.y - h[i].y) <= HIT + ROT_PAD) return { kind: 'rotate', index: i };
  }
  return { kind: 'rotate', index: 0 };
}

/** @returns {boolean} true when the session consumed the event */
export function transformPointerDown(e, view) {
  const s = app.transformSession;
  if (!s) return false;
  const hit = hitTest(s, e, view);
  s.drag = {
    ...hit,
    startDoc: { x: e.x, y: e.y },
    params: { ...s.params },
    pivotRel: { ...s.pivotRel },
    pivotDest: pivotDest(s),
    quad: s.quad.map((p) => ({ ...p })),
    warpPts: s.warp ? s.warp.pts.map((r) => r.map((p) => ({ ...p }))) : null,
  };
  return true;
}

export function transformPointerMove(e, view) {
  const s = app.transformSession;
  if (!s || !s.drag) return false;
  const d = s.drag;
  const primary = e.ctrlKey || e.metaKey;

  switch (d.kind) {
    case 'pivot': dragPivot(s, e); break;
    case 'warp': dragWarp(s, e); break;
    case 'rotate': dragRotate(s, e); break;
    case 'move': dragMove(s, e); break;
    case 'corner':
      if (primary && e.altKey && e.shiftKey) dragPerspective(s, e);
      else if (primary || s.mode === 'distort') dragDistort(s, e);
      else if (s.mode === 'perspective') dragPerspective(s, e);
      else dragScale(s, e, true);
      break;
    case 'edge':
      if ((primary && e.shiftKey) || s.mode === 'skew') dragSkew(s, e);
      else if (primary) dragDistortEdge(s, e);
      else dragScale(s, e, false);
      break;
    default: return false;
  }
  renderSession(s);
  app.requestRender();
  return true;
}

export function transformPointerUp() {
  const s = app.transformSession;
  if (!s || !s.drag) return false;
  s.drag = null;
  app.emit('tool-options', app.tool);
  return true;
}

/* --- individual drag behaviours ----------------------------------- */

function dragMove(s, e) {
  const d = s.drag;
  let dx = e.x - d.startDoc.x, dy = e.y - d.startDoc.y;
  if (e.shiftKey) {
    if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0;
  }
  if (s.warp) {
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
      s.warp.pts[j][i] = { x: d.warpPts[j][i].x + dx, y: d.warpPts[j][i].y + dy };
    }
    return;
  }
  if (s.freeform) {
    s.quad = d.quad.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    syncFromQuad(s);
    return;
  }
  s.params.tx = d.params.tx + dx;
  s.params.ty = d.params.ty + dy;
  syncFromParams(s);
}

function dragRotate(s, e) {
  const d = s.drag;
  const cx = d.pivotDest.x, cy = d.pivotDest.y;
  const a0 = Math.atan2(d.startDoc.y - cy, d.startDoc.x - cx);
  const a1 = Math.atan2(e.y - cy, e.x - cx);
  let delta = rad2deg(a1 - a0);
  if (s.warp || s.freeform) {
    const r = deg2rad(delta), cos = Math.cos(r), sin = Math.sin(r);
    const rot = (pt) => ({
      x: cx + (pt.x - cx) * cos - (pt.y - cy) * sin,
      y: cy + (pt.x - cx) * sin + (pt.y - cy) * cos,
    });
    if (s.warp) {
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) s.warp.pts[j][i] = rot(d.warpPts[j][i]);
    } else {
      s.quad = d.quad.map(rot);
      syncFromQuad(s);
    }
    return;
  }
  let deg = d.params.angle + delta;
  if (e.shiftKey) deg = Math.round(deg / 15) * 15;
  s.params.angle = deg;
  syncFromParams(s);
}

function dragScale(s, e, isCorner) {
  const d = s.drag;
  const p = pivotFor(s, d.pivotRel);
  const inv = frameInverse(s, d.params, d.pivotRel);
  const q = inv.transformPoint(new DOMPoint(e.x, e.y));
  const src = isCorner ? cornersOfRect(s.bounds)[d.index] : edgeMidsOfRect(s.bounds)[d.index];
  const r0x = src.x - p.x, r0y = src.y - p.y;

  let nsx = d.params.sx, nsy = d.params.sy;
  const wantX = isCorner || d.index === 1 || d.index === 3;
  const wantY = isCorner || d.index === 0 || d.index === 2;
  if (wantX && Math.abs(r0x) > 1e-6) nsx = (q.x - p.x) / r0x;
  if (wantY && Math.abs(r0y) > 1e-6) nsy = (q.y - p.y) / r0y;

  if (e.shiftKey) {
    const fx = d.params.sx ? nsx / d.params.sx : 1;
    const fy = d.params.sy ? nsy / d.params.sy : 1;
    const f = isCorner ? (Math.abs(fx) + Math.abs(fy)) / 2 : Math.abs(wantX ? fx : fy);
    nsx = d.params.sx * f * (fx < 0 ? -1 : 1);
    nsy = d.params.sy * f * (fy < 0 ? -1 : 1);
  }

  s.params.sx = nsx;
  s.params.sy = nsy;
  s.params.tx = d.params.tx;
  s.params.ty = d.params.ty;

  if (!e.altKey) {
    // Keep the opposite handle pinned instead of scaling around the pivot.
    const anchor = isCorner
      ? cornersOfRect(s.bounds)[(d.index + 2) % 4]
      : edgeMidsOfRect(s.bounds)[(d.index + 2) % 4];
    const before = applyM(matrixFrom(s, d.params, d.pivotRel), anchor);
    const after = applyM(matrixFrom(s, s.params, d.pivotRel), anchor);
    s.params.tx += before.x - after.x;
    s.params.ty += before.y - after.y;
  }
  syncFromParams(s);
}

function dragSkew(s, e) {
  const d = s.drag;
  const p = pivotFor(s, d.pivotRel);
  const rot = deg2rad(d.params.angle);
  const ex = { x: Math.cos(rot), y: Math.sin(rot) };
  const ey = { x: -Math.sin(rot), y: Math.cos(rot) };
  const dx = e.x - d.startDoc.x, dy = e.y - d.startDoc.y;
  const lx = dx * ex.x + dy * ex.y;
  const ly = dx * ey.x + dy * ey.y;
  const srcMid = edgeMidsOfRect(s.bounds)[d.index];

  s.params = { ...d.params };
  if (d.index === 0 || d.index === 2) {
    const arm = d.params.sy * (srcMid.y - p.y);
    if (Math.abs(arm) > 1e-3) {
      s.params.skewX = clamp(rad2deg(Math.atan(Math.tan(deg2rad(d.params.skewX)) + lx / arm)), -85, 85);
    }
  } else {
    const arm = d.params.sx * (srcMid.x - p.x);
    if (Math.abs(arm) > 1e-3) {
      s.params.skewY = clamp(rad2deg(Math.atan(Math.tan(deg2rad(d.params.skewY)) + ly / arm)), -85, 85);
    }
  }
  syncFromParams(s);
}

function dragDistort(s, e) {
  const d = s.drag;
  s.freeform = true;
  s.quad = d.quad.map((p) => ({ ...p }));
  s.quad[d.index] = { x: d.quad[d.index].x + (e.x - d.startDoc.x), y: d.quad[d.index].y + (e.y - d.startDoc.y) };
  syncFromQuad(s);
}

function dragDistortEdge(s, e) {
  const d = s.drag;
  s.freeform = true;
  const dx = e.x - d.startDoc.x, dy = e.y - d.startDoc.y;
  s.quad = d.quad.map((p) => ({ ...p }));
  const a = d.index, b = (d.index + 1) % 4;
  s.quad[a] = { x: d.quad[a].x + dx, y: d.quad[a].y + dy };
  s.quad[b] = { x: d.quad[b].x + dx, y: d.quad[b].y + dy };
  syncFromQuad(s);
}

function dragPerspective(s, e) {
  const d = s.drag;
  s.freeform = true;
  const dx = e.x - d.startDoc.x, dy = e.y - d.startDoc.y;
  // The corner sharing the horizontal edge mirrors the horizontal motion.
  const partner = [1, 0, 3, 2][d.index];
  s.quad = d.quad.map((p) => ({ ...p }));
  s.quad[d.index] = { x: d.quad[d.index].x + dx, y: d.quad[d.index].y + dy };
  s.quad[partner] = { x: d.quad[partner].x - dx, y: d.quad[partner].y + dy };
  syncFromQuad(s);
}

function dragPivot(s, e) {
  if (s.warp || s.freeform) {
    const q = s.warp
      ? [s.warp.pts[0][0], s.warp.pts[0][3], s.warp.pts[3][3], s.warp.pts[3][0]]
      : s.quad;
    const uv = inverseBilinear(q, { x: e.x, y: e.y });
    s.pivotRel = { x: clamp(uv.x, -2, 3), y: clamp(uv.y, -2, 3) };
    return;
  }
  const inv = matrixFrom(s, s.params, s.pivotRel).inverse();
  const src = inv.transformPoint(new DOMPoint(e.x, e.y));
  const before = applyM(matrixFrom(s, s.params, s.pivotRel), { x: s.bounds.x, y: s.bounds.y });
  s.pivotRel = {
    x: clamp((src.x - s.bounds.x) / s.bounds.width, -2, 3),
    y: clamp((src.y - s.bounds.y) / s.bounds.height, -2, 3),
  };
  const after = applyM(matrixFrom(s, s.params, s.pivotRel), { x: s.bounds.x, y: s.bounds.y });
  s.params.tx += before.x - after.x;
  s.params.ty += before.y - after.y;
  syncFromParams(s);
}

function dragWarp(s, e) {
  const d = s.drag;
  const dx = e.x - d.startDoc.x, dy = e.y - d.startDoc.y;
  const move = (r, c) => {
    s.warp.pts[r][c] = { x: d.warpPts[r][c].x + dx, y: d.warpPts[r][c].y + dy };
  };
  move(d.row, d.col);
  // Corner points carry their two tangent handles so the corner stays rigid.
  const isCornerPt = (d.row === 0 || d.row === 3) && (d.col === 0 || d.col === 3);
  if (isCornerPt) {
    move(d.row, d.col === 0 ? 1 : 2);
    move(d.row === 0 ? 1 : 2, d.col);
  }
}

/* ------------------------------------------------------------------ */
/* Overlay                                                             */
/* ------------------------------------------------------------------ */

function strokeShape(ctx, pts, close = true) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  if (close) ctx.closePath();
  ctx.stroke();
}

function handleBox(ctx, p, filled = true) {
  const r = 4;
  ctx.beginPath();
  ctx.rect(p.x - r, p.y - r, r * 2, r * 2);
  ctx.fillStyle = filled ? '#ffffff' : OVERLAY.accent;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.85)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

/**
 * Draw the transform chrome. `ctx` is in screen space.
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('../render/viewport.js').Viewport} view
 */
export function drawTransformOverlay(ctx, view) {
  const s = app.transformSession;
  if (!s) return;
  ctx.save();
  ctx.lineJoin = 'round';

  if (s.warp) {
    const N = 12;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,.45)';
    for (let k = 0; k <= 3; k++) {
      const rowPts = [], colPts = [];
      for (let i = 0; i <= N; i++) {
        const a = evalPatch(s.warp.pts, i / N, k / 3);
        const b = evalPatch(s.warp.pts, k / 3, i / N);
        rowPts.push(view.toScreen(a.x, a.y));
        colPts.push(view.toScreen(b.x, b.y));
      }
      strokeShape(ctx, rowPts, false);
      strokeShape(ctx, colPts, false);
    }
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    for (let k = 0; k <= 3; k++) {
      const rowPts = [], colPts = [];
      for (let i = 0; i <= N; i++) {
        const a = evalPatch(s.warp.pts, i / N, k / 3);
        const b = evalPatch(s.warp.pts, k / 3, i / N);
        rowPts.push(view.toScreen(a.x, a.y));
        colPts.push(view.toScreen(b.x, b.y));
      }
      ctx.setLineDash(k === 0 || k === 3 ? [] : [3, 3]);
      strokeShape(ctx, rowPts, false);
      strokeShape(ctx, colPts, false);
    }
    ctx.setLineDash([]);
    // Tangent handles.
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    const corners = [[0, 0], [0, 3], [3, 3], [3, 0]];
    for (const [r, c] of corners) {
      const a = view.toScreen(s.warp.pts[r][c].x, s.warp.pts[r][c].y);
      for (const [r2, c2] of [[r, c === 0 ? 1 : 2], [r === 0 ? 1 : 2, c]]) {
        const b = view.toScreen(s.warp.pts[r2][c2].x, s.warp.pts[r2][c2].y);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        const p = view.toScreen(s.warp.pts[j][i].x, s.warp.pts[j][i].y);
        const isCorner = (j === 0 || j === 3) && (i === 0 || i === 3);
        if (isCorner) handleBox(ctx, p, true);
        else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = OVERLAY.accent;
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,.9)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }
  } else {
    const h = screenHandles(s, view);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,.7)';
    strokeShape(ctx, h.slice(0, 4));
    ctx.strokeStyle = 'rgba(255,255,255,.95)';
    ctx.setLineDash([4, 3]);
    strokeShape(ctx, h.slice(0, 4));
    ctx.setLineDash([]);
    for (const p of h) handleBox(ctx, p, true);
  }

  // Pivot.
  const p = pivotDest(s);
  const pv = view.toScreen(p.x, p.y);
  ctx.strokeStyle = 'rgba(0,0,0,.8)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(pv.x - 7, pv.y); ctx.lineTo(pv.x + 7, pv.y);
  ctx.moveTo(pv.x, pv.y - 7); ctx.lineTo(pv.x, pv.y + 7);
  ctx.stroke();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(pv.x, pv.y, 4, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Enter / Escape                                                      */
/* ------------------------------------------------------------------ */

let keysInstalled = false;

function onKeyDown(e) {
  if (!app.transformSession) return;
  const t = e.target;
  const editing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    commitTransform();
  } else if (e.key === 'Escape' && !editing) {
    e.preventDefault();
    e.stopPropagation();
    cancelTransform();
  }
}

function installKeys() {
  if (keysInstalled) return;
  window.addEventListener('keydown', onKeyDown, true);
  keysInstalled = true;
}

function removeKeys() {
  if (!keysInstalled) return;
  window.removeEventListener('keydown', onKeyDown, true);
  keysInstalled = false;
}

/**
 * The app clears the session when its document is closed or deactivated. The
 * live preview is already rendered into the layer pixels at that point, so bake
 * it rather than stranding a half-applied transform. `app.transformSession` is
 * still set while the event fires, so commitTransform() can do its normal work.
 */
app.on('transform-session-ending', (s) => {
  if (app.transformSession === s) commitTransform();
  else removeKeys();
});
