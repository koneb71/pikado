/**
 * Filter > Noise — Add Noise, Despeckle, Dust & Scratches, Median and
 * Reduce Noise.
 *
 * Median (and the two filters built on it) use Huang's sliding-window
 * histogram: moving one pixel to the right costs 2*(2r+1) histogram updates
 * plus a couple of steps of the median pointer, so the per-pixel cost is
 * linear in the radius instead of quadratic.
 */

import { registerFilter, makeRandom } from './registry.js';
import {
  premultiplyImageData,
  unpremultiplyInto,
  convolveBuffer,
  boxBlurBuffer,
  gaussianBlurBuffer,
  luminancePlane,
  sobelMagnitude,
} from './blur.js';

const SOFT3 = new Float32Array([0.25, 0.5, 0.25]);

/* ------------------------------------------------------------------ */
/* Median                                                              */
/* ------------------------------------------------------------------ */

// Above this the median runs on a downsampled copy — a 100px median is a
// low-frequency operation, and the exact window cost grows with the radius.
const MEDIAN_MAX_R = 12;

function medianChannel(src, dst, w, h, r, ch) {
  const hist = new Int32Array(256);
  const win = 2 * r + 1;
  const medIdx = (win * win) >> 1;
  const rows = new Int32Array(win);
  for (let y = 0; y < h; y++) {
    for (let k = -r; k <= r; k++) {
      const yy = y + k;
      rows[k + r] = (yy < 0 ? 0 : yy > h - 1 ? h - 1 : yy) * w * 4;
    }
    hist.fill(0);
    for (let k = 0; k < win; k++) {
      const rowBase = rows[k];
      for (let dx = -r; dx <= r; dx++) {
        const xx = dx < 0 ? 0 : dx > w - 1 ? w - 1 : dx;
        hist[src[rowBase + xx * 4 + ch]]++;
      }
    }
    let mVal = 0, mNum = 0, acc = 0;
    for (let v = 0; v < 256; v++) {
      if (acc + hist[v] > medIdx) { mVal = v; mNum = acc; break; }
      acc += hist[v];
    }
    dst[y * w * 4 + ch] = mVal;
    for (let x = 1; x < w; x++) {
      let remX = x - 1 - r, addX = x + r;
      remX = remX < 0 ? 0 : remX > w - 1 ? w - 1 : remX;
      addX = addX < 0 ? 0 : addX > w - 1 ? w - 1 : addX;
      const ro = remX * 4 + ch, ao = addX * 4 + ch;
      for (let k = 0; k < win; k++) {
        const rowBase = rows[k];
        const vOut = src[rowBase + ro];
        hist[vOut]--;
        if (vOut < mVal) mNum--;
        const vIn = src[rowBase + ao];
        hist[vIn]++;
        if (vIn < mVal) mNum++;
      }
      while (mNum > medIdx) { mVal--; mNum -= hist[mVal]; }
      while (mNum + hist[mVal] <= medIdx) { mNum += hist[mVal]; mVal++; }
      dst[(y * w + x) * 4 + ch] = mVal;
    }
  }
}

function runMedian(data, w, h, r) {
  const src = new Uint8ClampedArray(data);
  let opaque = true;
  for (let i = 3; i < src.length; i += 4) if (src[i] !== 255) { opaque = false; break; }
  medianChannel(src, data, w, h, r, 0);
  medianChannel(src, data, w, h, r, 1);
  medianChannel(src, data, w, h, r, 2);
  if (!opaque) medianChannel(src, data, w, h, r, 3);
}

