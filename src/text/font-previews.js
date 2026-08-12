import { css2Url } from './fonts.js';
import { isOffline } from '../io/offline.js';

/**
 * Specimens for families that have not been downloaded.
 *
 * Showing a font in its own face is the whole point of a font browser, and
 * there are ~1,900 of them — so the only question that matters is how few
 * requests a screenful costs. One css2 stylesheet can carry many families, so a
 * batch of two dozen is one request rather than two dozen.
 *
 * UI-free on purpose: the browser dialog and the picker popover both want this,
 * and it is the only part of the browser worth testing on its own.
 *
 * A preview asks for **no weight axis at all**. Regular is all a specimen
 * needs, and an axis-free request is the one shape that is valid for every
 * family — which is exactly the trap that broke ten of the bundled families
 * when the old loader posted a fixed `100..900` to all of them.
 */

const BATCH = 24;
const DEBOUNCE_MS = 120;
const SETTLE_MS = 1500;
const MAX_INFLIGHT = 2;

/** family -> 'unknown' | 'loading' | 'ready' | 'failed' | 'offline' */
const state = new Map();
const pending = new Set();
const listeners = new Set();
let timer = null;
let inflight = 0;
let sample = '';

export function previewState(family) {
  return state.get(family) || 'unknown';
}

export function onPreviewState(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce(families) {
  for (const fn of listeners) {
    try { fn(families); } catch { /* one bad listener must not stop the rest */ }
  }
}

function mark(families, value) {
  for (const f of families) state.set(f, value);
  announce(families);
}

/**
 * The text specimens are drawn with. Changing it re-requests nothing: the
 * stylesheet already declares every subset, so a new string only needs the
 * browser to load glyphs it does not have yet.
 */
export function setPreviewText(text) {
  sample = String(text || '');
}

export function previewText() {
  return sample;
}

/**
 * Ask for specimens. Safe to call on every scroll frame — the work is
 * debounced, and families that scrolled out of view before the batch fires are
 * dropped rather than fetched.
 *
 * @param {{family:string}[]} families the families currently visible
 * @param {() => {family:string}[]} [stillVisible] re-read at flush time
 */
export function requestPreviews(families, stillVisible = null) {
  let added = false;
  for (const f of families) {
    const name = f && f.family;
    if (!name || state.has(name)) continue;
    state.set(name, 'unknown');
    pending.add(name);
    added = true;
  }
  if (!added && !pending.size) return;
  clearTimeout(timer);
  timer = setTimeout(() => flush(stillVisible), DEBOUNCE_MS);
}

function flush(stillVisible) {
  if (!pending.size) return;
  if (inflight >= MAX_INFLIGHT) {
    // Re-arm rather than queueing more requests at once; a fast scroll would
    // otherwise open a dozen connections for rows nobody is looking at.
    timer = setTimeout(() => flush(stillVisible), DEBOUNCE_MS);
    return;
  }

  const visible = stillVisible ? new Set(stillVisible().map((f) => f.family)) : null;
  const wanted = [...pending].filter((f) => !visible || visible.has(f));
  for (const f of wanted) pending.delete(f);
  // Anything flung past is forgotten entirely, so it is asked for again if the
  // user scrolls back rather than being stuck at 'unknown'.
  for (const f of pending) state.delete(f);
  pending.clear();
  if (!wanted.length) return;

  if (isOffline()) { mark(wanted, 'offline'); return; }

  const chunk = wanted.slice(0, BATCH);
  for (const rest of wanted.slice(BATCH)) pending.add(rest);
  loadChunk(chunk);
  if (pending.size) timer = setTimeout(() => flush(stillVisible), DEBOUNCE_MS);
}

function loadChunk(chunk) {
  mark(chunk, 'loading');
  inflight += 1;

  const href = css2Url(chunk.map((family) => ({ family })), { text: sample || undefined });
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.pkFontPreview = String(chunk.length);
  document.head.appendChild(link);

  let settled = false;
  const settle = async () => {
    if (settled) return;
    settled = true;
    inflight -= 1;
    try {
      // One request, but the truth is per family: a stylesheet that resolved
      // says nothing about whether every family in it did.
      await Promise.allSettled(chunk.map((f) => document.fonts.load(`400 22px "${f}"`, sample || f)));
      for (const f of chunk) {
        state.set(f, document.fonts.check(`400 22px "${f}"`, sample || f) ? 'ready' : 'failed');
      }
    } catch {
      for (const f of chunk) state.set(f, 'failed');
    }
    announce(chunk);
  };

  link.addEventListener('load', settle, { once: true });
  link.addEventListener('error', () => {
    if (settled) return;
    settled = true;
    inflight -= 1;
    link.remove();
    mark(chunk, 'failed');
  }, { once: true });
  // A stylesheet already in the HTTP cache fires neither event in some
  // browsers, so race the listeners against a timer.
  setTimeout(settle, SETTLE_MS);
}

/**
 * Let the failures be asked for again.
 *
 * Failures are otherwise sticky: retrying automatically as rows scroll back
 * into view turns one bad network moment into a request storm, and the row
 * says what happened, so the user can decide.
 */
export function retryFailedPreviews() {
  const again = [];
  for (const [family, value] of state) {
    if (value === 'failed' || value === 'offline') { state.delete(family); again.push({ family }); }
  }
  if (again.length) requestPreviews(again);
  return again.length;
}

/** For tests. */
export function resetPreviews() {
  clearTimeout(timer);
  state.clear();
  pending.clear();
  inflight = 0;
}
