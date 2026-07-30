import './curve-editor.css';
import { el, clamp } from '../core/util.js';
import { drawHistogram, setupHiDPI, currentHistogram, emptyHistogram } from './histogram.js';

/**
 * Reusable tone-curve widget, exposed as a `custom` ParamDescriptor.
 *
 * The value stored in the form state is a plain, structured-cloneable object:
 *
 *   { channel: 'rgb', rgb: [{x,y},…], r: [...], g: [...], b: [...] }
 *
 * `channel` is only the UI's editing target; `apply` ignores it. Points live in
 * 0..255 input/output space and are interpolated with a monotone cubic spline
 * (Fritsch–Carlson) so a curve can never overshoot between its control points.
 */

export const CURVE_CHANNELS = [
  { id: 'rgb', label: 'RGB', color: 'accent' },
  { id: 'r', label: 'Red', color: '#ff5d5d' },
  { id: 'g', label: 'Green', color: '#54d954' },
  { id: 'b', label: 'Blue', color: '#6ea8ff' },
];

/**
 * Read a design token so the painted plot matches the stylesheet instead of
 * carrying its own hardcoded palette. Cached: the tokens never change at
 * runtime, and `draw()` runs on every pointer move.
 */
const tokenCache = new Map();
function token(name, fallback) {
  if (tokenCache.has(name)) return tokenCache.get(name);
  let v = fallback;
  try {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  } catch {
    v = fallback;
  }
  tokenCache.set(name, v);
  return v;
}

/** The composite curve is drawn in the accent; per-channel curves keep theirs. */
function channelColor(meta) {
  return meta.color === 'accent' ? token('--accent-hi', '#9184ff') : meta.color;
}

const IDENTITY = [{ x: 0, y: 0 }, { x: 255, y: 255 }];

/** Photoshop-style curve presets. */
export const CURVE_PRESETS = {
  'Default': {},
  'Strong Contrast': { rgb: [[0, 0], [70, 32], [139, 143], [194, 222], [255, 255]] },
  'Medium Contrast': { rgb: [[0, 0], [64, 50], [128, 128], [192, 206], [255, 255]] },
  'Linear Contrast': { rgb: [[0, 0], [22, 0], [233, 255], [255, 255]] },
  'Negative': { rgb: [[0, 255], [255, 0]] },
  'Cross Process': {
    r: [[0, 0], [64, 54], [128, 140], [192, 220], [255, 255]],
    g: [[0, 0], [64, 68], [128, 128], [192, 190], [255, 250]],
    b: [[0, 42], [64, 88], [128, 128], [192, 176], [255, 214]],
  },
  'Darker': { rgb: [[0, 0], [64, 44], [128, 102], [192, 168], [255, 255]] },
  'Lighter': { rgb: [[0, 0], [64, 88], [128, 154], [192, 214], [255, 255]] },
};

/* ------------------------------------------------------------------ */
/* Value helpers                                                       */
/* ------------------------------------------------------------------ */

function clonePoints(pts) {
  return pts.map((p) => ({ x: p.x, y: p.y }));
}

function fromPairs(pairs) {
  return pairs.map(([x, y]) => ({ x, y }));
}

function sanitize(pts) {
  if (!Array.isArray(pts) || pts.length < 2) return clonePoints(IDENTITY);
  const out = pts
    .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => ({ x: clamp(Math.round(p.x), 0, 255), y: clamp(Math.round(p.y), 0, 255) }))
    .sort((a, b) => a.x - b.x);
  return out.length >= 2 ? out : clonePoints(IDENTITY);
}

/** Normalise any partial value into a complete curves object. */
export function normalizeCurves(v) {
  const src = v && typeof v === 'object' ? v : {};
  return {
    channel: CURVE_CHANNELS.some((c) => c.id === src.channel) ? src.channel : 'rgb',
    rgb: sanitize(src.rgb),
    r: sanitize(src.r),
    g: sanitize(src.g),
    b: sanitize(src.b),
  };
}

/** A fresh identity curve set. */
export function defaultCurves() {
  return {
    channel: 'rgb',
    rgb: clonePoints(IDENTITY),
    r: clonePoints(IDENTITY),
    g: clonePoints(IDENTITY),
    b: clonePoints(IDENTITY),
  };
}

/** Expand a preset name into a full curves object. */
export function curvesFromPreset(name) {
  const preset = CURVE_PRESETS[name] || {};
  const out = defaultCurves();
  for (const ch of ['rgb', 'r', 'g', 'b']) {
    if (preset[ch]) out[ch] = fromPairs(preset[ch]);
  }
  return out;
}

export function isIdentityCurve(pts) {
  const p = sanitize(pts);
  return p.length === 2 && p[0].x === 0 && p[0].y === 0 && p[1].x === 255 && p[1].y === 255;
}

