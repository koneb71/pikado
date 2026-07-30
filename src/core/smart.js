import { PikaDocument } from './document.js';
import { Layer, LayerType, createRasterLayer, setSmartSourceCloner } from './layer.js';
import { app } from './app.js';
import { uid, createCanvas, ctx2d, ctx2dRead, imageDataToCanvas, download } from './util.js';
import { compositeDocument, setLayerPreview } from '../render/compositor.js';
import { getFilter, runFilter } from '../filters/registry.js';

/**
 * Smart Objects — genuinely non-destructive embedded documents.
 *
 * `layer.smart` looks like:
 * ```
 * {
 *   source: PikaDocument,      // the embedded contents (layers, masks, groups)
 *   sourceWidth, sourceHeight, // the source document size
 *   sourceVersion: number,     // bumped whenever `source` is replaced
 *   transform: { matrix: [a,b,c,d,e,f] },
 *   filters: [{ id, filterId, name, params, enabled }],
 * }
 * ```
 *
 * **Every render starts from `source`.** The stored smart filters are re-run
 * against the freshly composited source pixels and the transform is applied
 * last, so scaling a smart object down and back up resamples the originals once
 * instead of compounding a chain of lossy steps. `layer.canvas` is only a cache
 * of that render; the compositor draws it like any other raster layer.
 *
 * **Mutation rule.** `Layer.snapshot()` shallow-copies `layer.smart`, so history
 * states share the payload object. Nothing here ever edits `layer.smart` (or its
 * `filters` array) in place — every mutator installs a brand new payload with a
 * new `filters` array. Old snapshots therefore keep the values they were taken
 * with, and undo/redo of smart-object edits round-trips exactly.
 */

/** The neutral transform: source pixels land 1:1 at the document origin. */
export const IDENTITY_MATRIX = [1, 0, 0, 1, 0, 0];

/* ------------------------------------------------------------------ */
/* Matrix helpers ([a,b,c,d,e,f], the canvas setTransform order)        */
/* ------------------------------------------------------------------ */

/** `A ∘ B` — the matrix that applies `B` first, then `A`. */
export function matrixMultiply(A, B) {
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}

/**
 * Split a matrix into the values the UI edits: where the centre of the source
 * box lands, its scale and its rotation. Skew is not represented (the panel
 * cannot author it) but is preserved by leaving the matrix alone.
 * @returns {{centerX:number, centerY:number, scaleX:number, scaleY:number, angle:number}}
 */
export function decomposeMatrix(matrix, sourceWidth, sourceHeight) {
  const [a, b, c, d, e, f] = matrix;
  const scaleX = Math.hypot(a, b);
  const det = a * d - b * c;
  const scaleY = (Math.hypot(c, d) || 0) * (det < 0 ? -1 : 1);
  const angle = Math.atan2(b, a);
  const hx = sourceWidth / 2, hy = sourceHeight / 2;
  return {
    centerX: a * hx + c * hy + e,
    centerY: b * hx + d * hy + f,
    scaleX,
    scaleY,
    angle,
  };
}

/** The inverse of {@link decomposeMatrix}. */
export function composeMatrix({ centerX, centerY, scaleX, scaleY, angle }, sourceWidth, sourceHeight) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const a = scaleX * cos, b = scaleX * sin;
  const c = -scaleY * sin, d = scaleY * cos;
  const hx = sourceWidth / 2, hy = sourceHeight / 2;
  return [a, b, c, d, centerX - (a * hx + c * hy), centerY - (b * hx + d * hy)];
}

function validMatrix(m) {
  return Array.isArray(m) && m.length === 6 && m.every((n) => Number.isFinite(n));
}

/* ------------------------------------------------------------------ */
/* Predicates and payload access                                       */
/* ------------------------------------------------------------------ */

/** True when `layer` is a smart object with usable contents. */
export function isSmartLayer(layer) {
  return !!(layer && layer.type === LayerType.SMART && layer.smart && layer.smart.source);
}

/** The smart payload, or null — never throws on a plain layer. */
export function smartPayload(layer) {
  return isSmartLayer(layer) ? layer.smart : null;
}

/** A copy of the layer's transform matrix. */
export function getSmartTransform(layer) {
  const s = smartPayload(layer);
  const m = s && s.transform && s.transform.matrix;
  return validMatrix(m) ? m.slice() : IDENTITY_MATRIX.slice();
}

