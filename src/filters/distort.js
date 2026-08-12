import { registerFilter } from './registry.js';
import { operableRect, operableSurface } from './run.js';
import { app } from '../core/app.js';
import { el, createCanvas, clamp, deg2rad } from '../core/util.js';
import {
  FACE_SLIDERS, applyFaceLiquify, faceParamsAreNeutral, defaultFaceBox,
} from './face-liquify.js';
import './distort.css';

/**
 * Filter > Distort — geometric warps.
 *
 * Every distortion inverse-maps: for each *destination* pixel we compute the
 * source coordinate and bilinearly sample it, so results never have holes.
 * Sampling runs in premultiplied space so transparent edges never bleed a
 * dark fringe into opaque pixels.
 */

/* ------------------------------------------------------------------ */
/* Sampling machinery                                                  */
/* ------------------------------------------------------------------ */

const EDGE_CLAMP = 0;
const EDGE_WRAP = 1;
const EDGE_NONE = 2;

/** 'wrap' | 'repeat' | 'transparent' -> EDGE_* */
function edgeCode(v) {
  return v === 'wrap' ? EDGE_WRAP : v === 'transparent' ? EDGE_NONE : EDGE_CLAMP;
}

/** Premultiplied copy of an RGBA buffer. */
function premultiply(data) {
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 255) {
      out[i] = data[i]; out[i + 1] = data[i + 1]; out[i + 2] = data[i + 2];
    } else if (a !== 0) {
      const f = a / 255;
      out[i] = data[i] * f; out[i + 1] = data[i + 1] * f; out[i + 2] = data[i + 2] * f;
    }
    out[i + 3] = a;
  }
  return out;
}

/** Bilinear sample of a premultiplied buffer honouring the edge policy. */
function sampleEdge(src, w, h, x, y, edge, out) {
  const bx = Math.floor(x), by = Math.floor(y);
  const fx = x - bx, fy = y - by;
  let r = 0, g = 0, b = 0, a = 0;
  for (let j = 0; j < 2; j++) {
    const wy = j === 0 ? 1 - fy : fy;
    if (wy <= 0) continue;
    let sy = by + j;
    if (edge === EDGE_WRAP) sy = ((sy % h) + h) % h;
    else if (edge === EDGE_CLAMP) sy = sy < 0 ? 0 : sy > h - 1 ? h - 1 : sy;
    else if (sy < 0 || sy >= h) continue;
    const row = sy * w;
    for (let i = 0; i < 2; i++) {
      const wx = i === 0 ? 1 - fx : fx;
      if (wx <= 0) continue;
      let sx = bx + i;
      if (edge === EDGE_WRAP) sx = ((sx % w) + w) % w;
      else if (edge === EDGE_CLAMP) sx = sx < 0 ? 0 : sx > w - 1 ? w - 1 : sx;
      else if (sx < 0 || sx >= w) continue;
      const k = (row + sx) * 4, ww = wx * wy;
      r += src[k] * ww; g += src[k + 1] * ww; b += src[k + 2] * ww; a += src[k + 3] * ww;
    }
  }
  out[0] = r; out[1] = g; out[2] = b; out[3] = a;
}

/**
 * Inverse-map an ImageData in place.
 * @param {ImageData} imageData
 * @param {number} edge one of EDGE_CLAMP / EDGE_WRAP / EDGE_NONE
 * @param {(x:number,y:number,out:Float64Array)=>void} mapFn writes the source
 *   coordinate for destination pixel (x,y) into out[0], out[1].
 */
function warp(imageData, edge, mapFn) {
  const { width: w, height: h, data } = imageData;
  const src = premultiply(data);
  const co = new Float64Array(2);
  const px = new Float64Array(4);
  let i = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      mapFn(x, y, co);
      sampleEdge(src, w, h, co[0], co[1], edge, px);
      const a = px[3];
      if (a <= 0.4) {
        data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 0;
      } else {
        const inv = 255 / a;
        data[i] = px[0] * inv; data[i + 1] = px[1] * inv; data[i + 2] = px[2] * inv; data[i + 3] = a;
      }
    }
  }
  return imageData;
}

const UNDEFINED_AREAS = [
  { value: 'wrap', label: 'Wrap Around' },
  { value: 'repeat', label: 'Repeat Edge Pixels' },
];

/* ------------------------------------------------------------------ */
/* Displace                                                            */
/* ------------------------------------------------------------------ */

