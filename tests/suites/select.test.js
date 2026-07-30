import { suite } from '../harness.js';
import { MaxFlow } from '/src/select/maxflow.js';
import { TRIMAP, grabcut, autoTrimap, saliencyMap } from '/src/select/grabcut.js';
import {
  edgeBand, refineRadius, smoothMask, featherMask, contrastMask, shiftEdge,
  decontaminateColors, refineSelection,
} from '/src/select/refine.js';

/**
 * Selection: graph cuts, GrabCut and edge refinement.
 *
 * The whole point of these features is that they are honest — a minimum cut and
 * a closed-form matte, not a model that produces a confident-looking guess. That
 * only means something if the maths is right, so these tests check the maths
 * rather than the plumbing:
 *
 *  - the max-flow solver is compared against a textbook Edmonds–Karp
 *    implementation on random graphs. Two independent algorithms agreeing on the
 *    flow value, and the cut agreeing with the flow, is the strongest evidence
 *    available without a reference dataset.
 *  - GrabCut is run on synthetic images with a *known* answer and scored by
 *    intersection-over-union, so "it segmented something" cannot pass.
 *  - every refinement is checked for the direction it claims: pucker-style
 *    controls must shrink, matting must reduce the error against a known alpha
 *    ramp, decontamination must remove the green it says it removes.
 *
 * Two behaviours here are deliberate and easy to mistake for bugs, so they get
 * their own assertions: feathering *conserves* total coverage (it is a symmetric
 * blur — Shift Edge is the control that moves the boundary), and matting leaves a
 * pixel alone when the local foreground and background are the same colour, on
 * the grounds that no mixture can be recovered and a made-up number is worse
 * than the cut's own answer.
 */

/* ------------------------------------------------------------------ */
/* Reference implementation                                            */
/* ------------------------------------------------------------------ */

/**
 * Edmonds–Karp max flow on a dense matrix, source `n`, sink `n + 1`.
 * Deliberately the dumbest correct algorithm: it shares no code and no ideas
 * with the Boykov–Kolmogorov implementation it is checking.
 */
function edmondsKarp(n, edges, terminals) {
  const N = n + 2, S = n, T = n + 1;
  const cap = Array.from({ length: N }, () => new Float64Array(N));
  for (const [i, j, c, rc] of edges) { cap[i][j] += c; cap[j][i] += rc; }
  for (let i = 0; i < n; i++) { cap[S][i] += terminals[i][0]; cap[i][T] += terminals[i][1]; }
  let flow = 0;
  for (;;) {
    const prev = new Int32Array(N).fill(-1);
    prev[S] = S;
    const queue = [S];
    while (queue.length) {
      const u = queue.shift();
      for (let v = 0; v < N; v++) if (prev[v] === -1 && cap[u][v] > 1e-12) { prev[v] = u; queue.push(v); }
    }
    if (prev[T] === -1) break;
    let bottleneck = Infinity;
    for (let v = T; v !== S; v = prev[v]) bottleneck = Math.min(bottleneck, cap[prev[v]][v]);
    for (let v = T; v !== S; v = prev[v]) { cap[prev[v]][v] -= bottleneck; cap[v][prev[v]] += bottleneck; }
    flow += bottleneck;
  }
  return flow;
}

/** A fixed-sequence generator, so a failure is reproducible. */
function rng(seed = 12345) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

/* ------------------------------------------------------------------ */
/* Max flow                                                            */
/* ------------------------------------------------------------------ */

