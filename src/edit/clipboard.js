import { app } from '../core/app.js';
import { createCanvas, loadImage, clamp } from '../core/util.js';
import { compositeDocument, flattenLayers } from '../render/compositor.js';
import { Layer, LayerType } from '../core/layer.js';
import { nextLayerName } from '../layers/ops.js';
import { toCss } from '../core/color.js';

/**
 * Edit > Cut / Copy / Copy Merged / Paste / Paste Into / Paste Outside / Clear.
 *
 * The internal clipboard lives on `app.clipboard` as
 * `{canvas, bounds:{x,y,width,height}, docId}` so a paste back into the source
 * document lands exactly where it was copied from. Every copy also tries to
 * mirror the pixels onto the *system* clipboard as a PNG so other apps can use
 * them, and a window-level `paste` listener accepts images coming the other way.
 */

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** The pixels a copy should read from the given layer. */
function sourceCanvas(doc, layer) {
  if (!layer) return null;
  if (layer.editingMask && layer.mask) return layer.mask;
  if (layer.type === LayerType.GROUP) return flattenLayers(doc, [layer]);
  return layer.canvas;
}

function selectionBounds(doc) {
  if (!doc.selection.active) return { x: 0, y: 0, width: doc.width, height: doc.height };
  const b = doc.selection.bounds();
  if (!b) return null;
  return b;
}

/** Cut `bounds` out of `src`, masked by the active selection. */
function extractRegion(doc, src, bounds) {
  const out = createCanvas(bounds.width, bounds.height);
  const c = out.getContext('2d');
  c.drawImage(src, -bounds.x, -bounds.y);
  if (doc.selection.active) {
    const alpha = doc.selection.toAlphaCanvas();
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(alpha, -bounds.x, -bounds.y);
    c.globalCompositeOperation = 'source-over';
  }
  return out;
}

/** Best-effort mirror of a canvas onto the OS clipboard as a PNG. */
function writeSystemClipboard(canvas) {
  if (!navigator.clipboard || typeof window.ClipboardItem !== 'function' || !canvas.toBlob) return;
  try {
    canvas.toBlob((blob) => {
      if (!blob) return;
      navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]).catch(() => {});
    }, 'image/png');
  } catch {
    /* Safari throws synchronously without a user gesture — ignore. */
  }
}

/** Centre of the part of the document currently on screen. */
function viewCenter(doc) {
  const vp = app.viewport;
  if (!vp || !vp.viewWidth || !vp.viewHeight) return { x: doc.width / 2, y: doc.height / 2 };
  const p = vp.toDoc(vp.viewWidth / 2, vp.viewHeight / 2);
  return {
    x: clamp(p.x, 0, doc.width),
    y: clamp(p.y, 0, doc.height),
  };
}

function storeClipboard(doc, canvas, bounds) {
  app.clipboard = {
    canvas,
    bounds: { ...bounds },
    docId: doc ? doc.id : null,
    width: canvas.width,
    height: canvas.height,
  };
  return app.clipboard;
}

/** Build a document-sized layer canvas holding `src` at (x, y). */
function placedCanvas(doc, src, x, y) {
  const cv = createCanvas(doc.width, doc.height);
  cv.getContext('2d').drawImage(src, Math.round(x), Math.round(y));
  return cv;
}

/* ------------------------------------------------------------------ */
/* Copy / Cut                                                          */
/* ------------------------------------------------------------------ */

/**
 * Copy the selected region of the active layer.
 * @returns {boolean} true when something was copied
 */
export function copy(doc) {
  if (!doc) return false;
  const layer = doc.activeLayer();
  const src = sourceCanvas(doc, layer);
  if (!src) {
    app.toast('This layer has no pixels to copy.');
    return false;
  }
  const bounds = selectionBounds(doc);
  if (!bounds) {
    app.toast('The selection is empty.');
    return false;
  }
  const canvas = extractRegion(doc, src, bounds);
  storeClipboard(doc, canvas, bounds);
  writeSystemClipboard(canvas);
  app.toast(`Copied ${bounds.width} × ${bounds.height} px`, 'ok', 1400);
  return true;
}

