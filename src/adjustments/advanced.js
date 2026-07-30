import './advanced.css';
import { registerAdjustment, buildLUT, applyLUT } from './registry.js';
import { el, clamp, clamp255, createCanvas, ctx2dRead } from '../core/util.js';
import { parseColor, toHex } from '../core/color.js';
import { rgbToHsl, hslToRgb, luma8 } from './basic.js';
import { gradientParam, gradientToLUT, defaultGradient } from '../ui/gradient-editor.js';
import { computeHistogram, drawHistogram, setupHiDPI, currentHistogram, clipPoints, emptyHistogram } from '../ui/histogram.js';
import { getComposite } from '../render/compositor.js';
import { app } from '../core/app.js';

/**
 * The rest of Image > Adjustments: pixel-mapping operations, the mask-driven
 * Shadows/Highlights and HDR Toning pair, and the three Auto commands.
 */

/* ------------------------------------------------------------------ */
/* Local helpers                                                       */
/* ------------------------------------------------------------------ */

/** Separable box blur with running sums — cost is independent of radius. */
function boxPass(src, dst, w, h, r, vertical) {
  const inv = 1 / (2 * r + 1);
  if (!vertical) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += src[row + clamp(i, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        dst[row + x] = acc * inv;
        acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
      }
    }
  } else {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += src[clamp(i, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        dst[y * w + x] = acc * inv;
        acc += src[Math.min(h - 1, y + r + 1) * w + x] - src[Math.max(0, y - r) * w + x];
      }
    }
  }
}

/**
 * Blur a single-channel image. Three box passes approximate a gaussian well
 * enough that the shadow/highlight mask has no visible halo edge.
 */
function blurGray(src, w, h, radius, passes = 3) {
  const r = Math.max(0, Math.round(radius));
  if (r < 1) return Float32Array.from(src);
  let a = Float32Array.from(src);
  let b = new Float32Array(w * h);
  const per = Math.max(1, Math.round(r / Math.sqrt(passes)));
  for (let p = 0; p < passes; p++) {
    boxPass(a, b, w, h, per, false);
    boxPass(b, a, w, h, per, true);
  }
  return a;
}

/** Luminance plane of an ImageData. */
function lumaPlane(imageData) {
  const d = imageData.data;
  const n = d.length >> 2;
  const out = new Float32Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) out[j] = luma8(d[i], d[i + 1], d[i + 2]);
  return out;
}

const smoothstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/* ================================================================== */
/* Invert                                                              */
/* ================================================================== */

const INVERT_LUT = buildLUT((i) => 255 - i);

registerAdjustment({
  id: 'invert',
  name: 'Invert',
  group: 'map',
  params: [],
  apply(imageData) {
    applyLUT(imageData, INVERT_LUT, INVERT_LUT, INVERT_LUT);
  },
});

/* ================================================================== */
/* Posterize                                                           */
/* ================================================================== */

registerAdjustment({
  id: 'posterize',
  name: 'Posterize...',
  group: 'map',
  dialogWidth: 320,
  params: [{ key: 'levels', label: 'Levels', type: 'slider', min: 2, max: 255, step: 1, default: 4 }],
  apply(imageData, p) {
    const n = clamp(Math.round(p.levels), 2, 255);
    if (n >= 255) return;
    const step = 255 / (n - 1);
    const lut = buildLUT((i) => Math.round(Math.round((i / 255) * (n - 1)) * step));
    applyLUT(imageData, lut, lut, lut);
  },
});

/* ================================================================== */
/* Threshold                                                           */
/* ================================================================== */

