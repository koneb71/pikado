/**
 * The pen group: pen, freeform pen, curvature pen and the three
 * add/delete/convert point tools.
 *
 * `VectorTool` (exported) carries the Path / Shape / Pixels output mode plus
 * the fill and stroke options; `src/tools/shape.js` extends it too.
 */

import { app } from '../core/app.js';
import { Tool, registerTool, getTool } from './base.js';
import { createCanvas, ctx2d, ctx2dRead } from '../core/util.js';
import { LayerType } from '../core/layer.js';
import { toCss } from '../core/color.js';
import { getComposite } from '../render/compositor.js';
import { PaintStroke, brushFromOptions } from '../paint/brush-engine.js';
import { sep } from '../ui/canvas-menu.js';
import {
  createSubpath, createPoint, drawPathOverlay, hitTestPoint, hitTestSegment,
  insertPointAt, removePoint, convertPoint, smoothSubpath, fitCurve,
  createShapeLayer, appendSubpathsToDoc, paintSubpathsOnLayer, uniqueLayerName,
  findAnchorAt, findSegmentAt, findShapeAt, activeVectorTarget, beginVectorEdit,
  touchVectorTarget, commitVectorTarget, segmentOf, segmentCount, pointOnSegment,
  pathToPath2D, pathToSelectionMask,
} from '../vector/path.js';

/* ------------------------------------------------------------------ */
/* Shared options + base class                                         */
/* ------------------------------------------------------------------ */

export const DASH_OPTIONS = [
  { value: 'solid', label: 'Solid' },
  { value: 'dash', label: 'Dashed' },
  { value: 'dash-tight', label: 'Dashed (tight)' },
  { value: 'dot', label: 'Dotted' },
  { value: 'dash-dot', label: 'Dash-dot' },
  { value: 'long-dash', label: 'Long dash' },
];

/** The Path / Shape / Pixels selector shared by the pen and shape tools. */
export function modeOption(def = 'shape') {
  return {
    key: 'mode',
    label: 'Mode',
    type: 'select',
    default: def,
    options: [
      { value: 'shape', label: 'Shape' },
      { value: 'path', label: 'Path' },
      { value: 'pixels', label: 'Pixels' },
    ],
  };
}

/** Fill / stroke descriptors, hidden when the tool is only making a path. */
export function vectorStyleOptions() {
  const paints = (s) => s.mode !== 'path';
  return [
    { key: 'fill', label: 'Fill', type: 'color', default: '#4a90d9', when: paints },
    { key: 'noFill', label: 'No fill', type: 'checkbox', default: false, when: paints },
    { key: 'strokeColor', label: 'Stroke', type: 'color', default: '#000000', when: paints },
    { key: 'strokeWidth', label: 'Stroke width', type: 'number', min: 0, max: 400, step: 0.5, default: 0, unit: 'px', when: paints },
    {
      key: 'strokeAlign', label: 'Align', type: 'select', default: 'center',
      options: [{ value: 'inside', label: 'Inside' }, { value: 'center', label: 'Center' }, { value: 'outside', label: 'Outside' }],
      when: (s) => paints(s) && (s.strokeWidth || 0) > 0,
    },
    {
      key: 'strokeDash', label: 'Dash', type: 'select', default: 'solid', options: DASH_OPTIONS,
      when: (s) => paints(s) && (s.strokeWidth || 0) > 0,
    },
  ];
}

/**
 * Base class for every tool that produces vector geometry. Subclasses build
 * subpaths and call `outputSubpaths()`, which honours the Mode option.
 */
export class VectorTool extends Tool {
  constructor(opts) {
    super(opts);
    this.app = app;
  }

  /** Fill/stroke descriptor built from the current option values. */
  styleFromState() {
    const s = this.state;
    const width = Number(s.strokeWidth) || 0;
    return {
      fill: s.noFill ? { type: 'none' } : { type: 'solid', color: s.fill || '#000000' },
      stroke: {
        enabled: width > 0,
        color: s.strokeColor || '#000000',
        width,
        align: s.strokeAlign || 'center',
        cap: s.strokeCap || 'butt',
        join: s.strokeJoin || 'miter',
        dash: s.strokeDash || 'solid',
      },
    };
  }

  /** Screen-space tolerance converted to document units. */
  tol(px = 6) {
    return px / Math.max(0.02, app.viewport.scale);
  }

