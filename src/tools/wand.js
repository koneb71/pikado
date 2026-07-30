import { registerTool } from './base.js';
import { SelectionTool } from './marquee.js';
import { getComposite } from '../render/compositor.js';
import { ctx2dRead, clamp } from '../core/util.js';
import { cmd } from '../ui/canvas-menu.js';

/**
 * Magic Wand and Quick Selection, plus the Select > Grow / Similar helpers the
 * Select menu imports.
 */

/* ------------------------------------------------------------------ */
/* Sampling helpers                                                    */
/* ------------------------------------------------------------------ */

/** Pixels the colour-based tools should read: the layer, or the composite. */
function sourceImageData(doc, sampleAllLayers) {
  let cv = null;
  if (sampleAllLayers) {
    cv = getComposite(doc);
  } else {
    const layer = doc.activeLayer();
    cv = layer && (layer.editingMask && layer.mask ? layer.mask : layer.canvas);
    if (!cv) cv = getComposite(doc);
  }
  if (!cv) return null;
  return ctx2dRead(cv).getImageData(0, 0, cv.width, cv.height);
}

/** Per-channel (Chebyshev) distance between two RGBA samples. */
function channelDistance(d, i, r, g, b, a) {
  if (d[i + 3] === 0 && a === 0) return 0; // transparent matches transparent
  const dr = Math.abs(d[i] - r);
  const dg = Math.abs(d[i + 1] - g);
  const db = Math.abs(d[i + 2] - b);
  const da = Math.abs(d[i + 3] - a);
  let m = dr > dg ? dr : dg;
  if (db > m) m = db;
  if (da > m) m = da;
  return m;
}

/**
 * Flood/global colour selection.
 *
 * With anti-alias on, pixels whose colour distance sits inside a ramp around
 * the tolerance get partial coverage, which produces a soft edge exactly where
 * the region stops matching instead of a hard 0/255 cut.
 *
 * @param {ImageData} img
 * @param {number} sx seed x
 * @param {number} sy seed y
 * @param {number} tol 0..255
 * @param {{contiguous?:boolean, antialias?:boolean}} opts
 * @returns {Uint8ClampedArray} coverage mask
 */
export function wandMask(img, sx, sy, tol, { contiguous = true, antialias = true } = {}) {
  const w = img.width;
  const h = img.height;
  const d = img.data;
  const out = new Uint8ClampedArray(w * h);
  const seed = (sy * w + sx) * 4;
  const r0 = d[seed];
  const g0 = d[seed + 1];
  const b0 = d[seed + 2];
  const a0 = d[seed + 3];

  const ramp = antialias ? Math.max(1, tol * 0.25 + 1) : 0;
  const hi = tol + ramp;
  const lo = tol - ramp;
  const coverage = (dv) => {
    if (!ramp) return dv <= tol ? 255 : 0;
    if (dv <= lo) return 255;
    if (dv >= hi) return 0;
    return Math.round((255 * (hi - dv)) / (2 * ramp));
  };

  if (!contiguous) {
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      out[p] = coverage(channelDistance(d, i, r0, g0, b0, a0));
    }
    return out;
  }

  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let top = 0;
  const start = sy * w + sx;
  stack[top++] = start;
  seen[start] = 1;
  while (top > 0) {
    const p = stack[--top];
    const dv = channelDistance(d, p * 4, r0, g0, b0, a0);
    const cov = coverage(dv);
    if (!cov) continue;
    out[p] = cov;
    // Ramp pixels are the soft boundary: include them, but do not grow through.
    if (dv > tol) continue;
    const x = p % w;
    const y = (p / w) | 0;
    if (x > 0 && !seen[p - 1]) { seen[p - 1] = 1; stack[top++] = p - 1; }
    if (x < w - 1 && !seen[p + 1]) { seen[p + 1] = 1; stack[top++] = p + 1; }
    if (y > 0 && !seen[p - w]) { seen[p - w] = 1; stack[top++] = p - w; }
    if (y < h - 1 && !seen[p + w]) { seen[p + w] = 1; stack[top++] = p + w; }
  }
  return out;
}

/**
 * Context-menu Modify group for the colour-based tools.
 *
 * Grow and Similar are the follow-ups you actually reach for after a wand
 * click — they extend the same colour match — so they take the place of the
 * geometric Expand/Contract the marquee offers.
 */
function colorSelectionModifyItems() {
  return [
    cmd('select.modify.feather', { hideWhenDisabled: true }),
    cmd('select.grow', { hideWhenDisabled: true }),
    cmd('select.similar', { hideWhenDisabled: true }),
  ];
}

