import '../ui/dialogs/dialogs.css';
import { app } from '../core/app.js';
import { createCanvas, cloneCanvas, el, clamp, clamp255, deg2rad, uid } from '../core/util.js';
import { Selection } from '../core/selection.js';
import { Layer, LayerType } from '../core/layer.js';
import { PikaDocument } from '../core/document.js';
import { compositeDocument, flattenLayers, setLayerPreview } from '../render/compositor.js';
import { BLEND_MODES, isNativeBlend, gcoFor, blendCPU } from '../core/blend.js';
import { rgb2hsv, luminance } from '../core/color.js';
import { Dialog, paramDialog, confirmDialog } from '../ui/dialog.js';

/**
 * Pixel-level implementations behind the Image, Edit and Layer menus.
 *
 * Kept out of `definitions.js` so the command table stays readable: every
 * function here is a self-contained document operation that records its own
 * history entry.
 */

const BLEND_OPTIONS = BLEND_MODES.map((m) => ({ value: m.id, label: m.name }));

/* ------------------------------------------------------------------ */
/* Small shared helpers                                                */
/* ------------------------------------------------------------------ */

function readPixels(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
}

function toCanvas(imageData) {
  const cv = createCanvas(imageData.width, imageData.height);
  cv.getContext('2d').putImageData(imageData, 0, 0);
  return cv;
}

/** Blend `top` over `base` into a new canvas. */
function blendCanvases(base, top, mode, opacity) {
  const out = createCanvas(base.width, base.height);
  const c = out.getContext('2d');
  c.drawImage(base, 0, 0);
  if (opacity <= 0) return out;
  if (isNativeBlend(mode)) {
    c.save();
    c.globalAlpha = opacity;
    c.globalCompositeOperation = gcoFor(mode);
    c.drawImage(top, 0, 0);
    c.restore();
    return out;
  }
  const b = c.getImageData(0, 0, out.width, out.height);
  const t = top.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, out.width, out.height);
  blendCPU(b, t, mode, opacity);
  c.putImageData(b, 0, 0);
  return out;
}

function everyRasterLayer(doc) {
  return doc.flatLayers().filter((l) => l.canvas);
}

/* ------------------------------------------------------------------ */
/* Image > Mode                                                        */
/* ------------------------------------------------------------------ */

/** Image > Mode > RGB Color. */
export function convertToRGB(doc) {
  if (doc.colorMode === 'rgb') return;
  doc.colorMode = 'rgb';
  doc.commit('RGB Color');
  app.toast('Document mode set to RGB. Colour lost in a previous conversion is not restored.');
}

/** Image > Mode > Grayscale — desaturates every layer. */
export function convertToGrayscale(doc) {
  for (const l of everyRasterLayer(doc)) {
    l.beginEdit();
    const img = readPixels(l.canvas);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const g = clamp255(Math.round(luminance(d[i], d[i + 1], d[i + 2])));
      d[i] = d[i + 1] = d[i + 2] = g;
    }
    l.canvas = toCanvas(img);
  }
  doc.colorMode = 'grayscale';
  doc.commit('Grayscale');
}

const BAYER8 = [
  [0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21],
];

/** Image > Mode > Bitmap — flattens to a single 1-bit layer. */
export async function convertToBitmap(doc) {
  const opts = await paramDialog({
    title: 'Bitmap',
    width: 380,
    preview: false,
    state: { method: 'threshold', threshold: 128 },
    params: [
      {
        key: 'method', label: 'Method', type: 'select',
        options: [
          { value: 'threshold', label: '50% Threshold' },
          { value: 'pattern', label: 'Pattern Dither' },
          { value: 'diffusion', label: 'Diffusion Dither' },
        ],
      },
      { key: 'threshold', label: 'Threshold', type: 'slider', min: 1, max: 254, step: 1, when: (s) => s.method === 'threshold' },
      { type: 'label', label: 'Bitmap mode flattens the document to a single black-and-white layer.' },
    ],
  });
  if (!opts) return;

  const w = doc.width, h = doc.height;
  const flat = createCanvas(w, h);
  const fc = flat.getContext('2d');
  fc.fillStyle = '#ffffff';
  fc.fillRect(0, 0, w, h);
  fc.drawImage(compositeDocument(doc), 0, 0);

  const img = readPixels(flat);
  const d = img.data;
  const grey = new Float32Array(w * h);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) grey[p] = luminance(d[i], d[i + 1], d[i + 2]);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      let on;
      if (opts.method === 'pattern') {
        on = grey[p] > (BAYER8[y & 7][x & 7] / 64) * 255;
      } else if (opts.method === 'diffusion') {
        on = grey[p] > 127.5;
        const err = grey[p] - (on ? 255 : 0);
        if (x + 1 < w) grey[p + 1] += (err * 7) / 16;
        if (y + 1 < h) {
          if (x > 0) grey[p + w - 1] += (err * 3) / 16;
          grey[p + w] += (err * 5) / 16;
          if (x + 1 < w) grey[p + w + 1] += err / 16;
        }
      } else {
        on = grey[p] > opts.threshold;
      }
      const i = p * 4;
      const v = on ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
  }

  const nl = new Layer({ type: LayerType.RASTER, name: 'Background', canvas: toCanvas(img), isBackground: true });
  doc.layers = [nl];
  doc.activeLayerId = nl.id;
  doc.selectedLayerIds = [nl.id];
  doc.colorMode = 'bitmap';
  doc.emit('structure');
  doc.commit('Bitmap');
}

