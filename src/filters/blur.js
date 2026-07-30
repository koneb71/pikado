/**
 * Filter > Blur.
 *
 * The averaging blurs all run on a premultiplied Float32 buffer so colour is
 * never dragged out of transparent pixels. The edge preserving ones (Smart /
 * Surface) run on straight RGBA and fold alpha into the range metric, which
 * keeps transparent and opaque neighbours from mixing.
 *
 * Everything is O(1)-per-pixel in the radius wherever that is possible:
 * running prefix sums for box/motion, three box passes for large gaussians,
 * and span-decomposed kernels (on a downsampled buffer) for the shaped blurs.
 */

import { registerFilter, separableConvolve, gaussianKernel } from './registry.js';
import { blurImageData } from '../render/fast-blur.js';

/* ------------------------------------------------------------------ */
/* Premultiplied float buffers                                         */
/* ------------------------------------------------------------------ */

/**
 * Copy an ImageData into a premultiplied Float32 buffer `[r*a, g*a, b*a, a]`
 * where alpha stays in 0..255.
 * @param {ImageData} imageData
 * @returns {Float32Array}
 */
export function premultiplyImageData(imageData) {
  const d = imageData.data;
  const buf = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    const f = a / 255;
    buf[i] = d[i] * f;
    buf[i + 1] = d[i + 1] * f;
    buf[i + 2] = d[i + 2] * f;
    buf[i + 3] = a;
  }
  return buf;
}

/**
 * Write a premultiplied Float32 buffer back into an ImageData, undoing the
 * premultiplication.
 * @param {Float32Array} buf
 * @param {ImageData} imageData
 */
export function unpremultiplyInto(buf, imageData) {
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = buf[i + 3];
    if (a <= 0.4) {
      d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 0;
      continue;
    }
    const inv = 255 / a;
    d[i] = buf[i] * inv;
    d[i + 1] = buf[i + 1] * inv;
    d[i + 2] = buf[i + 2] * inv;
    d[i + 3] = a;
  }
}

/* ------------------------------------------------------------------ */
/* Box / gaussian                                                      */
/* ------------------------------------------------------------------ */

function boxPassH(buf, w, h, r, ch) {
  const pref = new Float64Array((w + 1) * ch);
  const row = new Float32Array(w * ch);
  const denom = 2 * r + 1;
  const stride = w * ch;
  for (let y = 0; y < h; y++) {
    const base = y * stride;
    for (let c = 0; c < ch; c++) pref[c] = 0;
    for (let x = 0; x < w; x++) {
      const pi = (x + 1) * ch, qi = x * ch, si = base + qi;
      for (let c = 0; c < ch; c++) pref[pi + c] = pref[qi + c] + buf[si + c];
    }
    const lastBase = base + (w - 1) * ch;
    for (let x = 0; x < w; x++) {
      const lo = x - r, hi = x + r + 1;
      const leftExtra = lo < 0 ? -lo : 0;
      const rightExtra = hi > w ? hi - w : 0;
      const ai = (lo < 0 ? 0 : lo) * ch;
      const bi = (hi > w ? w : hi) * ch;
      const oi = x * ch;
      for (let c = 0; c < ch; c++) {
        let s = pref[bi + c] - pref[ai + c];
        if (leftExtra) s += leftExtra * buf[base + c];
        if (rightExtra) s += rightExtra * buf[lastBase + c];
        row[oi + c] = s / denom;
      }
    }
    buf.set(row, base);
  }
}

function boxPassV(buf, w, h, r, ch) {
  const pref = new Float64Array((h + 1) * ch);
  const col = new Float32Array(h * ch);
  const denom = 2 * r + 1;
  const stride = w * ch;
  for (let x = 0; x < w; x++) {
    const cbase = x * ch;
    for (let c = 0; c < ch; c++) pref[c] = 0;
    for (let y = 0; y < h; y++) {
      const pi = (y + 1) * ch, qi = y * ch, si = y * stride + cbase;
      for (let c = 0; c < ch; c++) pref[pi + c] = pref[qi + c] + buf[si + c];
    }
    const firstBase = cbase, lastBase = (h - 1) * stride + cbase;
    for (let y = 0; y < h; y++) {
      const lo = y - r, hi = y + r + 1;
      const topExtra = lo < 0 ? -lo : 0;
      const botExtra = hi > h ? hi - h : 0;
      const ai = (lo < 0 ? 0 : lo) * ch;
      const bi = (hi > h ? h : hi) * ch;
      const oi = y * ch;
      for (let c = 0; c < ch; c++) {
        let s = pref[bi + c] - pref[ai + c];
        if (topExtra) s += topExtra * buf[firstBase + c];
        if (botExtra) s += botExtra * buf[lastBase + c];
        col[oi + c] = s / denom;
      }
    }
    for (let y = 0; y < h; y++) {
      const si = y * stride + cbase, oi = y * ch;
      for (let c = 0; c < ch; c++) buf[si + c] = col[oi + c];
    }
  }
}

/**
 * In-place box blur of a premultiplied buffer.
 * @param {Float32Array} buf
 * @param {number} w
 * @param {number} h
 * @param {number} rx horizontal radius
 * @param {number} ry vertical radius
 * @param {number} [ch] channels per pixel
 */