suite('select / max flow agrees with Edmonds-Karp', async (t) => {
  const rnd = rng();
  const problems = [];
  let trials = 0;

  /*
   * Three densities, not one. The sparse graphs a single density produces rarely
   * orphan a node with surviving tree neighbours, which is the branch of `_adopt`
   * where a wrong-arc bug lived undetected through 190 sparse graphs — it took
   * reading the algorithm against its published form to find. Denser graphs
   * exercise it, so the sweep varies density and runs more trials.
   */
  for (const density of [0.25, 0.5, 0.8]) {
  for (let trial = 0; trial < 120; trial++) {
    const n = 4 + Math.floor(rnd() * 22);
    const edges = [];
    const terminals = [];
    // Nodes carrying BOTH terminal capacities are what produce orphans.
    for (let i = 0; i < n; i++) terminals.push([Math.floor(rnd() * 8), Math.floor(rnd() * 8)]);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (rnd() < density) edges.push([i, j, Math.floor(rnd() * 12), Math.floor(rnd() * 12)]);
      }
    }

    const mf = new MaxFlow(n, Math.max(2, edges.length * 2));
    for (const [i, j, c, rc] of edges) mf.addEdge(i, j, c, rc);
    terminals.forEach(([s, k], i) => mf.addTerminal(i, s, k));
    const got = mf.compute();
    const want = edmondsKarp(n, edges, terminals);
    trials++;
    if (Math.abs(got - want) > 1e-9) problems.push(`n=${n}: BK ${got} vs EK ${want}`);

    // Max-flow min-cut: the capacities crossing the cut must sum to the flow.
    let cut = 0;
    for (let i = 0; i < n; i++) cut += mf.inSource(i) ? terminals[i][1] : terminals[i][0];
    for (const [i, j, c, rc] of edges) {
      if (mf.inSource(i) && !mf.inSource(j)) cut += c;
      if (mf.inSource(j) && !mf.inSource(i)) cut += rc;
    }
    if (Math.abs(cut - want) > 1e-9) problems.push(`n=${n}: cut ${cut} != flow ${want}`);
    // The invariant a flow comparison cannot see.
    const leak = residualLeak(mf, n);
    if (leak) problems.push(`n=${n} d=${density}: ${leak}`);
  }
  }
  t.eq(problems.slice(0, 4), [], `the same maximum flow on ${trials} random integer graphs across three densities, and the min cut equals it`);

  // Real-valued capacities, which is what GrabCut actually produces.
  const floatProblems = [];
  for (let trial = 0; trial < 40; trial++) {
    const n = 4 + Math.floor(rnd() * 8);
    const edges = [];
    const terminals = [];
    for (let i = 0; i < n; i++) terminals.push([rnd() * 5, rnd() * 5]);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (rnd() < 0.5) edges.push([i, j, rnd() * 4, rnd() * 4]);
    const mf = new MaxFlow(n, Math.max(2, edges.length * 2));
    for (const [i, j, c, rc] of edges) mf.addEdge(i, j, c, rc);
    terminals.forEach(([s, k], i) => mf.addTerminal(i, s, k));
    const got = mf.compute();
    const want = edmondsKarp(n, edges, terminals);
    if (Math.abs(got - want) > 1e-6) floatProblems.push(`${got.toFixed(6)} vs ${want.toFixed(6)}`);
  }
  t.eq(floatProblems.slice(0, 3), [], 'and on graphs with real-valued capacities');

  // A node with both a source and a sink capacity passes min(s, t) straight
  // through. Collapsing the pair into one signed residual loses exactly that,
  // and it is a constant the solver has to add back.
  const both = new MaxFlow(1, 2);
  both.addTerminal(0, 7, 4);
  t.eq(both.compute(), 4, 'flow that runs straight through a node is counted');
});

/**
 * Is the source side of the cut closed under residual arcs?
 *
 * This is THE invariant that makes a partition a minimum cut, and it is the one a
 * flow-value comparison cannot see. `_adopt` once tested the wrong arc of a sister
 * pair, which left nodes stranded outside the source tree: the flow value stayed
 * correct — the augmenting phase was fine — and only the *labelling* was wrong, so
 * comparing against Edmonds-Karp passed every time. A broadened random sweep did
 * not catch it either (verified: 360 graphs across three densities, zero
 * failures against the buggy code). Checking closure directly does catch it,
 * because a stranded node is by definition reachable from the source through a
 * residual arc.
 *
 * @returns {string|null} a description of the first leak, or null
 */
