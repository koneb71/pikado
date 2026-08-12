/**
 * Snapping.
 *
 * Pikado has had guides, a grid, a layout dialog and a Snap toggle for a long
 * time, and until now nothing consumed any of it — you could lay out a
 * twelve-column grid and drag a layer straight through it. This is the piece
 * that was missing.
 *
 * Deliberately pure: a rectangle and a bag of candidate lines in, an adjustment
 * out. No DOM, no `app`, no viewport. Everything about snapping that can be
 * wrong — which edge wins, how ties break, whether the tolerance means anything
 * at 10% zoom — is decided here and can be tested without a browser.
 *
 * **The tolerance is in document units and the caller converts.** That is not a
 * detail. A fixed document-space tolerance behaves completely differently at
 * different zooms: 6 units is a comfortable nudge at 100% and an invisible
 * twitch at 800%, while at 10% zoom a layer would leap to a guide 6 screen
 * pixels — 60 document units — away. Callers pass `6 / viewport.scale`, which is
 * the convention `src/ui/rulers.js` already used for dragging a guide.
 */

/**
 * @typedef {object} SnapCandidate
 * @property {number} pos       position along the axis, in document units
 * @property {string} kind      'guide' | 'document' | 'layer' | 'grid'
 * @property {number} priority  lower wins a tie; see KIND_PRIORITY
 */

/**
 * What wins when two candidates are equally close.
 *
 * A guide is something the user placed deliberately, so it outranks everything.
 * The document's own edges and centre come next because they are structural. A
 * neighbouring layer's edge is a suggestion. The grid is the background hum and
 * loses to all of them — otherwise a guide sitting one unit off a grid line
 * would be unreachable.
 */
const KIND_PRIORITY = { guide: 0, document: 1, layer: 2, grid: 3 };

/** The three places on a moving rectangle that can align to something. */
function movingEdges(rect, axis) {
  const start = axis === 'x' ? rect.x : rect.y;
  const size = axis === 'x' ? rect.width : rect.height;
  return [
    { at: start, edge: 'start' },
    { at: start + size / 2, edge: 'centre' },
    { at: start + size, edge: 'end' },
  ];
}

/**
 * Every line a rectangle could snap to on one axis.
 *
 * @param {'x'|'y'} axis
 * @param {object} targets
 * @returns {SnapCandidate[]}
 */
function candidatesFor(axis, targets) {
  const out = [];
  const wantGuide = axis === 'x' ? 'v' : 'h';

  for (const g of targets.guides || []) {
    if (g && g.axis === wantGuide && Number.isFinite(g.pos)) {
      out.push({ pos: g.pos, kind: 'guide', priority: KIND_PRIORITY.guide });
    }
  }

  const extent = axis === 'x' ? targets.docWidth : targets.docHeight;
  if (Number.isFinite(extent) && extent > 0) {
    out.push({ pos: 0, kind: 'document', priority: KIND_PRIORITY.document });
    out.push({ pos: extent / 2, kind: 'document', priority: KIND_PRIORITY.document });
    out.push({ pos: extent, kind: 'document', priority: KIND_PRIORITY.document });
  }

  // Smart guides: the edges and centre of everything else in the document.
  for (const r of targets.rects || []) {
    if (!r) continue;
    const start = axis === 'x' ? r.x : r.y;
    const size = axis === 'x' ? r.width : r.height;
    if (!Number.isFinite(start) || !Number.isFinite(size)) continue;
    out.push({ pos: start, kind: 'layer', priority: KIND_PRIORITY.layer });
    out.push({ pos: start + size / 2, kind: 'layer', priority: KIND_PRIORITY.layer });
    out.push({ pos: start + size, kind: 'layer', priority: KIND_PRIORITY.layer });
  }
  return out;
}

/**
 * Solve one axis.
 *
 * Returns the correction and every line that ends up aligned by it, so the
 * overlay can draw all of them rather than just the one that won — lining up
 * with three things at once is exactly the moment the hint is most useful.
 */
function solveAxis(rect, axis, targets, threshold) {
  const edges = movingEdges(rect, axis);
  const fixed = candidatesFor(axis, targets);

  let best = null;
  const consider = (delta, candidate) => {
    const dist = Math.abs(delta);
    if (dist > threshold) return;
    if (!best
      || dist < best.dist - 1e-9
      || (Math.abs(dist - best.dist) <= 1e-9 && candidate.priority < best.priority)) {
      best = { delta, dist, priority: candidate.priority };
    }
  };

  for (const e of edges) {
    for (const c of fixed) consider(c.pos - e.at, c);
    /*
     * The grid is computed per edge rather than enumerated, because a grid has
     * no natural extent — the nearest multiple is the only candidate that can
     * ever win, so generating the rest would be work with no effect.
     */
    const g = targets.gridSize;
    if (Number.isFinite(g) && g > 0) {
      consider(Math.round(e.at / g) * g - e.at, { kind: 'grid', priority: KIND_PRIORITY.grid });
    }
  }

  if (!best) return { delta: 0, lines: [] };

  // Everything the winning correction happens to align, for the overlay.
  const lines = [];
  const axisLabel = axis === 'x' ? 'v' : 'h';
  for (const e of edges) {
    const moved = e.at + best.delta;
    for (const c of fixed) {
      if (Math.abs(c.pos - moved) <= 1e-6) lines.push({ axis: axisLabel, pos: c.pos, kind: c.kind });
    }
  }
  return { delta: best.delta, lines };
}

/**
 * Snap a moving rectangle to whatever is near it.
 *
 * @param {{x:number,y:number,width:number,height:number}} rect where it is now
 * @param {{guides?:Array, gridSize?:number, docWidth?:number, docHeight?:number, rects?:Array}} targets
 * @param {{threshold:number, axes?:'both'|'x'|'y'}} opts threshold in DOCUMENT units
 * @returns {{dx:number, dy:number, lines:Array<{axis:'h'|'v', pos:number, kind:string}>}}
 */
export function solveSnap(rect, targets = {}, opts = {}) {
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : 0;
  const axes = opts.axes || 'both';
  const none = { dx: 0, dy: 0, lines: [] };
  if (!rect || threshold <= 0) return none;

  const x = axes === 'y' ? { delta: 0, lines: [] } : solveAxis(rect, 'x', targets, threshold);
  const y = axes === 'x' ? { delta: 0, lines: [] } : solveAxis(rect, 'y', targets, threshold);
  return { dx: x.delta, dy: y.delta, lines: [...x.lines, ...y.lines] };
}

/**
 * Snap a single position on one axis — what dragging a guide out of the ruler
 * needs, as opposed to a whole rectangle.
 *
 * @param {number} pos
 * @param {'h'|'v'} axis the orientation of the thing being dragged
 * @param {object} targets
 * @param {number} threshold in document units
 * @returns {{pos:number, lines:Array}} the snapped position and the lines it
 *   ended up on, so the overlay has the same hints a rectangle drag gets.
 */
export function snapPosition(pos, axis, targets, threshold) {
  const along = axis === 'v' ? 'x' : 'y';
  const rect = along === 'x'
    ? { x: pos, y: 0, width: 0, height: 0 }
    : { x: 0, y: pos, width: 0, height: 0 };
  const r = solveSnap(rect, targets, { threshold, axes: along });
  return { pos: pos + (along === 'x' ? r.dx : r.dy), lines: r.lines };
}

/** The tolerance in document units for a given zoom. One place, one convention. */
export function snapThreshold(scale, screenPixels = 6) {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return screenPixels / s;
}
