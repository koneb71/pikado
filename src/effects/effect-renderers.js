import {
  registerEffectRenderer, alphaToCanvas, blurAlpha, spreadAlpha, offsetAlpha,
} from './styles.js';
import { createCanvas, clamp, clamp255, deg2rad } from '../core/util.js';
import { gcoFor, isNativeBlend } from '../core/blend.js';
import { renderGradient, resolveStops, reverseStops, buildStopLUT } from '../paint/gradients.js';
import { getPattern, makeTiledCanvas } from '../paint/patterns.js';

/**
 * The ten layer-effect renderers.
 *
 * Contract (see src/effects/styles.js): `(cfg, env) => canvas|null` where
 * `env = {w, h, alpha, src, layer, doc, styles, globalLight}` and the returned
 * canvas is document sized. `applyLayerStyles` applies `cfg.opacity` and
 * `cfg.blendMode` itself, so nothing here pre-applies them.
 *
 * Everything is computed in Float32 alpha "fields" (0..255) and quantised only
 * when a field is turned into a canvas, so edges stay antialiased throughout.
 */

/* ------------------------------------------------------------------ */
/* Small value helpers                                                 */
/* ------------------------------------------------------------------ */

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * Spread / choke / noise are stored as fractions (0..1) by the Layer Style
 * dialog, but the PSD importer hands them over as raw percentages. Anything
 * above 1 is therefore read as a percentage.
 */
const frac = (v) => {
  const n = num(v, 0);
  return clamp(n > 1 ? n / 100 : n, 0, 1);
};

const DEFAULT_STOPS = [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }];

/* ------------------------------------------------------------------ */
/* Alpha-field maths                                                   */
/* ------------------------------------------------------------------ */
/* Every operation returns a NEW array: the helpers in styles.js return their
   input untouched when a parameter is a no-op, so a field is never safe to
   write into unless we allocated it ourselves.                               */

/** field * (alpha/255) — clip an effect to the layer's own coverage. */
function clipField(f, alpha) {
  const out = new Float32Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = f[i] * (alpha[i] / 255);
  return out;
}

/** field * (1 - alpha/255) — knock the layer's own shape out of an effect. */
function knockOutField(f, alpha) {
  const out = new Float32Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = f[i] * (1 - alpha[i] / 255);
  return out;
}

function invertField(f) {
  const out = new Float32Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = 255 - f[i];
  return out;
}

/** max(0, a - b), keeping fractional coverage. */
function subField(a, b) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const v = a[i] - b[i];
    out[i] = v > 0 ? v : 0;
  }
  return out;
}

/** Deterministic per-pixel hash so noise does not crawl between repaints. */
function hashRandom(i) {
  let x = (i * 374761393 + 668265263) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

function noiseField(f, amount) {
  if (amount <= 0) return f;
  const out = new Float32Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = f[i] * (1 - amount * hashRandom(i));
  return out;
}

/** One separable box-blur pass with clamped edges. */
function boxBlurPass(src, w, h, radius) {
  const r = Math.max(1, Math.round(radius));
  const norm = 1 / (2 * r + 1);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[row + clamp(i, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum * norm;
      sum += src[row + clamp(x + r + 1, 0, w - 1)] - src[row + clamp(x - r, 0, w - 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += tmp[clamp(i, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum * norm;
      sum += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x];
    }
  }
  return out;
}

/**
 * Blur a field. Small radii use the exact Gaussian from styles.js; large ones
 * use three box passes (a Gaussian to within a few percent) because a true
 * 250px Gaussian is ~750 taps per pixel per axis and effects re-render on every
 * composite.
 */
function blurField(f, w, h, radius) {
  if (!(radius > 0.05)) return f;
  if (radius <= 16) return blurAlpha(f, w, h, radius);
  const sigma = radius / 2;
  const boxR = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2));
  let out = f;
  for (let i = 0; i < 3; i++) out = boxBlurPass(out, w, h, boxR);
  return out;
}

/** Two-pass chamfer distance transform (in place). */
function chamfer(d, w, h) {
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
  return d;
}

/**
 * Signed distance to the shape edge in pixels: positive inside, negative
 * outside. Pixels within one pixel of the border take their distance from the
 * coverage value instead, which keeps antialiased edges sub-pixel accurate.
 */
function signedDistance(alpha, w, h) {
  const n = w * h;
  const INF = 1e9;
  const din = new Float32Array(n);
  const dout = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const inside = alpha[i] > 127;
    din[i] = inside ? INF : 0;
    dout[i] = inside ? 0 : INF;
  }
  chamfer(din, w, h);
  chamfer(dout, w, h);
  const sd = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (din[i] <= 1.5 && dout[i] <= 1.5) sd[i] = alpha[i] / 255 - 0.5;
    else sd[i] = din[i] > 0 ? din[i] - 0.5 : 0.5 - dout[i];
  }
  return sd;
}