function thresholdHistogramParam() {
  return {
    key: '_thresholdHist',
    label: '',
    type: 'custom',
    default: 0,
    render(container, state, onChange) {
      const PAD = 8, PLOT = 256, HH = 84, W = PLOT + PAD * 2, H = HH + 4;
      const canvas = el('canvas.pk-thr-canvas', { width: W, height: H });
      const ctx = setupHiDPI(canvas, W, H);
      let hist;
      try {
        hist = currentHistogram() || emptyHistogram();
      } catch {
        hist = emptyHistogram();
      }
      container.appendChild(canvas);

      const draw = () => {
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#1c1c1c';
        ctx.fillRect(PAD, 0, PLOT, HH);
        drawHistogram(canvas, hist, {
          channel: 'l', rect: { x: PAD, y: 0, width: PLOT, height: HH }, fill: 0.85, color: '#b4b4b4', clear: false,
        });
        ctx.strokeStyle = 'rgba(255,255,255,.25)';
        ctx.strokeRect(PAD + 0.5, 0.5, PLOT - 1, HH - 1);
        const x = PAD + (clamp(state.level, 0, 255) / 255) * PLOT;
        ctx.strokeStyle = '#ff5252';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, HH);
        ctx.stroke();
      };

      let down = false;
      const set = (e) => {
        const rect = canvas.getBoundingClientRect();
        const v = clamp(Math.round(((e.clientX - rect.left - PAD) / PLOT) * 255), 1, 255);
        state.level = v;
        draw();
        onChange('level', v);
      };
      canvas.addEventListener('pointerdown', (e) => { down = true; canvas.setPointerCapture(e.pointerId); set(e); });
      canvas.addEventListener('pointermove', (e) => { if (down) set(e); });
      canvas.addEventListener('pointerup', (e) => { down = false; canvas.releasePointerCapture(e.pointerId); });

      draw();
      return { sync: draw };
    },
  };
}

registerAdjustment({
  id: 'threshold',
  name: 'Threshold...',
  group: 'map',
  dialogWidth: 320,
  params: [
    thresholdHistogramParam(),
    { key: 'level', label: 'Threshold Level', type: 'slider', min: 1, max: 255, step: 1, default: 128 },
  ],
  apply(imageData, p) {
    const level = clamp(Math.round(p.level), 1, 255);
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      // Round to 8-bit before comparing: the weighted sum is a double, so a
      // neutral 128 grey evaluates to 127.99999999999999 and would fall on the
      // wrong side of level 128. Most other luma8 callers interpolate with it,
      // so the rounding belongs here rather than in luma8 itself.
      const v = Math.round(luma8(d[i], d[i + 1], d[i + 2])) >= level ? 255 : 0;
      d[i] = v; d[i + 1] = v; d[i + 2] = v;
    }
  },
});

/* ================================================================== */
/* Gradient Map                                                        */
/* ================================================================== */

// 4×4 ordered dither, scaled to ±~2 levels — enough to break up banding in
// gradients built from only a couple of stops.
const BAYER4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
];

registerAdjustment({
  id: 'gradient-map',
  name: 'Gradient Map...',
  group: 'map',
  dialogWidth: 380,
  params: [
    gradientParam({ key: 'gradient', label: 'Gradient Used for Grayscale Mapping' }),
    { key: 'reverse', label: 'Reverse', type: 'checkbox', default: false },
    { key: 'dither', label: 'Dither', type: 'checkbox', default: false },
  ],
  defaults: { gradient: defaultGradient(), reverse: false, dither: false },
  apply(imageData, p) {
    const lut = gradientToLUT(p.gradient);
    const d = imageData.data;
    const w = imageData.width;
    const reverse = !!p.reverse;
    const dither = !!p.dither;
    for (let i = 0, px = 0; i < d.length; i += 4, px++) {
      if (d[i + 3] === 0) continue;
      let t = luma8(d[i], d[i + 1], d[i + 2]);
      if (dither) {
        const x = px % w, y = (px / w) | 0;
        t += (BAYER4[(y & 3) * 4 + (x & 3)] / 15 - 0.5) * 4;
      }
      let idx = clamp(Math.round(t), 0, 255);
      if (reverse) idx = 255 - idx;
      const a = lut.a[idx];
      if (a >= 1) {
        d[i] = lut.r[idx]; d[i + 1] = lut.g[idx]; d[i + 2] = lut.b[idx];
      } else if (a > 0) {
        d[i] += (lut.r[idx] - d[i]) * a;
        d[i + 1] += (lut.g[idx] - d[i + 1]) * a;
        d[i + 2] += (lut.b[idx] - d[i + 2]) * a;
      }
    }
  },
});

/* ================================================================== */
/* Selective Color                                                     */
/* ================================================================== */