export function boxBlurBuffer(buf, w, h, rx, ry, ch = 4) {
  if (rx >= 1) boxPassH(buf, w, h, Math.round(rx), ch);
  if (ry >= 1) boxPassV(buf, w, h, Math.round(ry), ch);
}

/**
 * In-place separable convolution of a float buffer with a 1-D kernel.
 * @param {Float32Array} buf
 * @param {number} w
 * @param {number} h
 * @param {ArrayLike<number>} kernel odd-length, already normalised
 * @param {number} ch channels per pixel
 */
export function convolveBuffer(buf, w, h, kernel, ch) {
  const r = (kernel.length - 1) >> 1;
  if (r < 1) return;
  const stride = w * ch;
  const tmp = new Float32Array(buf.length);
  if (ch === 4) {
    for (let y = 0; y < h; y++) {
      const base = y * stride;
      for (let x = 0; x < w; x++) {
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
        for (let k = -r; k <= r; k++) {
          let xx = x + k;
          xx = xx < 0 ? 0 : xx > w - 1 ? w - 1 : xx;
          const si = base + (xx << 2), kv = kernel[k + r];
          s0 += buf[si] * kv; s1 += buf[si + 1] * kv;
          s2 += buf[si + 2] * kv; s3 += buf[si + 3] * kv;
        }
        const o = base + (x << 2);
        tmp[o] = s0; tmp[o + 1] = s1; tmp[o + 2] = s2; tmp[o + 3] = s3;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
        const xo = x << 2;
        for (let k = -r; k <= r; k++) {
          let yy = y + k;
          yy = yy < 0 ? 0 : yy > h - 1 ? h - 1 : yy;
          const si = yy * stride + xo, kv = kernel[k + r];
          s0 += tmp[si] * kv; s1 += tmp[si + 1] * kv;
          s2 += tmp[si + 2] * kv; s3 += tmp[si + 3] * kv;
        }
        const o = y * stride + xo;
        buf[o] = s0; buf[o + 1] = s1; buf[o + 2] = s2; buf[o + 3] = s3;
      }
    }
    return;
  }
  for (let y = 0; y < h; y++) {
    const base = y * stride;
    for (let x = 0; x < w; x++) {
      const o = base + x * ch;
      for (let c = 0; c < ch; c++) tmp[o + c] = 0;
      for (let k = -r; k <= r; k++) {
        let xx = x + k;
        xx = xx < 0 ? 0 : xx > w - 1 ? w - 1 : xx;
        const si = base + xx * ch, kv = kernel[k + r];
        for (let c = 0; c < ch; c++) tmp[o + c] += buf[si + c] * kv;
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * stride + x * ch;
      for (let c = 0; c < ch; c++) buf[o + c] = 0;
      for (let k = -r; k <= r; k++) {
        let yy = y + k;
        yy = yy < 0 ? 0 : yy > h - 1 ? h - 1 : yy;
        const si = yy * stride + x * ch, kv = kernel[k + r];
        for (let c = 0; c < ch; c++) buf[o + c] += tmp[si + c] * kv;
      }
    }
  }
}

// Three successive box passes converge on a gaussian (central limit); these
// are the box widths that best match a given sigma.
function boxRadiiForGauss(sigma, n) {
  const ideal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl--;
  if (wl < 1) wl = 1;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const radii = [];
  for (let i = 0; i < n; i++) radii.push(((i < m ? wl : wu) - 1) / 2);
  return radii;
}

/**
 * In-place gaussian blur of a premultiplied buffer. Uses a true kernel for
 * small sigmas and a three-box approximation above that, so the cost stays
 * constant no matter how large the radius gets.
 * @param {Float32Array} buf
 * @param {number} w
 * @param {number} h
 * @param {number} sigma
 * @param {number} [ch]
 */
export function gaussianBlurBuffer(buf, w, h, sigma, ch = 4) {
  if (!(sigma > 0.05)) return;
  if (sigma <= 2.5) {
    convolveBuffer(buf, w, h, gaussianKernel(sigma), ch);
    return;
  }
  for (const r of boxRadiiForGauss(sigma, 3)) {
    if (r >= 1) { boxPassH(buf, w, h, Math.round(r), ch); boxPassV(buf, w, h, Math.round(r), ch); }
  }
}

/* ------------------------------------------------------------------ */
/* Shaped (span decomposed) kernels                                    */
/* ------------------------------------------------------------------ */

// A kernel is stored as horizontal runs: triples of (dy, x0, x1). Each run is
// summed in O(1) from a per-row prefix table, so the cost per pixel is one
// lookup pair per run rather than one per kernel sample.
function spansFromMask(mask, r) {
  const size = 2 * r + 1;
  const out = [];
  let total = 0;
  for (let j = 0; j < size; j++) {
    let run = -1;
    for (let i = 0; i <= size; i++) {
      const on = i < size && mask[j * size + i] !== 0;
      if (on && run < 0) run = i;
      else if (!on && run >= 0) {
        out.push(j - r, run - r, i - 1 - r);
        total += i - run;
        run = -1;
      }
    }
  }
  if (!out.length) { out.push(0, 0, 0); total = 1; }
  return { spans: Int32Array.from(out), total };
}

function spanConvolve(buf, w, h, spans, total, ch) {
  let minDy = spans[0], maxDy = spans[0];
  for (let i = 0; i < spans.length; i += 3) {
    if (spans[i] < minDy) minDy = spans[i];
    if (spans[i] > maxDy) maxDy = spans[i];
  }
  const K = maxDy - minDy + 1;
  const rowLen = (w + 1) * ch;
  const pref = new Float64Array(K * rowLen);
  const firsts = new Float64Array(K * ch);
  const lasts = new Float64Array(K * ch);
  const loaded = new Int32Array(K).fill(-1073741824);
  const slotOf = new Int32Array(K);
  const acc = new Float64Array(ch);
  const stride = w * ch;
  const out = new Float32Array(buf.length);
  const wCh = w * ch;

  const ensure = (y) => {
    const slot = ((y % K) + K) % K;
    if (loaded[slot] === y) return slot;
    const yy = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
    const base = yy * stride;
    const pb = slot * rowLen;
    for (let c = 0; c < ch; c++) pref[pb + c] = 0;
    for (let x = 0; x < w; x++) {
      const pi = pb + (x + 1) * ch, qi = pb + x * ch, si = base + x * ch;
      for (let c = 0; c < ch; c++) pref[pi + c] = pref[qi + c] + buf[si + c];
    }
    for (let c = 0; c < ch; c++) {
      firsts[slot * ch + c] = buf[base + c];
      lasts[slot * ch + c] = buf[base + wCh - ch + c];
    }
    loaded[slot] = y;
    return slot;
  };

  for (let y = 0; y < h; y++) {
    for (let d = minDy; d <= maxDy; d++) slotOf[d - minDy] = ensure(y + d);
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < ch; c++) acc[c] = 0;
      for (let i = 0; i < spans.length; i += 3) {
        const slot = slotOf[spans[i] - minDy];
        const pb = slot * rowLen;
        const lo = x + spans[i + 1];
        const hi = x + spans[i + 2] + 1;
        if (lo >= 0 && hi <= w) {
          const ai = pb + lo * ch, bi = pb + hi * ch;
          for (let c = 0; c < ch; c++) acc[c] += pref[bi + c] - pref[ai + c];
          continue;
        }
        // Off the edge: the prefix table is extended linearly with the first
        // and last pixel of the row, which is the usual edge-clamp.
        const fb = slot * ch, pw = pb + w * ch;
        for (let c = 0; c < ch; c++) {
          const a = lo <= 0 ? lo * firsts[fb + c]
            : lo >= w ? pref[pw + c] + (lo - w) * lasts[fb + c]
              : pref[pb + lo * ch + c];
          const b = hi <= 0 ? hi * firsts[fb + c]
            : hi >= w ? pref[pw + c] + (hi - w) * lasts[fb + c]
              : pref[pb + hi * ch + c];
          acc[c] += b - a;
        }
      }
      const oi = y * stride + x * ch;
      for (let c = 0; c < ch; c++) out[oi + c] = acc[c] / total;
    }
  }
  buf.set(out);
}