/** The stored smart filters, newest-applied last. Safe to iterate, not to edit. */
export function getSmartFilters(layer) {
  const s = smartPayload(layer);
  return s && Array.isArray(s.filters) ? s.filters : [];
}

/** Deep-enough copy of a filter list so history states never share entries. */
function copyFilters(list) {
  return (list || []).map((f) => ({ ...f, params: { ...f.params } }));
}

/**
 * Install a new smart payload on `layer`. Never mutates the old one, so the
 * shallow copy in `Layer.snapshot()` keeps older history states intact.
 */
function setPayload(layer, patch) {
  const s = layer.smart || {};
  const next = patch.transform ? patch.transform.matrix : (s.transform || {}).matrix;
  layer.smart = {
    ...s,
    ...patch,
    filters: copyFilters(patch.filters || s.filters),
    transform: { matrix: (validMatrix(next) ? next : IDENTITY_MATRIX).slice() },
  };
  return layer.smart;
}

/* ------------------------------------------------------------------ */
/* Embedded document helpers                                           */
/* ------------------------------------------------------------------ */

/**
 * A detached copy of a document, suitable for storing as smart contents.
 * Layer ids are preserved so the editing tab and the stored source line up.
 */
export function cloneSourceDocument(src, name) {
  const d = new PikaDocument({
    width: src.width,
    height: src.height,
    name: name || src.name,
    resolution: src.resolution,
  });
  d.colorMode = src.colorMode;
  d.layers = src.layers.map((l) => {
    const c = l.clone(false);
    c.parent = null;
    return c;
  });
  d.activeLayerId = src.activeLayerId && d.findLayer(src.activeLayerId) ? src.activeLayerId : (d.flatLayers()[0] || {}).id || null;
  d.selectedLayerIds = d.activeLayerId ? [d.activeLayerId] : [];
  d.paths = structuredClone(src.paths || []);
  d.guides = (src.guides || []).map((g) => ({ ...g }));
  d.history.clear('Smart Object');
  return d;
}

