/**
 * Adjustment registry.
 *
 * An adjustment is a pure pixel transform used in two places:
 *   1. Image > Adjustments  (destructive, applied to the active layer)
 *   2. Adjustment layers    (non-destructive, applied by the compositor)
 *
 * Register with:
 *   registerAdjustment({
 *     id: 'brightness-contrast',
 *     name: 'Brightness/Contrast',
 *     group: 'tone',                  // menu grouping
 *     params: [ ...ParamDescriptor ], // drives the auto-generated dialog
 *     defaults: {brightness: 0},      // optional, else derived from params
 *     apply(imageData, params, ctx) {},// mutate imageData in place
 *     renderUI(container, state, onChange) {}, // optional custom dialog body
 *     layerable: true,                // can be an adjustment layer (default true)
 *   })
 *
 * ParamDescriptor:
 *   {key, label, type, min, max, step, default, options, unit, suffix}
 *   type: 'slider' | 'number' | 'select' | 'checkbox' | 'color' | 'angle' | 'curve' | 'gradient' | 'label'
 */

/** @type {Map<string, object>} */
export const adjustments = new Map();

export function registerAdjustment(def) {
  if (!def || !def.id) throw new Error('Adjustment needs an id');
  if (!def.defaults) {
    def.defaults = {};
    for (const p of def.params || []) if (p.key !== undefined) def.defaults[p.key] = p.default;
  }
  if (def.layerable === undefined) def.layerable = true;
  adjustments.set(def.id, def);
  return def;
}

export function getAdjustment(id) {
  return adjustments.get(id) || null;
}

export function listAdjustments() {
  return [...adjustments.values()];
}

export function defaultParams(id) {
  const a = adjustments.get(id);
  return a ? structuredClone(a.defaults) : {};
}

/**
 * Apply an adjustment to ImageData in place.
 * Unknown ids are a no-op so a corrupt document never crashes the compositor.
 */
export function applyAdjustment(id, imageData, params, ctx) {
  const a = adjustments.get(id);
  if (!a || typeof a.apply !== 'function') return imageData;
  try {
    const merged = { ...a.defaults, ...(params || {}) };
    a.apply(imageData, merged, ctx || {});
  } catch (err) {
    console.error(`[adjustment:${id}]`, err);
  }
  return imageData;
}

/* ------------------------------------------------------------------ */
/* Shared helpers for adjustment implementations                       */
/* ------------------------------------------------------------------ */

/** Build a 256-entry lookup table from a per-channel function. */
export function buildLUT(fn) {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = fn(i);
  return lut;
}

/** Apply per-channel LUTs (any may be null to leave a channel untouched). */
export function applyLUT(imageData, rLut, gLut = rLut, bLut = rLut) {
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    if (rLut) d[i] = rLut[d[i]];
    if (gLut) d[i + 1] = gLut[d[i + 1]];
    if (bLut) d[i + 2] = bLut[d[i + 2]];
  }
  return imageData;
}

/**
 * Blend an adjusted result back toward the original by `amount` (0..1).
 * Adjustment implementations use this for "Amount"-style sliders.
 */
export function mixImageData(original, adjusted, amount) {
  const a = original.data, b = adjusted.data;
  for (let i = 0; i < a.length; i += 4) {
    b[i] = a[i] + (b[i] - a[i]) * amount;
    b[i + 1] = a[i + 1] + (b[i + 1] - a[i + 1]) * amount;
    b[i + 2] = a[i + 2] + (b[i + 2] - a[i + 2]) * amount;
  }
  return adjusted;
}
