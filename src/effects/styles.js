import { createCanvas, cloneCanvas, clamp255, ctx2dRead } from '../core/util.js';
import { toCss, parseColor } from '../core/color.js';
import { gaussianKernel, separableConvolve } from '../filters/registry.js';
import { blurAlphaField } from '../render/fast-blur.js';
import { gcoFor, isNativeBlend, blendCPU } from '../core/blend.js';
import { patternOptions } from '../paint/patterns.js';

/**
 * Layer styles (layer effects).
 *
 * `layer.styles` is an object keyed by effect id. Each value has at least
 * `{enabled: bool}` plus effect-specific fields. Effects render in Photoshop's
 * stacking order: drop shadow (behind) ... content ... stroke (front).
 */

/** Id of the first tile in the pattern library, or null when it is empty. */
function firstPatternId() {
  const opts = patternOptions();
  return opts.length ? opts[0].value : null;
}

export const EFFECT_ORDER_BELOW = ['dropShadow', 'outerGlow'];
export const EFFECT_ORDER_ABOVE = [
  'innerShadow', 'innerGlow', 'satin', 'colorOverlay', 'gradientOverlay', 'patternOverlay', 'bevelEmboss', 'stroke',
];

export const DEFAULT_STYLES = {
  dropShadow: {
    enabled: false, color: '#000000', opacity: 0.75, blendMode: 'multiply',
    angle: 120, useGlobalLight: true, distance: 5, spread: 0, size: 5, noise: 0,
  },
  innerShadow: {
    enabled: false, color: '#000000', opacity: 0.75, blendMode: 'multiply',
    angle: 120, useGlobalLight: true, distance: 5, choke: 0, size: 5, noise: 0,
  },
  outerGlow: {
    enabled: false, color: '#ffe38a', opacity: 0.75, blendMode: 'screen',
    spread: 0, size: 10, noise: 0,
  },
  innerGlow: {
    enabled: false, color: '#ffe38a', opacity: 0.75, blendMode: 'screen',
    choke: 0, size: 10, source: 'edge', noise: 0,
  },
  bevelEmboss: {
    enabled: false, style: 'inner', technique: 'smooth', depth: 1, direction: 'up',
    size: 5, soften: 0, angle: 120, altitude: 30, useGlobalLight: true,
    highlightColor: '#ffffff', highlightOpacity: 0.75, highlightMode: 'screen',
    shadowColor: '#000000', shadowOpacity: 0.75, shadowMode: 'multiply',
  },
  satin: {
    enabled: false, color: '#000000', opacity: 0.5, blendMode: 'multiply',
    angle: 19, distance: 11, size: 14, invert: true,
  },
  colorOverlay: { enabled: false, color: '#ff0000', opacity: 1, blendMode: 'normal' },
  gradientOverlay: {
    enabled: false, opacity: 1, blendMode: 'normal', angle: 90, scale: 1, reverse: false,
    style: 'linear',
    stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }],
  },
  // A pattern effect with no pattern renders nothing, so the default names the
  // first registered tile rather than leaving the effect inert when enabled.
  patternOverlay: { enabled: false, opacity: 1, blendMode: 'normal', scale: 1, patternId: firstPatternId() },
  stroke: {
    enabled: false, size: 3, position: 'outside', blendMode: 'normal', opacity: 1,
    fillType: 'color', color: '#000000',
    stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }], angle: 90,
  },
};

export function defaultStyle(id) {
  return structuredClone(DEFAULT_STYLES[id] || { enabled: false });
}

export function hasStyles(layer) {
  const s = layer.styles;
  if (!s) return false;
  for (const k of Object.keys(s)) if (s[k] && s[k].enabled) return true;
  return false;
}

export function enabledEffects(layer) {
  const s = layer.styles || {};
  return [...EFFECT_ORDER_BELOW, ...EFFECT_ORDER_ABOVE].filter((k) => s[k] && s[k].enabled);
}

/* ------------------------------------------------------------------ */
/* Mask/alpha helpers                                                  */
/* ------------------------------------------------------------------ */

