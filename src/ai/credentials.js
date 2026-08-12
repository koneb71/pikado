import { kvSet, kvGet, kvDelete } from '../io/store.js';

/**
 * The user's own API keys, handled so that they cannot leak.
 *
 * Start from the thing that is true and unpleasant: **no browser storage
 * protects a secret from same-origin JavaScript.** localStorage, sessionStorage
 * and IndexedDB are all one line away from any script running on this page.
 * Nothing in this module changes that, and nothing in the UI should imply it
 * does. What the design controls is *blast radius and durability* — how much
 * exists, for how long, and how many places it can end up in by accident.
 *
 * Four decisions follow from that.
 *
 * **Keys are per provider.** An earlier version held one key with a label saying
 * which provider it belonged to. That was fine with one provider and a real bug
 * with two: the "is a key set?" check was provider-blind, so configuring OpenAI
 * and then switching to Gemini would have sent the OpenAI key to Google. Every
 * entry point now names the provider it means, so a key cannot reach a host it
 * was not issued for.
 *
 * **The default is memory only.** Nothing is written to disk unless the user
 * ticks "remember on this device". A drive-by script that dumps every storage
 * area finds nothing, and closing the tab genuinely forgets. The cost is real —
 * re-pasting after every refresh — so key entry is made cheap rather than the
 * default made weaker.
 *
 * **There is no exported getter.** This is the load-bearing decision. A raw key
 * leaves this module through exactly one door, `authorizeRequest`, which writes
 * it into a header and returns. Because no other module can obtain it, no other
 * module can put it in a log line, a URL, an `Error.message` that `runCommand`
 * then toasts on screen for five seconds, or an object that gets serialised. A
 * rule that would otherwise need a reviewer to notice is instead impossible to
 * break.
 *
 * **A key is never a property of a `Document` or a `Layer`.** `savePKD`
 * (src/io/pkd.js) and `doc.captureState()` (src/core/document.js) are explicit
 * field whitelists rather than object walkers, so that single rule closes .pkd
 * files, session autosave, history snapshots and PSD export at once, with no
 * filtering code anywhere.
 *
 * Persisted form lives in IndexedDB under `ai.credentials`, deliberately not in
 * the `pikado.prefs` localStorage blob: that blob is what people paste into bug
 * reports, and what any future settings-export would carry off wholesale.
 */

const STORE_KEY = 'ai.credentials';

/** @type {Map<string, string>} providerId -> raw key. Never exported. */
const keys = new Map();
/** @type {Map<string, 'memory'|'device'>} */
const scopes = new Map();

/**
 * Restore remembered keys into memory.
 *
 * Called from every AI entry point rather than at boot, so the IndexedDB read
 * happens for the people who use the feature and nobody else — the same reason
 * the provider modules are not fetched until asked for.
 *
 * **Runs at most once**, so opening the AI dialogs repeatedly costs one
 * IndexedDB read rather than one per open. Only a saving, not a correctness
 * guard: a second run would be harmless, because `setCredential` deletes the
 * stored copy when a key is set for this session only, so there is never a
 * stale record on disk waiting to overwrite what is in memory.
 *
 * @returns {Promise<number>} how many keys were restored
 */
let loading = null;
export function loadCredentials() {
  if (!loading) loading = readCredentials();
  return loading;
}

async function readCredentials() {
  try {
    const rec = await kvGet(STORE_KEY);
    if (!rec || typeof rec !== 'object') return 0;
    let n = 0;
    for (const [id, entry] of Object.entries(rec)) {
      if (!entry || typeof entry.key !== 'string' || !entry.key) continue;
      keys.set(id, entry.key);
      scopes.set(id, 'device');
      n += 1;
    }
    return n;
  } catch {
    return 0;
  }
}

/** For tests, which need a fresh boot rather than one memoised run. */
export function resetCredentialLoad() {
  loading = null;
}

/** The persisted record, or an empty object. */
async function readStore() {
  const rec = await kvGet(STORE_KEY);
  return rec && typeof rec === 'object' ? { ...rec } : {};
}

