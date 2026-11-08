/**
 * The interface language.
 *
 * English is the source language, and the English text is the key:
 * `tr('Gaussian Blur...')` looks that exact string up in the active catalogue
 * and falls back to it. A string nobody has translated yet therefore still
 * reads correctly, the code reads like the interface it builds, and there is
 * no second file of English to keep in step with the first.
 *
 *   tr('Gaussian Blur...')                             translate now
 *   tr('Layer "{name}" is locked.', { name })          named placeholders
 *   trn('{count} layer', '{count} layers', n)          plurals, per the language's own rules
 *   msg('Fade {action}', { action: msg(label) })       a message translated when it is shown
 *   tr('Delete|key')                                   with a context, shown in English as "Delete"
 *
 * `tr`, not the more usual `t`: sixty-odd modules here already use `t` for a
 * curve parameter or a loop variable, and a translator shadowed by one fails
 * only when that line runs.
 *
 * Three rules make the rest of the codebase work with this, and each one is
 * there because the alternative is a real bug:
 *
 * 1. **Data stays English; it is translated where it is shown.** Registries —
 *    commands, tools, filters, adjustments, panels, menus, ParamDescriptors —
 *    are declared when their module is imported, which is before any
 *    catalogue can have loaded, so they hold English and the code that
 *    renders them calls `tr()`. It is also what keeps logic working: history
 *    icons are chosen by reading the English label, and the suite compares
 *    labels as English.
 * 2. **Never translate a user's data.** A layer the user named "Background"
 *    is not the word "Background". Translation is explicit — only text the
 *    code knows to be interface text goes through `tr()` — so a name can never
 *    be translated by accident because it happens to match a key.
 * 3. **Never call `tr()` at module top level.** It would run before the
 *    language has loaded and freeze the English. Tables of interface text
 *    stay English (or are wrapped in `msg()`) and are translated when drawn.
 *
 * Catalogues are JSON in `src/locales/`, one per language, and only the one
 * in use is ever fetched. JSON rather than a module on purpose: a translation
 * is usually contributed by someone who reads the language rather than someone
 * a reviewer can vet, and data cannot run.
 *
 * Changing language reloads the interface rather than repainting it in place.
 * Most of the chrome is built once at boot and the panels subscribe to the app
 * as they build, so a live repaint would need every one of them to tear down
 * cleanly; a reload costs nothing but undo history, because the session is
 * autosaved and comes straight back. Photoshop asks for a restart too.
 */

export const SOURCE_LANGUAGE = 'en';

/**
 * A pseudo-language for finding text that never reaches `tr()`: every
 * translated string comes back accented, bracketed and about a third longer
 * (`⟦Ĝåûššîåñ Ɓļûŕ···⟧`), so anything still plain English on screen is a
 * string that escaped translation, and anything clipped is a layout that will
 * clip in German. Not offered in Preferences — open the app with `?lang=en-XA`.
 * The tag is the one Android and Chrome use for the same job.
 */
export const PSEUDO_LANGUAGE = 'en-XA';

/**
 * Every interface language, in the order the picker shows them.
 *
 * `name` is what the language calls itself, never its English name: someone
 * who cannot read the interface they are looking at still has to be able to
 * find their own language in the list.
 */
export const LANGUAGES = [
  { tag: 'en', name: 'English' },
  { tag: 'de', name: 'Deutsch', load: () => import('../locales/de.json') },
  { tag: 'es', name: 'Español', load: () => import('../locales/es.json') },
  { tag: 'fr', name: 'Français', load: () => import('../locales/fr.json') },
  { tag: 'pt-BR', name: 'Português (Brasil)', load: () => import('../locales/pt-BR.json') },
  { tag: 'ru', name: 'Русский', load: () => import('../locales/ru.json') },
  { tag: 'ja', name: '日本語', load: () => import('../locales/ja.json') },
  { tag: 'ko', name: '한국어', load: () => import('../locales/ko.json') },
  { tag: 'zh-CN', name: '简体中文', load: () => import('../locales/zh-CN.json') },
  { tag: 'zh-TW', name: '繁體中文', load: () => import('../locales/zh-TW.json') },
];

/** Matches a trailing ellipsis, either spelling, and what comes before it. */
const ELLIPSIS = /^([\s\S]*?)(\.\.\.|…)$/;

/**
 * A context: `'Delete|key'`. One English word can be two words elsewhere —
 * "Delete" the key on a German keyboard is Entf, "Delete" the command is
 * Löschen — so the source can say which it means. The catalogue key keeps
 * the context, so a translator sees it; English, and any language without
 * the entry, shows the text before the bar.
 */
const CONTEXT = /^([\s\S]*?)\|([a-z][a-z -]*)$/;

/** Source text without its context, which is how English shows it. */
function plain(text) {
  const m = CONTEXT.exec(text);
  return m ? m[1] : text;
}

