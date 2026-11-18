import { suite } from '../harness.js';
import { distanceField, seedsFromField, spreadField, signedDistance, NO_SEED } from '/src/core/distance.js';
import { spreadAlpha } from '/src/effects/styles.js';

/**
 * The exact Euclidean distance transform behind Spread, Choke, Stroke, Inner
 * Glow, Bevel and Select and Mask's edge band.
 *
 * Every check compares against a brute-force answer — the distance from each
 * pixel to every seed, minimised — so a transform that is merely plausible (the
 * chamfer this replaced reads a (2, 1) step as 2.414 instead of 2.236) fails
 * on the first off-axis pixel.
 */

function bruteForce(seed, w, h) {
  const pts = [];
  for (let i = 0; i < w * h; i++) if (seed[i]) pts.push([i % w, (i / w) | 0]);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best = Infinity;
      for (const [px, py] of pts) {
        const d = (px - x) * (px - x) + (py - y) * (py - y);
        if (d < best) best = d;
      }
      out[y * w + x] = pts.length ? Math.sqrt(best) : NO_SEED;
    }
  }
  return out;
}

/** A small deterministic generator, so a failure reproduces. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

suite('distance / the transform is exact', async (t) => {
  const W = 64, H = 48;
  const rand = rng(7);
  let worst = 0, cases = 0;
  for (let trial = 0; trial < 12; trial++) {
    const seed = new Uint8Array(W * H);
    const density = 0.002 + trial * 0.01;
    for (let i = 0; i < seed.length; i++) seed[i] = rand() < density ? 1 : 0;
    const got = distanceField(seed, W, H);
    const exp = bruteForce(seed, W, H);
    for (let i = 0; i < got.length; i++) {
      const d = Math.abs(got[i] - exp[i]);
      if (d > worst) worst = d;
    }
    cases++;
  }
  t.eq(cases, 12, 'twelve random seed patterns, sparse to dense');
  t.lt(worst, 1e-5, `every pixel matches the brute-force distance (worst ${worst})`);

  // The step that exposes an octagonal (chamfer) metric.
  const one = new Uint8Array(9 * 9);
  one[4 * 9 + 4] = 1;
  const d1 = distanceField(one, 9, 9);
  t.close(d1[5 * 9 + 6], Math.sqrt(5), 1e-6, 'a (2, 1) step is sqrt(5) = 2.236, not the chamfer\'s 2.414');
  t.close(d1[0], Math.sqrt(32), 1e-6, 'a (4, 4) diagonal is 5.657');
  t.eq(d1[4 * 9 + 4], 0, 'the seed itself is at distance 0');
});

suite('distance / no seeds and all seeds', async (t) => {
  const none = distanceField(new Uint8Array(30 * 20), 30, 20);
  t.ok(none.every((v) => v === NO_SEED), 'with no seeds at all every pixel reads NO_SEED');
  const all = distanceField(new Uint8Array(30 * 20).fill(1), 30, 20);
  t.ok(all.every((v) => v === 0), 'with every pixel a seed every distance is 0');
  const col = new Uint8Array(30 * 20);
  for (let y = 0; y < 20; y++) col[y * 30 + 29] = 1;
  const d = distanceField(col, 30, 20);
  t.eq(d[10 * 30], 29, 'one seeded column: the far column is exactly 29 away');
});

suite('distance / spread uses the true distance', async (t) => {
  const W = 41, H = 41;
  const a = new Float32Array(W * H);
  a[20 * W + 20] = 255;
  const grown = spreadField(a, W, H, 10);
  // (9, 4) from the pixel is sqrt(97) = 9.849 away: coverage (10 - 9.849 + 0.5) * 255.
  const exp = (10.5 - Math.sqrt(97)) * 255;
  t.close(grown[24 * W + 29], exp, 1e-3, `a pixel sqrt(97) away from a dot grown by 10 is ${exp.toFixed(1)}, not 0`);
  t.eq(grown[20 * W + 31], 0, 'eleven pixels straight out is beyond the ramp');
  t.eq(grown[20 * W + 30], 127.5, 'exactly 10 out is the half-coverage point');
  const viaStyles = spreadAlpha(a, W, H, 10);
  t.eq(Array.from(viaStyles), Array.from(grown), 'spreadAlpha (the Layer Style entry point) is this transform');

  const shrunk = spreadField(new Float32Array(W * H).fill(255), W, H, -3);
  t.eq(shrunk[20 * W + 20], 255, 'shrinking a full field leaves it full (there is no outside to measure from)');
});

suite('distance / signed distance on a disc', async (t) => {
  const W = 120, H = 100, R = 40;
  const alpha = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) alpha[y * W + x] = Math.hypot(x - 60, y - 50) < R ? 255 : 0;
  const sd = signedDistance(alpha, W, H);
  const din = bruteForce(seedsFromField(alpha, W, H, false), W, H);
  const dout = bruteForce(seedsFromField(alpha, W, H, true), W, H);
  let worst = 0, checked = 0;
  for (let i = 0; i < W * H; i++) {
    if (din[i] <= 1.5 && dout[i] <= 1.5) continue; // the coverage-based band
    const exp = din[i] > 0 ? din[i] - 0.5 : 0.5 - dout[i];
    worst = Math.max(worst, Math.abs(sd[i] - exp));
    checked++;
  }
  t.gt(checked, 10000, `checked ${checked} pixels away from the edge`);
  t.lt(worst, 1e-5, `the signed distance is exact everywhere (worst ${worst})`);
  t.close(sd[50 * W + 60], 39.5, 1e-6, 'the centre is 40 px from the outside, minus the half pixel');
});
