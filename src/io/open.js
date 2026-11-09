import './open.css';
import { app } from '../core/app.js';
import { tr, trn } from '../core/i18n.js';
import { PikaDocument } from '../core/document.js';
import { createRasterLayer } from '../core/layer.js';
import { createCanvas, ctx2d, el, readFileAsArrayBuffer, readFileAsText } from '../core/util.js';
import { getComposite } from '../render/compositor.js';
import { readPSD } from './psd-read.js';
import { importSVG } from './svg.js';
import { loadPKD } from './pkd.js';
import { decodeImage } from './decode.js';

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
  const dialog = new Dialog({ title: tr('This PSD is bigger than it looks'), width: 500 });
  dialog.setBody(
    el('div.pk-msg', {
      text: trn(
        'It has {count} layer on a {width} x {height} canvas. '
          + 'Pikado keeps every layer at full canvas size, so opening them all needs about '
          + '{size} MB — well past the {budget} MB budget in Preferences. That is usually '
          + 'enough to make the tab unresponsive or close it outright.',
        'It has {count} layers on a {width} x {height} canvas. '
          + 'Pikado keeps every layer at full canvas size, so opening them all needs about '
          + '{size} MB — well past the {budget} MB budget in Preferences. That is usually '
          + 'enough to make the tab unresponsive or close it outright.',
        info.layers,
        { width: info.width, height: info.height, size: mb, budget: budgetMb },
      ),
    }),
    el('div.pk-hint', {
      text: tr('Opening it flattened uses the composite Photoshop already stored in the file. '
        + 'You get the picture, at one layer, immediately. Opening every layer may still '
        + 'work if you have the memory to spare — it is your call, not a refusal.'),
    }),
  );
  dialog.setButtons([
    { label: tr('Cancel'), value: 'cancel', subtle: true },
    { label: tr('Open all layers anyway'), value: 'proceed' },
    { label: tr('Open flattened'), value: 'flatten', primary: true },
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

/**
 * Extensions we can open even when the clipboard reports no MIME type — or a
 * useless one: Chrome and Firefox label a `.heic` from the disk with no type at
 * all, and a server will often call it `application/octet-stream`.
 */
const KNOWN_EXTENSIONS = new Set(['psd', 'psb', 'pkd', 'svg', 'heic', 'heif', 'hif', 'icns']);

function extensionOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

function stemOf(name) {
  return String(name || tr('Untitled')).replace(/\.[a-z0-9]{1,6}$/i, '') || tr('Untitled');
}

/* ------------------------------------------------------------------ */
/* Decoding helpers                                                    */
/* ------------------------------------------------------------------ */

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
  const layer = createRasterLayer(canvas.width, canvas.height, tr('Background'));
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
    const layer = createRasterLayer(doc.width, doc.height, tr('Frame {number}', { number: i + 1 }));
    ctx2d(layer.canvas).drawImage(frame, 0, 0);
    return layer;
  });
  doc.activeLayerId = doc.layers[0].id;
  doc.selectedLayerIds = [doc.layers[0].id];
  doc.history.clear('Open');
  doc.dirty = false;
  return doc;
}

/**
 * Place a canvas into an open document as a new layer, scaled to fit.
 *
 * Exported because this is also what a drag between two open Pikado documents
 * lands on (`src/ui/cross-doc-drag.js`). The contain-fit is the point: a layer
 * buffer is document-sized with no offset, so drawing the source at its own
 * size would put everything past the edge somewhere it is not stored.
 */