const SC_GROUPS = [
  { id: 'reds', label: 'Reds' },
  { id: 'yellows', label: 'Yellows' },
  { id: 'greens', label: 'Greens' },
  { id: 'cyans', label: 'Cyans' },
  { id: 'blues', label: 'Blues' },
  { id: 'magentas', label: 'Magentas' },
  { id: 'whites', label: 'Whites' },
  { id: 'neutrals', label: 'Neutrals' },
  { id: 'blacks', label: 'Blacks' },
];
const SC_INKS = [
  { suffix: 'C', label: 'Cyan' },
  { suffix: 'M', label: 'Magenta' },
  { suffix: 'Y', label: 'Yellow' },
  { suffix: 'K', label: 'Black' },
];

const scParams = [
  { key: 'color', label: 'Colors', type: 'select', default: 'reds', options: SC_GROUPS.map((g) => ({ value: g.id, label: g.label })) },
];
for (const g of SC_GROUPS) {
  for (const ink of SC_INKS) {
    scParams.push({
      key: `${g.id}${ink.suffix}`, label: ink.label, type: 'slider',
      min: -100, max: 100, step: 1, default: 0, unit: '%',
      when: (s) => s.color === g.id,
    });
  }
}
scParams.push({ type: 'separator' });
scParams.push({
  key: 'method', label: 'Method', type: 'radio', default: 'relative',
  options: [{ value: 'relative', label: 'Relative' }, { value: 'absolute', label: 'Absolute' }],
});

registerAdjustment({
  id: 'selective-color',
  name: 'Selective Color...',
  group: 'color',
  params: scParams,
  apply(imageData, p) {
    const table = [];
    let any = false;
    for (const g of SC_GROUPS) {
      const row = SC_INKS.map((ink) => clamp(p[`${g.id}${ink.suffix}`] || 0, -100, 100) / 100);
      if (row.some((v) => v !== 0)) any = true;
      table.push(row);
    }
    if (!any) return;
    const relative = p.method !== 'absolute';
    const d = imageData.data;
    const w = new Float64Array(9);

    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const md = r + g + b - mx - mn;
      w.fill(0);

      if (mx > md) {
        const primary = mx === r ? 0 : mx === g ? 2 : 4;
        w[primary] = (mx - md) / 255;
      }
      if (md > mn) {
        // The secondary is the mix of the two brightest channels.
        const dark = mn === r ? 0 : mn === g ? 1 : 2;
        const secondary = dark === 2 ? 1 : dark === 0 ? 3 : 5; // yellow / cyan / magenta
        w[secondary] = (md - mn) / 255;
      }
      const l = luma8(r, g, b) / 255;
      w[6] = mn > 127.5 ? (mn / 255 - 0.5) * 2 : 0;
      w[8] = mx < 127.5 ? 1 - (mx / 255) * 2 : 0;
      w[7] = clamp(1 - Math.abs(2 * l - 1), 0, 1);

      const k0 = 1 - mx / 255;
      const denom = 1 - k0;
      let c = 0, m = 0, y = 0;
      if (denom > 1e-6) {
        c = (1 - r / 255 - k0) / denom;
        m = (1 - g / 255 - k0) / denom;
        y = (1 - b / 255 - k0) / denom;
      }
      let k = k0;
      let touched = false;

      for (let gi = 0; gi < 9; gi++) {
        const wt = w[gi];
        if (wt <= 0) continue;
        const row = table[gi];
        if (!row[0] && !row[1] && !row[2] && !row[3]) continue;
        touched = true;
        if (relative) {
          c += c * row[0] * wt;
          m += m * row[1] * wt;
          y += y * row[2] * wt;
          k += k * row[3] * wt;
        } else {
          c += row[0] * wt;
          m += row[1] * wt;
          y += row[2] * wt;
          k += row[3] * wt;
        }
      }
      if (!touched) continue;

      c = clamp(c, 0, 1); m = clamp(m, 0, 1); y = clamp(y, 0, 1); k = clamp(k, 0, 1);
      d[i] = clamp255(255 * (1 - c) * (1 - k));
      d[i + 1] = clamp255(255 * (1 - m) * (1 - k));
      d[i + 2] = clamp255(255 * (1 - y) * (1 - k));
    }
  },
});

/* ================================================================== */
/* Shadows / Highlights                                                */
/* ================================================================== */

