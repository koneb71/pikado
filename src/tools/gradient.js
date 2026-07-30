import { Tool, registerTool } from './base.js';
import { app } from '../core/app.js';
import { createCanvas, cloneCanvas, clamp, ctx2dRead, el } from '../core/util.js';
import { toCss } from '../core/color.js';
import { BLEND_MODES } from '../core/blend.js';
import { blendOnto, getComposite } from '../render/compositor.js';
import { Dialog } from '../ui/dialog.js';
import {
  GRADIENT_PRESETS, getGradientPreset, renderGradient, gradientPreviewCanvas,
} from '../paint/gradients.js';
import { getPattern, makeTiledCanvas } from '../paint/patterns.js';
import './gradient.css';

/**
 * Gradient and Paint Bucket.
 *
 * Both build a document-sized "ink" canvas, clip it to the coverage they are
 * allowed to touch (selection ∩ flood region ∩ lock-transparency) and then
 * blend it onto a cached copy of the layer, so opacity and blend mode behave
 * the same way as in the brush engine.
 */

const BLEND_OPTIONS = BLEND_MODES.map((m) => ({ value: m.id, label: m.name }));

/** Alpha-only canvas from a 0..255 coverage mask. */
function maskToAlphaCanvas(mask, w, h) {
  const cv = createCanvas(w, h);
  const img = new ImageData(w, h);
  const d = img.data;
  for (let p = 0, i = 3; p < mask.length; p++, i += 4) d[i] = mask[p];
  cv.getContext('2d').putImageData(img, 0, 0);
  return cv;
}

/**
 * Composite `ink` onto `target` over `base`, honouring the selection, the
 * layer's transparency lock, blend mode and opacity.
 */
function paintInk(doc, layer, target, base, ink, mode, opacity, extraClip) {
  const ic = ink.getContext('2d');
  if (extraClip) {
    ic.globalCompositeOperation = 'destination-in';
    ic.drawImage(extraClip, 0, 0);
    ic.globalCompositeOperation = 'source-over';
  }
  if (doc.selection.active) {
    ic.globalCompositeOperation = 'destination-in';
    ic.drawImage(doc.selection.toAlphaCanvas(), 0, 0);
    ic.globalCompositeOperation = 'source-over';
  }
  if (layer.locked.transparency && !layer.editingMask) {
    ic.globalCompositeOperation = 'destination-in';
    ic.drawImage(base, 0, 0);
    ic.globalCompositeOperation = 'source-over';
  }
  const c = target.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = 'source-over';
  c.globalAlpha = 1;
  c.clearRect(0, 0, target.width, target.height);
  c.drawImage(base, 0, 0);
  blendOnto(c, ink, mode, opacity, doc);
}

/* ------------------------------------------------------------------ */
/* Gradient preset picker                                              */
/* ------------------------------------------------------------------ */

function showGradientPicker(current) {
  const d = new Dialog({ title: 'Gradient Picker', width: 470, className: 'pk-grad-dialog' });
  const grid = el('div.pk-grad-grid');
  for (const g of GRADIENT_PRESETS) {
    const cell = el('button.pk-grad-cell' + (g.id === current ? '.selected' : ''), {
      type: 'button', title: g.name, onclick: () => d.close(g.id),
    });
    cell.appendChild(gradientPreviewCanvas(g.stops, 126, 26));
    cell.appendChild(el('span.pk-grad-name', { text: g.name }));
    grid.appendChild(cell);
  }
  d.setBody(grid);
  d.setButtons([{ label: 'Cancel', value: null, subtle: true }]);
  return d.open();
}

function renderGradientSwatch(container, state, onChange, p) {
  const btn = el('button.pk-grad-swatch', { type: 'button' });
  const draw = (id) => {
    const preset = getGradientPreset(id) || GRADIENT_PRESETS[0];
    btn.title = preset.name;
    btn.replaceChildren(gradientPreviewCanvas(preset.stops, 116, 20));
  };
  btn.addEventListener('click', async () => {
    const id = await showGradientPicker(state[p.key]);
    if (id) {
      draw(id);
      onChange(p.key, id);
    }
  });
  draw(state[p.key]);
  // Foreground/background presets must follow the colour swatches.
  const off = app.on('color-change', () => {
    if (!btn.isConnected) { off(); return; }
    draw(state[p.key]);
  });
  container.appendChild(btn);
  return { sync: draw };
}

