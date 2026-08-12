import { LayerType } from '../core/layer.js';
import { normalizeFontId, googleFamilyOf, googleNameFor, getFontFamily } from './fonts.js';

/**
 * Which fonts a document names, and what is known about each.
 *
 * Kept apart from both `font-manager.js` and `pkd.js` because it is neither
 * network nor format: it is the one place that walks a layer tree looking for
 * type. `psd-write.js` needs the same answer for its `FontSet`, and the browser
 * dialog needs it for its "in this document" filter.
 */

/**
 * Where per-family capabilities come from, when anything knows them.
 *
 * A hook rather than an import so that saving a `.pkd` does not drag in the
 * font manager, and with it IndexedDB, the preferences store and the catalogue.
 * `font-manager.js` registers itself when it loads; until then the table falls
 * back to what the bundled list knows, which is the right answer for a document
 * with no downloaded fonts in it.
 */
let capabilityProvider = null;

export function setCapabilityProvider(fn) {
  capabilityProvider = typeof fn === 'function' ? fn : null;
}

/**
 * What is known about a family right now, or null.
 *
 * The same hook the `.pkd` manifest uses, exposed so PSD export can ask without
 * importing the font manager — which would drag IndexedDB and the catalogue
 * into a format writer.
 */
export function capabilitiesOf(id) {
  return capabilityProvider ? capabilityProvider(id) : null;
}

/** Every distinct font id used by text in a tree, including nested documents. */
export function fontsUsedBy(doc) {
  const ids = new Set();
  if (!doc) return ids;

  const walk = (layers) => {
    for (const l of layers || []) {
      if (l.type === LayerType.GROUP) { walk(l.children); continue; }
      if (l.text) {
        const id = normalizeFontId(l.text.font || l.text.fontFamily);
        if (id) ids.add(id);
      }
      // A Smart Object carries a whole document, and its text counts: the file
      // will not render right without those fonts either.
      if (l.smart && l.smart.doc) for (const nested of fontsUsedBy(l.smart.doc)) ids.add(nested);
    }
  };
  walk(doc.layers);
  return ids;
}

/**
 * The manifest entry for a `.pkd` — a reference per family, never bytes.
 *
 * @param {object} doc
 * @param {(id: string) => ({weights?:number[], italics?:number[], category?:string}|null)} [caps]
 *   what is known about a family right now; the manager supplies it when it is
 *   loaded, and the table falls back to the catalogue's own description.
 * @returns {{id:string, family:string, category:string, weights:number[], italics:number[]}[]}
 */
export function fontTableFor(doc, caps = capabilityProvider) {
  const out = [];
  for (const id of fontsUsedBy(doc)) {
    const builtin = getFontFamily(id);
    // A pure system stack needs no entry: it is available wherever the file
    // opens, and naming it would only invite a pointless missing-font warning.
    if (builtin && !builtin.google) continue;

    const family = googleNameFor(id) || googleFamilyOf(id) || id;
    const known = caps ? caps(id) : null;
    out.push({
      id,
      family,
      category: (known && known.category) || (builtin && builtin.category) || '',
      weights: (known && known.weights) || [],
      italics: (known && known.italics) || [],
    });
  }
  return out.sort((a, b) => a.family.localeCompare(b.family));
}

/** What a document's own table says about an id, or null. */
export function tableEntry(doc, id) {
  const key = normalizeFontId(id);
  const table = doc && Array.isArray(doc.fontTable) ? doc.fontTable : [];
  return table.find((e) => e.id === key) || null;
}
