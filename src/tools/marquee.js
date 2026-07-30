import { Tool, registerTool } from './base.js';
import { app } from '../core/app.js';
import { Selection } from '../core/selection.js';

/**
 * Marquee tools + the shared base class every selection tool builds on
 * (`src/tools/lasso.js` and `src/tools/wand.js` import `SelectionTool` from
 * here).
 */

const ALL_MODES = [
  { value: 'replace', label: 'New' },
  { value: 'add', label: 'Add' },
  { value: 'subtract', label: 'Subtract' },
  { value: 'intersect', label: 'Intersect' },
];

/**
 * Build the standard option list for a selection tool: boolean mode first,
 * the tool's own options in the middle, feather + anti-alias last.
 * @param {string[]} [modes] restrict which boolean modes are offered
 * @param {object[]} [extra] tool-specific ParamDescriptors
 */
export function selectionOptions(modes, extra = []) {
  const opts = modes ? ALL_MODES.filter((m) => modes.includes(m.value)) : ALL_MODES;
  return [
    { key: 'mode', label: 'Mode', type: 'radio', options: opts, default: opts[0].value },
    ...extra,
    { key: 'feather', label: 'Feather', type: 'slider', min: 0, max: 250, step: 1, default: 0, unit: 'px' },
    { key: 'antialias', label: 'Anti-alias', type: 'checkbox', default: true },
  ];
}

/**
 * Common behaviour for every tool that produces a pixel selection: modifier
 * key overrides, feathering, anti-aliased rasterisation and history commits.
 */
export class SelectionTool extends Tool {
  constructor(opts = {}) {
    const { modes, options = [], ...rest } = opts;
    super({ cursor: 'crosshair', ...rest, options: selectionOptions(modes, options) });
    // Tools are constructed at import time, long before any init(app) call.
    this.app = app;
  }

  /**
   * The boolean mode for the drag that is starting. Shift = add, Alt =
   * subtract, Shift+Alt = intersect; they win over the options bar.
   */
  modeFor(e) {
    if (e.shiftKey && e.altKey) return 'intersect';
    if (e.shiftKey) return 'add';
    if (e.altKey) return 'subtract';
    return this.state.mode || 'replace';
  }

  featherPx() {
    const f = Number(this.state.feather);
    return Number.isFinite(f) && f > 0 ? f : 0;
  }

  antialiasOn() {
    return this.state.antialias !== false;
  }

  /** Rasterise a document-space Path2D into a coverage mask. */
  maskFromPath(path, fillRule) {
    const doc = this.doc;
    const aa = this.antialiasOn();
    const m = Selection.rasterizePath(path, doc.width, doc.height, { antialias: aa, fillRule });
    // rasterizePath cannot switch off the canvas rasteriser's own AA, so hard
    // edges are produced by thresholding the coverage instead.
    if (!aa) for (let i = 0; i < m.length; i++) m[i] = m[i] >= 128 ? 255 : 0;
    return m;
  }

  /** Combine a finished coverage mask into the document selection. */
  applyMask(mask, mode, label) {
    const doc = this.doc;
    if (!doc) return;
    doc.selection.combine(mask, mode);
    const f = this.featherPx();
    if (f > 0) doc.selection.feather(f);
    doc.emit('selection-change');
    doc.commit(label);
  }

  /** Convenience: rasterise then combine. */
  applyPath(path, mode, label, fillRule) {
    this.applyMask(this.maskFromPath(path, fillRule), mode, label);
  }

  clearSelection() {
    const doc = this.doc;
    if (!doc || !doc.selection.active) return;
    doc.selection.clear();
    doc.emit('selection-change');
    doc.commit('Deselect');
  }

  /** Live drag feedback — repaint with no history entry. */
  preview() {
    const doc = this.doc;
    if (doc) doc.touch('selection-preview');
  }

  /** Screen-space distance between a document point and a screen point. */
  screenDist(docPt, sx, sy) {
    const p = this.app.viewport.toScreen(docPt.x, docPt.y);
    return Math.hypot(p.x - sx, p.y - sy);
  }
}

/* ------------------------------------------------------------------ */
/* Overlay helpers (screen space) — shared with lasso/wand/crop        */
/* ------------------------------------------------------------------ */

/** Map document-space points to screen space. */
export function toScreenPoints(view, pts) {
  return pts.map((p) => view.toScreen(p.x, p.y));
}

/** Marching-ants style stroke: solid dark underneath, dashed white on top. */
export function strokeDashedPoly(ctx, pts, close = true) {
  if (!pts || pts.length < 2) return;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  if (close) ctx.closePath();
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(0,0,0,.8)';
  ctx.stroke();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.restore();
}

