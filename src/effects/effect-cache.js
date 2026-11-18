import { createCanvas } from '../core/util.js';
import { resolveStops } from '../paint/gradients.js';
import { getGPUDevice, isGPUEnabled, gpuGeneration } from '../render/gpu-device.js';
import { gpuEffectsBroken } from '../render/gpu-effects.js';
import {
  EFFECT_ORDER_BELOW, EFFECT_ORDER_ABOVE, runnableEffects, effectReach, alphaBoundsFast,
  regionFromBounds, cropCanvas, envFor, drawEffectResult,
} from './styles.js';

/**
 * Layer-effect results kept between composites.
 *
 * Effects re-render on every composite, and the canvas view composites on every
 * brush frame — so painting on one layer re-ran every other layer's drop
 * shadow, glow and stroke, sixty times a second, though none of them had
 * changed. This keeps each styled layer's results until something they depend
 * on does, at three levels:
 *
 *   base     which buffer holds the layer's pixels and its revision
 *            (src/core/pixel-revision.js), where a compact layer sits, the
 *            document size, and whether WebGPU renders effects (its results
 *            differ from the CPU's by a count or two). Any change: start over.
 *   region   the content bounds — measured once per base — grown by how far the
 *            enabled effects reach. A different region: re-render everything.
 *   effect   one result per effect, keyed by its settings minus opacity and
 *            blend mode (those are applied when drawing), plus what else feeds
 *            it: the global light angle, the colours a 'foreground' /
 *            'background' gradient stop resolves to, and the renderer itself.
 *
 * Plus `composed`: the layer's content at its fill opacity with the effects that
 * sit above it, ready to draw — keyed by fill and the above effects' full
 * settings. Changing a shadow's opacity re-renders nothing; changing Fill
 * recomposes without re-running a renderer.
 *
 * Settings are compared by value, never identity: the Layer Style dialog and
 * the Layers panel's eye edit the styles object in place.
 *
 * Results are region-sized and never written again once handed out — a changed
 * input makes new canvases — so a consumer can hold one across frames.
 *
 * Only the live composite (`getComposite`) uses this. `compositeDocument`, which
 * exports and the tests compare against, renders everything from scratch.
 */

/** Total bytes of cached results a document may hold before old entries go. */
let budget = 256 * 1024 * 1024;

export function setEffectCacheBudget(bytes) {
  // Not `bytes | 0`: that is a 32-bit integer, so the 2 GiB a 4096 MB memory
  // limit gives (the Preferences maximum) wrapped negative and became 0.
  const n = Math.floor(Number(bytes));
  budget = Number.isFinite(n) && n > 0 ? n : 0;
}

export function effectCacheBudget() {
  return budget;
}

class EffectCache {
  constructor() {
    /** @type {Map<string, object>} layer id -> entry */
    this.entries = new Map();
    this.frame = 0;
    this.stats = { renders: 0, composes: 0, hits: 0, bounds: 0 };
  }

  *canvases() {
    for (const e of this.entries.values()) {
      for (const r of e.results.values()) if (r.canvas) yield r.canvas;
      if (e.composed) yield e.composed.canvas;
    }
  }

  bytes() {
    let n = 0;
    for (const e of this.entries.values()) n += entryBytes(e);
    return n;
  }
}

function entryBytes(e) {
  let n = 0;
  for (const r of e.results.values()) if (r.canvas) n += r.canvas.width * r.canvas.height * 4;
  if (e.composed) n += e.composed.canvas.width * e.composed.canvas.height * 4;
  return n;
}

function cacheOf(doc) {
  if (!doc._fxCache) doc._fxCache = new EffectCache();
  return doc._fxCache;
}

/** Counters for tests and profiling: renderer calls, compositions, hits, bounds scans. */
export function effectCacheStats(doc) {
  const c = doc && doc._fxCache;
  return c ? { ...c.stats, entries: c.entries.size, bytes: c.bytes() } : { renders: 0, composes: 0, hits: 0, bounds: 0, entries: 0, bytes: 0 };
}