/* ------------------------------------------------------------------ */
/* Image rotation                                                      */
/* ------------------------------------------------------------------ */

/** Image > Image Rotation > Arbitrary. Grows the canvas to fit the rotation. */
export function rotateDocumentArbitrary(doc, degrees) {
  const rad = deg2rad(degrees);
  const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
  const w = doc.width, h = doc.height;
  const nw = Math.max(1, Math.ceil(w * cos + h * sin));
  const nh = Math.max(1, Math.ceil(w * sin + h * cos));

  const spin = (src, fillWhite) => {
    const out = createCanvas(nw, nh);
    const c = out.getContext('2d');
    if (fillWhite) { c.fillStyle = '#ffffff'; c.fillRect(0, 0, nw, nh); }
    c.translate(nw / 2, nh / 2);
    c.rotate(rad);
    c.imageSmoothingQuality = 'high';
    c.drawImage(src, -w / 2, -h / 2);
    return out;
  };

  for (const l of doc.flatLayers()) {
    l.beginEdit();
    if (l.canvas) l.canvas = spin(l.canvas, false);
    if (l.mask) { l.mask = spin(l.mask, true); l.touchMask(); }
  }
  doc.width = nw;
  doc.height = nh;
  doc.selection = new Selection(nw, nh);
  doc.guides = [];
  doc.invalidate();
  doc.emit('resize');
  doc.commit(`Rotate ${degrees}°`);
}

/* ------------------------------------------------------------------ */
/* Layer transforms (Edit > Transform > Rotate 180 / Flip / …)         */
/* ------------------------------------------------------------------ */

function transformOneLayer(doc, layer, kind) {
  const w = doc.width, h = doc.height;
  // Layer buffers are document-sized, so the transform happens about the
  // document centre and anything pushed outside the canvas is clipped.
  const apply = (src) => {
    if (!src) return null;
    const out = createCanvas(w, h);
    const c = out.getContext('2d');
    c.translate(w / 2, h / 2);
    if (kind === 'cw') c.rotate(Math.PI / 2);
    else if (kind === 'ccw') c.rotate(-Math.PI / 2);
    else if (kind === '180') c.rotate(Math.PI);
    else if (kind === 'flip-h') c.scale(-1, 1);
    else if (kind === 'flip-v') c.scale(1, -1);
    c.imageSmoothingQuality = 'high';
    c.drawImage(src, -w / 2, -h / 2);
    return out;
  };
  layer.beginEdit();
  if (layer.canvas) layer.canvas = apply(layer.canvas);
  if (layer.mask && layer.maskLinked) { layer.mask = apply(layer.mask); layer.touchMask(); }
  if (layer.children) for (const child of layer.children) transformOneLayer(doc, child, kind);
}

/**
 * Edit > Transform > Rotate 180 / 90° CW / 90° CCW / Flip Horizontal / Vertical
 * applied to the selected layers.
 */
export function transformLayers(doc, layers, kind, label) {
  const list = (layers && layers.length ? layers : doc.selectedLayers()).filter(Boolean);
  if (!list.length) return;
  for (const l of list) transformOneLayer(doc, l, kind);
  doc.commit(label || 'Transform');
}

/** Move layer pixels (and the linked mask) by a whole number of pixels. */
export function translateLayers(doc, layers, dx, dy) {
  const shift = (layer) => {
    layer.beginEdit();
    const move = (src) => {
      if (!src) return null;
      const out = createCanvas(src.width, src.height);
      out.getContext('2d').drawImage(src, Math.round(dx), Math.round(dy));
      return out;
    };
    if (layer.canvas) layer.canvas = move(layer.canvas);
    if (layer.mask && layer.maskLinked) { layer.mask = move(layer.mask); layer.touchMask(); }
    if (layer.children) for (const c of layer.children) shift(c);
  };
  for (const l of layers) shift(l);
}

/* ------------------------------------------------------------------ */
/* Layer > Align & Distribute                                          */
/* ------------------------------------------------------------------ */

function layerBounds(doc, layer) {
  if (layer.type === LayerType.GROUP) {
    let box = null;
    for (const c of layer.children || []) {
      const b = layerBounds(doc, c);
      if (!b) continue;
      box = box ? {
        x: Math.min(box.x, b.x), y: Math.min(box.y, b.y),
        width: Math.max(box.x + box.width, b.x + b.width) - Math.min(box.x, b.x),
        height: Math.max(box.y + box.height, b.y + b.height) - Math.min(box.y, b.y),
      } : b;
    }
    return box;
  }
  return layer.contentBounds();
}