function downsampleBuffer(buf, w, h, s, ch) {
  const dw = Math.max(1, Math.ceil(w / s));
  const dh = Math.max(1, Math.ceil(h / s));
  const out = new Float32Array(dw * dh * ch);
  const cnt = new Float32Array(dw * dh);
  for (let y = 0; y < h; y++) {
    const dy = Math.min(dh - 1, (y / s) | 0);
    for (let x = 0; x < w; x++) {
      const dx = Math.min(dw - 1, (x / s) | 0);
      const di = dy * dw + dx;
      cnt[di]++;
      const si = (y * w + x) * ch, oi = di * ch;
      for (let c = 0; c < ch; c++) out[oi + c] += buf[si + c];
    }
  }
  for (let i = 0; i < dw * dh; i++) {
    const n = cnt[i] || 1, oi = i * ch;
    for (let c = 0; c < ch; c++) out[oi + c] /= n;
  }
  return { buf: out, w: dw, h: dh };
}

function upsampleInto(small, sw, sh, dst, w, h, s, ch) {
  for (let y = 0; y < h; y++) {
    let fy = (y + 0.5) / s - 0.5;
    fy = fy < 0 ? 0 : fy > sh - 1 ? sh - 1 : fy;
    const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      let fx = (x + 0.5) / s - 0.5;
      fx = fx < 0 ? 0 : fx > sw - 1 ? sw - 1 : fx;
      const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const i00 = (y0 * sw + x0) * ch, i10 = (y0 * sw + x1) * ch;
      const i01 = (y1 * sw + x0) * ch, i11 = (y1 * sw + x1) * ch;
      const o = (y * w + x) * ch;
      for (let c = 0; c < ch; c++) {
        const a = small[i00 + c] + (small[i10 + c] - small[i00 + c]) * tx;
        const b = small[i01 + c] + (small[i11 + c] - small[i01 + c]) * tx;
        dst[o + c] = a + (b - a) * ty;
      }
    }
  }
}

