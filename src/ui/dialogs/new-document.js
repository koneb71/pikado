import './dialogs.css';
import { app } from '../../core/app.js';
import { el } from '../../core/util.js';
import { Dialog, confirmDialog } from '../dialog.js';
import { toHex, toCss, parseColor } from '../../core/color.js';
import { createGroupLayer } from '../../core/layer.js';
import { getPref } from './preferences.js';

/**
 * File > New. A preset browser plus the full set of document parameters.
 *
 * The unit helpers exported here are shared by the Image Size and Canvas Size
 * dialogs so all three agree on how physical units map to pixels.
 */

/* ------------------------------------------------------------------ */
/* Units                                                               */
/* ------------------------------------------------------------------ */

export const UNIT_OPTIONS = [
  { value: 'px', label: 'Pixels' },
  { value: 'in', label: 'Inches' },
  { value: 'cm', label: 'Centimeters' },
  { value: 'mm', label: 'Millimeters' },
  { value: 'pt', label: 'Points' },
  { value: 'pica', label: 'Picas' },
];

/** Pixels per one unit at the given resolution (pixels per inch). */
function unitScale(unit, ppi) {
  switch (unit) {
    case 'in': return ppi;
    case 'cm': return ppi / 2.54;
    case 'mm': return ppi / 25.4;
    case 'pt': return ppi / 72;
    case 'pica': return ppi / 6;
    default: return 1;
  }
}

/** Convert a value expressed in `unit` to pixels. */
export function toPixels(value, unit, ppi) {
  return value * unitScale(unit, ppi);
}

/** Convert pixels to `unit`. */
export function fromPixels(px, unit, ppi) {
  return px / unitScale(unit, ppi);
}

/** Round for display: pixels are whole, physical units keep 3 decimals. */
export function roundForUnit(value, unit) {
  if (unit === 'px') return Math.max(1, Math.round(value));
  return Math.round(value * 1000) / 1000;
}

/** Resolution display helpers ('ppi' = pixels/inch, 'ppcm' = pixels/cm). */
export const RES_UNITS = [
  { value: 'ppi', label: 'Pixels/Inch' },
  { value: 'ppcm', label: 'Pixels/Centimeter' },
];

export function resToUnit(ppi, resUnit) {
  return resUnit === 'ppcm' ? Math.round((ppi / 2.54) * 100) / 100 : Math.round(ppi * 100) / 100;
}

export function resFromUnit(value, resUnit) {
  return resUnit === 'ppcm' ? value * 2.54 : value;
}

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

const PRESETS = {
  Photo: [
    { name: 'Landscape 4 × 6', w: 1800, h: 1200, res: 300 },
    { name: 'Portrait 4 × 6', w: 1200, h: 1800, res: 300 },
    { name: 'Landscape 5 × 7', w: 2100, h: 1500, res: 300 },
    { name: 'Portrait 8 × 10', w: 2400, h: 3000, res: 300 },
    { name: 'Landscape 11 × 14', w: 4200, h: 3300, res: 300 },
    { name: 'High Resolution 16 × 20', w: 6000, h: 4800, res: 300 },
  ],
  Print: [
    { name: 'US Letter', w: 2550, h: 3300, res: 300 },
    { name: 'US Legal', w: 2550, h: 4200, res: 300 },
    { name: 'Tabloid', w: 3300, h: 5100, res: 300 },
    { name: 'A3', w: 3508, h: 4961, res: 300 },
    { name: 'A4', w: 2480, h: 3508, res: 300 },
    { name: 'A5', w: 1748, h: 2480, res: 300 },
    { name: 'Business Card', w: 1050, h: 600, res: 300 },
  ],
  'Art & Illustration': [
    { name: 'Square 2000 px', w: 2000, h: 2000, res: 300 },
    { name: 'Poster 18 × 24', w: 5400, h: 7200, res: 300 },
    { name: 'Comic Book Page', w: 1988, h: 3056, res: 300 },
    { name: 'Sketchbook', w: 2480, h: 3508, res: 300 },
    { name: 'Album Cover', w: 3000, h: 3000, res: 300 },
    { name: 'Digital Painting', w: 4000, h: 2500, res: 200 },
  ],
  Web: [
    { name: 'Web Large 1920 × 1080', w: 1920, h: 1080, res: 72 },
    { name: 'Web Medium 1440 × 900', w: 1440, h: 900, res: 72 },
    { name: 'Web Small 1366 × 768', w: 1366, h: 768, res: 72 },
    { name: 'Web Minimum 1024 × 768', w: 1024, h: 768, res: 72 },
    { name: 'Social Post 1080 × 1080', w: 1080, h: 1080, res: 72 },
    { name: 'Social Story 1080 × 1920', w: 1080, h: 1920, res: 72 },
  ],
  Mobile: [
    { name: 'iPhone 14 Pro', w: 1179, h: 2556, res: 72 },
    { name: 'iPhone 13 / 12', w: 1170, h: 2532, res: 72 },
    { name: 'iPhone SE', w: 750, h: 1334, res: 72 },
    { name: 'Android 1080p', w: 1080, h: 1920, res: 72 },
    { name: 'iPad Pro 11"', w: 1668, h: 2388, res: 72 },
    { name: 'iPad 10.2"', w: 1620, h: 2160, res: 72 },
  ],
  'Film & Video': [
    { name: 'HDTV 1080p', w: 1920, h: 1080, res: 72 },
    { name: 'HDTV 720p', w: 1280, h: 720, res: 72 },
    { name: '4K UHD', w: 3840, h: 2160, res: 72 },
    { name: 'DCI 4K', w: 4096, h: 2160, res: 72 },
    { name: 'Cinema 2K', w: 2048, h: 1080, res: 72 },
    { name: 'Ultra Panavision', w: 3996, h: 1692, res: 72 },
  ],
};