/** Forget everything cached for `doc`. */
export function clearEffectCache(doc) {
  if (doc && doc._fxCache) doc._fxCache.entries.clear();
}

/* ------------------------------------------------------------------ */
/* Keys                                                                */
/* ------------------------------------------------------------------ */

const rendererIds = new WeakMap();
let nextRendererId = 1;
function rendererId(fn) {
  let id = rendererIds.get(fn);
  if (!id) rendererIds.set(fn, (id = nextRendererId++));
  return id;
}

/** JSON with sorted keys, so two objects with the same values give the same string. */
function canon(v, skip = null) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map((x) => canon(x)).join(',')}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined && !(skip && skip.has(k))).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
}

const DRAW_ONLY = new Set(['opacity', 'blendMode']);

/**
 * What a renderer's output depends on besides the layer's pixels and region.
 * `withDraw` adds opacity and blend mode, for keys of composed results.
 */
function effectKey(cfg, fn, doc, withDraw) {
  let k = `${rendererId(fn)}${canon(cfg, withDraw ? null : DRAW_ONLY)}`;
  if (cfg.useGlobalLight) k += `|gl${doc.globalLight || 120}`;
  if (Array.isArray(cfg.stops) && cfg.stops.some((s) => s && (s.color === 'foreground' || s.color === 'background'))) {
    k += `|fgbg${canon(resolveStops(cfg.stops))}`;
  }
  return k;
}

function gpuState() {
  if (!isGPUEnabled() || !getGPUDevice()) return 'cpu';
  return `g${gpuGeneration()}${gpuEffectsBroken() ? 'b' : ''}`;
}

const sameRegion = (a, b) => (a === b) || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

/* ------------------------------------------------------------------ */
/* Entries                                                             */
/* ------------------------------------------------------------------ */

/**
 * The entry for `layer`, reset if its base no longer matches, with `region`
 * brought up to date. `getSrc` is called only if the bounds must be measured or
 * a renderer must run.
 */
function entryFor(layer, doc, getSrc) {
  const cache = cacheOf(doc);
  const key = layer.pixelKey();
  const rev = layer.pixelRevision();
  const tile = layer.tile;
  const x = tile ? tile.x : 0, y = tile ? tile.y : 0;
  const w = doc.width, h = doc.height;
  const gpu = gpuState();
  let e = cache.entries.get(layer.id);
  if (!e || e.keyRef.deref() !== key || e.rev !== rev || e.x !== x || e.y !== y
    || e.w !== w || e.h !== h || e.gpu !== gpu) {
    e = {
      keyRef: new WeakRef(key), rev, x, y, w, h, gpu,
      bounds: undefined, reach: -1, region: undefined,
      results: new Map(), composed: null, lastUsed: 0,
    };
    cache.entries.set(layer.id, e);
  }
  e.lastUsed = cache.frame;

  const reach = effectReach(layer.styles);
  if (e.region === undefined || e.reach !== reach) {
    if (e.bounds === undefined) {
      e.bounds = alphaBoundsFast(getSrc());
      cache.stats.bounds++;
    }
    const region = regionFromBounds(e.bounds, reach, w, h);
    if (e.region === undefined || !sameRegion(region, e.region)) {
      e.results.clear();
      e.composed = null;
    }
    e.region = region;
    e.reach = reach;
  }
  return e;
}

/** A per-call helper: the source canvas, the cropped environment, built at most once. */
function lazyInputs(layer, doc) {
  let src, env;
  return {
    src: () => (src === undefined ? (src = layer.renderCanvas()) : src),
    env(e) {
      if (!env) {
        const s = this.src();
        const esrc = e.region ? cropCanvas(s, e.region) : s;
        env = envFor(esrc, e.region, layer, doc, layer.styles || {}, doc.width, doc.height);
      }
      return env;
    },
  };
}

function resultFor(e, id, cfg, fn, doc, inputs, cache) {
  const key = effectKey(cfg, fn, doc, false);
  const hit = e.results.get(id);
  if (hit && hit.key === key) {
    cache.stats.hits++;
    return hit.canvas;
  }
  const canvas = fn(cfg, inputs.env(e)) || null;
  cache.stats.renders++;
  e.results.set(id, { key, canvas });
  return canvas;
}

