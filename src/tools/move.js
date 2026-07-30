import { Tool, registerTool } from './base.js';
import { app } from '../core/app.js';
import { LayerType, translateLayerGeometry } from '../core/layer.js';
import { createCanvas, cloneCanvas, uid, el } from '../core/util.js';
import { iconEl } from '../ui/icons.js';
import {
  isTransforming, startTransform, commitTransform, cancelTransform,
  drawTransformOverlay, transformPointerDown, transformPointerMove, transformPointerUp,
  getTransformNumeric, setTransformNumeric, transformContextMenu,
} from './transform.js';
import { cmd, sep } from '../ui/canvas-menu.js';
import './move.css';
import { OVERLAY } from '../ui/brand.js';

/**
 * Move tool + Artboard tool.
 *
 * The Move tool owns three jobs: dragging layer pixels, driving the
 * free-transform session (see transform.js — it is not a tool of its own, so
 * the Move tool forwards pointer events to it), and the align/distribute
 * buttons in the options bar.
 */

/* ------------------------------------------------------------------ */
/* Shared layer helpers                                                */
/* ------------------------------------------------------------------ */

/** Expand groups, drop anything that has no pixels or is position-locked. */
function movableTargets(list, { warn = false } = {}) {
  const out = [];
  let blocked = 0;
  const walk = (l) => {
    if (l.type === LayerType.GROUP) {
      for (const c of l.children || []) walk(c);
      return;
    }
    if (!l.canvas) return;
    if (l.locked.all || l.locked.position) { blocked++; return; }
    if (!out.includes(l)) out.push(l);
  };
  for (const l of list) walk(l);
  if (warn && !out.length && blocked) app.toast('The layer is locked and cannot be moved.', 'warn');
  return out;
}

function shiftCanvas(cv, dx, dy) {
  const tmp = cloneCanvas(cv);
  const c = cv.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, cv.width, cv.height);
  c.drawImage(tmp, dx, dy);
}

/**
 * `contentBounds()` scans every pixel of the layer, and the transform box asks
 * for it on every rendered frame. Cache it against the canvas *object*: the
 * copy-on-write rule means `beginEdit` hands out a fresh canvas for each
 * recorded edit, so identity is a sound invalidation key.
 * @type {WeakMap<HTMLCanvasElement, {x,y,width,height}|null>}
 */
const boundsCache = new WeakMap();

function contentBoundsOf(layer) {
  if (!layer.canvas) return null;
  if (boundsCache.has(layer.canvas)) return boundsCache.get(layer.canvas);
  const b = layer.contentBounds();
  boundsCache.set(layer.canvas, b);
  return b;
}

/** Record where a known bounding box landed after a translation. */
function cacheShiftedBounds(layer, b, dx, dy) {
  if (!layer.canvas) return;
  boundsCache.set(layer.canvas, b ? { ...b, x: b.x + dx, y: b.y + dy } : null);
}

/** Offset a layer's pixels (and its mask when linked). Needs beginEdit first. */
function offsetLayer(layer, dx, dy) {
  if (!dx && !dy) return;
  if (layer.canvas) shiftCanvas(layer.canvas, dx, dy);
  // Text and shape layers can be re-rendered from their parameters at any time,
  // so those parameters have to move with the pixels or the next re-render puts
  // the layer back where it was authored.
  translateLayerGeometry(layer, dx, dy);
  if (layer.mask && layer.maskLinked) {
    shiftCanvas(layer.mask, dx, dy);
    layer.touchMask();
  }
  layer.thumbDirty = true;
}

