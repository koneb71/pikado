import { Tool, registerTool } from './base.js';
import { app } from '../core/app.js';
import { createCanvas, clamp, uid, rad2deg } from '../core/util.js';
import { rgb, toCss } from '../core/color.js';
import { getComposite } from '../render/compositor.js';
import { promptDialog } from '../ui/dialog.js';

/**
 * The eyedropper fly-out: colour picker, colour samplers, ruler and notes.
 *
 * Samplers, the measurement line and notes live on the document
 * (`doc.colorSamplers`, `doc.measurement`, `doc.notes`) but are annotations
 * rather than pixels, so they update through `doc.touch()` and never open an
 * edit.
 */

/* ------------------------------------------------------------------ */
/* Sampling                                                            */
/* ------------------------------------------------------------------ */

/** Source canvas the sampling tools read from. */
function sampleSource(doc, source) {
  if (source === 'layer') {
    const l = doc.activeLayer();
    return l && l.canvas ? l.canvas : null;
  }
  return getComposite(doc);
}

/**
 * Average the colour over an `size x size` neighbourhood, weighting RGB by
 * alpha so transparent pixels do not darken the result.
 * @returns {{r,g,b,a}|null}
 */
export function sampleColor(doc, x, y, size = 1, source = 'all') {
  const src = sampleSource(doc, source);
  if (!src) return null;
  const r = Math.floor(Math.max(1, size) / 2);
  const cx = Math.floor(x), cy = Math.floor(y);
  const x0 = clamp(cx - r, 0, src.width - 1);
  const y0 = clamp(cy - r, 0, src.height - 1);
  const x1 = clamp(cx + r, 0, src.width - 1);
  const y1 = clamp(cy + r, 0, src.height - 1);
  if (cx < 0 || cy < 0 || cx >= src.width || cy >= src.height) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const d = src.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, w, h).data;
  let sr = 0, sg = 0, sb = 0, sa = 0;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    sr += d[i] * a;
    sg += d[i + 1] * a;
    sb += d[i + 2] * a;
    sa += a;
  }
  if (sa <= 0) return rgb(0, 0, 0, 0);
  return rgb(Math.round(sr / sa), Math.round(sg / sa), Math.round(sb / sa), sa / (w * h));
}

/* ------------------------------------------------------------------ */
/* Eyedropper                                                          */
/* ------------------------------------------------------------------ */

const SAMPLE_SIZES = [
  { value: 1, label: 'Point Sample' },
  { value: 3, label: '3 by 3 Average' },
  { value: 5, label: '5 by 5 Average' },
  { value: 11, label: '11 by 11 Average' },
  { value: 31, label: '31 by 31 Average' },
  { value: 51, label: '51 by 51 Average' },
  { value: 101, label: '101 by 101 Average' },
];

class EyedropperTool extends Tool {
  constructor() {
    super({
      id: 'eyedropper',
      name: 'Eyedropper Tool',
      icon: 'eyedropper',
      cursor: 'crosshair',
      shortcut: 'I',
      group: 'eyedropper',
      groupOrder: 5,
      options: [
        { key: 'sampleSize', type: 'select', label: 'Sample Size', default: 1, options: SAMPLE_SIZES },
        {
          key: 'sample', type: 'select', label: 'Sample', default: 'all',
          options: [{ value: 'all', label: 'All Layers' }, { value: 'layer', label: 'Current Layer' }],
        },
        { key: 'showRing', type: 'checkbox', label: 'Show Sampling Ring', default: true },
      ],
    });
    this.hover = null;
    this.sampling = false;
  }

  pick(e) {
    const doc = this.doc;
    if (!doc) return;
    const c = sampleColor(doc, e.x, e.y, Number(this.state.sampleSize) || 1, this.state.sample);
    if (!c) return;
    const solid = rgb(c.r, c.g, c.b, 1);
    if (e.altKey) this.app.setBackground(solid);
    else this.app.setForeground(solid);
    this.hover = { sx: e.sx, sy: e.sy, x: e.x, y: e.y, color: solid };
  }

  onPointerDown(e) {
    this.sampling = true;
    this.pick(e);
    this.app.requestRender();
  }

  onPointerMove(e) {
    if (!this.sampling) return;
    this.pick(e);
    this.app.requestRender();
  }

  onPointerUp() {
    this.sampling = false;
    this.hover = null;
    this.app.requestRender();
  }