  /**
   * Emit finished geometry according to the Mode option.
   * @param {Array} subpaths
   * @param {string} label history label
   * @param {object} [meta] extra keys copied onto `layer.shape` (radius, sides…)
   * @returns {import('../core/layer.js').Layer|null} the shape layer, if any
   */
  outputSubpaths(subpaths, label, meta = {}) {
    const doc = this.doc;
    if (!doc || !subpaths || !subpaths.length) return null;
    const mode = this.state.mode || 'shape';

    if (mode === 'path') {
      appendSubpathsToDoc(doc, subpaths, 'Path');
      doc.commit(label);
      return null;
    }

    if (mode === 'pixels') {
      if (!this.canPaint()) return null;
      const layer = doc.activeLayer();
      const style = this.styleFromState();
      if (style.fill.type === 'none' && !style.stroke.enabled) {
        app.toast('Set a fill or a stroke width to draw pixels.');
        return null;
      }
      doc.beginEdit(layer);
      paintSubpathsOnLayer(doc, layer, subpaths, style);
      doc.commit(label);
      return null;
    }

    const style = { ...this.styleFromState(), ...meta };
    const layer = createShapeLayer(doc, subpaths, style, uniqueLayerName(doc, meta.baseName || 'Shape'));
    doc.addLayer(layer);
    doc.commit(label);
    return layer;
  }
}

/* ------------------------------------------------------------------ */
/* Point helpers                                                       */
/* ------------------------------------------------------------------ */

/** Freeze an anchor's coordinates so a drag can be applied as an offset. */
export function snapshotPoint(p) {
  return {
    x: p.x, y: p.y,
    in: p.in ? { x: p.in.x, y: p.in.y } : null,
    out: p.out ? { x: p.out.x, y: p.out.y } : null,
  };
}

/** Move an anchor (and its handles) to `origin + delta`. */
export function movePointTo(p, origin, dx, dy) {
  p.x = origin.x + dx;
  p.y = origin.y + dy;
  if (p.in && origin.in) { p.in.x = origin.in.x + dx; p.in.y = origin.in.y + dy; }
  if (p.out && origin.out) { p.out.x = origin.out.x + dx; p.out.y = origin.out.y + dy; }
}

/* ------------------------------------------------------------------ */
/* Context-menu helpers (shared with path-select.js and shape.js)      */
/* ------------------------------------------------------------------ */

/**
 * The path actions live here rather than in `ui/panels/paths.js` because that
 * panel keeps them as closures inside `build()` and exports nothing. They call
 * the same helpers it does (`pathToSelectionMask`, `pathToPath2D`, the brush
 * engine) so a path filled from the canvas menu matches one filled from the
 * panel button.
 */

/**
 * The layer Fill/Stroke Path can draw onto, or null. Shape and text layers are
 * excluded: their pixels are re-derived from the geometry, so a fill painted
 * into them would silently disappear on the next edit.
 */
function paintablePathLayer(doc) {
  const l = doc && doc.activeLayer();
  if (!l) return null;
  if (l.locked.all || l.locked.pixels) return null;
  if (l.editingMask && l.mask) return l;
  return l.type === LayerType.RASTER && l.canvas ? l : null;
}

/** Flatten a subpath into a polyline the brush engine can walk. */
function flattenSubpath(sp, steps = 24) {
  const pts = sp.points || [];
  const out = [];
  if (!pts.length) return out;
  out.push({ x: pts[0].x, y: pts[0].y });
  const segs = segmentCount(sp);
  for (let i = 0; i < segs; i++) {
    const s = segmentOf(sp, i);
    if (!s) continue;
    if (s.straight) { out.push({ x: s.p3.x, y: s.p3.y }); continue; }
    for (let k = 1; k <= steps; k++) {
      const p = pointOnSegment([sp], 0, i, k / steps);
      if (p) out.push(p);
    }
  }
  return out;
}

/** Load subpaths as the document selection. */
function makeSelectionFromPath(doc, subpaths) {
  let mask = null;
  try {
    mask = pathToSelectionMask(subpaths, doc.width, doc.height);
  } catch (err) {
    console.warn('[pen] pathToSelectionMask failed', err);
  }
  if (!mask || mask.length !== doc.width * doc.height) {
    app.toast('That path cannot be turned into a selection.', 'warn');
    return;
  }
  doc.selection.set(mask instanceof Uint8ClampedArray ? mask : Uint8ClampedArray.from(mask));
  doc.emit('selection-change');
  doc.commit('Make Selection from Path');
}

/** Fill subpaths with the foreground colour on the active raster layer. */
function fillPathWithForeground(doc, subpaths) {
  const layer = paintablePathLayer(doc);
  if (!layer) { app.toast('Select an unlocked raster layer first.', 'warn'); return; }
  const tmp = createCanvas(doc.width, doc.height);
  const tc = ctx2d(tmp);
  tc.fillStyle = toCss(app.foreground);
  tc.fill(pathToPath2D(subpaths));
  if (doc.selection.active) {
    tc.globalCompositeOperation = 'destination-in';
    tc.drawImage(doc.selection.toAlphaCanvas(), 0, 0);
    tc.globalCompositeOperation = 'source-over';
  }
  doc.beginEdit(layer);
  ctx2d(layer.paintTarget()).drawImage(tmp, 0, 0);
  doc.commit('Fill Path');
}

