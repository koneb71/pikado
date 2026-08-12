import { Tool, registerTool } from './base.js';
import { app } from '../core/app.js';
import { Selection } from '../core/selection.js';
import { snapPoint, snapRect, clearSnapLines } from '../core/snapping.js';
import { createCanvas, ctx2dRead, clamp } from '../core/util.js';
import { sampleBilinear } from '../filters/registry.js';
import { OVERLAY } from '../ui/brand.js';
import { sep } from '../ui/canvas-menu.js';

/**
 * Crop family: the rotating crop box, the perspective crop and the slice tool.
 */

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const HANDLE_HIT = 9;
const ROTATE_HIT = 40;
const MAX_STRAIGHTEN = 45;

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function screenPoly(view, pts) {
  return pts.map((p) => view.toScreen(p.x, p.y));
}

function tracePoly(ctx, pts) {
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

/** Translucent veil over everything outside `quad` (screen space). */
function dimOutside(ctx, view, quad) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, view.viewWidth, view.viewHeight);
  tracePoly(ctx, quad);
  ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.fill('evenodd');
  ctx.restore();
}

function strokeQuad(ctx, quad, color = '#fff') {
  ctx.save();
  ctx.setLineDash([]);
  ctx.beginPath();
  tracePoly(ctx, quad);
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,.35)';
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.restore();
}