function downscaleRGBA(src, w, h, s) {
  const dw = Math.max(1, Math.ceil(w / s));
  const dh = Math.max(1, Math.ceil(h / s));
  const acc = new Float32Array(dw * dh * 4);
  const cnt = new Float32Array(dw * dh);
  for (let y = 0; y < h; y++) {
    const dy = Math.min(dh - 1, (y / s) | 0);
    for (let x = 0; x < w; x++) {
      const dx = Math.min(dw - 1, (x / s) | 0);
      const di = dy * dw + dx;
      const si = (y * w + x) * 4;
      const a = src[si + 3], f = a / 255;
      acc[di * 4] += src[si] * f;
      acc[di * 4 + 1] += src[si + 1] * f;
      acc[di * 4 + 2] += src[si + 2] * f;
      acc[di * 4 + 3] += a;
      cnt[di]++;
    }
  }
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let i = 0; i < dw * dh; i++) {
    const n = cnt[i] || 1, o = i * 4;
    const a = acc[o + 3] / n;
    if (a <= 0.4) continue;
    const inv = 255 / a;
    out[o] = (acc[o] / n) * inv;
    out[o + 1] = (acc[o + 1] / n) * inv;
    out[o + 2] = (acc[o + 2] / n) * inv;
    out[o + 3] = a;
  }
  return { data: out, w: dw, h: dh };
}

function upscaleRGBAInto(small, sw, sh, dst, w, h, s) {
  const pm = new Float32Array(sw * sh * 4);
  for (let i = 0; i < pm.length; i += 4) {
    const a = small[i + 3], f = a / 255;
    pm[i] = small[i] * f; pm[i + 1] = small[i + 1] * f; pm[i + 2] = small[i + 2] * f; pm[i + 3] = a;
  }
  for (let y = 0; y < h; y++) {
    let fy = (y + 0.5) / s - 0.5;
    fy = fy < 0 ? 0 : fy > sh - 1 ? sh - 1 : fy;
    const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      let fx = (x + 0.5) / s - 0.5;
      fx = fx < 0 ? 0 : fx > sw - 1 ? sw - 1 : fx;
      const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      const o = (y * w + x) * 4;
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty, w11 = tx * ty;
      const pa = pm[i00 + 3] * w00 + pm[i10 + 3] * w10 + pm[i01 + 3] * w01 + pm[i11 + 3] * w11;
      if (pa <= 0.4) { dst[o] = 0; dst[o + 1] = 0; dst[o + 2] = 0; dst[o + 3] = 0; continue; }
      const inv = 255 / pa;
      dst[o] = (pm[i00] * w00 + pm[i10] * w10 + pm[i01] * w01 + pm[i11] * w11) * inv;
      dst[o + 1] = (pm[i00 + 1] * w00 + pm[i10 + 1] * w10 + pm[i01 + 1] * w01 + pm[i11 + 1] * w11) * inv;
      dst[o + 2] = (pm[i00 + 2] * w00 + pm[i10 + 2] * w10 + pm[i01 + 2] * w01 + pm[i11 + 2] * w11) * inv;
      dst[o + 3] = pa;
    }
  }
}

/**
 * Median filter an ImageData in place.
 * @param {ImageData} imageData
 * @param {number} radius
 */
function medianFilterImage(imageData, radius) {
  const w = imageData.width, h = imageData.height;
  const r = Math.max(1, Math.round(radius));
  if (r <= MEDIAN_MAX_R) { runMedian(imageData.data, w, h, r); return; }
  const s = Math.ceil(r / MEDIAN_MAX_R);
  const small = downscaleRGBA(imageData.data, w, h, s);
  runMedian(small.data, small.w, small.h, Math.max(1, Math.round(r / s)));
  upscaleRGBAInto(small.data, small.w, small.h, imageData.data, w, h, s);
}

/* ------------------------------------------------------------------ */
/* Scalar bilateral (Reduce Noise)                                     */
/* ------------------------------------------------------------------ */

