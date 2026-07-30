import { createCanvas, cloneCanvas, clamp, deg2rad, ctx2dRead } from '../core/util.js';
import { isNativeBlend, gcoFor, blendCPU } from '../core/blend.js';
import { toCss } from '../core/color.js';

/**
 * Brush engine.
 *
 * Two stroke flavours:
 *
 *   PaintStroke  — accumulates dabs into a stroke buffer, then composites the
 *                  buffer onto the layer once per frame at the stroke opacity.
 *                  This is what gives Photoshop's "opacity caps the stroke,
 *                  flow builds within it" behaviour. Used by brush, pencil,
 *                  eraser, clone/pattern stamp, history brush, colour
 *                  replacement.
 *
 *   EffectStroke — runs a callback per dab directly against the layer pixels,
 *                  masked by the tip. Used by smudge, blur/sharpen, dodge/burn
 *                  and sponge, where the operation depends on what is already
 *                  there.
 *
 * Both share tip generation, spacing, and the dynamics model.
 */

/* ------------------------------------------------------------------ */
/* Brush tips                                                          */
/* ------------------------------------------------------------------ */

const tipCache = new Map();
const TIP_CACHE_MAX = 220;

/**
 * A greyscale-alpha tip stamp. Returned canvas is black with the tip in alpha,
 * so it can be used as a mask or tinted via `source-in`.
 *
 * @param {{size:number, hardness:number, angle:number, roundness:number,
 *          shape?:'round'|'square'|'custom', custom?:HTMLCanvasElement,
 *          antialias?:boolean}} spec
 */
export function makeTip(spec) {
  const size = Math.max(1, Math.round(spec.size));
  const hardness = clamp(spec.hardness == null ? 1 : spec.hardness, 0, 1);
  const angle = spec.angle || 0;
  const roundness = clamp(spec.roundness == null ? 1 : spec.roundness, 0.01, 1);
  const shape = spec.shape || 'round';
  const aa = spec.antialias !== false;

  const key = `${shape}|${size}|${hardness.toFixed(3)}|${angle}|${roundness.toFixed(3)}|${aa}|${spec.customKey || ''}`;
  const hit = tipCache.get(key);
  if (hit) return hit;

  // Enough room for the rotated ellipse.
  const dim = size + 2;
  const cv = createCanvas(dim, dim);
  const c = cv.getContext('2d');
  const cx = dim / 2, cy = dim / 2;

  c.save();
  c.translate(cx, cy);
  if (angle) c.rotate(deg2rad(angle));
  c.scale(1, roundness);

  if (shape === 'custom' && spec.custom) {
    c.drawImage(spec.custom, -size / 2, -size / 2, size, size);
  } else if (shape === 'square') {
    if (hardness >= 1) {
      c.fillStyle = '#000';
      c.fillRect(-size / 2, -size / 2, size, size);
    } else {
      const blur = (1 - hardness) * size * 0.5;
      c.filter = `blur(${blur.toFixed(2)}px)`;
      c.fillStyle = '#000';
      const inset = blur;
      c.fillRect(-size / 2 + inset, -size / 2 + inset, size - inset * 2, size - inset * 2);
      c.filter = 'none';
    }
  } else {
    const r = size / 2;
    if (!aa) {
      // Pencil: hard aliased disc.
      c.restore();
      const img = c.createImageData(dim, dim);
      const d = img.data;
      const rr = r * r;
      for (let y = 0; y < dim; y++) {
        for (let x = 0; x < dim; x++) {
          const dx = x + 0.5 - cx, dy = (y + 0.5 - cy) / roundness;
          const i = (y * dim + x) * 4;
          d[i + 3] = dx * dx + dy * dy <= rr ? 255 : 0;
        }
      }
      c.putImageData(img, 0, 0);
      cacheTip(key, cv);
      return cv;
    }
    if (hardness >= 0.995) {
      c.fillStyle = '#000';
      c.beginPath();
      c.arc(0, 0, r, 0, Math.PI * 2);
      c.fill();
    } else {
      // Photoshop's falloff: solid core out to `hardness`, then a smooth ramp.
      const g = c.createRadialGradient(0, 0, 0, 0, 0, r);
      const core = hardness * 0.92;
      g.addColorStop(0, 'rgba(0,0,0,1)');
      if (core > 0) g.addColorStop(core, 'rgba(0,0,0,1)');
      // Extra stops keep the ramp from banding on very soft brushes.
      const steps = 6;
      for (let i = 1; i < steps; i++) {
        const t = core + ((1 - core) * i) / steps;
        const a = Math.pow(1 - i / steps, 1.35);
        g.addColorStop(t, `rgba(0,0,0,${a.toFixed(4)})`);
      }
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.beginPath();
      c.arc(0, 0, r, 0, Math.PI * 2);
      c.fill();
    }
  }
  c.restore();
  cacheTip(key, cv);
  return cv;
}

