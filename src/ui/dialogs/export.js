import './dialogs.css';
import { app } from '../../core/app.js';
import { el, createCanvas, formatBytes, download, debounce } from '../../core/util.js';
import { Dialog } from '../dialog.js';
import { compositeDocument, flattenLayers } from '../../render/compositor.js';
import { encodeGIF } from '../../io/gif.js';
import { encodeHEIC, heicEncodeSupport } from '../../io/heif-write.js';
import { writeICNS, icnsSizesFor } from '../../io/icns.js';
import { tr, trn } from '../../core/i18n.js';

/**
 * File > Export As.
 *
 * Encoding is delegated to `src/io/save.js` (`exportDocument` / `exportLayers`)
 * when that module provides it; the local encoders below are the fallback so
 * the dialog always produces a file.
 */

const FORMATS = [
  { value: 'png', label: 'PNG', mime: 'image/png', lossy: false, alpha: true, ext: 'png' },
  { value: 'jpg', label: 'JPG', mime: 'image/jpeg', lossy: true, alpha: false, ext: 'jpg' },
  { value: 'webp', label: 'WebP', mime: 'image/webp', lossy: true, alpha: true, ext: 'webp' },
  { value: 'gif', label: 'GIF', mime: 'image/gif', lossy: false, alpha: true, ext: 'gif' },
  { value: 'svg', label: 'SVG', mime: 'image/svg+xml', lossy: false, alpha: true, ext: 'svg' },
  { value: 'heic', label: 'HEIC', mime: 'image/heic', lossy: true, alpha: true, ext: 'heic' },
  // An icon is one file holding every size macOS asks for, so it has no export
  // scale and no per-layer mode.
  { value: 'icns', label: 'ICNS (macOS icon)', mime: 'image/icns', lossy: false, alpha: true, ext: 'icns', icon: true },
];

const SCALES = [0.5, 1, 2, 3];

function formatOf(id) {
  return FORMATS.find((f) => f.value === id) || FORMATS[0];
}

function baseName(doc) {
  return (doc.name || tr('Untitled')).replace(/\.[a-z0-9]+$/i, '');
}

/* ------------------------------------------------------------------ */
/* Local encoders (fallback)                                           */
/* ------------------------------------------------------------------ */

/** Render a source canvas at `scale`, optionally flattening onto white. */
function renderAt(src, scale, transparent) {
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const out = createCanvas(w, h);
  const c = out.getContext('2d');
  if (!transparent) {
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, w, h);
  }
  c.imageSmoothingQuality = 'high';
  c.drawImage(src, 0, 0, w, h);
  return out;
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), mime, quality);
  });
}

/** Wrap the raster in an SVG document so it scales in vector pipelines. */
function svgBlob(canvas) {
  const data = canvas.toDataURL('image/png');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}"><image width="${canvas.width}" height="${canvas.height}" xlink:href="${data}"/></svg>`;
  return new Blob([svg], { type: 'image/svg+xml' });
}

/** Encode a canvas with the local encoders. */
async function encodeLocally(canvas, fmt, quality, transparent) {
  if (fmt.value === 'svg') return svgBlob(canvas);
  if (fmt.value === 'gif') return encodeGIF(canvas, transparent);
  if (fmt.value === 'heic') return encodeHEIC(canvas, { quality: quality / 100, transparent });
  if (fmt.value === 'icns') return writeICNS(canvas);
  const blob = await canvasToBlob(canvas, fmt.mime, fmt.lossy ? quality / 100 : undefined);
  return blob || (await canvasToBlob(canvas, 'image/png'));
}

/* ------------------------------------------------------------------ */
/* io/save.js bridge                                                   */
/* ------------------------------------------------------------------ */

async function saveModule() {
  try {
    return await import('../../io/save.js');
  } catch {
    return null;
  }
}