function residualLeak(mf, n) {
  for (let i = 0; i < n; i++) {
    if (!mf.inSource(i)) continue;
    for (let a = mf.firstArc[i]; a !== -1; a = mf.nextArc[a]) {
      if (mf.cap[a] <= 1e-9) continue;
      const q = mf.head[a];
      if (!mf.inSource(q)) return `node ${i} reaches ${q} with residual ${mf.cap[a]} but ${q} is on the sink side`;
    }
  }
  return null;
}

suite('select / the cut is closed under residual arcs', async (t) => {
  /*
   * The exact nine-node graph that exposed the `_adopt` sister-arc bug, pinned as a
   * fixed case rather than left to a random sweep that provably does not find it.
   * The shape that matters: an edge whose two directions have *different*
   * capacities (0 one way), so testing the wrong arc reads 0 and skips the
   * re-activation.
   */
  const terminals = [[2, 0], [0, 0], [1, 3], [1, 0], [2, 1], [2, 1], [2, 3], [0, 3], [2, 0]];
  const edges = [
    [0, 1, 1, 5], [0, 2, 4, 5], [0, 8, 4, 6], [1, 2, 4, 3], [1, 4, 3, 0], [1, 6, 5, 0],
    [2, 4, 0, 1], [2, 8, 1, 1], [3, 5, 3, 1], [3, 6, 2, 3], [5, 7, 4, 6], [6, 8, 5, 2],
  ];
  const n = 9;
  const mf = new MaxFlow(n, edges.length * 2);
  for (const [i, j, c, rc] of edges) mf.addEdge(i, j, c, rc);
  terminals.forEach(([a, b], i) => mf.addTerminal(i, a, b));
  const flow = mf.compute();

  t.eq(flow, edmondsKarp(n, edges, terminals), 'the flow value is right — it always was, which is the point');
  t.eq(residualLeak(mf, n), null, 'and the source side is closed under residual arcs');

  // The cut this partition describes must actually be the minimum, checked
  // against brute force over all 512 partitions.
  const cutOf = (mask) => {
    let cut = 0;
    for (let i = 0; i < n; i++) cut += (mask >> i) & 1 ? terminals[i][1] : terminals[i][0];
    for (const [i, j, c, rc] of edges) {
      const si = (mask >> i) & 1, sj = (mask >> j) & 1;
      if (si && !sj) cut += c;
      if (sj && !si) cut += rc;
    }
    return cut;
  };
  let best = Infinity;
  for (let mask = 0; mask < 1 << n; mask++) best = Math.min(best, cutOf(mask));
  let ours = 0;
  for (let i = 0; i < n; i++) ours |= (mf.inSource(i) ? 1 : 0) << i;
  t.eq(cutOf(ours), best, `the returned partition is a minimum cut (${cutOf(ours)} vs the best possible ${best})`);
  t.eq(best, flow, 'and the minimum cut equals the maximum flow');
});

suite('select / max flow finds the cut a grid is seeded with', async (t) => {
  const W = 120, H = 90, n = W * H;
  const g = new MaxFlow(n, n * 8);
  const inside = (x, y) => Math.hypot(x - W / 2, y - H / 2) < 30;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (x > 0) g.addEdge(i, i - 1, 3, 3);
      if (y > 0) g.addEdge(i, i - W, 3, 3);
      if (x > 0 && y > 0) g.addEdge(i, i - W - 1, 2, 2);
      if (x < W - 1 && y > 0) g.addEdge(i, i - W + 1, 2, 2);
      g.addTerminal(i, inside(x, y) ? 30 : 0.4, inside(x, y) ? 0.4 : 30);
    }
  }
  t.gt(g.compute(), 0, 'a grid graph produces a positive flow');

  let kept = 0, stray = 0, area = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const src = g.inSource(y * W + x);
      if (inside(x, y)) { area++; if (src) kept++; } else if (src) stray++;
    }
  }
  t.gt(kept, area * 0.98, `the circle comes back (${kept} of ${area} pixels)`);
  t.lt(stray, area * 0.02, `with almost nothing outside it (${stray} stray pixels)`);
  t.eq(residualLeak(g, n), null, 'and the source side of a grid cut is closed under residual arcs too');
});

