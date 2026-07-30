import { createCanvas, ctx2dRead, clamp } from '../core/util.js';
import { getComposite } from '../render/compositor.js';
import { app } from '../core/app.js';

/**
 * Histogram computation and drawing.
 *
 * Used as a backdrop by the Levels and Curves widgets, by Threshold and by the
 * Histogram panel. Computation always fills all four channels — the extra work
 * is a couple of array increments per pixel and it means one pass serves every
 * consumer.
 */

/** Largest edge a histogram source is downsampled to before counting. */
const SAMPLE_MAX = 420;

const CHANNEL_COLORS = {
  r: '#ff4d4d',
  g: '#3fd23f',
  b: '#5c9bff',
  l: '#c8c8c8',
};

/**
 * Count pixel values in an ImageData.
 * @param {ImageData} imageData
 * @param {'rgb'|'r'|'g'|'b'|'l'} [channel] which channel `max` is derived from
 * @returns {{r:Uint32Array,g:Uint32Array,b:Uint32Array,l:Uint32Array,max:number,count:number}}
 */
export function computeHistogram(imageData, channel = 'rgb') {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const l = new Uint32Array(256);
  let count = 0;
  if (imageData && imageData.data) {
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 8) continue;
      const R = d[i], G = d[i + 1], B = d[i + 2];
      r[R]++;
      g[G]++;
      b[B]++;
      // 77/150/29 ≈ 0.299/0.587/0.114 in 8.8 fixed point.
      l[(R * 77 + G * 150 + B * 29) >> 8]++;
      count++;
    }
  }
  const hist = { r, g, b, l, count, max: 0 };
  hist.max = histMax(hist, channel);
  return hist;
}

/** Peak bin count for a channel selector ('rgb' takes the max of R, G and B). */
export function histMax(hist, channel = 'rgb') {
  const lists =
    channel === 'rgb' || channel === 'all' ? [hist.r, hist.g, hist.b]
      : channel === 'l' || channel === 'luma' ? [hist.l]
        : hist[channel] ? [hist[channel]] : [hist.l];
  let max = 0;
  for (const arr of lists) for (let i = 0; i < 256; i++) if (arr[i] > max) max = arr[i];
  return max;
}

/** An empty histogram — handy when there is no document yet. */
export function emptyHistogram() {
  return { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), l: new Uint32Array(256), count: 0, max: 0 };
}

/**
 * Draw a histogram into a canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {object} hist result of {@link computeHistogram}
 * @param {{channel?:string, background?:string, color?:string, fill?:number,
 *          log?:boolean, rect?:{x,y,width,height}, clear?:boolean}} [opts]
 */
export function drawHistogram(canvas, hist, opts = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = canvas._pkDpr || 1;
  const rect = opts.rect || { x: 0, y: 0, width: canvas.width / dpr, height: canvas.height / dpr };
  const channel = opts.channel || 'l';
  if (opts.clear !== false && !opts.rect) ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  }
  if (!hist || !hist.count) return;

  const channels = channel === 'rgb' || channel === 'all' ? ['r', 'g', 'b'] : [channel === 'luma' ? 'l' : channel];
  const peak = Math.max(1, histMax(hist, channel));
  const scaleY = (v) => {
    if (!v) return 0;
    if (opts.log) return Math.log(1 + v) / Math.log(1 + peak);
    return v / peak;
  };

  ctx.save();
  if (channels.length > 1) ctx.globalCompositeOperation = 'lighter';
  for (const ch of channels) {
    const arr = hist[ch];
    ctx.fillStyle = opts.color && channels.length === 1 ? opts.color : CHANNEL_COLORS[ch] || '#c8c8c8';
    ctx.globalAlpha = opts.fill == null ? (channels.length > 1 ? 0.55 : 0.85) : opts.fill;
    ctx.beginPath();
    ctx.moveTo(rect.x, rect.y + rect.height);
    for (let i = 0; i < 256; i++) {
      const h = scaleY(arr[i]) * rect.height;
      const x = rect.x + (i / 255) * rect.width;
      ctx.lineTo(x, rect.y + rect.height - h);
    }
    ctx.lineTo(rect.x + rect.width, rect.y + rect.height);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Size a canvas for the device pixel ratio and return its 2d context. */
export function setupHiDPI(canvas, cssWidth, cssHeight) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas._pkDpr = dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** Downsample a canvas so histogram counting stays cheap on large documents. */
function sampleCanvas(canvas) {
  const big = Math.max(canvas.width, canvas.height);
  if (big <= SAMPLE_MAX) return canvas;
  const s = SAMPLE_MAX / big;
  const out = createCanvas(Math.max(1, Math.round(canvas.width * s)), Math.max(1, Math.round(canvas.height * s)));
  const c = out.getContext('2d');
  c.imageSmoothingEnabled = true;
  c.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

/** @returns {object} histogram of an arbitrary canvas (downsampled). */
export function histogramForCanvas(canvas, channel = 'rgb') {
  if (!canvas || !canvas.width || !canvas.height) return emptyHistogram();
  const src = sampleCanvas(canvas);
  const data = ctx2dRead(src).getImageData(0, 0, src.width, src.height);
  return computeHistogram(data, channel);
}

const docCache = new WeakMap();

/**
 * Histogram of a document's flattened composite. Cached against the composite
 * canvas identity, so it is recomputed only when the document re-composites.
 * @param {object} doc
 */
export function histogramForDocument(doc, channel = 'rgb') {
  if (!doc) return emptyHistogram();
  const composite = getComposite(doc);
  const cached = docCache.get(composite);
  if (cached) return cached;
  const hist = histogramForCanvas(composite, channel);
  docCache.set(composite, hist);
  return hist;
}

/**
 * Best available histogram for whatever the user is about to adjust: the
 * active layer's own pixels when it has some, otherwise the composite.
 */
export function currentHistogram() {
  const doc = app.activeDoc;
  if (!doc) return emptyHistogram();
  const layer = doc.activeLayer();
  if (layer && layer.canvas && !layer.editingMask) {
    const cached = docCache.get(layer.canvas);
    if (cached) return cached;
    const hist = histogramForCanvas(layer.canvas);
    // Layer canvases are copy-on-write, so identity keying stays correct.
    docCache.set(layer.canvas, hist);
    if (hist.count > 0) return hist;
  }
  return histogramForDocument(doc);
}

/**
 * Clip points for auto adjustments: the values below/above which `clipPct` of
 * the pixels lie.
 * @param {Uint32Array} bins
 * @param {number} clipPct percent of the total pixel count to discard per end
 * @returns {{lo:number, hi:number}}
 */
export function clipPoints(bins, clipPct = 0.1) {
  let total = 0;
  for (let i = 0; i < 256; i++) total += bins[i];
  if (!total) return { lo: 0, hi: 255 };
  const budget = (total * clipPct) / 100;
  let lo = 0, hi = 255, acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += bins[i];
    if (acc > budget) { lo = i; break; }
  }
  acc = 0;
  for (let i = 255; i >= 0; i--) {
    acc += bins[i];
    if (acc > budget) { hi = i; break; }
  }
  if (hi <= lo) { lo = 0; hi = 255; }
  return { lo: clamp(lo, 0, 254), hi: clamp(hi, 1, 255) };
}

export { CHANNEL_COLORS };
