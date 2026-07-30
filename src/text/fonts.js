/**
 * Font catalogue + measurement helpers for the type tools.
 *
 * `FONT_FAMILIES` mixes system stacks (always available) with a handful of
 * Google families that are fetched on demand by `loadGoogleFont()`. Every
 * entry exposes a CSS `stack` string that both the canvas renderer and the
 * editing `<textarea>` use, so glyph metrics agree exactly.
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

/**
 * @param {string} id a FONT_FAMILIES id — unknown ids fall through to the
 *   system stack so old documents never render blank.
 */
export function fontStack(id) {
  const f = FONT_FAMILIES.find((x) => x.id === id);
  return f ? f.stack : (id && /[a-z]/i.test(String(id)) ? `${id}, ${SANS}` : SANS);
}

export function getFontFamily(id) {
  return FONT_FAMILIES.find((x) => x.id === id) || null;
}

/* ------------------------------------------------------------------ */
/* Google font loading                                                 */
/* ------------------------------------------------------------------ */

const _requested = new Map();

/**
 * Inject a Google Fonts stylesheet and wait for the browser to report the
 * face as ready. Resolves (without throwing) when the network is unavailable
 * so text still renders in the fallback stack.
 * @param {string} name the Google family name, e.g. 'Playfair Display'
 * @returns {Promise<boolean>} true when the face actually loaded
 */
export function loadGoogleFont(name) {
  if (!name) return Promise.resolve(false);
  if (_requested.has(name)) return _requested.get(name);

  const href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, '+')}:ital,wght@0,100..900;1,100..900&display=swap`;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.pkFont = name;
  document.head.appendChild(link);

  const p = new Promise((resolve) => {
    const settle = async () => {
      try {
        await Promise.all([
          document.fonts.load(`400 24px "${name}"`),
          document.fonts.load(`700 24px "${name}"`),
        ]);
        await document.fonts.ready;
        resolve(document.fonts.check(`400 24px "${name}"`));
      } catch {
        resolve(false);
      }
    };
    link.addEventListener('load', settle, { once: true });
    link.addEventListener('error', () => resolve(false), { once: true });
    // Some browsers fire neither for cached stylesheets.
    setTimeout(settle, 1200);
  });
  _requested.set(name, p);
  return p;
}

/**
 * Make sure the face behind a FONT_FAMILIES id is usable, loading it from
 * Google when needed.
 * @returns {Promise<boolean>}
 */
export async function ensureFont(id, weight = 400, style = 'normal') {
  const f = getFontFamily(id);
  if (!f) return false;
  if (f.google) await loadGoogleFont(f.google);
  try {
    await document.fonts.load(`${style} ${weight} 24px ${f.stack}`);
  } catch {
    /* the stack still resolves to a fallback face */
  }
  return true;
}

/** Preload every family that the character panel may show a preview of. */
export function preloadGoogleFonts() {
  return Promise.all(FONT_FAMILIES.filter((f) => f.google).map((f) => loadGoogleFont(f.google)));
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
