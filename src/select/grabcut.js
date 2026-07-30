import { MaxFlow } from './maxflow.js';

/**
 * GrabCut — iterated graph-cut segmentation with Gaussian mixture colour models.
 *
 * The honest answer to "Select Subject". Photoshop's version runs a trained
 * neural network; this runs the classical algorithm the literature calls GrabCut
 * (Rother, Kolmogorov & Blake, 2004), which is not a smaller model — it is a
 * different kind of thing entirely. It builds a five-component Gaussian mixture
 * over the colours you have marked as foreground and another over the
 * background, turns "which label is cheaper here, and do my neighbours agree"
 * into a flow network, and takes the minimum cut. Then it refits both mixtures
 * from the result and does it again.
 *
 * What that means in practice, stated plainly because it sets expectations:
 *
 *  - it finds the boundary between two *colour distributions*, so a subject that
 *    shares its palette with the background will not separate cleanly no matter
 *    how many iterations run;
 *  - it has no idea what a person, a cat or a bottle is, so `selectSubject` is a
 *    saliency guess followed by the same cut — good on a clear subject against a
 *    distinguishable background, and honestly not magic;
 *  - it is deterministic, inspectable, and needs no model weights or network.
 *
 * Brush a few strokes with the Select and Mask refine tools and it gets much
 * better, which is exactly how GrabCut is meant to be used.
 *
 * Performance: the cut runs on a downscaled copy (a quarter-megapixel by
 * default) and the result is scaled back up. A min-cut is superlinear in the
 * node count, and at full resolution a 12 MP image would take minutes; the
 * boundary detail that the downscale costs is put back by the matting pass in
 * `src/select/refine.js`, which works at full resolution in a narrow band.
 */

/* ------------------------------------------------------------------ */
/* Trimap                                                             */
/* ------------------------------------------------------------------ */

/**
 * Per-pixel labels. The two "maybe" states are what the algorithm is allowed to
 * change; the two definite ones are hard constraints it must respect.
 */
export const TRIMAP = {
  BG: 0,
  FG: 1,
  MAYBE_BG: 2,
  MAYBE_FG: 3,
};

const isFgLabel = (v) => v === TRIMAP.FG || v === TRIMAP.MAYBE_FG;

/** Components per mixture — the value the original paper settles on. */
const COMPONENTS = 5;

/** Smoothness weight. 50 is the standard value and behaves well at 8-bit. */
const GAMMA = 50;

/** Variance floor, in squared 8-bit units, so a flat cluster stays invertible. */
const VARIANCE_FLOOR = 4;

/* ------------------------------------------------------------------ */
/* Gaussian mixture                                                    */
/* ------------------------------------------------------------------ */

/**
 * A three-channel Gaussian mixture, fitted by hard assignment.
 *
 * Full expectation-maximisation would weight every pixel by its responsibility
 * to every component; GrabCut instead assigns each pixel to its single best
 * component and refits, which is what the paper specifies and is both faster and
 * stabler on quantised 8-bit colour.
 */
class GMM {
  constructor(k = COMPONENTS) {
    this.k = k;
    this.weight = new Float64Array(k);
    this.mean = new Float64Array(k * 3);
    /** Row-major 3x3 per component. */
    this.cov = new Float64Array(k * 9);
    this.inv = new Float64Array(k * 9);
    this.detRoot = new Float64Array(k);
    this.count = new Int32Array(k);
  }