/** 32-bit integer hash -> 0..1, used by the procedural displacement maps. */
function hash2(x, y, seed) {
  let n = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  n = (n ^ (n >>> 13)) | 0;
  n = Math.imul(n, 1274126177) | 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function smootherstep(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Periodic value noise on a `period`-cell lattice. */
function valueNoise(u, v, period, seed) {
  const x = u * period, y = v * period;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const tx = smootherstep(x - x0), ty = smootherstep(y - y0);
  const ix0 = ((x0 % period) + period) % period, iy0 = ((y0 % period) + period) % period;
  const ix1 = (ix0 + 1) % period, iy1 = (iy0 + 1) % period;
  const a = hash2(ix0, iy0, seed), b = hash2(ix1, iy0, seed);
  const c = hash2(ix0, iy1, seed), d = hash2(ix1, iy1, seed);
  const top = a + (b - a) * tx, bot = c + (d - c) * tx;
  return top + (bot - top) * ty;
}

/** Tileable fBm in -1..1. */
function fbm(u, v, seed, octaves = 4) {
  let sum = 0, amp = 1, norm = 0, period = 4;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(u, v, period, seed + o * 977) * amp;
    norm += amp;
    amp *= 0.5;
    period *= 2;
  }
  return (sum / norm) * 2 - 1;
}

/**
 * Build a tileable displacement field. Returns two Float32Arrays of gw*gh
 * holding dx/dy in -1..1.
 */
function buildDisplacementField(type, g, seed) {
  const dx = new Float32Array(g * g);
  const dy = new Float32Array(g * g);
  for (let j = 0; j < g; j++) {
    const v = j / g;
    for (let i = 0; i < g; i++) {
      const u = i / g;
      const k = j * g + i;
      let a = 0, b = 0;
      if (type === 'perlin') {
        a = fbm(u, v, seed | 0);
        b = fbm(u, v, (seed | 0) + 5171);
      } else if (type === 'ripples') {
        a = Math.sin(2 * Math.PI * 3 * v) * Math.cos(2 * Math.PI * 2 * u);
        b = Math.cos(2 * Math.PI * 2 * v) * Math.sin(2 * Math.PI * 3 * u);
      } else if (type === 'bars') {
        const band = Math.floor(v * 8);
        a = (band % 2 === 0 ? 1 : -1) * (0.4 + 0.6 * ((band * 37) % 5) / 4);
        b = 0;
      } else {
        const c = (Math.floor(u * 8) + Math.floor(v * 8)) % 2 === 0 ? 1 : -1;
        a = c;
        b = -c;
      }
      dx[k] = a;
      dy[k] = b;
    }
  }
  return { dx, dy, g };
}

/** Wrapped bilinear lookup into a displacement field. */
function sampleField(field, fx, fy, out) {
  const g = field.g;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const ix0 = ((x0 % g) + g) % g, iy0 = ((y0 % g) + g) % g;
  const ix1 = (ix0 + 1) % g, iy1 = (iy0 + 1) % g;
  const i00 = iy0 * g + ix0, i10 = iy0 * g + ix1, i01 = iy1 * g + ix0, i11 = iy1 * g + ix1;
  const dx = field.dx, dy = field.dy;
  const xa = dx[i00] + (dx[i10] - dx[i00]) * tx;
  const xb = dx[i01] + (dx[i11] - dx[i01]) * tx;
  const ya = dy[i00] + (dy[i10] - dy[i00]) * tx;
  const yb = dy[i01] + (dy[i11] - dy[i01]) * tx;
  out[0] = xa + (xb - xa) * ty;
  out[1] = ya + (yb - ya) * ty;
}

registerFilter({
  id: 'displace',
  name: 'Displace...',
  menu: 'Distort',
  dialogWidth: 380,
  params: [
    { key: 'horizontal', label: 'Horizontal Scale', type: 'slider', min: -999, max: 999, step: 1, default: 10 },
    { key: 'vertical', label: 'Vertical Scale', type: 'slider', min: -999, max: 999, step: 1, default: 10 },
    {
      key: 'mapType', label: 'Displacement Map', type: 'select', default: 'perlin',
      options: [
        { value: 'perlin', label: 'Perlin Noise' },
        { value: 'ripples', label: 'Ripples' },
        { value: 'bars', label: 'Bars' },
        { value: 'checkers', label: 'Checkers' },
      ],
    },
    { key: 'seed', label: 'Seed', type: 'slider', min: 1, max: 9999, step: 1, default: 137, when: (s) => s.mapType === 'perlin' },
    {
      key: 'fit', label: 'Map Fit', type: 'radio', default: 'stretch',
      options: [{ value: 'stretch', label: 'Stretch To Fit' }, { value: 'tile', label: 'Tile' }],
    },
    { key: 'detail', label: 'Tile Size', type: 'slider', min: 2, max: 100, step: 1, default: 25, unit: '%', when: (s) => s.fit === 'tile' },
    { key: 'undefinedAreas', label: 'Undefined Areas', type: 'radio', default: 'repeat', options: UNDEFINED_AREAS },
  ],
  apply(imageData, p) {
    const w = imageData.width, h = imageData.height;
    const g = 128;
    const field = buildDisplacementField(p.mapType, g, p.seed || 1);
    const tile = Math.max(8, (p.detail / 100) * Math.min(w, h));
    const kx = p.fit === 'tile' ? g / tile : g / w;
    const ky = p.fit === 'tile' ? g / tile : g / h;
    const d = new Float64Array(2);
    return warp(imageData, edgeCode(p.undefinedAreas), (x, y, out) => {
      sampleField(field, x * kx, y * ky, d);
      out[0] = x + d[0] * p.horizontal;
      out[1] = y + d[1] * p.vertical;
    });
  },
});

/* ------------------------------------------------------------------ */
/* Pinch                                                               */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'pinch',
  name: 'Pinch...',
  menu: 'Distort',
  params: [
    { key: 'amount', label: 'Amount', type: 'slider', min: -100, max: 100, step: 1, default: 50, unit: '%' },
  ],
  apply(imageData, p) {
    const w = imageData.width, h = imageData.height;
    if (!p.amount) return imageData;
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const rx = Math.max(1, cx), ry = Math.max(1, cy);
    // q < 1 pulls content inward (pinch), q > 1 pushes it outward (bulge).
    const q = Math.pow(2, -p.amount / 100);
    return warp(imageData, EDGE_CLAMP, (x, y, out) => {
      const nx = (x - cx) / rx, ny = (y - cy) / ry;
      const d = Math.sqrt(nx * nx + ny * ny);
      if (d >= 1 || d === 0) { out[0] = x; out[1] = y; return; }
      const s = Math.pow(d, q) / d;
      out[0] = cx + nx * s * rx;
      out[1] = cy + ny * s * ry;
    });
  },
});

/* ------------------------------------------------------------------ */
/* Polar Coordinates                                                   */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'polar-coordinates',
  name: 'Polar Coordinates...',
  menu: 'Distort',
  params: [
    {
      key: 'mode', label: 'Conversion', type: 'radio', default: 'rect2polar',
      options: [
        { value: 'rect2polar', label: 'Rectangular to Polar' },
        { value: 'polar2rect', label: 'Polar to Rectangular' },
      ],
    },
  ],
  apply(imageData, p) {
    const w = imageData.width, h = imageData.height;
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const rmax = Math.hypot(cx, cy) || 1;
    const TAU = Math.PI * 2;
    if (p.mode === 'rect2polar') {
      // The top row of the source collapses to the centre, the bottom row
      // becomes the outer edge; columns sweep clockwise from 12 o'clock.
      return warp(imageData, EDGE_CLAMP, (x, y, out) => {
        const dx = x - cx, dy = y - cy;
        const r = Math.sqrt(dx * dx + dy * dy);
        let a = Math.atan2(dx, -dy);
        if (a < 0) a += TAU;
        out[0] = (a / TAU) * (w - 1);
        out[1] = (r / rmax) * (h - 1);
      });
    }
    return warp(imageData, EDGE_CLAMP, (x, y, out) => {
      const a = (x / Math.max(1, w - 1)) * TAU;
      const r = (y / Math.max(1, h - 1)) * rmax;
      out[0] = cx + r * Math.sin(a);
      out[1] = cy - r * Math.cos(a);
    });
  },
});

