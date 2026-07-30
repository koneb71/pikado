import { createCanvas, clamp255 } from './util.js';

/**
 * A pixel selection stored as an 8-bit coverage mask (0 = unselected,
 * 255 = fully selected). `mask === null` means "no active selection", which
 * every operation treats as "the whole document".
 */
export class Selection {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    /** @type {Uint8ClampedArray|null} */
    this.mask = null;
    this._boundsCache = null;
    this._contourCache = null;
    this._loopCache = null;
    this.version = 0;
  }

  get active() {
    return this.mask !== null;
  }

  _touch() {
    this._boundsCache = null;
    this._contourCache = null;
    this._loopCache = null;
    this.version++;
  }

  clone() {
    const s = new Selection(this.width, this.height);
    if (this.mask) s.mask = new Uint8ClampedArray(this.mask);
    return s;
  }

  clear() {
    this.mask = null;
    this._touch();
  }

  selectAll() {
    this.mask = new Uint8ClampedArray(this.width * this.height).fill(255);
    this._touch();
  }

  set(mask) {
    this.mask = mask;
    this._touch();
  }

  resize(w, h) {
    if (this.mask) {
      const next = new Uint8ClampedArray(w * h);
      const cw = Math.min(w, this.width), ch = Math.min(h, this.height);
      for (let y = 0; y < ch; y++) next.set(this.mask.subarray(y * this.width, y * this.width + cw), y * w);
      this.mask = next;
    }
    this.width = w;
    this.height = h;
    this._touch();
  }

  /** Coverage 0..1 at a pixel. Unselected documents report 1 everywhere. */
  at(x, y) {
    if (!this.mask) return 1;
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.mask[y * this.width + x] / 255;
  }

  /* --------------------------------------------------------------- */
  /* Boolean composition                                              */
  /* --------------------------------------------------------------- */

  /**
   * Combine an incoming coverage mask.
   * @param {Uint8ClampedArray} other
   * @param {'replace'|'add'|'subtract'|'intersect'|'xor'} mode
   */
  combine(other, mode = 'replace') {
    const n = this.width * this.height;
    if (mode === 'replace' || !this.mask) {
      if (mode === 'subtract') return; // nothing to subtract from
      if (mode === 'intersect' && !this.mask) { this.mask = new Uint8ClampedArray(other); this._touch(); return; }
      this.mask = new Uint8ClampedArray(other);
      this._touch();
      this._dropIfEmpty();
      return;
    }
    const m = this.mask;
    switch (mode) {
      case 'add': for (let i = 0; i < n; i++) m[i] = Math.max(m[i], other[i]); break;
      case 'subtract': for (let i = 0; i < n; i++) m[i] = Math.max(0, m[i] - other[i]); break;
      case 'intersect': for (let i = 0; i < n; i++) m[i] = Math.min(m[i], other[i]); break;
      case 'xor': for (let i = 0; i < n; i++) m[i] = Math.abs(m[i] - other[i]); break;
      default: break;
    }
    this._touch();
    this._dropIfEmpty();
  }

  _dropIfEmpty() {
    if (!this.mask) return;
    for (let i = 0; i < this.mask.length; i++) if (this.mask[i] !== 0) return;
    this.mask = null;
    this._touch();
  }

  invert() {
    if (!this.mask) { this.mask = new Uint8ClampedArray(this.width * this.height); this._touch(); return; }
    for (let i = 0; i < this.mask.length; i++) this.mask[i] = 255 - this.mask[i];
    this._touch();
    this._dropIfEmpty();
  }

  /* --------------------------------------------------------------- */
  /* Mask construction from geometry                                  */
  /* --------------------------------------------------------------- */

  /** Rasterise a Path2D (document space) into a coverage mask. */
  static rasterizePath(path, width, height, { antialias = true, fillRule = 'nonzero' } = {}) {
    const cv = createCanvas(width, height);
    const c = cv.getContext('2d', { willReadFrequently: true });
    c.fillStyle = '#fff';
    c.fill(path, fillRule);
    const d = c.getImageData(0, 0, width, height).data;
    const out = new Uint8ClampedArray(width * height);
    if (antialias) {
      for (let i = 0, p = 0; i < d.length; i += 4, p++) out[p] = d[i + 3];
    } else {
      // `imageSmoothingEnabled` does NOT affect the path rasteriser — setting it
      // (as this used to) left the option doing nothing at all. Hard edges have
      // to come from thresholding the coverage the rasteriser produced.
      for (let i = 0, p = 0; i < d.length; i += 4, p++) out[p] = d[i + 3] > 127 ? 255 : 0;
    }
    return out;
  }

  static rectMask(x, y, w, h, width, height) {
    const p = new Path2D();
    p.rect(x, y, w, h);
    return Selection.rasterizePath(p, width, height);
  }

  static ellipseMask(cx, cy, rx, ry, width, height) {
    const p = new Path2D();
    p.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
    return Selection.rasterizePath(p, width, height);
  }

  fromPath(path, mode = 'replace', opts) {
    this.combine(Selection.rasterizePath(path, this.width, this.height, opts), mode);
  }

  /* --------------------------------------------------------------- */
  /* Modify operations                                                */
  /* --------------------------------------------------------------- */

  /** Gaussian-ish feather using a separable box blur run three times. */
  feather(radius) {
    if (!this.mask || radius <= 0) return;
    this.mask = boxBlurMask(this.mask, this.width, this.height, radius);
    this._touch();
  }

  /** Positive grows the selection, negative shrinks it. */
  expand(amount) {
    if (!this.mask || amount === 0) return;
    this.mask = morph(this.mask, this.width, this.height, Math.abs(amount), amount > 0);
    this._touch();
  }

  contract(amount) {
    this.expand(-Math.abs(amount));
  }

  /** Ring of `width` px centred on the current selection edge. */
  border(width) {
    if (!this.mask) return;
    const grow = morph(this.mask, this.width, this.height, Math.ceil(width / 2), true);
    const shrink = morph(this.mask, this.width, this.height, Math.floor(width / 2), false);
    for (let i = 0; i < grow.length; i++) grow[i] = Math.max(0, grow[i] - shrink[i]);
    this.mask = grow;
    this._touch();
  }

  smooth(radius) {
    if (!this.mask || radius <= 0) return;
    const b = boxBlurMask(this.mask, this.width, this.height, radius);
    for (let i = 0; i < b.length; i++) b[i] = b[i] > 127 ? 255 : 0;
    this.mask = b;
    this._touch();
  }

  translate(dx, dy) {
    if (!this.mask) return;
    const next = new Uint8ClampedArray(this.width * this.height);
    dx = Math.round(dx); dy = Math.round(dy);
    for (let y = 0; y < this.height; y++) {
      const sy = y - dy;
      if (sy < 0 || sy >= this.height) continue;
      for (let x = 0; x < this.width; x++) {
        const sx = x - dx;
        if (sx < 0 || sx >= this.width) continue;
        next[y * this.width + x] = this.mask[sy * this.width + sx];
      }
    }
    this.mask = next;
    this._touch();
  }

  /* --------------------------------------------------------------- */
  /* Queries & conversions                                            */
  /* --------------------------------------------------------------- */

  bounds() {
    if (!this.mask) return { x: 0, y: 0, width: this.width, height: this.height };
    if (this._boundsCache) return this._boundsCache;
    let minX = this.width, minY = this.height, maxX = -1, maxY = -1;
    for (let y = 0; y < this.height; y++) {
      const row = y * this.width;
      for (let x = 0; x < this.width; x++) {
        if (this.mask[row + x] !== 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const b = maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
    this._boundsCache = b;
    return b;
  }

  /** Greyscale canvas of the mask (used for Quick Mask & Save Selection). */
  toCanvas() {
    const cv = createCanvas(this.width, this.height);
    const img = new ImageData(this.width, this.height);
    const d = img.data;
    for (let i = 0, p = 0; p < this.width * this.height; p++, i += 4) {
      const v = this.mask ? this.mask[p] : 255;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    cv.getContext('2d').putImageData(img, 0, 0);
    return cv;
  }

  /** Alpha-only canvas, ready to use as a `destination-in` clip source. */
  toAlphaCanvas() {
    const cv = createCanvas(this.width, this.height);
    const img = new ImageData(this.width, this.height);
    const d = img.data;
    for (let i = 0, p = 0; p < this.width * this.height; p++, i += 4) {
      d[i + 3] = this.mask ? this.mask[p] : 255;
    }
    cv.getContext('2d').putImageData(img, 0, 0);
    return cv;
  }

  static fromCanvas(canvas) {
    const w = canvas.width, h = canvas.height;
    const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const s = new Selection(w, h);
    const m = new Uint8ClampedArray(w * h);
    for (let i = 0, p = 0; p < w * h; p++, i += 4) {
      m[p] = clamp255((d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) * (d[i + 3] / 255));
    }
    s.mask = m;
    return s;
  }

  /**
   * Closed boundary loops of the selection, in document coordinates.
   *
   * Each loop is a flat `[x0, y0, x1, y1, …]` array of vertices on the pixel
   * grid, walking clockwise around selected regions (holes come back
   * anticlockwise). Collinear runs are merged, so a rectangle is four points
   * rather than one per pixel.
   *
   * The loops matter for more than tidiness: `setLineDash` restarts its phase at
   * every `moveTo`, so a path made of one subpath per pixel edge renders every
   * dash "on" — a solid line that cannot march. Continuous loops are what make
   * marching ants actually march.
   *
   * @returns {number[][]} one flat vertex array per closed loop
   */
  contourLoops() {
    if (!this.mask) return [];
    if (this._loopCache) return this._loopCache;

    const w = this.width, h = this.height, m = this.mask;
    const on = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? false : m[y * w + x] > 127);
    const vw = w + 1; // vertex grid is one wider than the pixel grid
    const key = (vx, vy) => vy * vw + vx;

    // Directed boundary edges, oriented clockwise around each selected pixel
    // (y grows downward). Only sides facing an unselected neighbour are added,
    // so shared interior edges never appear and the result is already a set of
    // closed loops. Stored as startVertex -> [endVertex, …].
    /** @type {Map<number, number[]>} */
    const out = new Map();
    const add = (ax, ay, bx, by) => {
      const a = key(ax, ay), b = key(bx, by);
      const list = out.get(a);
      if (list) list.push(b);
      else out.set(a, [b]);
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!on(x, y)) continue;
        if (!on(x, y - 1)) add(x, y, x + 1, y);             // top, rightwards
        if (!on(x + 1, y)) add(x + 1, y, x + 1, y + 1);     // right, downwards
        if (!on(x, y + 1)) add(x + 1, y + 1, x, y + 1);     // bottom, leftwards
        if (!on(x - 1, y)) add(x, y + 1, x, y);             // left, upwards
      }
    }

    const dirOf = (a, b) => {
      const d = b - a;
      if (d === 1) return 0;   // +x
      if (d === vw) return 1;  // +y
      if (d === -1) return 2;  // -x
      return 3;                // -y
    };

    const loops = [];
    for (const startKey of out.keys()) {
      // A vertex can begin several loops where regions touch diagonally.
      while (out.get(startKey) && out.get(startKey).length) {
        const pts = [];
        let cur = startKey;
        let dir = -1;
        do {
          const list = out.get(cur);
          if (!list || !list.length) break;

          let pick = 0;
          if (list.length > 1 && dir >= 0) {
            // Ambiguous vertex (two regions meeting corner to corner). Turning
            // as sharply clockwise as possible keeps the two outlines separate
            // instead of stitching them into one figure-of-eight.
            const want = [(dir + 1) % 4, dir, (dir + 3) % 4, (dir + 2) % 4];
            for (const d of want) {
              const i = list.findIndex((n) => dirOf(cur, n) === d);
              if (i >= 0) { pick = i; break; }
            }
          }
          const next = list.splice(pick, 1)[0];
          if (!list.length) out.delete(cur);

          const nd = dirOf(cur, next);
          // Only a change of direction is a corner. Carrying straight on needs no
          // vertex at all — the previous corner still holds, and the segment
          // simply continues to wherever it next turns.
          if (nd !== dir) {
            const vx = cur % vw;
            pts.push(vx, (cur - vx) / vw);
          }
          dir = nd;
          cur = next;
        } while (cur !== startKey);

        // The walk starts wherever the edge map happened to be indexed, which
        // may be part-way along a straight run. If so the first vertex is
        // collinear with the closing segment and is not a corner — drop it.
        if (pts.length >= 8) {
          const n = pts.length;
          const inDx = Math.sign(pts[0] - pts[n - 2]);
          const inDy = Math.sign(pts[1] - pts[n - 1]);
          const outDx = Math.sign(pts[2] - pts[0]);
          const outDy = Math.sign(pts[3] - pts[1]);
          if (inDx === outDx && inDy === outDy) pts.splice(0, 2);
        }
        if (pts.length >= 6) loops.push(pts);
      }
    }

    this._loopCache = loops;
    return loops;
  }

  /**
   * Marching-ants outline as a Path2D in document coordinates, built from
   * {@link contourLoops} so dash patterns run continuously along each loop.
   */
  contour() {
    if (!this.mask) return null;
    if (this._contourCache) return this._contourCache;
    const p = new Path2D();
    for (const loop of this.contourLoops()) {
      p.moveTo(loop[0], loop[1]);
      for (let i = 2; i < loop.length; i += 2) p.lineTo(loop[i], loop[i + 1]);
      p.closePath();
    }
    this._contourCache = p;
    return p;
  }
}

