import { boxBlurMask } from '../core/selection.js';

/**
 * Edge refinement for selections — the maths behind Select and Mask.
 *
 * Six operations, in the order the workspace applies them, each one a pure
 * function of a coverage mask (and, where it needs to look at the picture, the
 * image):
 *
 *   Radius + Smart Radius   estimate real coverage in a band around the edge
 *   Smooth                  remove staircase and speckle from the contour
 *   Feather                 blur the coverage
 *   Contrast                harden a soft edge back up
 *   Shift Edge              move the contour in or out, sub-pixel
 *   Decontaminate Colours   replace fringe pixels with pure foreground colour
 *
 * The interesting one is Radius, which is alpha matting rather than filtering.
 * Inside the band it stops treating the mask as the answer and asks the picture
 * instead: given the foreground colour and background colour typical of this
 * neighbourhood, what mixture is this pixel? That is what recovers hair and fur,
 * and it is why the band, not the mask, is what the radius controls.
 *
 * Everything here works on `Uint8ClampedArray` coverage of length `w * h`, the
 * same representation `Selection.mask` uses, so results drop straight in.
 */

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** A copy, so every operation can be written non-destructively. */
const copy = (mask) => new Uint8ClampedArray(mask);

/**
 * Pixels within `radius` of the mask's edge.
 *
 * Found by a two-pass chamfer distance transform over the binary mask rather
 * than by dilating in a loop: one pass forward, one back, so the cost is the
 * same whether the radius is 1 or 250. The distances are approximate (3-4
 * chamfer weights, about 2% off true Euclidean), which is far below what any of
 * these controls can express.
 *
 * @returns {{band:Uint8Array, dist:Float32Array}} `band` is 1 inside the band;
 *   `dist` is the signed distance to the edge, negative outside the selection.
 */
export function edgeBand(mask, w, h, radius) {
  const n = w * h;
  const dist = new Float32Array(n);
  const band = new Uint8Array(n);
  const BIG = 1e9;
  const inside = new Float32Array(n);
  const outside = new Float32Array(n);

  // Seed: a pixel next to a differently-labelled pixel is on the edge.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const on = mask[i] > 127;
      let edge = false;
      if (x > 0 && (mask[i - 1] > 127) !== on) edge = true;
      else if (x < w - 1 && (mask[i + 1] > 127) !== on) edge = true;
      else if (y > 0 && (mask[i - w] > 127) !== on) edge = true;
      else if (y < h - 1 && (mask[i + w] > 127) !== on) edge = true;
      inside[i] = on ? (edge ? 0 : BIG) : BIG;
      outside[i] = on ? BIG : (edge ? 0 : BIG);
    }
  }

  const chamfer = (f) => {
    const D1 = 1, D2 = 1.41421356;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let v = f[i];
        if (y > 0) {
          if (f[i - w] + D1 < v) v = f[i - w] + D1;
          if (x > 0 && f[i - w - 1] + D2 < v) v = f[i - w - 1] + D2;
          if (x < w - 1 && f[i - w + 1] + D2 < v) v = f[i - w + 1] + D2;
        }
        if (x > 0 && f[i - 1] + D1 < v) v = f[i - 1] + D1;
        f[i] = v;
      }
    }
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        let v = f[i];
        if (y < h - 1) {
          if (f[i + w] + D1 < v) v = f[i + w] + D1;
          if (x < w - 1 && f[i + w + 1] + D2 < v) v = f[i + w + 1] + D2;
          if (x > 0 && f[i + w - 1] + D2 < v) v = f[i + w - 1] + D2;
        }
        if (x < w - 1 && f[i + 1] + D1 < v) v = f[i + 1] + D1;
        f[i] = v;
      }
    }
  };
  chamfer(inside);
  chamfer(outside);

  for (let i = 0; i < n; i++) {
    const on = mask[i] > 127;
    const d = on ? inside[i] : -outside[i];
    dist[i] = d;
    if (Math.abs(d) <= radius) band[i] = 1;
  }
  return { band, dist };
}

