import './basic.css';
import { registerAdjustment, buildLUT, buildLUTf, sampleLUT, applyLUT } from './registry.js';
import { el, clamp, clamp255 } from '../core/util.js';
import { parseColor } from '../core/color.js';
import { curveParam, applyCurves, defaultCurves, curveToLUT } from '../ui/curve-editor.js';
import { drawHistogram, setupHiDPI, currentHistogram, clipPoints, emptyHistogram } from '../ui/histogram.js';

/**
 * The "tone and colour" half of Image > Adjustments. Everything here is a pure
 * function of (imageData, params): the compositor re-runs them on every
 * recomposite for adjustment layers, so the implementations build lookup
 * tables wherever the maths allows and avoid per-pixel allocation everywhere
 * else.
 */

/* ------------------------------------------------------------------ */
/* Shared numeric helpers (also used by advanced.js)                   */
/* ------------------------------------------------------------------ */

export const LUMA_R = 0.299, LUMA_G = 0.587, LUMA_B = 0.114;

export function luma8(r, g, b) {
  return LUMA_R * r + LUMA_G * g + LUMA_B * b;
}

/**
 * Allocation-free RGB→HSL. Writes `[h(0..360), s(0..1), l(0..1)]` into `out`.
 * @param {number} r 0..255
 * @param {number} g 0..255
 * @param {number} b 0..255
 * @param {Float64Array|number[]} out
 */
export function rgbToHsl(r, g, b, out) {
  const R = r / 255, G = g / 255, B = b / 255;
  const mx = R > G ? (R > B ? R : B) : (G > B ? G : B);
  const mn = R < G ? (R < B ? R : B) : (G < B ? G : B);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  let h = 0, s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === R) h = ((G - B) / d) % 6;
    else if (mx === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  out[0] = h; out[1] = s; out[2] = l;
  return out;
}

/** Allocation-free HSL→RGB. Writes `[r,g,b]` (0..255) into `out`. */
export function hslToRgb(h, s, l, out) {
  h = ((h % 360) + 360) % 360;
  if (s <= 0) {
    const v = l * 255;
    out[0] = v; out[1] = v; out[2] = v;
    return out;
  }
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  out[0] = (r + m) * 255; out[1] = (g + m) * 255; out[2] = (b + m) * 255;
  return out;
}

/** Rescale a pixel so its luminance matches `target`. */
function restoreLuma(d, i, target) {
  const cur = luma8(d[i], d[i + 1], d[i + 2]);
  if (cur <= 0.5) {
    d[i] = d[i + 1] = d[i + 2] = clamp255(target);
    return;
  }
  const k = target / cur;
  d[i] = clamp255(d[i] * k);
  d[i + 1] = clamp255(d[i + 1] * k);
  d[i + 2] = clamp255(d[i + 2] * k);
}

/** Piecewise-linear sampling of `[[in,out],…]` control points into a LUT. */
export function pointsToLUT(pairs) {
  return curveToLUT(pairs.map(([x, y]) => ({ x, y })));
}

/**
 * A `select` that also writes a whole set of sibling keys. The form's onChange
 * only carries one key, so the preset writes the others straight into the live
 * state object and then fires a single change (which refreshes every control).
 * @param {{key:string, label:string, presets:Record<string,object>, default?:string}} cfg
 */
export function presetParam(cfg) {
  const names = Object.keys(cfg.presets);
  const def = cfg.default || names[0];
  return {
    key: cfg.key,
    label: cfg.label,
    type: 'custom',
    default: def,
    render(container, state, onChange) {
      const sel = el('select.pk-select.pk-preset-select');
      for (const n of names) sel.appendChild(el('option', { value: n, text: n }));
      sel.value = state[cfg.key] || def;
      sel.addEventListener('change', () => {
        const values = cfg.presets[sel.value] || {};
        for (const [k, v] of Object.entries(values)) state[k] = v;
        onChange(cfg.key, sel.value);
      });
      container.appendChild(sel);
      return { sync: (v) => { if (v != null && sel.value !== v) sel.value = v; } };
    },
  };
}

/* ================================================================== */
/* Brightness / Contrast                                               */
/* ================================================================== */

function brightnessContrastLUT(brightness, contrast, legacy) {
  if (legacy) {
    const c = clamp(contrast, -100, 100) * 2.55;
    const f = (259 * (c + 255)) / (255 * (259 - c));
    return buildLUT((i) => Math.round(f * (i + brightness - 128) + 128));
  }
  const bn = clamp(brightness, -150, 150) / 150;
  const cn = clamp(contrast, -50, 100) / 100;
  const gamma = bn >= 0 ? 1 / (1 + bn) : 1 - bn * 0.6;
  return buildLUT((i) => {
    let t = Math.pow(i / 255, gamma);
    if (cn >= 0) {
      const s = t * t * (3 - 2 * t); // smoothstep S-curve, never clips
      t = t + (s - t) * cn;
    } else {
      t = 0.5 + (t - 0.5) * (1 + cn);
    }
    return Math.round(t * 255);
  });
}

registerAdjustment({
  id: 'brightness-contrast',
  name: 'Brightness/Contrast...',
  group: 'tone',
  params: [
    { key: 'brightness', label: 'Brightness', type: 'slider', min: -150, max: 150, step: 1, default: 0 },
    { key: 'contrast', label: 'Contrast', type: 'slider', min: -50, max: 100, step: 1, default: 0 },
    { key: 'useLegacy', label: 'Use Legacy', type: 'checkbox', default: false },
  ],
  apply(imageData, p) {
    if (!p.brightness && !p.contrast) return;
    const lut = brightnessContrastLUT(p.brightness, p.contrast, !!p.useLegacy);
    applyLUT(imageData, lut, lut, lut);
  },
});

/* ================================================================== */
/* Levels                                                              */
/* ================================================================== */

const LEVEL_CHANNELS = ['rgb', 'r', 'g', 'b'];

function blankLevels() {
  return { ib: 0, ig: 1, iw: 255, ob: 0, ow: 255 };
}

