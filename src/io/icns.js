import { createCanvas, ctx2d } from '../core/util.js';
import { tr } from '../core/i18n.js';

/**
 * Apple icon files (`.icns`) — the format of every macOS app and folder icon.
 *
 * An ICNS is a flat list of `type, length, data` entries, one per size and
 * pixel density. Since macOS 10.7 each entry is simply a PNG; older icons store
 * run-length-encoded RGB planes with a separate 8-bit mask, and both kinds are
 * still in circulation, so both are read.
 *
 * Reading opens the largest entry that decodes: an icon is one picture drawn at
 * several sizes, and the largest is the one worth editing. Writing goes the
 * other way, rendering the document at every size Finder and the Dock ask for —
 * but never *above* the document's own size, because an upscaled entry is
 * blurrier than the smaller one macOS would otherwise scale up itself.
 */

const MAGIC = 'icns';

/**
 * PNG entry types, by pixel size. `ic10`–`ic14` are the @2x slots: `ic10` is
 * "512pt at 2x", which is 1024 pixels. Order is the order they are written in,
 * smallest first, matching what `iconutil` produces.
 */
const PNG_ENTRIES = [
  ['icp4', 16], ['ic11', 32], ['icp5', 32], ['icp6', 64], ['ic12', 64],
  ['ic07', 128], ['ic08', 256], ['ic13', 256], ['ic09', 512], ['ic14', 512], ['ic10', 1024],
];

/** Legacy RLE RGB entries, with the uncompressed 8-bit mask each pairs with. */
const RLE_ENTRIES = {
  is32: { size: 16, mask: 's8mk' },
  il32: { size: 32, mask: 'l8mk' },
  ih32: { size: 48, mask: 'h8mk' },
  it32: { size: 128, mask: 't8mk' },
};

/** ARGB entries: 'ARGB' and then four RLE planes, alpha first. */
const ARGB_ENTRIES = { ic04: 16, ic05: 32 };

const fourcc = (b, at) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

function readU32(b, at) {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}

/** Whether these bytes are an ICNS file. */
export function isICNS(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  return b.length >= 8 && fourcc(b, 0) === MAGIC;
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/**
 * Every entry in the file, as {type, data}. An entry whose length runs past the
 * end of the file stops the walk — what came before it is still usable, and a
 * truncated download usually still has its small sizes intact.
 */
export function icnsEntries(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!isICNS(b)) throw new Error(tr('this is not an ICNS file'));
  const end = Math.min(readU32(b, 4), b.length);
  const entries = [];
  let at = 8;
  while (at + 8 <= end) {
    const type = fourcc(b, at);
    const length = readU32(b, at + 4);
    if (length < 8 || at + length > end) break;
    entries.push({ type, data: b.subarray(at + 8, at + length) });
    at += length;
  }
  return entries;
}

/**
 * Decode the largest image in an ICNS file.
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function readICNS(bytes) {
  const entries = icnsEntries(bytes);
  const byType = new Map(entries.map((e) => [e.type, e]));
  const candidates = [];

  for (const e of entries) {
    const d = e.data;
    if (d.length >= 8 && d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47) {
      // Trust the PNG's own header for the size rather than the slot: a
      // mislabelled entry is common in hand-made icons and harmless here.
      const size = d.length >= 24 ? Math.max(readU32(d, 16), readU32(d, 20)) : 0;
      candidates.push({ size, decode: () => decodeBitmap(d, 'image/png') });
    } else if (d.length >= 12 && readU32(d, 0) === 12 && fourcc(d, 4) === 'jP  ') {
      // JPEG 2000, used by some 10.5-era icons. No current browser decodes it,
      // but trying costs nothing and the smaller RLE entries are the fallback.
      const size = PNG_ENTRIES.find(([t]) => t === e.type)?.[1] || 0;
      candidates.push({ size, decode: () => decodeBitmap(d, 'image/jp2') });
    } else if (RLE_ENTRIES[e.type]) {
      const { size, mask } = RLE_ENTRIES[e.type];
      candidates.push({ size, decode: () => decodeRLE(d, size, byType.get(mask)) });
    } else if (ARGB_ENTRIES[e.type] && fourcc(d, 0) === 'ARGB') {
      const size = ARGB_ENTRIES[e.type];
      candidates.push({ size, decode: () => decodeARGB(d, size) });
    }
  }

  candidates.sort((a, b) => b.size - a.size);
  for (const c of candidates) {
    try {
      const canvas = await c.decode();
      if (canvas) return canvas;
    } catch (err) {
      console.info('[icns] entry skipped', err);
    }
  }
  throw new Error(entries.length
    ? tr('this icon has no image Pikado can decode')
    : tr('this ICNS file has no icon entries'));
}

async function decodeBitmap(data, type) {
  const bitmap = await createImageBitmap(new Blob([data], { type }));
  const canvas = createCanvas(bitmap.width, bitmap.height);
  ctx2d(canvas).drawImage(bitmap, 0, 0);
  if (bitmap.close) bitmap.close();
  return canvas;
}

/**
 * Apple's icon RLE, which is PackBits with a different bias: a control byte
 * below 0x80 means "copy the next n + 1 bytes", and one at or above it means
 * "repeat the next byte n - 125 times".
 *
 * @returns {number} where in `src` the plane ended
 */