/* ------------------------------------------------------------------ */
/* What the compositor asks for                                        */
/* ------------------------------------------------------------------ */

/**
 * The effects behind a layer's content — drop shadow, outer glow — each
 * region-sized with where it goes and how to blend it.
 *
 * @returns {{canvas:HTMLCanvasElement, x:number, y:number, mode:string, opacity:number}[]}
 */
export function cachedBelowEffects(layer, doc) {
  const list = runnableEffects(layer.styles || {}, EFFECT_ORDER_BELOW);
  if (!list.length) return [];
  const cache = cacheOf(doc);
  const inputs = lazyInputs(layer, doc);
  const e = entryFor(layer, doc, inputs.src);
  const out = [];
  for (const [cfg, fn, id] of list) {
    const canvas = resultFor(e, id, cfg, fn, doc, inputs, cache);
    if (!canvas) continue;
    out.push({
      canvas,
      x: e.region ? e.region.x : 0,
      y: e.region ? e.region.y : 0,
      mode: cfg.blendMode || 'normal',
      opacity: cfg.opacity == null ? 1 : cfg.opacity,
    });
  }
  dropIfHuge(cache, layer.id, e);
  return out;
}

/**
 * The layer's content at `fill`, with the effects above it drawn on top —
 * what `applyLayerStyles(..., {skipBelow: true})` draws, but region-sized.
 *
 * @returns {{canvas:HTMLCanvasElement, x:number, y:number}}
 */
export function cachedComposed(layer, doc, fill) {
  const styles = layer.styles || {};
  const above = runnableEffects(styles, EFFECT_ORDER_ABOVE);
  const cache = cacheOf(doc);
  const inputs = lazyInputs(layer, doc);
  const e = entryFor(layer, doc, inputs.src);
  let key = `f${fill}`;
  for (const [cfg, fn] of above) key += `;${effectKey(cfg, fn, doc, true)}`;
  const rx = e.region ? e.region.x : 0, ry = e.region ? e.region.y : 0;
  if (e.composed && e.composed.key === key) {
    cache.stats.hits++;
    return { canvas: e.composed.canvas, x: rx, y: ry };
  }
  const rw = e.region ? e.region.w : doc.width, rh = e.region ? e.region.h : doc.height;
  const canvas = createCanvas(rw, rh);
  const c = canvas.getContext('2d');
  c.globalAlpha = fill;
  c.drawImage(inputs.src(), -rx, -ry);
  c.globalAlpha = 1;
  for (const [cfg, fn, id] of above) {
    drawEffectResult(c, resultFor(e, id, cfg, fn, doc, inputs, cache), cfg, 0, 0);
  }
  cache.stats.composes++;
  e.composed = { key, canvas };
  dropIfHuge(cache, layer.id, e);
  return { canvas, x: rx, y: ry };
}

/** One entry bigger than half the budget is used this frame and not kept. */
function dropIfHuge(cache, id, e) {
  if (entryBytes(e) > budget / 2) cache.entries.delete(id);
}

/** Start of a cached composite. */
export function beginEffectFrame(doc) {
  cacheOf(doc).frame++;
}

/**
 * End of a cached composite: forget layers that no longer exist, then evict the
 * least recently used entries (never one used this frame) until under budget.
 */
export function endEffectFrame(doc) {
  const cache = doc._fxCache;
  if (!cache) return;
  const ids = new Set(doc.flatLayers().map((l) => l.id));
  for (const id of cache.entries.keys()) if (!ids.has(id)) cache.entries.delete(id);
  let total = cache.bytes();
  if (total <= budget) return;
  const old = [...cache.entries.entries()]
    .filter(([, e]) => e.lastUsed < cache.frame)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [id, e] of old) {
    if (total <= budget) break;
    total -= entryBytes(e);
    cache.entries.delete(id);
  }
}