/** Stroke subpaths with the current brush on the active raster layer. */
function strokePathWithBrush(doc, subpaths) {
  const layer = paintablePathLayer(doc);
  if (!layer) { app.toast('Select an unlocked raster layer first.', 'warn'); return; }
  const brushTool = getTool('brush');
  const brush = brushFromOptions(brushTool ? brushTool.state : {}, { smoothing: 0, airbrush: false });
  doc.beginEdit(layer);
  const stroke = new PaintStroke({
    doc, layer, target: layer.paintTarget(), brush, mode: 'paint', color: toCss(app.foreground),
  });
  let drew = false;
  for (const sp of subpaths) {
    const line = flattenSubpath(sp);
    if (line.length < 2) continue;
    stroke.begin(line[0].x, line[0].y, 1);
    for (let i = 1; i < line.length; i++) stroke.move(line[i].x, line[i].y, 1);
    if (sp.closed) stroke.move(line[0].x, line[0].y, 1);
    stroke.end();
    drew = true;
  }
  if (!drew) { app.toast('That path has nothing to stroke.', 'warn'); return; }
  stroke.flush();
  doc.commit('Stroke Path');
}

/** Drop a Paths-panel entry. */
function deletePathRecord(doc, path) {
  const i = doc.paths.indexOf(path);
  if (i < 0) return;
  doc.paths.splice(i, 1);
  if (doc.activePathId === path.id) doc.activePathId = doc.paths[0] ? doc.paths[0].id : null;
  doc.commit('Delete Path');
}

/**
 * The vector target a canvas menu should act on: whatever the click landed on,
 * else the active path or shape layer.
 * @returns {{kind:'layer'|'path', layer?:object, path?:object, subpaths:Array}|null}
 */
export function pathTargetAt(doc, e, tol) {
  if (!doc) return null;
  const hit = findShapeAt(doc, e.x, e.y, tol);
  if (hit) return hit.target;
  const t = activeVectorTarget(doc);
  return t && t.subpaths && t.subpaths.length ? t : null;
}

/**
 * Make Selection / Fill Path / Stroke Path / Delete Path for `target`.
 * Returns `[]` when there is no geometry, so the menu stays short instead of
 * showing four dead rows.
 */
export function pathActionItems(doc, target) {
  if (!doc || !target || !target.subpaths || !target.subpaths.length) return [];
  const subpaths = target.subpaths;
  const paintable = !!paintablePathLayer(doc);
  const items = [
    { label: 'Make Selection', run: () => makeSelectionFromPath(doc, subpaths) },
    { label: 'Fill Path', run: () => fillPathWithForeground(doc, subpaths), disabled: !paintable },
    { label: 'Stroke Path', run: () => strokePathWithBrush(doc, subpaths), disabled: !paintable },
  ];
  if (target.kind === 'path' && target.path) {
    items.push(sep());
    items.push({ label: 'Delete Path', run: () => deletePathRecord(doc, target.path) });
  }
  return items;
}

/**
 * Where a right-click landed on path geometry: an anchor, or a segment.
 * `live` describes a subpath a tool is still drawing (not yet in the document).
 */
function anchorSite(doc, e, tol, live) {
  if (live && live.subpaths && live.subpaths[0] && (live.subpaths[0].points || []).length) {
    const a = hitTestPoint(live.subpaths, e.x, e.y, tol);
    if (a && a.kind === 'anchor') return { live, subpaths: live.subpaths, hit: a };
    const s = hitTestSegment(live.subpaths, e.x, e.y, tol);
    if (s) return { live, subpaths: live.subpaths, hit: s };
  }
  if (!doc) return null;
  const fa = findAnchorAt(doc, e.x, e.y, tol);
  if (fa && fa.hit.kind === 'anchor') return { target: fa.target, subpaths: fa.target.subpaths, hit: fa.hit };
  const fs = findSegmentAt(doc, e.x, e.y, tol);
  if (fs) return { target: fs.target, subpaths: fs.target.subpaths, hit: fs.hit };
  return null;
}

/**
 * Add / Delete / Convert Point rows — offered only when the click actually hits
 * a segment or an anchor.
 * @param {object} doc
 * @param {object} e normalised pointer event
 * @param {number} tol document-space hit tolerance
 * @param {{subpaths:Array, changed:Function}} [live] subpath still being drawn
 */
