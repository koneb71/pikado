import './open.css';
import { app } from '../core/app.js';
import { PikaDocument } from '../core/document.js';
import { createRasterLayer } from '../core/layer.js';
import { createCanvas, ctx2d, el, loadImage, readFileAsArrayBuffer, readFileAsText } from '../core/util.js';
import { getComposite } from '../render/compositor.js';
import { readPSD } from './psd-read.js';
import { importSVG } from './svg.js';
import { loadPKD } from './pkd.js';

/**
 * Ask before opening a PSD that would not fit.
 *
 * The number is worth showing because it is nowhere near the file size and the
 * user has no way to guess it: Pikado holds every layer buffer at document size,
 * so a 0.76 MB file with 70 layers on a 2000x1500 canvas needs about 900 MB. The
 * dialog quotes the real figure rather than saying "large", because "large" gives
 * nobody anything to decide with.
 *
 * Flattening is genuinely cheap — every PSD carries a flattened composite for
 * compatibility, so it costs one document-sized canvas instead of N — and it is
 * offered first for that reason.
 *
 * @returns {Promise<'flatten'|'proceed'|'cancel'>}
 */
async function askAboutOversizePSD(info) {
  const mb = Math.round(info.projectedBytes / 1048576);
  const budgetMb = Math.round(info.budgetBytes / 1048576);
  const { Dialog } = await import('../ui/dialog.js');
  const dialog = new Dialog({ title: 'This PSD is bigger than it looks', width: 500 });
  dialog.setBody(
    el('div.pk-msg', {
      text: `It has ${info.layers} layers on a ${info.width} x ${info.height} canvas. `
        + `Pikado keeps every layer at full canvas size, so opening them all needs about `
        + `${mb} MB — well past the ${budgetMb} MB budget in Preferences. That is usually `
        + `enough to make the tab unresponsive or close it outright.`,
    }),
    el('div.pk-hint', {
      text: 'Opening it flattened uses the composite Photoshop already stored in the file. '
        + 'You get the picture, at one layer, immediately. Opening every layer may still '
        + 'work if you have the memory to spare — it is your call, not a refusal.',
    }),
  );
  dialog.setButtons([
    { label: 'Cancel', value: 'cancel', subtle: true },
    { label: 'Open all layers anyway', value: 'proceed' },
    { label: 'Open flattened', value: 'flatten', primary: true },
  ]);
  const choice = await dialog.open();
  return choice || 'cancel';
}

/**
 * Opening files: the file input, drag-and-drop and paste.
 *
 * Every entry point funnels through `openFile`, which dispatches on extension
 * and MIME type. Failures are reported per file so one bad image never stops
 * the rest of a multi-file drop.
 */

const MAX_GIF_FRAMES = 300;

/** Extensions we can open even when the clipboard reports no MIME type. */
const KNOWN_EXTENSIONS = new Set(['psd', 'psb', 'pkd', 'svg']);

function extensionOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

function stemOf(name) {
  return String(name || 'Untitled').replace(/\.[a-z0-9]{1,6}$/i, '') || 'Untitled';
}

/* ------------------------------------------------------------------ */
/* Decoding helpers                                                    */
/* ------------------------------------------------------------------ */

/** Decode any browser-supported image blob to a canvas. */
async function decodeToCanvas(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      const canvas = createCanvas(bitmap.width, bitmap.height);
      ctx2d(canvas).drawImage(bitmap, 0, 0);
      if (bitmap.close) bitmap.close();
      return canvas;
    } catch (err) {
      // Safari refuses some types here; the <img> path below still works.
    }
  }
  const img = await loadImage(blob);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) throw new Error('The image has no pixels');
  const canvas = createCanvas(w, h);
  ctx2d(canvas).drawImage(img, 0, 0);
  return canvas;
}

/**
 * Decode every frame of an animated GIF using the WebCodecs ImageDecoder.
 * Returns null when the browser lacks it or the file has a single frame.
 */