/* ------------------------------------------------------------------ */
/* Magic Wand                                                          */
/* ------------------------------------------------------------------ */

class MagicWandTool extends SelectionTool {
  constructor() {
    super({
      id: 'wand', name: 'Magic Wand Tool', icon: 'wand', shortcut: 'W',
      group: 'wand', groupOrder: 3,
      options: [
        { key: 'tolerance', label: 'Tolerance', type: 'slider', min: 0, max: 255, step: 1, default: 32 },
        { key: 'contiguous', label: 'Contiguous', type: 'checkbox', default: true },
        { key: 'sampleAllLayers', label: 'Sample All Layers', type: 'checkbox', default: false },
      ],
    });
  }

  onPointerDown(e) {
    const doc = this.doc;
    if (!doc) return;
    const x = Math.floor(e.x);
    const y = Math.floor(e.y);
    if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
    const img = sourceImageData(doc, this.state.sampleAllLayers);
    if (!img) {
      this.app.toast('Nothing to sample on this layer.', 'warn');
      return;
    }
    const mask = wandMask(img, x, y, Math.max(0, Number(this.state.tolerance) || 0), {
      contiguous: this.state.contiguous !== false,
      antialias: this.antialiasOn(),
    });
    this.applyMask(mask, this.modeFor(e), 'Magic Wand');
  }

  selectionModifyItems() {
    return colorSelectionModifyItems();
  }
}

/* ------------------------------------------------------------------ */
/* Quick Selection                                                     */
/* ------------------------------------------------------------------ */

/** Pixel visits allowed per pointer event, so huge images stay interactive. */
const GROW_BUDGET = 160000;

class QuickSelectTool extends SelectionTool {
  constructor() {
    super({
      id: 'quick-select', name: 'Quick Selection Tool', icon: 'quick-select', shortcut: 'W',
      group: 'wand', groupOrder: 3,
      modes: ['replace', 'add', 'subtract'],
      options: [
        { key: 'size', label: 'Size', type: 'slider', min: 1, max: 500, step: 1, default: 30, unit: 'px' },
        { key: 'sampleAllLayers', label: 'Sample All Layers', type: 'checkbox', default: false },
      ],
    });
    this.painting = false;
    this.cursor = null;
  }

  onPointerDown(e) {
    const doc = this.doc;
    if (!doc) return;
    const img = sourceImageData(doc, this.state.sampleAllLayers);
    if (!img) {
      this.app.toast('Nothing to sample on this layer.', 'warn');
      return;
    }
    this.img = img;
    this.w = img.width;
    this.h = img.height;
    const n = this.w * this.h;

    this.mode = this.modeFor(e);
    const cur = doc.selection.mask;
    // Add/subtract need something to combine with.
    if (this.mode !== 'replace' && !cur) this.mode = 'replace';
    this.base = cur ? new Uint8ClampedArray(cur) : null;

    this.region = new Uint8Array(n);
    this.visited = new Uint8Array(n);
    this.queue = new Int32Array(n);
    this.qHead = 0;
    this.qTail = 0;
    this.work = new Uint8ClampedArray(n);
    this.sum = [0, 0, 0, 0];
    this.sumSq = [0, 0, 0, 0];
    this.count = 0;

    this.painting = true;
    this.last = { x: e.x, y: e.y };
    this.cursor = { x: e.x, y: e.y };
    this.dab(e.x, e.y);
    this.grow(GROW_BUDGET);
    this.push(false);
  }