/** Alpha channel of a canvas as a greyscale Float32Array 0..255. */
export function alphaOf(canvas) {
  const w = canvas.width, h = canvas.height;
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const a = new Float32Array(w * h);
  for (let i = 0, p = 0; p < w * h; p++, i += 4) a[p] = d[i + 3];
  return a;
}

/** Turn a Float32 alpha field into a solid-colour RGBA canvas. */
export function alphaToCanvas(alpha, w, h, color) {
  const c = parseColor(color);
  const img = new ImageData(w, h);
  const d = img.data;
  for (let i = 0, p = 0; p < w * h; p++, i += 4) {
    d[i] = c.r; d[i + 1] = c.g; d[i + 2] = c.b; d[i + 3] = clamp255(alpha[p]);
  }
  const cv = createCanvas(w, h);
  cv.getContext('2d').putImageData(img, 0, 0);
  return cv;
}

/**
 * Blur a Float32 alpha field with a Gaussian of the given radius.
 *
 * This runs on every recomposite of a layer with a shadow or glow, so on a
 * large document the JS kernel below dominates frame time. Hand off to the GPU
 * where we can and keep the kernel as the fallback.
 */
export function blurAlpha(alpha, w, h, radius) {
  if (radius <= 0) return alpha;
  return blurAlphaField(alpha, w, h, radius / 2, blurAlphaJS);
}

/** Separable Gaussian on an alpha field — the fallback for `blurAlpha`. */
function blurAlphaJS(alpha, w, h, sigma) {
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) / 2;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += alpha[y * w + Math.min(w - 1, Math.max(0, x + i))] * k[i + r];
      tmp[y * w + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * k[i + r];
      out[y * w + x] = s;
    }
  }
  return out;
}

/**
 * Grow (`amount > 0`) or shrink the alpha field, used for Spread / Choke and
 * for stroke geometry. Chamfer distance transform on the 50% threshold.
 */
export function spreadAlpha(alpha, w, h, amount) {
  if (!amount) return alpha;
  const grow = amount > 0;
  const rad = Math.abs(amount);
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const inside = alpha[i] > 127;
    d[i] = (grow ? inside : !inside) ? 0 : INF;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + 1);
    if (y > 0) v = Math.min(v, d[i - w] + 1);
    if (x > 0 && y > 0) v = Math.min(v, d[i - w - 1] + 1.414);
    if (x < w - 1 && y > 0) v = Math.min(v, d[i - w + 1] + 1.414);
    d[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    let v = d[i];
    if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
    if (y < h - 1) v = Math.min(v, d[i + w] + 1);
    if (x < w - 1 && y < h - 1) v = Math.min(v, d[i + w + 1] + 1.414);
    if (x > 0 && y < h - 1) v = Math.min(v, d[i + w - 1] + 1.414);
    d[i] = v;
  }
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    // Soft 1px edge so the result stays antialiased.
    const t = grow ? rad - d[i] : d[i] - rad;
    out[i] = clamp255((t + 0.5) * 255);
  }
  return out;
}

/** Offset an alpha field by an angle/distance in Photoshop's convention. */
export function offsetAlpha(alpha, w, h, angleDeg, distance) {
  if (!distance) return alpha;
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.round(-Math.cos(rad) * distance);
  const dy = Math.round(Math.sin(rad) * distance);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= w) continue;
      out[y * w + x] = alpha[sy * w + sx];
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Main entry point used by the compositor                             */
/* ------------------------------------------------------------------ */

/**
 * Alpha bounding box, measured on a downscaled copy.
 *
 * A full-resolution scan costs ~140 ms at 12 MP, which defeats the purpose;
 * downscaling by `step` first is a GPU blit and the read is 64x smaller. Any
 * non-empty source block averages to a non-zero alpha, and the result is padded
 * by a whole block, so this never reports a box smaller than the truth.
 */