function normalizeLevels(v) {
  const src = v && typeof v === 'object' ? v : {};
  const out = { channel: LEVEL_CHANNELS.includes(src.channel) ? src.channel : 'rgb' };
  for (const ch of LEVEL_CHANNELS) {
    const s = src[ch] && typeof src[ch] === 'object' ? src[ch] : {};
    const ib = clamp(Number.isFinite(s.ib) ? s.ib : 0, 0, 253);
    const iw = clamp(Number.isFinite(s.iw) ? s.iw : 255, ib + 2, 255);
    out[ch] = {
      ib,
      iw,
      ig: clamp(Number.isFinite(s.ig) ? s.ig : 1, 0.01, 9.99),
      ob: clamp(Number.isFinite(s.ob) ? s.ob : 0, 0, 255),
      ow: clamp(Number.isFinite(s.ow) ? s.ow : 255, 0, 255),
    };
  }
  return out;
}

export function defaultLevels() {
  const v = { channel: 'rgb' };
  for (const ch of LEVEL_CHANNELS) v[ch] = blankLevels();
  return v;
}

function isIdentityLevels(L) {
  return L.ib === 0 && L.iw === 255 && L.ig === 1 && L.ob === 0 && L.ow === 255;
}

function levelsLUT(L) {
  const range = Math.max(1, L.iw - L.ib);
  const inv = 1 / Math.max(0.01, L.ig);
  // Unrounded: this table is usually fed into the master table below, and
  // rounding here would quantise the tones twice on the way to one pixel.
  return buildLUTf((i) => {
    let t = (i - L.ib) / range;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    if (inv !== 1) t = Math.pow(t, inv);
    return L.ob + t * (L.ow - L.ob);
  });
}

/**
 * Per-channel levels, then the master.
 *
 * The intermediate is read at its true value rather than rounded to a byte
 * first. Rounding twice is what puts visible steps in a gradient that has had
 * both a channel and a master adjustment — the exact case a deeper pipeline
 * would fix, available here without one.
 */
function composeLUT(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = new Float32Array(256);
  for (let i = 0; i < 256; i++) out[i] = sampleLUT(b, a[i]);
  return out;
}

/* --- the interactive Levels widget --- */

const GAMMA_LOG = Math.log(9.99);
const gammaToPos = (g) => clamp(0.5 - Math.log(clamp(g, 0.1, 9.99)) / (2 * GAMMA_LOG), 0, 1);
const posToGamma = (p) => clamp(Math.pow(9.99, (0.5 - p) * 2), 0.1, 9.99);

function levelsParam(key = 'levels') {
  return {
    key,
    label: '',
    type: 'custom',
    default: defaultLevels(),
    render(container, state, onChange) {
      return buildLevelsWidget(container, key, state, onChange);
    },
  };
}