/* ------------------------------------------------------------------ */
/* GrabCut                                                             */
/* ------------------------------------------------------------------ */

/** A noisy two-material image with a known foreground, and its ground truth. */
function segmentationFixture(w = 240, h = 180) {
  const img = new ImageData(w, h);
  const truth = new Uint8Array(w * h);
  const rnd = rng(7);
  const inSubject = (x, y) => Math.hypot((x - w * 0.5) / (w * 0.23), (y - h * 0.5) / (h * 0.35)) < 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, o = i * 4;
      const fg = inSubject(x, y);
      truth[i] = fg ? 1 : 0;
      // Real noise, so the mixtures have something to model.
      const n = (rnd() - 0.5) * 40;
      img.data[o] = (fg ? 40 : 210) + n;
      img.data[o + 1] = (fg ? 120 : 170) + n;
      img.data[o + 2] = (fg ? 190 : 90) + n;
      img.data[o + 3] = 255;
    }
  }
  return { img, truth, inSubject };
}

const iou = (mask, truth) => {
  let inter = 0, union = 0;
  for (let i = 0; i < truth.length; i++) {
    const a = mask[i] > 127 ? 1 : 0;
    if (a || truth[i]) union++;
    if (a && truth[i]) inter++;
  }
  return union ? inter / union : 0;
};

suite('select / saliency scores the unusual thing highest', async (t) => {
  const { img, truth } = segmentationFixture();
  const sal = saliencyMap(img);
  let fgSum = 0, fgN = 0, bgSum = 0, bgN = 0;
  for (let i = 0; i < truth.length; i++) {
    if (truth[i]) { fgSum += sal[i]; fgN++; } else { bgSum += sal[i]; bgN++; }
  }
  const fg = fgSum / fgN, bg = bgSum / bgN;
  t.gt(fg, bg, `the subject scores above the background (${fg.toFixed(3)} vs ${bg.toFixed(3)})`);
  t.gt(fg, bg * 2, 'and by a wide margin on an image with one obvious subject');

  // An image with nothing unusual in it must not produce a confident seed.
  const flat = new ImageData(60, 60);
  for (let i = 0; i < 3600; i++) {
    const o = i * 4;
    flat.data[o] = flat.data[o + 1] = flat.data[o + 2] = 120;
    flat.data[o + 3] = 255;
  }
  t.notOk(autoTrimap(flat).confident, 'a featureless image reports that it found no subject');
});

suite('select / GrabCut recovers a known shape', async (t) => {
  const { img, truth } = segmentationFixture();

  // Unattended, from saliency alone — the Select Subject path.
  const auto = autoTrimap(img);
  t.ok(auto.confident, 'saliency is confident enough to seed a definite foreground here');
  const unattended = grabcut(img, auto.trimap.slice(), { iterations: 3 });
  const autoScore = iou(unattended.mask, truth);
  t.gt(autoScore, 0.9, `an unattended cut scores IoU ${autoScore.toFixed(3)}`);

  // From a rough rectangle, the way GrabCut is meant to be driven.
  const w = img.width, h = img.height;
  const boxed = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inBox = x > w * 0.2 && x < w * 0.8 && y > h * 0.08 && y < h * 0.92;
      boxed[y * w + x] = inBox ? TRIMAP.MAYBE_FG : TRIMAP.BG;
    }
  }
  const guided = grabcut(img, boxed, { iterations: 3 });
  t.gt(iou(guided.mask, truth), 0.93, `a rough rectangle scores IoU ${iou(guided.mask, truth).toFixed(3)}`);

  // Convergence: running again on a settled trimap must not thrash.
  const settled = auto.trimap.slice();
  grabcut(img, settled, { iterations: 3 });
  const again = grabcut(img, settled, { iterations: 3 });
  t.lt(again.changed, w * h * 0.01, `re-running on a settled trimap moves ${again.changed} pixels`);
});

