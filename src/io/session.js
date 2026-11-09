import { app } from '../core/app.js';
import { Emitter } from '../core/emitter.js';
import { createCanvas } from '../core/util.js';
import { tr } from '../core/i18n.js';
import { getComposite } from '../render/compositor.js';
import { savePKD, loadPKD } from './pkd.js';
import {
  putDoc, getDocData, listDocs, deleteDoc, kvSet, kvGet,
  storageAvailable, requestPersistence, prune, usage, DOC_LIMIT_BYTES,
} from './store.js';

/**
 * Session persistence: your open documents survive a refresh, a crash, and
 * being offline.
 *
 * Documents are serialised with the same `.pkd` writer File > Save uses, so
 * there is one format to trust rather than a parallel "autosave schema".
 *
 * Timing matters more than it looks. Serialising is 1-2 s for a large document
 * (PNG-encoding every layer), and `beforeunload` cannot await asynchronous
 * storage work — so a save triggered by the refresh itself would never finish.
 * Instead we save continuously in the background:
 *
 *   - 1.2 s after you stop editing (debounce), and
 *   - no more often than every 4 s per document (throttle floor), so a long
 *     drag-heavy session does not spend all its time encoding, and
 *   - immediately when the tab is hidden, which is the last reliable moment
 *     before a reload or a tab close.
 *
 * That bounds what a refresh can cost you to the few seconds since the last
 * quiet moment. Undo history is deliberately not persisted — Photoshop does not
 * either, and it would multiply the payload by the number of history states.
 */

export const sessionEvents = new Emitter();

const SESSION_KEY = 'session';
const IDLE_MS = 1200;
const MIN_INTERVAL_MS = 4000;
const THUMB_MAX = 320;

const state = {
  enabled: false,
  saving: false,
  lastSavedAt: 0,
  error: null,
  restoring: false,
};

/** @type {Map<string, {timer:any, lastSaveAt:number, signature:string, pending:boolean, failed:boolean}>} */
const tracked = new Map();

/** The save running now, if any, so a flush can wait for it rather than skip it. */
let running = null;

function entryOf(doc) {
  const id = storeIdOf(doc);
  let entry = tracked.get(id);
  if (!entry) tracked.set(id, (entry = { timer: null, lastSaveAt: 0, signature: '', pending: false, failed: false }));
  return entry;
}

export function sessionState() {
  return { ...state };
}

function emit() {
  sessionEvents.emit('state', sessionState());
}

/**
 * A stable id for the document across sessions.
 *
 * `doc.id` is regenerated every time a document is constructed, so a restored
 * document would otherwise be stored again under a fresh key and the old copy
 * would linger until eviction.
 */
function storeIdOf(doc) {
  if (!doc._storeId) doc._storeId = doc.id;
  return doc._storeId;
}

/**
 * What "unchanged" means. The history position moves on every commit, and the
 * rest covers the things that change without one.
 */
function signatureOf(doc) {
  const h = doc.history;
  return `${h ? h.index : 0}.${h ? h.states.length : 0}|${doc.width}x${doc.height}|${doc.name}|${doc.layers.length}`;
}