// Kernels bigger than this are evaluated on a downsampled copy — bokeh and
// shaped blurs are low frequency, so the visual result is identical while the
// cost stays bounded.
const MAX_WORK_RADIUS = 9;

function shapedBlur(buf, w, h, radius, ch, makeSpans) {
  if (!(radius >= 1)) return;
  const s = Math.max(1, Math.ceil(radius / MAX_WORK_RADIUS));
  const r = Math.max(1, Math.round(radius / s));
  if (s === 1) {
    const { spans, total } = makeSpans(r);
    spanConvolve(buf, w, h, spans, total, ch);
    return;
  }
  const small = downsampleBuffer(buf, w, h, s, ch);
  const { spans, total } = makeSpans(r);
  spanConvolve(small.buf, small.w, small.h, spans, total, ch);
  upsampleInto(small.buf, small.w, small.h, buf, w, h, s, ch);
}

function pointInPolygon(px, py, v) {
  let inside = false;
  for (let i = 0, k = v.length - 2; i < v.length; k = i, i += 2) {
    const xi = v[i], yi = v[i + 1], xk = v[k], yk = v[k + 1];
    if ((yi > py) !== (yk > py) && px < ((xk - xi) * (py - yi)) / (yk - yi) + xi) inside = !inside;
  }
  return inside;
}

function polygonMask(r, verts) {
  const size = 2 * r + 1;
  const m = new Uint8Array(size * size);
  for (let j = -r; j <= r; j++) {
    for (let i = -r; i <= r; i++) {
      if (pointInPolygon(i, j, verts)) m[(j + r) * size + (i + r)] = 1;
    }
  }
  return m;
}

function regularPolygonVerts(r, sides, rotationDeg) {
  const v = [];
  const rot = (rotationDeg * Math.PI) / 180 - Math.PI / 2;
  for (let i = 0; i < sides; i++) {
    const a = rot + (i * 2 * Math.PI) / sides;
    v.push(Math.cos(a) * r, Math.sin(a) * r);
  }
  return v;
}

function circleMask(r) {
  const size = 2 * r + 1;
  const m = new Uint8Array(size * size);
  const rr = (r + 0.35) * (r + 0.35);
  for (let j = -r; j <= r; j++) {
    for (let i = -r; i <= r; i++) if (i * i + j * j <= rr) m[(j + r) * size + (i + r)] = 1;
  }
  return m;
}

function shapeMask(shape, r) {
  const size = 2 * r + 1;
  if (shape === 'square') return new Uint8Array(size * size).fill(1);
  if (shape === 'cross') {
    const m = new Uint8Array(size * size);
    const t = Math.max(0, Math.round(r * 0.3));
    for (let j = -r; j <= r; j++) {
      for (let i = -r; i <= r; i++) {
        if (Math.abs(j) <= t || Math.abs(i) <= t) m[(j + r) * size + (i + r)] = 1;
      }
    }
    return m;
  }
  if (shape === 'star') {
    const v = [];
    for (let i = 0; i < 10; i++) {
      const rad = i % 2 === 0 ? r : r * 0.42;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      v.push(Math.cos(a) * rad, Math.sin(a) * rad);
    }
    return polygonMask(r, v);
  }
  return circleMask(r);
}

/**
 * In-place circular ("lens") blur of a premultiplied buffer.
 * @param {Float32Array} buf
 * @param {number} w
 * @param {number} h
 * @param {number} radius
 * @param {number} [ch]
 */
export function discBlurBuffer(buf, w, h, radius, ch = 4) {
  shapedBlur(buf, w, h, radius, ch, (r) => spansFromMask(circleMask(r), r));
}

/* ------------------------------------------------------------------ */
/* Motion blur                                                         */
/* ------------------------------------------------------------------ */

function transposeBuffer(buf, w, h, ch) {
  const out = new Float32Array(buf.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * ch, di = (x * h + y) * ch;
      for (let c = 0; c < ch; c++) out[di + c] = buf[si + c];
    }
  }
  return out;
}

