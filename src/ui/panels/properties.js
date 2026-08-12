import './panels.css';
import './smart.css';
import { registerPanel } from '../panel-host.js';
import { app } from '../../core/app.js';
import { el, createCanvas, cloneCanvas, getImageData, clamp } from '../../core/util.js';
import { icon } from '../icons.js';
import { LayerType } from '../../core/layer.js';
import { boxBlurMask } from '../../core/selection.js';
import { getAdjustment, defaultParams } from '../../adjustments/registry.js';
import { buildForm } from '../dialog.js';
import { toHex, parseColor } from '../../core/color.js';
import { fontFamilyOptions, FONT_WEIGHTS, ensureFont } from '../../text/fonts.js';
import * as ops from '../../layers/ops.js';
import {
  isSmartLayer, getSmartTransform, getSmartFilters, decomposeMatrix, composeMatrix,
  setSmartTransform, resetSmartTransform, editSmartContents, exportSmartContents,
  getSmartPerspective, getSmartWarp, clearSmartShape,
} from '../../core/smart.js';

/**
 * The Properties panel — context sensitive on the active layer.
 *
 * Adjustment layers get their registered ParamDescriptors (including custom
 * Curves/Levels widgets); text and shape layers get their editable payload and
 * are re-rasterized through the owning module; a selected layer mask gets
 * density + feather; anything else falls back to document properties.
 */

const ALIGNS = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right', label: 'Right' },
  { value: 'justify', label: 'Justify' },
];

/** Stroke dash presets understood by `dashArrayFor()` in vector/path.js. */
const DASH_OPTIONS = [
  { value: 'solid', label: 'Solid' },
  { value: 'dash', label: 'Dashed' },
  { value: 'dash-tight', label: 'Dashed (tight)' },
  { value: 'dot', label: 'Dotted' },
  { value: 'dash-dot', label: 'Dash-dot' },
  { value: 'long-dash', label: 'Long dash' },
];

const STROKE_ALIGNS = [
  { value: 'inside', label: 'Inside' },
  { value: 'center', label: 'Center' },
  { value: 'outside', label: 'Outside' },
];

let textModPromise = null;
const textMod = () => (textModPromise || (textModPromise = import('../../text/text-render.js')));
let shapeModPromise = null;
const shapeMod = () => (shapeModPromise || (shapeModPromise = import('../../vector/path.js')));

registerPanel({
  id: 'properties',
  title: 'Properties',
  icon: 'properties',
  group: 'bottom',
  order: 0,
  defaultOpen: true,
  minHeight: 120,
  build: buildPropertiesPanel,
});

function buildPropertiesPanel(bodyEl) {
  const root = el('div.pk-prop');
  bodyEl.appendChild(root);

  /** @type {{key:string|null, sync:Function|null, dispose:Function|null}} */
  let current = { key: null, sync: null, dispose: null };
  let queued = false;

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      render();
    });
  }

  function render() {
    const doc = app.activeDoc;
    const layer = doc ? doc.activeLayer() : null;
    const mode = pickMode(doc, layer);
    const key = [
      doc ? doc.id : '-',
      layer ? layer.id : '-',
      mode,
      layer && layer.adjustment ? layer.adjustment.kind : '',
    ].join('|');

    if (key === current.key) {
      if (current.sync) {
        try {
          current.sync();
        } catch (err) {
          console.error('[properties] sync', err);
        }
      }
      return;
    }

    if (current.dispose) {
      try {
        current.dispose();
      } catch (err) {
        console.error('[properties] dispose', err);
      }
    }
    current = { key, sync: null, dispose: null };
    root.replaceChildren();

    if (!doc) {
      root.appendChild(el('div.pk-panel-empty', { text: 'No document open.' }));
      return;
    }

    root.appendChild(headerFor(doc, layer, mode));

    let built = null;
    if (mode === 'adjustment') built = adjustmentSection(doc, layer);
    else if (mode === 'mask') built = maskSection(doc, layer);
    else if (mode === 'text') built = textSection(doc, layer);
    else if (mode === 'shape') built = shapeSection(doc, layer);
    else if (mode === 'smart') built = smartSection(doc, layer);
    else built = documentSection(doc);

    if (built) {
      root.appendChild(built.node);
      current.sync = built.sync || null;
      current.dispose = built.dispose || null;
    }
  }

  const onChange = () => schedule();
  app.on('active-doc', onChange);
  app.on('doc-selection', onChange);
  app.on('doc-structure', onChange);
  app.on('doc-resize', onChange);
  app.on('history-change', onChange);

  render();

  return {
    refresh: schedule,
    destroy() {
      if (current.dispose) current.dispose();
      app.off('active-doc', onChange);
      app.off('doc-selection', onChange);
      app.off('doc-structure', onChange);
      app.off('doc-resize', onChange);
      app.off('history-change', onChange);
    },
  };
}

/* ------------------------------------------------------------------ */

