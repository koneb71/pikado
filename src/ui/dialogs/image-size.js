import './dialogs.css';
import { app } from '../../core/app.js';
import { el, formatBytes, clamp255 } from '../../core/util.js';
import { Dialog, confirmDialog } from '../dialog.js';
import { getComposite } from '../../render/compositor.js';
import { UNIT_OPTIONS, RES_UNITS, toPixels, fromPixels, roundForUnit, resToUnit, resFromUnit } from './new-document.js';
import { getPref } from './preferences.js';

/**
 * Image > Image Size. Resamples every layer, or re-labels the document's
 * resolution without touching a single pixel when Resample is off.
 */

const RESAMPLE_METHODS = [
  { value: 'automatic', label: 'Automatic' },
  { value: 'preserve-details', label: 'Preserve Details (enlargement)' },
  { value: 'bicubic-smoother', label: 'Bicubic Smoother (enlargement)' },
  { value: 'bicubic-sharper', label: 'Bicubic Sharper (reduction)' },
  { value: 'bicubic', label: 'Bicubic (smooth gradients)' },
  { value: 'nearest', label: 'Nearest Neighbor (hard edges)' },
  { value: 'bilinear', label: 'Bilinear' },
];

/** How each method maps onto canvas smoothing + an optional sharpening pass. */
function methodSettings(method) {
  switch (method) {
    case 'nearest': return { smoothing: 'nearest', sharpen: 0 };
    case 'bilinear': return { smoothing: 'low', sharpen: 0 };
    case 'bicubic-smoother': return { smoothing: 'medium', sharpen: 0 };
    case 'bicubic-sharper': return { smoothing: 'high', sharpen: 0.35 };
    case 'preserve-details': return { smoothing: 'high', sharpen: 0.6 };
    default: return { smoothing: 'high', sharpen: 0 };
  }
}

/** Unsharp mask against a 3×3 box blur; alpha is left alone. */
function sharpenCanvas(canvas, amount) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const src = new Uint8ClampedArray(d);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (src[i + 3] === 0) continue;
      for (let k = 0; k < 3; k++) {
        let sum = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            sum += src[(yy * w + xx) * 4 + k];
            n++;
          }
        }
        const blur = sum / n;
        d[i + k] = clamp255(src[i + k] + (src[i + k] - blur) * amount);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

/* ------------------------------------------------------------------ */