/** Lazily-built bank of gamma LUTs — avoids three Math.pow calls per pixel. */
function gammaBank(count, minLog, maxLog) {
  const bank = new Array(count).fill(null);
  return (expo) => {
    const t = clamp((Math.log(expo) - minLog) / (maxLog - minLog), 0, 1);
    const idx = Math.round(t * (count - 1));
    let lut = bank[idx];
    if (!lut) {
      const g = Math.exp(minLog + (idx / (count - 1)) * (maxLog - minLog));
      lut = buildLUT((i) => Math.round(255 * Math.pow(i / 255, g)));
      bank[idx] = lut;
    }
    return lut;
  };
}

registerAdjustment({
  id: 'shadows-highlights',
  name: 'Shadows/Highlights...',
  group: 'tone',
  dialogWidth: 420,
  params: [
    { type: 'label', label: 'Shadows' },
    { key: 'shadowsAmount', label: 'Amount', type: 'slider', min: 0, max: 100, step: 1, default: 35, unit: '%' },
    { key: 'shadowsTone', label: 'Tone', type: 'slider', min: 1, max: 100, step: 1, default: 50, unit: '%' },
    { key: 'shadowsRadius', label: 'Radius', type: 'slider', min: 0, max: 500, step: 1, default: 30, unit: 'px' },
    { type: 'label', label: 'Highlights' },
    { key: 'highlightsAmount', label: 'Amount', type: 'slider', min: 0, max: 100, step: 1, default: 0, unit: '%' },
    { key: 'highlightsTone', label: 'Tone', type: 'slider', min: 1, max: 100, step: 1, default: 50, unit: '%' },
    { key: 'highlightsRadius', label: 'Radius', type: 'slider', min: 0, max: 500, step: 1, default: 30, unit: 'px' },
    { type: 'label', label: 'Adjustments' },
    { key: 'colorCorrection', label: 'Color Correction', type: 'slider', min: -100, max: 100, step: 1, default: 20 },
    { key: 'midtoneContrast', label: 'Midtone Contrast', type: 'slider', min: -100, max: 100, step: 1, default: 0 },
    { key: 'blackClip', label: 'Black Clip', type: 'number', min: 0, max: 10, step: 0.01, default: 0.01, unit: '%' },
    { key: 'whiteClip', label: 'White Clip', type: 'number', min: 0, max: 10, step: 0.01, default: 0.01, unit: '%' },
  ],
  apply(imageData, p) {
    const sAmt = clamp(p.shadowsAmount, 0, 100) / 100;
    const hAmt = clamp(p.highlightsAmount, 0, 100) / 100;
    const midC = clamp(p.midtoneContrast, -100, 100) / 100;
    const blackClip = clamp(p.blackClip, 0, 10);
    const whiteClip = clamp(p.whiteClip, 0, 10);
    if (!sAmt && !hAmt && !midC && !blackClip && !whiteClip) return;

    const w = imageData.width, h = imageData.height;
    const d = imageData.data;
    const lum = lumaPlane(imageData);

    const sTone = clamp(p.shadowsTone, 1, 100) / 100;
    const hTone = clamp(p.highlightsTone, 1, 100) / 100;
    const sRadius = clamp(p.shadowsRadius, 0, 500);
    const hRadius = clamp(p.highlightsRadius, 0, 500);
    const blurS = sAmt ? blurGray(lum, w, h, sRadius) : null;
    const blurH = hAmt ? (hRadius === sRadius && blurS ? blurS : blurGray(lum, w, h, hRadius)) : null;

    const pick = gammaBank(64, Math.log(1 / (1 + 2)), Math.log(1 + 2));
    const cc = clamp(p.colorCorrection, -100, 100) / 100;
    const outHist = new Uint32Array(256);
    let count = 0;

    for (let i = 0, px = 0; i < d.length; i += 4, px++) {
      if (d[i + 3] === 0) continue;
      let sw = 0, hw = 0;
      if (blurS) {
        const bl = blurS[px] / 255;
        sw = smoothstep(clamp((sTone - bl) / sTone, 0, 1));
      }
      if (blurH) {
        const bl = blurH[px] / 255;
        hw = smoothstep(clamp((bl - (1 - hTone)) / hTone, 0, 1));
      }
      const expo = (1 / (1 + 2 * sAmt * sw)) * (1 + 2 * hAmt * hw);
      if (expo !== 1) {
        const lut = pick(expo);
        d[i] = lut[d[i]];
        d[i + 1] = lut[d[i + 1]];
        d[i + 2] = lut[d[i + 2]];
        // Lifting shadows flattens colour: put some of it back.
        if (cc) {
          const strength = sAmt * sw + hAmt * hw;
          const f = 1 + cc * strength;
          const l1 = luma8(d[i], d[i + 1], d[i + 2]);
          d[i] = clamp255(l1 + (d[i] - l1) * f);
          d[i + 1] = clamp255(l1 + (d[i + 1] - l1) * f);
          d[i + 2] = clamp255(l1 + (d[i + 2] - l1) * f);
        }
      }
      outHist[luma8(d[i], d[i + 1], d[i + 2]) | 0]++;
      count++;
    }

    if (!count) return;
    let lo = 0, hi = 255;
    if (blackClip > 0 || whiteClip > 0) {
      const budgetLo = (count * blackClip) / 100;
      const budgetHi = (count * whiteClip) / 100;
      let acc = 0;
      for (let i = 0; i < 256; i++) { acc += outHist[i]; if (acc > budgetLo) { lo = i; break; } }
      acc = 0;
      for (let i = 255; i >= 0; i--) { acc += outHist[i]; if (acc > budgetHi) { hi = i; break; } }
      if (hi - lo < 8) { lo = 0; hi = 255; }
    }
    if (lo === 0 && hi === 255 && !midC) return;

    const span = Math.max(1, hi - lo);
    const finalLut = buildLUT((i) => {
      let t = clamp((i - lo) / span, 0, 1);
      if (midC > 0) t += (t * t * (3 - 2 * t) - t) * midC;
      else if (midC < 0) t = 0.5 + (t - 0.5) * (1 + midC * 0.8);
      return Math.round(t * 255);
    });
    applyLUT(imageData, finalLut, finalLut, finalLut);
  },
});

