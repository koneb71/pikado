import { PikaDocument } from './document.js';
import { Layer, LayerType, createRasterLayer, setSmartSourceCloner } from './layer.js';
import { app } from './app.js';
import { uid, createCanvas, ctx2d, ctx2dRead, imageDataToCanvas, download } from './util.js';
import { compositeDocument, setLayerPreview } from '../render/compositor.js';
import { getFilter, runFilter } from '../filters/registry.js';

/**
 * Smart Objects — genuinely non-destructive embedded documents.
 *
 * `layer.smart` looks like:
 * ```
 * {
 *   source: PikaDocument,      // the embedded contents (layers, masks, groups)
 *   sourceWidth, sourceHeight, // the source document size
 *   sourceVersion: number,     // bumped whenever `source` is replaced
 *   transform: {
 *     matrix: [a,b,c,d,e,f],   // the affine part
 *     perspective: [p,q],      // optional projective row — see below
 *     warp: [[{x,y} x4] x4],   // optional 4x4 Bezier mesh in SOURCE pixels
 *   },
 *   filters: [{ id, filterId, name, params, enabled }],
 * }
 * ```
 *
 * **Every render starts from `source`.** The stored smart filters are re-run
 * against the freshly composited source pixels and the shape (warp, then the
 * projective transform) is applied last, so scaling a smart object down and back
 * up resamples the originals once instead of compounding a chain of lossy steps.
 * `layer.canvas` is only a cache of that render; the compositor draws it like any
 * other raster layer.
 *
 * **The shape.** A source point travels
 * `source -> warp patch -> affine x perspective -> document`, i.e.
 * `H = A · P` with
 * ```
 *      | a c e |        | 1 0 0 |
 *  A = | b d f |    P = | 0 1 0 |
 *      | 0 0 1 |        | p q 1 |
 * ```
 * `P` is the identity when `perspective` is absent, so a plain affine smart
 * object is bit-for-bit unaffected by any of this and keeps the fast
 * single-`drawImage` path. Storing the projective row separately (rather than one
 * 3x3) is only a reparameterisation of the same homography — `matrix` stays the
 * thing the Properties panel and Free Transform compose with.
 *
 * **Mutation rule.** `Layer.snapshot()` shallow-copies `layer.smart`, so history
 * states share the payload object. Nothing here ever edits `layer.smart` (or its
 * `filters` array) in place — every mutator installs a brand new payload with a
 * new `filters` array. Old snapshots therefore keep the values they were taken
 * with, and undo/redo of smart-object edits round-trips exactly.
 */

/** The neutral transform: source pixels land 1:1 at the document origin. */
export const IDENTITY_MATRIX = [1, 0, 0, 1, 0, 0];

/** The neutral projective row: no perspective. */
export const NO_PERSPECTIVE = [0, 0];

/* ------------------------------------------------------------------ */
/* Matrix helpers ([a,b,c,d,e,f], the canvas setTransform order)        */
/* ------------------------------------------------------------------ */

/** `A ∘ B` — the matrix that applies `B` first, then `A`. */
export function matrixMultiply(A, B) {
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}

/**
 * Split a matrix into the values the Properties panel edits: where the centre of
 * the source box lands, its scale, its rotation and its skew.
 *
 * This is the QR-style decomposition `T · R(angle) · K(skew) · S(scale)`, so
 * `composeMatrix(decomposeMatrix(M)) === M` for **any** invertible affine matrix
 * — nothing is thrown away any more.
 *
 * An affine matrix has six degrees of freedom and centre + scale + rotation
 * already spend five of them, so exactly *one* shear parameter fits. The
 * canonical form returned here is therefore always `skewY: 0`, with the whole
 * shear expressed as `skewX`. `composeMatrix` still accepts a `skewY` (the panel
 * authors both axes); it simply comes back folded into angle/skewX/scaleY next
 * time, describing the very same matrix.
 *
 * @returns {{centerX:number, centerY:number, scaleX:number, scaleY:number,
 *            angle:number, skewX:number, skewY:number}} angles in radians
 */
export function decomposeMatrix(matrix, sourceWidth, sourceHeight) {
  const [a, b, c, d, e, f] = matrix;
  const scaleX = Math.hypot(a, b);
  const det = a * d - b * c;
  // A degenerate matrix has no recoverable shear; fall back to the column length.
  const scaleY = scaleX > 1e-12 ? det / scaleX : Math.hypot(c, d) * (det < 0 ? -1 : 1);
  const shear = Math.abs(det) > 1e-12 ? (a * c + b * d) / det : 0;
  const angle = Math.atan2(b, a);
  const hx = sourceWidth / 2, hy = sourceHeight / 2;
  return {
    centerX: a * hx + c * hy + e,
    centerY: b * hx + d * hy + f,
    scaleX,
    scaleY,
    angle,
    skewX: Math.atan(shear),
    skewY: 0,
  };
}

/** The inverse of {@link decomposeMatrix}. `skewX`/`skewY` are optional radians. */
export function composeMatrix(
  { centerX, centerY, scaleX, scaleY, angle, skewX = 0, skewY = 0 },
  sourceWidth,
  sourceHeight
) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const kx = Math.tan(skewX || 0), ky = Math.tan(skewY || 0);
  // R(angle) · K(kx,ky) · S(scaleX,scaleY), written out column by column.
  const a = scaleX * (cos - ky * sin);
  const b = scaleX * (sin + ky * cos);
  const c = scaleY * (kx * cos - sin);
  const d = scaleY * (kx * sin + cos);
  const hx = sourceWidth / 2, hy = sourceHeight / 2;
  return [a, b, c, d, centerX - (a * hx + c * hy), centerY - (b * hx + d * hy)];
}

