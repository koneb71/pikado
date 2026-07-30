import { Tool, registerTool } from './base.js';
import { app } from '../core/app.js';
import { PaintStroke, EffectStroke, brushOptionDescriptors, brushFromOptions } from '../paint/brush-engine.js';
import { BLEND_MODES, isNativeBlend, gcoFor, blendCPU } from '../core/blend.js';
import { getComposite } from '../render/compositor.js';
import { createCanvas, ctx2dRead, clamp, clamp255 } from '../core/util.js';
import { rgb, rgb2hsl, hsl2rgb, toCss, luminance, colorDistance } from '../core/color.js';
import { OVERLAY } from '../ui/brand.js';
import { cmd, sep } from '../ui/canvas-menu.js';

/**
 * Painting tools: Brush, Pencil, Colour Replacement, Mixer Brush.
 *
 * This module also owns the pieces every other brush-like tool file shares —
 * `BrushToolBase` (cursor ring, bracket-key size/hardness, stroke lifecycle),
 * `BlendPaintStroke` (a PaintStroke that honours a blend mode) and a couple of
 * small pixel helpers.
 */

/* ================================================================== */
/* Shared helpers                                                      */
/* ================================================================== */

/** Photoshop-ish size stepping for the `[` / `]` keys. */
function sizeStep(size, up) {
  const s = up ? size : size - 1;
  if (s < 10) return 1;
  if (s < 50) return 5;
  if (s < 100) return 10;
  if (s < 200) return 25;
  if (s < 500) return 50;
  return 100;
}

/* ------------------------------------------------------------------ */
/* The right-click brush picker                                        */
/* ------------------------------------------------------------------ */

/**
 * Right-clicking with a paint tool opens Photoshop's brush preset picker. The
 * flat-menu equivalent is a short ladder of tip sizes and hardnesses, followed
 * by the layer/edit entries that are worth reaching for mid-stroke.
 */
const SIZE_PRESETS = [1, 4, 12, 30, 80, 200];
const HARDNESS_PRESETS = [0, 50, 100];