export function anchorEditItems(doc, e, tol, live = null) {
  const site = anchorSite(doc, e, tol, live);
  if (!site) return [];

  const begin = () => { if (site.target) beginVectorEdit(doc, site.target); };
  const done = (label) => {
    if (site.target) commitVectorTarget(doc, site.target, label);
    else if (site.live && site.live.changed) site.live.changed();
    app.requestRender();
  };

  if (site.hit.kind === 'anchor') {
    const sp = site.subpaths[site.hit.subpathIndex];
    const p = sp && sp.points[site.hit.pointIndex];
    if (!p) return [];
    const smooth = !!(p.in || p.out);
    return [
      {
        label: 'Delete Anchor Point',
        run: () => {
          begin();
          removePoint(site.subpaths, site.hit.subpathIndex, site.hit.pointIndex);
          done('Delete Anchor Point');
        },
      },
      {
        label: smooth ? 'Convert to Corner Point' : 'Convert to Smooth Point',
        run: () => {
          begin();
          convertPoint(site.subpaths, site.hit.subpathIndex, site.hit.pointIndex, !smooth);
          done('Convert Anchor Point');
        },
      },
    ];
  }

  return [{
    label: 'Add Anchor Point',
    run: () => {
      begin();
      insertPointAt(site.subpaths, site.hit.subpathIndex, site.hit.segmentIndex, site.hit.t);
      done('Add Anchor Point');
    },
  }];
}

/**
 * The path-flavoured canvas menu every pen tool shares: what the click hit,
 * then the actions for the path itself.
 * @param {Tool} tool
 * @param {object} e normalised pointer event
 * @param {{live?:object, extra?:Array}} [o]
 */
function penMenu(tool, e, o = {}) {
  const doc = tool.doc;
  if (!doc) return [];
  const tol = tool.tol(7);
  const items = anchorEditItems(doc, e, tol, o.live || null);
  if (o.extra && o.extra.length) items.push(sep(), ...o.extra);
  items.push(sep());
  items.push(...pathActionItems(doc, pathTargetAt(doc, e, tol)));
  return items;
}

/* ------------------------------------------------------------------ */
/* Overlay helpers                                                     */
/* ------------------------------------------------------------------ */

function drawRubberBand(ctx, view, from, to) {
  const a = view.toScreen(from.x, from.y);
  const b = view.toScreen(to.x, to.y);
  ctx.save();
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,0,0,.6)';
  ctx.beginPath();
  if (from.out) {
    const c = view.toScreen(from.out.x, from.out.y);
    ctx.moveTo(a.x, a.y);
    ctx.bezierCurveTo(c.x, c.y, b.x, b.y, b.x, b.y);
  } else {
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  ctx.strokeStyle = '#3da9ff';
  ctx.lineDashOffset = 4;
  ctx.stroke();
  ctx.restore();
}

function drawCloseHint(ctx, view, pt) {
  const s = view.toScreen(pt.x, pt.y);
  ctx.save();
  ctx.beginPath();
  ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.strokeStyle = '#3da9ff';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.restore();
}