function buildLevelsWidget(container, key, state, onChange) {
  const PAD = 8, PLOT = 256, W = PLOT + PAD * 2;
  const HIST_H = 92, IN_TOP = HIST_H + 2, IN_H = 12;
  const RAMP_TOP = IN_TOP + IN_H + 12, RAMP_H = 12;
  const OUT_TOP = RAMP_TOP + RAMP_H, OUT_H = 12;
  const H = OUT_TOP + OUT_H + 2;

  let value = normalizeLevels(state[key]);
  let emitted = null;
  let hist;
  try {
    hist = currentHistogram() || emptyHistogram();
  } catch {
    hist = emptyHistogram();
  }

  const chanSelect = el('select.pk-select.pk-levels-chan');
  for (const c of [{ v: 'rgb', l: 'RGB' }, { v: 'r', l: 'Red' }, { v: 'g', l: 'Green' }, { v: 'b', l: 'Blue' }]) {
    chanSelect.appendChild(el('option', { value: c.v, text: c.l }));
  }
  chanSelect.value = value.channel;
  chanSelect.addEventListener('change', () => {
    const next = cloneLevels(value);
    next.channel = chanSelect.value;
    commit(next);
  });

  const autoBtn = el('button.pk-btn.subtle', {
    type: 'button', text: 'Auto', title: 'Clip 0.1% of each channel',
    onclick: () => {
      const next = cloneLevels(value);
      for (const ch of ['r', 'g', 'b']) {
        const { lo, hi } = clipPoints(hist[ch], 0.1);
        next[ch].ib = lo;
        next[ch].iw = Math.max(lo + 2, hi);
        next[ch].ig = 1;
      }
      next.rgb = blankLevels();
      commit(next);
    },
  });
  const resetBtn = el('button.pk-btn.subtle', {
    type: 'button', text: 'Reset', title: 'Reset this channel',
    onclick: () => {
      const next = cloneLevels(value);
      next[next.channel] = blankLevels();
      commit(next);
    },
  });

  const canvas = el('canvas.pk-levels-canvas', { width: W, height: H });
  const ctx = setupHiDPI(canvas, W, H);

  const num = (title, min, max, step) =>
    el('input.pk-num', { type: 'number', min, max, step, title });
  const ibNum = num('Input black', 0, 253, 1);
  const igNum = num('Midtone gamma', 0.01, 9.99, 0.01);
  const iwNum = num('Input white', 2, 255, 1);
  const obNum = num('Output black', 0, 255, 1);
  const owNum = num('Output white', 0, 255, 1);

  const bindNum = (input, field) => {
    input.addEventListener('input', () => {
      const raw = Number(input.value);
      if (!Number.isFinite(raw)) return;
      const next = cloneLevels(value);
      next[next.channel][field] = raw;
      commit(next, true);
    });
  };
  bindNum(ibNum, 'ib');
  bindNum(igNum, 'ig');
  bindNum(iwNum, 'iw');
  bindNum(obNum, 'ob');
  bindNum(owNum, 'ow');

  const root = el('div.pk-levels', {},
    el('div.pk-levels-head', {},
      el('span.pk-levels-lbl', { text: 'Channel' }), chanSelect,
      el('div.pk-spacer'), autoBtn, resetBtn),
    canvas,
    el('div.pk-levels-nums', {},
      el('span.pk-levels-lbl', { text: 'Input' }), ibNum, igNum, iwNum,
      el('div.pk-spacer'),
      el('span.pk-levels-lbl', { text: 'Output' }), obNum, owNum)
  );
  container.appendChild(root);

  function cloneLevels(v) {
    const out = { channel: v.channel };
    for (const ch of LEVEL_CHANNELS) out[ch] = { ...v[ch] };
    return out;
  }

  function commit(next, keepFocus = false) {
    value = normalizeLevels(next);
    emitted = value;
    chanSelect.value = value.channel;
    draw();
    syncNums(keepFocus);
    onChange(key, value);
  }

  function syncNums(keepFocus) {
    const L = value[value.channel];
    const set = (input, v) => {
      if (keepFocus && document.activeElement === input) return;
      input.value = v;
    };
    set(ibNum, L.ib);
    set(igNum, Number(L.ig.toFixed(2)));
    set(iwNum, L.iw);
    set(obNum, L.ob);
    set(owNum, L.ow);
  }

  const xOf = (v) => PAD + (v / 255) * PLOT;
  const vOf = (x) => clamp(Math.round(((x - PAD) / PLOT) * 255), 0, 255);

  function triangle(x, y, h, fill) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - h * 0.55, y + h);
    ctx.lineTo(x + h * 0.55, y + h);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.75)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function draw() {
    const ch = value.channel;
    const L = value[ch];
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = '#1c1c1c';
    ctx.fillRect(PAD, 0, PLOT, HIST_H);
    drawHistogram(canvas, hist, {
      channel: ch === 'rgb' ? 'l' : ch,
      rect: { x: PAD, y: 0, width: PLOT, height: HIST_H },
      fill: 0.85,
      color: '#b4b4b4',
      clear: false,
    });
    ctx.strokeStyle = 'rgba(255,255,255,.25)';
    ctx.strokeRect(PAD + 0.5, 0.5, PLOT - 1, HIST_H - 1);

    // Input ramp handles.
    triangle(xOf(L.ib), IN_TOP, IN_H, '#0a0a0a');
    triangle(xOf(L.iw), IN_TOP, IN_H, '#f2f2f2');
    const gx = xOf(L.ib) + (xOf(L.iw) - xOf(L.ib)) * gammaToPos(L.ig);
    triangle(gx, IN_TOP, IN_H, '#8b8b8b');

    // Output ramp.
    const grad = ctx.createLinearGradient(PAD, 0, PAD + PLOT, 0);
    grad.addColorStop(0, '#000');
    grad.addColorStop(1, '#fff');
    ctx.fillStyle = grad;
    ctx.fillRect(PAD, RAMP_TOP, PLOT, RAMP_H);
    ctx.strokeStyle = 'rgba(255,255,255,.25)';
    ctx.strokeRect(PAD + 0.5, RAMP_TOP + 0.5, PLOT - 1, RAMP_H - 1);
    triangle(xOf(L.ob), OUT_TOP, OUT_H, '#0a0a0a');
    triangle(xOf(L.ow), OUT_TOP, OUT_H, '#f2f2f2');
  }

  /* --- dragging --- */
  let drag = null;
  const localX = (e) => e.clientX - canvas.getBoundingClientRect().left;
  const localY = (e) => e.clientY - canvas.getBoundingClientRect().top;

  canvas.addEventListener('pointerdown', (e) => {
    const x = localX(e), y = localY(e);
    const L = value[value.channel];
    if (y >= IN_TOP - 4 && y <= IN_TOP + IN_H + 4) {
      const gx = xOf(L.ib) + (xOf(L.iw) - xOf(L.ib)) * gammaToPos(L.ig);
      const cands = [
        { id: 'ib', d: Math.abs(x - xOf(L.ib)) },
        { id: 'ig', d: Math.abs(x - gx) },
        { id: 'iw', d: Math.abs(x - xOf(L.iw)) },
      ].sort((a, b) => a.d - b.d);
      drag = cands[0].id;
    } else if (y >= OUT_TOP - 4 && y <= OUT_TOP + OUT_H + 4) {
      drag = Math.abs(x - xOf(L.ob)) <= Math.abs(x - xOf(L.ow)) ? 'ob' : 'ow';
    } else {
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    moveDrag(e);
    e.preventDefault();
  });

  function moveDrag(e) {
    if (!drag) return;
    const x = localX(e);
    const next = cloneLevels(value);
    const L = next[next.channel];
    if (drag === 'ib') L.ib = Math.min(vOf(x), L.iw - 2);
    else if (drag === 'iw') L.iw = Math.max(vOf(x), L.ib + 2);
    else if (drag === 'ig') {
      const x0 = xOf(L.ib), x1 = xOf(L.iw);
      L.ig = posToGamma(clamp((x - x0) / Math.max(1, x1 - x0), 0, 1));
    } else if (drag === 'ob') L.ob = vOf(x);
    else if (drag === 'ow') L.ow = vOf(x);
    commit(next);
  }

  canvas.addEventListener('pointermove', moveDrag);
  const endDrag = (e) => {
    if (drag && canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    drag = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  draw();
  syncNums(false);

  return {
    sync(v) {
      if (v && v === emitted) return;
      value = normalizeLevels(v || state[key]);
      chanSelect.value = value.channel;
      draw();
      syncNums(true);
    },
  };
}

registerAdjustment({
  id: 'levels',
  name: 'Levels...',
  group: 'tone',
  dialogWidth: 330,
  params: [levelsParam('levels')],
  apply(imageData, p) {
    const v = normalizeLevels(p.levels);
    const master = isIdentityLevels(v.rgb) ? null : levelsLUT(v.rgb);
    const lr = composeLUT(isIdentityLevels(v.r) ? null : levelsLUT(v.r), master);
    const lg = composeLUT(isIdentityLevels(v.g) ? null : levelsLUT(v.g), master);
    const lb = composeLUT(isIdentityLevels(v.b) ? null : levelsLUT(v.b), master);
    if (!lr && !lg && !lb) return;
    applyLUT(imageData, lr, lg, lb);
  },
});

/* ================================================================== */
/* Curves                                                              */
/* ================================================================== */

registerAdjustment({
  id: 'curves',
  name: 'Curves...',
  group: 'tone',
  dialogWidth: 320,
  params: [curveParam({ key: 'curves' })],
  defaults: { curves: defaultCurves() },
  apply(imageData, p) {
    applyCurves(imageData, p.curves);
  },
});

/* ================================================================== */
/* Exposure                                                            */
/* ================================================================== */

registerAdjustment({
  id: 'exposure',
  name: 'Exposure...',
  group: 'tone',
  params: [
    { key: 'exposure', label: 'Exposure', type: 'slider', min: -20, max: 20, step: 0.01, default: 0 },
    { key: 'offset', label: 'Offset', type: 'slider', min: -0.5, max: 0.5, step: 0.0001, default: 0 },
    { key: 'gamma', label: 'Gamma Correction', type: 'slider', min: 0.01, max: 9.99, step: 0.01, default: 1 },
  ],
  apply(imageData, p) {
    const e = clamp(p.exposure, -20, 20);
    const off = clamp(p.offset, -0.5, 0.5);
    const g = clamp(p.gamma, 0.01, 9.99);
    if (e === 0 && off === 0 && g === 1) return;
    const mul = Math.pow(2, e);
    const lut = buildLUT((i) => {
      // Exposure scales linear light; offset and gamma act on the encoded value.
      const lin = Math.pow(i / 255, 2.2) * mul;
      let v = Math.pow(lin < 0 ? 0 : lin, 1 / 2.2) + off;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      if (g !== 1) v = Math.pow(v, g);
      return Math.round(v * 255);
    });
    applyLUT(imageData, lut, lut, lut);
  },
});

/* ================================================================== */
/* Vibrance                                                            */
/* ================================================================== */

registerAdjustment({
  id: 'vibrance',
  name: 'Vibrance...',
  group: 'color',
  params: [
    { key: 'vibrance', label: 'Vibrance', type: 'slider', min: -100, max: 100, step: 1, default: 0 },
    { key: 'saturation', label: 'Saturation', type: 'slider', min: -100, max: 100, step: 1, default: 0 },
  ],
  apply(imageData, p) {
    const vib = clamp(p.vibrance, -100, 100) / 100;
    const sat = clamp(p.saturation, -100, 100) / 100;
    if (!vib && !sat) return;
    const base = 1 + sat;
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      let f = base;
      if (vib) {
        const chroma = mx === 0 ? 0 : (mx - mn) / mx;
        let w = 1 - chroma;
        // Protect skin tones: reddish-orange hues get roughly half the boost.
        if (mx === r && g >= b && mx > mn) {
          const hue = ((g - b) / (mx - mn)) * 60;
          if (hue >= 5 && hue <= 50) w *= 0.45;
        }
        f *= 1 + vib * w * 1.4;
      }
      if (f === 1) continue;
      const l = luma8(r, g, b);
      d[i] = clamp255(l + (r - l) * f);
      d[i + 1] = clamp255(l + (g - l) * f);
      d[i + 2] = clamp255(l + (b - l) * f);
    }
  },
});

/* ================================================================== */
/* Hue / Saturation                                                    */
/* ================================================================== */

const HS_RANGES = [
  { id: 'master', label: 'Master', center: -1 },
  { id: 'reds', label: 'Reds', center: 0 },
  { id: 'yellows', label: 'Yellows', center: 60 },
  { id: 'greens', label: 'Greens', center: 120 },
  { id: 'cyans', label: 'Cyans', center: 180 },
  { id: 'blues', label: 'Blues', center: 240 },
  { id: 'magentas', label: 'Magentas', center: 300 },
];

/** 1 inside the ±15° core, fading to 0 across the next 30°. */
function bandWeight(hue, center) {
  let d = Math.abs(((hue - center + 540) % 360) - 180);
  if (d <= 15) return 1;
  if (d >= 45) return 0;
  return 1 - (d - 15) / 30;
}

const hsParams = [
  { key: 'range', label: 'Edit', type: 'select', default: 'master', options: HS_RANGES.map((r) => ({ value: r.id, label: r.label })), when: (s) => !s.colorize },
  { key: 'colorize', label: 'Colorize', type: 'checkbox', default: false },
];
for (const r of HS_RANGES) {
  hsParams.push(
    { key: `${r.id}Hue`, label: 'Hue', type: 'slider', min: -180, max: 180, step: 1, default: 0, when: (s) => !s.colorize && s.range === r.id },
    { key: `${r.id}Sat`, label: 'Saturation', type: 'slider', min: -100, max: 100, step: 1, default: 0, when: (s) => !s.colorize && s.range === r.id },
    { key: `${r.id}Light`, label: 'Lightness', type: 'slider', min: -100, max: 100, step: 1, default: 0, when: (s) => !s.colorize && s.range === r.id }
  );
}
hsParams.push(
  { key: 'colorizeHue', label: 'Hue', type: 'slider', min: 0, max: 360, step: 1, default: 30, when: (s) => s.colorize },
  { key: 'colorizeSat', label: 'Saturation', type: 'slider', min: 0, max: 100, step: 1, default: 25, when: (s) => s.colorize },
  { key: 'colorizeLight', label: 'Lightness', type: 'slider', min: -100, max: 100, step: 1, default: 0, when: (s) => s.colorize }
);

function applyLightness(l, amount) {
  if (!amount) return l;
  return amount > 0 ? l + (1 - l) * (amount / 100) : l * (1 + amount / 100);
}

registerAdjustment({
  id: 'hue-saturation',
  name: 'Hue/Saturation...',
  group: 'color',
  params: hsParams,
  apply(imageData, p) {
    const d = imageData.data;
    const hsl = new Float64Array(3);
    const out = new Float64Array(3);

    if (p.colorize) {
      const H = clamp(p.colorizeHue, 0, 360);
      const S = clamp(p.colorizeSat, 0, 100) / 100;
      const Ladj = clamp(p.colorizeLight, -100, 100);
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const l = applyLightness(luma8(d[i], d[i + 1], d[i + 2]) / 255, Ladj);
        hslToRgb(H, S, clamp(l, 0, 1), out);
        d[i] = out[0]; d[i + 1] = out[1]; d[i + 2] = out[2];
      }
      return;
    }

    const bands = [];
    for (const r of HS_RANGES) {
      const h = clamp(p[`${r.id}Hue`] || 0, -180, 180);
      const s = clamp(p[`${r.id}Sat`] || 0, -100, 100);
      const l = clamp(p[`${r.id}Light`] || 0, -100, 100);
      if (!h && !s && !l) continue;
      if (r.center < 0) bands.unshift({ master: true, h, s, l });
      else bands.push({ master: false, center: r.center, h, s, l });
    }
    if (!bands.length) return;

    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      rgbToHsl(d[i], d[i + 1], d[i + 2], hsl);
      let dh = 0, ds = 0, dl = 0;
      for (const b of bands) {
        const w = b.master ? 1 : bandWeight(hsl[0], b.center);
        if (w <= 0) continue;
        dh += b.h * w;
        ds += b.s * w;
        dl += b.l * w;
      }
      if (!dh && !ds && !dl) continue;
      const s = clamp(hsl[1] * (1 + clamp(ds, -100, 300) / 100), 0, 1);
      const l = clamp(applyLightness(hsl[2], clamp(dl, -100, 100)), 0, 1);
      hslToRgb(hsl[0] + dh, s, l, out);
      d[i] = out[0]; d[i + 1] = out[1]; d[i + 2] = out[2];
    }
  },
});

