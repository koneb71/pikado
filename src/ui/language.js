import { app } from '../core/app.js';
import { el } from '../core/util.js';
import {
  LANGUAGES, chooseLanguage, pinnedLanguage, loadLanguage, language, languageInfo, pickLanguage, tr,
} from '../core/i18n.js';
import { confirmDialog } from './dialog.js';
import { iconEl } from './icons.js';
import { flushAll } from '../io/session.js';
import { storageAvailable } from '../io/store.js';
import './language.css';

/**
 * Choosing the interface language: at boot, in Preferences and on the start
 * screen. The translating itself is src/core/i18n.js; this is the part that
 * knows about the app.
 */

/** The browser's languages, most preferred first. */
export function browserLanguages() {
  if (typeof navigator === 'undefined') return [];
  if (navigator.languages && navigator.languages.length) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

/**
 * Load the language the interface should start in, before any of it is built.
 *
 * Never rejects. A catalogue that cannot be fetched — offline, the first time
 * a language is chosen on this device — leaves the interface in English, and
 * the tag that failed is returned so the app can say so once it can.
 *
 * @param {string} preference the stored preference: 'auto' or a tag
 * @returns {Promise<string|null>} the tag that could not be loaded, if any
 */
export async function startLanguage(preference) {
  const tag = chooseLanguage({ pinned: pinnedLanguage(), preference, browser: browserLanguages() });
  try {
    await loadLanguage(tag);
    return null;
  } catch (err) {
    console.warn(`[i18n] could not load "${tag}":`, err && err.message);
    return tag;
  }
}

/** Say that a language could not be loaded. Shown in English, the only language left. */
export function reportLanguageFailure(tag) {
  const name = (languageInfo(tag) || {}).name || tag;
  app.toast(`${name} could not be loaded, so Pikado is in English. It will try again next time it starts.`, 'warn', 6000);
}

/**
 * Options for a language picker: Automatic, naming what it currently
 * resolves to, then every language under its own name. A function of the
 * moment rather than a constant, since "Automatic" follows the browser.
 *
 * The language names are given exactly as they are, never through `tr()`:
 * each is written in its own language precisely so it reads the same to
 * everyone.
 */
export function languageOptions() {
  const auto = languageInfo(pickLanguage(browserLanguages()));
  return [
    { value: 'auto', label: tr('Automatic — {language}', { language: auto ? auto.name : 'English' }) },
    ...LANGUAGES.map((l) => ({ value: l.tag, label: l.name })),
  ];
}

/**
 * Put a new language preference into effect, which means reloading.
 *
 * The session is autosaved, so open documents come straight back — but their
 * undo history does not, and that is said before anything happens. With no
 * document open there is nothing to lose and nothing to ask.
 *
 * @param {string} preference 'auto' or a tag, already saved by the caller
 * @returns {Promise<boolean>} whether Pikado is reloading
 */
export async function applyLanguagePreference(preference) {
  const pinned = pinnedLanguage();
  const target = chooseLanguage({ preference, browser: browserLanguages() });
  // Already showing it, and nothing in the address overriding it: done.
  if (target === language() && !pinned) return false;

  const name = (languageInfo(target) || {}).name || target;
  if (app.docs.length) {
    const kept = storageAvailable();
    const ok = await confirmDialog(
      kept
        ? tr('Pikado reloads to change language. Your open documents come back as they are, but not their undo history.')
        : tr('Pikado reloads to change language, and this browser is not keeping your work: open documents will be lost unless you save them first.'),
      tr('Switch to {language}', { language: name }),
      tr('Reload Now'),
      { danger: !kept },
    );
    if (!ok) {
      app.toast(tr('{language} will be used the next time Pikado starts.', { language: name }), 'info', 4000);
      return false;
    }
    // Saves run on a debounce; make sure the newest edit is on disk before the page goes.
    await flushAll().catch(() => { /* reload regardless: the documents are as safe as they were */ });
  }

  // A `?lang=` in the address outranks the preference, so it has to go or the
  // reload would come back in the language it pins.
  const url = new URL(location.href);
  url.searchParams.delete('lang');
  if (url.href === location.href) location.reload();
  else location.replace(url.href);
  return true;
}

/**
 * A compact language picker — a globe and a select — for the start screen,
 * where someone who cannot read English has to be able to find their way out
 * of it.
 *
 * @param {{value: string, onChange: (preference: string) => void}} o
 */
export function languagePicker({ value, onChange }) {
  // Each language's own name is written for everyone; keep page translation off it.
  const select = el('select.pk-select', { 'aria-label': tr('Language') },
    ...languageOptions().map((o) => el('option', { value: o.value, text: o.label, translate: o.value === 'auto' ? null : 'no' })));
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  return el('label.pk-lang-pick', { title: tr('Language') }, iconEl('language', { size: 14 }), select);
}