// Requires |dxu| >= |dyu|. Every pixel belongs to exactly one discrete line
// `c = y - round(m*x)`, so a sliding prefix sum along each line gives an
// O(1)-per-pixel directional average whatever the distance.
function motionBlurCore(buf, w, h, dxu, dyu, distance, ch) {
  const m = dyu / dxu;
  const U = Math.round((distance * Math.abs(dxu)) / 2);
  if (U < 1) return;
  const offs = new Int32Array(w);
  let oMin = 0, oMax = 0;
  for (let x = 0; x < w; x++) {
    const o = Math.round(m * x);
    offs[x] = o;
    if (o < oMin) oMin = o;
    if (o > oMax) oMax = o;
  }
  const stride = w * ch;
  const out = new Float32Array(buf.length);
  const line = new Float32Array(w * ch);
  const pref = new Float64Array((w + 1) * ch);
  const denom = 2 * U + 1;
  const lastBase = (w - 1) * ch;
  for (let c0 = -oMax; c0 <= h - 1 - oMin; c0++) {
    for (let x = 0; x < w; x++) {
      let yy = c0 + offs[x];
      yy = yy < 0 ? 0 : yy > h - 1 ? h - 1 : yy;
      const si = yy * stride + x * ch, li = x * ch;
      for (let c = 0; c < ch; c++) line[li + c] = buf[si + c];
    }
    for (let c = 0; c < ch; c++) pref[c] = 0;
    for (let x = 0; x < w; x++) {
      const pi = (x + 1) * ch, qi = x * ch;
      for (let c = 0; c < ch; c++) pref[pi + c] = pref[qi + c] + line[qi + c];
    }
    for (let x = 0; x < w; x++) {
      const y = c0 + offs[x];
      if (y < 0 || y >= h) continue;
      const lo = x - U, hi = x + U + 1;
      const leftExtra = lo < 0 ? -lo : 0;
      const rightExtra = hi > w ? hi - w : 0;
      const ai = (lo < 0 ? 0 : lo) * ch;
      const bi = (hi > w ? w : hi) * ch;
      const oi = y * stride + x * ch;
      for (let c = 0; c < ch; c++) {
        let s = pref[bi + c] - pref[ai + c];
        if (leftExtra) s += leftExtra * line[c];
        if (rightExtra) s += rightExtra * line[lastBase + c];
        out[oi + c] = s / denom;
      }
    }
  }
  buf.set(out);
}

/**
 * In-place directional blur of a premultiplied buffer.
 * @param {Float32Array} buf
 * @param {number} w
 * @param {number} h
 * @param {number} angleDeg 0 = horizontal, positive = counter-clockwise
 * @param {number} distance total streak length in pixels
 * @param {number} [ch]
 */
export function motionBlurBuffer(buf, w, h, angleDeg, distance, ch = 4) {
  const a = (angleDeg * Math.PI) / 180;
  const dxu = Math.cos(a), dyu = -Math.sin(a);
  if (Math.abs(dxu) >= Math.abs(dyu)) {
    motionBlurCore(buf, w, h, dxu, dyu, distance, ch);
    return;
  }
  const t = transposeBuffer(buf, w, h, ch);
  motionBlurCore(t, h, w, dyu, dxu, distance, ch);
  buf.set(transposeBuffer(t, h, w, ch));
}

/* ------------------------------------------------------------------ */
/* Edge-preserving helpers (smart / surface blur)                       */
/* ------------------------------------------------------------------ */

// One separable half of an edge-preserving blur. `vertical` picks the axis;
// the two mirrored taps are unrolled and the neighbour index is computed as a
// clamped delta so the inner loop stays free of per-sample multiplies.
function rangePass(src, dst, w, h, taps, spatial, thr, tent, vertical) {
  const invThr = 1 / Math.max(1, thr);
  const stepIdx = vertical ? w * 4 : 4;
  const limit = vertical ? h - 1 : w - 1;
  const nTaps = taps.length;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ci = (y * w + x) * 4;
      const coord = vertical ? y : x;
      const cr = src[ci], cg = src[ci + 1], cb = src[ci + 2], ca = src[ci + 3];
      let ar = cr, ag = cg, ab = cb, aa = ca, wsum = 1;
      for (let t = 0; t < nTaps; t++) {
        const k = taps[t], base = spatial[t];
        const dA = coord - k < 0 ? -coord : -k;
        const dB = coord + k > limit ? limit - coord : k;
        let ni = ci + dA * stepIdx;
        for (let s = 0; s < 2; s++) {
          let d = Math.abs(src[ni] - cr);
          const dg = Math.abs(src[ni + 1] - cg); if (dg > d) d = dg;
          const db = Math.abs(src[ni + 2] - cb); if (db > d) d = db;
          const da = Math.abs(src[ni + 3] - ca); if (da > d) d = da;
          let wr;
          if (tent) wr = 1 - d * invThr;
          else wr = d > thr ? 0 : 1;
          if (wr > 0) {
            const ww = wr * base;
            ar += src[ni] * ww; ag += src[ni + 1] * ww;
            ab += src[ni + 2] * ww; aa += src[ni + 3] * ww;
            wsum += ww;
          }
          ni = ci + dB * stepIdx;
        }
      }
      dst[ci] = ar / wsum; dst[ci + 1] = ag / wsum;
      dst[ci + 2] = ab / wsum; dst[ci + 3] = aa / wsum;
    }
  }
}

function rangeBlurImageData(imageData, radius, threshold, tent, step) {
  const w = imageData.width, h = imageData.height, d = imageData.data;
  const taps = [];
  for (let k = step; k <= radius; k += step) taps.push(k);
  if (!taps.length) return;
  const spatial = new Float32Array(taps.length);
  const sig2 = 2 * (radius * 0.6) * (radius * 0.6) || 1;
  for (let i = 0; i < taps.length; i++) spatial[i] = Math.exp(-(taps[i] * taps[i]) / sig2);
  const a = new Float32Array(d.length);
  for (let i = 0; i < d.length; i++) a[i] = d[i];
  const b = new Float32Array(d.length);
  rangePass(a, b, w, h, taps, spatial, threshold, tent, false);
  rangePass(b, a, w, h, taps, spatial, threshold, tent, true);
  for (let i = 0; i < d.length; i++) d[i] = a[i];
}

