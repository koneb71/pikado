/**
 * Font catalogue + measurement helpers for the type tools.
 *
 * `FONT_FAMILIES` mixes system stacks (always available) with a handful of
 * Google families, which `ensureFont()` downloads through `font-manager.js`.
 * Every entry exposes a CSS `stack` string that both the canvas renderer and
 * the editing `<textarea>` use, so glyph metrics agree exactly.
 *
 * A family not in that list is identified as `google:<Exact Family Name>` and
 * comes from the bundled catalogue — see `normalizeFontId` below, which is
 * where the three dialects that have historically been written into
 * `layer.text.font` are reconciled.
 */

import { createCanvas } from '../core/util.js';

const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/**
 * @type {{id:string, name:string, stack:string, google?:string, category:string}[]}
 */
export const FONT_FAMILIES = [
  { id: 'system', name: 'System UI', stack: SANS, category: 'Sans' },
  { id: 'arial', name: 'Arial', stack: 'Arial, "Helvetica Neue", Helvetica, sans-serif', category: 'Sans' },
  { id: 'helvetica', name: 'Helvetica Neue', stack: '"Helvetica Neue", Helvetica, Arial, sans-serif', category: 'Sans' },
  { id: 'verdana', name: 'Verdana', stack: 'Verdana, Geneva, sans-serif', category: 'Sans' },
  { id: 'tahoma', name: 'Tahoma', stack: 'Tahoma, Verdana, sans-serif', category: 'Sans' },
  { id: 'trebuchet', name: 'Trebuchet MS', stack: '"Trebuchet MS", Tahoma, sans-serif', category: 'Sans' },
  { id: 'segoe', name: 'Segoe UI', stack: '"Segoe UI", Frutiger, "Helvetica Neue", sans-serif', category: 'Sans' },
  { id: 'gill', name: 'Gill Sans', stack: '"Gill Sans", "Gill Sans MT", Calibri, sans-serif', category: 'Sans' },
  { id: 'futura', name: 'Futura', stack: 'Futura, "Century Gothic", AppleGothic, sans-serif', category: 'Sans' },
  { id: 'impact', name: 'Impact', stack: 'Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif', category: 'Display' },

  { id: 'inter', name: 'Inter', stack: 'Inter, ' + SANS, google: 'Inter', category: 'Sans' },
  { id: 'roboto', name: 'Roboto', stack: 'Roboto, ' + SANS, google: 'Roboto', category: 'Sans' },
  { id: 'open-sans', name: 'Open Sans', stack: '"Open Sans", ' + SANS, google: 'Open Sans', category: 'Sans' },
  { id: 'lato', name: 'Lato', stack: 'Lato, ' + SANS, google: 'Lato', category: 'Sans' },
  { id: 'montserrat', name: 'Montserrat', stack: 'Montserrat, ' + SANS, google: 'Montserrat', category: 'Sans' },
  { id: 'poppins', name: 'Poppins', stack: 'Poppins, ' + SANS, google: 'Poppins', category: 'Sans' },
  { id: 'raleway', name: 'Raleway', stack: 'Raleway, ' + SANS, google: 'Raleway', category: 'Sans' },
  { id: 'oswald', name: 'Oswald', stack: 'Oswald, "Arial Narrow", sans-serif', google: 'Oswald', category: 'Display' },

  { id: 'times', name: 'Times New Roman', stack: '"Times New Roman", Times, serif', category: 'Serif' },
  { id: 'georgia', name: 'Georgia', stack: 'Georgia, "Times New Roman", serif', category: 'Serif' },
  { id: 'garamond', name: 'Garamond', stack: 'Garamond, "EB Garamond", Baskerville, serif', category: 'Serif' },
  { id: 'palatino', name: 'Palatino', stack: 'Palatino, "Palatino Linotype", "Book Antiqua", serif', category: 'Serif' },
  { id: 'playfair', name: 'Playfair Display', stack: '"Playfair Display", Georgia, serif', google: 'Playfair Display', category: 'Serif' },
  { id: 'merriweather', name: 'Merriweather', stack: 'Merriweather, Georgia, serif', google: 'Merriweather', category: 'Serif' },

  { id: 'courier', name: 'Courier New', stack: '"Courier New", Courier, monospace', category: 'Mono' },
  { id: 'mono', name: 'Monospace', stack: 'ui-monospace, Menlo, Consolas, "Liberation Mono", monospace', category: 'Mono' },
  { id: 'jetbrains', name: 'JetBrains Mono', stack: '"JetBrains Mono", ui-monospace, monospace', google: 'JetBrains Mono', category: 'Mono' },

  { id: 'comic', name: 'Comic Sans MS', stack: '"Comic Sans MS", "Comic Sans", cursive', category: 'Display' },
  { id: 'brush', name: 'Brush Script MT', stack: '"Brush Script MT", "Segoe Script", cursive', category: 'Script' },
  { id: 'pacifico', name: 'Pacifico', stack: 'Pacifico, cursive', google: 'Pacifico', category: 'Script' },
  { id: 'lobster', name: 'Lobster', stack: 'Lobster, cursive', google: 'Lobster', category: 'Script' },
  { id: 'dancing', name: 'Dancing Script', stack: '"Dancing Script", cursive', google: 'Dancing Script', category: 'Script' },
];

