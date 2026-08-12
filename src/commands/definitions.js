import { app } from '../core/app.js';
import { el, uid, createCanvas, formatBytes, clamp } from '../core/util.js';
import { registerCommand, registerCommands, getCommand } from './registry.js';
import { Dialog, confirmDialog, paramDialog, promptDialog } from '../ui/dialog.js';
import { toHex, toCss } from '../core/color.js';
import { showColorPicker } from '../ui/color-picker.js';
import { gradientParam, normalizeGradient } from '../ui/gradient-editor.js';
import { Layer, LayerType, createGroupLayer } from '../core/layer.js';
import { Selection } from '../core/selection.js';
import { makeTiledCanvas } from '../paint/patterns.js';

import * as ops from '../layers/ops.js';
import * as smart from '../core/smart.js';
import * as img from './image-ops.js';
import * as tf from '../tools/transform.js';
import { growSelection, similarSelection } from '../tools/wand.js';
import { applyAdjustmentCommand, applyFilterCommand, repeatLastFilter } from '../filters/run.js';
import { rasterizeTextLayer, WARP_STYLES } from '../text/text-render.js';
import { createShapeLayer, defaultShapeStyle, fitCurve } from '../vector/path.js';

import { cut, copy, copyMerged, paste, pasteInto, pasteOutside, clear } from '../edit/clipboard.js';
import {
  showFillDialog, showStrokeDialog, showContentAwareFillDialog, fillSelection, definePattern, getPatterns,
} from '../edit/fill-stroke.js';

import { saveDocument, saveDocumentAs } from '../io/save.js';
import { openFiles } from '../io/open.js';

import { showNewDocumentDialog } from '../ui/dialogs/new-document.js';
import { showImageSizeDialog } from '../ui/dialogs/image-size.js';
import { showCanvasSizeDialog } from '../ui/dialogs/canvas-size.js';
import { showExportDialog, quickExportPng } from '../ui/dialogs/export.js';
import { showPreferencesDialog, getPref } from '../ui/dialogs/preferences.js';
import { showKeyboardShortcutsDialog, applyStoredShortcuts } from '../ui/dialogs/keyboard-shortcuts.js';

import { PANELS, togglePanel, isPanelVisible, openPanel, closePanel } from '../ui/panel-host.js';
import { setScreenMode, getScreenMode } from '../ui/shortcuts.js';

/**
 * Every Pikado command, plus the menu tree the menu bar renders.
 *
 * The command *table* lives here; anything that needs more than a few lines of
 * pixel work is implemented in `image-ops.js`, `layers/ops.js`, `edit/*` or a
 * dialog module, so this file stays readable as a map of the application.
 */

/* ------------------------------------------------------------------ */
/* Small predicates shared by enabled()                                */
/* ------------------------------------------------------------------ */

const D = () => app.activeDoc;
const hasDoc = () => !!app.activeDoc;
const activeLayer = () => (app.activeDoc ? app.activeDoc.activeLayer() : null);
const hasLayer = () => !!activeLayer();
const hasSelection = () => !!(app.activeDoc && app.activeDoc.selection.active);
const isSmart = () => smart.isSmartLayer(activeLayer());

function hasPixels() {
  const l = activeLayer();
  return !!(l && (l.canvas || (l.editingMask && l.mask)));
}

function layerOfType(type) {
  const l = activeLayer();
  return l && l.type === type ? l : null;
}

function commitSelection(doc, label) {
  doc.emit('selection-change');
  doc.commit(label);
}

/** Colour management dialogs, loaded on demand with the ICC machinery. */
async function colorDialog(which) {
  const doc = D();
  if (!doc) return;
  const mod = await import('../ui/dialogs/color-settings.js');
  if (which === 'assign') return mod.showAssignProfileDialog(doc);
  if (which === 'convert') return mod.showConvertProfileDialog(doc);
  return mod.showProofSetupDialog(doc);
}

async function toggleProof() {
  const doc = D();
  if (!doc) return;
  const { proofOf, setProof, proofLabel } = await import('../color/manage.js');
  const proof = proofOf(doc);
  setProof(doc, { enabled: !proof.enabled });
  app.toast(proof.enabled ? proofLabel(doc) || 'Proofing on' : 'Proofing off', 'info');
  app.emit('doc-change', doc);
}

async function toggleGamutWarning() {
  const doc = D();
  if (!doc) return;
  const { proofOf, setProof } = await import('../color/manage.js');
  const proof = proofOf(doc);
  // A gamut warning with no proof to compare against would mark nothing, so turn
  // proofing on with it rather than appearing to do nothing.
  setProof(doc, { gamutWarning: !proof.gamutWarning, enabled: !proof.gamutWarning ? true : proof.enabled });
  app.emit('doc-change', doc);
}

/**
 * Open the Select and Mask workspace.
 *
 * Loaded on demand: the workspace pulls in the graph-cut solver and the matting
 * pass, which are a few hundred lines of numerical code nothing else needs, and
 * keeping them out of the initial bundle is worth one dynamic import.
 */
async function openSelectAndMask(doc, opts = {}) {
  if (!doc) return;
  const { showSelectAndMask } = await import('../ui/dialogs/select-and-mask.js');
  await showSelectAndMask(doc, opts);
}

/**
 * Open Generative Fill.
 *
 * Loaded on demand, and for a stronger reason than bundle size: this is the only
 * corner of Pikado that can make a network request, and the module that can do it
 * is not even fetched until a user deliberately asks for the feature. The
 * providers register themselves as a side effect of that import.
 */
/**
 * Whether to offer the mock provider.
 *
 * It generates a hatched placeholder with no key and no network, which is what
 * makes it useful in the test suite and wrong in the shipped dropdown: beside
 * two real providers it reads as a third one that is simply broken. `?ai=mock`
 * is the flag its own source comment always claimed gated it, and did not.
 *
 * Exported and taking the query string as an argument so the rule can be tested
 * without a page load — the test suite registers the mock by importing it, so
 * its absence cannot be observed any other way.
 *
 * @param {string} search
 * @returns {boolean}
 */
export function mockProviderRequested(search = '') {
  return new URLSearchParams(search).get('ai') === 'mock';
}

/**
 * Everything the AI feature needs, fetched on demand.
 *
 * Exported so the test suite can assert the wiring itself. That is not
 * ceremony: the credential restore below existed as a function nobody called
 * for the whole life of the feature, and a test of the function would have
 * passed the entire time.
 */
export async function loadAiProviders() {
  await import('../ai/providers/openai.js');
  await import('../ai/providers/gemini.js');
  if (mockProviderRequested(location.search)) {
    await import('../ai/providers/mock.js');
  }
  /*
   * Restore any key the user asked this device to remember. Without it the
   * "Remember this key on this device" checkbox wrote to IndexedDB and nothing
   * ever read it back, so it behaved exactly like not ticking the box.
   */
  const { loadCredentials } = await import('../ai/credentials.js');
  await loadCredentials();
}

async function openGenerativeFill(doc) {
  if (!doc) return;
  await loadAiProviders();
  const { showGenerativeFillDialog } = await import('../ui/dialogs/generative-fill.js');
  await showGenerativeFillDialog(doc);
}

/* ------------------------------------------------------------------ */
/* File > Open Recent                                                  */
/* ------------------------------------------------------------------ */

const RECENT_KEY = 'pikado.recent';
const RECENT_MAX = 20;
const HANDLE_DB = 'pikado-recent';
const HANDLE_STORE = 'handles';

function readRecent() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list = raw ? JSON.parse(raw) : null;
    return Array.isArray(list) ? list.filter((e) => e && e.key) : [];
  } catch {
    return [];
  }
}

function writeRecent(list) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    /* Private mode or quota — the list simply will not survive a reload. */
  }
}

function openHandleDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
    const req = indexedDB.open(HANDLE_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(HANDLE_STORE)) req.result.createObjectStore(HANDLE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** File System Access handles survive a reload only in IndexedDB. */
async function rememberHandle(key, handle) {
  try {
    const db = await openHandleDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      tx.objectStore(HANDLE_STORE).put(handle, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* Handles are a bonus; the recent list still works without them. */
  }
}

async function recallHandle(key) {
  try {
    const db = await openHandleDB();
    const handle = await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly');
      const req = tx.objectStore(HANDLE_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return handle;
  } catch {
    return null;
  }
}

const noted = new Set();

function noteRecent(doc) {
  if (!doc || !doc.filePath) return;
  const key = String(doc.filePath);
  const stamp = `${doc.id}:${key}`;
  if (noted.has(stamp)) return;
  noted.add(stamp);
  const limit = Math.min(RECENT_MAX, Number(getPref('recentLimit', 10)) || 0);
  if (limit <= 0) return;
  const list = readRecent().filter((e) => e.key !== key);
  list.unshift({ key, name: doc.name || key, time: Date.now() });
  writeRecent(list.slice(0, limit));
  if (doc.fileHandle) rememberHandle(key, doc.fileHandle);
}

app.on('docs-change', () => {
  for (const doc of app.docs) noteRecent(doc);
});

function recentList() {
  const limit = Math.min(RECENT_MAX, Number(getPref('recentLimit', 10)) || 0);
  return readRecent().slice(0, limit);
}

async function openRecent(entry) {
  if (!entry) return;
  const handle = await recallHandle(entry.key);
  if (handle && typeof handle.getFile === 'function') {
    try {
      let perm = handle.queryPermission ? await handle.queryPermission({ mode: 'read' }) : 'granted';
      if (perm !== 'granted' && handle.requestPermission) perm = await handle.requestPermission({ mode: 'read' });
      if (perm === 'granted') {
        const file = await handle.getFile();
        file.handle = handle;
        await openFiles([file]);
        return;
      }
    } catch (err) {
      console.warn('[open-recent]', err);
    }
  }
  app.toast(`The browser will not reopen "${entry.name}" by itself — pick the file again.`, 'warn', 4200);
  const input = document.getElementById('file-input');
  if (input) input.click();
}

/* ------------------------------------------------------------------ */
/* File helpers                                                        */
/* ------------------------------------------------------------------ */

function pickFiles() {
  const input = document.getElementById('file-input');
  if (input) { input.click(); return; }
  app.toast('The file picker is unavailable.', 'error');
}

async function closeDoc(doc) {
  if (!doc) return false;
  if (doc.dirty && getPref('confirmBeforeClosing', true)) {
    const ok = await confirmDialog(`"${doc.name}" has unsaved changes. Close it anyway?`, 'Close', 'Discard');
    if (!ok) return false;
  }
  app.closeDocument(doc);
  return true;
}

async function revertDoc(doc) {
  if (doc.fileHandle && typeof doc.fileHandle.getFile === 'function') {
    try {
      const file = await doc.fileHandle.getFile();
      file.handle = doc.fileHandle;
      app.closeDocument(doc);
      await openFiles([file]);
      return;
    } catch (err) {
      console.warn('[revert]', err);
    }
  }
  if (!doc.history.canUndo) { app.toast('Nothing to revert to.'); return; }
  doc.history.goto(0);
  doc.dirty = false;
  app.toast(`Reverted ${doc.name}`, 'ok');
}

async function showFileInfo(doc) {
  const info = doc.info || (doc.info = { title: '', author: '', description: '', copyright: '' });
  const stat = (label, value) => el('div.pkd-row', {},
    el('span', { text: label, style: { flex: '0 0 130px', color: 'var(--fg-dim)' } }),
    el('span', { text: value })
  );
  const layers = doc.flatLayers();
  const dlg = new Dialog({ title: 'File Info', width: 460 });

  const fields = {};
  const input = (key, label) => {
    const node = el('input.pk-input', { type: 'text', value: info[key] || '' });
    fields[key] = node;
    return el('div.pk-field', {}, el('label', { text: label }), node);
  };
  const desc = el('textarea.pk-input.pk-textarea', { rows: 3 });
  desc.value = info.description || '';

  dlg.setBody(el('div', {},
    el('div.pkd-section', { text: 'Description' }),
    input('title', 'Document Title'),
    input('author', 'Author'),
    el('div.pk-field', {}, el('label', { text: 'Description' }), desc),
    input('copyright', 'Copyright Notice'),
    el('div.pkd-section', { text: 'Data' }),
    stat('Dimensions', `${doc.width} × ${doc.height} px`),
    stat('Resolution', `${Math.round(doc.resolution || 72)} ppi`),
    stat('Print size', `${(doc.width / (doc.resolution || 72)).toFixed(2)} × ${(doc.height / (doc.resolution || 72)).toFixed(2)} in`),
    stat('Color mode', doc.colorMode === 'grayscale' ? 'Grayscale' : doc.colorMode === 'bitmap' ? 'Bitmap' : 'RGB Color'),
    stat('Layers', `${layers.length} (${layers.filter((l) => l.visible).length} visible)`),
    stat('Alpha channels', String(doc.alphaChannels.length)),
    stat('Paths', String(doc.paths.length)),
    stat('Pixel memory', formatBytes(doc.memoryUse())),
    stat('History states', String(doc.history.states.length)),
    stat('File', doc.filePath || 'Not saved yet'),
    el('div.pkd-note', { text: 'Description fields are kept with the open document and written into .pkd projects.' })
  ));
  dlg.setButtons([
    { label: 'Cancel', value: null, subtle: true },
    { label: 'OK', primary: true, onClick: (d) => { d.close(true); return false; } },
  ]);
  const ok = await dlg.open();
  if (!ok) return;
  for (const [key, node] of Object.entries(fields)) info[key] = node.value;
  info.description = desc.value;
  doc.dirty = true;
  app.emit('doc-change', doc);
}

/* ------------------------------------------------------------------ */
/* Edit > Transform                                                    */
/* ------------------------------------------------------------------ */

let liveTransform = null;
let lastTransform = null;

// The transform session is owned by tools/transform.js; sampling it on every
// repaint is how "Transform Again" learns what the user last did.
app.on('render', () => {
  if (app.transformSession) {
    liveTransform = tf.getTransformNumeric();
  } else if (liveTransform) {
    lastTransform = liveTransform;
    liveTransform = null;
  }
});

/**
 * The live transform session, but only when it belongs to the active document.
 * Closing or switching documents leaves `app.transformSession` pointing at the
 * old one; routing commands into it would silently do nothing here.
 */
function liveSession() {
  const s = app.transformSession;
  return s && s.doc === D() ? s : null;
}

function startOrSwitchTransform(mode) {
  const doc = D();
  if (!doc) return;
  if (liveSession()) tf.setTransformMode(mode);
  else tf.startTransform(doc, { mode });
}

function pivotOf(n) {
  return {
    x: n.bounds.x + n.pivotX * n.bounds.width,
    y: n.bounds.y + n.pivotY * n.bounds.height,
  };
}

/** Edit > Transform > Again — repeat the last transform on the current layers. */
function transformAgain() {
  const doc = D();
  if (!doc || !lastTransform) { app.toast('No transform to repeat.'); return; }
  const prevPivot = pivotOf(lastTransform);
  const dx = lastTransform.x - prevPivot.x;
  const dy = lastTransform.y - prevPivot.y;

  if (!tf.startTransform(doc, { mode: 'free' })) return;
  const now = tf.getTransformNumeric();
  if (!now) return;
  const pivot = pivotOf(now);
  tf.setTransformNumeric({
    scaleX: lastTransform.scaleX,
    scaleY: lastTransform.scaleY,
    angle: lastTransform.angle,
    skewX: lastTransform.skewX,
    skewY: lastTransform.skewY,
    x: pivot.x + dx,
    y: pivot.y + dy,
  });
  tf.commitTransform();
}

/** Rotate/flip: the live session when there is one, otherwise the layer pixels. */
function transformLayersOrSession(kind, label) {
  const doc = D();
  if (!doc) return;
  if (liveSession()) {
    if (kind === 'flip-h') tf.flipTransform('h');
    else if (kind === 'flip-v') tf.flipTransform('v');
    else tf.rotateTransform(kind === 'cw' ? 90 : kind === 'ccw' ? -90 : 180);
    return;
  }
  img.transformLayers(doc, null, kind, label);
}

/* ------------------------------------------------------------------ */
/* Edit > Purge                                                        */
/* ------------------------------------------------------------------ */

function purge(what) {
  if (what === 'clipboard' || what === 'all') app.clipboard = null;
  if (what === 'undo' && app.activeDoc) app.activeDoc.history.clear('Purge');
  if (what === 'histories' || what === 'all') for (const d of app.docs) d.history.clear('Purge');
  app.emit('history-change', app.activeDoc);
  app.toast('Purged.', 'ok');
}

/* ------------------------------------------------------------------ */
/* Selection helpers                                                   */
/* ------------------------------------------------------------------ */

/** Remembers the mask that Deselect threw away, so Reselect can restore it. */
const lastMasks = new WeakMap();

function deselect(doc) {
  if (!doc.selection.active) return;
  lastMasks.set(doc, new Uint8ClampedArray(doc.selection.mask));
  doc.selection.clear();
  commitSelection(doc, 'Deselect');
}

function reselect(doc) {
  const mask = lastMasks.get(doc);
  if (!mask || mask.length !== doc.width * doc.height) { app.toast('Nothing to reselect.'); return; }
  doc.selection.set(new Uint8ClampedArray(mask));
  commitSelection(doc, 'Reselect');
}

async function modifySelection(doc, kind) {
  const titles = {
    border: 'Border Selection', smooth: 'Smooth Selection', expand: 'Expand Selection',
    contract: 'Contract Selection', feather: 'Feather Selection',
  };
  const max = kind === 'feather' ? 250 : 100;
  const result = await paramDialog({
    title: titles[kind],
    width: 320,
    preview: false,
    state: { amount: kind === 'feather' ? 2 : 4 },
    params: [{ key: 'amount', label: kind === 'feather' ? 'Feather Radius' : 'Width', type: 'slider', min: 1, max, step: 1, unit: 'px' }],
  });
  if (!result) return;
  const n = result.amount;
  if (kind === 'border') doc.selection.border(n);
  else if (kind === 'smooth') doc.selection.smooth(n);
  else if (kind === 'expand') doc.selection.expand(n);
  else if (kind === 'contract') doc.selection.contract(n);
  else doc.selection.feather(n);
  commitSelection(doc, titles[kind]);
}

function toggleQuickMaskMode(doc) {
  doc.quickMask = !doc.quickMask;
  if (doc.quickMask && !doc.selection.active) {
    doc.selection.set(new Uint8ClampedArray(doc.width * doc.height));
  }
  doc.touch('quick-mask');
  app.emit('doc-selection', doc);
  app.toast(doc.quickMask ? 'Quick Mask on' : 'Quick Mask off');
}

async function saveSelection(doc) {
  const name = await promptDialog('Channel name', `Alpha ${doc.alphaChannels.length + 1}`, 'Save Selection');
  if (name == null) return;
  doc.alphaChannels.push({
    id: `chan_${Date.now().toString(36)}_${doc.alphaChannels.length}`,
    name: name.trim() || `Alpha ${doc.alphaChannels.length + 1}`,
    canvas: doc.selection.toCanvas(),
  });
  doc.commit('Save Selection');
  app.toast('Selection saved as an alpha channel.', 'ok');
}

function maskFromCanvas(canvas, w, h) {
  const scaled = canvas.width === w && canvas.height === h ? canvas : (() => {
    const cv = createCanvas(w, h);
    cv.getContext('2d').drawImage(canvas, 0, 0, w, h);
    return cv;
  })();
  return Selection.fromCanvas(scaled).mask;
}

async function loadSelection(doc) {
  const sources = [
    ...doc.alphaChannels.map((c) => ({ value: `chan:${c.id}`, label: `Channel — ${c.name}` })),
    ...doc.flatLayers().filter((l) => l.canvas).map((l) => ({ value: `layer:${l.id}`, label: `${l.name} Transparency` })),
    ...doc.flatLayers().filter((l) => l.mask).map((l) => ({ value: `mask:${l.id}`, label: `${l.name} Mask` })),
  ];
  if (!sources.length) { app.toast('There is nothing to load a selection from.'); return; }

  const result = await paramDialog({
    title: 'Load Selection',
    width: 380,
    preview: false,
    state: { source: sources[0].value, op: 'replace', invert: false },
    params: [
      { key: 'source', label: 'Source', type: 'select', options: sources },
      {
        key: 'op', label: 'Operation', type: 'radio',
        options: [
          { value: 'replace', label: 'New Selection' },
          { value: 'add', label: 'Add to Selection' },
          { value: 'subtract', label: 'Subtract from Selection' },
          { value: 'intersect', label: 'Intersect with Selection' },
        ],
      },
      { key: 'invert', label: 'Invert', type: 'checkbox' },
    ],
  });
  if (!result) return;

  const [kind, id] = result.source.split(':');
  let mask = null;
  if (kind === 'chan') {
    const ch = doc.alphaChannels.find((c) => c.id === id);
    if (ch && ch.canvas) mask = maskFromCanvas(ch.canvas, doc.width, doc.height);
    else if (ch && ch.mask) mask = new Uint8ClampedArray(ch.mask);
  } else {
    const layer = doc.findLayer(id);
    if (!layer) return;
    if (kind === 'mask') mask = maskFromCanvas(layer.mask, doc.width, doc.height);
    else {
      const d = layer.canvas.getContext('2d', { willReadFrequently: true })
        .getImageData(0, 0, doc.width, doc.height).data;
      mask = new Uint8ClampedArray(doc.width * doc.height);
      for (let p = 0, i = 3; p < mask.length; p++, i += 4) mask[p] = d[i];
    }
  }
  if (!mask) { app.toast('That source has no pixels.'); return; }
  if (result.invert) for (let i = 0; i < mask.length; i++) mask[i] = 255 - mask[i];
  doc.selection.combine(mask, result.op);
  commitSelection(doc, 'Load Selection');
}

/**
 * Select > Make Work Path — trace the selection into `doc.paths`.
 *
 * Reuses the marching-squares tracer and the bezier pipeline that Type >
 * Convert to Shape uses (`traceAlphaContours` + `loopsToSubpaths`, below);
 * only the bounding box is scanned, since a selection is usually small
 * relative to the canvas. Like the Paths panel, the traced result replaces the
 * existing Work Path rather than piling up new ones.
 */
function makeWorkPath(doc) {
  const sel = doc.selection;
  const b = sel.active ? sel.bounds() : null;
  if (!b) { app.toast('Make a selection first.'); return; }

  // A 1px pad keeps a selection that touches the canvas edge a closed loop.
  const pad = 1;
  const ox = Math.max(0, b.x - pad);
  const oy = Math.max(0, b.y - pad);
  const crop = createCanvas(b.width + pad * 2, b.height + pad * 2);
  crop.getContext('2d').drawImage(sel.toAlphaCanvas(), -ox, -oy);

  const subpaths = loopsToSubpaths(traceAlphaContours(crop), ox, oy, 1, 1.4);
  if (!subpaths.length) { app.toast('That selection is too small to trace.'); return; }

  const i = doc.paths.findIndex((p) => p.isWork);
  const path = { id: i >= 0 ? doc.paths[i].id : uid('path'), name: 'Work Path', isWork: true, subpaths };
  if (i >= 0) doc.paths[i] = path;
  else doc.paths.unshift(path);
  doc.activePathId = path.id;
  doc.emit('structure');
  doc.commit('Make Work Path');
}

function selectAllLayers(doc) {
  const list = doc.flatLayers().filter((l) => !l.isBackground);
  const use = list.length ? list : doc.flatLayers();
  doc.selectedLayerIds = use.map((l) => l.id);
  doc.activeLayerId = use.length ? use[0].id : null;
  doc.emit('selection-change');
  doc.emit('structure');
}

function deselectLayers(doc) {
  doc.selectedLayerIds = [];
  doc.activeLayerId = null;
  doc.emit('selection-change');
  doc.emit('structure');
}

/* ------------------------------------------------------------------ */
/* Layer > New > Layer Via Copy / Layer Via Cut                        */
/* ------------------------------------------------------------------ */

/** The layer Layer Via Copy/Cut reads from — real pixels, not a group or mask. */
function viaSourceLayer() {
  const l = activeLayer();
  if (!l || !l.canvas || l.type === LayerType.GROUP) return null;
  if (l.editingMask) return null; // "via copy" means the pixels, not the mask
  return l;
}

function canLayerVia(cut) {
  const l = viaSourceLayer();
  if (!l || !hasSelection()) return false;
  // Cut has to erase the source, so it needs an unlocked raster layer; copy
  // only reads, so it happily works from type, shape and smart layers too.
  return !cut || (l.type === LayerType.RASTER && !l.locked.all && !l.locked.pixels);
}

/**
 * Move the selected pixels of the active layer into a new layer above it.
 *
 * Layer buffers are always document-sized, so writing the extracted pixels at
 * the origin is what "keeps position" means here — there is no offset to carry.
 * Cut additionally clears the region from the source layer; both record a
 * single history entry.
 *
 * @param {import('../core/document.js').PikaDocument} doc
 * @param {boolean} cut
 */
function layerViaSelection(doc, cut) {
  const layer = viaSourceLayer();
  if (!layer || !doc.selection.active) return;
  if (!doc.selection.bounds()) { app.toast('The selection is empty.'); return; }
  const alpha = doc.selection.toAlphaCanvas();

  const cv = createCanvas(doc.width, doc.height);
  const c = cv.getContext('2d');
  c.drawImage(layer.canvas, 0, 0);
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(alpha, 0, 0);

  if (cut) {
    // COW before the source pixels change, or older undo states lose them.
    doc.beginEdit(layer);
    const lc = layer.canvas.getContext('2d');
    lc.save();
    lc.globalCompositeOperation = 'destination-out';
    lc.drawImage(alpha, 0, 0);
    lc.restore();
  }

  doc.addLayer(new Layer({ type: LayerType.RASTER, name: ops.nextLayerName(doc), canvas: cv }), { above: layer });
  doc.commit(cut ? 'Layer Via Cut' : 'Layer Via Copy');
}

/* ------------------------------------------------------------------ */
/* Layer > New Fill Layer                                              */
/* ------------------------------------------------------------------ */

async function newFillLayer(doc, kind) {
  if (kind === 'solid') {
    const c = await showColorPicker({ color: toHex(app.foreground), title: 'Color Fill' });
    if (!c) return;
    ops.addFillLayer(doc, 'solid', { color: toCss(c) });
    return;
  }
  if (kind === 'gradient') {
    const result = await paramDialog({
      title: 'Gradient Fill',
      width: 420,
      preview: false,
      state: {
        gradient: { stops: [{ pos: 0, color: toHex(app.foreground) }, { pos: 1, color: toHex(app.background) }] },
        angle: 90,
      },
      params: [
        gradientParam({ key: 'gradient', label: 'Gradient' }),
        { key: 'angle', label: 'Angle', type: 'angle' },
      ],
    });
    if (!result) return;
    const g = normalizeGradient(result.gradient);
    ops.addFillLayer(doc, 'gradient', { stops: g.stops, angle: result.angle });
    return;
  }
  const patterns = getPatterns();
  if (!patterns.length) { app.toast('No patterns available — use Edit > Define Pattern first.'); return; }
  const result = await paramDialog({
    title: 'Pattern Fill',
    width: 380,
    preview: false,
    state: { pattern: patterns[0].id, scale: 1 },
    params: [
      { key: 'pattern', label: 'Pattern', type: 'select', options: patterns.map((p) => ({ value: p.id, label: p.name })) },
      { key: 'scale', label: 'Scale', type: 'slider', min: 0.1, max: 4, step: 0.1 },
      { type: 'label', label: 'A pattern fill is baked into pixels, with a mask you can paint on.' },
    ],
  });
  if (!result) return;
  const entry = patterns.find((p) => p.id === result.pattern) || patterns[0];
  // History snapshots structured-clone `layer.shape`, and a canvas is not
  // cloneable — so the tile is rendered into a masked raster layer instead of
  // being stored on a live fill layer.
  const layer = new Layer({
    type: LayerType.RASTER,
    name: 'Pattern Fill',
    canvas: makeTiledCanvas(entry, doc.width, doc.height, result.scale),
  });
  layer.addMask(doc.width, doc.height, '#ffffff');
  doc.addLayer(layer);
  doc.commit('New Fill Layer');
}

/* ------------------------------------------------------------------ */
/* Layer > Rasterize > All Layers                                      */
/* ------------------------------------------------------------------ */

function rasterizeAll(doc) {
  const targets = doc.flatLayers().filter((l) => l.type === LayerType.TEXT || l.type === LayerType.SHAPE || l.type === LayerType.SMART);
  if (!targets.length) { app.toast('There is nothing left to rasterize.'); return; }
  doc.history.suspend();
  try {
    for (const l of targets) ops.rasterizeLayer(doc, l);
  } finally {
    doc.history.resume();
  }
  doc.commit('Rasterize All Layers');
}

/* ------------------------------------------------------------------ */
/* Layer styles (loaded on demand)                                     */
/* ------------------------------------------------------------------ */

let stylesMod = null;

async function stylesModule() {
  if (!stylesMod) stylesMod = await import('../effects/styles-dialog.js');
  return stylesMod;
}

const EFFECTS = [
  { id: 'dropShadow', label: 'Drop Shadow…' },
  { id: 'innerShadow', label: 'Inner Shadow…' },
  { id: 'outerGlow', label: 'Outer Glow…' },
  { id: 'innerGlow', label: 'Inner Glow…' },
  { id: 'bevelEmboss', label: 'Bevel & Emboss…' },
  { id: 'satin', label: 'Satin…' },
  { id: 'colorOverlay', label: 'Color Overlay…' },
  { id: 'gradientOverlay', label: 'Gradient Overlay…' },
  { id: 'patternOverlay', label: 'Pattern Overlay…' },
  { id: 'stroke', label: 'Stroke…' },
];

/* ------------------------------------------------------------------ */
/* Type                                                                */
/* ------------------------------------------------------------------ */

function textLayer() {
  return layerOfType(LayerType.TEXT);
}

function setTextProp(doc, patch, label) {
  const l = textLayer();
  if (!l || !l.text) return;
  doc.beginEdit(l);
  Object.assign(l.text, patch);
  l.canvas = rasterizeTextLayer(l, doc);
  doc.commit(label);
}

async function warpTextDialog(doc) {
  const l = textLayer();
  if (!l || !l.text) return;
  const current = l.text.warp || { style: 'none', bend: 0, h: 0, v: 0 };
  const original = { ...current };
  const apply = (s) => {
    l.text.warp = { style: s.style, bend: s.bend, h: s.h, v: s.v };
    l.canvas = rasterizeTextLayer(l, doc);
    doc.touch('warp-preview');
  };
  doc.beginEdit(l);
  const result = await paramDialog({
    title: 'Warp Text',
    width: 380,
    state: { ...original },
    params: [
      { key: 'style', label: 'Style', type: 'select', options: WARP_STYLES },
      { key: 'bend', label: 'Bend', type: 'slider', min: -100, max: 100, step: 1, unit: '%', when: (s) => s.style !== 'none' },
      { key: 'h', label: 'Horizontal Distortion', type: 'slider', min: -100, max: 100, step: 1, unit: '%', when: (s) => s.style !== 'none' },
      { key: 'v', label: 'Vertical Distortion', type: 'slider', min: -100, max: 100, step: 1, unit: '%', when: (s) => s.style !== 'none' },
    ],
    onPreview: (s) => apply(s || original),
  });
  if (!result) { apply(original); return; }
  apply(result);
  doc.commit('Warp Text');
}

/* --- Convert to Shape ------------------------------------------------ */

/*
 * Marching-squares edge table. Corner bits are tl=8 tr=4 br=2 bl=1; the edge
 * ids are 0 top, 1 right, 2 bottom, 3 left. Every segment is oriented so the
 * opaque side lies on its left, which makes outer contours and holes wind
 * opposite ways — exactly what `nonzero` filling needs.
 */
const MS_TABLE = [
  [], [[3, 2]], [[2, 1]], [[3, 1]],
  [[1, 0]], [[1, 0], [3, 2]], [[2, 0]], [[3, 0]],
  [[0, 3]], [[0, 2]], [[0, 3], [2, 1]], [[0, 1]],
  [[1, 3]], [[1, 2]], [[2, 3]], [],
];

/**
 * Trace the alpha channel of a canvas into closed point loops.
 * @param {HTMLCanvasElement} canvas
 * @param {number} [threshold] alpha at which a pixel counts as opaque
 * @returns {{x:number,y:number}[][]}
 */
function traceAlphaContours(canvas, threshold = 128) {
  const w = canvas.width, h = canvas.height;
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const on = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : (data[(y * w + x) * 4 + 3] >= threshold ? 1 : 0));

  const key = (x, y) => (y * 2 + 2) * (w * 2 + 4) + (x * 2 + 2);
  /** @type {Map<number, {fx:number, fy:number, tx:number, ty:number}[]>} */
  const links = new Map();
  const push = (fx, fy, tx, ty) => {
    const k = key(fx, fy);
    const bucket = links.get(k);
    if (bucket) bucket.push({ fx, fy, tx, ty });
    else links.set(k, [{ fx, fy, tx, ty }]);
  };

  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const idx = on(x, y) * 8 + on(x + 1, y) * 4 + on(x + 1, y + 1) * 2 + on(x, y + 1);
      const segs = MS_TABLE[idx];
      if (!segs.length) continue;
      const ex = [x + 0.5, x + 1, x + 0.5, x];
      const ey = [y, y + 0.5, y + 1, y + 0.5];
      for (let i = 0; i < segs.length; i++) {
        const [a, b] = segs[i];
        push(ex[a], ey[a], ex[b], ey[b]);
      }
    }
  }

  const loops = [];
  const guardMax = w * h * 4 + 64;
  for (const startKey of links.keys()) {
    let bucket = links.get(startKey);
    while (bucket && bucket.length) {
      let seg = bucket.pop();
      const sx = seg.fx, sy = seg.fy;
      // +0.5 converts the pixel-index grid back to canvas coordinates.
      const loop = [{ x: sx + 0.5, y: sy + 0.5 }];
      let guard = 0;
      while (seg && guard++ < guardMax) {
        loop.push({ x: seg.tx + 0.5, y: seg.ty + 0.5 });
        if (seg.tx === sx && seg.ty === sy) break;
        const next = links.get(key(seg.tx, seg.ty));
        if (!next || !next.length) break;
        seg = next.pop();
      }
      if (loop.length > 6) loops.push(loop);
      bucket = links.get(startKey);
    }
  }
  return loops;
}