export function placeAsLayer(doc, source, name) {
  const layer = createRasterLayer(doc.width, doc.height, name);
  const scale = Math.min(1, doc.width / source.width, doc.height / source.height);
  const w = Math.max(1, Math.round(source.width * scale));
  const h = Math.max(1, Math.round(source.height * scale));
  const c = ctx2d(layer.canvas);
  c.imageSmoothingQuality = 'high';
  c.drawImage(source, Math.round((doc.width - w) / 2), Math.round((doc.height - h) / 2), w, h);
  doc.addLayer(layer);
  doc.commit('Place');
  app.toast(tr('Placed “{name}” as a new layer', { name }), 'ok');
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
export async function openImageBlob(blob, name = tr('Image'), opts = {}) {
  const target = opts.asLayer ? (opts.doc || app.activeDoc) : null;
  const isGif = blob.type === 'image/gif' || extensionOf(name) === 'gif';

  if (!target && isGif) {
    const frames = await decodeGifFrames(blob);
    if (frames && frames.length > 1) {
      app.toast(trn('Imported {count} GIF frame as a layer', 'Imported {count} GIF frames as layers', frames.length), 'ok');
      return adopt(documentFromFrames(frames, name));
    }
  }

  const canvas = await decodeImage(blob);
  if (target) return placeAsLayer(target, canvas, name);
  const doc = documentFromCanvas(canvas, name);
  await noteProfileOf(blob, doc);
  return adopt(doc);
}

/**
 * Remember which colour profile a JPEG, PNG or HEIC was tagged with.
 *
 * The document stays sRGB: its pixels were converted out of that profile while
 * they were decoded, so sRGB is what they are (see `noteSourceProfile`). This
 * only records where they came from, for the colour dialogs to mention.
 *
 * Loaded on demand — the ICC machinery is a few hundred lines nothing else in
 * the open path needs — and quiet about failure, because an unreadable profile
 * is not the user's problem at the moment they open a photograph.
 */
async function noteProfileOf(blob, doc) {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const { noteSourceProfile } = await import('../color/manage.js');
    await noteSourceProfile(doc, bytes);
  } catch (err) {
    console.info('[open] could not read the embedded colour profile', err);
  }
}

/**
 * Open a single file, dispatching on its extension and MIME type.
 * @param {File} file
 * @param {{asLayer?:boolean, doc?:PikaDocument}} [opts]
 * @returns {Promise<PikaDocument|import('../core/layer.js').Layer>}
 */
export async function openFile(file, opts = {}) {
  const name = file.name || tr('Untitled');
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
  const label = list.length > 1
    ? trn('Opening {count} file…', 'Opening {count} files…', list.length)
    : list[0].name ? tr('Opening {name}…', { name: list[0].name }) : tr('Opening file…');
  const result = await app.busy(label, async () => {
    const opened = [];
    for (const file of list) {
      try {
        const out = await openFile(file, opts);
        if (out) opened.push(out);
      } catch (err) {
        console.error(err);
        const why = err && err.message ? err.message : tr('the file could not be opened');
        app.toast(`${file.name || tr('File')}: ${why}`, 'error', 6000);
      }
    }
    return opened;
  });
  return result || [];
}

/* ------------------------------------------------------------------ */
/* Images dragged out of another page                                  */
/* ------------------------------------------------------------------ */

/** Schemes we will fetch. Anything else — `javascript:`, `file:` — is refused. */
const DROP_SCHEMES = new Set(['http:', 'https:', 'data:', 'blob:']);

/**
 * The first image in a drag's `text/html`, with its alt text.
 *
 * Parsed with `DOMParser` and never assigned to a live element: this is markup
 * from another origin, and an `<img src>` in the live document would fetch as a
 * side effect of merely reading it.
 *
 * A parsed document has no base URL, so a relative `src` cannot be resolved
 * here and falls through to `text/uri-list`. Browsers write absolute URLs into
 * drag markup, so that is the rare case rather than the normal one.
 */
function imageInMarkup(html) {
  if (!html) return null;
  let img = null;
  try {
    img = new DOMParser().parseFromString(html, 'text/html').querySelector('img[src]');
  } catch (err) {
    return null;
  }
  if (!img) return null;
  return { url: img.getAttribute('src') || '', alt: (img.getAttribute('alt') || '').trim() };
}

/** The first real entry of a `text/uri-list`: it is line-based, and `#` comments. */
function firstUri(raw) {
  for (const line of String(raw || '').split(/[\r\n]+/)) {
    const s = line.trim();
    if (s && s[0] !== '#') return s;
  }
  return '';
}