/** Draw the document's stored paths faintly so the pen tools have context. */
function drawStoredPaths(ctx, view, doc, opts = {}) {
  for (const p of doc.paths || []) {
    if (!p.subpaths || !p.subpaths.length) continue;
    drawPathOverlay(ctx, p.subpaths, view, {
      color: p.id === doc.activePathId ? '#3da9ff' : 'rgba(120,180,255,.55)',
      handles: 'none',
      anchors: opts.anchors !== false && p.id === doc.activePathId,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Pen                                                                 */
/* ------------------------------------------------------------------ */

class PenTool extends VectorTool {
  constructor() {
    super({
      id: 'pen', name: 'Pen Tool', icon: 'pen', cursor: 'crosshair', shortcut: 'P',
      group: 'pen', groupOrder: 14,
      options: [
        modeOption('shape'),
        ...vectorStyleOptions(),
        { key: 'autoAddDelete', label: 'Auto Add/Delete', type: 'checkbox', default: true },
        { key: 'rubberBand', label: 'Rubber Band', type: 'checkbox', default: true },
      ],
    });
    /** @type {{closed:boolean, points:object[]}|null} */
    this.sp = null;
    this.drag = null;
    this.cursorPt = null;
    this.hoverClose = false;
    this.closing = false;
  }

  onDeactivate() {
    this.commit();
  }

  onPointerDown(e) {
    const doc = this.doc;
    if (!doc) return;
    const tol = this.tol();

    if (this.sp && this.sp.points.length) {
      const pts = this.sp.points;
      const first = pts[0];
      if (pts.length >= 2 && Math.hypot(e.x - first.x, e.y - first.y) <= tol) {
        this.sp.closed = true;
        this.drag = { point: first, mode: 'close', start: { x: e.x, y: e.y }, moved: false };
        this.closing = true;
        app.requestRender();
        return;
      }
      if (this.state.autoAddDelete) {
        const wrap = [this.sp];
        const hitPt = hitTestPoint(wrap, e.x, e.y, tol);
        if (hitPt && hitPt.kind === 'anchor' && hitPt.pointIndex !== pts.length - 1) {
          pts.splice(hitPt.pointIndex, 1);
          if (pts.length < 2) this.sp.closed = false;
          app.requestRender();
          return;
        }
        const hitSeg = hitTestSegment(wrap, e.x, e.y, tol);
        if (hitSeg) {
          const added = insertPointAt(wrap, 0, hitSeg.segmentIndex, hitSeg.t);
          if (added) {
            const np = pts[added.pointIndex];
            this.drag = { point: np, mode: 'move', start: { x: e.x, y: e.y }, moved: false, origin: snapshotPoint(np) };
            app.requestRender();
            return;
          }
        }
      }
    }

    if (!this.sp) this.sp = createSubpath(false);
    const p = createPoint(e.x, e.y);
    this.sp.points.push(p);
    this.drag = { point: p, mode: 'new', start: { x: e.x, y: e.y }, moved: false };
    app.requestRender();
  }

  onPointerMove(e) {
    this.cursorPt = { x: e.x, y: e.y };
    const tol = this.tol();
    this.hoverClose = !!(this.sp && this.sp.points.length >= 2 && !this.sp.closed &&
      Math.hypot(e.x - this.sp.points[0].x, e.y - this.sp.points[0].y) <= tol);

    const d = this.drag;
    if (d) {
      if (!d.moved && Math.hypot(e.x - d.start.x, e.y - d.start.y) > 1.5 / Math.max(0.02, app.viewport.scale)) d.moved = true;
      if (d.moved) {
        const p = d.point;
        if (d.mode === 'move') {
          movePointTo(p, d.origin, e.x - d.start.x, e.y - d.start.y);
        } else if (d.mode === 'close') {
          p.in = { x: e.x, y: e.y };
          if (!e.altKey) p.out = { x: 2 * p.x - e.x, y: 2 * p.y - e.y };
          p.corner = false;
        } else {
          p.out = { x: e.x, y: e.y };
          if (!e.altKey) p.in = { x: 2 * p.x - e.x, y: 2 * p.y - e.y };
          p.corner = false;
        }
      }
    }
    app.requestRender();
  }

  onPointerUp() {
    this.drag = null;
    if (this.closing) {
      this.closing = false;
      this.finishPath();
    }
    app.requestRender();
  }

  onDoubleClick() {
    if (this.sp) this.finishPath();
  }

  onKeyDown(e) {
    if (!this.sp) return false;
    if (e.key === 'Enter') { this.finishPath(); return true; }
    if (e.key === 'Escape') { this.cancel(); return true; }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      this.sp.points.pop();
      if (!this.sp.points.length) this.sp = null;
      app.requestRender();
      return true;
    }
    return false;
  }

  finishPath() {
    const sp = this.sp;
    this.sp = null;
    this.drag = null;
    this.closing = false;
    this.hoverClose = false;
    if (sp && sp.points.length >= 2) {
      this.outputSubpaths([sp], sp.closed ? 'Close Path' : 'Pen Tool', { baseName: 'Shape' });
    }
    app.requestRender();
  }

  commit() {
    if (this.sp) this.finishPath();
  }

  cancel() {
    this.sp = null;
    this.drag = null;
    this.closing = false;
    app.requestRender();
  }

  /** The subpath still being drawn, described for `anchorEditItems`. */
  liveSubpath() {
    if (!this.sp || !this.sp.points.length) return null;
    return {
      subpaths: [this.sp],
      changed: () => {
        if (!this.sp) return;
        if (this.sp.points.length < 2) this.sp.closed = false;
        if (!this.sp.points.length) this.sp = null;
      },
    };
  }

  contextMenu(e) {
    const open = this.sp && this.sp.points.length >= 2 && !this.sp.closed;
    return penMenu(this, e, {
      live: this.liveSubpath(),
      extra: open ? [{
        label: 'Close Path',
        run: () => {
          if (!this.sp || this.sp.points.length < 2) return;
          this.sp.closed = true;
          this.finishPath();
        },
      }] : [],
    });
  }

  drawOverlay(ctx, view) {
    const doc = this.doc;
    if (!doc) return;
    if (this.state.mode === 'path') drawStoredPaths(ctx, view, doc);
    if (!this.sp || !this.sp.points.length) return;
    drawPathOverlay(ctx, [this.sp], view, { handles: 'all' });
    const last = this.sp.points[this.sp.points.length - 1];
    if (this.state.rubberBand && this.cursorPt && !this.drag && !this.sp.closed) {
      drawRubberBand(ctx, view, last, this.cursorPt);
    }
    if (this.hoverClose) drawCloseHint(ctx, view, this.sp.points[0]);
  }
}

/* ------------------------------------------------------------------ */
/* Freeform pen (+ magnetic)                                           */
/* ------------------------------------------------------------------ */

class FreeformPenTool extends VectorTool {
  constructor() {
    super({
      id: 'pen-free', name: 'Freeform Pen Tool', icon: 'pen-free', cursor: 'crosshair', shortcut: 'P',
      group: 'pen', groupOrder: 14,
      options: [
        modeOption('shape'),
        ...vectorStyleOptions(),
        { key: 'fit', label: 'Curve Fit', type: 'slider', min: 0.5, max: 10, step: 0.5, default: 2, unit: 'px' },
        { key: 'magnetic', label: 'Magnetic', type: 'checkbox', default: false },
        { key: 'magneticWidth', label: 'Width', type: 'slider', min: 1, max: 40, step: 1, default: 10, unit: 'px', when: (s) => s.magnetic },
        { key: 'magneticContrast', label: 'Contrast', type: 'slider', min: 1, max: 100, step: 1, default: 10, unit: '%', when: (s) => s.magnetic },
      ],
    });
    this.pts = null;
    this.edges = null;
  }

  onPointerDown(e) {
    const doc = this.doc;
    if (!doc) return;
    if (this.state.magnetic) this.buildEdgeMap(doc);
    const p = this.state.magnetic ? this.snap(e.x, e.y) : { x: e.x, y: e.y };
    this.pts = [p];
    app.requestRender();
  }

  onPointerMove(e) {
    if (!this.pts) return;
    const p = this.state.magnetic ? this.snap(e.x, e.y) : { x: e.x, y: e.y };
    const last = this.pts[this.pts.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) < 1) return;
    this.pts.push(p);
    app.requestRender();
  }

  onPointerUp() {
    const pts = this.pts;
    this.pts = null;
    this.edges = null;
    if (!pts || pts.length < 2) { app.requestRender(); return; }
    const sp = fitCurve(pts, Number(this.state.fit) || 2);
    const first = sp.points[0];
    const last = sp.points[sp.points.length - 1];
    if (sp.points.length > 2 && Math.hypot(last.x - first.x, last.y - first.y) <= this.tol(10)) {
      // Snap the loop shut and fold the final handle onto the first anchor.
      if (last.in) { first.in = last.in; first.corner = false; }
      sp.points.pop();
      sp.closed = true;
    }
    if (sp.points.length >= 2) this.outputSubpaths([sp], 'Freeform Pen', { baseName: 'Shape' });
    app.requestRender();
  }

  cancel() {
    this.pts = null;
    this.edges = null;
    app.requestRender();
  }

  contextMenu(e) {
    return penMenu(this, e);
  }

  /** Sobel gradient magnitude over the flattened document. */
  buildEdgeMap(doc) {
    const comp = getComposite(doc);
    const w = comp.width, h = comp.height;
    const d = ctx2dRead(comp).getImageData(0, 0, w, h).data;
    const lum = new Float32Array(w * h);
    for (let i = 0, p = 0; p < w * h; p++, i += 4) {
      lum[p] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) * (d[i + 3] / 255);
    }
    const g = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx =
          -lum[i - w - 1] - 2 * lum[i - 1] - lum[i + w - 1] +
          lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1];
        const gy =
          -lum[i - w - 1] - 2 * lum[i - w] - lum[i - w + 1] +
          lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1];
        g[i] = Math.min(255, Math.hypot(gx, gy) / 4);
      }
    }
    this.edges = { g, w, h };
  }

  /** Pull a sample onto the strongest nearby edge. */
  snap(x, y) {
    const E = this.edges;
    if (!E) return { x, y };
    const r = Math.round(this.state.magneticWidth || 10);
    const threshold = ((this.state.magneticContrast || 10) / 100) * 255 * 0.4;
    const cx = Math.round(x), cy = Math.round(y);
    let best = null;
    let bestScore = threshold;
    for (let dy = -r; dy <= r; dy++) {
      const py = cy + dy;
      if (py < 1 || py >= E.h - 1) continue;
      for (let dx = -r; dx <= r; dx++) {
        const px = cx + dx;
        if (px < 1 || px >= E.w - 1) continue;
        const score = E.g[py * E.w + px] / (1 + 0.16 * Math.hypot(dx, dy));
        if (score > bestScore) {
          bestScore = score;
          best = { x: px + 0.5, y: py + 0.5 };
        }
      }
    }
    return best || { x, y };
  }

  drawOverlay(ctx, view) {
    if (!this.pts || this.pts.length < 2) return;
    ctx.save();
    ctx.beginPath();
    const a = view.toScreen(this.pts[0].x, this.pts[0].y);
    ctx.moveTo(a.x, a.y);
    for (let i = 1; i < this.pts.length; i++) {
      const s = view.toScreen(this.pts[i].x, this.pts[i].y);
      ctx.lineTo(s.x, s.y);
    }
    ctx.strokeStyle = 'rgba(0,0,0,.55)';
    ctx.lineWidth = 2.4;
    ctx.stroke();
    ctx.strokeStyle = '#3da9ff';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ */
/* Curvature pen                                                       */
/* ------------------------------------------------------------------ */

class CurvaturePenTool extends VectorTool {
  constructor() {
    super({
      id: 'pen-curvature', name: 'Curvature Pen Tool', icon: 'pen-curvature', cursor: 'crosshair', shortcut: 'P',
      group: 'pen', groupOrder: 14,
      options: [modeOption('shape'), ...vectorStyleOptions()],
    });
    this.sp = null;
    this.dragIndex = -1;
    this.cursorPt = null;
  }

  onDeactivate() {
    this.commit();
  }

  onPointerDown(e) {
    const doc = this.doc;
    if (!doc) return;
    const tol = this.tol();
    if (this.sp && this.sp.points.length) {
      const pts = this.sp.points;
      if (pts.length >= 2 && !this.sp.closed &&
          Math.hypot(e.x - pts[0].x, e.y - pts[0].y) <= tol) {
        this.sp.closed = true;
        smoothSubpath(this.sp, 1, true);
        this.finishPath();
        return;
      }
      const hit = hitTestPoint([this.sp], e.x, e.y, tol);
      if (hit && hit.kind === 'anchor') {
        this.dragIndex = hit.pointIndex;
        return;
      }
    }
    if (!this.sp) this.sp = createSubpath(false);
    const p = createPoint(e.x, e.y);
    p.corner = false;
    this.sp.points.push(p);
    this.dragIndex = this.sp.points.length - 1;
    smoothSubpath(this.sp, 1, true);
    app.requestRender();
  }

  onPointerMove(e) {
    this.cursorPt = { x: e.x, y: e.y };
    if (this.sp && this.dragIndex >= 0) {
      const p = this.sp.points[this.dragIndex];
      if (p) {
        p.x = e.x;
        p.y = e.y;
        smoothSubpath(this.sp, 1, true);
      }
    }
    app.requestRender();
  }

  onPointerUp() {
    this.dragIndex = -1;
    app.requestRender();
  }

  onDoubleClick(e) {
    if (!this.sp) return;
    const hit = hitTestPoint([this.sp], e.x, e.y, this.tol());
    if (!hit || hit.kind !== 'anchor') return;
    const p = this.sp.points[hit.pointIndex];
    convertPoint([this.sp], 0, hit.pointIndex, p.corner === true);
    smoothSubpath(this.sp, 1, true);
    app.requestRender();
  }

  onKeyDown(e) {
    if (!this.sp) return false;
    if (e.key === 'Enter') { this.finishPath(); return true; }
    if (e.key === 'Escape') { this.cancel(); return true; }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      this.sp.points.pop();
      if (!this.sp.points.length) this.sp = null;
      else smoothSubpath(this.sp, 1, true);
      app.requestRender();
      return true;
    }
    return false;
  }

  finishPath() {
    const sp = this.sp;
    this.sp = null;
    this.dragIndex = -1;
    if (sp && sp.points.length >= 2) {
      smoothSubpath(sp, 1, true);
      this.outputSubpaths([sp], 'Curvature Pen', { baseName: 'Shape' });
    }
    app.requestRender();
  }

  commit() {
    if (this.sp) this.finishPath();
  }

  cancel() {
    this.sp = null;
    this.dragIndex = -1;
    app.requestRender();
  }

  contextMenu(e) {
    const open = this.sp && this.sp.points.length >= 2 && !this.sp.closed;
    return penMenu(this, e, {
      live: this.sp && this.sp.points.length
        ? {
            subpaths: [this.sp],
            changed: () => {
              if (!this.sp) return;
              if (this.sp.points.length < 2) this.sp.closed = false;
              if (!this.sp.points.length) this.sp = null;
              else smoothSubpath(this.sp, 1, true);
            },
          }
        : null,
      extra: open ? [{
        label: 'Close Path',
        run: () => {
          if (!this.sp || this.sp.points.length < 2) return;
          this.sp.closed = true;
          smoothSubpath(this.sp, 1, true);
          this.finishPath();
        },
      }] : [],
    });
  }

  drawOverlay(ctx, view) {
    const doc = this.doc;
    if (!doc) return;
    if (this.state.mode === 'path') drawStoredPaths(ctx, view, doc);
    if (!this.sp || !this.sp.points.length) return;
    drawPathOverlay(ctx, [this.sp], view, { handles: 'none' });
    const last = this.sp.points[this.sp.points.length - 1];
    if (this.cursorPt && this.dragIndex < 0 && !this.sp.closed) drawRubberBand(ctx, view, last, this.cursorPt);
  }
}

