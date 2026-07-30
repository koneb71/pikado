/**
 * Vector path model, geometry, hit-testing and rasterisation.
 *
 * A path is a plain object so it survives `structuredClone` in the history
 * snapshots:
 *
 *   { id, name, subpaths: [ { closed, points: [ {x, y, in, out, corner} ] } ] }
 *
 * `in` / `out` are **absolute** control-point coordinates (not deltas) or
 * `null`. A point with neither handle is a corner point.
 *
 * Shape layers keep the same subpath structure in `layer.shape`:
 *
 *   { kind:'shape'|'fill', subpaths, fill, stroke, radius, sides, star, innerRadius }
 */

import { uid, createCanvas, ctx2d } from '../core/util.js';
import { Selection } from '../core/selection.js';
import { Layer, LayerType } from '../core/layer.js';

/* ------------------------------------------------------------------ */
/* Model                                                               */
/* ------------------------------------------------------------------ */

/**
 * Create an empty path record for `doc.paths`.
 * @param {string} [name]
 */
export function createPath(name = 'Path 1') {
  return { id: uid('path'), name, subpaths: [] };
}

/** An empty subpath. */
export function createSubpath(closed = false) {
  return { closed: !!closed, points: [] };
}

/** An anchor point. Handles are absolute coordinates or null. */
export function createPoint(x, y, inH = null, outH = null) {
  return { x, y, in: inH, out: outH, corner: !inH && !outH };
}

/**
 * Deep copy of a path. The id is preserved so callers can decide whether the
 * copy replaces the original (live editing) or becomes a new entry.
 */
export function clonePath(p) {
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    subpaths: cloneSubpaths(p.subpaths),
  };
}

/** Deep copy of a subpath array. */
export function cloneSubpaths(subpaths) {
  return (subpaths || []).map((sp) => ({
    closed: !!sp.closed,
    points: (sp.points || []).map((pt) => ({
      x: pt.x,
      y: pt.y,
      in: pt.in ? { x: pt.in.x, y: pt.in.y } : null,
      out: pt.out ? { x: pt.out.x, y: pt.out.y } : null,
      corner: pt.corner !== false ? !pt.in && !pt.out : false,
    })),
  }));
}

function subpathsOf(path) {
  if (!path) return [];
  return Array.isArray(path) ? path : path.subpaths || [];
}

function eqPt(a, b) {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
}

function lerpPt(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** The four control points of segment `i` of a subpath. */
export function segmentOf(sp, i) {
  const pts = sp.points;
  const n = pts.length;
  const a = pts[i];
  const b = pts[(i + 1) % n];
  if (!a || !b) return null;
  return {
    p0: { x: a.x, y: a.y },
    c1: a.out ? { x: a.out.x, y: a.out.y } : { x: a.x, y: a.y },
    c2: b.in ? { x: b.in.x, y: b.in.y } : { x: b.x, y: b.y },
    p3: { x: b.x, y: b.y },
    straight: !a.out && !b.in,
  };
}

/** How many drawable segments a subpath has. */
export function segmentCount(sp) {
  const n = (sp.points || []).length;
  if (n < 2) return 0;
  return sp.closed ? n : n - 1;
}

function cubicAt(s, t) {
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return {
    x: a * s.p0.x + b * s.c1.x + c * s.c2.x + d * s.p3.x,
    y: a * s.p0.y + b * s.c1.y + c * s.c2.y + d * s.p3.y,
  };
}

/** Point on segment `segIndex` of subpath `si` at parameter `t`. */
export function pointOnSegment(path, si, segIndex, t) {
  const sp = subpathsOf(path)[si];
  if (!sp) return null;
  const s = segmentOf(sp, segIndex);
  return s ? cubicAt(s, t) : null;
}

/* ------------------------------------------------------------------ */
/* Path2D + bounds                                                     */
/* ------------------------------------------------------------------ */

/** Build a Path2D (document space) from a subpath array. */
export function subpathsToPath2D(subpaths) {
  const p = new Path2D();
  for (const sp of subpaths || []) {
    const pts = sp.points || [];
    if (!pts.length) continue;
    p.moveTo(pts[0].x, pts[0].y);
    const segs = segmentCount(sp);
    for (let i = 0; i < segs; i++) {
      const s = segmentOf(sp, i);
      if (s.straight) p.lineTo(s.p3.x, s.p3.y);
      else p.bezierCurveTo(s.c1.x, s.c1.y, s.c2.x, s.c2.y, s.p3.x, s.p3.y);
    }
    if (sp.closed) p.closePath();
  }
  return p;
}

/**
 * @param {object|Array} path a path record or a bare subpath array
 * @returns {Path2D}
 */
export function pathToPath2D(path) {
  return subpathsToPath2D(subpathsOf(path));
}

function cubicAxisBounds(a, b, c, d) {
  let lo = Math.min(a, d), hi = Math.max(a, d);
  const u = b - a, v = c - b, w = d - c;
  const A = u - 2 * v + w;
  const B = 2 * (v - u);
  const C = u;
  const roots = [];
  if (Math.abs(A) < 1e-9) {
    if (Math.abs(B) > 1e-9) roots.push(-C / B);
  } else {
    const disc = B * B - 4 * A * C;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      roots.push((-B + s) / (2 * A), (-B - s) / (2 * A));
    }
  }
  for (const t of roots) {
    if (!(t > 0 && t < 1)) continue;
    const mt = 1 - t;
    const val = mt * mt * mt * a + 3 * mt * mt * t * b + 3 * mt * t * t * c + t * t * t * d;
    if (val < lo) lo = val;
    if (val > hi) hi = val;
  }
  return [lo, hi];
}