  /**
   * Fit from a sample list.
   * @param {Uint8Array|Uint8ClampedArray} rgb interleaved RGB(A) samples
   * @param {Int32Array} idx pixel indices to use
   * @param {number} used how many entries of `idx` are valid
   * @param {Int32Array} comp per-pixel component assignment (written when seeding)
   * @param {boolean} seed true to k-means-seed the assignment first
   */
  fit(rgb, idx, used, comp, seed) {
    if (used === 0) {
      // No samples at all: one wide component, so the data term is finite and
      // uninformative rather than infinite.
      this.weight.fill(0);
      this.weight[0] = 1;
      this.mean.fill(128);
      for (let c = 0; c < this.k; c++) {
        this.cov.fill(0, c * 9, c * 9 + 9);
        for (let d = 0; d < 3; d++) this.cov[c * 9 + d * 4] = 128 * 128;
      }
      this._invert();
      return;
    }
    if (seed) this._kmeans(rgb, idx, used, comp);

    const sum = new Float64Array(this.k * 3);
    const prod = new Float64Array(this.k * 9);
    this.count.fill(0);
    for (let t = 0; t < used; t++) {
      const p = idx[t];
      const c = comp[p];
      const o = p * 4;
      const r = rgb[o], g = rgb[o + 1], b = rgb[o + 2];
      this.count[c]++;
      sum[c * 3] += r; sum[c * 3 + 1] += g; sum[c * 3 + 2] += b;
      const q = c * 9;
      prod[q] += r * r; prod[q + 1] += r * g; prod[q + 2] += r * b;
      prod[q + 3] += g * r; prod[q + 4] += g * g; prod[q + 5] += g * b;
      prod[q + 6] += b * r; prod[q + 7] += b * g; prod[q + 8] += b * b;
    }

    for (let c = 0; c < this.k; c++) {
      const n = this.count[c];
      this.weight[c] = n / used;
      if (n === 0) {
        this.cov.fill(0, c * 9, c * 9 + 9);
        for (let d = 0; d < 3; d++) this.cov[c * 9 + d * 4] = VARIANCE_FLOOR;
        continue;
      }
      const m = [sum[c * 3] / n, sum[c * 3 + 1] / n, sum[c * 3 + 2] / n];
      this.mean[c * 3] = m[0]; this.mean[c * 3 + 1] = m[1]; this.mean[c * 3 + 2] = m[2];
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) {
          let v = prod[c * 9 + a * 3 + b] / n - m[a] * m[b];
          if (a === b) v += VARIANCE_FLOOR;
          this.cov[c * 9 + a * 3 + b] = v;
        }
      }
    }
    this._invert();
  }

  /** k-means++ seeding followed by a few Lloyd iterations. */
  _kmeans(rgb, idx, used, comp) {
    const k = this.k;
    const centres = new Float64Array(k * 3);
    // Deterministic spread: pick the first sample, then repeatedly the sample
    // furthest from everything chosen so far. No RNG, so results are repeatable
    // (and `Math.random` is unavailable to workflow scripts anyway).
    const first = idx[0] * 4;
    centres[0] = rgb[first]; centres[1] = rgb[first + 1]; centres[2] = rgb[first + 2];
    for (let c = 1; c < k; c++) {
      let bestD = -1, bestP = idx[0];
      const step = Math.max(1, Math.floor(used / 4096));   // sample, for speed
      for (let t = 0; t < used; t += step) {
        const o = idx[t] * 4;
        let near = Infinity;
        for (let j = 0; j < c; j++) {
          const dr = rgb[o] - centres[j * 3];
          const dg = rgb[o + 1] - centres[j * 3 + 1];
          const db = rgb[o + 2] - centres[j * 3 + 2];
          const d = dr * dr + dg * dg + db * db;
          if (d < near) near = d;
        }
        if (near > bestD) { bestD = near; bestP = idx[t]; }
      }
      const o = bestP * 4;
      centres[c * 3] = rgb[o]; centres[c * 3 + 1] = rgb[o + 1]; centres[c * 3 + 2] = rgb[o + 2];
    }

    const sum = new Float64Array(k * 3);
    const cnt = new Int32Array(k);
    for (let iter = 0; iter < 8; iter++) {
      sum.fill(0); cnt.fill(0);
      for (let t = 0; t < used; t++) {
        const p = idx[t], o = p * 4;
        let best = 0, bestD = Infinity;
        for (let c = 0; c < k; c++) {
          const dr = rgb[o] - centres[c * 3];
          const dg = rgb[o + 1] - centres[c * 3 + 1];
          const db = rgb[o + 2] - centres[c * 3 + 2];
          const d = dr * dr + dg * dg + db * db;
          if (d < bestD) { bestD = d; best = c; }
        }
        comp[p] = best;
        cnt[best]++;
        sum[best * 3] += rgb[o]; sum[best * 3 + 1] += rgb[o + 1]; sum[best * 3 + 2] += rgb[o + 2];
      }
      let moved = 0;
      for (let c = 0; c < k; c++) {
        if (!cnt[c]) continue;
        for (let d = 0; d < 3; d++) {
          const next = sum[c * 3 + d] / cnt[c];
          moved += Math.abs(next - centres[c * 3 + d]);
          centres[c * 3 + d] = next;
        }
      }
      if (moved < 0.5) break;
    }
  }

  /** Invert every covariance, caching sqrt(det) for the likelihood. */
  _invert() {
    for (let c = 0; c < this.k; c++) {
      const q = c * 9;
      const a = this.cov[q], b = this.cov[q + 1], d = this.cov[q + 2];
      const e = this.cov[q + 3], f = this.cov[q + 4], g = this.cov[q + 5];
      const h = this.cov[q + 6], i = this.cov[q + 7], j = this.cov[q + 8];
      const A = f * j - g * i, B = g * h - e * j, C = e * i - f * h;
      let det = a * A + b * B + d * C;
      if (!(det > 1e-9)) {
        // Degenerate cluster: fall back to an isotropic covariance rather than
        // producing NaN likelihoods that would poison every data term.
        this.cov.fill(0, q, q + 9);
        for (let n = 0; n < 3; n++) this.cov[q + n * 4] = VARIANCE_FLOOR;
        this.inv.fill(0, q, q + 9);
        for (let n = 0; n < 3; n++) this.inv[q + n * 4] = 1 / VARIANCE_FLOOR;
        this.detRoot[c] = Math.sqrt(VARIANCE_FLOOR ** 3);
        continue;
      }
      const k = 1 / det;
      this.inv[q] = A * k;
      this.inv[q + 1] = (d * i - b * j) * k;
      this.inv[q + 2] = (b * g - d * f) * k;
      this.inv[q + 3] = B * k;
      this.inv[q + 4] = (a * j - d * h) * k;
      this.inv[q + 5] = (d * e - a * g) * k;
      this.inv[q + 6] = C * k;
      this.inv[q + 7] = (b * h - a * i) * k;
      this.inv[q + 8] = (a * f - b * e) * k;
      this.detRoot[c] = Math.sqrt(det);
    }
  }

  /** Unnormalised likelihood of one component. */
  componentProb(c, r, g, b) {
    if (this.weight[c] <= 0) return 0;
    const q = c * 9;
    const dr = r - this.mean[c * 3];
    const dg = g - this.mean[c * 3 + 1];
    const db = b - this.mean[c * 3 + 2];
    const m = dr * (this.inv[q] * dr + this.inv[q + 1] * dg + this.inv[q + 2] * db)
      + dg * (this.inv[q + 3] * dr + this.inv[q + 4] * dg + this.inv[q + 5] * db)
      + db * (this.inv[q + 6] * dr + this.inv[q + 7] * dg + this.inv[q + 8] * db);
    return Math.exp(-0.5 * m) / this.detRoot[c];
  }

  /** Mixture likelihood. */
  prob(r, g, b) {
    let s = 0;
    for (let c = 0; c < this.k; c++) s += this.weight[c] * this.componentProb(c, r, g, b);
    return s;
  }

  /** The component a colour belongs to. */
  bestComponent(r, g, b) {
    let best = 0, bestP = -1;
    for (let c = 0; c < this.k; c++) {
      const p = this.componentProb(c, r, g, b);
      if (p > bestP) { bestP = p; best = c; }
    }
    return best;
  }
}

