/**
 * The Google Fonts catalogue: lookup and search over ~1,900 families.
 *
 * Data only. This module never touches the network — the list is generated at
 * build time by `scripts/fetch-google-fonts.mjs` and imported lazily, so the
 * 60 KB it costs is paid by people who open the font browser and by nobody
 * else.
 *
 * It is separate from `font-manager.js` on purpose: knowing that a family
 * *exists* is a different question from having its bytes, and the answer to the
 * first one has to be available before any decision to download.
 */

let entries = null;
let byName = null;
let categories = [];
let loading = null;

function decode(mod) {
  categories = mod.CATEGORIES;
  const out = [];
  const index = new Map();
  for (const line of mod.default.split('\n')) {
    if (!line) continue;
    const [family, cat, weights, italic, variable] = line.split('|');
    const e = {
      family,
      category: categories[Number(cat)] || 'sans-serif',
      weights: weights.split(',').map(Number),
      italic: italic === '1',
      variable: variable === '1',
    };
    out.push(e);
    index.set(family.toLowerCase(), e);
  }
  entries = out;
  byName = index;
}

/**
 * Load the catalogue. Idempotent, and safe to call from several places at once
 * — they share one import and one decode.
 * @returns {Promise<void>}
 */
export function loadCatalog() {
  if (entries) return Promise.resolve();
  if (!loading) {
    loading = import('./google-catalog.data.js')
      .then(decode)
      .catch((err) => {
        // A failed chunk must not wedge the feature permanently; the next call
        // gets a fresh attempt.
        loading = null;
        throw err;
      });
  }
  return loading;
}

/** Whether the catalogue is in memory — synchronous, for render paths. */
export function catalogReady() {
  return !!entries;
}

/** When it was generated, so the browser can say how fresh the list is. */
export async function catalogGenerated() {
  await loadCatalog();
  const mod = await import('./google-catalog.data.js');
  return mod.GENERATED;
}

/**
 * One family by exact name, case-insensitively.
 * @returns {{family,category,weights,italic,variable}|null}
 */
export function findFamily(name) {
  if (!byName || !name) return null;
  return byName.get(String(name).toLowerCase()) || null;
}

/** Every category present, in catalogue order. */
export function catalogCategories() {
  return categories.slice();
}

export function catalogSize() {
  return entries ? entries.length : 0;
}

/**
 * Search the catalogue.
 *
 * Results keep the catalogue's own popularity order rather than being scored,
 * so the families anyone is actually looking for are in the first screenful. A
 * prefix match sorts ahead of a mid-word one, which is the only ranking that
 * earns its keep: typing "rob" should reach Roboto before Rock Salt.
 *
 * @param {{q?:string, category?:string, limit?:number}} [opts]
 * @returns {{family,category,weights,italic,variable}[]}
 */
export function searchFamilies(opts = {}) {
  if (!entries) return [];
  const q = String(opts.q || '').trim().toLowerCase();
  const cat = opts.category || '';
  const starts = [];
  const contains = [];
  for (const e of entries) {
    if (cat && e.category !== cat) continue;
    if (!q) { starts.push(e); continue; }
    const name = e.family.toLowerCase();
    const at = name.indexOf(q);
    if (at === 0) starts.push(e);
    else if (at > 0) contains.push(e);
  }
  const out = starts.concat(contains);
  return opts.limit ? out.slice(0, opts.limit) : out;
}