/**
 * Rec.601 luminance plane (0..255) for an RGBA byte array.
 * @param {Uint8ClampedArray} data
 * @param {number} n pixel count
 * @returns {Float32Array}
 */
export function luminancePlane(data, n) {
  const lum = new Float32Array(n);
  for (let i = 0, p = 0; p < n; p++, i += 4) {
    lum[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return lum;
}

/**
 * Sobel gradient magnitude, scaled so a full black/white step reads ~255.
 * @param {Float32Array} lum
 * @param {number} w
 * @param {number} h
 * @returns {Float32Array}
 */
export function sobelMagnitude(lum, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : 0, yp = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : w - 1;
      const a = lum[ym * w + xm], b = lum[ym * w + x], c = lum[ym * w + xp];
      const d = lum[y * w + xm], f = lum[y * w + xp];
      const g = lum[yp * w + xm], i = lum[yp * w + x], j = lum[yp * w + xp];
      const gx = (c + 2 * f + j) - (a + 2 * d + g);
      const gy = (g + 2 * i + j) - (a + 2 * b + c);
      out[y * w + x] = Math.sqrt(gx * gx + gy * gy) / 4;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Filters                                                             */
/* ------------------------------------------------------------------ */

const SOFT3 = new Float32Array([0.25, 0.5, 0.25]);

registerFilter({
  id: 'blur',
  name: 'Blur',
  menu: 'Blur',
  params: [],
  needsDialog: false,
  apply(imageData) {
    separableConvolve(imageData, SOFT3);
  },
});

registerFilter({
  id: 'blur-more',
  name: 'Blur More',
  menu: 'Blur',
  params: [],
  needsDialog: false,
  apply(imageData) {
    separableConvolve(imageData, SOFT3);
    separableConvolve(imageData, SOFT3);
    separableConvolve(imageData, SOFT3);
  },
});

registerFilter({
  id: 'average',
  name: 'Average',
  menu: 'Blur',
  params: [],
  needsDialog: false,
  apply(imageData) {
    const d = imageData.data;
    let sr = 0, sg = 0, sb = 0, sa = 0;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      const f = a / 255;
      sr += d[i] * f; sg += d[i + 1] * f; sb += d[i + 2] * f;
      sa += a;
    }
    const r = sa > 0 ? (sr * 255) / sa : 0;
    const g = sa > 0 ? (sg * 255) / sa : 0;
    const b = sa > 0 ? (sb * 255) / sa : 0;
    // Average fills the layer with one colour but must not flatten its shape,
    // so every pixel keeps its own alpha.
    for (let i = 0; i < d.length; i += 4) {
      d[i] = r; d[i + 1] = g; d[i + 2] = b;
    }
  },
});

registerFilter({
  id: 'box-blur',
  name: 'Box Blur...',
  menu: 'Blur',
  params: [
    { key: 'radius', label: 'Radius', type: 'slider', min: 1, max: 500, step: 1, default: 8, unit: 'px' },
  ],
  apply(imageData, p) {
    const w = imageData.width, h = imageData.height;
    const buf = premultiplyImageData(imageData);
    boxBlurBuffer(buf, w, h, p.radius, p.radius, 4);
    unpremultiplyInto(buf, imageData);
  },
});

registerFilter({
  id: 'gaussian-blur',
  name: 'Gaussian Blur...',
  menu: 'Blur',
  params: [
    { key: 'radius', label: 'Radius', type: 'slider', min: 0.1, max: 1000, step: 0.1, default: 4, unit: 'px' },
  ],
  apply(imageData, p) {
    if (!(p.radius > 0.05)) return;
    // The GPU path is ~30x faster on large images; the JS box passes stay as
    // the fallback for small images and browsers without Canvas2D filters.
    blurImageData(imageData, p.radius, (img, sigma) => {
      const buf = premultiplyImageData(img);
      gaussianBlurBuffer(buf, img.width, img.height, sigma, 4);
      unpremultiplyInto(buf, img);
    });
  },
});

registerFilter({
  id: 'lens-blur',
  name: 'Lens Blur...',
  menu: 'Blur',
  dialogWidth: 420,
  params: [
    { key: 'radius', label: 'Radius', type: 'slider', min: 1, max: 200, step: 1, default: 15, unit: 'px' },
    { key: 'blades', label: 'Blades', type: 'slider', min: 3, max: 8, step: 1, default: 6 },
    { key: 'rotation', label: 'Blade Rotation', type: 'angle', min: 0, max: 360, step: 1, default: 0 },
    { key: 'brightness', label: 'Specular Brightness', type: 'slider', min: 0, max: 100, step: 1, default: 40 },
    { key: 'threshold', label: 'Specular Threshold', type: 'slider', min: 0, max: 255, step: 1, default: 200 },
  ],
  apply(imageData, p) {
    const w = imageData.width, h = imageData.height;
    if (!(p.radius >= 1)) return;
    const d = imageData.data;
    const n = w * h;
    // Channel 5 carries the highlight gain so the convolution becomes a
    // gain-weighted average: bright pixels bloom into the blade shape while
    // the overall exposure stays put.
    const buf = new Float32Array(n * 5);
    const boost = (p.brightness / 100) * 8;
    const thr = p.threshold;
    const span = Math.max(1, 255 - thr);
    for (let i = 0, o = 0; i < d.length; i += 4, o += 5) {
      const a = d[i + 3];
      const f = a / 255;
      let g = 1;
      if (boost > 0) {
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (lum > thr) g = 1 + boost * ((lum - thr) / span);
      }
      buf[o] = d[i] * f * g;
      buf[o + 1] = d[i + 1] * f * g;
      buf[o + 2] = d[i + 2] * f * g;
      buf[o + 3] = a * g;
      buf[o + 4] = g;
    }
    const blades = Math.round(p.blades);
    const rotation = p.rotation;
    shapedBlur(buf, w, h, p.radius, 5, (r) =>
      spansFromMask(polygonMask(r, regularPolygonVerts(r, blades, rotation)), r)
    );
    for (let i = 0, o = 0; i < d.length; i += 4, o += 5) {
      const gm = buf[o + 4] || 1;
      const a = buf[o + 3] / gm;
      if (a <= 0.4) { d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 0; continue; }
      const inv = 255 / (a * gm);
      d[i] = buf[o] * inv;
      d[i + 1] = buf[o + 1] * inv;
      d[i + 2] = buf[o + 2] * inv;
      d[i + 3] = a;
    }
  },
});

registerFilter({
  id: 'motion-blur',
  name: 'Motion Blur...',
  menu: 'Blur',
  params: [
    { key: 'angle', label: 'Angle', type: 'angle', min: -360, max: 360, step: 1, default: 0 },
    { key: 'distance', label: 'Distance', type: 'slider', min: 1, max: 2000, step: 1, default: 24, unit: 'px' },
  ],
  apply(imageData, p) {
    const w = imageData.width, h = imageData.height;
    if (p.distance < 2) return;
    const buf = premultiplyImageData(imageData);
    motionBlurBuffer(buf, w, h, p.angle, p.distance, 4);
    unpremultiplyInto(buf, imageData);
  },
});

const RADIAL_QUALITY = { draft: 6, good: 16, best: 32 };

registerFilter({
  id: 'radial-blur',
  name: 'Radial Blur...',
  menu: 'Blur',
  dialogWidth: 420,
  params: [
    { key: 'amount', label: 'Amount', type: 'slider', min: 1, max: 100, step: 1, default: 10 },
    { key: 'method', label: 'Blur Method', type: 'radio', default: 'spin', options: [
      { value: 'spin', label: 'Spin' }, { value: 'zoom', label: 'Zoom' },
    ] },
    { key: 'quality', label: 'Quality', type: 'select', default: 'good', options: [
      { value: 'draft', label: 'Draft' }, { value: 'good', label: 'Good' }, { value: 'best', label: 'Best' },
    ] },
    { key: 'centerX', label: 'Center X', type: 'slider', min: 0, max: 100, step: 1, default: 50, unit: '%' },
    { key: 'centerY', label: 'Center Y', type: 'slider', min: 0, max: 100, step: 1, default: 50, unit: '%' },
  ],
  apply(imageData, p) {
    const w = imageData.width, h = imageData.height;
    if (p.amount < 1) return;
    const src = premultiplyImageData(imageData);
    const dst = new Float32Array(src.length);
    const cx = (w * p.centerX) / 100;
    const cy = (h * p.centerY) / 100;
    const maxN = RADIAL_QUALITY[p.quality] || 16;
    const smooth = p.quality !== 'draft';
    const spin = p.method !== 'zoom';
    const maxAng = (p.amount / 100) * (Math.PI / 6);
    const maxZoom = (p.amount / 100) * 0.3;

    // cos/sin per (sampleCount, index) so the inner loop is table lookups.
    const cosT = new Float32Array((maxN + 1) * maxN);
    const sinT = new Float32Array((maxN + 1) * maxN);
    for (let nn = 2; nn <= maxN; nn++) {
      for (let k = 0; k < nn; k++) {
        const t = k / (nn - 1) - 0.5;
        const a = t * maxAng;
        cosT[nn * maxN + k] = Math.cos(a);
        sinT[nn * maxN + k] = Math.sin(a);
      }
    }

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const vx = x - cx, vy = y - cy;
        const rad = Math.sqrt(vx * vx + vy * vy);
        const disp = spin ? rad * maxAng : rad * maxZoom;
        let n = Math.ceil(disp);
        if (n > maxN) n = maxN;
        if (n < 2) {
          dst[o] = src[o]; dst[o + 1] = src[o + 1];
          dst[o + 2] = src[o + 2]; dst[o + 3] = src[o + 3];
          continue;
        }
        let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
        for (let k = 0; k < n; k++) {
          let sx, sy;
          if (spin) {
            const c = cosT[n * maxN + k], s = sinT[n * maxN + k];
            sx = cx + vx * c - vy * s;
            sy = cy + vx * s + vy * c;
          } else {
            const sc = 1 + (k / (n - 1) - 0.5) * maxZoom;
            sx = cx + vx * sc;
            sy = cy + vy * sc;
          }
          if (smooth) {
            let fx = sx < 0 ? 0 : sx > w - 1 ? w - 1 : sx;
            let fy = sy < 0 ? 0 : sy > h - 1 ? h - 1 : sy;
            const x0 = fx | 0, y0 = fy | 0;
            const x1 = x0 + 1 > w - 1 ? w - 1 : x0 + 1;
            const y1 = y0 + 1 > h - 1 ? h - 1 : y0 + 1;
            const tx = fx - x0, ty = fy - y0;
            const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4;
            const i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
            const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty);
            const w01 = (1 - tx) * ty, w11 = tx * ty;
            a0 += src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
            a1 += src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
            a2 += src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
            a3 += src[i00 + 3] * w00 + src[i10 + 3] * w10 + src[i01 + 3] * w01 + src[i11 + 3] * w11;
          } else {
            let ix = Math.round(sx), iy = Math.round(sy);
            ix = ix < 0 ? 0 : ix > w - 1 ? w - 1 : ix;
            iy = iy < 0 ? 0 : iy > h - 1 ? h - 1 : iy;
            const si = (iy * w + ix) * 4;
            a0 += src[si]; a1 += src[si + 1]; a2 += src[si + 2]; a3 += src[si + 3];
          }
        }
        dst[o] = a0 / n; dst[o + 1] = a1 / n; dst[o + 2] = a2 / n; dst[o + 3] = a3 / n;
      }
    }
    unpremultiplyInto(dst, imageData);
  },
});

