import { Layer, LayerType, createRasterLayer, createGroupLayer, createAdjustmentLayer } from '../core/layer.js';
import { createCanvas, cloneCanvas } from '../core/util.js';
import { compositeDocument, flattenLayers, getComposite } from '../render/compositor.js';
import { rasterizeTextLayer } from '../text/text-render.js';
import { rasterizeShapeLayer } from '../vector/path.js';
import { defaultParams } from '../adjustments/registry.js';
import { createSmartObject, renderSmartObject, isSmartLayer } from '../core/smart.js';
import { app } from '../core/app.js';

/**
 * Layer operations shared by the Layers panel, the Layer menu and shortcuts.
 * Everything here records its own history entry.
 */

export function addRasterLayer(doc, name) {
  const l = createRasterLayer(doc.width, doc.height, name || nextLayerName(doc));
  doc.addLayer(l);
  doc.commit('New Layer');
  return l;
}

export function nextLayerName(doc) {
  let n = 1;
  const names = new Set(doc.flatLayers().map((l) => l.name));
  while (names.has(`Layer ${n}`)) n++;
  return `Layer ${n}`;
}

export function duplicateLayers(doc, layers) {
  const list = layers && layers.length ? layers : doc.selectedLayers();
  if (!list.length) return;
  const copies = list.map((l) => doc.duplicateLayer(l));
  doc.selectedLayerIds = copies.map((c) => c.id);
  doc.activeLayerId = copies[copies.length - 1].id;
  doc.commit(list.length > 1 ? 'Duplicate Layers' : 'Duplicate Layer');
  return copies;
}

export function deleteLayers(doc, layers) {
  const list = layers && layers.length ? layers : doc.selectedLayers();
  if (!list.length) return;
  if (doc.flatLayers().length <= list.length) {
    app.toast('A document needs at least one layer.');
    return;
  }
  for (const l of list) doc.removeLayer(l);
  doc.commit(list.length > 1 ? 'Delete Layers' : 'Delete Layer');
}

/* ------------------------------------------------------------------ */
/* Grouping                                                            */
/* ------------------------------------------------------------------ */

export function groupLayers(doc, layers) {
  const list = (layers && layers.length ? layers : doc.selectedLayers()).slice();
  if (!list.length) return null;
  // Order the group's children the same way they appear in the panel.
  const flat = doc.flatLayers();
  list.sort((a, b) => flat.indexOf(a) - flat.indexOf(b));

  const anchor = list[0];
  const loc = doc.locate(anchor);
  if (!loc) return null;

  const group = createGroupLayer('Group 1');
  let n = 1;
  const names = new Set(doc.flatLayers().map((l) => l.name));
  while (names.has(`Group ${n}`)) n++;
  group.name = `Group ${n}`;

  for (const l of list) {
    const li = doc.locate(l);
    if (li) li.list.splice(li.index, 1);
  }
  const target = loc.parent ? loc.parent.children : doc.layers;
  const idx = Math.min(loc.index, target.length);
  group.parent = loc.parent;
  target.splice(idx, 0, group);
  group.children = list;
  for (const l of list) l.parent = group;

  doc.activeLayerId = group.id;
  doc.selectedLayerIds = [group.id];
  doc.commit('Group Layers');
  return group;
}

export function ungroupLayers(doc, group) {
  const g = group || doc.activeLayer();
  if (!g || g.type !== LayerType.GROUP) return;
  const loc = doc.locate(g);
  if (!loc) return;
  const kids = g.children || [];
  loc.list.splice(loc.index, 1, ...kids);
  for (const k of kids) k.parent = loc.parent;
  doc.selectedLayerIds = kids.map((k) => k.id);
  doc.activeLayerId = kids.length ? kids[0].id : null;
  doc.commit('Ungroup Layers');
}

/* ------------------------------------------------------------------ */
/* Merging                                                             */
/* ------------------------------------------------------------------ */

/** The blend mode a merge result inherits from the layer it lands on. */
function mergeMode(bottom) {
  const m = bottom.blendMode || 'normal';
  return m === 'pass-through' ? 'normal' : m;
}

/**
 * Flatten `layers`, but with `bottom` drawn as opaque base pixels rather than
 * blended against the empty scratch canvas — its blend mode moves to the
 * merged layer so the visible composite is preserved.
 */
function flattenAsBase(doc, layers, bottom) {
  const saved = bottom.blendMode;
  bottom.blendMode = 'normal';
  try {
    return flattenLayers(doc, layers);
  } finally {
    bottom.blendMode = saved;
  }
}