function lerpPt(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Rule-of-thirds grid inside a screen-space quad [tl, tr, br, bl]. */
function drawThirds(ctx, quad) {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,.45)';
  ctx.setLineDash([]);
  ctx.beginPath();
  for (let i = 1; i <= 2; i++) {
    const t = i / 3;
    const a = lerpPt(quad[0], quad[1], t);
    const b = lerpPt(quad[3], quad[2], t);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    const c = lerpPt(quad[0], quad[3], t);
    const d = lerpPt(quad[1], quad[2], t);
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawHandles(ctx, pts, size = 7) {
  ctx.save();
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = 'rgba(0,0,0,.75)';
  const h = size / 2;
  for (const p of pts) {
    ctx.beginPath();
    ctx.rect(p.x - h, p.y - h, size, size);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Rotated crop                                                        */
/* ------------------------------------------------------------------ */

/**
 * Rotate + crop the whole document in one step. Mirrors `doc.crop()` but the
 * cut rectangle may be rotated around its own centre.
 */
function rotatedCrop(doc, rect, angle) {
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;

  const cut = (src, fillWhite) => {
    const out = createCanvas(w, h);
    const c = out.getContext('2d');
    if (fillWhite) {
      c.fillStyle = '#fff';
      c.fillRect(0, 0, w, h);
    }
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    // Source -> output: translate to the box centre, un-rotate, re-origin.
    c.translate(w / 2, h / 2);
    c.rotate(-angle);
    c.translate(-cx, -cy);
    c.drawImage(src, 0, 0);
    return out;
  };

  const layers = doc.flatLayers();
  doc.beginEdit(layers);
  for (const l of layers) {
    if (l.canvas) l.canvas = cut(l.canvas, false);
    if (l.mask) {
      l.mask = cut(l.mask, true);
      l.touchMask();
    }
  }

  const ca = Math.cos(-angle);
  const sa = Math.sin(-angle);
  const mapPt = (p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    return { x: dx * ca - dy * sa + w / 2, y: dx * sa + dy * ca + h / 2 };
  };
  for (const path of doc.paths) {
    for (const sp of path.subpaths || []) {
      for (const pt of sp.points || []) {
        const a = mapPt(pt);
        pt.x = a.x; pt.y = a.y;
        if (pt.in) { const b = mapPt(pt.in); pt.in.x = b.x; pt.in.y = b.y; }
        if (pt.out) { const b = mapPt(pt.out); pt.out.x = b.x; pt.out.y = b.y; }
      }
    }
  }

  doc.width = w;
  doc.height = h;
  doc.selection = new Selection(w, h);
  doc.guides = doc.guides.filter((g) => (g.axis === 'v' ? g.pos < w : g.pos < h));
  doc.invalidate();
  doc.emit('resize');
}

/* ------------------------------------------------------------------ */
/* Crop tool                                                           */
/* ------------------------------------------------------------------ */

/**
 * Ratio presets offered in the crop context menu. `custom` is left out on
 * purpose: it is only meaningful alongside the W/H fields in the options bar.
 */
const CONTEXT_RATIOS = [
  ['free', 'Unconstrained'],
  ['original', 'Original Ratio'],
  ['1:1', '1:1'],
  ['4:3', '4:3'],
  ['16:9', '16:9'],
];

class CropTool extends Tool {
  constructor() {
    super({
      id: 'crop', name: 'Crop Tool', icon: 'crop', shortcut: 'C', cursor: 'crosshair',
      group: 'crop', groupOrder: 4,
      options: [
        {
          key: 'ratio', label: 'Ratio', type: 'select', default: 'free',
          options: [
            { value: 'free', label: 'Unconstrained' },
            { value: 'original', label: 'Original Ratio' },
            { value: '1:1', label: '1:1' },
            { value: '4:3', label: '4:3' },
            { value: '16:9', label: '16:9' },
            { value: 'custom', label: 'Custom' },
          ],
        },
        { key: 'customW', label: 'W', type: 'number', min: 1, step: 1, default: 4, when: (s) => s.ratio === 'custom' },
        { key: 'customH', label: 'H', type: 'number', min: 1, step: 1, default: 5, when: (s) => s.ratio === 'custom' },
        { key: 'resolution', label: 'Resolution', type: 'number', min: 1, max: 2400, step: 1, default: 72, unit: 'ppi' },
        { key: 'straighten', label: 'Straighten', type: 'slider', min: -MAX_STRAIGHTEN, max: MAX_STRAIGHTEN, step: 0.1, default: 0, unit: '°' },
        { key: 'deleteCropped', label: 'Delete Cropped Pixels', type: 'checkbox', default: true },
      ],
    });
    this.app = app;
    this.rect = null;
    this.angle = 0;
    this.mode = null;
    this.handle = null;
    this._modified = false;
    this._docId = null;
    this._docW = 0;
    this._docH = 0;
  }

  onActivate() {
    this.syncDoc(true);
  }

  onDeactivate() {
    this.rect = null;
    this.mode = null;
    this._docId = null;
    this._modified = false;
  }

  /** Reset the box whenever the document (or its size) changed under us. */
  syncDoc(force = false) {
    const doc = this.doc;
    if (!doc) {
      this.rect = null;
      return;
    }
    if (force || !this.rect || this._docId !== doc.id || this._docW !== doc.width || this._docH !== doc.height) {
      this.rect = { x: 0, y: 0, width: doc.width, height: doc.height };
      this.angle = 0;
      this.state.straighten = 0;
      this.state.resolution = doc.resolution || 72;
      this._modified = false;
      this._docId = doc.id;
      this._docW = doc.width;
      this._docH = doc.height;
    }
  }

  onOptionChange(key, value) {
    if (key === 'straighten') {
      this.angle = (Number(value) || 0) * (Math.PI / 180);
      this._modified = true;
      this.app.requestRender();
      return;
    }
    if (key === 'ratio' || key === 'customW' || key === 'customH') {
      this.applyRatioToRect();
      this.app.requestRender();
    }
  }

  /** Snap the current box to the chosen aspect ratio, keeping its centre. */
  applyRatioToRect() {
    const r = this.ratioValue();
    if (!r || !this.rect) return;
    const c = this.center();
    const area = Math.max(1, this.rect.width * this.rect.height);
    const h = Math.sqrt(area / r);
    const w = h * r;
    this.rect = { x: c.x - w / 2, y: c.y - h / 2, width: w, height: h };
    this._modified = true;
  }

  ratioValue() {
    const doc = this.doc;
    switch (this.state.ratio) {
      case 'original': return doc ? doc.width / doc.height : 0;
      case '1:1': return 1;
      case '4:3': return 4 / 3;
      case '16:9': return 16 / 9;
      case 'custom': {
        const w = Number(this.state.customW) || 0;
        const h = Number(this.state.customH) || 0;
        return w > 0 && h > 0 ? w / h : 0;
      }
      default: return 0;
    }
  }

  /* --- geometry -------------------------------------------------- */

  center() {
    return { x: this.rect.x + this.rect.width / 2, y: this.rect.y + this.rect.height / 2 };
  }

  /** Document point -> crop-box local frame (origin at the box centre). */
  toLocal(px, py, rect = this.rect) {
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const dx = px - cx;
    const dy = py - cy;
    const c = Math.cos(-this.angle);
    const s = Math.sin(-this.angle);
    return { x: dx * c - dy * s, y: dx * s + dy * c };
  }

  toDocPt(lx, ly, rect = this.rect) {
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    return { x: cx + lx * c - ly * s, y: cy + lx * s + ly * c };
  }

  corners() {
    const hw = this.rect.width / 2;
    const hh = this.rect.height / 2;
    return [
      this.toDocPt(-hw, -hh), this.toDocPt(hw, -hh),
      this.toDocPt(hw, hh), this.toDocPt(-hw, hh),
    ];
  }

  handlePoints() {
    const hw = this.rect.width / 2;
    const hh = this.rect.height / 2;
    const at = {
      nw: [-hw, -hh], n: [0, -hh], ne: [hw, -hh], e: [hw, 0],
      se: [hw, hh], s: [0, hh], sw: [-hw, hh], w: [-hw, 0],
    };
    return HANDLES.map((id) => ({ id, p: this.toDocPt(at[id][0], at[id][1]) }));
  }

  hitTest(e) {
    const view = this.app.viewport;
    for (const hp of this.handlePoints()) {
      const s = view.toScreen(hp.p.x, hp.p.y);
      if (Math.hypot(s.x - e.sx, s.y - e.sy) <= HANDLE_HIT) return { mode: 'resize', handle: hp.id };
    }
    const l = this.toLocal(e.x, e.y);
    if (Math.abs(l.x) <= this.rect.width / 2 && Math.abs(l.y) <= this.rect.height / 2) return { mode: 'move' };
    for (const c of this.corners()) {
      const s = view.toScreen(c.x, c.y);
      if (Math.hypot(s.x - e.sx, s.y - e.sy) <= ROTATE_HIT) return { mode: 'rotate' };
    }
    return { mode: 'new' };
  }

  /* --- interaction ------------------------------------------------ */

  onPointerDown(e) {
    this.syncDoc();
    if (!this.rect) return;
    const hit = this.hitTest(e);
    this.mode = hit.mode;
    this.handle = hit.handle || null;
    this.startRect = { ...this.rect };
    this.startAngle = this.angle;
    this.startPt = { x: e.x, y: e.y };
    if (this.mode === 'rotate') {
      this.rotCenter = this.center();
      this.rotRef = Math.atan2(e.y - this.rotCenter.y, e.x - this.rotCenter.x);
    }
    if (this.mode === 'new') {
      this.angle = 0;
      this.state.straighten = 0;
      this.rect = { x: e.x, y: e.y, width: 0, height: 0 };
    }
    this._modified = true;
    this.app.requestRender();
  }

  onPointerMove(e) {
    if (!this.mode) return;
    /*
     * Each mode snaps the thing it is actually moving. Pulling a corner out
     * snaps that corner; sliding the whole box snaps the box, so its far edge
     * catches a guide as readily as its near one. Rotating snaps nothing —
     * there is no straight edge to catch.
     */
    if (this.mode === 'new') this.dragNew(e);
    else if (this.mode === 'move') {
      const moved = {
        ...this.startRect,
        x: this.startRect.x + (e.x - this.startPt.x),
        y: this.startRect.y + (e.y - this.startPt.y),
      };
      const snap = snapRect(moved, this.doc, { event: e });
      this.rect = { ...moved, x: moved.x + snap.dx, y: moved.y + snap.dy };
    } else if (this.mode === 'rotate') {
      const a = Math.atan2(e.y - this.rotCenter.y, e.x - this.rotCenter.x);
      const lim = (MAX_STRAIGHTEN * Math.PI) / 180;
      this.angle = clamp(this.startAngle + (a - this.rotRef), -lim, lim);
    } else if (this.mode === 'resize') {
      this.resizeTo(e);
    }
    this.app.requestRender();
  }

  dragNew(e) {
    const x0 = this.startPt.x;
    const y0 = this.startPt.y;
    const p = snapPoint(e.x, e.y, this.doc, { event: e });
    let dx = p.x - x0;
    let dy = p.y - y0;
    let ratio = this.ratioValue();
    if (!ratio && e.shiftKey) ratio = 1;
    if (ratio) {
      const m = Math.max(Math.abs(dx), Math.abs(dy) * ratio);
      dx = (dx < 0 ? -1 : 1) * m;
      dy = ((dy < 0 ? -1 : 1) * m) / ratio;
    }
    this.rect = {
      x: Math.min(x0, x0 + dx),
      y: Math.min(y0, y0 + dy),
      width: Math.abs(dx),
      height: Math.abs(dy),
    };
  }

  resizeTo(e) {
    const sr = this.startRect;
    /*
     * Only while the box is square to the document. `toLocal` works in the
     * box's rotated space, and a guide is a line in document space — snapping
     * the cursor first and rotating it afterwards would put the edge somewhere
     * near the guide rather than on it, which is worse than not snapping.
     */
    const p = this.angle ? e : snapPoint(e.x, e.y, this.doc, { event: e });
    const l0 = this.toLocal(p.x, p.y, sr);
    let l = -sr.width / 2;
    let r = sr.width / 2;
    let t = -sr.height / 2;
    let b = sr.height / 2;
    const hd = this.handle;
    if (hd.includes('w')) l = Math.min(l0.x, r - 1);
    if (hd.includes('e')) r = Math.max(l0.x, l + 1);
    if (hd.includes('n')) t = Math.min(l0.y, b - 1);
    if (hd.includes('s')) b = Math.max(l0.y, t + 1);

    let ratio = this.ratioValue();
    if (!ratio && e.shiftKey) ratio = sr.width / Math.max(1, sr.height);
    if (ratio) {
      let nw = r - l;
      let nh = b - t;
      if (hd.length === 2) {
        // Corner: grow the smaller axis so the dragged corner stays closest.
        if (nw / ratio >= nh) nh = nw / ratio; else nw = nh * ratio;
        if (hd.includes('w')) l = r - nw; else r = l + nw;
        if (hd.includes('n')) t = b - nh; else b = t + nh;
      } else if (hd === 'e' || hd === 'w') {
        nh = nw / ratio;
        const mid = (t + b) / 2;
        t = mid - nh / 2;
        b = mid + nh / 2;
      } else {
        nw = nh * ratio;
        const mid = (l + r) / 2;
        l = mid - nw / 2;
        r = mid + nw / 2;
      }
    }

    const nw = r - l;
    const nh = b - t;
    const c = this.toDocPt((l + r) / 2, (t + b) / 2, sr);
    this.rect = { x: c.x - nw / 2, y: c.y - nh / 2, width: nw, height: nh };
  }

  onPointerUp() {
    if (!this.mode) return;
    clearSnapLines();
    if (this.mode === 'new' && (this.rect.width < 2 || this.rect.height < 2)) {
      this.rect = { ...this.startRect };
    }
    if (this.mode === 'rotate') {
      // Keep the Straighten control in step with a rotation done by dragging.
      this.state.straighten = Number(((this.angle * 180) / Math.PI).toFixed(1));
      this.app.emit('tool-options', this);
    }
    this.mode = null;
    this.handle = null;
    this.app.requestRender();
  }

  onDoubleClick() {
    this.applyCrop();
  }

  onKeyDown(e) {
    if (!this.rect) return false;
    if (e.key === 'Enter') { this.applyCrop(); return true; }
    if (e.key === 'Escape') { this.cancel(); return true; }
    return false;
  }

  /** Called on tool switch — commit only if the user actually moved the box. */
  commit() {
    if (this._modified) this.applyCrop();
  }

  cancel() {
    clearSnapLines();
    this.syncDoc(true);
    this.app.requestRender();
  }

  applyCrop() {
    const doc = this.doc;
    if (!doc || !this.rect) return;
    let rect = { ...this.rect };
    const angle = this.angle;
    if (rect.width < 1 || rect.height < 1) {
      this.app.toast('The crop area is empty.', 'warn');
      return;
    }

    if (this.state.deleteCropped === false) {
      // "Delete Cropped Pixels" off: grow the box until it contains the whole
      // document, so the crop only ever reframes and never discards pixels.
      // (Layer buffers are document-sized, so anything outside the new canvas
      // cannot be retained any other way.)
      let l = -rect.width / 2;
      let r = rect.width / 2;
      let t = -rect.height / 2;
      let b = rect.height / 2;
      for (const [x, y] of [[0, 0], [doc.width, 0], [doc.width, doc.height], [0, doc.height]]) {
        const p = this.toLocal(x, y, rect);
        l = Math.min(l, p.x); r = Math.max(r, p.x);
        t = Math.min(t, p.y); b = Math.max(b, p.y);
      }
      const c = this.toDocPt((l + r) / 2, (t + b) / 2, rect);
      rect = { x: c.x - (r - l) / 2, y: c.y - (b - t) / 2, width: r - l, height: b - t };
    }

    let noChange = false;
    if (Math.abs(angle) > 1e-4) {
      rotatedCrop(doc, rect, angle);
    } else {
      rect = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      };
      const dx = Math.max(Math.max(0, -rect.x), Math.max(0, rect.x + rect.width - doc.width));
      const dy = Math.max(Math.max(0, -rect.y), Math.max(0, rect.y + rect.height - doc.height));
      if (dx > 0 || dy > 0) {
        // The box reaches outside the canvas: grow it first, then trim.
        doc.resizeCanvasTo(doc.width + dx * 2, doc.height + dy * 2, 'center');
        rect.x += dx;
        rect.y += dy;
      }
      const unchanged = rect.x === 0 && rect.y === 0 && rect.width === doc.width && rect.height === doc.height;
      if (!unchanged) doc.crop(rect);
      else noChange = dx === 0 && dy === 0;
    }

    const res = Number(this.state.resolution);
    const resChanged = Number.isFinite(res) && res > 0 && res !== doc.resolution;
    if (noChange && !resChanged) {
      this._modified = false;
      return; // the box already matches the canvas
    }
    if (resChanged) doc.resolution = res;
    doc.commit('Crop');
    this.syncDoc(true);
    this.app.viewport.center(doc.width, doc.height);
    this.app.emit('view-change');
    this.app.requestRender();
  }

  /**
   * Right-click menu: the ratio presets with a tick on the live one, the
   * Delete Cropped Pixels toggle, then commit / abandon — the same four things
   * the crop options bar offers, without leaving the canvas.
   */
  contextMenu() {
    const ratio = this.state.ratio;
    const deleteCropped = this.state.deleteCropped !== false;
    const pending = !!this.rect;
    return [
      ...CONTEXT_RATIOS.map(([value, label]) => ({
        label,
        checked: ratio === value,
        run: () => this.setOption('ratio', value),
      })),
      sep(),
      {
        label: 'Delete Cropped Pixels',
        checked: deleteCropped,
        run: () => this.setOption('deleteCropped', !deleteCropped),
      },
      sep(),
      { label: 'Crop', accel: 'Enter', disabled: !pending, run: () => this.applyCrop() },
      { label: 'Cancel', accel: 'Esc', disabled: !pending, run: () => this.cancel() },
    ];
  }

  drawOverlay(ctx, view) {
    this.syncDoc();
    if (!this.rect || this.rect.width <= 0 || this.rect.height <= 0) return;
    const quad = screenPoly(view, this.corners());
    dimOutside(ctx, view, quad);
    drawThirds(ctx, quad);
    strokeQuad(ctx, quad);
    drawHandles(ctx, screenPoly(view, this.handlePoints().map((h) => h.p)));
  }
}

/* ------------------------------------------------------------------ */
/* Perspective crop                                                    */
/* ------------------------------------------------------------------ */

/**
 * Solve the 8 coefficients of the projective map taking the four `from`
 * points to the four `to` points.
 *   X = (a·x + b·y + c) / (g·x + h·y + 1)
 *   Y = (d·x + e·y + f) / (g·x + h·y + 1)
 * @returns {number[]|null} [a,b,c,d,e,f,g,h]
 */
export function solveHomography(from, to) {
  const m = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i];
    const X = to[i].x;
    const Y = to[i].y;
    m.push([x, y, 1, 0, 0, 0, -x * X, -y * X, X]);
    m.push([0, 0, 0, x, y, 1, -x * Y, -y * Y, Y]);
  }
  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (Math.abs(m[piv][col]) < 1e-10) return null;
    const tmp = m[col]; m[col] = m[piv]; m[piv] = tmp;
    const p = m[col][col];
    for (let c = col; c < 9; c++) m[col][c] /= p;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (!f) continue;
      for (let c = col; c < 9; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row) => row[8]);
}