/* ------------------------------------------------------------------ */
/* Mask helpers                                                        */
/* ------------------------------------------------------------------ */

function boxBlurPass(src, dst, w, h, r) {
  const div = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[row + Math.min(w - 1, Math.max(0, i))];
    for (let x = 0; x < w; x++) {
      dst[row + x] = sum / div;
      const add = src[row + Math.min(w - 1, x + r + 1)];
      const sub = src[row + Math.max(0, x - r)];
      sum += add - sub;
    }
  }
}

function transpose(src, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[x * h + y] = src[y * w + x];
  return out;
}

export function boxBlurMask(mask, w, h, radius) {
  const r = Math.max(1, Math.round(radius));
  let a = Float32Array.from(mask);
  let b = new Float32Array(w * h);
  for (let pass = 0; pass < 3; pass++) {
    boxBlurPass(a, b, w, h, r);
    let t = transpose(b, w, h);
    let t2 = new Float32Array(w * h);
    boxBlurPass(t, t2, h, w, r);
    a = transpose(t2, h, w);
  }
  const out = new Uint8ClampedArray(w * h);
  for (let i = 0; i < out.length; i++) out[i] = a[i];
  return out;
}

/** Chamfer distance-transform based dilate (grow=true) / erode. */
export function morph(mask, w, h, radius, grow) {
  if (radius <= 0) return new Uint8ClampedArray(mask);
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const inside = mask[i] > 127;
    d[i] = (grow ? inside : !inside) ? 0 : INF;
  }
  // forward pass
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) v = Math.min(v, d[i - w] + 1);
      if (x > 0 && y > 0) v = Math.min(v, d[i - w - 1] + 1.414);
      if (x < w - 1 && y > 0) v = Math.min(v, d[i - w + 1] + 1.414);
      d[i] = v;
    }
  }
  // backward pass
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < h - 1) v = Math.min(v, d[i + w] + 1);
      if (x < w - 1 && y < h - 1) v = Math.min(v, d[i + w + 1] + 1.414);
      if (x > 0 && y < h - 1) v = Math.min(v, d[i + w - 1] + 1.414);
      d[i] = v;
    }
  }
  const out = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) {
    if (grow) out[i] = d[i] <= radius ? 255 : 0;
    else out[i] = d[i] > radius ? 255 : 0;
  }
  return out;
}
