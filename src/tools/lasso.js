import { registerTool } from './base.js';
import { SelectionTool, strokeDashedPoly, toScreenPoints } from './marquee.js';
import { getComposite } from '../render/compositor.js';
import { ctx2dRead } from '../core/util.js';

/**
 * Lasso family: freehand, polygonal and magnetic.
 *
 * All three build a document-space polygon and hand it to `SelectionTool`
 * for rasterisation, feathering and the history commit.
 */

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function polyPath(points) {
  const p = new Path2D();
  p.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) p.lineTo(points[i].x, points[i].y);
  p.closePath();
  return p;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Small square marker used to show "click here to close the path". */
function drawCloseMarker(ctx, pt) {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  ctx.strokeStyle = '#000';
  ctx.beginPath();
  ctx.rect(pt.x - 3.5, pt.y - 3.5, 7, 7);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawAnchors(ctx, pts) {
  ctx.save();
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = 'rgba(0,0,0,.8)';
  for (const p of pts) {
    ctx.beginPath();
    ctx.rect(p.x - 2, p.y - 2, 4, 4);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Freehand lasso                                                      */
/* ------------------------------------------------------------------ */

class LassoTool extends SelectionTool {
  constructor() {
    super({
      id: 'lasso', name: 'Lasso Tool', icon: 'lasso', shortcut: 'L',
      group: 'lasso', groupOrder: 2,
    });
    this.points = [];
    this.dragMode = 'replace';
    this.dragging = false;
  }

  onPointerDown(e) {
    if (!this.doc) return;
    this.dragging = true;
    this.dragMode = this.modeFor(e);
    this.points = [{ x: e.x, y: e.y }];
    this.preview();
  }

  onPointerMove(e) {
    if (!this.dragging) return;
    const last = this.points[this.points.length - 1];
    // ~1 screen pixel of travel, so zoomed-in strokes stay smooth.
    const min = 1 / Math.max(0.02, this.app.viewport.scale);
    if (Math.hypot(e.x - last.x, e.y - last.y) < min) return;
    this.points.push({ x: e.x, y: e.y });
    this.preview();
  }

  onPointerUp() {
    if (!this.dragging) return;
    this.dragging = false;
    const pts = this.points;
    this.points = [];
    if (pts.length < 3) {
      this.clearSelection();
      this.preview();
      return;
    }
    this.applyPath(polyPath(pts), this.dragMode, 'Lasso');
  }

  cancel() {
    if (!this.dragging) return;
    this.dragging = false;
    this.points = [];
    this.preview();
  }

  drawOverlay(ctx, view) {
    if (!this.dragging || this.points.length < 2) return;
    strokeDashedPoly(ctx, toScreenPoints(view, this.points), true);
  }
}

/* ------------------------------------------------------------------ */
/* Polygonal lasso                                                     */
/* ------------------------------------------------------------------ */

class PolyLassoTool extends SelectionTool {
  constructor() {
    super({
      id: 'lasso-poly', name: 'Polygonal Lasso Tool', icon: 'lasso-poly', shortcut: 'L',
      group: 'lasso', groupOrder: 2,
    });
    this.points = [];
    this.hover = null;
    this.active = false;
    this.dragMode = 'replace';
  }

  onDeactivate() {
    this.reset();
  }

  reset() {
    this.points = [];
    this.active = false;
    this.hover = null;
  }

  onPointerDown(e) {
    if (!this.doc) return;
    if (!this.active) {
      this.active = true;
      this.dragMode = this.modeFor(e);
      this.points = [{ x: e.x, y: e.y }];
      this.hover = { x: e.x, y: e.y };
      this.preview();
    }
  }

  onPointerMove(e) {
    this.hover = { x: e.x, y: e.y };
    if (this.active) this.preview();
  }

  onPointerUp(e) {
    if (!this.active) return;
    const pt = { x: e.x, y: e.y };
    if (this.points.length > 2 && this.screenDist(this.points[0], e.sx, e.sy) <= 8) {
      this.close();
      return;
    }
    const last = this.points[this.points.length - 1];
    // Ignore the release that belongs to the click which opened the path.
    if (last && this.screenDist(last, e.sx, e.sy) < 3) {
      this.preview();
      return;
    }
    this.points.push(pt);
    this.preview();
  }

  onDoubleClick() {
    if (this.active) this.close();
  }

  onKeyDown(e) {
    if (!this.active) return false;
    if (e.key === 'Enter') { this.close(); return true; }
    if (e.key === 'Escape') { this.cancel(); return true; }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      if (this.points.length > 1) this.points.pop();
      else this.cancel();
      this.preview();
      return true;
    }
    return false;
  }

  close() {
    const pts = this.points;
    this.reset();
    if (pts.length < 3) {
      this.preview();
      return;
    }
    this.applyPath(polyPath(pts), this.dragMode, 'Polygonal Lasso');
  }

  commit() {
    if (this.active) this.close();
  }

  cancel() {
    if (!this.active) return;
    this.reset();
    this.preview();
  }

  drawOverlay(ctx, view) {
    if (!this.active || !this.points.length) return;
    const scr = toScreenPoints(view, this.points);
    const cursor = this.hover ? view.toScreen(this.hover.x, this.hover.y) : null;
    const rubber = cursor ? [...scr, cursor] : scr;
    strokeDashedPoly(ctx, rubber, rubber.length > 2);
    drawAnchors(ctx, scr);
    if (this.points.length > 2 && cursor && Math.hypot(cursor.x - scr[0].x, cursor.y - scr[0].y) <= 8) {
      drawCloseMarker(ctx, scr[0]);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Magnetic lasso                                                      */
/* ------------------------------------------------------------------ */

/** Sobel gradient magnitude (0..255) of a canvas, used for edge snapping. */
function sobelMagnitude(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const d = ctx2dRead(canvas).getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    lum[p] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) * (d[i + 3] / 255);
  }
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -lum[i - w - 1] - 2 * lum[i - 1] - lum[i + w - 1]
        + lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1];
      const gy = -lum[i - w - 1] - 2 * lum[i - w] - lum[i - w + 1]
        + lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1];
      const m = Math.sqrt(gx * gx + gy * gy) / 4;
      mag[i] = m > 255 ? 255 : m;
    }
  }
  return { w, h, mag };
}