function pickMode(doc, layer) {
  if (!doc) return 'none';
  if (!layer) return 'document';
  if (layer.editingMask && layer.mask) return 'mask';
  if (layer.type === LayerType.ADJUSTMENT && layer.adjustment) return 'adjustment';
  if (layer.type === LayerType.TEXT && layer.text) return 'text';
  if (layer.type === LayerType.SHAPE && layer.shape) return 'shape';
  if (isSmartLayer(layer)) return 'smart';
  return 'document';
}

function headerFor(doc, layer, mode) {
  const iconName = mode === 'mask' ? 'mask'
    : mode === 'adjustment' ? 'adjustment'
      : mode === 'text' ? 'type'
        : mode === 'shape' ? 'rectangle'
          : mode === 'smart' ? 'image'
            : layer ? 'copy' : 'image';
  const title = mode === 'document' || !layer ? doc.name : layer.name;
  const kind = mode === 'mask' ? 'Layer Mask'
    : mode === 'adjustment' ? 'Adjustment'
      : mode === 'text' ? 'Type'
        : mode === 'shape' ? 'Shape'
          : mode === 'smart' ? 'Smart Object'
            : 'Document';
  return el('div.pk-prop-head', {},
    el('span.pk-prop-ico', { html: icon(iconName, { size: 15 }) }),
    el('span.pk-prop-name', { text: title }),
    el('span.pk-prop-kind', { text: kind })
  );
}

/**
 * Debounced commit that also opens the copy-on-write window once per burst.
 * `touch()` fires on every change for a live preview; `commit()` lands once the
 * user stops (or lets go of) the control *and* every re-render has finished.
 *
 * @param {string|(()=>string)} label history label
 * @param {{layerFor?:()=>object, before?:Function}} [opts]
 *   `layerFor` names the layer to `beginEdit` at the start of a burst;
 *   `before` runs immediately before the snapshot to land coalesced work.
 */
function makeCommitter(label, { layerFor = null, before = null } = {}) {
  /** The document the burst started on — never `app.activeDoc` at flush time. */
  let editDoc = null;
  let owed = false;
  let ready = false;
  let inFlight = 0;
  let timer = null;

  const settle = () => {
    if (!owed || !ready || inFlight) return;
    owed = false;
    ready = false;
    clearTimeout(timer);
    timer = null;
    if (before) before();
    const doc = editDoc;
    editDoc = null;
    if (doc) doc.commit(typeof label === 'function' ? label() : label);
  };

  const start = () => {
    if (editDoc) return;
    editDoc = app.activeDoc;
    const l = layerFor ? layerFor() : null;
    if (editDoc && l) editDoc.beginEdit(l);
  };

  return {
    bump() {
      start();
      owed = true;
      ready = false;
      clearTimeout(timer);
      timer = setTimeout(() => { ready = true; settle(); }, 380);
    },
    /** The user released a control — commit as soon as rendering catches up. */
    flush() {
      ready = true;
      settle();
    },
    /** Hold the commit back until an async re-render has landed. */
    async track(promise) {
      inFlight++;
      try {
        await promise;
      } finally {
        inFlight--;
        settle();
      }
    },
  };
}

/** Wire pointerup/change on a form so releasing a slider commits immediately. */
function commitOnRelease(node, committer) {
  const flush = () => committer.flush();
  node.addEventListener('pointerup', flush);
  node.addEventListener('change', flush);
  return () => {
    node.removeEventListener('pointerup', flush);
    node.removeEventListener('change', flush);
  };
}

/* ------------------------------------------------------------------ */
/* Adjustment layers                                                   */
/* ------------------------------------------------------------------ */

function adjustmentSection(doc, layer) {
  const kind = layer.adjustment.kind;
  const def = getAdjustment(kind);
  const node = el('div.pk-panel-section');

  if (!def) {
    node.appendChild(el('div.pk-panel-note', { text: `Unknown adjustment "${kind}".` }));
    return { node };
  }

  const state = { ...(def.defaults || {}), ...(layer.adjustment.params || {}) };
  layer.adjustment.params = state;

  const committer = makeCommitter(`${def.name.replace(/(\.\.\.|…)$/, '')} Layer`);
  const form = buildForm(def.params || [], state, (key, value) => {
    state[key] = value;
    form.refresh();
    doc.touch('adjustment');
    committer.bump();
  });

  node.appendChild(form.node);
  node.appendChild(el('div.pk-prop-actions', {},
    el('button.pk-mini-btn', {
      type: 'button', text: 'Reset',
      onclick: () => {
        Object.assign(state, defaultParams(kind));
        form.refresh();
        doc.commit(`Reset ${def.name.replace(/(\.\.\.|…)$/, '')}`);
      },
    }),
    el('button.pk-mini-btn', {
      type: 'button', text: layer.clipped ? 'Release Clip' : 'Clip to Layer',
      onclick: () => ops.toggleClipping(doc, layer),
    }),
    el('button.pk-mini-btn', {
      type: 'button', text: 'Delete',
      onclick: () => ops.deleteLayers(doc, [layer]),
    })
  ));

  const off = commitOnRelease(node, committer);
  return { node, sync: () => form.refresh(), dispose: () => { off(); committer.flush(); } };
}