/* ================================================================== */
/* Desaturate                                                          */
/* ================================================================== */

registerAdjustment({
  id: 'desaturate',
  name: 'Desaturate',
  group: 'map',
  params: [],
  apply(imageData) {
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      // HSL lightness, matching Photoshop's Desaturate.
      const v = (Math.max(r, g, b) + Math.min(r, g, b)) >> 1;
      d[i] = v; d[i + 1] = v; d[i + 2] = v;
    }
  },
});

/* ================================================================== */
/* Equalize                                                            */
/* ================================================================== */

function equalizeLUT(bins, total) {
  const lut = new Uint8ClampedArray(256);
  if (!total) return lut;
  let cdfMin = 0;
  for (let i = 0; i < 256; i++) if (bins[i]) { cdfMin = bins[i]; break; }
  const denom = Math.max(1, total - cdfMin);
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += bins[i];
    lut[i] = Math.round(((acc - cdfMin) / denom) * 255);
  }
  return lut;
}

registerAdjustment({
  id: 'equalize',
  name: 'Equalize',
  group: 'map',
  params: [],
  apply(imageData) {
    const hist = computeHistogram(imageData);
    if (!hist.count) return;
    applyLUT(
      imageData,
      equalizeLUT(hist.r, hist.count),
      equalizeLUT(hist.g, hist.count),
      equalizeLUT(hist.b, hist.count)
    );
  },
});

/* ================================================================== */
/* Replace Color                                                       */
/* ================================================================== */

/** Selection weight for a pixel against the target colour. */
function replaceWeight(r, g, b, tr, tg, tb, fuzz) {
  const dist = Math.max(Math.abs(r - tr), Math.abs(g - tg), Math.abs(b - tb));
  if (fuzz <= 0) return dist === 0 ? 1 : 0;
  return 1 - smoothstep(clamp(dist / fuzz, 0, 1));
}