/** Copy the flattened composite through the selection. */
export function copyMerged(doc) {
  if (!doc) return false;
  const bounds = selectionBounds(doc);
  if (!bounds) {
    app.toast('The selection is empty.');
    return false;
  }
  const canvas = extractRegion(doc, compositeDocument(doc), bounds);
  storeClipboard(doc, canvas, bounds);
  writeSystemClipboard(canvas);
  app.toast(`Copied merged ${bounds.width} × ${bounds.height} px`, 'ok', 1400);
  return true;
}

export function cut(doc) {
  if (!copy(doc)) return false;
  return clear(doc, { label: 'Cut' });
}

/* ------------------------------------------------------------------ */
/* Clear                                                               */
/* ------------------------------------------------------------------ */

/**
 * Erase the selected region of the active layer. The Background layer and
 * transparency-locked layers are filled with the background colour instead,
 * matching Photoshop.
 */
export function clear(doc, { label = 'Clear' } = {}) {
  if (!doc) return false;
  const layer = doc.activeLayer();
  if (!layer) {
    app.toast('No layer selected.');
    return false;
  }
  if (layer.locked.all || layer.locked.pixels) {
    app.toast(`Layer "${layer.name}" is locked.`);
    return false;
  }
  const onMask = !!(layer.editingMask && layer.mask);
  if (!onMask && !layer.canvas) {
    app.toast('This layer has no pixels to clear.');
    return false;
  }

  doc.beginEdit(layer);
  const cv = onMask ? layer.mask : layer.canvas;
  const c = cv.getContext('2d');
  const sel = doc.selection.active ? doc.selection.toAlphaCanvas() : null;

  // Masks clear to black; the background and transparency-locked layers keep
  // their alpha and take the background colour instead.
  const fillWith = onMask ? '#000000'
    : layer.isBackground || layer.locked.transparency ? toCss(app.background)
      : null;

  if (fillWith) {
    const paint = createCanvas(cv.width, cv.height);
    const pc = paint.getContext('2d');
    pc.fillStyle = fillWith;
    pc.fillRect(0, 0, cv.width, cv.height);
    if (sel) {
      pc.globalCompositeOperation = 'destination-in';
      pc.drawImage(sel, 0, 0);
      pc.globalCompositeOperation = 'source-over';
    }
    if (!onMask && layer.locked.transparency && !layer.isBackground) {
      // Keep the layer's existing alpha silhouette.
      pc.globalCompositeOperation = 'destination-in';
      pc.drawImage(cv, 0, 0);
      pc.globalCompositeOperation = 'source-over';
    }
    c.drawImage(paint, 0, 0);
  } else if (sel) {
    c.globalCompositeOperation = 'destination-out';
    c.drawImage(sel, 0, 0);
    c.globalCompositeOperation = 'source-over';
  } else {
    c.clearRect(0, 0, cv.width, cv.height);
  }

  if (onMask) layer.touchMask();
  doc.commit(label);
  return true;
}

/* ------------------------------------------------------------------ */
/* Paste                                                               */
/* ------------------------------------------------------------------ */

/** Where a paste should land: the original spot for same-document pastes. */
function pastePosition(doc, clip) {
  if (clip.docId === doc.id && clip.bounds) {
    return { x: clip.bounds.x, y: clip.bounds.y };
  }
  const c = viewCenter(doc);
  return {
    x: Math.round(c.x - clip.canvas.width / 2),
    y: Math.round(c.y - clip.canvas.height / 2),
  };
}

function addPastedLayer(doc, clip, { name, mask = null, label = 'Paste' }) {
  const pos = pastePosition(doc, clip);
  const layer = new Layer({
    type: LayerType.RASTER,
    name: name || nextLayerName(doc),
    canvas: placedCanvas(doc, clip.canvas, pos.x, pos.y),
  });
  if (mask) {
    layer.mask = mask;
    layer.maskEnabled = true;
    layer.touchMask();
  }
  doc.addLayer(layer);
  doc.selection.clear();
  doc.emit('selection-change');
  doc.commit(label);
  return layer;
}