/* ------------------------------------------------------------------ */
/* Layer masks                                                         */
/* ------------------------------------------------------------------ */

/**
 * Density and feather are applied **destructively** to `layer.mask`, but a
 * pristine copy of the mask is cached on the layer (`_maskBase`) so dragging
 * the sliders is never cumulative. Painting on the mask elsewhere invalidates
 * the cache, which re-seeds the base and resets the sliders.
 */
function ensureMaskBase(layer) {
  if (layer._maskBase && layer._maskBaseVersion === layer.maskVersion) return;
  layer._maskBase = cloneCanvas(layer.mask);
  layer._maskBaseVersion = layer.maskVersion;
  layer.maskDensity = 100;
  layer.maskFeather = 0;
}

function rebuildMask(layer) {
  const base = layer._maskBase;
  if (!base || !layer.mask) return;
  const w = base.width, h = base.height;
  const src = getImageData(base).data;
  let lum = new Uint8ClampedArray(w * h);
  for (let p = 0, i = 0; p < lum.length; p++, i += 4) {
    lum[p] = (src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114) * (src[i + 3] / 255);
  }
  const feather = Math.max(0, layer.maskFeather || 0);
  if (feather > 0) lum = boxBlurMask(lum, w, h, feather);

  const density = clamp(layer.maskDensity == null ? 100 : layer.maskDensity, 0, 100) / 100;
  const out = new ImageData(w, h);
  const o = out.data;
  for (let p = 0, i = 0; p < lum.length; p++, i += 4) {
    const v = density >= 1 ? lum[p] : 255 - (255 - lum[p]) * density;
    o[i] = v; o[i + 1] = v; o[i + 2] = v; o[i + 3] = 255;
  }
  const cv = createCanvas(w, h);
  cv.getContext('2d').putImageData(out, 0, 0);
  layer.mask = cv;
  layer.touchMask();
  layer._maskBaseVersion = layer.maskVersion;
}

function maskSection(doc, layer) {
  const node = el('div.pk-panel-section');

  // When the cached base is stale the mask was edited elsewhere, so the stored
  // density/feather no longer describe it — show the defaults instead.
  const stale = !layer._maskBase || layer._maskBaseVersion !== layer.maskVersion;
  const state = {
    density: stale || layer.maskDensity == null ? 100 : layer.maskDensity,
    feather: stale || layer.maskFeather == null ? 0 : layer.maskFeather,
  };

  // Feathering a document-sized mask is a multi-pass blur, so coalesce the
  // rebuild to one per frame no matter how fast the slider moves.
  let dirty = false;
  const rebuildNow = () => {
    if (!dirty) return;
    dirty = false;
    layer.maskDensity = state.density;
    layer.maskFeather = state.feather;
    rebuildMask(layer);
    doc.touch('mask');
  };
  const scheduleRebuild = () => {
    if (dirty) return;
    dirty = true;
    requestAnimationFrame(rebuildNow);
  };

  const committer = makeCommitter('Mask Density / Feather', {
    layerFor: () => {
      // Capture the pristine mask before copy-on-write bumps the version.
      ensureMaskBase(layer);
      return layer;
    },
    before: rebuildNow,
  });

  const form = buildForm([
    { key: 'density', label: 'Density', type: 'slider', min: 0, max: 100, step: 1, unit: '%' },
    { key: 'feather', label: 'Feather', type: 'slider', min: 0, max: 250, step: 1, unit: 'px' },
  ], state, (key, value) => {
    state[key] = value;
    committer.bump();
    // `bump()` ran beginEdit, which bumped maskVersion — re-anchor the base.
    layer._maskBaseVersion = layer.maskVersion;
    scheduleRebuild();
    form.refresh();
  });

  node.appendChild(form.node);
  node.appendChild(el('div.pk-panel-note', {
    text: 'Density fades the mask toward fully revealed; Feather softens its edges. Both are baked into the mask pixels when you commit.',
  }));

  node.appendChild(el('div.pk-prop-actions', {},
    el('button.pk-mini-btn', {
      type: 'button', text: 'Invert',
      onclick: () => {
        doc.beginEdit(layer);
        layer.maskInverted = !layer.maskInverted;
        layer.touchMask();
        layer._maskBaseVersion = -1;
        doc.commit('Invert Mask');
      },
    }),
    el('button.pk-mini-btn', {
      type: 'button', text: layer.maskEnabled ? 'Disable' : 'Enable',
      onclick: () => ops.toggleMaskEnabled(doc, layer),
    }),
    el('button.pk-mini-btn', { type: 'button', text: 'Apply', onclick: () => ops.applyLayerMask(doc, layer) }),
    el('button.pk-mini-btn', { type: 'button', text: 'Delete', onclick: () => ops.deleteLayerMask(doc, layer) })
  ));

  const off = commitOnRelease(node, committer);
  return { node, sync: () => form.refresh(), dispose: () => { off(); committer.flush(); } };
}

