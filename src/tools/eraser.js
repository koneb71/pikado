import { Tool, registerTool } from './base.js';
import { app } from '../core/app.js';
import { PaintStroke, EffectStroke, brushOptionDescriptors, brushFromOptions } from '../paint/brush-engine.js';
import { createCanvas, ctx2dRead, clamp, clamp255 } from '../core/util.js';
import { toCss, colorDistance } from '../core/color.js';
import { getComposite } from '../render/compositor.js';
import { BrushToolBase, tweakDefaults, buildMatchMask, samplePixel } from './brush.js';
import { historySourceCanvasFor } from './history-brush.js';
import { cmd, sep } from '../ui/canvas-menu.js';

/**
 * Eraser, Background Eraser and Magic Eraser.
 */

const LIMIT_OPTIONS = [
  { value: 'discontiguous', label: 'Discontiguous' },
  { value: 'contiguous', label: 'Contiguous' },
  { value: 'find-edges', label: 'Find Edges' },
];

/** Block eraser is a fixed 16 *screen* pixel square, like Photoshop's. */
const BLOCK_SCREEN_SIZE = 16;

/* ================================================================== */
/* Eraser                                                              */
/* ================================================================== */

class EraserTool extends BrushToolBase {
  constructor() {
    const base = brushOptionDescriptors().map((d) =>
      d.key === 'size' || d.key === 'hardness' ? { ...d, when: (s) => s.mode !== 'block' } : d
    );
    super({
      id: 'eraser', name: 'Eraser Tool', icon: 'eraser', cursor: 'crosshair', shortcut: 'E',
      group: 'eraser', groupOrder: 10,
      strokeLabel: 'Eraser',
      options: [
        { key: 'mode', label: 'Mode', type: 'select', default: 'brush',
          options: [
            { value: 'brush', label: 'Brush' },
            { value: 'pencil', label: 'Pencil' },
            { value: 'block', label: 'Block' },
          ] },
        ...tweakDefaults(base, { size: 40, hardness: 100 }),
        { key: 'eraseToHistory', label: 'Erase to History', type: 'checkbox', default: false },
      ],
    });
  }

  cursorDiameter() {
    if (this.state.mode === 'block') return this.blockSize();
    return this.state.size;
  }

  cursorShape() {
    return this.state.mode === 'block' ? 'square' : 'round';
  }

  blockSize() {
    const scale = app.viewport ? app.viewport.scale || 1 : 1;
    return Math.max(1, Math.round(BLOCK_SCREEN_SIZE / scale));
  }

  _brushSettings() {
    const mode = this.state.mode;
    if (mode === 'block') {
      return brushFromOptions(this.state, {
        size: this.blockSize(),
        hardness: 1,
        antialias: false,
        shape: 'square',
        spacing: 0.1,
        smoothing: 0,
        pressureSize: false,
      });
    }
    if (mode === 'pencil') {
      return brushFromOptions(this.state, { hardness: 1, antialias: false, spacing: 0.05 });
    }
    return brushFromOptions(this.state);
  }

  makeStroke(e, doc, layer) {
    const target = layer.paintTarget();
    const brush = this._brushSettings();

    if (this.state.eraseToHistory) {
      // Put back the pixels of the history source state — or, when that state
      // has nothing for this layer, the layer as it was when the stroke began.
      const src = historySourceCanvasFor(doc, layer, { warn: false });
      const holder = { ctx: src ? ctx2dRead(src) : null };
      // EffectStroke's coverage carries flow and the tip falloff; opacity has
      // to be applied by the op itself.
      const amount = clamp((this.state.opacity ?? 100) / 100, 0, 1);
      return new EffectStroke({
        doc,
        layer,
        target,
        brush,
        strength: 1,
        op: (region, meta) => {
          if (!holder.ctx) holder.ctx = ctx2dRead(meta.stroke.base);
          const from = holder.ctx.getImageData(meta.rectX, meta.rectY, region.width, region.height).data;
          const d = region.data;
          if (amount >= 1) {
            d.set(from);
            return region;
          }
          for (let i = 0; i < d.length; i += 4) {
            d[i] += (from[i] - d[i]) * amount;
            d[i + 1] += (from[i + 1] - d[i + 1]) * amount;
            d[i + 2] += (from[i + 2] - d[i + 2]) * amount;
            d[i + 3] += (from[i + 3] - d[i + 3]) * amount;
          }
          return region;
        },
      });
    }

    // Erasing a Background layer paints the background colour instead of
    // punching a hole in it.
    if (layer.isBackground && !layer.editingMask) {
      return new PaintStroke({
        doc, layer, target, brush, mode: 'paint', color: toCss(app.background),
      });
    }
    return new PaintStroke({
      doc, layer, target, brush, mode: 'erase',
      lockTransparency: !!layer.locked.transparency && !layer.editingMask,
    });
  }
}