/** A small PNG of the composite, for the welcome screen's recent list. */
async function makeThumb(doc) {
  try {
    const src = getComposite(doc);
    const s = Math.min(THUMB_MAX / doc.width, THUMB_MAX / doc.height, 1);
    const w = Math.max(1, Math.round(doc.width * s));
    const h = Math.max(1, Math.round(doc.height * s));
    const cv = createCanvas(w, h);
    const c = cv.getContext('2d');
    c.imageSmoothingQuality = 'high';
    c.drawImage(src, 0, 0, w, h);
    return await new Promise((res) => cv.toBlob((b) => res(b), 'image/png'));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Saving                                                              */
/* ------------------------------------------------------------------ */

/**
 * Write a document to local storage now.
 * @param {import('../core/document.js').PikaDocument} doc
 * @param {{force?:boolean}} [opts] force skips the "nothing changed" check
 */
export async function saveDocNow(doc, opts = {}) {
  if (!state.enabled || !doc || state.restoring) return false;
  const id = storeIdOf(doc);
  const entry = entryOf(doc);

  const sig = signatureOf(doc);
  if (!opts.force && sig === entry.signature) return false;

  // One save at a time: encoding two large documents at once just thrashes.
  if (state.saving) {
    entry.pending = true;
    return false;
  }

  state.saving = true;
  state.error = null;
  emit();
  let done;
  running = new Promise((resolve) => { done = resolve; });
  try {
    const [data, thumb] = await Promise.all([savePKD(doc), makeThumb(doc)]);
    if (data.size > DOC_LIMIT_BYTES) {
      failed(entry, 'too-large', tr('"{name}" is too large to keep locally, so it will not be restored after a refresh.', { name: doc.name }));
      return false;
    }
    await putDoc({
      id,
      name: doc.name,
      width: doc.width,
      height: doc.height,
      layers: doc.flatLayers().length,
      data,
      thumb,
    });
    entry.signature = sig;
    entry.lastSaveAt = Date.now();
    entry.failed = false;
    state.lastSavedAt = entry.lastSaveAt;
    await writeSessionPointer();
    return true;
  } catch (err) {
    console.warn('[session] save failed:', (err && err.message) || err);
    failed(entry, (err && err.message) || String(err), err && err.name === 'QuotaExceededError'
      ? tr('This browser’s storage is full, so "{name}" will not be restored after a refresh.', { name: doc.name })
      : tr('"{name}" could not be kept locally, so it will not be restored after a refresh.', { name: doc.name }));
    return false;
  } finally {
    state.saving = false;
    running = null;
    done();
    emit();
    if (entry.pending) {
      entry.pending = false;
      // Something changed while we were encoding — go round again, debounced.
      schedule(doc);
    }
  }
}

/**
 * A save that did not go through. Said once rather than at every attempt —
 * a failing save is retried after each edit, and a warning every few seconds
 * would bury everything else — and said again if a later save succeeds and
 * then one fails anew.
 */
function failed(entry, error, message) {
  state.error = error;
  if (!entry.failed) app.toast(message, 'warn', 8000);
  entry.failed = true;
}

/**
 * Whether autosave is keeping this document: it is on, and the document's last
 * save went through. A refresh then costs at most the moments since that save;
 * otherwise it can cost the document.
 */
export function isKept(doc) {
  if (!state.enabled) return false;
  const entry = tracked.get(storeIdOf(doc));
  return !(entry && entry.failed);
}

/** Debounced autosave for one document. */
function schedule(doc) {
  if (!state.enabled || state.restoring || !doc) return;
  const entry = entryOf(doc);

  clearTimeout(entry.timer);
  const since = Date.now() - entry.lastSaveAt;
  const wait = Math.max(IDLE_MS, MIN_INTERVAL_MS - since);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (app.docs.includes(doc)) saveDocNow(doc);
  }, wait);
}

/**
 * Save every open document that has changed. Used when the tab goes away, and
 * before the reload a language change makes — which is why a save already
 * running is waited for rather than skipped: afterwards, `isKept()` says
 * whether each document as it is now is stored.
 */