/* ------------------------------------------------------------------ */
/* Text layers                                                         */
/* ------------------------------------------------------------------ */

/** Colours may arrive as `{r,g,b,a}` or CSS — the form controls need hex. */
function asHex(v) {
  try {
    return toHex(parseColor(v == null ? '#000000' : v));
  } catch {
    return '#000000';
  }
}

/**
 * `lineHeight` is a multiplier of the type size, except above 5 where
 * text-render.js reads it as an absolute pixel leading. The panel always shows
 * a percentage, so both conventions round-trip.
 */
function leadingPercent(t) {
  const lh = Number(t.lineHeight);
  if (!Number.isFinite(lh) || lh <= 0) return 0;
  const size = Math.max(1, Number(t.size) || 16);
  return Math.round((lh > 5 ? lh / size : lh) * 100);
}

function textSection(doc, layer) {
  // `layer.text` is owned by src/text/text-render.js — see defaultTextProps().
  const t = layer.text;
  if (t.content == null) t.content = '';
  if (t.font == null) t.font = t.family || 'system';
  if (t.size == null) t.size = 48;
  if (t.color == null) t.color = toHex(app.foreground);
  if (t.align == null) t.align = 'left';
  if (t.weight == null) t.weight = 400;
  if (t.style == null) t.style = t.italic ? 'italic' : 'normal';
  if (t.letterSpacing == null) t.letterSpacing = 0;

  // Shared builder — it already prepends a family the list does not have, which
  // is what the ad-hoc code here used to do.
  const families = fontFamilyOptions(t.font);

  const state = {
    content: String(t.content),
    font: t.font,
    size: Number(t.size) || 48,
    weight: Number(t.weight) || 400,
    italic: t.style === 'italic' || !!t.italic,
    color: asHex(t.color),
    align: t.align,
    leading: leadingPercent(t),
    tracking: Number(t.letterSpacing) || 0,
  };

  const node = el('div.pk-panel-section');
  // No beginEdit: the payload is deep-copied into history snapshots and the
  // canvas is *replaced* rather than drawn into, so older states stay intact.
  const committer = makeCommitter('Edit Text');
  let token = 0;

  const apply = async () => {
    t.content = state.content;
    t.font = state.font;
    t.size = state.size;
    t.weight = state.weight;
    t.style = state.italic ? 'italic' : 'normal';
    t.italic = state.italic;
    t.color = state.color;
    t.align = state.align;
    t.letterSpacing = state.tracking;
    t.lineHeight = state.leading > 0 ? state.leading / 100 : 0;
    const mine = ++token;
    try {
      const mod = await textMod();
      await ensureFont(state.font, state.weight, t.style).catch(() => false);
      if (mine !== token) return;
      const fn = mod.rasterizeTextLayer;
      if (typeof fn !== 'function') throw new Error('Text renderer is unavailable.');
      layer.canvas = fn(layer, doc);
      doc.touch('text');
    } catch (err) {
      console.error(err);
      app.toast(err && err.message ? err.message : 'Could not render the text layer.', 'error');
    }
  };

  const form = buildForm([
    { key: 'content', label: 'Text', type: 'textarea', rows: 3 },
    { key: 'font', label: 'Font', type: 'select', options: families },
    { key: 'weight', label: 'Weight', type: 'select', options: FONT_WEIGHTS },
    { key: 'size', label: 'Size', type: 'slider', min: 4, max: 400, step: 1, unit: 'px' },
    { key: 'color', label: 'Color', type: 'color' },
    { key: 'align', label: 'Alignment', type: 'select', options: ALIGNS },
    { key: 'leading', label: 'Leading', type: 'slider', min: 0, max: 500, step: 5, unit: '%', hint: '0 = automatic' },
    { key: 'tracking', label: 'Tracking', type: 'slider', min: -50, max: 200, step: 0.5, unit: 'px' },
    { key: 'italic', label: 'Italic', type: 'checkbox' },
  ], state, (key, value) => {
    state[key] = value;
    form.refresh();
    committer.bump();
    committer.track(apply());
  });

  node.appendChild(form.node);
  node.appendChild(el('div.pk-prop-actions', {},
    el('button.pk-mini-btn', { type: 'button', text: 'Rasterize', onclick: () => ops.rasterizeLayer(doc, layer) })
  ));

  const off = commitOnRelease(node, committer);
  return { node, sync: () => form.refresh(), dispose: () => { off(); committer.flush(); } };
}

/* ------------------------------------------------------------------ */
/* Shape layers                                                        */
/* ------------------------------------------------------------------ */