/** Same look, for an axis-aligned document rect. */
export function strokeDashedRect(ctx, view, rect) {
  const { x, y, width: w, height: h } = rect;
  strokeDashedPoly(ctx, toScreenPoints(view, [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
  ]));
}

/** Same look, for a document-space ellipse inscribed in `rect`. */
export function strokeDashedEllipse(ctx, view, rect) {
  const c = view.toScreen(rect.x + rect.width / 2, rect.y + rect.height / 2);
  const rx = Math.max(0.5, (Math.abs(rect.width) / 2) * view.scale);
  const ry = Math.max(0.5, (Math.abs(rect.height) / 2) * view.scale);
  ctx.save();
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(c.x, c.y, rx, ry, view.rotation, 0, Math.PI * 2);
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(0,0,0,.8)';
  ctx.stroke();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Rectangular / elliptical marquee                                    */
/* ------------------------------------------------------------------ */

const STYLE_OPTIONS = [
  {
    key: 'style', label: 'Style', type: 'select', default: 'normal',
    options: [
      { value: 'normal', label: 'Normal' },
      { value: 'ratio', label: 'Fixed Ratio' },
      { value: 'size', label: 'Fixed Size' },
    ],
  },
  { key: 'ratioW', label: 'Width', type: 'number', min: 0.01, step: 0.01, default: 1, when: (s) => s.style === 'ratio' },
  { key: 'ratioH', label: 'Height', type: 'number', min: 0.01, step: 0.01, default: 1, when: (s) => s.style === 'ratio' },
  { key: 'fixedW', label: 'Width', type: 'number', min: 1, step: 1, default: 200, unit: 'px', when: (s) => s.style === 'size' },
  { key: 'fixedH', label: 'Height', type: 'number', min: 1, step: 1, default: 200, unit: 'px', when: (s) => s.style === 'size' },
];

class MarqueeShapeTool extends SelectionTool {
  constructor(opts) {
    super({ group: 'marquee', groupOrder: 1, options: STYLE_OPTIONS, ...opts });
    this.dragging = false;
    this.start = null;
    this.cur = null;
    this.dragMode = 'replace';
    this.moved = false;
    this.square = false;
    this.fromCenter = false;
  }

  onPointerDown(e) {
    if (!this.doc) return;
    this.dragging = true;
    this.moved = false;
    this.square = false;
    this.fromCenter = false;
    this.dragMode = this.modeFor(e);
    this.start = { x: e.x, y: e.y };
    this.cur = { x: e.x, y: e.y };
    if (this.state.style === 'size') this.preview();
  }

  onPointerMove(e) {
    if (!this.dragging) return;
    // Modifiers are re-read during the drag: there they mean "constrain" and
    // "from centre" rather than the boolean mode picked at pointer-down.
    this.square = e.shiftKey;
    this.fromCenter = e.altKey;
    this.cur = { x: e.x, y: e.y };
    if (Math.abs(e.x - this.start.x) > 0.5 || Math.abs(e.y - this.start.y) > 0.5) this.moved = true;
    this.preview();
  }

  onPointerUp() {
    if (!this.dragging) return;
    this.dragging = false;
    const doc = this.doc;
    if (!doc) return;
    const rect = this.currentRect();
    const fixed = this.state.style === 'size';
    if (!fixed && (!this.moved || rect.width < 1 || rect.height < 1)) {
      // A click with no drag clears the selection.
      this.clearSelection();
      this.start = this.cur = null;
      return;
    }
    this.applyPath(this.buildPath(rect), this.dragMode, this.label);
    this.start = this.cur = null;
  }

  cancel() {
    if (!this.dragging) return;
    this.dragging = false;
    this.start = this.cur = null;
    this.preview();
  }

  /** Geometry for the in-progress drag, honouring style + modifiers. */
  currentRect() {
    const st = this.state;
    const a = this.start, b = this.cur;
    if (!a || !b) return { x: 0, y: 0, width: 0, height: 0 };

    if (st.style === 'size') {
      const w = Math.max(1, Number(st.fixedW) || 1);
      const h = Math.max(1, Number(st.fixedH) || 1);
      return this.fromCenter
        ? { x: b.x - w / 2, y: b.y - h / 2, width: w, height: h }
        : { x: b.x, y: b.y, width: w, height: h };
    }

    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const sx = dx < 0 ? -1 : 1;
    const sy = dy < 0 ? -1 : 1;

    if (st.style === 'ratio') {
      const rw = Math.max(0.01, Number(st.ratioW) || 1);
      const rh = Math.max(0.01, Number(st.ratioH) || 1);
      const m = Math.max(Math.abs(dx), (Math.abs(dy) * rw) / rh);
      dx = sx * m;
      dy = (sy * m * rh) / rw;
    } else if (this.square) {
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      dx = sx * m;
      dy = sy * m;
    }

    if (this.fromCenter) {
      return { x: a.x - Math.abs(dx), y: a.y - Math.abs(dy), width: Math.abs(dx) * 2, height: Math.abs(dy) * 2 };
    }
    return {
      x: Math.min(a.x, a.x + dx),
      y: Math.min(a.y, a.y + dy),
      width: Math.abs(dx),
      height: Math.abs(dy),
    };
  }

  drawOverlay(ctx, view) {
    if (!this.dragging || !this.start) return;
    const rect = this.currentRect();
    if (rect.width < 0.5 && rect.height < 0.5) return;
    this.strokeShape(ctx, view, rect);
  }
}

class RectMarqueeTool extends MarqueeShapeTool {
  constructor() {
    super({ id: 'marquee-rect', name: 'Rectangular Marquee Tool', icon: 'marquee-rect', shortcut: 'M' });
    this.label = 'Rectangular Marquee';
  }

  buildPath(rect) {
    const p = new Path2D();
    p.rect(Math.round(rect.x), Math.round(rect.y), Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)));
    return p;
  }

  strokeShape(ctx, view, rect) {
    strokeDashedRect(ctx, view, rect);
  }
}

