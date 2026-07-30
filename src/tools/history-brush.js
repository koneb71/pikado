import { registerTool } from './base.js';
import { app } from '../core/app.js';
import { PaintStroke, brushOptionDescriptors, brushFromOptions } from '../paint/brush-engine.js';
import { ctx2dRead, clamp } from '../core/util.js';
import { BrushToolBase, tweakDefaults } from './brush.js';

/**
 * History Brush and Art History Brush.
 *
 * Both paint pixels back from a chosen history state. `doc.historyBrushSource`
 * holds the index into `doc.history.states`; it defaults to 0 (the state the
 * document was opened/created in), which is what Photoshop uses too.
 */

/* ------------------------------------------------------------------ */
/* History state lookup                                                */
/* ------------------------------------------------------------------ */

function findLayerSnapshot(list, id) {
  if (!list) return null;
  for (const s of list) {
    if (s.id === id) return s;
    if (s.children) {
      const f = findLayerSnapshot(s.children, id);
      if (f) return f;
    }
  }
  return null;
}

/** The history index the brushes paint from, defaulted and range-checked. */
export function historySourceIndex(doc) {
  const n = doc.history.states.length;
  let i = doc.historyBrushSource;
  if (typeof i !== 'number' || !Number.isFinite(i) || i < 0 || i >= n) {
    i = 0;
    doc.historyBrushSource = 0;
  }
  return i;
}

/**
 * The pixel buffer for `layer` inside the history-brush source state, or null
 * (with a toast) when that state has nothing usable for this layer.
 *
 * @param {import('../core/document.js').PikaDocument} doc
 * @param {import('../core/layer.js').Layer} layer
 * @param {{warn?:boolean}} [opts]
 * @returns {HTMLCanvasElement|null}
 */
export function historySourceCanvasFor(doc, layer, { warn = true } = {}) {
  const states = doc.history.states;
  if (!states.length) {
    if (warn) app.toast('There is no history state to paint from.', 'warn');
    return null;
  }
  const entry = states[historySourceIndex(doc)];
  const snap = entry && entry.state ? findLayerSnapshot(entry.state.layers, layer.id) : null;
  if (!snap) {
    if (warn) app.toast(`"${layer.name}" does not exist in the history source state.`, 'warn');
    return null;
  }
  const cv = layer.editingMask ? snap.mask : snap.canvas;
  if (!cv) {
    if (warn) app.toast('The history source has no pixels for this layer.', 'warn');
    return null;
  }
  if (cv.width !== doc.width || cv.height !== doc.height) {
    if (warn) app.toast('The history source was a different canvas size.', 'warn');
    return null;
  }
  return cv;
}

const identityMap = (x, y) => ({ x, y });

/* ------------------------------------------------------------------ */
/* History Brush                                                       */
/* ------------------------------------------------------------------ */

class HistoryBrushTool extends BrushToolBase {
  constructor() {
    super({
      id: 'history-brush', name: 'History Brush Tool', icon: 'history-brush',
      cursor: 'crosshair', shortcut: 'Y', group: 'history-brush', groupOrder: 9,
      strokeLabel: 'History Brush',
      options: tweakDefaults(brushOptionDescriptors(), { size: 40, hardness: 100 }),
    });
  }

  makeStroke(e, doc, layer) {
    const source = historySourceCanvasFor(doc, layer);
    if (!source) return null;
    return new PaintStroke({
      doc,
      layer,
      target: layer.paintTarget(),
      brush: brushFromOptions(this.state),
      mode: 'paint',
      sourceImage: source,
      sourceMap: identityMap,
      lockTransparency: !!layer.locked.transparency && !layer.editingMask,
    });
  }
}

registerTool(new HistoryBrushTool());

/* ------------------------------------------------------------------ */
/* Art History Brush                                                   */
/* ------------------------------------------------------------------ */

/** length is a multiple of the brush size; curl is radians per step. */
const ART_STYLES = {
  'tight-short': { len: 0.6, curl: 0.5, wobble: 0.18 },
  'loose-medium': { len: 1.9, curl: 0.3, wobble: 0.45 },
  dab: { len: 0, curl: 0, wobble: 0 },
  'tight-curl': { len: 1.2, curl: 1.7, wobble: 0.15 },
  'loose-curl': { len: 3.2, curl: 1.5, wobble: 0.5 },
};

