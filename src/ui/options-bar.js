import { el, clamp } from '../core/util.js';
import { app } from '../core/app.js';
import { icon } from './icons.js';
import { toCss, toHex, parseColor } from '../core/color.js';
import './options-bar.css';

/**
 * The tool options bar.
 *
 * Renders the active tool's ParamDescriptors in a single horizontal strip:
 * every control keeps its label to the left, sliders collapse to a number field
 * whose label is a scrubby drag handle (click it for a popover slider).
 * While a free-transform session is running the bar shows numeric transform
 * fields instead.
 */

let root = null;
let shownToolId = null;
let shownSession = null;
let installed = false;

/** key -> {sync(value), row, desc} */
let controls = new Map();
/** {node, key, sync(value)} for the open slider popover. */
let popover = null;

/** Lazily loaded src/tools/transform.js. */
let transformMod = null;
let transformLoading = null;
/** key -> {input} for the transform fields. */
let transformInputs = new Map();

/**
 * Build the options bar into `rootEl`.
 * @param {HTMLElement} rootEl
 */
export function buildOptionsBar(rootEl) {
  if (!rootEl) return;
  root = rootEl;

  if (!installed) {
    installed = true;
    app.on('tool-change', rebuild);
    app.on('tool-options', syncControls);
    app.on('render', watchTransform);
    window.addEventListener('blur', closePopover);
  }
  rebuild();
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function rebuild() {
  if (!root) return;
  closePopover();
  controls = new Map();
  transformInputs = new Map();
  root.replaceChildren();

  const tool = app.tool;
  shownToolId = tool ? tool.id : null;
  shownSession = app.transformSession || null;

  if (!tool) {
    root.appendChild(el('span.pk-ob-static', { text: 'No tool selected' }));
    return;
  }

  root.appendChild(
    el('div.pk-ob-tool', { title: tool.name },
      el('span.pk-ob-tool-ico', { html: icon(tool.icon || tool.id, { size: 18 }) }),
      el('span.pk-ob-tool-name', { text: tool.name })
    )
  );
  root.appendChild(el('div.pk-vsep'));

  if (shownSession) {
    renderTransform();
    return;
  }

  for (const p of tool.options || []) {
    const row = renderOption(p, tool);
    if (row) root.appendChild(row);
  }
  refreshVisibility();
}

function setValue(tool, key, value) {
  tool.setOption(key, value);
  refreshVisibility();
}

function refreshVisibility() {
  const tool = app.tool;
  if (!tool) return;
  for (const [, c] of controls) {
    if (!c.desc || !c.desc.when) continue;
    let visible = true;
    try {
      visible = !!c.desc.when(tool.state);
    } catch {
      visible = true;
    }
    c.row.style.display = visible ? '' : 'none';
  }
}

function syncControls() {
  const tool = app.tool;
  if (!tool || tool.id !== shownToolId || !!app.transformSession !== !!shownSession) {
    rebuild();
    return;
  }
  for (const [key, c] of controls) {
    if (c.sync) c.sync(tool.state[key]);
  }
  refreshVisibility();
}

/* ------------------------------------------------------------------ */
/* Individual controls                                                 */
/* ------------------------------------------------------------------ */

/**
 * A descriptor's options, which may be a plain array or a thunk.
 *
 * A thunk is for lists that change while the bar is on screen — the font list
 * grows when a family is downloaded, so an array captured at registration would
 * go stale at exactly the moment it matters.
 */
function optionsOf(p) {
  const o = typeof p.options === 'function' ? p.options() : p.options;
  return Array.isArray(o) ? o : [];
}

const valueOf = (o) => (typeof o === 'object' && o ? o.value : o);
const labelOf = (o) => (typeof o === 'object' && o ? o.label : String(o));

function renderOption(p, tool) {
  if (!p) return null;
  if (p.type === 'separator') return el('div.pk-vsep');
  if (p.type === 'label') return el('span.pk-ob-static', { text: p.label || '' });
  if (p.type === 'button') {
    return el('button.pk-btn.subtle.pk-ob-btn', {
      type: 'button',
      text: p.label,
      onclick: () => p.onClick && p.onClick(tool.state, (k, v) => setValue(tool, k, v)),
    });
  }

  const row = el('div.pk-ob-field');
  const state = tool.state;
  const register = (sync) => controls.set(p.key, { sync, row, desc: p });

  switch (p.type) {
    case 'slider':
    case 'number':
    case 'angle': {
      const isAngle = p.type === 'angle';
      const min = p.min != null ? p.min : isAngle ? -360 : undefined;
      const max = p.max != null ? p.max : isAngle ? 360 : undefined;
      const step = p.step == null ? (isAngle ? 1 : 1) : p.step;

      const num = el('input.pk-num.pk-ob-num', {
        type: 'number',
        min: min != null ? min : null,
        max: max != null ? max : null,
        step,
        value: state[p.key],
      });
      num.addEventListener('input', () => {
        let v = Number(num.value);
        if (Number.isNaN(v)) return;
        if (min != null) v = Math.max(min, v);
        if (max != null) v = Math.min(max, v);
        setValue(tool, p.key, v);
      });
      num.addEventListener('blur', () => { num.value = tool.state[p.key]; });

      const canPopover = p.type !== 'number' && min != null && max != null;
      const label = makeScrubLabel(p.label || p.key, {
        min, max, step,
        get: () => Number(tool.state[p.key]) || 0,
        set: (v) => { num.value = v; setValue(tool, p.key, v); },
        onClick: canPopover
          ? () => openSliderPopover(label, p, { min, max, step, tool })
          : null,
      });

      row.append(label, num);
      if (p.unit || isAngle) row.append(el('span.pk-unit', { text: p.unit || '°' }));
      register((v) => {
        if (document.activeElement !== num) num.value = v;
        if (popover && popover.key === p.key) popover.sync(v);
      });
      break;
    }

    case 'select': {
      const sel = el('select.pk-select.pk-ob-select');
      /*
       * Rebuilt on every sync rather than once, because a descriptor may
       * declare its options as a thunk when the list can change while the bar
       * is up — the font list grows as families are downloaded, and a layer can
       * carry a family the list has never had.
       */
      const fill = (v) => {
        const opts = optionsOf(p);
        const same = sel.options.length === opts.length
          && opts.every((o, i) => sel.options[i] && sel.options[i].value === String(valueOf(o)));
        if (!same) {
          sel.replaceChildren(...opts.map((o) => el('option', { value: valueOf(o), text: labelOf(o) })));
        }
        sel.value = v;
      };
      fill(state[p.key]);
      sel.addEventListener('change', () => {
        const opt = optionsOf(p).find((o) => String(valueOf(o)) === sel.value);
        setValue(tool, p.key, opt == null ? sel.value : valueOf(opt));
      });
      row.append(el('span.pk-ob-label', { text: p.label || '' }), sel);
      register(fill);
      break;
    }

    case 'radio': {
      const seg = el('div.pk-seg');
      const buttons = [];
      for (const o of optionsOf(p)) {
        const val = typeof o === 'object' ? o.value : o;
        const lab = typeof o === 'object' ? o.label : String(o);
        const b = el('button.pk-seg-btn', {
          type: 'button',
          text: lab,
          title: lab,
          onclick: () => setValue(tool, p.key, val),
        });
        b.dataset.value = String(val);
        buttons.push(b);
        seg.appendChild(b);
      }
      const paint = (v) => {
        for (const b of buttons) b.classList.toggle('active', b.dataset.value === String(v));
      };
      paint(state[p.key]);
      row.append(...[p.label ? el('span.pk-ob-label', { text: p.label }) : null, seg].filter(Boolean));
      register(paint);
      break;
    }

    case 'checkbox': {
      const input = el('input', { type: 'checkbox', checked: !!state[p.key] });
      input.addEventListener('change', () => setValue(tool, p.key, input.checked));
      row.append(el('label.pk-check', {}, input, el('span', { text: p.label || '' })));
      register((v) => { input.checked = !!v; });
      break;
    }

    case 'color': {
      const swatch = el('button.pk-color-swatch.pk-ob-color', { type: 'button' });
      const fill = el('span.pk-ob-color-fill');
      swatch.appendChild(fill);
      fill.style.background = toCss(parseColor(state[p.key] || '#000000'));
      const hidden = el('input', {
        type: 'color',
        value: safeHex(state[p.key]),
        style: { position: 'absolute', width: '0', height: '0', opacity: '0', pointerEvents: 'none' },
      });
      hidden.addEventListener('input', () => {
        fill.style.background = hidden.value;
        setValue(tool, p.key, hidden.value);
      });
      swatch.addEventListener('click', () => hidden.click());
      row.append(...[p.label ? el('span.pk-ob-label', { text: p.label }) : null, swatch, hidden].filter(Boolean));
      register((v) => {
        fill.style.background = toCss(parseColor(v || '#000000'));
        hidden.value = safeHex(v);
      });
      break;
    }

    case 'text': {
      const input = el('input.pk-input.pk-ob-text', { type: 'text', value: state[p.key] ?? '' });
      input.addEventListener('input', () => setValue(tool, p.key, input.value));
      row.append(...[p.label ? el('span.pk-ob-label', { text: p.label }) : null, input].filter(Boolean));
      register((v) => { if (document.activeElement !== input) input.value = v ?? ''; });
      break;
    }

    case 'custom': {
      if (p.label) row.append(el('span.pk-ob-label', { text: p.label }));
      const holder = el('div.pk-ob-custom');
      row.append(holder);
      if (typeof p.render === 'function') {
        let api = null;
        try {
          api = p.render(holder, state, (k, v) => setValue(tool, k, v), p);
        } catch (err) {
          console.error('[options-bar custom]', err);
        }
        register(api && api.sync ? api.sync : null);
      } else {
        register(null);
      }
      break;
    }

    default:
      return null;
  }

  if (p.hint) row.title = p.hint;
  return row;
}

function safeHex(v) {
  try {
    return toHex(parseColor(v || '#000000'));
  } catch {
    return '#000000';
  }
}

/* ------------------------------------------------------------------ */
/* Scrubby label + popover slider                                      */
/* ------------------------------------------------------------------ */

function snapTo(v, step) {
  if (!step || !Number.isFinite(step)) return v;
  const snapped = Math.round(v / step) * step;
  return Number(snapped.toFixed(6));
}

/**
 * A label that changes its value when dragged left/right.
 * @param {string} text
 * @param {{min?:number,max?:number,step?:number,get:()=>number,set:(v:number)=>void,onClick?:()=>void}} opts
 */
function makeScrubLabel(text, opts) {
  const label = el('span.pk-ob-label.pk-scrub', { text });
  let startX = 0;
  let startVal = 0;
  let moved = false;
  let dragging = false;

  label.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    startX = e.clientX;
    startVal = Number(opts.get()) || 0;
    label.classList.add('dragging');
    try { label.setPointerCapture(e.pointerId); } catch { /* not captured */ }
    e.preventDefault();
  });

  label.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    if (!moved && Math.abs(dx) < 3) return;
    moved = true;
    let per;
    if (opts.min != null && opts.max != null && opts.max > opts.min) per = (opts.max - opts.min) / 240;
    else per = opts.step || 1;
    if (e.shiftKey) per *= 0.25;
    if (e.altKey) per *= 4;
    let v = snapTo(startVal + dx * per, opts.step);
    if (opts.min != null) v = Math.max(opts.min, v);
    if (opts.max != null) v = Math.min(opts.max, v);
    opts.set(v);
  });

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    label.classList.remove('dragging');
    try { label.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (!moved && opts.onClick) opts.onClick();
  };
  label.addEventListener('pointerup', end);
  label.addEventListener('pointercancel', end);
  return label;
}

