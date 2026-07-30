/**
 * Maximum flow / minimum cut on a sparse graph.
 *
 * This is the Boykov–Kolmogorov augmenting-path algorithm, the one every
 * classical vision segmenter is built on: it grows a search tree from the source
 * *and* one from the sink, reuses both between augmentations instead of throwing
 * them away, and repairs the damaged branches ("orphans") rather than starting
 * over. On the grid graphs an image produces that is dramatically faster than
 * textbook Edmonds–Karp, which is why GrabCut is interactive at all.
 *
 * Why implement it rather than reach for a library: the whole point of Pikado's
 * selection tools is that they do honest edge-finding. A min-cut is the honest
 * version of "Select Subject" — no model weights, no network call, just the
 * energy minimum of a colour model you can inspect. See `src/select/grabcut.js`.
 *
 * The implementation follows the reference structure closely, including the two
 * details that are easy to get wrong and impossible to notice from a plausible
 * looking result:
 *
 *  - a node's `parent` is the arc **from the node to its parent**, so the
 *    residual capacity flowing *into* the node from its parent is the sister
 *    arc's. Getting this backwards produces a flow value that is merely too
 *    small, which looks like a slightly wrong cut rather than a bug.
 *  - `ts`/`dist` are a timestamp and a distance-to-terminal cache. They are only
 *    a heuristic for picking the shallowest new parent, but the origin check
 *    that uses them is what stops `adopt` from attaching a node to a branch that
 *    no longer reaches its terminal.
 *
 * Correctness is pinned in `tests/suites/select.test.js` against a
 * straightforward Edmonds–Karp implementation over random graphs: same maximum
 * flow, every time, or one of the two is wrong.
 *
 * Arcs are always added in sister pairs, so `a ^ 1` is the reverse arc and no
 * separate sister table is needed.
 */

const FREE = 0;
const SOURCE = 1;
const SINK = 2;

/** `parent` sentinels. Real values are arc indices, which are >= 0. */
const NONE = -1;
const TERMINAL = -2;
const ORPHAN = -3;

const INF_DIST = 0x3fffffff;

export class MaxFlow {
  /**
   * @param {number} nodeCount
   * @param {number} [arcHint] expected number of *directed* arcs (2 per edge)
   */
  constructor(nodeCount, arcHint = nodeCount * 8) {
    this.n = nodeCount;

    /* --- per node --- */
    this.firstArc = new Int32Array(nodeCount).fill(-1);
    /** Terminal capacity: positive is a source arc, negative a sink arc. */
    this.trCap = new Float64Array(nodeCount);
    this.parent = new Int32Array(nodeCount).fill(NONE);
    this.tree = new Uint8Array(nodeCount);
    this.ts = new Int32Array(nodeCount);
    this.dist = new Int32Array(nodeCount);
    /** Active queue links; -1 is "not queued". */
    this.nextActive = new Int32Array(nodeCount).fill(-1);
    this.queued = new Uint8Array(nodeCount);

    /* --- per arc --- */
    const cap = Math.max(2, arcHint);
    this.cap = new Float64Array(cap);
    this.head = new Int32Array(cap);
    this.nextArc = new Int32Array(cap);
    this.arcCount = 0;

    this.activeHead = -1;
    this.activeTail = -1;
    this.orphans = [];
    this.flow = 0;
    /** Flow that runs straight through a node — see `addTerminal`. */
    this.constantFlow = 0;
  }

  /* ------------------------------------------------------------------ */
  /* Building                                                            */
  /* ------------------------------------------------------------------ */

  _growArcs(need) {
    if (need <= this.cap.length) return;
    let size = this.cap.length;
    while (size < need) size *= 2;
    const cap = new Float64Array(size); cap.set(this.cap); this.cap = cap;
    const head = new Int32Array(size); head.set(this.head); this.head = head;
    const next = new Int32Array(size); next.set(this.nextArc); this.nextArc = next;
  }

  /**
   * Add source and sink capacities for a node. Both are non-negative; the pair
   * is collapsed into one signed residual, which is what makes a hard
   * constraint ("this pixel is definitely foreground") a single large number.
   *
   * Collapsing them loses `min(sourceCap, sinkCap)`: that much flow runs
   * source -> node -> sink no matter what the rest of the graph does, and the
   * signed residual cannot represent it. It is a constant, so it is banked here
   * and added back to the total. The *cut* is unaffected either way, which is
   * precisely why forgetting this reads as a plausible-looking segmentation with
   * a quietly wrong flow value.
   */
  addTerminal(i, sourceCap, sinkCap) {
    this.constantFlow += Math.min(sourceCap, sinkCap);
    this.trCap[i] += sourceCap - sinkCap;
  }