/**
 * Hold a key for one provider, for this session and optionally on this device.
 *
 * Memory is updated before the write is attempted, so the UI is correct even
 * when persistence fails — private browsing and a full quota both refuse, and
 * neither should stop the key working for the session the user is in.
 *
 * @param {string} providerId
 * @param {string} value
 * @param {{remember?: boolean}} [opts]
 * @returns {Promise<boolean>} true when a `remember` request actually persisted
 */
export async function setCredential(providerId, value, opts = {}) {
  if (!providerId) return false;
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key) {
    keys.delete(providerId);
    scopes.delete(providerId);
    return false;
  }
  keys.set(providerId, key);

  if (!opts.remember) {
    scopes.set(providerId, 'memory');
    // Any previously remembered key for this provider is now stale, and leaving
    // it on disk would mean "forget" had silently not happened next session.
    try {
      const rec = await readStore();
      if (rec[providerId]) {
        delete rec[providerId];
        if (Object.keys(rec).length) await kvSet(STORE_KEY, rec);
        else await kvDelete(STORE_KEY);
      }
    } catch { /* memory is already correct, which is what matters */ }
    return false;
  }

  scopes.set(providerId, 'device');
  try {
    const rec = await readStore();
    rec[providerId] = { key, savedAt: Date.now() };
    return await kvSet(STORE_KEY, rec);
  } catch {
    return false;
  }
}

/**
 * Drop one provider's key from memory AND from device storage.
 *
 * Both halves matter. A version that only clears memory looks forgotten for the
 * rest of the session and then reloads the key on the next boot, which is the
 * worst of both — the user believes it is gone.
 *
 * @param {string} providerId
 * @returns {Promise<boolean>}
 */
export async function forgetCredential(providerId) {
  keys.delete(providerId);
  scopes.delete(providerId);
  try {
    const rec = await readStore();
    if (!(providerId in rec)) return true;
    delete rec[providerId];
    if (Object.keys(rec).length) return kvSet(STORE_KEY, rec);
    return kvDelete(STORE_KEY);
  } catch {
    return false;
  }
}

/** Forget every key, everywhere. @returns {Promise<boolean>} */
export async function forgetAllCredentials() {
  keys.clear();
  scopes.clear();
  return kvDelete(STORE_KEY);
}

/**
 * Whether a key is held for this provider.
 *
 * Synchronous, and it must stay that way: command `enabled()` predicates are
 * called synchronously by the menu bar (`isEnabled` does `return !!c.enabled()`
 * in src/commands/registry.js), and a Promise is truthy — so an async version
 * would silently enable every AI menu item with no key present.
 *
 * @param {string} providerId
 * @returns {boolean}
 */
export function hasCredential(providerId) {
  const k = keys.get(providerId);
  return typeof k === 'string' && k.length > 0;
}

/** Provider ids with a key held right now. @returns {string[]} */
export function configuredProviders() {
  return [...keys.keys()];
}

/**
 * @param {string} providerId
 * @returns {'memory'|'device'|null}
 */
export function credentialScope(providerId) {
  return scopes.get(providerId) || null;
}

/**
 * A provider's key rendered for display. The only form any UI may show.
 * @param {string} providerId
 * @returns {string}
 */
export function redactedCredential(providerId) {
  return redact(keys.get(providerId) || '');
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
 * Replace any held key, from any provider, with its redaction.
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
  let s = String(text == null ? '' : text);
  for (const key of keys.values()) {
    if (key) s = s.split(key).join(redact(key));
  }
  return s;
}

/**
 * The only exit for a raw key.
 *
 * Returns a new `RequestInit` with the provider's auth header set. Header, never
 * a query string: URLs end up in proxy logs, browser history and `Referer`
 * headers, and a key in any of those is a key that has left the building. That
 * matters more than it sounds for Google, whose own documentation offers `?key=`
 * as the convenient option — `x-goog-api-key` is the same thing without the
 * trail, so that is what this uses.
 *
 * @param {string} providerId whose key to use
 * @param {RequestInit} init
 * @param {{headerName?: string, scheme?: string}} [shape]
 * @returns {RequestInit}
 * @throws {Error} when no key is held for that provider
 */
export function authorizeRequest(providerId, init, shape = {}) {
  const key = keys.get(providerId);
  if (!key) throw new Error(`no API key is configured for ${providerId}`);
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