/** Image > Image Size… */
export async function showImageSizeDialog(doc = app.activeDoc) {
  if (!doc) return null;

  const origW = doc.width, origH = doc.height, origRes = doc.resolution || 72;
  const ratio = origH / origW;

  const state = {
    w: origW,
    h: origH,
    res: origRes,
    unit: 'px',
    resUnit: 'ppi',
    constrain: true,
    resample: true,
    method: 'automatic',
  };

  const dlg = new Dialog({ title: 'Image Size', width: 520, className: 'pkd-imagesize' });

  const units = [...UNIT_OPTIONS, { value: 'percent', label: 'Percent' }];
  const widthInput = el('input.pk-input', { type: 'number', min: 0.001, step: 1 });
  const heightInput = el('input.pk-input', { type: 'number', min: 0.001, step: 1 });
  const unitSelect = el('select.pk-select', {}, ...units.map((u) => el('option', { value: u.value, text: u.label })));
  const resInput = el('input.pk-input', { type: 'number', min: 1, step: 1 });
  const resSelect = el('select.pk-select', {}, ...RES_UNITS.map((u) => el('option', { value: u.value, text: u.label })));
  const chain = el('button.pkd-chain.on', { type: 'button', title: 'Constrain proportions' });
  const resampleInput = el('input', { type: 'checkbox', checked: true });
  const methodSelect = el('select.pk-select', {}, ...RESAMPLE_METHODS.map((m) => el('option', { value: m.value, text: m.label })));

  const previewBox = el('div.pkd-preview', { style: { height: '150px' } });
  const previewCanvas = el('canvas');
  previewBox.appendChild(previewCanvas);
  const readout = el('div.pkd-readout');

  /* --- helpers --------------------------------------------------------- */

  const displayW = () => (state.unit === 'percent' ? (state.w / origW) * 100 : fromPixels(state.w, state.unit, state.res));
  const displayH = () => (state.unit === 'percent' ? (state.h / origH) * 100 : fromPixels(state.h, state.unit, state.res));

  function readWidth() {
    const v = Number(widthInput.value);
    if (!Number.isFinite(v) || v <= 0) return;
    if (!state.resample) {
      // Pixel dimensions are frozen: the physical size drives the resolution.
      if (state.unit === 'px' || state.unit === 'percent') return;
      const inches = toPixels(v, state.unit, 1); // value expressed in inches
      state.res = Math.max(1, origW / inches);
      sync();
      return;
    }
    const px = state.unit === 'percent' ? (v / 100) * origW : toPixels(v, state.unit, state.res);
    state.w = Math.max(1, Math.round(px));
    if (state.constrain) state.h = Math.max(1, Math.round(state.w * ratio));
    sync(widthInput);
  }

  function readHeight() {
    const v = Number(heightInput.value);
    if (!Number.isFinite(v) || v <= 0) return;
    if (!state.resample) {
      if (state.unit === 'px' || state.unit === 'percent') return;
      const inches = toPixels(v, state.unit, 1);
      state.res = Math.max(1, origH / inches);
      sync();
      return;
    }
    const px = state.unit === 'percent' ? (v / 100) * origH : toPixels(v, state.unit, state.res);
    state.h = Math.max(1, Math.round(px));
    if (state.constrain) state.w = Math.max(1, Math.round(state.h / ratio));
    sync(heightInput);
  }

  function readRes() {
    const v = Number(resInput.value);
    if (!Number.isFinite(v) || v <= 0) return;
    const next = resFromUnit(v, state.resUnit);
    if (state.resample) {
      // Physical size stays put, so the pixel count follows the resolution.
      const inW = state.w / state.res, inH = state.h / state.res;
      state.res = next;
      state.w = Math.max(1, Math.round(inW * next));
      state.h = Math.max(1, Math.round(inH * next));
    } else {
      state.res = next;
    }
    sync(resInput);
  }

  widthInput.addEventListener('input', readWidth);
  heightInput.addEventListener('input', readHeight);
  resInput.addEventListener('input', readRes);
  unitSelect.addEventListener('change', () => { state.unit = unitSelect.value; sync(); });
  resSelect.addEventListener('change', () => { state.resUnit = resSelect.value; sync(); });
  chain.addEventListener('click', () => {
    state.constrain = !state.constrain;
    if (state.constrain) state.h = Math.max(1, Math.round(state.w * ratio));
    sync();
  });
  resampleInput.addEventListener('change', () => {
    state.resample = resampleInput.checked;
    if (!state.resample) { state.w = origW; state.h = origH; }
    sync();
  });
  methodSelect.addEventListener('change', () => { state.method = methodSelect.value; sync(); });

  function sync(skip) {
    chain.className = `pkd-chain ${state.constrain ? 'on' : 'off'}`;
    methodSelect.disabled = !state.resample;
    widthInput.disabled = !state.resample && (state.unit === 'px' || state.unit === 'percent');
    heightInput.disabled = widthInput.disabled;

    if (skip !== widthInput && document.activeElement !== widthInput) {
      widthInput.value = state.unit === 'percent' ? Math.round(displayW() * 100) / 100 : roundForUnit(displayW(), state.unit);
    }
    if (skip !== heightInput && document.activeElement !== heightInput) {
      heightInput.value = state.unit === 'percent' ? Math.round(displayH() * 100) / 100 : roundForUnit(displayH(), state.unit);
    }
    if (skip !== resInput && document.activeElement !== resInput) resInput.value = resToUnit(state.res, state.resUnit);
    unitSelect.value = state.unit;
    resSelect.value = state.resUnit;
    resampleInput.checked = state.resample;
    methodSelect.value = state.method;
    drawPreview();
  }

  function drawPreview() {
    const maxW = 240, maxH = 140;
    const s = Math.min(maxW / state.w, maxH / state.h, 1);
    const pw = Math.max(4, Math.round(state.w * s));
    const ph = Math.max(4, Math.round(state.h * s));
    previewCanvas.width = pw;
    previewCanvas.height = ph;
    const c = previewCanvas.getContext('2d');
    c.imageSmoothingEnabled = state.method !== 'nearest';
    c.imageSmoothingQuality = 'high';
    c.clearRect(0, 0, pw, ph);
    try {
      c.drawImage(getComposite(doc), 0, 0, pw, ph);
    } catch {
      /* Nothing composited yet. */
    }

    const before = origW * origH * 4;
    const after = state.w * state.h * 4;
    readout.replaceChildren(
      el('div', {}, el('b', { text: `${state.w} × ${state.h} px` }), ` (was ${origW} × ${origH})`),
      el('div', { text: `${(state.w / state.res).toFixed(2)} × ${(state.h / state.res).toFixed(2)} in at ${Math.round(state.res)} ppi` }),
      el('div', { text: `Image size ${formatBytes(after)} — was ${formatBytes(before)}` })
    );
  }

  const field = (label, ...nodes) => el('div.pk-field', {}, el('label', { text: label }), ...nodes);

  dlg.setBody(
    el('div.pkd-cols', {},
      el('div.pkd-col', { style: { flex: '0 0 250px' } }, previewBox, readout),
      el('div.pkd-col.grow', {},
        el('div.pkd-row', {},
          el('div.pkd-col.grow', {},
            field('Width', widthInput),
            field('Height', heightInput)
          ),
          chain,
          el('div.pk-field.fixed', {}, el('label', { text: 'Units' }), unitSelect)
        ),
        el('div.pkd-row', {},
          field('Resolution', resInput),
          el('div.pk-field', {}, el('label', { text: ' ' }), resSelect)
        ),
        el('div.pk-field.inline', {}, el('label.pk-check', {}, resampleInput, el('span', { text: 'Resample' }))),
        field('Method', methodSelect),
        el('div.pkd-note', { text: 'With Resample off the pixels are untouched — only the print size and resolution change.' })
      )
    )
  );

  dlg.setButtons([
    { label: 'Cancel', value: null, subtle: true },
    { label: 'OK', primary: true, onClick: (d) => { d.close({ ...state }); return false; } },
  ]);

  sync();
  const result = await dlg.open();
  if (!result) return null;

  const limit = getPref('maxDocPixels', 80) * 1e6;
  if (result.w * result.h > limit) {
    const ok = await confirmDialog(
      `${result.w} × ${result.h} px is ${((result.w * result.h) / 1e6).toFixed(1)} megapixels. Continue?`,
      'Large image', 'Resize'
    );
    if (!ok) return null;
  }

  const changedPixels = result.resample && (result.w !== origW || result.h !== origH);
  const changedRes = Math.abs(result.res - origRes) > 1e-6;
  if (!changedPixels && !changedRes) return null;

  await app.busy('Image Size', async () => {
    if (changedPixels) {
      const { smoothing, sharpen } = methodSettings(result.method);
      doc.resample(result.w, result.h, smoothing);
      if (sharpen > 0) {
        for (const l of doc.flatLayers()) {
          if (l.canvas) sharpenCanvas(l.canvas, sharpen);
        }
      }
    }
    doc.resolution = result.res;
    doc.commit('Image Size');
  });
  return doc;
}