/* ------------------------------------------------------------------ */
/* Interpolation                                                       */
/* ------------------------------------------------------------------ */

/** Fritsch–Carlson monotone tangents, so the spline never overshoots. */
function tangents(pts) {
  const n = pts.length;
  const m = new Float64Array(n);
  if (n < 2) return m;
  const d = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    d[i] = dx === 0 ? 0 : (pts[i + 1].y - pts[i].y) / dx;
  }
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return m;
}

function hermite(pts, m, i, x) {
  const p0 = pts[i], p1 = pts[i + 1];
  const h = p1.x - p0.x;
  if (h === 0) return p1.y;
  const t = (x - p0.x) / h;
  const t2 = t * t, t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * p0.y +
    (t3 - 2 * t2 + t) * h * m[i] +
    (-2 * t3 + 3 * t2) * p1.y +
    (t3 - t2) * h * m[i + 1]
  );
}

/**
 * Evaluate a curve.
 * @param {{x:number,y:number}[]} points control points in 0..255 space
 * @param {number} x input 0..255
 * @returns {number} output 0..255
 */
export function evaluateCurve(points, x) {
  const pts = sanitize(points);
  if (x <= pts[0].x) return pts[0].y;
  if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
  const m = tangents(pts);
  for (let i = 0; i < pts.length - 1; i++) {
    if (x <= pts[i + 1].x) return clamp(hermite(pts, m, i, x), 0, 255);
  }
  return pts[pts.length - 1].y;
}

/**
 * Sample a curve into a 256-entry lookup table.
 * @param {{x:number,y:number}[]} points
 * @returns {Uint8ClampedArray}
 */
export function curveToLUT(points) {
  const pts = sanitize(points);
  const lut = new Uint8ClampedArray(256);
  const m = tangents(pts);
  const last = pts.length - 1;
  let seg = 0;
  for (let x = 0; x < 256; x++) {
    if (x <= pts[0].x) { lut[x] = pts[0].y; continue; }
    if (x >= pts[last].x) { lut[x] = pts[last].y; continue; }
    while (seg < last - 1 && x > pts[seg + 1].x) seg++;
    lut[x] = Math.round(hermite(pts, m, seg, x));
  }
  return lut;
}

function composeLUT(first, second) {
  if (!first && !second) return null;
  if (!second) return first;
  if (!first) return second;
  const out = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) out[i] = second[first[i]];
  return out;
}

/**
 * Apply a curves object to ImageData in place. Per-channel curves run first,
 * then the composite RGB curve — the same order Photoshop uses.
 * @param {ImageData} imageData
 * @param {object} curvesByChannel `{rgb,r,g,b}` point arrays
 */
export function applyCurves(imageData, curvesByChannel) {
  const c = normalizeCurves(curvesByChannel);
  const master = isIdentityCurve(c.rgb) ? null : curveToLUT(c.rgb);
  const lr = composeLUT(isIdentityCurve(c.r) ? null : curveToLUT(c.r), master);
  const lg = composeLUT(isIdentityCurve(c.g) ? null : curveToLUT(c.g), master);
  const lb = composeLUT(isIdentityCurve(c.b) ? null : curveToLUT(c.b), master);
  if (!lr && !lg && !lb) return imageData;
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    if (lr) d[i] = lr[d[i]];
    if (lg) d[i + 1] = lg[d[i + 1]];
    if (lb) d[i + 2] = lb[d[i + 2]];
  }
  return imageData;
}

/* ------------------------------------------------------------------ */
/* Widget                                                              */
/* ------------------------------------------------------------------ */

/**
 * Build a `custom` ParamDescriptor rendering an interactive curve editor.
 * @param {{key?:string, label?:string, channels?:string[], size?:number,
 *          presets?:boolean, histogram?:()=>object}} [opts]
 */
export function curveParam(opts = {}) {
  const key = opts.key || 'curves';
  const size = opts.size || 240;
  const channels = (opts.channels || ['rgb', 'r', 'g', 'b'])
    .map((id) => CURVE_CHANNELS.find((c) => c.id === id))
    .filter(Boolean);
  const showPresets = opts.presets !== false;

  return {
    key,
    label: opts.label || '',
    type: 'custom',
    default: defaultCurves(),
    render(container, state, onChange) {
      return buildCurveEditor(container, {
        key, state, onChange, size, channels, showPresets,
        histogram: opts.histogram || currentHistogram,
      });
    },
  };
}