/**
 * Layer > Align. Aligns the selected layers to the active selection when there
 * is one, otherwise to their common bounding box.
 * @param {'left'|'center-h'|'right'|'top'|'center-v'|'bottom'} mode
 */
export function alignLayers(doc, mode) {
  const layers = doc.selectedLayers().filter((l) => !l.locked.all && !l.locked.position);
  if (!layers.length) { app.toast('Select the layers to align.'); return; }
  const boxes = layers.map((l) => ({ layer: l, box: layerBounds(doc, l) })).filter((e) => e.box);
  if (!boxes.length) { app.toast('The selected layers are empty.'); return; }

  let ref;
  if (doc.selection.active && doc.selection.bounds()) ref = doc.selection.bounds();
  else if (boxes.length > 1) {
    const x0 = Math.min(...boxes.map((b) => b.box.x));
    const y0 = Math.min(...boxes.map((b) => b.box.y));
    const x1 = Math.max(...boxes.map((b) => b.box.x + b.box.width));
    const y1 = Math.max(...boxes.map((b) => b.box.y + b.box.height));
    ref = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  } else {
    ref = { x: 0, y: 0, width: doc.width, height: doc.height };
  }

  for (const { layer, box } of boxes) {
    let dx = 0, dy = 0;
    switch (mode) {
      case 'left': dx = ref.x - box.x; break;
      case 'right': dx = ref.x + ref.width - (box.x + box.width); break;
      case 'center-h': dx = ref.x + ref.width / 2 - (box.x + box.width / 2); break;
      case 'top': dy = ref.y - box.y; break;
      case 'bottom': dy = ref.y + ref.height - (box.y + box.height); break;
      case 'center-v': dy = ref.y + ref.height / 2 - (box.y + box.height / 2); break;
      default: break;
    }
    if (dx || dy) translateLayers(doc, [layer], dx, dy);
  }
  doc.commit('Align Layers');
}

/**
 * Layer > Distribute — evens out the spacing between layer centres.
 * @param {'horizontal'|'vertical'} axis
 */
export function distributeLayers(doc, axis) {
  const entries = doc.selectedLayers()
    .filter((l) => !l.locked.all && !l.locked.position)
    .map((l) => ({ layer: l, box: layerBounds(doc, l) }))
    .filter((e) => e.box);
  if (entries.length < 3) { app.toast('Select at least three layers to distribute.'); return; }

  const centre = (b) => (axis === 'horizontal' ? b.x + b.width / 2 : b.y + b.height / 2);
  entries.sort((a, b) => centre(a.box) - centre(b.box));
  const first = centre(entries[0].box);
  const last = centre(entries[entries.length - 1].box);
  const step = (last - first) / (entries.length - 1);

  entries.forEach((e, i) => {
    if (i === 0 || i === entries.length - 1) return;
    const want = first + step * i;
    const delta = want - centre(e.box);
    if (Math.abs(delta) < 0.5) return;
    translateLayers(doc, [e.layer], axis === 'horizontal' ? delta : 0, axis === 'horizontal' ? 0 : delta);
  });
  doc.commit('Distribute Layers');
}

/* ------------------------------------------------------------------ */
/* Layer > Matting                                                     */
/* ------------------------------------------------------------------ */

/**
 * Layer > Matting > Defringe. Replaces the colour of partly transparent edge
 * pixels with the nearest solid pixel's colour, killing halos from a cut-out.
 */
export function defringe(doc, layer, width = 1) {
  const l = layer || doc.activeLayer();
  if (!l || !l.canvas) { app.toast('No pixel layer selected.'); return; }
  doc.beginEdit(l);
  const img = readPixels(l.canvas);
  const w = img.width, h = img.height, d = img.data;
  const src = new Uint8ClampedArray(d);
  const solid = (i) => src[i + 3] >= 250;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = src[i + 3];
      if (a === 0 || a >= 250) continue;
      let bestD = Infinity, bx = -1;
      for (let dy = -width; dy <= width; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -width; dx <= width; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = (yy * w + xx) * 4;
          if (!solid(j)) continue;
          const dist = dx * dx + dy * dy;
          if (dist < bestD) { bestD = dist; bx = j; }
        }
      }
      if (bx >= 0) {
        d[i] = src[bx];
        d[i + 1] = src[bx + 1];
        d[i + 2] = src[bx + 2];
      }
    }
  }
  l.canvas = toCanvas(img);
  doc.commit('Defringe');
}

/**
 * Layer > Matting > Remove Black/White Matte. Un-multiplies the matte colour
 * out of semi-transparent pixels.
 */
export function removeMatte(doc, layer, matte = 'white') {
  const l = layer || doc.activeLayer();
  if (!l || !l.canvas) { app.toast('No pixel layer selected.'); return; }
  const m = matte === 'black' ? 0 : 255;
  doc.beginEdit(l);
  const img = readPixels(l.canvas);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    if (a <= 0 || a >= 1) continue;
    for (let k = 0; k < 3; k++) d[i + k] = clamp255((d[i + k] - m * (1 - a)) / a);
  }
  l.canvas = toCanvas(img);
  doc.commit(matte === 'black' ? 'Remove Black Matte' : 'Remove White Matte');
}