/** `{value,label}` list for a `select` ParamDescriptor. */
export const FONT_FAMILY_OPTIONS = FONT_FAMILIES.map((f) => ({ value: f.id, label: f.name }));

/**
 * Every family the user can pick right now: the built-ins, plus whatever has
 * been downloaded, plus the layer's own family when it is neither.
 *
 * One builder for all three pickers. The `current` shim is what lets a control
 * display a family it has no entry for — a Google family not yet downloaded, or
 * one named by a PSD — instead of silently showing the wrong name.
 *
 * @param {string} [current] the id the caller is displaying
 * @param {{id:string,name:string}[]} [installed] downloaded families
 * @returns {{value:string,label:string}[]}
 */
/**
 * The value a picker uses to mean "open the font browser".
 *
 * A row in the list rather than a button beside it: the question "which font?"
 * and the question "is there another font?" are the same question, and a user
 * who scrolls to the bottom of a short list looking for something is exactly
 * the person who needs the catalogue.
 */
export const BROWSE_FONTS = '\u0000browse';

export function fontFamilyOptions(current = '', installed = []) {
  const out = [...FONT_FAMILY_OPTIONS];
  for (const f of installed) {
    if (!out.some((o) => o.value === f.id)) out.push({ value: f.id, label: f.name });
  }
  const key = normalizeFontId(current);
  if (key && !out.some((o) => o.value === key)) {
    out.unshift({ value: key, label: googleFamilyOf(key) || String(key) });
  }
  out.push({ value: BROWSE_FONTS, label: 'Browse Google Fonts…' });
  return out;
}

export const FONT_WEIGHTS = [
  { value: 100, label: 'Thin' },
  { value: 200, label: 'Extra Light' },
  { value: 300, label: 'Light' },
  { value: 400, label: 'Regular' },
  { value: 500, label: 'Medium' },
  { value: 600, label: 'Semibold' },
  { value: 700, label: 'Bold' },
  { value: 800, label: 'Extra Bold' },
  { value: 900, label: 'Black' },
];

/** Common type sizes offered in the options bar. */
export const FONT_SIZES = [6, 8, 9, 10, 11, 12, 14, 16, 18, 21, 24, 30, 36, 48, 60, 72, 96, 144, 288];

/* ------------------------------------------------------------------ */
/* Font identity                                                       */
/* ------------------------------------------------------------------ */

/**
 * A downloaded Google family is identified as `google:<Exact Family Name>`.
 *
 * The name *is* the id rather than a slug, and that is load-bearing. The exact
 * string is already the key for the css2 API, for CSS `font-family`, for
 * `FontFace`, and for the catalogue — a slug would add a lossy two-way mapping
 * to maintain and a collision surface ("Noto Sans JP" vs "Noto Sans Jp"). More
 * importantly the name-as-id resolves with *nothing else loaded*: reopening a
 * `.pkd` offline, with no catalogue chunk and no IndexedDB read, still knows
 * which family the layer wants and what to call it in a warning.
 */
export const GOOGLE_PREFIX = 'google:';