async function decodeGifFrames(blob) {
  if (typeof ImageDecoder === 'undefined') return null;
  let decoder = null;
  try {
    const data = await blob.arrayBuffer();
    decoder = new ImageDecoder({ data, type: 'image/gif' });
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    if (!track) return null;
    if (track.animated === false) return null;
    await decoder.completed;
    const count = Math.min(decoder.tracks.selectedTrack.frameCount || 1, MAX_GIF_FRAMES);
    if (count <= 1) return null;

    const frames = [];
    for (let i = 0; i < count; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      const w = image.displayWidth || image.codedWidth;
      const h = image.displayHeight || image.codedHeight;
      const canvas = createCanvas(w, h);
      ctx2d(canvas).drawImage(image, 0, 0);
      if (image.close) image.close();
      frames.push(canvas);
    }
    return frames;
  } catch (err) {
    console.warn('[open] GIF frame decoding unavailable', err);
    return null;
  } finally {
    if (decoder && decoder.close) {
      try { decoder.close(); } catch (err) { /* already closed */ }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Document / layer construction                                       */
/* ------------------------------------------------------------------ */

function documentFromCanvas(canvas, name) {
  const doc = new PikaDocument({ width: canvas.width, height: canvas.height, name });
  const layer = createRasterLayer(canvas.width, canvas.height, 'Background');
  ctx2d(layer.canvas).drawImage(canvas, 0, 0);
  layer.isBackground = true;
  layer.locked = { ...layer.locked, position: true };
  doc.layers = [layer];
  doc.activeLayerId = layer.id;
  doc.selectedLayerIds = [layer.id];
  doc.history.clear('Open');
  doc.dirty = false;
  return doc;
}

function documentFromFrames(frames, name) {
  const doc = new PikaDocument({ width: frames[0].width, height: frames[0].height, name });
  doc.layers = frames.map((frame, i) => {
    const layer = createRasterLayer(doc.width, doc.height, `Frame ${i + 1}`);
    ctx2d(layer.canvas).drawImage(frame, 0, 0);
    return layer;
  });
  doc.activeLayerId = doc.layers[0].id;
  doc.selectedLayerIds = [doc.layers[0].id];
  doc.history.clear('Open');
  doc.dirty = false;
  return doc;
}

/** Place a canvas into an open document as a new layer, scaled to fit. */
function placeAsLayer(doc, source, name) {
  const layer = createRasterLayer(doc.width, doc.height, name);
  const scale = Math.min(1, doc.width / source.width, doc.height / source.height);
  const w = Math.max(1, Math.round(source.width * scale));
  const h = Math.max(1, Math.round(source.height * scale));
  const c = ctx2d(layer.canvas);
  c.imageSmoothingQuality = 'high';
  c.drawImage(source, Math.round((doc.width - w) / 2), Math.round((doc.height - h) / 2), w, h);
  doc.addLayer(layer);
  doc.commit('Place');
  app.toast(`Placed “${name}” as a new layer`, 'ok');
  return layer;
}

function adopt(doc) {
  app.addDocument(doc);
  return doc;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Decode an image blob into a new document, or into the active document when
 * `opts.asLayer` is set.
 * @param {Blob} blob
 * @param {string} [name]
 * @param {{asLayer?:boolean, doc?:PikaDocument}} [opts]
 */
export async function openImageBlob(blob, name = 'Image', opts = {}) {
  const target = opts.asLayer ? (opts.doc || app.activeDoc) : null;
  const isGif = blob.type === 'image/gif' || extensionOf(name) === 'gif';

  if (!target && isGif) {
    const frames = await decodeGifFrames(blob);
    if (frames && frames.length > 1) {
      app.toast(`Imported ${frames.length} GIF frames as layers`, 'ok');
      return adopt(documentFromFrames(frames, name));
    }
  }

  const canvas = await decodeToCanvas(blob);
  if (target) return placeAsLayer(target, canvas, name);
  const doc = documentFromCanvas(canvas, name);
  await adoptProfileFrom(blob, doc);
  /*
   * Re-baseline history AFTER adopting the profile. `documentFromCanvas` clears
   * history to a single 'Open' state, and the profile is part of a history state, so
   * adopting it afterwards left the baseline holding `profile: null` — the very first
   * undo threw the embedded profile away and relabelled the document sRGB.
   */
  doc.history.clear('Open');
  doc.dirty = false;
  return adopt(doc);
}

/**
 * Adopt a JPEG's or PNG's embedded ICC profile, if it has one we can read.
 *
 * Loaded on demand: the ICC machinery is a few hundred lines nothing else in the
 * open path needs. Failure is deliberately quiet — an unsupported profile (a
 * LUT-based one, which is most CMYK profiles) is common and is not the user's
 * problem at the moment they open a photograph. The document then behaves as
 * untagged sRGB, which is what 8-bit RGB is anyway.
 *
 * The canvas has already decoded the pixels by this point, and the browser
 * applied the profile itself while decoding — so what this does is *label* the
 * document with the space it came from, which is what Assign, Convert and soft
 * proofing then work from.
 */
async function adoptProfileFrom(blob, doc) {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const { adoptEmbeddedProfile } = await import('../color/manage.js');
    await adoptEmbeddedProfile(doc, bytes, { quiet: true });
  } catch (err) {
    console.info('[open] no usable embedded colour profile', err);
  }
}

/**
 * Open a single file, dispatching on its extension and MIME type.
 * @param {File} file
 * @param {{asLayer?:boolean, doc?:PikaDocument}} [opts]
 * @returns {Promise<PikaDocument|import('../core/layer.js').Layer>}
 */
export async function openFile(file, opts = {}) {
  const name = file.name || 'Untitled';
  const ext = extensionOf(name);
  const type = (file.type || '').toLowerCase();
  const target = opts.asLayer ? (opts.doc || app.activeDoc) : null;

  let doc = null;
  if (ext === 'psd' || ext === 'psb' || type === 'image/vnd.adobe.photoshop') {
    doc = await readPSD(await readFileAsArrayBuffer(file), {
      budgetBytes: (app.memoryLimitMB || 512) * 1048576,
      onOversize: askAboutOversizePSD,
    });
    doc.name = stemOf(name);
  } else if (ext === 'pkd' || type === 'application/x-pikado') {
    doc = await loadPKD(await readFileAsArrayBuffer(file));
    if (!doc.name || doc.name === 'Untitled') doc.name = stemOf(name);
    if (file.handle) doc.fileHandle = file.handle;
  } else if (ext === 'svg' || type === 'image/svg+xml') {
    doc = await importSVG(await readFileAsText(file), stemOf(name));
  } else {
    return openImageBlob(file, stemOf(name), opts);
  }

  doc.filePath = name;
  if (target) {
    // Placing a structured file into an open document flattens it first.
    const flat = getComposite(doc);
    return placeAsLayer(target, flat, stemOf(name));
  }
  return adopt(doc);
}

/**
 * Open a list of files. Each one becomes its own document unless
 * `opts.asLayer` is set, in which case it is placed into the active document.
 * @param {FileList|File[]} files
 * @param {{asLayer?:boolean, doc?:PikaDocument}} [opts]
 */
export async function openFiles(files, opts = {}) {
  const list = [...(files || [])].filter(Boolean);
  if (!list.length) return [];
  const label = list.length > 1 ? `Opening ${list.length} files…` : `Opening ${list[0].name || 'file'}…`;
  const result = await app.busy(label, async () => {
    const opened = [];
    for (const file of list) {
      try {
        const out = await openFile(file, opts);
        if (out) opened.push(out);
      } catch (err) {
        console.error(err);
        const why = err && err.message ? err.message : 'the file could not be opened';
        app.toast(`${file.name || 'File'}: ${why}`, 'error', 6000);
      }
    }
    return opened;
  });
  return result || [];
}

/* ------------------------------------------------------------------ */
/* Drag and drop + paste                                               */
/* ------------------------------------------------------------------ */

/**
 * Install window-wide drag-and-drop and paste handling, with a drop-target
 * overlay anchored inside `areaEl`.
 * @param {HTMLElement} areaEl the canvas area
 */
export function installFileDrop(areaEl) {
  const host = areaEl || document.body;
  const title = el('div.pk-drop-title', { text: 'Drop to open' });
  const hint = el('div.pk-drop-hint', {}, 'Hold ', el('kbd', { text: 'Shift' }), ' to place into the current document');
  const overlay = el('div.pk-drop-overlay', {}, el('div.pk-drop-card', {}, title, hint));
  host.appendChild(overlay);

  let depth = 0;
  const show = () => overlay.classList.add('is-active');
  const hide = () => { depth = 0; overlay.classList.remove('is-active'); };

  const describe = (shift) => {
    const asLayer = shift && !!app.activeDoc;
    title.textContent = asLayer ? 'Drop as a new layer' : 'Drop to open';
    hint.style.visibility = app.activeDoc ? 'visible' : 'hidden';
  };

  const hasFiles = (e) => {
    const dt = e.dataTransfer;
    if (!dt) return false;
    if (dt.types) return [...dt.types].includes('Files');
    return true;
  };

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    describe(e.shiftKey);
    show();
  });

  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    describe(e.shiftKey);
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    show();
  });

  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) hide();
  });

  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hide();
    const dt = e.dataTransfer;
    const files = dt ? [...dt.files] : [];
    if (!files.length) return;
    const opts = { asLayer: e.shiftKey && !!app.activeDoc };

    // Chromium hands over real file-system handles, which lets Save write a
    // project back to the file it came from. The calls have to be made now,
    // synchronously — the DataTransfer is emptied as soon as we await.
    const items = dt && dt.items ? [...dt.items].filter((it) => it.kind === 'file') : [];
    if (items.length !== files.length || typeof items[0].getAsFileSystemHandle !== 'function') {
      openFiles(files, opts);
      return;
    }
    const handles = items.map((it) => it.getAsFileSystemHandle().catch(() => null));
    Promise.all(handles).then((list) => {
      list.forEach((h, i) => { if (h && h.kind === 'file') files[i].handle = h; });
      openFiles(files, opts);
    });
  });

  // Pasted bitmaps land in the current document, matching Photoshop.
  // `src/edit/clipboard.js` claims plain images first (it can restore their
  // original position); anything it leaves — a dropped-in PSD, SVG or project
  // file on the clipboard — is opened here.
  window.addEventListener('paste', (e) => {
    if (e.defaultPrevented || isTextEntry(e.target)) return;
    const items = e.clipboardData ? [...e.clipboardData.items] : [];
    const files = items
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile())
      .filter((f) => f && (/^image\//.test(f.type) || KNOWN_EXTENSIONS.has(extensionOf(f.name))));
    if (!files.length) return;
    e.preventDefault();
    openFiles(files, { asLayer: !!app.activeDoc });
  });
}

/** Typing into a field must never be hijacked by the file handlers. */
function isTextEntry(node) {
  if (!node || !node.tagName) return false;
  return node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable;
}