  onPointerMove(e) {
    this.cursor = { x: e.x, y: e.y };
    if (!this.painting) {
      this.app.requestRender();
      return;
    }
    // Interpolate so fast drags still paint a continuous band of seeds.
    const step = Math.max(2, (Number(this.state.size) || 30) / 4);
    const d = Math.hypot(e.x - this.last.x, e.y - this.last.y);
    const steps = Math.min(64, Math.max(1, Math.ceil(d / step)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      this.dab(this.last.x + (e.x - this.last.x) * t, this.last.y + (e.y - this.last.y) * t);
    }
    this.last = { x: e.x, y: e.y };
    this.grow(GROW_BUDGET);
    this.push(false);
  }

  onPointerUp() {
    if (!this.painting) return;
    this.painting = false;
    // Drain whatever frontier is left, within a bounded final budget.
    this.grow(GROW_BUDGET * 4);
    this.push(true);
    this.img = null;
    this.region = this.visited = this.queue = this.work = this.base = null;
  }

  cancel() {
    if (!this.painting) return;
    this.painting = false;
    this.img = null;
    this.region = this.visited = this.queue = this.work = this.base = null;
  }

  /** Seed every pixel under one brush dab. */
  dab(cx, cy) {
    const r = Math.max(0.5, (Number(this.state.size) || 30) / 2);
    const w = this.w;
    const h = this.h;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(h - 1, Math.ceil(cy + r));
    const rr = r * r;
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        if (dx * dx + dy * dy > rr) continue;
        const p = y * w + x;
        // Painting over a pixel the growth previously rejected re-seeds it.
        if (this.region[p]) continue;
        this.accept(p);
      }
    }
  }

  accept(p) {
    this.visited[p] = 1;
    this.region[p] = 1;
    const i = p * 4;
    const d = this.img.data;
    for (let k = 0; k < 4; k++) {
      const v = d[i + k];
      this.sum[k] += v;
      this.sumSq[k] += v * v;
    }
    this.count++;
    if (this.qTail < this.queue.length) this.queue[this.qTail++] = p;
  }

  /** Tolerance derived from the colour spread of what is already selected. */
  tolerance() {
    const n = this.count || 1;
    let variance = 0;
    for (let k = 0; k < 3; k++) {
      const mean = this.sum[k] / n;
      variance += Math.max(0, this.sumSq[k] / n - mean * mean);
    }
    return clamp(10 + Math.sqrt(variance / 3) * 2.2, 12, 70);
  }

  /** Bounded BFS; the frontier survives between pointer events. */
  grow(budget) {
    const d = this.img.data;
    const w = this.w;
    const h = this.h;
    const tol = this.tolerance();
    const localTol = tol * 0.75 + 2;
    const n = this.count || 1;
    const mr = this.sum[0] / n;
    const mg = this.sum[1] / n;
    const mb = this.sum[2] / n;
    const ma = this.sum[3] / n;
    let work = budget;

    while (this.qHead < this.qTail && work-- > 0) {
      const p = this.queue[this.qHead++];
      const pi = p * 4;
      const x = p % w;
      const y = (p / w) | 0;
      for (let k = 0; k < 4; k++) {
        let q;
        if (k === 0) { if (x === 0) continue; q = p - 1; }
        else if (k === 1) { if (x === w - 1) continue; q = p + 1; }
        else if (k === 2) { if (y === 0) continue; q = p - w; }
        else { if (y === h - 1) continue; q = p + w; }
        if (this.visited[q]) continue;
        const qi = q * 4;
        // Close to the region's average colour...
        let dm = Math.abs(d[qi] - mr);
        const dg = Math.abs(d[qi + 1] - mg);
        const db = Math.abs(d[qi + 2] - mb);
        const da = Math.abs(d[qi + 3] - ma);
        if (dg > dm) dm = dg;
        if (db > dm) dm = db;
        if (da > dm) dm = da;
        if (dm > tol) { this.visited[q] = 1; continue; }
        // ...and to its immediate neighbour, which stops growth at edges.
        const dp = channelDistance(d, qi, d[pi], d[pi + 1], d[pi + 2], d[pi + 3]);
        if (dp > localTol) { this.visited[q] = 1; continue; }
        this.accept(q);
      }
    }
  }

  /** Write the accumulated region into the document selection. */
  push(final) {
    const doc = this.doc;
    if (!doc) return;
    const n = this.w * this.h;
    const reg = this.region;
    const base = this.base;
    const out = this.work;
    if (this.mode === 'add') {
      for (let i = 0; i < n; i++) out[i] = reg[i] ? 255 : base ? base[i] : 0;
    } else if (this.mode === 'subtract') {
      for (let i = 0; i < n; i++) out[i] = reg[i] ? 0 : base ? base[i] : 0;
    } else {
      for (let i = 0; i < n; i++) out[i] = reg[i] ? 255 : 0;
    }
    const sel = doc.selection;
    if (final) {
      sel.combine(out, 'replace'); // copies, and drops an all-empty mask
      const f = this.featherPx();
      if (f > 0) sel.feather(f);
      doc.emit('selection-change');
      doc.commit('Quick Selection');
      return;
    }
    sel.set(out);
    doc.emit('selection-change');
    doc.touch('quick-select');
  }

  selectionModifyItems() {
    return colorSelectionModifyItems();
  }

  drawOverlay(ctx, view) {
    if (!this.cursor) return;
    const c = view.toScreen(this.cursor.x, this.cursor.y);
    const r = ((Number(this.state.size) || 30) / 2) * view.scale;
    if (r < 1) return;
    ctx.save();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c.x, c.y, r - 1, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.stroke();
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ */
/* Select > Grow / Similar                                             */
/* ------------------------------------------------------------------ */

/**
 * Extend the selection into contiguous neighbours whose colour is within
 * `tolerance` of the selected pixel they touch.
 * @param {import('../core/document.js').PikaDocument} doc
 * @param {number} tolerance 0..255
 * @returns {boolean} true when the selection changed
 */
export function growSelection(doc, tolerance = 32) {
  if (!doc || !doc.selection.active) return false;
  const sel = doc.selection;
  const img = sourceImageData(doc, true);
  if (!img) return false;
  const w = img.width;
  const h = img.height;
  const d = img.data;
  const n = w * h;
  const mask = new Uint8ClampedArray(sel.mask);
  const visited = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let p = 0; p < n; p++) {
    if (mask[p] > 127) {
      visited[p] = 1;
      queue[tail++] = p;
    }
  }
  if (!tail) return false;

  while (head < tail) {
    const p = queue[head++];
    const pi = p * 4;
    const x = p % w;
    const y = (p / w) | 0;
    for (let k = 0; k < 4; k++) {
      let q;
      if (k === 0) { if (x === 0) continue; q = p - 1; }
      else if (k === 1) { if (x === w - 1) continue; q = p + 1; }
      else if (k === 2) { if (y === 0) continue; q = p - w; }
      else { if (y === h - 1) continue; q = p + w; }
      if (visited[q]) continue;
      visited[q] = 1;
      const qi = q * 4;
      if (channelDistance(d, qi, d[pi], d[pi + 1], d[pi + 2], d[pi + 3]) > tolerance) continue;
      mask[q] = 255;
      queue[tail++] = q;
    }
  }
  sel.combine(mask, 'replace');
  doc.emit('selection-change');
  doc.commit('Grow');
  return true;
}