  cancel() {
    this.sampling = false;
    this.hover = null;
  }

  drawOverlay(ctx) {
    if (!this.state.showRing || !this.sampling || !this.hover) return;
    const doc = this.doc;
    if (!doc) return;
    const { sx, sy, x, y, color } = this.hover;
    const R1 = 34, R2 = 48;
    const zoom = 8;
    const src = sampleSource(doc, this.state.sample);

    ctx.save();
    // Magnified pixels inside the ring.
    if (src) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(sx, sy, R1, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = '#3a3a3a';
      ctx.fillRect(sx - R1, sy - R1, R1 * 2, R1 * 2);
      const span = (R1 * 2) / zoom;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(
        src,
        Math.floor(x) - span / 2, Math.floor(y) - span / 2, span, span,
        sx - R1, sy - R1, R1 * 2, R1 * 2
      );
      // Crosshair on the sampled pixel.
      ctx.strokeStyle = 'rgba(0,0,0,.6)';
      ctx.lineWidth = 1;
      ctx.strokeRect(sx - zoom / 2 + 0.5, sy - zoom / 2 + 0.5, zoom, zoom);
      ctx.restore();
    }

    const half = (from, to, fill) => {
      ctx.beginPath();
      ctx.arc(sx, sy, R2, from, to, false);
      ctx.arc(sx, sy, R1, to, from, true);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    };
    half(Math.PI, Math.PI * 2, toCss(color));
    half(0, Math.PI, toCss(this.app.foreground));

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(20,20,20,.9)';
    ctx.beginPath();
    ctx.arc(sx, sy, R2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(sx, sy, R1, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ */
/* Colour sampler                                                      */
/* ------------------------------------------------------------------ */

const MAX_SAMPLERS = 10;

function samplersOf(doc) {
  if (!doc.colorSamplers) doc.colorSamplers = [];
  return doc.colorSamplers;
}

class ColorSamplerTool extends Tool {
  constructor() {
    super({
      id: 'color-sampler',
      name: 'Color Sampler Tool',
      icon: 'color-sampler',
      cursor: 'crosshair',
      shortcut: 'I',
      group: 'eyedropper',
      groupOrder: 5,
      options: [
        { key: 'sampleSize', type: 'select', label: 'Sample Size', default: 1, options: SAMPLE_SIZES },
        {
          key: 'sample', type: 'select', label: 'Sample', default: 'all',
          options: [{ value: 'all', label: 'All Layers' }, { value: 'layer', label: 'Current Layer' }],
        },
        {
          type: 'button', label: 'Clear All',
          onClick: () => {
            const doc = app.activeDoc;
            if (!doc) return;
            doc.colorSamplers = [];
            doc.touch('samplers');
          },
        },
      ],
    });
    this.drag = null;
  }

  indexAt(doc, e, view) {
    const list = samplersOf(doc);
    for (let i = list.length - 1; i >= 0; i--) {
      const p = view.toScreen(list[i].x, list[i].y);
      if (Math.hypot(e.sx - p.x, e.sy - p.y) <= 9) return i;
    }
    return -1;
  }

  onPointerDown(e) {
    const doc = this.doc;
    if (!doc) return;
    const list = samplersOf(doc);
    const i = this.indexAt(doc, e, this.app.viewport);
    if (e.altKey) {
      if (i >= 0) {
        list.splice(i, 1);
        doc.touch('samplers');
      }
      return;
    }
    if (i >= 0) {
      this.drag = i;
      return;
    }
    if (list.length >= MAX_SAMPLERS) {
      this.app.toast(`A document can hold ${MAX_SAMPLERS} colour samplers.`);
      return;
    }
    list.push({ x: Math.round(e.x), y: Math.round(e.y) });
    this.drag = list.length - 1;
    doc.touch('samplers');
  }

  onPointerMove(e) {
    if (this.drag == null) return;
    const doc = this.doc;
    const s = samplersOf(doc)[this.drag];
    if (!s) return;
    s.x = clamp(Math.round(e.x), 0, doc.width - 1);
    s.y = clamp(Math.round(e.y), 0, doc.height - 1);
    doc.touch('samplers');
  }

  onPointerUp() {
    this.drag = null;
  }

  drawOverlay(ctx, view) {
    const doc = this.doc;
    if (!doc) return;
    const list = samplersOf(doc);
    ctx.save();
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const size = Number(this.state.sampleSize) || 1;
    list.forEach((s, i) => {
      const p = view.toScreen(s.x + 0.5, s.y + 0.5);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,.75)';
      crosshair(ctx, p);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = '#ffffff';
      crosshair(ctx, p);
      const label = String(i + 1);
      ctx.fillStyle = 'rgba(0,0,0,.75)';
      ctx.fillRect(p.x + 7, p.y - 13, 22, 12);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, p.x + 10, p.y - 6.5);
      const c = sampleColor(doc, s.x, s.y, size, this.state.sample);
      if (c) {
        ctx.fillStyle = toCss(rgb(c.r, c.g, c.b, 1));
        ctx.fillRect(p.x + 18, p.y - 11, 9, 8);
        ctx.strokeStyle = 'rgba(255,255,255,.55)';
        ctx.lineWidth = 1;
        ctx.strokeRect(p.x + 18.5, p.y - 10.5, 8, 7);
      }
    });
    ctx.restore();
  }
}

function crosshair(ctx, p) {
  ctx.beginPath();
  ctx.moveTo(p.x - 8, p.y);
  ctx.lineTo(p.x - 2, p.y);
  ctx.moveTo(p.x + 2, p.y);
  ctx.lineTo(p.x + 8, p.y);
  ctx.moveTo(p.x, p.y - 8);
  ctx.lineTo(p.x, p.y - 2);
  ctx.moveTo(p.x, p.y + 2);
  ctx.lineTo(p.x, p.y + 8);
  ctx.stroke();
}

/* ------------------------------------------------------------------ */
/* Ruler                                                               */
/* ------------------------------------------------------------------ */

/**
 * Rotate every layer so the measured line becomes horizontal (or vertical,
 * whichever is closer), expanding the canvas to fit — Photoshop's
 * "Straighten Layer".
 */
export function straightenFromRuler(doc) {
  const m = doc && doc.measurement;
  if (!m) {
    app.toast('Drag the Ruler tool along the edge you want to straighten first.');
    return false;
  }
  let rot = -Math.atan2(m.y2 - m.y1, m.x2 - m.x1);
  while (rot > Math.PI / 4) rot -= Math.PI / 2;
  while (rot < -Math.PI / 4) rot += Math.PI / 2;
  if (Math.abs(rot) < 1e-4) {
    app.toast('The measurement is already straight.');
    return false;
  }

  const cos = Math.abs(Math.cos(rot)), sin = Math.abs(Math.sin(rot));
  const w = doc.width, h = doc.height;
  const nw = Math.max(1, Math.ceil(w * cos + h * sin));
  const nh = Math.max(1, Math.ceil(w * sin + h * cos));

  const spin = (src) => {
    if (!src) return null;
    const out = createCanvas(nw, nh);
    const c = out.getContext('2d');
    c.imageSmoothingQuality = 'high';
    c.translate(nw / 2, nh / 2);
    c.rotate(rot);
    c.translate(-w / 2, -h / 2);
    c.drawImage(src, 0, 0);
    return out;
  };

  doc.beginEdit(doc.flatLayers());
  for (const l of doc.flatLayers()) {
    if (l.canvas) l.canvas = spin(l.canvas);
    if (l.mask) { l.mask = spin(l.mask); l.touchMask(); }
  }
  const mapPoint = (px, py) => {
    const dx = px - w / 2, dy = py - h / 2;
    return {
      x: nw / 2 + dx * Math.cos(rot) - dy * Math.sin(rot),
      y: nh / 2 + dx * Math.sin(rot) + dy * Math.cos(rot),
    };
  };
  const a = mapPoint(m.x1, m.y1), b = mapPoint(m.x2, m.y2);
  doc.measurement = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };

  doc.width = nw;
  doc.height = nh;
  doc.selection.resize(nw, nh);
  doc.selection.clear();
  doc.invalidate();
  doc.emit('resize');
  doc.commit('Straighten Layer');
  app.fitView();
  return true;
}

class RulerTool extends Tool {
  constructor() {
    super({
      id: 'ruler',
      name: 'Ruler Tool',
      icon: 'ruler',
      cursor: 'crosshair',
      shortcut: 'I',
      group: 'eyedropper',
      groupOrder: 5,
      options: [
        { type: 'button', label: 'Straighten Layer', onClick: () => straightenFromRuler(app.activeDoc) },
        {
          type: 'button', label: 'Clear',
          onClick: () => {
            const doc = app.activeDoc;
            if (!doc) return;
            doc.measurement = null;
            doc.touch('measure');
          },
        },
      ],
    });
    this.drag = null;
  }