/** Small live preview of the colour-range mask; click it to sample a colour. */
function replaceMaskParam() {
  return {
    key: '_replaceMask',
    label: 'Selection Preview',
    type: 'custom',
    default: 0,
    render(container, state, onChange) {
      const W = 200, H = 120;
      const canvas = el('canvas.pk-rc-thumb', { width: W, height: H, title: 'Click to sample a colour' });
      const ctx = setupHiDPI(canvas, W, H);
      container.appendChild(canvas);

      // Snapshot the document once so the live preview does not feed back in.
      let source = null, sw = 0, sh = 0, ox = 0, oy = 0, scale = 1;
      try {
        const doc = app.activeDoc;
        const composite = doc ? getComposite(doc) : null;
        if (composite) {
          scale = Math.min(W / composite.width, H / composite.height);
          sw = Math.max(1, Math.round(composite.width * scale));
          sh = Math.max(1, Math.round(composite.height * scale));
          ox = Math.round((W - sw) / 2);
          oy = Math.round((H - sh) / 2);
          const small = createCanvas(sw, sh);
          small.getContext('2d').drawImage(composite, 0, 0, sw, sh);
          source = ctx2dRead(small).getImageData(0, 0, sw, sh);
        }
      } catch {
        source = null;
      }

      const out = source ? new ImageData(sw, sh) : null;

      const draw = () => {
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, W, H);
        if (!source) {
          ctx.fillStyle = '#7a7a7a';
          ctx.font = '11px sans-serif';
          ctx.fillText('No image', 8, 20);
          return;
        }
        const t = parseColor(state.targetColor || '#ff0000');
        const fuzz = clamp(state.fuzziness == null ? 40 : state.fuzziness, 0, 200);
        const sd = source.data, od = out.data;
        for (let i = 0; i < sd.length; i += 4) {
          const v = Math.round(replaceWeight(sd[i], sd[i + 1], sd[i + 2], t.r, t.g, t.b, fuzz) * 255);
          od[i] = v; od[i + 1] = v; od[i + 2] = v; od[i + 3] = 255;
        }
        const tmp = createCanvas(sw, sh);
        tmp.getContext('2d').putImageData(out, 0, 0);
        ctx.drawImage(tmp, ox, oy);
      };

      canvas.addEventListener('click', (e) => {
        if (!source) return;
        const rect = canvas.getBoundingClientRect();
        const x = Math.round(((e.clientX - rect.left) / rect.width) * W) - ox;
        const y = Math.round(((e.clientY - rect.top) / rect.height) * H) - oy;
        if (x < 0 || y < 0 || x >= sw || y >= sh) return;
        const i = (y * sw + x) * 4;
        const hex = toHex({ r: source.data[i], g: source.data[i + 1], b: source.data[i + 2] });
        state.targetColor = hex;
        draw();
        onChange('targetColor', hex);
      });

      draw();
      return { sync: draw };
    },
  };
}

registerAdjustment({
  id: 'replace-color',
  name: 'Replace Color...',
  group: 'color',
  dialogWidth: 380,
  params: [
    { key: 'targetColor', label: 'Target Color', type: 'color', default: '#ff0000' },
    { key: 'fuzziness', label: 'Fuzziness', type: 'slider', min: 0, max: 200, step: 1, default: 40 },
    replaceMaskParam(),
    { type: 'separator' },
    { key: 'hue', label: 'Hue', type: 'slider', min: -180, max: 180, step: 1, default: 0 },
    { key: 'saturation', label: 'Saturation', type: 'slider', min: -100, max: 100, step: 1, default: 0 },
    { key: 'lightness', label: 'Lightness', type: 'slider', min: -100, max: 100, step: 1, default: 0 },
  ],
  apply(imageData, p) {
    const hueShift = clamp(p.hue, -180, 180);
    const satShift = clamp(p.saturation, -100, 100);
    const lightShift = clamp(p.lightness, -100, 100);
    if (!hueShift && !satShift && !lightShift) return;
    const t = parseColor(p.targetColor || '#ff0000');
    const fuzz = clamp(p.fuzziness, 0, 200);
    const d = imageData.data;
    const hsl = new Float64Array(3);
    const rgbOut = new Float64Array(3);

    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const wt = replaceWeight(d[i], d[i + 1], d[i + 2], t.r, t.g, t.b, fuzz);
      if (wt <= 0.001) continue;
      rgbToHsl(d[i], d[i + 1], d[i + 2], hsl);
      const s = clamp(hsl[1] * (1 + satShift / 100), 0, 1);
      const l = lightShift > 0 ? hsl[2] + (1 - hsl[2]) * (lightShift / 100) : hsl[2] * (1 + lightShift / 100);
      hslToRgb(hsl[0] + hueShift, s, clamp(l, 0, 1), rgbOut);
      d[i] += (rgbOut[0] - d[i]) * wt;
      d[i + 1] += (rgbOut[1] - d[i + 1]) * wt;
      d[i + 2] += (rgbOut[2] - d[i + 2]) * wt;
    }
  },
});