/* ------------------------------------------------------------------ */
/* Ripple                                                              */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'ripple',
  name: 'Ripple...',
  menu: 'Distort',
  params: [
    { key: 'amount', label: 'Amount', type: 'slider', min: -999, max: 999, step: 1, default: 100, unit: '%' },
    {
      key: 'size', label: 'Size', type: 'select', default: 'medium',
      options: [{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }],
    },
  ],
  apply(imageData, p) {
    if (!p.amount) return imageData;
    const wl = p.size === 'small' ? 9 : p.size === 'large' ? 64 : 24;
    const amp = (p.amount / 100) * wl * 0.18;
    const k = (Math.PI * 2) / wl;
    return warp(imageData, EDGE_CLAMP, (x, y, out) => {
      out[0] = x + Math.sin(y * k) * amp;
      out[1] = y + Math.sin(x * k * 1.13 + 1.7) * amp;
    });
  },
});

/* ------------------------------------------------------------------ */
/* Shear                                                               */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'shear',
  name: 'Shear...',
  menu: 'Distort',
  params: [
    { key: 'amount', label: 'Amount', type: 'slider', min: -500, max: 500, step: 1, default: 40, unit: 'px' },
    { key: 'frequency', label: 'Frequency', type: 'slider', min: 0.25, max: 20, step: 0.25, default: 1 },
    { key: 'undefinedAreas', label: 'Undefined Areas', type: 'radio', default: 'repeat', options: UNDEFINED_AREAS },
  ],
  apply(imageData, p) {
    const h = imageData.height;
    if (!p.amount) return imageData;
    const k = (Math.PI * 2 * p.frequency) / Math.max(1, h);
    return warp(imageData, edgeCode(p.undefinedAreas), (x, y, out) => {
      out[0] = x - Math.sin(y * k) * p.amount;
      out[1] = y;
    });
  },
});

/* ------------------------------------------------------------------ */
/* Spherize                                                            */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'spherize',
  name: 'Spherize...',
  menu: 'Distort',
  params: [
    { key: 'amount', label: 'Amount', type: 'slider', min: -100, max: 100, step: 1, default: 100, unit: '%' },
    {
      key: 'mode', label: 'Mode', type: 'select', default: 'normal',
      options: [
        { value: 'normal', label: 'Normal' },
        { value: 'horizontal', label: 'Horizontal Only' },
        { value: 'vertical', label: 'Vertical Only' },
      ],
    },
  ],
  apply(imageData, p) {
    const w = imageData.width, h = imageData.height;
    if (!p.amount) return imageData;
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const rx = Math.max(1, cx), ry = Math.max(1, cy);
    const k = p.amount / 100;
    const HALF_PI = Math.PI / 2;
    // Dest radius d -> source radius: the arc-length parameterisation of a
    // hemisphere, mixed with identity by `amount`.
    const lens = (d) => {
      if (d <= 0) return 0;
      if (d >= 1) return 1;
      const sphere = Math.asin(d) / HALF_PI;
      return d + (sphere - d) * k;
    };
    if (p.mode === 'horizontal') {
      return warp(imageData, EDGE_CLAMP, (x, y, out) => {
        const nx = (x - cx) / rx;
        const d = Math.abs(nx);
        out[0] = d >= 1 ? x : cx + Math.sign(nx) * lens(d) * rx;
        out[1] = y;
      });
    }
    if (p.mode === 'vertical') {
      return warp(imageData, EDGE_CLAMP, (x, y, out) => {
        const ny = (y - cy) / ry;
        const d = Math.abs(ny);
        out[0] = x;
        out[1] = d >= 1 ? y : cy + Math.sign(ny) * lens(d) * ry;
      });
    }
    return warp(imageData, EDGE_CLAMP, (x, y, out) => {
      const nx = (x - cx) / rx, ny = (y - cy) / ry;
      const d = Math.sqrt(nx * nx + ny * ny);
      if (d >= 1 || d === 0) { out[0] = x; out[1] = y; return; }
      const s = lens(d) / d;
      out[0] = cx + nx * s * rx;
      out[1] = cy + ny * s * ry;
    });
  },
});

/* ------------------------------------------------------------------ */
/* Twirl                                                               */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'twirl',
  name: 'Twirl...',
  menu: 'Distort',
  params: [
    { key: 'angle', label: 'Angle', type: 'slider', min: -999, max: 999, step: 1, default: 50, unit: '°' },
  ],
  apply(imageData, p) {
    const w = imageData.width, h = imageData.height;
    if (!p.angle) return imageData;
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const rmax = Math.max(1, Math.min(cx, cy));
    const maxAngle = deg2rad(p.angle);
    return warp(imageData, EDGE_CLAMP, (x, y, out) => {
      const dx = x - cx, dy = y - cy;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r >= rmax) { out[0] = x; out[1] = y; return; }
      const f = 1 - r / rmax;
      const a = Math.atan2(dy, dx) - maxAngle * f * f;
      out[0] = cx + r * Math.cos(a);
      out[1] = cy + r * Math.sin(a);
    });
  },
});

/* ------------------------------------------------------------------ */
/* Wave                                                                */
/* ------------------------------------------------------------------ */

function waveShape(type, t) {
  const f = t - Math.floor(t);
  if (type === 'square') return f < 0.5 ? 1 : -1;
  if (type === 'triangle') return 1 - 4 * Math.abs((f + 0.25 - Math.floor(f + 0.25)) - 0.5);
  return Math.sin(f * Math.PI * 2);
}