/**
 * Offset a field with edge clamping rather than zero fill. Inner effects work
 * on the *inverted* matte, where the area outside the canvas is opaque, so a
 * zero-filled shift would punch a hole along the document border.
 */
function offsetFieldClamped(f, w, h, angleDeg, distance) {
  if (!distance) return f;
  const rad = deg2rad(angleDeg);
  const dx = Math.round(-Math.cos(rad) * distance);
  const dy = Math.round(Math.sin(rad) * distance);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = clamp(y - dy, 0, h - 1) * w;
    const row = y * w;
    for (let x = 0; x < w; x++) out[row + x] = f[sy + clamp(x - dx, 0, w - 1)];
  }
  return out;
}

/** Tight bounds of the non-zero part of a field, or the whole canvas. */
function fieldBounds(f, w, h) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (f[row + x] > 0.5) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, width: w, height: h };
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Limit an already-drawn canvas to a coverage field. */
function clipCanvasToField(canvas, field, w, h) {
  const c = canvas.getContext('2d');
  c.save();
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(alphaToCanvas(field, w, h, '#000000'), 0, 0);
  c.restore();
  return canvas;
}

/* ------------------------------------------------------------------ */
/* Gradients                                                           */
/* ------------------------------------------------------------------ */

/**
 * 256-entry lookup table for a stop list, indexed by `t * 255`. Shares the
 * Gradient tool's stop resolver so `'foreground'` / `'background'` tokens and
 * per-stop opacity behave identically here.
 *
 * @param {{pos:number,color:string,opacity?:number}[]} stops
 * @param {boolean} [reverse]
 * @returns {{r:Float32Array,g:Float32Array,b:Float32Array,a:Float32Array}}
 */
export function gradientLUT(stops, reverse = false) {
  let list = resolveStops(Array.isArray(stops) && stops.length ? stops : DEFAULT_STOPS);
  if (reverse) list = reverseStops(list);
  const raw = buildStopLUT(list, 256);
  const r = new Float32Array(256);
  const g = new Float32Array(256);
  const b = new Float32Array(256);
  const a = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const o = i * 4;
    r[i] = raw[o];
    g[i] = raw[o + 1];
    b[i] = raw[o + 2];
    a[i] = raw[o + 3] / 255;
  }
  return { r, g, b, a };
}

/**
 * Endpoints of a gradient axis across a `bw x bh` box, in Photoshop's angle
 * convention (0° = left-to-right, positive counter-clockwise).
 *
 * `renderGradient` treats `(x1,y1)` as the *origin* for every non-linear style
 * — the centre of a radial/diamond gradient, the pivot of an angle gradient,
 * the mirror line of a reflected one — so those get the box centre, while a
 * linear gradient gets an axis spanning the whole box.
 */
function gradientAxis(bw, bh, type, angleDeg, scale) {
  const rad = deg2rad(num(angleDeg, 90));
  const dx = Math.cos(rad);
  const dy = -Math.sin(rad);
  const cx = bw / 2;
  const cy = bh / 2;
  const half = ((Math.abs(dx) * bw + Math.abs(dy) * bh) / 2) * Math.max(0.01, num(scale, 1));
  if (type === 'linear') {
    return { x1: cx - dx * half, y1: cy - dy * half, x2: cx + dx * half, y2: cy + dy * half };
  }
  return { x1: cx, y1: cy, x2: cx + dx * half, y2: cy + dy * half };
}

/**
 * Paint a gradient described by an effect config into a document-sized canvas.
 * `box` is the region the gradient is fitted to (the layer's content bounds
 * when "Align with Layer" is on, otherwise the whole document).
 */
function gradientCanvas(w, h, cfg, box) {
  const bw = Math.max(1, Math.round(box.width));
  const bh = Math.max(1, Math.round(box.height));
  const type = cfg.style || cfg.type || 'linear';
  const tile = createCanvas(bw, bh);
  renderGradient(tile.getContext('2d'), {
    type,
    stops: Array.isArray(cfg.stops) && cfg.stops.length ? cfg.stops : DEFAULT_STOPS,
    angle: num(cfg.angle, 90),
    scale: Math.max(0.01, num(cfg.scale, 1)),
    reverse: !!cfg.reverse,
    ...gradientAxis(bw, bh, type, cfg.angle, cfg.scale),
  }, bw, bh);

  const out = createCanvas(w, h);
  out.getContext('2d').drawImage(tile, Math.round(box.x), Math.round(box.y));
  return out;
}