/* ------------------------------------------------------------------ */
/* Edit > Fade                                                         */
/* ------------------------------------------------------------------ */

function findSnapshot(list, id) {
  for (const s of list || []) {
    if (s.id === id) return s;
    if (s.children) {
      const f = findSnapshot(s.children, id);
      if (f) return f;
    }
  }
  return null;
}

/** The layer's pixels one history step back, or null when they did not change. */
function previousPixels(doc, layer) {
  const hist = doc.history;
  if (!hist.canUndo || !layer) return null;
  const prev = hist.states[hist.index - 1];
  if (!prev) return null;
  const snap = findSnapshot(prev.state.layers, layer.id);
  if (!snap || !snap.canvas || !layer.canvas) return null;
  if (snap.canvas === layer.canvas) return null;
  if (snap.canvas.width !== layer.canvas.width || snap.canvas.height !== layer.canvas.height) return null;
  return snap.canvas;
}

/** True when Edit > Fade can do something meaningful right now. */
export function canFade(doc) {
  if (!doc) return false;
  return !!previousPixels(doc, doc.activeLayer());
}

/** Edit > Fade — re-blends the last pixel operation against what it replaced. */
export async function showFadeDialog(doc) {
  const layer = doc.activeLayer();
  const before = previousPixels(doc, layer);
  if (!before) { app.toast('There is nothing to fade.'); return; }
  const after = layer.canvas;
  const label = doc.history.states[doc.history.index].label;

  const build = (s) => blendCanvases(before, after, s.blendMode, s.opacity / 100);

  const result = await paramDialog({
    title: `Fade ${label}`,
    width: 380,
    state: { opacity: 100, blendMode: 'normal' },
    params: [
      { key: 'opacity', label: 'Opacity', type: 'slider', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'blendMode', label: 'Mode', type: 'select', options: BLEND_OPTIONS },
    ],
    onPreview: (s) => {
      setLayerPreview(layer.id, s ? build(s) : null);
      doc.touch('preview');
    },
  });

  setLayerPreview(layer.id, null);
  doc.touch('preview');
  if (!result) return;
  const faded = build(result);
  doc.beginEdit(layer);
  layer.canvas = faded;
  doc.commit(`Fade ${label}`);
}

/* ------------------------------------------------------------------ */
/* Image > Apply Image and Calculations                                */
/* ------------------------------------------------------------------ */

const CHANNELS = [
  { value: 'rgb', label: 'RGB' },
  { value: 'red', label: 'Red' },
  { value: 'green', label: 'Green' },
  { value: 'blue', label: 'Blue' },
  { value: 'gray', label: 'Gray' },
  { value: 'alpha', label: 'Transparency' },
];

function layerOptions(doc, extra = []) {
  return [
    { value: '__merged__', label: 'Merged' },
    ...extra,
    ...doc.flatLayers().filter((l) => l.canvas || l.type === LayerType.GROUP).map((l) => ({ value: l.id, label: l.name })),
  ];
}

function sourceCanvasFor(doc, id) {
  if (id === '__merged__') return compositeDocument(doc);
  const l = doc.findLayer(id);
  if (!l) return compositeDocument(doc);
  if (l.type === LayerType.GROUP) return flattenLayers(doc, [l]);
  return l.canvas ? cloneCanvas(l.canvas) : createCanvas(doc.width, doc.height);
}

/** Extract one channel as a canvas, optionally inverted. */
function channelCanvas(src, channel, invert) {
  const img = readPixels(src);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2];
    if (channel === 'red') r = g = b = d[i];
    else if (channel === 'green') r = g = b = d[i + 1];
    else if (channel === 'blue') r = g = b = d[i + 2];
    else if (channel === 'gray') r = g = b = clamp255(Math.round(luminance(d[i], d[i + 1], d[i + 2])));
    else if (channel === 'alpha') { r = g = b = d[i + 3]; d[i + 3] = 255; }
    if (invert) { r = 255 - r; g = 255 - g; b = 255 - b; }
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  return toCanvas(img);
}