registerFilter({
  id: 'wave',
  name: 'Wave...',
  menu: 'Distort',
  dialogWidth: 380,
  params: [
    { key: 'generators', label: 'Number of Generators', type: 'slider', min: 1, max: 999, step: 1, default: 5 },
    { key: 'wavelengthMin', label: 'Wavelength Min', type: 'slider', min: 1, max: 999, step: 1, default: 10 },
    { key: 'wavelengthMax', label: 'Wavelength Max', type: 'slider', min: 1, max: 999, step: 1, default: 120 },
    { key: 'amplitudeMin', label: 'Amplitude Min', type: 'slider', min: 1, max: 999, step: 1, default: 5 },
    { key: 'amplitudeMax', label: 'Amplitude Max', type: 'slider', min: 1, max: 999, step: 1, default: 35 },
    { key: 'scaleH', label: 'Horizontal Scale', type: 'slider', min: 0, max: 100, step: 1, default: 100, unit: '%' },
    { key: 'scaleV', label: 'Vertical Scale', type: 'slider', min: 0, max: 100, step: 1, default: 100, unit: '%' },
    {
      key: 'type', label: 'Type', type: 'radio', default: 'sine',
      options: [{ value: 'sine', label: 'Sine' }, { value: 'triangle', label: 'Triangle' }, { value: 'square', label: 'Square' }],
    },
    { key: 'undefinedAreas', label: 'Undefined Areas', type: 'radio', default: 'repeat', options: UNDEFINED_AREAS },
    { key: 'seed', label: 'Randomize', type: 'slider', min: 1, max: 9999, step: 1, default: 42 },
  ],
  apply(imageData, p) {
    const n = Math.max(1, Math.min(999, p.generators | 0));
    const wlLo = Math.min(p.wavelengthMin, p.wavelengthMax);
    const wlHi = Math.max(p.wavelengthMin, p.wavelengthMax);
    const ampLo = Math.min(p.amplitudeMin, p.amplitudeMax);
    const ampHi = Math.max(p.amplitudeMin, p.amplitudeMax);

    // Deterministic generator bank so the preview is stable.
    let s = (p.seed | 0) || 1;
    const rnd = () => {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
    const gx = new Float64Array(n * 3);
    const gy = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      gx[i * 3] = 1 / Math.max(0.5, wlLo + rnd() * (wlHi - wlLo));
      gx[i * 3 + 1] = ampLo + rnd() * (ampHi - ampLo);
      gx[i * 3 + 2] = rnd();
      gy[i * 3] = 1 / Math.max(0.5, wlLo + rnd() * (wlHi - wlLo));
      gy[i * 3 + 1] = ampLo + rnd() * (ampHi - ampLo);
      gy[i * 3 + 2] = rnd();
    }
    const kh = (p.scaleH / 100) / n;
    const kv = (p.scaleV / 100) / n;
    const type = p.type;
    const w = imageData.width, h = imageData.height;

    // The horizontal shift only depends on y and the vertical one only on x,
    // so the generator bank is evaluated once per row and once per column.
    const shiftX = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const b = i * 3;
        sum += waveShape(type, y * gx[b] + gx[b + 2]) * gx[b + 1];
      }
      shiftX[y] = sum * kh;
    }
    const shiftY = new Float64Array(w);
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const b = i * 3;
        sum += waveShape(type, x * gy[b] + gy[b + 2]) * gy[b + 1];
      }
      shiftY[x] = sum * kv;
    }

    return warp(imageData, edgeCode(p.undefinedAreas), (x, y, out) => {
      out[0] = x + shiftX[y];
      out[1] = y + shiftY[x];
    });
  },
});

/* ------------------------------------------------------------------ */
/* ZigZag                                                              */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'zigzag',
  name: 'ZigZag...',
  menu: 'Distort',
  params: [
    { key: 'amount', label: 'Amount', type: 'slider', min: -100, max: 100, step: 1, default: 50, unit: '%' },
    { key: 'ridges', label: 'Ridges', type: 'slider', min: 0, max: 20, step: 1, default: 5 },
    {
      key: 'style', label: 'Style', type: 'select', default: 'pond',
      options: [
        { value: 'around', label: 'Around Center' },
        { value: 'out', label: 'Out From Center' },
        { value: 'pond', label: 'Pond Ripples' },
      ],
    },
  ],
  apply(imageData, p) {
    const w = imageData.width, h = imageData.height;
    if (!p.amount || !p.ridges) return imageData;
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const rmax = Math.max(1, Math.min(cx, cy));
    const amp = (p.amount / 100) * rmax * 0.25;
    const k = p.ridges * Math.PI;
    const radial = p.style !== 'around';
    const angular = p.style !== 'out';
    return warp(imageData, EDGE_CLAMP, (x, y, out) => {
      const dx = x - cx, dy = y - cy;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r >= rmax || r === 0) { out[0] = x; out[1] = y; return; }
      const d = r / rmax;
      const push = amp * Math.sin(d * k) * (1 - d);
      const sr = radial ? r + push : r;
      const sa = Math.atan2(dy, dx) + (angular ? push / Math.max(2, r) : 0);
      out[0] = cx + sr * Math.cos(sa);
      out[1] = cy + sr * Math.sin(sa);
    });
  },
});

/* ------------------------------------------------------------------ */
/* Lens Correction                                                     */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'lens-correction',
  name: 'Lens Correction...',
  menu: 'Distort',
  dialogWidth: 400,
  params: [
    { key: 'distortion', label: 'Remove Distortion', type: 'slider', min: -100, max: 100, step: 1, default: 0, hint: '− barrel · + pincushion' },
    { key: 'chromaRC', label: 'Fix Red/Cyan Fringe', type: 'slider', min: -100, max: 100, step: 1, default: 0 },
    { key: 'chromaBY', label: 'Fix Blue/Yellow Fringe', type: 'slider', min: -100, max: 100, step: 1, default: 0 },
    { type: 'separator' },
    { key: 'vertical', label: 'Vertical Perspective', type: 'slider', min: -100, max: 100, step: 1, default: 0 },
    { key: 'horizontal', label: 'Horizontal Perspective', type: 'slider', min: -100, max: 100, step: 1, default: 0 },
    { key: 'angle', label: 'Angle', type: 'angle', default: 0 },
    { key: 'scale', label: 'Scale', type: 'slider', min: 50, max: 200, step: 1, default: 100, unit: '%' },
  ],
  apply(imageData, p) {
    const w = imageData.width, h = imageData.height, data = imageData.data;
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const rn = Math.hypot(cx, cy) || 1;
    const sc = Math.max(0.05, p.scale / 100);
    const rot = deg2rad(-p.angle);
    const cs = Math.cos(rot), sn = Math.sin(rot);
    const kv = (p.vertical / 100) * 0.6;
    const kh = (p.horizontal / 100) * 0.6;
    const kd = p.distortion / 100;
    const sr = 1 + (p.chromaRC / 100) * 0.01;
    const sb = 1 + (p.chromaBY / 100) * 0.01;
    const ca = sr !== 1 || sb !== 1;

    const src = premultiply(data);
    const px = new Float64Array(4);
    const px2 = new Float64Array(4);
    const px3 = new Float64Array(4);

    // dest (x,y) -> source coordinate for a channel-specific radial scale
    const project = (x, y, chan, out) => {
      let nx = (x - cx) / (rn * sc), ny = (y - cy) / (rn * sc);
      let rx = nx * cs - ny * sn;
      let ry = nx * sn + ny * cs;
      const den = 1 + kv * ry + kh * rx;
      if (Math.abs(den) > 1e-3) { rx /= den; ry /= den; }
      const f = (1 + kd * (rx * rx + ry * ry)) * chan;
      out[0] = cx + rx * f * rn;
      out[1] = cy + ry * f * rn;
    };

    const co = new Float64Array(2);
    let i = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i += 4) {
        project(x, y, 1, co);
        sampleEdge(src, w, h, co[0], co[1], EDGE_NONE, px);
        let r = px[0], g = px[1], b = px[2], a = px[3];
        if (ca) {
          project(x, y, sr, co);
          sampleEdge(src, w, h, co[0], co[1], EDGE_NONE, px2);
          project(x, y, sb, co);
          sampleEdge(src, w, h, co[0], co[1], EDGE_NONE, px3);
          r = px2[0]; b = px3[2];
          a = (px[3] + px2[3] + px3[3]) / 3;
        }
        if (a <= 0.4) {
          data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 0;
        } else {
          const inv = 255 / a;
          data[i] = r * inv; data[i + 1] = g * inv; data[i + 2] = b * inv; data[i + 3] = a;
        }
      }
    }
    return imageData;
  },
});