/** Tight bounding box including bezier extrema, or null when empty. */
export function subpathsBounds(subpaths) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x, y) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const sp of subpaths || []) {
    const pts = sp.points || [];
    if (!pts.length) continue;
    if (pts.length === 1) { grow(pts[0].x, pts[0].y); continue; }
    const segs = segmentCount(sp);
    for (let i = 0; i < segs; i++) {
      const s = segmentOf(sp, i);
      if (s.straight) {
        grow(s.p0.x, s.p0.y);
        grow(s.p3.x, s.p3.y);
      } else {
        const [x0, x1] = cubicAxisBounds(s.p0.x, s.c1.x, s.c2.x, s.p3.x);
        const [y0, y1] = cubicAxisBounds(s.p0.y, s.c1.y, s.c2.y, s.p3.y);
        grow(x0, y0);
        grow(x1, y1);
      }
    }
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** @param {object|Array} path */
export function pathBounds(path) {
  return subpathsBounds(subpathsOf(path));
}

/* ------------------------------------------------------------------ */
/* Hit testing                                                         */
/* ------------------------------------------------------------------ */

/**
 * Find an anchor or handle near (x, y).
 * @returns {{subpathIndex:number, pointIndex:number, kind:'anchor'|'in'|'out'}|null}
 */
export function hitTestPoint(path, x, y, tol = 5) {
  const subpaths = subpathsOf(path);
  const t2 = tol * tol;
  let best = null;
  let bestD = Infinity;
  // Anchors win over handles so clicking a point never grabs its handle.
  for (let si = 0; si < subpaths.length; si++) {
    const pts = subpaths[si].points || [];
    for (let pi = 0; pi < pts.length; pi++) {
      const d = (pts[pi].x - x) ** 2 + (pts[pi].y - y) ** 2;
      if (d <= t2 && d < bestD) {
        bestD = d;
        best = { subpathIndex: si, pointIndex: pi, kind: 'anchor' };
      }
    }
  }
  if (best) return best;
  for (let si = 0; si < subpaths.length; si++) {
    const pts = subpaths[si].points || [];
    for (let pi = 0; pi < pts.length; pi++) {
      for (const kind of ['in', 'out']) {
        const h = pts[pi][kind];
        if (!h) continue;
        const d = (h.x - x) ** 2 + (h.y - y) ** 2;
        if (d <= t2 && d < bestD) {
          bestD = d;
          best = { subpathIndex: si, pointIndex: pi, kind };
        }
      }
    }
  }
  return best;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t, cy = ay + dy * t;
  return { d2: (px - cx) ** 2 + (py - cy) ** 2, t };
}

/**
 * Find the curve segment under (x, y).
 * @returns {{subpathIndex:number, segmentIndex:number, t:number}|null}
 */
export function hitTestSegment(path, x, y, tol = 5) {
  const subpaths = subpathsOf(path);
  const t2 = tol * tol;
  let best = null;
  let bestD = Infinity;
  const STEPS = 24;
  for (let si = 0; si < subpaths.length; si++) {
    const sp = subpaths[si];
    const segs = segmentCount(sp);
    for (let i = 0; i < segs; i++) {
      const s = segmentOf(sp, i);
      let prev = s.p0;
      for (let k = 1; k <= STEPS; k++) {
        const t1 = k / STEPS;
        const cur = s.straight ? lerpPt(s.p0, s.p3, t1) : cubicAt(s, t1);
        const r = distToSegment(x, y, prev.x, prev.y, cur.x, cur.y);
        if (r.d2 < bestD) {
          bestD = r.d2;
          best = { subpathIndex: si, segmentIndex: i, t: (k - 1 + r.t) / STEPS };
        }
        prev = cur;
      }
    }
  }
  if (!best || bestD > t2) return null;
  // Refine with a short local search so inserted points land on the curve.
  const sp = subpaths[best.subpathIndex];
  const s = segmentOf(sp, best.segmentIndex);
  let lo = Math.max(0, best.t - 1 / STEPS);
  let hi = Math.min(1, best.t + 1 / STEPS);
  for (let it = 0; it < 18; it++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const a = cubicAt(s, m1), b = cubicAt(s, m2);
    if ((a.x - x) ** 2 + (a.y - y) ** 2 < (b.x - x) ** 2 + (b.y - y) ** 2) hi = m2;
    else lo = m1;
  }
  best.t = (lo + hi) / 2;
  return best;
}

/** True when (x, y) is inside the filled path. */
export function containsPoint(path, x, y, fillRule = 'nonzero') {
  const cv = createCanvas(1, 1);
  const c = ctx2d(cv);
  return c.isPointInPath(pathToPath2D(path), x, y, fillRule);
}

/* ------------------------------------------------------------------ */
/* Editing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Split segment `segIndex` at `t` with de Casteljau so the curve shape is
 * preserved exactly.
 * @returns {{subpathIndex:number, pointIndex:number}|null}
 */
export function insertPointAt(path, si, segIndex, t) {
  const sp = subpathsOf(path)[si];
  if (!sp) return null;
  const pts = sp.points;
  const n = pts.length;
  const a = pts[segIndex];
  const b = pts[(segIndex + 1) % n];
  if (!a || !b) return null;
  t = Math.max(0.0005, Math.min(0.9995, t));

  if (!a.out && !b.in) {
    const np = createPoint(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    pts.splice(segIndex + 1, 0, np);
    return { subpathIndex: si, pointIndex: segIndex + 1 };
  }

  const s = segmentOf(sp, segIndex);
  const q0 = lerpPt(s.p0, s.c1, t);
  const q1 = lerpPt(s.c1, s.c2, t);
  const q2 = lerpPt(s.c2, s.p3, t);
  const r0 = lerpPt(q0, q1, t);
  const r1 = lerpPt(q1, q2, t);
  const m = lerpPt(r0, r1, t);

  a.out = eqPt(q0, s.p0) ? null : q0;
  if (!a.out && !a.in) a.corner = true;
  b.in = eqPt(q2, s.p3) ? null : q2;
  if (!b.in && !b.out) b.corner = true;

  const np = {
    x: m.x,
    y: m.y,
    in: eqPt(r0, m) ? null : r0,
    out: eqPt(r1, m) ? null : r1,
    corner: false,
  };
  if (!np.in && !np.out) np.corner = true;
  pts.splice(segIndex + 1, 0, np);
  return { subpathIndex: si, pointIndex: segIndex + 1 };
}

/** Remove an anchor. Empty subpaths are dropped. */
export function removePoint(path, si, pi) {
  const subpaths = subpathsOf(path);
  const sp = subpaths[si];
  if (!sp || !sp.points[pi]) return false;
  sp.points.splice(pi, 1);
  if (sp.points.length < 2) subpaths.splice(si, 1);
  return true;
}

/**
 * Toggle a point between a corner (no handles) and a smooth point whose
 * handles are derived from its neighbours.
 */
export function convertPoint(path, si, pi, toSmooth) {
  const sp = subpathsOf(path)[si];
  if (!sp) return null;
  const pts = sp.points;
  const p = pts[pi];
  if (!p) return null;
  if (!toSmooth) {
    p.in = null;
    p.out = null;
    p.corner = true;
    return p;
  }
  const n = pts.length;
  const prev = sp.closed ? pts[(pi - 1 + n) % n] : pts[pi - 1];
  const next = sp.closed ? pts[(pi + 1) % n] : pts[pi + 1];
  if (!prev && !next) return p;
  const a = prev || p;
  const b = next || p;
  let tx = b.x - a.x, ty = b.y - a.y;
  const l = Math.hypot(tx, ty) || 1;
  tx /= l; ty /= l;
  const dIn = prev ? Math.hypot(p.x - prev.x, p.y - prev.y) / 3 : 0;
  const dOut = next ? Math.hypot(next.x - p.x, next.y - p.y) / 3 : 0;
  p.in = prev ? { x: p.x - tx * dIn, y: p.y - ty * dIn } : null;
  p.out = next ? { x: p.x + tx * dOut, y: p.y + ty * dOut } : null;
  p.corner = false;
  return p;
}

/**
 * Give every point in a subpath Catmull-Rom derived handles so the polyline
 * becomes a smooth curve through the same anchors.
 */
export function smoothSubpath(sp, tension = 1, keepCorners = false) {
  const pts = sp.points || [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (keepCorners && p.corner === true) continue;
    const prev = sp.closed ? pts[(i - 1 + n) % n] : pts[i - 1];
    const next = sp.closed ? pts[(i + 1) % n] : pts[i + 1];
    if (!prev && !next) continue;
    const a = prev || p;
    const b = next || p;
    let tx = (b.x - a.x) / 6 * tension;
    let ty = (b.y - a.y) / 6 * tension;
    p.in = prev ? { x: p.x - tx, y: p.y - ty } : null;
    p.out = next ? { x: p.x + tx, y: p.y + ty } : null;
    p.corner = !p.in && !p.out;
  }
  return sp;
}

/** Apply a DOMMatrix to every anchor and handle, in place. */
export function transformPath(path, m) {
  transformSubpaths(subpathsOf(path), m);
  return path;
}

/** Apply a DOMMatrix to a subpath array, in place. */
export function transformSubpaths(subpaths, m) {
  const tp = (p) => {
    const q = m.transformPoint(new DOMPoint(p.x, p.y));
    p.x = q.x;
    p.y = q.y;
  };
  for (const sp of subpaths || []) {
    for (const p of sp.points || []) {
      tp(p);
      if (p.in) tp(p.in);
      if (p.out) tp(p.out);
    }
  }
  return subpaths;
}

/** Move every point by (dx, dy), in place. */
export function translateSubpaths(subpaths, dx, dy) {
  for (const sp of subpaths || []) {
    for (const p of sp.points || []) {
      p.x += dx; p.y += dy;
      if (p.in) { p.in.x += dx; p.in.y += dy; }
      if (p.out) { p.out.x += dx; p.out.y += dy; }
    }
  }
  return subpaths;
}

/* ------------------------------------------------------------------ */
/* Curve fitting (Schneider)                                           */
/* ------------------------------------------------------------------ */

function vSub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
function vAdd(a, b) { return { x: a.x + b.x, y: a.y + b.y }; }
function vMul(a, s) { return { x: a.x * s, y: a.y * s }; }
function vDot(a, b) { return a.x * b.x + a.y * b.y; }
function vNorm(a) {
  const l = Math.hypot(a.x, a.y);
  return l < 1e-9 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

function bezierEval(bez, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * mt * bez[0].x + 3 * mt * mt * t * bez[1].x + 3 * mt * t * t * bez[2].x + t * t * t * bez[3].x,
    y: mt * mt * mt * bez[0].y + 3 * mt * mt * t * bez[1].y + 3 * mt * t * t * bez[2].y + t * t * t * bez[3].y,
  };
}

function chordLengthParameterize(pts, first, last) {
  const u = [0];
  for (let i = first + 1; i <= last; i++) {
    u.push(u[u.length - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const total = u[u.length - 1] || 1;
  for (let i = 0; i < u.length; i++) u[i] /= total;
  return u;
}

function generateBezier(pts, first, last, uPrime, tHat1, tHat2) {
  const nPts = last - first + 1;
  const A = [];
  for (let i = 0; i < nPts; i++) {
    const u = uPrime[i];
    const mt = 1 - u;
    A.push([vMul(tHat1, 3 * u * mt * mt), vMul(tHat2, 3 * mt * u * u)]);
  }
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  const p0 = pts[first], p3 = pts[last];
  for (let i = 0; i < nPts; i++) {
    const u = uPrime[i];
    const mt = 1 - u;
    c00 += vDot(A[i][0], A[i][0]);
    c01 += vDot(A[i][0], A[i][1]);
    c11 += vDot(A[i][1], A[i][1]);
    const base = {
      x: p0.x * mt * mt * mt + p0.x * 3 * mt * mt * u + p3.x * 3 * mt * u * u + p3.x * u * u * u,
      y: p0.y * mt * mt * mt + p0.y * 3 * mt * mt * u + p3.y * 3 * mt * u * u + p3.y * u * u * u,
    };
    const tmp = vSub(pts[first + i], base);
    x0 += vDot(A[i][0], tmp);
    x1 += vDot(A[i][1], tmp);
  }
  const detC = c00 * c11 - c01 * c01;
  const detX0 = x0 * c11 - c01 * x1;
  const detX1 = c00 * x1 - x0 * c01;
  let alphaL = Math.abs(detC) < 1e-12 ? 0 : detX0 / detC;
  let alphaR = Math.abs(detC) < 1e-12 ? 0 : detX1 / detC;
  const segLen = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  const epsilon = 1e-6 * segLen;
  if (alphaL < epsilon || alphaR < epsilon) {
    const d = segLen / 3;
    alphaL = d;
    alphaR = d;
  }
  return [p0, vAdd(p0, vMul(tHat1, alphaL)), vAdd(p3, vMul(tHat2, alphaR)), p3];
}

function computeMaxError(pts, first, last, bez, u) {
  let maxDist = 0;
  let splitPoint = Math.floor((last - first + 1) / 2);
  for (let i = first + 1; i < last; i++) {
    const p = bezierEval(bez, u[i - first]);
    const dist = (p.x - pts[i].x) ** 2 + (p.y - pts[i].y) ** 2;
    if (dist >= maxDist) {
      maxDist = dist;
      splitPoint = i;
    }
  }
  return { error: maxDist, splitPoint };
}

function reparameterize(pts, first, last, u, bez) {
  const out = [];
  for (let i = first; i <= last; i++) {
    const t = u[i - first];
    const mt = 1 - t;
    const q = bezierEval(bez, t);
    const q1 = [
      vMul(vSub(bez[1], bez[0]), 3),
      vMul(vSub(bez[2], bez[1]), 3),
      vMul(vSub(bez[3], bez[2]), 3),
    ];
    const q2 = [vMul(vSub(q1[1], q1[0]), 2), vMul(vSub(q1[2], q1[1]), 2)];
    const qd = {
      x: mt * mt * q1[0].x + 2 * mt * t * q1[1].x + t * t * q1[2].x,
      y: mt * mt * q1[0].y + 2 * mt * t * q1[1].y + t * t * q1[2].y,
    };
    const qdd = { x: mt * q2[0].x + t * q2[1].x, y: mt * q2[0].y + t * q2[1].y };
    const d = vSub(q, pts[i]);
    const num = d.x * qd.x + d.y * qd.y;
    const den = qd.x * qd.x + qd.y * qd.y + d.x * qdd.x + d.y * qdd.y;
    out.push(Math.abs(den) < 1e-12 ? t : t - num / den);
  }
  return out;
}

function fitCubicRec(pts, first, last, tHat1, tHat2, tol, out, depth) {
  const nPts = last - first + 1;
  if (nPts === 2) {
    const dist = Math.hypot(pts[last].x - pts[first].x, pts[last].y - pts[first].y) / 3;
    out.push([
      pts[first],
      vAdd(pts[first], vMul(tHat1, dist)),
      vAdd(pts[last], vMul(tHat2, dist)),
      pts[last],
    ]);
    return;
  }
  let u = chordLengthParameterize(pts, first, last);
  let bez = generateBezier(pts, first, last, u, tHat1, tHat2);
  let { error, splitPoint } = computeMaxError(pts, first, last, bez, u);
  if (error < tol * tol) { out.push(bez); return; }
  if (error < (tol * 4) ** 2 && depth < 12) {
    for (let i = 0; i < 12; i++) {
      const uPrime = reparameterize(pts, first, last, u, bez);
      bez = generateBezier(pts, first, last, uPrime, tHat1, tHat2);
      const r = computeMaxError(pts, first, last, bez, uPrime);
      u = uPrime;
      error = r.error;
      splitPoint = r.splitPoint;
      if (error < tol * tol) { out.push(bez); return; }
    }
  }
  if (depth > 24) { out.push(bez); return; }
  let tHatCenter = vNorm(vSub(pts[splitPoint - 1], pts[splitPoint + 1]));
  fitCubicRec(pts, first, splitPoint, tHat1, tHatCenter, tol, out, depth + 1);
  fitCubicRec(pts, splitPoint, last, { x: -tHatCenter.x, y: -tHatCenter.y }, tHat2, tol, out, depth + 1);
}

/**
 * Least-squares (Schneider) bezier fit through sampled points.
 * @param {{x:number,y:number}[]} points
 * @param {number} tolerance max deviation in document pixels
 * @returns {{closed:boolean, points:object[]}} a subpath
 */
export function fitCurve(points, tolerance = 2) {
  const pts = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.4) pts.push({ x: p.x, y: p.y });
  }
  const sp = createSubpath(false);
  if (pts.length < 2) {
    if (pts.length === 1) sp.points.push(createPoint(pts[0].x, pts[0].y));
    return sp;
  }
  const beziers = [];
  const tHat1 = vNorm(vSub(pts[1], pts[0]));
  const tHat2 = vNorm(vSub(pts[pts.length - 2], pts[pts.length - 1]));
  fitCubicRec(pts, 0, pts.length - 1, tHat1, tHat2, Math.max(0.3, tolerance), beziers, 0);
  if (!beziers.length) return sp;

  sp.points.push({ x: beziers[0][0].x, y: beziers[0][0].y, in: null, out: null, corner: false });
  for (let i = 0; i < beziers.length; i++) {
    const b = beziers[i];
    const start = sp.points[sp.points.length - 1];
    start.out = eqPt(b[1], b[0]) ? null : { x: b[1].x, y: b[1].y };
    start.corner = !start.in && !start.out;
    sp.points.push({
      x: b[3].x,
      y: b[3].y,
      in: eqPt(b[2], b[3]) ? null : { x: b[2].x, y: b[2].y },
      out: null,
      corner: false,
    });
  }
  const lastPt = sp.points[sp.points.length - 1];
  lastPt.corner = !lastPt.in && !lastPt.out;
  return sp;
}

/* ------------------------------------------------------------------ */
/* Rasterisation                                                       */
/* ------------------------------------------------------------------ */

const DASH_PRESETS = {
  solid: null,
  dash: [3, 2],
  'dash-tight': [2, 1],
  dot: [1, 2],
  'dash-dot': [4, 2, 1, 2],
  'long-dash': [7, 3],
};

function dashArrayFor(dash, lineWidth) {
  if (!dash || dash === 'solid' || dash === 'none') return null;
  if (Array.isArray(dash)) {
    // An explicit array is already in document units.
    const arr = dash.map(Number).filter((n) => Number.isFinite(n) && n > 0);
    return arr.length ? arr : null;
  }
  const arr = DASH_PRESETS[dash];
  if (!arr || !arr.length) return null;
  // Presets are multiples of the line width, like Photoshop's dash presets.
  return arr.map((n) => Math.max(0.1, n * lineWidth));
}

function colorCss(c) {
  if (!c) return '#000000';
  if (typeof c === 'string') return c;
  if (typeof c === 'object' && 'r' in c) {
    return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${c.a == null ? 1 : c.a})`;
  }
  return String(c);
}

/** Normalise the many shapes a fill descriptor can take into one object. */
function normalizeFill(shape) {
  const f = shape.fill;
  if (f === 'none' || f === null) return null;
  if (f && typeof f === 'object') {
    if (f.type === 'none') return null;
    return f;
  }
  if (typeof f === 'string') return { type: 'solid', color: f };
  // Fill layers created by layers/ops.js spread their params onto the shape.
  if (shape.kind === 'fill') {
    if (shape.fillKind === 'gradient') {
      return { type: 'linear', stops: shape.stops || [{ pos: 0, color: '#000' }, { pos: 1, color: '#fff' }], angle: shape.angle || 0 };
    }
    if (shape.fillKind === 'pattern' && shape.pattern) return { type: 'pattern', canvas: shape.pattern, scale: shape.scale || 1 };
    return { type: 'solid', color: shape.color || '#808080' };
  }
  return { type: 'solid', color: shape.color || '#000000' };
}

function makeFillStyle(c, fill, box) {
  if (!fill) return null;
  if (fill.type === 'pattern' && fill.canvas) {
    const pat = c.createPattern(fill.canvas, 'repeat');
    if (fill.scale && fill.scale !== 1 && pat.setTransform) {
      pat.setTransform(new DOMMatrix().scaleSelf(fill.scale, fill.scale));
    }
    return pat;
  }
  const stops = fill.stops && fill.stops.length ? fill.stops : null;
  if ((fill.type === 'linear' || fill.type === 'gradient') && stops) {
    const a = ((fill.angle || 0) * Math.PI) / 180;
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const r = (Math.abs(box.width * Math.cos(a)) + Math.abs(box.height * Math.sin(a))) / 2;
    const g = c.createLinearGradient(cx - Math.cos(a) * r, cy - Math.sin(a) * r, cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    for (const s of stops) g.addColorStop(Math.max(0, Math.min(1, s.pos == null ? s.offset || 0 : s.pos)), colorCss(s.color));
    return g;
  }
  if (fill.type === 'radial' && stops) {
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const r = Math.max(box.width, box.height) / 2 || 1;
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, r);
    for (const s of stops) g.addColorStop(Math.max(0, Math.min(1, s.pos == null ? s.offset || 0 : s.pos)), colorCss(s.color));
    return g;
  }
  return colorCss(fill.color || '#000000');
}

/**
 * Normalise the several stroke spellings a shape can carry into one
 * descriptor, or null when nothing should be stroked. The Properties panel
 * writes `stroke` as a colour string plus flat `strokeWidth` / `strokeAlign` /
 * `dash` keys; the vector tools write a full `{enabled,color,width,…}` object.
 */
function normalizeStroke(shape) {
  const s = shape.stroke;
  let st;
  if (s && typeof s === 'object' && !Array.isArray(s)) st = { ...s };
  else if (typeof s === 'string') st = { color: s };
  else if (s == null) st = {};
  else return null;
  if (st.enabled === false) return null;
  if (st.color == null) st.color = shape.strokeColor || null;
  if (st.width == null) {
    const flat = shape.strokeWidth != null ? shape.strokeWidth : shape.lineWidth;
    st.width = flat != null ? Number(flat) : 1;
  }
  if (st.align == null) st.align = shape.strokeAlign || 'center';
  if (st.dash == null) st.dash = shape.dash || shape.strokeDash || 'solid';
  if (!st.color || st.color === 'none') return null;
  if (!(Number(st.width) > 0)) return null;
  return st;
}

function strokeInto(destCtx, p2, st, w, h) {
  const lw = Math.max(0.05, st.width == null ? 1 : st.width);
  const align = st.align || 'center';
  const paint = (c, width) => {
    c.save();
    c.lineWidth = width;
    c.lineCap = st.cap || 'butt';
    c.lineJoin = st.join || 'miter';
    c.miterLimit = st.miterLimit || 10;
    const dash = dashArrayFor(st.dash, lw);
    if (dash) c.setLineDash(dash);
    c.strokeStyle = colorCss(st.color || '#000000');
    c.stroke(p2);
    c.restore();
  };
  if (align === 'center') { paint(destCtx, lw); return; }
  const tmp = createCanvas(w, h);
  const tc = ctx2d(tmp);
  paint(tc, lw * 2);
  tc.globalCompositeOperation = align === 'inside' ? 'destination-in' : 'destination-out';
  tc.fillStyle = '#000';
  tc.fill(p2, 'nonzero');
  tc.globalCompositeOperation = 'source-over';
  destCtx.drawImage(tmp, 0, 0);
}

/**
 * Stroke a path onto a fresh canvas.
 * @param {object|Array} path
 * @param {{color?:string, width?:number, align?:string, cap?:string, join?:string, dash?:any}} opts
 */
export function strokePathToCanvas(path, opts = {}, w = 0, h = 0) {
  const b = pathBounds(path) || { x: 0, y: 0, width: 1, height: 1 };
  const width = w || Math.ceil(b.x + b.width + (opts.width || 1));
  const height = h || Math.ceil(b.y + b.height + (opts.width || 1));
  const cv = createCanvas(width, height);
  const c = ctx2d(cv);
  strokeInto(c, pathToPath2D(path), { width: 1, color: '#000000', ...opts }, width, height);
  return cv;
}

/** Rasterise a path into a selection coverage mask. */
export function pathToSelectionMask(path, w, h, opts = {}) {
  return Selection.rasterizePath(pathToPath2D(path), w, h, opts);
}

/**
 * Render a shape layer into a document-sized canvas.
 * Called by `src/layers/ops.js` and by every shape/pen tool after an edit.
 * @param {import('../core/layer.js').Layer} layer
 * @param {import('../core/document.js').PikaDocument} doc
 * @returns {HTMLCanvasElement}
 */
export function rasterizeShapeLayer(layer, doc) {
  const w = doc ? doc.width : 1;
  const h = doc ? doc.height : 1;
  const cv = createCanvas(w, h);
  const shape = layer && layer.shape;
  if (!shape || !shape.subpaths || !shape.subpaths.length) return cv;

  const c = ctx2d(cv);
  const p2 = subpathsToPath2D(shape.subpaths);
  const box = subpathsBounds(shape.subpaths) || { x: 0, y: 0, width: w, height: h };

  const fill = normalizeFill(shape);
  if (fill) {
    const style = makeFillStyle(c, fill, box);
    if (style) {
      c.save();
      if (fill.opacity != null) c.globalAlpha = fill.opacity;
      c.fillStyle = style;
      c.fill(p2, shape.fillRule || 'nonzero');
      c.restore();
    }
  }

  const st = normalizeStroke(shape);
  if (st) strokeInto(c, p2, st, w, h);
  return cv;
}

/* ------------------------------------------------------------------ */
/* Layer / document helpers used by the vector tools                   */
/* ------------------------------------------------------------------ */

/** Default shape style for a freshly drawn shape layer. */
export function defaultShapeStyle(over = {}) {
  return {
    fill: { type: 'solid', color: '#4a90d9' },
    stroke: { enabled: false, color: '#000000', width: 1, align: 'center', cap: 'butt', join: 'miter', dash: 'solid' },
    ...over,
  };
}

/**
 * Build a SHAPE layer from subpaths and rasterise it. The layer is *not*
 * inserted into the document — callers decide where it goes.
 */
export function createShapeLayer(doc, subpaths, style = {}, name = 'Shape') {
  const l = new Layer({ type: LayerType.SHAPE, name });
  l.shape = {
    kind: 'shape',
    subpaths: cloneSubpaths(subpaths),
    fill: style.fill === undefined ? { type: 'solid', color: '#4a90d9' } : style.fill,
    stroke: style.stroke === undefined ? { enabled: false, color: '#000000', width: 1, align: 'center', cap: 'butt', join: 'miter', dash: 'solid' } : style.stroke,
  };
  for (const k of ['radius', 'corners', 'sides', 'star', 'innerRadius', 'smoothCorners', 'shapeId', 'weight', 'geometry']) {
    if (style[k] !== undefined) l.shape[k] = style[k];
  }
  l.canvas = rasterizeShapeLayer(l, doc);
  return l;
}

/** Re-run rasterisation after `layer.shape` changed. Caller owns beginEdit. */
export function refreshShapeLayer(doc, layer) {
  if (!layer || layer.type !== LayerType.SHAPE) return;
  layer.canvas = rasterizeShapeLayer(layer, doc);
  layer.thumbDirty = true;
}

/** Give a document-unique name of the form `${base} 1`. */
export function uniqueLayerName(doc, base) {
  const names = new Set(doc.flatLayers().map((l) => l.name));
  let n = 1;
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/**
 * Append subpaths to the active work path (or create one) in `doc.paths`.
 * @returns {object} the path record
 */
export function appendSubpathsToDoc(doc, subpaths, name) {
  let p = doc.paths.find((x) => x.id === doc.activePathId);
  if (!p) {
    const names = new Set(doc.paths.map((x) => x.name));
    let n = 1;
    const base = name || 'Path';
    while (names.has(`${base} ${n}`)) n++;
    p = createPath(`${base} ${n}`);
    doc.paths.push(p);
    doc.activePathId = p.id;
  }
  p.subpaths.push(...cloneSubpaths(subpaths));
  return p;
}

/**
 * Paint subpaths onto a raster layer (the pen/shape "Pixels" mode).
 * The caller must have called `doc.beginEdit(layer)` first.
 */
export function paintSubpathsOnLayer(doc, layer, subpaths, style = {}) {
  const target = layer.paintTarget();
  if (!target) return;
  const p2 = subpathsToPath2D(subpaths);
  const box = subpathsBounds(subpaths) || { x: 0, y: 0, width: doc.width, height: doc.height };

  // Paint into a scratch buffer so an active selection can clip the result.
  const tmp = createCanvas(doc.width, doc.height);
  const tc = ctx2d(tmp);
  const fill = normalizeFill({ fill: style.fill, kind: 'shape' });
  if (fill) {
    const s = makeFillStyle(tc, fill, box);
    if (s) { tc.fillStyle = s; tc.fill(p2, 'nonzero'); }
  }
  const st = normalizeStroke(style);
  if (st) strokeInto(tc, p2, st, doc.width, doc.height);
  if (doc.selection.active) {
    tc.globalCompositeOperation = 'destination-in';
    tc.drawImage(doc.selection.toAlphaCanvas(), 0, 0);
    tc.globalCompositeOperation = 'source-over';
  }
  ctx2d(target).drawImage(tmp, 0, 0);
}

/* ------------------------------------------------------------------ */
/* Editable vector targets in a document                               */
/* ------------------------------------------------------------------ */

/**
 * Everything the vector tools can edit: shape layers (top first) followed by
 * the Paths-panel entries.
 * @returns {{kind:'layer'|'path', layer?:object, path?:object, subpaths:Array}[]}
 */
export function vectorTargets(doc) {
  const out = [];
  if (!doc) return out;
  for (const l of doc.flatLayers()) {
    if (l.type === LayerType.SHAPE && l.shape && l.shape.subpaths && l.shape.subpaths.length) {
      out.push({ kind: 'layer', layer: l, subpaths: l.shape.subpaths });
    }
  }
  for (const p of doc.paths || []) out.push({ kind: 'path', path: p, subpaths: p.subpaths || [] });
  return out;
}

/** The target the pen tools default to when nothing was clicked. */
export function activeVectorTarget(doc) {
  if (!doc) return null;
  const l = doc.activeLayer();
  if (l && l.type === LayerType.SHAPE && l.shape && l.shape.subpaths) {
    return { kind: 'layer', layer: l, subpaths: l.shape.subpaths };
  }
  const p = (doc.paths || []).find((x) => x.id === doc.activePathId) || (doc.paths || [])[0];
  return p ? { kind: 'path', path: p, subpaths: p.subpaths || [] } : null;
}

/** Nearest anchor or handle across every editable target. */
export function findAnchorAt(doc, x, y, tol) {
  for (const t of vectorTargets(doc)) {
    const hit = hitTestPoint(t.subpaths, x, y, tol);
    if (hit) return { target: t, hit };
  }
  return null;
}

/** Nearest curve segment across every editable target. */
export function findSegmentAt(doc, x, y, tol) {
  for (const t of vectorTargets(doc)) {
    const hit = hitTestSegment(t.subpaths, x, y, tol);
    if (hit) return { target: t, hit };
  }
  return null;
}

/**
 * Target under the cursor for the path-selection tool: inside a filled
 * subpath, or within `tol` of its outline.
 */
export function findShapeAt(doc, x, y, tol) {
  const probe = createCanvas(1, 1).getContext('2d');
  for (const t of vectorTargets(doc)) {
    for (let si = 0; si < t.subpaths.length; si++) {
      const sp = t.subpaths[si];
      if (!sp.points || sp.points.length < 2) continue;
      const p2 = subpathsToPath2D([sp]);
      if (sp.closed && probe.isPointInPath(p2, x, y, 'nonzero')) return { target: t, subpathIndex: si };
      if (hitTestSegment([sp], x, y, tol)) return { target: t, subpathIndex: si };
    }
  }
  return null;
}

/** Copy-on-write before mutating a target's geometry. */
export function beginVectorEdit(doc, target) {
  if (target && target.kind === 'layer') doc.beginEdit(target.layer);
}

/** Re-rasterise and repaint a target without touching history. */
export function touchVectorTarget(doc, target) {
  if (target && target.kind === 'layer') refreshShapeLayer(doc, target.layer);
  doc.touch();
}

/** Re-rasterise a target and record an undo step. */
export function commitVectorTarget(doc, target, label) {
  if (target && target.kind === 'layer') refreshShapeLayer(doc, target.layer);
  doc.commit(label);
}

/* ------------------------------------------------------------------ */
/* Screen-space overlay chrome                                         */
/* ------------------------------------------------------------------ */

const ANCHOR = 3.5;   // half-size of the anchor square, screen px
const HANDLE_R = 3;

/**
 * Draw pen/path chrome in **screen** space.
 * @param {CanvasRenderingContext2D} ctx screen-space context
 * @param {object|Array} path path record or subpath array
 * @param {import('../render/viewport.js').Viewport} view
 * @param {{color?:string, anchors?:boolean, handles?:'none'|'selected'|'all',
 *          selected?:Set<string>, activeHandle?:object, dim?:boolean}} [opts]
 */
export function drawPathOverlay(ctx, path, view, opts = {}) {
  const subpaths = subpathsOf(path);
  if (!subpaths.length) return;
  const color = opts.color || '#3da9ff';
  const selected = opts.selected || null;
  const handleMode = opts.handles || 'selected';

  const S = (p) => view.toScreen(p.x, p.y);

  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = color;
  ctx.setLineDash([]);

  // --- outline -------------------------------------------------------
  const outline = new Path2D();
  for (const sp of subpaths) {
    const pts = sp.points || [];
    if (!pts.length) continue;
    const first = S(pts[0]);
    outline.moveTo(first.x, first.y);
    const segs = segmentCount(sp);
    for (let i = 0; i < segs; i++) {
      const s = segmentOf(sp, i);
      const c1 = S(s.c1), c2 = S(s.c2), p3 = S(s.p3);
      if (s.straight) outline.lineTo(p3.x, p3.y);
      else outline.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p3.x, p3.y);
    }
    if (sp.closed) outline.closePath();
  }
  ctx.strokeStyle = 'rgba(0,0,0,.55)';
  ctx.lineWidth = 2.4;
  ctx.stroke(outline);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke(outline);

  if (opts.anchors === false) { ctx.restore(); return; }

  // --- handles -------------------------------------------------------
  for (let si = 0; si < subpaths.length; si++) {
    const pts = subpaths[si].points || [];
    for (let pi = 0; pi < pts.length; pi++) {
      const p = pts[pi];
      const isSel = selected ? selected.has(`${si}:${pi}`) : false;
      const showHandles = handleMode === 'all' || (handleMode === 'selected' && isSel);
      if (!showHandles) continue;
      const a = S(p);
      for (const kind of ['in', 'out']) {
        const h = p[kind];
        if (!h) continue;
        const hs = S(h);
        ctx.strokeStyle = 'rgba(0,0,0,.5)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(hs.x, hs.y);
        ctx.stroke();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(hs.x, hs.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(hs.x, hs.y, HANDLE_R, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.6)';
        ctx.stroke();
      }
    }
  }

  // --- anchors -------------------------------------------------------
  for (let si = 0; si < subpaths.length; si++) {
    const pts = subpaths[si].points || [];
    for (let pi = 0; pi < pts.length; pi++) {
      const a = S(pts[pi]);
      const isSel = selected ? selected.has(`${si}:${pi}`) : false;
      ctx.beginPath();
      ctx.rect(Math.round(a.x) - ANCHOR, Math.round(a.y) - ANCHOR, ANCHOR * 2, ANCHOR * 2);
      ctx.fillStyle = isSel ? color : '#ffffff';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = isSel ? '#ffffff' : 'rgba(0,0,0,.75)';
      ctx.stroke();
    }
  }
  ctx.restore();
}