function openSliderPopover(anchor, p, { min, max, step, tool }) {
  closePopover();
  const range = el('input.pk-range', { type: 'range', min, max, step: step || 1, value: tool.state[p.key] });
  const num = el('input.pk-num', { type: 'number', min, max, step: step || 1, value: tool.state[p.key] });

  range.addEventListener('input', () => {
    num.value = range.value;
    setValue(tool, p.key, Number(range.value));
  });
  num.addEventListener('input', () => {
    let v = Number(num.value);
    if (Number.isNaN(v)) return;
    v = clamp(v, min, max);
    range.value = v;
    setValue(tool, p.key, v);
  });

  const node = el('div.pk-ob-popover', {},
    el('span.pk-ob-popover-title', { text: p.label || p.key }),
    el('div.pk-slider-row', {}, range, num),
    p.unit ? el('span.pk-unit', { text: p.unit }) : null
  );
  document.body.appendChild(node);

  const r = anchor.getBoundingClientRect();
  const nr = node.getBoundingClientRect();
  let left = r.left - 6;
  if (left + nr.width > window.innerWidth - 6) left = Math.max(6, window.innerWidth - nr.width - 6);
  node.style.left = `${Math.round(left)}px`;
  node.style.top = `${Math.round(Math.min(r.bottom + 6, window.innerHeight - nr.height - 6))}px`;

  popover = {
    node,
    key: p.key,
    sync: (v) => {
      range.value = v;
      if (document.activeElement !== num) num.value = v;
    },
  };

  document.addEventListener('pointerdown', onDocPointerDown, true);
  window.addEventListener('keydown', onPopoverKey, true);
}