/** An absolute URL in a scheme we are willing to fetch, or ''. */
function usableUrl(raw) {
  if (!raw) return '';
  try {
    const u = new URL(String(raw).trim());
    return DROP_SCHEMES.has(u.protocol) ? u.href : '';
  } catch (err) {
    return '';   // relative, or not a URL at all
  }
}

/**
 * The image a drag is really carrying.
 *
 * `text/uri-list` looks like the obvious source and is the wrong one on its
 * own: when the dragged image sits inside a link — which on most sites it does
 * — the browser puts the *link's* href there, and the image's own `src` only in
 * `text/html`. Reading the markup first is the difference between dragging a
 * thumbnail off a search page and getting the picture, or getting the page it
 * happened to point at.
 *
 * @param {{html?:string, uriList?:string, plain?:string}} data raw drag strings
 * @returns {{url:string, alt:string}|null}
 */
export function droppedImageUrl(data = {}) {
  const found = imageInMarkup(data.html);
  const fromMarkup = usableUrl(found && found.url);
  if (fromMarkup) return { url: fromMarkup, alt: found.alt };
  const url = usableUrl(firstUri(data.uriList)) || usableUrl(firstUri(data.plain));
  return url ? { url, alt: '' } : null;
}

/** A file name for a fetched image: the URL's last path segment, else its alt text. */
function nameForUrl(url, alt) {
  let name = '';
  try {
    const u = new URL(url);
    if (u.protocol !== 'data:') {
      const last = u.pathname.split('/').pop() || '';
      try { name = decodeURIComponent(last).trim(); } catch (err) { name = last.trim(); }
    }
    if (!name) name = (alt || u.hostname || '').trim();
  } catch (err) {
    name = (alt || '').trim();
  }
  return name.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120) || tr('Image');
}

/** The host to name in a failure message. */
function hostOf(url) {
  try {
    return new URL(url).hostname || tr('That site');
  } catch (err) {
    return tr('That site');
  }
}

/**
 * Fetch an image dragged out of another page.
 *
 * Sent without cookies and without a referrer: this is the same request the
 * page you dragged from already made, and Pikado has no business telling that
 * server who you are or where the drag came from.
 *
 * A cross-origin image can only be *read* when the server allows it. There is a
 * fallback that looks like it works — draw an `<img>` with no `crossOrigin`
 * into a canvas — and it is a trap: the canvas is then tainted, `getImageData`
 * throws, and the compositor, history, thumbnails and export all break on a
 * document that otherwise looks fine. So a refusal is reported rather than
 * worked around, and it names the route that always works.
 *
 * @returns {Promise<File|null>}
 */
