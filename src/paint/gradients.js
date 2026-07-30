import { createCanvas, clamp, deg2rad } from '../core/util.js';
import { parseColor } from '../core/color.js';
import { app } from '../core/app.js';

/**
 * Gradient presets and gradient rasterisation.
 *
 * A gradient is a list of stops `{pos, color, opacity}` where `pos` is 0..1,
 * `color` is any CSS colour *or* one of the dynamic tokens `'foreground'` /
 * `'background'` (resolved against the app colours at render time), and
 * `opacity` is 0..1.
 *
 * `renderGradient(ctx, opts, w, h)` paints into `ctx` covering `w x h`.
 * Linear and radial gradients take the native Canvas2D path unless dithering
 * is requested; angle, reflected and diamond are always rasterised per pixel.
 */

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

const s = (pos, color, opacity) => ({ pos, color, opacity: opacity == null ? 1 : opacity });

/** @type {{id:string,name:string,type:string,stops:{pos:number,color:string,opacity:number}[]}[]} */
export const GRADIENT_PRESETS = [
  {
    id: 'foreground-to-background',
    name: 'Foreground to Background',
    type: 'linear',
    stops: [s(0, 'foreground'), s(1, 'background')],
  },
  {
    id: 'foreground-to-transparent',
    name: 'Foreground to Transparent',
    type: 'linear',
    stops: [s(0, 'foreground', 1), s(1, 'foreground', 0)],
  },
  {
    id: 'black-to-white',
    name: 'Black, White',
    type: 'linear',
    stops: [s(0, '#000000'), s(1, '#ffffff')],
  },
  {
    id: 'white-to-black',
    name: 'White, Black',
    type: 'linear',
    stops: [s(0, '#ffffff'), s(1, '#000000')],
  },
  {
    id: 'chrome',
    name: 'Chrome',
    type: 'linear',
    stops: [
      s(0, '#1d2126'), s(0.12, '#ffffff'), s(0.26, '#6f7d8c'), s(0.38, '#252d36'),
      s(0.5, '#e6edf3'), s(0.62, '#8794a1'), s(0.76, '#f4f8fb'), s(0.88, '#414b56'),
      s(1, '#cfd8e0'),
    ],
  },
  {
    id: 'copper',
    name: 'Copper',
    type: 'linear',
    stops: [
      s(0, '#2b0f06'), s(0.2, '#7a3a17'), s(0.4, '#c9793d'), s(0.55, '#f0b27a'),
      s(0.72, '#b96a30'), s(0.87, '#6d3413'), s(1, '#23100a'),
    ],
  },
  {
    id: 'spectrum',
    name: 'Spectrum',
    type: 'linear',
    stops: [
      s(0, '#ff0000'), s(0.17, '#ffff00'), s(0.33, '#00ff00'), s(0.5, '#00ffff'),
      s(0.67, '#0000ff'), s(0.83, '#ff00ff'), s(1, '#ff0000'),
    ],
  },
  {
    id: 'transparent-rainbow',
    name: 'Transparent Rainbow',
    type: 'linear',
    stops: [
      s(0, '#ff0000', 0), s(0.12, '#ff0000', 1), s(0.28, '#ffe600', 1), s(0.44, '#00d43a', 1),
      s(0.6, '#00c8ff', 1), s(0.76, '#3b1cff', 1), s(0.9, '#ff00c8', 1), s(1, '#ff00c8', 0),
    ],
  },
  {
    id: 'sunrise',
    name: 'Sunrise',
    type: 'linear',
    stops: [
      s(0, '#12123b'), s(0.28, '#6b2d5c'), s(0.55, '#e0552c'), s(0.8, '#ffb86b'), s(1, '#ffeec2'),
    ],
  },
  {
    id: 'ocean',
    name: 'Ocean',
    type: 'linear',
    stops: [s(0, '#001b3a'), s(0.35, '#005f8f'), s(0.7, '#29b5c9'), s(1, '#d8f3f7')],
  },
  {
    id: 'neon',
    name: 'Neon',
    type: 'linear',
    stops: [s(0, '#ff00c8'), s(0.5, '#7a00ff'), s(1, '#00fff0')],
  },
  {
    id: 'pastel',
    name: 'Pastel',
    type: 'linear',
    stops: [s(0, '#ffd6e0'), s(0.33, '#d6f0ff'), s(0.66, '#e6ffd6'), s(1, '#fff3d6')],
  },
  {
    id: 'fire',
    name: 'Fire',
    type: 'linear',
    stops: [s(0, '#000000'), s(0.25, '#7a0f00'), s(0.5, '#ff4d00'), s(0.75, '#ffbe0b'), s(1, '#fff6c2')],
  },
  {
    id: 'ice',
    name: 'Ice',
    type: 'linear',
    stops: [s(0, '#06263f'), s(0.4, '#1f7a99'), s(0.75, '#9fe3f0'), s(1, '#ffffff')],
  },
  {
    id: 'gold',
    name: 'Gold',
    type: 'linear',
    stops: [
      s(0, '#4a2c07'), s(0.22, '#b98a2b'), s(0.42, '#ffe28a'), s(0.6, '#d9a441'),
      s(0.8, '#8a5a12'), s(1, '#ffe9a8'),
    ],
  },
  {
    id: 'silver',
    name: 'Silver',
    type: 'linear',
    stops: [
      s(0, '#4a4f55'), s(0.25, '#c8ced4'), s(0.5, '#7e858c'), s(0.75, '#eef1f4'), s(1, '#6b7278'),
    ],
  },
  {
    id: 'violet-orange',
    name: 'Violet, Orange',
    type: 'linear',
    stops: [s(0, '#6a00ff'), s(1, '#ff8a00')],
  },
  {
    id: 'blue-red-yellow',
    name: 'Blue, Red, Yellow',
    type: 'linear',
    stops: [s(0, '#0033ff'), s(0.5, '#ff0033'), s(1, '#ffee00')],
  },
  {
    id: 'transparent-stripes',
    name: 'Transparent Stripes',
    type: 'linear',
    stops: [
      s(0, 'foreground', 1), s(0.16, 'foreground', 1), s(0.161, 'foreground', 0), s(0.33, 'foreground', 0),
      s(0.331, 'foreground', 1), s(0.49, 'foreground', 1), s(0.491, 'foreground', 0), s(0.66, 'foreground', 0),
      s(0.661, 'foreground', 1), s(0.82, 'foreground', 1), s(0.821, 'foreground', 0), s(1, 'foreground', 0),
    ],
  },
];