function buildCurveEditor(container, cfg) {
  const { key, state, onChange, size, channels, showPresets } = cfg;
  const PAD = 10;
  const W = size + PAD * 2;

  let value = normalizeCurves(state[key]);
  let emitted = null;
  let hist = emptyHistogram();
  try {
    hist = cfg.histogram() || emptyHistogram();
  } catch {
    hist = emptyHistogram();
  }

  const chanSelect = el('select.pk-select.pk-curve-chan');
  for (const c of channels) chanSelect.appendChild(el('option', { value: c.id, text: c.label }));
  chanSelect.value = value.channel;
  chanSelect.addEventListener('change', () => {
    const next = cloneValue(value);
    next.channel = chanSelect.value;
    commit(next);
  });

  const presetSelect = el('select.pk-select.pk-curve-preset');
  for (const name of Object.keys(CURVE_PRESETS)) presetSelect.appendChild(el('option', { value: name, text: name }));
  presetSelect.addEventListener('change', () => {
    const next = curvesFromPreset(presetSelect.value);
    next.channel = value.channel;
    commit(next);
  });

  const resetBtn = el('button.pk-btn.subtle.pk-curve-reset', {
    type: 'button', text: 'Reset',
    title: 'Reset the current channel to a straight line',
    onclick: () => {
      const next = cloneValue(value);
      next[next.channel] = clonePoints(IDENTITY);
      presetSelect.value = 'Default';
      commit(next);
    },
  });

  const canvas = el('canvas.pk-curve-canvas', { width: W, height: W });
  const ctx = setupHiDPI(canvas, W, W);
  const readout = el('div.pk-curve-readout', { text: 'Input: —   Output: —' });

  const head = el('div.pk-curve-head', {},
    el('span.pk-curve-lbl', { text: 'Channel' }), chanSelect,
    showPresets ? el('span.pk-curve-lbl', { text: 'Preset' }) : null,
    showPresets ? presetSelect : null
  );
  const foot = el('div.pk-curve-foot', {}, readout, el('div.pk-spacer'), resetBtn);
  const root = el('div.pk-curve', {}, head, canvas, foot);
  container.appendChild(root);

  /* ---- geometry ---- */
  const toPx = (x, y) => ({ px: PAD + (x / 255) * size, py: PAD + size - (y / 255) * size });
  const toVal = (px, py) => ({
    x: clamp(Math.round(((px - PAD) / size) * 255), 0, 255),
    y: clamp(Math.round(((PAD + size - py) / size) * 255), 0, 255),
  });

  function cloneValue(v) {
    return {
      channel: v.channel,
      rgb: clonePoints(v.rgb),
      r: clonePoints(v.r),
      g: clonePoints(v.g),
      b: clonePoints(v.b),
    };
  }

  function commit(next) {
    value = normalizeCurves(next);
    emitted = value;
    chanSelect.value = value.channel;
    draw();
    onChange(key, value);
  }

  /* ---- painting ---- */
  function draw() {
    const chan = value.channel;
    const meta = CURVE_CHANNELS.find((c) => c.id === chan) || CURVE_CHANNELS[0];
    const ink = channelColor(meta);
    const R = 9; // --r-md
    ctx.clearRect(0, 0, W, W);

    // The plot is a rounded inset plate, so it matches the cards around it.
    ctx.save();
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(PAD, PAD, size, size, R);
    else ctx.rect(PAD, PAD, size, size);
    ctx.clip();
    ctx.fillStyle = token('--s0', '#0f0f13');
    ctx.fillRect(PAD, PAD, size, size);

    drawHistogram(canvas, hist, {
      channel: chan === 'rgb' ? 'l' : chan,
      rect: { x: PAD, y: PAD, width: size, height: size },
      fill: 0.22,
      color: '#8f8f8f',
      clear: false,
    });

    // Grid — a faint hairline, matching --hair.
    ctx.strokeStyle = 'rgba(255,255,255,.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 4; i++) {
      const p = PAD + (size * i) / 4;
      ctx.moveTo(Math.round(p) + 0.5, PAD);
      ctx.lineTo(Math.round(p) + 0.5, PAD + size);
      ctx.moveTo(PAD, Math.round(p) + 0.5);
      ctx.lineTo(PAD + size, Math.round(p) + 0.5);
    }
    ctx.stroke();

    // Baseline.
    ctx.strokeStyle = 'rgba(255,255,255,.16)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(PAD, PAD + size);
    ctx.lineTo(PAD + size, PAD);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Frame: a hairline seam around the plate, not a hard border.
    ctx.save();
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(PAD + 0.5, PAD + 0.5, size - 1, size - 1, R - 0.5);
    else ctx.rect(PAD + 0.5, PAD + 0.5, size - 1, size - 1);
    ctx.strokeStyle = 'rgba(255,255,255,.11)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    // The curve itself, sampled through the LUT so it matches the pixels.
    const lut = curveToLUT(value[chan]);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let x = 0; x <= 255; x++) {
      const p = toPx(x, lut[x]);
      if (x === 0) ctx.moveTo(p.px, p.py); else ctx.lineTo(p.px, p.py);
    }
    ctx.stroke();

    // Control points: crisp white dots with a dark outline, so they read on
    // top of the curve, the histogram and the grid alike.
    const pts = value[chan];
    for (let i = 0; i < pts.length; i++) {
      const p = toPx(pts[i].x, pts[i].y);
      const on = i === selected;
      ctx.beginPath();
      ctx.arc(p.px, p.py, on ? 4.5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = on ? '#ffffff' : ink;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (on) {
        ctx.beginPath();
        ctx.arc(p.px, p.py, 4.5, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  /* ---- interaction ---- */
  let selected = -1;
  let dragging = -1;
  let dragMoved = false;

  const hitTest = (px, py) => {
    const pts = value[value.channel];
    for (let i = 0; i < pts.length; i++) {
      const p = toPx(pts[i].x, pts[i].y);
      if (Math.abs(p.px - px) <= 7 && Math.abs(p.py - py) <= 7) return i;
    }
    return -1;
  };

  const localPos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  };

  const setReadout = (px, py) => {
    const v = toVal(px, py);
    const lut = curveToLUT(value[value.channel]);
    readout.textContent = `Input: ${v.x}   Output: ${lut[v.x]}`;
  };

  canvas.addEventListener('pointerdown', (e) => {
    const { px, py } = localPos(e);
    const hit = hitTest(px, py);
    const pts = value[value.channel];

    if (hit >= 0 && (e.altKey || e.ctrlKey || e.metaKey || e.button === 2)) {
      if (pts.length > 2) {
        const next = cloneValue(value);
        next[next.channel].splice(hit, 1);
        selected = -1;
        commit(next);
      }
      e.preventDefault();
      return;
    }

    if (hit >= 0) {
      selected = hit;
      dragging = hit;
    } else {
      if (px < PAD - 6 || px > PAD + size + 6) return;
      const v = toVal(px, py);
      const next = cloneValue(value);
      const arr = next[next.channel];
      if (arr.some((p) => p.x === v.x)) {
        const idx = arr.findIndex((p) => p.x === v.x);
        arr[idx].y = v.y;
        selected = idx;
      } else {
        arr.push({ x: v.x, y: v.y });
        arr.sort((a, b) => a.x - b.x);
        selected = arr.findIndex((p) => p.x === v.x);
      }
      dragging = selected;
      commit(next);
    }
    dragMoved = false;
    canvas.setPointerCapture(e.pointerId);
    setReadout(px, py);
    draw();
    e.preventDefault();
  });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointermove', (e) => {
    const { px, py } = localPos(e);
    if (dragging < 0) {
      if (px >= PAD && px <= PAD + size) setReadout(px, py);
      return;
    }
    dragMoved = true;
    const next = cloneValue(value);
    const arr = next[next.channel];
    const outside = px < PAD - 26 || px > PAD + size + 26 || py < PAD - 26 || py > PAD + size + 26;
    if (outside && arr.length > 2 && dragging > 0 && dragging < arr.length - 1) {
      arr.splice(dragging, 1);
      dragging = -1;
      selected = -1;
      commit(next);
      return;
    }
    const v = toVal(px, py);
    const lo = dragging === 0 ? 0 : arr[dragging - 1].x + 1;
    const hi = dragging === arr.length - 1 ? 255 : arr[dragging + 1].x - 1;
    arr[dragging] = { x: clamp(v.x, Math.min(lo, hi), Math.max(lo, hi)), y: v.y };
    selected = dragging;
    setReadout(px, py);
    commit(next);
  });

  const endDrag = (e) => {
    if (dragging >= 0 && canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    dragging = -1;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('dblclick', (e) => {
    const { px, py } = localPos(e);
    const hit = hitTest(px, py);
    const pts = value[value.channel];
    if (hit > 0 && hit < pts.length - 1) {
      const next = cloneValue(value);
      next[next.channel].splice(hit, 1);
      selected = -1;
      commit(next);
    }
    e.preventDefault();
  });

  canvas.addEventListener('keydown', (e) => {
    if (selected < 0) return;
    const pts = value[value.channel];
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected > 0 && selected < pts.length - 1) {
      const next = cloneValue(value);
      next[next.channel].splice(selected, 1);
      selected = -1;
      commit(next);
      e.preventDefault();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const next = cloneValue(value);
      const step = e.shiftKey ? 10 : 1;
      const p = next[next.channel][selected];
      p.y = clamp(p.y + (e.key === 'ArrowUp' ? step : -step), 0, 255);
      commit(next);
      e.preventDefault();
    }
  });
  canvas.tabIndex = 0;

  // Unrelated form changes must not clobber an in-progress edit, so only adopt
  // values that did not come from this widget.
  const api = {
    sync(v) {
      if (v && v === emitted) return;
      value = normalizeCurves(v || state[key]);
      chanSelect.value = value.channel;
      draw();
    },
  };

  draw();
  return api;
}