function cacheTip(key, cv) {
  if (tipCache.size > TIP_CACHE_MAX) {
    const first = tipCache.keys().next().value;
    tipCache.delete(first);
  }
  tipCache.set(key, cv);
}

export function clearTipCache() {
  tipCache.clear();
}

/* ------------------------------------------------------------------ */
/* Dynamics                                                            */
/* ------------------------------------------------------------------ */

/**
 * @typedef {object} BrushSettings
 * @property {number} size          diameter in px
 * @property {number} hardness      0..1
 * @property {number} opacity       0..1 stroke ceiling
 * @property {number} flow          0..1 per-dab
 * @property {number} spacing       fraction of size between dabs (0.01..10)
 * @property {number} angle         degrees
 * @property {number} roundness     0..1
 * @property {boolean} pressureSize
 * @property {boolean} pressureOpacity
 * @property {number} sizeJitter    0..1
 * @property {number} opacityJitter 0..1
 * @property {number} scatter       0..1 (fraction of size)
 * @property {number} angleJitter   0..1
 * @property {number} smoothing     0..1 stroke smoothing
 * @property {boolean} airbrush     build up while stationary
 * @property {string} shape
 */

export const DEFAULT_BRUSH = {
  size: 30,
  hardness: 0.85,
  opacity: 1,
  flow: 1,
  spacing: 0.08,
  angle: 0,
  roundness: 1,
  pressureSize: true,
  pressureOpacity: false,
  sizeJitter: 0,
  opacityJitter: 0,
  scatter: 0,
  angleJitter: 0,
  smoothing: 0.35,
  airbrush: false,
  shape: 'round',
  antialias: true,
};

/* ------------------------------------------------------------------ */
/* Stroke base                                                         */
/* ------------------------------------------------------------------ */

class StrokeBase {
  /**
   * @param {object} o
   * @param {import('../core/document.js').PikaDocument} o.doc
   * @param {import('../core/layer.js').Layer} o.layer
   * @param {HTMLCanvasElement} o.target  surface receiving paint
   * @param {BrushSettings} o.brush
   */
  constructor(o) {
    this.doc = o.doc;
    this.layer = o.layer;
    this.target = o.target;
    this.brush = { ...DEFAULT_BRUSH, ...o.brush };
    this.selectionClip = o.selectionClip !== false && o.doc.selection.active ? o.doc.selection.toAlphaCanvas() : null;
    this.lockTransparency = !!o.lockTransparency;

    this.lastX = 0;
    this.lastY = 0;
    this.leftover = 0;
    this.started = false;
    this.dabCount = 0;
    this._smoothX = 0;
    this._smoothY = 0;
    this._rnd = mulberry(o.seed || 12345);
    this._airbrushTimer = null;
    this._lastPressure = 1;
    this.dirty = null; // accumulated bounding box of touched pixels
  }

  _rand() {
    return this._rnd();
  }