/** @param {string} id @returns {object|null} */
export function getGradientPreset(id) {
  return GRADIENT_PRESETS.find((g) => g.id === id) || null;
}

/* ------------------------------------------------------------------ */
/* Stops                                                               */
/* ------------------------------------------------------------------ */

/** Stop positions reach us as 0..1 from tools and 0..100 from PSD-style data. */
function normPos(p) {
  const v = Number(p);
  if (!Number.isFinite(v)) return 0;
  return v > 1 ? v / 100 : v;
}

/**
 * Resolve dynamic colour tokens and normalise a stop list: sorted, at least
 * two entries, colour split into `{r,g,b}` plus a single 0..1 `opacity`.
 * @param {object[]} stops
 * @param {{r,g,b,a}} [fg] overrides app.foreground
 * @param {{r,g,b,a}} [bg] overrides app.background
 */
export function resolveStops(stops, fg, bg) {
  const F = fg || app.foreground || { r: 0, g: 0, b: 0, a: 1 };
  const B = bg || app.background || { r: 255, g: 255, b: 255, a: 1 };
  const out = [];
  for (const st of stops || []) {
    let c;
    if (st.color === 'foreground') c = F;
    else if (st.color === 'background') c = B;
    else c = parseColor(st.color);
    const op = st.opacity == null ? 1 : st.opacity;
    out.push({
      pos: clamp(normPos(st.pos), 0, 1),
      color: { r: c.r, g: c.g, b: c.b },
      opacity: clamp(op * (c.a == null ? 1 : c.a), 0, 1),
    });
  }
  out.sort((a, b) => a.pos - b.pos);
  if (!out.length) out.push({ pos: 0, color: { r: 0, g: 0, b: 0 }, opacity: 1 });
  if (out.length === 1) out.push({ ...out[0], pos: out[0].pos < 1 ? 1 : 0 });
  out.sort((a, b) => a.pos - b.pos);
  return out;
}