function alphaAt(canvas, x, y) {
  if (!canvas || x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return 0;
  return canvas.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data[3];
}

function maskValueAt(layer, x, y) {
  const m = layer.mask;
  if (!m || x < 0 || y < 0 || x >= m.width || y >= m.height) return 255;
  const d = m.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data;
  let v = (d[0] * 0.299 + d[1] * 0.587 + d[2] * 0.114) * (d[3] / 255);
  if (layer.maskInverted) v = 255 - v;
  return v;
}

function chainVisible(layer) {
  let p = layer.parent;
  while (p) {
    if (!p.visible) return false;
    p = p.parent;
  }
  return true;
}

/**
 * Topmost layer with a non-transparent pixel under the cursor.
 * @param {'layer'|'group'} kind
 */
export function pickLayerAt(doc, x, y, kind = 'layer') {
  const px = Math.floor(x), py = Math.floor(y);
  for (const l of doc.flatLayers()) {
    if (l.type === LayerType.GROUP || !l.visible || !l.canvas) continue;
    if (!chainVisible(l)) continue;
    if (alphaAt(l.canvas, px, py) < 8) continue;
    if (l.mask && l.maskEnabled && maskValueAt(l, px, py) < 8) continue;
    if (kind === 'group' && l.parent) {
      let top = l;
      while (top.parent) top = top.parent;
      return top;
    }
    return l;
  }
  return null;
}

/**
 * Every layer with an opaque pixel under (x,y), topmost first — the list the
 * Move tool's context menu offers so you can reach a layer buried under others.
 * Groups, hidden layers and layers masked out at that point are skipped.
 *
 * @param {import('../core/document.js').PikaDocument} doc
 * @param {number} limit most rows the menu will show
 * @returns {import('../core/layer.js').Layer[]}
 */
export function layersUnderPoint(doc, x, y, limit = 10) {
  const px = Math.floor(x), py = Math.floor(y);
  const out = [];
  if (!doc) return out;
  for (const l of doc.flatLayers()) {
    if (l.type === LayerType.GROUP || !l.visible || !l.canvas) continue;
    if (!chainVisible(l)) continue;
    if (alphaAt(l.canvas, px, py) < 8) continue;
    if (l.mask && l.maskEnabled && maskValueAt(l, px, py) < 8) continue;
    out.push(l);
    if (out.length >= limit) break;
  }
  return out;
}

/** Union of the content bounds of `layers`, or null. */
export function layersBounds(layers) {
  let r = null;
  for (const l of layers) {
    const b = contentBoundsOf(l);
    if (!b) continue;
    r = r ? {
      x: Math.min(r.x, b.x), y: Math.min(r.y, b.y),
      x2: Math.max(r.x2, b.x + b.width), y2: Math.max(r.y2, b.y + b.height),
    } : { x: b.x, y: b.y, x2: b.x + b.width, y2: b.y + b.height };
  }
  return r ? { x: r.x, y: r.y, width: r.x2 - r.x, height: r.y2 - r.y } : null;
}

/* ------------------------------------------------------------------ */
/* Align & distribute                                                  */
/* ------------------------------------------------------------------ */

function alignTarget(doc, layers) {
  if (doc.selection.active) {
    const b = doc.selection.bounds();
    if (b) return b;
  }
  if (layers.length > 1) return layersBounds(layers) || { x: 0, y: 0, width: doc.width, height: doc.height };
  return { x: 0, y: 0, width: doc.width, height: doc.height };
}

/**
 * @param {'left'|'center-h'|'right'|'top'|'center-v'|'bottom'} how
 */
export function alignLayers(doc, how) {
  if (!doc) return;
  const layers = movableTargets(doc.selectedLayers(), { warn: true });
  const items = layers.map((l) => ({ l, b: contentBoundsOf(l) })).filter((x) => x.b);
  if (!items.length) {
    app.toast('Nothing to align.');
    return;
  }
  const t = alignTarget(doc, items.map((x) => x.l));
  doc.beginEdit(items.map((x) => x.l));
  for (const { l, b } of items) {
    let dx = 0, dy = 0;
    if (how === 'left') dx = t.x - b.x;
    else if (how === 'center-h') dx = t.x + t.width / 2 - (b.x + b.width / 2);
    else if (how === 'right') dx = t.x + t.width - (b.x + b.width);
    else if (how === 'top') dy = t.y - b.y;
    else if (how === 'center-v') dy = t.y + t.height / 2 - (b.y + b.height / 2);
    else if (how === 'bottom') dy = t.y + t.height - (b.y + b.height);
    dx = Math.round(dx);
    dy = Math.round(dy);
    offsetLayer(l, dx, dy);
    cacheShiftedBounds(l, b, dx, dy);
  }
  doc.commit('Align Layers');
}

/** @param {'h'|'v'} axis */
export function distributeLayers(doc, axis) {
  if (!doc) return;
  const layers = movableTargets(doc.selectedLayers(), { warn: true });
  const items = layers.map((l) => ({ l, b: contentBoundsOf(l) })).filter((x) => x.b);
  if (items.length < 3) {
    app.toast('Select three or more layers to distribute.');
    return;
  }
  const key = axis === 'h' ? 'x' : 'y';
  const size = axis === 'h' ? 'width' : 'height';
  items.sort((a, b) => a.b[key] + a.b[size] / 2 - (b.b[key] + b.b[size] / 2));
  const first = items[0].b, last = items[items.length - 1].b;
  const start = first[key] + first[size] / 2;
  const end = last[key] + last[size] / 2;
  const step = (end - start) / (items.length - 1);
  doc.beginEdit(items.map((x) => x.l));
  for (let i = 1; i < items.length - 1; i++) {
    const it = items[i];
    const want = start + step * i;
    const cur = it.b[key] + it.b[size] / 2;
    const d = Math.round(want - cur);
    const dx = axis === 'h' ? d : 0;
    const dy = axis === 'h' ? 0 : d;
    offsetLayer(it.l, dx, dy);
    cacheShiftedBounds(it.l, it.b, dx, dy);
  }
  doc.commit('Distribute Layers');
}

/** Arrow-key nudge. Coalesces consecutive presses into one history entry. */
let lastNudge = null;
export function nudgeLayers(doc, dx, dy) {
  const layers = movableTargets(doc.selectedLayers(), { warn: true });
  if (!layers.length) return false;
  // Read the bounds before the edit so the cache can be carried across the
  // copy-on-write rather than rescanning on every key repeat.
  const prior = layers.map((l) => (boundsCache.has(l.canvas) ? boundsCache.get(l.canvas) : undefined));
  doc.beginEdit(layers);
  layers.forEach((l, i) => {
    offsetLayer(l, dx, dy);
    if (prior[i] !== undefined) cacheShiftedBounds(l, prior[i], dx, dy);
  });
  const now = performance.now();
  if (lastNudge && lastNudge.doc === doc && now - lastNudge.t < 900) {
    doc.dirty = true;
    doc.invalidate();
    doc.history.replaceTop('Move Layer');
    doc.emit('change', { reason: 'Move Layer' });
  } else {
    doc.commit('Move Layer');
  }
  lastNudge = { doc, t: now };
  return true;
}

/* ------------------------------------------------------------------ */
/* Options-bar align widget                                            */
/* ------------------------------------------------------------------ */

const ALIGN_BUTTONS = [
  ['align-left', 'left', 'Align left edges'],
  ['align-center-h', 'center-h', 'Align horizontal centres'],
  ['align-right', 'right', 'Align right edges'],
  ['align-top', 'top', 'Align top edges'],
  ['align-center-v', 'center-v', 'Align vertical centres'],
  ['align-bottom', 'bottom', 'Align bottom edges'],
];

function renderAlignBar(container) {
  const bar = el('div.pk-align-bar');
  for (const [ico, how, title] of ALIGN_BUTTONS) {
    const b = el('button.pk-icon-btn', { type: 'button', title, onclick: () => alignLayers(app.activeDoc, how) });
    b.appendChild(iconEl(ico));
    bar.appendChild(b);
  }
  bar.appendChild(el('span.pk-vsep'));
  bar.appendChild(el('button.pk-btn.subtle.pk-align-dist', {
    type: 'button', text: 'Dist H', title: 'Distribute horizontal centres',
    onclick: () => distributeLayers(app.activeDoc, 'h'),
  }));
  bar.appendChild(el('button.pk-btn.subtle.pk-align-dist', {
    type: 'button', text: 'Dist V', title: 'Distribute vertical centres',
    onclick: () => distributeLayers(app.activeDoc, 'v'),
  }));
  container.appendChild(bar);
  return null;
}

/* ------------------------------------------------------------------ */
/* Move tool                                                           */
/* ------------------------------------------------------------------ */

const NUDGE_KEYS = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
};