suite('select / a high-frequency image still cuts sanely', async (t) => {
  /*
   * The shape that reaches the `_adopt` sister-arc bug through GrabCut rather than
   * through MaxFlow directly.
   *
   * The fixture matters, and the first version of this suite got it wrong: a 40x50
   * image with 2x2 blocks produces byte-identical output from the buggy and fixed
   * solvers (0 of 2000 pixels differ), so no assertion over the result could catch
   * anything — the suite was a no-op dressed as a regression guard. A 64x64 image
   * with 4x4 blocks does diverge, badly: the pre-fix solver returns a 4-connected
   * share of 0.016 against an 8-connected 0.984, and 3968 of 4096 mask pixels
   * differ. The 4-vs-8 assertion below is what fires on it.
   *
   * Two of these assertions are structurally immune to a labelling bug and are kept
   * only as sanity checks, which is worth stating so nobody mistakes them for the
   * guard: the hard constraints hold for ANY solver (a definite pixel gets a terminal
   * capacity larger than the total flow its own edges can carry, so it can never
   * orphan), and determinism compares the solver against itself.
   */
  const w = 64, h = 64;
  const img = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const on = ((x >> 2) + (y >> 2)) % 2 === 0;
      img.data[o] = on ? 235 : 25;
      img.data[o + 1] = on ? 40 : 210;
      img.data[o + 2] = on ? 120 : 90;
      img.data[o + 3] = 255;
    }
  }

  const forcedFg = (x, y) => x < 6 && y < 6;
  const forcedBg = (x, y) => x >= w - 6 && y >= h - 6;
  const seed = () => {
    const trimap = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        trimap[y * w + x] = forcedFg(x, y) ? TRIMAP.FG : forcedBg(x, y) ? TRIMAP.BG : TRIMAP.MAYBE_FG;
      }
    }
    return trimap;
  };

  const eight = grabcut(img, seed(), { iterations: 3, diagonals: true });
  const four = grabcut(img, seed(), { iterations: 3, diagonals: false });
  const share = (m) => [...m].filter((v) => v > 127).length / (w * h);

  /*
   * THE guard. On the pre-fix solver these two diverge by 0.97; they agree closely
   * on a correct one. A cut that stops growing early labels a swathe of the image
   * sink-side, and 4- and 8-connectivity strand different swathes.
   */
  t.close(share(four.mask), share(eight.mask), 0.2,
    `4- and 8-connected cuts agree (${share(four.mask).toFixed(3)} vs ${share(eight.mask).toFixed(3)})`);

  let violations = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (forcedFg(x, y) && eight.mask[i] !== 255) violations++;
      if (forcedBg(x, y) && eight.mask[i] !== 0) violations++;
    }
  }
  t.eq(violations, 0, 'the hard constraints survive (a sanity check — this holds for any solver)');

  const repeat = grabcut(img, seed(), { iterations: 3, diagonals: true });
  t.eq(t.mad(eight.mask, repeat.mask), 0,
    'the same input gives a byte-identical mask (also self-comparing, so also only a sanity check)');

  const settled = seed();
  grabcut(img, settled, { iterations: 3, diagonals: true });
  const again = grabcut(img, settled, { iterations: 3, diagonals: true });
  t.lt(again.changed, w * h * 0.05, `re-running on the settled trimap moves ${again.changed} of ${w * h} pixels`);
});

