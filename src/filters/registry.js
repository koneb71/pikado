/**
 * Filter registry.
 *
 * Register with:
 *   registerFilter({
 *     id: 'gaussian-blur',
 *     name: 'Gaussian Blur...',
 *     menu: 'Blur',                    // Filter > Blur > ...
 *     params: [ ...ParamDescriptor ],  // drives the auto-generated dialog
 *     preview: true,                   // live preview in the dialog (default true)
 *     needsDialog: true,               // false = run immediately (e.g. Sharpen)
 *     apply(imageData, params, ctx) {  // mutate in place OR return new ImageData
 *       // ctx = {doc, layer, width, height, selection, seed}
 *     },
 *   })
 *
 * `apply` receives the *layer's* pixels. Selection masking, undo and history
 * are handled by the caller (src/filters/run.js), so filters stay pure.
 */

/** @type {Map<string, object>} */
export const filters = new Map();

/** Menu order for Filter > ... submenus. */
export const FILTER_MENUS = [
  'Blur',
  'Distort',
  'Noise',
  'Pixelate',
  'Render',
  'Sharpen',
  'Stylize',
  'Other',
];

export function registerFilter(def) {
  if (!def || !def.id) throw new Error('Filter needs an id');
  if (!def.defaults) {
    def.defaults = {};
    for (const p of def.params || []) if (p.key !== undefined) def.defaults[p.key] = p.default;
  }
  if (def.preview === undefined) def.preview = true;
  if (def.needsDialog === undefined) def.needsDialog = (def.params || []).length > 0;
  filters.set(def.id, def);
  return def;
}

export function getFilter(id) {
  return filters.get(id) || null;
}

export function listFilters(menu) {
  const all = [...filters.values()];
  return menu ? all.filter((f) => f.menu === menu) : all;
}

export function filtersByMenu() {
  const map = new Map();
  for (const m of FILTER_MENUS) map.set(m, []);
  for (const f of filters.values()) {
    if (!map.has(f.menu)) map.set(f.menu, []);
    map.get(f.menu).push(f);
  }
  for (const [, list] of map) list.sort((a, b) => a.name.localeCompare(b.name));
  return map;
}

/**
 * Run a filter on ImageData. Returns the resulting ImageData (which may be a
 * different object than the input if the filter chose to allocate).
 */
export function runFilter(id, imageData, params, ctx) {
  const f = filters.get(id);
  if (!f) return imageData;
  const merged = { ...f.defaults, ...(params || {}) };
  const res = f.apply(imageData, merged, ctx || { width: imageData.width, height: imageData.height });
  return res instanceof ImageData ? res : imageData;
}

/* ------------------------------------------------------------------ */
/* Shared numeric helpers for filter implementations                   */
/* ------------------------------------------------------------------ */

/** Deterministic PRNG so "Add Noise" etc. can be previewed stably. */
export function makeRandom(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Bilinear sample with edge clamping. Writes into `out` [r,g,b,a]. */
export function sampleBilinear(data, w, h, x, y, out) {
  x = x < 0 ? 0 : x > w - 1 ? w - 1 : x;
  y = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
  for (let k = 0; k < 4; k++) {
    const a = data[i00 + k] + (data[i10 + k] - data[i00 + k]) * fx;
    const b = data[i01 + k] + (data[i11 + k] - data[i01 + k]) * fx;
    out[k] = a + (b - a) * fy;
  }
  return out;
}

/**
 * Separable convolution helper — runs a 1-D kernel horizontally then
 * vertically. Handles alpha correctly by working in premultiplied space.
 */
export function separableConvolve(imageData, kernel) {
  const { width: w, height: h, data } = imageData;
  const r = (kernel.length - 1) / 2;
  const tmp = new Float32Array(w * h * 4);
  const src = new Float32Array(w * h * 4);

  // premultiply
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    src[i] = data[i] * a;
    src[i + 1] = data[i + 1] * a;
    src[i + 2] = data[i + 2] * a;
    src[i + 3] = data[i + 3];
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let k = -r; k <= r; k++) {
        const xx = Math.min(w - 1, Math.max(0, x + k));
        const i = (y * w + xx) * 4;
        const kv = kernel[k + r];
        s0 += src[i] * kv; s1 += src[i + 1] * kv; s2 += src[i + 2] * kv; s3 += src[i + 3] * kv;
      }
      const o = (y * w + x) * 4;
      tmp[o] = s0; tmp[o + 1] = s1; tmp[o + 2] = s2; tmp[o + 3] = s3;
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let k = -r; k <= r; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        const i = (yy * w + x) * 4;
        const kv = kernel[k + r];
        s0 += tmp[i] * kv; s1 += tmp[i + 1] * kv; s2 += tmp[i + 2] * kv; s3 += tmp[i + 3] * kv;
      }
      const o = (y * w + x) * 4;
      const a = s3;
      if (a <= 0.5) {
        data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; data[o + 3] = 0;
      } else {
        const inv = 255 / a;
        data[o] = s0 * inv;
        data[o + 1] = s1 * inv;
        data[o + 2] = s2 * inv;
        data[o + 3] = a;
      }
    }
  }
  return imageData;
}

/** Normalised 1-D Gaussian kernel for a given sigma. */
export function gaussianKernel(sigma) {
  if (sigma <= 0) return new Float32Array([1]);
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(r * 2 + 1);
  const s2 = 2 * sigma * sigma;
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / s2);
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}