/**
 * Select every pixel in the image whose colour matches one already selected,
 * contiguous or not.
 * @param {import('../core/document.js').PikaDocument} doc
 * @param {number} tolerance 0..255
 * @returns {boolean} true when the selection changed
 */
export function similarSelection(doc, tolerance = 32) {
  if (!doc || !doc.selection.active) return false;
  const sel = doc.selection;
  const img = sourceImageData(doc, true);
  if (!img) return false;
  const w = img.width;
  const h = img.height;
  const d = img.data;
  const n = w * h;
  const src = sel.mask;

  // Occupancy of the selected colours in a 32^3 RGB grid (8 levels per bin).
  const BINS = 32;
  const SHIFT = 3;
  let occ = new Uint8Array(BINS * BINS * BINS);
  let any = false;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (src[p] <= 127) continue;
    any = true;
    occ[((d[i] >> SHIFT) * BINS + (d[i + 1] >> SHIFT)) * BINS + (d[i + 2] >> SHIFT)] = 1;
  }
  if (!any) return false;

  // Dilate by the tolerance (Chebyshev), separably along each colour axis.
  const r = Math.min(BINS - 1, Math.ceil(tolerance / (1 << SHIFT)));
  if (r > 0) {
    for (let axis = 0; axis < 3; axis++) {
      const next = new Uint8Array(occ.length);
      for (let a = 0; a < BINS; a++) {
        for (let b = 0; b < BINS; b++) {
          for (let c = 0; c < BINS; c++) {
            let on = 0;
            for (let k = -r; k <= r && !on; k++) {
              const cc = c + k;
              if (cc < 0 || cc >= BINS) continue;
              const idx = axis === 0 ? (cc * BINS + a) * BINS + b
                : axis === 1 ? (a * BINS + cc) * BINS + b
                  : (a * BINS + b) * BINS + cc;
              if (occ[idx]) on = 1;
            }
            const oidx = axis === 0 ? (c * BINS + a) * BINS + b
              : axis === 1 ? (a * BINS + c) * BINS + b
                : (a * BINS + b) * BINS + c;
            next[oidx] = on;
          }
        }
      }
      occ = next;
    }
  }

  const out = new Uint8ClampedArray(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (occ[((d[i] >> SHIFT) * BINS + (d[i + 1] >> SHIFT)) * BINS + (d[i + 2] >> SHIFT)]) out[p] = 255;
  }
  sel.combine(out, 'replace');
  doc.emit('selection-change');
  doc.commit('Similar');
  return true;
}

registerTool(new QuickSelectTool());
registerTool(new MagicWandTool());
