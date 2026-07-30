import { registerFilter } from './registry.js';
import { el, clamp } from '../core/util.js';
import { rgb2hsv, hsv2rgb, rgb2hsl, hsl2rgb } from '../core/color.js';
import './other.css';

/**
 * Filter > Other — the utility filters: a raw convolution kernel, high pass,
 * morphological maximum/minimum, offset and the HSB/HSL channel remap.
 */

/* ------------------------------------------------------------------ */
/* Plane helpers                                                       */
/* ------------------------------------------------------------------ */

/** Split RGBA into four premultiplied Float32 planes. */
function toPlanes(data, n) {
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n), a = new Float32Array(n);
  for (let k = 0, i = 0; k < n; k++, i += 4) {
    const al = data[i + 3];
    const f = al / 255;
    r[k] = data[i] * f;
    g[k] = data[i + 1] * f;
    b[k] = data[i + 2] * f;
    a[k] = al;
  }
  return [r, g, b, a];
}

/** Sliding-window extreme over a 1-D line (monotonic deque, O(n)). */
function lineMorph(line, out, n, r, isMax, dq) {
  let head = 0, tail = 0, next = 0;
  for (let i = 0; i < n; i++) {
    const hi = Math.min(n - 1, i + r);
    while (next <= hi) {
      const v = line[next];
      while (tail > head && (isMax ? line[dq[tail - 1]] <= v : line[dq[tail - 1]] >= v)) tail--;
      dq[tail++] = next++;
    }
    const lo = i - r;
    while (dq[head] < lo) head++;
    out[i] = line[dq[head]];
  }
}

/** Dilate/erode a plane with an axis-aligned square structuring element. */
function morphSquare(plane, w, h, r, isMax) {
  if (r <= 0) return;
  const m = Math.max(w, h);
  const line = new Float32Array(m), out = new Float32Array(m), dq = new Int32Array(m);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) line[x] = plane[row + x];
    lineMorph(line, out, w, r, isMax, dq);
    for (let x = 0; x < w; x++) plane[row + x] = out[x];
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) line[y] = plane[y * w + x];
    lineMorph(line, out, h, r, isMax, dq);
    for (let y = 0; y < h; y++) plane[y * w + x] = out[y];
  }
}

/**
 * Dilate/erode along one diagonal family. Running both families turns a square
 * SE into an octagon, which is what "roundness" wants, still in O(n).
 */
function morphDiagonal(plane, w, h, r, isMax, down) {
  if (r <= 0) return;
  const m = Math.max(w, h);
  const line = new Float32Array(m), out = new Float32Array(m), dq = new Int32Array(m);
  const dy = down ? 1 : -1;
  const starts = [];
  if (down) {
    for (let x = 0; x < w; x++) starts.push(x, 0);
    for (let y = 1; y < h; y++) starts.push(0, y);
  } else {
    for (let x = 0; x < w; x++) starts.push(x, h - 1);
    for (let y = 0; y < h - 1; y++) starts.push(0, y);
  }
  for (let s = 0; s < starts.length; s += 2) {
    const sx = starts[s], sy = starts[s + 1];
    let x = sx, y = sy, n = 0;
    while (x < w && y >= 0 && y < h) { line[n++] = plane[y * w + x]; x++; y += dy; }
    if (n === 0) continue;
    lineMorph(line, out, n, r, isMax, dq);
    x = sx; y = sy;
    for (let i = 0; i < n; i++) { plane[y * w + x] = out[i]; x++; y += dy; }
  }
}