suite('select / a definite label is a hard constraint', async (t) => {
  const { img } = segmentationFixture();
  const w = img.width, h = img.height;
  const trimap = new Uint8Array(w * h);
  // Deliberately perverse: force a patch of plain background to foreground, and
  // a patch that the colour model likes to background.
  const forcedFg = (x, y) => x > 10 && x < 40 && y > 10 && y < 40;
  const forcedBg = (x, y) => x > w - 40 && y > h - 40;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      trimap[i] = forcedFg(x, y) ? TRIMAP.FG : forcedBg(x, y) ? TRIMAP.BG : TRIMAP.MAYBE_FG;
    }
  }
  const res = grabcut(img, trimap, { iterations: 2 });
  let violations = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (forcedFg(x, y) && res.mask[i] !== 255) violations++;
      if (forcedBg(x, y) && res.mask[i] !== 0) violations++;
    }
  }
  t.eq(violations, 0, 'every pixel marked definite keeps that label — exactly, not mostly');
});

suite('select / degenerate images are handled, not divided by', async (t) => {
  const flat = new ImageData(40, 40);
  for (let i = 0; i < 1600; i++) {
    const o = i * 4;
    flat.data[o] = flat.data[o + 1] = flat.data[o + 2] = 128;
    flat.data[o + 3] = 255;
  }
  const res = grabcut(flat, new Uint8Array(1600).fill(TRIMAP.MAYBE_FG), { iterations: 2 });
  t.eq(res.mask.length, 1600, 'a perfectly flat image still produces a mask');
  t.ok([...res.mask].every((v) => Number.isFinite(v)), 'with no NaN in it');

  // A trimap with no foreground at all: the mixtures have nothing to fit, and
  // the fallback wide component has to keep the data term finite.
  const empty = grabcut(flat, new Uint8Array(1600).fill(TRIMAP.BG), { iterations: 1 });
  t.eq([...empty.mask].filter((v) => v !== 0).length, 0, 'an all-background trimap stays all background');
});

/* ------------------------------------------------------------------ */
/* Refinement                                                          */
/* ------------------------------------------------------------------ */

const W = 120, H = 100, N = W * H;

/** A hard-edged disc, radius 30, centred. */
function disc() {
  const m = new Uint8ClampedArray(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) m[y * W + x] = Math.hypot(x - 60, y - 50) < 30 ? 255 : 0;
  return m;
}
const covered = (m) => { let n = 0; for (let i = 0; i < N; i++) if (m[i] > 127) n++; return n; };
const partial = (m) => { let n = 0; for (let i = 0; i < N; i++) if (m[i] > 8 && m[i] < 247) n++; return n; };

suite('select / the edge band follows the contour', async (t) => {
  const m = disc();
  const { band, dist } = edgeBand(m, W, H, 5);
  let inBand = 0, misplaced = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!band[y * W + x]) continue;
      inBand++;
      if (Math.abs(Math.hypot(x - 60, y - 50) - 30) > 7) misplaced++;
    }
  }
  t.gt(inBand, 700, `the band has real width (${inBand} pixels)`);
  t.eq(misplaced, 0, 'and every pixel in it is within 7px of the true edge');
  t.gt(dist[50 * W + 60], 25, 'the signed distance is positive deep inside');
  t.lt(dist[2 * W + 2], -25, 'and negative far outside');
});

suite('select / feather softens without moving the boundary', async (t) => {
  const m = disc();
  t.eq(partial(m), 0, 'the fixture starts perfectly hard');

  const soft = featherMask(m, W, H, 4);
  t.gt(partial(soft), 400, `feathering produces partial coverage (${partial(soft)} pixels)`);
  t.eq(soft[50 * W + 60], 255, 'while the interior stays fully selected');
  // A symmetric blur conserves the integral, so the 50% contour does not move.
  // This is why Feather is not the control that grows a selection.
  t.close(covered(soft), covered(m), covered(m) * 0.05, 'and the 50% contour stays where it was');

  const hard = contrastMask(soft, 95);
  t.lt(partial(hard), partial(soft) * 0.35, `contrast hardens it back up (${partial(soft)} -> ${partial(hard)})`);
  t.eq([...contrastMask(soft, 0)], [...soft], 'zero contrast is exactly the identity');

  let differ = 0;
  const round = contrastMask(featherMask(m, W, H, 3), 100);
  for (let i = 0; i < N; i++) if ((round[i] > 127) !== (m[i] > 127)) differ++;
  t.lt(differ, covered(m) * 0.03, `feather then full contrast returns the original shape (${differ} pixels differ)`);
});

