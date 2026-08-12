import { app } from '../core/app.js';
import {
  css2Url, googleNameFor, normalizeFontId, invalidateFontMetrics, getFontFamily,
} from './fonts.js';
import { loadCatalog, findFamily, catalogReady } from './font-catalog.js';
import {
  putFont, listFontMeta, getFontData, deleteFont, fontUsage, FONT_LIMIT_BYTES, storageAvailable,
} from '../io/store.js';
import { getPref } from '../ui/dialogs/preferences.js';
import { setCapabilityProvider, fontsUsedBy, tableEntry } from './font-table.js';

/**
 * Downloaded fonts: fetching, storing, and registering them with the browser.
 *
 * A family arrives as bytes, not as a stylesheet link. That costs a little more
 * work here and buys three things: it survives a reload with no network, it
 * survives reopening a document offline, and it puts every request Pikado makes
 * to Google behind one function that can be refused.
 *
 * The registry is deliberately **synchronous once hydrated**. `fontStack()` and
 * `postScriptFace()` run on every rasterisation and every PSD export; neither
 * can await. So boot reads the metadata store only — family, category, weights
 * — and the bytes stay on disk until something actually needs to draw with
 * them.
 */

/*
 * So a `.pkd` manifest and a PSD FontSet can record real weights without the
 * format modules having to import this one.
 */
setCapabilityProvider((id) => {
  const known = familyCapabilities(id);
  if (known) return known;
  /*
   * Not downloaded, but the catalogue may still know its shape — and the
   * category is the field that decides whether a missing serif substitutes with
   * a serif or with whatever sans is nearest. Only read when the catalogue
   * happens to be in memory: this runs on every save, and a save must not pull
   * a 60 KB chunk for a document that has no Google font in it.
   */
  if (!catalogReady()) return null;
  const e = findFamily(googleNameFor(id));
  return e ? { weights: e.weights, italics: e.italic ? e.weights : [], category: e.category } : null;
});

/** family name -> {family, category, weights, italics, bytes} */
const installed = new Map();
/** family name -> Promise, so two callers share one download. */
const inFlight = new Map();
/** Families that failed this session; not retried automatically. */
const failed = new Map();

let hydrated = null;

/* ------------------------------------------------------------------ */
/* Policy                                                              */
/* ------------------------------------------------------------------ */

/**
 * Whether Pikado may fetch a font.
 *
 * A font is a *download* — nothing of the user's leaves the machine — which is
 * why this defaults to allowed and Generative Fill's per-host consent does not.
 * The two are different questions and deserve different answers.
 *
 * @returns {'auto'|'ask'|'off'}
 */
export function webfontPolicy() {
  const v = getPref('webfonts', 'auto');
  return v === 'off' || v === 'ask' ? v : 'auto';
}

export function webfontsAllowed() {
  return webfontPolicy() !== 'off';
}

/* ------------------------------------------------------------------ */
/* The synchronous registry                                            */
/* ------------------------------------------------------------------ */

/**
 * Read what has already been downloaded into memory. Metadata only.
 * Idempotent — later calls share the first one's promise.
 */
export function hydrateInstalledFonts() {
  if (!hydrated) {
    hydrated = listFontMeta().then((metas) => {
      for (const m of metas) installed.set(m.family, m);
      if (metas.length) app.emit('fonts-changed', { families: metas.map((m) => m.family) });
      return metas.length;
    }).catch(() => 0);
  }
  return hydrated;
}

/** Downloaded families, as picker options. */
export function installedFamilies() {
  return [...installed.values()].map((m) => ({
    id: `google:${m.family}`,
    name: m.family,
    family: m.family,
    category: m.category,
    weights: m.weights || [],
    italics: m.italics || [],
    bytes: m.bytes || 0,
  }));
}

/**
 * What a family can actually do — the weights and italics it has faces for.
 * Synchronous, because PSD export needs it and cannot await.
 * @returns {{weights:number[], italics:number[], category:string}|null}
 */
export function familyCapabilities(id) {
  const family = googleNameFor(id);
  const m = family && installed.get(family);
  return m ? { weights: m.weights || [], italics: m.italics || [], category: m.category } : null;
}