class PerspectiveCropTool extends Tool {
  constructor() {
    super({
      id: 'crop-perspective', name: 'Perspective Crop Tool', icon: 'crop-perspective', shortcut: 'C',
      cursor: 'crosshair', group: 'crop', groupOrder: 4,
      options: [
        { key: 'resolution', label: 'Resolution', type: 'number', min: 1, max: 2400, step: 1, default: 72, unit: 'ppi' },
        { key: 'showGrid', label: 'Show Grid', type: 'checkbox', default: true },
      ],
    });
    this.app = app;
    this.quad = null;
    this.drag = -1;
    this._modified = false;
    this._docId = null;
    this._docW = 0;
    this._docH = 0;
  }

  onActivate() {
    this.syncDoc(true);
  }

  onDeactivate() {
    this.quad = null;
    this.drag = -1;
    this._modified = false;
    this._docId = null;
  }

  syncDoc(force = false) {
    const doc = this.doc;
    if (!doc) {
      this.quad = null;
      return;
    }
    if (force || !this.quad || this._docId !== doc.id || this._docW !== doc.width || this._docH !== doc.height) {
      this.quad = [
        { x: 0, y: 0 }, { x: doc.width, y: 0 },
        { x: doc.width, y: doc.height }, { x: 0, y: doc.height },
      ];
      this._modified = false;
      this._docId = doc.id;
      this._docW = doc.width;
      this._docH = doc.height;
      this.state.resolution = doc.resolution || 72;
    }
  }

