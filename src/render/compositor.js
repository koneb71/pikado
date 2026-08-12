import { LayerType } from '../core/layer.js';
import { gcoFor, isNativeBlend, blendCPU } from '../core/blend.js';
import { createCanvas, cloneCanvas, ctx2d, ctx2dRead } from '../core/util.js';
import { applyLayerStyles, belowEffectResults, hasStyles } from '../effects/styles.js';
import { blendOnGPU } from './gpu-blend.js';
import { applyAdjustment } from '../adjustments/registry.js';

/**
 * Layer compositing.
 *
 * Walks `doc.layers` bottom-up (remember: index 0 is the TOP layer) and
 * accumulates into a single canvas. Handles groups, clipping masks, layer
 * masks, adjustment layers, layer effects and the non-native blend modes.
 */

/** Modules can register a live preview canvas that replaces a layer's pixels. */
const previewOverrides = new Map();

export function setLayerPreview(layerId, canvas) {
  if (canvas) previewOverrides.set(layerId, canvas);
  else previewOverrides.delete(layerId);
}

export function clearLayerPreviews() {
  previewOverrides.clear();
}

export function getLayerPreview(layerId) {
  return previewOverrides.get(layerId) || null;
}

/**
 * Render the whole document.
 * @param {import('../core/document.js').PikaDocument} doc
 * @param {{skipLayerIds?:Set<string>, onlyLayerIds?:Set<string>, ignoreEffects?:boolean}} [opts]
 * @returns {HTMLCanvasElement}
 */
export function compositeDocument(doc, opts = {}) {
  const out = createCanvas(doc.width, doc.height);
  const ctx = out.getContext('2d');
  compositeList(doc.layers, ctx, doc, opts);
  return out;
}

/** Cached composite — recomputed only when the document is invalidated. */
export function getComposite(doc, opts) {
  if (opts) return compositeDocument(doc, opts);
  if (doc._compositeValid && doc._composite && doc._composite.width === doc.width && doc._composite.height === doc.height) {
    return doc._composite;
  }
  doc._composite = compositeDocument(doc);
  doc._compositeValid = true;
  return doc._composite;
}

/* ------------------------------------------------------------------ */
/* Channel view — a viewing aid, never part of the pixels              */
/* ------------------------------------------------------------------ */

/**
 * Per-channel view visibility, as toggled by the eyes in the Channels panel.
 *
 * The state lives on the *document* rather than on `app` so that two open
 * documents each remember their own channel view — switching tabs must not
 * carry "Red only" across with it. It is deliberately absent from
 * `captureState()`, because it is a view setting: undo must not restore it, and
 * nothing downstream of the composite (export, flatten, Save, PSD, the
 * eyedropper) ever sees it. `getComposite()` keeps returning the true
 * full-colour composite; only `getViewComposite()` — used by the canvas view —
 * applies the filter.
 */
const FULL_CHANNEL_VIEW = { r: true, g: true, b: true };

/** The document's channel view, created on first use. */
export function channelViewOf(doc) {
  if (!doc) return { ...FULL_CHANNEL_VIEW };
  const cv = doc.channelView;
  if (!cv || typeof cv !== 'object') {
    doc.channelView = { ...FULL_CHANNEL_VIEW };
    return doc.channelView;
  }
  // Tolerate a partially-written object (e.g. restored from storage).
  if (typeof cv.r !== 'boolean') cv.r = true;
  if (typeof cv.g !== 'boolean') cv.g = true;
  if (typeof cv.b !== 'boolean') cv.b = true;
  return cv;
}

/** True when nothing is being filtered out. */
export function isFullChannelView(view) {
  return !!(view && view.r && view.g && view.b);
}

/**
 * Merge `patch` into the document's channel view.
 * @returns {boolean} whether anything actually changed (callers repaint on true)
 */
