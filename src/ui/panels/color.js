import { registerPanel } from '../panel-host.js';
import { app } from '../../core/app.js';
import { el, clamp } from '../../core/util.js';
import {
  parseColor, toHex, toCss, rgb,
  rgb2hsv, hsv2rgb, rgb2cmyk, cmyk2rgb, rgb2lab, lab2rgb, luminance,
} from '../../core/color.js';
import { iconEl } from '../icons.js';
import { showColorPicker } from '../color-picker.js';
import './panels.css';
import './color.css';

/**
 * The Color panel: foreground/background swatches, a colour model selector with
 * live gradient sliders, a hex field and a clickable spectrum ramp.
 */

const MODES = [
  { value: 'rgb', label: 'RGB Sliders' },
  { value: 'hsb', label: 'HSB Sliders' },
  { value: 'cmyk', label: 'CMYK Sliders' },
  { value: 'lab', label: 'Lab Sliders' },
  { value: 'gray', label: 'Grayscale Slider' },
  { value: 'web', label: 'Web Color Sliders' },
];

const byte = (v) => Math.round(clamp(v, 0, 255));

/** Channel descriptors per colour model. `hue` carries the hue across greys. */
function channelsFor(mode, hue) {
  const keepAlpha = (c, next) => ({ ...next, a: c.a });
  const hsvOf = (c) => {
    const t = rgb2hsv(c.r, c.g, c.b);
    if (t.s <= 0.0005 || t.v <= 0.0005) t.h = hue.value;
    else hue.value = t.h;
    return t;
  };

  switch (mode) {
    case 'hsb':
      return [
        { label: 'H', min: 0, max: 360, step: 1, get: (c) => Math.round(hsvOf(c).h), apply: (c, v) => { hue.value = v; const t = hsvOf(c); return keepAlpha(c, hsv2rgb(v, t.s, t.v)); } },
        { label: 'S', min: 0, max: 100, step: 1, get: (c) => Math.round(hsvOf(c).s * 100), apply: (c, v) => { const t = hsvOf(c); return keepAlpha(c, hsv2rgb(t.h, v / 100, t.v)); } },
        { label: 'B', min: 0, max: 100, step: 1, get: (c) => Math.round(hsvOf(c).v * 100), apply: (c, v) => { const t = hsvOf(c); return keepAlpha(c, hsv2rgb(t.h, t.s, v / 100)); } },
      ];
    case 'cmyk':
      return ['c', 'm', 'y', 'k'].map((k) => ({
        label: k.toUpperCase(), min: 0, max: 100, step: 1,
        get: (c) => Math.round(rgb2cmyk(c.r, c.g, c.b)[k] * 100),
        apply: (c, v) => {
          const t = rgb2cmyk(c.r, c.g, c.b);
          t[k] = v / 100;
          return keepAlpha(c, cmyk2rgb(t.c, t.m, t.y, t.k));
        },
      }));
    case 'lab':
      return [
        { label: 'L', min: 0, max: 100, step: 1, key: 'l' },
        { label: 'a', min: -128, max: 127, step: 1, key: 'a' },
        { label: 'b', min: -128, max: 127, step: 1, key: 'b' },
      ].map((d) => ({
        ...d,
        get: (c) => Math.round(rgb2lab(c.r, c.g, c.b)[d.key]),
        apply: (c, v) => {
          const t = rgb2lab(c.r, c.g, c.b);
          t[d.key] = v;
          return keepAlpha(c, lab2rgb(t.l, t.a, t.b));
        },
      }));
    case 'gray':
      return [{
        label: 'K', min: 0, max: 100, step: 1,
        get: (c) => Math.round((1 - luminance(c.r, c.g, c.b) / 255) * 100),
        apply: (c, v) => {
          const g = byte(255 * (1 - v / 100));
          return keepAlpha(c, rgb(g, g, g));
        },
      }];
    case 'web':
      return ['r', 'g', 'b'].map((k) => ({
        label: k.toUpperCase(), min: 0, max: 255, step: 51,
        get: (c) => Math.round(clamp(c[k], 0, 255) / 51) * 51,
        apply: (c, v) => {
          const next = { r: Math.round(c.r / 51) * 51, g: Math.round(c.g / 51) * 51, b: Math.round(c.b / 51) * 51, a: c.a };
          next[k] = Math.round(v / 51) * 51;
          return next;
        },
      }));
    default:
      return ['r', 'g', 'b'].map((k) => ({
        label: k.toUpperCase(), min: 0, max: 255, step: 1,
        get: (c) => Math.round(c[k]),
        apply: (c, v) => ({ ...c, [k]: byte(v) }),
      }));
  }
}

