import './dialogs.css';
import { app } from '../../core/app.js';
import { el, createCanvas, formatBytes } from '../../core/util.js';
import { Dialog } from '../dialog.js';
import { toCss } from '../../core/color.js';
import { UNIT_OPTIONS, toPixels, fromPixels, roundForUnit } from './new-document.js';

/**
 * Image > Canvas Size. Grows or crops the canvas without resampling, anchored
 * on a 3×3 grid, optionally painting the newly exposed area on the background.
 */

const ANCHORS = [
  ['top-left', 'top', 'top-right'],
  ['left', 'center', 'right'],
  ['bottom-left', 'bottom', 'bottom-right'],
];

/** Arrow glyphs showing which way the existing image will sit. */
const ARROWS = {
  'top-left': '↖', top: '↑', 'top-right': '↗',
  left: '←', center: '✛', right: '→',
  'bottom-left': '↙', bottom: '↓', 'bottom-right': '↘',
};

const EXTENSION_COLORS = [
  { value: 'background', label: 'Background' },
  { value: 'foreground', label: 'Foreground' },
  { value: 'white', label: 'White' },
  { value: 'black', label: 'Black' },
  { value: 'gray', label: '50% Gray' },
  { value: 'transparent', label: 'Transparent' },
  { value: 'custom', label: 'Other...' },
];

function extensionCss(kind, custom) {
  switch (kind) {
    case 'foreground': return toCss(app.foreground);
    case 'white': return '#ffffff';
    case 'black': return '#000000';
    case 'gray': return '#808080';
    case 'custom': return custom || '#ffffff';
    case 'transparent': return null;
    default: return toCss(app.background);
  }
}

/** Offset the old canvas receives inside the new one, mirroring doc.resizeCanvasTo. */
function anchorOffset(anchor, oldW, oldH, newW, newH) {
  const ax = anchor.includes('left') ? 0 : anchor.includes('right') ? 1 : 0.5;
  const ay = anchor.includes('top') ? 0 : anchor.includes('bottom') ? 1 : 0.5;
  return { dx: Math.round((newW - oldW) * ax), dy: Math.round((newH - oldH) * ay) };
}

/* ------------------------------------------------------------------ */