/* ------------------------------------------------------------------ */
/* Radius — alpha matting in the band                                  */
/* ------------------------------------------------------------------ */

/**
 * Re-estimate coverage inside a band around the edge by asking the image what
 * mixture each pixel is.
 *
 * For every band pixel, sample the confident foreground and confident background
 * within a local window, take the mean colour of each, and project the pixel
 * onto the line between them: `alpha = (z - B)·(F - B) / |F - B|²`. That is the
 * closed-form solution to the compositing equation for one foreground and one
 * background colour, and it is exactly right when the window really does contain
 * only two materials — which, in a small enough window, is usually true.
 *
 * When it isn't — the window straddles three colours, or foreground and
 * background are the same colour so `|F - B|` collapses — the estimate is
 * unusable, and the original mask value is kept rather than a confident-looking
 * number being invented. `smart` widens the window where the local gradient is
 * high, which is what Photoshop's Smart Radius does: hair needs a wider window
 * than a shoulder.
 *
 * @param {ImageData} image
 * @param {Uint8ClampedArray} mask
 * @param {number} radius band half-width in pixels
 * @param {object} [opts]
 * @param {boolean} [opts.smart] vary the window with local contrast
 * @returns {Uint8ClampedArray} a new mask
 */
export function refineRadius(image, mask, radius, opts = {}) {
  const w = image.width, h = image.height, n = w * h;
  if (!(radius > 0)) return copy(mask);
  const { smart = false } = opts;
  const d = image.data;
  const out = copy(mask);
  const { band, dist } = edgeBand(mask, w, h, radius);

  // Confident sample sets sit outside the band, so a pixel never learns its
  // foreground colour from another uncertain pixel.
  const confidentFg = new Uint8Array(n);
  const confidentBg = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (band[i]) continue;
    if (mask[i] > 127) confidentFg[i] = 1; else confidentBg[i] = 1;
  }

  // Local gradient magnitude, for Smart Radius.
  let grad = null;
  if (smart) {
    grad = new Float32Array(n);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x, o = i * 4;
        const gx = Math.abs(d[o + 4] - d[o - 4]) + Math.abs(d[o + 5] - d[o - 3]) + Math.abs(d[o + 6] - d[o - 2]);
        const gy = Math.abs(d[o + w * 4] - d[o - w * 4]) + Math.abs(d[o + w * 4 + 1] - d[o - w * 4 + 1])
          + Math.abs(d[o + w * 4 + 2] - d[o - w * 4 + 2]);
        grad[i] = (gx + gy) / 6;
      }
    }
  }

  const base = Math.max(2, Math.round(radius));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!band[i]) continue;

      let win = base;
      if (smart) {
        // High local contrast means fine structure: widen, up to double.
        const t = Math.min(1, grad[i] / 40);
        win = Math.round(base * (1 + t));
      }
      const x0 = Math.max(0, x - win), x1 = Math.min(w - 1, x + win);
      const y0 = Math.max(0, y - win), y1 = Math.min(h - 1, y + win);

      let fr = 0, fg = 0, fb = 0, fn = 0;
      let br = 0, bg = 0, bb = 0, bn = 0;
      for (let sy = y0; sy <= y1; sy++) {
        for (let sx = x0; sx <= x1; sx++) {
          const j = sy * w + sx, o = j * 4;
          if (confidentFg[j]) { fr += d[o]; fg += d[o + 1]; fb += d[o + 2]; fn++; }
          else if (confidentBg[j]) { br += d[o]; bg += d[o + 1]; bb += d[o + 2]; bn++; }
        }
      }
      // Not enough evidence on both sides: leave the pixel as the cut left it.
      if (fn < 3 || bn < 3) continue;

      const F = [fr / fn, fg / fn, fb / fn];
      const B = [br / bn, bg / bn, bb / bn];
      const dr = F[0] - B[0], dg = F[1] - B[1], db = F[2] - B[2];
      const denom = dr * dr + dg * dg + db * db;
      // Foreground and background are the same colour here; no mixture can be
      // recovered, so keep what we had.
      if (denom < 48) continue;

      const o = i * 4;
      const alpha = ((d[o] - B[0]) * dr + (d[o + 1] - B[1]) * dg + (d[o + 2] - B[2]) * db) / denom;
      const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;

      // Blend toward the estimate with distance from the edge, so the band joins
      // the untouched interior smoothly instead of showing its own seam.
      const t = 1 - Math.min(1, Math.abs(dist[i]) / radius);
      out[i] = clamp255(Math.round(mask[i] * (1 - t) + a * 255 * t));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Global refinements                                                  */