/* ------------------------------------------------------------------ */
/* Add / delete / convert point                                        */
/* ------------------------------------------------------------------ */

/** Common overlay + target plumbing for the three point-editing tools. */
class PointEditTool extends VectorTool {
  constructor(opts) {
    super({ cursor: 'crosshair', group: 'pen', groupOrder: 14, options: [], ...opts });
    this.target = null;
  }

  currentTarget() {
    return this.target || activeVectorTarget(this.doc);
  }

  contextMenu(e) {
    return penMenu(this, e);
  }

  drawOverlay(ctx, view) {
    const doc = this.doc;
    if (!doc) return;
    const t = this.currentTarget();
    if (!t || !t.subpaths.length) return;
    drawPathOverlay(ctx, t.subpaths, view, { handles: 'all' });
  }
}

class AddAnchorTool extends PointEditTool {
  constructor() {
    super({ id: 'pen-add', name: 'Add Anchor Point Tool', icon: 'pen-add' });
  }

  onPointerDown(e) {
    const doc = this.doc;
    if (!doc) return;
    const found = findSegmentAt(doc, e.x, e.y, this.tol(7));
    if (!found) { app.toast('Click a path segment to add an anchor point.'); return; }
    this.target = found.target;
    beginVectorEdit(doc, found.target);
    insertPointAt(found.target.subpaths, found.hit.subpathIndex, found.hit.segmentIndex, found.hit.t);
    commitVectorTarget(doc, found.target, 'Add Anchor Point');
    app.requestRender();
  }
}