let current = SOURCE_LANGUAGE;
/** @type {Map<string, string|object>|null} the active catalogue; null for English */
let table = null;
let pseudo = false;
let rules = new Intl.PluralRules(SOURCE_LANGUAGE);
const englishRules = rules;

/** Strings asked for that the active catalogue does not have, for translators. */
const missing = new Set();
const MISSING_CAP = 4000;

/** The language the interface is in now. */
export function language() {
  return current;
}

/* ------------------------------------------------------------------ */
/* Translating                                                         */
/* ------------------------------------------------------------------ */

/**
 * A message that is translated when it is shown rather than when it is made.
 *
 * For text that is stored first and displayed later — a history label, a
 * table of hints declared at module scope — where translating at creation
 * would either run before the language loaded or freeze it into the data.
 * As a string it is English (`String(m)`), exactly like the plain-string
 * labels it sits beside, so logic that reads labels and the suite's
 * assertions see one form whichever way a label was written. Display goes
 * through `tr(m)`, as all display does.
 *
 * Parameters that are themselves messages are translated with it; anything
 * else is data and is inserted verbatim.
 */
export class Message {
  constructor(text, params = null) {
    this.text = String(text);
    this.params = params;
    Object.freeze(this);
  }

  toString() {
    return fill(plain(this.text), this.params, String);
  }
}

/** Mark text as interface text to translate when it is shown. See {@link Message}. */
export function msg(text, params) {
  return new Message(text, params);
}

/**
 * Translate interface text into the current language.
 *
 * Text that is not in the catalogue comes back as it was, which also makes
 * this safe to call on text that has already been translated.
 *
 * @param {string|Message} text English source text, or a {@link Message}
 * @param {object} [params] values for `{name}` placeholders; a Message value is
 *   translated too, anything else is inserted as it is
 * @returns {string}
 */
export function tr(text, params) {
  if (text instanceof Message) return fill(translate(text.text), text.params, tr);
  if (text == null) return '';
  const found = translate(String(text));
  return params ? fill(found, params, tr) : found;
}

/**
 * Translate text that depends on a count.
 *
 * English supplies both forms; a catalogue entry, keyed by the singular,
 * supplies whichever forms its language has (`one`, `few`, `many`, `other`…)
 * and `Intl.PluralRules` picks between them, so Russian gets its three forms
 * and Chinese its one without the code knowing either exists. `{count}` is
 * filled in automatically.
 *
 * @param {string} one   English singular, e.g. '{count} layer'
 * @param {string} other English plural, e.g. '{count} layers'
 * @param {number} count
 * @param {object} [params]
 */
export function trn(one, other, count, params) {
  const values = { count, ...params };
  const n = Number(count);
  if (pseudo) return fill(accent(englishRules.select(n) === 'one' ? one : other), values, tr);
  const entry = table ? table.get(one) : undefined;
  let template;
  if (entry && typeof entry === 'object') template = entry[rules.select(n)] || entry.other;
  else if (typeof entry === 'string' && entry) template = entry;
  if (!template) {
    if (table) note(one);
    template = englishRules.select(n) === 'one' ? one : other;
  }
  return fill(template, values, tr);
}

function translate(text) {
  if (pseudo) return text.startsWith('⟦') ? text : accent(plain(text));
  if (!table) return plain(text);
  const found = lookup(text);
  if (found !== undefined) return found;
  note(text);
  return plain(text);
}

/**
 * Find a translation, treating a trailing ellipsis as punctuation.
 *
 * "Gaussian Blur..." in the Filter menu and "Gaussian Blur" on the history
 * step it leaves behind are one name; the dots only say a dialog follows. So
 * either form finds the other, and a translator writes each name once — which
 * also means the two can never drift apart.
 */
function lookup(text) {
  const hit = pick(table.get(text));
  if (hit) return hit;
  const dots = ELLIPSIS.exec(text);
  if (dots) {
    const stem = pick(table.get(dots[1]));
    return stem ? stem + dots[2] : undefined;
  }
  const dotted = pick(table.get(`${text}...`)) || pick(table.get(`${text}…`));
  return dotted ? dotted.replace(/(\.\.\.|…)$/, '') : undefined;
}

/** A usable string from a catalogue value: empty means "not yet translated". */
function pick(value) {
  if (typeof value === 'string') return value || undefined;
  if (value && typeof value === 'object' && typeof value.other === 'string') return value.other || undefined;
  return undefined;
}

/**
 * Replace `{name}` placeholders. A placeholder with no value is left showing,
 * which is the visible failure a typo in either the code or a translation
 * deserves.
 */
function fill(template, params, render) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key) => {
    if (!(key in params)) return whole;
    const v = params[key];
    if (v instanceof Message) return render(v);
    return v == null ? '' : String(v);
  });
}

function note(text) {
  if (missing.size < MISSING_CAP) missing.add(text);
}

/**
 * Interface text this session asked for that the current catalogue lacks —
 * `pikado.i18n.missing()` in the console, after clicking through whatever you
 * are translating, lists exactly what is still English there.
 */
