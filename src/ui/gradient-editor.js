import './gradient-editor.css';
import { el, clamp } from '../core/util.js';
import { parseColor, toHex } from '../core/color.js';
import { GRADIENT_PRESETS, renderGradient, resolveStops } from '../paint/gradients.js';

/**
 * Reusable gradient-stop editor, exposed as a `custom` ParamDescriptor.
 *
 * Value shape (plain + structured-cloneable so it can live on an adjustment
 * layer):
 *
 *   { stops: [{pos:0..1, color:'#rrggbb'}, …],
 *     opacityStops: [{pos:0..1, opacity:0..1}, …] }
 */

const FALLBACK_PRESETS = [
  { name: 'Black, White', stops: [[0, '#000000'], [1, '#ffffff']] },
  { name: 'White, Black', stops: [[0, '#ffffff'], [1, '#000000']] },
  { name: 'Sepia', stops: [[0, '#1c1008'], [0.5, '#8a6437'], [1, '#f5e3c4']] },
  { name: 'Cyanotype', stops: [[0, '#04121f'], [0.5, '#2f6f9e'], [1, '#e8f4ff']] },
  { name: 'Copper', stops: [[0, '#231108'], [0.45, '#a3572a'], [0.75, '#e0a06a'], [1, '#ffe7c9']] },
  { name: 'Gold', stops: [[0, '#17120a'], [0.5, '#a9822b'], [1, '#ffeeb0']] },
  { name: 'Teal & Orange', stops: [[0, '#062028'], [0.5, '#5f7d80'], [1, '#ffc07a']] },
  { name: 'Violet, Orange', stops: [[0, '#3b1150'], [0.5, '#b7457a'], [1, '#ffb64d']] },
  { name: 'Blue, Yellow', stops: [[0, '#0a2a6b'], [0.5, '#7f8fa8'], [1, '#ffe14d']] },
  { name: 'Spectrum', stops: [[0, '#ff0000'], [0.17, '#ffff00'], [0.33, '#00ff00'], [0.5, '#00ffff'], [0.67, '#0000ff'], [0.83, '#ff00ff'], [1, '#ff0000']] },
  { name: 'Chrome', stops: [[0, '#1c1c1c'], [0.28, '#c9d4dc'], [0.42, '#5a6a75'], [0.62, '#ffffff'], [0.8, '#7c8a94'], [1, '#e6eef4']] },
  { name: 'Cool Shadows', stops: [[0, '#0d1a2b'], [0.35, '#4a5f77'], [0.7, '#c3c0b4'], [1, '#fff4e2']] },
];

/* ------------------------------------------------------------------ */
/* Value helpers                                                       */
/* ------------------------------------------------------------------ */

function hexOf(c) {
  try {
    return toHex(parseColor(c));
  } catch {
    return '#000000';
  }
}

function normStop(s) {
  if (Array.isArray(s)) return { pos: clamp(Number(s[0]) || 0, 0, 1), color: hexOf(s[1]) };
  if (!s || typeof s !== 'object') return null;
  let pos = s.pos != null ? s.pos : s.offset != null ? s.offset : s.location != null ? s.location : s.t;
  if (pos == null) return null;
  pos = Number(pos);
  if (!Number.isFinite(pos)) return null;
  if (pos > 1) pos /= 100; // `location` is often 0..100
  return { pos: clamp(pos, 0, 1), color: hexOf(s.color != null ? s.color : s.c) };
}

function normOpacityStop(s) {
  if (Array.isArray(s)) return { pos: clamp(Number(s[0]) || 0, 0, 1), opacity: clamp(Number(s[1]), 0, 1) };
  if (!s || typeof s !== 'object') return null;
  let pos = s.pos != null ? s.pos : s.offset != null ? s.offset : s.location != null ? s.location : s.t;
  if (pos == null) return null;
  pos = Number(pos);
  if (!Number.isFinite(pos)) return null;
  if (pos > 1) pos /= 100;
  let o = s.opacity != null ? s.opacity : s.a != null ? s.a : s.alpha;
  o = Number(o);
  if (!Number.isFinite(o)) o = 1;
  if (o > 1) o /= 100;
  return { pos: clamp(pos, 0, 1), opacity: clamp(o, 0, 1) };
}

/**
 * Coerce anything gradient-shaped (our value, a preset record, a bare stop
 * array) into the canonical value object.
 */
