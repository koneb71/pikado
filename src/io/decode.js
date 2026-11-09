import { createCanvas, ctx2d, loadImage } from '../core/util.js';
import { tr } from '../core/i18n.js';
import { isHEIF } from './heif-info.js';
import { decodeHEIF } from './heif-read.js';
import { isICNS, readICNS } from './icns.js';

/**
 * Turning an image file into pixels.
 *
 * Kept apart from `open.js`, which turns pixels into *documents*: pasting an
 * image and replacing a Smart Object's contents need the decoding and none of
 * the rest, and importing all of `open.js` for it would pull the PSD and SVG
 * readers along.
 */

/** Decode any browser-supported image blob to a canvas. */
export async function decodeToCanvas(blob) {
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
  if (!w || !h) throw new Error(tr('The image has no pixels'));
  const canvas = createCanvas(w, h);
  ctx2d(canvas).drawImage(img, 0, 0);
  return canvas;
}

/**
 * Decode any image Pikado can open as pixels, to a canvas.
 *
 * Dispatches on the bytes rather than the name, because a name is only a
 * claim: a HEIC renamed `.jpg` is still a HEIC, and a JPEG converted from one
 * often keeps the `.heic` it started with.
 *
 * HEIC tries the browser first. Safari decodes it natively — with the OS's own
 * colour handling, and without fetching 2 MB of decoder — and every other
 * browser fails fast and falls through to libheif.
 *
 * Used by File > Open, paste, and Smart Object > Replace Contents alike, so a
 * format that opens anywhere opens everywhere.
 *
 * @param {Blob} blob
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function decodeImage(blob) {
  const head = new Uint8Array(await blob.slice(0, 256).arrayBuffer());
  if (isICNS(head)) return readICNS(new Uint8Array(await blob.arrayBuffer()));
  if (isHEIF(head)) {
    try {
      return await decodeToCanvas(blob);
    } catch (err) {
      return decodeHEIF(blob);
    }
  }
  return decodeToCanvas(blob);
}