/* ------------------------------------------------------------------ */

/**
 * Smooth the contour: a majority filter, which straightens a staircase and
 * removes isolated speckle without softening the edge the way a blur would.
 *
 * The majority vote decides where the contour *is*; the original coverage decides
 * how soft it is. Emitting a hard 0/255 from the vote alone — as this first did —
 * threw away every partial pixel, and because `refineSelection` runs Smooth
 * immediately after the matting pass, a Radius of 40 and a Smooth of 1 silently
 * destroyed the matte the Radius had just recovered. So the vote is only allowed
 * to move a pixel it disagrees with, and agreement keeps whatever coverage was
 * there.
 *
 * @param {number} radius 0..100
 */
export function smoothMask(mask, w, h, radius) {
  if (!(radius > 0)) return copy(mask);
  const r = Math.max(1, Math.round(radius));
  const n = w * h;
  // Integral image of the binary mask, so the window sum is four lookups
  // regardless of radius.
  const sum = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += mask[y * w + x] > 127 ? 1 : 0;
      sum[(y + 1) * (w + 1) + x + 1] = sum[y * (w + 1) + x + 1] + row;
    }
  }
  const out = new Uint8ClampedArray(n);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const on = sum[(y1 + 1) * (w + 1) + x1 + 1] - sum[y0 * (w + 1) + x1 + 1]
        - sum[(y1 + 1) * (w + 1) + x0] + sum[y0 * (w + 1) + x0];
      const i = y * w + x;
      const inside = on * 2 >= area;
      const was = mask[i];
      // Agreement: keep the coverage, partial included. Disagreement: the vote
      // wins, because that is the speckle or staircase being removed.
      out[i] = (inside === (was > 127)) ? was : (inside ? 255 : 0);
    }
  }
  return out;
}

/**
 * The width, in pixels, of a mask's soft transition.
 *
 * Partial-coverage area divided by contour length is a width — but only if the
 * length is measured properly. Counting horizontal sign changes with a wrapped
 * `i - 1` compares the last pixel of one row against the first of the next, which
 * inflates the count on some masks and deflates it on others. Both directions are
 * counted here, within their own rows and columns.
 *
 * Returns 0 for a hard mask, which callers read as "nothing to preserve".
 */
function transitionWidth(mask, w, h) {
  let partial = 0, crossings = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = mask[i];
      if (v > 8 && v < 247) partial++;
      if (x > 0 && (v > 127) !== (mask[i - 1] > 127)) crossings++;
      if (y > 0 && (v > 127) !== (mask[i - w] > 127)) crossings++;
    }
  }
  // Two crossings per contour pixel on average (one per axis), so halve.
  const contour = crossings / 2;
  return contour > 0 ? partial / contour : 0;
}

/**
 * Feather: blur the coverage. `boxBlurMask` runs three box passes, which is a
 * close enough approximation of a Gaussian that the difference is invisible in
 * an 8-bit mask. It *returns* a new mask rather than blurring in place.
 */
export function featherMask(mask, w, h, radius) {
  if (!(radius > 0)) return copy(mask);
  return boxBlurMask(mask, w, h, radius);
}