/* ------------------------------------------------------------------ */
/* Patterns                                                            */
/* ------------------------------------------------------------------ */

/**
 * Document-sized canvas filled with a repeating pattern at `scale`.
 * An unset id means "None"; note `getPattern` substitutes the first pattern for
 * ids it does not know, so the empty case has to be caught before that.
 */
function patternCanvas(patternId, w, h, scale) {
  if (patternId == null || patternId === '') return null;
  return makeTiledCanvas(getPattern(patternId), w, h, Math.max(0.05, num(scale, 1)));
}

/* ------------------------------------------------------------------ */
/* Shared fill of a coverage field                                     */
/* ------------------------------------------------------------------ */

/**
 * Colour a coverage field. `ramp` (optional, 0..1 per pixel) selects the
 * gradient position, used by the glows so the ramp follows the falloff.
 */
function fillField(field, w, h, cfg, ramp) {
  const wantsGradient = cfg.fillType === 'gradient' && Array.isArray(cfg.stops) && cfg.stops.length > 0;
  if (!wantsGradient) return alphaToCanvas(field, w, h, cfg.color || '#000000');

  const lut = gradientLUT(cfg.stops, cfg.reverse);
  const img = new ImageData(w, h);
  const d = img.data;
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    const idx = clamp(Math.round(clamp(ramp ? ramp[p] : 0, 0, 1) * 255), 0, 255);
    d[i] = lut.r[idx];
    d[i + 1] = lut.g[idx];
    d[i + 2] = lut.b[idx];
    d[i + 3] = clamp255(field[p] * lut.a[idx]);
  }
  const cv = createCanvas(w, h);
  cv.getContext('2d').putImageData(img, 0, 0);
  return cv;
}

/* ================================================================== */
/* Drop shadow                                                         */
/* ================================================================== */

registerEffectRenderer('dropShadow', (cfg, env) => {
  const { w, h, alpha } = env;
  const size = Math.max(0, num(cfg.size, 5));
  const spreadPx = size * frac(cfg.spread);
  const angle = cfg.useGlobalLight ? num(env.globalLight, 120) : num(cfg.angle, 120);

  let f = offsetAlpha(alpha, w, h, angle, Math.max(0, num(cfg.distance, 0)));
  if (spreadPx > 0) f = spreadAlpha(f, w, h, spreadPx);
  f = blurField(f, w, h, size - spreadPx);
  f = noiseField(f, frac(cfg.noise));
  // The shadow must not show through semi-transparent layer pixels.
  f = knockOutField(f, alpha);
  return alphaToCanvas(f, w, h, cfg.color || '#000000');
});

/* ================================================================== */
/* Inner shadow                                                        */
/* ================================================================== */

registerEffectRenderer('innerShadow', (cfg, env) => {
  const { w, h, alpha } = env;
  const size = Math.max(0, num(cfg.size, 5));
  const chokePx = size * frac(cfg.choke);
  const angle = cfg.useGlobalLight ? num(env.globalLight, 120) : num(cfg.angle, 120);

  // Shadow cast by the hole around the layer: work on the inverted matte.
  let f = invertField(alpha);
  f = offsetFieldClamped(f, w, h, angle, Math.max(0, num(cfg.distance, 0)));
  if (chokePx > 0) f = spreadAlpha(f, w, h, chokePx);
  f = blurField(f, w, h, size - chokePx);
  f = noiseField(f, frac(cfg.noise));
  f = clipField(f, alpha);
  return alphaToCanvas(f, w, h, cfg.color || '#000000');
});

/* ================================================================== */
/* Outer glow                                                          */
/* ================================================================== */

registerEffectRenderer('outerGlow', (cfg, env) => {
  const { w, h, alpha } = env;
  const size = Math.max(0, num(cfg.size, 10));
  const spreadPx = size * frac(cfg.spread);

  let f = spreadPx > 0 ? spreadAlpha(alpha, w, h, spreadPx) : alpha;
  f = blurField(f, w, h, size - spreadPx);
  const falloff = f;
  f = noiseField(f, frac(cfg.noise));
  f = knockOutField(f, alpha);

  // For a gradient glow the ramp runs outward from the object edge, so the
  // gradient position is the inverse of the remaining glow strength.
  let ramp = null;
  if (cfg.fillType === 'gradient') {
    ramp = new Float32Array(w * h);
    for (let i = 0; i < ramp.length; i++) ramp[i] = 1 - falloff[i] / 255;
  }
  return fillField(f, w, h, cfg, ramp);
});

