import { createCanvas, ctx2d, ctx2dRead } from '../core/util.js';
import { morph } from '../core/selection.js';

/**
 * The pixel geometry of a generative fill.
 *
 * Everything here is pure canvas maths with no knowledge of providers, keys or
 * networks, which is deliberate: this is the half of the feature that is either
 * right or wrong regardless of who is generating the pixels, so it is the half
 * that can be tested exhaustively offline.
 *
 * The problem it solves: a selection is an arbitrary region of a document of
 * arbitrary size, and an image model wants a fixed square. Getting from one to
 * the other loses quality in exactly one place, and the job here is to make sure
 * it is the *cheap* place.
 */

/**
 * @typedef {object} FillFrame
 * @property {{x:number,y:number,width:number,height:number}} crop
 *   The document-space region actually sent. Always contains the selection.
 * @property {number} size   the provider's square edge, e.g. 1024
 * @property {number} scale  size / longest crop edge. Below 1 the crop is being
 *   downscaled to fit (cheap); above 1 the result comes back genuinely softer
 *   than the pixels around it, and the dialog says so.
 * @property {{x:number,y:number,width:number,height:number}} inset
 *   Where the crop sits inside the square, as fractions of 0..1. A square crop
 *   is {0,0,1,1}; a wide one is letterboxed. Fractions rather than pixels so a
 *   provider that answers at a different resolution than it was asked for still
 *   maps back to the right document coordinates.
 */

/**
 * Choose the region to send and how it maps into the provider's square.
 *
 * The rule that matters is "grow for free". The obvious implementation takes the
 * selection's bounding box plus a margin and scales that up to the request size —
 * which, for a small selection in a large document, throws away real pixels in
 * order to send invented ones. A 200x200 selection in a 2000x2000 document would
 * be sent as a 300x300 crop upscaled 3.4x, when a 1024x1024 crop of genuine
 * neighbouring pixels was available at no cost at all and gives the model far
 * more context to match lighting and texture against.
 *
 * So the crop grows toward the request size wherever the document allows, is slid
 * inside the document rather than shrunk when it hits an edge, and is only ever
 * made of real pixels — there is no transparent-padding case to reason about.
 *
 * @param {{x:number,y:number,width:number,height:number}} bounds selection bounds
 * @param {number} docWidth
 * @param {number} docHeight
 * @param {{size?:number, context?:number}} [opts]
 * @returns {FillFrame}
 */
export function planFrame(bounds, docWidth, docHeight, { size = 1024, context = 0.25 } = {}) {
  const bw = Math.max(1, Math.round(bounds.width));
  const bh = Math.max(1, Math.round(bounds.height));
  const bx = Math.round(bounds.x);
  const by = Math.round(bounds.y);

  // Grow toward the request size, but never past what the document actually has.
  const ideal = Math.ceil(Math.max(bw, bh) * (1 + 2 * context));
  let side = Math.max(ideal, Math.min(size, docWidth, docHeight));
  side = Math.min(side, docWidth, docHeight);

  // Per-axis rather than a strict square, because a selection longer than `side`
  // cannot fit inside one — a letterboxed non-square crop is the honest answer,
  // and containing the selection matters more than the request being square.
  const cw = Math.min(docWidth, Math.max(side, bw));
  const ch = Math.min(docHeight, Math.max(side, bh));

  // Centre on the selection, then slide inside the document. Sliding, not
  // shrinking: shrinking at an edge would hand the model less context in exactly
  // the place it already has least.
  const cx = Math.max(0, Math.min(Math.round(bx + bw / 2 - cw / 2), docWidth - cw));
  const cy = Math.max(0, Math.min(Math.round(by + bh / 2 - ch / 2), docHeight - ch));

  const longest = Math.max(cw, ch);
  const inset = {
    x: (1 - cw / longest) / 2,
    y: (1 - ch / longest) / 2,
    width: cw / longest,
    height: ch / longest,
  };

  return { crop: { x: cx, y: cy, width: cw, height: ch }, size, scale: size / longest, inset };
}

/**
 * Cut `frame.crop` out of a document-sized canvas into a size x size request image.
 *
 * Two draws rather than one: a negative source rectangle in `drawImage` is the
 * kind of thing browsers disagree about, so the crop is staged at its own size
 * first and only then placed into the square.
 *
 * @param {HTMLCanvasElement} source document-sized composite
 * @param {FillFrame} frame
 * @returns {HTMLCanvasElement}
 */
export function cropToRequest(source, frame) {
  const { crop, size, inset } = frame;
  const stage = createCanvas(crop.width, crop.height);
  ctx2d(stage).drawImage(source, -crop.x, -crop.y);

  const out = createCanvas(size, size);
  const c = ctx2d(out);
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(stage, inset.x * size, inset.y * size, inset.width * size, inset.height * size);
  return out;
}

/**
 * Build the provider's mask image from a Pikado coverage mask.
 *
 * Pikado stores 255 = selected. Providers disagree about what a mask means:
 * OpenAI's edit endpoint replaces wherever the mask is *transparent*, most
 * Stable-Diffusion endpoints replace wherever it is *white*, a few use black.
 * The provider descriptor names its convention and this is the only place in the
 * codebase where the difference exists.
 *
 * Two deliberate asymmetries with the layer mask, both of which look like bugs:
 *
 *  - **Hardened at a threshold.** Providers treat masks as binary in practice,
 *    and a feathered edge sent as mid-grey is interpreted inconsistently between
 *    them. The request gets a boundary that cannot be misread; the *result* is
 *    then blended into the document through the original soft coverage, where
 *    Pikado controls the filter. So a feathered selection still feathers.
 *  - **Dilated a few pixels.** Providers reproduce the mask boundary only
 *    approximately. If the request mask and the layer mask were identical, a
 *    one-pixel misalignment would show as a halo of original pixels along the
 *    seam. Overshooting means the generated content runs *under* the layer
 *    mask's edge, where it is harmless.
 *
 * @param {Uint8ClampedArray} coverage document-sized, 255 = fill here
 * @param {number} docWidth
 * @param {number} docHeight
 * @param {FillFrame} frame
 * @param {{polarity?:string, dilate?:number, threshold?:number}} [opts]
 * @returns {HTMLCanvasElement} size x size
 */