function bilateralPassScalar(src, dst, w, h, r, thr, sx, sy) {
  const spatial = new Float32Array(r + 1);
  const sig2 = 2 * (r * 0.7) * (r * 0.7) || 1;
  for (let k = 1; k <= r; k++) spatial[k] = Math.exp(-(k * k) / sig2);
  const invThr = 1 / Math.max(1, thr);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ci = y * w + x;
      const cv = src[ci];
      let acc = cv, wsum = 1;
      for (let k = 1; k <= r; k++) {
        const base = spatial[k];
        for (let s = -1; s <= 1; s += 2) {
          let nx = x + sx * k * s, ny = y + sy * k * s;
          nx = nx < 0 ? 0 : nx > w - 1 ? w - 1 : nx;
          ny = ny < 0 ? 0 : ny > h - 1 ? h - 1 : ny;
          const nv = src[ny * w + nx];
          const wr = 1 - Math.abs(nv - cv) * invThr;
          if (wr <= 0) continue;
          const ww = wr * base;
          acc += nv * ww;
          wsum += ww;
        }
      }
      dst[ci] = acc / wsum;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Filters                                                             */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'add-noise',
  name: 'Add Noise...',
  menu: 'Noise',
  params: [
    { key: 'amount', label: 'Amount', type: 'slider', min: 0.1, max: 400, step: 0.1, default: 12.5, unit: '%' },
    { key: 'distribution', label: 'Distribution', type: 'radio', default: 'uniform', options: [
      { value: 'uniform', label: 'Uniform' },
      { value: 'gaussian', label: 'Gaussian' },
    ] },
    { key: 'monochromatic', label: 'Monochromatic', type: 'checkbox', default: false },
    { key: 'seed', label: 'Seed', type: 'number', min: 0, max: 99999, step: 1, default: 1 },
  ],
  apply(imageData, p) {
    const d = imageData.data;
    const rand = makeRandom((p.seed | 0) + 1);
    const gaussian = p.distribution === 'gaussian';
    const scale = gaussian ? (p.amount / 100) * 255 * 0.25 : (p.amount / 100) * 255 * 0.5;
    let spare = null;
    const normal = () => {
      if (spare !== null) { const v = spare; spare = null; return v; }
      let u = rand();
      if (u < 1e-7) u = 1e-7;
      const m = Math.sqrt(-2 * Math.log(u));
      const a = 2 * Math.PI * rand();
      spare = m * Math.sin(a);
      return m * Math.cos(a);
    };
    const draw = gaussian ? normal : () => rand() * 2 - 1;
    if (p.monochromatic) {
      for (let i = 0; i < d.length; i += 4) {
        const n = draw() * scale;
        d[i] += n; d[i + 1] += n; d[i + 2] += n;
      }
    } else {
      for (let i = 0; i < d.length; i += 4) {
        d[i] += draw() * scale;
        d[i + 1] += draw() * scale;
        d[i + 2] += draw() * scale;
      }
    }
  },
});

registerFilter({
  id: 'despeckle',
  name: 'Despeckle',
  menu: 'Noise',
  params: [],
  needsDialog: false,
  apply(imageData) {
    const w = imageData.width, h = imageData.height, d = imageData.data;
    const n = w * h;
    const mag = sobelMagnitude(luminancePlane(d, n), w, h);
    const orig = new Uint8ClampedArray(d);
    const buf = premultiplyImageData(imageData);
    convolveBuffer(buf, w, h, SOFT3, 4);
    unpremultiplyInto(buf, imageData);
    // Keep the original wherever the neighbourhood contains a real edge.
    const lo = 10, hi = 34;
    for (let i = 0, q = 0; q < n; q++, i += 4) {
      const t0 = (mag[q] - lo) / (hi - lo);
      const t = t0 <= 0 ? 0 : t0 >= 1 ? 1 : t0 * t0 * (3 - 2 * t0);
      if (t <= 0) continue;
      d[i] += (orig[i] - d[i]) * t;
      d[i + 1] += (orig[i + 1] - d[i + 1]) * t;
      d[i + 2] += (orig[i + 2] - d[i + 2]) * t;
      d[i + 3] += (orig[i + 3] - d[i + 3]) * t;
    }
  },
});

