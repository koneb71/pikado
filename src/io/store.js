/**
 * Local project storage, backed by IndexedDB.
 *
 * Documents are kept as `.pkd` blobs — the same lossless format File > Save
 * writes — so persistence and export share one serialiser and there is no second
 * schema to keep in step.
 *
 * Two object stores rather than one, deliberately: IndexedDB hands back whole
 * records, so keeping the 50 MB payload separate from the metadata lets the
 * welcome screen list recent documents (with thumbnails) without reading a
 * single project blob.
 *
 *   docmeta: {id, name, width, height, updatedAt, bytes, thumb: Blob}
 *   docdata: {id, data: Blob}
 *   kv:      {key, value}   — the session pointer and anything else small
 */

const DB_NAME = 'pikado';
const DB_VERSION = 1;

/** Stop growing the store past this; the least recently touched go first. */
export const STORE_LIMIT_BYTES = 1_200 * 1024 * 1024;
/** A single project larger than this is not worth autosaving. */
export const DOC_LIMIT_BYTES = 320 * 1024 * 1024;

let dbPromise = null;

/**
 * Last timestamp handed out, so `updatedAt` is strictly increasing.
 *
 * `Date.now()` has millisecond resolution, and two saves inside the same
 * millisecond tie — which makes the "most recent first" ordering of the recent
 * list arbitrary. Nudging forward on a tie keeps it deterministic while staying
 * accurate to the wall clock in every realistic case.
 */
let lastStamp = 0;

function nextStamp() {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp;
}

/** True when this browser can persist at all (private modes sometimes cannot). */
export function storageAvailable() {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!storageAvailable()) {
      reject(new Error('IndexedDB is unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('docmeta')) {
        const s = db.createObjectStore('docmeta', { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('docdata')) db.createObjectStore('docdata', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading the schema would otherwise block forever.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('Could not open the local project store'));
    req.onblocked = () => reject(new Error('Local storage is blocked by another tab'));
  });
  // A failed open must not be cached as a permanently rejected promise.
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

/** Run `fn(tx)` and resolve when the transaction completes, not when fn returns. */
function withTx(storeNames, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted'));
    try {
      result = fn(tx);
    } catch (err) {
      try { tx.abort(); } catch { /* already dead */ }
      reject(err);
    }
  }));
}

/**
 * Read one record by key.
 *
 * The value has to be captured inside the transaction and read back after it
 * completes — resolving on the request alone would race the transaction, and
 * IndexedDB invalidates the request once the tx is done.
 */
async function getOne(storeName, key) {
  const box = { value: null };
  await withTx([storeName], 'readonly', (tx) => {
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => { box.value = req.result; };
  });
  return box.value || null;
}

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

/**
 * Store (or replace) a project.
 * @param {{id:string, name:string, width:number, height:number, data:Blob, thumb?:Blob}} rec
 * @returns {Promise<{id:string, bytes:number}>}
 */
export async function putDoc(rec) {
  if (!rec || !rec.id || !(rec.data instanceof Blob)) throw new Error('putDoc needs an id and a data blob');
  if (rec.data.size > DOC_LIMIT_BYTES) {
    const err = new Error(`Project is too large to keep locally (${(rec.data.size / 1048576).toFixed(0)} MB)`);
    err.code = 'too-large';
    throw err;
  }
  const meta = {
    id: rec.id,
    name: rec.name || 'Untitled',
    width: rec.width || 0,
    height: rec.height || 0,
    layers: rec.layers || 0,
    updatedAt: nextStamp(),
    bytes: rec.data.size,
    thumb: rec.thumb || null,
  };
  await withTx(['docmeta', 'docdata'], 'readwrite', (tx) => {
    tx.objectStore('docmeta').put(meta);
    tx.objectStore('docdata').put({ id: rec.id, data: rec.data });
  });
  await prune();
  return { id: rec.id, bytes: meta.bytes };
}

/** Metadata for every stored project, most recently updated first. */
export async function listDocs() {
  try {
    const all = await withTx(['docmeta'], 'readonly', (tx) => {
      const out = [];
      tx.objectStore('docmeta').openCursor().onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) return;
        out.push(cur.value);
        cur.continue();
      };
      return out;
    });
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/** The stored `.pkd` blob for a project, or null. */
export async function getDocData(id) {
  try {
    const rec = await getOne('docdata', id);
    return rec ? rec.data : null;
  } catch {
    return null;
  }
}

export async function getDocMeta(id) {
  try {
    return await getOne('docmeta', id);
  } catch {
    return null;
  }
}

export async function deleteDoc(id) {
  try {
    await withTx(['docmeta', 'docdata'], 'readwrite', (tx) => {
      tx.objectStore('docmeta').delete(id);
      tx.objectStore('docdata').delete(id);
    });
    return true;
  } catch {
    return false;
  }
}

export async function clearDocs() {
  try {
    await withTx(['docmeta', 'docdata', 'kv'], 'readwrite', (tx) => {
      tx.objectStore('docmeta').clear();
      tx.objectStore('docdata').clear();
      tx.objectStore('kv').clear();
    });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Session pointer + small values                                      */
/* ------------------------------------------------------------------ */

export async function kvSet(key, value) {
  try {
    await withTx(['kv'], 'readwrite', (tx) => { tx.objectStore('kv').put({ key, value }); });
    return true;
  } catch {
    return false;
  }
}

export async function kvGet(key) {
  try {
    const rec = await getOne('kv', key);
    return rec ? rec.value : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Housekeeping                                                        */
/* ------------------------------------------------------------------ */

/** Bytes and count currently held, plus the browser's own estimate. */
export async function usage() {
  const docs = await listDocs();
  const bytes = docs.reduce((n, d) => n + (d.bytes || 0), 0);
  let quota = null;
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      quota = { quota: est.quota, used: est.usage };
    }
  } catch { /* not available */ }
  return { bytes, count: docs.length, quota };
}

/**
 * Drop the least recently updated projects until the store is under its limit.
 * `keepIds` are never evicted — the documents currently open outrank history.
 */
export async function prune(keepIds = []) {
  const keep = new Set(keepIds);
  const docs = await listDocs();
  let total = docs.reduce((n, d) => n + (d.bytes || 0), 0);
  if (total <= STORE_LIMIT_BYTES) return { evicted: 0, bytes: total };

  let evicted = 0;
  // listDocs() is newest-first, so walk from the back.
  for (let i = docs.length - 1; i >= 0 && total > STORE_LIMIT_BYTES; i--) {
    const d = docs[i];
    if (keep.has(d.id)) continue;
    if (await deleteDoc(d.id)) {
      total -= d.bytes || 0;
      evicted++;
    }
  }
  return { evicted, bytes: total };
}

/**
 * Ask the browser not to evict us under storage pressure. Best effort — Safari
 * and private windows will simply say no.
 */
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch { /* not available */ }
  return false;
}
