/**
 * The type tools: horizontal type, vertical type and the type mask.
 *
 * Editing uses a **real `<textarea>`** positioned inside `#canvas-overlay` and
 * transformed by the viewport matrix, so the browser owns the caret, text
 * selection, IME composition and the clipboard. Its glyphs are transparent —
 * what the user sees is the layer itself, re-rasterised through
 * `rasterizeTextLayer()` on every `input` event — so the caret and the
 * selection highlight always sit on top of the pixels that will be committed.
 *
 * Only one editing session exists at a time (module-level `session`), because
 * the tool that opened it may be swapped out from under it (the Move tool
 * starts editing on double-click through `editTextLayer()`).
 */

import { app } from '../core/app.js';
import { Tool, registerTool } from './base.js';
import { Layer, LayerType } from '../core/layer.js';
import { createCanvas, ctx2d, el, debounce } from '../core/util.js';
import { toHex, parseColor, toCss } from '../core/color.js';
import { paramDialog } from '../ui/dialog.js';
import { cmd, sep } from '../ui/canvas-menu.js';
import { formatAccel } from '../commands/registry.js';
import { FONT_FAMILY_OPTIONS, FONT_WEIGHTS, fontStack, ensureFont, invalidateFontMetrics } from '../text/fonts.js';
import {
  WARP_STYLES, defaultTextProps, layoutText, textOrigin, wrapWidthFor,
  measureTextLayer, rasterizeTextLayer, textLayerToMask, resolveTextProps,
} from '../text/text-render.js';
import './type.css';

const ANTIALIAS_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'sharp', label: 'Sharp' },
  { value: 'crisp', label: 'Crisp' },
  { value: 'strong', label: 'Strong' },
  { value: 'smooth', label: 'Smooth' },
];

const ALIGN_OPTIONS = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right', label: 'Right' },
  { value: 'justify', label: 'Justify' },
];

const SELECTION_MODES = [
  { value: 'replace', label: 'New' },
  { value: 'add', label: 'Add' },
  { value: 'subtract', label: 'Subtract' },
  { value: 'intersect', label: 'Intersect' },
];

function cssColor(c) {
  try {
    return toCss(parseColor(c || '#000000'));
  } catch {
    return '#000000';
  }
}

function overlayHost() {
  return document.getElementById('canvas-overlay') || document.body;
}

/* ------------------------------------------------------------------ */
/* Editing session                                                     */
/* ------------------------------------------------------------------ */

/** @type {TypeSession|null} */
let session = null;

class TypeSession {
  /**
   * @param {{doc:object, layer:Layer, tool:object|null, isNew:boolean, mask:boolean}} o
   */
  constructor(o) {
    this.doc = o.doc;
    this.tool = o.tool || null;
    this.isNew = !!o.isNew;
    this.mask = !!o.mask;
    /** Type-mask sessions edit a layer that is *not* in the document. */
    this.detached = this.mask ? o.layer : null;
    this.layerId = o.layer.id;
    this.preview = null;
    this.closing = false;
    this.node = null;
    this.mount();
  }

  /** Layers are rebuilt by undo, so always re-resolve by id. */
  get layer() {
    if (this.detached) return this.detached;
    return this.doc ? this.doc.findLayer(this.layerId) : null;
  }

  /* ---------------- DOM ---------------- */

  mount() {
    const layer = this.layer;
    const ta = el('textarea.pk-type-edit', {
      spellcheck: 'false',
      autocapitalize: 'off',
      autocomplete: 'off',
      autocorrect: 'off',
    });
    ta.value = (layer && layer.text && layer.text.content) || '';
    ta.addEventListener('input', () => this.onInput());
    ta.addEventListener('keydown', (e) => this.onKeyDown(e));
    // Clicks inside the editor must not reach the canvas underneath.
    ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    overlayHost().appendChild(ta);
    this.node = ta;
    this.sync();
    this.render();
    requestAnimationFrame(() => {
      if (this.node !== ta) return;
      ta.focus({ preventScroll: true });
      const n = ta.value.length;
      ta.setSelectionRange(n, n);
    });
  }

  focus() {
    if (this.node) this.node.focus({ preventScroll: true });
  }

  dispose() {
    if (this.node) {
      this.node.remove();
      this.node = null;
    }
    this.preview = null;
    if (session === this) session = null;
  }

  /* ---------------- editing ---------------- */