/* ================================================================== */
/* Color Balance                                                       */
/* ================================================================== */

const CB_TONES = ['shadows', 'midtones', 'highlights'];
const CB_AXES = [
  { key: 'CR', label: 'Cyan / Red', channel: 0 },
  { key: 'MG', label: 'Magenta / Green', channel: 1 },
  { key: 'YB', label: 'Yellow / Blue', channel: 2 },
];

const cbParams = [];
for (const tone of CB_TONES) {
  cbParams.push({ type: 'label', label: tone[0].toUpperCase() + tone.slice(1) });
  for (const axis of CB_AXES) {
    cbParams.push({
      key: `${tone}${axis.key}`, label: axis.label, type: 'slider',
      min: -100, max: 100, step: 1, default: 0,
    });
  }
}
cbParams.push({ type: 'separator' });
cbParams.push({ key: 'preserveLuminosity', label: 'Preserve Luminosity', type: 'checkbox', default: true });

/** GIMP-style tonal weighting: smooth, overlapping shadow/midtone/highlight bands. */
function toneWeights(t) {
  const a = 0.25, b = 0.333, scale = 0.7;
  const s = clamp((t - b) / -a + 0.5, 0, 1) * scale;
  const h = clamp((t + b - 1) / a + 0.5, 0, 1) * scale;
  const m = clamp((t - b) / a + 0.5, 0, 1) * clamp((t + b - 1) / -a + 0.5, 0, 1) * scale;
  return [s, m, h];
}