suite('select / shift edge is the control that moves the boundary', async (t) => {
  const m = disc();
  const grown = shiftEdge(m, W, H, 60);
  const shrunk = shiftEdge(m, W, H, -60);
  t.gt(covered(grown), covered(m) * 1.05, `a positive shift grows (${covered(m)} -> ${covered(grown)} px)`);
  t.lt(covered(shrunk), covered(m) * 0.95, `a negative shift shrinks (${covered(m)} -> ${covered(shrunk)} px)`);
  t.eq([...shiftEdge(m, W, H, 0)], [...m], 'and zero is exactly the identity');
});

suite('select / smooth removes speckle without eating the shape', async (t) => {
  const truth = disc();
  const speckled = new Uint8ClampedArray(truth);
  const rnd = rng(3);
  let flipped = 0;
  for (let i = 0; i < N; i++) if (rnd() < 0.04) { speckled[i] = speckled[i] ? 0 : 255; flipped++; }
  const cleaned = smoothMask(speckled, W, H, 2);

  let before = 0, after = 0;
  for (let i = 0; i < N; i++) {
    if ((speckled[i] > 127) !== (truth[i] > 127)) before++;
    if ((cleaned[i] > 127) !== (truth[i] > 127)) after++;
  }
  t.eq(before, flipped, 'the speckle really is wrong to begin with');
  t.lt(after, before * 0.1, `smoothing recovers the true shape (${before} wrong -> ${after})`);
});

suite('select / matting recovers a soft edge the cut cannot', async (t) => {
  // A disc whose true alpha ramps over 6px, composited over a distinct colour.
  const img = new ImageData(W, H);
  const alpha = new Float32Array(N);
  const F = [230, 60, 40], B = [30, 70, 200];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, o = i * 4;
      const a = Math.max(0, Math.min(1, (33 - Math.hypot(x - 60, y - 50)) / 6));
      alpha[i] = a;
      for (let c = 0; c < 3; c++) img.data[o + c] = Math.round(a * F[c] + (1 - a) * B[c]);
      img.data[o + 3] = 255;
    }
  }
  // The binary cut a graph cut would hand over.
  const hard = new Uint8ClampedArray(N);
  for (let i = 0; i < N; i++) hard[i] = alpha[i] > 0.5 ? 255 : 0;

  const err = (m) => {
    let s = 0;
    for (let i = 0; i < N; i++) s += Math.abs(m[i] / 255 - alpha[i]);
    return s / N;
  };
  const matted = refineRadius(img, hard, 8);
  t.lt(err(matted), err(hard) * 0.55,
    `matting halves the alpha error (${err(hard).toFixed(4)} -> ${err(matted).toFixed(4)})`);
  t.gt(partial(matted), 300, `and produces genuinely partial coverage (${partial(matted)} pixels)`);

  // Smart Radius must not make it worse on the same image.
  const smart = refineRadius(img, hard, 8, { smart: true });
  t.lt(err(smart), err(hard), 'smart radius also beats the binary cut');

  // With no edge to find, matting must hand back what it was given rather than
  // inventing a plausible-looking gradient.
  const flat = new ImageData(W, H);
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    flat.data[o] = flat.data[o + 1] = flat.data[o + 2] = 128;
    flat.data[o + 3] = 255;
  }
  const m = disc();
  t.eq([...refineRadius(flat, m, 8)], [...m], 'on a colourless image matting changes nothing at all');
});