  onKeyDown(e) {
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      e.stopPropagation();
      commitTypeSession();
    }
  }

  onInput() {
    const layer = this.layer;
    if (!layer || !layer.text) { this.dispose(); return; }
    layer.text.content = this.node.value;
    this.render();
    this.sync();
  }

  /**
   * Re-rasterise the layer. `layer.canvas` is *replaced*, never drawn into, so
   * the buffers held by older history states stay untouched and no
   * `beginEdit()` is needed; the undo entry is written by `finish()`.
   */
  render() {
    const layer = this.layer;
    if (!layer || !layer.text) return;
    rasterizeTextLayer(layer, this.doc);
    if (this.mask) {
      this.buildMaskPreview(layer);
      app.requestRender();
    } else {
      this.doc.touch('type');
    }
  }

  /** Quick-mask style wash: red over the document, glyphs punched out. */
  buildMaskPreview(layer) {
    const w = this.doc.width;
    const h = this.doc.height;
    const cv = createCanvas(w, h);
    const c = ctx2d(cv);
    c.fillStyle = 'rgba(214,44,44,.45)';
    c.fillRect(0, 0, w, h);
    if (layer.canvas) {
      c.globalCompositeOperation = 'destination-out';
      c.drawImage(layer.canvas, 0, 0);
      c.globalCompositeOperation = 'source-over';
    }
    this.preview = cv;
  }

  /** Position, size and style the textarea so it matches the rendered glyphs. */
  sync() {
    const layer = this.layer;
    if (!layer || !layer.text || !this.node) return;
    const t = resolveTextProps(layer.text);
    const lay = layoutText(t, wrapWidthFor(t));
    const o = textOrigin(t, lay);
    const node = this.node;

    let w;
    let h;
    let slackX = 0;
    if (t.paragraph) {
      w = Math.max(4, t.vertical ? lay.width : (t.boxWidth || lay.width));
      h = Math.max(4, t.vertical ? (t.boxHeight || lay.height) : Math.max(t.boxHeight || 0, lay.height));
    } else {
      // Point text: a couple of pixels of slack so the caret at the end of a
      // line is not clipped. Compensate with the transform so the glyph
      // positions inside the box stay identical to the rendered ones.
      w = Math.max(4, lay.width + 2);
      h = Math.max(4, lay.height + (t.vertical ? t.size : 0));
      slackX = t.align === 'center' ? -1 : t.align === 'right' ? -2 : 0;
    }

    const m = app.viewport.matrix().translate(o.x + slackX, o.y);
    node.style.transform = `matrix(${m.a}, ${m.b}, ${m.c}, ${m.d}, ${m.e}, ${m.f})`;
    node.style.width = `${w}px`;
    node.style.height = `${h}px`;
    node.style.font = `${t.italic ? 'italic' : 'normal'} ${t.weight} ${t.size}px/${lay.lineStep}px ${fontStack(t.font)}`;
    node.style.letterSpacing = `${t.letterSpacing}px`;
    node.style.textAlign = t.align || 'left';
    node.style.caretColor = cssColor(t.color);
    node.classList.toggle('is-paragraph', !!t.paragraph);
    node.classList.toggle('is-vertical', !!t.vertical);
    node.wrap = t.paragraph && !t.vertical ? 'soft' : 'off';
  }

  /** Drop the session when the layer vanished (undo, delete, doc switch). */
  checkAlive() {
    if (this.closing) return true;
    const layer = this.layer;
    if (!layer || layer.type !== LayerType.TEXT || !layer.text) {
      this.dispose();
      return false;
    }
    if (this.node && this.node.value !== (layer.text.content || '')) {
      // Something else (a panel, undo) rewrote the content.
      this.node.value = layer.text.content || '';
      this.sync();
    }
    return true;
  }

  /* ---------------- finishing ---------------- */

  /** Commit the edit: history entry, selection, or clean-up of empty text. */
  finish(label) {
    const layer = this.layer;
    const doc = this.doc;
    this.dispose();
    if (!layer || !doc) {
      app.requestRender();
      return;
    }
    const content = (layer.text && layer.text.content) || '';

    if (this.mask) {
      if (content.trim()) {
        const mode = (this.tool && this.tool.state.mode) || 'replace';
        const mask = textLayerToMask(layer, doc);
        doc.selection.combine(mask, mode);
        doc.emit('selection-change');
        doc.commit('Type Mask');
      } else {
        doc.touch('type');
      }
      app.requestRender();
      return;
    }

    if (!content.length) {
      doc.removeLayer(layer);
      if (this.isNew) doc.touch('type');
      else doc.commit('Delete Type Layer');
      app.requestRender();
      return;
    }

    if (this.isNew) layer.name = nameFromContent(content);
    rasterizeTextLayer(layer, doc);
    doc.commit(label || (this.isNew ? 'Type Layer' : 'Edit Type Layer'));
    app.requestRender();
  }
}