/**
 * The parameters the user actually authored, when they still describe the
 * matrix — otherwise null.
 *
 * An affine matrix has one shear degree of freedom, and centre, scale and
 * rotation spend the other five, so `decomposeMatrix` can only ever hand back
 * the canonical form with the whole shear in `skewX`. That is not a rounding
 * loss — the matrix genuinely does not record which of the two skew fields the
 * user typed into — so the only way for Skew Y to read back as Skew Y is to
 * remember what was authored.
 *
 * Remembered *alongside* the matrix, never instead of it: the matrix stays the
 * single source of truth for rendering, and this is checked against it before
 * it is believed. So Free Transform, a script or an undo moving the matrix
 * makes the memo stale, it is detected, and the panel falls back to the
 * canonical decomposition — which is the honest answer at that point, because
 * the authored pair really has stopped describing the layer.
 *
 * @returns {{centerX,centerY,scaleX,scaleY,angle,skewX,skewY}|null} radians
 */
export function authoredParams(smart, matrix, sourceWidth, sourceHeight) {
  const a = smart && smart.authored;
  if (!a || !validMatrix(matrix)) return null;
  const composed = composeMatrix(a, sourceWidth, sourceHeight);
  // Loose enough for a round trip through JSON and a hand-typed field, tight
  // enough that any real edit invalidates it.
  for (let i = 0; i < 6; i += 1) {
    if (Math.abs(composed[i] - matrix[i]) > 1e-6) return null;
  }
  return { ...a };
}

function validMatrix(m) {
  return Array.isArray(m) && m.length === 6 && m.every((n) => Number.isFinite(n));
}

function validPerspective(p) {
  return Array.isArray(p) && p.length === 2 && p.every((n) => Number.isFinite(n));
}

/* ------------------------------------------------------------------ */
/* Homography helpers (row-major 3x3, source -> document)              */
/* ------------------------------------------------------------------ */

/** The `A · P` homography for an affine matrix plus a projective row. */
export function toMatrix3(matrix, perspective) {
  const [a, b, c, d, e, f] = matrix;
  const p = perspective ? perspective[0] : 0;
  const q = perspective ? perspective[1] : 0;
  return [
    a + e * p, c + e * q, e,
    b + f * p, d + f * q, f,
    p, q, 1,
  ];
}

/** `A ∘ B` for two row-major 3x3 matrices. */
export function matrix3Multiply(A, B) {
  const out = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    }
  }
  return out;
}

/**
 * Split a homography back into `{matrix, perspective}`. Exact, and the inverse
 * of {@link toMatrix3}: `perspective` is the bottom row and the affine part is
 * what is left once that row's contribution to the translation is removed.
 * @returns {{matrix:number[], perspective:number[]}|null} null if degenerate
 */
export function fromMatrix3(H) {
  if (!Array.isArray(H) || H.length !== 9 || !H.every((n) => Number.isFinite(n))) return null;
  if (Math.abs(H[8]) < 1e-12) return null;
  const k = 1 / H[8];
  const e = H[2] * k, f = H[5] * k;
  const p = H[6] * k, q = H[7] * k;
  return {
    matrix: [H[0] * k - e * p, H[3] * k - f * p, H[1] * k - e * q, H[4] * k - f * q, e, f],
    perspective: [p, q],
  };
}

/** Map one point through a row-major 3x3. */
export function applyMatrix3(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  const iw = Math.abs(w) < 1e-12 ? 1e12 : 1 / w;
  return { x: (H[0] * x + H[1] * y + H[2]) * iw, y: (H[3] * x + H[4] * y + H[5]) * iw };
}

/** Inverse of a row-major 3x3, or null when it is singular. */
export function invertMatrix3(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null;
  const k = 1 / det;
  return [
    A * k, (c * h - b * i) * k, (b * f - c * e) * k,
    B * k, (a * i - c * g) * k, (c * d - a * f) * k,
    C * k, (b * g - a * h) * k, (a * e - b * d) * k,
  ];
}

/**
 * The projective map from the unit square onto `quad` (TL, TR, BR, BL) —
 * Heckbert's formulation, as a row-major 3x3.
 */
export function unitSquareToQuad(quad) {
  const [p0, p1, p2, p3] = quad;
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
  return [a, b, c, d, e, f, g, h, 1];
}

/**
 * The projective map taking the axis-aligned rect `box` onto `quad`, i.e.
 * `unitSquareToQuad(quad)` pre-composed with the normalisation of `box`.
 */
export function rectToQuad(box, quad) {
  const kx = 1 / (box.width || 1), ky = 1 / (box.height || 1);
  const norm = [kx, 0, -box.x * kx, 0, ky, -box.y * ky, 0, 0, 1];
  return matrix3Multiply(unitSquareToQuad(quad), norm);
}

/* ------------------------------------------------------------------ */
/* Warp mesh (4x4 bicubic Bézier patch, in source pixels)              */
/* ------------------------------------------------------------------ */

function bezierBasis(t) {
  const it = 1 - t;
  return [it * it * it, 3 * it * it * t, 3 * it * t * t, t * t * t];
}

/**
 * The neutral 4x4 control grid over a `width × height` box: evenly spaced
 * control points make the patch reproduce the identity map exactly.
 * @returns {{x:number,y:number}[][]}
 */
export function identityWarp(width, height) {
  const pts = [];
  for (let j = 0; j < 4; j++) {
    const row = [];
    for (let i = 0; i < 4; i++) row.push({ x: (width * i) / 3, y: (height * j) / 3 });
    pts.push(row);
  }
  return pts;
}