export function mergeDown(doc, layer) {
  const l = layer || doc.activeLayer();
  if (!l) return;
  const loc = doc.locate(l);
  if (!loc) return;
  const below = loc.list[loc.index + 1];
  if (!below) { app.toast('Nothing below to merge into.'); return; }
  if (below.type === LayerType.GROUP) { app.toast('Cannot merge into a group. Merge the group first.'); return; }

  const keepName = below.name;
  const wasBackground = below.isBackground;
  // The lower layer's blend mode survives the merge (Photoshop does the same),
  // so flatten it as plain pixels and hand the mode to the result instead of
  // baking a blend against the transparent scratch canvas.
  const keepMode = mergeMode(below);
  const merged = flattenAsBase(doc, [l, below], below);

  loc.list.splice(loc.index, 2);
  const nl = new Layer({
    type: LayerType.RASTER,
    name: keepName,
    canvas: merged,
    isBackground: wasBackground,
    opacity: 1,
    blendMode: keepMode,
  });
  nl.parent = loc.parent;
  loc.list.splice(loc.index, 0, nl);
  doc.activeLayerId = nl.id;
  doc.selectedLayerIds = [nl.id];
  doc.commit('Merge Down');
  return nl;
}

export function mergeSelected(doc) {
  const list = doc.selectedLayers();
  if (list.length < 2) return mergeDown(doc);
  const flat = doc.flatLayers();
  list.sort((a, b) => flat.indexOf(a) - flat.indexOf(b));
  const anchor = list[list.length - 1];
  const merged = flattenAsBase(doc, list, anchor);
  const keepMode = mergeMode(anchor);
  const loc = doc.locate(anchor);
  const name = list[0].name;
  const parent = loc ? loc.parent : null;
  // The index has to be counted before the originals go, but in terms of the
  // siblings that survive — reusing `loc.index` afterwards drops the merged
  // layer far too low in the stack.
  const doomed = new Set(list.map((x) => x.id));
  let index = 0;
  if (loc) for (let i = 0; i < loc.index; i++) if (!doomed.has(loc.list[i].id)) index++;
  for (const l of list) doc.removeLayer(l);
  const nl = new Layer({ type: LayerType.RASTER, name, canvas: merged, blendMode: keepMode });
  doc.addLayer(nl, { index, parent });
  doc.commit('Merge Layers');
  return nl;
}

export function mergeVisible(doc) {
  const visible = doc.flatLayers().filter((l) => l.visible && !l.parent);
  if (!visible.length) return;
  const merged = compositeDocument(doc);
  const bottom = visible[visible.length - 1];
  const keepBackground = bottom.isBackground;
  // Land where the bottom-most visible layer was, not at the very bottom —
  // hidden layers below it must stay below it.
  const doomed = new Set(visible.map((l) => l.id));
  let index = 0;
  for (const l of doc.layers) {
    if (l === bottom) break;
    if (!doomed.has(l.id)) index++;
  }
  for (const l of [...visible]) doc.removeLayer(l);
  const nl = new Layer({ type: LayerType.RASTER, name: keepBackground ? 'Background' : 'Merged', canvas: merged, isBackground: keepBackground });
  doc.layers.splice(index, 0, nl);
  doc.activeLayerId = nl.id;
  doc.selectedLayerIds = [nl.id];
  doc.commit('Merge Visible');
  return nl;
}

export function flattenImage(doc) {
  const merged = compositeDocument(doc);
  // Flattening composites onto white, matching Photoshop.
  const flat = createCanvas(doc.width, doc.height);
  const c = flat.getContext('2d');
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, doc.width, doc.height);
  c.drawImage(merged, 0, 0);
  doc.layers = [];
  const nl = new Layer({ type: LayerType.RASTER, name: 'Background', canvas: flat, isBackground: true });
  doc.layers.push(nl);
  doc.activeLayerId = nl.id;
  doc.selectedLayerIds = [nl.id];
  doc.commit('Flatten Image');
  return nl;
}

/** Merge the selected layers into a new layer, keeping the originals. */
export function stampVisible(doc) {
  const merged = compositeDocument(doc);
  const nl = new Layer({ type: LayerType.RASTER, name: 'Stamp', canvas: merged });
  doc.addLayer(nl, { above: doc.layers[0] });
  doc.commit('Stamp Visible');
  return nl;
}

/* ------------------------------------------------------------------ */
/* Smart objects                                                       */
/* ------------------------------------------------------------------ */

/**
 * Layer > Smart Objects > Convert to Smart Object. Captures the layers into an
 * embedded document so every later transform and filter resamples the
 * originals — see `src/core/smart.js`.
 *
 * @param {import('../core/document.js').PikaDocument} doc
 * @param {import('../core/layer.js').Layer[]} [layers] defaults to the selection
 * @returns {import('../core/layer.js').Layer|null}
 */