export function isInstalled(id) {
  const family = googleNameFor(id);
  return !!(family && installed.has(family));
}

export function failureFor(id) {
  const family = googleNameFor(id);
  return (family && failed.get(family)) || '';
}

/* ------------------------------------------------------------------ */
/* css2 parsing                                                        */
/* ------------------------------------------------------------------ */

/**
 * Latin and the punctuation that travels with it.
 *
 * Google splits a family into per-script files and Pikado wants the one a Latin
 * document needs. This is not a nicety: Noto Sans JP is 124 separate files and
 * about 5 MB for a single weight, of which exactly one file is Latin.
 */
const LATIN_RANGES = [
  [0x0000, 0x024f], // basic + latin-1 + extended A/B
  [0x2000, 0x206f], // general punctuation
  [0x2c60, 0x2c7f], // latin extended-C
  [0xa720, 0xa7ff], // latin extended-D
];

/** Whether a `unicode-range` descriptor overlaps Latin at all. */
export function isLatinRange(range) {
  if (!range) return true; // no range means the face covers everything
  for (const part of String(range).split(',')) {
    const m = part.trim().match(/^u\+([0-9a-f?]+)(?:-([0-9a-f]+))?$/i);
    if (!m) continue;
    const lo = parseInt(m[1].replace(/\?/g, '0'), 16);
    const hi = m[2] ? parseInt(m[2], 16) : parseInt(m[1].replace(/\?/g, 'f'), 16);
    for (const [a, b] of LATIN_RANGES) if (lo <= b && hi >= a) return true;
  }
  return false;
}

/**
 * Pull the faces out of a css2 stylesheet.
 *
 * Matched on `unicode-range` rather than on the `/* latin *\/` comment Google
 * emits above each block — the comment is a label and could change; the
 * descriptor is the thing that actually decides which glyphs a face serves.
 *
 * @param {string} css
 * @returns {{weight:number, style:string, unicodeRange:string, url:string}[]}
 */
