import { el, clamp } from '../core/util.js';
import { toHex, parseColor } from '../core/color.js';
import { Dialog, buildForm } from '../ui/dialog.js';
import { BLEND_MODES } from '../core/blend.js';
import { LayerType } from '../core/layer.js';
import { app } from '../core/app.js';
import { patternOptions } from '../paint/patterns.js';
import { DEFAULT_STYLES, defaultStyle } from './styles.js';
import { gradientLUT } from './effect-renderers.js';
import './styles.css';

/**
 * The Layer Style dialog — Photoshop's two-column effects editor.
 *
 * The left column lists Blending Options plus the ten effects with an enable
 * checkbox each; the right column is a generated form for the selected page.
 * Every change writes into a working copy of `layer.styles`, assigns it to the
 * layer and calls `doc.touch()`, so the canvas previews live without touching
 * history. Cancel restores the original styles and blending values; OK records
 * a single "Layer Style" undo step.
 */

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * Spread / Choke / Noise are 0..1 here but the PSD importer leaves them as raw
 * percentages, so anything above 1 is read as one — the same rule the renderers
 * apply. Re-saving through this dialog normalises the value.
 */
const frac = (v) => {
  const n = num(v, 0);
  return clamp(n > 1 ? n / 100 : n, 0, 1);
};

const BLEND_OPTIONS = BLEND_MODES.map((m) => ({ value: m.id, label: m.name }));

const GRADIENT_TYPES = [
  { value: 'linear', label: 'Linear' },
  { value: 'radial', label: 'Radial' },
  { value: 'angle', label: 'Angle' },
  { value: 'reflected', label: 'Reflected' },
  { value: 'diamond', label: 'Diamond' },
];

const DEFAULT_STOPS = [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }];

/**
 * Fields the renderers understand but `DEFAULT_STYLES` does not seed (gradient
 * glows, gradient/pattern strokes, gradient alignment).
 */
const EXTRA_DEFAULTS = {
  outerGlow: { fillType: 'color', stops: DEFAULT_STOPS, reverse: false },
  innerGlow: { fillType: 'color', stops: DEFAULT_STOPS, reverse: false },
  gradientOverlay: { alignWithLayer: true },
  stroke: { style: 'linear', scale: 1, reverse: false, alignWithLayer: true, patternId: null, patternScale: 1 },
};

/* ------------------------------------------------------------------ */
/* Reusable descriptor pieces                                          */
/* ------------------------------------------------------------------ */

const sectionLabel = (label, when) => ({ type: 'label', label, when });

const blendParam = (key = 'blendMode', label = 'Blend Mode') => ({ key, label, type: 'select', options: BLEND_OPTIONS });

/** Opacity-style field: stored 0..1, edited as a percentage. */
const pctParam = (key, label, min = 0, max = 100, when) => ({
  key, label, type: 'slider', min, max, step: 1, unit: '%', pct: true, when,
});

/** A percentage that can never exceed 100 — read through {@link frac}. */
const fracParam = (key, label, when) => ({ ...pctParam(key, label, 0, 100, when), frac: true });

const pxParam = (key, label, max = 250, when) => ({
  key, label, type: 'slider', min: 0, max, step: 1, unit: 'px', when,
});

const colorParam = (key, label, when) => ({ key, label, type: 'color', when });

const angleParams = () => [
  { key: 'angle', label: 'Angle', type: 'angle' },
  { key: 'useGlobalLight', label: 'Use Global Light', type: 'checkbox' },
];

function gradientParams(when) {
  return [
    stopsParam('stops', 'Gradient', when),
    { key: 'reverse', label: 'Reverse', type: 'checkbox', when },
    { key: 'style', label: 'Style', type: 'select', options: GRADIENT_TYPES, when },
    { key: 'angle', label: 'Angle', type: 'angle', when },
    pctParam('scale', 'Scale', 10, 300, when),
    { key: 'alignWithLayer', label: 'Align with Layer', type: 'checkbox', when },
  ];
}

/** Id of the first registered pattern, used to seed an unset pattern field. */
function firstPatternId() {
  const list = patternOptions();
  return list.length ? list[0].value : null;
}