  onPointerDown(e) {
    this.syncDoc();
    if (!this.quad) return;
    const view = this.app.viewport;
    let best = -1;
    let bestD = 14;
    for (let i = 0; i < 4; i++) {
      const s = view.toScreen(this.quad[i].x, this.quad[i].y);
      const d = Math.hypot(s.x - e.sx, s.y - e.sy);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) {
      this.drag = best;
    } else {
      this.drag = -2; // dragging out a fresh axis-aligned quad
      this.startPt = { x: e.x, y: e.y };
      this.quad = [{ x: e.x, y: e.y }, { x: e.x, y: e.y }, { x: e.x, y: e.y }, { x: e.x, y: e.y }];
    }
    this.app.requestRender();
  }

  onPointerMove(e) {
    if (this.drag === -1) return;
    if (this.drag === -2) {
      const a = this.startPt;
      const x0 = Math.min(a.x, e.x);
      const x1 = Math.max(a.x, e.x);
      const y0 = Math.min(a.y, e.y);
      const y1 = Math.max(a.y, e.y);
      this.quad = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
    } else {
      this.quad[this.drag] = { x: e.x, y: e.y };
    }
    this._modified = true;
    this.app.requestRender();
  }

  onPointerUp() {
    if (this.drag === -2 && (dist(this.quad[0], this.quad[1]) < 4 || dist(this.quad[0], this.quad[3]) < 4)) {
      this.syncDoc(true);
    }
    this.drag = -1;
    this.app.requestRender();
  }