function onDocPointerDown(e) {
  if (popover && !popover.node.contains(e.target)) closePopover();
}

function onPopoverKey(e) {
  if (popover && e.key === 'Escape') {
    e.stopPropagation();
    e.preventDefault();
    closePopover();
  }
}

function closePopover() {
  if (!popover) return;
  popover.node.remove();
  popover = null;
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  window.removeEventListener('keydown', onPopoverKey, true);
}

/* ------------------------------------------------------------------ */
/* Free transform                                                      */
/* ------------------------------------------------------------------ */

/** Numeric fields for a free-transform session; `key` matches the transform API. */
const TRANSFORM_FIELDS = [
  { key: 'x', label: 'X', unit: 'px', step: 1, fallback: 0 },
  { key: 'y', label: 'Y', unit: 'px', step: 1, fallback: 0 },
  { key: 'width', label: 'W', unit: '%', step: 0.1, fallback: 100 },
  { key: 'height', label: 'H', unit: '%', step: 0.1, fallback: 100 },
  { key: 'angle', label: 'Angle', unit: '°', step: 0.1, fallback: 0 },
  { key: 'skewX', label: 'Skew', unit: '°', step: 0.1, fallback: 0 },
];

function ensureTransformModule() {
  if (transformMod) return Promise.resolve(transformMod);
  if (!transformLoading) {
    transformLoading = import('../tools/transform.js')
      .then((m) => { transformMod = m; return m; })
      .catch((err) => {
        console.warn('[options-bar] transform module unavailable:', err && err.message);
        transformMod = {};
        return transformMod;
      });
  }
  return transformLoading;
}