class MagneticLassoTool extends SelectionTool {
  constructor() {
    super({
      id: 'lasso-magnetic', name: 'Magnetic Lasso Tool', icon: 'lasso-magnetic', shortcut: 'L',
      group: 'lasso', groupOrder: 2,
      options: [
        { key: 'width', label: 'Width', type: 'slider', min: 1, max: 256, step: 1, default: 10, unit: 'px' },
        { key: 'contrast', label: 'Contrast', type: 'slider', min: 1, max: 100, step: 1, default: 10, unit: '%' },
        { key: 'frequency', label: 'Frequency', type: 'slider', min: 0, max: 100, step: 1, default: 57 },
      ],
    });
    this.anchors = [];
    this.hover = null;
    this.active = false;
    this.edge = null;
    this.dragMode = 'replace';
  }

  onDeactivate() {
    this.reset();
  }

  reset() {
    this.anchors = [];
    this.active = false;
    this.hover = null;
    this.edge = null;
  }

  /** Anchor spacing in document pixels: higher frequency = more anchors. */
  spacing() {
    const f = Math.max(0, Math.min(100, Number(this.state.frequency) || 0));
    return Math.max(2, 42 - f * 0.4);
  }

  onPointerDown(e) {
    const doc = this.doc;
    if (!doc) return;
    if (!this.active) {
      this.active = true;
      this.dragMode = this.modeFor(e);
      // The edge map is expensive, so it is built once per path.
      this.edge = sobelMagnitude(getComposite(doc));
      this.anchors = [{ x: e.x, y: e.y }];
      this.hover = { x: e.x, y: e.y };
      this.preview();
      return;
    }
    if (this.anchors.length > 2 && this.screenDist(this.anchors[0], e.sx, e.sy) <= 8) {
      this.close();
      return;
    }
    // A click drops a manual anchor exactly where the user asked.
    this.anchors.push({ x: e.x, y: e.y });
    this.preview();
  }

  onPointerMove(e) {
    this.hover = { x: e.x, y: e.y };
    if (!this.active) return;
    const step = this.spacing();
    let last = this.anchors[this.anchors.length - 1];
    let guard = 0;
    while (dist(last, this.hover) >= step && guard++ < 64) {
      const d = dist(last, this.hover);
      const dir = { x: (this.hover.x - last.x) / d, y: (this.hover.y - last.y) / d };
      const target = { x: last.x + dir.x * step, y: last.y + dir.y * step };
      const snapped = this.snapToEdge(target, dir);
      this.anchors.push(snapped);
      last = snapped;
    }
    this.preview();
  }

  /**
   * Search `width` px perpendicular to the travel direction and return the
   * strongest gradient above the contrast threshold, or `pt` when the area is
   * flat.
   */
  snapToEdge(pt, dir) {
    const em = this.edge;
    if (!em) return pt;
    const width = Math.max(1, Number(this.state.width) || 10);
    const threshold = (Math.max(1, Number(this.state.contrast) || 1) / 100) * 255 * 0.5;
    const nx = -dir.y;
    const ny = dir.x;
    let best = null;
    let bestScore = 0;
    for (let s = -width; s <= width; s++) {
      const fx = pt.x + nx * s;
      const fy = pt.y + ny * s;
      const x = Math.round(fx);
      const y = Math.round(fy);
      if (x < 0 || y < 0 || x >= em.w || y >= em.h) continue;
      const m = em.mag[y * em.w + x];
      if (m < threshold) continue;
      // Prefer strong edges, but bias towards the cursor's own track.
      const score = m * (1 - (0.5 * Math.abs(s)) / width);
      if (score > bestScore) {
        bestScore = score;
        best = { x: fx, y: fy };
      }
    }
    return best || pt;
  }

  onDoubleClick() {
    if (this.active) this.close();
  }

  onKeyDown(e) {
    if (!this.active) return false;
    if (e.key === 'Enter') { this.close(); return true; }
    if (e.key === 'Escape') { this.cancel(); return true; }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      if (this.anchors.length > 1) this.anchors.pop();
      else this.cancel();
      this.preview();
      return true;
    }
    return false;
  }

  close() {
    const pts = this.anchors;
    this.reset();
    if (pts.length < 3) {
      this.preview();
      return;
    }
    this.applyPath(polyPath(pts), this.dragMode, 'Magnetic Lasso');
  }

  commit() {
    if (this.active) this.close();
  }

  cancel() {
    if (!this.active) return;
    this.reset();
    this.preview();
  }

  drawOverlay(ctx, view) {
    if (!this.active || !this.anchors.length) return;
    const scr = toScreenPoints(view, this.anchors);
    const live = this.hover ? [...scr, view.toScreen(this.hover.x, this.hover.y)] : scr;
    strokeDashedPoly(ctx, live, live.length > 2);
    drawAnchors(ctx, scr);
    if (this.anchors.length > 2) drawCloseMarker(ctx, scr[0]);
  }
}

registerTool(new LassoTool());
registerTool(new PolyLassoTool());
registerTool(new MagneticLassoTool());
