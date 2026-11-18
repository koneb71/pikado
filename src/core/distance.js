/**
 * Exact Euclidean distance transforms.
 *
 * Spread, Choke, Stroke, Inner Glow, Bevel and Select and Mask's edge band all
 * need "how far is this pixel from the nearest pixel of that set". They used
 * to share a two-pass chamfer — distances of 1 and 1.414 to the eight
 * neighbours, summed along a path — which is cheap but reads diagonal and
 * knight-move distances up to 8% long (it says 2.414 for a step of (2, 1),
 * whose true length is 2.236), so a stroke's corners came out visibly
 * octagonal. It is also inherently sequential: every pixel waits for the one
 * before it, so it cannot run on a GPU.
 *
 * This is Felzenszwalb and Huttenlocher's exact transform ("Distance
 * Transforms of Sampled Functions", 2012). The squared distance is separable:
 *
 *   1. down each column, the distance to the nearest seed in that column;
 *   2. along each row, the lower envelope of the parabolas (x - q)^2 + g(q)^2.
 *
 * Both passes work on one line at a time, cost O(pixels) whatever the radius,
 * and give the squared distance to the nearest seed *exactly* — an integer —
 * so the WebGPU version in src/render/gpu-distance.js, which does the same two
 * passes line-parallel, agrees with this one to the last bit wherever its
 * bounded search reaches.
 */

/** What the fields hold where no seed exists at all — far enough to read as "never". */
export const NO_SEED = 1e9;

/**
 * Distance from every pixel centre to the nearest seed's centre.
 *
 * @param {Uint8Array|Uint8ClampedArray} seed  non-zero marks a seed pixel
 * @param {number} w
 * @param {number} h
 * @returns {Float32Array} distances in pixels: 0 on seeds, NO_SEED everywhere
 *   when there are no seeds
 */
export function distanceField(seed, w, h) {
  const n = w * h;
  const out = new Float32Array(n);
  // Pass 1, per column: the vertical distance to the nearest seed in the
  // column (Infinity when the column has none). Stored in `out` for now.
  for (let x = 0; x < w; x++) {
    let last = -Infinity;
    for (let y = 0, i = x; y < h; y++, i += w) {
      if (seed[i]) last = y;
      out[i] = y - last;
    }
    last = Infinity;
    for (let y = h - 1, i = x + (h - 1) * w; y >= 0; y--, i -= w) {
      if (seed[i]) last = y;
      const below = last - y;
      if (below < out[i]) out[i] = below;
    }
  }

  // Pass 2, per row: the lower envelope of the parabolas
  // (x - q)^2 + g(q)^2 over the columns q that have a seed at all.
  const f = new Float64Array(w); // g(q)^2 for this row
  const v = new Int32Array(w);   // columns of the parabolas in the envelope
  const z = new Float64Array(w + 1); // where each parabola takes over
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let q = 0; q < w; q++) {
      const g = out[row + q];
      f[q] = g * g;
    }
    let k = -1;
    for (let q = 0; q < w; q++) {
      const fq = f[q];
      if (fq === Infinity) continue;
      if (k < 0) {
        k = 0; v[0] = q; z[0] = -Infinity; z[1] = Infinity;
        continue;
      }
      let s;
      for (;;) {
        const p = v[k];
        // Where parabola q overtakes parabola p. The values are integers well
        // inside float64's exact range, so no comparison here is ever wrong.
        s = ((fq + q * q) - (f[p] + p * p)) / (2 * (q - p));
        if (s <= z[k]) k--; else break;
      }
      k++;
      v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    if (k < 0) {
      for (let q = 0; q < w; q++) out[row + q] = NO_SEED;
      continue;
    }
    k = 0;
    for (let q = 0; q < w; q++) {
      while (z[k + 1] < q) k++;
      const p = v[k];
      out[row + q] = Math.sqrt((q - p) * (q - p) + f[p]);
    }
  }
  return out;
}

/**
 * Seeds where a field is above (`inside = true`) or at most (`false`) its 50%
 * level — the binarisation every caller of the transform starts from.
 */
export function seedsFromField(field, w, h, inside = true) {
  const n = w * h;
  const seed = new Uint8Array(n);
  if (inside) { for (let i = 0; i < n; i++) seed[i] = field[i] > 127 ? 1 : 0; }
  else { for (let i = 0; i < n; i++) seed[i] = field[i] > 127 ? 0 : 1; }
  return seed;
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * Grow (`amount > 0`) or shrink an alpha field by `|amount|` pixels about its
 * 50% level, with a one-pixel ramp so the edge stays antialiased. Spread,
 * Choke and every Stroke position are built from this.
 */
export function spreadField(alpha, w, h, amount) {
  if (!amount) return alpha;
  const grow = amount > 0;
  const rad = Math.abs(amount);
  // Growing measures from the shape; shrinking measures from its outside.
  const d = distanceField(seedsFromField(alpha, w, h, grow), w, h);
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const t = grow ? rad - d[i] : d[i] - rad;
    out[i] = clamp255((t + 0.5) * 255);
  }
  return out;
}

/**
 * Signed distance to the shape's edge in pixels: positive inside, negative
 * outside. Pixels within 1.5 px of the border take their distance from their
 * coverage instead, which keeps antialiased edges sub-pixel accurate.
 */
export function signedDistance(alpha, w, h) {
  const n = w * h;
  // din: from an inside pixel to the nearest outside one; dout the reverse.
  const din = distanceField(seedsFromField(alpha, w, h, false), w, h);
  const dout = distanceField(seedsFromField(alpha, w, h, true), w, h);
  const sd = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (din[i] <= 1.5 && dout[i] <= 1.5) sd[i] = alpha[i] / 255 - 0.5;
    else sd[i] = din[i] > 0 ? din[i] - 0.5 : 0.5 - dout[i];
  }
  return sd;
}