function nameFromContent(content) {
  const first = String(content).split('\n').find((l) => l.trim()) || 'Type Layer';
  const trimmed = first.trim();
  return trimmed.length > 28 ? `${trimmed.slice(0, 28)}…` : trimmed;
}

/** Start editing `layer`; any live session is committed first. */
function startSession(opts) {
  commitTypeSession();
  session = new TypeSession(opts);
  app.requestRender();
  return session;
}

/** Finish the live editing session, writing an undo step. */
export function commitTypeSession(label) {
  if (!session || session.closing) return;
  const s = session;
  s.closing = true;
  session = null;
  s.finish(label);
}

/** True while a type layer is being edited. */
export function isEditingText() {
  return !!session;
}

/**
 * Start editing a text layer — used by the Move tool's double-click and by
 * the type tools themselves.
 * @param {import('../core/document.js').PikaDocument} doc
 * @param {Layer} layer a TEXT layer
 * @returns {Layer|null}
 */
export function editTextLayer(doc, layer) {
  if (!doc || !layer || layer.type !== LayerType.TEXT || !layer.text) return null;
  if (session && !session.mask && session.layer === layer) {
    session.focus();
    return layer;
  }
  commitTypeSession();
  const wanted = layer.text.vertical ? 'type-vertical' : 'type';
  const fits = app.tool && app.tool.isTypeTool && !app.tool.mask
    && !!app.tool.vertical === !!layer.text.vertical;
  if (!fits) app.setTool(wanted);
  doc.setActiveLayer(layer.id);
  const tool = app.tool && app.tool.isTypeTool ? app.tool : null;
  if (tool) tool.pullFromLayer(layer);
  startSession({ doc, layer, tool, isNew: false, mask: false });
  return layer;
}

/* Keep the editor glued to the document while the view moves, and drop it
 * when the layer it edits disappears. */
app.on('view-change', () => { if (session) session.sync(); });
app.on('render', () => { if (session) session.checkAlive(); });
app.on('active-doc', () => commitTypeSession());

/* ------------------------------------------------------------------ */
/* Warp dialog                                                         */
/* ------------------------------------------------------------------ */

function pct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.abs(n) <= 1.0001 ? Math.round(n * 100) : Math.round(n);
}

/** The layer the options bar and the warp dialog act on. */
function currentTextLayer(doc) {
  if (session && !session.mask) {
    const l = session.layer;
    if (l && l.type === LayerType.TEXT && l.text) return l;
  }
  const a = doc && doc.activeLayer();
  return a && a.type === LayerType.TEXT && a.text ? a : null;
}

async function openWarpDialog() {
  const doc = app.activeDoc;
  const layer = currentTextLayer(doc);
  if (!layer) {
    app.toast('Select or create a type layer first.');
    return;
  }
  const before = structuredClone(layer.text.warp || { style: 'none', bend: 0, h: 0, v: 0 });
  const state = { style: before.style || 'none', bend: pct(before.bend), h: pct(before.h), v: pct(before.v) };

  const apply = (s) => {
    layer.text.warp = s
      ? { style: s.style, bend: s.bend / 100, h: s.h / 100, v: s.v / 100 }
      : structuredClone(before);
    rasterizeTextLayer(layer, doc);
    doc.touch('warp');
    if (session) session.sync();
  };

  const notNone = (s) => s.style !== 'none';
  const result = await paramDialog({
    title: 'Warp Text',
    width: 360,
    state,
    params: [
      { key: 'style', label: 'Style', type: 'select', options: WARP_STYLES },
      { key: 'bend', label: 'Bend', type: 'slider', min: -100, max: 100, step: 1, unit: '%', when: notNone },
      { key: 'h', label: 'Horizontal Distortion', type: 'slider', min: -100, max: 100, step: 1, unit: '%', when: notNone },
      { key: 'v', label: 'Vertical Distortion', type: 'slider', min: -100, max: 100, step: 1, unit: '%', when: notNone },
    ],
    onPreview: (s) => apply(s),
  });

  if (result) {
    apply(result);
    doc.commit('Warp Text');
  }
  app.requestRender();
}