/** Image > Apply Image — blends another layer/channel onto the active layer. */
export async function showApplyImageDialog(doc) {
  const target = doc.activeLayer();
  if (!target || !target.canvas) { app.toast('Apply Image needs a pixel layer.'); return; }

  const build = (s) => {
    const src = channelCanvas(sourceCanvasFor(doc, s.source), s.channel, s.invert);
    let out = blendCanvases(target.canvas, src, s.blendMode, s.opacity / 100);
    if (s.useSelection && doc.selection.active) {
      const masked = createCanvas(doc.width, doc.height);
      const mc = masked.getContext('2d');
      mc.drawImage(out, 0, 0);
      mc.globalCompositeOperation = 'destination-in';
      mc.drawImage(doc.selection.toAlphaCanvas(), 0, 0);
      mc.globalCompositeOperation = 'destination-over';
      mc.drawImage(target.canvas, 0, 0);
      out = masked;
    }
    if (s.preserveTransparency) {
      const kept = createCanvas(doc.width, doc.height);
      const kc = kept.getContext('2d');
      kc.drawImage(out, 0, 0);
      kc.globalCompositeOperation = 'destination-in';
      kc.drawImage(target.canvas, 0, 0);
      out = kept;
    }
    return out;
  };

  const result = await paramDialog({
    title: 'Apply Image',
    width: 420,
    state: {
      source: '__merged__', channel: 'rgb', invert: false,
      blendMode: 'multiply', opacity: 100,
      preserveTransparency: true, useSelection: doc.selection.active,
    },
    params: [
      { key: 'source', label: 'Source Layer', type: 'select', options: layerOptions(doc) },
      { key: 'channel', label: 'Channel', type: 'select', options: CHANNELS },
      { key: 'invert', label: 'Invert', type: 'checkbox' },
      { type: 'separator' },
      { key: 'blendMode', label: 'Blending', type: 'select', options: BLEND_OPTIONS },
      { key: 'opacity', label: 'Opacity', type: 'slider', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'preserveTransparency', label: 'Preserve Transparency', type: 'checkbox' },
      { key: 'useSelection', label: 'Limit to Selection', type: 'checkbox' },
    ],
    onPreview: (s) => {
      setLayerPreview(target.id, s ? build(s) : null);
      doc.touch('preview');
    },
  });

  setLayerPreview(target.id, null);
  doc.touch('preview');
  if (!result) return;
  doc.beginEdit(target);
  target.canvas = build(result);
  doc.commit('Apply Image');
}

/** Greyscale coverage mask from a canvas' luminance. */
function canvasToMask(canvas) {
  const img = readPixels(canvas);
  const d = img.data;
  const mask = new Uint8ClampedArray(canvas.width * canvas.height);
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    mask[p] = clamp255(luminance(d[i], d[i + 1], d[i + 2]) * (d[i + 3] / 255));
  }
  return mask;
}

/**
 * Image > Calculations — blends two single channels and sends the greyscale
 * result to a new document, a new alpha channel or the selection.
 */
export async function showCalculationsDialog(doc) {
  const build = (s) => {
    const a = channelCanvas(sourceCanvasFor(doc, s.source1), s.channel1, s.invert1);
    const b = channelCanvas(sourceCanvasFor(doc, s.source2), s.channel2, s.invert2);
    // Source 2 is the backdrop, Source 1 is blended on top (as in Photoshop).
    const blended = blendCanvases(b, a, s.blendMode, s.opacity / 100);
    return channelCanvas(blended, 'gray', false);
  };

  const result = await paramDialog({
    title: 'Calculations',
    width: 430,
    preview: false,
    state: {
      source1: '__merged__', channel1: 'gray', invert1: false,
      source2: '__merged__', channel2: 'gray', invert2: false,
      blendMode: 'multiply', opacity: 100, output: 'channel',
    },
    params: [
      { type: 'label', label: 'Source 1' },
      { key: 'source1', label: 'Layer', type: 'select', options: layerOptions(doc) },
      { key: 'channel1', label: 'Channel', type: 'select', options: CHANNELS },
      { key: 'invert1', label: 'Invert', type: 'checkbox' },
      { type: 'separator' },
      { type: 'label', label: 'Source 2' },
      { key: 'source2', label: 'Layer', type: 'select', options: layerOptions(doc) },
      { key: 'channel2', label: 'Channel', type: 'select', options: CHANNELS },
      { key: 'invert2', label: 'Invert', type: 'checkbox' },
      { type: 'separator' },
      { key: 'blendMode', label: 'Blending', type: 'select', options: BLEND_OPTIONS },
      { key: 'opacity', label: 'Opacity', type: 'slider', min: 0, max: 100, step: 1, unit: '%' },
      {
        key: 'output', label: 'Result', type: 'select',
        options: [
          { value: 'channel', label: 'New Channel' },
          { value: 'selection', label: 'Selection' },
          { value: 'document', label: 'New Document' },
        ],
      },
    ],
  });
  if (!result) return;

  const grey = build(result);
  if (result.output === 'document') {
    const nd = new PikaDocument({ width: doc.width, height: doc.height, name: `${doc.name} Calculation` });
    const nl = new Layer({ type: LayerType.RASTER, name: 'Background', canvas: grey, isBackground: true });
    nd.layers.push(nl);
    nd.activeLayerId = nl.id;
    nd.selectedLayerIds = [nl.id];
    nd.history.clear('Calculations');
    app.addDocument(nd);
    return;
  }
  const mask = canvasToMask(grey);
  if (result.output === 'selection') {
    doc.selection.set(mask);
    doc.emit('selection-change');
    doc.commit('Calculations');
    return;
  }
  doc.alphaChannels.push({
    id: uid('chan'),
    name: `Alpha ${doc.alphaChannels.length + 1}`,
    width: doc.width,
    height: doc.height,
    mask,
    canvas: grey,
  });
  doc.commit('Calculations');
  app.toast('Result stored as a new alpha channel.', 'ok');
}

