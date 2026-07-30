import { el, clamp } from '../core/util.js';
import { Dialog } from './dialog.js';
import {
  parseColor, toHex, toCss,
  rgb2hsv, hsv2rgb, rgb2cmyk, cmyk2rgb, rgb2lab, lab2rgb,
} from '../core/color.js';
import './color-picker.css';

/**
 * The full colour picker: a saturation/value field, hue and alpha strips, a
 * before/after swatch, and HSB / RGB / Lab / CMYK / hex fields that all stay in
 * sync. `onChange` fires on every interaction so callers can live-preview.
 */

const RECENT_KEY = 'pikado.recentColors';
const MAX_RECENT = 14;

function loadRecent() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((c) => typeof c === 'string').slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

let recentColors = loadRecent();

function pushRecent(hex) {
  recentColors = [hex, ...recentColors.filter((c) => c.toLowerCase() !== hex.toLowerCase())].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentColors));
  } catch {
    /* private mode / storage disabled — recents just stay in memory */
  }
}

const byte = (v) => Math.round(clamp(v, 0, 255));
const snapWebChannel = (v) => Math.round(clamp(v, 0, 255) / 51) * 51;

function snapWeb(c) {
  return { r: snapWebChannel(c.r), g: snapWebChannel(c.g), b: snapWebChannel(c.b), a: c.a };
}

/* ------------------------------------------------------------------ */
/* Canvas painting helpers                                             */
/* ------------------------------------------------------------------ */

function paintChecker(c, w, h, size = 6) {
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, w, h);
  c.fillStyle = '#bfbfbf';
  for (let y = 0; y < h; y += size) {
    for (let x = 0; x < w; x += size) {
      if (((x / size) + (y / size)) % 2 === 0) c.fillRect(x, y, size, size);
    }
  }
}

function ringMarker(c, x, y) {
  c.save();
  c.beginPath();
  c.arc(x, y, 6, 0, Math.PI * 2);
  c.lineWidth = 3;
  c.strokeStyle = 'rgba(0,0,0,.6)';
  c.stroke();
  c.lineWidth = 1.5;
  c.strokeStyle = '#ffffff';
  c.stroke();
  c.restore();
}

function stripMarker(c, y, w, h) {
  c.save();
  c.beginPath();
  c.rect(0.5, Math.round(clamp(y, 2, h - 2)) - 2.5, w - 1, 5);
  c.lineWidth = 3;
  c.strokeStyle = 'rgba(0,0,0,.65)';
  c.stroke();
  c.lineWidth = 1.5;
  c.strokeStyle = '#ffffff';
  c.stroke();
  c.restore();
}

/** Pointer drag on a canvas, reporting normalised 0..1 coordinates. */
function onDrag(canvas, handler) {
  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1),
      y: clamp((e.clientY - r.top) / Math.max(1, r.height), 0, 1),
    };
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture?.(e.pointerId);
    handler(at(e));
    const move = (ev) => handler(at(ev));
    const up = () => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    e.preventDefault();
  });
}

/* ------------------------------------------------------------------ */
/* The dialog                                                          */
/* ------------------------------------------------------------------ */

/**
 * Open the colour picker.
 * @param {{color?: any, title?: string, onChange?: (c:{r,g,b,a})=>void, showAlpha?: boolean}} opts
 * @returns {Promise<{r:number,g:number,b:number,a:number}|null>} the chosen colour, or null.
 */