registerTool(new EraserTool());

/* ================================================================== */
/* Background Eraser                                                   */
/* ================================================================== */

class BackgroundEraserTool extends BrushToolBase {
  constructor() {
    super({
      id: 'bg-eraser', name: 'Background Eraser Tool', icon: 'bg-eraser',
      cursor: 'crosshair', shortcut: 'E', group: 'eraser', groupOrder: 10,
      strokeLabel: 'Background Eraser',
      options: [
        ...tweakDefaults(brushOptionDescriptors({ opacity: false, airbrush: false }), { size: 60, hardness: 100 }),
        { key: 'sampling', label: 'Sampling', type: 'select', default: 'continuous',
          options: [
            { value: 'continuous', label: 'Continuous' },
            { value: 'once', label: 'Once' },
            { value: 'background', label: 'Background Swatch' },
          ] },
        { key: 'limits', label: 'Limits', type: 'select', options: LIMIT_OPTIONS, default: 'contiguous' },
        { key: 'tolerance', label: 'Tolerance', type: 'slider', min: 1, max: 100, step: 1, default: 30, unit: '%' },
        { key: 'protectForeground', label: 'Protect Foreground Color', type: 'checkbox', default: false },
      ],
    });
  }

  beforeStroke(e, doc, layer) {
    // A background layer cannot hold transparency, so promote it first.
    if (layer.isBackground && !layer.editingMask) layer.isBackground = false;
    return true;
  }

  makeStroke(e, doc, layer) {
    const target = layer.paintTarget();
    const tol = (this.state.tolerance / 100) * 255;
    const limits = this.state.limits;
    const protect = this.state.protectForeground;
    const fg = app.foreground;

    let fixed = null;
    if (this.state.sampling === 'once') {
      const px = samplePixel(target, e.x, e.y);
      fixed = px ? { r: px.r, g: px.g, b: px.b } : null;
    } else if (this.state.sampling === 'background') {
      fixed = { r: app.background.r, g: app.background.g, b: app.background.b };
    }
    // Continuous sampling remembers the last usable hot-spot colour so passing
    // over an already-erased area does not reset the reference.
    const live = { ref: fixed };

    return new EffectStroke({
      doc,
      layer,
      target,
      brush: brushFromOptions(this.state),
      strength: 1,
      op: (region, meta) => {
        const w = region.width, h = region.height, d = region.data;
        if (!fixed) {
          const cx = clamp(Math.round(meta.x) - meta.rectX, 0, w - 1);
          const cy = clamp(Math.round(meta.y) - meta.rectY, 0, h - 1);
          const ci = (cy * w + cx) * 4;
          if (d[ci + 3] > 8) live.ref = { r: d[ci], g: d[ci + 1], b: d[ci + 2] };
        }
        if (!live.ref) return region;

        const match = buildMatchMask(region, meta, { ref: live.ref, tol, limits });
        for (let p = 0, i = 0; p < w * h; p++, i += 4) {
          const m = match[p];
          if (m <= 0 || d[i + 3] === 0) continue;
          if (protect && colorDistance({ r: d[i], g: d[i + 1], b: d[i + 2] }, fg) < 30) continue;
          d[i + 3] = d[i + 3] * (1 - m);
        }
        return region;
      },
    });
  }
}

registerTool(new BackgroundEraserTool());

/* ================================================================== */
/* Magic Eraser                                                        */
/* ================================================================== */

/**
 * Flood/global colour match over a whole document.
 *
 * @returns {Float32Array} coverage 0..1 per pixel
 */