export async function flushAll() {
  if (!state.enabled) return;
  for (const doc of [...app.docs]) {
    const entry = tracked.get(storeIdOf(doc));
    if (entry && entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    // Sequential on purpose: concurrent encodes of several large documents is
    // the one thing guaranteed not to finish before the tab dies.
    while (running) await running;
    await saveDocNow(doc);
  }
}

async function writeSessionPointer() {
  const open = app.docs.map((d) => ({
    id: storeIdOf(d),
    name: d.name,
    view: d === app.activeDoc ? app.viewport.serialize() : (app._views.get(d.id) || null),
  }));
  const activeId = app.activeDoc ? storeIdOf(app.activeDoc) : null;
  await kvSet(SESSION_KEY, { open, activeId, savedAt: Date.now() });
}

/* ------------------------------------------------------------------ */
/* Restoring                                                           */
/* ------------------------------------------------------------------ */

/**
 * Reopen whatever was open last time.
 * @returns {Promise<number>} how many documents came back
 */
export async function restoreSession() {
  if (!storageAvailable()) return 0;
  const sess = await kvGet(SESSION_KEY);
  if (!sess || !Array.isArray(sess.open) || !sess.open.length) return 0;

  state.restoring = true;
  let restored = 0;
  let firstFailure = null;
  try {
    for (const ref of sess.open) {
      try {
        const blob = await getDocData(ref.id);
        if (!blob) continue;
        const doc = await loadPKD(await blob.arrayBuffer());
        doc._storeId = ref.id;
        if (ref.name) doc.name = ref.name;
        doc.dirty = false;
        app.addDocument(doc, false);
        if (ref.view) app._views.set(doc.id, ref.view);
        // Restored work is already on disk; do not rewrite it immediately.
        tracked.set(ref.id, {
          timer: null, lastSaveAt: Date.now(), signature: signatureOf(doc), pending: false, failed: false,
        });
        restored++;
      } catch (err) {
        if (!firstFailure) firstFailure = err;
        console.warn(`[session] could not restore ${ref.id}:`, err && err.message);
      }
    }

    if (restored) {
      const active = app.docs.find((d) => d._storeId === sess.activeId) || app.docs[0];
      app.setActiveDoc(active);
      const view = app._views.get(active.id);
      if (view) { app.viewport.restore(view); app.emit('view-change'); }
      else app.fitView();
    }
  } finally {
    state.restoring = false;
    emit();
  }

  if (firstFailure && !restored) {
    app.toast(tr('Your previous session could not be restored.'), 'warn', 5000);
  }
  return restored;
}

/* ------------------------------------------------------------------ */
/* Recent projects (the welcome screen reads these)                    */
/* ------------------------------------------------------------------ */

/** @returns {Promise<Array<{id,name,width,height,layers,updatedAt,bytes,thumb}>>} */
export function listRecent() {
  return listDocs();
}

/** Open a stored project into a tab, or focus it if already open. */
export async function openRecent(id) {
  const already = app.docs.find((d) => d._storeId === id);
  if (already) { app.setActiveDoc(already); return already; }

  return app.busy(tr('Opening…'), async () => {
    const blob = await getDocData(id);
    if (!blob) { app.toast(tr('That project is no longer stored locally.'), 'warn'); return null; }
    const doc = await loadPKD(await blob.arrayBuffer());
    doc._storeId = id;
    doc.dirty = false;
    app.addDocument(doc);
    tracked.set(id, { timer: null, lastSaveAt: Date.now(), signature: signatureOf(doc), pending: false });
    app.fitView();
    await writeSessionPointer();
    sessionEvents.emit('recents-change');
    return doc;
  });
}

export async function forgetRecent(id) {
  await deleteDoc(id);
  sessionEvents.emit('recents-change');
}

export { usage as storageUsage };

/* ------------------------------------------------------------------ */
/* Wiring                                                             */
/* ------------------------------------------------------------------ */

/**
 * Turn autosave on and start watching the app.
 * Safe to call when storage is unavailable — it simply stays off.
 */
export function installSession() {
  if (!storageAvailable()) {
    console.info('[session] local storage unavailable; autosave is off');
    return false;
  }
  state.enabled = true;
  requestPersistence();

  const touch = (doc) => schedule(doc || app.activeDoc);
  app.on('doc-change', touch);
  app.on('doc-structure', touch);
  app.on('doc-resize', touch);
  app.on('history-change', touch);

  app.on('docs-change', () => {
    writeSessionPointer();
    sessionEvents.emit('recents-change');
  });
  app.on('active-doc', () => writeSessionPointer());

  // Closing a document should leave it in the recent list but drop it from the
  // session, so a refresh does not resurrect something you deliberately closed.
  app.on('docs-change', () => {
    const live = new Set(app.docs.map((d) => d._storeId).filter(Boolean));
    for (const [id, entry] of tracked) {
      if (!live.has(id)) {
        clearTimeout(entry.timer);
        tracked.delete(id);
      }
    }
  });

  // The last reliable moment before a reload or close.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAll();
  });
  window.addEventListener('pagehide', () => { flushAll(); });

  prune(app.docs.map(storeIdOf));
  emit();
  return true;
}
