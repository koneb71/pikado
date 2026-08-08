import { getPref, setPrefs } from '../ui/dialogs/preferences.js';

/**
 * Agreement to send a picture to a particular host.
 *
 * Kept separate from the API key on purpose. Entering a key is not agreement to
 * upload anything — a user may well paste a key to see whether the feature works
 * at all, and be entitled to a second, explicit "yes, send this image" before a
 * single pixel goes anywhere. Keeping them apart also means forgetting the key
 * does not silently revoke consent, and keeping consent does not imply a key is
 * still present.
 *
 * Consent is per *host*, not per provider or per session, because the host is
 * the thing the promise is actually about: what leaves the machine and who
 * receives it. Point the same provider at a different endpoint and the question
 * has to be asked again.
 *
 * Granted-for-this-session lives in memory; "don't ask again" lives in
 * `pikado.prefs`. A boolean list of hostnames is not a secret, so the ordinary
 * preferences store is the right home for it — unlike the key, which must never
 * go near that blob.
 */

const PREF_KEY = 'aiConsentHosts';

/** Hosts agreed to for this session only. Cleared by a reload. */
const sessionHosts = new Set();

/** @returns {string[]} hosts with a persisted "don't ask again" */
export function consentedHosts() {
  const list = getPref(PREF_KEY, []);
  return Array.isArray(list) ? list.slice() : [];
}

/**
 * Whether this host may be sent to without asking again.
 * Synchronous, for the same reason `hasCredential` is.
 *
 * @param {string} host
 * @returns {boolean}
 */
export function hasConsent(host) {
  if (!host) return false;
  return sessionHosts.has(host) || consentedHosts().includes(host);
}

/**
 * Record agreement.
 *
 * @param {string} host
 * @param {{remember?: boolean}} [opts] remember across sessions
 */
export function grantConsent(host, opts = {}) {
  if (!host) return;
  sessionHosts.add(host);
  if (!opts.remember) return;
  const list = consentedHosts();
  if (!list.includes(host)) setPrefs({ [PREF_KEY]: [...list, host] });
}

/**
 * Withdraw agreement, for this session and for good.
 * @param {string} host
 */
export function revokeConsent(host) {
  sessionHosts.delete(host);
  const list = consentedHosts().filter((h) => h !== host);
  setPrefs({ [PREF_KEY]: list });
}

/** Withdraw every agreement. Used by the "forget everything" path in settings. */
export function revokeAllConsent() {
  sessionHosts.clear();
  setPrefs({ [PREF_KEY]: [] });
}

/**
 * The host a URL will actually be sent to. Exported because the consent gate and
 * the dialog must be talking about the same string, and `new URL` is the only
 * thing that agrees with what the browser will really do.
 *
 * @param {string} url
 * @returns {string}
 */
export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