  onPointerDown(e) {
    const doc = this.doc;
    if (!doc) return;
    const m = doc.measurement;
    const view = this.app.viewport;
    if (m) {
      const p1 = view.toScreen(m.x1, m.y1);
      const p2 = view.toScreen(m.x2, m.y2);
      if (Math.hypot(e.sx - p1.x, e.sy - p1.y) <= 8) { this.drag = 'start'; return; }
      if (Math.hypot(e.sx - p2.x, e.sy - p2.y) <= 8) { this.drag = 'end'; return; }
    }
    doc.measurement = { x1: e.x, y1: e.y, x2: e.x, y2: e.y };
    this.drag = 'end';
    doc.touch('measure');
  }

  onPointerMove(e) {
    if (!this.drag) return;
    const doc = this.doc;
    const m = doc.measurement;
    if (!m) return;
    let x = e.x, y = e.y;
    if (e.shiftKey) {
      const ax = this.drag === 'end' ? m.x1 : m.x2;
      const ay = this.drag === 'end' ? m.y1 : m.y2;
      const dx = x - ax, dy = y - ay;
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      x = ax + Math.cos(ang) * len;
      y = ay + Math.sin(ang) * len;
    }
    if (this.drag === 'start') { m.x1 = x; m.y1 = y; } else { m.x2 = x; m.y2 = y; }
    doc.touch('measure');
  }