export function convertToSmartObject(doc, layers) {
  return createSmartObject(doc, layers && layers.length ? layers : doc.selectedLayers());
}

/* ------------------------------------------------------------------ */
/* Rasterizing                                                         */
/* ------------------------------------------------------------------ */

export function rasterizeLayer(doc, layer) {
  const l = layer || doc.activeLayer();
  if (!l) return;
  doc.beginEdit(l);
  if (l.type === LayerType.TEXT) {
    l.canvas = rasterizeTextLayer(l, doc);
    l.text = null;
    l.type = LayerType.RASTER;
  } else if (l.type === LayerType.SHAPE) {
    l.canvas = rasterizeShapeLayer(l, doc);
    l.shape = null;
    l.type = LayerType.RASTER;
  } else if (l.type === LayerType.SMART) {
    // Bake the *current* smart render (contents + smart filters + transform)
    // rather than whatever stale cache happens to sit in `l.canvas`.
    if (isSmartLayer(l)) l.canvas = renderSmartObject(l, doc) || l.canvas;
    if (!l.canvas) l.canvas = createCanvas(doc.width, doc.height);
    l._smartCache = null;
    l.smart = null;
    l.type = LayerType.RASTER;
  } else if (l.type === LayerType.GROUP) {
    const merged = flattenLayers(doc, [l]);
    const loc = doc.locate(l);
    loc.list.splice(loc.index, 1);
    const nl = new Layer({ type: LayerType.RASTER, name: l.name, canvas: merged, opacity: l.opacity, blendMode: l.blendMode === 'pass-through' ? 'normal' : l.blendMode });
    nl.parent = loc.parent;
    loc.list.splice(loc.index, 0, nl);
    doc.activeLayerId = nl.id;
    doc.selectedLayerIds = [nl.id];
    doc.commit('Rasterize Group');
    return nl;
  } else {
    return;
  }
  doc.commit('Rasterize Layer');
  return l;
}

/** Bake the layer's effects into its pixels. */
export function rasterizeLayerStyle(doc, layer) {
  const l = layer || doc.activeLayer();
  if (!l || !l.styles) return;
  const only = flattenLayers(doc, [l]);
  doc.beginEdit(l);
  l.canvas = only;
  l.styles = null;
  doc.commit('Rasterize Layer Style');
}

/* ------------------------------------------------------------------ */
/* Masks                                                               */
/* ------------------------------------------------------------------ */

/**
 * @param {'reveal-all'|'hide-all'|'reveal-selection'|'hide-selection'} kind
 */
export function addLayerMask(doc, layer, kind = 'reveal-all') {
  const l = layer || doc.activeLayer();
  if (!l) return;
  if (l.mask) { app.toast('Layer already has a mask.'); return; }
  doc.beginEdit(l);
  const mask = createCanvas(doc.width, doc.height);
  const c = mask.getContext('2d');
  const useSel = kind.includes('selection') && doc.selection.active;
  if (kind === 'hide-all' || (kind === 'hide-selection' && !useSel)) {
    c.fillStyle = '#000';
    c.fillRect(0, 0, doc.width, doc.height);
  } else if (useSel) {
    const sel = doc.selection.toCanvas();
    if (kind === 'hide-selection') {
      c.fillStyle = '#fff';
      c.fillRect(0, 0, doc.width, doc.height);
      c.globalCompositeOperation = 'difference';
      c.drawImage(sel, 0, 0);
      c.globalCompositeOperation = 'source-over';
    } else {
      c.fillStyle = '#000';
      c.fillRect(0, 0, doc.width, doc.height);
      c.drawImage(sel, 0, 0);
    }
  } else {
    c.fillStyle = '#fff';
    c.fillRect(0, 0, doc.width, doc.height);
  }
  l.mask = mask;
  l.maskEnabled = true;
  l.editingMask = true;
  l.touchMask();
  doc.commit('Add Layer Mask');
  return mask;
}

export function deleteLayerMask(doc, layer) {
  const l = layer || doc.activeLayer();
  if (!l || !l.mask) return;
  doc.beginEdit(l);
  l.removeMask();
  doc.commit('Delete Layer Mask');
}

export function applyLayerMask(doc, layer) {
  const l = layer || doc.activeLayer();
  if (!l || !l.mask || !l.canvas) return;
  doc.beginEdit(l);
  const ma = l.maskAlphaCanvas();
  const out = createCanvas(doc.width, doc.height);
  const c = out.getContext('2d');
  c.drawImage(l.canvas, 0, 0);
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(ma, 0, 0);
  l.canvas = out;
  l.removeMask();
  doc.commit('Apply Layer Mask');
}