/** Ramer–Douglas–Peucker on a closed loop. */
function simplifyLoop(points, tolerance) {
  const n = points.length;
  if (n < 4) return points;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [];
  const first = points[0], last = points[n - 1];
  if (Math.abs(last.x - first.x) < 1e-9 && Math.abs(last.y - first.y) < 1e-9) {
    // A traced contour ends where it starts, and RDP with coincident endpoints
    // measures every distance against a zero-length baseline — it would keep
    // nothing. Split the loop at its farthest vertex and simplify each arc.
    let split = -1, far = -1;
    for (let i = 1; i < n - 1; i++) {
      const d = Math.hypot(points[i].x - first.x, points[i].y - first.y);
      if (d > far) { far = d; split = i; }
    }
    if (split > 0) {
      keep[split] = 1;
      stack.push([0, split], [split, n - 1]);
    } else {
      stack.push([0, n - 1]);
    }
  } else {
    stack.push([0, n - 1]);
  }
  while (stack.length) {
    const [a, b] = stack.pop();
    const pa = points[a], pb = points[b];
    const dx = pb.x - pa.x, dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy) || 1;
    let worst = -1, worstD = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((points[i].x - pa.x) * dy - (points[i].y - pa.y) * dx) / len;
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Turn traced pixel loops into closed bezier subpaths.
 *
 * Shared by Type > Convert to Shape and Select > Make Work Path: both trace an
 * alpha channel with `traceAlphaContours` and then need the same simplify →
 * curve-fit → close pipeline.
 *
 * @param {{x:number,y:number}[][]} loops
 * @param {number} [ox] offset added to every point (loops traced from a crop)
 * @param {number} [oy]
 * @param {number} [simplifyTol] RDP tolerance in px
 * @param {number} [fitTol] curve-fitting tolerance in px
 */
function loopsToSubpaths(loops, ox = 0, oy = 0, simplifyTol = 0.6, fitTol = 1.1) {
  const subpaths = [];
  for (const raw of loops) {
    const loop = ox || oy ? raw.map((p) => ({ x: p.x + ox, y: p.y + oy })) : raw;
    const simple = simplifyLoop(loop, simplifyTol);
    if (simple.length < 4) continue;
    const sp = fitCurve(simple, fitTol);
    if (sp.points.length < 3) continue;
    const first = sp.points[0];
    const last = sp.points[sp.points.length - 1];
    if (Math.hypot(last.x - first.x, last.y - first.y) < 1.2) {
      first.in = last.in ? { ...last.in } : null;
      sp.points.pop();
    }
    sp.closed = true;
    subpaths.push(sp);
  }
  return subpaths;
}

/** Type > Convert to Shape — trace the rendered glyphs into vector subpaths. */
function convertTypeToShape(doc) {
  const l = textLayer();
  if (!l || !l.canvas) { app.toast('Select a type layer.'); return; }
  const box = l.contentBounds();
  if (!box) { app.toast('This type layer has no visible pixels.'); return; }

  // Trace only the glyph bounding box — a full-document scan is pure waste.
  const pad = 2;
  const ox = Math.max(0, box.x - pad);
  const oy = Math.max(0, box.y - pad);
  const crop = createCanvas(box.width + pad * 2, box.height + pad * 2);
  crop.getContext('2d').drawImage(l.canvas, -ox, -oy);

  const loops = traceAlphaContours(crop);
  if (!loops.length) { app.toast('This type layer has no visible pixels.'); return; }

  const subpaths = loopsToSubpaths(loops, ox, oy);
  if (!subpaths.length) { app.toast('The outline was too small to trace.'); return; }

  const color = typeof l.text.color === 'string' ? l.text.color : toCss(l.text.color || '#000000');
  const shape = createShapeLayer(doc, subpaths, defaultShapeStyle({ fill: { type: 'solid', color } }), l.name);
  shape.opacity = l.opacity;
  shape.blendMode = l.blendMode;
  shape.styles = l.styles;
  const loc = doc.locate(l);
  const parent = loc ? loc.parent : null;
  const index = loc ? loc.index : 0;
  doc.removeLayer(l);
  doc.addLayer(shape, { parent, index });
  doc.commit('Convert to Shape');
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

function zoomTo(scale) {
  if (!app.activeDoc) return;
  app.viewport.setScale(scale);
  app.emit('view-change');
  app.requestRender();
}

function zoomStep(dir) {
  if (!app.activeDoc) return;
  app.viewport.zoomStep(dir);
  app.emit('view-change');
  app.requestRender();
}

let extrasHidden = null;

function toggleExtras() {
  if (extrasHidden) {
    app.showGuides = extrasHidden.guides;
    app.showGrid = extrasHidden.grid;
    extrasHidden = null;
  } else {
    extrasHidden = { guides: app.showGuides, grid: app.showGrid };
    app.showGuides = false;
    app.showGrid = false;
  }
  app.requestRender();
}

function toggleFlag(key) {
  app[key] = !app[key];
  if (extrasHidden && (key === 'showGuides' || key === 'showGrid')) extrasHidden = null;
  app.emit('view-change');
  app.requestRender();
}

function dedupeGuides(list) {
  const seen = new Set();
  const out = [];
  for (const g of list) {
    const k = `${g.axis}:${Math.round(g.pos)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ axis: g.axis, pos: Math.round(g.pos) });
  }
  return out;
}

async function newGuide(doc) {
  const result = await paramDialog({
    title: 'New Guide',
    width: 320,
    preview: false,
    state: { axis: 'v', pos: Math.round(doc.width / 2) },
    params: [
      { key: 'axis', label: 'Orientation', type: 'radio', options: [{ value: 'v', label: 'Vertical' }, { value: 'h', label: 'Horizontal' }] },
      { key: 'pos', label: 'Position', type: 'number', min: 0, unit: 'px' },
    ],
  });
  if (!result) return;
  const max = result.axis === 'v' ? doc.width : doc.height;
  doc.guides = dedupeGuides([...doc.guides, { axis: result.axis, pos: clamp(result.pos, 0, max) }]);
  app.showGuides = true;
  doc.commit('New Guide');
}

async function newGuideLayout(doc) {
  const result = await paramDialog({
    title: 'New Guide Layout',
    width: 380,
    preview: false,
    state: { clear: true, columns: 3, columnGutter: 20, rows: 0, rowGutter: 20, margin: 0 },
    params: [
      { key: 'clear', label: 'Clear existing guides', type: 'checkbox' },
      { key: 'columns', label: 'Columns', type: 'slider', min: 0, max: 24, step: 1 },
      { key: 'columnGutter', label: 'Column Gutter', type: 'number', min: 0, unit: 'px', when: (s) => s.columns > 0 },
      { key: 'rows', label: 'Rows', type: 'slider', min: 0, max: 24, step: 1 },
      { key: 'rowGutter', label: 'Row Gutter', type: 'number', min: 0, unit: 'px', when: (s) => s.rows > 0 },
      { key: 'margin', label: 'Margin', type: 'number', min: 0, unit: 'px' },
    ],
  });
  if (!result) return;

  const guides = result.clear ? [] : [...doc.guides];
  const m = Math.max(0, result.margin);
  if (m > 0) {
    guides.push({ axis: 'v', pos: m }, { axis: 'v', pos: doc.width - m });
    guides.push({ axis: 'h', pos: m }, { axis: 'h', pos: doc.height - m });
  }
  if (result.columns > 0) {
    const span = doc.width - m * 2;
    const cw = (span - result.columnGutter * (result.columns - 1)) / result.columns;
    if (cw > 0) {
      let x = m;
      for (let i = 0; i < result.columns; i++) {
        guides.push({ axis: 'v', pos: x }, { axis: 'v', pos: x + cw });
        x += cw + result.columnGutter;
      }
    }
  }
  if (result.rows > 0) {
    const span = doc.height - m * 2;
    const rh = (span - result.rowGutter * (result.rows - 1)) / result.rows;
    if (rh > 0) {
      let y = m;
      for (let i = 0; i < result.rows; i++) {
        guides.push({ axis: 'h', pos: y }, { axis: 'h', pos: y + rh });
        y += rh + result.rowGutter;
      }
    }
  }
  doc.guides = dedupeGuides(guides);
  app.showGuides = true;
  doc.commit('New Guide Layout');
}

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

const WORKSPACES = {
  essentials: ['layers', 'channels', 'paths', 'color', 'swatches', 'properties', 'history', 'navigator'],
  painting: ['color', 'swatches', 'layers', 'navigator', 'history'],
  photography: ['layers', 'channels', 'info', 'properties', 'history', 'navigator'],
};

function applyWorkspace(name) {
  const wanted = new Set(WORKSPACES[name] || WORKSPACES.essentials);
  for (const p of PANELS.keys()) {
    if (wanted.has(p)) openPanel(p);
    else closePanel(p);
  }
  app.toast(`${name[0].toUpperCase()}${name.slice(1)} workspace`, 'ok');
}

function resetWorkspace() {
  for (const p of PANELS.values()) {
    if (p.defaultOpen) openPanel(p.id);
    else closePanel(p.id);
  }
  app.toast('Workspace reset.', 'ok');
}

function stepDocument(dir) {
  if (app.docs.length < 2) return;
  const i = app.docs.indexOf(app.activeDoc);
  const next = app.docs[(i + dir + app.docs.length) % app.docs.length];
  app.setActiveDoc(next);
}

/** One toggle command per registered panel, created lazily. */
function ensurePanelCommands() {
  const ids = [];
  for (const p of PANELS.values()) {
    const id = `window.panel.${p.id}`;
    ids.push(id);
    if (getCommand(id)) continue;
    registerCommand({
      id,
      label: p.title,
      checked: () => isPanelVisible(p.id),
      run: () => togglePanel(p.id),
    });
  }
  return ids;
}

/* ------------------------------------------------------------------ */
/* Help                                                                */
/* ------------------------------------------------------------------ */

const DONE = [
  'Layers, groups, 27 blend modes, opacity and fill opacity',
  'Layer masks, clipping masks and ten live layer effects',
  'Adjustment layers and 24 destructive adjustments',
  '60+ filters across Blur, Distort, Noise, Pixelate, Render, Sharpen, Stylize and Other',
  'Marquee, lasso, magic wand, quick select and Color Range selections',
  'Pressure-aware brush engine, eraser, clone/pattern stamp, healing, dodge/burn/sponge',
  'Gradients, patterns, Fill, Stroke and a real content-aware fill',
  'Type layers with warping, vector paths and live shape layers',
  'Free transform with scale, rotate, skew, distort, perspective and warp',
  'Snapshot undo history, guides, grid, rulers and quick mask',
  'Snapping and smart guides across every drag, with Ctrl to override',
  'Select Subject and the Select and Mask workspace, on a GrabCut segmenter',
  'Camera Raw develop controls and a frame-animation timeline',
  'Colour management with soft proofing and gamut warning',
  'Slices and notes',
  'The whole Google Fonts catalogue, downloaded and kept for offline use',
  'Open and save .pkd projects; import/export PSD, PNG, JPG, WebP, GIF and SVG',
  'Non-destructive smart objects: embedded contents, re-editable smart filters and transforms',
];

const NOT_DONE = [
  'CMYK, Lab, Indexed and Duotone document modes; 16- and 32-bit depth',
  'A standing layer-edge overlay (edges show while dragging, not at rest)',
  '3D and panorama merging',
  'Cloud documents, plug-ins and scripting',
];

function showAbout() {
  const dlg = new Dialog({ title: 'About Pikado', width: 520 });
  dlg.setBody(el('div.pkd-about', {},
    el('p', {
      text: 'Pikado is an image editor that runs entirely in the browser. No pixels leave '
        + 'your machine — Generative Fill is the one thing that can send any, and it asks first. '
        + 'Web fonts are downloaded from Google when you use one, which sends nothing of yours.',
    }),
    el('div.pkd-section', { text: 'What works' }),
    el('ul', {}, ...DONE.map((t) => el('li', { text: t }))),
    el('div.pkd-section', { text: 'What is not implemented' }),
    el('ul', {}, ...NOT_DONE.map((t) => el('li', { text: t }))),
    el('div.pkd-note', { text: 'Built with plain ES modules and a 2-D canvas. Everything above is checked against the code, not the roadmap.' })
  ));
  dlg.setButtons([{ label: 'Close', value: true, primary: true }]);
  return dlg.open();
}

/* ------------------------------------------------------------------ */
/* Command table                                                       */
/* ------------------------------------------------------------------ */

registerCommands([
  /* --- File ------------------------------------------------------- */
  { id: 'file.new', label: 'New…', accel: 'Ctrl+N', run: () => showNewDocumentDialog() },
  { id: 'file.open', label: 'Open…', accel: 'Ctrl+O', run: () => pickFiles() },
  {
    id: 'file.recent-clear', label: 'Clear Recent File List',
    run: () => { writeRecent([]); noted.clear(); app.toast('Recent file list cleared.'); },
  },
  { id: 'file.close', label: 'Close', accel: 'Ctrl+W', enabled: hasDoc, run: () => closeDoc(D()) },
  {
    id: 'file.close-all', label: 'Close All', accel: 'Alt+Ctrl+W',
    enabled: () => app.docs.length > 0,
    run: async () => {
      for (const doc of [...app.docs]) {
        const ok = await closeDoc(doc);
        if (!ok) return;
      }
    },
  },
  { id: 'file.save', label: 'Save', accel: 'Ctrl+S', enabled: hasDoc, run: async () => { await saveDocument(D()); noteRecent(D()); } },
  { id: 'file.save-as', label: 'Save As…', accel: 'Shift+Ctrl+S', enabled: hasDoc, run: async () => { const d = D(); await saveDocumentAs(d); noteRecent(d); } },
  { id: 'file.export-as', label: 'Export As…', accel: 'Alt+Shift+Ctrl+W', enabled: hasDoc, run: () => showExportDialog(D()) },
  { id: 'file.export-png', label: 'Quick Export as PNG', enabled: hasDoc, run: () => quickExportPng(D()) },
  { id: 'file.revert', label: 'Revert', accel: 'F12', enabled: hasDoc, run: () => revertDoc(D()) },
  { id: 'file.print', label: 'Print…', accel: 'Ctrl+P', enabled: hasDoc, run: () => img.printDocument(D()) },
  { id: 'file.info', label: 'File Info…', accel: 'Alt+Shift+Ctrl+I', enabled: hasDoc, run: () => showFileInfo(D()) },

  /* --- Edit ------------------------------------------------------- */
  {
    id: 'edit.undo', label: 'Undo', accel: 'Ctrl+Z',
    dynamicLabel: () => {
      const d = D();
      if (!d || !d.history.canUndo) return 'Undo';
      return `Undo ${d.history.states[d.history.index].label}`;
    },
    enabled: () => !!(D() && D().history.canUndo),
    run: () => D().history.undo(),
  },
  {
    id: 'edit.redo', label: 'Redo', accel: 'Ctrl+Shift+Z',
    dynamicLabel: () => {
      const d = D();
      if (!d || !d.history.canRedo) return 'Redo';
      return `Redo ${d.history.states[d.history.index + 1].label}`;
    },
    enabled: () => !!(D() && D().history.canRedo),
    run: () => D().history.redo(),
  },
  {
    id: 'edit.step-forward', label: 'Step Forward',
    enabled: () => !!(D() && D().history.canRedo),
    run: () => D().history.redo(),
  },
  {
    id: 'edit.step-backward', label: 'Step Backward', accel: 'Ctrl+Alt+Z',
    enabled: () => !!(D() && D().history.canUndo),
    run: () => D().history.undo(),
  },
  {
    id: 'edit.fade', label: 'Fade…', accel: 'Shift+Ctrl+F',
    dynamicLabel: () => {
      const d = D();
      if (!d || !img.canFade(d)) return 'Fade…';
      return `Fade ${d.history.states[d.history.index].label}…`;
    },
    enabled: () => img.canFade(D()),
    run: () => img.showFadeDialog(D()),
  },

  { id: 'edit.cut', label: 'Cut', accel: 'Ctrl+X', enabled: hasPixels, run: () => cut(D()) },
  { id: 'edit.copy', label: 'Copy', accel: 'Ctrl+C', enabled: hasPixels, run: () => copy(D()) },
  { id: 'edit.copy-merged', label: 'Copy Merged', accel: 'Shift+Ctrl+C', enabled: hasDoc, run: () => copyMerged(D()) },
  { id: 'edit.paste', label: 'Paste', accel: 'Ctrl+V', enabled: hasDoc, run: () => paste(D()) },
  {
    id: 'edit.paste-into', label: 'Paste Into', accel: 'Alt+Shift+Ctrl+V',
    enabled: () => hasDoc() && hasSelection() && !!app.clipboard,
    run: () => pasteInto(D()),
  },
  {
    id: 'edit.paste-outside', label: 'Paste Outside',
    enabled: () => hasDoc() && hasSelection() && !!app.clipboard,
    run: () => pasteOutside(D()),
  },
  { id: 'edit.clear', label: 'Clear', accel: 'Delete', altAccels: ['Backspace'], enabled: hasPixels, run: () => clear(D()) },

  { id: 'edit.fill', label: 'Fill…', accel: 'Shift+F5', enabled: hasLayer, run: () => showFillDialog(D()) },
  {
    id: 'edit.fill-foreground', label: 'Fill with Foreground Color', accel: 'Alt+Backspace', altAccels: ['Alt+Delete'],
    enabled: hasPixels, run: () => fillSelection(D(), { use: 'foreground' }),
  },
  {
    id: 'edit.fill-background', label: 'Fill with Background Color', accel: 'Ctrl+Backspace', altAccels: ['Ctrl+Delete'],
    enabled: hasPixels, run: () => fillSelection(D(), { use: 'background' }),
  },
  { id: 'edit.stroke', label: 'Stroke…', enabled: hasLayer, run: () => showStrokeDialog(D()) },
  {
    id: 'edit.content-aware-fill', label: 'Content-Aware Fill…',
    enabled: () => hasPixels() && hasSelection(),
    run: () => showContentAwareFillDialog(D()),
  },
  {
    /*
     * Next to Content-Aware Fill because they are the same job — replace a
     * selection with plausible pixels — one done locally and one by asking a
     * model. Adjacency is what makes the choice legible.
     *
     * Deliberately enabled without a key. A greyed-out item whose reason is
     * invisible is a dead end: nothing would tell the user that a key is what is
     * missing, or where to put one. The dialog explains itself instead.
     */
    id: 'edit.generative-fill', label: 'Generative Fill…',
    enabled: () => hasPixels() && hasSelection(),
    run: () => openGenerativeFill(D()),
  },

  {
    id: 'edit.free-transform', label: 'Free Transform', accel: 'Ctrl+T',
    enabled: hasLayer, run: () => startOrSwitchTransform('free'),
  },
  { id: 'edit.transform.again', label: 'Again', accel: 'Shift+Ctrl+T', enabled: () => hasLayer() && !!lastTransform, run: transformAgain },
  { id: 'edit.transform.scale', label: 'Scale', enabled: hasLayer, run: () => startOrSwitchTransform('scale') },
  { id: 'edit.transform.rotate', label: 'Rotate', enabled: hasLayer, run: () => startOrSwitchTransform('rotate') },
  { id: 'edit.transform.skew', label: 'Skew', enabled: hasLayer, run: () => startOrSwitchTransform('skew') },
  { id: 'edit.transform.distort', label: 'Distort', enabled: hasLayer, run: () => startOrSwitchTransform('distort') },
  { id: 'edit.transform.perspective', label: 'Perspective', enabled: hasLayer, run: () => startOrSwitchTransform('perspective') },
  { id: 'edit.transform.warp', label: 'Warp', enabled: hasLayer, run: () => startOrSwitchTransform('warp') },
  { id: 'edit.transform.rot180', label: 'Rotate 180°', enabled: hasLayer, run: () => transformLayersOrSession('180', 'Rotate Layer 180°') },
  { id: 'edit.transform.rot90cw', label: 'Rotate 90° Clockwise', enabled: hasLayer, run: () => transformLayersOrSession('cw', 'Rotate Layer 90° CW') },
  { id: 'edit.transform.rot90ccw', label: 'Rotate 90° Counter Clockwise', enabled: hasLayer, run: () => transformLayersOrSession('ccw', 'Rotate Layer 90° CCW') },
  { id: 'edit.transform.flip-h', label: 'Flip Horizontal', enabled: hasLayer, run: () => transformLayersOrSession('flip-h', 'Flip Layer Horizontal') },
  { id: 'edit.transform.flip-v', label: 'Flip Vertical', enabled: hasLayer, run: () => transformLayersOrSession('flip-v', 'Flip Layer Vertical') },

  { id: 'edit.define-pattern', label: 'Define Pattern…', enabled: hasDoc, run: () => definePattern(D()) },
  { id: 'edit.purge.undo', label: 'Histories (this document)', enabled: hasDoc, run: () => purge('undo') },
  { id: 'edit.purge.clipboard', label: 'Clipboard', enabled: () => !!app.clipboard, run: () => purge('clipboard') },
  { id: 'edit.purge.histories', label: 'All Histories', enabled: () => app.docs.length > 0, run: () => purge('histories') },
  { id: 'edit.purge.all', label: 'All', enabled: () => app.docs.length > 0, run: () => purge('all') },
  { id: 'edit.keyboard-shortcuts', label: 'Keyboard Shortcuts…', accel: 'Alt+Shift+Ctrl+K', run: () => showKeyboardShortcutsDialog() },
  { id: 'edit.preferences', label: 'Preferences…', accel: 'Ctrl+K', run: () => showPreferencesDialog() },
  {
    // Next to Preferences rather than inside it: a credential should be
    // clearable on its own, and resetting preferences must not silently keep one.
    id: 'edit.ai-settings',
    label: 'AI Settings…',
    run: async () => {
      await loadAiProviders();
      const { showAiKeyDialog } = await import('../ui/dialogs/ai-key.js');
      await showAiKeyDialog('openai');
    },
  },

  /* --- Image ------------------------------------------------------ */
  {
    id: 'image.mode.rgb', label: 'RGB Color',
    enabled: hasDoc, checked: () => !!D() && D().colorMode === 'rgb',
    run: () => img.convertToRGB(D()),
  },
  {
    id: 'image.mode.grayscale', label: 'Grayscale',
    enabled: hasDoc, checked: () => !!D() && D().colorMode === 'grayscale',
    // Resolve the document up front: `app.busy` waits a frame, and the user can
    // close or switch documents before the callback runs.
    run: () => { const doc = D(); return app.busy('Grayscale', async () => img.convertToGrayscale(doc)); },
  },
  {
    id: 'edit.assign-profile', label: 'Assign Profile…',
    enabled: hasDoc,
    run: () => colorDialog('assign'),
  },
  {
    id: 'edit.convert-profile', label: 'Convert to Profile…',
    enabled: hasDoc,
    run: () => colorDialog('convert'),
  },
  {
    id: 'view.proof-colors', label: 'Proof Colors', accel: 'Ctrl+Y',
    enabled: hasDoc,
    checked: () => !!(D() && D().proof && D().proof.enabled),
    run: () => toggleProof(),
  },
  {
    id: 'view.proof-setup', label: 'Proof Setup…',
    enabled: hasDoc,
    run: () => colorDialog('proof'),
  },
  {
    id: 'view.gamut-warning', label: 'Gamut Warning', accel: 'Shift+Ctrl+Y',
    enabled: hasDoc,
    checked: () => !!(D() && D().proof && D().proof.gamutWarning),
    run: () => toggleGamutWarning(),
  },
  {
    id: 'image.mode.bitmap', label: 'Bitmap…',
    enabled: hasDoc, checked: () => !!D() && D().colorMode === 'bitmap',
    run: async () => {
      const doc = D();
      if (doc.flatLayers().length > 1) {
        const ok = await img.confirmFlatten('Bitmap mode flattens the document to one black-and-white layer. Continue?');
        if (!ok) return;
      }
      await img.convertToBitmap(doc);
    },
  },
  { id: 'image.auto-tone', label: 'Auto Tone', accel: 'Shift+Ctrl+L', enabled: hasLayer, run: () => applyAdjustmentCommand('auto-tone') },
  { id: 'image.auto-contrast', label: 'Auto Contrast', accel: 'Alt+Shift+Ctrl+L', enabled: hasLayer, run: () => applyAdjustmentCommand('auto-contrast') },
  { id: 'image.auto-color', label: 'Auto Color', accel: 'Shift+Ctrl+B', enabled: hasLayer, run: () => applyAdjustmentCommand('auto-color') },
  { id: 'image.size', label: 'Image Size…', accel: 'Alt+Ctrl+I', enabled: hasDoc, run: () => showImageSizeDialog(D()) },
  { id: 'image.canvas-size', label: 'Canvas Size…', accel: 'Alt+Ctrl+C', enabled: hasDoc, run: () => showCanvasSizeDialog(D()) },
  { id: 'image.rotate.180', label: '180°', enabled: hasDoc, run: () => { D().transformImage('180'); D().commit('Rotate Canvas 180°'); } },
  { id: 'image.rotate.cw', label: '90° Clockwise', enabled: hasDoc, run: () => { D().transformImage('cw'); D().commit('Rotate Canvas 90° CW'); } },
  { id: 'image.rotate.ccw', label: '90° Counter Clockwise', enabled: hasDoc, run: () => { D().transformImage('ccw'); D().commit('Rotate Canvas 90° CCW'); } },
  { id: 'image.rotate.arbitrary', label: 'Arbitrary…', enabled: hasDoc, run: () => img.showArbitraryRotationDialog(D()) },
  { id: 'image.rotate.flip-h', label: 'Flip Canvas Horizontal', enabled: hasDoc, run: () => { D().transformImage('flip-h'); D().commit('Flip Canvas Horizontal'); } },
  { id: 'image.rotate.flip-v', label: 'Flip Canvas Vertical', enabled: hasDoc, run: () => { D().transformImage('flip-v'); D().commit('Flip Canvas Vertical'); } },
  {
    id: 'image.crop', label: 'Crop',
    enabled: hasSelection,
    run: () => {
      const doc = D();
      const b = doc.selection.bounds();
      if (!b) { app.toast('The selection is empty.'); return; }
      doc.crop(b);
      doc.commit('Crop');
    },
  },
  { id: 'image.trim', label: 'Trim…', enabled: hasDoc, run: () => img.showTrimDialog(D(), ops.trimDocument) },
  {
    id: 'image.reveal-all', label: 'Reveal All',
    enabled: hasDoc,
    run: () => {
      // Layer buffers are always document-sized, so nothing can hide outside
      // the canvas — this is a report rather than an edit.
      app.toast('Nothing is hidden outside the canvas: Pikado clips layers to the document.');
    },
  },
  { id: 'image.duplicate', label: 'Duplicate…', enabled: hasDoc, run: async () => {
    const doc = D();
    const name = await promptDialog('Duplicate as', `${doc.name} copy`, 'Duplicate Image');
    if (name == null) return;
    img.duplicateDocument(doc, name.trim() || `${doc.name} copy`);
  } },
  { id: 'image.apply-image', label: 'Apply Image…', enabled: hasPixels, run: () => img.showApplyImageDialog(D()) },
  { id: 'image.calculations', label: 'Calculations…', enabled: hasDoc, run: () => img.showCalculationsDialog(D()) },

  /* --- Adjustment accelerators (menu comes from the registry) ------ */
  { id: 'adjust.levels', label: 'Levels…', accel: 'Ctrl+L', enabled: hasLayer, run: () => applyAdjustmentCommand('levels') },
  { id: 'adjust.curves', label: 'Curves…', accel: 'Ctrl+M', enabled: hasLayer, run: () => applyAdjustmentCommand('curves') },
  { id: 'adjust.hue-saturation', label: 'Hue/Saturation…', accel: 'Ctrl+U', enabled: hasLayer, run: () => applyAdjustmentCommand('hue-saturation') },
  { id: 'adjust.color-balance', label: 'Color Balance…', accel: 'Ctrl+B', enabled: hasLayer, run: () => applyAdjustmentCommand('color-balance') },
  { id: 'adjust.invert', label: 'Invert', accel: 'Ctrl+I', enabled: hasLayer, run: () => applyAdjustmentCommand('invert') },
  { id: 'adjust.desaturate', label: 'Desaturate', accel: 'Shift+Ctrl+U', enabled: hasLayer, run: () => applyAdjustmentCommand('desaturate') },

  /* --- Layer ------------------------------------------------------ */
  { id: 'layer.new', label: 'Layer', accel: 'Shift+Ctrl+N', enabled: hasDoc, run: () => ops.addRasterLayer(D()) },
  {
    id: 'layer.from-background', label: 'Layer from Background',
    enabled: () => { const l = activeLayer(); return !!(l && l.isBackground); },
    run: () => ops.convertBackgroundToLayer(D()),
  },
  {
    id: 'layer.to-background', label: 'Background from Layer',
    enabled: () => { const l = activeLayer(); return !!(l && !l.isBackground && l.type === LayerType.RASTER); },
    run: () => ops.convertLayerToBackground(D()),
  },
  {
    // Photoshop puts this on Ctrl+J, but Pikado bound that to Duplicate Layer
    // long before this command existed and `buildBindingMap` is first-wins — so
    // claiming the accel here would print a shortcut in the menu that actually
    // runs Duplicate Layer. Left unbound rather than advertised falsely.
    id: 'layer.via-copy', label: 'Layer Via Copy',
    enabled: () => canLayerVia(false),
    run: () => layerViaSelection(D(), false),
  },
  {
    id: 'layer.via-cut', label: 'Layer Via Cut', accel: 'Ctrl+Shift+J',
    enabled: () => canLayerVia(true),
    run: () => layerViaSelection(D(), true),
  },
  {
    id: 'layer.new-group', label: 'Group',
    enabled: hasDoc,
    run: () => {
      const d = D();
      const names = new Set(d.flatLayers().map((l) => l.name));
      let n = 1;
      while (names.has(`Group ${n}`)) n++;
      d.addLayer(createGroupLayer(`Group ${n}`));
      d.commit('New Group');
    },
  },
  { id: 'layer.group-from-layers', label: 'Group from Layers', accel: 'Ctrl+G', enabled: hasLayer, run: () => ops.groupLayers(D()) },
  {
    id: 'layer.ungroup', label: 'Ungroup Layers', accel: 'Shift+Ctrl+G',
    enabled: () => !!layerOfType(LayerType.GROUP),
    run: () => ops.ungroupLayers(D()),
  },
  { id: 'layer.duplicate', label: 'Duplicate Layer', accel: 'Ctrl+J', enabled: hasLayer, run: () => ops.duplicateLayers(D()) },
  { id: 'layer.delete', label: 'Layer', enabled: hasLayer, run: () => ops.deleteLayers(D()) },
  {
    id: 'layer.delete-hidden', label: 'Hidden Layers',
    enabled: () => !!D() && D().flatLayers().some((l) => !l.visible),
    run: () => {
      const d = D();
      const hidden = d.flatLayers().filter((l) => !l.visible);
      const set = new Set(hidden);
      // Only delete the outermost hidden layers; their children go with them.
      const roots = hidden.filter((l) => {
        for (let p = l.parent; p; p = p.parent) if (set.has(p)) return false;
        return true;
      });
      ops.deleteLayers(d, roots);
    },
  },

  {
    id: 'layer.style.options', label: 'Blending Options…',
    enabled: hasLayer,
    run: async () => { const m = await stylesModule(); await m.showLayerStyleDialog(D(), activeLayer()); },
  },
  ...EFFECTS.map((fx) => ({
    id: `layer.style.${fx.id}`,
    label: fx.label,
    enabled: hasLayer,
    run: async () => { const m = await stylesModule(); await m.showLayerStyleDialog(D(), activeLayer(), fx.id); },
  })),
  {
    id: 'layer.style.copy', label: 'Copy Layer Style',
    enabled: () => { const l = activeLayer(); return !!(l && l.styles); },
    run: async () => { const m = await stylesModule(); m.copyLayerStyle(activeLayer()); },
  },
  {
    id: 'layer.style.paste', label: 'Paste Layer Style',
    enabled: () => hasLayer() && !!(stylesMod && stylesMod.hasCopiedLayerStyle()),
    run: async () => { const m = await stylesModule(); m.pasteLayerStyle(D(), activeLayer()); },
  },
  {
    id: 'layer.style.clear', label: 'Clear Layer Style',
    enabled: () => { const l = activeLayer(); return !!(l && l.styles); },
    run: async () => { const m = await stylesModule(); m.clearLayerStyles(D(), activeLayer()); },
  },

  { id: 'layer.fill.solid', label: 'Solid Color…', enabled: hasDoc, run: () => newFillLayer(D(), 'solid') },
  { id: 'layer.fill.gradient', label: 'Gradient…', enabled: hasDoc, run: () => newFillLayer(D(), 'gradient') },
  { id: 'layer.fill.pattern', label: 'Pattern…', enabled: hasDoc, run: () => newFillLayer(D(), 'pattern') },

  {
    id: 'layer.mask.reveal-all', label: 'Reveal All',
    enabled: () => { const l = activeLayer(); return !!(l && !l.mask); },
    run: () => ops.addLayerMask(D(), null, 'reveal-all'),
  },
  {
    id: 'layer.mask.hide-all', label: 'Hide All',
    enabled: () => { const l = activeLayer(); return !!(l && !l.mask); },
    run: () => ops.addLayerMask(D(), null, 'hide-all'),
  },
  {
    id: 'layer.mask.reveal-selection', label: 'Reveal Selection',
    enabled: () => { const l = activeLayer(); return !!(l && !l.mask) && hasSelection(); },
    run: () => ops.addLayerMask(D(), null, 'reveal-selection'),
  },
  {
    id: 'layer.mask.hide-selection', label: 'Hide Selection',
    enabled: () => { const l = activeLayer(); return !!(l && !l.mask) && hasSelection(); },
    run: () => ops.addLayerMask(D(), null, 'hide-selection'),
  },
  {
    id: 'layer.mask.delete', label: 'Delete',
    enabled: () => { const l = activeLayer(); return !!(l && l.mask); },
    run: () => ops.deleteLayerMask(D()),
  },
  {
    id: 'layer.mask.apply', label: 'Apply',
    enabled: () => { const l = activeLayer(); return !!(l && l.mask && l.canvas); },
    run: () => ops.applyLayerMask(D()),
  },
  {
    id: 'layer.mask.toggle', label: 'Disable',
    dynamicLabel: () => { const l = activeLayer(); return l && l.mask && !l.maskEnabled ? 'Enable' : 'Disable'; },
    enabled: () => { const l = activeLayer(); return !!(l && l.mask); },
    run: () => ops.toggleMaskEnabled(D()),
  },

  {
    id: 'layer.clipping', label: 'Create Clipping Mask', accel: 'Alt+Ctrl+G',
    dynamicLabel: () => { const l = activeLayer(); return l && l.clipped ? 'Release Clipping Mask' : 'Create Clipping Mask'; },
    enabled: hasLayer,
    run: () => ops.toggleClipping(D()),
  },
  { id: 'layer.smart.convert', label: 'Convert to Smart Object', enabled: hasLayer, run: () => ops.convertToSmartObject(D()) },
  {
    id: 'layer.smart.edit', label: 'Edit Contents',
    enabled: isSmart,
    run: () => smart.editSmartContents(D(), activeLayer()),
  },
  {
    id: 'layer.smart.transform', label: 'Transform…',
    enabled: isSmart,
    run: async () => {
      const mod = await import('../ui/dialogs/smart-object.js');
      await mod.showSmartTransformDialog(D(), activeLayer());
    },
  },
  {
    id: 'layer.smart.replace', label: 'Replace Contents…',
    enabled: isSmart,
    run: async () => {
      const mod = await import('../ui/dialogs/smart-object.js');
      await mod.showReplaceContentsDialog(D(), activeLayer());
    },
  },
  {
    id: 'layer.smart.export', label: 'Export Contents…',
    enabled: isSmart,
    run: () => smart.exportSmartContents(D(), activeLayer()),
  },
  {
    /*
     * Photoshop's Cmd+J on a Smart Object makes a *linked* copy, and so does
     * ours — this is the one that deliberately does not, for when you want the
     * two to go their own way.
     */
    id: 'layer.smart.copy-unlinked', label: 'New Smart Object via Copy',
    enabled: () => { const l = activeLayer(); return !!(l && l.smart); },
    run: () => {
      const doc = D();
      const layer = activeLayer();
      if (!doc || !layer) return;
      const copy = doc.duplicateLayer(layer, { link: false });
      copy.name = `${layer.name} copy`;
      doc.commit('New Smart Object via Copy');
    },
  },
  {
    id: 'layer.smart.unlink', label: 'Unlink Contents',
    enabled: () => {
      const l = activeLayer();
      return !!(l && l.smart && l.smart.linkId);
    },
    run: async () => {
      const { unlinkSmartObject } = await import('../core/smart.js');
      unlinkSmartObject(D(), activeLayer());
    },
  },
  {
    id: 'layer.smart.rasterize', label: 'Rasterize Smart Object',
    enabled: () => !!layerOfType(LayerType.SMART),
    run: () => ops.rasterizeLayer(D(), activeLayer()),
  },
  { id: 'layer.rasterize.type', label: 'Type', enabled: () => !!layerOfType(LayerType.TEXT), run: () => ops.rasterizeLayer(D()) },
  { id: 'layer.rasterize.shape', label: 'Shape', enabled: () => !!layerOfType(LayerType.SHAPE), run: () => ops.rasterizeLayer(D()) },
  {
    id: 'layer.rasterize.style', label: 'Layer Style',
    enabled: () => { const l = activeLayer(); return !!(l && l.styles); },
    run: () => ops.rasterizeLayerStyle(D()),
  },
  {
    id: 'layer.rasterize.layer', label: 'Layer',
    enabled: () => { const l = activeLayer(); return !!l && l.type !== LayerType.RASTER; },
    run: () => ops.rasterizeLayer(D()),
  },
  { id: 'layer.rasterize.all', label: 'All Layers', enabled: hasDoc, run: () => rasterizeAll(D()) },

  { id: 'layer.arrange.front', label: 'Bring to Front', accel: 'Shift+Ctrl+]', enabled: hasLayer, run: () => { const d = D(); d.arrange(d.activeLayer(), 'front'); d.commit('Bring to Front'); } },
  { id: 'layer.arrange.forward', label: 'Bring Forward', accel: 'Ctrl+]', enabled: hasLayer, run: () => { const d = D(); d.arrange(d.activeLayer(), 'forward'); d.commit('Bring Forward'); } },
  { id: 'layer.arrange.backward', label: 'Send Backward', accel: 'Ctrl+[', enabled: hasLayer, run: () => { const d = D(); d.arrange(d.activeLayer(), 'backward'); d.commit('Send Backward'); } },
  { id: 'layer.arrange.back', label: 'Send to Back', accel: 'Shift+Ctrl+[', enabled: hasLayer, run: () => { const d = D(); d.arrange(d.activeLayer(), 'back'); d.commit('Send to Back'); } },

  { id: 'layer.align.left', label: 'Left Edges', enabled: hasLayer, run: () => img.alignLayers(D(), 'left') },
  { id: 'layer.align.center-h', label: 'Horizontal Centers', enabled: hasLayer, run: () => img.alignLayers(D(), 'center-h') },
  { id: 'layer.align.right', label: 'Right Edges', enabled: hasLayer, run: () => img.alignLayers(D(), 'right') },
  { id: 'layer.align.top', label: 'Top Edges', enabled: hasLayer, run: () => img.alignLayers(D(), 'top') },
  { id: 'layer.align.center-v', label: 'Vertical Centers', enabled: hasLayer, run: () => img.alignLayers(D(), 'center-v') },
  { id: 'layer.align.bottom', label: 'Bottom Edges', enabled: hasLayer, run: () => img.alignLayers(D(), 'bottom') },
  {
    id: 'layer.distribute.horizontal', label: 'Horizontally',
    enabled: () => !!D() && D().selectedLayers().length >= 3,
    run: () => img.distributeLayers(D(), 'horizontal'),
  },
  {
    id: 'layer.distribute.vertical', label: 'Vertically',
    enabled: () => !!D() && D().selectedLayers().length >= 3,
    run: () => img.distributeLayers(D(), 'vertical'),
  },

  {
    id: 'layer.merge-down', label: 'Merge Down', accel: 'Ctrl+E',
    dynamicLabel: () => (D() && D().selectedLayers().length > 1 ? 'Merge Layers' : 'Merge Down'),
    enabled: hasLayer,
    run: () => { const d = D(); if (d.selectedLayers().length > 1) ops.mergeSelected(d); else ops.mergeDown(d); },
  },
  { id: 'layer.merge-visible', label: 'Merge Visible', accel: 'Shift+Ctrl+E', enabled: hasDoc, run: () => ops.mergeVisible(D()) },
  { id: 'layer.stamp-visible', label: 'Stamp Visible', accel: 'Alt+Shift+Ctrl+E', enabled: hasDoc, run: () => ops.stampVisible(D()) },
  { id: 'layer.flatten', label: 'Flatten Image', enabled: hasDoc, run: () => ops.flattenImage(D()) },

  { id: 'layer.matting.defringe', label: 'Defringe…', enabled: hasPixels, run: async () => {
    const r = await paramDialog({
      title: 'Defringe', width: 300, preview: false, state: { width: 1 },
      params: [{ key: 'width', label: 'Width', type: 'slider', min: 1, max: 10, step: 1, unit: 'px' }],
    });
    if (!r) return;
    await app.busy('Defringe', async () => img.defringe(D(), null, r.width));
  } },
  { id: 'layer.matting.black', label: 'Remove Black Matte', enabled: hasPixels, run: () => img.removeMatte(D(), null, 'black') },
  { id: 'layer.matting.white', label: 'Remove White Matte', enabled: hasPixels, run: () => img.removeMatte(D(), null, 'white') },

  /* --- Type ------------------------------------------------------- */
  ...['none', 'sharp', 'crisp', 'strong', 'smooth'].map((mode) => ({
    id: `type.antialias.${mode}`,
    label: mode === 'none' ? 'None' : mode[0].toUpperCase() + mode.slice(1),
    enabled: () => !!textLayer(),
    checked: () => { const l = textLayer(); return !!(l && l.text) && (l.text.antialias || 'smooth') === mode; },
    run: () => setTextProp(D(), { antialias: mode }, 'Anti-Alias'),
  })),
  {
    id: 'type.orientation.horizontal', label: 'Horizontal',
    enabled: () => !!textLayer(),
    checked: () => { const l = textLayer(); return !!(l && l.text) && !l.text.vertical; },
    run: () => setTextProp(D(), { vertical: false }, 'Horizontal Type'),
  },
  {
    id: 'type.orientation.vertical', label: 'Vertical',
    enabled: () => !!textLayer(),
    checked: () => { const l = textLayer(); return !!(l && l.text) && !!l.text.vertical; },
    run: () => setTextProp(D(), { vertical: true }, 'Vertical Type'),
  },
  {
    id: 'type.convert-to-shape', label: 'Convert to Shape',
    enabled: () => !!textLayer(),
    run: () => app.busy('Convert to Shape', async () => convertTypeToShape(D())),
  },
  { id: 'type.rasterize', label: 'Rasterize Type Layer', enabled: () => !!textLayer(), run: () => ops.rasterizeLayer(D()) },
  { id: 'type.warp', label: 'Warp Text…', enabled: () => !!textLayer(), run: () => warpTextDialog(D()) },
  {
    id: 'type.panel.character', label: 'Character',
    checked: () => isPanelVisible('character'),
    run: () => togglePanel('character'),
  },

  /* --- Select ----------------------------------------------------- */
  { id: 'select.all', label: 'All', accel: 'Ctrl+A', enabled: hasDoc, run: () => { const d = D(); d.selection.selectAll(); commitSelection(d, 'Select All'); } },
  { id: 'select.deselect', label: 'Deselect', accel: 'Ctrl+D', enabled: hasSelection, run: () => deselect(D()) },
  { id: 'select.reselect', label: 'Reselect', accel: 'Shift+Ctrl+D', enabled: () => !!(D() && lastMasks.has(D())), run: () => reselect(D()) },
  { id: 'select.inverse', label: 'Inverse', accel: 'Shift+Ctrl+I', enabled: hasSelection, run: () => { const d = D(); d.selection.invert(); commitSelection(d, 'Inverse'); } },
  { id: 'select.all-layers', label: 'All Layers', accel: 'Alt+Ctrl+A', enabled: hasDoc, run: () => selectAllLayers(D()) },
  { id: 'select.deselect-layers', label: 'Deselect Layers', enabled: () => !!(D() && D().selectedLayerIds.length), run: () => deselectLayers(D()) },
  { id: 'select.color-range', label: 'Color Range…', enabled: hasDoc, run: () => img.showColorRangeDialog(D()) },
  {
    id: 'select.subject', label: 'Subject',
    // A saliency guess plus a graph cut, not a trained model — see
    // `src/select/grabcut.js`. It opens the workspace rather than committing a
    // guess silently, because the guess is a starting point.
    enabled: hasDoc,
    run: () => openSelectAndMask(D(), { subject: true }),
  },
  {
    id: 'select.select-and-mask', label: 'Select and Mask…', accel: 'Alt+Ctrl+R',
    enabled: hasDoc,
    run: () => openSelectAndMask(D()),
  },
  { id: 'select.modify.border', label: 'Border…', enabled: hasSelection, run: () => modifySelection(D(), 'border') },
  { id: 'select.modify.smooth', label: 'Smooth…', enabled: hasSelection, run: () => modifySelection(D(), 'smooth') },
  { id: 'select.modify.expand', label: 'Expand…', enabled: hasSelection, run: () => modifySelection(D(), 'expand') },
  { id: 'select.modify.contract', label: 'Contract…', enabled: hasSelection, run: () => modifySelection(D(), 'contract') },
  { id: 'select.modify.feather', label: 'Feather…', accel: 'Shift+F6', enabled: hasSelection, run: () => modifySelection(D(), 'feather') },
  { id: 'select.grow', label: 'Grow', enabled: hasSelection, run: () => growSelection(D()) },
  { id: 'select.similar', label: 'Similar', enabled: hasSelection, run: () => similarSelection(D()) },
  { id: 'select.transform', label: 'Transform Selection', enabled: hasSelection, run: () => tf.transformSelectionStart(D()) },
  {
    id: 'select.quick-mask', label: 'Edit in Quick Mask Mode', accel: 'Q',
    enabled: hasDoc,
    checked: () => !!(D() && D().quickMask),
    run: () => toggleQuickMaskMode(D()),
  },
  { id: 'select.load', label: 'Load Selection…', enabled: hasDoc, run: () => loadSelection(D()) },
  { id: 'select.save', label: 'Save Selection…', enabled: hasSelection, run: () => saveSelection(D()) },
  {
    id: 'select.make-work-path', label: 'Make Work Path',
    enabled: hasSelection,
    run: () => app.busy('Make Work Path', async () => makeWorkPath(D())),
  },

  /* --- Filter ----------------------------------------------------- */
  {
    id: 'filter.last', label: 'Last Filter', accel: 'Ctrl+F',
    dynamicLabel: () => (app.lastFilter ? app.lastFilter.label : 'Last Filter'),
    enabled: () => hasLayer() && !!app.lastFilter,
    run: () => repeatLastFilter(),
  },
  {
    // Camera Raw is a registered filter, so it also appears under Filter > Other
    // and works as a smart filter. This is the top-level entry Photoshop gives
    // it, with the same shortcut.
    id: 'filter.camera-raw', label: 'Camera Raw Filter…', accel: 'Shift+Ctrl+A',
    enabled: hasLayer,
    run: () => applyFilterCommand('camera-raw'),
  },
  {
    id: 'filter.smart.convert', label: 'Convert for Smart Filters',
    enabled: () => hasLayer() && !isSmart(),
    run: () => {
      const l = ops.convertToSmartObject(D());
      if (l) app.toast('Filters applied to this layer are now re-editable smart filters.', 'ok');
    },
  },

  /* --- View ------------------------------------------------------- */
  { id: 'view.zoom-in', label: 'Zoom In', accel: 'Ctrl+=', enabled: hasDoc, run: () => zoomStep(1) },
  { id: 'view.zoom-out', label: 'Zoom Out', accel: 'Ctrl+-', enabled: hasDoc, run: () => zoomStep(-1) },
  { id: 'view.fit', label: 'Fit on Screen', accel: 'Ctrl+0', enabled: hasDoc, run: () => app.fitView() },
  {
    id: 'view.fill-screen', label: 'Fill Screen',
    enabled: hasDoc,
    // The viewport has no usable size until the canvas area has been laid out;
    // filling against it would set a garbage scale. Same guard as app.fitView().
    run: () => {
      const d = D();
      if (app.viewport.viewWidth <= 1 || app.viewport.viewHeight <= 1) return;
      app.viewport.fillScreen(d.width, d.height);
      app.emit('view-change');
      app.requestRender();
    },
  },
  { id: 'view.zoom-100', label: '100%', accel: 'Ctrl+1', enabled: hasDoc, run: () => zoomTo(1) },
  { id: 'view.zoom-200', label: '200%', enabled: hasDoc, run: () => zoomTo(2) },
  {
    id: 'view.print-size', label: 'Print Size',
    enabled: hasDoc,
    run: () => zoomTo(96 / (D().resolution || 72)),
  },
  ...[['standard', 'Standard Screen Mode'], ['full-menu', 'Full Screen With Menu Bar'], ['full', 'Full Screen Mode']].map(([mode, label]) => ({
    id: `view.screen.${mode}`,
    label,
    checked: () => getScreenMode() === mode,
    run: () => setScreenMode(mode),
  })),
  { id: 'view.extras', label: 'Extras', accel: 'Ctrl+H', enabled: hasDoc, checked: () => !extrasHidden, run: toggleExtras },
  { id: 'view.show.grid', label: 'Grid', accel: "Ctrl+'", checked: () => app.showGrid, run: () => toggleFlag('showGrid') },
  { id: 'view.show.guides', label: 'Guides', accel: 'Ctrl+;', checked: () => app.showGuides, run: () => toggleFlag('showGuides') },
  { id: 'view.rulers', label: 'Rulers', accel: 'Ctrl+R', checked: () => app.showRulers, run: () => toggleFlag('showRulers') },
  { id: 'view.snap', label: 'Snap', accel: 'Shift+Ctrl+;', checked: () => app.snap, run: () => toggleFlag('snap') },
  {
    id: 'view.clear-guides', label: 'Clear Guides',
    enabled: () => !!(D() && D().guides.length),
    run: () => { const d = D(); d.guides = []; d.commit('Clear Guides'); },
  },
  { id: 'view.new-guide', label: 'New Guide…', enabled: hasDoc, run: () => newGuide(D()) },
  { id: 'view.new-guide-layout', label: 'New Guide Layout…', enabled: hasDoc, run: () => newGuideLayout(D()) },

  /* --- Window ----------------------------------------------------- */
  { id: 'window.next-doc', label: 'Next Document', accel: 'Ctrl+PageDown', enabled: () => app.docs.length > 1, run: () => stepDocument(1) },
  { id: 'window.prev-doc', label: 'Previous Document', accel: 'Ctrl+PageUp', enabled: () => app.docs.length > 1, run: () => stepDocument(-1) },
  { id: 'window.workspace.essentials', label: 'Essentials', run: () => applyWorkspace('essentials') },
  { id: 'window.workspace.painting', label: 'Painting', run: () => applyWorkspace('painting') },
  { id: 'window.workspace.photography', label: 'Photography', run: () => applyWorkspace('photography') },
  { id: 'window.workspace.reset', label: 'Reset Workspace', run: resetWorkspace },

  {
    id: 'type.fonts',
    label: 'Manage Fonts…',
    run: async () => {
      const { showFontsDialog } = await import('../ui/dialogs/fonts.js');
      const id = await showFontsDialog({ initial: app.tool && app.tool.state ? app.tool.state.font : '' });
      if (!id) return;
      // Applied to the selected text layers when there are any, and otherwise
      // left as the Type tool's next-layer default — the same rule the options
      // bar already follows.
      const doc = D();
      const layers = doc ? doc.selectedLayers().filter((l) => l.text) : [];
      if (layers.length) {
        const { rasterizeTextLayer } = await import('../text/text-render.js');
        doc.beginEdit(layers);
        for (const l of layers) {
          l.text.font = id;
          delete l.text.fontFamily;
          const cv = await rasterizeTextLayer(l, doc);
          if (cv) l.canvas = cv;
        }
        doc.commit('Change Font');
      } else if (app.tool && app.tool.state && 'font' in app.tool.state) {
        app.tool.state.font = id;
        app.emit('tool-options', app.tool);
      }
    },
  },

  /* --- Help ------------------------------------------------------- */
  {
    /*
     * Above About rather than below it, because it is the one thing in this menu
     * somebody actually needs: Generative Fill spends real money and is the only
     * feature whose setup lives in a different dialog from the feature itself.
     */
    id: 'help.ai-guide',
    label: 'Using Generative Fill…',
    run: async () => {
      const { showAiGuideDialog } = await import('../ui/dialogs/ai-guide.js');
      // Opened here rather than by the guide calling runCommand: this command is
      // still running while the guide is up, and runCommand will not re-enter.
      if (await showAiGuideDialog() !== 'settings') return;
      await loadAiProviders();
      const { showAiKeyDialog } = await import('../ui/dialogs/ai-key.js');
      await showAiKeyDialog('openai');
    },
  },
  { id: 'help.about', label: 'About Pikado…', run: showAbout },
]);

/* Open Recent slots — labelled from localStorage at menu-open time. */
for (let i = 0; i < RECENT_MAX; i++) {
  registerCommand({
    id: `file.open-recent.${i}`,
    label: `Recent ${i + 1}`,
    dynamicLabel: () => {
      const e = recentList()[i];
      return e ? e.name : `Recent ${i + 1}`;
    },
    enabled: () => !!recentList()[i],
    run: () => openRecent(recentList()[i]),
  });
}

applyStoredShortcuts();

/* ------------------------------------------------------------------ */
/* Menu tree                                                           */
/* ------------------------------------------------------------------ */

/**
 * The menu bar tree. Entries are command ids, `'---'`, `{label, items}` groups
 * or `{label?, dynamic}` registry-driven groups. `items` getters are read each
 * time a menu opens, which is how the recent-file and panel lists stay live.
 * @type {Array<{label:string, items:any[]}>}
 */
export const MENU_TREE = [
  {
    label: 'File',
    items: [
      'file.new',
      'file.open',
      {
        label: 'Open Recent',
        get items() {
          const list = recentList();
          if (!list.length) return ['file.recent-clear'];
          return [...list.map((_, i) => `file.open-recent.${i}`), '---', 'file.recent-clear'];
        },
      },
      '---',
      'file.close',
      'file.close-all',
      '---',
      'file.save',
      'file.save-as',
      '---',
      'file.export-as',
      'file.export-png',
      '---',
      'file.revert',
      'file.print',
      'file.info',
    ],
  },
  {
    label: 'Edit',
    items: [
      'edit.undo',
      'edit.redo',
      'edit.step-forward',
      'edit.step-backward',
      'edit.fade',
      '---',
      'edit.cut',
      'edit.copy',
      'edit.copy-merged',
      'edit.paste',
      'edit.paste-into',
      'edit.paste-outside',
      'edit.clear',
      '---',
      'edit.fill',
      'edit.stroke',
      'edit.content-aware-fill',
      'edit.generative-fill',
      '---',
      'edit.free-transform',
      {
        label: 'Transform',
        items: [
          'edit.transform.again',
          '---',
          'edit.transform.scale',
          'edit.transform.rotate',
          'edit.transform.skew',
          'edit.transform.distort',
          'edit.transform.perspective',
          'edit.transform.warp',
          '---',
          'edit.transform.rot180',
          'edit.transform.rot90cw',
          'edit.transform.rot90ccw',
          '---',
          'edit.transform.flip-h',
          'edit.transform.flip-v',
        ],
      },
      '---',
      'edit.define-pattern',
      {
        label: 'Purge',
        items: ['edit.purge.undo', 'edit.purge.clipboard', 'edit.purge.histories', '---', 'edit.purge.all'],
      },
      '---',
      'edit.keyboard-shortcuts',
      'edit.ai-settings',
      'edit.preferences',
    ],
  },
  {
    label: 'Image',
    items: [
      { label: 'Mode', items: ['image.mode.rgb', 'image.mode.grayscale', 'image.mode.bitmap'] },
      '---',
      'edit.assign-profile',
      'edit.convert-profile',
      '---',
      { label: 'Adjustments', dynamic: 'adjustments' },
      '---',
      'image.auto-tone',
      'image.auto-contrast',
      'image.auto-color',
      '---',
      'image.size',
      'image.canvas-size',
      {
        label: 'Image Rotation',
        items: [
          'image.rotate.180', 'image.rotate.cw', 'image.rotate.ccw', 'image.rotate.arbitrary',
          '---', 'image.rotate.flip-h', 'image.rotate.flip-v',
        ],
      },
      'image.crop',
      'image.trim',
      'image.reveal-all',
      '---',
      'image.duplicate',
      'image.apply-image',
      'image.calculations',
    ],
  },
  {
    label: 'Layer',
    items: [
      {
        label: 'New',
        items: [
          'layer.new', 'layer.from-background', 'layer.to-background',
          '---', 'layer.via-copy', 'layer.via-cut',
          '---', 'layer.new-group', 'layer.group-from-layers',
        ],
      },
      'layer.duplicate',
      'layer.ungroup',
      { label: 'Delete', items: ['layer.delete', 'layer.delete-hidden'] },
      '---',
      {
        label: 'Layer Style',
        items: [
          'layer.style.options',
          '---',
          ...EFFECTS.map((fx) => `layer.style.${fx.id}`),
          '---',
          'layer.style.copy',
          'layer.style.paste',
          'layer.style.clear',
        ],
      },
      { label: 'New Fill Layer', items: ['layer.fill.solid', 'layer.fill.gradient', 'layer.fill.pattern'] },
      { label: 'New Adjustment Layer', dynamic: 'adjustment-layers' },
      '---',
      {
        label: 'Layer Mask',
        items: [
          'layer.mask.reveal-all', 'layer.mask.hide-all',
          'layer.mask.reveal-selection', 'layer.mask.hide-selection',
          '---', 'layer.mask.delete', 'layer.mask.apply', 'layer.mask.toggle',
        ],
      },
      'layer.clipping',
      {
        label: 'Smart Objects',
        items: [
          'layer.smart.convert', '---',
          'layer.smart.edit', 'layer.smart.transform', 'layer.smart.replace', 'layer.smart.export',
          '---',
          'layer.smart.copy-unlinked', 'layer.smart.unlink',
          '---', 'layer.smart.rasterize',
        ],
      },
      {
        label: 'Rasterize',
        items: ['layer.rasterize.type', 'layer.rasterize.shape', 'layer.rasterize.style', 'layer.rasterize.layer', '---', 'layer.rasterize.all'],
      },
      '---',
      {
        label: 'Arrange',
        items: ['layer.arrange.front', 'layer.arrange.forward', 'layer.arrange.backward', 'layer.arrange.back'],
      },
      {
        label: 'Align',
        items: [
          'layer.align.left', 'layer.align.center-h', 'layer.align.right',
          '---', 'layer.align.top', 'layer.align.center-v', 'layer.align.bottom',
        ],
      },
      { label: 'Distribute', items: ['layer.distribute.horizontal', 'layer.distribute.vertical'] },
      '---',
      'layer.merge-down',
      'layer.merge-visible',
      'layer.stamp-visible',
      'layer.flatten',
      '---',
      { label: 'Matting', items: ['layer.matting.defringe', 'layer.matting.black', 'layer.matting.white'] },
    ],
  },
  {
    label: 'Type',
    items: [
      'type.fonts',
      '---',
      {
        label: 'Anti-Alias',
        items: ['type.antialias.none', 'type.antialias.sharp', 'type.antialias.crisp', 'type.antialias.strong', 'type.antialias.smooth'],
      },
      { label: 'Orientation', items: ['type.orientation.horizontal', 'type.orientation.vertical'] },
      '---',
      'type.convert-to-shape',
      'type.rasterize',
      'type.warp',
      '---',
      { label: 'Panels', items: ['type.panel.character'] },
    ],
  },
  {
    label: 'Select',
    items: [
      'select.all',
      'select.deselect',
      'select.reselect',
      'select.inverse',
      '---',
      'select.all-layers',
      'select.deselect-layers',
      '---',
      'select.subject',
      'select.select-and-mask',
      'select.color-range',
      {
        label: 'Modify',
        items: ['select.modify.border', 'select.modify.smooth', 'select.modify.expand', 'select.modify.contract', 'select.modify.feather'],
      },
      '---',
      'select.grow',
      'select.similar',
      '---',
      'select.transform',
      'select.quick-mask',
      '---',
      'select.load',
      'select.save',
      'select.make-work-path',
    ],
  },
  {
    label: 'Filter',
    items: ['filter.last', '---', 'filter.camera-raw', '---', 'filter.smart.convert', '---', { dynamic: 'filters' }],
  },
  {
    label: 'View',
    items: [
      'view.zoom-in',
      'view.zoom-out',
      'view.fit',
      'view.fill-screen',
      'view.zoom-100',
      'view.zoom-200',
      'view.print-size',
      '---',
      { label: 'Screen Mode', items: ['view.screen.standard', 'view.screen.full-menu', 'view.screen.full'] },
      '---',
      'view.proof-setup',
      'view.proof-colors',
      'view.gamut-warning',
      '---',
      'view.extras',
      { label: 'Show', items: ['view.show.grid', 'view.show.guides'] },
      '---',
      'view.rulers',
      'view.snap',
      '---',
      'view.new-guide',
      'view.new-guide-layout',
      'view.clear-guides',
    ],
  },
  {
    label: 'Window',
    get items() {
      return [
        { label: 'Arrange', items: ['window.next-doc', 'window.prev-doc'] },
        {
          label: 'Workspace',
          items: ['window.workspace.essentials', 'window.workspace.painting', 'window.workspace.photography', '---', 'window.workspace.reset'],
        },
        '---',
        ...ensurePanelCommands(),
        '---',
        { dynamic: 'documents' },
      ];
    },
  },
  {
    label: 'Help',
    items: ['help.ai-guide', '---', 'help.about', '---', 'edit.keyboard-shortcuts'],
  },
];

export default MENU_TREE;