/** Paste the clipboard into a new layer. */
export async function paste(doc) {
  if (!doc) return null;
  let clip = app.clipboard;
  if (!clip) clip = await readSystemClipboard();
  if (!clip) {
    app.toast('The clipboard is empty.');
    return null;
  }
  return addPastedLayer(doc, clip, { label: 'Paste' });
}

/** Paste into the current selection — the selection becomes the layer mask. */
export async function pasteInto(doc, { outside = false } = {}) {
  if (!doc) return null;
  let clip = app.clipboard;
  if (!clip) clip = await readSystemClipboard();
  if (!clip) {
    app.toast('The clipboard is empty.');
    return null;
  }
  if (!doc.selection.active) {
    app.toast('Make a selection first.');
    return null;
  }
  const b = doc.selection.bounds();
  if (!b) {
    app.toast('The selection is empty.');
    return null;
  }

  // A "paste into" centres the artwork inside the selection rather than
  // restoring its original coordinates.
  const pos = {
    x: Math.round(b.x + (b.width - clip.canvas.width) / 2),
    y: Math.round(b.y + (b.height - clip.canvas.height) / 2),
  };

  const mask = createCanvas(doc.width, doc.height);
  const mc = mask.getContext('2d');
  if (outside) {
    mc.fillStyle = '#ffffff';
    mc.fillRect(0, 0, doc.width, doc.height);
    mc.globalCompositeOperation = 'difference';
    mc.drawImage(doc.selection.toCanvas(), 0, 0);
    mc.globalCompositeOperation = 'source-over';
  } else {
    mc.fillStyle = '#000000';
    mc.fillRect(0, 0, doc.width, doc.height);
    mc.drawImage(doc.selection.toCanvas(), 0, 0);
  }

  const layer = new Layer({
    type: LayerType.RASTER,
    name: nextLayerName(doc),
    canvas: placedCanvas(doc, clip.canvas, pos.x, pos.y),
  });
  layer.mask = mask;
  layer.maskEnabled = true;
  layer.maskLinked = true;
  layer.touchMask();
  doc.addLayer(layer);
  doc.selection.clear();
  doc.emit('selection-change');
  doc.commit(outside ? 'Paste Outside' : 'Paste Into');
  return layer;
}

export function pasteOutside(doc) {
  return pasteInto(doc, { outside: true });
}

/* ------------------------------------------------------------------ */
/* System clipboard input                                              */
/* ------------------------------------------------------------------ */

/** Try to pull an image off the OS clipboard (needs a user gesture). */
async function readSystemClipboard() {
  if (!navigator.clipboard || !navigator.clipboard.read) return null;
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      const img = await loadImage(blob);
      return adoptImage(img);
    }
  } catch {
    /* Permission denied or nothing readable. */
  }
  return null;
}

function adoptImage(img) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const cv = createCanvas(w, h);
  cv.getContext('2d').drawImage(img, 0, 0);
  return storeClipboard(null, cv, { x: 0, y: 0, width: w, height: h });
}

function isTextEntry(node) {
  if (!node) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || node.isContentEditable;
}

/**
 * Ctrl+V of an image copied from another application. The browser only hands
 * those pixels over through a real `paste` event, so we listen for one.
 */
window.addEventListener('paste', async (e) => {
  // io/open.js listens on `document` and handles image files there; bail out
  // when it already claimed the event so a paste never lands twice.
  if (e.defaultPrevented || isTextEntry(e.target)) return;
  const data = e.clipboardData;
  if (!data) return;
  const items = [...(data.items || [])];
  const imageItem = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
  if (!imageItem) return;
  const file = imageItem.getAsFile();
  if (!file) return;
  e.preventDefault();
  try {
    const img = await loadImage(file);
    const clip = adoptImage(img);
    if (app.activeDoc) addPastedLayer(app.activeDoc, clip, { label: 'Paste' });
    else app.addDocument((await import('../core/document.js')).PikaDocument.fromImage(img, 'Pasted'));
  } catch (err) {
    app.toast('Could not read the pasted image.', 'error');
  }
});

/** Drop everything the internal clipboard holds (Edit > Purge > Clipboard). */
export function purgeClipboard() {
  app.clipboard = null;
}

/** True when there is something to paste. */
export function hasClipboard() {
  return !!app.clipboard;
}
