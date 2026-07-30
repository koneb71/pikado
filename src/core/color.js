import { clamp, clamp255 } from './util.js';

/**
 * Colour utilities. Internally a colour is `{r,g,b,a}` with r/g/b in 0..255
 * and a in 0..1 — the same shape the tools, swatches and dialogs all pass around.
 */

export function rgb(r, g, b, a = 1) {
  return { r, g, b, a };
}

export function parseColor(input) {
  if (input == null) return rgb(0, 0, 0, 1);
  if (typeof input === 'object') return { r: input.r | 0, g: input.g | 0, b: input.b | 0, a: input.a == null ? 1 : input.a };
  const s = String(input).trim();
  let m = s.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    const h = m[1];
    if (h.length === 3) return rgb(parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16));
    if (h.length === 4)
      return rgb(parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), parseInt(h[3] + h[3], 16) / 255);
    if (h.length === 6) return rgb(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16));
    if (h.length === 8)
      return rgb(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), parseInt(h.slice(6, 8), 16) / 255);
  }
  m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return rgb(p[0] | 0, p[1] | 0, p[2] | 0, p.length > 3 ? p[3] : 1);
  }
  m = s.match(/^hsla?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(/[,\s/%]+/).filter(Boolean).map(Number);
    const c = hsl2rgb(p[0], p[1] / 100, p[2] / 100);
    c.a = p.length > 3 ? p[3] : 1;
    return c;
  }
  // Fall back to the browser's own parser for named colours.
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.fillStyle = '#000';
  cx.fillStyle = s;
  const resolved = cx.fillStyle;
  if (resolved.startsWith('#')) return parseColor(resolved);
  cx.fillRect(0, 0, 1, 1);
  const d = cx.getImageData(0, 0, 1, 1).data;
  return rgb(d[0], d[1], d[2], d[3] / 255);
}

export function toHex(c, withAlpha = false) {
  const h = (n) => clamp255(Math.round(n)).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${withAlpha ? h((c.a == null ? 1 : c.a) * 255) : ''}`;
}

export function toCss(c) {
  const a = c.a == null ? 1 : c.a;
  return a >= 1 ? `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})` : `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${a})`;
}

export function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsv2rgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return rgb(Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255));
}

export function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  let h = 0, s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, l };
}

export function hsl2rgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return rgb(Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255));
}

/** CMYK in 0..1 (naive conversion — no ICC profile). */
export function rgb2cmyk(r, g, b) {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const k = 1 - Math.max(rr, gg, bb);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 1 };
  return { c: (1 - rr - k) / (1 - k), m: (1 - gg - k) / (1 - k), y: (1 - bb - k) / (1 - k), k };
}

export function cmyk2rgb(c, m, y, k) {
  return rgb(Math.round(255 * (1 - c) * (1 - k)), Math.round(255 * (1 - m) * (1 - k)), Math.round(255 * (1 - y) * (1 - k)));
}

/* --- Lab (D65) --- */
function f2(t) { return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; }
export function rgb2lab(r, g, b) {
  let R = r / 255, G = g / 255, B = b / 255;
  R = R > 0.04045 ? ((R + 0.055) / 1.055) ** 2.4 : R / 12.92;
  G = G > 0.04045 ? ((G + 0.055) / 1.055) ** 2.4 : G / 12.92;
  B = B > 0.04045 ? ((B + 0.055) / 1.055) ** 2.4 : B / 12.92;
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const fx = f2(X), fy = f2(Y), fz = f2(Z);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function lab2rgb(l, a, bb) {
  const fy = (l + 16) / 116, fx = fy + a / 500, fz = fy - bb / 200;
  const inv = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
  let R = X * 3.2406 + Y * -1.5372 + Z * -0.4986;
  let G = X * -0.9689 + Y * 1.8758 + Z * 0.0415;
  let B = X * 0.0557 + Y * -0.204 + Z * 1.057;
  const gam = (v) => (v > 0.0031308 ? 1.055 * v ** (1 / 2.4) - 0.055 : 12.92 * v);
  return rgb(clamp255(Math.round(gam(R) * 255)), clamp255(Math.round(gam(G) * 255)), clamp255(Math.round(gam(B) * 255)));
}

export function luminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function colorDistance(a, b) {
  const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

export function mixColors(a, b, t) {
  return rgb(
    Math.round(a.r + (b.r - a.r) * t),
    Math.round(a.g + (b.g - a.g) * t),
    Math.round(a.b + (b.b - a.b) * t),
    (a.a == null ? 1 : a.a) + ((b.a == null ? 1 : b.a) - (a.a == null ? 1 : a.a)) * t
  );
}

export const DEFAULT_SWATCHES = [
  '#000000', '#404040', '#808080', '#c0c0c0', '#ffffff', '#ff0000', '#ff7f00', '#ffff00',
  '#7fff00', '#00ff00', '#00ff7f', '#00ffff', '#007fff', '#0000ff', '#7f00ff', '#ff00ff',
  '#ff007f', '#7f0000', '#7f3f00', '#7f7f00', '#3f7f00', '#007f00', '#007f3f', '#007f7f',
  '#003f7f', '#00007f', '#3f007f', '#7f007f', '#7f003f', '#c08040', '#f0d0a0', '#8b4513',
];