  onDoubleClick() {
    this.apply();
  }

  onKeyDown(e) {
    if (!this.quad) return false;
    if (e.key === 'Enter') { this.apply(); return true; }
    if (e.key === 'Escape') { this.syncDoc(true); this.app.requestRender(); return true; }
    return false;
  }

  /** Called on tool switch — like the crop tool, apply a quad the user moved. */
  commit() {
    if (this._modified) this.apply();
  }

  cancel() {
    this.syncDoc(true);
    this.app.requestRender();
  }

  apply() {
    const doc = this.doc;
    if (!doc || !this.quad) return;
    const [p0, p1, p2, p3] = this.quad;
    const W = Math.max(1, Math.round((dist(p0, p1) + dist(p3, p2)) / 2));
    const H = Math.max(1, Math.round((dist(p0, p3) + dist(p1, p2)) / 2));
    const rectPts = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
    // Destination -> source, so every output pixel can be inverse-mapped.
    const fwd = solveHomography(rectPts, this.quad);
    const inv = solveHomography(this.quad, rectPts);
    if (!fwd || !inv) {
      this.app.toast('That quad is degenerate — move the corners apart.', 'warn');
      return;
    }

    const sw = doc.width;
    const sh = doc.height;
    const warp = (src, isMask) => {
      const simg = ctx2dRead(src).getImageData(0, 0, sw, sh);
      const sd = simg.data;
      const out = new ImageData(W, H);
      const od = out.data;
      const px = [0, 0, 0, 0];
      for (let v = 0; v < H; v++) {
        const vv = v + 0.5;
        for (let u = 0; u < W; u++) {
          const uu = u + 0.5;
          const den = fwd[6] * uu + fwd[7] * vv + 1;
          const x = (fwd[0] * uu + fwd[1] * vv + fwd[2]) / den - 0.5;
          const y = (fwd[3] * uu + fwd[4] * vv + fwd[5]) / den - 0.5;
          const o = (v * W + u) * 4;
          if (x < -0.5 || y < -0.5 || x > sw - 0.5 || y > sh - 0.5) {
            if (isMask) { od[o] = od[o + 1] = od[o + 2] = 255; od[o + 3] = 255; }
            continue;
          }
          sampleBilinear(sd, sw, sh, x, y, px);
          od[o] = px[0]; od[o + 1] = px[1]; od[o + 2] = px[2]; od[o + 3] = px[3];
        }
      }
      const cv = createCanvas(W, H);
      cv.getContext('2d').putImageData(out, 0, 0);
      return cv;
    };

    const mapPt = (q) => {
      const den = inv[6] * q.x + inv[7] * q.y + 1;
      return {
        x: (inv[0] * q.x + inv[1] * q.y + inv[2]) / den,
        y: (inv[3] * q.x + inv[4] * q.y + inv[5]) / den,
      };
    };

    const layers = doc.flatLayers();
    doc.beginEdit(layers);
    for (const l of layers) {
      if (l.canvas) l.canvas = warp(l.canvas, false);
      if (l.mask) {
        l.mask = warp(l.mask, true);
        l.touchMask();
      }
    }
    for (const path of doc.paths) {
      for (const sp of path.subpaths || []) {
        for (const pt of sp.points || []) {
          const a = mapPt(pt);
          pt.x = a.x; pt.y = a.y;
          if (pt.in) { const b = mapPt(pt.in); pt.in.x = b.x; pt.in.y = b.y; }
          if (pt.out) { const b = mapPt(pt.out); pt.out.x = b.x; pt.out.y = b.y; }
        }
      }
    }

    doc.width = W;
    doc.height = H;
    doc.selection = new Selection(W, H);
    doc.guides = [];
    doc.invalidate();
    doc.emit('resize');
    const res = Number(this.state.resolution);
    if (Number.isFinite(res) && res > 0) doc.resolution = res;
    doc.commit('Perspective Crop');

    this.syncDoc(true);
    this.app.viewport.center(doc.width, doc.height);
    this.app.emit('view-change');
    this.app.requestRender();
  }