const BACKGROUNDS = [
  { value: 'white', label: 'White' },
  { value: 'black', label: 'Black' },
  { value: 'background', label: 'Background Color' },
  { value: 'transparent', label: 'Transparent' },
  { value: 'custom', label: 'Custom...' },
];

const COLOR_MODES = [
  { value: 'rgb', label: 'RGB Color' },
  { value: 'grayscale', label: 'Grayscale' },
  { value: 'bitmap', label: 'Bitmap' },
];

let untitledCount = 0;

/* ------------------------------------------------------------------ */

/**
 * Show the New Document dialog and create the document when confirmed.
 * @returns {Promise<import('../../core/document.js').PikaDocument|null>}
 */
export async function showNewDocumentDialog() {
  const state = {
    name: `Untitled-${++untitledCount}`,
    px: { w: 1920, h: 1080 },
    res: 72,
    unit: app.units && app.units !== 'percent' ? app.units : 'px',
    resUnit: 'ppi',
    artboards: false,
    mode: 'rgb',
    background: 'white',
    customColor: '#ffffff',
    category: 'Web',
    preset: 'Web Large 1920 × 1080',
  };

  const dlg = new Dialog({ title: 'New Document', width: 700, className: 'pkd-newdoc' });

  /* --- preset column --------------------------------------------------- */
  const cats = el('div.pkd-cats');
  const list = el('div.pkd-preset-list');

  const renderPresets = () => {
    list.replaceChildren(
      ...PRESETS[state.category].map((p) =>
        el('button.pkd-preset' + (state.preset === p.name ? '.active' : ''), {
          type: 'button',
          onclick: () => {
            state.preset = p.name;
            state.px = { w: p.w, h: p.h };
            state.res = p.res;
            syncAll();
          },
        },
        el('span', { text: p.name }),
        el('small', { text: `${p.w} × ${p.h} px · ${p.res} ppi` })
        )
      )
    );
  };

  const renderCats = () => {
    cats.replaceChildren(
      ...Object.keys(PRESETS).map((c) =>
        el('button.pkd-cat' + (state.category === c ? '.active' : ''), {
          type: 'button', text: c,
          onclick: () => {
            state.category = c;
            renderCats();
            renderPresets();
          },
        })
      )
    );
  };

  /* --- form column ----------------------------------------------------- */
  const nameInput = el('input.pk-input', { type: 'text', value: state.name });
  nameInput.addEventListener('input', () => { state.name = nameInput.value; });

  const widthInput = el('input.pk-input', { type: 'number', min: 1, step: 1 });
  const heightInput = el('input.pk-input', { type: 'number', min: 1, step: 1 });
  const unitSelect = el('select.pk-select', {},
    ...UNIT_OPTIONS.map((u) => el('option', { value: u.value, text: u.label })));
  const resInput = el('input.pk-input', { type: 'number', min: 1, step: 1 });
  const resSelect = el('select.pk-select', {},
    ...RES_UNITS.map((u) => el('option', { value: u.value, text: u.label })));

  const orient = el('div.pkd-seg');
  const portraitBtn = el('button', { type: 'button', text: 'Portrait', onclick: () => setOrientation('portrait') });
  const landscapeBtn = el('button', { type: 'button', text: 'Landscape', onclick: () => setOrientation('landscape') });
  orient.append(portraitBtn, landscapeBtn);

  const artboardsInput = el('input', { type: 'checkbox' });
  artboardsInput.addEventListener('change', () => { state.artboards = artboardsInput.checked; });

  const modeSelect = el('select.pk-select', {},
    ...COLOR_MODES.map((m) => el('option', { value: m.value, text: m.label })));
  modeSelect.addEventListener('change', () => { state.mode = modeSelect.value; });

  const bgSelect = el('select.pk-select', {},
    ...BACKGROUNDS.map((b) => el('option', { value: b.value, text: b.label })));
  const bgSwatch = el('button.pk-color-swatch', { type: 'button' });
  const bgPicker = el('input', { type: 'color', value: '#ffffff', style: { display: 'none' } });
  bgSwatch.addEventListener('click', () => bgPicker.click());
  bgPicker.addEventListener('input', () => {
    state.customColor = bgPicker.value;
    state.background = 'custom';
    bgSelect.value = 'custom';
    syncAll();
  });
  bgSelect.addEventListener('change', () => { state.background = bgSelect.value; syncAll(); });

  const previewBox = el('div.pkd-preview', { style: { height: '132px' } });
  const previewCanvas = el('canvas', { width: 200, height: 120 });
  previewBox.appendChild(previewCanvas);
  const summary = el('div.pkd-readout');

  /* --- behaviour ------------------------------------------------------- */

  function setOrientation(kind) {
    const { w, h } = state.px;
    if (kind === 'portrait' && w > h) state.px = { w: h, h: w };
    if (kind === 'landscape' && h > w) state.px = { w: h, h: w };
    state.preset = null;
    syncAll();
  }

  function commitSize() {
    const wv = Number(widthInput.value);
    const hv = Number(heightInput.value);
    if (Number.isFinite(wv) && wv > 0) state.px.w = Math.max(1, Math.round(toPixels(wv, state.unit, state.res)));
    if (Number.isFinite(hv) && hv > 0) state.px.h = Math.max(1, Math.round(toPixels(hv, state.unit, state.res)));
    state.preset = null;
    syncPreview();
    renderPresets();
  }

  widthInput.addEventListener('input', commitSize);
  heightInput.addEventListener('input', commitSize);
  unitSelect.addEventListener('change', () => { state.unit = unitSelect.value; syncFields(); });
  resInput.addEventListener('input', () => {
    const v = Number(resInput.value);
    if (Number.isFinite(v) && v > 0) {
      state.res = resFromUnit(v, state.resUnit);
      syncPreview();
    }
  });
  resSelect.addEventListener('change', () => { state.resUnit = resSelect.value; syncFields(); });

  function backgroundCss() {
    switch (state.background) {
      case 'black': return '#000000';
      case 'background': return toHex(app.background);
      case 'transparent': return null;
      case 'custom': return state.customColor;
      default: return '#ffffff';
    }
  }

  function syncFields() {
    if (document.activeElement !== widthInput) widthInput.value = roundForUnit(fromPixels(state.px.w, state.unit, state.res), state.unit);
    if (document.activeElement !== heightInput) heightInput.value = roundForUnit(fromPixels(state.px.h, state.unit, state.res), state.unit);
    if (document.activeElement !== resInput) resInput.value = resToUnit(state.res, state.resUnit);
    unitSelect.value = state.unit;
    resSelect.value = state.resUnit;
    modeSelect.value = state.mode;
    bgSelect.value = state.background;
    artboardsInput.checked = state.artboards;
    portraitBtn.classList.toggle('active', state.px.h >= state.px.w);
    landscapeBtn.classList.toggle('active', state.px.w > state.px.h);
    const css = backgroundCss();
    bgSwatch.style.background = css || 'transparent';
    bgSwatch.style.opacity = css ? '1' : '0.35';
    bgPicker.value = state.customColor;
    syncPreview();
  }

  function syncPreview() {
    const maxW = 210, maxH = 120;
    const s = Math.min(maxW / state.px.w, maxH / state.px.h, 1);
    const pw = Math.max(4, Math.round(state.px.w * s));
    const ph = Math.max(4, Math.round(state.px.h * s));
    previewCanvas.width = pw;
    previewCanvas.height = ph;
    const c = previewCanvas.getContext('2d');
    c.clearRect(0, 0, pw, ph);
    const css = backgroundCss();
    if (css) {
      c.fillStyle = css;
      c.fillRect(0, 0, pw, ph);
    }
    c.strokeStyle = 'rgba(0,0,0,.5)';
    c.strokeRect(0.5, 0.5, pw - 1, ph - 1);

    const mb = (state.px.w * state.px.h * 4) / 1048576;
    const inW = state.px.w / state.res;
    const inH = state.px.h / state.res;
    summary.replaceChildren(
      el('div', {}, el('b', { text: `${state.px.w} × ${state.px.h} px` })),
      el('div', { text: `${inW.toFixed(2)} × ${inH.toFixed(2)} in at ${Math.round(state.res)} ppi` }),
      el('div', { text: `${(inW * 2.54).toFixed(2)} × ${(inH * 2.54).toFixed(2)} cm` }),
      el('div', { text: `Flat memory ≈ ${mb.toFixed(1)} MB` })
    );
  }

  function syncAll() {
    renderCats();
    renderPresets();
    syncFields();
  }

  const field = (label, ...nodes) => el('div.pk-field', {}, el('label', { text: label }), ...nodes);

  dlg.setBody(
    el('div.pkd-cols', {},
      el('div.pkd-presets', {}, el('div.pkd-section', { text: 'Presets' }), cats, list),
      el('div.pkd-col.grow', {},
        field('Name', nameInput),
        el('div.pkd-row', {},
          field('Width', widthInput),
          field('Height', heightInput),
          el('div.pk-field', {}, el('label', { text: 'Units' }), unitSelect)
        ),
        el('div.pkd-row', {},
          field('Resolution', resInput),
          el('div.pk-field', {}, el('label', { text: ' ' }), resSelect)
        ),
        el('div.pkd-row', {},
          el('div.pk-field', {}, el('label', { text: 'Orientation' }), orient),
          el('div.pk-field', {}, el('label', { text: 'Artboards' }),
            el('label.pk-check', {}, artboardsInput, el('span', { text: 'Wrap content in an artboard' })))
        ),
        el('div.pkd-row', {},
          field('Color Mode', modeSelect),
          field('Background Contents', bgSelect),
          el('div.pk-field.fixed', {}, el('label', { text: 'Color' }), bgSwatch, bgPicker)
        ),
        previewBox,
        summary
      )
    )
  );

  dlg.setButtons([
    { label: 'Cancel', value: null, subtle: true },
    { label: 'Create', primary: true, onClick: (d) => { d.close({ ...state, px: { ...state.px } }); return false; } },
  ]);

  syncAll();
  const result = await dlg.open();
  if (!result) return null;

  const limit = getPref('maxDocPixels', 80) * 1e6;
  if (result.px.w * result.px.h > limit) {
    const ok = await confirmDialog(
      `${result.px.w} × ${result.px.h} px is ${(result.px.w * result.px.h / 1e6).toFixed(1)} megapixels, above the ${getPref('maxDocPixels', 80)} MP limit set in Preferences. Create it anyway?`,
      'Large document', 'Create'
    );
    if (!ok) return null;
  }

  const fill = result.background === 'transparent' ? 'transparent' : (
    result.background === 'black' ? '#000000'
      : result.background === 'background' ? toCss(app.background)
        : result.background === 'custom' ? toCss(parseColor(result.customColor))
          : '#ffffff');

  const doc = app.newDocument({
    width: result.px.w,
    height: result.px.h,
    name: result.name || 'Untitled',
    fill,
    resolution: result.res,
  });
  doc.colorMode = result.mode;

  if (result.artboards) {
    const group = createGroupLayer('Artboard 1');
    const existing = doc.layers.slice();
    doc.layers = [group];
    group.children = existing;
    for (const l of existing) {
      l.parent = group;
      l.isBackground = false;
    }
    doc.activeLayerId = existing.length ? existing[0].id : group.id;
    doc.selectedLayerIds = [doc.activeLayerId];
    doc.artboards = [{ id: group.id, name: 'Artboard 1', x: 0, y: 0, width: doc.width, height: doc.height }];
    doc.history.clear('New');
    doc.emit('structure');
  }

  return doc;
}
