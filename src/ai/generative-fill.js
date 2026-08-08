import { app } from '../core/app.js';
import { Layer, LayerType } from '../core/layer.js';
import { createCanvas, ctx2d } from '../core/util.js';
import { getComposite } from '../render/compositor.js';
import { planFrame, cropToRequest, requestMask, patchFromResult, maskToGreyCanvas } from './geometry.js';
import { hasCredential } from './credentials.js';
import { hasConsent, hostOf } from './consent.js';
import { GenerationError, GEN_ERRORS, mapThrown } from './errors.js';

/**
 * Generative Fill: the Pikado half.
 *
 * This is the only file under `src/ai/` that knows what a document or a layer is.
 * Everything network- or vendor-shaped lives in `providers/`, and everything
 * pixel-shaped lives in `geometry.js`, so what remains here is the part that has
 * to be right about Pikado's own rules: copy-on-write, document-sized buffers,
 * and exactly one undo step.
 */

/** How long to wait before giving up on a provider, in milliseconds. */
const TIMEOUT_MS = 120000;

/**
 * A layer name from the prompt, because a stack of four attempts is unreadable
 * when every one of them is called "Generative Fill".
 */
export function layerNameFor(prompt) {
  const s = String(prompt || '').trim().replace(/\s+/g, ' ');
  if (!s) return 'Generative Fill';
  if (s.length <= 28) return s;
  const cut = s.slice(0, 28);
  const space = cut.lastIndexOf(' ');
  return `${(space > 12 ? cut.slice(0, space) : cut).trim()}…`;
}

/**
 * Install a generated patch as a new masked layer, in one undo step.
 *
 * No `beginEdit` anywhere, and that is deliberate rather than an oversight:
 * `beginEdit` exists to protect buffers that a history snapshot already shares,
 * and both buffers here were created a moment ago and have never been handed to
 * one. Calling it on the layer *underneath* would be worse than pointless — it
 * would mean something had started compositing in place, which is exactly what
 * this design avoids and what the tests assert against.
 *
 * The whole generated tile is kept and the mask decides what shows. The model
 * paints across the context ring too, and masking that away rather than cropping
 * it off means a user who wants slightly more of it just paints the mask.
 *
 * @param {import('../core/document.js').PikaDocument} doc
 * @param {HTMLCanvasElement} patch crop-sized generated pixels
 * @param {Uint8ClampedArray} coverage the selection as it was when the request went out
 * @param {{prompt: string, crop: {x: number, y: number}}} opts
 * @returns {Layer}
 */
export function applyGeneratedFill(doc, patch, coverage, opts) {
  const canvas = createCanvas(doc.width, doc.height);
  ctx2d(canvas).drawImage(patch, opts.crop.x, opts.crop.y);

  const layer = new Layer({
    type: LayerType.RASTER,
    name: layerNameFor(opts.prompt),
    canvas,
    mask: maskToGreyCanvas(coverage, doc.width, doc.height),
    maskEnabled: true,
  });

  /*
   * Root top, not above the active layer. Photoshop uses the active layer, but
   * the fill was composed against the *flattened* composite — so dropping it
   * inside a group with a blend mode or a group mask would render it differently
   * from the thing the user just approved. select-and-mask.js makes the same
   * call for the same reason.
   */
  doc.addLayer(layer, { above: doc.layers[0] || null });
  doc.commit('Generative Fill');
  return layer;
}

/**
 * Run a generation end to end.
 *
 * The consent check is here rather than in the dialog, so that calling the
 * command directly — from a script, a future keyboard shortcut, or the console —
 * still cannot send anything the user has not agreed to send. It fails closed.
 *
 * @param {import('../core/document.js').PikaDocument} doc
 * @param {{provider: object, prompt: string, signal?: AbortSignal, size?: number}} opts
 * @returns {Promise<Layer>}
 */
export async function runGenerativeFill(doc, opts) {
  const { provider, prompt, signal } = opts;
  if (!provider) throw new GenerationError(GEN_ERRORS.UNKNOWN, 'no provider selected');
  if (provider.needsKey && !hasCredential()) {
    throw new GenerationError(GEN_ERRORS.NO_KEY, '', { provider: provider.name });
  }
  if (provider.endpoint && !hasConsent(hostOf(provider.endpoint))) {
    throw new GenerationError(GEN_ERRORS.NO_CONSENT, '', { provider: provider.name });
  }

  const bounds = doc.selection.bounds();
  if (!bounds || !bounds.width || !bounds.height) {
    throw new GenerationError(GEN_ERRORS.UNKNOWN, 'there is nothing selected to fill');
  }

  // Snapshot everything the request depends on. A generation takes tens of
  // seconds, and the document is fully editable throughout.
  const docWidth = doc.width;
  const docHeight = doc.height;
  const coverage = doc.selection.mask
    ? new Uint8ClampedArray(doc.selection.mask)
    : new Uint8ClampedArray(docWidth * docHeight).fill(255);

  const size = opts.size || (provider.sizes && provider.sizes[0]) || 1024;
  const frame = planFrame(bounds, docWidth, docHeight, { size });
  const image = cropToRequest(getComposite(doc), frame);
  const mask = requestMask(coverage, docWidth, docHeight, frame, { polarity: provider.maskPolarity });

  const timer = new AbortController();
  const onAbort = () => timer.abort(signal.reason);
  if (signal) {
    if (signal.aborted) throw new GenerationError(GEN_ERRORS.ABORTED, '', { provider: provider.name });
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timeout = setTimeout(() => timer.abort(new DOMException('timeout', 'TimeoutError')), TIMEOUT_MS);

  let result;
  try {
    result = await provider.generate({ prompt, image, mask, size, signal: timer.signal });
  } catch (err) {
    throw mapThrown(err, provider.name);
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  if (!result || !result.image) {
    throw new GenerationError(GEN_ERRORS.BAD_RESPONSE, 'no image came back', { provider: provider.name });
  }

  /*
   * The document may have been resized, or closed, while we were waiting. A
   * buffer built for the old size would violate the document-sized rule silently,
   * so nothing is committed and the user is told plainly rather than left with a
   * layer that does not line up.
   */
  if (doc.width !== docWidth || doc.height !== docHeight || !app.docs.includes(doc)) {
    throw new GenerationError(GEN_ERRORS.UNKNOWN, 'the document changed while the fill was generating — nothing was added');
  }

  const rw = result.image.width || result.image.naturalWidth;
  const rh = result.image.height || result.image.naturalHeight;
  // A different *size* is survivable, because `inset` is fractional — it just
  // comes back softer. A different *aspect* makes the geometry meaningless.
  if (rw && rh && Math.abs(rw / rh - 1) > 0.02) {
    throw new GenerationError(
      GEN_ERRORS.BAD_RESPONSE,
      `a ${rw} x ${rh} image was returned for a square request`,
      { provider: provider.name },
    );
  }
  if (rw && rw < size) {
    app.toast(`${provider.name} returned ${rw}x${rh} instead of ${size}x${size}; the fill will be softer.`, 'warn', 4000);
  }

  const patch = patchFromResult(result.image, frame);
  return applyGeneratedFill(doc, patch, coverage, { prompt, crop: frame.crop });
}