registerAdjustment({
  id: 'color-balance',
  name: 'Color Balance...',
  group: 'color',
  params: cbParams,
  apply(imageData, p) {
    const amounts = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; // [tone][channel]
    let any = false;
    for (let t = 0; t < 3; t++) {
      for (let c = 0; c < 3; c++) {
        const v = clamp(p[`${CB_TONES[t]}${CB_AXES[c].key}`] || 0, -100, 100) / 100;
        amounts[t][c] = v;
        if (v) any = true;
      }
    }
    if (!any) return;

    const luts = [];
    for (let c = 0; c < 3; c++) {
      luts.push(buildLUT((i) => {
        const w = toneWeights(i / 255);
        const shift = amounts[0][c] * w[0] + amounts[1][c] * w[1] + amounts[2][c] * w[2];
        return Math.round(i + shift * 255);
      }));
    }

    const d = imageData.data;
    const preserve = !!p.preserveLuminosity;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const l0 = preserve ? luma8(d[i], d[i + 1], d[i + 2]) : 0;
      d[i] = luts[0][d[i]];
      d[i + 1] = luts[1][d[i + 1]];
      d[i + 2] = luts[2][d[i + 2]];
      if (preserve) restoreLuma(d, i, l0);
    }
  },
});

/* ================================================================== */
/* Black & White                                                       */
/* ================================================================== */

const BW_KEYS = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'];

const BW_PRESETS = {
  'Default': { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80 },
  'Blue Filter': { reds: 0, yellows: -10, greens: 20, cyans: 110, blues: 150, magentas: 60 },
  'Green Filter': { reds: 0, yellows: 60, greens: 200, cyans: 60, blues: -10, magentas: 0 },
  'Red Filter': { reds: 120, yellows: 110, greens: 40, cyans: -10, blues: 0, magentas: 60 },
  'Yellow Filter': { reds: 60, yellows: 180, greens: 60, cyans: -10, blues: 0, magentas: 60 },
  'High Contrast Blue Filter': { reds: -30, yellows: -60, greens: -30, cyans: 140, blues: 200, magentas: 30 },
  'High Contrast Red Filter': { reds: 160, yellows: 200, greens: -30, cyans: -60, blues: -30, magentas: 100 },
  'Infrared': { reds: -70, yellows: 200, greens: 300, cyans: 60, blues: -30, magentas: 0 },
  'Maximum Black': { reds: 0, yellows: 0, greens: 0, cyans: 0, blues: 0, magentas: 0 },
  'Maximum White': { reds: 300, yellows: 300, greens: 300, cyans: 300, blues: 300, magentas: 300 },
  'Neutral Density': { reds: 30, yellows: 89, greens: 59, cyans: 70, blues: 11, magentas: 41 },
};