/**
 * Contrast: push coverage toward 0 and 255 around the midpoint, which hardens an
 * edge that feathering or matting left too soft.
 * @param {number} amount 0..100
 */
export function contrastMask(mask, amount) {
  if (!(amount > 0)) return copy(mask);
  const out = new Uint8ClampedArray(mask.length);
  // At 100 the curve is a step; below that it is a smoothstep whose width
  // shrinks as the amount rises.
  const t = Math.min(100, amount) / 100;
  const width = (1 - t) * 0.5 + 0.001;
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i] / 255;
    let u = (v - 0.5) / (2 * width) + 0.5;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    out[i] = Math.round(255 * u * u * (3 - 2 * u));
  }
  return out;
}

/**
 * Shift Edge: move the contour outward (positive) or inward (negative).
 *
 * Done as a threshold shift on the blurred mask rather than as morphology, so
 * a fraction of a pixel is expressible and a soft edge stays soft. The blur
 * radius scales with the shift because a threshold shift can only move the
 * contour about as far as the blur spread it.
 *
 * @param {number} percent -100..100
 */
export function shiftEdge(mask, w, h, percent) {
  if (!percent) return copy(mask);
  const p = Math.max(-100, Math.min(100, percent)) / 100;
  const spread = Math.max(1, Math.round(Math.abs(p) * 10));
  const blurred = boxBlurMask(mask, w, h, spread);
  // Threshold below the midpoint to grow, above it to shrink.
  const cut = 127.5 - p * 110;
  const out = new Uint8ClampedArray(mask.length);

  /*
   * The shifted contour comes from the blurred copy; the *softness* has to come
   * from the input. Mapping everything through a fixed 24-level ramp — which is
   * what this did first — gave every result the same hardness, so a matted edge
   * with a 20-pixel falloff came back as a 24-level ramp: Shift Edge silently
   * hardened whatever Radius and Feather had produced.
   *
   * The ramp width is therefore taken from the input's own transition width,
   * estimated from how much partial coverage it has. A hard mask keeps a narrow
   * ramp; a soft one keeps its softness.
   */
  const softness = transitionWidth(mask, w, h);
  /*
   * The ramp is in mask levels; the softness is in pixels. A box-blurred mask changes
   * by roughly 255 / (2 * spread) levels per pixel near the contour, so preserving a
   * transition `softness` pixels wide needs a ramp of `softness * 255 / (2 * spread)`
   * levels. That derivation is the point: the first version multiplied the estimate by
   * a magic 26 and clamped at 200, which saturated on almost any soft mask and gave
   * every result the same hardness — the very thing the estimate was added to avoid.
   */
  const ramp = Math.max(12, Math.min(255, (softness * 255) / (2 * spread)));

  for (let i = 0; i < mask.length; i++) {
    const v = (blurred[i] - cut) / ramp + 0.5;
    out[i] = clamp255(Math.round(255 * (v < 0 ? 0 : v > 1 ? 1 : v)));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Colour decontamination                                              */
/* ------------------------------------------------------------------ */

/**
 * Replace the colour of partially selected pixels with an estimate of their pure
 * foreground colour, so a subject cut from a green wall does not keep a green
 * fringe.
 *
 * From the compositing equation `z = αF + (1-α)B`, the foreground colour is
 * `F = (z - (1-α)B) / α`. B comes from the nearby confident background, α from
 * the mask. The result is blended by `amount`, and pixels whose α is too small
 * are left alone — dividing by a coverage of 0.02 amplifies noise by fifty.
 *
 * Mutates `image` in place and returns it, because the caller has just made the
 * copy it wants to keep.
 *
 * @param {ImageData} image
 * @param {Uint8ClampedArray} mask
 * @param {number} amount 0..100
 * @param {{radius?:number}} [opts] band half-width; derived from the mask's own
 *   edge softness when omitted
 */
export function decontaminateColors(image, mask, amount = 100, opts = {}) {
  const w = image.width, h = image.height;
  const d = image.data;
  const strength = Math.max(0, Math.min(100, amount)) / 100;
  if (!strength) return image;

  /*
   * The band and the sampling window scale with the mask's own edge, rather than
   * being fixed at 6 px and 4 px as they first were. A matte with a 30 px falloff —
   * which a Radius of 40 produces, and which is exactly the case that needs
   * decontaminating — had most of its fringe outside a 6 px band, and inside a 4 px
   * window there was often no confident background left to sample, so the pass
   * quietly did nothing on the very edges it exists for.
   *
   * The falloff width is estimated the same way `shiftEdge` estimates it: partial
   * pixels per unit of contour length.
   */
  const falloff = transitionWidth(mask, w, h);
  const bandRadius = Math.max(6, Math.min(48, Math.round(opts.radius || falloff * 1.6)));
  /*
   * The sampling window is capped hard, and separately from the band.
   *
   * It is the inner loop of a per-fringe-pixel search, so its cost is quadratic: at
   * the 51 px an unbounded `bandRadius * 0.8` reached, that is 10,609 samples for
   * every fringe pixel, running synchronously at full document resolution while the
   * Select and Mask preview waits. Twelve pixels is ample — the background it needs
   * is right there across the edge — and caps the inner loop at 625.
   */
  const win = Math.max(4, Math.min(12, Math.round(bandRadius * 0.8)));

  const { band } = edgeBand(mask, w, h, bandRadius);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!band[i]) continue;
      const a = mask[i] / 255;
      if (a < 0.15 || a > 0.98) continue;

      let br = 0, bg = 0, bb = 0, bn = 0;
      const x0 = Math.max(0, x - win), x1 = Math.min(w - 1, x + win);
      const y0 = Math.max(0, y - win), y1 = Math.min(h - 1, y + win);
      for (let sy = y0; sy <= y1; sy++) {
        for (let sx = x0; sx <= x1; sx++) {
          const j = sy * w + sx;
          if (mask[j] > 40) continue;
          const o = j * 4;
          br += d[o]; bg += d[o + 1]; bb += d[o + 2]; bn++;
        }
      }
      if (bn < 3) continue;
      const B = [br / bn, bg / bn, bb / bn];
      const o = i * 4;
      for (let c = 0; c < 3; c++) {
        const pure = (d[o + c] - (1 - a) * B[c]) / a;
        d[o + c] = clamp255(Math.round(d[o + c] * (1 - strength) + pure * strength));
      }
    }
  }
  return image;
}

