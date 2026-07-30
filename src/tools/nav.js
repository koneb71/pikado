import { Tool, registerTool } from './base.js';
import { app } from '../core/app.js';
import { deg2rad, rad2deg } from '../core/util.js';

/**
 * Navigation tools: Hand, Rotate View and Zoom.
 *
 * None of these touch pixels — they only move `app.viewport`, so they never
 * open an edit or record history.
 */

function viewChanged() {
  app.emit('view-change');
  app.requestRender();
}

/** Zoom so `rect` (document space) fills the viewport. */
function zoomToDocRect(vp, rect) {
  const pad = 12;
  const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
  const s = Math.min((vp.viewWidth - pad * 2) / w, (vp.viewHeight - pad * 2) / h);
  vp.setScale(s);
  const c = vp.toScreen(rect.x + w / 2, rect.y + h / 2);
  vp.offsetX += vp.viewWidth / 2 - c.x;
  vp.offsetY += vp.viewHeight / 2 - c.y;
}

function fitScreen() {
  app.fitView(16);
}

function fillScreen() {
  const doc = app.activeDoc;
  if (!doc) return;
  app.viewport.fillScreen(doc.width, doc.height);
  viewChanged();
}

function actualPixels() {
  const doc = app.activeDoc;
  if (!doc) return;
  app.viewport.setScale(1);
  viewChanged();
}

const VIEW_BUTTONS = [
  { type: 'button', label: 'Fit Screen', onClick: fitScreen },
  { type: 'button', label: 'Fill Screen', onClick: fillScreen },
  { type: 'button', label: '100%', onClick: actualPixels },
];

/* ------------------------------------------------------------------ */
/* Hand                                                                */
/* ------------------------------------------------------------------ */

class HandTool extends Tool {
  constructor() {
    super({
      id: 'hand',
      name: 'Hand Tool',
      icon: 'hand',
      cursor: 'grab',
      shortcut: 'H',
      group: 'nav',
      groupOrder: 18,
      options: [...VIEW_BUTTONS],
    });
    this.pan = null;
  }

  onPointerDown(e) {
    const vp = this.app.viewport;
    this.pan = { sx: e.sx, sy: e.sy, ox: vp.offsetX, oy: vp.offsetY };
  }

  onPointerMove(e) {
    if (!this.pan) return;
    const vp = this.app.viewport;
    vp.offsetX = this.pan.ox + (e.sx - this.pan.sx);
    vp.offsetY = this.pan.oy + (e.sy - this.pan.sy);
    viewChanged();
  }

  onPointerUp() {
    this.pan = null;
  }

  onDoubleClick() {
    this.pan = null;
    fitScreen();
  }
}

/* ------------------------------------------------------------------ */
/* Rotate view                                                         */
/* ------------------------------------------------------------------ */

class RotateViewTool extends Tool {
  constructor() {
    super({
      id: 'rotate-view',
      name: 'Rotate View Tool',
      icon: 'rotate-view',
      cursor: 'crosshair',
      // R belongs to the focus group; this tool is reached by cycling the nav
      // group with Shift+H (hand -> rotate view -> zoom).
      shortcut: 'H',
      group: 'nav',
      groupOrder: 18,
      options: [
        { key: 'angle', type: 'number', label: 'Rotation Angle', min: -360, max: 360, step: 1, unit: '°', default: 0 },
        { type: 'button', label: 'Reset View', onClick: () => rotateViewTool.reset() },
      ],
    });
    this.spin = null;
  }

  onActivate() {
    this.state.angle = Math.round(rad2deg(this.app.viewport.rotation));
  }

  onOptionChange(key, value) {
    if (key !== 'angle') return;
    this.app.viewport.setRotation(deg2rad(Number(value) || 0));
    viewChanged();
  }

  reset() {
    this.state.angle = 0;
    this.app.viewport.setRotation(0);
    this.app.emit('tool-options', this);
    viewChanged();
  }

  centre() {
    const vp = this.app.viewport;
    return { x: vp.viewWidth / 2, y: vp.viewHeight / 2 };
  }

  onPointerDown(e) {
    const c = this.centre();
    this.spin = {
      a0: Math.atan2(e.sy - c.y, e.sx - c.x),
      start: this.app.viewport.rotation,
    };
  }