function patternParams(idKey, scaleKey, when) {
  return [
    {
      key: idKey, label: 'Pattern', type: 'select', when,
      options: [{ value: '', label: 'None' }, ...patternOptions()],
    },
    pctParam(scaleKey, 'Scale', 10, 400, when),
  ];
}

/* ------------------------------------------------------------------ */
/* Gradient stop editor (custom ParamDescriptor)                       */
/* ------------------------------------------------------------------ */

function normalizeStops(v) {
  const src = Array.isArray(v) && v.length ? v : DEFAULT_STOPS;
  const out = src.map((s) => {
    const p = num(s && s.pos, 0);
    return { pos: clamp(p > 1 ? p / 100 : p, 0, 1), color: hexOf(s && s.color) };
  });
  while (out.length < 2) out.push({ pos: 1, color: '#ffffff' });
  return out;
}

function hexOf(c) {
  try {
    return toHex(parseColor(c || '#000000'));
  } catch {
    return '#000000';
  }
}

/**
 * A compact gradient editor: a live ramp preview plus one row per stop
 * (colour, position, delete) and an add button.
 */
function stopsParam(key, label, when) {
  return {
    key, label, when, type: 'custom',
    render(container, state, onChange, p) {
      let stops = normalizeStops(state[p.key]);
      const bar = el('canvas.pk-fx-ramp', { width: 256, height: 18 });
      const rows = el('div.pk-fx-stops');
      const addBtn = el('button.pk-btn.subtle.pk-fx-add-stop', { type: 'button', text: 'Add stop' });

      const emit = () => onChange(p.key, stops.map((s) => ({ pos: s.pos, color: s.color })));

      const paint = () => {
        const lut = gradientLUT(stops, false);
        const ctx = bar.getContext('2d');
        ctx.clearRect(0, 0, bar.width, bar.height);
        for (let i = 0; i < 256; i++) {
          ctx.fillStyle = `rgba(${Math.round(lut.r[i])},${Math.round(lut.g[i])},${Math.round(lut.b[i])},${lut.a[i]})`;
          ctx.fillRect(i, 0, 1, bar.height);
        }
      };

      const build = () => {
        rows.replaceChildren(
          ...stops.map((stop, i) => {
            const color = el('input.pk-fx-stop-color', { type: 'color', value: stop.color });
            color.addEventListener('input', () => {
              stops[i].color = color.value;
              paint();
              emit();
            });
            const pos = el('input.pk-num', {
              type: 'number', min: 0, max: 100, step: 1, value: Math.round(stop.pos * 100),
            });
            pos.addEventListener('input', () => {
              const v = Number(pos.value);
              if (Number.isNaN(v)) return;
              stops[i].pos = clamp(v, 0, 100) / 100;
              paint();
              emit();
            });
            const del = el('button.pk-icon-btn.pk-fx-stop-del', {
              type: 'button', title: 'Delete stop', text: '×',
              disabled: stops.length <= 2,
              onclick: () => {
                if (stops.length <= 2) return;
                stops.splice(i, 1);
                build();
                paint();
                emit();
              },
            });
            return el('div.pk-fx-stop', {}, color, pos, el('span.pk-unit', { text: '%' }), del);
          })
        );
      };

      addBtn.addEventListener('click', () => {
        stops.push({ pos: 0.5, color: '#808080' });
        build();
        paint();
        emit();
      });

      container.append(bar, rows, addBtn);
      build();
      paint();

      return {
        sync(v) {
          const next = normalizeStops(v);
          if (JSON.stringify(next) === JSON.stringify(stops)) return;
          stops = next;
          build();
          paint();
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* The ten effect pages                                                */
/* ------------------------------------------------------------------ */

const isGradientFill = (s) => s.fillType === 'gradient';
const isColorFill = (s) => s.fillType !== 'gradient' && s.fillType !== 'pattern';

/**
 * The ten pages, in Photoshop's list order. Built per dialog so each instance
 * owns its own descriptor objects (and the `when` closures that go with them).
 */
function buildEffectPages() {
  return [
    {
      id: 'bevelEmboss',
      name: 'Bevel & Emboss',
      params: [
        sectionLabel('Structure'),
        {
          key: 'style', label: 'Style', type: 'select',
          options: [
            { value: 'inner', label: 'Inner Bevel' },
            { value: 'outer', label: 'Outer Bevel' },
            { value: 'emboss', label: 'Emboss' },
            { value: 'pillow-emboss', label: 'Pillow Emboss' },
          ],
        },
        {
          key: 'technique', label: 'Technique', type: 'select',
          options: [
            { value: 'smooth', label: 'Smooth' },
            { value: 'chisel-hard', label: 'Chisel Hard' },
            { value: 'chisel-soft', label: 'Chisel Soft' },
          ],
        },
        pctParam('depth', 'Depth', 1, 1000),
        {
          key: 'direction', label: 'Direction', type: 'radio',
          options: [{ value: 'up', label: 'Up' }, { value: 'down', label: 'Down' }],
        },
        pxParam('size', 'Size'),
        pxParam('soften', 'Soften', 16),
        sectionLabel('Shading'),
        ...angleParams(),
        { key: 'altitude', label: 'Altitude', type: 'slider', min: 0, max: 90, step: 1, unit: '°' },
        blendParam('highlightMode', 'Highlight Mode'),
        colorParam('highlightColor', 'Highlight Color'),
        pctParam('highlightOpacity', 'Highlight Opacity'),
        blendParam('shadowMode', 'Shadow Mode'),
        colorParam('shadowColor', 'Shadow Color'),
        pctParam('shadowOpacity', 'Shadow Opacity'),
      ],
    },
    {
      id: 'stroke',
      name: 'Stroke',
      params: [
        sectionLabel('Structure'),
        pxParam('size', 'Size'),
        {
          key: 'position', label: 'Position', type: 'select',
          options: [
            { value: 'outside', label: 'Outside' },
            { value: 'inside', label: 'Inside' },
            { value: 'center', label: 'Center' },
          ],
        },
        blendParam(),
        pctParam('opacity', 'Opacity'),
        {
          key: 'fillType', label: 'Fill Type', type: 'select',
          options: [
            { value: 'color', label: 'Color' },
            { value: 'gradient', label: 'Gradient' },
            { value: 'pattern', label: 'Pattern' },
          ],
        },
        colorParam('color', 'Color', isColorFill),
        ...gradientParams(isGradientFill),
        ...patternParams('patternId', 'patternScale', (s) => s.fillType === 'pattern'),
      ],
    },
    {
      id: 'innerShadow',
      name: 'Inner Shadow',
      params: [
        sectionLabel('Structure'),
        blendParam(),
        colorParam('color', 'Color'),
        pctParam('opacity', 'Opacity'),
        ...angleParams(),
        pxParam('distance', 'Distance'),
        fracParam('choke', 'Choke'),
        pxParam('size', 'Size'),
        sectionLabel('Quality'),
        fracParam('noise', 'Noise'),
      ],
    },
    {
      id: 'innerGlow',
      name: 'Inner Glow',
      params: [
        sectionLabel('Structure'),
        blendParam(),
        pctParam('opacity', 'Opacity'),
        fracParam('noise', 'Noise'),
        {
          key: 'fillType', label: 'Fill Type', type: 'radio',
          options: [{ value: 'color', label: 'Color' }, { value: 'gradient', label: 'Gradient' }],
        },
        colorParam('color', 'Color', isColorFill),
        stopsParam('stops', 'Gradient', isGradientFill),
        { key: 'reverse', label: 'Reverse', type: 'checkbox', when: isGradientFill },
        sectionLabel('Elements'),
        {
          key: 'source', label: 'Source', type: 'radio',
          options: [{ value: 'edge', label: 'Edge' }, { value: 'center', label: 'Center' }],
        },
        fracParam('choke', 'Choke'),
        pxParam('size', 'Size'),
      ],
    },
    {
      id: 'satin',
      name: 'Satin',
      params: [
        sectionLabel('Structure'),
        blendParam(),
        colorParam('color', 'Color'),
        pctParam('opacity', 'Opacity'),
        { key: 'angle', label: 'Angle', type: 'angle' },
        pxParam('distance', 'Distance'),
        pxParam('size', 'Size'),
        { key: 'invert', label: 'Invert', type: 'checkbox' },
      ],
    },
    {
      id: 'colorOverlay',
      name: 'Color Overlay',
      params: [
        blendParam(),
        colorParam('color', 'Color'),
        pctParam('opacity', 'Opacity'),
      ],
    },
    {
      id: 'gradientOverlay',
      name: 'Gradient Overlay',
      params: [
        blendParam(),
        pctParam('opacity', 'Opacity'),
        ...gradientParams(),
      ],
    },
    {
      id: 'patternOverlay',
      name: 'Pattern Overlay',
      params: [
        blendParam(),
        pctParam('opacity', 'Opacity'),
        ...patternParams('patternId', 'scale'),
      ],
    },
    {
      id: 'outerGlow',
      name: 'Outer Glow',
      params: [
        sectionLabel('Structure'),
        blendParam(),
        pctParam('opacity', 'Opacity'),
        fracParam('noise', 'Noise'),
        {
          key: 'fillType', label: 'Fill Type', type: 'radio',
          options: [{ value: 'color', label: 'Color' }, { value: 'gradient', label: 'Gradient' }],
        },
        colorParam('color', 'Color', isColorFill),
        stopsParam('stops', 'Gradient', isGradientFill),
        { key: 'reverse', label: 'Reverse', type: 'checkbox', when: isGradientFill },
        sectionLabel('Elements'),
        fracParam('spread', 'Spread'),
        pxParam('size', 'Size'),
      ],
    },
    {
      id: 'dropShadow',
      name: 'Drop Shadow',
      params: [
        sectionLabel('Structure'),
        blendParam(),
        colorParam('color', 'Color'),
        pctParam('opacity', 'Opacity'),
        ...angleParams(),
        pxParam('distance', 'Distance'),
        fracParam('spread', 'Spread'),
        pxParam('size', 'Size'),
        sectionLabel('Quality'),
        fracParam('noise', 'Noise'),
      ],
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

function globalLightOf(doc) {
  return num(doc.globalLight, 120);
}

function formStateFor(cfg, params) {
  const state = {};
  for (const p of params) {
    if (!p.key) continue;
    if (p.frac) state[p.key] = Math.round(frac(cfg[p.key]) * 100);
    else if (p.pct) state[p.key] = Math.round(num(cfg[p.key], 0) * 100);
    else state[p.key] = cfg[p.key];
  }
  return state;
}

/**
 * Open the full Layer Style dialog.
 * @param {import('../core/document.js').PikaDocument} doc
 * @param {import('../core/layer.js').Layer} layer
 * @param {string} [initialEffect] effect id to select (and enable) on open
 * @returns {Promise<boolean|null>} true on OK, null on cancel
 */
export function showLayerStyleDialog(doc, layer, initialEffect = null) {
  if (!doc || !layer) return Promise.resolve(null);
  if (layer.type === LayerType.ADJUSTMENT) {
    app.toast('Adjustment layers cannot have layer effects', 'warn');
    return Promise.resolve(null);
  }

  const pages = buildEffectPages();
  const original = layer.styles ? structuredClone(layer.styles) : null;
  const originalProps = {
    blendMode: layer.blendMode,
    opacity: layer.opacity,
    fillOpacity: layer.fillOpacity,
  };

  // Working copy: every effect present, seeded from defaults then the layer.
  const working = {};
  for (const page of pages) {
    working[page.id] = {
      ...defaultStyle(page.id),
      ...(EXTRA_DEFAULTS[page.id] ? structuredClone(EXTRA_DEFAULTS[page.id]) : null),
      ...(layer.styles && layer.styles[page.id] ? structuredClone(layer.styles[page.id]) : null),
    };
  }
  // A pattern effect with no pattern chosen renders nothing, so preselect the
  // first registered one exactly like Photoshop's picker does.
  const seedPattern = firstPatternId();
  if (seedPattern != null) {
    if (working.patternOverlay.patternId == null) working.patternOverlay.patternId = seedPattern;
    if (working.stroke.patternId == null) working.stroke.patternId = seedPattern;
  }
  if (initialEffect && working[initialEffect]) working[initialEffect].enabled = true;
  layer.styles = working;

  const preview = () => {
    layer.styles = working;
    doc.touch('layer-style');
  };

  const dlg = new Dialog({ title: 'Layer Style', width: 720, className: 'pk-fx-dialog' });
  const listEl = el('div.pk-fx-list.pk-scroll');
  const paneEl = el('div.pk-fx-pane.pk-scroll');
  const rowNodes = new Map();
  let current = initialEffect && working[initialEffect] ? initialEffect : '__blending';

  /* --- left column ------------------------------------------------- */

  const addRow = (id, name, withCheck) => {
    const row = el('div.pk-fx-row', { onclick: () => selectPage(id) });
    if (withCheck) {
      const box = el('input', {
        type: 'checkbox', checked: !!working[id].enabled, title: `Toggle ${name}`,
      });
      box.addEventListener('click', (e) => e.stopPropagation());
      box.addEventListener('change', () => {
        working[id].enabled = box.checked;
        row.classList.toggle('on', box.checked);
        preview();
      });
      row.append(el('label.pk-check', { onclick: (e) => e.stopPropagation() }, box));
      row.classList.toggle('on', !!working[id].enabled);
    } else {
      row.append(el('span.pk-fx-nocheck'));
    }
    row.append(el('span.pk-fx-name.pk-truncate', { text: name }));
    rowNodes.set(id, row);
    listEl.append(row);
  };

  addRow('__blending', 'Blending Options', false);
  listEl.append(el('hr.pk-sep.pk-fx-listsep'));
  for (const page of pages) addRow(page.id, page.name, true);

  /* --- right column ------------------------------------------------ */

  const pageTitle = (text, onReset) =>
    el('div.pk-fx-title', {},
      el('span', { text }),
      onReset ? el('button.pk-btn.subtle.pk-fx-reset', { type: 'button', text: 'Reset', onclick: onReset }) : null
    );

  function blendingPage() {
    const options = layer.type === LayerType.GROUP
      ? [{ value: 'pass-through', label: 'Pass Through' }, ...BLEND_OPTIONS]
      : BLEND_OPTIONS;
    const params = [
      sectionLabel('General Blending'),
      { key: 'blendMode', label: 'Blend Mode', type: 'select', options },
      pctParam('opacity', 'Opacity'),
      sectionLabel('Advanced Blending'),
      pctParam('fillOpacity', 'Fill Opacity'),
    ];
    const state = {
      blendMode: layer.blendMode || 'normal',
      opacity: Math.round(num(layer.opacity, 1) * 100),
      fillOpacity: Math.round(num(layer.fillOpacity, 1) * 100),
    };
    const form = buildForm(params, state, (key, value) => {
      state[key] = value;
      if (key === 'blendMode') layer.blendMode = value;
      else layer[key] = clamp(value, 0, 100) / 100;
      form.refresh();
      preview();
    });
    return [
      pageTitle('Blending Options'),
      form.node,
      el('div.pk-hint', { text: 'Fill Opacity fades the layer pixels only — layer effects keep their own opacity.' }),
    ];
  }

  function effectPage(page) {
    const cfg = working[page.id];
    // Effects that follow the global light angle read it from the document.
    if (cfg.useGlobalLight && 'angle' in cfg) cfg.angle = globalLightOf(doc);

    const state = formStateFor(cfg, page.params);
    const form = buildForm(page.params, state, (key, value) => {
      const p = page.params.find((x) => x.key === key);
      state[key] = value;
      cfg[key] = p && p.pct ? value / 100 : value;
      if (key === 'useGlobalLight' && value) {
        cfg.angle = globalLightOf(doc);
        state.angle = cfg.angle;
      }
      if (key === 'angle' && cfg.useGlobalLight) doc.globalLight = value;
      form.refresh();
      preview();
    });

    const reset = () => {
      const enabled = cfg.enabled;
      for (const k of Object.keys(cfg)) delete cfg[k];
      Object.assign(cfg, structuredClone(DEFAULT_STYLES[page.id]), EXTRA_DEFAULTS[page.id] ? structuredClone(EXTRA_DEFAULTS[page.id]) : {});
      cfg.enabled = enabled;
      selectPage(page.id);
      preview();
    };

    const enableBox = el('input', { type: 'checkbox', checked: !!cfg.enabled });
    enableBox.addEventListener('change', () => {
      cfg.enabled = enableBox.checked;
      const row = rowNodes.get(page.id);
      if (row) {
        row.classList.toggle('on', enableBox.checked);
        const listBox = row.querySelector('input[type=checkbox]');
        if (listBox) listBox.checked = enableBox.checked;
      }
      preview();
    });
    const enableRow = el('label.pk-check.pk-fx-enable', {}, enableBox, el('span', { text: `Enable ${page.name}` }));

    return [pageTitle(page.name, reset), enableRow, form.node];
  }

  function selectPage(id) {
    current = id;
    for (const [key, node] of rowNodes) node.classList.toggle('active', key === id);
    const page = pages.find((p) => p.id === id);
    paneEl.replaceChildren(...(page ? effectPage(page) : blendingPage()));
    paneEl.scrollTop = 0;
  }

  dlg.setBody(el('div.pk-fx-cols', {}, listEl, paneEl));
  dlg.setButtons([
    { label: 'Cancel', value: null, subtle: true },
    { label: 'OK', value: true, primary: true },
  ]);
  dlg.onClose((v) => {
    if (v) {
      const anyEnabled = Object.values(working).some((s) => s && s.enabled);
      layer.styles = anyEnabled ? working : null;
      doc.commit('Layer Style');
    } else {
      layer.styles = original;
      layer.blendMode = originalProps.blendMode;
      layer.opacity = originalProps.opacity;
      layer.fillOpacity = originalProps.fillOpacity;
      doc.touch('layer-style');
    }
  });

  const promise = dlg.open();
  selectPage(current);
  preview();
  return promise;
}

/**
 * Open the Layer Style dialog on one effect (Layer > Layer Style > Drop Shadow…).
 * @param {import('../core/document.js').PikaDocument} doc
 * @param {import('../core/layer.js').Layer} layer
 * @param {string} effectId
 */
export function showEffectDialog(doc, layer, effectId) {
  if (!DEFAULT_STYLES[effectId]) return showLayerStyleDialog(doc, layer);
  return showLayerStyleDialog(doc, layer, effectId);
}

/* ------------------------------------------------------------------ */
/* Copy / paste / clear, for the Layer menu                            */
/* ------------------------------------------------------------------ */

/** @type {object|null} */
let styleClipboard = null;

/**
 * Remember a layer's effects.
 * @returns {boolean} false when the layer has none.
 */
export function copyLayerStyle(layer) {
  if (!layer || !layer.styles) {
    app.toast('That layer has no layer style', 'warn');
    return false;
  }
  styleClipboard = structuredClone(layer.styles);
  app.toast('Layer style copied');
  return true;
}

/**
 * Apply the remembered effects to `layer`, recording one undo step.
 * @returns {boolean}
 */
export function pasteLayerStyle(doc, layer) {
  if (!styleClipboard) {
    app.toast('No layer style to paste', 'warn');
    return false;
  }
  if (!doc || !layer) return false;
  layer.styles = structuredClone(styleClipboard);
  doc.commit('Paste Layer Style');
  return true;
}

/**
 * Remove every effect from `layer`, recording one undo step.
 * @returns {boolean}
 */
export function clearLayerStyles(doc, layer) {
  if (!doc || !layer || !layer.styles) return false;
  layer.styles = null;
  doc.commit('Clear Layer Style');
  return true;
}

/** True when something has been copied with {@link copyLayerStyle}. */
export function hasCopiedLayerStyle() {
  return !!styleClipboard;
}