/**
 * Decompose a pixel into achromatic + secondary + primary components and mix
 * them with the six channel weights — the same model Photoshop's B&W uses.
 */
function blackWhiteGrey(r, g, b, w) {
  let mx, md, mn, primary, secondary;
  if (r >= g) {
    if (g >= b) { mx = r; md = g; mn = b; primary = 0; secondary = 1; }       // red, yellow
    else if (r >= b) { mx = r; md = b; mn = g; primary = 0; secondary = 5; }  // red, magenta
    else { mx = b; md = r; mn = g; primary = 4; secondary = 5; }              // blue, magenta
  } else if (g >= b) {
    if (r >= b) { mx = g; md = r; mn = b; primary = 2; secondary = 1; }       // green, yellow
    else { mx = g; md = b; mn = r; primary = 2; secondary = 3; }              // green, cyan
  } else { mx = b; md = g; mn = r; primary = 4; secondary = 3; }              // blue, cyan
  return mn + (md - mn) * w[secondary] + (mx - md) * w[primary];
}

registerAdjustment({
  id: 'black-white',
  name: 'Black & White...',
  group: 'color',
  params: [
    presetParam({ key: 'preset', label: 'Preset', presets: BW_PRESETS, default: 'Default' }),
    { key: 'reds', label: 'Reds', type: 'slider', min: -200, max: 300, step: 1, default: 40 },
    { key: 'yellows', label: 'Yellows', type: 'slider', min: -200, max: 300, step: 1, default: 60 },
    { key: 'greens', label: 'Greens', type: 'slider', min: -200, max: 300, step: 1, default: 40 },
    { key: 'cyans', label: 'Cyans', type: 'slider', min: -200, max: 300, step: 1, default: 60 },
    { key: 'blues', label: 'Blues', type: 'slider', min: -200, max: 300, step: 1, default: 20 },
    { key: 'magentas', label: 'Magentas', type: 'slider', min: -200, max: 300, step: 1, default: 80 },
    { type: 'separator' },
    { key: 'tint', label: 'Tint', type: 'checkbox', default: false },
    { key: 'tintColor', label: 'Tint Color', type: 'color', default: '#d9b48f', when: (s) => s.tint },
  ],
  apply(imageData, p) {
    const w = BW_KEYS.map((k) => clamp(p[k] == null ? 0 : p[k], -200, 300) / 100);
    const d = imageData.data;
    const out = new Float64Array(3);
    let th = 0, ts = 0;
    if (p.tint) {
      const c = parseColor(p.tintColor || '#d9b48f');
      const hsl = new Float64Array(3);
      rgbToHsl(c.r, c.g, c.b, hsl);
      th = hsl[0];
      ts = hsl[1];
    }
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const grey = clamp255(blackWhiteGrey(d[i], d[i + 1], d[i + 2], w));
      if (p.tint && ts > 0) {
        hslToRgb(th, ts, grey / 255, out);
        d[i] = out[0]; d[i + 1] = out[1]; d[i + 2] = out[2];
      } else {
        d[i] = grey; d[i + 1] = grey; d[i + 2] = grey;
      }
    }
  },
});

/* ================================================================== */
/* Photo Filter                                                        */
/* ================================================================== */

const PHOTO_FILTERS = {
  'Warming Filter (85)': '#ec8a00',
  'Warming Filter (LBA)': '#fa9600',
  'Warming Filter (81)': '#ebb113',
  'Cooling Filter (80)': '#006dff',
  'Cooling Filter (LBB)': '#005dff',
  'Cooling Filter (82)': '#00b5ff',
  'Red': '#ea1a1a',
  'Orange': '#f7a50a',
  'Yellow': '#ebe10a',
  'Green': '#19c919',
  'Cyan': '#0bc4c4',
  'Blue': '#1a4cea',
  'Violet': '#9c1aea',
  'Magenta': '#ea1ac4',
  'Sepia': '#ac7a33',
  'Deep Red': '#ff0000',
  'Deep Blue': '#0000ff',
  'Deep Emerald': '#008c00',
  'Underwater': '#00c2b1',
  'Custom': null,
};

registerAdjustment({
  id: 'photo-filter',
  name: 'Photo Filter...',
  group: 'color',
  params: [
    {
      key: 'filter', label: 'Filter', type: 'select', default: 'Warming Filter (85)',
      options: Object.keys(PHOTO_FILTERS),
    },
    { key: 'color', label: 'Color', type: 'color', default: '#ec8a00', when: (s) => s.filter === 'Custom' },
    { key: 'density', label: 'Density', type: 'slider', min: 1, max: 100, step: 1, default: 25, unit: '%' },
    { key: 'preserveLuminosity', label: 'Preserve Luminosity', type: 'checkbox', default: true },
  ],
  apply(imageData, p) {
    const hex = PHOTO_FILTERS[p.filter] || p.color || '#ec8a00';
    const c = parseColor(hex);
    const dens = clamp(p.density, 0, 100) / 100;
    if (dens <= 0) return;
    // A density-weighted multiply by the filter colour: linear per channel.
    const kr = 1 - dens * (1 - c.r / 255);
    const kg = 1 - dens * (1 - c.g / 255);
    const kb = 1 - dens * (1 - c.b / 255);
    const d = imageData.data;
    const preserve = !!p.preserveLuminosity;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const l0 = preserve ? luma8(d[i], d[i + 1], d[i + 2]) : 0;
      d[i] = clamp255(d[i] * kr);
      d[i + 1] = clamp255(d[i + 1] * kg);
      d[i + 2] = clamp255(d[i + 2] * kb);
      if (preserve) restoreLuma(d, i, l0);
    }
  },
});

/* ================================================================== */
/* Channel Mixer                                                       */
/* ================================================================== */

const CM_OUTPUTS = ['red', 'green', 'blue'];