  _markDirty(x, y, r) {
    // Clipped to the surface: a dab entirely off-canvas touches no pixels, and
    // `dirty === null` is what tells callers the stroke changed nothing.
    const x0 = Math.max(0, Math.floor(x - r - 2)), y0 = Math.max(0, Math.floor(y - r - 2));
    const x1 = Math.min(this.target.width, Math.ceil(x + r + 2));
    const y1 = Math.min(this.target.height, Math.ceil(y + r + 2));
    if (x1 <= x0 || y1 <= y0) return;
    if (!this.dirty) this.dirty = { x0, y0, x1, y1 };
    else {
      if (x0 < this.dirty.x0) this.dirty.x0 = x0;
      if (y0 < this.dirty.y0) this.dirty.y0 = y0;
      if (x1 > this.dirty.x1) this.dirty.x1 = x1;
      if (y1 > this.dirty.y1) this.dirty.y1 = y1;
    }
  }

  /** Per-dab parameters after dynamics. */
  _dabParams(pressure) {
    const b = this.brush;
    let size = b.size;
    if (b.pressureSize) size *= 0.15 + 0.85 * pressure;
    if (b.sizeJitter) size *= 1 - b.sizeJitter * this._rand();
    size = Math.max(0.6, size);

    let alpha = b.flow;
    if (b.pressureOpacity) alpha *= pressure;
    if (b.opacityJitter) alpha *= 1 - b.opacityJitter * this._rand();

    let angle = b.angle;
    if (b.angleJitter) angle += (this._rand() * 2 - 1) * 180 * b.angleJitter;

    return { size, alpha: clamp(alpha, 0, 1), angle };
  }

  _scatterOffset(size) {
    const s = this.brush.scatter;
    if (!s) return { ox: 0, oy: 0 };
    const r = s * size;
    return { ox: (this._rand() * 2 - 1) * r, oy: (this._rand() * 2 - 1) * r };
  }

  /** Walk from the last point to (x,y) emitting dabs at the spacing interval. */
  _walk(x, y, pressure, emit) {
    const b = this.brush;
    const dist = Math.hypot(x - this.lastX, y - this.lastY);
    const step = Math.max(0.5, b.spacing * b.size * (b.pressureSize ? 0.15 + 0.85 * pressure : 1));
    let travelled = -this.leftover;

    if (dist < 1e-6) return;
    let d = travelled;
    while (d + step <= dist) {
      d += step;
      const t = d / dist;
      emit(this.lastX + (x - this.lastX) * t, this.lastY + (y - this.lastY) * t, pressure);
    }
    this.leftover = dist - d;
    this.lastX = x;
    this.lastY = y;
  }

  _smooth(x, y) {
    const s = this.brush.smoothing;
    if (!s) return { x, y };
    const k = 1 - Math.pow(s, 0.4) * 0.82;
    this._smoothX += (x - this._smoothX) * k;
    this._smoothY += (y - this._smoothY) * k;
    return { x: this._smoothX, y: this._smoothY };
  }

  begin(x, y, pressure = 1) {
    this.started = true;
    this.lastX = x;
    this.lastY = y;
    this._smoothX = x;
    this._smoothY = y;
    this.leftover = 0;
    this._lastPressure = pressure;
    this.stamp(x, y, pressure);
    if (this.brush.airbrush) this._startAirbrush();
  }

  move(x, y, pressure = 1) {
    if (!this.started) return;
    const p = this._smooth(x, y);
    this._lastPressure = pressure;
    this._walk(p.x, p.y, pressure, (dx, dy, dp) => this.stamp(dx, dy, dp));
    this._airbrushX = p.x;
    this._airbrushY = p.y;
  }

  end() {
    this.started = false;
    this._stopAirbrush();
  }

  _startAirbrush() {
    this._airbrushX = this.lastX;
    this._airbrushY = this.lastY;
    this._airbrushTimer = setInterval(() => {
      if (!this.started) return;
      this.stamp(this._airbrushX, this._airbrushY, this._lastPressure);
      if (this.onFrame) this.onFrame();
    }, 40);
  }

  _stopAirbrush() {
    if (this._airbrushTimer) {
      clearInterval(this._airbrushTimer);
      this._airbrushTimer = null;
    }
  }

  /** @abstract */
  stamp() {}
}