  contextMenu() {
    const grid = this.state.showGrid !== false;
    return [
      { label: 'Perspective Crop', accel: 'Enter', disabled: !this.quad, run: () => this.apply() },
      { label: 'Cancel', accel: 'Esc', disabled: !this.quad, run: () => this.cancel() },
      sep(),
      { label: 'Show Grid', checked: grid, run: () => this.setOption('showGrid', !grid) },
    ];
  }

  drawOverlay(ctx, view) {
    this.syncDoc();
    if (!this.quad) return;
    const scr = screenPoly(view, this.quad);
    dimOutside(ctx, view, scr);
    if (this.state.showGrid) drawThirds(ctx, scr);
    strokeQuad(ctx, scr);
    drawHandles(ctx, scr, 9);
  }
}

/* ------------------------------------------------------------------ */
/* Slice tool                                                          */
/* ------------------------------------------------------------------ */

function slicesOf(doc) {
  if (!Array.isArray(doc.slices)) doc.slices = [];
  return doc.slices;
}

class SliceTool extends Tool {
  constructor() {
    super({
      id: 'slice', name: 'Slice Tool', icon: 'slice', cursor: 'crosshair', shortcut: 'C',
      group: 'crop', groupOrder: 4,
      options: [
        { key: 'namePrefix', label: 'Name', type: 'text', default: 'Slice' },
        {
          type: 'button', label: 'Clear All',
          onClick: () => {
            const doc = app.activeDoc;
            if (!doc) return;
            doc.slices = [];
            app.requestRender();
          },
        },
      ],
    });
    this.app = app;
    this.drag = null;
    this.selected = -1;
  }