/* ------------------------------------------------------------------ */
/* Liquify                                                             */
/* ------------------------------------------------------------------ */

/**
 * Liquify — an interactive mesh warp with the full tool set.
 *
 * The state is one forward-displacement mesh: `dx`/`dy` hold the offset at each
 * node in **normalised image units** (so the same mesh applies to the preview and
 * to the full-size layer), and `frozen` holds a 0..1 protection weight per node.
 * Every tool is a brush that edits those three arrays; `applyLiquifyMesh` is the
 * only thing that ever touches pixels, and it inverse-maps once from the
 * untouched original, so no amount of pushing pixels around compounds a resample.
 *
 * Freezing is enforced at the point of authorship rather than at render time:
 * every tool scales its per-node weight by `1 - frozen`, so a fully frozen node
 * cannot move, and a fully frozen *region* comes out byte-identical (the mesh
 * there stays exactly zero, and a zero displacement samples the source pixel
 * centre exactly).
 *
 * The face-aware sliders live in `face-liquify.js` and write into this same
 * mesh, so freezing, reconstruct and the single inverse resample all apply to
 * them unchanged. What is still absent is *detection*: the face is the region
 * being worked on rather than something found automatically.
 */

const MESH_N = 65;

/** The Liquify tool list, in the order the dialog offers them. */
export const LIQUIFY_TOOLS = [
  { value: 'push', label: 'Forward Warp' },
  { value: 'reconstruct', label: 'Reconstruct' },
  { value: 'smooth', label: 'Smooth' },
  { value: 'twirl-cw', label: 'Twirl Clockwise' },
  { value: 'twirl-ccw', label: 'Twirl Anticlockwise' },
  { value: 'pucker', label: 'Pucker' },
  { value: 'bloat', label: 'Bloat' },
  { value: 'push-left', label: 'Push Left' },
  { value: 'freeze', label: 'Freeze Mask' },
  { value: 'thaw', label: 'Thaw Mask' },
];

/** Tools that keep working while the pointer is held still. */
const HOLD_TOOLS = new Set([
  'reconstruct', 'smooth', 'twirl-cw', 'twirl-ccw', 'pucker', 'bloat', 'freeze', 'thaw',
]);

/** Tools that paint the freeze mask rather than the displacement. */
const MASK_TOOLS = new Set(['freeze', 'thaw']);

/**
 * A neutral Liquify mesh.
 * @param {number} [n] nodes per axis
 * @returns {{n:number, dx:Float32Array, dy:Float32Array, frozen:Float32Array}}
 */
export function createLiquifyMesh(n = MESH_N) {
  return {
    n,
    dx: new Float32Array(n * n),
    dy: new Float32Array(n * n),
    frozen: new Float32Array(n * n),
  };
}

/** True when the mesh would not move a single pixel. */
export function liquifyMeshIsEmpty(m) {
  if (!m || !m.dx || !m.dy) return true;
  const d = m.dx, e = m.dy;
  if (d.length !== e.length) return true;
  for (let i = 0; i < d.length; i++) if (d[i] !== 0 || e[i] !== 0) return false;
  return true;
}

/** A mesh with a `frozen` channel, adopting `m`'s buffers when it already has one. */
function withFrozen(m) {
  if (!m || !m.dx) return createLiquifyMesh();
  if (m.frozen && m.frozen.length === m.dx.length) return m;
  return { n: m.n, dx: m.dx, dy: m.dy, frozen: new Float32Array(m.dx.length) };
}