/* ------------------------------------------------------------------ */
/* PaintStroke                                                         */
/* ------------------------------------------------------------------ */

/**
 * Buffered stroke. Dabs accumulate in `buffer`; `flush()` rebuilds the layer
 * as `base + buffer * opacity`.
 */
export class PaintStroke extends StrokeBase {
  /**
   * @param {object} o
   * @param {'paint'|'erase'} [o.mode]
   * @param {string|object} [o.color]          fill colour for 'paint'
   * @param {HTMLCanvasElement} [o.sourceImage] clone/pattern source, drawn through the tip
   * @param {(x:number,y:number)=>{x:number,y:number}} [o.sourceMap] maps dab centre to source coords
   * @param {string} [o.blendMode] blend mode for compositing the stroke buffer
   */
  constructor(o) {
    super(o);
    this.mode = o.mode || 'paint';
    this.color = o.color || '#000000';
    this.sourceImage = o.sourceImage || null;
    this.sourceMap = o.sourceMap || null;
    this.blendMode = o.blendMode || 'normal';

    this.base = cloneCanvas(this.target);
    this.buffer = createCanvas(this.target.width, this.target.height);
    this.bctx = this.buffer.getContext('2d');
    this._tmp = createCanvas(1, 1);
  }

  stamp(x, y, pressure) {
    const { size, alpha, angle } = this._dabParams(pressure);
    if (alpha <= 0) return;
    const { ox, oy } = this._scatterOffset(size);
    const px = x + ox, py = y + oy;

    const tip = makeTip({
      size,
      hardness: this.brush.hardness,
      angle,
      roundness: this.brush.roundness,
      shape: this.brush.shape,
      custom: this.brush.custom,
      customKey: this.brush.customKey,
      antialias: this.brush.antialias,
    });
    const half = tip.width / 2;
    const dx = px - half, dy = py - half;

    const c = this.bctx;
    c.save();
    c.globalAlpha = alpha;

    if (this.sourceImage) {
      // Draw the source through the tip: tint the tip with the source pixels.
      const t = this._tmp;
      if (t.width !== tip.width || t.height !== tip.height) {
        t.width = tip.width;
        t.height = tip.height;
      }
      const tc = t.getContext('2d');
      tc.clearRect(0, 0, t.width, t.height);
      tc.drawImage(tip, 0, 0);
      tc.globalCompositeOperation = 'source-in';
      const src = this.sourceMap ? this.sourceMap(px, py) : { x: px, y: py };
      tc.drawImage(this.sourceImage, src.x - half, src.y - half, tip.width, tip.height, 0, 0, tip.width, tip.height);
      tc.globalCompositeOperation = 'source-over';
      c.drawImage(t, dx, dy);
    } else {
      const t = this._tmp;
      if (t.width !== tip.width || t.height !== tip.height) {
        t.width = tip.width;
        t.height = tip.height;
      }
      const tc = t.getContext('2d');
      tc.clearRect(0, 0, t.width, t.height);
      tc.drawImage(tip, 0, 0);
      tc.globalCompositeOperation = 'source-in';
      tc.fillStyle = typeof this.color === 'string' ? this.color : toCss(this.color);
      tc.fillRect(0, 0, t.width, t.height);
      tc.globalCompositeOperation = 'source-over';
      c.drawImage(t, dx, dy);
    }

    c.restore();
    this.dabCount++;
    this._markDirty(px, py, size);
  }

  /** The stroke buffer, clipped to the selection and to locked transparency. */
  _clippedBuffer() {
    if (!this.selectionClip && !this.lockTransparency) return this.buffer;
    const paint = createCanvas(this.target.width, this.target.height);
    const pc = paint.getContext('2d');
    pc.drawImage(this.buffer, 0, 0);
    pc.globalCompositeOperation = 'destination-in';
    if (this.selectionClip) pc.drawImage(this.selectionClip, 0, 0);
    if (this.lockTransparency) pc.drawImage(this.base, 0, 0);
    pc.globalCompositeOperation = 'source-over';
    return paint;
  }