class ArtHistoryTool extends BrushToolBase {
  constructor() {
    super({
      id: 'art-history', name: 'Art History Brush Tool', icon: 'art-history',
      cursor: 'crosshair', shortcut: 'Y', group: 'history-brush', groupOrder: 9,
      strokeLabel: 'Art History Brush',
      options: [
        ...tweakDefaults(brushOptionDescriptors({ smoothing: false, airbrush: false }), { size: 12, hardness: 70, opacity: 100, flow: 80 }),
        { key: 'style', label: 'Style', type: 'select', default: 'tight-short',
          options: [
            { value: 'tight-short', label: 'Tight Short' },
            { value: 'loose-medium', label: 'Loose Medium' },
            { value: 'dab', label: 'Dab' },
            { value: 'tight-curl', label: 'Tight Curl' },
            { value: 'loose-curl', label: 'Loose Curl' },
          ] },
        { key: 'area', label: 'Area', type: 'slider', min: 1, max: 500, step: 1, default: 50, unit: 'px' },
        { key: 'tolerance', label: 'Tolerance', type: 'slider', min: 0, max: 100, step: 1, default: 0, unit: '%' },
      ],
    });
    this._last = null;
    this._travel = 0;
    this._srcCtx = null;
    this._baseCtx = null;
    this._rndState = 1;
  }

  _rand() {
    // Small deterministic-per-stroke PRNG so strokes look organic but stable.
    this._rndState = (this._rndState * 1664525 + 1013904223) >>> 0;
    return this._rndState / 4294967296;
  }

  onPointerDown(e) {
    if (e.button !== 0) return;
    if (!this.canPaint()) return;
    const doc = this.doc;
    const layer = doc.activeLayer();
    const source = historySourceCanvasFor(doc, layer);
    if (!source) return;

    doc.beginEdit(layer);
    const stroke = new PaintStroke({
      doc,
      layer,
      target: layer.paintTarget(),
      brush: brushFromOptions(this.state, { smoothing: 0, spacing: 0.25 }),
      mode: 'paint',
      sourceImage: source,
      sourceMap: identityMap,
      lockTransparency: !!layer.locked.transparency && !layer.editingMask,
    });
    this.stroke = stroke;
    this.strokeDoc = doc;
    this.strokeLayer = layer;
    this._srcCtx = ctx2dRead(source);
    this._baseCtx = ctx2dRead(stroke.base);
    this._last = { x: e.x, y: e.y };
    this._travel = 0;
    this._rndState = (Date.now() ^ 0x9e3779b9) >>> 0;
    this._spray(e.x, e.y, e.pressure, doc);
    this._paintFrame();
  }

  onPointerMove(e) {
    if (!this.stroke) return;
    const dist = Math.hypot(e.x - this._last.x, e.y - this._last.y);
    this._last = { x: e.x, y: e.y };
    this._travel += dist;
    const step = Math.max(2, this.state.area * 0.3);
    let guard = 0;
    while (this._travel >= step && guard++ < 64) {
      this._travel -= step;
      this._spray(e.x, e.y, e.pressure, this.strokeDoc);
    }
    this._paintFrame();
  }

  onPointerUp() {
    this._srcCtx = null;
    this._baseCtx = null;
    super.onPointerUp();
  }

  /** Emit one or more curly strokes around (x,y). */
  _spray(x, y, pressure, doc) {
    const area = this.state.area;
    const size = this.state.size;
    const count = clamp(Math.round(area / Math.max(4, size)), 1, 6);
    for (let i = 0; i < count; i++) {
      const ang = this._rand() * Math.PI * 2;
      const rad = Math.sqrt(this._rand()) * (area / 2);
      this._curl(x + Math.cos(ang) * rad, y + Math.sin(ang) * rad, pressure, doc);
    }
  }

  /** One painterly stroke starting at (x,y). */
  _curl(x, y, pressure, doc) {
    if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
    if (!this._passesTolerance(x, y)) return;

    const style = ART_STYLES[this.state.style] || ART_STYLES['tight-short'];
    const size = this.state.size;
    const stroke = this.stroke;

    if (style.len <= 0) {
      stroke.stamp(x, y, pressure);
      return;
    }
    const step = Math.max(1, size * 0.28);
    const steps = Math.max(1, Math.round((style.len * size) / step));
    let ang = this._rand() * Math.PI * 2;
    let px = x, py = y;
    for (let i = 0; i <= steps; i++) {
      stroke.stamp(px, py, pressure);
      ang += style.curl * (step / Math.max(1, size)) + (this._rand() - 0.5) * style.wobble;
      px += Math.cos(ang) * step;
      py += Math.sin(ang) * step;
      if (px < -size || py < -size || px > doc.width + size || py > doc.height + size) break;
    }
  }

  /**
   * Tolerance restricts painting to places where the canvas already differs
   * from the history source — 0 lets you paint anywhere.
   */
  _passesTolerance(x, y) {
    const tol = this.state.tolerance;
    if (tol <= 0) return true;
    const px = Math.floor(x), py = Math.floor(y);
    const s = this._srcCtx.getImageData(px, py, 1, 1).data;
    const b = this._baseCtx.getImageData(px, py, 1, 1).data;
    const diff = Math.max(Math.abs(s[0] - b[0]), Math.abs(s[1] - b[1]), Math.abs(s[2] - b[2]), Math.abs(s[3] - b[3]));
    return diff >= (tol / 100) * 255;
  }

  cursorDiameter() {
    return Math.max(this.state.area, this.state.size);
  }
}

registerTool(new ArtHistoryTool());