export function parseFontFaces(css) {
  const out = [];
  for (const block of String(css).split('@font-face').slice(1)) {
    const body = block.slice(0, block.indexOf('}') + 1);
    const url = (body.match(/url\((https:\/\/[^)]+\.woff2)\)/) || [])[1];
    if (!url) continue;
    const style = /font-style:\s*italic/i.test(body) ? 'italic' : 'normal';
    const weightRaw = (body.match(/font-weight:\s*([0-9]+)(?:\s+([0-9]+))?/i) || [])[1];
    const unicodeRange = (body.match(/unicode-range:\s*([^;]+);/i) || [])[1] || '';
    out.push({
      weight: Number(weightRaw) || 400,
      style,
      unicodeRange: unicodeRange.trim(),
      url,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Downloading                                                         */
/* ------------------------------------------------------------------ */

class FontError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

/** A family's own entry, from the catalogue or the built-in list. */
async function describe(family) {
  await loadCatalog();
  const found = findFamily(family);
  if (found) return found;
  // A built-in Google family that predates the catalogue, or one retired from
  // it: fall back to the bundled description rather than refusing.
  const builtin = getFontFamily(normalizeFontId(`google:${family}`));
  if (builtin && builtin.google) {
    return { family: builtin.google, category: 'sans-serif', weights: [400, 700], italic: true, variable: false };
  }
  return null;
}

/**
 * Fetch, store and register a family.
 *
 * @param {string} family exact Google family name
 * @param {{onProgress?: (done:number, total:number) => void}} [opts]
 * @returns {Promise<{family:string, bytes:number}>}
 */
export function downloadFamily(family, opts = {}) {
  const name = String(family || '').trim();
  if (!name) return Promise.reject(new FontError('unknown', 'no family named'));
  if (installed.has(name)) return Promise.resolve(installed.get(name));
  const running = inFlight.get(name);
  if (running) return running;

  const job = (async () => {
    if (!webfontsAllowed()) {
      throw new FontError('refused', 'Downloading fonts is turned off in Preferences.');
    }
    const entry = await describe(name);
    if (!entry) throw new FontError('unknown', `${name} is not in the font catalogue.`);

    const css = await fetch(css2Url([entry])).then((r) => {
      if (!r.ok) throw new FontError('unavailable', `Google answered ${r.status} for ${name}.`);
      return r.text();
    }).catch((err) => {
      if (err instanceof FontError) throw err;
      throw new FontError('offline', `Could not reach Google Fonts for ${name}.`);
    });

    const all = parseFontFaces(css);
    const wanted = all.filter((f) => isLatinRange(f.unicodeRange));
    if (!wanted.length) {
      // Never store an empty record: a format change on Google's side would
      // otherwise be cached as "downloaded" and fail silently forever.
      throw new FontError('empty', `${name} returned no usable faces.`);
    }

    const used = await fontUsage();
    const faces = [];
    let done = 0;
    for (const f of wanted) {
      const buf = await fetch(f.url).then((r) => {
        if (!r.ok) throw new FontError('unavailable', `${name}: a font file answered ${r.status}.`);
        return r.arrayBuffer();
      }).catch((err) => {
        if (err instanceof FontError) throw err;
        throw new FontError('offline', `${name}: a font file could not be fetched.`);
      });
      faces.push({ weight: f.weight, style: f.style, unicodeRange: f.unicodeRange, buffer: buf });
      done += 1;
      if (opts.onProgress) opts.onProgress(done, wanted.length);
    }

    const bytes = faces.reduce((n, f) => n + f.buffer.byteLength, 0);
    if (used + bytes > FONT_LIMIT_BYTES) {
      throw new FontError('full', `There is no room for ${name}. Remove a downloaded font first.`);
    }

    const meta = {
      family: name,
      category: entry.category,
      weights: [...new Set(faces.filter((f) => f.style === 'normal').map((f) => f.weight))].sort((a, b) => a - b),
      italics: [...new Set(faces.filter((f) => f.style === 'italic').map((f) => f.weight))].sort((a, b) => a - b),
    };

    await registerFaces(name, faces);
    let record = { ...meta, bytes, faces: faces.length };
    if (storageAvailable()) {
      // A browser that refuses to store still gets the font for this session.
      try { record = await putFont(meta, faces); } catch { /* memory-only */ }
    }
    installed.set(name, record);
    failed.delete(name);
    invalidateFontMetrics();
    app.emit('fonts-changed', { families: [name] });
    return record;
  })();

  inFlight.set(name, job);
  job.catch((err) => { failed.set(name, (err && err.message) || 'Download failed.'); })
    .finally(() => { inFlight.delete(name); });
  return job;
}

/**
 * Hand the faces to the browser.
 *
 * `unicodeRange` is passed through and that is **required, not an
 * optimisation**: without it every subset file claims to cover everything, and
 * the browser is free to pick the Cyrillic file to draw Latin text — which
 * renders as notdef boxes rather than as an error.
 */
async function registerFaces(family, faces) {
  const jobs = [];
  for (const f of faces) {
    try {
      const desc = { weight: String(f.weight), style: f.style, display: 'swap' };
      if (f.unicodeRange) desc.unicodeRange = f.unicodeRange;
      const face = new FontFace(family, f.buffer, desc);
      // Awaited, not fire-and-forget: a caller told the family is ready has to
      // be able to measure with it on the next line.
      jobs.push(face.load().then((loaded) => { document.fonts.add(loaded); }).catch(() => { /* one bad face */ }));
    } catch { /* a face the browser will not take is not worth failing the family for */ }
  }
  await Promise.all(jobs);
}

/**
 * Make a family usable: register what is stored, downloading it first if it is
 * not here yet and policy allows.
 *
 * @param {string} id a font id — anything not a `google:` id resolves trivially
 * @returns {Promise<boolean>} whether the family is now usable
 */
export async function ensureFamily(id) {
  const family = googleNameFor(id);
  if (!family) return true; // a pure system stack needs nothing

  await hydrateInstalledFonts();
  if (installed.has(family)) {
    const faces = await getFontData(family);
    if (faces) await registerFaces(family, faces);
    return true;
  }
  if (!webfontsAllowed()) return false;
  try {
    await downloadFamily(family);
    return true;
  } catch {
    return false;
  }
}

/** Forget a downloaded family, on disk and in this session. */
export async function removeFamily(family) {
  const name = googleNameFor(family) || family;
  await deleteFont(name);
  installed.delete(name);
  /*
   * The registered FontFace objects are deliberately left in `document.fonts`.
   * Removing them would repaint every open document mid-session with no
   * warning; the family is gone from the pickers and will not come back after a
   * reload, which is what "removed" has to mean without being destructive.
   */
  app.emit('fonts-changed', { families: [name] });
  return true;
}

export { FontError };

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

/**
 * Make a document's fonts usable, and say plainly when one cannot be.
 *
 * Runs on `doc-added`, which covers File > Open, a drop, and session restore
 * in one place — and deliberately not inside `loadPKD`/`readPSD`, so the format
 * readers never reach for the network.
 *
 * A family that cannot be had **substitutes at render time and the layer is
 * left alone**. Rewriting `layer.text.font` would be the destructive move: the
 * document would then be permanently wrong even once the font arrived, and a
 * save would bake in the substitution. Instead the id stands, `fontStack()`
 * falls back in the right category, and the document heals the moment the
 * family turns up.
 */
export async function ensureDocumentFonts(doc) {
  if (!doc) return [];
  const ids = [...fontsUsedBy(doc)].filter((id) => googleNameFor(id));
  if (!ids.length) {
    doc.missingFonts = [];
    return [];
  }

  await hydrateInstalledFonts();
  const missing = [];
  const arrived = [];

  for (const id of ids) {
    const family = googleNameFor(id);
    if (installed.has(family)) {
      const faces = await getFontData(family);
      if (faces) { await registerFaces(family, faces); arrived.push(family); }
      continue;
    }
    if (!webfontsAllowed()) {
      missing.push({ id, family, reason: 'off' });
      continue;
    }
    try {
      await downloadFamily(family);
      arrived.push(family);
    } catch (err) {
      missing.push({ id, family, reason: (err && err.reason) || 'offline' });
    }
  }

  doc.missingFonts = missing;
  if (arrived.length) {
    invalidateFontMetrics();
    app.emit('fonts-changed', { families: arrived });
  }
  if (missing.length) {
    /*
     * One toast per document, naming what is wrong. Silence here was the old
     * behaviour and the worst of it: a document opened looking subtly wrong
     * with nothing to say why, and the substituted face was easy to mistake for
     * the author's choice.
     */
    const names = missing.map((m) => m.family);
    const list = names.length === 1 ? names[0]
      : `${names.slice(0, 2).join(', ')}${names.length > 2 ? ` and ${names.length - 2} more` : ''}`;
    const why = missing.every((m) => m.reason === 'off')
      ? 'Downloading fonts is turned off'
      : 'They could not be downloaded';
    app.toast(`${list} — showing a substitute face. ${why}.`, 'warn', 6000);
    app.emit('doc-fonts', doc);
  }
  return missing;
}

/**
 * What a document's own manifest says about a family, for substituting in kind
 * when the font itself is not here.
 */
export function documentFontCategory(doc, id) {
  const caps = familyCapabilities(id);
  if (caps && caps.category) return caps.category;
  // The file's own manifest is the offline answer: with no catalogue and no
  // download, it is the only thing that knows a missing family was a serif.
  const entry = tableEntry(doc, id);
  if (entry && entry.category) return entry.category;
  if (catalogReady()) {
    const e = findFamily(googleNameFor(id));
    if (e) return e.category;
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* Keeping metrics honest                                              */
/* ------------------------------------------------------------------ */

let metricsTimer = null;

/**
 * A face arriving changes measurements, and text is rasterised into a layer's
 * canvas — so this is not a repaint, it is a re-render of the layers that use
 * the family that just landed.
 *
 * Before this, `invalidateFontMetrics()` was called from exactly one place in
 * the Type tool, so any other path — a document opening, a download finishing —
 * kept whatever metrics were cached before the font existed.
 */
export function watchFontLoading() {
  if (!document.fonts || !document.fonts.addEventListener) return;
  document.fonts.addEventListener('loadingdone', () => {
    clearTimeout(metricsTimer);
    // Debounced: a batch of subsets lands as a burst of events.
    metricsTimer = setTimeout(() => {
      invalidateFontMetrics();
      app.emit('fonts-changed', { families: [...installed.keys()] });
    }, 50);
  });
}