/* ------------------------------------------------------------------ */
/* The segmentation                                                    */
/* ------------------------------------------------------------------ */

/**
 * Mean squared colour difference between neighbours, which sets how strongly the
 * smoothness term reacts to an edge. Computed from the image rather than fixed,
 * so a flat studio shot and a noisy night shot both behave.
 */
function computeBeta(data, w, h) {
  let total = 0, n = 0;
  const diff = (i, j) => {
    const dr = data[i] - data[j], dg = data[i + 1] - data[j + 1], db = data[i + 2] - data[j + 2];
    return dr * dr + dg * dg + db * db;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (x > 0) { total += diff(i, i - 4); n++; }
      if (y > 0) { total += diff(i, i - w * 4); n++; }
      if (x > 0 && y > 0) { total += diff(i, i - w * 4 - 4); n++; }
      if (x < w - 1 && y > 0) { total += diff(i, i - w * 4 + 4); n++; }
    }
  }
  if (!n || total <= 0) return 0;
  return 1 / (2 * (total / n));
}

/**
 * One graph-cut pass over the current mixtures.
 * @returns {number} how many pixels changed label
 */
function cutOnce(data, w, h, trimap, fg, bg, comp, beta, diagW) {
  const n = w * h;
  const flow = new MaxFlow(n, n * 8);

  // Smoothness first, so the hard-constraint weight can dominate the largest
  // total any single node accumulates.
  const nodeSum = new Float64Array(n);
  const edge = (a, b, weight) => {
    flow.addEdge(a, b, weight, weight);
    nodeSum[a] += weight;
    nodeSum[b] += weight;
  };
  const link = (ai, bi, dist) => {
    const a = ai * 4, b = bi * 4;
    const dr = data[a] - data[b], dg = data[a + 1] - data[b + 1], db = data[a + 2] - data[b + 2];
    const d2 = dr * dr + dg * dg + db * db;
    edge(ai, bi, (GAMMA / dist) * Math.exp(-beta * d2));
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x > 0) link(i, i - 1, 1);
      if (y > 0) link(i, i - w, 1);
      if (diagW) {
        if (x > 0 && y > 0) link(i, i - w - 1, Math.SQRT2);
        if (x < w - 1 && y > 0) link(i, i - w + 1, Math.SQRT2);
      }
    }
  }

  let hard = 1;
  for (let i = 0; i < n; i++) if (nodeSum[i] > hard) hard = nodeSum[i];
  hard = 1 + hard * 2;

  for (let i = 0; i < n; i++) {
    const t = trimap[i];
    if (t === TRIMAP.FG) { flow.addTerminal(i, hard, 0); continue; }
    if (t === TRIMAP.BG) { flow.addTerminal(i, 0, hard); continue; }
    const o = i * 4;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    // Cutting the *source* arc labels a pixel background, so its cost is the
    // background model's — this orientation is the one that is easy to flip.
    const pBg = bg.prob(r, g, b);
    const pFg = fg.prob(r, g, b);
    const toSource = -Math.log(Math.max(pBg, 1e-30));
    const toSink = -Math.log(Math.max(pFg, 1e-30));
    flow.addTerminal(i, Math.min(toSource, hard), Math.min(toSink, hard));
  }

  flow.compute();

  let changed = 0;
  for (let i = 0; i < n; i++) {
    const t = trimap[i];
    if (t === TRIMAP.FG || t === TRIMAP.BG) continue;
    const next = flow.inSource(i) ? TRIMAP.MAYBE_FG : TRIMAP.MAYBE_BG;
    if (next !== t) { trimap[i] = next; changed++; }
  }
  return changed;
}