export function showColorPicker({ color = '#000000', title = 'Color Picker', onChange = null, showAlpha = true } = {}) {
  const original = parseColor(color);
  let cur = { ...original };
  const startHsv = rgb2hsv(cur.r, cur.g, cur.b);
  let H = startHsv.h, S = startHsv.s, V = startHsv.v;
  let webOnly = false;

  const svField = el('canvas.pkcp-sv', { width: 256, height: 256, title: 'Saturation / Brightness' });
  const hueStrip = el('canvas.pkcp-strip', { width: 18, height: 256, title: 'Hue' });
  const alphaStrip = el('canvas.pkcp-strip', { width: 18, height: 256, title: 'Opacity' });

  const beforeCell = el('button.pkcp-half', { type: 'button', title: 'Original colour — click to restore' });
  const afterCell = el('div.pkcp-half.is-new', { title: 'New colour' });
  const compare = el('div.pkcp-compare.pk-checker', {}, afterCell, beforeCell);

  const fields = [];
  const recentRow = el('div.pkcp-recent');

  /* ---- state plumbing ------------------------------------------- */

  const emit = () => { if (onChange) onChange({ ...cur }); };

  const setRGB = (c, quiet) => {
    const next = webOnly ? snapWeb(c) : c;
    cur = { r: byte(next.r), g: byte(next.g), b: byte(next.b), a: cur.a };
    const t = rgb2hsv(cur.r, cur.g, cur.b);
    if (t.s > 0.0005 && t.v > 0.0005) H = t.h;
    S = t.s;
    V = t.v;
    render();
    if (!quiet) emit();
  };

  const setHSV = (h, s, v) => {
    H = ((h % 360) + 360) % 360;
    S = clamp(s, 0, 1);
    V = clamp(v, 0, 1);
    const c = hsv2rgb(H, S, V);
    const next = webOnly ? snapWeb(c) : c;
    cur = { r: byte(next.r), g: byte(next.g), b: byte(next.b), a: cur.a };
    render();
    emit();
  };

  const setAlpha = (a) => {
    cur.a = clamp(a, 0, 1);
    render();
    emit();
  };

  /* ---- painting -------------------------------------------------- */

  const drawSV = () => {
    const c = svField.getContext('2d');
    c.fillStyle = toCss(hsv2rgb(H, 1, 1));
    c.fillRect(0, 0, 256, 256);
    let g = c.createLinearGradient(0, 0, 256, 0);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 256, 256);
    g = c.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,1)');
    c.fillStyle = g;
    c.fillRect(0, 0, 256, 256);
    ringMarker(c, S * 256, (1 - V) * 256);
  };

  const drawHue = () => {
    const c = hueStrip.getContext('2d');
    const g = c.createLinearGradient(0, 0, 0, 256);
    for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, toCss(hsv2rgb(i * 60, 1, 1)));
    c.fillStyle = g;
    c.fillRect(0, 0, 18, 256);
    stripMarker(c, (H / 360) * 256, 18, 256);
  };

  const drawAlpha = () => {
    const c = alphaStrip.getContext('2d');
    paintChecker(c, 18, 256, 6);
    const g = c.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, `rgba(${cur.r},${cur.g},${cur.b},1)`);
    g.addColorStop(1, `rgba(${cur.r},${cur.g},${cur.b},0)`);
    c.fillStyle = g;
    c.fillRect(0, 0, 18, 256);
    stripMarker(c, (1 - cur.a) * 256, 18, 256);
  };

  const render = () => {
    drawSV();
    drawHue();
    drawAlpha();
    afterCell.style.background = toCss(cur);
    beforeCell.style.background = toCss(original);
    for (const f of fields) {
      if (document.activeElement === f.input) continue;
      f.input.value = f.get();
    }
  };

  /* ---- interaction ----------------------------------------------- */

  onDrag(svField, (p) => setHSV(H, p.x, 1 - p.y));
  onDrag(hueStrip, (p) => setHSV(p.y * 360, S, V));
  onDrag(alphaStrip, (p) => setAlpha(1 - p.y));
  beforeCell.addEventListener('click', () => setRGB({ ...original }));

  /* ---- numeric fields -------------------------------------------- */

  const num = (label, unit, min, max, get, set, step = 1) => {
    const input = el('input.pk-input.pkcp-num', { type: 'number', min, max, step, value: get() });
    input.addEventListener('input', () => {
      if (input.value === '') return;
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      set(clamp(v, min, max));
    });
    input.addEventListener('blur', () => { input.value = get(); });
    const row = el('label.pkcp-field', {}, el('span', { text: label }), input, unit ? el('em', { text: unit }) : null);
    fields.push({ input, get });
    return row;
  };

  const hsbBlock = el('div.pkcp-group', {},
    num('H', '°', 0, 360, () => Math.round(H), (v) => setHSV(v, S, V)),
    num('S', '%', 0, 100, () => Math.round(S * 100), (v) => setHSV(H, v / 100, V)),
    num('B', '%', 0, 100, () => Math.round(V * 100), (v) => setHSV(H, S, v / 100))
  );

  const rgbBlock = el('div.pkcp-group', {},
    num('R', '', 0, 255, () => Math.round(cur.r), (v) => setRGB({ ...cur, r: v })),
    num('G', '', 0, 255, () => Math.round(cur.g), (v) => setRGB({ ...cur, g: v })),
    num('B', '', 0, 255, () => Math.round(cur.b), (v) => setRGB({ ...cur, b: v }))
  );

  const labOf = () => rgb2lab(cur.r, cur.g, cur.b);
  const setLab = (l, a, b) => setRGB({ ...lab2rgb(l, a, b), a: cur.a });
  const labBlock = el('div.pkcp-group.pkcp-wide', {},
    num('L', '', 0, 100, () => Math.round(labOf().l), (v) => { const t = labOf(); setLab(v, t.a, t.b); }),
    num('a', '', -128, 127, () => Math.round(labOf().a), (v) => { const t = labOf(); setLab(t.l, v, t.b); }),
    num('b', '', -128, 127, () => Math.round(labOf().b), (v) => { const t = labOf(); setLab(t.l, t.a, v); })
  );

  const cmykOf = () => rgb2cmyk(cur.r, cur.g, cur.b);
  const setCmyk = (c, m, y, k) => setRGB({ ...cmyk2rgb(c, m, y, k), a: cur.a });
  const cmykBlock = el('div.pkcp-group.pkcp-wide', {},
    num('C', '%', 0, 100, () => Math.round(cmykOf().c * 100), (v) => { const t = cmykOf(); setCmyk(v / 100, t.m, t.y, t.k); }),
    num('M', '%', 0, 100, () => Math.round(cmykOf().m * 100), (v) => { const t = cmykOf(); setCmyk(t.c, v / 100, t.y, t.k); }),
    num('Y', '%', 0, 100, () => Math.round(cmykOf().y * 100), (v) => { const t = cmykOf(); setCmyk(t.c, t.m, v / 100, t.k); }),
    num('K', '%', 0, 100, () => Math.round(cmykOf().k * 100), (v) => { const t = cmykOf(); setCmyk(t.c, t.m, t.y, v / 100); })
  );

  const hexInput = el('input.pk-input.pkcp-hex', { type: 'text', value: toHex(cur), spellcheck: 'false' });
  hexInput.addEventListener('input', () => {
    const raw = hexInput.value.trim().replace(/^#/, '');
    if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(raw)) return;
    setRGB({ ...parseColor(`#${raw}`), a: cur.a });
  });
  hexInput.addEventListener('blur', () => { hexInput.value = toHex(cur); });
  fields.push({ input: hexInput, get: () => toHex(cur) });
  const hexRow = el('label.pkcp-field.pkcp-hexrow', {}, el('span', { text: '#' }), hexInput);

  const alphaRow = num('A', '%', 0, 100, () => Math.round(cur.a * 100), (v) => setAlpha(v / 100));
  if (!showAlpha) alphaRow.style.display = 'none';

  const webCheck = el('input', { type: 'checkbox' });
  webCheck.addEventListener('change', () => {
    webOnly = webCheck.checked;
    if (webOnly) setRGB({ ...cur });
    else render();
  });

  /* ---- recently used --------------------------------------------- */

  const buildRecent = () => {
    recentRow.replaceChildren(
      el('span.pkcp-recent-label', { text: 'Recent' }),
      ...recentColors.map((hex) =>
        el('button.pkcp-chip', {
          type: 'button', title: hex, style: { background: hex },
          onclick: () => setRGB({ ...parseColor(hex), a: cur.a }),
        })
      )
    );
    if (!recentColors.length) recentRow.appendChild(el('span.pkcp-recent-empty', { text: 'none yet' }));
  };
  buildRecent();

  /* ---- assemble --------------------------------------------------- */

  const body = el('div.pkcp', {},
    el('div.pkcp-top', {},
      svField,
      el('div.pkcp-strips', {}, hueStrip, showAlpha ? alphaStrip : null),
      el('div.pkcp-side', {},
        compare,
        hsbBlock,
        rgbBlock,
        hexRow,
        showAlpha ? alphaRow : null
      )
    ),
    el('div.pkcp-bottom', {},
      labBlock,
      cmykBlock,
      el('div.pkcp-foot', {},
        el('label.pk-check', {}, webCheck, el('span', { text: 'Only web colors' })),
        recentRow
      )
    )
  );

  const dlg = new Dialog({ title, width: 566, className: 'pk-colorpicker' });
  dlg.setBody(body);
  dlg.setButtons([
    { label: 'Cancel', value: null, subtle: true },
    { label: 'OK', primary: true, onClick: (d) => { d.close({ ...cur }); return false; } },
  ]);

  const promise = dlg.open().then((result) => {
    if (result) pushRecent(toHex(result));
    else if (onChange) onChange({ ...original });
    return result;
  });

  render();
  return promise;
}