/**
 * `layer.shape.fill` is one of: `null`, `'none'`, a CSS string, or a descriptor
 * `{type:'solid'|'linear'|'radial'|'pattern'|'none', color, stops, …}`. Fill
 * layers from `layers/ops.js` instead carry `kind:'fill'` + `fillKind`.
 * @returns {{type:string, color:string}}
 */
function readShapeFill(s) {
  const f = s.fill;
  if (f === null || f === 'none') return { type: 'none', color: '#000000' };
  if (typeof f === 'string') return { type: 'solid', color: f };
  if (f && typeof f === 'object') {
    if (f.type === 'none') return { type: 'none', color: f.color || '#000000' };
    if (!f.type || f.type === 'solid') return { type: 'solid', color: f.color || '#000000' };
    return { type: f.type, color: f.color || '#000000' };
  }
  if (s.kind === 'fill') {
    if (s.fillKind === 'gradient') return { type: 'linear', color: '#000000' };
    if (s.fillKind === 'pattern') return { type: 'pattern', color: '#000000' };
    return { type: 'solid', color: s.color || '#808080' };
  }
  return { type: 'solid', color: s.color || '#000000' };
}

/** Stroke descriptor with every key `rasterizeShapeLayer` looks at. */
function readShapeStroke(s) {
  const st = s.stroke && typeof s.stroke === 'object' ? s.stroke : null;
  return {
    enabled: st ? st.enabled !== false : false,
    color: st && st.color ? st.color : '#000000',
    width: st ? (st.width == null ? 1 : Number(st.width) || 0) : 0,
    align: (st && st.align) || 'center',
    cap: (st && st.cap) || 'butt',
    join: (st && st.join) || 'miter',
    dash: st && typeof st.dash === 'string' ? st.dash : 'solid',
  };
}

/**
 * The bounding box of an axis-aligned rectangular shape, or null when the
 * geometry is not a rectangle. Anchors alone give the exact box for both plain
 * and rounded rectangles, because rounded corners still touch all four edges.
 */