/* ================================================================== */
/* Inner glow                                                          */
/* ================================================================== */

registerEffectRenderer('innerGlow', (cfg, env) => {
  const { w, h, alpha } = env;
  const size = Math.max(0.5, num(cfg.size, 10));
  const chokePx = size * frac(cfg.choke);
  const span = Math.max(0.001, size - chokePx);
  const sd = signedDistance(alpha, w, h);

  // A blurred inverted matte only reaches 50% right at the edge, which halves
  // an unoffset inner glow — build the falloff from the distance field instead.
  const n = w * h;
  const edge = new Float32Array(n);
  for (let i = 0; i < n; i++) edge[i] = 255 * clamp((size - sd[i]) / span, 0, 1);

  const fromCenter = cfg.source === 'center';
  let f = fromCenter ? invertField(edge) : edge;
  f = blurField(f, w, h, 1);
  f = noiseField(f, frac(cfg.noise));
  const falloff = f;
  f = clipField(f, alpha);

  let ramp = null;
  if (cfg.fillType === 'gradient') {
    ramp = new Float32Array(n);
    for (let i = 0; i < n; i++) ramp[i] = 1 - falloff[i] / 255;
  }
  return fillField(f, w, h, cfg, ramp);
});

/* ================================================================== */
/* Bevel & Emboss                                                      */
/* ================================================================== */

/** PSD names for the bevel styles this renderer does not implement verbatim. */
const BEVEL_STYLE_ALIAS = { pillow: 'pillow-emboss', stroke: 'emboss' };

registerEffectRenderer('bevelEmboss', (cfg, env) => {
  const { w, h, alpha } = env;
  const n = w * h;
  const size = Math.max(1, num(cfg.size, 5));
  const raw = cfg.style || 'inner';
  const style = BEVEL_STYLE_ALIAS[raw] || raw;
  const sd = signedDistance(alpha, w, h);

  // Height field in 0..1. Each style places the ramp differently relative to
  // the shape edge; `sd` is positive inside the shape.
  let height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = sd[i];
    if (style === 'outer') height[i] = clamp(1 + s / size, 0, 1);
    else if (style === 'emboss') height[i] = clamp(0.5 + s / (2 * size), 0, 1);
    else if (style === 'pillow-emboss') height[i] = clamp(Math.abs(s) / size, 0, 1);
    else height[i] = clamp(s / size, 0, 1);
  }

  // Technique shapes the profile: Smooth rounds the whole ramp, Chisel Soft
  // only takes the hard corners off, Chisel Hard stays linear (antialiased).
  const technique = cfg.technique || 'smooth';
  const roundOff = technique === 'smooth' ? size * 0.5
    : technique === 'chisel-soft' ? Math.max(0.6, size * 0.18)
      : 0.5;
  height = blurField(height, w, h, roundOff + Math.max(0, num(cfg.soften, 0)));

  // Surface normals from the height gradient. Scaling by `size` makes Depth
  // independent of Size: depth 1 (100%) is a 45° slope on a linear ramp.
  const depth = Math.max(0, num(cfg.depth, 1)) * size * (cfg.direction === 'down' ? -1 : 1);
  const angle = cfg.useGlobalLight ? num(env.globalLight, 120) : num(cfg.angle, 120);
  const rad = deg2rad(angle);
  const alt = deg2rad(clamp(num(cfg.altitude, 30), 0, 90));
  const lz = Math.sin(alt);
  const lx = Math.cos(rad) * Math.cos(alt);
  const ly = -Math.sin(rad) * Math.cos(alt);

  // Coverage the shading is allowed to appear on.
  const grown = style === 'inner' ? null : spreadAlpha(alpha, w, h, size);
  const mask = style === 'inner' ? alpha : style === 'outer' ? subField(grown, alpha) : grown;

  const hi = new Float32Array(n);
  const sh = new Float32Array(n);
  const hiRange = Math.max(0.001, 1 - lz);
  const shRange = Math.max(0.001, lz);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const up = (y > 0 ? y - 1 : 0) * w;
    const dn = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const m = mask[i];
      if (m <= 0) continue;
      const xl = x > 0 ? x - 1 : 0;
      const xr = x < w - 1 ? x + 1 : w - 1;
      const gx = ((height[row + xr] - height[row + xl]) / 2) * depth;
      const gy = ((height[dn + x] - height[up + x]) / 2) * depth;
      const len = Math.sqrt(gx * gx + gy * gy + 1);
      const ndotl = (-gx * lx - gy * ly + lz) / len;
      const delta = ndotl - lz;
      if (delta > 0) hi[i] = 255 * clamp(delta / hiRange, 0, 1) * (m / 255);
      else sh[i] = 255 * clamp(-delta / shRange, 0, 1) * (m / 255);
    }
  }

  // A renderer may only return one canvas, and `applyLayerStyles` applies a
  // single blend mode to it — but a bevel needs two (highlight and shadow with
  // independent modes). We therefore composite the two halves here with their
  // own modes over transparency and hand back a plain "normal" canvas. Against
  // an empty backdrop multiply/screen degrade to source-over, so the pair reads
  // correctly for the usual white-screen / black-multiply defaults; what is
  // lost is the interaction between each half and the pixels *below* the layer.
  const out = createCanvas(w, h);
  const c = out.getContext('2d');
  drawWithMode(c, alphaToCanvas(sh, w, h, cfg.shadowColor || '#000000'), cfg.shadowMode, num(cfg.shadowOpacity, 0.75));
  drawWithMode(c, alphaToCanvas(hi, w, h, cfg.highlightColor || '#ffffff'), cfg.highlightMode, num(cfg.highlightOpacity, 0.75));
  return out;
});