const CM_PRESETS = {
  'Default': { redR: 100, redG: 0, redB: 0, redC: 0, greenR: 0, greenG: 100, greenB: 0, greenC: 0, blueR: 0, blueG: 0, blueB: 100, blueC: 0, grayR: 40, grayG: 40, grayB: 20, grayC: 0, monochrome: false },
  'Black & White Infrared (RGB)': { monochrome: true, grayR: -70, grayG: 200, grayB: -30, grayC: 0 },
  'Black & White Blue Filter (RGB)': { monochrome: true, grayR: 0, grayG: 0, grayB: 100, grayC: 0 },
  'Black & White Green Filter (RGB)': { monochrome: true, grayR: 0, grayG: 100, grayB: 0, grayC: 0 },
  'Black & White Orange Filter (RGB)': { monochrome: true, grayR: 50, grayG: 50, grayB: 0, grayC: 0 },
  'Black & White Red Filter (RGB)': { monochrome: true, grayR: 100, grayG: 0, grayB: 0, grayC: 0 },
  'Black & White Yellow Filter (RGB)': { monochrome: true, grayR: 34, grayG: 66, grayB: 0, grayC: 0 },
};

const cmParams = [
  presetParam({ key: 'preset', label: 'Preset', presets: CM_PRESETS, default: 'Default' }),
  { key: 'monochrome', label: 'Monochrome', type: 'checkbox', default: false },
  {
    key: 'outputChannel', label: 'Output Channel', type: 'select', default: 'red',
    options: CM_OUTPUTS.map((c) => ({ value: c, label: c[0].toUpperCase() + c.slice(1) })),
    when: (s) => !s.monochrome,
  },
  { type: 'separator' },
];
for (const out of [...CM_OUTPUTS, 'gray']) {
  const prefix = out;
  const vis = out === 'gray' ? (s) => !!s.monochrome : (s) => !s.monochrome && s.outputChannel === out;
  const identity = { red: 'R', green: 'G', blue: 'B', gray: null }[out];
  for (const src of ['R', 'G', 'B']) {
    cmParams.push({
      key: `${prefix}${src}`, label: { R: 'Red', G: 'Green', B: 'Blue' }[src],
      type: 'slider', min: -200, max: 200, step: 1,
      default: out === 'gray' ? (src === 'B' ? 20 : 40) : (src === identity ? 100 : 0),
      unit: '%', when: vis,
    });
  }
  cmParams.push({
    key: `${prefix}C`, label: 'Constant', type: 'slider', min: -200, max: 200, step: 1,
    default: 0, unit: '%', when: vis,
  });
}

registerAdjustment({
  id: 'channel-mixer',
  name: 'Channel Mixer...',
  group: 'color',
  params: cmParams,
  apply(imageData, p) {
    const d = imageData.data;
    const g = (k) => clamp(p[k] == null ? 0 : p[k], -200, 200) / 100;
    if (p.monochrome) {
      const wr = g('grayR'), wg = g('grayG'), wb = g('grayB'), c = g('grayC') * 255;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const v = clamp255(d[i] * wr + d[i + 1] * wg + d[i + 2] * wb + c);
        d[i] = v; d[i + 1] = v; d[i + 2] = v;
      }
      return;
    }
    const m = [
      [g('redR'), g('redG'), g('redB'), g('redC') * 255],
      [g('greenR'), g('greenG'), g('greenB'), g('greenC') * 255],
      [g('blueR'), g('blueG'), g('blueB'), g('blueC') * 255],
    ];
    const identity =
      m[0][0] === 1 && m[0][1] === 0 && m[0][2] === 0 && m[0][3] === 0 &&
      m[1][0] === 0 && m[1][1] === 1 && m[1][2] === 0 && m[1][3] === 0 &&
      m[2][0] === 0 && m[2][1] === 0 && m[2][2] === 1 && m[2][3] === 0;
    if (identity) return;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      d[i] = clamp255(r * m[0][0] + gg * m[0][1] + b * m[0][2] + m[0][3]);
      d[i + 1] = clamp255(r * m[1][0] + gg * m[1][1] + b * m[1][2] + m[1][3]);
      d[i + 2] = clamp255(r * m[2][0] + gg * m[2][1] + b * m[2][2] + m[2][3]);
    }
  },
});

/* ================================================================== */
/* Color Lookup                                                        */
/* ================================================================== */

/**
 * Each look is a small, real colour transform: per-channel curves, an optional
 * 3×3 mix, a saturation factor, split toning and hue-selective desaturation.
 */