  onPointerDown(e) {
    const doc = this.doc;
    if (!doc) return;
    const list = slicesOf(doc);
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      if (e.x >= s.x && e.y >= s.y && e.x <= s.x + s.width && e.y <= s.y + s.height) {
        this.selected = i;
        this.drag = { kind: 'move', index: i, start: { x: e.x, y: e.y }, orig: { ...s } };
        this.app.requestRender();
        return;
      }
    }
    this.selected = -1;
    this.drag = { kind: 'new', start: { x: e.x, y: e.y }, rect: { x: e.x, y: e.y, width: 0, height: 0 } };
    this.app.requestRender();
  }

  onPointerMove(e) {
    if (!this.drag) return;
    if (this.drag.kind === 'new') {
      const a = this.drag.start;
      this.drag.rect = {
        x: Math.min(a.x, e.x), y: Math.min(a.y, e.y),
        width: Math.abs(e.x - a.x), height: Math.abs(e.y - a.y),
      };
    } else {
      const s = slicesOf(this.doc)[this.drag.index];
      if (s) {
        s.x = Math.round(this.drag.orig.x + (e.x - this.drag.start.x));
        s.y = Math.round(this.drag.orig.y + (e.y - this.drag.start.y));
      }
    }
    this.app.requestRender();
  }

  onPointerUp() {
    if (!this.drag) return;
    const doc = this.doc;
    if (this.drag.kind === 'new' && doc) {
      const r = this.drag.rect;
      if (r.width >= 2 && r.height >= 2) {
        const list = slicesOf(doc);
        list.push({
          x: Math.round(r.x), y: Math.round(r.y),
          width: Math.round(r.width), height: Math.round(r.height),
          name: `${this.state.namePrefix || 'Slice'} ${list.length + 1}`,
        });
        this.selected = list.length - 1;
      }
    }
    this.drag = null;
    this.app.requestRender();
  }

  onKeyDown(e) {
    const doc = this.doc;
    if (!doc) return false;
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected >= 0) {
      slicesOf(doc).splice(this.selected, 1);
      this.selected = -1;
      this.app.requestRender();
      return true;
    }
    if (e.key === 'Escape') {
      this.selected = -1;
      this.app.requestRender();
      return true;
    }
    return false;
  }

  cancel() {
    this.drag = null;
    this.selected = -1;
  }

  /** Topmost slice covering a document point, or null. */
  sliceAt(x, y) {
    const doc = this.doc;
    const list = doc && Array.isArray(doc.slices) ? doc.slices : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      if (x >= s.x && y >= s.y && x <= s.x + s.width && y <= s.y + s.height) return s;
    }
    return null;
  }

  /**
   * Right-click menu: delete the slice under the pointer, or all of them.
   * Slices are not part of the history stack (the options bar's "Clear All"
   * mutates them the same way), so these repaint rather than commit.
   */
  contextMenu(e) {
    const doc = this.doc;
    if (!doc) return [];
    const slice = this.sliceAt(e.x, e.y);
    const count = Array.isArray(doc.slices) ? doc.slices.length : 0;
    const items = [];
    if (slice) {
      items.push({
        label: `Delete "${slice.name}"`,
        run: () => {
          const list = slicesOf(doc);
          const i = list.indexOf(slice);
          if (i >= 0) list.splice(i, 1);
          this.selected = -1;
          this.app.requestRender();
        },
      });
    }
    items.push({
      label: 'Delete All Slices',
      disabled: !count,
      run: () => {
        doc.slices = [];
        this.selected = -1;
        this.app.requestRender();
      },
    });
    return items;
  }

  drawOverlay(ctx, view) {
    const doc = this.doc;
    if (!doc) return;
    const list = slicesOf(doc);
    ctx.save();
    ctx.setLineDash([]);
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const boxes = this.drag && this.drag.kind === 'new' ? [...list, this.drag.rect] : list;
    boxes.forEach((s, i) => {
      const a = view.toScreen(s.x, s.y);
      const b = view.toScreen(s.x + s.width, s.y + s.height);
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      ctx.lineWidth = i === this.selected ? 2 : 1;
      ctx.strokeStyle = i === this.selected ? '#ffd479' : OVERLAY.accent;
      ctx.strokeRect(x + 0.5, y + 0.5, w, h);
      const label = String(i + 1);
      const tw = ctx.measureText(label).width + 8;
      ctx.fillStyle = i === this.selected ? '#ffd479' : OVERLAY.accent;
      ctx.fillRect(x, y, tw, 13);
      ctx.fillStyle = '#08121c';
      ctx.fillText(label, x + 4, y + 2);
    });
    ctx.restore();
  }
}

registerTool(new CropTool());
registerTool(new PerspectiveCropTool());
registerTool(new SliceTool());