suite('select / decontaminate pulls the fringe colour out', async (t) => {
  const img = new ImageData(W, H);
  const alpha = new Float32Array(N);
  const F = [220, 40, 40], B = [20, 210, 30];    // red subject on a green screen
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, o = i * 4;
      const a = Math.max(0, Math.min(1, (33 - Math.hypot(x - 60, y - 50)) / 6));
      alpha[i] = a;
      for (let c = 0; c < 3; c++) img.data[o + c] = Math.round(a * F[c] + (1 - a) * B[c]);
      img.data[o + 3] = 255;
    }
  }
  const mask = new Uint8ClampedArray(N);
  for (let i = 0; i < N; i++) mask[i] = Math.round(alpha[i] * 255);

  const fringeGreen = (data) => {
    let sum = 0, n = 0;
    for (let i = 0; i < N; i++) {
      if (alpha[i] > 0.35 && alpha[i] < 0.85) { sum += data[i * 4 + 1]; n++; }
    }
    return n ? sum / n : 0;
  };
  const before = fringeGreen(img.data);
  const after = fringeGreen(decontaminateColors(img, mask, 100).data);
  t.lt(after, before - 10, `the green fringe is pulled out (${before.toFixed(1)} -> ${after.toFixed(1)})`);

  // At zero amount it must be a no-op, not a subtle shift.
  const untouched = new ImageData(W, H);
  untouched.data.set(img.data);
  const same = decontaminateColors(untouched, mask, 0);
  t.eq(t.mad(img.data, same.data), 0, 'and zero amount leaves every pixel alone');
});

suite('select / the refinement pipeline is neutral at its defaults', async (t) => {
  const m = disc();
  const img = new ImageData(W, H);
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    img.data[o] = 200; img.data[o + 1] = 100; img.data[o + 2] = 50; img.data[o + 3] = 255;
  }
  t.eq([...refineSelection(img, m, W, H, {})], [...m], 'every control at zero is exactly the identity');

  /*
   * And the order is the documented one: matting, smooth, feather, contrast, shift.
   * Running them by hand must match the pipeline exactly — but the image has to be
   * one where matting DOES something, or the comparison is blind to the first
   * stage. On the flat single-colour image above, `refineRadius` is the identity
   * (correctly: there is no edge to find), so the assertion would have passed even
   * if the pipeline skipped matting altogether. Use an image with a real edge.
   */
  const edged = new ImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const a = Math.max(0, Math.min(1, (33 - Math.hypot(x - 60, y - 50)) / 6));
      edged.data[o] = Math.round(a * 230 + (1 - a) * 30);
      edged.data[o + 1] = Math.round(a * 60 + (1 - a) * 70);
      edged.data[o + 2] = Math.round(a * 40 + (1 - a) * 200);
      edged.data[o + 3] = 255;
    }
  }
  const p = { radius: 6, smooth: 2, feather: 3, contrast: 40, shift: 20 };
  const matted = refineRadius(edged, m, p.radius);
  t.gt(t.mad(matted, m), 0.5, 'the fixture is one where matting genuinely changes the mask');

  let byHand = matted;
  byHand = smoothMask(byHand, W, H, p.smooth);
  byHand = featherMask(byHand, W, H, p.feather);
  byHand = contrastMask(byHand, p.contrast);
  byHand = shiftEdge(byHand, W, H, p.shift);
  t.eq([...refineSelection(edged, m, W, H, p)], [...byHand], 'and the pipeline applies them in that order');

  // Smooth and Shift Edge must not silently destroy the matte they are handed:
  // both used to re-binarise, so Radius 40 plus Smooth 1 threw the matte away.
  const soft = refineRadius(edged, m, 10);
  const softPartial = partial(soft);
  t.gt(softPartial, 200, 'matting produced a soft edge to protect');
  t.gt(partial(smoothMask(soft, W, H, 2)), softPartial * 0.5,
    'Smooth keeps most of the partial coverage it was given');
  t.gt(partial(shiftEdge(soft, W, H, 30)), softPartial * 0.5,
    'and so does Shift Edge');
});