export function setChannelView(doc, patch) {
  if (!doc || !patch) return false;
  const cv = channelViewOf(doc);
  let changed = false;
  for (const k of ['r', 'g', 'b']) {
    if (patch[k] === undefined) continue;
    const next = !!patch[k];
    if (cv[k] !== next) {
      cv[k] = next;
      changed = true;
    }
  }
  return changed;
}

/**
 * Final pass over a finished composite: hide the channels the view turned off.
 *
 * Photoshop's two cases, both implemented here:
 *   - exactly one channel visible -> show it as greyscale (r = g = b = value),
 *     which is what makes "click Red to check the red plate" useful;
 *   - two or more (or none) visible -> keep those, zero the hidden ones.
 * Alpha is never touched, so transparency still reads as the checkerboard.
 *
 * @param {CanvasRenderingContext2D} ctx composite to filter, in place
 * @param {{r:boolean,g:boolean,b:boolean}} view
 * @returns {boolean} whether any pixel was rewritten
 */
export function applyChannelView(ctx, view) {
  if (isFullChannelView(view)) return false;
  const w = ctx.canvas.width, h = ctx.canvas.height;
  if (w < 1 || h < 1) return false;
  const keep = [!!view.r, !!view.g, !!view.b];
  const shown = (keep[0] ? 1 : 0) + (keep[1] ? 1 : 0) + (keep[2] ? 1 : 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;

  if (shown === 1) {
    const off = keep[0] ? 0 : keep[1] ? 1 : 2;
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i + off];
      d[i] = v; d[i + 1] = v; d[i + 2] = v;
    }
  } else {
    for (let i = 0; i < d.length; i += 4) {
      if (!keep[0]) d[i] = 0;
      if (!keep[1]) d[i + 1] = 0;
      if (!keep[2]) d[i + 2] = 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  return true;
}

/**
 * The composite as it should appear on screen: the cached full-colour composite
 * with the channel view applied. Returns the cached composite itself when every
 * channel is visible, so the common case costs nothing.
 *
 * The filtered copy is cached against the composite it came from *by reference*.
 * `doc.touch()`/`commit()` make `getComposite()` build a brand-new canvas, and
 * flipping a channel changes the key, so either one invalidates this cache
 * without needing a hook inside `document.js`.
 */
export function getViewComposite(doc) {
  const full = getComposite(doc);
  const view = channelViewOf(doc);
  const proof = doc && doc.proof && doc.proof.enabled ? doc.proof : null;
  if (isFullChannelView(view) && !proof) {
    doc._channelComposite = null;
    doc._channelCompositeSrc = null;
    return full;
  }
  const key = `${view.r ? 1 : 0}${view.g ? 1 : 0}${view.b ? 1 : 0}|`
    + (proof ? `${proof.profileId}:${proof.intent}:${proof.blackPoint ? 1 : 0}:${proof.gamutWarning ? 1 : 0}` : '-');
  const cached = doc._channelComposite;
  if (cached && doc._channelCompositeSrc === full && doc._channelCompositeKey === key
      && cached.width === full.width && cached.height === full.height) {
    return cached;
  }
  const out = createCanvas(full.width, full.height);
  const c = ctx2dRead(out);
  c.drawImage(full, 0, 0);
  // Soft proof before the channel view: proofing simulates another colour space,
  // and the channel view is a way of *looking* at whatever is being shown. Doing
  // it the other way round would proof a greyscale channel view, which is
  // meaningless.
  if (proof && proofHook) proofHook(c, doc);
  applyChannelView(c, view);
  doc._channelComposite = out;
  doc._channelCompositeSrc = full;
  doc._channelCompositeKey = key;
  return out;
}

/**
 * Soft proofing lives in `src/color/manage.js`, which imports the compositor —
 * so it registers itself here rather than being imported, which would be a cycle.
 * Absent (the default), proofing simply does not happen.
 * @type {((ctx:CanvasRenderingContext2D, doc:object) => boolean)|null}
 */
let proofHook = null;

/** Called once by `src/color/manage.js` on import. */
export function registerProofRenderer(fn) {
  proofHook = typeof fn === 'function' ? fn : null;
}

/**
 * Composite a list of sibling layers onto `ctx`.
 * The list is ordered top-first, so we iterate backwards.
 */
export function compositeList(list, ctx, doc, opts = {}) {
  for (let i = list.length - 1; i >= 0; i--) {
    const layer = list[i];
    if (!isRenderable(layer, opts)) continue;
    if (layer.clipped) continue; // consumed by its base below

    // Collect the clipping run: layers immediately *above* this one (lower
    // indices) that have `clipped` set.
    const clipGroup = [];
    for (let j = i - 1; j >= 0; j--) {
      if (!list[j].clipped) break;
      clipGroup.push(list[j]);
    }

    if (clipGroup.length === 0) {
      drawLayer(layer, ctx, doc, opts);
    } else {
      drawClipGroup(layer, clipGroup, ctx, doc, opts);
    }
  }
}

function isRenderable(layer, opts) {
  if (!layer.visible) return false;
  if (opts.skipLayerIds && opts.skipLayerIds.has(layer.id)) return false;
  if (opts.onlyLayerIds && !opts.onlyLayerIds.has(layer.id)) return false;
  return true;
}

/**
 * Base layer + the layers clipped to it. The clipped stack is composited on
 * top of the base, limited to the base's alpha, then blended as a unit.
 */
function drawClipGroup(base, clipGroup, ctx, doc, opts) {
  const w = doc.width, h = doc.height;
  const temp = createCanvas(w, h);
  const tctx = temp.getContext('2d');

  // The base's shadow/glow belong behind the whole clip stack, on the backdrop.
  drawBelowEffects(base, ctx, doc, opts);

  // Base pixels with its mask applied but *without* opacity/blend.
  const basePixels = layerPixels(base, doc, opts);
  if (basePixels) tctx.drawImage(basePixels, 0, 0);

  // Clipped layers stack upward from the base.
  for (const cl of clipGroup) {
    if (!isRenderable(cl, opts)) continue;
    drawLayer(cl, tctx, doc, opts, { clipBase: basePixels });
  }

  // Limit to the base's alpha.
  if (basePixels) {
    tctx.globalCompositeOperation = 'destination-in';
    tctx.drawImage(basePixels, 0, 0);
    tctx.globalCompositeOperation = 'source-over';
  }

  blendOnto(ctx, temp, base.blendMode, effectiveOpacity(base), doc);
}

/**
 * Resolve a layer to a document-sized RGBA canvas with its own mask applied,
 * but *before* opacity and blend mode.
 */
function layerPixels(layer, doc, opts) {
  if (layer.type === LayerType.GROUP) return groupPixels(layer, doc, opts);
  if (layer.type === LayerType.ADJUSTMENT) return null;

  let src = previewOverrides.get(layer.id) || layer.canvas;
  if (!src) return null;

  const needsStyles = !opts.ignoreEffects && hasStyles(layer);
  const needsMask = layer.mask && layer.maskEnabled;
  const fill = layer.fillOpacity == null ? 1 : layer.fillOpacity;

  if (!needsStyles && !needsMask && fill >= 1) return src;

  const out = createCanvas(doc.width, doc.height);
  const c = out.getContext('2d');

  if (needsStyles) {
    // Effects render underneath/over the layer content and are *not* affected
    // by Fill Opacity — that is the whole point of the Fill slider. The two
    // below-effects are left out: drawBelowEffects() puts them on the real
    // backdrop so their own blend modes have something to blend with.
    applyLayerStyles(c, src, layer, doc, fill, { skipBelow: true });
  } else {
    c.globalAlpha = fill;
    c.drawImage(src, 0, 0);
    c.globalAlpha = 1;
  }

  if (needsMask) {
    const ma = layer.maskAlphaCanvas();
    if (ma) {
      c.globalCompositeOperation = 'destination-in';
      c.drawImage(ma, 0, 0);
      c.globalCompositeOperation = 'source-over';
    }
  }
  return out;
}

function groupPixels(group, doc, opts) {
  const temp = createCanvas(doc.width, doc.height);
  const tctx = temp.getContext('2d');
  compositeList(group.children || [], tctx, doc, opts);
  if (group.mask && group.maskEnabled) {
    const ma = group.maskAlphaCanvas();
    if (ma) {
      tctx.globalCompositeOperation = 'destination-in';
      tctx.drawImage(ma, 0, 0);
      tctx.globalCompositeOperation = 'source-over';
    }
  }
  return temp;
}

function effectiveOpacity(layer) {
  return layer.opacity == null ? 1 : layer.opacity;
}

/**
 * Drop shadow and outer glow go straight onto the accumulated backdrop, each
 * with its own blend mode — that is what "Multiply" on a drop shadow means.
 * They are scaled by the layer's opacity but never by its Fill or blend mode.
 */
function drawBelowEffects(layer, ctx, doc, opts) {
  if (opts.ignoreEffects || !hasStyles(layer)) return;
  if (layer.type === LayerType.GROUP || layer.type === LayerType.ADJUSTMENT) return;
  const src = previewOverrides.get(layer.id) || layer.canvas;
  if (!src) return;
  const list = belowEffectResults(src, layer, doc, doc.width, doc.height);
  if (!list.length) return;

  const op = effectiveOpacity(layer);
  const ma = layer.mask && layer.maskEnabled ? layer.maskAlphaCanvas() : null;
  for (const e of list) {
    let px = e.canvas;
    if (ma) {
      const clipped = createCanvas(doc.width, doc.height);
      const cc = clipped.getContext('2d');
      cc.drawImage(px, 0, 0);
      cc.globalCompositeOperation = 'destination-in';
      cc.drawImage(ma, 0, 0);
      px = clipped;
    }
    blendOnto(ctx, px, e.mode, e.opacity * op, doc);
  }
}

/** Draw one layer (any type) onto the accumulating context. */
function drawLayer(layer, ctx, doc, opts, extra = {}) {
  if (layer.type === LayerType.ADJUSTMENT) {
    drawAdjustmentLayer(layer, ctx, doc, extra);
    return;
  }

  if (layer.type === LayerType.GROUP) {
    const passThrough = layer.blendMode === 'pass-through';
    if (passThrough && effectiveOpacity(layer) >= 1 && !(layer.mask && layer.maskEnabled)) {
      // True pass-through: children blend directly with the existing backdrop.
      compositeList(layer.children || [], ctx, doc, opts);
      return;
    }
    const px = groupPixels(layer, doc, opts);
    blendOnto(ctx, px, passThrough ? 'normal' : layer.blendMode, effectiveOpacity(layer), doc);
    return;
  }

  drawBelowEffects(layer, ctx, doc, opts);

  /*
   * The fast path, and the whole reason a compact layer stays compact.
   *
   * When a layer has nothing that needs a document-sized surface — no effects, no
   * mask, full fill opacity, and a blend mode Canvas2D can do natively — its
   * pixels can be drawn straight from the tile at their offset. Reading
   * `layer.canvas` instead would expand it to document size on the first frame
   * and every layer in the document with it.
   *
   * The non-native blend modes cannot come here: `blendOnto` falls through to
   * WebGL or `blendCPU`, both of which read the source at destination size.
   */
  const tile = layer.tile;
  if (tile
    && !(!opts.ignoreEffects && hasStyles(layer))
    && !(layer.mask && layer.maskEnabled)
    && (layer.fillOpacity == null || layer.fillOpacity >= 1)
    && isNativeBlend(layer.blendMode === 'pass-through' ? 'normal' : layer.blendMode)) {
    const op = effectiveOpacity(layer);
    if (op <= 0) return;
    ctx.save();
    ctx.globalAlpha = op;
    ctx.globalCompositeOperation = gcoFor(layer.blendMode === 'pass-through' ? 'normal' : layer.blendMode);
    ctx.drawImage(tile.canvas, tile.x, tile.y);
    ctx.restore();
    return;
  }

  const px = layerPixels(layer, doc, opts);
  if (!px) return;
  blendOnto(ctx, px, layer.blendMode, effectiveOpacity(layer), doc);
}

/**
 * Adjustment layers re-process whatever has already been composited below
 * them, limited by their own mask.
 */
function drawAdjustmentLayer(layer, ctx, doc, extra = {}) {
  const adj = layer.adjustment;
  if (!adj) return;
  const w = ctx.canvas.width, h = ctx.canvas.height;
  if (w < 1 || h < 1) return;

  const base = ctx.getImageData(0, 0, w, h);
  const work = new ImageData(new Uint8ClampedArray(base.data), w, h);
  applyAdjustment(adj.kind, work, adj.params || {});

  // Build the adjusted result as a canvas so we can mask/blend it.
  const adjusted = createCanvas(w, h);
  adjusted.getContext('2d').putImageData(work, 0, 0);

  const c = adjusted.getContext('2d');
  if (layer.mask && layer.maskEnabled) {
    const ma = layer.maskAlphaCanvas();
    if (ma) {
      c.globalCompositeOperation = 'destination-in';
      c.drawImage(ma, 0, 0);
      c.globalCompositeOperation = 'source-over';
    }
  }
  if (extra.clipBase) {
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(extra.clipBase, 0, 0);
    c.globalCompositeOperation = 'source-over';
  }

  const op = effectiveOpacity(layer);
  const mode = layer.blendMode === 'pass-through' ? 'normal' : layer.blendMode;
  if (isNativeBlend(mode)) {
    ctx.save();
    ctx.globalAlpha = op;
    ctx.globalCompositeOperation = gcoFor(mode);
    ctx.drawImage(adjusted, 0, 0);
    ctx.restore();
  } else {
    blendOnto(ctx, adjusted, mode, op, doc);
  }
}

/** Blend `src` onto `ctx`, taking the CPU path when Canvas2D can't do it. */
export function blendOnto(ctx, src, mode, opacity, doc) {
  if (opacity <= 0) return;
  const m = mode === 'pass-through' ? 'normal' : mode;
  if (isNativeBlend(m)) {
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.globalCompositeOperation = gcoFor(m);
    ctx.drawImage(src, 0, 0);
    ctx.restore();
    return;
  }
  // Canvas2D cannot do this mode. Try the shader first — the CPU path costs
  // ~1 s per recomposite on a 12 MP document, which a brush stroke cannot wear.
  if (blendOnGPU(ctx, src, m, opacity)) return;
  const w = ctx.canvas.width, h = ctx.canvas.height;
  const base = ctx.getImageData(0, 0, w, h);
  const top = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h);
  blendCPU(base, top, m, opacity);
  ctx.putImageData(base, 0, 0);
}

/**
 * Flatten a subset of layers into a single raster canvas — used by Merge Down,
 * Merge Visible, Flatten Image and Copy Merged.
 */
export function flattenLayers(doc, layers) {
  const ids = new Set(layers.map((l) => l.id));
  const out = createCanvas(doc.width, doc.height);
  const ctx = out.getContext('2d');
  // Keep the tree shape (so groups/clipping still resolve correctly) but drop
  // every branch that contains none of the requested layers.
  compositeList(pruneTree(doc.layers, ids), ctx, doc, {});
  return out;
}

/** Return a structural copy of the tree keeping only layers in `ids`. */
function pruneTree(list, ids) {
  const out = [];
  for (const l of list) {
    if (ids.has(l.id)) {
      out.push(l);
    } else if (l.children) {
      const kids = pruneTree(l.children, ids);
      if (kids.length) {
        const shell = Object.create(Object.getPrototypeOf(l));
        Object.assign(shell, l, { children: kids });
        out.push(shell);
      }
    }
  }
  return out;
}
