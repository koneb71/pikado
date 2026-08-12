/**
 * Snapping, bound to the editor.
 *
 * `snap.js` is the pure solver and knows nothing about Pikado. This is the
 * layer that gathers what a document offers to snap to — its guides, its edges,
 * the grid, the other layers — and applies the two rules every call site shares:
 *
 * - `View > Snap` off means nothing snaps.
 * - Holding Ctrl (Cmd on a Mac) suspends snapping for the duration of a drag.
 *   That is the Photoshop convention, and it is the escape hatch for putting
 *   something exactly one pixel off a guide.
 *
 * Every tool that drags a rectangle around should go through `snapRect` rather
 * than reaching for the solver, so the rules stay in one place.
 */

import { app } from './app.js';
import { LayerType } from './layer.js';
import { layerBounds } from './layer-bounds.js';
import { solveSnap, snapPosition, snapThreshold } from './snap.js';

/** True when this event should suspend snapping. */
export function snapSuspended(e) {
  return !app.snap || !!(e && (e.ctrlKey || e.metaKey));
}

/* ------------------------------------------------------------------ */
/* The hints on screen                                                 */
/* ------------------------------------------------------------------ */

/**
 * The lines the last solved snap landed on.
 *
 * Kept here rather than on the drag state of whichever tool is running, so the
 * canvas overlay has one thing to read and every call site gets the hints
 * without wiring anything up. Recorded on every solve — including the ones that
 * find nothing and the ones Ctrl suspends, so the hints vanish the instant they
 * stop being true — and cleared by whoever ends the drag.
 */
let lines = [];

export function snapLines() {
  return lines;
}

export function clearSnapLines() {
  if (!lines.length) return false;
  lines = [];
  return true;
}

/**
 * Everything in a document worth aligning to.
 *
 * @param {object} doc
 * @param {object} [opts]
 * @param {Set|Array} [opts.exclude]  layers to leave out — the ones being moved,
 *   which would otherwise offer their own current position as a snap target and
 *   glue the drag in place.
 * @param {object} [opts.excludeGuide]  a guide being dragged, for the same reason.
 * @param {boolean} [opts.layers=true]  gather other layers' edges (smart guides).
 */
export function snapTargets(doc, opts = {}) {
  const targets = {
    guides: [],
    gridSize: app.gridSize,
    docWidth: doc.width,
    docHeight: doc.height,
    rects: [],
  };

  for (const g of doc.guides || []) {
    if (g !== opts.excludeGuide) targets.guides.push(g);
  }

  if (opts.layers !== false) {
    const skip = opts.exclude instanceof Set ? opts.exclude : new Set(opts.exclude || []);
    for (const l of doc.flatLayers()) {
      if (skip.has(l) || l.type === LayerType.GROUP || !l.visible) continue;
      /*
       * `layerBounds` is keyed on the layer's pixel buffer, so measuring every
       * layer in the document does not materialise any of them. Reaching for
       * `layer.canvas` here instead would expand the whole document on the
       * first drag.
       */
      const b = layerBounds(l);
      if (b) targets.rects.push(b);
    }
  }
  return targets;
}

/**
 * Snap a moving rectangle.
 *
 * @param {{x,y,width,height}} rect  where it is right now, in document space
 * @param {object} doc
 * @param {object} [opts]  `exclude`, `excludeGuide`, `layers` as above, plus
 *   `event` (the pointer event, for the Ctrl escape hatch) and `axes`.
 * @returns {{dx:number, dy:number, lines:Array}} zero and no lines when nothing
 *   is in range, so callers can add the result unconditionally.
 */
export function snapRect(rect, doc, opts = {}) {
  if (!rect || !doc || snapSuspended(opts.event)) {
    lines = [];
    return { dx: 0, dy: 0, lines };
  }
  const r = solveSnap(rect, snapTargets(doc, opts), {
    threshold: snapThreshold(app.viewport.scale),
    axes: opts.axes,
  });
  lines = r.lines;
  return r;
}

/**
 * Snap a single position on one axis — what dragging a guide needs, as opposed
 * to a whole rectangle.
 *
 * @param {number} pos
 * @param {'h'|'v'} axis  the orientation of the guide being dragged
 */
export function snapGuidePos(pos, axis, doc, opts = {}) {
  if (!doc || snapSuspended(opts.event)) {
    lines = [];
    return pos;
  }
  const r = snapPosition(pos, axis, snapTargets(doc, opts), snapThreshold(app.viewport.scale));
  /*
   * The guide it landed on would be drawn twice, once as a hint and once as
   * itself, so leave those out — what is worth showing is the layer edge or
   * document centre that the guide is now lined up with.
   */
  lines = r.lines.filter((l) => l.kind !== 'guide');
  return r.pos;
}