export function normalizeGradient(v) {
  let colorSrc = null, opacitySrc = null;
  if (Array.isArray(v)) colorSrc = v;
  else if (v && typeof v === 'object') {
    colorSrc = v.stops || v.colorStops || v.colors || null;
    opacitySrc = v.opacityStops || v.alphaStops || null;
    if (colorSrc && !Array.isArray(colorSrc) && typeof colorSrc === 'object') {
      // { stops: {color:[…], opacity:[…]} }
      opacitySrc = opacitySrc || colorSrc.opacity;
      colorSrc = colorSrc.color || colorSrc.colors;
    }
  }
  let stops = (Array.isArray(colorSrc) ? colorSrc : []).map(normStop).filter(Boolean).sort((a, b) => a.pos - b.pos);
  if (stops.length === 0) stops = [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }];
  if (stops.length === 1) stops = [{ ...stops[0], pos: 0 }, { ...stops[0], pos: 1 }];

  let opacityStops = (Array.isArray(opacitySrc) ? opacitySrc : []).map(normOpacityStop).filter(Boolean).sort((a, b) => a.pos - b.pos);
  if (opacityStops.length === 0) opacityStops = [{ pos: 0, opacity: 1 }, { pos: 1, opacity: 1 }];
  if (opacityStops.length === 1) opacityStops = [{ ...opacityStops[0], pos: 0 }, { ...opacityStops[0], pos: 1 }];

  return { stops, opacityStops };
}

/** A fresh black-to-white gradient. */
export function defaultGradient() {
  return {
    stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }],
    opacityStops: [{ pos: 0, opacity: 1 }, { pos: 1, opacity: 1 }],
  };
}

function cloneGradient(g) {
  return {
    stops: g.stops.map((s) => ({ pos: s.pos, color: s.color })),
    opacityStops: g.opacityStops.map((s) => ({ pos: s.pos, opacity: s.opacity })),
  };
}

function interpStops(stops, t, get) {
  if (t <= stops[0].pos) return get(stops[0]);
  const last = stops[stops.length - 1];
  if (t >= last.pos) return get(last);
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    if (t <= b.pos) {
      const span = b.pos - a.pos;
      const k = span <= 0 ? 0 : (t - a.pos) / span;
      const va = get(a), vb = get(b);
      if (typeof va === 'number') return va + (vb - va) * k;
      return {
        r: va.r + (vb.r - va.r) * k,
        g: va.g + (vb.g - va.g) * k,
        b: va.b + (vb.b - va.b) * k,
      };
    }
  }
  return get(last);
}

/**
 * Sample a gradient.
 * @param {object} value gradient value
 * @param {number} t 0..1
 * @returns {{r:number,g:number,b:number,a:number}}
 */
export function sampleGradient(value, t) {
  const g = normalizeGradient(value);
  const c = interpStops(g.stops, t, (s) => parseColor(s.color));
  const a = interpStops(g.opacityStops, t, (s) => s.opacity);
  return { r: c.r, g: c.g, b: c.b, a };
}

/**
 * Sample a gradient into 256-entry lookup tables.
 * @param {object|Array} stops gradient value (or a bare colour-stop array)
 * @returns {{r:Uint8ClampedArray,g:Uint8ClampedArray,b:Uint8ClampedArray,a:Float32Array}}
 */
export function gradientToLUT(stops) {
  const g = normalizeGradient(stops);
  const r = new Uint8ClampedArray(256);
  const gg = new Uint8ClampedArray(256);
  const b = new Uint8ClampedArray(256);
  const a = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const c = interpStops(g.stops, t, (s) => parseColor(s.color));
    r[i] = c.r;
    gg[i] = c.g;
    b[i] = c.b;
    a[i] = interpStops(g.opacityStops, t, (s) => s.opacity);
  }
  return { r, g: gg, b, a };
}