/* ================================================================== */
/* HDR Toning                                                          */
/* ================================================================== */

const HDR_METHODS = [
  { value: 'local', label: 'Local Adaptation' },
  { value: 'highlight', label: 'Highlight Compression' },
  { value: 'equalize', label: 'Equalize Histogram' },
  { value: 'exposure', label: 'Exposure and Gamma' },
];

registerAdjustment({
  id: 'hdr-toning',
  name: 'HDR Toning...',
  group: 'tone',
  dialogWidth: 400,
  params: [
    { key: 'method', label: 'Method', type: 'select', default: 'local', options: HDR_METHODS },
    { key: 'radius', label: 'Radius', type: 'slider', min: 1, max: 500, step: 1, default: 40, unit: 'px', when: (s) => s.method === 'local' },
    { key: 'strength', label: 'Strength', type: 'slider', min: 0, max: 4, step: 0.01, default: 1, when: (s) => s.method === 'local' },
    { key: 'detail', label: 'Detail', type: 'slider', min: -300, max: 300, step: 1, default: 30, unit: '%', when: (s) => s.method === 'local' },
    { key: 'shadow', label: 'Shadow', type: 'slider', min: -100, max: 100, step: 1, default: 0, unit: '%', when: (s) => s.method === 'local' || s.method === 'highlight' },
    { key: 'highlight', label: 'Highlight', type: 'slider', min: -100, max: 100, step: 1, default: 0, unit: '%', when: (s) => s.method === 'local' || s.method === 'highlight' },
    { key: 'exposure', label: 'Exposure', type: 'slider', min: -5, max: 5, step: 0.01, default: 0, when: (s) => s.method === 'exposure' },
    { key: 'gamma', label: 'Gamma', type: 'slider', min: 0.1, max: 3, step: 0.01, default: 1, when: (s) => s.method === 'exposure' },
    { type: 'separator' },
    { key: 'vibrance', label: 'Vibrance', type: 'slider', min: -100, max: 100, step: 1, default: 20 },
    { key: 'saturation', label: 'Saturation', type: 'slider', min: 0, max: 300, step: 1, default: 100, unit: '%' },
  ],
  apply(imageData, p) {
    const d = imageData.data;
    const w = imageData.width, h = imageData.height;
    const method = p.method || 'local';

    if (method === 'equalize') {
      const hist = computeHistogram(imageData);
      if (hist.count) {
        const lut = equalizeLUT(hist.l, hist.count);
        applyLUT(imageData, lut, lut, lut);
      }
    } else if (method === 'exposure') {
      const mul = Math.pow(2, clamp(p.exposure, -5, 5));
      const g = clamp(p.gamma, 0.1, 3);
      const lut = buildLUT((i) => Math.round(255 * Math.pow(clamp((i / 255) * mul, 0, 1), g)));
      applyLUT(imageData, lut, lut, lut);
    } else if (method === 'highlight') {
      // Compress the top end so blown highlights come back, keep blacks put.
      const sh = clamp(p.shadow, -100, 100) / 100;
      const hi = clamp(p.highlight, -100, 100) / 100;
      const lut = buildLUT((i) => {
        let t = i / 255;
        t = t / (1 + t * 0.55);
        t *= 1.55;
        t += sh * (1 - t) * (1 - t) * 0.6;
        t += hi * t * t * 0.6;
        return Math.round(clamp(t, 0, 1) * 255);
      });
      applyLUT(imageData, lut, lut, lut);
    } else {
      // Local adaptation: separate the log-luminance into a coarse base layer
      // and a detail layer, compress the base, and amplify the detail.
      const lum = lumaPlane(imageData);
      const n = lum.length;
      const logL = new Float32Array(n);
      let mean = 0;
      for (let i = 0; i < n; i++) {
        logL[i] = Math.log(lum[i] + 1);
        mean += logL[i];
      }
      mean /= Math.max(1, n);
      const base = blurGray(logL, w, h, clamp(p.radius, 1, 500));
      const compress = 1 / (1 + clamp(p.strength, 0, 4));
      const detailGain = Math.max(0, 1 + clamp(p.detail, -300, 300) / 300);
      const sh = clamp(p.shadow, -100, 100) / 100;
      const hi = clamp(p.highlight, -100, 100) / 100;

      for (let i = 0, px = 0; i < d.length; i += 4, px++) {
        if (d[i + 3] === 0) continue;
        const b = base[px];
        const detail = logL[px] - b;
        const newLog = mean + (b - mean) * compress + detail * detailGain;
        let t = clamp((Math.exp(newLog) - 1) / 255, 0, 1);
        if (sh) t += sh * (1 - t) * (1 - t);
        if (hi) t += hi * t * t;
        t = clamp(t, 0, 1);
        const target = t * 255;
        const l0 = lum[px];
        const k = l0 > 0.5 ? target / l0 : 0;
        if (k === 0) {
          d[i] = target; d[i + 1] = target; d[i + 2] = target;
        } else {
          d[i] = clamp255(d[i] * k);
          d[i + 1] = clamp255(d[i + 1] * k);
          d[i + 2] = clamp255(d[i + 2] * k);
        }
      }
    }

    // Shared colour finish.
    const vib = clamp(p.vibrance, -100, 100) / 100;
    const sat = clamp(p.saturation, 0, 300) / 100;
    if (!vib && sat === 1) return;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      let f = sat;
      if (vib) {
        const chroma = mx === 0 ? 0 : (mx - mn) / mx;
        f *= 1 + vib * (1 - chroma) * 1.4;
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
/* Auto Tone / Contrast / Color                                        */
/* ================================================================== */

function stretchLUT(lo, hi, gamma = 1) {
  const span = Math.max(1, hi - lo);
  return buildLUT((i) => {
    let t = clamp((i - lo) / span, 0, 1);
    if (gamma !== 1) t = Math.pow(t, gamma);
    return Math.round(t * 255);
  });
}

registerAdjustment({
  id: 'auto-tone',
  name: 'Auto Tone',
  group: 'auto',
  layerable: false,
  params: [],
  apply(imageData) {
    const hist = computeHistogram(imageData);
    if (!hist.count) return;
    const r = clipPoints(hist.r, 0.1);
    const g = clipPoints(hist.g, 0.1);
    const b = clipPoints(hist.b, 0.1);
    applyLUT(imageData, stretchLUT(r.lo, r.hi), stretchLUT(g.lo, g.hi), stretchLUT(b.lo, b.hi));
  },
});

registerAdjustment({
  id: 'auto-contrast',
  name: 'Auto Contrast',
  group: 'auto',
  layerable: false,
  params: [],
  apply(imageData) {
    const hist = computeHistogram(imageData);
    if (!hist.count) return;
    // One stretch for all three channels, so the colour cast is preserved.
    const { lo, hi } = clipPoints(hist.l, 0.05);
    const lut = stretchLUT(lo, hi);
    applyLUT(imageData, lut, lut, lut);
  },
});

registerAdjustment({
  id: 'auto-color',
  name: 'Auto Color',
  group: 'auto',
  layerable: false,
  params: [],
  apply(imageData) {
    const hist = computeHistogram(imageData);
    if (!hist.count) return;
    const ends = [clipPoints(hist.r, 0.1), clipPoints(hist.g, 0.1), clipPoints(hist.b, 0.1)];
    const bins = [hist.r, hist.g, hist.b];

    // Mean of each channel *after* the endpoint stretch, so the midtone
    // neutralisation below is computed against the corrected image.
    const means = [];
    for (let c = 0; c < 3; c++) {
      const { lo, hi } = ends[c];
      const span = Math.max(1, hi - lo);
      let sum = 0;
      for (let i = 0; i < 256; i++) {
        if (!bins[c][i]) continue;
        sum += clamp((i - lo) / span, 0, 1) * bins[c][i];
      }
      means.push(sum / hist.count);
    }
    const target = clamp((means[0] + means[1] + means[2]) / 3, 0.02, 0.98);
    const luts = [];
    for (let c = 0; c < 3; c++) {
      const m = clamp(means[c], 0.02, 0.98);
      const gamma = Math.log(target) / Math.log(m);
      luts.push(stretchLUT(ends[c].lo, ends[c].hi, clamp(gamma, 0.2, 5)));
    }
    applyLUT(imageData, luts[0], luts[1], luts[2]);
  },
});

export { blurGray, lumaPlane, equalizeLUT };