/** Point on a 4x4 bicubic Bézier patch at `(u,v)` in 0..1. */
export function evalWarp(pts, u, v) {
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

function validWarp(pts) {
  if (!Array.isArray(pts) || pts.length !== 4) return false;
  return pts.every((row) => Array.isArray(row) && row.length === 4
    && row.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)));
}

function copyWarp(pts) {
  return pts.map((row) => row.map((p) => ({ x: p.x, y: p.y })));
}

/** True when the grid is (within a hair of) the neutral grid for that box. */
function warpIsIdentity(pts, width, height) {
  const id = identityWarp(width, height);
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      if (Math.abs(pts[j][i].x - id[j][i].x) > 1e-6) return false;
      if (Math.abs(pts[j][i].y - id[j][i].y) > 1e-6) return false;
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Mesh rasterisation                                                  */
/* ------------------------------------------------------------------ */

/**
 * Draw one source triangle onto `ctx` through the affine map that takes it to
 * the destination triangle. Only the source cell rectangle is sampled, so the
 * cost scales with the mesh cell rather than the whole image.
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

/**
 * Resample `img` through an arbitrary parametric map by splitting `box` (a rect
 * in `img` coordinates) into `n × n` cells and drawing each as two affine
 * triangles. This is the shared primitive behind smart-object perspective and
 * warp rendering and the free-transform preview.
 *
 * @param {CanvasRenderingContext2D} ctx destination, already reset to identity
 * @param {CanvasImageSource & {width:number,height:number}} img
 * @param {{x:number,y:number,width:number,height:number}} box
 * @param {number} n cells per axis
 * @param {(u:number,v:number)=>{x:number,y:number}} mapFn destination point for
 *   the normalised position `(u,v)` inside `box`
 */
export function drawMappedGrid(ctx, img, box, n, mapFn) {
  const grid = [];
  for (let j = 0; j <= n; j++) {
    const row = [];
    for (let i = 0; i <= n; i++) row.push(mapFn(i / n, j / n));
    grid.push(row);
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x0 = box.x + (box.width * i) / n, x1 = box.x + (box.width * (i + 1)) / n;
      const y0 = box.y + (box.height * j) / n, y1 = box.y + (box.height * (j + 1)) / n;
      const sq = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
      const dq = [grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]];
      const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      drawTriangle(ctx, img, sq[0], sq[1], sq[2], dq[0], dq[1], dq[2], rect);
      drawTriangle(ctx, img, sq[0], sq[2], sq[3], dq[0], dq[2], dq[3], rect);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Predicates and payload access                                       */
/* ------------------------------------------------------------------ */

/** True when `layer` is a smart object with usable contents. */
export function isSmartLayer(layer) {
  return !!(layer && layer.type === LayerType.SMART && layer.smart && layer.smart.source);
}

/** The smart payload, or null — never throws on a plain layer. */
export function smartPayload(layer) {
  return isSmartLayer(layer) ? layer.smart : null;
}

/** A copy of the layer's affine transform matrix. */
export function getSmartTransform(layer) {
  const s = smartPayload(layer);
  const m = s && s.transform && s.transform.matrix;
  return validMatrix(m) ? m.slice() : IDENTITY_MATRIX.slice();
}

/** A copy of the layer's projective row `[p,q]` — `[0,0]` when there is none. */
export function getSmartPerspective(layer) {
  const s = smartPayload(layer);
  const p = s && s.transform && s.transform.perspective;
  return validPerspective(p) ? p.slice() : NO_PERSPECTIVE.slice();
}

/** A copy of the layer's 4x4 warp control grid (source pixels), or null. */
export function getSmartWarp(layer) {
  const s = smartPayload(layer);
  const w = s && s.transform && s.transform.warp;
  return validWarp(w) ? copyWarp(w) : null;
}

/** The full source → document homography of a smart layer, as a row-major 3x3. */
export function getSmartMatrix3(layer) {
  return toMatrix3(getSmartTransform(layer), getSmartPerspective(layer));
}

/** True when the layer carries perspective or a warp on top of its affine part. */
export function hasSmartShape(layer) {
  const p = getSmartPerspective(layer);
  return !!(p[0] || p[1] || getSmartWarp(layer));
}

/** The stored smart filters, newest-applied last. Safe to iterate, not to edit. */
export function getSmartFilters(layer) {
  const s = smartPayload(layer);
  return s && Array.isArray(s.filters) ? s.filters : [];
}

/** Deep-enough copy of a filter list so history states never share entries. */
function copyFilters(list) {
  return (list || []).map((f) => ({ ...f, params: { ...f.params } }));
}

/**
 * A validated, freshly allocated transform record. Optional parts are omitted
 * rather than stored as neutral values, so `JSON.stringify` of an untouched
 * smart object stays exactly what it always was.
 */
function normalizeTransform(t) {
  const m = validMatrix(t && t.matrix) ? t.matrix.slice() : IDENTITY_MATRIX.slice();
  const out = { matrix: m };
  const p = t && t.perspective;
  if (validPerspective(p) && (p[0] !== 0 || p[1] !== 0)) out.perspective = [p[0], p[1]];
  if (validWarp(t && t.warp)) out.warp = copyWarp(t.warp);
  return out;
}

/**
 * Install a new smart payload on `layer`. Never mutates the old one, so the
 * shallow copy in `Layer.snapshot()` keeps older history states intact.
 */
function setPayload(layer, patch) {
  const s = layer.smart || {};
  layer.smart = {
    ...s,
    ...patch,
    filters: copyFilters(patch.filters || s.filters),
    transform: normalizeTransform(patch.transform || s.transform),
  };
  return layer.smart;
}

/* ------------------------------------------------------------------ */
/* Embedded document helpers                                           */
/* ------------------------------------------------------------------ */

/**
 * A detached copy of a document, suitable for storing as smart contents.
 * Layer ids are preserved so the editing tab and the stored source line up.
 */
export function cloneSourceDocument(src, name) {
  const d = new PikaDocument({
    width: src.width,
    height: src.height,
    name: name || src.name,
    resolution: src.resolution,
  });
  d.colorMode = src.colorMode;
  d.layers = src.layers.map((l) => {
    const c = l.clone(false);
    c.parent = null;
    return c;
  });
  d.activeLayerId = src.activeLayerId && d.findLayer(src.activeLayerId) ? src.activeLayerId : (d.flatLayers()[0] || {}).id || null;
  d.selectedLayerIds = d.activeLayerId ? [d.activeLayerId] : [];
  d.paths = structuredClone(src.paths || []);
  d.guides = (src.guides || []).map((g) => ({ ...g }));
  d.history.clear('Smart Object');
  return d;
}

/** Wrap an image/canvas in a one-layer document. */
function documentFromImage(image, name) {
  const w = Math.max(1, image.naturalWidth || image.width || 1);
  const h = Math.max(1, image.naturalHeight || image.height || 1);
  const d = new PikaDocument({ width: w, height: h, name: name || 'Contents' });
  const l = createRasterLayer(w, h, 'Layer 1');
  ctx2d(l.canvas).drawImage(image, 0, 0, w, h);
  d.layers = [l];
  d.activeLayerId = l.id;
  d.selectedLayerIds = [l.id];
  d.history.clear('Smart Object');
  return d;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/**
 * Cache key covering everything that feeds the pre-transform pixels.
 *
 * `sourceVersion` only moves when the smart API *replaces* the source, so it
 * misses edits made to the embedded document directly — which is exactly what
 * an open "Contents" tab does. Folding in the source's own history position
 * catches those: every committed edit moves it.
 */
function sourceKey(s) {
  const fs = (s.filters || [])
    .map((f) => (f.enabled ? `${f.filterId}:${JSON.stringify(f.params || {})}` : '-'))
    .join(';');
  const src = s.source;
  const hist = src && src.history ? `${src.history.index}.${src.history.states.length}` : '0';
  return `${src ? src.id : '?'}|${s.sourceVersion || 0}|${hist}|${fs}`;
}

/** Run the stored smart filters over the composited source, in order. */
function applySmartFilters(canvas, s, layer) {
  let cur = canvas;
  for (const f of s.filters || []) {
    if (!f.enabled) continue;
    const def = getFilter(f.filterId);
    if (!def) {
      app.toast(`Smart filter "${f.filterId}" is not registered — skipped.`, 'error');
      continue;
    }
    const w = cur.width, h = cur.height;
    const region = ctx2dRead(cur).getImageData(0, 0, w, h);
    let res = runFilter(f.filterId, region, f.params, {
      doc: s.source, layer, rect: { x: 0, y: 0, width: w, height: h },
      isMask: false, width: w, height: h, app,
    });
    if (!(res instanceof ImageData)) res = region;
    cur = imageDataToCanvas(res);
  }
  return cur;
}

/**
 * Successive halving before a big downscale. A single `drawImage` that shrinks
 * by more than 2× box-filters poorly, and the whole point of a smart object is
 * that the small version still looks right.
 */
function prescale(src, sx, sy) {
  let cur = src;
  let px = 1, py = 1;
  for (let i = 0; i < 12; i++) {
    if (!(sx / px < 0.5 && sy / py < 0.5)) break;
    if (cur.width <= 4 || cur.height <= 4) break;
    const w = Math.max(1, Math.round(cur.width / 2));
    const h = Math.max(1, Math.round(cur.height / 2));
    const half = createCanvas(w, h);
    const hc = ctx2d(half);
    hc.imageSmoothingEnabled = true;
    hc.imageSmoothingQuality = 'high';
    hc.drawImage(cur, 0, 0, w, h);
    cur = half;
    px = cur.width / src.width;
    py = cur.height / src.height;
  }
  return { canvas: cur, px, py };
}

/**
 * The pre-transform pixels: the embedded document composited at source size
 * with the enabled smart filters applied. Cached on `cacheHolder` (the layer)
 * so dragging a transform does not re-run the filter chain every frame.
 * @returns {HTMLCanvasElement}
 */
export function smartSourcePixels(s, layer, cacheHolder) {
  const key = sourceKey(s);
  if (cacheHolder && cacheHolder._smartCache && cacheHolder._smartCache.key === key) {
    return cacheHolder._smartCache.canvas;
  }
  const composed = applySmartFilters(compositeDocument(s.source), s, layer);
  if (cacheHolder) cacheHolder._smartCache = { key, canvas: composed };
  return composed;
}

/**
 * How finely to subdivide the source box when rendering through a warp or a
 * perspective. Driven by the *destination* size so a big object gets a smooth
 * mesh and a thumbnail-sized one does not pay for cells nobody can see.
 */
function gridSteps(mapFn) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let j = 0; j <= 4; j++) {
    for (let i = 0; i <= 4; i++) {
      const p = mapFn(i / 4, j / 4);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
  }
  const span = Math.max(x1 - x0, y1 - y0);
  if (!Number.isFinite(span)) return 8;
  return Math.max(8, Math.min(28, Math.round(span / 20)));
}

/**
 * Render a smart payload into a `width × height` canvas without touching any
 * layer. Used for the live filter preview as well as the real render.
 *
 * A plain affine object takes the single-`drawImage` path it always did — that
 * is what makes a scale round trip bit-exact. A warp or a perspective switches
 * to the triangle-mesh resampler, still reading the *original* source pixels
 * once, so those are non-destructive on exactly the same terms.
 *
 * @returns {HTMLCanvasElement}
 */
export function composeSmartCanvas(s, width, height, layer = null, cacheHolder = null) {
  const src = smartSourcePixels(s, layer, cacheHolder);
  const t = s.transform || {};
  const matrix = validMatrix(t.matrix) ? t.matrix : IDENTITY_MATRIX;
  const persp = validPerspective(t.perspective) ? t.perspective : NO_PERSPECTIVE;
  const warp = validWarp(t.warp) ? t.warp : null;
  const out = createCanvas(width, height);
  const ctx = ctx2d(out);
  const [a, b, c, d, e, f] = matrix;
  const sx = Math.hypot(a, b);
  const sy = Math.hypot(c, d);
  if (sx <= 0 || sy <= 0) return out;
  const pre = prescale(src, sx, sy);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if (!warp && !persp[0] && !persp[1]) {
    ctx.setTransform(a, b, c, d, e, f);
    if (pre.px !== 1 || pre.py !== 1) ctx.scale(1 / pre.px, 1 / pre.py);
    ctx.drawImage(pre.canvas, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return out;
  }

  // The warp grid is expressed in ORIGINAL source pixels, so prescaling the
  // source is invisible here: the grid is walked in normalised (u,v).
  const H = toMatrix3(matrix, persp);
  const sw = src.width || 1, sh = src.height || 1;
  const map = warp
    ? (u, v) => {
      const p = evalWarp(warp, u, v);
      return applyMatrix3(H, p.x, p.y);
    }
    : (u, v) => applyMatrix3(H, u * sw, v * sh);
  const box = { x: 0, y: 0, width: pre.canvas.width, height: pre.canvas.height };
  drawMappedGrid(ctx, pre.canvas, box, gridSteps(map), map);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return out;
}

/**
 * Re-composite the embedded document, re-apply the smart filters in order and
 * re-apply the transform — always resampling from the original source pixels.
 * Assigns the result to `layer.canvas` (a replacement, never an in-place edit).
 *
 * @param {import('./layer.js').Layer} layer
 * @param {import('./document.js').PikaDocument} doc parent document
 * @returns {HTMLCanvasElement|null}
 */
export function renderSmartObject(layer, doc) {
  if (!isSmartLayer(layer)) {
    app.toast('That layer has no Smart Object contents.', 'error');
    return null;
  }
  const cv = composeSmartCanvas(layer.smart, doc.width, doc.height, layer, layer);
  layer.canvas = cv;
  layer.thumbDirty = true;
  return cv;
}

/** Drop the cached source pixels — call after editing `smart.source` in place. */
export function invalidateSmartCache(layer) {
  if (layer) layer._smartCache = null;
}

/* ------------------------------------------------------------------ */
/* Creation                                                            */
/* ------------------------------------------------------------------ */

/** Remove layers that are already inside another layer of the same list. */
function dropNested(list) {
  const isInside = (l, maybeParent) => {
    for (let p = l.parent; p; p = p.parent) if (p === maybeParent) return true;
    return false;
  };
  return list.filter((l) => !list.some((o) => o !== l && isInside(l, o)));
}

/**
 * Layer > Smart Objects > Convert to Smart Object.
 *
 * Captures `layers` into an embedded `PikaDocument` (so nested groups, masks
 * and layer styles all survive verbatim) and replaces them with one smart
 * layer rendered from that document.
 *
 * @param {import('./document.js').PikaDocument} doc
 * @param {import('./layer.js').Layer[]} [layers] defaults to the selection
 * @returns {import('./layer.js').Layer|null}
 */
export function createSmartObject(doc, layers) {
  if (!doc) return null;
  let list = (layers && layers.length ? layers : doc.selectedLayers()).filter(Boolean);
  if (!list.length) {
    app.toast('Select a layer to convert to a Smart Object.');
    return null;
  }
  if (list.length === 1 && list[0].type === LayerType.SMART) {
    app.toast('That layer is already a Smart Object.');
    return null;
  }
  list = dropNested(list);
  const flat = doc.flatLayers();
  const ordered = [...list].sort((a, b) => flat.indexOf(a) - flat.indexOf(b));

  const anchor = ordered[0];
  const loc = doc.locate(anchor);
  if (!loc) {
    app.toast('Could not locate the layer to convert.', 'error');
    return null;
  }
  const parent = loc.parent;
  const index = loc.index;
  const name = ordered.length === 1 ? anchor.name : 'Smart Object';

  const source = new PikaDocument({
    width: doc.width, height: doc.height, name, resolution: doc.resolution,
  });
  source.colorMode = doc.colorMode;
  source.layers = ordered.map((l) => {
    const c = l.clone(false);
    c.parent = null;
    c.clipped = false;
    c.isBackground = false;
    c.locked = { all: false, pixels: false, position: false, transparency: false };
    return c;
  });
  source.activeLayerId = source.layers[0].id;
  source.selectedLayerIds = [source.activeLayerId];
  source.history.clear('Smart Object');

  for (const l of ordered) doc.removeLayer(l);

  const smart = new Layer({ type: LayerType.SMART, name });
  smart.smart = {
    source,
    sourceWidth: doc.width,
    sourceHeight: doc.height,
    sourceVersion: 1,
    transform: { matrix: IDENTITY_MATRIX.slice() },
    filters: [],
  };
  renderSmartObject(smart, doc);

  const target = parent ? parent.children : doc.layers;
  doc.addLayer(smart, { parent, index: Math.min(index, target.length) });
  doc.commit('Convert to Smart Object');
  return smart;
}

/* ------------------------------------------------------------------ */
/* Transform                                                           */
/* ------------------------------------------------------------------ */

/**
 * Replace the smart layer's transform and re-render from the source pixels.
 *
 * The affine `matrix` is always replaced. `perspective` and `warp` are left as
 * they were unless the caller names them — pass `null` to clear one, so the
 * Properties panel can edit scale/rotation without disturbing a perspective the
 * transform tool put there (and vice versa).
 *
 * @param {import('./document.js').PikaDocument} doc
 * @param {import('./layer.js').Layer} layer
 * @param {number[]} matrix `[a,b,c,d,e,f]`
 * @param {{commit?:boolean, label?:string, perspective?:number[]|null,
 *          warp?:object[][]|null}} [opts] `commit:false` for a live drag
 */
export function setSmartTransform(doc, layer, matrix, opts = {}) {
  if (!isSmartLayer(layer)) {
    app.toast('Select a Smart Object layer first.');
    return null;
  }
  if (!validMatrix(matrix)) {
    app.toast('That transform is not a valid matrix.', 'error');
    return null;
  }
  const { commit = true, label = 'Transform Smart Object' } = opts;
  const cur = layer.smart.transform || {};
  let perspective = cur.perspective;
  let warp = cur.warp;
  if (opts.perspective !== undefined) {
    if (opts.perspective !== null && !validPerspective(opts.perspective)) {
      app.toast('That perspective is not a valid projective row.', 'error');
      return null;
    }
    perspective = opts.perspective;
  }
  if (opts.warp !== undefined) {
    if (opts.warp !== null && !validWarp(opts.warp)) {
      app.toast('That warp mesh is not a valid 4x4 control grid.', 'error');
      return null;
    }
    // A mesh that is back at its neutral positions is dropped, not stored, so
    // the object returns to the exact single-drawImage path.
    warp = opts.warp && !warpIsIdentity(opts.warp, layer.smart.sourceWidth, layer.smart.sourceHeight)
      ? opts.warp
      : null;
  }
  if (commit) doc.beginEdit(layer);
  setPayload(layer, { transform: { matrix: matrix.slice(), perspective, warp } });
  renderSmartObject(layer, doc);
  if (commit) doc.commit(label);
  else doc.touch('smart-transform');
  return layer.smart.transform.matrix;
}

/** Put the contents back at 1:1, unrotated, unwarped, at the document origin. */
export function resetSmartTransform(doc, layer) {
  return setSmartTransform(doc, layer, IDENTITY_MATRIX.slice(), {
    label: 'Reset Smart Transform',
    perspective: null,
    warp: null,
  });
}

/**
 * Drop the perspective and/or the warp while keeping the affine placement —
 * the non-destructive counterpart of "undo my distortion".
 * @param {{perspective?:boolean, warp?:boolean}} what
 */
export function clearSmartShape(doc, layer, what = { perspective: true, warp: true }) {
  if (!isSmartLayer(layer)) {
    app.toast('Select a Smart Object layer first.');
    return null;
  }
  const opts = { label: 'Clear Smart Distortion' };
  if (what.perspective) opts.perspective = null;
  if (what.warp) opts.warp = null;
  return setSmartTransform(doc, layer, getSmartTransform(layer), opts);
}

/* ------------------------------------------------------------------ */
/* Editing the contents in a child tab                                 */
/* ------------------------------------------------------------------ */

/** Open editing sessions, keyed `parentDocId:layerId`. */
const sessions = new Map();

function sessionKey(doc, layer) {
  return `${doc.id}:${layer.id}`;
}

function endSession(key, { flush = false } = {}) {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  clearTimeout(s.timer);
  s.offChange();
  s.offStructure();
  s.offDocs();
  if (flush && s.pending) pushContents(s);
}

/** Copy the child tab's current state back into the parent smart layer. */
function pushContents(s) {
  s.pending = false;
  const doc = s.doc;
  if (!app.docs.includes(doc)) {
    endSession(s.key);
    return;
  }
  const layer = doc.findLayer(s.layerId);
  if (!layer || !layer.smart) {
    endSession(s.key);
    app.toast('The Smart Object layer is gone — contents were not saved back.', 'warn');
    return;
  }
  doc.beginEdit(layer);
  setPayload(layer, {
    source: cloneSourceDocument(s.child, layer.smart.source.name),
    sourceWidth: s.child.width,
    sourceHeight: s.child.height,
    sourceVersion: (layer.smart.sourceVersion || 0) + 1,
  });
  invalidateSmartCache(layer);
  renderSmartObject(layer, doc);
  doc.commit('Edit Smart Contents');
}

/**
 * Layer > Smart Objects > Edit Contents — opens `layer.smart.source` as a real
 * editable tab. Every commit in that tab flows straight back into the parent
 * smart layer (a fresh source copy plus a re-render), and closing the tab
 * flushes anything still pending.
 *
 * @returns {import('./document.js').PikaDocument|null} the child document
 */
export function editSmartContents(doc, layer) {
  if (!isSmartLayer(layer)) {
    app.toast('Select a Smart Object layer first.');
    return null;
  }
  const key = sessionKey(doc, layer);
  const open = sessions.get(key);
  if (open && app.docs.includes(open.child)) {
    app.setActiveDoc(open.child);
    return open.child;
  }
  if (open) endSession(key);

  const child = cloneSourceDocument(layer.smart.source, `${layer.name} (Contents)`);
  child.smartParent = { docId: doc.id, layerId: layer.id };

  const s = { key, doc, layerId: layer.id, child, timer: null, pending: false };
  const schedule = () => {
    s.pending = true;
    clearTimeout(s.timer);
    s.timer = setTimeout(() => pushContents(s), 120);
  };
  s.offChange = child.on('change', schedule);
  s.offStructure = child.on('structure', schedule);
  s.offDocs = app.on('docs-change', () => {
    if (!app.docs.includes(child)) endSession(key, { flush: true });
    else if (!app.docs.includes(doc)) endSession(key);
  });
  sessions.set(key, s);

  app.addDocument(child);
  app.fitView();
  app.toast('Editing Smart Object contents — changes update the parent live.', 'info');
  return child;
}

/** True when a child editing tab is open for this layer. */
export function isEditingContents(doc, layer) {
  const s = sessions.get(sessionKey(doc, layer));
  return !!(s && app.docs.includes(s.child));
}

/* ------------------------------------------------------------------ */
/* Replace / export contents                                           */
/* ------------------------------------------------------------------ */

/**
 * Swap the embedded contents for another image or document, keeping the
 * placement: the new contents are scaled to occupy the same box as the old.
 *
 * @param {import('./document.js').PikaDocument} doc
 * @param {import('./layer.js').Layer} layer
 * @param {HTMLImageElement|HTMLCanvasElement|ImageBitmap|import('./document.js').PikaDocument} imageOrDoc
 */
export function replaceContents(doc, layer, imageOrDoc, label = 'Replace Contents') {
  if (!isSmartLayer(layer)) {
    app.toast('Select a Smart Object layer first.');
    return null;
  }
  if (!imageOrDoc) {
    app.toast('Nothing to place into the Smart Object.', 'error');
    return null;
  }
  const s = layer.smart;
  const source = imageOrDoc instanceof PikaDocument
    ? cloneSourceDocument(imageOrDoc, imageOrDoc.name)
    : documentFromImage(imageOrDoc, layer.name);

  const oldW = s.sourceWidth || source.width;
  const oldH = s.sourceHeight || source.height;
  const fx = oldW / source.width, fy = oldH / source.height;
  const fit = [fx, 0, 0, fy, 0, 0];
  const matrix = matrixMultiply(getSmartTransform(layer), fit);
  // The warp grid lives in source pixels, and the fit scale is folded into the
  // matrix — rescale the grid by the same factor so the two cancel and the warp
  // keeps the shape it had.
  const oldWarp = getSmartWarp(layer);
  const warp = oldWarp
    ? oldWarp.map((row) => row.map((p) => ({ x: p.x / fx, y: p.y / fy })))
    : null;

  endSession(sessionKey(doc, layer));
  doc.beginEdit(layer);
  setPayload(layer, {
    source,
    sourceWidth: source.width,
    sourceHeight: source.height,
    sourceVersion: (s.sourceVersion || 0) + 1,
    transform: { matrix, perspective: getSmartPerspective(layer), warp },
  });
  invalidateSmartCache(layer);
  renderSmartObject(layer, doc);
  doc.commit(label);
  return layer.smart;
}

/**
 * Layer > Smart Objects > Export Contents — writes the untransformed,
 * unfiltered source composite out as a PNG.
 */
export async function exportSmartContents(doc, layer) {
  if (!isSmartLayer(layer)) {
    app.toast('Select a Smart Object layer first.');
    return false;
  }
  const s = layer.smart;
  const cv = compositeDocument(s.source);
  const blob = await new Promise((resolve, reject) => {
    cv.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the Smart Object contents.'))), 'image/png');
  });
  const safe = String(layer.name || 'smart-object').replace(/[^\w.-]+/g, '-');
  download(blob, `${safe}.png`);
  return true;
}

/* ------------------------------------------------------------------ */
/* Smart filters                                                       */
/* ------------------------------------------------------------------ */

function filterLabel(def) {
  return def.name.replace(/(\.\.\.|…)$/, '');
}

function indexOfFilter(s, ref) {
  const list = s.filters || [];
  if (typeof ref === 'number') return ref >= 0 && ref < list.length ? ref : -1;
  return list.findIndex((f) => f.id === ref || f.filterId === ref);
}

/**
 * Add a re-editable smart filter. Filters live on `layer.smart.filters` and are
 * re-run from the source on every render, so they never damage the originals.
 *
 * @param {string} filterId a registered filter id
 * @param {object} [params] defaults to the filter's own defaults
 */
export function addSmartFilter(doc, layer, filterId, params) {
  if (!isSmartLayer(layer)) {
    app.toast('Smart filters need a Smart Object layer.');
    return null;
  }
  const def = getFilter(filterId);
  if (!def) {
    app.toast(`Unknown filter "${filterId}".`, 'error');
    return null;
  }
  const entry = {
    id: uid('sfilter'),
    filterId,
    name: filterLabel(def),
    params: { ...def.defaults, ...(params || {}) },
    enabled: true,
  };
  doc.beginEdit(layer);
  setPayload(layer, { filters: [...getSmartFilters(layer), entry] });
  renderSmartObject(layer, doc);
  doc.commit(`Smart Filter: ${entry.name}`);
  return entry;
}

/** Remove a smart filter by entry id, filter id or index. */
export function removeSmartFilter(doc, layer, ref) {
  if (!isSmartLayer(layer)) return false;
  const i = indexOfFilter(layer.smart, ref);
  if (i < 0) {
    app.toast('That smart filter is no longer on this layer.', 'error');
    return false;
  }
  const list = getSmartFilters(layer);
  const name = list[i].name;
  doc.beginEdit(layer);
  setPayload(layer, { filters: list.filter((_, n) => n !== i) });
  renderSmartObject(layer, doc);
  doc.commit(`Delete Smart Filter: ${name}`);
  return true;
}

/** Move a smart filter within the stack — order changes the result. */
export function reorderSmartFilters(doc, layer, from, to) {
  if (!isSmartLayer(layer)) return false;
  const list = getSmartFilters(layer);
  const a = indexOfFilter(layer.smart, from);
  const b = typeof to === 'number' ? Math.max(0, Math.min(list.length - 1, to)) : indexOfFilter(layer.smart, to);
  if (a < 0 || b < 0 || a === b) return false;
  const next = copyFilters(list);
  const [moved] = next.splice(a, 1);
  next.splice(b, 0, moved);
  doc.beginEdit(layer);
  setPayload(layer, { filters: next });
  renderSmartObject(layer, doc);
  doc.commit('Reorder Smart Filters');
  return true;
}

/** Toggle one smart filter on or off without losing its settings. */
export function toggleSmartFilter(doc, layer, ref) {
  if (!isSmartLayer(layer)) return false;
  const i = indexOfFilter(layer.smart, ref);
  if (i < 0) return false;
  const next = copyFilters(getSmartFilters(layer));
  next[i].enabled = !next[i].enabled;
  doc.beginEdit(layer);
  setPayload(layer, { filters: next });
  renderSmartObject(layer, doc);
  doc.commit(`${next[i].enabled ? 'Show' : 'Hide'} Smart Filter: ${next[i].name}`);
  return true;
}

/** Show or hide every smart filter at once, as one history step. */
export function setSmartFiltersEnabled(doc, layer, enabled) {
  if (!isSmartLayer(layer)) return false;
  const list = getSmartFilters(layer);
  if (!list.length || list.every((f) => !!f.enabled === !!enabled)) return false;
  const next = copyFilters(list);
  for (const f of next) f.enabled = !!enabled;
  doc.beginEdit(layer);
  setPayload(layer, { filters: next });
  renderSmartObject(layer, doc);
  doc.commit(enabled ? 'Show All Smart Filters' : 'Hide All Smart Filters');
  return true;
}

/**
 * Re-open a smart filter's dialog. The preview re-renders the whole stack from
 * the source, so what you see is exactly what commits.
 */
export async function editSmartFilter(doc, layer, ref) {
  if (!isSmartLayer(layer)) {
    app.toast('Select a Smart Object layer first.');
    return false;
  }
  const i = indexOfFilter(layer.smart, ref);
  if (i < 0) {
    app.toast('That smart filter is no longer on this layer.', 'error');
    return false;
  }
  const entry = getSmartFilters(layer)[i];
  const def = getFilter(entry.filterId);
  if (!def) {
    app.toast(`Filter "${entry.filterId}" is not registered.`, 'error');
    return false;
  }
  if (!def.params || !def.params.length) {
    app.toast(`${entry.name} has no settings to edit.`);
    return false;
  }
  const result = await runFilterDialog(doc, layer, def, { ...entry.params }, (params) => {
    const next = copyFilters(getSmartFilters(layer));
    next[i] = { ...next[i], params };
    return next;
  });
  if (!result) return false;
  const next = copyFilters(getSmartFilters(layer));
  next[i] = { ...next[i], params: result };
  doc.beginEdit(layer);
  setPayload(layer, { filters: next });
  renderSmartObject(layer, doc);
  doc.commit(`Smart Filter: ${entry.name}`);
  return true;
}

/**
 * The dialog shared by "add" and "edit": live-previews `buildFilters(params)`
 * through the compositor's layer override.
 * @returns {Promise<object|null>} the accepted params
 */
async function runFilterDialog(doc, layer, def, state, buildFilters) {
  const { paramDialog } = await import('../ui/dialog.js');
  const preview = (params) => {
    if (!params) {
      setLayerPreview(layer.id, null);
      doc.touch('preview');
      return;
    }
    const trial = { ...layer.smart, filters: buildFilters(params) };
    setLayerPreview(layer.id, composeSmartCanvas(trial, doc.width, doc.height, layer, null));
    doc.touch('preview');
  };
  const result = await paramDialog({
    title: filterLabel(def),
    params: def.params,
    state,
    width: def.dialogWidth || 400,
    preview: def.preview !== false,
    onPreview: preview,
  });
  setLayerPreview(layer.id, null);
  doc.touch('preview');
  return result;
}

/**
 * Entry point used by `src/filters/run.js` when a filter is aimed at a smart
 * layer: never burn the filter into the pixels, stack it instead.
 *
 * @param {object} [preset] skip the dialog (Filter > Last Filter, presets)
 */
export async function promptSmartFilter(doc, layer, filterId, preset) {
  const def = getFilter(filterId);
  if (!def) {
    app.toast(`Unknown filter "${filterId}".`, 'error');
    return null;
  }
  if (preset || !def.needsDialog || !def.params || !def.params.length) {
    const params = preset || def.defaults;
    // Filter > Last Filter must repeat what just happened, smart or not.
    app.lastFilter = { id: filterId, params, label: filterLabel(def) };
    return addSmartFilter(doc, layer, filterId, params);
  }
  const pendingId = uid('sfilter');
  const result = await runFilterDialog(doc, layer, def, { ...def.defaults }, (params) => [
    ...copyFilters(getSmartFilters(layer)),
    { id: pendingId, filterId, name: filterLabel(def), params, enabled: true },
  ]);
  if (!result) return null;
  app.lastFilterParams = { ...(app.lastFilterParams || {}), [filterId]: result };
  app.lastFilter = { id: filterId, params: result, label: filterLabel(def) };
  return addSmartFilter(doc, layer, filterId, result);
}

// Let Layer.clone() deep-copy an embedded source without importing PikaDocument
// (document.js already imports layer.js, so the reverse would be a cycle).
setSmartSourceCloner((source) => cloneSourceDocument(source));