export function toggleMaskEnabled(doc, layer) {
  const l = layer || doc.activeLayer();
  if (!l || !l.mask) return;
  l.maskEnabled = !l.maskEnabled;
  doc.commit(l.maskEnabled ? 'Enable Layer Mask' : 'Disable Layer Mask');
}

/* ------------------------------------------------------------------ */
/* Adjustment layers                                                   */
/* ------------------------------------------------------------------ */

export function addAdjustmentLayer(doc, kind, params, name) {
  const l = createAdjustmentLayer(kind, params || defaultParams(kind), doc.width, doc.height, name);
  if (doc.selection.active) {
    const mask = createCanvas(doc.width, doc.height);
    const c = mask.getContext('2d');
    c.fillStyle = '#000';
    c.fillRect(0, 0, doc.width, doc.height);
    c.drawImage(doc.selection.toCanvas(), 0, 0);
    l.mask = mask;
    l.touchMask();
  } else {
    l.addMask(doc.width, doc.height, '#ffffff');
  }
  doc.addLayer(l);
  doc.commit(`New ${l.name} Layer`);
  return l;
}

/** Fill/solid-colour, gradient and pattern layers. */
export function addFillLayer(doc, kind, params) {
  const l = new Layer({ type: LayerType.SHAPE, name: kind === 'solid' ? 'Color Fill' : kind === 'gradient' ? 'Gradient Fill' : 'Pattern Fill' });
  l.shape = { kind: 'fill', fillKind: kind, ...params, subpaths: [{ closed: true, points: rectPoints(doc.width, doc.height) }] };
  l.canvas = rasterizeShapeLayer(l, doc);
  l.addMask(doc.width, doc.height, '#ffffff');
  doc.addLayer(l);
  doc.commit('New Fill Layer');
  return l;
}

function rectPoints(w, h) {
  return [
    { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h },
  ];
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

export function toggleClipping(doc, layer) {
  const l = layer || doc.activeLayer();
  if (!l) return;
  const loc = doc.locate(l);
  if (!loc || loc.index >= loc.list.length - 1) { app.toast('No layer below to clip to.'); return; }
  l.clipped = !l.clipped;
  doc.commit(l.clipped ? 'Create Clipping Mask' : 'Release Clipping Mask');
}

export function setLayerProps(doc, layer, props, label = 'Layer Properties') {
  const l = layer || doc.activeLayer();
  if (!l) return;
  Object.assign(l, props);
  doc.commit(label);
}

export function convertBackgroundToLayer(doc, layer) {
  const l = layer || doc.activeLayer();
  if (!l || !l.isBackground) return;
  l.isBackground = false;
  l.locked = { all: false, pixels: false, position: false, transparency: false };
  l.name = nextLayerName(doc);
  doc.commit('Layer From Background');
}

export function convertLayerToBackground(doc, layer) {
  const l = layer || doc.activeLayer();
  if (!l || l.type !== LayerType.RASTER) return;
  const flat = createCanvas(doc.width, doc.height);
  const c = flat.getContext('2d');
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, doc.width, doc.height);
  c.drawImage(l.canvas, 0, 0);
  doc.beginEdit(l);
  l.canvas = flat;
  l.isBackground = true;
  l.name = 'Background';
  l.opacity = 1;
  l.blendMode = 'normal';
  // The background must sit at the bottom of the root list.
  const loc = doc.locate(l);
  if (loc) {
    loc.list.splice(loc.index, 1);
    doc.layers.push(l);
    l.parent = null;
  }
  doc.commit('Background From Layer');
}

/** Trim transparent / uniform-colour edges (Image > Trim). */
export function trimDocument(doc, mode = 'transparent') {
  const comp = compositeDocument(doc);
  const w = comp.width, h = comp.height;
  const d = comp.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const ref = mode === 'top-left' ? [d[0], d[1], d[2], d[3]] : null;
  const brI = ((h - 1) * w + (w - 1)) * 4;
  const refBR = mode === 'bottom-right' ? [d[brI], d[brI + 1], d[brI + 2], d[brI + 3]] : null;
  const target = ref || refBR;

  const keep = (i) => {
    if (mode === 'transparent') return d[i + 3] !== 0;
    return !(d[i] === target[0] && d[i + 1] === target[1] && d[i + 2] === target[2] && d[i + 3] === target[3]);
  };

  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (keep((y * w + x) * 4)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) { app.toast('Nothing to trim.'); return; }
  if (minX === 0 && minY === 0 && maxX === w - 1 && maxY === h - 1) { app.toast('Nothing to trim.'); return; }
  doc.crop({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
  doc.commit('Trim');
}