/* ------------------------------------------------------------------ */
/* Swatch button                                                       */
/* ------------------------------------------------------------------ */

/**
 * A clickable swatch that opens the picker.
 * @param {() => any} getColor reads the current colour
 * @param {(c:{r,g,b,a}) => void} setColor writes it back
 * @param {{title?:string, className?:string, live?:boolean, size?:number}} [opts]
 * @returns {HTMLButtonElement} with an extra `sync()` method.
 */
export function colorSwatchButton(getColor, setColor, opts = {}) {
  const btn = el(`button.pk-color-btn.pk-checker${opts.className ? `.${opts.className}` : ''}`, {
    type: 'button',
    title: opts.title || 'Click to choose a colour',
    style: opts.size ? { width: `${opts.size}px`, height: `${opts.size}px` } : null,
  });
  const fill = el('span.pk-color-btn-fill');
  btn.appendChild(fill);

  const sync = () => {
    fill.style.background = toCss(parseColor(getColor()));
  };
  btn.sync = sync;
  sync();

  btn.addEventListener('click', async () => {
    const before = parseColor(getColor());
    const chosen = await showColorPicker({
      color: before,
      title: opts.title || 'Color Picker',
      onChange: (c) => {
        if (opts.live !== false) setColor(c);
        sync();
      },
    });
    setColor(chosen || before);
    sync();
  });

  return btn;
}