/** Bilinear lookup of the forward displacement (normalised units). */
function meshAt(m, u, v, out) {
  const n = m.n;
  const fx = clamp(u, 0, 1) * (n - 1), fy = clamp(v, 0, 1) * (n - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  const dx = m.dx, dy = m.dy;
  const i00 = y0 * n + x0, i10 = y0 * n + x1, i01 = y1 * n + x0, i11 = y1 * n + x1;
  const xa = dx[i00] + (dx[i10] - dx[i00]) * tx;
  const xb = dx[i01] + (dx[i11] - dx[i01]) * tx;
  const ya = dy[i00] + (dy[i10] - dy[i00]) * tx;
  const yb = dy[i01] + (dy[i11] - dy[i01]) * tx;
  out[0] = xa + (xb - xa) * ty;
  out[1] = ya + (yb - ya) * ty;
}

/**
 * Inverse-map an ImageData through a Liquify mesh, in place.
 * @param {ImageData} imageData
 * @param {{n:number, dx:Float32Array, dy:Float32Array}} mesh
 * @returns {ImageData}
 */
export function applyLiquifyMesh(imageData, mesh) {
  const w = imageData.width, h = imageData.height;
  const d = new Float64Array(2);
  const iw = Math.max(1, w - 1), ih = Math.max(1, h - 1);
  return warp(imageData, EDGE_CLAMP, (x, y, out) => {
    meshAt(mesh, x / iw, y / ih, d);
    out[0] = x - d[0] * w;
    out[1] = y - d[1] * h;
  });
}

/**
 * Paint one brush dab into the mesh.
 *
 * @param {object} mesh from {@link createLiquifyMesh}
 * @param {object} o
 * @param {number} o.u normalised brush centre
 * @param {number} o.v
 * @param {number} [o.vx] drag velocity, normalised units (Forward Warp, Push Left)
 * @param {number} [o.vy]
 * @param {string} o.mode one of {@link LIQUIFY_TOOLS}
 * @param {number} o.radius brush radius in image pixels
 * @param {number} o.pressure 0..1 overall strength for this dab
 * @param {number} [o.density] 0..1 edge hardness of the falloff (default 0.5)
 * @param {number} o.aspectW image width in pixels (the radius' frame)
 * @param {number} o.aspectH image height in pixels
 * @returns {number} the number of nodes the dab actually changed
 */
export function liquifyDab(mesh, o) {
  const n = mesh.n;
  const frozen = mesh.frozen;
  const rw = o.aspectW, rh = o.aspectH;
  const rad = Math.max(1, o.radius);
  const press = clamp(o.pressure, 0, 1);
  const mode = o.mode || 'push';
  if (press <= 0) return 0;
  // Density shapes the falloff: 100 spreads the effect right out to the brush
  // edge, 0 concentrates it in the middle. 50 is the classic (1-d²)².
  const edge = 1 + (1 - clamp(o.density == null ? 0.5 : o.density, 0, 1)) * 2;

  // Only the nodes inside the brush footprint need visiting.
  const spanU = Math.ceil((rad / rw) * (n - 1)) + 1;
  const spanV = Math.ceil((rad / rh) * (n - 1)) + 1;
  const ci = Math.round(o.u * (n - 1)), cj = Math.round(o.v * (n - 1));
  const i0 = Math.max(0, ci - spanU), i1 = Math.min(n - 1, ci + spanU);
  const j0 = Math.max(0, cj - spanV), j1 = Math.min(n - 1, cj + spanV);
  if (i1 < i0 || j1 < j0) return 0;

  // Smooth averages neighbours, so it reads from a snapshot of the footprint —
  // otherwise the sweep direction would bias the result.
  let snapX = null, snapY = null, snapW = 0, snapH = 0;
  if (mode === 'smooth') {
    snapW = i1 - i0 + 1;
    snapH = j1 - j0 + 1;
    snapX = new Float32Array(snapW * snapH);
    snapY = new Float32Array(snapW * snapH);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = (j - j0) * snapW + (i - i0);
        snapX[k] = mesh.dx[j * n + i];
        snapY[k] = mesh.dy[j * n + i];
      }
    }
  }

  let touched = 0;
  for (let j = j0; j <= j1; j++) {
    const py = (j / (n - 1) - o.v) * rh;
    for (let i = i0; i <= i1; i++) {
      const pxx = (i / (n - 1) - o.u) * rw;
      const dist = Math.sqrt(pxx * pxx + py * py) / rad;
      if (dist >= 1) continue;
      const k = j * n + i;
      const fall = Math.pow(1 - dist * dist, edge);
      let wgt = fall * press;
      if (!MASK_TOOLS.has(mode)) wgt *= 1 - clamp(frozen ? frozen[k] : 0, 0, 1);
      if (wgt <= 0) continue;
      touched++;

      switch (mode) {
        case 'push':
          mesh.dx[k] += o.vx * wgt;
          mesh.dy[k] += o.vy * wgt;
          break;
        case 'push-left':
          // Perpendicular to travel, on the left-hand side of the direction of
          // motion: dragging up pushes pixels left, dragging right pushes up.
          mesh.dx[k] += o.vy * wgt;
          mesh.dy[k] += -o.vx * wgt;
          break;
        case 'twirl-cw':
        case 'twirl-ccw': {
          const ang = (mode === 'twirl-cw' ? 0.35 : -0.35) * wgt;
          const cs = Math.cos(ang), sn = Math.sin(ang);
          const qx = pxx * cs - py * sn, qy = pxx * sn + py * cs;
          mesh.dx[k] += (qx - pxx) / rw;
          mesh.dy[k] += (qy - py) / rh;
          break;
        }
        case 'bloat':
        case 'pucker': {
          const dir = mode === 'bloat' ? 0.16 : -0.16;
          mesh.dx[k] += (pxx / rw) * dir * wgt;
          mesh.dy[k] += (py / rh) * dir * wgt;
          break;
        }
        case 'reconstruct': {
          const t = Math.min(1, wgt);
          mesh.dx[k] -= mesh.dx[k] * t;
          mesh.dy[k] -= mesh.dy[k] * t;
          break;
        }
        case 'smooth': {
          const t = Math.min(1, wgt);
          const li = i - i0, lj = j - j0;
          let sx = 0, sy = 0, cnt = 0;
          for (let b = -1; b <= 1; b++) {
            for (let a = -1; a <= 1; a++) {
              const ni = li + a, nj = lj + b;
              if (ni < 0 || nj < 0 || ni >= snapW || nj >= snapH) continue;
              const sk = nj * snapW + ni;
              sx += snapX[sk]; sy += snapY[sk]; cnt++;
            }
          }
          if (!cnt) break;
          mesh.dx[k] += (sx / cnt - mesh.dx[k]) * t;
          mesh.dy[k] += (sy / cnt - mesh.dy[k]) * t;
          break;
        }
        case 'freeze':
          if (frozen) frozen[k] = Math.min(1, frozen[k] + wgt);
          break;
        case 'thaw':
          if (frozen) frozen[k] = Math.max(0, frozen[k] - wgt);
          break;
        default:
          mesh.dx[k] += o.vx * wgt;
          mesh.dy[k] += o.vy * wgt;
          break;
      }
    }
  }
  return touched;
}

/** Blend the whole mesh back toward the identity — the Reconstruct button. */
function reconstructAll(mesh, amount) {
  const k = clamp(1 - amount, 0, 1);
  for (let i = 0; i < mesh.dx.length; i++) {
    const keep = k + (1 - k) * clamp(mesh.frozen ? mesh.frozen[i] : 0, 0, 1);
    mesh.dx[i] *= keep;
    mesh.dy[i] *= keep;
  }
}