/** Wrap an image/canvas in a one-layer document. */
function documentFromImage(image, name) {
  const w = Math.max(1, image.naturalWidth || image.width || 1);
  const h = Math.max(1, image.naturalHeight || image.height || 1);
  const d = new PikaDocument({ width: w, height: h, name: name || 'Contents' });
  const l = createRasterLayer(w, h, 'Layer 1');
  ctx2d(l.canvas).drawImage(image, 0, 0, w, h);
  d.layers = [l];
  d.activeLayerId = l.id;
  d.selectedLayerIds = [l.id];
  d.history.clear('Smart Object');
  return d;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/**
 * Cache key covering everything that feeds the pre-transform pixels.
 *
 * `sourceVersion` only moves when the smart API *replaces* the source, so it
 * misses edits made to the embedded document directly — which is exactly what
 * an open "Contents" tab does. Folding in the source's own history position
 * catches those: every committed edit moves it.
 */
function sourceKey(s) {
  const fs = (s.filters || [])
    .map((f) => (f.enabled ? `${f.filterId}:${JSON.stringify(f.params || {})}` : '-'))
    .join(';');
  const src = s.source;
  const hist = src && src.history ? `${src.history.index}.${src.history.states.length}` : '0';
  return `${src ? src.id : '?'}|${s.sourceVersion || 0}|${hist}|${fs}`;
}

/** Run the stored smart filters over the composited source, in order. */
function applySmartFilters(canvas, s, layer) {
  let cur = canvas;
  for (const f of s.filters || []) {
    if (!f.enabled) continue;
    const def = getFilter(f.filterId);
    if (!def) {
      app.toast(`Smart filter "${f.filterId}" is not registered — skipped.`, 'error');
      continue;
    }
    const w = cur.width, h = cur.height;
    const region = ctx2dRead(cur).getImageData(0, 0, w, h);
    let res = runFilter(f.filterId, region, f.params, {
      doc: s.source, layer, rect: { x: 0, y: 0, width: w, height: h },
      isMask: false, width: w, height: h, app,
    });
    if (!(res instanceof ImageData)) res = region;
    cur = imageDataToCanvas(res);
  }
  return cur;
}

/**
 * Successive halving before a big downscale. A single `drawImage` that shrinks
 * by more than 2× box-filters poorly, and the whole point of a smart object is
 * that the small version still looks right.
 */
function prescale(src, sx, sy) {
  let cur = src;
  let px = 1, py = 1;
  for (let i = 0; i < 12; i++) {
    if (!(sx / px < 0.5 && sy / py < 0.5)) break;
    if (cur.width <= 4 || cur.height <= 4) break;
    const w = Math.max(1, Math.round(cur.width / 2));
    const h = Math.max(1, Math.round(cur.height / 2));
    const half = createCanvas(w, h);
    const hc = ctx2d(half);
    hc.imageSmoothingEnabled = true;
    hc.imageSmoothingQuality = 'high';
    hc.drawImage(cur, 0, 0, w, h);
    cur = half;
    px = cur.width / src.width;
    py = cur.height / src.height;
  }
  return { canvas: cur, px, py };
}

/**
 * The pre-transform pixels: the embedded document composited at source size
 * with the enabled smart filters applied. Cached on `cacheHolder` (the layer)
 * so dragging a transform does not re-run the filter chain every frame.
 * @returns {HTMLCanvasElement}
 */
export function smartSourcePixels(s, layer, cacheHolder) {
  const key = sourceKey(s);
  if (cacheHolder && cacheHolder._smartCache && cacheHolder._smartCache.key === key) {
    return cacheHolder._smartCache.canvas;
  }
  const composed = applySmartFilters(compositeDocument(s.source), s, layer);
  if (cacheHolder) cacheHolder._smartCache = { key, canvas: composed };
  return composed;
}

/**
 * Render a smart payload into a `width × height` canvas without touching any
 * layer. Used for the live filter preview as well as the real render.
 * @returns {HTMLCanvasElement}
 */
export function composeSmartCanvas(s, width, height, layer = null, cacheHolder = null) {
  const src = smartSourcePixels(s, layer, cacheHolder);
  const matrix = validMatrix(s.transform && s.transform.matrix) ? s.transform.matrix : IDENTITY_MATRIX;
  const out = createCanvas(width, height);
  const ctx = ctx2d(out);
  const [a, b, c, d, e, f] = matrix;
  const sx = Math.hypot(a, b);
  const sy = Math.hypot(c, d);
  if (sx <= 0 || sy <= 0) return out;
  const pre = prescale(src, sx, sy);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(a, b, c, d, e, f);
  if (pre.px !== 1 || pre.py !== 1) ctx.scale(1 / pre.px, 1 / pre.py);
  ctx.drawImage(pre.canvas, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return out;
}

/**
 * Re-composite the embedded document, re-apply the smart filters in order and
 * re-apply the transform — always resampling from the original source pixels.
 * Assigns the result to `layer.canvas` (a replacement, never an in-place edit).
 *
 * @param {import('./layer.js').Layer} layer
 * @param {import('./document.js').PikaDocument} doc parent document
 * @returns {HTMLCanvasElement|null}
 */
export function renderSmartObject(layer, doc) {
  if (!isSmartLayer(layer)) {
    app.toast('That layer has no Smart Object contents.', 'error');
    return null;
  }
  const cv = composeSmartCanvas(layer.smart, doc.width, doc.height, layer, layer);
  layer.canvas = cv;
  layer.thumbDirty = true;
  return cv;
}

/** Drop the cached source pixels — call after editing `smart.source` in place. */
export function invalidateSmartCache(layer) {
  if (layer) layer._smartCache = null;
}

/* ------------------------------------------------------------------ */
/* Creation                                                            */
/* ------------------------------------------------------------------ */

/** Remove layers that are already inside another layer of the same list. */
function dropNested(list) {
  const isInside = (l, maybeParent) => {
    for (let p = l.parent; p; p = p.parent) if (p === maybeParent) return true;
    return false;
  };
  return list.filter((l) => !list.some((o) => o !== l && isInside(l, o)));
}

/**
 * Layer > Smart Objects > Convert to Smart Object.
 *
 * Captures `layers` into an embedded `PikaDocument` (so nested groups, masks
 * and layer styles all survive verbatim) and replaces them with one smart
 * layer rendered from that document.
 *
 * @param {import('./document.js').PikaDocument} doc
 * @param {import('./layer.js').Layer[]} [layers] defaults to the selection
 * @returns {import('./layer.js').Layer|null}
 */
export function createSmartObject(doc, layers) {
  if (!doc) return null;
  let list = (layers && layers.length ? layers : doc.selectedLayers()).filter(Boolean);
  if (!list.length) {
    app.toast('Select a layer to convert to a Smart Object.');
    return null;
  }
  if (list.length === 1 && list[0].type === LayerType.SMART) {
    app.toast('That layer is already a Smart Object.');
    return null;
  }
  list = dropNested(list);
  const flat = doc.flatLayers();
  const ordered = [...list].sort((a, b) => flat.indexOf(a) - flat.indexOf(b));

  const anchor = ordered[0];
  const loc = doc.locate(anchor);
  if (!loc) {
    app.toast('Could not locate the layer to convert.', 'error');
    return null;
  }
  const parent = loc.parent;
  const index = loc.index;
  const name = ordered.length === 1 ? anchor.name : 'Smart Object';

  const source = new PikaDocument({
    width: doc.width, height: doc.height, name, resolution: doc.resolution,
  });
  source.colorMode = doc.colorMode;
  source.layers = ordered.map((l) => {
    const c = l.clone(false);
    c.parent = null;
    c.clipped = false;
    c.isBackground = false;
    c.locked = { all: false, pixels: false, position: false, transparency: false };
    return c;
  });
  source.activeLayerId = source.layers[0].id;
  source.selectedLayerIds = [source.activeLayerId];
  source.history.clear('Smart Object');

  for (const l of ordered) doc.removeLayer(l);

  const smart = new Layer({ type: LayerType.SMART, name });
  smart.smart = {
    source,
    sourceWidth: doc.width,
    sourceHeight: doc.height,
    sourceVersion: 1,
    transform: { matrix: IDENTITY_MATRIX.slice() },
    filters: [],
  };
  renderSmartObject(smart, doc);

  const target = parent ? parent.children : doc.layers;
  doc.addLayer(smart, { parent, index: Math.min(index, target.length) });
  doc.commit('Convert to Smart Object');
  return smart;
}

/* ------------------------------------------------------------------ */
/* Transform                                                           */
/* ------------------------------------------------------------------ */

/**
 * Replace the smart layer's transform and re-render from the source pixels.
 *
 * @param {import('./document.js').PikaDocument} doc
 * @param {import('./layer.js').Layer} layer
 * @param {number[]} matrix `[a,b,c,d,e,f]`
 * @param {{commit?:boolean, label?:string}} [opts] `commit:false` for a live drag
 */
export function setSmartTransform(doc, layer, matrix, opts = {}) {
  if (!isSmartLayer(layer)) {
    app.toast('Select a Smart Object layer first.');
    return null;
  }
  if (!validMatrix(matrix)) {
    app.toast('That transform is not a valid matrix.', 'error');
    return null;
  }
  const { commit = true, label = 'Transform Smart Object' } = opts;
  if (commit) doc.beginEdit(layer);
  setPayload(layer, { transform: { matrix: matrix.slice() } });
  renderSmartObject(layer, doc);
  if (commit) doc.commit(label);
  else doc.touch('smart-transform');
  return layer.smart.transform.matrix;
}

/** Put the contents back at 1:1, unrotated, at the document origin. */
export function resetSmartTransform(doc, layer) {
  return setSmartTransform(doc, layer, IDENTITY_MATRIX.slice(), { label: 'Reset Smart Transform' });
}

/* ------------------------------------------------------------------ */
/* Editing the contents in a child tab                                 */
/* ------------------------------------------------------------------ */

/** Open editing sessions, keyed `parentDocId:layerId`. */
const sessions = new Map();

function sessionKey(doc, layer) {
  return `${doc.id}:${layer.id}`;
}

function endSession(key, { flush = false } = {}) {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  clearTimeout(s.timer);
  s.offChange();
  s.offStructure();
  s.offDocs();
  if (flush && s.pending) pushContents(s);
}

/** Copy the child tab's current state back into the parent smart layer. */
function pushContents(s) {
  s.pending = false;
  const doc = s.doc;
  if (!app.docs.includes(doc)) {
    endSession(s.key);
    return;
  }
  const layer = doc.findLayer(s.layerId);
  if (!layer || !layer.smart) {
    endSession(s.key);
    app.toast('The Smart Object layer is gone — contents were not saved back.', 'warn');
    return;
  }
  doc.beginEdit(layer);
  setPayload(layer, {
    source: cloneSourceDocument(s.child, layer.smart.source.name),
    sourceWidth: s.child.width,
    sourceHeight: s.child.height,
    sourceVersion: (layer.smart.sourceVersion || 0) + 1,
  });
  invalidateSmartCache(layer);
  renderSmartObject(layer, doc);
  doc.commit('Edit Smart Contents');
}

/**
 * Layer > Smart Objects > Edit Contents — opens `layer.smart.source` as a real
 * editable tab. Every commit in that tab flows straight back into the parent
 * smart layer (a fresh source copy plus a re-render), and closing the tab
 * flushes anything still pending.
 *
 * @returns {import('./document.js').PikaDocument|null} the child document
 */
export function editSmartContents(doc, layer) {
  if (!isSmartLayer(layer)) {
    app.toast('Select a Smart Object layer first.');
    return null;
  }
  const key = sessionKey(doc, layer);
  const open = sessions.get(key);
  if (open && app.docs.includes(open.child)) {
    app.setActiveDoc(open.child);
    return open.child;
  }
  if (open) endSession(key);

  const child = cloneSourceDocument(layer.smart.source, `${layer.name} (Contents)`);
  child.smartParent = { docId: doc.id, layerId: layer.id };

  const s = { key, doc, layerId: layer.id, child, timer: null, pending: false };
  const schedule = () => {
    s.pending = true;
    clearTimeout(s.timer);
    s.timer = setTimeout(() => pushContents(s), 120);
  };
  s.offChange = child.on('change', schedule);
  s.offStructure = child.on('structure', schedule);
  s.offDocs = app.on('docs-change', () => {
    if (!app.docs.includes(child)) endSession(key, { flush: true });
    else if (!app.docs.includes(doc)) endSession(key);
  });
  sessions.set(key, s);

  app.addDocument(child);
  app.fitView();
  app.toast('Editing Smart Object contents — changes update the parent live.', 'info');
  return child;
}

/** True when a child editing tab is open for this layer. */
export function isEditingContents(doc, layer) {
  const s = sessions.get(sessionKey(doc, layer));
  return !!(s && app.docs.includes(s.child));
}

/* ------------------------------------------------------------------ */
/* Replace / export contents                                           */
/* ------------------------------------------------------------------ */

/**
 * Swap the embedded contents for another image or document, keeping the
 * placement: the new contents are scaled to occupy the same box as the old.
 *
 * @param {import('./document.js').PikaDocument} doc
 * @param {import('./layer.js').Layer} layer
 * @param {HTMLImageElement|HTMLCanvasElement|ImageBitmap|import('./document.js').PikaDocument} imageOrDoc
 */
export function replaceContents(doc, layer, imageOrDoc, label = 'Replace Contents') {
  if (!isSmartLayer(layer)) {
    app.toast('Select a Smart Object layer first.');
    return null;
  }
  if (!imageOrDoc) {
    app.toast('Nothing to place into the Smart Object.', 'error');
    return null;
  }
  const s = layer.smart;
  const source = imageOrDoc instanceof PikaDocument
    ? cloneSourceDocument(imageOrDoc, imageOrDoc.name)
    : documentFromImage(imageOrDoc, layer.name);

  const oldW = s.sourceWidth || source.width;
  const oldH = s.sourceHeight || source.height;
  const fit = [oldW / source.width, 0, 0, oldH / source.height, 0, 0];
  const matrix = matrixMultiply(getSmartTransform(layer), fit);

  endSession(sessionKey(doc, layer));
  doc.beginEdit(layer);
  setPayload(layer, {
    source,
    sourceWidth: source.width,
    sourceHeight: source.height,
    sourceVersion: (s.sourceVersion || 0) + 1,
    transform: { matrix },
  });
  invalidateSmartCache(layer);
  renderSmartObject(layer, doc);
  doc.commit(label);
  return layer.smart;
}

/**
 * Layer > Smart Objects > Export Contents — writes the untransformed,
 * unfiltered source composite out as a PNG.
 */
export async function exportSmartContents(doc, layer) {
  if (!isSmartLayer(layer)) {
    app.toast('Select a Smart Object layer first.');
    return false;
  }
  const s = layer.smart;
  const cv = compositeDocument(s.source);
  const blob = await new Promise((resolve, reject) => {
    cv.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the Smart Object contents.'))), 'image/png');
  });
  const safe = String(layer.name || 'smart-object').replace(/[^\w.-]+/g, '-');
  download(blob, `${safe}.png`);
  return true;
}

/* ------------------------------------------------------------------ */
/* Smart filters                                                       */
/* ------------------------------------------------------------------ */

function filterLabel(def) {
  return def.name.replace(/(\.\.\.|…)$/, '');
}

function indexOfFilter(s, ref) {
  const list = s.filters || [];
  if (typeof ref === 'number') return ref >= 0 && ref < list.length ? ref : -1;
  return list.findIndex((f) => f.id === ref || f.filterId === ref);
}

/**
 * Add a re-editable smart filter. Filters live on `layer.smart.filters` and are
 * re-run from the source on every render, so they never damage the originals.
 *
 * @param {string} filterId a registered filter id
 * @param {object} [params] defaults to the filter's own defaults
 */
export function addSmartFilter(doc, layer, filterId, params) {
  if (!isSmartLayer(layer)) {
    app.toast('Smart filters need a Smart Object layer.');
    return null;
  }
  const def = getFilter(filterId);
  if (!def) {
    app.toast(`Unknown filter "${filterId}".`, 'error');
    return null;
  }
  const entry = {
    id: uid('sfilter'),
    filterId,
    name: filterLabel(def),
    params: { ...def.defaults, ...(params || {}) },
    enabled: true,
  };
  doc.beginEdit(layer);
  setPayload(layer, { filters: [...getSmartFilters(layer), entry] });
  renderSmartObject(layer, doc);
  doc.commit(`Smart Filter: ${entry.name}`);
  return entry;
}

/** Remove a smart filter by entry id, filter id or index. */
export function removeSmartFilter(doc, layer, ref) {
  if (!isSmartLayer(layer)) return false;
  const i = indexOfFilter(layer.smart, ref);
  if (i < 0) {
    app.toast('That smart filter is no longer on this layer.', 'error');
    return false;
  }
  const list = getSmartFilters(layer);
  const name = list[i].name;
  doc.beginEdit(layer);
  setPayload(layer, { filters: list.filter((_, n) => n !== i) });
  renderSmartObject(layer, doc);
  doc.commit(`Delete Smart Filter: ${name}`);
  return true;
}

/** Move a smart filter within the stack — order changes the result. */
export function reorderSmartFilters(doc, layer, from, to) {
  if (!isSmartLayer(layer)) return false;
  const list = getSmartFilters(layer);
  const a = indexOfFilter(layer.smart, from);
  const b = typeof to === 'number' ? Math.max(0, Math.min(list.length - 1, to)) : indexOfFilter(layer.smart, to);
  if (a < 0 || b < 0 || a === b) return false;
  const next = copyFilters(list);
  const [moved] = next.splice(a, 1);
  next.splice(b, 0, moved);
  doc.beginEdit(layer);
  setPayload(layer, { filters: next });
  renderSmartObject(layer, doc);
  doc.commit('Reorder Smart Filters');
  return true;
}

/** Toggle one smart filter on or off without losing its settings. */
export function toggleSmartFilter(doc, layer, ref) {
  if (!isSmartLayer(layer)) return false;
  const i = indexOfFilter(layer.smart, ref);
  if (i < 0) return false;
  const next = copyFilters(getSmartFilters(layer));
  next[i].enabled = !next[i].enabled;
  doc.beginEdit(layer);
  setPayload(layer, { filters: next });
  renderSmartObject(layer, doc);
  doc.commit(`${next[i].enabled ? 'Show' : 'Hide'} Smart Filter: ${next[i].name}`);
  return true;
}

/** Show or hide every smart filter at once, as one history step. */
export function setSmartFiltersEnabled(doc, layer, enabled) {
  if (!isSmartLayer(layer)) return false;
  const list = getSmartFilters(layer);
  if (!list.length || list.every((f) => !!f.enabled === !!enabled)) return false;
  const next = copyFilters(list);
  for (const f of next) f.enabled = !!enabled;
  doc.beginEdit(layer);
  setPayload(layer, { filters: next });
  renderSmartObject(layer, doc);
  doc.commit(enabled ? 'Show All Smart Filters' : 'Hide All Smart Filters');
  return true;
}

/**
 * Re-open a smart filter's dialog. The preview re-renders the whole stack from
 * the source, so what you see is exactly what commits.
 */
export async function editSmartFilter(doc, layer, ref) {
  if (!isSmartLayer(layer)) {
    app.toast('Select a Smart Object layer first.');
    return false;
  }
  const i = indexOfFilter(layer.smart, ref);
  if (i < 0) {
    app.toast('That smart filter is no longer on this layer.', 'error');
    return false;
  }
  const entry = getSmartFilters(layer)[i];
  const def = getFilter(entry.filterId);
  if (!def) {
    app.toast(`Filter "${entry.filterId}" is not registered.`, 'error');
    return false;
  }
  if (!def.params || !def.params.length) {
    app.toast(`${entry.name} has no settings to edit.`);
    return false;
  }
  const result = await runFilterDialog(doc, layer, def, { ...entry.params }, (params) => {
    const next = copyFilters(getSmartFilters(layer));
    next[i] = { ...next[i], params };
    return next;
  });
  if (!result) return false;
  const next = copyFilters(getSmartFilters(layer));
  next[i] = { ...next[i], params: result };
  doc.beginEdit(layer);
  setPayload(layer, { filters: next });
  renderSmartObject(layer, doc);
  doc.commit(`Smart Filter: ${entry.name}`);
  return true;
}

/**
 * The dialog shared by "add" and "edit": live-previews `buildFilters(params)`
 * through the compositor's layer override.
 * @returns {Promise<object|null>} the accepted params
 */
async function runFilterDialog(doc, layer, def, state, buildFilters) {
  const { paramDialog } = await import('../ui/dialog.js');
  const preview = (params) => {
    if (!params) {
      setLayerPreview(layer.id, null);
      doc.touch('preview');
      return;
    }
    const trial = { ...layer.smart, filters: buildFilters(params) };
    setLayerPreview(layer.id, composeSmartCanvas(trial, doc.width, doc.height, layer, null));
    doc.touch('preview');
  };
  const result = await paramDialog({
    title: filterLabel(def),
    params: def.params,
    state,
    width: def.dialogWidth || 400,
    preview: def.preview !== false,
    onPreview: preview,
  });
  setLayerPreview(layer.id, null);
  doc.touch('preview');
  return result;
}

/**
 * Entry point used by `src/filters/run.js` when a filter is aimed at a smart
 * layer: never burn the filter into the pixels, stack it instead.
 *
 * @param {object} [preset] skip the dialog (Filter > Last Filter, presets)
 */
export async function promptSmartFilter(doc, layer, filterId, preset) {
  const def = getFilter(filterId);
  if (!def) {
    app.toast(`Unknown filter "${filterId}".`, 'error');
    return null;
  }
  if (preset || !def.needsDialog || !def.params || !def.params.length) {
    const params = preset || def.defaults;
    // Filter > Last Filter must repeat what just happened, smart or not.
    app.lastFilter = { id: filterId, params, label: filterLabel(def) };
    return addSmartFilter(doc, layer, filterId, params);
  }
  const pendingId = uid('sfilter');
  const result = await runFilterDialog(doc, layer, def, { ...def.defaults }, (params) => [
    ...copyFilters(getSmartFilters(layer)),
    { id: pendingId, filterId, name: filterLabel(def), params, enabled: true },
  ]);
  if (!result) return null;
  app.lastFilterParams = { ...(app.lastFilterParams || {}), [filterId]: result };
  app.lastFilter = { id: filterId, params: result, label: filterLabel(def) };
  return addSmartFilter(doc, layer, filterId, result);
}

// Let Layer.clone() deep-copy an embedded source without importing PikaDocument
// (document.js already imports layer.js, so the reverse would be a cycle).
setSmartSourceCloner((source) => cloneSourceDocument(source));