/* ------------------------------------------------------------------ */
/* Hit testing                                                         */
/* ------------------------------------------------------------------ */

/** Top-most text layer whose layout box contains (x, y). */
function hitTextLayer(doc, x, y, tol = 0) {
  if (!doc) return null;
  for (const l of doc.flatLayers()) {
    if (l.type !== LayerType.TEXT || !l.text || !l.visible) continue;
    const b = measureTextLayer(l);
    if (!b.width || !b.height) continue;
    if (x >= b.x - tol && x <= b.x + b.width + tol && y >= b.y - tol && y <= b.y + b.height + tol) return l;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Context menu                                                        */
/* ------------------------------------------------------------------ */

/**
 * Paste at the caret of the live editor.
 *
 * The browser owns the clipboard here, so this reads it through
 * `navigator.clipboard` and falls back to telling the user to use the keyboard
 * when that is unavailable or blocked.
 */
async function pasteIntoEditor(node) {
  const clip = navigator.clipboard;
  let text = '';
  if (clip && clip.readText) {
    try {
      text = await clip.readText();
    } catch {
      text = '';
    }
  }
  if (!text) {
    app.toast('Clipboard text is unavailable — paste with the keyboard instead.', 'warn');
    node.focus({ preventScroll: true });
    return;
  }
  const start = node.selectionStart == null ? node.value.length : node.selectionStart;
  const end = node.selectionEnd == null ? start : node.selectionEnd;
  node.setRangeText(text, start, end, 'end');
  node.focus({ preventScroll: true });
  node.dispatchEvent(new Event('input', { bubbles: true }));
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

const commitAttributes = debounce(() => {
  const doc = app.activeDoc;
  if (doc) doc.commit('Type Attributes');
}, 420);

class TypeToolBase extends Tool {
  constructor(opts) {
    const extra = opts.extraOptions || [];
    super({
      cursor: 'text',
      shortcut: 'T',
      group: 'type',
      groupOrder: 15,
      ...opts,
      options: [
        { key: 'font', label: 'Font', type: 'select', options: FONT_FAMILY_OPTIONS, default: 'system' },
        { key: 'size', label: 'Size', type: 'number', min: 1, max: 1600, step: 1, default: 48, unit: 'px' },
        { key: 'weight', label: 'Weight', type: 'select', options: FONT_WEIGHTS, default: 400 },
        { key: 'italic', label: 'Italic', type: 'checkbox', default: false },
        { key: 'color', label: 'Color', type: 'color', default: '#000000' },
        { key: 'align', label: 'Align', type: 'radio', options: ALIGN_OPTIONS, default: 'left' },
        { key: 'lineHeight', label: 'Leading', type: 'number', min: 0, max: 20, step: 0.05, default: 1.2, hint: 'Multiple of the type size (0 = automatic)' },
        { key: 'letterSpacing', label: 'Tracking', type: 'number', min: -200, max: 400, step: 0.5, default: 0, unit: 'px' },
        { key: 'underline', label: 'Underline', type: 'checkbox', default: false },
        { key: 'antialias', label: 'Anti-alias', type: 'select', options: ANTIALIAS_OPTIONS, default: 'smooth' },
        ...extra,
        { key: '_warp', label: 'Warp…', type: 'button', onClick: () => openWarpDialog() },
      ],
    });
    this.app = app;
    this.isTypeTool = true;
    this.vertical = !!opts.vertical;
    this.mask = !!opts.mask;
    /** Set once the user picks a colour, so the foreground stops seeding it. */
    this.colorPinned = false;
    this.drag = null;
  }

  onActivate() {
    if (!this.colorPinned) this.state.color = toHex(app.foreground);
    this.warmFont();
    app.emit('tool-options', this);
  }

  onDeactivate() {
    this.drag = null;
    commitTypeSession();
  }

  commit() {
    commitTypeSession();
  }

  /** Escape: finish the edit (the textarea handles it when it has focus). */
  cancel() {
    this.drag = null;
    commitTypeSession();
    app.requestRender();
  }

  tol() {
    return 6 / Math.max(0.02, app.viewport.scale);
  }

  /** Text properties for the next layer this tool creates. */
  textDefaults() {
    const s = this.state;
    return {
      font: s.font,
      size: Number(s.size) || 48,
      weight: Number(s.weight) || 400,
      style: s.italic ? 'italic' : 'normal',
      color: s.color || '#000000',
      align: s.align || 'left',
      lineHeight: Number(s.lineHeight) || 0,
      letterSpacing: Number(s.letterSpacing) || 0,
      underline: !!s.underline,
      antialias: s.antialias || 'smooth',
      vertical: this.vertical,
    };
  }

  /** Mirror a layer's type properties into the options bar. */
  pullFromLayer(layer) {
    if (!layer || !layer.text) return;
    const t = resolveTextProps(layer.text);
    this.state.font = t.font;
    this.state.size = Math.round(t.size * 100) / 100;
    this.state.weight = t.weight;
    this.state.italic = t.italic;
    this.state.color = toHex(parseColor(t.color));
    this.state.align = t.align;
    this.state.lineHeight = t.lineStep == null ? 0 : Math.round((t.lineStep / t.size) * 1000) / 1000;
    this.state.letterSpacing = Math.round(t.letterSpacing * 100) / 100;
    this.state.underline = t.underline;
    this.state.antialias = t.antialias;
    this.colorPinned = true;
    app.emit('tool-options', this);
  }

  /** Load a webfont, then re-measure everything that depends on its metrics. */
  warmFont() {
    const s = this.state;
    ensureFont(s.font, Number(s.weight) || 400, s.italic ? 'italic' : 'normal').then(() => {
      invalidateFontMetrics();
      if (session) {
        session.render();
        session.sync();
      }
      app.requestRender();
    });
  }

  onOptionChange(key, value) {
    if (key === 'color') this.colorPinned = true;
    if (key === 'font' || key === 'weight' || key === 'italic') this.warmFont();

    const doc = this.doc;
    const layer = currentTextLayer(doc);
    if (!layer) return;
    const t = layer.text;
    switch (key) {
      case 'font': t.font = value; break;
      case 'size': t.size = Number(value) || 1; break;
      case 'weight': t.weight = Number(value) || 400; break;
      case 'italic': t.style = value ? 'italic' : 'normal'; break;
      case 'color': t.color = value; break;
      case 'align': t.align = value; break;
      case 'lineHeight': t.lineHeight = Number(value) || 0; break;
      case 'letterSpacing': t.letterSpacing = Number(value) || 0; break;
      case 'underline': t.underline = !!value; break;
      case 'antialias': t.antialias = value; break;
      default: return;
    }
    if (session) {
      session.render();
      session.sync();
    } else {
      rasterizeTextLayer(layer, doc);
      doc.touch('type');
      // Scrubbing a number field fires many changes; only record one step.
      commitAttributes();
    }
    app.requestRender();
  }

  /* ---------------- pointer ---------------- */

  onPointerDown(e) {
    const doc = this.doc;
    if (!doc) return;
    if (session) commitTypeSession();

    if (!this.mask) {
      const hit = hitTextLayer(doc, e.x, e.y, this.tol());
      if (hit) {
        editTextLayer(doc, hit);
        return;
      }
    }
    this.drag = { start: { x: e.x, y: e.y }, cur: { x: e.x, y: e.y }, moved: false };
    app.requestRender();
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d) return;
    d.cur = { x: e.x, y: e.y };
    if (!d.moved && Math.hypot(e.x - d.start.x, e.y - d.start.y) > this.tol()) d.moved = true;
    app.requestRender();
  }

  onPointerUp() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.moved) {
      const x = Math.min(d.start.x, d.cur.x);
      const y = Math.min(d.start.y, d.cur.y);
      const w = Math.abs(d.cur.x - d.start.x);
      const h = Math.abs(d.cur.y - d.start.y);
      this.createLayer({ x, y, boxWidth: w, boxHeight: h, paragraph: true });
    } else {
      this.createLayer({ x: d.start.x, y: d.start.y, paragraph: false });
    }
  }

  onDoubleClick(e) {
    if (session || this.mask) return;
    const hit = hitTextLayer(this.doc, e.x, e.y, this.tol());
    if (hit) editTextLayer(this.doc, hit);
  }

  /** Create the layer and open an editing session on it. */
  createLayer(geometry) {
    const doc = this.doc;
    if (!doc) return null;
    const layer = new Layer({ type: LayerType.TEXT, name: this.mask ? 'Type Mask' : 'Type Layer' });
    layer.text = defaultTextProps({ ...this.textDefaults(), ...geometry });
    rasterizeTextLayer(layer, doc);
    if (!this.mask) doc.addLayer(layer);
    startSession({ doc, layer, tool: this, isNew: true, mask: this.mask });
    return layer;
  }

  /* ---------------- context menu ---------------- */

  /** The live editor, when it is editing a real type layer (not a mask). */
  editingNode() {
    return session && !session.mask && session.node ? session.node : null;
  }

  contextMenu(e) {
    const doc = this.doc;
    if (!doc) return [];
    const items = [];

    // A type layer that is not the one being edited: offer to edit it rather
    // than showing rows that would silently act on a different layer.
    const hit = this.mask ? null : hitTextLayer(doc, e.x, e.y, this.tol());
    if (hit && hit !== currentTextLayer(doc)) {
      items.push({ label: 'Edit Type Layer', run: () => editTextLayer(doc, hit) });
      items.push(sep());
    }

    items.push(cmd('type.rasterize', { hideWhenDisabled: true }));
    items.push(cmd('type.convert-to-shape', { hideWhenDisabled: true }));
    items.push(cmd('type.warp', { hideWhenDisabled: true }));

    // The orientation commands read the active layer, so only offer them when
    // that is what they will act on.
    const active = doc.activeLayer();
    if (active && active.type === LayerType.TEXT && active.text) {
      items.push({ header: 'Orientation' });
      items.push(cmd('type.orientation.horizontal'));
      items.push(cmd('type.orientation.vertical'));
    }

    const node = this.editingNode();
    if (node) {
      items.push(sep());
      items.push({
        label: 'Select All',
        accel: formatAccel('Ctrl+A'),
        run: () => { node.focus({ preventScroll: true }); node.select(); },
      });
      items.push({
        label: 'Paste',
        accel: formatAccel('Ctrl+V'),
        run: () => { pasteIntoEditor(node); },
      });
    }

    return items;
  }

  /* ---------------- overlay ---------------- */

  drawOverlay(ctx, view) {
    const doc = this.doc;
    if (!doc) return;

    if (session && session.mask && session.preview) {
      const m = view.matrix();
      ctx.save();
      ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
      ctx.drawImage(session.preview, 0, 0);
      ctx.restore();
    }

    if (this.drag && this.drag.moved) {
      const d = this.drag;
      strokeDocRect(ctx, view, {
        x: Math.min(d.start.x, d.cur.x),
        y: Math.min(d.start.y, d.cur.y),
        width: Math.abs(d.cur.x - d.start.x),
        height: Math.abs(d.cur.y - d.start.y),
      }, '#3da9ff');
      return;
    }

    if (session) {
      const layer = session.layer;
      if (!layer || !layer.text) return;
      const b = measureTextLayer(layer);
      if (!b.width && !b.height) return;
      strokeDocRect(ctx, view, b, session.mask ? '#ff7a7a' : '#3da9ff');
    }
  }
}