  /** Add an undirected edge with (possibly asymmetric) capacities. */
  addEdge(i, j, cap, revCap) {
    const a = this.arcCount;
    this._growArcs(a + 2);
    this.head[a] = j;
    this.cap[a] = cap;
    this.nextArc[a] = this.firstArc[i];
    this.firstArc[i] = a;

    this.head[a + 1] = i;
    this.cap[a + 1] = revCap;
    this.nextArc[a + 1] = this.firstArc[j];
    this.firstArc[j] = a + 1;

    this.arcCount = a + 2;
  }

  /* ------------------------------------------------------------------ */
  /* Active queue                                                        */
  /* ------------------------------------------------------------------ */

  _setActive(i) {
    if (this.queued[i]) return;
    this.queued[i] = 1;
    this.nextActive[i] = -1;
    if (this.activeTail === -1) this.activeHead = i;
    else this.nextActive[this.activeTail] = i;
    this.activeTail = i;
  }

  /** Pop the next node that is still attached to a tree. */
  _nextActive() {
    while (this.activeHead !== -1) {
      const i = this.activeHead;
      const nxt = this.nextActive[i];
      this.activeHead = nxt;
      if (nxt === -1) this.activeTail = -1;
      this.nextActive[i] = -1;
      this.queued[i] = 0;
      if (this.parent[i] !== NONE) return i;
    }
    return -1;
  }

  /* ------------------------------------------------------------------ */
  /* The algorithm                                                       */
  /* ------------------------------------------------------------------ */

  /** @returns {number} the maximum flow */
  compute() {
    const { n, trCap, tree, parent, ts, dist, cap, head, nextArc, firstArc } = this;

    this.activeHead = this.activeTail = -1;
    this.queued.fill(0);
    this.orphans.length = 0;

    for (let i = 0; i < n; i++) {
      ts[i] = 0;
      dist[i] = 1;
      if (trCap[i] > 0) { tree[i] = SOURCE; parent[i] = TERMINAL; this._setActive(i); }
      else if (trCap[i] < 0) { tree[i] = SINK; parent[i] = TERMINAL; this._setActive(i); }
      else { tree[i] = FREE; parent[i] = NONE; }
    }

    let flow = this.constantFlow;
    let time = 0;
    let current = -1;

    for (;;) {
      let p = current;
      // The "current node" optimisation: after an augmentation p usually still
      // has spare capacity, so re-growing from it beats going back to the queue.
      if (p !== -1 && parent[p] === NONE) p = -1;
      if (p === -1) {
        p = this._nextActive();
        if (p === -1) break;
      }

      const isSource = tree[p] === SOURCE;
      let joinArc = -1;
      for (let a = firstArc[p]; a !== -1; a = nextArc[a]) {
        // Growing along p -> q needs residual capacity in that direction: the
        // arc itself for a source-tree node, the sister for a sink-tree one.
        if (cap[isSource ? a : a ^ 1] <= 0) continue;
        const q = head[a];
        if (tree[q] === FREE) {
          tree[q] = tree[p];
          parent[q] = a ^ 1;          // arc from q back to p
          ts[q] = ts[p];
          dist[q] = dist[p] + 1;
          this._setActive(q);
        } else if (tree[q] !== tree[p]) {
          // The two trees touch: an augmenting path, oriented source -> sink.
          joinArc = isSource ? a : a ^ 1;
          break;
        } else if (ts[q] <= ts[p] && dist[q] > dist[p] + 1) {
          // Same tree, but q is deeper than it needs to be — re-parent it so
          // later origin checks terminate quickly.
          parent[q] = a ^ 1;
          ts[q] = ts[p];
          dist[q] = dist[p] + 1;
        }
      }

      time++;
      if (joinArc === -1) {
        current = -1;
        continue;
      }
      flow += this._augment(joinArc);
      this._adoptAll(time);
      // Keep p as the current node; the loop drops it if it went free.
      current = p;
    }

    this.flow = flow;
    return flow;
  }

  /**
   * Push flow along the path through `midArc` (oriented source-side -> sink-side)
   * and orphan every node whose link to its terminal saturated.
   * @returns {number} the flow pushed
   */
  _augment(midArc) {
    const { cap, head, parent, trCap } = this;
    const p = head[midArc ^ 1];   // last node of the source tree
    const q = head[midArc];       // first node of the sink tree

    /* --- bottleneck --- */
    let bottleneck = cap[midArc];
    for (let i = p; ;) {
      const a = parent[i];
      if (a === TERMINAL) break;
      // The arc parent -> i is the sister of i's parent arc.
      const r = cap[a ^ 1];
      if (r < bottleneck) bottleneck = r;
      i = head[a];
    }
    {
      let root = p;
      while (parent[root] !== TERMINAL) root = head[parent[root]];
      if (trCap[root] < bottleneck) bottleneck = trCap[root];
    }
    for (let i = q; ;) {
      const a = parent[i];
      if (a === TERMINAL) break;
      const r = cap[a];
      if (r < bottleneck) bottleneck = r;
      i = head[a];
    }
    {
      let root = q;
      while (parent[root] !== TERMINAL) root = head[parent[root]];
      if (-trCap[root] < bottleneck) bottleneck = -trCap[root];
    }

    /* --- push --- */
    cap[midArc ^ 1] += bottleneck;
    cap[midArc] -= bottleneck;

    for (let i = p; ;) {
      const a = parent[i];
      if (a === TERMINAL) {
        trCap[i] -= bottleneck;
        if (trCap[i] === 0) { parent[i] = ORPHAN; this.orphans.push(i); }
        break;
      }
      cap[a] += bottleneck;
      cap[a ^ 1] -= bottleneck;
      if (cap[a ^ 1] === 0) { parent[i] = ORPHAN; this.orphans.push(i); }
      i = head[a];
    }
    for (let i = q; ;) {
      const a = parent[i];
      if (a === TERMINAL) {
        trCap[i] += bottleneck;
        if (trCap[i] === 0) { parent[i] = ORPHAN; this.orphans.push(i); }
        break;
      }
      cap[a ^ 1] += bottleneck;
      cap[a] -= bottleneck;
      if (cap[a] === 0) { parent[i] = ORPHAN; this.orphans.push(i); }
      i = head[a];
    }

    return bottleneck;
  }