export function unpackIconRLE(src, at, out, count) {
  let n = 0;
  while (n < count) {
    if (at >= src.length) throw new Error('the icon data ends early');
    const control = src[at++];
    if (control < 0x80) {
      const run = control + 1;
      if (at + run > src.length || n + run > count) throw new Error('an icon run overflows');
      out.set(src.subarray(at, at + run), n);
      at += run;
      n += run;
    } else {
      const run = control - 125;
      if (at >= src.length || n + run > count) throw new Error('an icon run overflows');
      out.fill(src[at++], n, n + run);
      n += run;
    }
  }
  return at;
}

function planesToCanvas(size, r, g, bl, a) {
  const canvas = createCanvas(size, size);
  const image = new ImageData(size, size);
  const d = image.data;
  for (let i = 0, p = 0; i < size * size; i++, p += 4) {
    d[p] = r[i];
    d[p + 1] = g[i];
    d[p + 2] = bl[i];
    d[p + 3] = a ? a[i] : 255;
  }
  ctx2d(canvas).putImageData(image, 0, 0);
  return canvas;
}

function decodeRLE(data, size, maskEntry) {
  const count = size * size;
  const planes = [new Uint8Array(count), new Uint8Array(count), new Uint8Array(count)];
  // it32 opens with four bytes of zero padding; the smaller sizes do not.
  let at = size === 128 ? 4 : 0;
  for (const plane of planes) at = unpackIconRLE(data, at, plane, count);
  const mask = maskEntry && maskEntry.data.length >= count ? maskEntry.data.subarray(0, count) : null;
  return planesToCanvas(size, planes[0], planes[1], planes[2], mask);
}

function decodeARGB(data, size) {
  const count = size * size;
  const planes = [new Uint8Array(count), new Uint8Array(count), new Uint8Array(count), new Uint8Array(count)];
  let at = 4;
  for (const plane of planes) at = unpackIconRLE(data, at, plane, count);
  const [a, r, g, b] = planes;
  return planesToCanvas(size, r, g, b, a);
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

/**
 * The source drawn into a transparent square of side `size`, contained and
 * centred, halving step by step on the way down. A single 1024 → 16 drawImage
 * samples a handful of source pixels per output pixel and shimmers; halving
 * keeps every step a true average.
 */
function renderSquare(source, size) {
  let src = source;
  let w = source.width;
  let h = source.height;
  const fit = size / Math.max(w, h);
  const targetW = Math.max(1, Math.round(w * fit));
  const targetH = Math.max(1, Math.round(h * fit));
  while (w / 2 >= targetW && h / 2 >= targetH) {
    const half = createCanvas(Math.round(w / 2), Math.round(h / 2));
    const c = ctx2d(half);
    c.imageSmoothingQuality = 'high';
    c.drawImage(src, 0, 0, half.width, half.height);
    src = half;
    w = half.width;
    h = half.height;
  }
  const out = createCanvas(size, size);
  const c = ctx2d(out);
  c.imageSmoothingQuality = 'high';
  c.drawImage(src, Math.round((size - targetW) / 2), Math.round((size - targetH) / 2), targetW, targetH);
  return out;
}

function pngOf(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(tr('Could not encode an icon size as PNG')))), 'image/png');
  });
}

/** The entry sizes an icon of this source would get. Never above the source. */
export function icnsSizesFor(width, height) {
  const longest = Math.max(width, height);
  const fits = PNG_ENTRIES.filter(([, size]) => size <= longest);
  return fits.length ? fits : PNG_ENTRIES.slice(0, 1);
}

/**
 * Encode a canvas as an ICNS file.
 * @param {HTMLCanvasElement} source
 * @returns {Promise<Blob>}
 */
export async function writeICNS(source) {
  const entries = icnsSizesFor(source.width, source.height);
  // Several slots share a pixel size (ic11 and icp5 are both 32 px): render and
  // encode each size once.
  const pngs = new Map();
  for (const [, size] of entries) {
    if (!pngs.has(size)) {
      pngs.set(size, new Uint8Array(await (await pngOf(renderSquare(source, size))).arrayBuffer()));
    }
  }

  const parts = [];
  let total = 8;
  for (const [type, size] of entries) {
    const data = pngs.get(size);
    const head = new Uint8Array(8);
    for (let i = 0; i < 4; i++) head[i] = type.charCodeAt(i);
    new DataView(head.buffer).setUint32(4, data.length + 8);
    parts.push(head, data);
    total += data.length + 8;
  }
  const header = new Uint8Array(8);
  for (let i = 0; i < 4; i++) header[i] = MAGIC.charCodeAt(i);
  new DataView(header.buffer).setUint32(4, total);
  return new Blob([header, ...parts], { type: 'image/icns' });
}