/**
 * The css2 URL for a family, built from what that family actually offers.
 *
 * This is the whole of a bug that shipped for the life of the feature. The old
 * code posted `:ital,wght@0,100..900;1,100..900` for every family, and a weight
 * range a family does not have is a **hard failure**, not a fallback to what it
 * does have. Ten of the fourteen bundled Google families — Open Sans, Lato,
 * Poppins, Oswald, Playfair Display, Merriweather, JetBrains Mono, Pacifico,
 * Lobster, Dancing Script — never loaded at all, and because the loader
 * resolved `false` instead of throwing, picking one silently rendered the CSS
 * fallback instead.
 *
 * Three shapes, decided by the family rather than assumed:
 *
 *   static, one weight   `?family=Pacifico`                  (no axis at all)
 *   static, many weights `?family=Lato:ital,wght@0,100;0,300;…;1,100;…`
 *   variable             `?family=Open+Sans:ital,wght@0,300..800;1,300..800`
 *
 * @param {{family:string, weights?:number[], italic?:boolean, variable?:boolean}[]} families
 * @param {{text?:string}} [opts] `text` asks Google to subset to those glyphs,
 *   which is what makes a preview a few KB rather than the whole face.
 * @returns {string}
 */
export function css2Url(families, opts = {}) {
  const parts = [];
  for (const f of families) {
    if (!f || !f.family) continue;
    const name = f.family.trim().replace(/\s+/g, '+');
    const weights = (f.weights || []).filter((w) => Number.isFinite(w)).sort((a, b) => a - b);

    // No axis spec always resolves, so it is the right answer whenever there is
    // nothing to say — one weight, or no weight data at all.
    if (weights.length < 2 && !f.italic) { parts.push(name); continue; }

    const axis = f.variable
      ? `${weights[0]}..${weights[weights.length - 1]}`
      : weights.join(';0,');
    const spec = f.italic
      ? `ital,wght@0,${axis};1,${f.variable ? axis : weights.join(';1,')}`
      : `wght@${f.variable ? axis : weights.join(';')}`;
    parts.push(`${name}:${spec}`);
  }
  if (!parts.length) return '';
  const text = opts.text ? `&text=${encodeURIComponent(opts.text)}` : '';
  return `https://fonts.googleapis.com/css2?family=${parts.join('&family=')}${text}&display=swap`;
}

/** `google:Playfair Display` -> `Playfair Display`, otherwise ''. */
export function googleFamilyOf(id) {
  return typeof id === 'string' && id.startsWith(GOOGLE_PREFIX)
    ? id.slice(GOOGLE_PREFIX.length)
    : '';
}

/**
 * The Google family name behind any id, or `''` for a pure system stack.
 *
 * Distinct from `googleFamilyOf` because the built-ins are the awkward case:
 * `normalizeFontId` collapses `google:Pacifico` to the built-in id `pacifico`,
 * which is right for identity but loses the name the font is *stored and
 * registered* under. Anything asking "which downloaded family is this?" has to
 * come through here, or every built-in Google family reads as not installed.
 */
export function googleNameFor(id) {
  const key = normalizeFontId(id);
  const direct = googleFamilyOf(key);
  if (direct) return direct;
  const f = FONT_FAMILIES.find((x) => x.id === key);
  return (f && f.google) || '';
}

/**
 * Aliases onto canonical ids, built once.
 *
 * Three separate dialects have to land on the same value: the catalogue ids the
 * Type tool writes, the display names and raw CSS families the Character panel
 * writes (`'Arial'`, `'sans-serif'`), and `google:` names for families that are
 * already built in.
 */
const ALIASES = (() => {
  const m = new Map();
  const put = (k, id) => { if (k) m.set(String(k).toLowerCase(), id); };
  for (const f of FONT_FAMILIES) {
    put(f.id, f.id);
    put(f.name, f.id);
    // A built-in beats a download: `google:Roboto` collapses to `roboto`, which
    // keeps its PostScript faces for PSD export and stops every picker
    // listing Roboto twice.
    if (f.google) {
      put(f.google, f.id);
      put(GOOGLE_PREFIX + f.google, f.id);
    }
  }
  // The generic CSS families the Character panel offers as if they were fonts.
  put('system-ui', 'system');
  put('sans-serif', 'system');
  put('serif', 'times');
  put('monospace', 'mono');
  put('cursive', 'brush');
  return m;
})();