registerFilter({
  id: 'dust-scratches',
  name: 'Dust & Scratches...',
  menu: 'Noise',
  params: [
    { key: 'radius', label: 'Radius', type: 'slider', min: 1, max: 100, step: 1, default: 2, unit: 'px' },
    { key: 'threshold', label: 'Threshold', type: 'slider', min: 0, max: 255, step: 1, default: 12, unit: 'levels' },
  ],
  apply(imageData, p) {
    const orig = new Uint8ClampedArray(imageData.data);
    medianFilterImage(imageData, p.radius);
    const d = imageData.data;
    const thr = p.threshold;
    for (let i = 0; i < d.length; i += 4) {
      let diff = Math.abs(orig[i] - d[i]);
      const dg = Math.abs(orig[i + 1] - d[i + 1]); if (dg > diff) diff = dg;
      const db = Math.abs(orig[i + 2] - d[i + 2]); if (db > diff) diff = db;
      const da = Math.abs(orig[i + 3] - d[i + 3]); if (da > diff) diff = da;
      // Only outliers past the threshold are considered dust; the rest of the
      // image keeps its original detail.
      if (diff <= thr) {
        d[i] = orig[i]; d[i + 1] = orig[i + 1];
        d[i + 2] = orig[i + 2]; d[i + 3] = orig[i + 3];
      }
    }
  },
});

registerFilter({
  id: 'median',
  name: 'Median...',
  menu: 'Noise',
  params: [
    { key: 'radius', label: 'Radius', type: 'slider', min: 1, max: 100, step: 1, default: 3, unit: 'px' },
  ],
  apply(imageData, p) {
    medianFilterImage(imageData, p.radius);
  },
});

registerFilter({
  id: 'reduce-noise',
  name: 'Reduce Noise...',
  menu: 'Noise',
  dialogWidth: 420,
  params: [
    { key: 'strength', label: 'Strength', type: 'slider', min: 0, max: 10, step: 1, default: 5 },
    { key: 'preserveDetails', label: 'Preserve Details', type: 'slider', min: 0, max: 100, step: 1, default: 60, unit: '%' },
    { key: 'reduceColorNoise', label: 'Reduce Color Noise', type: 'slider', min: 0, max: 100, step: 1, default: 45, unit: '%' },
    { key: 'sharpenDetails', label: 'Sharpen Details', type: 'slider', min: 0, max: 100, step: 1, default: 25, unit: '%' },
  ],
  apply(imageData, p) {
    const w = imageData.width, h = imageData.height, d = imageData.data;
    const n = w * h;
    const Y = new Float32Array(n);
    const Cb = new Float32Array(n);
    const Cr = new Float32Array(n);
    for (let i = 0, q = 0; q < n; q++, i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      Y[q] = 0.299 * r + 0.587 * g + 0.114 * b;
      Cb[q] = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
      Cr[q] = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
    }

    if (p.strength > 0) {
      const r = 1 + Math.round(p.strength * 0.4);
      const thr = 4 + p.strength * 6 * (1 - (p.preserveDetails / 100) * 0.8);
      const iterations = p.strength > 6 ? 2 : 1;
      const tmp = new Float32Array(n);
      for (let it = 0; it < iterations; it++) {
        bilateralPassScalar(Y, tmp, w, h, r, thr, 1, 0);
        bilateralPassScalar(tmp, Y, w, h, r, thr, 0, 1);
      }
    }

    const cAmt = p.reduceColorNoise / 100;
    if (cAmt > 0) {
      const cr = Math.max(1, Math.round(1 + cAmt * 7));
      const cbB = Cb.slice();
      const crB = Cr.slice();
      boxBlurBuffer(cbB, w, h, cr, cr, 1);
      boxBlurBuffer(crB, w, h, cr, cr, 1);
      for (let q = 0; q < n; q++) {
        Cb[q] += (cbB[q] - Cb[q]) * cAmt;
        Cr[q] += (crB[q] - Cr[q]) * cAmt;
      }
    }

    const sAmt = (p.sharpenDetails / 100) * 1.2;
    if (sAmt > 0) {
      const blurY = Y.slice();
      gaussianBlurBuffer(blurY, w, h, 1, 1);
      for (let q = 0; q < n; q++) Y[q] += (Y[q] - blurY[q]) * sAmt;
    }

    for (let i = 0, q = 0; q < n; q++, i += 4) {
      const y = Y[q], cb = Cb[q] - 128, cr = Cr[q] - 128;
      d[i] = y + 1.402 * cr;
      d[i + 1] = y - 0.344136 * cb - 0.714136 * cr;
      d[i + 2] = y + 1.772 * cb;
    }
  },
});