function matchRegion(data, w, h, sx, sy, tol, contiguous) {
  const cov = new Float32Array(w * h);
  const si = (sy * w + sx) * 4;
  const sr = data[si], sg = data[si + 1], sb = data[si + 2], sa = data[si + 3];
  const soft = Math.max(1, tol * 0.25);
  const hard = Math.max(0, tol - soft);

  const score = (i) => {
    const dist = Math.max(
      Math.abs(data[i] - sr),
      Math.abs(data[i + 1] - sg),
      Math.abs(data[i + 2] - sb),
      Math.abs(data[i + 3] - sa)
    );
    if (dist <= hard) return 1;
    if (dist >= tol) return 0;
    const t = 1 - (dist - hard) / soft;
    return t * t * (3 - 2 * t);
  };

  if (!contiguous) {
    for (let p = 0, i = 0; p < w * h; p++, i += 4) cov[p] = score(i);
    return cov;
  }

  const stack = new Int32Array(w * h);
  let top = 0;
  const seen = new Uint8Array(w * h);
  const start = sy * w + sx;
  stack[top++] = start;
  seen[start] = 1;
  while (top > 0) {
    const p = stack[--top];
    const s = score(p * 4);
    if (s <= 0) continue;
    cov[p] = s;
    if (s < 1) continue; // partial pixels are edge pixels: do not spread past them
    const x = p % w, y = (p - x) / w;
    if (x > 0 && !seen[p - 1]) { seen[p - 1] = 1; stack[top++] = p - 1; }
    if (x < w - 1 && !seen[p + 1]) { seen[p + 1] = 1; stack[top++] = p + 1; }
    if (y > 0 && !seen[p - w]) { seen[p - w] = 1; stack[top++] = p - w; }
    if (y < h - 1 && !seen[p + w]) { seen[p + w] = 1; stack[top++] = p + w; }
  }
  return cov;
}

class MagicEraserTool extends Tool {
  constructor() {
    super({
      id: 'magic-eraser', name: 'Magic Eraser Tool', icon: 'magic-eraser',
      cursor: 'crosshair', shortcut: 'E', group: 'eraser', groupOrder: 10,
      options: [
        { key: 'tolerance', label: 'Tolerance', type: 'slider', min: 0, max: 255, step: 1, default: 32 },
        { key: 'antialias', label: 'Anti-alias', type: 'checkbox', default: true },
        { key: 'contiguous', label: 'Contiguous', type: 'checkbox', default: true },
        { key: 'sampleAllLayers', label: 'Sample All Layers', type: 'checkbox', default: false },
        { key: 'opacity', label: 'Opacity', type: 'slider', min: 1, max: 100, step: 1, default: 100, unit: '%' },
      ],
    });
    this.app = app;
  }

  /** No brush tip here, so the menu offers the flags that shape the match. */
  contextMenu() {
    const flag = (key, label) => ({
      label,
      checked: !!this.state[key],
      run: () => this.setOption(key, !this.state[key]),
    });
    return [
      { header: 'Magic Eraser' },
      flag('contiguous', 'Contiguous'),
      flag('antialias', 'Anti-alias'),
      flag('sampleAllLayers', 'Sample All Layers'),
      sep(),
      cmd('layer.new', { label: 'New Layer' }),
      cmd('edit.fill'),
      sep(),
      cmd('edit.undo'),
    ];
  }

  onPointerDown(e) {
    if (e.button !== 0) return;
    if (!this.canPaint()) return;
    const doc = this.doc;
    const layer = doc.activeLayer();
    const target = layer.paintTarget();
    const w = doc.width, h = doc.height;
    const sx = Math.floor(e.x), sy = Math.floor(e.y);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;

    const sampleFrom = this.state.sampleAllLayers && !layer.editingMask ? getComposite(doc) : target;
    const src = ctx2dRead(sampleFrom).getImageData(0, 0, w, h).data;
    const cov = matchRegion(src, w, h, sx, sy, this.state.tolerance, this.state.contiguous);

    const aa = this.state.antialias;
    const opacity = this.state.opacity / 100;
    const sel = doc.selection.active ? doc.selection.mask : null;

    // Build the alpha stencil we will subtract from the layer.
    const stencil = new ImageData(w, h);
    const sd = stencil.data;
    let hit = false;
    for (let p = 0, i = 3; p < w * h; p++, i += 4) {
      let c = cov[p];
      if (c <= 0) continue;
      if (!aa) c = c >= 0.5 ? 1 : 0;
      if (sel) c *= sel[p] / 255;
      c *= opacity;
      if (c <= 0) continue;
      sd[i] = clamp255(Math.round(c * 255));
      hit = true;
    }
    if (!hit) {
      app.toast('Nothing within tolerance here.', 'warn');
      return;
    }

    doc.beginEdit(layer);
    const surface = layer.paintTarget();
    const cut = createCanvas(w, h);
    cut.getContext('2d').putImageData(stencil, 0, 0);
    const ctx = surface.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(cut, 0, 0);
    ctx.restore();
    if (layer.isBackground && !layer.editingMask) layer.isBackground = false;
    if (layer.editingMask) layer.touchMask();
    doc.commit('Magic Eraser');
  }
}

registerTool(new MagicEraserTool());