class EllipseMarqueeTool extends MarqueeShapeTool {
  constructor() {
    super({ id: 'marquee-ellipse', name: 'Elliptical Marquee Tool', icon: 'marquee-ellipse', shortcut: 'M' });
    this.label = 'Elliptical Marquee';
  }

  buildPath(rect) {
    const p = new Path2D();
    p.ellipse(rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width / 2, rect.height / 2, 0, 0, Math.PI * 2);
    return p;
  }

  strokeShape(ctx, view, rect) {
    strokeDashedEllipse(ctx, view, rect);
  }
}

/* ------------------------------------------------------------------ */
/* Single row / single column                                          */
/* ------------------------------------------------------------------ */

class BandMarqueeTool extends SelectionTool {
  constructor(axis, opts) {
    super({ group: 'marquee', groupOrder: 1, ...opts });
    this.axis = axis; // 'row' | 'col'
    this.dragging = false;
    this.cur = null;
    this.dragMode = 'replace';
  }

  onPointerDown(e) {
    if (!this.doc) return;
    this.dragging = true;
    this.dragMode = this.modeFor(e);
    this.cur = { x: e.x, y: e.y };
    this.preview();
  }

  onPointerMove(e) {
    this.cur = { x: e.x, y: e.y };
    if (this.dragging) this.preview();
    else this.app.requestRender();
  }

  onPointerUp() {
    if (!this.dragging) return;
    this.dragging = false;
    const rect = this.bandRect();
    if (!rect) return;
    const p = new Path2D();
    p.rect(rect.x, rect.y, rect.width, rect.height);
    this.applyPath(p, this.dragMode, this.label);
  }

  cancel() {
    this.dragging = false;
  }

  bandRect() {
    const doc = this.doc;
    if (!doc || !this.cur) return null;
    if (this.axis === 'row') {
      const y = Math.max(0, Math.min(doc.height - 1, Math.floor(this.cur.y)));
      return { x: 0, y, width: doc.width, height: 1 };
    }
    const x = Math.max(0, Math.min(doc.width - 1, Math.floor(this.cur.x)));
    return { x, y: 0, width: 1, height: doc.height };
  }

  drawOverlay(ctx, view) {
    const rect = this.bandRect();
    if (!rect) return;
    // A 1px band is invisible when zoomed out, so stroke its centre line.
    const a = view.toScreen(rect.x, rect.y + rect.height / 2);
    const b = view.toScreen(rect.x + rect.width, rect.y + rect.height / 2);
    ctx.save();
    ctx.lineWidth = Math.max(1, view.scale);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.stroke();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.restore();
  }
}

class RowMarqueeTool extends BandMarqueeTool {
  constructor() {
    super('row', { id: 'marquee-row', name: 'Single Row Marquee Tool', icon: 'marquee-row', shortcut: 'M' });
    this.label = 'Single Row Marquee';
  }
}

class ColMarqueeTool extends BandMarqueeTool {
  constructor() {
    super('col', { id: 'marquee-col', name: 'Single Column Marquee Tool', icon: 'marquee-col', shortcut: 'M' });
    this.label = 'Single Column Marquee';
  }
}

registerTool(new RectMarqueeTool());
registerTool(new EllipseMarqueeTool());
registerTool(new RowMarqueeTool());
registerTool(new ColMarqueeTool());