/**
 * The canonical id for anything that has ever been written into
 * `layer.text.font` or `layer.text.fontFamily`.
 *
 * Pure and synchronous — no catalogue, no IndexedDB — because it is called from
 * `fontStack`, which runs on every rasterisation.
 *
 * Anything unrecognised is returned unchanged. That is deliberate: a family
 * name from a PSD we have no mapping for still has to render through the CSS
 * stack, and inventing an id for it would lose the only information we have.
 *
 * @param {string} v
 * @returns {string}
 */
export function normalizeFontId(v) {
  if (!v || typeof v !== 'string') return 'system';
  const hit = ALIASES.get(v.toLowerCase());
  if (hit) return hit;
  const g = googleFamilyOf(v);
  // `google:` survives even when the family is unknown to us — offline, that
  // prefix plus the name is the whole of what we know, and it is enough.
  return g ? GOOGLE_PREFIX + g.trim() : v;
}

/**
 * Fallback stacks per catalogue category, so a substituted face is at least the
 * right shape — a serif standing in for a serif.
 */
const CATEGORY_STACKS = {
  'sans-serif': SANS,
  serif: 'Georgia, "Times New Roman", serif',
  display: SANS,
  handwriting: '"Segoe Script", "Brush Script MT", cursive',
  monospace: 'ui-monospace, Menlo, Consolas, monospace',
};

/**
 * The CSS stack for a font id — unknown ids fall through to a system stack so
 * old documents never render blank.
 *
 * @param {string} id
 * @param {string} [category] the catalogue category, when the caller knows it,
 *   so a missing download substitutes something of the right shape
 */
export function fontStack(id, category = '') {
  const key = normalizeFontId(id);
  const f = FONT_FAMILIES.find((x) => x.id === key);
  if (f) return f.stack;
  const google = googleFamilyOf(key);
  const tail = CATEGORY_STACKS[category] || SANS;
  if (google) return `"${google}", ${tail}`;
  return key && /[a-z]/i.test(key) ? `${key}, ${tail}` : tail;
}

export function getFontFamily(id) {
  const key = normalizeFontId(id);
  return FONT_FAMILIES.find((x) => x.id === key) || null;
}

/* ------------------------------------------------------------------ */
/* PostScript face names                                               */
/* ------------------------------------------------------------------ */

/**
 * Real PostScript face names per family, for the four style slots a font file
 * can occupy.
 *
 * A PSD names a type layer's font by its *PostScript* name, which identifies
 * one face — one file — not a family. So bold and italic can only travel as a
 * real face when that face exists as its own file. Families that ship a single
 * file (Impact, Brush Script, Pacifico, Lobster) or that have no italic
 * (Tahoma, Comic Sans, Oswald, Dancing Script) deliberately leave those slots
 * out, and `postScriptFace` then names the closest face it does have and
 * reports the remainder as FauxBold / FauxItalic — which is exactly what
 * Photoshop does itself when a family has no real bold.
 *
 * The names are the ones the shipping files carry: Monotype's `MT` / `PS`
 * suffixes for the Windows core fonts, Apple's for the macOS faces, and
 * Google's static-face naming for the webfont families. A family is listed only
 * where the face name is a well-known constant of the font file — an
 * unresolvable PostScript name is worse than faux styling, because Photoshop
 * then substitutes a completely different family. None of this could be checked
 * against a Photoshop install; see the note in `src/io/psd-write.js`.
 *
 * @type {Object<string, {regular:string, bold?:string, italic?:string, boldItalic?:string}>}
 */
