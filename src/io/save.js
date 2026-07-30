import { app } from '../core/app.js';
import { getComposite, flattenLayers } from '../render/compositor.js';
import { createCanvas, ctx2d, ctx2dRead, download } from '../core/util.js';
import { savePKD } from './pkd.js';
import { writePSD } from './psd-write.js';
import { exportSVG } from './svg.js';
import { encodeGIF, encodeAnimatedGIF } from './gif.js';
import { framesOf, applyFrame } from '../core/animation.js';

/**
 * Saving and exporting.
 *
 * Saving writes the lossless `.pkd` project; exporting renders the composite
 * (or one file per top-level layer) to PNG/JPEG/WebP, or hands off to the PSD
 * and SVG writers.
 */

const MIME = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  webp: 'image/webp',
};

/** Strip an extension and anything a file system would object to. */
function baseName(name) {
  return String(name || 'Untitled').replace(/\.[a-z0-9]{1,6}$/i, '').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Untitled';
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(`Could not encode the image as ${type}`))), type, quality);
  });
}

/* ------------------------------------------------------------------ */
/* Saving the project                                                  */
/* ------------------------------------------------------------------ */

function pickerSupported() {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
}

async function writeToHandle(handle, blob) {
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

/**
 * Save to the document's existing file handle, or fall back to Save As.
 * @param {import('../core/document.js').PikaDocument} doc
 * @returns {Promise<boolean>} whether the file was written
 */
export async function saveDocument(doc) {
  if (!doc) return false;
  if (!doc.fileHandle || typeof doc.fileHandle.createWritable !== 'function') return saveDocumentAs(doc);
  return app.busy('Saving…', async () => {
    const blob = await savePKD(doc);
    await writeToHandle(doc.fileHandle, blob);
    doc.dirty = false;
    app.toast(`Saved ${doc.name}`, 'ok');
    app.emit('doc-change', doc);
    return true;
  });
}

/**
 * Always prompt for a location. Uses the File System Access API when the
 * browser has it, otherwise triggers a download.
 * @param {import('../core/document.js').PikaDocument} doc
 * @returns {Promise<boolean>}
 */
export async function saveDocumentAs(doc) {
  if (!doc) return false;
  const suggested = `${baseName(doc.name)}.pkd`;

  if (pickerSupported()) {
    let handle;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: suggested,
        types: [{ description: 'Pikado project', accept: { 'application/x-pikado': ['.pkd'] } }],
      });
    } catch (err) {
      if (err && err.name === 'AbortError') return false;
      handle = null;
    }
    if (handle) {
      return app.busy('Saving…', async () => {
        const blob = await savePKD(doc);
        await writeToHandle(handle, blob);
        doc.fileHandle = handle;
        doc.filePath = handle.name || suggested;
        doc.name = baseName(handle.name || doc.name);
        doc.dirty = false;
        app.toast(`Saved ${doc.name}`, 'ok');
        app.emit('docs-change');
        return true;
      });
    }
  }

  return app.busy('Saving…', async () => {
    const blob = await savePKD(doc);
    download(blob, suggested);
    doc.dirty = false;
    app.toast(`Saved ${suggested}`, 'ok');
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* Exporting                                                           */
/* ------------------------------------------------------------------ */

/** Composite the document, optionally scaled and flattened onto white. */
function renderComposite(doc, scale, transparent) {
  const width = Math.max(1, Math.round(doc.width * scale));
  const height = Math.max(1, Math.round(doc.height * scale));
  const out = createCanvas(width, height);
  const c = ctx2d(out);
  if (!transparent) {
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, width, height);
  }
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(getComposite(doc), 0, 0, width, height);
  return out;
}

/**
 * Render every animation frame, at `scale`.
 *
 * Each frame is applied to the live document, composited, and the layer state is
 * put back afterwards — the same approach the Timeline panel's thumbnails use, and
 * for the same reason: a frame *is* layer state, so there is no way to render one
 * without applying it, and cloning the whole document per frame would cost a copy
 * of every layer buffer.
 *
 * The restore runs in a `finally`, because leaving the document showing the last
 * frame after an export would be a visible side effect of saving a file.
 *
 * @returns {Array<{canvas:HTMLCanvasElement, delay:number}>}
 */
function renderFrames(doc, scale, transparent) {
  const frames = framesOf(doc);
  const wasFrameId = doc.activeFrameId;
  const before = doc.flatLayers().map((l) => ({ l, visible: l.visible, opacity: l.opacity }));
  const out = [];
  try {
    for (const frame of frames) {
      applyFrame(doc, frame);
      out.push({ canvas: renderComposite(doc, scale, transparent), delay: frame.delay });
    }
  } finally {
    for (const { l, visible, opacity } of before) { l.visible = visible; l.opacity = opacity; }
    doc.activeFrameId = wasFrameId;
    doc.invalidate();
  }
  return out;
}

/**
 * Render and download the document in the requested format.
 * @param {import('../core/document.js').PikaDocument} doc
 * @param {{format?:string, quality?:number, scale?:number, transparent?:boolean,
 *          filename?:string, save?:boolean}} [opts]
 * @returns {Promise<Blob|null>} the encoded blob
 */
export async function exportDocument(doc, opts = {}) {
  if (!doc) return null;
  const format = String(opts.format || 'png').toLowerCase();
  const scale = opts.scale && opts.scale > 0 ? opts.scale : 1;
  const quality = opts.quality == null ? 0.92 : Math.max(0.01, Math.min(1, opts.quality));
  const wantsTransparency = opts.transparent !== false && format !== 'jpeg' && format !== 'jpg';
  const shouldSave = opts.save !== false;

  return app.busy('Exporting…', async () => {
    let blob;
    let extension = format;

    if (format === 'psd') {
      blob = await writePSD(doc);
      extension = 'psd';
    } else if (format === 'svg') {
      blob = exportSVG(doc);
      extension = 'svg';
    } else if (format === 'gif') {
      // Canvas cannot encode GIF; we quantise and LZW-compress it ourselves.
      // A document with a timeline exports as an animation unless the caller
      // explicitly asks for a still — exporting only the current frame from a
      // finished animation is almost never what was meant.
      const frames = framesOf(doc);
      const animate = opts.animate !== false && frames.length > 1;
      blob = animate
        ? encodeAnimatedGIF(renderFrames(doc, scale, wantsTransparency), {
          loop: doc.loopCount == null ? 0 : doc.loopCount,
          transparent: wantsTransparency,
        })
        : encodeGIF(renderComposite(doc, scale, wantsTransparency), wantsTransparency);
      extension = 'gif';
    } else {
      const mime = MIME[format];
      if (!mime) throw new Error(`Unsupported export format "${format}"`);
      const canvas = renderComposite(doc, scale, wantsTransparency);
      blob = await canvasToBlob(canvas, mime, quality);
      if (blob.type && blob.type !== mime) {
        app.toast(`This browser cannot write ${format.toUpperCase()} — exported as ${blob.type.split('/')[1].toUpperCase()} instead.`, 'warn');
        extension = blob.type.split('/')[1] || format;
      } else {
        extension = format === 'jpg' ? 'jpg' : format;
      }
    }

    const filename = opts.filename || `${baseName(doc.name)}.${extension}`;
    if (shouldSave) {
      download(blob, filename);
      app.toast(`Exported ${filename}`, 'ok');
    }
    return blob;
  });
}

/** One-click PNG export at 100 %. */
export function quickExportPNG(doc) {
  return exportDocument(doc, { format: 'png', scale: 1, transparent: true });
}

/* ------------------------------------------------------------------ */
/* Per-layer export                                                    */
/* ------------------------------------------------------------------ */

/** Opaque bounds of an arbitrary canvas, or null when it is fully empty. */
function contentBoundsOf(canvas) {
  const w = canvas.width, h = canvas.height;
  const d = ctx2dRead(canvas).getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (d[row + x * 4 + 3] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Export every top-level layer as its own file, trimmed to its content.
 * The files are packed into a store-only ZIP.
 * @param {import('../core/document.js').PikaDocument} doc
 * @param {{format?:string, quality?:number, scale?:number, transparent?:boolean,
 *          trim?:boolean, visibleOnly?:boolean, filename?:string}} [opts]
 * @returns {Promise<Blob|null>} the zip blob
 */
export async function exportLayers(doc, opts = {}) {
  if (!doc) return null;
  const format = String(opts.format || 'png').toLowerCase();
  const mime = MIME[format];
  if (!mime) throw new Error(`Unsupported export format "${format}"`);
  const scale = opts.scale && opts.scale > 0 ? opts.scale : 1;
  const quality = opts.quality == null ? 0.92 : Math.max(0.01, Math.min(1, opts.quality));
  const wantsTransparency = opts.transparent !== false && format !== 'jpeg' && format !== 'jpg';
  const trim = opts.trim !== false;

  return app.busy('Exporting layers…', async () => {
    const zip = new StoreZip();
    const used = new Map();
    let count = 0;

    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const layer = doc.layers[i];
      if (opts.visibleOnly && !layer.visible) continue;

      const flat = flattenLayers(doc, layer.children ? collectIds(layer) : [layer]);
      const bounds = trim ? contentBoundsOf(flat) : { x: 0, y: 0, width: doc.width, height: doc.height };
      if (!bounds) continue;

      const width = Math.max(1, Math.round(bounds.width * scale));
      const height = Math.max(1, Math.round(bounds.height * scale));
      const out = createCanvas(width, height);
      const c = ctx2d(out);
      if (!wantsTransparency) {
        c.fillStyle = '#ffffff';
        c.fillRect(0, 0, width, height);
      }
      c.imageSmoothingQuality = 'high';
      c.drawImage(flat, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, width, height);

      const blob = await canvasToBlob(out, mime, quality);
      const stem = baseName(layer.name || `Layer ${i + 1}`);
      const seen = (used.get(stem) || 0) + 1;
      used.set(stem, seen);
      const entry = `${String(count + 1).padStart(2, '0')}-${stem}${seen > 1 ? `-${seen}` : ''}.${format === 'jpg' ? 'jpg' : format}`;
      await zip.add(entry, blob);
      count++;
    }

    if (!count) {
      app.toast('There is nothing to export — every top-level layer is empty.', 'warn');
      return null;
    }

    const zipBlob = zip.finish();
    const filename = opts.filename || `${baseName(doc.name)}-layers.zip`;
    download(zipBlob, filename);
    app.toast(`Exported ${count} layer${count === 1 ? '' : 's'} to ${filename}`, 'ok');
    return zipBlob;
  });
}

/** Every layer id inside a group (the compositor prunes by id). */
function collectIds(group, out = []) {
  for (const child of group.children || []) {
    out.push(child);
    if (child.children) collectIds(child, out);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Minimal store-only ZIP writer                                       */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Uncompressed (method 0) ZIP archive — enough for already-compressed PNGs. */
class StoreZip {
  constructor() {
    this.parts = [];
    this.entries = [];
    this.offset = 0;
    const now = new Date();
    this.time = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
    this.date = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  }

  async add(name, blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(bytes);

    const header = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(header.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);      // version needed
    dv.setUint16(6, 0x0800, true);  // UTF-8 names
    dv.setUint16(8, 0, true);       // method: store
    dv.setUint16(10, this.time, true);
    dv.setUint16(12, this.date, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, bytes.length, true);
    dv.setUint32(22, bytes.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    header.set(nameBytes, 30);

    this.entries.push({ nameBytes, crc, size: bytes.length, offset: this.offset });
    this.parts.push(header, bytes);
    this.offset += header.length + bytes.length;
  }

  finish() {
    const centralParts = [];
    let centralSize = 0;
    for (const e of this.entries) {
      const rec = new Uint8Array(46 + e.nameBytes.length);
      const dv = new DataView(rec.buffer);
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, 20, true);      // version made by
      dv.setUint16(6, 20, true);      // version needed
      dv.setUint16(8, 0x0800, true);
      dv.setUint16(10, 0, true);
      dv.setUint16(12, this.time, true);
      dv.setUint16(14, this.date, true);
      dv.setUint32(16, e.crc, true);
      dv.setUint32(20, e.size, true);
      dv.setUint32(24, e.size, true);
      dv.setUint16(28, e.nameBytes.length, true);
      dv.setUint16(30, 0, true);      // extra length
      dv.setUint16(32, 0, true);      // comment length
      dv.setUint16(34, 0, true);      // disk number
      dv.setUint16(36, 0, true);      // internal attributes
      dv.setUint32(38, 0, true);      // external attributes
      dv.setUint32(42, e.offset, true);
      rec.set(e.nameBytes, 46);
      centralParts.push(rec);
      centralSize += rec.length;
    }

    const end = new Uint8Array(22);
    const dv = new DataView(end.buffer);
    dv.setUint32(0, 0x06054b50, true);
    dv.setUint16(4, 0, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, this.entries.length, true);
    dv.setUint16(10, this.entries.length, true);
    dv.setUint32(12, centralSize, true);
    dv.setUint32(16, this.offset, true);
    dv.setUint16(20, 0, true);

    return new Blob([...this.parts, ...centralParts, end], { type: 'application/zip' });
  }
}