/** Relax the whole mesh once — the Smooth All button. */
function smoothAll(mesh) {
  const n = mesh.n;
  const sx = mesh.dx.slice(), sy = mesh.dy.slice();
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const hold = clamp(mesh.frozen ? mesh.frozen[k] : 0, 0, 1);
      if (hold >= 1) continue;
      let ax = 0, ay = 0, c = 0;
      for (let b = -1; b <= 1; b++) {
        for (let a = -1; a <= 1; a++) {
          const ni = i + a, nj = j + b;
          if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
          ax += sx[nj * n + ni]; ay += sy[nj * n + ni]; c++;
        }
      }
      if (!c) continue;
      const t = 1 - hold;
      mesh.dx[k] += (ax / c - sx[k]) * t;
      mesh.dy[k] += (ay / c - sy[k]) * t;
    }
  }
}

/* ------------------------------------------------------------------ */
/* The interactive editor                                              */
/* ------------------------------------------------------------------ */

/** Interactive mesh editor rendered into the Liquify dialog. */
function renderLiquify(container, state, onChange) {
  const doc = app.activeDoc;
  const layer = doc && doc.activeLayer();
  const surf = doc && layer ? operableSurface(doc, layer) : null;
  if (!surf) {
    container.appendChild(el('div.pk-hint', { text: 'No editable layer.' }));
    return null;
  }
  const rect = operableRect(doc);
  const scale = Math.min(440 / rect.width, 320 / rect.height, 1);
  const pw = Math.max(8, Math.round(rect.width * scale));
  const ph = Math.max(8, Math.round(rect.height * scale));

  const base = createCanvas(pw, ph);
  const bctx = base.getContext('2d', { willReadFrequently: true });
  bctx.drawImage(surf.canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, pw, ph);
  const baseData = bctx.getImageData(0, 0, pw, ph);

  const view = el('canvas.pk-liquify-view.pk-checker', { width: pw, height: ph });
  const chrome = el('canvas.pk-liquify-chrome', { width: pw, height: ph });
  const stage = el('div.pk-liquify-stage', {}, view, chrome);
  const vctx = view.getContext('2d');
  const cctx = chrome.getContext('2d');
  const work = new ImageData(new Uint8ClampedArray(baseData.data.length), pw, ph);

  // The frozen overlay is drawn from a node-resolution canvas scaled up, which
  // is both cheap and an honest picture of the mesh the mask actually protects.
  const maskCv = createCanvas(MESH_N, MESH_N);
  const mctx = maskCv.getContext('2d');
  const maskImg = new ImageData(MESH_N, MESH_N);

  let mesh = createLiquifyMesh();
  const d = new Float64Array(2);
  /** Brush ring position in preview pixels, or null when the pointer is away. */
  let hover = null;

  const previewRadius = () => Math.max(2, ((state.brushSize || 180) / 2) * scale);

  const drawChrome = () => {
    cctx.clearRect(0, 0, pw, ph);
    if (state.showMask !== false && mesh.frozen) {
      let any = false;
      const md = maskImg.data;
      for (let k = 0; k < mesh.frozen.length; k++) {
        const a = clamp(mesh.frozen[k], 0, 1);
        if (a > 0) any = true;
        md[k * 4] = 255; md[k * 4 + 1] = 64; md[k * 4 + 2] = 64;
        md[k * 4 + 3] = Math.round(a * 130);
      }
      if (any) {
        mctx.putImageData(maskImg, 0, 0);
        cctx.save();
        cctx.imageSmoothingEnabled = true;
        cctx.drawImage(maskCv, 0, 0, pw, ph);
        cctx.restore();
      }
    }
    if (state.showMesh) {
      cctx.save();
      cctx.strokeStyle = 'rgba(122,184,255,.45)';
      cctx.lineWidth = 1;
      const step = 4;
      const n = mesh.n;
      cctx.beginPath();
      for (let j = 0; j < n; j += step) {
        for (let i = 0; i < n; i += step) {
          meshAt(mesh, i / (n - 1), j / (n - 1), d);
          const x = (i / (n - 1) + d[0]) * pw;
          const y = (j / (n - 1) + d[1]) * ph;
          if (i === 0) cctx.moveTo(x, y); else cctx.lineTo(x, y);
        }
      }
      for (let i = 0; i < n; i += step) {
        for (let j = 0; j < n; j += step) {
          meshAt(mesh, i / (n - 1), j / (n - 1), d);
          const x = (i / (n - 1) + d[0]) * pw;
          const y = (j / (n - 1) + d[1]) * ph;
          if (j === 0) cctx.moveTo(x, y); else cctx.lineTo(x, y);
        }
      }
      cctx.stroke();
      cctx.restore();
    }
    if (hover) {
      cctx.save();
      cctx.beginPath();
      cctx.arc(hover.x, hover.y, previewRadius(), 0, Math.PI * 2);
      cctx.strokeStyle = 'rgba(0,0,0,.55)';
      cctx.lineWidth = 3;
      cctx.stroke();
      cctx.strokeStyle = MASK_TOOLS.has(state.mode) ? 'rgba(255,120,120,.95)' : 'rgba(255,255,255,.95)';
      cctx.lineWidth = 1.25;
      cctx.stroke();
      cctx.restore();
    }
  };

  const draw = () => {
    work.data.set(baseData.data);
    if (!liquifyMeshIsEmpty(mesh)) applyLiquifyMesh(work, mesh);
    vctx.putImageData(work, 0, 0);
    drawChrome();
  };

  const publish = () => onChange('mesh', { n: mesh.n, dx: mesh.dx, dy: mesh.dy, frozen: mesh.frozen });

  let dragging = false;
  let lastU = 0, lastV = 0;
  let hold = null;
  // A mesh left over from a previous run must not be adopted: re-applying it
  // would warp pixels that already carry that warp. Ignore exactly that object.
  const stale = state.mesh && !liquifyMeshIsEmpty(state.mesh) ? state.mesh : null;

  const posOf = (e) => {
    const r = view.getBoundingClientRect();
    return { u: (e.clientX - r.left) / r.width, v: (e.clientY - r.top) / r.height };
  };

  const dab = (u, v, vx, vy, strength) => {
    liquifyDab(mesh, {
      u, v, vx, vy,
      mode: state.mode || 'push',
      radius: Math.max(2, (state.brushSize || 180) / 2),
      pressure: strength,
      density: (state.brushDensity == null ? 50 : state.brushDensity) / 100,
      aspectW: rect.width,
      aspectH: rect.height,
    });
    draw();
  };

  /** Drag strength, and the weaker per-tick strength for a held brush. */
  const pressure = () => clamp((state.brushPressure == null ? 60 : state.brushPressure) / 100, 0, 1);
  const tickStrength = () => pressure() * clamp((state.brushRate == null ? 40 : state.brushRate) / 100, 0, 1);

  view.addEventListener('pointerdown', (e) => {
    dragging = true;
    view.setPointerCapture(e.pointerId);
    const p = posOf(e);
    lastU = p.u; lastV = p.v;
    hover = { x: p.u * pw, y: p.v * ph };
    if (HOLD_TOOLS.has(state.mode || 'push')) {
      dab(p.u, p.v, 0, 0, tickStrength());
      // Twirl/pucker/bloat/reconstruct/smooth/freeze keep working while held.
      hold = setInterval(() => {
        if (!view.isConnected) { finish(); return; }
        dab(lastU, lastV, 0, 0, tickStrength());
      }, 45);
    }
    e.preventDefault();
  });

  view.addEventListener('pointermove', (e) => {
    const p = posOf(e);
    hover = { x: p.u * pw, y: p.v * ph };
    if (!dragging) { drawChrome(); return; }
    dab(p.u, p.v, p.u - lastU, p.v - lastV, pressure());
    lastU = p.u; lastV = p.v;
  });

  view.addEventListener('pointerleave', () => {
    if (dragging) return;
    hover = null;
    drawChrome();
  });

  const finish = () => {
    if (!dragging) return;
    dragging = false;
    if (hold) { clearInterval(hold); hold = null; }
    publish();
  };
  view.addEventListener('pointerup', finish);
  view.addEventListener('pointercancel', finish);
  view.addEventListener('lostpointercapture', finish);

  const act = (label, fn, title) => el('button.pk-btn.subtle', {
    type: 'button', text: label, title: title || label,
    onclick: () => {
      fn();
      draw();
      publish();
    },
  });

  const tools = el('div.pk-liquify-tools', {},
    act('Reconstruct', () => reconstructAll(mesh, 0.3), 'Ease the whole mesh back toward its original shape'),
    act('Smooth All', () => smoothAll(mesh), 'Relax the whole mesh'),
    act('Restore All', () => { mesh.dx.fill(0); mesh.dy.fill(0); }, 'Remove every distortion'),
    act('Freeze All', () => mesh.frozen.fill(1), 'Protect the whole image'),
    act('Invert Freeze', () => {
      for (let i = 0; i < mesh.frozen.length; i++) mesh.frozen[i] = 1 - mesh.frozen[i];
    }, 'Swap frozen and thawed areas'),
    act('Thaw All', () => mesh.frozen.fill(0), 'Clear the freeze mask'),
    el('span.pk-hint', { text: 'Drag on the preview to warp' })
  );

  container.classList.add('pk-liquify');
  container.append(stage, tools);

  // `onChange` cannot run while the form is still being built, so the reset of
  // a remembered mesh is deferred to the next frame.
  if (stale) requestAnimationFrame(publish);
  draw();

  return {
    sync(v) {
      if (v && v.dx && v !== stale) {
        if (v.dx !== mesh.dx) mesh = withFrozen({ n: v.n, dx: v.dx, dy: v.dy, frozen: v.frozen });
      } else if (!liquifyMeshIsEmpty(mesh)) {
        mesh = createLiquifyMesh();
      }
      draw();
    },
  };
}