/** Mirror a resolved stop list end-for-end. */
export function reverseStops(stops) {
  return stops.map((st) => ({ ...st, pos: 1 - st.pos })).sort((a, b) => a.pos - b.pos);
}

/** Colour at `t` (0..1) as `{r,g,b,a}` with a in 0..1. */
export function sampleStops(stops, t) {
  const list = stops.length && stops[0].color && typeof stops[0].color === 'object' ? stops : resolveStops(stops);
  const x = clamp(t, 0, 1);
  let i = 0;
  while (i < list.length - 2 && x > list[i + 1].pos) i++;
  const a = list[i], b = list[i + 1];
  const span = b.pos - a.pos;
  const k = span <= 1e-6 ? (x >= b.pos ? 1 : 0) : clamp((x - a.pos) / span, 0, 1);
  return {
    r: Math.round(a.color.r + (b.color.r - a.color.r) * k),
    g: Math.round(a.color.g + (b.color.g - a.color.g) * k),
    b: Math.round(a.color.b + (b.color.b - a.color.b) * k),
    a: a.opacity + (b.opacity - a.opacity) * k,
  };
}

/**
 * Float RGBA lookup table (length `n*4`, values 0..255) used by the per-pixel
 * rasteriser. Straight (non-premultiplied) alpha.
 */
export function buildStopLUT(stops, n = 1024) {
  const lut = new Float32Array(n * 4);
  let si = 0;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    while (si < stops.length - 2 && t > stops[si + 1].pos) si++;
    const a = stops[si], b = stops[si + 1];
    const span = b.pos - a.pos;
    const k = span <= 1e-6 ? (t >= b.pos ? 1 : 0) : clamp((t - a.pos) / span, 0, 1);
    const o = i * 4;
    lut[o] = a.color.r + (b.color.r - a.color.r) * k;
    lut[o + 1] = a.color.g + (b.color.g - a.color.g) * k;
    lut[o + 2] = a.color.b + (b.color.b - a.color.b) * k;
    lut[o + 3] = (a.opacity + (b.opacity - a.opacity) * k) * 255;
  }
  return lut;
}

/**
 * Build a native CanvasGradient for the linear and radial cases.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object[]} stops raw or resolved stops
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
 * @param {'linear'|'radial'} [type]
 * @param {boolean} [reverse]
 * @returns {CanvasGradient}
 */
export function stopsToCanvasGradient(ctx, stops, x1, y1, x2, y2, type = 'linear', reverse = false) {
  let list = stops.length && stops[0].color && typeof stops[0].color === 'object' ? stops : resolveStops(stops);
  if (reverse) list = reverseStops(list);
  let g;
  if (type === 'radial') {
    const r = Math.max(1e-3, Math.hypot(x2 - x1, y2 - y1));
    g = ctx.createRadialGradient(x1, y1, 0, x1, y1, r);
  } else {
    g = ctx.createLinearGradient(x1, y1, x2, y2);
  }
  let last = -1;
  for (const st of list) {
    // addColorStop refuses to go backwards; nudge duplicates forward instead.
    const p = clamp(st.pos <= last ? last + 1e-6 : st.pos, 0, 1);
    last = p;
    g.addColorStop(p, `rgba(${Math.round(st.color.r)},${Math.round(st.color.g)},${Math.round(st.color.b)},${st.opacity})`);
  }
  return g;
}

/* ------------------------------------------------------------------ */
/* Rasterisation                                                       */
/* ------------------------------------------------------------------ */

// Ordered 8x8 Bayer matrix — deterministic dithering, no per-frame noise.
const BAYER8 = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

/** Resolve the gradient axis: explicit endpoints, or angle+scale over the box. */
function axisFrom(opts, w, h) {
  if (opts.x1 != null && opts.x2 != null) {
    return { x1: opts.x1, y1: opts.y1 == null ? 0 : opts.y1, x2: opts.x2, y2: opts.y2 == null ? 0 : opts.y2 };
  }
  const a = deg2rad(opts.angle || 0);
  const dx = Math.cos(a), dy = -Math.sin(a);
  const cx = w / 2, cy = h / 2;
  const scale = opts.scale == null ? 1 : Math.max(0.01, opts.scale);
  const len = ((Math.abs(w * dx) + Math.abs(h * dy)) / 2) * scale;
  return { x1: cx - dx * len, y1: cy - dy * len, x2: cx + dx * len, y2: cy + dy * len };
}