async function runExport(doc, opts) {
  const mod = await saveModule();
  if (mod && typeof mod.exportDocument === 'function') {
    try {
      // io/save.js takes quality as 0..1; the dialog works in percent. It
      // reports its own failures and returns null, which is not "finished".
      return !!(await mod.exportDocument(doc, { ...opts, quality: opts.quality / 100 }));
    } catch (err) {
      console.error('[export]', err);
    }
  }
  const fmt = formatOf(opts.format);
  const canvas = renderAt(compositeDocument(doc), opts.scale, opts.transparent && fmt.alpha);
  const blob = await encodeLocally(canvas, fmt, opts.quality, opts.transparent && fmt.alpha);
  if (!blob) return false;
  download(blob, `${opts.filename || baseName(doc)}.${fmt.ext}`);
  return true;
}

async function runExportLayers(doc, opts) {
  const mod = await saveModule();
  if (mod && typeof mod.exportLayers === 'function') {
    try {
      return !!(await mod.exportLayers(doc, { ...opts, quality: opts.quality / 100 }));
    } catch (err) {
      console.error('[export layers]', err);
    }
  }
  const fmt = formatOf(opts.format);
  const layers = doc.flatLayers().filter((l) => l.visible && l.type !== 'adjustment');
  let n = 0;
  for (const layer of layers) {
    const flat = flattenLayers(doc, [layer]);
    const canvas = renderAt(flat, opts.scale, opts.transparent && fmt.alpha);
    const blob = await encodeLocally(canvas, fmt, opts.quality, opts.transparent && fmt.alpha);
    if (!blob) continue;
    const safe = layer.name.replace(/[\\/:*?"<>|]+/g, '_');
    download(blob, `${baseName(doc)}-${String(++n).padStart(2, '0')}-${safe}.${fmt.ext}`);
    await new Promise((r) => setTimeout(r, 120));
  }
  return n > 0;
}

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

/** File > Export As… */
export async function showExportDialog(doc = app.activeDoc) {
  if (!doc) return null;

  const state = {
    format: 'png',
    quality: 82,
    scale: 1,
    transparent: true,
    allLayers: false,
    filename: baseName(doc),
  };

  const dlg = new Dialog({ title: tr('Export As'), width: 620, className: 'pkd-export' });

  const source = compositeDocument(doc);

  const formatSelect = el('select.pk-select', {}, ...FORMATS.map((f) => el('option', { value: f.value, text: tr(f.label) })));
  const heicOption = formatSelect.querySelector('option[value="heic"]');
  const heicNote = el('div.pkd-note', { style: { display: 'none' } });
  // Disabled, not hidden: someone looking for HEIC should find out why it is
  // greyed out rather than conclude Pikado cannot write it anywhere.
  heicEncodeSupport().then(({ ok, reason }) => {
    heicOption.disabled = !ok;
    if (!ok) {
      heicOption.textContent = tr('HEIC (not available in this browser)');
      heicNote.textContent = reason;
      heicNote.style.display = '';
    }
  });
  const qualityRange = el('input.pk-range', { type: 'range', min: 1, max: 100, step: 1, value: state.quality });
  const qualityNum = el('input.pk-num', { type: 'number', min: 1, max: 100, step: 1, value: state.quality });
  const qualityRow = el('div.pk-field', {}, el('label', { text: tr('Quality') }), el('div.pk-slider-row', {}, qualityRange, qualityNum));
  const scaleBtns = el('div.pkd-size-btns');
  const customScale = el('input.pk-input', { type: 'number', min: 0.05, max: 8, step: 0.05, value: 1, style: { width: '74px' } });
  const transparentInput = el('input', { type: 'checkbox', checked: true });
  const transparentRow = el('label.pk-check', {}, transparentInput, el('span', { text: tr('Transparency') }));
  const allLayersInput = el('input', { type: 'checkbox' });
  const nameInput = el('input.pk-input', { type: 'text', value: state.filename });

  const previewBox = el('div.pkd-preview', { style: { height: '230px' } });
  const previewCanvas = el('canvas');
  previewBox.appendChild(previewCanvas);
  const info = el('div.pkd-readout');

  formatSelect.addEventListener('change', () => { state.format = formatSelect.value; sync(); });
  qualityRange.addEventListener('input', () => { state.quality = Number(qualityRange.value); qualityNum.value = qualityRange.value; sync(); });
  qualityNum.addEventListener('input', () => {
    const v = Math.min(100, Math.max(1, Number(qualityNum.value) || 1));
    state.quality = v; qualityRange.value = v; sync();
  });
  customScale.addEventListener('input', () => {
    const v = Number(customScale.value);
    if (Number.isFinite(v) && v > 0) { state.scale = v; sync(true); }
  });
  transparentInput.addEventListener('change', () => { state.transparent = transparentInput.checked; sync(); });
  allLayersInput.addEventListener('change', () => { state.allLayers = allLayersInput.checked; sync(); });
  nameInput.addEventListener('input', () => { state.filename = nameInput.value; });

  function buildScaleButtons() {
    scaleBtns.replaceChildren(
      ...SCALES.map((s) =>
        el('button' + (Math.abs(state.scale - s) < 1e-6 ? '.active' : ''), {
          type: 'button', text: `${s}×`,
          onclick: () => { state.scale = s; sync(); },
        })
      )
    );
  }

  const estimate = debounce(async () => {
    const fmt = formatOf(state.format);
    if (fmt.icon) {
      const sizes = [...new Set(icnsSizesFor(doc.width, doc.height).map(([, s]) => s))];
      let blob = null;
      try { blob = await writeICNS(source); } catch { blob = null; }
      info.replaceChildren(
        el('div', {}, el('b', { text: `${sizes.join(', ')} px` }), ` · ${tr(fmt.label)}`),
        el('div', { text: blob ? tr('Size ≈ {size}', { size: formatBytes(blob.size) }) : tr('Estimated size unavailable') }),
        el('div', { text: Math.max(doc.width, doc.height) < 1024 ? tr('Sizes above the document are left out rather than upscaled — 1024 px is the largest macOS uses.') : tr('Single file: {file}', { file: `${state.filename || baseName(doc)}.${fmt.ext}` }) })
      );
      return;
    }
    const w = Math.round(doc.width * state.scale);
    const h = Math.round(doc.height * state.scale);
    let probeScale = state.scale;
    let ratio = 1;
    if (w * h > 4e6) {
      probeScale = state.scale * Math.sqrt(4e6 / (w * h));
      ratio = (w * h) / (Math.round(doc.width * probeScale) * Math.round(doc.height * probeScale));
    }
    let size = 0;
    try {
      const probe = renderAt(source, probeScale, state.transparent && fmt.alpha);
      const blob = await encodeLocally(probe, fmt, state.quality, state.transparent && fmt.alpha);
      size = blob ? blob.size * ratio : 0;
    } catch {
      size = 0;
    }
    // A GIF from a document with a timeline is written as an animation, and the
    // size estimate above is for a single frame — say so rather than let the
    // number mislead.
    const frameCount = Array.isArray(doc.frames) ? doc.frames.length : 0;
    const animated = fmt.value === 'gif' && frameCount > 1 && !state.allLayers;
    const bytes = formatBytes(Math.round(size));
    const estimated = !size ? tr('Estimated size unavailable')
      : ratio > 1 && animated ? tr('Estimated size ≈ {size} (extrapolated) per frame', { size: bytes })
        : ratio > 1 ? tr('Estimated size ≈ {size} (extrapolated)', { size: bytes })
          : animated ? tr('Estimated size ≈ {size} per frame', { size: bytes })
            : tr('Estimated size ≈ {size}', { size: bytes });
    // replaceChildren() is the DOM's own and writes a null child out as the
    // text "null" (el() skips it), so the frame line is filtered in, not passed
    // as null — which showed "null" under every export but an animated GIF.
    info.replaceChildren(...[
      el('div', {}, el('b', { text: `${w} × ${h} px` }), ` · ${tr(fmt.label)}`),
      el('div', { text: estimated }),
      el('div', { text: state.allLayers ? trn('Exports {count} layer as separate files', 'Exports {count} layers as separate files', doc.flatLayers().filter((l) => l.visible && l.type !== 'adjustment').length) : tr('Single file: {file}', { file: `${state.filename || baseName(doc)}.${fmt.ext}` }) }),
      animated
        ? el('div', {
          text: doc.loopCount
            ? trn('Animated: {count} frame, {plays}', 'Animated: {count} frames, {plays}', frameCount, { plays: trn('{count} play', '{count} plays', doc.loopCount) })
            : trn('Animated: {count} frame, looping forever', 'Animated: {count} frames, looping forever', frameCount),
        })
        : null,
    ].filter(Boolean));
  }, 220);

  function drawPreview() {
    const maxW = 300, maxH = 220;
    const s = Math.min(maxW / doc.width, maxH / doc.height, 1);
    const pw = Math.max(4, Math.round(doc.width * s));
    const ph = Math.max(4, Math.round(doc.height * s));
    previewCanvas.width = pw;
    previewCanvas.height = ph;
    const c = previewCanvas.getContext('2d');
    c.clearRect(0, 0, pw, ph);
    const fmt = formatOf(state.format);
    if (!(state.transparent && fmt.alpha)) {
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, pw, ph);
    }
    c.imageSmoothingQuality = 'high';
    c.drawImage(source, 0, 0, pw, ph);
  }

  function sync(skipButtons) {
    const fmt = formatOf(state.format);
    formatSelect.value = state.format;
    qualityRow.style.display = fmt.lossy ? '' : 'none';
    transparentRow.style.display = fmt.alpha ? '' : 'none';
    sizeRow.style.display = fmt.icon ? 'none' : '';
    allLayersRow.style.display = fmt.icon ? 'none' : '';
    if (fmt.icon) state.allLayers = false;
    transparentInput.checked = state.transparent;
    allLayersInput.checked = state.allLayers;
    if (!skipButtons) {
      buildScaleButtons();
      if (document.activeElement !== customScale) customScale.value = state.scale;
    }
    drawPreview();
    estimate();
  }

  const field = (label, ...nodes) => el('div.pk-field', {}, el('label', { text: label }), ...nodes);
  const sizeRow = field(tr('Size'), el('div.pkd-row', {}, scaleBtns, customScale, el('span.pk-unit', { text: '×' })));
  const allLayersRow = el('label.pk-check', {}, allLayersInput, el('span', { text: tr('Export all layers as separate files') }));

  dlg.setBody(
    el('div.pkd-cols', {},
      el('div.pkd-col', { style: { flex: '0 0 310px' } }, previewBox, info),
      el('div.pkd-col.grow', {},
        field(tr('File Name'), nameInput),
        field(tr('Format'), formatSelect),
        qualityRow,
        sizeRow,
        transparentRow,
        allLayersRow,
        el('div.pkd-note', { text: tr('GIF is written with a 256-colour median-cut palette. SVG embeds the rendered raster.') }),
        heicNote
      )
    )
  );

  dlg.setButtons([
    { label: tr('Cancel'), value: null, subtle: true },
    { label: tr('Export'), primary: true, onClick: (d) => { d.close({ ...state }); return false; } },
  ]);

  sync();
  const result = await dlg.open();
  if (!result) return null;

  await app.busy(tr('Exporting'), async () => {
    const opts = {
      format: result.format,
      quality: result.quality,
      scale: result.scale,
      transparent: result.transparent,
      filename: result.filename || baseName(doc),
    };
    const ok = result.allLayers ? await runExportLayers(doc, opts) : await runExport(doc, opts);
    app.toast(ok ? tr('Export finished.') : tr('Nothing was exported.'), ok ? 'ok' : 'warn');
  });
  return result;
}

/** File > Quick Export as PNG — no dialog, 1× PNG of the composite. */
export async function quickExportPng(doc = app.activeDoc) {
  if (!doc) return;
  await app.busy(tr('Quick Export'), async () => {
    await runExport(doc, { format: 'png', quality: 100, scale: 1, transparent: true, filename: baseName(doc) });
  });
}