/* ------------------------------------------------------------------ */
/* Gradient tool                                                       */
/* ------------------------------------------------------------------ */

class GradientTool extends Tool {
  constructor() {
    super({
      id: 'gradient',
      name: 'Gradient Tool',
      icon: 'gradient',
      cursor: 'crosshair',
      shortcut: 'G',
      group: 'gradient',
      groupOrder: 11,
      options: [
        { key: 'preset', type: 'custom', label: 'Gradient', default: 'foreground-to-background', render: renderGradientSwatch },
        {
          key: 'type', type: 'radio', label: '', default: 'linear',
          options: [
            { value: 'linear', label: 'Linear' },
            { value: 'radial', label: 'Radial' },
            { value: 'angle', label: 'Angle' },
            { value: 'reflected', label: 'Reflected' },
            { value: 'diamond', label: 'Diamond' },
          ],
        },
        { key: 'mode', type: 'select', label: 'Mode', default: 'normal', options: BLEND_OPTIONS },
        { key: 'opacity', type: 'slider', label: 'Opacity', min: 0, max: 100, step: 1, default: 100, unit: '%' },
        { key: 'reverse', type: 'checkbox', label: 'Reverse', default: false },
        { key: 'dither', type: 'checkbox', label: 'Dither', default: true },
        { key: 'transparency', type: 'checkbox', label: 'Transparency', default: true },
      ],
    });
    this.drag = null;
  }

  stops() {
    const preset = getGradientPreset(this.state.preset) || GRADIENT_PRESETS[0];
    if (this.state.transparency) return preset.stops;
    return preset.stops.map((s) => ({ ...s, opacity: 1 }));
  }

  onPointerDown(e) {
    if (!this.canPaint()) return;
    const doc = this.doc;
    const layer = doc.activeLayer();
    doc.beginEdit(layer);
    const target = layer.paintTarget();
    if (!target) return;
    this.drag = {
      doc, layer, target,
      base: cloneCanvas(target),
      x1: e.x, y1: e.y, x2: e.x, y2: e.y,
      drawn: false,
    };
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d) return;
    let x = e.x, y = e.y;
    if (e.shiftKey) {
      const dx = x - d.x1, dy = y - d.y1;
      const len = Math.hypot(dx, dy);
      const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      x = d.x1 + Math.cos(a) * len;
      y = d.y1 + Math.sin(a) * len;
    }
    d.x2 = x;
    d.y2 = y;
    this.paint();
    d.doc.touch('gradient');
  }

  paint() {
    const d = this.drag;
    const doc = d.doc;
    if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < 0.5) return;
    const ink = createCanvas(doc.width, doc.height);
    renderGradient(ink.getContext('2d'), {
      type: this.state.type,
      stops: this.stops(),
      x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2,
      reverse: this.state.reverse,
      dither: this.state.dither,
    }, doc.width, doc.height);
    paintInk(doc, d.layer, d.target, d.base, ink, this.state.mode, clamp(this.state.opacity / 100, 0, 1));
    d.drawn = true;
  }

  onPointerUp() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (!d.drawn) return;
    d.doc.commit('Gradient');
  }

  cancel() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const c = d.target.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, d.target.width, d.target.height);
    c.drawImage(d.base, 0, 0);
    d.doc.touch('gradient-cancel');
  }

  drawOverlay(ctx, view) {
    const d = this.drag;
    if (!d || !d.drawn) return;
    const p1 = view.toScreen(d.x1, d.y1);
    const p2 = view.toScreen(d.x2, d.y2);
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,.55)';
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    for (const p of [p1, p2]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.7)';
      ctx.stroke();
    }
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ */
/* Paint bucket                                                        */
/* ------------------------------------------------------------------ */