/**
 * Run GrabCut.
 *
 * @param {ImageData} image the (already downscaled) image to segment
 * @param {Uint8Array} trimap one `TRIMAP` value per pixel, modified in place
 * @param {object} [opts]
 * @param {number} [opts.iterations] mixture refits; 3 is usually enough
 * @param {boolean} [opts.diagonals] use 8-connectivity (smoother, ~2x slower)
 * @param {(f:number)=>void} [opts.onProgress] 0..1
 * @returns {{mask:Uint8ClampedArray, iterations:number, changed:number}}
 *   `mask` is 0 or 255 per pixel
 */
export function grabcut(image, trimap, opts = {}) {
  const { iterations = 3, diagonals = true, onProgress = null } = opts;
  const w = image.width, h = image.height;
  const n = w * h;
  const data = image.data;

  const fg = new GMM();
  const bg = new GMM();
  const comp = new Int32Array(n);
  const fgIdx = new Int32Array(n);
  const bgIdx = new Int32Array(n);

  const beta = computeBeta(data, w, h);
  let changed = 0;
  let ran = 0;

  for (let iter = 0; iter < iterations; iter++) {
    let nf = 0, nb = 0;
    for (let i = 0; i < n; i++) {
      if (isFgLabel(trimap[i])) fgIdx[nf++] = i;
      else bgIdx[nb++] = i;
    }
    // Seed the component assignment on the first pass only; afterwards each
    // pixel keeps looking up its own best component, which is what makes the
    // iteration converge instead of oscillating.
    if (iter === 0) {
      fg.fit(data, fgIdx, nf, comp, true);
      bg.fit(data, bgIdx, nb, comp, true);
    } else {
      for (let t = 0; t < nf; t++) {
        const p = fgIdx[t], o = p * 4;
        comp[p] = fg.bestComponent(data[o], data[o + 1], data[o + 2]);
      }
      for (let t = 0; t < nb; t++) {
        const p = bgIdx[t], o = p * 4;
        comp[p] = bg.bestComponent(data[o], data[o + 1], data[o + 2]);
      }
      fg.fit(data, fgIdx, nf, comp, false);
      bg.fit(data, bgIdx, nb, comp, false);
    }

    changed = cutOnce(data, w, h, trimap, fg, bg, comp, beta, diagonals);
    ran = iter + 1;
    if (onProgress) onProgress(ran / iterations);
    // Converged: another refit would produce the same cut.
    if (changed === 0) break;
  }

  const mask = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) mask[i] = isFgLabel(trimap[i]) ? 255 : 0;
  return { mask, iterations: ran, changed };
}