/** CSS `linear-gradient(...)` text for a gradient value (opacity included). */
export function gradientToCss(value, angle = '90deg') {
  const g = normalizeGradient(value);
  const marks = new Set([...g.stops.map((s) => s.pos), ...g.opacityStops.map((s) => s.pos)]);
  const list = [...marks].sort((a, b) => a - b).map((p) => {
    const c = sampleGradient(g, p);
    return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${c.a.toFixed(3)}) ${(p * 100).toFixed(2)}%`;
  });
  return `linear-gradient(${angle}, ${list.join(', ')})`;
}

/* ------------------------------------------------------------------ */
/* Bridge to paint/gradients.js                                        */
/* ------------------------------------------------------------------ */

/**
 * Our value shape → the `{pos, color, opacity}` stop list the shared gradient
 * renderer expects. Colour and opacity stops sit on independent position
 * lists, so the union of both sets is resampled into one list.
 * @param {object} value
 * @returns {{pos:number, color:string, opacity:number}[]}
 */
export function toPaintStops(value) {
  const g = normalizeGradient(value);
  const marks = new Set([...g.stops.map((s) => s.pos), ...g.opacityStops.map((s) => s.pos)]);
  return [...marks].sort((a, b) => a - b).map((pos) => {
    const c = sampleGradient(g, pos);
    return { pos, color: toHex(c), opacity: c.a };
  });
}

/** A resolved stop list from `paint/gradients.js` → our value shape. */
function fromPaintStops(list) {
  return normalizeGradient({
    stops: list.map((s) => ({ pos: s.pos, color: typeof s.color === 'string' ? s.color : toHex(s.color) })),
    opacityStops: list.map((s) => ({ pos: s.pos, opacity: s.opacity == null ? 1 : s.opacity })),
  });
}

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

/**
 * Normalised preset list, taken from the shared library in
 * `paint/gradients.js`. `resolveStops` expands the dynamic `foreground` /
 * `background` tokens and folds per-stop alpha in, so a preset looks the same
 * in this widget as it does painted on canvas.
 * @returns {{name:string, gradient:object}[]}
 */
export function gradientPresets() {
  const src = GRADIENT_PRESETS;
  const raw = Array.isArray(src)
    ? src
    : src && typeof src === 'object'
      ? Object.entries(src).map(([k, v]) => (v && typeof v === 'object' ? { name: v.name || v.label || k, ...v } : { name: k, stops: v }))
      : [];

  const out = [];
  for (const p of raw) {
    if (!p || !p.stops) continue;
    try {
      out.push({ name: String(p.name || p.id || 'Gradient'), gradient: fromPaintStops(resolveStops(p.stops)) });
    } catch {
      // One malformed preset must not take out the whole picker.
    }
  }
  if (!out.length) {
    for (const p of FALLBACK_PRESETS) out.push({ name: p.name, gradient: normalizeGradient(p.stops) });
  }
  return out;
}

/**
 * A compact row of clickable gradient swatches.
 * @param {(gradient:object, name:string)=>void} onPick
 * @param {{presets?:Array}} [opts]
 * @returns {HTMLElement}
 */
export function gradientPresetPicker(onPick, opts = {}) {
  const list = opts.presets || gradientPresets();
  const row = el('div.pk-grad-presets');
  for (const p of list) {
    const sw = el('button.pk-grad-preset', {
      type: 'button', title: p.name,
      style: { backgroundImage: gradientToCss(p.gradient) },
      onclick: () => onPick(cloneGradient(p.gradient), p.name),
    });
    row.appendChild(sw);
  }
  return row;
}

/* ------------------------------------------------------------------ */
/* Bar painting                                                        */
/* ------------------------------------------------------------------ */

/** Paint a gradient value across a canvas (checkerboard behind for alpha). */
export function paintGradientBar(canvas, value, opts = {}) {
  const w = canvas.width, h = canvas.height;
  if (w < 1 || h < 1) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (opts.checker !== false) {
    const s = 6;
    for (let y = 0; y < h; y += s) {
      for (let x = 0; x < w; x += s) {
        ctx.fillStyle = ((x / s + y / s) & 1) ? '#5a5a5a' : '#8d8d8d';
        ctx.fillRect(x, y, s, s);
      }
    }
  }
  try {
    renderGradient(ctx, { type: 'linear', stops: toPaintStops(value), x1: 0, y1: 0, x2: w, y2: 0 }, w, h);
    return;
  } catch {
    // Fall through to the local painter so the editor still works.
  }
  const lut = gradientToLUT(value);
  for (let x = 0; x < w; x++) {
    const i = Math.round((x / Math.max(1, w - 1)) * 255);
    ctx.fillStyle = `rgba(${lut.r[i]},${lut.g[i]},${lut.b[i]},${lut.a[i]})`;
    ctx.fillRect(x, 0, 1, h);
  }
}

/* ------------------------------------------------------------------ */
/* Widget                                                              */
/* ------------------------------------------------------------------ */

/**
 * Build a `custom` ParamDescriptor rendering the gradient stop editor.
 * @param {{key?:string, label?:string, presets?:boolean}} [opts]
 */
export function gradientParam(opts = {}) {
  const key = opts.key || 'gradient';
  return {
    key,
    label: opts.label || 'Gradient',
    type: 'custom',
    default: defaultGradient(),
    render(container, state, onChange) {
      return buildGradientEditor(container, { key, state, onChange, showPresets: opts.presets !== false });
    },
  };
}

function buildGradientEditor(container, cfg) {
  const { key, state, onChange, showPresets } = cfg;
  let value = normalizeGradient(state[key]);
  let emitted = null;
  /** @type {{kind:'color'|'opacity', index:number}|null} */
  let selection = { kind: 'color', index: 0 };

  const bar = el('canvas.pk-grad-bar', { width: 300, height: 26 });
  const colorRow = el('div.pk-grad-row.colors');
  const opacityRow = el('div.pk-grad-row.opacity');
  const track = el('div.pk-grad-track', {}, opacityRow, bar, colorRow);

  const swatch = el('button.pk-color-swatch.pk-grad-swatch', { type: 'button', title: 'Stop colour' });
  const colorInput = el('input', { type: 'color', style: { display: 'none' } });
  const opacityNum = el('input.pk-num', { type: 'number', min: 0, max: 100, step: 1, value: 100, title: 'Opacity %' });
  const locNum = el('input.pk-num', { type: 'number', min: 0, max: 100, step: 1, value: 0, title: 'Location %' });
  const delBtn = el('button.pk-btn.subtle', { type: 'button', text: 'Delete' });

  const editRow = el('div.pk-grad-edit', {},
    el('span.pk-grad-group.only-color', {}, el('span.pk-grad-lbl', { text: 'Color' }), swatch, colorInput),
    el('span.pk-grad-group.only-opacity', {}, el('span.pk-grad-lbl', { text: 'Opacity' }), opacityNum, el('span.pk-unit', { text: '%' })),
    el('span.pk-grad-group', {}, el('span.pk-grad-lbl', { text: 'Location' }), locNum, el('span.pk-unit', { text: '%' })),
    el('div.pk-spacer'), delBtn
  );

  const root = el('div.pk-grad');
  if (showPresets) root.appendChild(gradientPresetPicker((g) => { selection = { kind: 'color', index: 0 }; commit(g); }));
  root.append(track, editRow);
  container.appendChild(root);

  function commit(next) {
    value = normalizeGradient(next);
    emitted = value;
    render();
    onChange(key, value);
  }

  function listFor(kind) {
    return kind === 'opacity' ? value.opacityStops : value.stops;
  }

  function trackWidth() {
    return Math.max(40, track.clientWidth || 300);
  }

  /* ---- rendering ---- */
  function render() {
    const w = trackWidth();
    if (bar.width !== w) bar.width = w;
    paintGradientBar(bar, value);

    const build = (row, kind) => {
      row.replaceChildren();
      const stops = listFor(kind);
      stops.forEach((s, i) => {
        const active = selection && selection.kind === kind && selection.index === i;
        const node = el(`div.pk-grad-stop.${kind}` + (active ? '.active' : ''), {
          style: { left: `${s.pos * 100}%` },
          title: kind === 'color' ? `${s.color} @ ${Math.round(s.pos * 100)}%` : `${Math.round(s.opacity * 100)}% @ ${Math.round(s.pos * 100)}%`,
        });
        const chip = el('i.pk-grad-chip', {
          style: {
            background: kind === 'color' ? s.color : `rgb(${Math.round(s.opacity * 255)},${Math.round(s.opacity * 255)},${Math.round(s.opacity * 255)})`,
          },
        });
        node.appendChild(chip);
        node.addEventListener('pointerdown', (e) => startDrag(e, kind, i));
        node.addEventListener('dblclick', (e) => {
          e.preventDefault();
          selection = { kind, index: i };
          render();
          if (kind === 'color') colorInput.click();
          else { opacityNum.focus(); opacityNum.select(); }
        });
        row.appendChild(node);
      });
    };
    build(colorRow, 'color');
    build(opacityRow, 'opacity');
    syncEditor();
  }

  function syncEditor() {
    const kind = selection ? selection.kind : 'color';
    const stops = listFor(kind);
    const s = selection ? stops[selection.index] : null;
    editRow.classList.toggle('is-opacity', kind === 'opacity');
    if (!s) {
      delBtn.disabled = true;
      return;
    }
    delBtn.disabled = stops.length <= 2;
    if (document.activeElement !== locNum) locNum.value = Math.round(s.pos * 100);
    if (kind === 'color') {
      swatch.style.background = s.color;
      colorInput.value = s.color;
    } else if (document.activeElement !== opacityNum) {
      opacityNum.value = Math.round(s.opacity * 100);
    }
  }

  /* ---- interaction ---- */
  function posFromEvent(e) {
    const r = track.getBoundingClientRect();
    return clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1);
  }

  // Stop nodes are rebuilt on every commit, so the drag listens on the window
  // rather than on the (short-lived) handle element.
  function beginDrag(kind, index, startY) {
    let idx = index;
    let dead = false;
    const move = (ev) => {
      if (dead) return;
      const next = cloneGradient(value);
      const stops = kind === 'opacity' ? next.opacityStops : next.stops;
      if (Math.abs(ev.clientY - startY) > 34 && stops.length > 2) {
        stops.splice(idx, 1);
        selection = null;
        dead = true;
        commit(next);
        return;
      }
      const stop = stops[idx];
      if (!stop) { dead = true; return; }
      stop.pos = posFromEvent(ev);
      stops.sort((a, b) => a.pos - b.pos);
      idx = stops.indexOf(stop);
      selection = { kind, index: idx };
      commit(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function startDrag(e, kind, index) {
    e.preventDefault();
    e.stopPropagation();
    selection = { kind, index };
    render();
    beginDrag(kind, index, e.clientY);
  }

  /** Insert a stop at `pos` and return its index in the new value. */
  const addAt = (kind, pos) => {
    const next = cloneGradient(value);
    let index = 0;
    if (kind === 'color') {
      const c = sampleGradient(value, pos);
      const stop = { pos, color: toHex(c) };
      next.stops.push(stop);
      next.stops.sort((a, b) => a.pos - b.pos);
      index = next.stops.indexOf(stop);
    } else {
      const stop = { pos, opacity: interpStops(value.opacityStops, pos, (s) => s.opacity) };
      next.opacityStops.push(stop);
      next.opacityStops.sort((a, b) => a.pos - b.pos);
      index = next.opacityStops.indexOf(stop);
    }
    selection = { kind, index };
    commit(next);
    return index;
  };

  const addAndDrag = (e, kind) => {
    e.preventDefault();
    const idx = addAt(kind, posFromEvent(e));
    beginDrag(kind, idx, e.clientY);
  };

  bar.addEventListener('pointerdown', (e) => addAndDrag(e, 'color'));
  colorRow.addEventListener('pointerdown', (e) => { if (e.target === colorRow) addAndDrag(e, 'color'); });
  opacityRow.addEventListener('pointerdown', (e) => { if (e.target === opacityRow) addAndDrag(e, 'opacity'); });

  swatch.addEventListener('click', () => colorInput.click());
  colorInput.addEventListener('input', () => {
    if (!selection || selection.kind !== 'color') return;
    const next = cloneGradient(value);
    next.stops[selection.index].color = colorInput.value;
    commit(next);
  });
  opacityNum.addEventListener('input', () => {
    if (!selection || selection.kind !== 'opacity') return;
    const v = clamp(Number(opacityNum.value) || 0, 0, 100) / 100;
    const next = cloneGradient(value);
    next.opacityStops[selection.index].opacity = v;
    commit(next);
  });
  locNum.addEventListener('input', () => {
    if (!selection) return;
    const v = clamp(Number(locNum.value) || 0, 0, 100) / 100;
    const next = cloneGradient(value);
    const stops = selection.kind === 'opacity' ? next.opacityStops : next.stops;
    stops[selection.index].pos = v;
    commit(next);
  });
  delBtn.addEventListener('click', () => {
    if (!selection) return;
    const next = cloneGradient(value);
    const stops = selection.kind === 'opacity' ? next.opacityStops : next.stops;
    if (stops.length <= 2) return;
    stops.splice(selection.index, 1);
    selection = null;
    commit(next);
  });

  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => {
      const w = trackWidth();
      if (bar.width !== w) render();
    });
    ro.observe(track);
  }

  requestAnimationFrame(render);
  render();

  return {
    sync(v) {
      if (v && v === emitted) return;
      value = normalizeGradient(v || state[key]);
      render();
    },
  };
}