// Maximum number of kernel taps per separable pass at each quality setting.
const SMART_QUALITY = { low: 4, medium: 8, high: 16 };

registerFilter({
  id: 'smart-blur',
  name: 'Smart Blur...',
  menu: 'Blur',
  dialogWidth: 420,
  params: [
    { key: 'radius', label: 'Radius', type: 'slider', min: 0.1, max: 100, step: 0.1, default: 5 },
    { key: 'threshold', label: 'Threshold', type: 'slider', min: 0.1, max: 100, step: 0.1, default: 25 },
    { key: 'quality', label: 'Quality', type: 'select', default: 'medium', options: [
      { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' },
    ] },
    { key: 'mode', label: 'Mode', type: 'select', default: 'normal', options: [
      { value: 'normal', label: 'Normal' },
      { value: 'edge-only', label: 'Edge Only' },
      { value: 'overlay-edge', label: 'Overlay Edge' },
    ] },
  ],
  apply(imageData, p) {
    const w = imageData.width, h = imageData.height, d = imageData.data;
    const n = w * h;
    const r = Math.max(1, Math.round(p.radius));
    const thr = Math.max(1, p.threshold * 2.55);

    if (p.mode !== 'normal') {
      // Edge modes report where the blur would have refused to average.
      const lum = luminancePlane(d, n);
      if (p.radius > 1) gaussianBlurBuffer(lum, w, h, p.radius / 3, 1);
      const mag = sobelMagnitude(lum, w, h);
      const edgeThr = thr * 0.5;
      if (p.mode === 'edge-only') {
        for (let i = 0, q = 0; q < n; q++, i += 4) {
          const v = mag[q] > edgeThr ? 255 : 0;
          d[i] = v; d[i + 1] = v; d[i + 2] = v;
        }
      } else {
        for (let i = 0, q = 0; q < n; q++, i += 4) {
          if (mag[q] > edgeThr) { d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; }
        }
      }
      return;
    }

    const step = Math.max(1, Math.ceil(r / (SMART_QUALITY[p.quality] || 8)));
    rangeBlurImageData(imageData, r, thr, false, step);
  },
});

registerFilter({
  id: 'surface-blur',
  name: 'Surface Blur...',
  menu: 'Blur',
  params: [
    { key: 'radius', label: 'Radius', type: 'slider', min: 1, max: 100, step: 1, default: 5, unit: 'px' },
    { key: 'threshold', label: 'Threshold', type: 'slider', min: 2, max: 255, step: 1, default: 15, unit: 'levels' },
  ],
  apply(imageData, p) {
    const r = Math.max(1, Math.round(p.radius));
    const step = Math.max(1, Math.ceil(r / 14));
    rangeBlurImageData(imageData, r, Math.max(2, p.threshold), true, step);
  },
});

registerFilter({
  id: 'shape-blur',
  name: 'Shape Blur...',
  menu: 'Blur',
  params: [
    { key: 'radius', label: 'Radius', type: 'slider', min: 1, max: 500, step: 1, default: 20, unit: 'px' },
    { key: 'shape', label: 'Shape', type: 'select', default: 'circle', options: [
      { value: 'circle', label: 'Circle' },
      { value: 'square', label: 'Square' },
      { value: 'star', label: 'Star' },
      { value: 'cross', label: 'Cross' },
    ] },
  ],
  apply(imageData, p) {
    const w = imageData.width, h = imageData.height;
    if (!(p.radius >= 1)) return;
    const buf = premultiplyImageData(imageData);
    const shape = p.shape;
    shapedBlur(buf, w, h, p.radius, 4, (r) => spansFromMask(shapeMask(shape, r), r));
    unpremultiplyInto(buf, imageData);
  },
});