/** Horizontal box blur with clamped edges. */
function boxH(src, dst, w, h, r) {
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[row + clamp(i, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      dst[row + x] = sum / win;
      sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
}

/** Vertical box blur with clamped edges. */
function boxV(src, dst, w, h, r) {
  const win = 2 * r + 1;
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[clamp(i, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum / win;
      sum += src[Math.min(h - 1, y + r + 1) * w + x] - src[Math.max(0, y - r) * w + x];
    }
  }
}

/** Three box passes ≈ a Gaussian of the given sigma — O(n) for any radius. */
function blurPlane(plane, w, h, sigma) {
  if (sigma <= 0) return plane;
  const ideal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - 3 * wl * wl - 12 * wl - 9) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const radii = [0, 1, 2].map((i) => (((i < m ? wl : wu) - 1) / 2) | 0);
  const tmp = new Float32Array(plane.length);
  let a = plane, b = tmp;
  for (const r of radii) {
    if (r <= 0) continue;
    boxH(a, b, w, h, r);
    boxV(b, a, w, h, r);
  }
  return a;
}

/* ------------------------------------------------------------------ */
/* Custom (5x5 convolution)                                            */
/* ------------------------------------------------------------------ */

const IDENTITY_MATRIX = [
  0, 0, 0, 0, 0,
  0, 0, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 0, 0,
  0, 0, 0, 0, 0,
];

function renderMatrix(container, state, onChange) {
  const cells = [];
  const grid = el('div.pk-matrix');
  const current = () => (Array.isArray(state.matrix) ? state.matrix : IDENTITY_MATRIX);
  for (let i = 0; i < 25; i++) {
    const input = el('input.pk-input.pk-matrix-cell', {
      type: 'number', step: 1, value: current()[i],
    });
    if (i === 12) input.classList.add('center');
    input.addEventListener('input', () => {
      const next = current().slice();
      next[i] = Number(input.value) || 0;
      onChange('matrix', next);
    });
    cells.push(input);
    grid.appendChild(input);
  }
  container.appendChild(grid);
  return {
    sync(v) {
      const arr = Array.isArray(v) ? v : IDENTITY_MATRIX;
      for (let i = 0; i < 25; i++) {
        if (document.activeElement !== cells[i]) cells[i].value = arr[i];
      }
    },
  };
}

registerFilter({
  id: 'custom',
  name: 'Custom...',
  menu: 'Other',
  dialogWidth: 360,
  params: [
    { key: 'matrix', label: 'Kernel', type: 'custom', default: IDENTITY_MATRIX, render: renderMatrix },
    { key: 'scale', label: 'Scale', type: 'number', min: -9999, max: 9999, step: 1, default: 1 },
    { key: 'offset', label: 'Offset', type: 'number', min: -255, max: 255, step: 1, default: 0 },
  ],
  apply(imageData, p) {
    const { width: w, height: h, data } = imageData;
    const m = Array.isArray(p.matrix) ? p.matrix : IDENTITY_MATRIX;
    const scale = Number(p.scale) || 1;
    const offset = Number(p.offset) || 0;

    // Only non-zero taps are visited.
    const taps = [];
    for (let j = 0; j < 5; j++) {
      for (let i = 0; i < 5; i++) {
        const v = Number(m[j * 5 + i]) || 0;
        if (v !== 0) taps.push(i - 2, j - 2, v);
      }
    }
    if (!taps.length) {
      for (let i = 0; i < data.length; i += 4) {
        data[i] = offset; data[i + 1] = offset; data[i + 2] = offset;
      }
      return imageData;
    }

    const n = w * h;
    const [pr, pg, pb] = toPlanes(data, n);
    const inv = 1 / scale;
    let idx = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++, idx++) {
        let sr = 0, sg = 0, sb = 0;
        for (let t = 0; t < taps.length; t += 3) {
          const sx = clamp(x + taps[t], 0, w - 1);
          const sy = clamp(y + taps[t + 1], 0, h - 1);
          const k = sy * w + sx, wt = taps[t + 2];
          sr += pr[k] * wt; sg += pg[k] * wt; sb += pb[k] * wt;
        }
        const i = idx * 4;
        const a = data[i + 3];
        if (a === 0) continue;
        const un = 255 / a;
        data[i] = sr * inv * un + offset;
        data[i + 1] = sg * inv * un + offset;
        data[i + 2] = sb * inv * un + offset;
      }
    }
    return imageData;
  },
});

/* ------------------------------------------------------------------ */
/* High Pass                                                           */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'high-pass',
  name: 'High Pass...',
  menu: 'Other',
  params: [
    { key: 'radius', label: 'Radius', type: 'slider', min: 0.1, max: 1000, step: 0.1, default: 10, unit: 'px' },
  ],
  apply(imageData, p) {
    const { width: w, height: h, data } = imageData;
    const n = w * h;
    const sigma = Math.max(0.1, p.radius / 2);
    const [pr, pg, pb, pa] = toPlanes(data, n);
    const br = blurPlane(pr, w, h, sigma);
    const bg = blurPlane(pg, w, h, sigma);
    const bb = blurPlane(pb, w, h, sigma);
    const ba = blurPlane(pa, w, h, sigma);
    for (let k = 0, i = 0; k < n; k++, i += 4) {
      const a = data[i + 3];
      if (a === 0) { data[i] = 128; data[i + 1] = 128; data[i + 2] = 128; continue; }
      const abl = ba[k];
      const un = abl > 0.5 ? 255 / abl : 0;
      data[i] = data[i] - br[k] * un + 128;
      data[i + 1] = data[i + 1] - bg[k] * un + 128;
      data[i + 2] = data[i + 2] - bb[k] * un + 128;
    }
    return imageData;
  },
});

/* ------------------------------------------------------------------ */
/* Maximum / Minimum                                                   */
/* ------------------------------------------------------------------ */

function morphFilter(imageData, p, isMax) {
  const { width: w, height: h, data } = imageData;
  const r = Math.max(0, Math.round(p.radius));
  if (r === 0) return imageData;
  const n = w * h;
  const planes = toPlanes(data, n);
  const round = p.preserve === 'roundness';
  const b = round ? Math.round(r * 0.29) : 0;
  const a = round ? r - 2 * b : r;
  for (const plane of planes) {
    if (a > 0) morphSquare(plane, w, h, a, isMax);
    if (b > 0) {
      morphDiagonal(plane, w, h, b, isMax, true);
      morphDiagonal(plane, w, h, b, isMax, false);
    }
  }
  const [pr, pg, pb, pa] = planes;
  for (let k = 0, i = 0; k < n; k++, i += 4) {
    const al = pa[k];
    if (al <= 0.5) { data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 0; continue; }
    const un = 255 / al;
    data[i] = pr[k] * un;
    data[i + 1] = pg[k] * un;
    data[i + 2] = pb[k] * un;
    data[i + 3] = al;
  }
  return imageData;
}