  onPointerMove(e) {
    if (!this.spin) return;
    const c = this.centre();
    const a1 = Math.atan2(e.sy - c.y, e.sx - c.x);
    let rot = this.spin.start + (a1 - this.spin.a0);
    if (e.shiftKey) rot = deg2rad(Math.round(rad2deg(rot) / 15) * 15);
    this.app.viewport.setRotation(rot);
    this.state.angle = Math.round(rad2deg(rot));
    this.app.emit('tool-options', this);
    viewChanged();
  }

  onPointerUp() {
    this.spin = null;
  }

  onDoubleClick() {
    this.spin = null;
    this.reset();
  }

  onKeyDown(e) {
    if (e.key !== 'Escape') return false;
    this.reset();
    return true;
  }

  cancel() {
    this.reset();
  }

  drawOverlay(ctx) {
    if (!this.spin) return;
    const c = this.centre();
    const rot = this.app.viewport.rotation;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.strokeStyle = 'rgba(255,255,255,.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, 56, 0, Math.PI * 2);
    ctx.stroke();
    ctx.rotate(rot);
    ctx.strokeStyle = '#1473e6';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -56);
    ctx.stroke();
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ */
/* Zoom                                                                */
/* ------------------------------------------------------------------ */

class ZoomTool extends Tool {
  constructor() {
    super({
      id: 'zoom',
      name: 'Zoom Tool',
      icon: 'zoom',
      cursor: 'zoom-in',
      shortcut: 'Z',
      group: 'nav',
      groupOrder: 18,
      options: [
        {
          key: 'dir', type: 'radio', label: '', default: 'in',
          options: [{ value: 'in', label: 'Zoom In' }, { value: 'out', label: 'Zoom Out' }],
        },
        {
          key: 'resizeWindows', type: 'checkbox', default: false,
          label: 'Resize Windows to Fit',
          hint: 'Re-centres the document after zooming when it fits on screen.',
        },
        ...VIEW_BUTTONS,
      ],
    });
    this.marquee = null;
  }

  getCursor() {
    return this.state.dir === 'out' ? 'zoom-out' : 'zoom-in';
  }

  onPointerDown(e) {
    this.marquee = { x0: e.sx, y0: e.sy, x1: e.sx, y1: e.sy, dragged: false };
  }

  onPointerMove(e) {
    if (!this.marquee) return;
    this.marquee.x1 = e.sx;
    this.marquee.y1 = e.sy;
    if (Math.hypot(e.sx - this.marquee.x0, e.sy - this.marquee.y0) > 6) this.marquee.dragged = true;
    this.app.requestRender();
  }

  onPointerUp(e) {
    const m = this.marquee;
    this.marquee = null;
    if (!m) return;
    const vp = this.app.viewport;

    if (m.dragged) {
      const a = vp.toDoc(m.x0, m.y0);
      const b = vp.toDoc(m.x1, m.y1);
      const c = vp.toDoc(m.x0, m.y1);
      const d = vp.toDoc(m.x1, m.y0);
      const xs = [a.x, b.x, c.x, d.x], ys = [a.y, b.y, c.y, d.y];
      zoomToDocRect(vp, {
        x: Math.min(...xs), y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      });
    } else {
      const out = this.state.dir === 'out' ? !e.altKey : e.altKey;
      vp.zoomStep(out ? -1 : 1, m.x0, m.y0);
    }

    if (this.state.resizeWindows) this.recentre();
    viewChanged();
  }

  /** Keep the whole document centred once it fits inside the viewport. */
  recentre() {
    const doc = this.app.activeDoc;
    const vp = this.app.viewport;
    if (!doc) return;
    if (doc.width * vp.scale <= vp.viewWidth && doc.height * vp.scale <= vp.viewHeight) {
      vp.center(doc.width, doc.height);
    }
  }

  onDoubleClick() {
    this.marquee = null;
    actualPixels();
  }

  onKeyDown(e) {
    if (e.key === 'Escape' && this.marquee) {
      this.marquee = null;
      this.app.requestRender();
      return true;
    }
    return false;
  }

  cancel() {
    this.marquee = null;
  }

  drawOverlay(ctx) {
    const m = this.marquee;
    if (!m || !m.dragged) return;
    const x = Math.min(m.x0, m.x1), y = Math.min(m.y0, m.y1);
    const w = Math.abs(m.x1 - m.x0), h = Math.abs(m.y1 - m.y0);
    ctx.save();
    ctx.fillStyle = 'rgba(20,115,230,.14)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.restore();
  }
}

registerTool(new HandTool());
const rotateViewTool = registerTool(new RotateViewTool());
registerTool(new ZoomTool());