  /**
   * Rebuild the layer surface as `base + buffer * opacity`, honouring the
   * stroke's blend mode.
   *
   * Native Canvas2D modes go through `globalCompositeOperation`; the ten it
   * lacks fall back to `blendCPU` over the stroke's dirty rectangle only, so a
   * CPU-mode brush stays interactive on a large document.
   */
  flush() {
    const ctx = this.target.getContext('2d');
    const w = this.target.width, h = this.target.height;
    const paint = this._clippedBuffer();
    const id = this.blendMode;
    const blended = id && id !== 'normal' && this.mode !== 'erase';

    ctx.save();
    ctx.globalCompositeOperation = 'copy';
    ctx.globalAlpha = 1;
    ctx.drawImage(this.base, 0, 0);
    ctx.restore();

    if (!blended || isNativeBlend(id)) {
      ctx.save();
      ctx.globalAlpha = this.brush.opacity;
      ctx.globalCompositeOperation = this.mode === 'erase'
        ? 'destination-out'
        : blended ? gcoFor(id) : 'source-over';
      ctx.drawImage(paint, 0, 0);
      ctx.restore();
      return;
    }

    const dr = this.dirty || { x0: 0, y0: 0, x1: w, y1: h };
    const x0 = clamp(Math.floor(dr.x0), 0, w), y0 = clamp(Math.floor(dr.y0), 0, h);
    const x1 = clamp(Math.ceil(dr.x1), 0, w), y1 = clamp(Math.ceil(dr.y1), 0, h);
    if (x1 <= x0 || y1 <= y0) return;
    const baseData = ctx2dRead(this.base).getImageData(x0, y0, x1 - x0, y1 - y0);
    const topData = ctx2dRead(paint).getImageData(x0, y0, x1 - x0, y1 - y0);
    blendCPU(baseData, topData, id, this.brush.opacity);
    ctx.putImageData(baseData, x0, y0);
  }
}

/* ------------------------------------------------------------------ */
/* EffectStroke                                                        */
/* ------------------------------------------------------------------ */

/**
 * Runs `op(imageData, meta)` for the pixels under each dab, then blends the
 * result back through the tip alpha. Used by smudge / blur / dodge / burn.
 */
export class EffectStroke extends StrokeBase {
  /**
   * @param {object} o
   * @param {(region:ImageData, meta:{x:number,y:number,size:number,strength:number,stroke:EffectStroke})=>ImageData|void} o.op
   * @param {number} [o.strength] 0..1
   */
  constructor(o) {
    super(o);
    this.op = o.op;
    this.strength = o.strength == null ? 0.5 : o.strength;
    this.base = cloneCanvas(this.target);
    this._ctx = this.target.getContext('2d', { willReadFrequently: true });
  }