function readTransform() {
  if (!transformMod || typeof transformMod.getTransformNumeric !== 'function') return null;
  try {
    return transformMod.getTransformNumeric() || null;
  } catch (err) {
    console.error('[getTransformNumeric]', err);
    return null;
  }
}

function writeTransform(key, value) {
  if (!transformMod || typeof transformMod.setTransformNumeric !== 'function') return;
  try {
    transformMod.setTransformNumeric({ [key]: value });
  } catch (err) {
    console.error('[setTransformNumeric]', err);
  }
  app.requestRender();
}

function renderTransform() {
  ensureTransformModule().then(() => syncTransform());

  for (const f of TRANSFORM_FIELDS) {
    const num = el('input.pk-num.pk-ob-num', { type: 'number', step: f.step, value: f.fallback });
    num.addEventListener('input', () => {
      const v = Number(num.value);
      if (Number.isNaN(v)) return;
      writeTransform(f.key, v);
    });
    const label = makeScrubLabel(f.label, {
      step: f.step,
      get: () => Number(num.value) || 0,
      set: (v) => { num.value = v; writeTransform(f.key, v); },
    });
    transformInputs.set(f.key, { input: num, fallback: f.fallback });
    root.appendChild(el('div.pk-ob-field', {}, label, num, el('span.pk-unit', { text: f.unit })));
  }

  root.appendChild(el('div.pk-vsep'));
  root.appendChild(
    el('button.pk-icon-btn.pk-ob-cancel', {
      type: 'button', title: 'Cancel transform (Esc)',
      html: icon('close', { size: 15 }),
      onclick: () => endTransform('cancel'),
    })
  );
  root.appendChild(
    el('button.pk-icon-btn.pk-ob-commit', {
      type: 'button', title: 'Commit transform (Enter)',
      html: icon('check', { size: 15 }),
      onclick: () => endTransform('commit'),
    })
  );
}

/** Finish the session through the transform module, falling back to the tool. */
function endTransform(what) {
  const fn = transformMod && transformMod[what === 'commit' ? 'commitTransform' : 'cancelTransform'];
  try {
    if (typeof fn === 'function') fn();
    else if (app.tool) app.tool[what]();
  } catch (err) {
    console.error('[options-bar transform]', err);
  }
  app.requestRender();
}

function syncTransform() {
  if (!transformInputs.size) return;
  const values = readTransform();
  if (!values) return;
  for (const [key, { input, fallback }] of transformInputs) {
    if (document.activeElement === input) continue;
    const raw = values[key];
    const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
    const rounded = Math.round(v * 100) / 100;
    if (Number(input.value) !== rounded) input.value = rounded;
  }
}

/** Detects transform sessions starting/ending; runs on the rAF render tick. */
function watchTransform() {
  const cur = app.transformSession || null;
  if (cur !== shownSession) {
    rebuild();
    return;
  }
  if (cur) syncTransform();
}