  /** Re-attach every orphan, or free it and orphan its children in turn. */
  _adoptAll(time) {
    const orphans = this.orphans;
    while (orphans.length) {
      const i = orphans.shift();
      if (this.tree[i] === SOURCE) this._adopt(i, time, true);
      else this._adopt(i, time, false);
    }
  }

  _adopt(i, time, isSource) {
    const { cap, head, nextArc, firstArc, parent, tree, ts, dist } = this;
    const want = isSource ? SOURCE : SINK;
    let bestArc = NONE;
    let bestDist = INF_DIST;

    for (let a = firstArc[i]; a !== -1; a = nextArc[a]) {
      const q = head[a];
      if (tree[q] !== want) continue;
      // A parent must be able to push into i: for the source tree that is the
      // arc q -> i, which is the sister of a.
      if (cap[isSource ? a ^ 1 : a] <= 0) continue;

      // Origin check: walk up from q and make sure the branch still ends at a
      // terminal rather than at an orphan.
      let d = 0;
      let j = q;
      for (;;) {
        if (ts[j] === time) { d += dist[j]; break; }
        const a2 = parent[j];
        d++;
        if (a2 === TERMINAL) { ts[j] = time; dist[j] = 1; break; }
        if (a2 === ORPHAN || a2 === NONE) { d = INF_DIST; break; }
        j = head[a2];
      }
      if (d >= INF_DIST) continue;

      if (d < bestDist) { bestArc = a; bestDist = d; }

      // Cache the distances we just walked, so the next origin check is cheap.
      let k = d;
      for (let m = q; ts[m] !== time; m = head[parent[m]]) {
        ts[m] = time;
        dist[m] = k--;
      }
    }

    if (bestArc !== NONE) {
      parent[i] = bestArc;
      ts[i] = time;
      dist[i] = bestDist + 1;
      return;
    }

    // Nothing can adopt it: the node leaves the tree, and anything that called
    // it a parent is orphaned too.
    for (let a = firstArc[i]; a !== -1; a = nextArc[a]) {
      const q = head[a];
      if (tree[q] !== want) continue;
      const a2 = parent[q];
      if (a2 === NONE) continue;
      /*
       * Re-queue a neighbour that can now grow INTO the node being freed.
       * `a` runs i -> q, so growth from q into i travels the sister arc, and the
       * residual to test is the sister's: for the source tree `cap[a ^ 1]`
       * (q -> i), for the sink tree `cap[a]` (i -> q).
       *
       * This had the pair the wrong way round. The reference algorithm tests
       * `a0->sister->r_cap` here, and getting it backwards means a node that
       * could still grow is never made active again: the search tree stops early
       * and the "maximum" flow can be short, with `inSource()` returning a
       * partition that is not a minimum cut. It survived 190 random graphs and
       * two grid tests against Edmonds-Karp, which is exactly why an audit that
       * reads the algorithm against its source is worth more than another
       * hundred random graphs.
       */
      if (cap[isSource ? a ^ 1 : a] > 0) this._setActive(q);
      if (a2 !== TERMINAL && a2 !== ORPHAN && head[a2] === i) {
        parent[q] = ORPHAN;
        this.orphans.push(q);
      }
    }
    tree[i] = FREE;
    parent[i] = NONE;
  }

  /* ------------------------------------------------------------------ */
  /* Reading the cut                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Which side of the minimum cut a node ended on. True is the source side.
   * A node left free by the algorithm is unreachable from the source in the
   * residual graph, so it belongs to the sink side.
   */
  inSource(i) {
    return this.tree[i] === SOURCE;
  }

  /** The source side of the cut as a byte per node — handy for masks. */
  sourceMask(out = new Uint8Array(this.n)) {
    for (let i = 0; i < this.n; i++) out[i] = this.tree[i] === SOURCE ? 1 : 0;
    return out;
  }
}