/**
 * Scanline flood fill.
 * @returns {Uint8ClampedArray} coverage mask, 0 or 255
 */
export function floodFillMask(src, sx, sy, tolerance, contiguous) {
  const w = src.width, h = src.height;
  const data = ctx2dRead(src).getImageData(0, 0, w, h).data;
  const out = new Uint8ClampedArray(w * h);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return out;

  const o = (sy * w + sx) * 4;
  const r0 = data[o], g0 = data[o + 1], b0 = data[o + 2], a0 = data[o + 3];
  const tol = Math.max(0, tolerance);
  const match = (p) => {
    const i = p * 4;
    const da = Math.abs(data[i + 3] - a0);
    if (da > tol) return false;
    // Fully transparent pixels have meaningless RGB — compare alpha only.
    if (data[i + 3] === 0 && a0 === 0) return true;
    return Math.abs(data[i] - r0) <= tol && Math.abs(data[i + 1] - g0) <= tol && Math.abs(data[i + 2] - b0) <= tol;
  };

  if (!contiguous) {
    for (let p = 0; p < w * h; p++) if (match(p)) out[p] = 255;
    return out;
  }

  const visited = new Uint8Array(w * h);
  const stack = [sy * w + sx];
  while (stack.length) {
    const p = stack.pop();
    const y = (p / w) | 0;
    let x = p - y * w;
    if (visited[p] || !match(p)) continue;
    while (x > 0 && !visited[y * w + x - 1] && match(y * w + x - 1)) x--;
    let spanUp = false, spanDown = false;
    for (; x < w; x++) {
      const q = y * w + x;
      if (visited[q] || !match(q)) break;
      visited[q] = 1;
      out[q] = 255;
      if (y > 0) {
        const up = q - w;
        const ok = !visited[up] && match(up);
        if (ok && !spanUp) { stack.push(up); spanUp = true; }
        else if (!ok) spanUp = false;
      }
      if (y < h - 1) {
        const dn = q + w;
        const ok = !visited[dn] && match(dn);
        if (ok && !spanDown) { stack.push(dn); spanDown = true; }
        else if (!ok) spanDown = false;
      }
    }
  }
  return out;
}

/**
 * Turn the hard flood edge into a one-pixel ramp.
 *
 * The ramp is taken as `max(coverage, 3x3 average)` rather than the average
 * alone: a plain blur also eats into the *inside* of the region, which would
 * leave a third of the original colour showing through all the way around the
 * fill. Taking the maximum keeps the interior solid and feathers outwards.
 */
function softenMask(mask, w, h) {
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const self = mask[p];
      if (self === 255) { out[p] = 255; continue; }
      let sum = 0, n = 0;
      for (let j = -1; j <= 1; j++) {
        const yy = y + j;
        if (yy < 0 || yy >= h) continue;
        for (let i = -1; i <= 1; i++) {
          const xx = x + i;
          if (xx < 0 || xx >= w) continue;
          sum += mask[yy * w + xx];
          n++;
        }
      }
      const avg = sum / n;
      out[p] = avg > self ? avg : self;
    }
  }
  return out;
}

/**
 * `[{value,label}]` for every pattern in the library. Kept tolerant because
 * `paint/patterns.js` is owned elsewhere: only `getPattern` and
 * `makeTiledCanvas` are contractual, the listing helper is best-effort.
 */
function patternChoices(mod) {
  if (typeof mod.patternOptions === 'function') return mod.patternOptions();
  let raw = [];
  if (typeof mod.getPatterns === 'function') raw = mod.getPatterns();
  else if (typeof mod.listPatterns === 'function') raw = mod.listPatterns();
  else if (Array.isArray(mod.PATTERNS)) raw = mod.PATTERNS;
  return (Array.isArray(raw) ? raw : []).map((x) => (
    typeof x === 'string' ? { value: x, label: x } : { value: x.id, label: x.name || x.id }
  )).filter((o) => o.value);
}