export function missingStrings() {
  return [...missing];
}

/* ------------------------------------------------------------------ */
/* Pseudo-localisation                                                 */
/* ------------------------------------------------------------------ */

const ACCENTED = {
  a: 'å', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'î', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ',
  n: 'ñ', o: 'ö', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'û', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Å', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Î', J: 'Ĵ', K: 'Ķ', L: 'Ļ', M: 'Ṁ',
  N: 'Ñ', O: 'Ö', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Û', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};

/**
 * Accent every letter outside a `{placeholder}` and pad by about 30%, the
 * expansion German and Russian really need. Placeholders are left intact so
 * their values — data — are inserted as they are.
 */
function accent(text) {
  const body = text.replace(/\{\w+\}|[A-Za-z]/g, (m) => (m.length > 1 ? m : ACCENTED[m]));
  const pad = '·'.repeat(Math.ceil(text.length * 0.3));
  return `⟦${body}${pad}⟧`;
}

/* ------------------------------------------------------------------ */
/* Choosing and loading a language                                     */
/* ------------------------------------------------------------------ */

/**
 * The best interface language for a list of preferences, most preferred
 * first — `navigator.languages`, typically.
 *
 * Each preference is tried in turn: an exact tag, then the same written
 * language. Chinese is matched by script rather than by region, because
 * Simplified and Traditional are different written languages while the
 * regions are not: zh-SG reads Simplified, zh-HK and zh-MO read Traditional.
 * One script is never served for the other — a reader who asked for
 * Traditional and then English gets English. A preference for any English
 * ends the search, since English is always available.
 *
 * @param {readonly string[]} wanted
 * @param {readonly string[]} [available]
 * @returns {string}
 */
export function pickLanguage(wanted, available = LANGUAGES.map((l) => l.tag)) {
  const byLower = new Map(available.map((tag) => [tag.toLowerCase(), tag]));
  for (const raw of wanted || []) {
    if (typeof raw !== 'string' || !raw) continue;
    const exact = byLower.get(raw.toLowerCase());
    if (exact) return exact;
    let want;
    try { want = new Intl.Locale(raw).maximize(); } catch { continue; }
    const match = available.find((tag) => {
      let have;
      try { have = new Intl.Locale(tag).maximize(); } catch { return false; }
      return have.language === want.language && (want.language !== 'zh' || have.script === want.script);
    });
    if (match) return match;
  }
  return SOURCE_LANGUAGE;
}

/**
 * A language forced for this page load: `?lang=` in the address, then a
 * `<meta name="pikado-language">` in the page. The parameter is for
 * translators checking their work and for the pseudo-language; the meta tag
 * is how the test page holds the suite to English, whose assertions compare
 * English labels. Neither is remembered.
 */
export function pinnedLanguage() {
  if (typeof location !== 'undefined') {
    const param = new URLSearchParams(location.search).get('lang');
    if (param) return param;
  }
  if (typeof document !== 'undefined') {
    const meta = document.querySelector('meta[name="pikado-language"]');
    if (meta && meta.content) return meta.content;
  }
  return null;
}

/**
 * Decide the language to start in.
 *
 * @param {object} o
 * @param {string|null} [o.pinned]    from {@link pinnedLanguage}
 * @param {string} [o.preference]     the stored preference: 'auto' or a tag
 * @param {readonly string[]} [o.browser] the browser's languages, most preferred first
 */
export function chooseLanguage({ pinned = null, preference = 'auto', browser = [] } = {}) {
  if (pinned === PSEUDO_LANGUAGE) return PSEUDO_LANGUAGE;
  if (pinned) return pickLanguage([pinned]);
  if (preference && preference !== 'auto' && LANGUAGES.some((l) => l.tag === preference)) return preference;
  return pickLanguage(browser);
}

/**
 * Switch translation to `tag`, fetching its catalogue first. Resolves with the
 * tag now in use. Rejects — leaving the current language untouched — when the
 * catalogue cannot be fetched, which offline is a real possibility for a
 * language never used on this device.
 */
export async function loadLanguage(tag) {
  const entry = LANGUAGES.find((l) => l.tag === tag);
  let next = null;
  if (tag !== PSEUDO_LANGUAGE && entry && entry.load) {
    const mod = await entry.load();
    next = new Map(Object.entries((mod && mod.default) || mod || {}));
  }
  pseudo = tag === PSEUDO_LANGUAGE;
  current = pseudo ? PSEUDO_LANGUAGE : entry ? entry.tag : SOURCE_LANGUAGE;
  table = next;
  rules = pseudo ? englishRules : new Intl.PluralRules(current);
  missing.clear();
  if (typeof document !== 'undefined') document.documentElement.lang = current;
  return current;
}

/** The entry for a tag in {@link LANGUAGES}, or null. */
export function languageInfo(tag) {
  return LANGUAGES.find((l) => l.tag === tag) || null;
}