/* ------------------------------------------------------------------ */
/* The whole pipeline                                                  */
/* ------------------------------------------------------------------ */

/**
 * Apply every refinement in the order Select and Mask presents them.
 *
 * The order is not arbitrary: matting first, because it needs the cut's own
 * confident regions to sample from; then smooth, which wants a hard mask to
 * straighten; then feather and contrast, which are inverses of each other and
 * have to be adjacent for that to be usable; then shift, so it moves the edge
 * the user can actually see.
 *
 * @param {ImageData|null} image required only when `radius > 0`
 * @param {Uint8ClampedArray} mask
 * @param {number} w
 * @param {number} h
 * @param {{radius?:number, smart?:boolean, smooth?:number, feather?:number,
 *   contrast?:number, shift?:number}} p
 * @returns {Uint8ClampedArray} a new mask
 */
export function refineSelection(image, mask, w, h, p = {}) {
  let out = copy(mask);
  if (image && p.radius > 0) out = refineRadius(image, out, p.radius, { smart: !!p.smart });
  if (p.smooth > 0) out = smoothMask(out, w, h, p.smooth);
  if (p.feather > 0) out = featherMask(out, w, h, p.feather);
  if (p.contrast > 0) out = contrastMask(out, p.contrast);
  if (p.shift) out = shiftEdge(out, w, h, p.shift);
  return out;
}