function alphaBoundsFast(canvas, step = 8) {
  const w = canvas.width, h = canvas.height;
  const sw = Math.max(1, Math.ceil(w / step));
  const sh = Math.max(1, Math.ceil(h / step));
  const small = createCanvas(sw, sh);
  small.getContext('2d').drawImage(canvas, 0, 0, sw, sh);
  const d = ctx2dRead(small).getImageData(0, 0, sw, sh).data;
  let minX = sw, minY = sh, maxX = -1, maxY = -1;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (d[(y * sw + x) * 4 + 3] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return {
    x: Math.max(0, minX * step - step),
    y: Math.max(0, minY * step - step),
    width: Math.min(w, (maxX + 2) * step) - Math.max(0, minX * step - step),
    height: Math.min(h, (maxY + 2) * step) - Math.max(0, minY * step - step),
  };
}

/** How far outside the layer content the enabled effects can reach, in px. */
function effectReach(styles) {
  let reach = 0;
  const s = styles || {};
  const bump = (v) => { if (v > reach) reach = v; };
  if (s.dropShadow && s.dropShadow.enabled) {
    bump((s.dropShadow.distance || 0) + (s.dropShadow.size || 0) + Math.abs(s.dropShadow.spread || 0));
  }
  if (s.outerGlow && s.outerGlow.enabled) bump((s.outerGlow.size || 0) + Math.abs(s.outerGlow.spread || 0));
  if (s.satin && s.satin.enabled) bump((s.satin.distance || 0) + (s.satin.size || 0));
  if (s.stroke && s.stroke.enabled && s.stroke.position !== 'inside') bump(s.stroke.size || 0);
  if (s.bevelEmboss && s.bevelEmboss.enabled && s.bevelEmboss.style !== 'inner') {
    bump((s.bevelEmboss.size || 0) + (s.bevelEmboss.soften || 0));
  }
  return Math.ceil(reach) + 4;
}

/**
 * The sub-rectangle the effect pipeline actually has to touch.
 *
 * Every renderer works on document-sized buffers, so a small logo on a 12 MP
 * canvas used to cost the same as one covering it — a drop shadow ran to nearly
 * two seconds per recomposite. Cropping to the content plus the effects' reach
 * is what Photoshop does and is worth 10-20x here.
 *
 * Returns null when cropping would not pay for itself.
 */
function effectRegion(src, styles, w, h) {
  const b = alphaBoundsFast(src);
  if (!b) return { x: 0, y: 0, w: 1, h: 1 }; // empty layer: nothing can render
  const reach = effectReach(styles);
  const x0 = Math.max(0, Math.floor(b.x - reach));
  const y0 = Math.max(0, Math.floor(b.y - reach));
  const x1 = Math.min(w, Math.ceil(b.x + b.width + reach));
  const y1 = Math.min(h, Math.ceil(b.y + b.height + reach));
  const rw = x1 - x0, rh = y1 - y0;
  if (rw <= 0 || rh <= 0) return { x: 0, y: 0, w: 1, h: 1 };
  if (rw * rh > w * h * 0.6) return null; // covers most of the canvas anyway
  return { x: x0, y: y0, w: rw, h: rh };
}

function cropCanvas(src, r) {
  const out = createCanvas(r.w, r.h);
  out.getContext('2d').drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  return out;
}

/** Build the renderer environment, cropped to the affected region. */
function buildEnv(src, layer, doc, styles, w, h) {
  const region = effectRegion(src, styles, w, h);
  const esrc = region ? cropCanvas(src, region) : src;
  return {
    region,
    env: {
      w: region ? region.w : w,
      h: region ? region.h : h,
      alpha: alphaOf(esrc),
      src: esrc,
      layer,
      doc,
      styles,
      globalLight: doc.globalLight || 120,
      // Where this region sits in the document, for renderers that need it.
      offsetX: region ? region.x : 0,
      offsetY: region ? region.y : 0,
      docW: w,
      docH: h,
    },
  };
}

/**
 * Draw `src` (the layer's raw pixels) plus all enabled effects onto `ctx`.
 *
 * Registered by src/effects/effect-renderers.js — this file only owns the
 * orchestration and the shared alpha maths so the compositor never has a
 * missing import.
 *
 * @param {CanvasRenderingContext2D} ctx  destination, document-sized
 * @param {HTMLCanvasElement} src         layer pixels
 * @param {import('../core/layer.js').Layer} layer
 * @param {import('../core/document.js').PikaDocument} doc
 * @param {number} fillOpacity            applies to content only, not effects
 * @param {{skipBelow?:boolean}} [opts]   `skipBelow` leaves drop shadow / outer
 *        glow out so the caller can blend them against the real backdrop
 */
export function applyLayerStyles(ctx, src, layer, doc, fillOpacity = 1, opts = {}) {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  const styles = layer.styles || {};
  const { region, env } = buildEnv(src, layer, doc, styles, w, h);
  const ox = region ? region.x : 0;
  const oy = region ? region.y : 0;

  if (!opts.skipBelow) {
    for (const id of EFFECT_ORDER_BELOW) {
      const cfg = styles[id];
      if (!cfg || !cfg.enabled) continue;
      const fn = renderers.get(id);
      if (fn) drawEffectResult(ctx, fn(cfg, env), cfg, ox, oy);
    }
  }

  ctx.save();
  ctx.globalAlpha = fillOpacity;
  ctx.drawImage(src, 0, 0);
  ctx.restore();

  for (const id of EFFECT_ORDER_ABOVE) {
    const cfg = styles[id];
    if (!cfg || !cfg.enabled) continue;
    const fn = renderers.get(id);
    if (fn) drawEffectResult(ctx, fn(cfg, env), cfg, ox, oy);
  }
}

/**
 * Render the effects that sit *behind* the layer content.
 *
 * They have to be blended by the compositor against whatever is already on the
 * canvas: rendered into the layer's own pre-blend buffer the destination is
 * empty, and every blend mode would collapse to source-over.
 *
 * @returns {{canvas:HTMLCanvasElement, mode:string, opacity:number}[]}
 */
export function belowEffectResults(src, layer, doc, w, h) {
  const styles = layer.styles || {};
  const out = [];
  let built = null;
  for (const id of EFFECT_ORDER_BELOW) {
    const cfg = styles[id];
    if (!cfg || !cfg.enabled) continue;
    const fn = renderers.get(id);
    if (!fn) continue;
    if (!built) built = buildEnv(src, layer, doc, styles, w, h);
    const canvas = fn(cfg, built.env);
    if (!canvas) continue;
    // The compositor masks and blends these against the document, so hand back
    // a document-sized canvas even though we rendered only the region.
    let full = canvas;
    if (built.region) {
      full = createCanvas(w, h);
      full.getContext('2d').drawImage(canvas, built.region.x, built.region.y);
    }
    out.push({ canvas: full, mode: cfg.blendMode || 'normal', opacity: cfg.opacity == null ? 1 : cfg.opacity });
  }
  return out;
}

function drawEffectResult(ctx, canvas, cfg, ox = 0, oy = 0) {
  if (!canvas) return;
  const opacity = cfg.opacity == null ? 1 : cfg.opacity;
  const mode = cfg.blendMode || 'normal';
  if (!isNativeBlend(mode)) { blendEffectCPU(ctx, canvas, mode, opacity, ox, oy); return; }
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.globalCompositeOperation = gcoFor(mode);
  ctx.drawImage(canvas, ox, oy);
  ctx.restore();
}

/**
 * Canvas2D has no operator for these ten modes, so blend them by hand — but
 * only over the region the effect actually covers.
 */
function blendEffectCPU(ctx, canvas, mode, opacity, ox = 0, oy = 0) {
  if (opacity <= 0) return;
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  const x = Math.max(0, ox), y = Math.max(0, oy);
  const w = Math.min(cw - x, canvas.width - (x - ox));
  const h = Math.min(ch - y, canvas.height - (y - oy));
  if (w < 1 || h < 1) return;
  const base = ctx.getImageData(x, y, w, h);
  const top = ctx2dRead(canvas).getImageData(x - ox, y - oy, w, h);
  blendCPU(base, top, mode, opacity);
  ctx.putImageData(base, x, y);
}

/**
 * Effect renderers: `(cfg, env) => HTMLCanvasElement|null`.
 * Populated by src/effects/effect-renderers.js.
 * @type {Map<string, (cfg:object, env:object)=>HTMLCanvasElement|null>}
 */
export const renderers = new Map();

export function registerEffectRenderer(id, fn) {
  renderers.set(id, fn);
}