const LOOKS = {
  'Crisp Warm': {
    curves: {
      r: [[0, 6], [64, 78], [128, 146], [192, 210], [255, 255]],
      g: [[0, 0], [64, 62], [128, 130], [192, 198], [255, 253]],
      b: [[0, 0], [64, 54], [128, 118], [192, 184], [255, 246]],
    },
    sat: 1.08,
  },
  'Crisp Winter': {
    curves: {
      r: [[0, 0], [64, 56], [128, 122], [192, 190], [255, 248]],
      g: [[0, 2], [64, 64], [128, 130], [192, 198], [255, 253]],
      b: [[0, 10], [64, 78], [128, 144], [192, 208], [255, 255]],
    },
    sat: 1.04,
  },
  'Drop Blues': {
    curves: { r: [[0, 0], [128, 134], [255, 255]], g: [[0, 0], [128, 130], [255, 255]], b: [[0, 0], [128, 120], [255, 246]] },
    dropDominant: { channel: 2, amount: 0.85 },
    sat: 1.05,
  },
  'Fall Colors': {
    curves: {
      r: [[0, 8], [64, 86], [128, 156], [192, 214], [255, 255]],
      g: [[0, 0], [64, 58], [128, 124], [192, 192], [255, 246]],
      b: [[0, 0], [64, 44], [128, 100], [192, 166], [255, 226]],
    },
    dropDominant: { channel: 1, amount: 0.35 },
    sat: 1.18,
  },
  'Foggy Night': {
    curves: {
      r: [[0, 48], [128, 132], [255, 206]],
      g: [[0, 52], [128, 136], [255, 210]],
      b: [[0, 62], [128, 146], [255, 216]],
    },
    sat: 0.42,
  },
  'Late Sunset': {
    curves: {
      r: [[0, 22], [64, 100], [128, 172], [192, 224], [255, 255]],
      g: [[0, 10], [64, 60], [128, 122], [192, 186], [255, 238]],
      b: [[0, 24], [64, 58], [128, 100], [192, 154], [255, 206]],
    },
    split: { shadow: '#3a1a4a', highlight: '#ffa438', amount: 0.28 },
    sat: 1.2,
  },
  'Moonlight': {
    curves: {
      r: [[0, 0], [64, 38], [128, 84], [192, 138], [255, 196]],
      g: [[0, 2], [64, 46], [128, 98], [192, 156], [255, 214]],
      b: [[0, 14], [64, 70], [128, 130], [192, 190], [255, 240]],
    },
    sat: 0.55,
  },
  'Night From Day': {
    curves: {
      r: [[0, 0], [64, 26], [128, 62], [192, 108], [255, 158]],
      g: [[0, 0], [64, 32], [128, 72], [192, 122], [255, 174]],
      b: [[0, 10], [64, 58], [128, 108], [192, 160], [255, 214]],
    },
    sat: 0.65,
  },
  'Soft Warming': {
    curves: {
      r: [[0, 8], [128, 138], [255, 255]],
      g: [[0, 6], [128, 132], [255, 252]],
      b: [[0, 4], [128, 122], [255, 244]],
    },
    sat: 1.02,
  },
  'Teal & Orange': {
    curves: {
      r: [[0, 0], [64, 60], [128, 136], [192, 208], [255, 255]],
      g: [[0, 4], [64, 62], [128, 128], [192, 194], [255, 250]],
      b: [[0, 16], [64, 74], [128, 126], [192, 180], [255, 236]],
    },
    split: { shadow: '#0e4a55', highlight: '#ffb066', amount: 0.32 },
    sat: 1.12,
  },
  'Bleach Bypass': {
    curves: {
      r: [[0, 0], [48, 24], [128, 140], [208, 236], [255, 255]],
      g: [[0, 0], [48, 24], [128, 140], [208, 236], [255, 255]],
      b: [[0, 0], [48, 26], [128, 140], [208, 234], [255, 255]],
    },
    sat: 0.28,
  },
  'Technicolor': {
    mix: [1.32, -0.18, -0.14, -0.16, 1.28, -0.12, -0.14, -0.22, 1.36],
    curves: {
      r: [[0, 0], [64, 58], [128, 130], [192, 206], [255, 255]],
      g: [[0, 0], [64, 58], [128, 130], [192, 206], [255, 255]],
      b: [[0, 0], [64, 58], [128, 130], [192, 206], [255, 255]],
    },
    sat: 1.35,
  },
};

function applyLook(imageData, look) {
  const d = imageData.data;
  const lr = look.curves && look.curves.r ? pointsToLUT(look.curves.r) : null;
  const lg = look.curves && look.curves.g ? pointsToLUT(look.curves.g) : null;
  const lb = look.curves && look.curves.b ? pointsToLUT(look.curves.b) : null;
  const m = look.mix || null;
  const sat = look.sat == null ? 1 : look.sat;
  const split = look.split ? {
    s: parseColor(look.split.shadow),
    h: parseColor(look.split.highlight),
    a: look.split.amount,
  } : null;
  const drop = look.dropDominant || null;

  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    let r = d[i], g = d[i + 1], b = d[i + 2];

    if (m) {
      const nr = r * m[0] + g * m[1] + b * m[2];
      const ng = r * m[3] + g * m[4] + b * m[5];
      const nb = r * m[6] + g * m[7] + b * m[8];
      r = clamp255(nr); g = clamp255(ng); b = clamp255(nb);
    }
    if (lr) r = lr[r | 0];
    if (lg) g = lg[g | 0];
    if (lb) b = lb[b | 0];

    if (split) {
      const t = luma8(r, g, b) / 255;
      const ws = (1 - t) * (1 - t) * split.a;
      const wh = t * t * split.a;
      r = r + (split.s.r - r) * ws + (split.h.r - r) * wh;
      g = g + (split.s.g - g) * ws + (split.h.g - g) * wh;
      b = b + (split.s.b - b) * ws + (split.h.b - b) * wh;
    }

    let f = sat;
    if (drop) {
      const ch = drop.channel === 0 ? r : drop.channel === 1 ? g : b;
      const other = drop.channel === 0 ? Math.max(g, b) : drop.channel === 1 ? Math.max(r, b) : Math.max(r, g);
      const dominance = ch > other ? (ch - other) / 255 : 0;
      f *= 1 - drop.amount * Math.min(1, dominance * 3);
    }
    if (f !== 1) {
      const l = luma8(r, g, b);
      r = l + (r - l) * f;
      g = l + (g - l) * f;
      b = l + (b - l) * f;
    }

    d[i] = clamp255(r);
    d[i + 1] = clamp255(g);
    d[i + 2] = clamp255(b);
  }
}

registerAdjustment({
  id: 'color-lookup',
  name: 'Color Lookup...',
  group: 'color',
  params: [
    { key: 'lut', label: 'Look', type: 'select', default: 'Crisp Warm', options: Object.keys(LOOKS) },
    { key: 'amount', label: 'Amount', type: 'slider', min: 0, max: 100, step: 1, default: 100, unit: '%' },
  ],
  apply(imageData, p) {
    const look = LOOKS[p.lut];
    if (!look) return;
    const amount = clamp(p.amount == null ? 100 : p.amount, 0, 100) / 100;
    if (amount <= 0) return;
    if (amount >= 1) {
      applyLook(imageData, look);
      return;
    }
    const src = new Uint8ClampedArray(imageData.data);
    applyLook(imageData, look);
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = src[i] + (d[i] - src[i]) * amount;
      d[i + 1] = src[i + 1] + (d[i + 1] - src[i + 1]) * amount;
      d[i + 2] = src[i + 2] + (d[i + 2] - src[i + 2]) * amount;
    }
  },
});

export { LOOKS, applyLook, restoreLuma, toneWeights, composeLUT };