/** One labelled slider with a live gradient-filled track. */
function buildSlider(onInput) {
  const name = el('span.pkc-sname');
  const thumb = el('div.pkc-thumb');
  const track = el('div.pkc-track', {}, thumb);
  const num = el('input.pk-num.pkc-num', { type: 'number' });
  const row = el('div.pkc-slider', {}, name, track, num);
  let desc = null;

  const ratioValue = (clientX) => {
    const r = track.getBoundingClientRect();
    const t = clamp((clientX - r.left) / Math.max(1, r.width), 0, 1);
    const step = desc.step || 1;
    return clamp(Math.round((desc.min + t * (desc.max - desc.min)) / step) * step, desc.min, desc.max);
  };

  track.addEventListener('pointerdown', (e) => {
    if (!desc) return;
    track.setPointerCapture?.(e.pointerId);
    onInput(desc, ratioValue(e.clientX));
    const move = (ev) => onInput(desc, ratioValue(ev.clientX));
    const up = () => {
      track.removeEventListener('pointermove', move);
      track.removeEventListener('pointerup', up);
      track.removeEventListener('pointercancel', up);
    };
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', up);
    track.addEventListener('pointercancel', up);
    e.preventDefault();
  });

  num.addEventListener('input', () => {
    if (!desc || num.value === '') return;
    const v = Number(num.value);
    if (Number.isFinite(v)) onInput(desc, clamp(v, desc.min, desc.max));
  });

  return {
    row,
    bind(d) {
      desc = d;
      name.textContent = d.label;
      num.min = d.min;
      num.max = d.max;
      num.step = d.step || 1;
    },
    sync(color) {
      if (!desc) return;
      const v = desc.get(color);
      if (document.activeElement !== num) num.value = v;
      const t = (v - desc.min) / (desc.max - desc.min || 1);
      thumb.style.left = `${clamp(t, 0, 1) * 100}%`;
      const stops = [];
      for (let i = 0; i <= 8; i++) {
        const val = desc.min + (i / 8) * (desc.max - desc.min);
        const c = desc.apply(color, val);
        stops.push(`${toCss({ ...c, a: 1 })} ${(i / 8) * 100}%`);
      }
      track.style.background = `linear-gradient(to right, ${stops.join(',')})`;
    },
  };
}