/** Dashed outline of a document-space rectangle, honouring view rotation. */
function strokeDocRect(ctx, view, r, color) {
  const p = [
    view.toScreen(r.x, r.y),
    view.toScreen(r.x + r.width, r.y),
    view.toScreen(r.x + r.width, r.y + r.height),
    view.toScreen(r.x, r.y + r.height),
  ];
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(p[0].x, p[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(p[i].x, p[i].y);
  ctx.closePath();
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,0,0,.6)';
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineDashOffset = 4;
  ctx.stroke();
  ctx.restore();
}

class TypeTool extends TypeToolBase {
  constructor() {
    super({ id: 'type', name: 'Horizontal Type Tool', icon: 'type' });
  }
}

class VerticalTypeTool extends TypeToolBase {
  constructor() {
    super({ id: 'type-vertical', name: 'Vertical Type Tool', icon: 'type-vertical', vertical: true });
  }
}

class TypeMaskTool extends TypeToolBase {
  constructor() {
    super({
      id: 'type-mask',
      name: 'Type Mask Tool',
      icon: 'type-mask',
      mask: true,
      extraOptions: [
        { key: 'mode', label: 'Selection', type: 'radio', options: SELECTION_MODES, default: 'replace' },
      ],
    });
  }
}

registerTool(new TypeTool());
registerTool(new VerticalTypeTool());
registerTool(new TypeMaskTool());