/* ------------------------------------------------------------------ */
/* Saliency, for an unattended first guess                             */
/* ------------------------------------------------------------------ */

/**
 * Histogram-contrast saliency: how unusual each colour is in the image as a
 * whole, weighted toward the centre.
 *
 * This is the Cheng et al. HC measure — quantise colour into a coarse
 * histogram, then score each bin by its distance to every other bin weighted by
 * that bin's frequency. A colour that dominates the frame scores low; a colour
 * that appears rarely against a common background scores high. It is a
 * *statistic*, not an object detector, and behaves accordingly: it finds the
 * unusual thing, which is usually but not always the subject.
 *
 * @returns {Float32Array} 0..1 per pixel
 */
export function saliencyMap(image) {
  const w = image.width, h = image.height, n = w * h;
  const d = image.data;
  const BINS = 12;                       // 12^3 = 1728 bins
  const SHIFT = 256 / BINS;
  const hist = new Float64Array(BINS ** 3);
  const bin = new Int32Array(n);

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = Math.min(BINS - 1, (d[o] / SHIFT) | 0);
    const g = Math.min(BINS - 1, (d[o + 1] / SHIFT) | 0);
    const b = Math.min(BINS - 1, (d[o + 2] / SHIFT) | 0);
    const k = (r * BINS + g) * BINS + b;
    bin[i] = k;
    hist[k]++;
  }

  // Only bins that actually occur take part, which keeps the pairwise loop to
  // the few hundred colours a real photograph uses.
  const used = [];
  for (let k = 0; k < hist.length; k++) if (hist[k] > 0) used.push(k);
  const centre = used.map((k) => {
    const b = k % BINS, g = ((k / BINS) | 0) % BINS, r = ((k / (BINS * BINS)) | 0) % BINS;
    return [(r + 0.5) * SHIFT, (g + 0.5) * SHIFT, (b + 0.5) * SHIFT];
  });

  const score = new Float64Array(hist.length);
  for (let a = 0; a < used.length; a++) {
    let s = 0;
    for (let b = 0; b < used.length; b++) {
      if (a === b) continue;
      const dr = centre[a][0] - centre[b][0];
      const dg = centre[a][1] - centre[b][1];
      const db = centre[a][2] - centre[b][2];
      s += hist[used[b]] * Math.sqrt(dr * dr + dg * dg + db * db);
    }
    score[used[a]] = s / n;
  }

  let lo = Infinity, hi = -Infinity;
  for (const k of used) { if (score[k] < lo) lo = score[k]; if (score[k] > hi) hi = score[k]; }
  const span = hi - lo > 1e-9 ? hi - lo : 1;

  // Centre prior: photographers put subjects near the middle, and the border is
  // background far more often than not.
  const out = new Float32Array(n);
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const rx = Math.max(1, cx), ry = Math.max(1, cy);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      const prior = Math.exp(-1.2 * (dx * dx + dy * dy));
      out[i] = ((score[bin[i]] - lo) / span) * prior;
    }
  }
  return out;
}