registerFilter({
  id: 'liquify',
  name: 'Liquify...',
  menu: 'Distort',
  dialogWidth: 520,
  params: [
    { key: 'mode', label: 'Tool', type: 'select', default: 'push', options: LIQUIFY_TOOLS },
    { key: 'brushSize', label: 'Brush Size', type: 'slider', min: 4, max: 1500, step: 1, default: 180, unit: 'px' },
    { key: 'brushPressure', label: 'Brush Pressure', type: 'slider', min: 1, max: 100, step: 1, default: 60 },
    {
      key: 'brushRate', label: 'Brush Rate', type: 'slider', min: 1, max: 100, step: 1, default: 40,
      hint: 'Speed of the tools that keep working while you hold still',
    },
    {
      key: 'brushDensity', label: 'Brush Density', type: 'slider', min: 0, max: 100, step: 1, default: 50,
      hint: 'How far the effect reaches toward the brush edge',
    },
    { key: 'showMesh', label: 'Show Mesh', type: 'checkbox', default: false },
    { key: 'showMask', label: 'Show Frozen Areas', type: 'checkbox', default: true },
    { key: 'mesh', type: 'custom', default: null, render: renderLiquify },

    /*
     * Face-aware sliders. The face is *the region being worked on*: make a
     * selection round a face and these act on it, otherwise they fall back to a
     * portrait-framed guess in the middle of the layer.
     *
     * That is not a detector, and it is not pretending to be one. There is no
     * FaceDetector in this engine and a landmark model is a table of trained
     * coefficients — inventing numbers would give a detector that looks
     * implemented and finds nothing, which is worse than none because the user
     * would blame their photograph. Selecting the face is one gesture and it is
     * honest. See src/filters/face-liquify.js.
     */
    ...FACE_SLIDERS.map((f) => ({
      key: f.key,
      label: f.label,
      type: 'slider',
      min: -100,
      max: 100,
      step: 1,
      default: 0,
      group: f.group,
    })),
  ],
  apply(imageData, p) {
    const brush = p.mesh;
    const mesh = faceParamsAreNeutral(p)
      ? brush
      : applyFaceLiquify(
        faceBoxFor(imageData),
        p,
        imageData.width,
        imageData.height,
        brush && brush.dx ? brush : null,
      );
    if (liquifyMeshIsEmpty(mesh)) return imageData;
    return applyLiquifyMesh(imageData, mesh);
  },
});

/**
 * Where the face is, for the sliders above.
 *
 * `imageData` is already the region being worked on — Liquify operates on the
 * selection when there is one — so a selection *is* the face box. With no
 * selection the whole layer is the region, and a centred portrait frame is the
 * best available starting point.
 */
function faceBoxFor(imageData) {
  const doc = app.activeDoc;
  const selected = doc && doc.selection && doc.selection.active;
  return selected
    ? { x: 0, y: 0, width: imageData.width, height: imageData.height }
    : defaultFaceBox(imageData.width, imageData.height);
}