function renderPatternSelect(container, state, onChange, p) {
  const sel = el('select.pk-select.pk-pattern-select');
  const fill = (list) => {
    sel.replaceChildren(...list.map((o) => el('option', { value: o.value, text: o.label })));
    if (list.length && !list.some((o) => String(o.value) === String(state[p.key]))) {
      onChange(p.key, list[0].value);
    }
    sel.value = state[p.key];
  };
  fill([{ value: state[p.key] || '', label: 'Loading…' }]);
  // Dynamic so an unexpected export shape degrades to an empty list instead of
  // breaking the bundle.
  import('../paint/patterns.js')
    .then((m) => {
      const list = patternChoices(m);
      if (list.length) fill(list);
    })
    .catch((err) => console.error('[bucket] pattern list unavailable', err));
  sel.addEventListener('change', () => onChange(p.key, sel.value));
  container.appendChild(sel);
  return { sync: (v) => { if (v != null) sel.value = v; } };
}

class BucketTool extends Tool {
  constructor() {
    super({
      id: 'bucket',
      name: 'Paint Bucket Tool',
      icon: 'bucket',
      cursor: 'crosshair',
      shortcut: 'G',
      group: 'gradient',
      groupOrder: 11,
      options: [
        {
          key: 'fill', type: 'select', label: 'Fill', default: 'foreground',
          options: [{ value: 'foreground', label: 'Foreground' }, { value: 'pattern', label: 'Pattern' }],
        },
        {
          key: 'pattern', type: 'custom', label: 'Pattern', default: '',
          render: renderPatternSelect, when: (s) => s.fill === 'pattern',
        },
        { key: 'mode', type: 'select', label: 'Mode', default: 'normal', options: BLEND_OPTIONS },
        { key: 'opacity', type: 'slider', label: 'Opacity', min: 0, max: 100, step: 1, default: 100, unit: '%' },
        { key: 'tolerance', type: 'slider', label: 'Tolerance', min: 0, max: 255, step: 1, default: 32 },
        { key: 'antialias', type: 'checkbox', label: 'Anti-alias', default: true },
        { key: 'contiguous', type: 'checkbox', label: 'Contiguous', default: true },
        { key: 'allLayers', type: 'checkbox', label: 'All Layers', default: false },
      ],
    });
  }

  inkCanvas(doc) {
    const cv = createCanvas(doc.width, doc.height);
    const c = cv.getContext('2d');
    if (this.state.fill === 'pattern') {
      const pat = getPattern(this.state.pattern);
      const tiled = pat ? makeTiledCanvas(pat, doc.width, doc.height) : null;
      if (!tiled) {
        this.app.toast('Choose a pattern first.');
        return null;
      }
      c.drawImage(tiled, 0, 0);
    } else {
      c.fillStyle = toCss(this.app.foreground);
      c.fillRect(0, 0, doc.width, doc.height);
    }
    return cv;
  }

  onPointerDown(e) {
    if (!this.canPaint()) return;
    const doc = this.doc;
    const layer = doc.activeLayer();
    const x = Math.floor(e.x), y = Math.floor(e.y);
    if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
    if (doc.selection.active && doc.selection.at(x, y) === 0) {
      this.app.toast('Click inside the selection to fill.');
      return;
    }

    const source = this.state.allLayers
      ? getComposite(doc)
      : (layer.editingMask && layer.mask ? layer.mask : layer.canvas);
    if (!source) return;

    const ink = this.inkCanvas(doc);
    if (!ink) return;

    let mask = floodFillMask(source, x, y, Number(this.state.tolerance) || 0, this.state.contiguous);
    if (this.state.antialias) mask = softenMask(mask, doc.width, doc.height);

    doc.beginEdit(layer);
    const target = layer.paintTarget();
    if (!target) return;
    const base = cloneCanvas(target);
    paintInk(
      doc, layer, target, base, ink,
      this.state.mode, clamp(this.state.opacity / 100, 0, 1),
      maskToAlphaCanvas(mask, doc.width, doc.height)
    );
    doc.commit('Paint Bucket');
  }
}

registerTool(new GradientTool());
registerTool(new BucketTool());
