/**
 * Cached content bounds for layers.
 *
 * `contentBounds()` scans every pixel of a layer, and several things ask for it
 * on every rendered frame — the transform box, align and distribute, and now
 * snapping, which wants the bounds of *every* layer in the document to align
 * against. So it is cached.
 *
 * Lives on its own rather than inside the Move tool because snapping needs it
 * too, and the Move tool imports snapping.
 */

/**
 * Copy-on-write identifies changed pixels; the tile origin identifies moves
 * that share those pixels. Both must match before reusing document-space bounds.
 * @type {WeakMap<HTMLCanvasElement, {x:number,y:number,bounds:object|null}>}
 */
const cache = new WeakMap();

/**
 * A layer's content bounds in document space, or null if it has no pixels.
 *
 * Keyed on `pixelKey()`, not `layer.canvas`. Reading `.canvas` materialises a
 * compact layer into a document-sized buffer, and snapping measures every layer
 * in the document. Keyed the old way, one drag would expand all of them — a
 * 60-layer 4000x3000 PSD goes from 99 MB to 3.6 GB. `contentBounds()` is
 * already tile-aware and answers in document space either way; this just stops
 * the cache key undoing that.
 */
export function layerBounds(layer) {
  if (!layer) return null;
  const key = layer.pixelKey();
  if (!key) return null;
  const cached = peekBounds(layer);
  if (cached !== undefined) return cached;
  const b = layer.contentBounds();
  cacheShiftedBounds(layer, b, 0, 0);
  return b;
}

/**
 * What the cache already knows, without scanning for it — `undefined` when it
 * knows nothing. Callers use this to carry an entry across a copy-on-write edit
 * instead of paying for a rescan on every key repeat.
 */
export function peekBounds(layer) {
  const key = layer && layer.pixelKey();
  if (!key) return undefined;
  const entry = cache.get(key);
  return entry && entry.x === (layer.tile?.x ?? 0) && entry.y === (layer.tile?.y ?? 0)
    ? entry.bounds : undefined;
}

/** Record where a known bounding box landed after a translation. */
export function cacheShiftedBounds(layer, b, dx, dy) {
  const key = layer.pixelKey();
  if (!key) return;
  cache.set(key, { x: layer.tile?.x ?? 0, y: layer.tile?.y ?? 0,
    bounds: b ? { ...b, x: b.x + dx, y: b.y + dy } : null });
}

/** The union of several layers' content bounds. */
export function layersBounds(layers) {
  let r = null;
  for (const l of layers) {
    const b = layerBounds(l);
    if (!b) continue;
    r = r ? {
      x: Math.min(r.x, b.x), y: Math.min(r.y, b.y),
      x2: Math.max(r.x2, b.x + b.width), y2: Math.max(r.y2, b.y + b.height),
    } : { x: b.x, y: b.y, x2: b.x + b.width, y2: b.y + b.height };
  }
  return r ? { x: r.x, y: r.y, width: r.x2 - r.x, height: r.y2 - r.y } : null;
}