export const POSTSCRIPT_FACES = {
  // The 35 core PostScript faces — always resolvable.
  system: { regular: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique' },

  arial: { regular: 'ArialMT', bold: 'Arial-BoldMT', italic: 'Arial-ItalicMT', boldItalic: 'Arial-BoldItalicMT' },
  helvetica: { regular: 'HelveticaNeue', bold: 'HelveticaNeue-Bold', italic: 'HelveticaNeue-Italic', boldItalic: 'HelveticaNeue-BoldItalic' },
  verdana: { regular: 'Verdana', bold: 'Verdana-Bold', italic: 'Verdana-Italic', boldItalic: 'Verdana-BoldItalic' },
  // Tahoma ships Regular and Bold only.
  tahoma: { regular: 'Tahoma', bold: 'Tahoma-Bold' },
  // The bold-italic file drops the "MS" — a quirk of the shipped font, not a typo.
  trebuchet: { regular: 'TrebuchetMS', bold: 'TrebuchetMS-Bold', italic: 'TrebuchetMS-Italic', boldItalic: 'Trebuchet-BoldItalic' },
  segoe: { regular: 'SegoeUI', bold: 'SegoeUI-Bold', italic: 'SegoeUI-Italic', boldItalic: 'SegoeUI-BoldItalic' },
  gill: { regular: 'GillSans', bold: 'GillSans-Bold', italic: 'GillSans-Italic', boldItalic: 'GillSans-BoldItalic' },
  // macOS Futura is a Medium-weight regular and has no bold-italic file.
  futura: { regular: 'Futura-Medium', bold: 'Futura-Bold', italic: 'Futura-MediumItalic' },
  impact: { regular: 'Impact' },

  times: { regular: 'TimesNewRomanPSMT', bold: 'TimesNewRomanPS-BoldMT', italic: 'TimesNewRomanPS-ItalicMT', boldItalic: 'TimesNewRomanPS-BoldItalicMT' },
  georgia: { regular: 'Georgia', bold: 'Georgia-Bold', italic: 'Georgia-Italic', boldItalic: 'Georgia-BoldItalic' },
  // Monotype Garamond ships Regular, Italic and Bold, but no bold-italic.
  garamond: { regular: 'Garamond', bold: 'Garamond-Bold', italic: 'Garamond-Italic' },
  palatino: { regular: 'Palatino-Roman', bold: 'Palatino-Bold', italic: 'Palatino-Italic', boldItalic: 'Palatino-BoldItalic' },

  courier: { regular: 'CourierNewPSMT', bold: 'CourierNewPS-BoldMT', italic: 'CourierNewPS-ItalicMT', boldItalic: 'CourierNewPS-BoldItalicMT' },
  mono: { regular: 'Menlo-Regular', bold: 'Menlo-Bold', italic: 'Menlo-Italic', boldItalic: 'Menlo-BoldItalic' },

  comic: { regular: 'ComicSansMS', bold: 'ComicSansMS-Bold' },
  brush: { regular: 'BrushScriptMT' },

  // Google families, using Google's own static-face names.
  inter: { regular: 'Inter-Regular', bold: 'Inter-Bold', italic: 'Inter-Italic', boldItalic: 'Inter-BoldItalic' },
  roboto: { regular: 'Roboto-Regular', bold: 'Roboto-Bold', italic: 'Roboto-Italic', boldItalic: 'Roboto-BoldItalic' },
  'open-sans': { regular: 'OpenSans-Regular', bold: 'OpenSans-Bold', italic: 'OpenSans-Italic', boldItalic: 'OpenSans-BoldItalic' },
  lato: { regular: 'Lato-Regular', bold: 'Lato-Bold', italic: 'Lato-Italic', boldItalic: 'Lato-BoldItalic' },
  montserrat: { regular: 'Montserrat-Regular', bold: 'Montserrat-Bold', italic: 'Montserrat-Italic', boldItalic: 'Montserrat-BoldItalic' },
  poppins: { regular: 'Poppins-Regular', bold: 'Poppins-Bold', italic: 'Poppins-Italic', boldItalic: 'Poppins-BoldItalic' },
  raleway: { regular: 'Raleway-Regular', bold: 'Raleway-Bold', italic: 'Raleway-Italic', boldItalic: 'Raleway-BoldItalic' },
  // Oswald and Dancing Script are upright-only families.
  oswald: { regular: 'Oswald-Regular', bold: 'Oswald-Bold' },
  playfair: { regular: 'PlayfairDisplay-Regular', bold: 'PlayfairDisplay-Bold', italic: 'PlayfairDisplay-Italic', boldItalic: 'PlayfairDisplay-BoldItalic' },
  merriweather: { regular: 'Merriweather-Regular', bold: 'Merriweather-Bold', italic: 'Merriweather-Italic', boldItalic: 'Merriweather-BoldItalic' },
  jetbrains: { regular: 'JetBrainsMono-Regular', bold: 'JetBrainsMono-Bold', italic: 'JetBrainsMono-Italic', boldItalic: 'JetBrainsMono-BoldItalic' },
  pacifico: { regular: 'Pacifico-Regular' },
  lobster: { regular: 'Lobster-Regular' },
  dancing: { regular: 'DancingScript-Regular', bold: 'DancingScript-Bold' },
};

/** Weights this heavy want the bold face; the rest render on the regular one. */
const BOLD_THRESHOLD = 600;

/**
 * The PostScript face to name for a family at a weight and slant, plus the faux
 * flags that have to make up whatever the family cannot supply as a real face.
 *
 * @param {string} id a `FONT_FAMILIES` id (or any string, for old documents)
 * @param {number} [weight] 100..900
 * @param {string} [style] `'italic'` to slant
 * @returns {{name:string, fauxBold:boolean, fauxItalic:boolean, real:boolean}}
 *   `real` is true when the name is the actual face for that weight and slant.
 */
export function postScriptFace(id, weight = 400, style = 'normal', caps = null) {
  const key = normalizeFontId(id);
  const wantBold = Number(weight) >= BOLD_THRESHOLD;
  const wantItalic = style === 'italic';
  const faces = POSTSCRIPT_FACES[key];

  if (!faces) {
    const google = googleFamilyOf(key);
    if (google) {
      /*
       * Google's static faces are named `FamilyNoSpaces-Regular`, `-Bold`,
       * `-Italic`, `-BoldItalic`. Claim a slot only when the family is known
       * to have that face: an unresolvable PostScript name is worse than faux
       * styling, because Photoshop then substitutes a different family
       * outright. Without capabilities to check against, claim nothing.
       */
      const stem = google.replace(/[^A-Za-z0-9]/g, '');
      const hasBold = !!caps && (caps.weights || []).some((w) => Number(w) >= BOLD_THRESHOLD);
      const hasItalic = !!caps && (caps.italics || []).length > 0;
      const bold = wantBold && hasBold;
      const italic = wantItalic && hasItalic;
      const slot = bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular';
      return {
        name: `${stem}-${slot}`,
        fauxBold: wantBold && !bold,
        fauxItalic: wantItalic && !italic,
        real: (!wantBold || bold) && (!wantItalic || italic),
      };
    }
    // An unknown id (a family typed in by hand, or one from a foreign file)
    // has no face table, so the regular-plus-faux route is all there is.
    const stripped = String(key == null ? '' : key).replace(/[^A-Za-z0-9]/g, '');
    return { name: stripped || 'Helvetica', fauxBold: wantBold, fauxItalic: wantItalic, real: false };
  }

  const exact = wantBold && wantItalic ? faces.boldItalic : wantBold ? faces.bold : wantItalic ? faces.italic : faces.regular;
  if (exact) return { name: exact, fauxBold: false, fauxItalic: false, real: true };

  // Bold-italic on a family with only three faces: keep whichever real axis
  // exists and synthesise the other one. Bold is the more visible of the two,
  // so it wins the file.
  if (wantBold && wantItalic && faces.bold) {
    return { name: faces.bold, fauxBold: false, fauxItalic: true, real: false };
  }
  if (wantBold && wantItalic && faces.italic) {
    return { name: faces.italic, fauxBold: true, fauxItalic: false, real: false };
  }
  return { name: faces.regular, fauxBold: wantBold, fauxItalic: wantItalic, real: false };
}

/**
 * `system` is written as Helvetica because that is the closest resolvable face
 * to a platform UI font, but the reverse mapping must not claim every Helvetica
 * document was authored in Pikado's System UI — those stay with the reader's
 * own alias table, which resolves them to a real Helvetica stack.
 */
const REVERSE_EXCLUDED = new Set(['system']);

const _faceIndex = new Map();
for (const [id, faces] of Object.entries(POSTSCRIPT_FACES)) {
  if (REVERSE_EXCLUDED.has(id)) continue;
  const slots = [
    ['regular', 400, 'normal'],
    ['bold', 700, 'normal'],
    ['italic', 400, 'italic'],
    ['boldItalic', 700, 'italic'],
  ];
  for (const [slot, weight, style] of slots) {
    const name = faces[slot];
    if (!name || _faceIndex.has(name.toLowerCase())) continue;
    _faceIndex.set(name.toLowerCase(), { font: id, weight, style });
  }
}

/**
 * The exact inverse of `postScriptFace`: a face name back to the family id and
 * the weight and slant that face stands for.
 * @param {string} name a PostScript face name
 * @returns {{font:string, weight:number, style:string}|null} null when the name
 *   is not one we write, so the caller can fall back to its own heuristics.
 */
export function familyFromPostScriptName(name) {
  if (!name) return null;
  const hit = _faceIndex.get(String(name).trim().toLowerCase());
  return hit ? { ...hit } : null;
}

/* ------------------------------------------------------------------ */
/* Google font loading                                                 */
/* ------------------------------------------------------------------ */

/**
 * Make sure the face behind a font id is usable.
 *
 * Everything that needs the network now goes through `font-manager.js`, which
 * downloads a family's bytes and stores them. This used to inject a Google
 * stylesheet `<link>` with a hardcoded `wght@100..900`, which is a hard failure
 * for any family that does not offer that range — ten of the fourteen bundled
 * Google families never loaded at all, and because the loader resolved `false`
 * rather than throwing, the failure was invisible.
 *
 * Imported lazily so that a document with no Google family in it never pulls
 * the manager, the catalogue, or IndexedDB.
 *
 * @returns {Promise<boolean>}
 */
export async function ensureFont(id) {
  const key = normalizeFontId(id);
  const f = getFontFamily(key);
  // A built-in with a `google` name is downloaded like any other Google family;
  // a pure system stack needs nothing at all.
  const needsNetwork = googleFamilyOf(key) || (f && f.google);
  if (!needsNetwork) return true;
  const { ensureFamily } = await import('./font-manager.js');
  return ensureFamily(f && f.google ? GOOGLE_PREFIX + f.google : key);
}

/* ------------------------------------------------------------------ */
/* Measurement                                                         */
/* ------------------------------------------------------------------ */

let _mctx = null;
function measureCtx() {
  if (!_mctx) _mctx = createCanvas(8, 8).getContext('2d');
  return _mctx;
}

/**
 * CSS font shorthand for a set of text properties.
 * @param {{style?:string, weight?:number|string, size?:number, font?:string, family?:string}} t
 */
export function fontCssString(t) {
  const style = t.style === 'italic' || t.italic ? 'italic' : 'normal';
  const weight = t.weight || 400;
  const size = Math.max(1, t.size || 16);
  return `${style} ${weight} ${size}px ${fontStack(t.font || t.family || 'system')}`;
}

const _metricCache = new Map();

/**
 * Ascent/descent for a CSS font string, in pixels.
 * @returns {{ascent:number, descent:number, height:number}}
 */
export function fontMetrics(cssFont) {
  const hit = _metricCache.get(cssFont);
  if (hit) return hit;
  const c = measureCtx();
  c.font = cssFont;
  const m = c.measureText('Hxdpqg');
  const sizeMatch = /(\d*\.?\d+)px/.exec(cssFont);
  const size = sizeMatch ? Number(sizeMatch[1]) : 16;
  let ascent = m.fontBoundingBoxAscent;
  let descent = m.fontBoundingBoxDescent;
  if (!Number.isFinite(ascent) || ascent <= 0) ascent = m.actualBoundingBoxAscent || size * 0.8;
  if (!Number.isFinite(descent) || descent <= 0) descent = m.actualBoundingBoxDescent || size * 0.2;
  const out = { ascent, descent, height: ascent + descent };
  // Metrics only change when a webfont finishes loading; the cache is cheap
  // to rebuild so cap it rather than tracking invalidation.
  if (_metricCache.size > 200) _metricCache.clear();
  _metricCache.set(cssFont, out);
  return out;
}

/** Drop cached metrics — call after a webfont finishes loading. */
export function invalidateFontMetrics() {
  _metricCache.clear();
}

/**
 * Width of a run of text, honouring letter spacing (which, like CSS, is added
 * after every character including the last).
 */
export function measureRun(text, cssFont, letterSpacing = 0) {
  if (!text) return 0;
  const c = measureCtx();
  c.font = cssFont;
  if (!letterSpacing) return c.measureText(text).width;
  let w = 0;
  for (const ch of text) w += c.measureText(ch).width + letterSpacing;
  return w;
}

/**
 * Per-character advances for a line — used to place the caret and to draw
 * letter-spaced text glyph by glyph.
 * @returns {{ch:string, x:number, width:number}[]}
 */
export function measureChars(text, cssFont, letterSpacing = 0) {
  const c = measureCtx();
  c.font = cssFont;
  const out = [];
  let x = 0;
  for (const ch of text) {
    const w = c.measureText(ch).width;
    out.push({ ch, x, width: w });
    x += w + letterSpacing;
  }
  return out;
}