class DeleteAnchorTool extends PointEditTool {
  constructor() {
    super({ id: 'pen-delete', name: 'Delete Anchor Point Tool', icon: 'pen-delete' });
  }

  onPointerDown(e) {
    const doc = this.doc;
    if (!doc) return;
    const found = findAnchorAt(doc, e.x, e.y, this.tol(7));
    if (!found || found.hit.kind !== 'anchor') { app.toast('Click an anchor point to delete it.'); return; }
    this.target = found.target;
    beginVectorEdit(doc, found.target);
    removePoint(found.target.subpaths, found.hit.subpathIndex, found.hit.pointIndex);
    commitVectorTarget(doc, found.target, 'Delete Anchor Point');
    app.requestRender();
  }
}

class ConvertPointTool extends PointEditTool {
  constructor() {
    super({ id: 'pen-convert', name: 'Convert Point Tool', icon: 'pen-convert' });
    this.drag = null;
  }

  onPointerDown(e) {
    const doc = this.doc;
    if (!doc) return;
    const found = findAnchorAt(doc, e.x, e.y, this.tol(7));
    if (!found || found.hit.kind !== 'anchor') { app.toast('Click an anchor point to convert it.'); return; }
    this.target = found.target;
    beginVectorEdit(doc, found.target);
    const sp = found.target.subpaths[found.hit.subpathIndex];
    const p = sp.points[found.hit.pointIndex];
    const wasSmooth = !!(p.in || p.out);
    convertPoint(found.target.subpaths, found.hit.subpathIndex, found.hit.pointIndex, !wasSmooth);
    this.drag = { point: p, moved: false, start: { x: e.x, y: e.y } };
    touchVectorTarget(doc, found.target);
    app.requestRender();
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d) return;
    const doc = this.doc;
    if (!d.moved && Math.hypot(e.x - d.start.x, e.y - d.start.y) > this.tol(2)) d.moved = true;
    if (!d.moved) return;
    // Dragging sets the handle length and direction symmetrically.
    const p = d.point;
    p.out = { x: e.x, y: e.y };
    p.in = { x: 2 * p.x - e.x, y: 2 * p.y - e.y };
    p.corner = false;
    touchVectorTarget(doc, this.target);
    app.requestRender();
  }

  onPointerUp() {
    if (!this.drag) return;
    this.drag = null;
    commitVectorTarget(this.doc, this.target, 'Convert Anchor Point');
    app.requestRender();
  }
}

registerTool(new PenTool());
registerTool(new FreeformPenTool());
registerTool(new CurvaturePenTool());
registerTool(new AddAnchorTool());
registerTool(new DeleteAnchorTool());
registerTool(new ConvertPointTool());