/** Is `key` an option the tool is actually showing right now? */
function optionShown(tool, key) {
  const d = (tool.options || []).find((o) => o.key === key);
  if (!d) return false;
  if (typeof d.when === 'function') {
    try {
      if (!d.when(tool.state)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Size / hardness preset rows for a brush-driven tool. */
export function brushPresetItems(tool) {
  const items = [];
  if (optionShown(tool, 'size')) {
    const cur = Math.round(tool.state.size);
    items.push({ header: 'Brush Size' });
    for (const px of SIZE_PRESETS) {
      items.push({
        label: `${px} px`,
        checked: cur === px,
        run: () => {
          tool.setOption('size', px);
          app.requestRender();
        },
      });
    }
  }
  if (optionShown(tool, 'hardness')) {
    const cur = Math.round(tool.state.hardness);
    items.push({ header: 'Hardness' });
    for (const pct of HARDNESS_PRESETS) {
      items.push({
        label: `${pct}%`,
        checked: cur === pct,
        run: () => {
          tool.setOption('hardness', pct);
          app.requestRender();
        },
      });
    }
  }
  return items;
}

/**
 * The whole canvas menu for a brush-driven tool: the preset picker, then any
 * tool-specific rows (a clone source to reset, a mixer brush to clean), then
 * the layer and edit entries that make sense while painting.
 *
 * @param {Tool} tool
 * @param {Array<object>} [extra] rows inserted after the presets
 */
export function brushContextMenu(tool, extra = []) {
  return [
    ...brushPresetItems(tool),
    sep(),
    ...extra,
    sep(),
    cmd('layer.new', { label: 'New Layer' }),
    cmd('edit.fill'),
    sep(),
    cmd('edit.undo'),
  ];
}

/** Clone a descriptor list with different defaults. */
export function tweakDefaults(descriptors, overrides) {
  return descriptors.map((d) => (d.key in overrides ? { ...d, default: overrides[d.key] } : d));
}

/** Single-pixel sample from a canvas, or null when out of bounds. */
export function samplePixel(canvas, x, y) {
  const px = Math.floor(x), py = Math.floor(y);
  if (!canvas || px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return null;
  const d = ctx2dRead(canvas).getImageData(px, py, 1, 1).data;
  return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
}

function gaussKernel(sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(r * 2 + 1);
  const s2 = 2 * sigma * sigma;
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / s2);
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/**
 * Separable Gaussian blur of an ImageData. Alpha-correct (premultiplies
 * first) and non-destructive — returns a new ImageData.
 *
 * @param {ImageData} img
 * @param {number} sigma
 * @returns {ImageData}
 */
export function blurImageData(img, sigma) {
  const w = img.width, h = img.height, d = img.data;
  const out = new ImageData(new Uint8ClampedArray(d), w, h);
  if (sigma <= 0.06) return out;
  const k = gaussKernel(sigma);
  const kr = (k.length - 1) / 2;

  const a = new Float32Array(w * h * 4);
  for (let i = 0; i < d.length; i += 4) {
    const al = d[i + 3] / 255;
    a[i] = d[i] * al;
    a[i + 1] = d[i + 1] * al;
    a[i + 2] = d[i + 2] * al;
    a[i + 3] = d[i + 3];
  }
  const b = new Float32Array(w * h * 4);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, bl = 0, al = 0;
      for (let t = -kr; t <= kr; t++) {
        const sx = clamp(x + t, 0, w - 1);
        const i = (row + sx) * 4;
        const wt = k[t + kr];
        r += a[i] * wt; g += a[i + 1] * wt; bl += a[i + 2] * wt; al += a[i + 3] * wt;
      }
      const o = (row + x) * 4;
      b[o] = r; b[o + 1] = g; b[o + 2] = bl; b[o + 3] = al;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, bl = 0, al = 0;
      for (let t = -kr; t <= kr; t++) {
        const sy = clamp(y + t, 0, h - 1);
        const i = (sy * w + x) * 4;
        const wt = k[t + kr];
        r += b[i] * wt; g += b[i + 1] * wt; bl += b[i + 2] * wt; al += b[i + 3] * wt;
      }
      const o = (y * w + x) * 4;
      const alpha = al / 255;
      out.data[o] = alpha > 0.0001 ? clamp255(r / alpha) : 0;
      out.data[o + 1] = alpha > 0.0001 ? clamp255(g / alpha) : 0;
      out.data[o + 2] = alpha > 0.0001 ? clamp255(bl / alpha) : 0;
      out.data[o + 3] = clamp255(al);
    }
  }
  return out;
}

/** Foreground colour flattened to grey — what painting into a mask means. */
function paintColorFor(layer, color) {
  if (!layer.editingMask) return toCss(color);
  const v = Math.round(luminance(color.r, color.g, color.b) * (color.a == null ? 1 : color.a));
  return `rgb(${v},${v},${v})`;
}

/* ================================================================== */
/* BlendPaintStroke                                                    */
/* ================================================================== */

/**
 * A PaintStroke that composites its buffer with a blend mode instead of plain
 * source-over. Native Canvas2D modes go through `globalCompositeOperation`;
 * the rest fall back to `blendCPU` over the stroke's dirty rectangle.
 */
export class BlendPaintStroke extends PaintStroke {
  flush() {
    const id = this.blendMode;
    if (!id || id === 'normal' || this.mode === 'erase') return super.flush();

    const w = this.target.width, h = this.target.height;
    let paint = this.buffer;
    if (this.selectionClip || this.lockTransparency) {
      paint = createCanvas(w, h);
      const pc = paint.getContext('2d');
      pc.drawImage(this.buffer, 0, 0);
      pc.globalCompositeOperation = 'destination-in';
      if (this.selectionClip) pc.drawImage(this.selectionClip, 0, 0);
      if (this.lockTransparency) pc.drawImage(this.base, 0, 0);
      pc.globalCompositeOperation = 'source-over';
    }

    const ctx = this.target.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = 'copy';
    ctx.globalAlpha = 1;
    ctx.drawImage(this.base, 0, 0);
    ctx.restore();

    if (isNativeBlend(id)) {
      ctx.save();
      ctx.globalAlpha = this.brush.opacity;
      ctx.globalCompositeOperation = gcoFor(id);
      ctx.drawImage(paint, 0, 0);
      ctx.restore();
      return;
    }

    // CPU modes: only the touched rectangle needs recomputing.
    const dr = this.dirty || { x0: 0, y0: 0, x1: w, y1: h };
    const x0 = clamp(Math.floor(dr.x0), 0, w), y0 = clamp(Math.floor(dr.y0), 0, h);
    const x1 = clamp(Math.ceil(dr.x1), 0, w), y1 = clamp(Math.ceil(dr.y1), 0, h);
    if (x1 <= x0 || y1 <= y0) return;
    const rw = x1 - x0, rh = y1 - y0;
    const baseData = ctx2dRead(this.base).getImageData(x0, y0, rw, rh);
    const topData = ctx2dRead(paint).getImageData(x0, y0, rw, rh);
    blendCPU(baseData, topData, id, this.brush.opacity);
    ctx.putImageData(baseData, x0, y0);
  }
}

/* ================================================================== */
/* BrushToolBase                                                       */
/* ================================================================== */

/**
 * Base for every brush-driven tool: tracks the cursor for the size ring,
 * handles `[` / `]` (size) and Shift+`[` / Shift+`]` (hardness), and runs the
 * beginEdit → flush/touch → commit stroke lifecycle.
 *
 * Subclasses implement `makeStroke(e, doc, layer)` and may override
 * `beforeStroke` to veto a stroke.
 */
export class BrushToolBase extends Tool {
  constructor(opts) {
    super(opts);
    // Nothing calls Tool#init before the first event, so bind the singleton now.
    this.app = app;
    this.strokeLabel = opts.strokeLabel || opts.name || 'Paint';
    this.cursorPos = null;
    this.stroke = null;
    this.strokeDoc = null;
    this.strokeLayer = null;
    this._offCursor = null;
  }

  onActivate() {
    if (this._offCursor) return;
    this._offCursor = app.on('cursor-move', (e) => {
      this.cursorPos = { sx: e.sx, sy: e.sy, x: e.x, y: e.y };
      app.requestRender();
    });
  }

  onDeactivate() {
    if (this._offCursor) {
      this._offCursor();
      this._offCursor = null;
    }
    this.cancel();
    this.cursorPos = null;
  }

  /* -------- stroke lifecycle ------------------------------------- */

  /** @returns {import('../paint/brush-engine.js').PaintStroke|null} */
  makeStroke(e, doc, layer) { // eslint-disable-line no-unused-vars
    return null;
  }

  /** Return false to abort before any pixels are touched. */
  beforeStroke(e, doc, layer) { // eslint-disable-line no-unused-vars
    return true;
  }

  onPointerDown(e) {
    if (e.button !== 0) return;
    if (!this.canPaint()) return;
    const doc = this.doc;
    const layer = doc.activeLayer();
    if (this.beforeStroke(e, doc, layer) === false) return;
    doc.beginEdit(layer);
    let stroke = null;
    try {
      stroke = this.makeStroke(e, doc, layer);
    } catch (err) {
      console.error('[brush]', err);
    }
    if (!stroke) return;
    this.stroke = stroke;
    this.strokeDoc = doc;
    this.strokeLayer = layer;
    stroke.onFrame = () => this._paintFrame();
    stroke.begin(e.x, e.y, e.pressure);
    this._paintFrame();
  }

  onPointerMove(e) {
    if (!this.stroke) return;
    this.stroke.move(e.x, e.y, e.pressure);
    this._paintFrame();
  }

  onPointerUp() {
    if (!this.stroke) return;
    const stroke = this.stroke;
    const doc = this.strokeDoc;
    this.stroke = null;
    stroke.end();
    stroke.flush();
    if (this.strokeLayer && this.strokeLayer.editingMask) this.strokeLayer.touchMask();
    this.afterStroke(stroke, doc, this.strokeLayer);
    // A stroke that never stamped a dab (every dab fell outside the canvas)
    // must not push an empty step onto the undo stack.
    if (stroke.dirty) doc.commit(this.strokeLabel);
    else doc.touch();
    this.strokeDoc = null;
    this.strokeLayer = null;
  }

  afterStroke() {}

  _paintFrame() {
    if (!this.stroke) return;
    this.stroke.flush();
    if (this.strokeLayer && this.strokeLayer.editingMask) this.strokeLayer.touchMask();
    this.strokeDoc.touch();
  }

  commit() {
    if (this.stroke) this.onPointerUp();
  }

  cancel() {
    if (!this.stroke) return;
    const stroke = this.stroke;
    this.stroke = null;
    stroke.end();
    const ctx = stroke.target.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = 'copy';
    ctx.globalAlpha = 1;
    ctx.drawImage(stroke.base, 0, 0);
    ctx.restore();
    if (this.strokeLayer && this.strokeLayer.editingMask) this.strokeLayer.touchMask();
    if (this.strokeDoc) this.strokeDoc.touch();
    this.strokeDoc = null;
    this.strokeLayer = null;
  }

  /* -------- keyboard --------------------------------------------- */

  onKeyDown(e) {
    const k = e.key;
    if (k !== '[' && k !== ']' && k !== '{' && k !== '}') return false;
    const up = k === ']' || k === '}';
    const hardness = e.shiftKey || k === '{' || k === '}';
    if (hardness) {
      if (!('hardness' in this.state)) return false;
      const v = clamp(Math.round((this.state.hardness || 0) + (up ? 10 : -10)), 0, 100);
      if (v !== this.state.hardness) this.setOption('hardness', v);
      return true;
    }
    if (!('size' in this.state)) return false;
    const cur = this.state.size || 1;
    const v = clamp(Math.round(cur + (up ? sizeStep(cur, true) : -sizeStep(cur, false))), 1, 2500);
    if (v !== cur) this.setOption('size', v);
    app.requestRender();
    return true;
  }

  /* -------- context menu ----------------------------------------- */

  /**
   * Every brush-driven tool offers the preset picker. Tools with a sampled
   * source override this and pass their own rows through `extra`.
   */
  contextMenu() {
    return brushContextMenu(this);
  }

  /* -------- overlay ---------------------------------------------- */

  /** Diameter of the ring, in document pixels. Overridden by the block eraser. */
  cursorDiameter() {
    return this.state.size || 1;
  }

  cursorShape() {
    return 'round';
  }

  drawOverlay(ctx, view) {
    this.drawBrushCursor(ctx, view);
  }

  /** Screen-space brush outline at the cursor. */
  drawBrushCursor(ctx, view, opts = {}) {
    const p = this.cursorPos;
    if (!p) return;
    const size = opts.size == null ? this.cursorDiameter() : opts.size;
    const shape = opts.shape || this.cursorShape();
    const r = (size / 2) * view.scale;
    ctx.save();
    ctx.lineWidth = 1;
    if (r >= 1.5 && r < 4000) {
      const outline = (rad, css) => {
        ctx.beginPath();
        if (shape === 'square') ctx.rect(p.sx - rad, p.sy - rad, rad * 2, rad * 2);
        else ctx.arc(p.sx, p.sy, rad, 0, Math.PI * 2);
        ctx.strokeStyle = css;
        ctx.stroke();
      };
      outline(r + 0.5, 'rgba(255,255,255,.75)');
      outline(r - 0.5, 'rgba(0,0,0,.8)');
    } else {
      ctx.strokeStyle = 'rgba(0,0,0,.8)';
      ctx.beginPath();
      ctx.moveTo(p.sx - 5, p.sy);
      ctx.lineTo(p.sx + 5, p.sy);
      ctx.moveTo(p.sx, p.sy - 5);
      ctx.lineTo(p.sx, p.sy + 5);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Little crosshair marker, used for clone/heal source points. */
  drawCrosshair(ctx, view, docX, docY, css = OVERLAY.accent) {
    const p = view.toScreen(docX, docY);
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = css;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5.5, 0, Math.PI * 2);
    ctx.moveTo(p.x - 9, p.y);
    ctx.lineTo(p.x - 2, p.y);
    ctx.moveTo(p.x + 2, p.y);
    ctx.lineTo(p.x + 9, p.y);
    ctx.moveTo(p.x, p.y - 9);
    ctx.lineTo(p.x, p.y - 2);
    ctx.moveTo(p.x, p.y + 2);
    ctx.lineTo(p.x, p.y + 9);
    ctx.stroke();
    ctx.restore();
  }

  /** Alt-click eyedropper shared by the paint tools. */
  pickForeground(e) {
    const doc = this.doc;
    if (!doc) return;
    const c = samplePixel(getComposite(doc), e.x, e.y);
    if (!c) return;
    app.setForeground(rgb(c.r, c.g, c.b, 1));
  }
}

/* ================================================================== */
/* Brush                                                               */
/* ================================================================== */

const BLEND_OPTIONS = BLEND_MODES.map((m) => ({ value: m.id, label: m.name }));

/** Insert the blend-mode select right after the tip controls (size/hardness). */
function withBlendMode(list) {
  const mode = { key: 'blendMode', label: 'Mode', type: 'select', options: BLEND_OPTIONS, default: 'normal' };
  let at = 0;
  while (at < list.length && (list[at].key === 'size' || list[at].key === 'hardness')) at++;
  return [...list.slice(0, at), mode, ...list.slice(at)];
}

class BrushTool extends BrushToolBase {
  constructor() {
    super({
      id: 'brush', name: 'Brush Tool', icon: 'brush', cursor: 'crosshair', shortcut: 'B',
      group: 'brush', groupOrder: 7,
      strokeLabel: 'Brush',
      options: withBlendMode(brushOptionDescriptors()),
    });
  }

  onPointerDown(e) {
    // Alt turns the brush into a temporary eyedropper, as in Photoshop.
    if (e.button === 0 && e.altKey) {
      this.pickForeground(e);
      return;
    }
    super.onPointerDown(e);
  }

  getCursor() {
    return 'crosshair';
  }

  makeStroke(e, doc, layer) {
    return new BlendPaintStroke({
      doc,
      layer,
      target: layer.paintTarget(),
      brush: brushFromOptions(this.state),
      mode: 'paint',
      color: paintColorFor(layer, app.foreground),
      blendMode: layer.editingMask ? 'normal' : this.state.blendMode,
      lockTransparency: !!layer.locked.transparency && !layer.editingMask,
    });
  }
}

registerTool(new BrushTool());

/* ================================================================== */
/* Pencil                                                              */
/* ================================================================== */

class PencilTool extends BrushToolBase {
  constructor() {
    super({
      id: 'pencil', name: 'Pencil Tool', icon: 'pencil', cursor: 'crosshair', shortcut: 'B',
      group: 'brush', groupOrder: 7,
      strokeLabel: 'Pencil',
      options: [
        ...withBlendMode(tweakDefaults(brushOptionDescriptors().filter((d) => d.key !== 'hardness'), { size: 4, smoothing: 0 })),
        { key: 'autoErase', label: 'Auto Erase', type: 'checkbox', default: false,
          hint: 'Paint the background colour over foreground-coloured pixels' },
      ],
    });
  }

  onPointerDown(e) {
    if (e.button === 0 && e.altKey) {
      this.pickForeground(e);
      return;
    }
    super.onPointerDown(e);
  }

  makeStroke(e, doc, layer) {
    let color = app.foreground;
    if (this.state.autoErase) {
      const px = samplePixel(layer.paintTarget(), e.x, e.y);
      // "Starts on foreground" means the pixel already carries the paint colour.
      if (px && px.a > 0.5 && colorDistance(px, app.foreground) < 24) color = app.background;
    }
    return new BlendPaintStroke({
      doc,
      layer,
      target: layer.paintTarget(),
      // A pencil is a hard aliased tip: no antialiasing, no falloff.
      brush: brushFromOptions(this.state, { hardness: 1, antialias: false, spacing: 0.05 }),
      mode: 'paint',
      color: paintColorFor(layer, color),
      blendMode: layer.editingMask ? 'normal' : this.state.blendMode,
      lockTransparency: !!layer.locked.transparency && !layer.editingMask,
    });
  }
}

registerTool(new PencilTool());

/* ================================================================== */
/* Colour Replacement                                                  */
/* ================================================================== */

const LIMIT_OPTIONS = [
  { value: 'discontiguous', label: 'Discontiguous' },
  { value: 'contiguous', label: 'Contiguous' },
  { value: 'find-edges', label: 'Find Edges' },
];

/**
 * Grow a match mask out from the dab centre, optionally refusing to cross
 * strong luminance edges. Returns the connected subset of `match`.
 */
function connectedMatch(match, w, h, sx, sy, lum, edgeStop) {
  const out = new Float32Array(w * h);
  const start = sy * w + sx;
  if (match[start] <= 0) return out;
  const stack = [start];
  const seen = new Uint8Array(w * h);
  seen[start] = 1;
  out[start] = match[start];
  while (stack.length) {
    const p = stack.pop();
    const x = p % w, y = (p - x) / w;
    for (let k = 0; k < 4; k++) {
      const nx = x + (k === 0 ? -1 : k === 1 ? 1 : 0);
      const ny = y + (k === 2 ? -1 : k === 3 ? 1 : 0);
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const q = ny * w + nx;
      if (seen[q]) continue;
      if (match[q] <= 0) continue;
      if (edgeStop > 0 && Math.abs(lum[q] - lum[p]) > edgeStop) continue;
      seen[q] = 1;
      out[q] = match[q];
      stack.push(q);
    }
  }
  return out;
}

/**
 * Per-pixel 0..1 "how well does this match the reference colour" mask for a
 * dab region, honouring the Discontiguous / Contiguous / Find Edges limits.
 *
 * @param {ImageData} region
 * @param {{x:number,y:number,rectX:number,rectY:number}} meta
 * @param {{ref:?{r:number,g:number,b:number}, tol:number, limits:string}} cfg
 * @returns {Float32Array}
 */
export function buildMatchMask(region, meta, cfg) {
  const w = region.width, h = region.height, d = region.data;
  const cx = clamp(Math.round(meta.x) - meta.rectX, 0, w - 1);
  const cy = clamp(Math.round(meta.y) - meta.rectY, 0, h - 1);
  const ci = (cy * w + cx) * 4;
  const ref = cfg.ref || { r: d[ci], g: d[ci + 1], b: d[ci + 2] };
  const tol = Math.max(1, cfg.tol);

  const match = new Float32Array(w * h);
  const lum = cfg.limits === 'discontiguous' ? null : new Float32Array(w * h);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    const dr = Math.abs(d[i] - ref.r), dg = Math.abs(d[i + 1] - ref.g), db = Math.abs(d[i + 2] - ref.b);
    const dist = Math.max(dr, dg, db);
    if (lum) lum[p] = luminance(d[i], d[i + 1], d[i + 2]);
    if (d[i + 3] === 0) continue;
    if (dist >= tol) continue;
    const t = 1 - dist / tol;
    match[p] = t * t * (3 - 2 * t); // smoothstep keeps the edge from crawling
  }
  if (cfg.limits === 'discontiguous') return match;
  return connectedMatch(match, w, h, cx, cy, lum, cfg.limits === 'find-edges' ? 22 : 0);
}

class ColorReplaceTool extends BrushToolBase {
  constructor() {
    super({
      id: 'color-replace', name: 'Color Replacement Tool', icon: 'color-replace',
      cursor: 'crosshair', shortcut: 'B', group: 'brush', groupOrder: 7,
      strokeLabel: 'Color Replacement',
      options: [
        ...tweakDefaults(brushOptionDescriptors({ opacity: false, airbrush: false }), { size: 24 }),
        { key: 'mode', label: 'Mode', type: 'select', default: 'color',
          options: [
            { value: 'hue', label: 'Hue' },
            { value: 'saturation', label: 'Saturation' },
            { value: 'color', label: 'Color' },
            { value: 'luminosity', label: 'Luminosity' },
          ] },
        { key: 'sampling', label: 'Sampling', type: 'select', default: 'continuous',
          options: [
            { value: 'continuous', label: 'Continuous' },
            { value: 'once', label: 'Once' },
            { value: 'background', label: 'Background Swatch' },
          ] },
        { key: 'limits', label: 'Limits', type: 'select', options: LIMIT_OPTIONS, default: 'contiguous' },
        { key: 'tolerance', label: 'Tolerance', type: 'slider', min: 1, max: 100, step: 1, default: 30, unit: '%' },
      ],
    });
  }

  onPointerDown(e) {
    if (e.button === 0 && e.altKey) {
      this.pickForeground(e);
      return;
    }
    super.onPointerDown(e);
  }

  makeStroke(e, doc, layer) {
    const target = layer.paintTarget();
    const fg = app.foreground;
    const fgHsl = rgb2hsl(fg.r, fg.g, fg.b);
    const mode = this.state.mode;
    const tol = (this.state.tolerance / 100) * 255;
    const limits = this.state.limits;

    let ref = null;
    if (this.state.sampling === 'once') {
      const px = samplePixel(target, e.x, e.y);
      ref = px ? { r: px.r, g: px.g, b: px.b } : null;
    } else if (this.state.sampling === 'background') {
      ref = { r: app.background.r, g: app.background.g, b: app.background.b };
    }

    return new EffectStroke({
      doc,
      layer,
      target,
      brush: brushFromOptions(this.state),
      strength: 1,
      op: (region, meta) => {
        const match = buildMatchMask(region, meta, { ref, tol, limits });
        const d = region.data;
        for (let p = 0, i = 0; p < region.width * region.height; p++, i += 4) {
          const m = match[p];
          if (m <= 0) continue;
          const hsl = rgb2hsl(d[i], d[i + 1], d[i + 2]);
          let rep;
          if (mode === 'hue') rep = hsl2rgb(fgHsl.h, hsl.s, hsl.l);
          else if (mode === 'saturation') rep = hsl2rgb(hsl.h, fgHsl.s, hsl.l);
          else if (mode === 'luminosity') rep = hsl2rgb(hsl.h, hsl.s, fgHsl.l);
          else rep = hsl2rgb(fgHsl.h, fgHsl.s, hsl.l);
          d[i] += (rep.r - d[i]) * m;
          d[i + 1] += (rep.g - d[i + 1]) * m;
          d[i + 2] += (rep.b - d[i + 2]) * m;
        }
        return region;
      },
    });
  }
}

registerTool(new ColorReplaceTool());

/* ================================================================== */
/* Mixer Brush                                                         */
/* ================================================================== */

class MixerBrushTool extends BrushToolBase {
  constructor() {
    super({
      id: 'mixer-brush', name: 'Mixer Brush Tool', icon: 'mixer-brush',
      cursor: 'crosshair', shortcut: 'B', group: 'brush', groupOrder: 7,
      strokeLabel: 'Mixer Brush',
      options: [
        ...tweakDefaults(brushOptionDescriptors({ opacity: false, flow: false }), { size: 40, hardness: 60 }),
        { key: 'wet', label: 'Wet', type: 'slider', min: 0, max: 100, step: 1, default: 60, unit: '%',
          hint: 'How much canvas colour the brush picks up' },
        { key: 'load', label: 'Load', type: 'slider', min: 0, max: 100, step: 1, default: 70, unit: '%',
          hint: 'How much paint the reservoir lays down' },
        { key: 'mix', label: 'Mix', type: 'slider', min: 0, max: 100, step: 1, default: 50, unit: '%',
          hint: 'Ratio of canvas colour to reservoir colour in each dab' },
        { key: 'flow', label: 'Flow', type: 'slider', min: 1, max: 100, step: 1, default: 100, unit: '%' },
        { key: 'cleanAfterStroke', label: 'Clean Brush After Stroke', type: 'checkbox', default: true },
      ],
    });
    /** Colour currently held on the bristles. */
    this.reservoir = null;
  }

  onPointerDown(e) {
    // Alt-click loads the brush from the canvas, as in Photoshop.
    if (e.button === 0 && e.altKey) {
      const doc = this.doc;
      if (!doc) return;
      const c = samplePixel(getComposite(doc), e.x, e.y);
      if (c) {
        this.reservoir = { r: c.r, g: c.g, b: c.b, a: c.a };
        app.toast('Mixer brush loaded.', 'ok', 1200);
      }
      return;
    }
    super.onPointerDown(e);
  }

  makeStroke(e, doc, layer) {
    const fg = app.foreground;
    if (!this.reservoir) this.reservoir = { r: fg.r, g: fg.g, b: fg.b, a: 1 };
    const wet = this.state.wet / 100;
    const load = this.state.load / 100;
    const mix = this.state.mix / 100;

    return new EffectStroke({
      doc,
      layer,
      target: layer.paintTarget(),
      // `flow` here is the per-dab deposit; the engine applies it as dab alpha.
      brush: brushFromOptions(this.state),
      strength: 1,
      op: (region) => {
        const d = region.data;
        const n = region.width * region.height;

        // Average of what is already on the canvas under the dab.
        let ar = 0, ag = 0, ab = 0, aa = 0, count = 0;
        for (let i = 0; i < n * 4; i += 4) {
          const a = d[i + 3] / 255;
          if (a <= 0) { count++; continue; }
          ar += d[i] * a; ag += d[i + 1] * a; ab += d[i + 2] * a; aa += a;
          count++;
        }
        const res = this.reservoir;
        const canvasColor = aa > 0.001
          ? { r: ar / aa, g: ag / aa, b: ab / aa, a: aa / Math.max(1, count) }
          : { r: res.r, g: res.g, b: res.b, a: 0 };

        // What the bristles lay down this dab.
        const dep = {
          r: res.r + (canvasColor.r - res.r) * mix,
          g: res.g + (canvasColor.g - res.g) * mix,
          b: res.b + (canvasColor.b - res.b) * mix,
          a: res.a + (canvasColor.a - res.a) * mix,
        };
        const sa = load * clamp(dep.a, 0, 1);
        if (sa > 0.0005) {
          for (let i = 0; i < n * 4; i += 4) {
            const ba = d[i + 3] / 255;
            const outA = sa + ba * (1 - sa);
            if (outA <= 0) continue;
            d[i] = (dep.r * sa + d[i] * ba * (1 - sa)) / outA;
            d[i + 1] = (dep.g * sa + d[i + 1] * ba * (1 - sa)) / outA;
            d[i + 2] = (dep.b * sa + d[i + 2] * ba * (1 - sa)) / outA;
            d[i + 3] = outA * 255;
          }
        }

        // Then pick colour back up off the canvas.
        if (wet > 0 && aa > 0.001) {
          res.r += (canvasColor.r - res.r) * wet;
          res.g += (canvasColor.g - res.g) * wet;
          res.b += (canvasColor.b - res.b) * wet;
          res.a += (Math.min(1, canvasColor.a) - res.a) * wet;
        }
        return region;
      },
    });
  }

  afterStroke() {
    if (this.state.cleanAfterStroke) this.reservoir = null;
  }

  contextMenu() {
    // "Clean" is the mixer's equivalent of clearing a sampled source: it drops
    // whatever colour the bristles are holding.
    return brushContextMenu(this, [{
      label: 'Clean Brush',
      disabled: !this.reservoir,
      run: () => {
        this.reservoir = null;
        app.toast('Mixer brush cleaned.', 'ok', 1200);
      },
    }]);
  }
}

registerTool(new MixerBrushTool());
