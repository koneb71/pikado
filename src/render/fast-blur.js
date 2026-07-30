import { createCanvas, ctx2dRead } from '../core/util.js';

/**
 * GPU-accelerated Gaussian blur.
 *
 * The browser's own `ctx.filter = 'blur(Npx)'` is a true Gaussian run on the
 * GPU. On a 12 MP image it costs ~1 ms, versus ~1400 ms for the equivalent
 * three-pass box blur in JS — the JS version is memory-bandwidth bound, not
 * algorithmically wrong. Round-tripping through ImageData adds ~50 ms, still
 * roughly 30x faster end to end.
 *
 * CSS `blur(Npx)` uses N as the standard deviation, which matches the sigma
 * convention the JS path already used, so results line up.
 *
 * One behavioural wrinkle: CSS blur treats everything outside the canvas as
 * transparent black, which fades the edges of an opaque image. The JS path
 * clamped instead. We replicate the edge pixels into a padded border first so
 * the two agree.
 */

let _supported = null;

/** Whether this browser implements Canvas2D filters. */
export function supportsCanvasFilter() {
  if (_supported !== null) return _supported;
  try {
    const c = createCanvas(1, 1).getContext('2d');
    c.filter = 'blur(1px)';
    _supported = c.filter === 'blur(1px)';
  } catch {
    _supported = false;
  }
  return _supported;
}

/** Below this many pixels the JS path is fast enough that the round trip wins nothing. */
const GPU_MIN_PIXELS = 90000; // ~300x300

/** Pad a canvas by `pad` px on every side, replicating the edge pixels. */
function padWithEdgeClamp(src, pad) {
  const w = src.width, h = src.height;
  const out = createCanvas(w + pad * 2, h + pad * 2);
  const c = out.getContext('2d');
  c.drawImage(src, pad, pad);
  if (pad > 0) {
    // Edges: stretch the outermost row/column outward.
    c.drawImage(src, 0, 0, w, 1, pad, 0, w, pad);
    c.drawImage(src, 0, h - 1, w, 1, pad, pad + h, w, pad);
    c.drawImage(src, 0, 0, 1, h, 0, pad, pad, h);
    c.drawImage(src, w - 1, 0, 1, h, pad + w, pad, pad, h);
    // Corners: stretch the single corner pixel.
    c.drawImage(src, 0, 0, 1, 1, 0, 0, pad, pad);
    c.drawImage(src, w - 1, 0, 1, 1, pad + w, 0, pad, pad);
    c.drawImage(src, 0, h - 1, 1, 1, 0, pad + h, pad, pad);
    c.drawImage(src, w - 1, h - 1, 1, 1, pad + w, pad + h, pad, pad);
  }
  return out;
}

/**
 * Blur a canvas, returning a new canvas of the same size.
 * @param {HTMLCanvasElement} src
 * @param {number} sigma standard deviation in px
 * @param {boolean} [clampEdges] replicate edge pixels instead of fading to transparent
 */
export function blurCanvas(src, sigma, clampEdges = true) {
  const w = src.width, h = src.height;
  if (!(sigma > 0.05)) {
    const copy = createCanvas(w, h);
    copy.getContext('2d').drawImage(src, 0, 0);
    return copy;
  }
  const pad = clampEdges ? Math.min(512, Math.ceil(sigma * 3) + 1) : 0;
  const padded = pad ? padWithEdgeClamp(src, pad) : src;

  const blurred = createCanvas(padded.width, padded.height);
  const bc = blurred.getContext('2d');
  bc.filter = `blur(${sigma}px)`;
  bc.drawImage(padded, 0, 0);
  bc.filter = 'none';

  if (!pad) return blurred;
  const out = createCanvas(w, h);
  out.getContext('2d').drawImage(blurred, pad, pad, w, h, 0, 0, w, h);
  return out;
}

/**
 * Blur ImageData in place. Returns the same ImageData for convenience.
 * Falls back to `jsFallback(imageData, sigma)` when Canvas2D filters are
 * unavailable or the image is too small for the round trip to pay off.
 *
 * @param {ImageData} imageData
 * @param {number} sigma
 * @param {(imageData:ImageData, sigma:number)=>void} [jsFallback]
 */
export function blurImageData(imageData, sigma, jsFallback) {
  const w = imageData.width, h = imageData.height;
  if (!(sigma > 0.05)) return imageData;
  if (!supportsCanvasFilter() || w * h < GPU_MIN_PIXELS) {
    if (jsFallback) jsFallback(imageData, sigma);
    return imageData;
  }
  const src = createCanvas(w, h);
  src.getContext('2d').putImageData(imageData, 0, 0);
  const blurred = blurCanvas(src, sigma, true);
  const res = ctx2dRead(blurred).getImageData(0, 0, w, h);
  imageData.data.set(res.data);
  return imageData;
}

/**
 * Blur a Float32 alpha field (0..255) as used by the layer-effect renderers.
 * Returns a new Float32Array.
 *
 * @param {Float32Array} alpha
 * @param {(alpha:Float32Array,w:number,h:number,sigma:number)=>Float32Array} [jsFallback]
 */
export function blurAlphaField(alpha, w, h, sigma, jsFallback) {
  if (!(sigma > 0.05)) return alpha;
  if (!supportsCanvasFilter() || w * h < GPU_MIN_PIXELS) {
    return jsFallback ? jsFallback(alpha, w, h, sigma) : alpha;
  }
  const img = new ImageData(w, h);
  const d = img.data;
  for (let i = 0, p = 0; p < w * h; p++, i += 4) {
    // Store the field in alpha only; RGB stays 0 so premultiplication is a no-op.
    d[i + 3] = alpha[p] < 0 ? 0 : alpha[p] > 255 ? 255 : alpha[p];
  }
  const src = createCanvas(w, h);
  src.getContext('2d').putImageData(img, 0, 0);
  // A shadow/glow field must fade to nothing outside the layer, so no clamping.
  const blurred = blurCanvas(src, sigma, false);
  const res = ctx2dRead(blurred).getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h);
  for (let i = 3, p = 0; p < w * h; p++, i += 4) out[p] = res[i];
  return out;
}