class MoveTool extends Tool {
  constructor() {
    super({
      id: 'move',
      name: 'Move Tool',
      icon: 'move',
      cursor: 'move',
      shortcut: 'V',
      group: 'move',
      groupOrder: 0,
      options: [
        { key: 'autoSelect', type: 'checkbox', label: 'Auto-Select', default: false },
        {
          key: 'autoSelectKind', type: 'select', label: '', default: 'layer',
          options: [{ value: 'layer', label: 'Layer' }, { value: 'group', label: 'Group' }],
          when: (s) => s.autoSelect,
        },
        { key: 'showTransform', type: 'checkbox', label: 'Show Transform Controls', default: false },
        { type: 'separator' },
        { key: 'align', type: 'custom', label: 'Align', render: renderAlignBar },
      ],
    });
    this.drag = null;
    this.forwarding = false;
  }

  onDeactivate() {
    if (isTransforming()) commitTransform();
    this.drag = null;
  }

  commit() {
    if (isTransforming()) commitTransform();
  }

  cancel() {
    if (isTransforming()) { cancelTransform(); return; }
    this.abortDrag();
  }

  abortDrag() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    for (let i = 0; i < d.layers.length; i++) {
      const l = d.layers[i];
      if (d.bases[i].canvas) l.canvas = cloneCanvas(d.bases[i].canvas);
      if (d.bases[i].mask) { l.mask = cloneCanvas(d.bases[i].mask); l.touchMask(); }
    }
    if (d.baseSel) d.doc.selection.set(new Uint8ClampedArray(d.baseSel));
    d.doc.touch('move-cancel');
  }

  /* --- bounding box shown by "Show Transform Controls" ------------- */

  boxHandles(view) {
    const doc = this.doc;
    if (!doc) return null;
    const d = this.drag;
    // While dragging, follow the box captured at pointer-down instead of
    // re-measuring the pixels we are actively rewriting each frame.
    const b = d && d.boxBounds
      ? { ...d.boxBounds, x: d.boxBounds.x + d.dx, y: d.boxBounds.y + d.dy }
      : layersBounds(movableTargets(doc.selectedLayers()));
    if (!b) return null;
    const c = [
      view.toScreen(b.x, b.y), view.toScreen(b.x + b.width, b.y),
      view.toScreen(b.x + b.width, b.y + b.height), view.toScreen(b.x, b.y + b.height),
    ];
    const m = (a, z) => ({ x: (a.x + z.x) / 2, y: (a.y + z.y) / 2 });
    return { bounds: b, points: [...c, m(c[0], c[1]), m(c[1], c[2]), m(c[2], c[3]), m(c[3], c[0])] };
  }

  hitBoxHandle(e, view) {
    const h = this.boxHandles(view);
    if (!h) return false;
    return h.points.some((p) => Math.hypot(e.sx - p.x, e.sy - p.y) <= 8);
  }

  /* --- pointer ----------------------------------------------------- */

  onPointerDown(e) {
    const doc = this.doc;
    if (!doc) return;
    const view = this.app.viewport;

    if (isTransforming()) {
      this.forwarding = transformPointerDown(e, view);
      return;
    }
    if (this.state.showTransform && this.hitBoxHandle(e, view)) {
      if (startTransform(doc, { mode: 'free' })) {
        this.forwarding = transformPointerDown(e, view);
        return;
      }
    }

    const ctrl = e.ctrlKey || e.metaKey;
    const pixelMove = ctrl && doc.selection.active;

    // Ctrl inverts the Auto-Select setting, exactly like Photoshop — unless it
    // is claimed by a floating-pixel move.
    if (!pixelMove && this.state.autoSelect !== ctrl) {
      const picked = pickLayerAt(doc, e.x, e.y, this.state.autoSelectKind);
      if (picked) doc.setActiveLayer(picked.id, e.shiftKey);
    }

    const layers = pixelMove
      ? movableTargets([doc.activeLayer()].filter(Boolean), { warn: true })
      : movableTargets(doc.selectedLayers(), { warn: true });
    if (!layers.length) return;

    const boxBounds = this.state.showTransform && !pixelMove ? layersBounds(layers) : null;
    const priorBounds = layers.map((l) => (boundsCache.has(l.canvas) ? boundsCache.get(l.canvas) : undefined));
    doc.beginEdit(layers);
    const drag = {
      doc,
      layers,
      startX: e.x,
      startY: e.y,
      dx: 0,
      dy: 0,
      moved: false,
      pixelMove,
      boxBounds,
      priorBounds,
      bases: layers.map((l) => ({
        canvas: cloneCanvas(l.canvas),
        mask: l.mask && l.maskLinked ? cloneCanvas(l.mask) : null,
      })),
      float: null,
      erased: null,
      baseSel: null,
    };

    if (pixelMove) {
      const layer = layers[0];
      const sel = doc.selection.toAlphaCanvas();
      const float = createCanvas(doc.width, doc.height);
      const fc = float.getContext('2d');
      fc.drawImage(layer.canvas, 0, 0);
      fc.globalCompositeOperation = 'destination-in';
      fc.drawImage(sel, 0, 0);
      const erased = createCanvas(doc.width, doc.height);
      const ec = erased.getContext('2d');
      ec.drawImage(layer.canvas, 0, 0);
      ec.globalCompositeOperation = 'destination-out';
      ec.drawImage(sel, 0, 0);
      drag.float = float;
      drag.erased = erased;
      drag.baseSel = new Uint8ClampedArray(doc.selection.mask);
    }

    this.drag = drag;
  }

  onPointerMove(e) {
    if (this.forwarding) {
      transformPointerMove(e, this.app.viewport);
      return;
    }
    const d = this.drag;
    if (!d) return;
    let dx = e.x - d.startX, dy = e.y - d.startY;
    if (e.shiftKey) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0;
    }
    dx = Math.round(dx);
    dy = Math.round(dy);
    if (dx === d.dx && dy === d.dy) return;
    d.dx = dx;
    d.dy = dy;
    d.moved = d.moved || dx !== 0 || dy !== 0;
    this.applyDrag();
    d.doc.touch('move');
  }

  applyDrag() {
    const d = this.drag;
    if (d.pixelMove) {
      const layer = d.layers[0];
      const c = layer.canvas.getContext('2d');
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      c.drawImage(d.erased, 0, 0);
      c.drawImage(d.float, d.dx, d.dy);
      layer.thumbDirty = true;
      d.doc.selection.set(translateMask(d.baseSel, d.doc.width, d.doc.height, d.dx, d.dy));
      return;
    }
    for (let i = 0; i < d.layers.length; i++) {
      const l = d.layers[i];
      const base = d.bases[i];
      if (l.canvas && base.canvas) {
        const c = l.canvas.getContext('2d');
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, l.canvas.width, l.canvas.height);
        c.drawImage(base.canvas, d.dx, d.dy);
      }
      if (l.mask && base.mask) {
        const c = l.mask.getContext('2d');
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, l.mask.width, l.mask.height);
        c.drawImage(base.mask, d.dx, d.dy);
        l.touchMask();
      }
      l.thumbDirty = true;
    }
  }

  onPointerUp(e) {
    if (this.forwarding) {
      transformPointerUp(e);
      this.forwarding = false;
      return;
    }
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (!d.moved) return;
    if (!d.pixelMove) {
      d.layers.forEach((l, i) => {
        if (d.priorBounds[i] !== undefined) cacheShiftedBounds(l, d.priorBounds[i], d.dx, d.dy);
      });
    }
    d.doc.commit(d.pixelMove ? 'Move Selection' : 'Move Layer');
  }

  /* --- context menu ------------------------------------------------ */

  contextMenu(e) {
    // Mid-transform the box owns the gesture, so offer the transform kinds
    // instead of a layer picker that could not be acted on anyway.
    if (isTransforming()) return transformContextMenu();

    const doc = this.doc;
    if (!doc) return [];
    const active = doc.activeLayer();
    const items = [{ header: 'Select Layer' }];
    const hits = layersUnderPoint(doc, e.x, e.y);
    if (!hits.length) {
      items.push({ label: 'No layer under cursor', disabled: true });
    } else {
      for (const l of hits) {
        items.push({
          label: l.name,
          checked: !!active && active.id === l.id,
          run: () => doc.setActiveLayer(l.id),
        });
      }
    }
    return [
      ...items,
      sep(),
      cmd('layer.duplicate'),
      cmd('layer.delete', { label: 'Delete Layer' }),
      cmd('layer.group-from-layers', { label: 'Group Layers' }),
      sep(),
      cmd('layer.merge-down'),
      cmd('layer.merge-visible'),
      cmd('layer.flatten'),
      sep(),
      cmd('layer.style.options'),
      cmd('layer.rasterize.layer', { label: 'Rasterize Layer', hideWhenDisabled: true }),
    ];
  }

  async onDoubleClick(e) {
    const doc = this.doc;
    if (!doc) return;
    if (isTransforming()) { commitTransform(); return; }
    const layer = pickLayerAt(doc, e.x, e.y, 'layer') || doc.activeLayer();
    if (!layer || layer.type !== LayerType.TEXT) return;
    // Dynamic import: type.js also reaches into the move tool, and a static
    // import here would create a load-order cycle.
    try {
      const mod = await import('./type.js');
      if (typeof mod.editTextLayer === 'function') {
        doc.setActiveLayer(layer.id);
        mod.editTextLayer(doc, layer);
      }
    } catch (err) {
      console.error('[move] text editing unavailable', err);
    }
  }

  onKeyDown(e) {
    const doc = this.doc;
    if (!doc) return false;
    if (isTransforming()) {
      if (e.key === 'Enter') { commitTransform(); return true; }
      if (e.key === 'Escape') { cancelTransform(); return true; }
      const nk = NUDGE_KEYS[e.key];
      if (nk) {
        const step = e.shiftKey ? 10 : 1;
        const cur = getTransformNumeric();
        setTransformNumeric({ x: cur.x + nk[0] * step, y: cur.y + nk[1] * step });
        return true;
      }
      return false;
    }
    const nk = NUDGE_KEYS[e.key];
    if (!nk) return false;
    const step = e.shiftKey ? 10 : 1;
    return nudgeLayers(doc, nk[0] * step, nk[1] * step);
  }

  drawOverlay(ctx, view) {
    if (isTransforming()) {
      drawTransformOverlay(ctx, view);
      return;
    }
    if (!this.state.showTransform) return;
    const h = this.boxHandles(view);
    if (!h) return;
    const c = h.points;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.beginPath();
    ctx.moveTo(c[0].x, c[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.95)';
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of c) {
      ctx.beginPath();
      ctx.rect(p.x - 4, p.y - 4, 8, 8);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.85)';
      ctx.stroke();
    }
    ctx.restore();
  }
}