function rectBoxOf(s) {
  const sp = s.subpaths;
  if (!sp || sp.length !== 1 || !sp[0].closed) return null;
  const pts = sp[0].points || [];
  if (!pts.length) return null;
  const rounded = s.radius != null || Array.isArray(s.corners);
  if (!rounded) {
    if (pts.length !== 4 || pts.some((p) => p.in || p.out)) return null;
    const xs = new Set(pts.map((p) => Math.round(p.x * 100)));
    const ys = new Set(pts.map((p) => Math.round(p.y * 100)));
    if (xs.size !== 2 || ys.size !== 2) return null;
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  if (!(x1 > x0 && y1 > y0)) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function shapeSection(doc, layer) {
  const s = layer.shape;
  const fill = readShapeFill(s);
  const stroke = readShapeStroke(s);
  const box = rectBoxOf(s);
  const maxRadius = box ? Math.floor(Math.min(box.width, box.height) / 2) : 0;
  const complexFill = fill.type !== 'solid' && fill.type !== 'none';

  const state = {
    fillOn: fill.type !== 'none',
    fill: asHex(fill.color),
    stroke: asHex(stroke.color),
    width: stroke.enabled ? stroke.width : 0,
    align: stroke.align,
    dash: stroke.dash,
    radius: clamp(Number(s.radius) || 0, 0, Math.max(0, maxRadius)),
  };

  const node = el('div.pk-panel-section');
  // See textSection: replacing the canvas keeps history snapshots valid.
  const committer = makeCommitter('Edit Shape');
  let token = 0;

  const apply = async (geometryChanged) => {
    if (!complexFill) {
      s.fill = state.fillOn ? { type: 'solid', color: state.fill } : { type: 'none' };
      if (s.kind === 'fill') s.color = state.fill;
    } else if (!state.fillOn) {
      s.fill = { type: 'none' };
    }
    s.stroke = {
      ...(s.stroke && typeof s.stroke === 'object' ? s.stroke : {}),
      enabled: state.width > 0,
      color: state.stroke,
      width: state.width,
      align: state.align,
      cap: stroke.cap,
      join: stroke.join,
      dash: state.dash,
    };
    const mine = ++token;
    try {
      const mod = await shapeMod();
      if (mine !== token) return;
      if (geometryChanged && box) {
        const { roundedRectSubpath } = await import('../../tools/shape.js');
        if (mine !== token) return;
        const r = state.radius;
        s.radius = r;
        s.corners = [r, r, r, r];
        s.subpaths = [roundedRectSubpath(box, s.corners)];
      }
      const fn = mod.rasterizeShapeLayer;
      if (typeof fn !== 'function') throw new Error('Shape renderer is unavailable.');
      layer.canvas = fn(layer, doc);
      doc.touch('shape');
    } catch (err) {
      console.error(err);
      app.toast(err && err.message ? err.message : 'Could not render the shape layer.', 'error');
    }
  };

  const form = buildForm([
    { key: 'fillOn', label: 'Fill', type: 'checkbox' },
    { key: 'fill', label: 'Fill color', type: 'color', when: (st) => st.fillOn && !complexFill },
    { key: 'stroke', label: 'Stroke color', type: 'color' },
    { key: 'width', label: 'Stroke width', type: 'slider', min: 0, max: 100, step: 0.5, unit: 'px' },
    { key: 'align', label: 'Stroke align', type: 'select', options: STROKE_ALIGNS, when: (st) => st.width > 0 },
    { key: 'dash', label: 'Dash', type: 'select', options: DASH_OPTIONS, when: (st) => st.width > 0 },
    {
      key: 'radius', label: 'Corner radius', type: 'slider',
      min: 0, max: Math.max(1, maxRadius), step: 1, unit: 'px',
      when: () => !!box,
    },
  ], state, (key, value) => {
    state[key] = value;
    form.refresh();
    committer.bump();
    committer.track(apply(key === 'radius'));
  });

  node.appendChild(form.node);
  if (complexFill) {
    node.appendChild(el('div.pk-panel-note', {
      text: `This layer uses a ${fill.type === 'pattern' ? 'pattern' : 'gradient'} fill. Turn Fill off to remove it, or edit it with the shape tools.`,
    }));
  }
  node.appendChild(el('div.pk-panel-note', {
    text: `${(s.subpaths || []).length} subpath${(s.subpaths || []).length === 1 ? '' : 's'} · edit the geometry with the Path Selection tools.`,
  }));
  node.appendChild(el('div.pk-prop-actions', {},
    el('button.pk-mini-btn', { type: 'button', text: 'Rasterize', onclick: () => ops.rasterizeLayer(doc, layer) })
  ));

  const off = commitOnRelease(node, committer);
  return { node, sync: () => form.refresh(), dispose: () => { off(); committer.flush(); } };
}

/* ------------------------------------------------------------------ */
/* Smart objects                                                       */
/* ------------------------------------------------------------------ */

const round2 = (n) => Math.round(n * 100) / 100;
const DEG = 180 / Math.PI;

/**
 * Smart Object properties: the embedded source size, the live transform, and
 * the smart-filter count.
 *
 * Every edit here only writes a matrix — `setSmartTransform` re-renders from
 * the embedded document, so dragging Width down to 10% and back to 100% costs
 * nothing in quality. The panel therefore never calls `beginEdit` itself; the
 * committer opens the copy-on-write window and `setSmartTransform` replaces
 * `layer.canvas` outright. Perspective and the warp mesh are *not* touched: the
 * matrix is only the affine part of the layer's shape, so editing Width here
 * leaves a perspective from Free Transform exactly where it was.
 *
 * Skew, and why there are two fields for one degree of freedom
 * -----------------------------------------------------------
 * An affine matrix has six degrees of freedom; centre, scale and rotation
 * already account for five, so only one shear survives a round trip through the
 * matrix. Both Skew X and Skew Y are therefore authored here and composed
 * faithfully, but a re-read (after Free Transform, an undo, or another panel
 * writing the matrix) shows the canonical form, where the whole shear sits in
 * Skew X. While the panel is the one driving the matrix it keeps whatever the
 * user typed, so the fields do not jump around under the cursor.
 */
function smartSection(doc, layer) {
  const s = layer.smart;
  const node = el('div.pk-panel-section');
  const d = decomposeMatrix(getSmartTransform(layer), s.sourceWidth, s.sourceHeight);

  const state = {
    x: round2(d.centerX),
    y: round2(d.centerY),
    scaleX: round2(d.scaleX * 100),
    scaleY: round2(d.scaleY * 100),
    angle: round2(d.angle * DEG),
    skewX: round2(d.skewX * DEG),
    skewY: 0,
    linked: Math.abs(d.scaleX - d.scaleY) < 1e-6,
  };

  /** The matrix this panel last wrote — see the note about Skew Y above. */
  let owned = null;

  const matrixFor = () => composeMatrix({
    centerX: Number(state.x) || 0,
    centerY: Number(state.y) || 0,
    scaleX: (Number(state.scaleX) || 0) / 100,
    scaleY: (Number(state.linked ? state.scaleX : state.scaleY) || 0) / 100,
    angle: ((Number(state.angle) || 0) * Math.PI) / 180,
    skewX: ((Number(state.skewX) || 0) * Math.PI) / 180,
    skewY: ((Number(state.skewY) || 0) * Math.PI) / 180,
  }, s.sourceWidth, s.sourceHeight);

  const committer = makeCommitter('Transform Smart Object', { layerFor: () => layer });

  const form = buildForm([
    { key: 'x', label: 'Center X', type: 'number', step: 1, unit: 'px' },
    { key: 'y', label: 'Center Y', type: 'number', step: 1, unit: 'px' },
    { key: 'linked', label: 'Constrain proportions', type: 'checkbox' },
    { key: 'scaleX', label: 'Width', type: 'slider', min: 1, max: 400, step: 0.5, unit: '%' },
    { key: 'scaleY', label: 'Height', type: 'slider', min: 1, max: 400, step: 0.5, unit: '%', when: (v) => !v.linked },
    { key: 'angle', label: 'Rotate', type: 'angle' },
    { key: 'skewX', label: 'Skew X', type: 'slider', min: -85, max: 85, step: 0.5, unit: '°' },
    { key: 'skewY', label: 'Skew Y', type: 'slider', min: -85, max: 85, step: 0.5, unit: '°' },
  ], state, (key, value) => {
    state[key] = value;
    if (key === 'linked' && value) state.scaleY = state.scaleX;
    form.refresh();
    committer.bump();
    const m = matrixFor();
    owned = m.slice();
    setSmartTransform(doc, layer, m, { commit: false });
  });

  node.appendChild(form.node);

  const filters = getSmartFilters(layer);
  const scaleText = () => `${round2(state.scaleX)}% × ${round2(state.linked ? state.scaleX : state.scaleY)}%`;
  const shapeText = () => {
    const p = getSmartPerspective(layer);
    const bits = [];
    if (p[0] || p[1]) bits.push(`perspective ${round2(p[0] * 1000)}, ${round2(p[1] * 1000)} ‰`);
    if (getSmartWarp(layer)) bits.push('warp mesh');
    return bits.length ? bits.join(' · ') : 'None';
  };
  const sizeVal = el('span.pk-panel-val', { text: `${s.sourceWidth} × ${s.sourceHeight} px` });
  const scaleVal = el('span.pk-panel-val', { text: scaleText() });
  const posVal = el('span.pk-panel-val', { text: `${Math.round(state.x)}, ${Math.round(state.y)}` });
  const shapeVal = el('span.pk-panel-val', { text: shapeText() });
  const layerVal = el('span.pk-panel-val', { text: String(s.source.flatLayers().length) });
  const filterVal = el('span.pk-panel-val', {
    text: filters.length ? `${filters.length} (${filters.filter((f) => f.enabled).length} on)` : 'None',
  });

  node.appendChild(el('div.pk-panel-grid.pk-prop-smart-grid', {},
    el('span.pk-panel-key', { text: 'Source size' }), sizeVal,
    el('span.pk-panel-key', { text: 'Source layers' }), layerVal,
    el('span.pk-panel-key', { text: 'Scale' }), scaleVal,
    el('span.pk-panel-key', { text: 'Center' }), posVal,
    el('span.pk-panel-key', { text: 'Distortion' }), shapeVal,
    el('span.pk-panel-key', { text: 'Smart filters' }), filterVal
  ));

  node.appendChild(el('div.pk-panel-note', {
    text: 'Centre, scale, rotation and skew are one matrix; perspective and warp ride alongside it. All of them, plus the smart filters, are re-applied to the embedded source on every render, so nothing here is baked into pixels until you rasterize.',
  }));

  const clearBtn = el('button.pk-mini-btn', {
    type: 'button', text: 'Clear Distortion',
    onclick: () => { clearSmartShape(doc, layer); sync(); },
  });

  node.appendChild(el('div.pk-prop-actions', {},
    el('button.pk-mini-btn', { type: 'button', text: 'Edit Contents', onclick: () => editSmartContents(doc, layer) }),
    el('button.pk-mini-btn', {
      type: 'button', text: 'Replace…',
      onclick: async () => {
        const mod = await import('../dialogs/smart-object.js');
        await mod.showReplaceContentsDialog(doc, layer);
      },
    }),
    el('button.pk-mini-btn', { type: 'button', text: 'Export…', onclick: () => exportSmartContents(doc, layer) }),
    clearBtn,
    el('button.pk-mini-btn', {
      type: 'button', text: 'Reset',
      onclick: () => { resetSmartTransform(doc, layer); sync(); },
    }),
    el('button.pk-mini-btn', { type: 'button', text: 'Rasterize', onclick: () => ops.rasterizeLayer(doc, layer) })
  ));

  const off = commitOnRelease(node, committer);
  const sync = () => {
    const m = getSmartTransform(layer);
    const mine = owned && m.every((n, i) => Math.abs(n - owned[i]) < 1e-9);
    if (!mine) {
      // Somebody else moved the matrix (Free Transform, undo, a script), so the
      // authored skew pair no longer describes it — show the canonical form.
      const cur = decomposeMatrix(m, layer.smart.sourceWidth, layer.smart.sourceHeight);
      state.x = round2(cur.centerX);
      state.y = round2(cur.centerY);
      state.scaleX = round2(cur.scaleX * 100);
      state.scaleY = round2(cur.scaleY * 100);
      state.angle = round2(cur.angle * DEG);
      state.skewX = round2(cur.skewX * DEG);
      state.skewY = 0;
      owned = null;
    }
    form.refresh();
    sizeVal.textContent = `${layer.smart.sourceWidth} × ${layer.smart.sourceHeight} px`;
    scaleVal.textContent = scaleText();
    posVal.textContent = `${Math.round(state.x)}, ${Math.round(state.y)}`;
    shapeVal.textContent = shapeText();
    clearBtn.style.display = shapeVal.textContent === 'None' ? 'none' : '';
    layerVal.textContent = String(layer.smart.source.flatLayers().length);
    const fl = getSmartFilters(layer);
    filterVal.textContent = fl.length ? `${fl.length} (${fl.filter((f) => f.enabled).length} on)` : 'None';
  };
  sync();
  return { node, sync, dispose: () => { off(); committer.flush(); } };
}

/* ------------------------------------------------------------------ */
/* Document properties                                                 */
/* ------------------------------------------------------------------ */

function documentSection(doc) {
  const node = el('div.pk-panel-section');

  const wIn = el('input.pk-input', { type: 'number', min: 1, max: 20000, step: 1, value: doc.width });
  const hIn = el('input.pk-input', { type: 'number', min: 1, max: 20000, step: 1, value: doc.height });
  const resIn = el('input.pk-input', { type: 'number', min: 1, max: 2400, step: 1, value: doc.resolution });
  const constrain = el('input', { type: 'checkbox', checked: true });

  wIn.addEventListener('input', () => {
    if (!constrain.checked) return;
    const w = Number(wIn.value);
    if (w > 0) hIn.value = String(Math.max(1, Math.round((w * doc.height) / doc.width)));
  });
  hIn.addEventListener('input', () => {
    if (!constrain.checked) return;
    const h = Number(hIn.value);
    if (h > 0) wIn.value = String(Math.max(1, Math.round((h * doc.width) / doc.height)));
  });

  const applyBtn = el('button.pk-btn.primary', {
    type: 'button', text: 'Apply',
    onclick: () => {
      const w = clamp(Math.round(Number(wIn.value) || doc.width), 1, 20000);
      const h = clamp(Math.round(Number(hIn.value) || doc.height), 1, 20000);
      const res = clamp(Math.round(Number(resIn.value) || doc.resolution), 1, 2400);
      let changed = false;
      if (res !== doc.resolution) { doc.resolution = res; changed = true; }
      if (w !== doc.width || h !== doc.height) {
        doc.resample(w, h);
        doc.commit('Image Size');
        return;
      }
      if (changed) doc.commit('Document Resolution');
    },
  });

  node.append(
    el('div.pk-panel-grid', {},
      el('span.pk-panel-key', { text: 'Width' }), wIn,
      el('span.pk-panel-key', { text: 'Height' }), hIn,
      el('span.pk-panel-key', { text: 'Resolution' }), el('div.pk-slider-row', {}, resIn, el('span.pk-unit', { text: 'ppi' })),
      el('span.pk-panel-key', { text: 'Color mode' }), el('span.pk-panel-val', { text: colorModeLabel(doc) }),
      el('span.pk-panel-key', { text: 'Layers' }), el('span.pk-panel-val.pk-doc-layers', { text: String(doc.flatLayers().length) })
    ),
    el('label.pk-check', {}, constrain, el('span', { text: 'Constrain proportions' })),
    el('div.pk-prop-actions', {}, applyBtn)
  );

  node.appendChild(el('hr.pk-sep'));
  node.appendChild(el('div.pk-prop-actions', {},
    el('button.pk-mini-btn', { type: 'button', text: 'Fit on Screen', onclick: () => app.fitView(8) }),
    el('button.pk-mini-btn', { type: 'button', text: 'Trim', onclick: () => ops.trimDocument(doc, 'transparent') }),
    el('button.pk-mini-btn', { type: 'button', text: 'Flatten', onclick: () => ops.flattenImage(doc) }),
    el('button.pk-mini-btn', { type: 'button', text: 'New Layer', onclick: () => ops.addRasterLayer(doc) }),
    el('button.pk-mini-btn', {
      type: 'button', text: 'Add Mask',
      onclick: () => {
        const l = doc.activeLayer();
        if (!l) return;
        ops.addLayerMask(doc, l, doc.selection.active ? 'reveal-selection' : 'reveal-all');
      },
    })
  ));

  const sync = () => {
    if (document.activeElement !== wIn) wIn.value = String(doc.width);
    if (document.activeElement !== hIn) hIn.value = String(doc.height);
    if (document.activeElement !== resIn) resIn.value = String(doc.resolution);
    const n = node.querySelector('.pk-doc-layers');
    if (n) n.textContent = String(doc.flatLayers().length);
  };

  return { node, sync };
}

function colorModeLabel(doc) {
  const m = String(doc.colorMode || 'rgb').toLowerCase();
  if (m === 'gray' || m === 'grayscale') return 'Grayscale · 8 bit';
  if (m === 'cmyk') return 'CMYK · 8 bit';
  return 'RGB Color · 8 bit';
}