/** Image > Canvas Size… */
export async function showCanvasSizeDialog(doc = app.activeDoc) {
  if (!doc) return null;

  const origW = doc.width, origH = doc.height;
  const state = {
    w: origW,
    h: origH,
    unit: 'px',
    relative: false,
    anchor: 'center',
    extension: 'background',
    custom: '#ffffff',
  };

  const dlg = new Dialog({ title: 'Canvas Size', width: 460, className: 'pkd-canvassize' });

  const current = el('div.pkd-readout');
  const widthInput = el('input.pk-input', { type: 'number', step: 1 });
  const heightInput = el('input.pk-input', { type: 'number', step: 1 });
  const unitSelect = el('select.pk-select', {}, ...UNIT_OPTIONS.map((u) => el('option', { value: u.value, text: u.label })));
  const relativeInput = el('input', { type: 'checkbox' });
  const anchorGrid = el('div.pkd-anchor');
  const extSelect = el('select.pk-select', {}, ...EXTENSION_COLORS.map((c) => el('option', { value: c.value, text: c.label })));
  const extSwatch = el('button.pk-color-swatch', { type: 'button' });
  const extPicker = el('input', { type: 'color', value: '#ffffff', style: { display: 'none' } });
  const newReadout = el('div.pkd-readout');

  const res = doc.resolution || 72;

  const targetSize = () => {
    if (!state.relative) return { w: Math.max(1, Math.round(state.w)), h: Math.max(1, Math.round(state.h)) };
    return { w: Math.max(1, origW + Math.round(state.w)), h: Math.max(1, origH + Math.round(state.h)) };
  };

  function readSize() {
    const wv = Number(widthInput.value);
    const hv = Number(heightInput.value);
    if (Number.isFinite(wv)) state.w = state.unit === 'px' ? wv : toPixels(wv, state.unit, res);
    if (Number.isFinite(hv)) state.h = state.unit === 'px' ? hv : toPixels(hv, state.unit, res);
    sync(true);
  }

  widthInput.addEventListener('input', readSize);
  heightInput.addEventListener('input', readSize);
  unitSelect.addEventListener('change', () => { state.unit = unitSelect.value; sync(); });
  relativeInput.addEventListener('change', () => {
    state.relative = relativeInput.checked;
    // Switching modes keeps the same resulting size.
    if (state.relative) { state.w = state.w - origW; state.h = state.h - origH; }
    else { state.w = origW + state.w; state.h = origH + state.h; }
    sync();
  });
  extSelect.addEventListener('change', () => {
    state.extension = extSelect.value;
    if (state.extension === 'custom') extPicker.click();
    sync();
  });
  extSwatch.addEventListener('click', () => extPicker.click());
  extPicker.addEventListener('input', () => {
    state.custom = extPicker.value;
    state.extension = 'custom';
    sync();
  });

  function buildAnchorGrid() {
    const target = targetSize();
    anchorGrid.replaceChildren(
      ...ANCHORS.flat().map((a) =>
        el('button' + (state.anchor === a ? '.active' : ''), {
          type: 'button', title: a.replace('-', ' '), text: ARROWS[a],
          onclick: () => { state.anchor = a; sync(); },
        })
      )
    );
    anchorGrid.title = `New canvas ${target.w} × ${target.h}`;
  }

  function sync(skipInputs) {
    const target = targetSize();
    if (!skipInputs) {
      const wv = state.unit === 'px' ? Math.round(state.w) : roundForUnit(fromPixels(state.w, state.unit, res), state.unit);
      const hv = state.unit === 'px' ? Math.round(state.h) : roundForUnit(fromPixels(state.h, state.unit, res), state.unit);
      if (document.activeElement !== widthInput) widthInput.value = wv;
      if (document.activeElement !== heightInput) heightInput.value = hv;
    }
    unitSelect.value = state.unit;
    relativeInput.checked = state.relative;
    extSelect.value = state.extension;
    const css = extensionCss(state.extension, state.custom);
    extSwatch.style.background = css || 'transparent';
    extSwatch.style.opacity = css ? '1' : '0.35';
    extPicker.value = state.custom;
    buildAnchorGrid();

    current.replaceChildren(
      el('div', {}, 'Current size: ', el('b', { text: formatBytes(origW * origH * 4) })),
      el('div', { text: `${origW} × ${origH} px  (${(origW / res).toFixed(2)} × ${(origH / res).toFixed(2)} in)` })
    );
    const off = anchorOffset(state.anchor, origW, origH, target.w, target.h);
    newReadout.replaceChildren(
      el('div', {}, 'New size: ', el('b', { text: formatBytes(target.w * target.h * 4) })),
      el('div', { text: `${target.w} × ${target.h} px` }),
      el('div', { text: `Existing image lands at ${off.dx}, ${off.dy}` })
    );
  }

  const field = (label, ...nodes) => el('div.pk-field', {}, el('label', { text: label }), ...nodes);

  dlg.setBody(
    el('div.pkd-col', {},
      current,
      el('div.pkd-section', { text: 'New Size' }),
      el('div.pkd-row', {},
        field('Width', widthInput),
        field('Height', heightInput),
        el('div.pk-field.fixed', {}, el('label', { text: 'Units' }), unitSelect)
      ),
      el('label.pk-check', {}, relativeInput, el('span', { text: 'Relative' })),
      el('div.pkd-cols', {},
        el('div.pk-field', {}, el('label', { text: 'Anchor' }), anchorGrid),
        el('div.pkd-col.grow', {},
          field('Canvas Extension Color', el('div.pkd-row', {}, extSelect, extSwatch, extPicker)),
          newReadout
        )
      )
    )
  );

  dlg.setButtons([
    { label: 'Cancel', value: null, subtle: true },
    { label: 'OK', primary: true, onClick: (d) => { d.close({ ...state, target: targetSize() }); return false; } },
  ]);

  sync();
  const result = await dlg.open();
  if (!result) return null;

  const { w, h } = result.target;
  if (w === origW && h === origH) return null;

  await app.busy('Canvas Size', async () => {
    doc.resizeCanvasTo(w, h, result.anchor);

    const css = extensionCss(result.extension, result.custom);
    const bg = doc.layers[doc.layers.length - 1];
    if (css && bg && bg.isBackground && bg.canvas && (w > origW || h > origH)) {
      // Paint the freshly exposed area only — destination-over leaves the
      // original pixels alone because the background is fully opaque.
      const fill = createCanvas(w, h);
      const fc = fill.getContext('2d');
      fc.fillStyle = css;
      fc.fillRect(0, 0, w, h);
      const out = createCanvas(w, h);
      const oc = out.getContext('2d');
      oc.drawImage(bg.canvas, 0, 0);
      oc.globalCompositeOperation = 'destination-over';
      oc.drawImage(fill, 0, 0);
      oc.globalCompositeOperation = 'source-over';
      bg.canvas = out;
    }
    doc.commit('Canvas Size');
  });
  return doc;
}