/* ------------------------------------------------------------------ */
/* Select > Color Range                                                */
/* ------------------------------------------------------------------ */

const RANGE_KINDS = [
  { value: 'sampled', label: 'Sampled Colors' },
  { value: 'reds', label: 'Reds' },
  { value: 'yellows', label: 'Yellows' },
  { value: 'greens', label: 'Greens' },
  { value: 'cyans', label: 'Cyans' },
  { value: 'blues', label: 'Blues' },
  { value: 'magentas', label: 'Magentas' },
  { value: 'highlights', label: 'Highlights' },
  { value: 'midtones', label: 'Midtones' },
  { value: 'shadows', label: 'Shadows' },
];

const HUE_CENTRES = { reds: 0, yellows: 60, greens: 120, cyans: 180, blues: 240, magentas: 300 };

/** Build a coverage mask for the Color Range settings. */
function colorRangeMask(img, opts) {
  const { width: w, height: h, data: d } = img;
  const out = new Uint8ClampedArray(w * h);
  const fuzz = Math.max(1, opts.fuzziness) * 2.2;
  const samples = opts.samples;
  const localR = opts.localized ? Math.max(8, (opts.range / 100) * Math.max(w, h)) : 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const i = p * 4;
      const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
      let cov = 0;

      if (opts.kind === 'sampled') {
        let best = Infinity;
        for (const s of samples) {
          const dr = r - s.r, dg = g - s.g, db = b - s.b;
          const dist = Math.sqrt(dr * dr + dg * dg + db * db);
          if (dist < best) best = dist;
        }
        cov = best >= fuzz ? 0 : 255 * (1 - best / fuzz);
      } else if (opts.kind === 'highlights' || opts.kind === 'midtones' || opts.kind === 'shadows') {
        const l = luminance(r, g, b) / 255;
        const centre = opts.kind === 'highlights' ? 1 : opts.kind === 'shadows' ? 0 : 0.5;
        const halfWidth = 0.25 + (opts.fuzziness / 200) * 0.5;
        const dist = Math.abs(l - centre);
        cov = dist >= halfWidth ? 0 : 255 * (1 - dist / halfWidth);
      } else {
        const hsv = rgb2hsv(r, g, b);
        const centre = HUE_CENTRES[opts.kind];
        let dh = Math.abs(hsv.h - centre);
        if (dh > 180) dh = 360 - dh;
        const halfWidth = 25 + (opts.fuzziness / 200) * 45;
        cov = dh >= halfWidth ? 0 : 255 * (1 - dh / halfWidth) * Math.min(1, hsv.s * 2.5) * Math.min(1, hsv.v * 2.5);
      }

      if (cov > 0 && localR > 0 && samples.length) {
        let nearest = Infinity;
        for (const s of samples) {
          if (s.x == null) continue;
          const dx = x - s.x, dy = y - s.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < nearest) nearest = dist;
        }
        if (nearest !== Infinity) cov *= nearest >= localR ? 0 : 1 - nearest / localR;
      }

      out[p] = clamp255(cov * (a / 255));
    }
  }
  if (opts.invert) for (let i = 0; i < out.length; i++) out[i] = 255 - out[i];
  return out;
}