/**
 * Paint a gradient over the `w x h` area of `ctx`.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{type?:string, stops:object[], x1?:number, y1?:number, x2?:number, y2?:number,
 *          angle?:number, reverse?:boolean, dither?:boolean, scale?:number, aspect?:number,
 *          foreground?:object, background?:object}} opts
 * @param {number} w @param {number} h
 */
export function renderGradient(ctx, opts, w, h) {
  w = Math.round(w); h = Math.round(h);
  if (w < 1 || h < 1) return;
  const type = opts.type || 'linear';
  let stops = resolveStops(opts.stops && opts.stops.length ? opts.stops : GRADIENT_PRESETS[0].stops, opts.foreground, opts.background);
  if (opts.reverse) stops = reverseStops(stops);
  const ax = axisFrom(opts, w, h);

  // `aspect` squashes the perpendicular axis, which the native gradients
  // cannot express, so it forces the per-pixel path along with dithering.
  const squashed = opts.aspect != null && Math.abs(opts.aspect - 1) > 1e-6;
  if ((type === 'linear' || type === 'radial') && !opts.dither && !squashed) {
    ctx.save();
    ctx.fillStyle = stopsToCanvasGradient(ctx, stops, ax.x1, ax.y1, ax.x2, ax.y2, type, false);
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
    return;
  }

  const tmp = createCanvas(w, h);
  const img = new ImageData(w, h);
  const d = img.data;
  const lut = buildStopLUT(stops, 1024);
  const N = 1023;

  const dx = ax.x2 - ax.x1, dy = ax.y2 - ax.y1;
  const len2 = dx * dx + dy * dy || 1e-6;
  const aspect = opts.aspect == null || opts.aspect === 0 ? 1 : opts.aspect;
  const dither = !!opts.dither;
  const TWO_PI = Math.PI * 2;

  for (let y = 0; y < h; y++) {
    const py = y + 0.5 - ax.y1;
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - ax.x1;
      // u = distance along the axis, v = perpendicular, both in axis units.
      const u = (px * dx + py * dy) / len2;
      const v = ((px * -dy + py * dx) / len2) / aspect;

      let t;
      switch (type) {
        case 'radial': t = Math.sqrt(u * u + v * v); break;
        case 'angle': t = 1 - ((Math.atan2(v, u) / TWO_PI + 1) % 1); break;
        case 'reflected': t = Math.abs(u); break;
        case 'diamond': t = Math.abs(u) + Math.abs(v); break;
        default: t = u; break;
      }
      t = t < 0 ? 0 : t > 1 ? 1 : t;

      const idx = t * N;
      const i0 = idx | 0;
      const i1 = i0 >= N ? N : i0 + 1;
      const k = idx - i0;
      const o0 = i0 * 4, o1 = i1 * 4;
      const dth = dither ? BAYER8[(y & 7) * 8 + (x & 7)] / 64 - 0.5 : 0;
      const o = (y * w + x) * 4;
      d[o] = lut[o0] + (lut[o1] - lut[o0]) * k + dth;
      d[o + 1] = lut[o0 + 1] + (lut[o1 + 1] - lut[o0 + 1]) * k + dth;
      d[o + 2] = lut[o0 + 2] + (lut[o1 + 2] - lut[o0 + 2]) * k + dth;
      d[o + 3] = lut[o0 + 3] + (lut[o1 + 3] - lut[o0 + 3]) * k + dth;
    }
  }
  tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.drawImage(tmp, 0, 0);
}

/**
 * Small left-to-right preview of a stop list over a checkerboard — used by the
 * options bar swatch and the preset picker.
 */
export function gradientPreviewCanvas(stops, w = 120, h = 22, checker = true) {
  const cv = createCanvas(w, h);
  const c = cv.getContext('2d');
  if (checker) {
    const size = 6;
    for (let y = 0; y < h; y += size) {
      for (let x = 0; x < w; x += size) {
        c.fillStyle = ((x / size) | 0) % 2 === ((y / size) | 0) % 2 ? '#8f8f8f' : '#616161';
        c.fillRect(x, y, size, size);
      }
    }
  }
  renderGradient(c, { type: 'linear', stops, x1: 0, y1: 0, x2: w, y2: 0 }, w, h);
  return cv;
}