  stamp(x, y, pressure) {
    const { size, alpha, angle } = this._dabParams(pressure);
    if (alpha <= 0) return;
    const opacityCeil = this.brush.opacity == null ? 1 : this.brush.opacity;
    if (opacityCeil <= 0) return;
    const { ox, oy } = this._scatterOffset(size);
    const px = x + ox, py = y + oy;

    const tip = makeTip({
      size,
      hardness: this.brush.hardness,
      angle,
      roundness: this.brush.roundness,
      shape: this.brush.shape,
      custom: this.brush.custom,
      customKey: this.brush.customKey,
      antialias: this.brush.antialias,
    });
    const dim = tip.width;
    const rx = Math.round(px - dim / 2);
    const ry = Math.round(py - dim / 2);

    const W = this.target.width, H = this.target.height;
    const x0 = Math.max(0, rx), y0 = Math.max(0, ry);
    const x1 = Math.min(W, rx + dim), y1 = Math.min(H, ry + dim);
    if (x1 <= x0 || y1 <= y0) return;
    const rw = x1 - x0, rh = y1 - y0;

    const region = this._ctx.getImageData(x0, y0, rw, rh);
    const original = new ImageData(new Uint8ClampedArray(region.data), rw, rh);

    const res = this.op(region, {
      x: px, y: py, size, strength: this.strength * alpha, stroke: this,
      rectX: x0, rectY: y0, width: rw, height: rh,
    });
    const out = res instanceof ImageData ? res : region;

    // Blend back through tip alpha × selection coverage.
    const tipData = tip.getContext('2d', { willReadFrequently: true }).getImageData(
      x0 - rx, y0 - ry, rw, rh
    ).data;
    const sel = this.doc.selection.active ? this.doc.selection.mask : null;
    const od = original.data, nd = out.data;
    for (let yy = 0; yy < rh; yy++) {
      for (let xx = 0; xx < rw; xx++) {
        const i = (yy * rw + xx) * 4;
        // Coverage is tip alpha x per-dab flow x the stroke's opacity ceiling.
        // Opacity used to be ignored here, so any EffectStroke tool exposing an
        // Opacity slider had to re-apply it inside its own `op`.
        let cov = (tipData[i + 3] / 255) * alpha * opacityCeil;
        if (sel) cov *= sel[(y0 + yy) * W + (x0 + xx)] / 255;
        if (cov <= 0) {
          nd[i] = od[i]; nd[i + 1] = od[i + 1]; nd[i + 2] = od[i + 2]; nd[i + 3] = od[i + 3];
        } else if (cov < 1) {
          nd[i] = od[i] + (nd[i] - od[i]) * cov;
          nd[i + 1] = od[i + 1] + (nd[i + 1] - od[i + 1]) * cov;
          nd[i + 2] = od[i + 2] + (nd[i + 2] - od[i + 2]) * cov;
          nd[i + 3] = od[i + 3] + (nd[i + 3] - od[i + 3]) * cov;
        }
      }
    }
    this._ctx.putImageData(out, x0, y0);
    this.dabCount++;
    this._markDirty(px, py, size);
  }

  flush() {
    // EffectStroke writes straight to the target; nothing to compose.
  }
}

/* ------------------------------------------------------------------ */

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shared option descriptors so every paint tool's options bar matches. */
export function brushOptionDescriptors({ opacity = true, flow = true, smoothing = true, airbrush = true } = {}) {
  const list = [
    { key: 'size', label: 'Size', type: 'slider', min: 1, max: 2500, step: 1, default: 30, unit: 'px' },
    { key: 'hardness', label: 'Hardness', type: 'slider', min: 0, max: 100, step: 1, default: 85, unit: '%' },
  ];
  if (opacity) list.push({ key: 'opacity', label: 'Opacity', type: 'slider', min: 0, max: 100, step: 1, default: 100, unit: '%' });
  if (flow) list.push({ key: 'flow', label: 'Flow', type: 'slider', min: 1, max: 100, step: 1, default: 100, unit: '%' });
  if (smoothing) list.push({ key: 'smoothing', label: 'Smoothing', type: 'slider', min: 0, max: 100, step: 1, default: 20, unit: '%' });
  if (airbrush) list.push({ key: 'airbrush', label: 'Airbrush', type: 'checkbox', default: false });
  return list;
}

/** Convert options-bar state (0..100 ints) into engine settings (0..1). */
export function brushFromOptions(state, extra = {}) {
  return {
    ...DEFAULT_BRUSH,
    size: state.size ?? 30,
    hardness: (state.hardness ?? 85) / 100,
    opacity: (state.opacity ?? 100) / 100,
    flow: (state.flow ?? 100) / 100,
    smoothing: (state.smoothing ?? 20) / 100,
    airbrush: !!state.airbrush,
    spacing: state.spacing != null ? state.spacing / 100 : 0.08,
    angle: state.angle ?? 0,
    roundness: state.roundness != null ? state.roundness / 100 : 1,
    sizeJitter: (state.sizeJitter ?? 0) / 100,
    opacityJitter: (state.opacityJitter ?? 0) / 100,
    scatter: (state.scatter ?? 0) / 100,
    angleJitter: (state.angleJitter ?? 0) / 100,
    ...extra,
  };
}