/** Select > Color Range… */
export async function showColorRangeDialog(doc) {
  const source = compositeDocument(doc);
  const full = readPixels(source);

  // Preview and mask evaluation run on a downscaled proxy for responsiveness.
  const maxSide = 420;
  const scale = Math.min(1, maxSide / Math.max(doc.width, doc.height));
  const pw = Math.max(1, Math.round(doc.width * scale));
  const ph = Math.max(1, Math.round(doc.height * scale));
  const proxy = createCanvas(pw, ph);
  const proxyCtx = proxy.getContext('2d', { willReadFrequently: true });
  proxyCtx.drawImage(source, 0, 0, pw, ph);
  const proxyImg = proxyCtx.getImageData(0, 0, pw, ph);

  const state = {
    kind: 'sampled',
    fuzziness: 40,
    localized: false,
    range: 20,
    invert: false,
    show: 'selection',
    samples: [{ r: 128, g: 128, b: 128, x: null, y: null }],
  };

  const dlg = new Dialog({ title: 'Color Range', width: 520, className: 'pkd-colorrange' });

  const kindSelect = el('select.pk-select', {}, ...RANGE_KINDS.map((k) => el('option', { value: k.value, text: k.label })));
  const fuzzRange = el('input.pk-range', { type: 'range', min: 0, max: 200, step: 1, value: state.fuzziness });
  const fuzzNum = el('input.pk-num', { type: 'number', min: 0, max: 200, step: 1, value: state.fuzziness });
  const localizedInput = el('input', { type: 'checkbox' });
  const rangeRow = el('div.pk-field');
  const rangeInput = el('input.pk-range', { type: 'range', min: 1, max: 100, step: 1, value: state.range });
  rangeRow.append(el('label', { text: 'Range' }), rangeInput);
  const invertInput = el('input', { type: 'checkbox' });
  const showSelect = el('select.pk-select', {},
    el('option', { value: 'selection', text: 'Selection' }),
    el('option', { value: 'image', text: 'Image' }));
  const swatchRow = el('div.pkd-row');
  const previewBox = el('div.pkd-preview', { style: { height: `${Math.min(260, ph)}px`, cursor: 'crosshair' } });
  const previewCanvas = el('canvas', { width: pw, height: ph });
  previewBox.appendChild(previewCanvas);
  const hint = el('div.pkd-note', { text: 'Click the preview to sample a colour. Shift-click adds, Alt-click removes.' });

  let maskCache = null;

  const currentOpts = () => ({
    kind: state.kind,
    fuzziness: state.fuzziness,
    localized: state.localized,
    range: state.range,
    invert: state.invert,
    samples: state.samples,
  });

  function scaledSamples(f) {
    return state.samples.map((s) => ({ ...s, x: s.x == null ? null : s.x * f, y: s.y == null ? null : s.y * f }));
  }

  function refresh() {
    fuzzRange.value = state.fuzziness;
    fuzzNum.value = state.fuzziness;
    localizedInput.checked = state.localized;
    invertInput.checked = state.invert;
    rangeRow.style.display = state.localized ? '' : 'none';
    kindSelect.value = state.kind;
    showSelect.value = state.show;

    swatchRow.replaceChildren(
      ...state.samples.map((s, i) =>
        el('button.pk-color-swatch', {
          type: 'button',
          title: `Remove sample ${i + 1}`,
          style: { background: `rgb(${s.r},${s.g},${s.b})` },
          onclick: () => {
            if (state.samples.length > 1) {
              state.samples.splice(i, 1);
              refresh();
            }
          },
        })
      ),
      el('span.pk-hint', { text: `${state.samples.length} sample${state.samples.length === 1 ? '' : 's'}` })
    );

    maskCache = colorRangeMask(proxyImg, { ...currentOpts(), samples: scaledSamples(scale) });
    const c = previewCanvas.getContext('2d');
    if (state.show === 'image') {
      c.clearRect(0, 0, pw, ph);
      c.drawImage(proxy, 0, 0);
      const overlay = new ImageData(pw, ph);
      for (let p = 0, i = 0; p < pw * ph; p++, i += 4) {
        overlay.data[i] = 255;
        overlay.data[i + 3] = 255 - maskCache[p];
      }
      const ov = toCanvas(overlay);
      c.globalAlpha = 0.45;
      c.drawImage(ov, 0, 0);
      c.globalAlpha = 1;
    } else {
      const img = new ImageData(pw, ph);
      for (let p = 0, i = 0; p < pw * ph; p++, i += 4) {
        img.data[i] = img.data[i + 1] = img.data[i + 2] = maskCache[p];
        img.data[i + 3] = 255;
      }
      c.putImageData(img, 0, 0);
    }
  }

  previewCanvas.addEventListener('mousedown', (e) => {
    const r = previewCanvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * pw);
    const y = Math.floor(((e.clientY - r.top) / r.height) * ph);
    if (x < 0 || y < 0 || x >= pw || y >= ph) return;
    const i = (y * pw + x) * 4;
    const sample = {
      r: proxyImg.data[i], g: proxyImg.data[i + 1], b: proxyImg.data[i + 2],
      x: x / scale, y: y / scale,
    };
    if (e.altKey) {
      if (state.samples.length > 1) state.samples.pop();
    } else if (e.shiftKey) {
      state.samples.push(sample);
    } else {
      state.samples = [sample];
    }
    state.kind = 'sampled';
    refresh();
  });

  kindSelect.addEventListener('change', () => { state.kind = kindSelect.value; refresh(); });
  fuzzRange.addEventListener('input', () => { state.fuzziness = Number(fuzzRange.value); refresh(); });
  fuzzNum.addEventListener('input', () => {
    const v = clamp(Number(fuzzNum.value) || 0, 0, 200);
    state.fuzziness = v;
    refresh();
  });
  localizedInput.addEventListener('change', () => { state.localized = localizedInput.checked; refresh(); });
  rangeInput.addEventListener('input', () => { state.range = Number(rangeInput.value); refresh(); });
  invertInput.addEventListener('change', () => { state.invert = invertInput.checked; refresh(); });
  showSelect.addEventListener('change', () => { state.show = showSelect.value; refresh(); });

  dlg.setBody(
    el('div.pkd-cols', {},
      el('div.pkd-col.grow', {},
        el('div.pk-field', {}, el('label', { text: 'Select' }), kindSelect),
        el('div.pk-field', {}, el('label', { text: 'Fuzziness' }), el('div.pk-slider-row', {}, fuzzRange, fuzzNum)),
        el('label.pk-check', {}, localizedInput, el('span', { text: 'Localized Color Clusters' })),
        rangeRow,
        el('label.pk-check', {}, invertInput, el('span', { text: 'Invert' })),
        el('div.pk-field', {}, el('label', { text: 'Selection Preview' }), showSelect),
        swatchRow,
        hint
      ),
      el('div.pkd-col', { style: { flex: '0 0 230px' } }, previewBox)
    )
  );

  dlg.setButtons([
    { label: 'Cancel', value: null, subtle: true },
    { label: 'OK', primary: true, onClick: (d) => { d.close({ ...currentOpts(), samples: [...state.samples] }); return false; } },
  ]);

  refresh();
  const result = await dlg.open();
  if (!result) return;

  await app.busy('Color Range', async () => {
    const mask = colorRangeMask(full, result);
    let any = false;
    for (let i = 0; i < mask.length; i++) if (mask[i] !== 0) { any = true; break; }
    if (!any) {
      app.toast('No pixels matched — try a higher fuzziness.', 'warn');
      return;
    }
    doc.selection.set(mask);
    doc.emit('selection-change');
    doc.commit('Color Range');
  });
}