export function requestMask(coverage, docWidth, docHeight, frame, opts = {}) {
  const { polarity = 'alpha-holes', dilate = 3, threshold = 128 } = opts;

  const hard = new Uint8ClampedArray(docWidth * docHeight);
  for (let i = 0; i < hard.length; i++) hard[i] = coverage[i] >= threshold ? 255 : 0;
  const grown = dilate > 0 ? morph(hard, docWidth, docHeight, dilate, true) : hard;

  const { crop, size, inset } = frame;
  const holes = polarity === 'alpha-holes';
  const img = new ImageData(crop.width, crop.height);
  const d = img.data;
  for (let y = 0; y < crop.height; y++) {
    const srcRow = (y + crop.y) * docWidth + crop.x;
    const dstRow = y * crop.width;
    for (let x = 0; x < crop.width; x++) {
      const fill = grown[srcRow + x] >= 128;
      const i = (dstRow + x) * 4;
      if (holes) {
        /*
         * Opaque where the hole goes, and punched out below rather than drawn.
         * Staging the holes as transparent and drawing them over an opaque
         * background does not work: drawImage composites source-over, so a
         * transparent source pixel leaves the destination untouched and every
         * hole fills straight back in. Measured: zero holes in a 576-pixel
         * selection. So the stage carries the holes as alpha and
         * `destination-out` subtracts them.
         */
        d[i] = d[i + 1] = d[i + 2] = 0;
        d[i + 3] = fill ? 255 : 0;
      } else {
        const on = polarity === 'black-fills' ? !fill : fill;
        d[i] = d[i + 1] = d[i + 2] = on ? 255 : 0;
        d[i + 3] = 255;
      }
    }
  }
  const stage = createCanvas(crop.width, crop.height);
  ctx2d(stage).putImageData(img, 0, 0);

  const out = createCanvas(size, size);
  const c = ctx2d(out);
  // Outside the crop the answer is always "do not paint here", in whichever
  // convention this provider reads.
  c.fillStyle = polarity === 'black-fills' ? '#ffffff' : '#000000';
  c.fillRect(0, 0, size, size);
  // Smoothing off: a hardened boundary that gets resampled smoothly turns back
  // into the mid-greys the hardening existed to remove.
  c.imageSmoothingEnabled = false;
  if (holes) c.globalCompositeOperation = 'destination-out';
  c.drawImage(stage, inset.x * size, inset.y * size, inset.width * size, inset.height * size);
  c.globalCompositeOperation = 'source-over';
  return out;
}

/**
 * Take the generated square back to crop-sized document pixels.
 *
 * `inset` is fractional, so this is also what makes a size mismatch survivable:
 * a provider that answers 512x512 to a 1024x1024 request still lands in exactly
 * the right document coordinates, merely softer.
 *
 * @param {HTMLImageElement|HTMLCanvasElement} image
 * @param {FillFrame} frame
 * @returns {HTMLCanvasElement}
 */
export function patchFromResult(image, frame) {
  const { crop, inset } = frame;
  const iw = image.width || image.naturalWidth;
  const ih = image.height || image.naturalHeight;
  const out = createCanvas(crop.width, crop.height);
  const c = ctx2d(out);
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(
    image,
    inset.x * iw, inset.y * ih, inset.width * iw, inset.height * ih,
    0, 0, crop.width, crop.height,
  );
  return out;
}

/**
 * A coverage mask as the greyscale RGBA canvas a layer mask wants (white =
 * visible). Built from an array rather than from `doc.selection` because the
 * selection may have changed during a generation that took half a minute.
 *
 * @param {Uint8ClampedArray} coverage
 * @param {number} w
 * @param {number} h
 * @returns {HTMLCanvasElement}
 */
export function maskToGreyCanvas(coverage, w, h) {
  const img = new ImageData(w, h);
  const d = img.data;
  for (let i = 0, p = 0; p < w * h; p++, i += 4) {
    const v = coverage[p];
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  const cv = createCanvas(w, h);
  ctx2d(cv).putImageData(img, 0, 0);
  return cv;
}

/**
 * PNG bytes for a canvas. PNG rather than JPEG because lossy ringing along a
 * mask boundary is the one artefact this feature cannot afford, and the
 * alpha-holes convention needs an alpha channel to exist at all.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<Blob>}
 */
export function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas could not be encoded'))), 'image/png');
  });
}

/** Count of pixels a mask canvas marks as "fill here". Exported for tests. */
export function fillCoverage(canvas, polarity = 'alpha-holes') {
  const { width: w, height: h } = canvas;
  const d = ctx2dRead(canvas).getImageData(0, 0, w, h).data;
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (polarity === 'alpha-holes') { if (d[o + 3] < 128) n++; }
    else if (polarity === 'black-fills') { if (d[o] < 128) n++; }
    else if (d[o] >= 128) n++;
  }
  return n;
}