function translateMask(mask, w, h, dx, dy) {
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= w) continue;
      out[y * w + x] = mask[sy * w + sx];
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Artboard tool                                                       */
/* ------------------------------------------------------------------ */

const ARTBOARD_PRESETS = [
  { value: 'custom', label: 'Custom', w: 0, h: 0 },
  { value: 'web-1366', label: 'Web 1366 × 768', w: 1366, h: 768 },
  { value: 'web-1920', label: 'Web 1920 × 1080', w: 1920, h: 1080 },
  { value: 'mbp', label: 'Laptop 1440 × 900', w: 1440, h: 900 },
  { value: 'phone', label: 'Phone 390 × 844', w: 390, h: 844 },
  { value: 'tablet', label: 'Tablet 820 × 1180', w: 820, h: 1180 },
  { value: 'a4', label: 'A4 595 × 842', w: 595, h: 842 },
  { value: 'square', label: 'Square 1080', w: 1080, h: 1080 },
];

function artboardsOf(doc) {
  if (!doc.artboards) doc.artboards = [];
  return doc.artboards;
}

function nextArtboardName(doc) {
  const names = new Set(artboardsOf(doc).map((a) => a.name));
  let n = 1;
  while (names.has(`Artboard ${n}`)) n++;
  return `Artboard ${n}`;
}