/* ------------------------------------------------------------------ */
/* Image > Duplicate                                                   */
/* ------------------------------------------------------------------ */

/** Image > Duplicate — a full independent copy of the document. */
export function duplicateDocument(doc, name) {
  const copy = new PikaDocument({ width: doc.width, height: doc.height, name: name || `${doc.name} copy`, resolution: doc.resolution });
  copy.colorMode = doc.colorMode;
  copy.layers = doc.layers.map((l) => l.clone(true));
  for (const l of copy.layers) l.parent = null;
  const first = copy.flatLayers()[0];
  copy.activeLayerId = first ? first.id : null;
  copy.selectedLayerIds = first ? [first.id] : [];
  if (doc.selection.mask) {
    copy.selection.set(new Uint8ClampedArray(doc.selection.mask));
  }
  copy.guides = [...doc.guides];
  copy.alphaChannels = doc.alphaChannels.map((c) => ({ ...c }));
  copy.paths = structuredClone(doc.paths);
  copy.history.clear('Duplicate');
  app.addDocument(copy);
  return copy;
}

/* ------------------------------------------------------------------ */
/* File > Print                                                        */
/* ------------------------------------------------------------------ */

/** File > Print — hands the flattened composite to the browser print dialog. */
export function printDocument(doc) {
  const data = compositeDocument(doc).toDataURL('image/png');
  const frame = el('iframe', {
    style: { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0', visibility: 'hidden' },
  });
  document.body.appendChild(frame);
  const win = frame.contentWindow;
  win.document.open();
  win.document.write(
    `<!doctype html><title>${doc.name}</title>` +
    '<style>@page{margin:12mm}html,body{margin:0;padding:0}img{max-width:100%;max-height:100vh;display:block;margin:auto}</style>' +
    `<img src="${data}">`
  );
  win.document.close();
  const go = () => {
    win.focus();
    win.print();
    setTimeout(() => frame.remove(), 1500);
  };
  const img = win.document.querySelector('img');
  if (img && !img.complete) img.onload = go;
  else setTimeout(go, 120);
}

/* ------------------------------------------------------------------ */
/* Image > Trim options                                                */
/* ------------------------------------------------------------------ */

/** Image > Trim… — asks which edges/colour to trim, then crops. */
export async function showTrimDialog(doc, trimFn) {
  const result = await paramDialog({
    title: 'Trim',
    width: 340,
    preview: false,
    state: { mode: 'transparent' },
    params: [
      {
        key: 'mode', label: 'Based On', type: 'radio',
        options: [
          { value: 'transparent', label: 'Transparent Pixels' },
          { value: 'top-left', label: 'Top Left Pixel Color' },
          { value: 'bottom-right', label: 'Bottom Right Pixel Color' },
        ],
      },
    ],
  });
  if (!result) return;
  trimFn(doc, result.mode);
}

/** Image > Image Rotation > Arbitrary… */
export async function showArbitraryRotationDialog(doc) {
  const result = await paramDialog({
    title: 'Rotate Canvas',
    width: 340,
    preview: false,
    state: { angle: 15, direction: 'cw' },
    params: [
      { key: 'angle', label: 'Angle', type: 'slider', min: 0, max: 359.9, step: 0.1, unit: '°' },
      {
        key: 'direction', label: 'Direction', type: 'radio',
        options: [{ value: 'cw', label: '°CW' }, { value: 'ccw', label: '°CCW' }],
      },
    ],
  });
  if (!result || !result.angle) return;
  const deg = result.direction === 'ccw' ? -result.angle : result.angle;
  await app.busy('Rotate Canvas', async () => rotateDocumentArbitrary(doc, deg));
}

/** Confirmation used before destructive mode changes. */
export function confirmFlatten(message) {
  return confirmDialog(message, 'Change Mode', 'Flatten');
}