/**
 * A trimap guessed from saliency alone — the seed behind Select Subject.
 *
 * The border ring is marked definite background (a subject touching all four
 * edges is not a subject), the most salient pixels definite foreground, and
 * everything between is left for the cut to decide. When saliency finds nothing
 * confident enough, the foreground seed is dropped rather than invented: GrabCut
 * copes with an empty definite-foreground set, and a wrong hard constraint is far
 * worse than none.
 *
 * @returns {{trimap:Uint8Array, confident:boolean}}
 */
export function autoTrimap(image, opts = {}) {
  const w = image.width, h = image.height, n = w * h;
  const { borderFraction = 0.03 } = opts;
  const sal = saliencyMap(image);
  const trimap = new Uint8Array(n).fill(TRIMAP.MAYBE_BG);

  let mean = 0;
  for (let i = 0; i < n; i++) mean += sal[i];
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) { const d = sal[i] - mean; variance += d * d; }
  const sd = Math.sqrt(variance / n);

  const hiCut = mean + sd * 1.1;
  const midCut = mean + sd * 0.15;

  let seeded = 0;
  for (let i = 0; i < n; i++) {
    if (sal[i] >= hiCut) { trimap[i] = TRIMAP.FG; seeded++; }
    else if (sal[i] >= midCut) trimap[i] = TRIMAP.MAYBE_FG;
  }

  const ring = Math.max(1, Math.round(Math.min(w, h) * borderFraction));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= ring && y >= ring && x < w - ring && y < h - ring) continue;
      trimap[y * w + x] = TRIMAP.BG;
    }
  }

  /*
   * Is the seed worth trusting?
   *
   * Three ways it is not, and the middle one is the trap: on an image with no
   * variation at all every pixel scores identically, `sd` is zero, and the
   * `>= mean + 0` test marks the *entire frame* as definite foreground — a
   * maximally confident claim derived from no information whatsoever. So the
   * spread has to be real, the seed has to be more than noise, and it has to be
   * less than most of the picture: a "subject" covering the whole frame tells
   * the cut nothing it did not already know.
   */
  const fraction = seeded / n;
  const confident = sd > 1e-4 && fraction > 0.005 && fraction < 0.6;
  if (!confident) {
    // Demote to a suggestion and let the cut work from the border constraint.
    for (let i = 0; i < n; i++) if (trimap[i] === TRIMAP.FG) trimap[i] = TRIMAP.MAYBE_FG;
  }
  return { trimap, confident };
}