function drawWithMode(ctx, canvas, mode, opacity) {
  if (opacity <= 0) return;
  ctx.save();
  ctx.globalAlpha = clamp(opacity, 0, 1);
  ctx.globalCompositeOperation = isNativeBlend(mode || 'normal') ? gcoFor(mode || 'normal') : 'source-over';
  ctx.drawImage(canvas, 0, 0);
  ctx.restore();
}

/* ================================================================== */
/* Satin                                                               */
/* ================================================================== */

registerEffectRenderer('satin', (cfg, env) => {
  const { w, h, alpha } = env;
  const angle = num(cfg.angle, 19);
  const distance = Math.max(0, num(cfg.distance, 11));

  const a1 = offsetAlpha(alpha, w, h, angle, distance);
  const a2 = offsetAlpha(alpha, w, h, angle + 180, distance);
  const n = w * h;
  let f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = Math.abs(a1[i] - a2[i]);
  f = blurField(f, w, h, Math.max(0, num(cfg.size, 14)));
  if (cfg.invert) f = invertField(f);
  f = clipField(f, alpha);
  return alphaToCanvas(f, w, h, cfg.color || '#000000');
});

/* ================================================================== */
/* Color overlay                                                       */
/* ================================================================== */

registerEffectRenderer('colorOverlay', (cfg, env) => alphaToCanvas(env.alpha, env.w, env.h, cfg.color || '#ff0000'));

/* ================================================================== */
/* Gradient overlay                                                    */
/* ================================================================== */

registerEffectRenderer('gradientOverlay', (cfg, env) => {
  const { w, h, alpha } = env;
  const box = cfg.alignWithLayer === false ? { x: 0, y: 0, width: w, height: h } : fieldBounds(alpha, w, h);
  return clipCanvasToField(gradientCanvas(w, h, cfg, box), alpha, w, h);
});

/* ================================================================== */
/* Pattern overlay                                                     */
/* ================================================================== */

registerEffectRenderer('patternOverlay', (cfg, env) => {
  const { w, h, alpha } = env;
  const tiled = patternCanvas(cfg.patternId, w, h, num(cfg.scale, 1));
  if (!tiled) return null;
  return clipCanvasToField(tiled, alpha, w, h);
});

/* ================================================================== */
/* Stroke                                                              */
/* ================================================================== */

registerEffectRenderer('stroke', (cfg, env) => {
  const { w, h, alpha } = env;
  const size = Math.max(0, num(cfg.size, 3));
  if (size <= 0) return null;

  let band;
  if (cfg.position === 'inside') {
    band = subField(alpha, spreadAlpha(alpha, w, h, -size));
  } else if (cfg.position === 'center') {
    band = subField(spreadAlpha(alpha, w, h, size / 2), spreadAlpha(alpha, w, h, -size / 2));
  } else {
    band = subField(spreadAlpha(alpha, w, h, size), alpha);
  }

  if (cfg.fillType === 'gradient') {
    const box = cfg.alignWithLayer === false ? { x: 0, y: 0, width: w, height: h } : fieldBounds(band, w, h);
    return clipCanvasToField(gradientCanvas(w, h, cfg, box), band, w, h);
  }
  if (cfg.fillType === 'pattern') {
    const tiled = patternCanvas(cfg.patternId, w, h, num(cfg.patternScale, 1));
    if (!tiled) return null;
    return clipCanvasToField(tiled, band, w, h);
  }
  return alphaToCanvas(band, w, h, cfg.color || '#000000');
});