/** Create an artboard rectangle on the document. */
export function addArtboard(doc, rect) {
  const list = artboardsOf(doc);
  const a = {
    id: uid('ab'),
    name: nextArtboardName(doc),
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
  list.push(a);
  doc.touch('artboard');
  return a;
}

const AB_HANDLES = [
  ['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0], ['e', 1, 0.5],
  ['se', 1, 1], ['s', 0.5, 1], ['sw', 0, 1], ['w', 0, 0.5],
];

class ArtboardTool extends Tool {
  constructor() {
    super({
      id: 'artboard',
      name: 'Artboard Tool',
      icon: 'artboard',
      cursor: 'crosshair',
      shortcut: 'V',
      group: 'move',
      groupOrder: 0,
      options: [
        {
          key: 'preset', type: 'select', label: 'Size', default: 'custom',
          options: ARTBOARD_PRESETS.map((p) => ({ value: p.value, label: p.label })),
        },
        { key: 'width', type: 'number', label: 'W', min: 1, step: 1, default: 1366, unit: 'px' },
        { key: 'height', type: 'number', label: 'H', min: 1, step: 1, default: 768, unit: 'px' },
        {
          type: 'button', label: 'Add Artboard',
          onClick: (state) => {
            const doc = app.activeDoc;
            if (!doc) return;
            const list = artboardsOf(doc);
            const x = 20 + list.length * 24;
            const y = 20 + list.length * 24;
            const a = addArtboard(doc, { x, y, width: state.width, height: state.height });
            artboardTool.selectedId = a.id;
            app.requestRender();
          },
        },
        {
          type: 'button', label: 'Delete Artboard',
          onClick: () => artboardTool.deleteSelected(),
        },
      ],
    });
    this.selectedId = null;
    this.drag = null;
  }

  onOptionChange(key, value) {
    if (key !== 'preset') return;
    const p = ARTBOARD_PRESETS.find((x) => x.value === value);
    if (!p || !p.w) return;
    this.state.width = p.w;
    this.state.height = p.h;
    if (this.app) this.app.emit('tool-options', this);
  }

  selected(doc) {
    return artboardsOf(doc).find((a) => a.id === this.selectedId) || null;
  }

  deleteSelected() {
    const doc = app.activeDoc;
    if (!doc) return;
    const list = artboardsOf(doc);
    const i = list.findIndex((a) => a.id === this.selectedId);
    if (i < 0) return;
    list.splice(i, 1);
    this.selectedId = null;
    doc.touch('artboard');
  }

  handleAt(doc, e, view) {
    const a = this.selected(doc);
    if (!a) return null;
    for (const [id, fx, fy] of AB_HANDLES) {
      const p = view.toScreen(a.x + a.width * fx, a.y + a.height * fy);
      if (Math.hypot(e.sx - p.x, e.sy - p.y) <= 7) return id;
    }
    return null;
  }

  artboardAt(doc, x, y) {
    const list = artboardsOf(doc);
    for (let i = list.length - 1; i >= 0; i--) {
      const a = list[i];
      if (x >= a.x && y >= a.y && x <= a.x + a.width && y <= a.y + a.height) return a;
    }
    return null;
  }

  onPointerDown(e) {
    const doc = this.doc;
    if (!doc) return;
    const view = this.app.viewport;

    const handle = this.handleAt(doc, e, view);
    if (handle) {
      const a = this.selected(doc);
      this.drag = { kind: 'resize', handle, a, start: { ...a }, x: e.x, y: e.y };
      return;
    }
    const hit = this.artboardAt(doc, e.x, e.y);
    if (hit) {
      this.selectedId = hit.id;
      this.drag = { kind: 'move', a: hit, start: { ...hit }, x: e.x, y: e.y };
      doc.touch('artboard');
      return;
    }
    this.selectedId = null;
    this.drag = { kind: 'create', x: e.x, y: e.y, rect: null };
    doc.touch('artboard');
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d) return;
    const doc = this.doc;
    if (d.kind === 'create') {
      d.rect = {
        x: Math.min(d.x, e.x), y: Math.min(d.y, e.y),
        width: Math.abs(e.x - d.x), height: Math.abs(e.y - d.y),
      };
      this.app.requestRender();
      return;
    }
    const dx = Math.round(e.x - d.x), dy = Math.round(e.y - d.y);
    if (d.kind === 'move') {
      d.a.x = d.start.x + dx;
      d.a.y = d.start.y + dy;
    } else {
      const h = d.handle;
      let { x, y, width, height } = d.start;
      if (h.includes('w')) { x = d.start.x + dx; width = d.start.width - dx; }
      if (h.includes('e')) { width = d.start.width + dx; }
      if (h.includes('n')) { y = d.start.y + dy; height = d.start.height - dy; }
      if (h.includes('s')) { height = d.start.height + dy; }
      if (width < 1) { x += width - 1; width = 1; }
      if (height < 1) { y += height - 1; height = 1; }
      Object.assign(d.a, { x, y, width, height });
    }
    doc.touch('artboard');
  }

  onPointerUp() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const doc = this.doc;
    if (d.kind === 'create') {
      const r = d.rect && d.rect.width > 4 && d.rect.height > 4
        ? d.rect
        : { x: d.x, y: d.y, width: this.state.width, height: this.state.height };
      const a = addArtboard(doc, r);
      this.selectedId = a.id;
    } else {
      this.state.width = Math.round(d.a.width);
      this.state.height = Math.round(d.a.height);
      this.app.emit('tool-options', this);
    }
    doc.touch('artboard');
  }

  async onDoubleClick() {
    const doc = this.doc;
    const a = doc && this.selected(doc);
    if (!a) return;
    const { promptDialog } = await import('../ui/dialog.js');
    const name = await promptDialog('Artboard name', a.name, 'Rename Artboard');
    if (name != null && name !== '') {
      a.name = name;
      doc.touch('artboard');
    }
  }

  onKeyDown(e) {
    const doc = this.doc;
    if (!doc || !this.selectedId) return false;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      this.deleteSelected();
      return true;
    }
    const nk = NUDGE_KEYS[e.key];
    if (!nk) return false;
    const a = this.selected(doc);
    if (!a) return false;
    const step = e.shiftKey ? 10 : 1;
    a.x += nk[0] * step;
    a.y += nk[1] * step;
    doc.touch('artboard');
    return true;
  }

  drawOverlay(ctx, view) {
    const doc = this.doc;
    if (!doc) return;
    const list = artboardsOf(doc);
    ctx.save();
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    for (const a of list) {
      const p0 = view.toScreen(a.x, a.y);
      const p1 = view.toScreen(a.x + a.width, a.y);
      const p2 = view.toScreen(a.x + a.width, a.y + a.height);
      const p3 = view.toScreen(a.x, a.y + a.height);
      const active = a.id === this.selectedId;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.lineTo(p3.x, p3.y);
      ctx.closePath();
      ctx.lineWidth = active ? 2 : 1;
      ctx.strokeStyle = active ? OVERLAY.accent : OVERLAY.accentSoft;
      ctx.stroke();

      const label = `${a.name}  ${Math.round(a.width)} × ${Math.round(a.height)}`;
      ctx.fillStyle = active ? OVERLAY.accentHi : 'rgba(220,222,240,.85)';
      ctx.fillText(label, p0.x, p0.y - 4);

      if (active) {
        for (const [, fx, fy] of AB_HANDLES) {
          const h = view.toScreen(a.x + a.width * fx, a.y + a.height * fy);
          ctx.beginPath();
          ctx.rect(h.x - 4, h.y - 4, 8, 8);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,.8)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }
    const d = this.drag;
    if (d && d.kind === 'create' && d.rect) {
      const p0 = view.toScreen(d.rect.x, d.rect.y);
      const p2 = view.toScreen(d.rect.x + d.rect.width, d.rect.y + d.rect.height);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = OVERLAY.accent;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.min(p0.x, p2.x), Math.min(p0.y, p2.y), Math.abs(p2.x - p0.x), Math.abs(p2.y - p0.y));
      ctx.setLineDash([]);
    }
    ctx.restore();
  }
}

registerTool(new MoveTool());
const artboardTool = registerTool(new ArtboardTool());