async function fetchDroppedImage(url, name) {
  let res;
  try {
    res = await fetch(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch (err) {
    app.toast(
      tr('{host} does not let another site read its images. Right-click the image, '
        + 'choose Copy image, then press Ctrl+V here.', { host: hostOf(url) }),
      'error', 8000,
    );
    return null;
  }
  if (!res.ok) {
    app.toast(tr('{host} refused the image (HTTP {status}).', { host: hostOf(url), status: res.status }), 'error', 6000);
    return null;
  }
  const blob = await res.blob();
  if (!blob.size) {
    app.toast(tr('That image came back empty.'), 'error');
    return null;
  }
  const type = (blob.type || '').toLowerCase();
  /*
   * Servers do mislabel images as `application/octet-stream`, so an unhelpful
   * type is not treated as a refusal — the decoder gets to decide. Only a type
   * that is positively something else, which is what dragging a *link* gives
   * you, is turned away here, because "the image has no pixels" would be a
   * baffling thing to read after dropping a link.
   */
  const openable = /^image\//.test(type)
    || KNOWN_EXTENSIONS.has(extensionOf(name))
    || !type
    || type === 'application/octet-stream'
    || type === 'application/x-pikado';
  if (!openable) {
    app.toast(tr('That link points at a page, not an image.'), 'error', 5000);
    return null;
  }
  return new File([blob], name, { type });
}

/**
 * Open an image dragged out of another page. Fetching it is the only new step;
 * everything after goes through `openFiles`, so a dragged PSD, SVG or animated
 * GIF behaves exactly as the same file would coming off the disk.
 */
async function openDroppedUrl(url, alt, opts) {
  const name = nameForUrl(url, alt);
  // `app.busy` lowers the overlay in a `finally`, so two of them cannot be
  // nested — this one has to finish before `openFiles` starts its own.
  const file = await app.busy(tr('Fetching {name}…', { name }), () => fetchDroppedImage(url, name));
  if (!file) return null;
  return openFiles([file], opts);
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
  const title = el('div.pk-drop-title', { text: tr('Drop to open') });
  const [hintStart, hintEnd] = tr('Hold {key} to place into the current document').split('{key}');
  const hint = el('div.pk-drop-hint', {}, hintStart, el('kbd', { text: tr('Shift') }), hintEnd);
  const overlay = el('div.pk-drop-overlay', {}, el('div.pk-drop-card', {}, title, hint));
  host.appendChild(overlay);

  let depth = 0;
  const show = () => overlay.classList.add('is-active');
  const hide = () => { depth = 0; overlay.classList.remove('is-active'); };

  const describe = (shift) => {
    const asLayer = shift && !!app.activeDoc;
    title.textContent = asLayer ? tr('Drop as a new layer') : tr('Drop to open');
    hint.style.visibility = app.activeDoc ? 'visible' : 'hidden';
  };

  /**
   * Drags we take over.
   *
   * `Files` is the file system. `text/uri-list` is what a browser puts on the
   * drag when you pull an image — or a link — out of a page, and it is exactly
   * what separates those from a plain text selection, which carries
   * `text/plain` and `text/html` and nothing else. The timeline's own
   * frame-reorder drag sets `text/plain` alone for the same reason
   * (src/ui/panels/timeline.js), so it stays out of this too.
   *
   * Dropping onto a field the user is typing in is left to the browser, which
   * is what inserts the text they dragged there.
   */
  const isOpenableDrag = (e) => {
    const dt = e.dataTransfer;
    if (!dt || isTextEntry(e.target)) return false;
    if (!dt.types) return true;
    const types = [...dt.types];
    return types.includes('Files') || types.includes('text/uri-list');
  };

  window.addEventListener('dragenter', (e) => {
    if (!isOpenableDrag(e)) return;
    e.preventDefault();
    depth++;
    describe(e.shiftKey);
    show();
  });

  window.addEventListener('dragover', (e) => {
    if (!isOpenableDrag(e)) return;
    e.preventDefault();
    describe(e.shiftKey);
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    show();
  });

  window.addEventListener('dragleave', (e) => {
    if (!isOpenableDrag(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) hide();
  });

  window.addEventListener('drop', (e) => {
    if (!isOpenableDrag(e)) return;
    /*
     * Claimed, so the browser must not also do its default thing with it.
     * Dropping an image or a link used to navigate the tab straight to it,
     * taking the editor and everything open in it along — a worse outcome than
     * any failure below, including the ones we cannot do anything about.
     */
    e.preventDefault();
    hide();
    const dt = e.dataTransfer;
    const files = dt ? [...dt.files] : [];
    const opts = { asLayer: e.shiftKey && !!app.activeDoc };

    if (!files.length) {
      /*
       * No File on the drag means it came out of a page rather than off the
       * disk. Every string has to be read now, for the same reason the handle
       * calls below are made synchronously: the DataTransfer is emptied the
       * moment we await.
       */
      const found = droppedImageUrl({
        html: dt ? dt.getData('text/html') : '',
        uriList: dt ? dt.getData('text/uri-list') : '',
        plain: dt ? dt.getData('text/plain') : '',
      });
      if (found) openDroppedUrl(found.url, found.alt, opts);
      return;
    }

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