  onPointerUp() {
    this.drag = null;
  }

  onKeyDown(e) {
    const doc = this.doc;
    if (!doc || !doc.measurement) return false;
    if (e.key !== 'Delete' && e.key !== 'Backspace' && e.key !== 'Escape') return false;
    doc.measurement = null;
    doc.touch('measure');
    return true;
  }

  drawOverlay(ctx, view) {
    const doc = this.doc;
    const m = doc && doc.measurement;
    if (!m) return;
    const p1 = view.toScreen(m.x1, m.y1);
    const p2 = view.toScreen(m.x2, m.y2);
    const dx = m.x2 - m.x1, dy = m.y2 - m.y1;
    const dist = Math.hypot(dx, dy);
    const ang = -rad2deg(Math.atan2(dy, dx));

    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    for (const p of [p1, p2]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.8)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    const text = `${dist.toFixed(1)} px   ${ang.toFixed(1)}°`;
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    const tw = ctx.measureText(text).width;
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    ctx.fillStyle = 'rgba(0,0,0,.75)';
    ctx.fillRect(mx - tw / 2 - 5, my - 24, tw + 10, 17);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, mx - tw / 2, my - 15.5);
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ */
/* Note                                                                */
/* ------------------------------------------------------------------ */

function notesOf(doc) {
  if (!doc.notes) doc.notes = [];
  return doc.notes;
}

class NoteTool extends Tool {
  constructor() {
    super({
      id: 'note',
      name: 'Note Tool',
      icon: 'note',
      cursor: 'crosshair',
      shortcut: 'I',
      group: 'eyedropper',
      groupOrder: 5,
      options: [
        { key: 'author', type: 'text', label: 'Author', default: 'Me' },
        { type: 'label', label: 'Click to place a note, double-click to edit it.' },
        {
          type: 'button', label: 'Delete All Notes',
          onClick: () => {
            const doc = app.activeDoc;
            if (!doc) return;
            doc.notes = [];
            noteTool.selectedId = null;
            doc.touch('notes');
          },
        },
      ],
    });
    this.selectedId = null;
    this.drag = null;
    /** Guards the second half of a double-click from dropping a second note. */
    this.justCreated = null;
  }

  noteAt(doc, e, view) {
    const list = notesOf(doc);
    for (let i = list.length - 1; i >= 0; i--) {
      const p = view.toScreen(list[i].x, list[i].y);
      if (e.sx >= p.x - 2 && e.sx <= p.x + 20 && e.sy >= p.y - 20 && e.sy <= p.y + 2) return list[i];
    }
    return null;
  }