registerPanel({
  id: 'color',
  title: 'Color',
  icon: 'adjustment',
  group: 'mid',
  order: 0,
  defaultOpen: true,
  build(body) {
    body.classList.add('pkc-body');
    const hue = { value: 0 };
    let target = 'foreground';
    let mode = 'rgb';

    const current = () => (target === 'foreground' ? app.foreground : app.background);
    const write = (c) => {
      if (target === 'foreground') app.setForeground(c);
      else app.setBackground(c);
    };

    /* ---- foreground / background ------------------------------- */

    const fgFill = el('span.pkc-chip-fill');
    const bgFill = el('span.pkc-chip-fill');
    const fgChip = el('button.pkc-chip.pkc-fg.pk-checker', { type: 'button', title: 'Foreground colour' }, fgFill);
    const bgChip = el('button.pkc-chip.pkc-bg.pk-checker', { type: 'button', title: 'Background colour' }, bgFill);

    const openPicker = (which) => {
      const before = which === 'foreground' ? { ...app.foreground } : { ...app.background };
      const set = (c) => (which === 'foreground' ? app.setForeground(c) : app.setBackground(c));
      showColorPicker({
        color: before,
        title: which === 'foreground' ? 'Foreground Color' : 'Background Color',
        onChange: (c) => set(c),
      }).then((res) => set(res || before));
    };

    const chipClick = (which) => {
      if (target === which) openPicker(which);
      else {
        target = which;
        sync();
      }
    };
    fgChip.addEventListener('click', () => chipClick('foreground'));
    bgChip.addEventListener('click', () => chipClick('background'));

    const swapBtn = el('button.pk-icon-btn.pkc-mini', { type: 'button', title: 'Swap colours (X)', onclick: () => app.swapColors() }, iconEl('refresh', { size: 13 }));
    const resetBtn = el('button.pkc-reset', { type: 'button', title: 'Default colours (D)', onclick: () => app.resetColors() },
      el('span.pkc-reset-b'), el('span.pkc-reset-w'));

    const chipRow = el('div.pkc-chips', {},
      el('div.pkc-stack', {}, fgChip, bgChip),
      el('div.pkc-chip-tools', {}, swapBtn, resetBtn)
    );

    /* ---- mode + sliders ---------------------------------------- */

    const modeSel = el('select.pk-select.pkc-mode', {
      onchange: () => { mode = modeSel.value; rebuild(); },
    });
    for (const m of MODES) modeSel.appendChild(el('option', { value: m.value, text: m.label }));
    modeSel.value = mode;

    const sliderHost = el('div.pkc-sliders');
    const sliders = [];
    for (let i = 0; i < 4; i++) {
      const s = buildSlider((desc, value) => {
        write(desc.apply(current(), value));
      });
      sliders.push(s);
      sliderHost.appendChild(s.row);
    }

    let channels = channelsFor(mode, hue);

    const hexInput = el('input.pk-input.pkc-hex', { type: 'text', spellcheck: 'false' });
    hexInput.addEventListener('input', () => {
      const raw = hexInput.value.trim().replace(/^#/, '');
      if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(raw)) return;
      write({ ...parseColor(`#${raw}`), a: current().a });
    });
    hexInput.addEventListener('blur', () => { hexInput.value = toHex(current()); });
    const hexRow = el('div.pkc-hexrow', {}, el('span', { text: '#' }), hexInput);

    /* ---- spectrum ramp ------------------------------------------ */

    const ramp = el('canvas.pkc-ramp', { title: 'Click to set the foreground, Alt-click for the background' });
    let rampData = null;

    const drawRamp = () => {
      const w = Math.max(32, Math.round(ramp.clientWidth || body.clientWidth || 240));
      const h = 30;
      if (ramp.width !== w || ramp.height !== h) {
        ramp.width = w;
        ramp.height = h;
      }
      const ctx = ramp.getContext('2d');
      const img = ctx.createImageData(w, h);
      const d = img.data;
      const swatchW = Math.min(30, Math.max(16, Math.round(w * 0.09)));
      const rampW = Math.max(1, w - swatchW);
      for (let y = 0; y < h; y++) {
        const ty = y / (h - 1);
        const s = clamp(ty * 2, 0, 1);
        const v = clamp(2 - ty * 2, 0, 1);
        for (let x = 0; x < w; x++) {
          let c;
          if (x < rampW) c = hsv2rgb((x / rampW) * 360, s, v);
          else c = ty < 0.5 ? rgb(255, 255, 255) : rgb(0, 0, 0);
          const i = (y * w + x) * 4;
          d[i] = c.r; d[i + 1] = c.g; d[i + 2] = c.b; d[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      rampData = d;
    };

    const pickFromRamp = (e) => {
      if (!rampData) return;
      const r = ramp.getBoundingClientRect();
      const x = clamp(Math.floor(((e.clientX - r.left) / Math.max(1, r.width)) * ramp.width), 0, ramp.width - 1);
      const y = clamp(Math.floor(((e.clientY - r.top) / Math.max(1, r.height)) * ramp.height), 0, ramp.height - 1);
      const i = (y * ramp.width + x) * 4;
      const c = rgb(rampData[i], rampData[i + 1], rampData[i + 2], 1);
      if (e.altKey) app.setBackground(c);
      else app.setForeground(c);
    };
    ramp.addEventListener('pointerdown', (e) => {
      ramp.setPointerCapture?.(e.pointerId);
      pickFromRamp(e);
      const move = (ev) => { if (ev.buttons) pickFromRamp(ev); };
      const up = () => {
        ramp.removeEventListener('pointermove', move);
        ramp.removeEventListener('pointerup', up);
      };
      ramp.addEventListener('pointermove', move);
      ramp.addEventListener('pointerup', up);
      e.preventDefault();
    });

    /* ---- assembly ----------------------------------------------- */

    body.append(
      el('div.pkc-head', {}, chipRow, el('div.pkc-headcol', {}, modeSel, hexRow)),
      sliderHost,
      ramp
    );

    const rebuild = () => {
      channels = channelsFor(mode, hue);
      sliders.forEach((s, i) => {
        if (i < channels.length) {
          s.bind(channels[i]);
          s.row.style.display = '';
        } else {
          s.row.style.display = 'none';
        }
      });
      sync();
    };

    const sync = () => {
      const c = current();
      fgFill.style.background = toCss(app.foreground);
      bgFill.style.background = toCss(app.background);
      fgChip.classList.toggle('is-target', target === 'foreground');
      bgChip.classList.toggle('is-target', target === 'background');
      for (let i = 0; i < channels.length; i++) sliders[i].sync(c);
      if (document.activeElement !== hexInput) hexInput.value = toHex(c);
    };

    app.on('color-change', sync);

    const ro = new ResizeObserver(() => drawRamp());
    ro.observe(body);

    rebuild();
    drawRamp();

    return {
      refresh() {
        drawRamp();
        sync();
      },
    };
  },
});
