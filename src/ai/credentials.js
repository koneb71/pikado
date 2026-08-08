import { kvSet, kvGet, kvDelete } from '../io/store.js';

/**
 * The user's own API key, handled so that it cannot leak.
 *
 * Start from the thing that is true and unpleasant: **no browser storage
 * protects a secret from same-origin JavaScript.** localStorage, sessionStorage
 * and IndexedDB are all one line away from any script running on this page.
 * Nothing in this module changes that, and nothing in the UI should imply it
 * does. What the design controls is *blast radius and durability* — how much
 * exists, for how long, and how many places it can end up in by accident.
 *
 * Three decisions follow from that.
 *
 * **The default is memory only.** Nothing is written to disk unless the user
 * ticks "remember on this device". A drive-by script that dumps every storage
 * area finds nothing, and closing the tab genuinely forgets. The cost is real —
 * re-pasting the key after every refresh — so key entry is made cheap rather
 * than the default made weaker.
 *
 * **There is no exported getter.** This is the load-bearing decision. The raw
 * string leaves this module through exactly one door, `authorizeRequest`, which
 * writes it into a header and returns. Because no other module can obtain it, no
 * other module can put it in a log line, a URL, an `Error.message` that
 * `runCommand` then toasts on screen for five seconds, or an object that gets
 * serialised. A rule that would otherwise need a reviewer to notice is instead
 * impossible to break.
 *
 * **The key is never a property of a `Document` or a `Layer`.** `savePKD`
 * (src/io/pkd.js) and `doc.captureState()` (src/core/document.js) are explicit
 * field whitelists rather than object walkers, so that single rule closes .pkd
 * files, session autosave, history snapshots and PSD export at once, with no
 * filtering code anywhere.
 *
 * Persisted form lives in IndexedDB under `ai.credential`, deliberately not in
 * the `pikado.prefs` localStorage blob: that blob is what people paste into bug
 * reports, and what any future settings-export would carry off wholesale.
 */

const STORE_KEY = 'ai.credential';

/** @type {string} */
let key = '';
/** @type {'memory'|'device'|null} */
let scope = null;
/** @type {string} */
let providerId = '';

/**
 * Restore a remembered key into memory. Call once during boot.
 * Async because it reads IndexedDB.
 *
 * @returns {Promise<boolean>} true when a key was restored
 */
export async function loadCredential() {
  try {
    const rec = await kvGet(STORE_KEY);
    if (!rec || !rec.key) return false;
    key = String(rec.key);
    providerId = String(rec.provider || '');
    scope = 'device';
    return true;
  } catch {
    return false;
  }
}

/**
 * Hold a key for this session, and optionally on this device.
 *
 * Memory is updated before the write is attempted, so the UI is correct even
 * when persistence fails — private browsing and a full quota both refuse, and
 * neither should stop the key working for the session the user is in.
 *
 * @param {string} value
 * @param {{remember?: boolean, provider?: string}} [opts]
 * @returns {Promise<boolean>} true when a `remember` request actually persisted
 */
export async function setCredential(value, opts = {}) {
  key = typeof value === 'string' ? value.trim() : '';
  providerId = opts.provider || providerId;
  if (!key) { scope = null; return false; }

  if (!opts.remember) {
    scope = 'memory';
    // Any previously remembered key is now stale, and leaving it on disk would
    // mean "forget" had silently not happened for the next session.
    await kvDelete(STORE_KEY).catch(() => {});
    return false;
  }
  scope = 'device';
  return kvSet(STORE_KEY, { key, provider: providerId, savedAt: Date.now() });
}

/**
 * Drop the key from memory AND from device storage.
 *
 * Both halves matter. A version that only nulls the module variable looks
 * forgotten for the rest of the session and then reloads the key on the next
 * boot, which is the worst of both — the user believes it is gone.
 *
 * @returns {Promise<boolean>}
 */
export async function forgetCredential() {
  key = '';
  scope = null;
  providerId = '';
  return kvDelete(STORE_KEY);
}

/**
 * Whether a key is currently held.
 *
 * Synchronous, and it must stay that way: command `enabled()` predicates are
 * called synchronously by the menu bar (`isEnabled` does `return !!c.enabled()`
 * in src/commands/registry.js), and a Promise is truthy — so an async version
 * would silently enable every AI menu item with no key present.
 *
 * @returns {boolean}
 */
export function hasCredential() {
  return key.length > 0;
}

/** @returns {'memory'|'device'|null} */
export function credentialScope() {
  return scope;
}

/** @returns {string} the provider the stored key belongs to, or '' */
export function credentialProvider() {
  return providerId;
}

/**
 * The key rendered for display. The only form any UI is allowed to show.
 * @returns {string}
 */
export function redactedCredential() {
  return redact(key);
}

/**
 * Redact a secret for display.
 *
 * Keeps a recognisable vendor prefix and the last four characters, which is
 * enough for someone to tell two of their own keys apart and not enough to be
 * worth anything to anyone else. Short strings reveal nothing at all: four
 * trailing characters of a short secret is a large fraction of it, and a short
 * string here is almost always a truncated paste anyway.
 *
 * Deliberately never renders the true length — a row of dots sized to the key is
 * a free fingerprint of which provider and which key generation it is.
 *
 * @param {string} raw
 * @returns {string}
 */
export function redact(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  if (raw.length < 12) return '…';
  const prefix = /^([A-Za-z]{2,6})-/.exec(raw);
  return `${prefix ? `${prefix[1]}-` : ''}…${raw.slice(-4)}`;
}

/**
 * Replace any occurrence of the live key with its redaction.
 *
 * Defence in depth for text on its way to `app.toast`. Provider errors are
 * supposed to be rewritten rather than re-thrown, but a 401 body that echoes the
 * Authorization header back is a real thing that real APIs do, and that text
 * would otherwise land on screen for five seconds — quite possibly during the
 * screen share where someone is being helped with the problem.
 *
 * @param {string} text
 * @returns {string}
 */
export function scrubSecrets(text) {
  const s = String(text == null ? '' : text);
  if (!key) return s;
  return s.split(key).join(redact(key));
}

/**
 * The only exit for the raw key.
 *
 * Returns a new `RequestInit` with the provider's auth header set. Header, never
 * a query string: URLs end up in proxy logs, browser history and `Referer`
 * headers, and a key in any of those is a key that has left the building.
 *
 * @param {RequestInit} init
 * @param {{headerName?: string, scheme?: string}} [shape]
 * @returns {RequestInit}
 * @throws {Error} when no key is held
 */
export function authorizeRequest(init, shape = {}) {
  if (!key) throw new Error('no API key is configured');
  const headerName = shape.headerName || 'Authorization';
  const scheme = shape.scheme === undefined ? 'Bearer ' : shape.scheme;
  return {
    ...init,
    headers: { ...(init && init.headers), [headerName]: `${scheme}${key}` },
    // A credential must not ride along with anything the browser would attach on
    // its own, and the destination must never learn where it was called from.
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
    mode: 'cors',
  };
}