  onPointerDown(e) {
    const doc = this.doc;
    if (!doc) return;
    const hit = this.noteAt(doc, e, this.app.viewport);
    if (hit && e.altKey) {
      const list = notesOf(doc);
      list.splice(list.indexOf(hit), 1);
      if (this.selectedId === hit.id) this.selectedId = null;
      doc.touch('notes');
      return;
    }
    if (hit) {
      this.selectedId = hit.id;
      this.drag = { note: hit, ox: hit.x - e.x, oy: hit.y - e.y };
      doc.touch('notes');
      return;
    }
    // The second press of a double-click lands here too — reuse the note the
    // first press created instead of stacking a duplicate on top of it.
    const jc = this.justCreated;
    if (jc && performance.now() - jc.t < 600 && Math.hypot(e.sx - jc.sx, e.sy - jc.sy) < 8) {
      const prev = notesOf(doc).find((n) => n.id === jc.id);
      if (prev) {
        this.selectedId = prev.id;
        this.drag = { note: prev, ox: prev.x - e.x, oy: prev.y - e.y };
        return;
      }
    }
    const note = { id: uid('note'), x: Math.round(e.x), y: Math.round(e.y), text: '', author: this.state.author || 'Me' };
    notesOf(doc).push(note);
    this.selectedId = note.id;
    this.justCreated = { id: note.id, t: performance.now(), sx: e.sx, sy: e.sy };
    this.drag = { note, ox: note.x - e.x, oy: note.y - e.y };
    doc.touch('notes');
  }

  onPointerMove(e) {
    if (!this.drag) return;
    const doc = this.doc;
    this.drag.note.x = Math.round(e.x + this.drag.ox);
    this.drag.note.y = Math.round(e.y + this.drag.oy);
    doc.touch('notes');
  }

  onPointerUp() {
    this.drag = null;
  }

  async onDoubleClick(e) {
    const doc = this.doc;
    if (!doc) return;
    const hit = this.noteAt(doc, e, this.app.viewport) || notesOf(doc).find((n) => n.id === this.selectedId);
    if (hit) await this.edit(doc, hit);
  }

  async edit(doc, note) {
    const text = await promptDialog(`Note by ${note.author}`, note.text, 'Note');
    if (text == null) return;
    note.text = text;
    doc.touch('notes');
  }

  onKeyDown(e) {
    const doc = this.doc;
    if (!doc || !this.selectedId) return false;
    if (e.key !== 'Delete' && e.key !== 'Backspace') return false;
    const list = notesOf(doc);
    const i = list.findIndex((n) => n.id === this.selectedId);
    if (i < 0) return false;
    list.splice(i, 1);
    this.selectedId = null;
    doc.touch('notes');
    return true;
  }

  drawOverlay(ctx, view) {
    const doc = this.doc;
    if (!doc) return;
    const list = notesOf(doc);
    ctx.save();
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    list.forEach((n, i) => {
      const p = view.toScreen(n.x, n.y);
      const active = n.id === this.selectedId;
      const x = p.x, y = p.y - 18, w = 18, h = 18;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + w, y);
      ctx.lineTo(x + w, y + h - 6);
      ctx.lineTo(x + w - 6, y + h);
      ctx.lineTo(x, y + h);
      ctx.closePath();
      ctx.fillStyle = active ? '#ffd479' : '#f0c14b';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.75)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + 4, y + 5);
      ctx.lineTo(x + 14, y + 5);
      ctx.moveTo(x + 4, y + 9);
      ctx.lineTo(x + 12, y + 9);
      ctx.stroke();
      ctx.fillStyle = 'rgba(0,0,0,.8)';
      ctx.fillText(String(i + 1), x + w + 3, y + h / 2);

      if (active && n.text) {
        const lines = wrapText(ctx, n.text, 180);
        const bw = 190, bh = lines.length * 14 + 10;
        const bx = x, by = y - bh - 4;
        ctx.fillStyle = 'rgba(20,20,20,.9)';
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeStyle = 'rgba(255,255,255,.25)';
        ctx.strokeRect(bx + 0.5, by + 0.5, bw, bh);
        ctx.fillStyle = '#eaeaea';
        lines.forEach((ln, k) => ctx.fillText(ln, bx + 6, by + 12 + k * 14));
      }
    });
    ctx.restore();
  }
}

function wrapText(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 8);
}

registerTool(new EyedropperTool());
registerTool(new ColorSamplerTool());
registerTool(new RulerTool());
const noteTool = registerTool(new NoteTool());