const PRESERVE_PARAM = {
  key: 'preserve', label: 'Preserve', type: 'select', default: 'squareness',
  options: [{ value: 'squareness', label: 'Squareness' }, { value: 'roundness', label: 'Roundness' }],
};

registerFilter({
  id: 'maximum',
  name: 'Maximum...',
  menu: 'Other',
  params: [
    { key: 'radius', label: 'Radius', type: 'slider', min: 0, max: 100, step: 1, default: 3, unit: 'px' },
    { ...PRESERVE_PARAM },
  ],
  apply(imageData, p) {
    return morphFilter(imageData, p, true);
  },
});

registerFilter({
  id: 'minimum',
  name: 'Minimum...',
  menu: 'Other',
  params: [
    { key: 'radius', label: 'Radius', type: 'slider', min: 0, max: 100, step: 1, default: 3, unit: 'px' },
    { ...PRESERVE_PARAM },
  ],
  apply(imageData, p) {
    return morphFilter(imageData, p, false);
  },
});

/* ------------------------------------------------------------------ */
/* Offset                                                              */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'offset',
  name: 'Offset...',
  menu: 'Other',
  params: [
    { key: 'horizontal', label: 'Horizontal', type: 'number', min: -30000, max: 30000, step: 1, default: 0, unit: 'px right' },
    { key: 'vertical', label: 'Vertical', type: 'number', min: -30000, max: 30000, step: 1, default: 0, unit: 'px down' },
    {
      key: 'undefinedAreas', label: 'Undefined Areas', type: 'radio', default: 'wrap',
      options: [
        { value: 'transparent', label: 'Set to Transparent' },
        { value: 'repeat', label: 'Repeat Edge Pixels' },
        { value: 'wrap', label: 'Wrap Around' },
      ],
    },
  ],
  apply(imageData, p) {
    const { width: w, height: h, data } = imageData;
    const ox = Math.round(p.horizontal), oy = Math.round(p.vertical);
    if (!ox && !oy) return imageData;
    const src = new Uint8ClampedArray(data);
    const mode = p.undefinedAreas;
    let i = 0;
    for (let y = 0; y < h; y++) {
      let sy = y - oy;
      let rowBad = false;
      if (mode === 'wrap') sy = ((sy % h) + h) % h;
      else if (mode === 'repeat') sy = sy < 0 ? 0 : sy > h - 1 ? h - 1 : sy;
      else if (sy < 0 || sy >= h) rowBad = true;
      const row = sy * w;
      for (let x = 0; x < w; x++, i += 4) {
        if (rowBad) { data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 0; continue; }
        let sx = x - ox;
        if (mode === 'wrap') sx = ((sx % w) + w) % w;
        else if (mode === 'repeat') sx = sx < 0 ? 0 : sx > w - 1 ? w - 1 : sx;
        else if (sx < 0 || sx >= w) { data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 0; continue; }
        const j = (row + sx) * 4;
        data[i] = src[j]; data[i + 1] = src[j + 1]; data[i + 2] = src[j + 2]; data[i + 3] = src[j + 3];
      }
    }
    return imageData;
  },
});

/* ------------------------------------------------------------------ */
/* HSB/HSL                                                             */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'hsb-hsl',
  name: 'HSB/HSL...',
  menu: 'Other',
  dialogWidth: 340,
  params: [
    {
      key: 'mode', label: 'Conversion', type: 'select', default: 'rgb2hsb',
      options: [
        { value: 'rgb2hsb', label: 'RGB → HSB' },
        { value: 'rgb2hsl', label: 'RGB → HSL' },
        { value: 'hsb2rgb', label: 'HSB → RGB' },
        { value: 'hsl2rgb', label: 'HSL → RGB' },
      ],
    },
  ],
  apply(imageData, p) {
    const d = imageData.data;
    const mode = p.mode;
    for (let i = 0; i < d.length; i += 4) {
      if (mode === 'rgb2hsb') {
        const c = rgb2hsv(d[i], d[i + 1], d[i + 2]);
        d[i] = (c.h / 360) * 255;
        d[i + 1] = c.s * 255;
        d[i + 2] = c.v * 255;
      } else if (mode === 'rgb2hsl') {
        const c = rgb2hsl(d[i], d[i + 1], d[i + 2]);
        d[i] = (c.h / 360) * 255;
        d[i + 1] = c.s * 255;
        d[i + 2] = c.l * 255;
      } else if (mode === 'hsb2rgb') {
        const c = hsv2rgb((d[i] / 255) * 360, d[i + 1] / 255, d[i + 2] / 255);
        d[i] = c.r; d[i + 1] = c.g; d[i + 2] = c.b;
      } else {
        const c = hsl2rgb((d[i] / 255) * 360, d[i + 1] / 255, d[i + 2] / 255);
        d[i] = c.r; d[i + 1] = c.g; d[i + 2] = c.b;
      }
    }
    return imageData;
  },
});
