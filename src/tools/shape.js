/**
 * Vector shape tools: rectangle, rounded rectangle, ellipse, polygon/star,
 * line and custom shape.
 *
 * All six share `VectorTool` from `./pen.js`, so the Mode option decides
 * whether a drag produces a shape layer, a stored path, or pixels.
 *
 * Drag modifiers: Shift constrains proportions (square / circle / 45°),
 * Alt draws from the centre, Space repositions while still dragging.
 */

import { app } from '../core/app.js';
import { registerTool } from './base.js';
import { LayerType } from '../core/layer.js';
import { cmd, sep } from '../ui/canvas-menu.js';
import { getCommand, labelOf, formatAccel, runCommand } from '../commands/registry.js';
import { drawPathOverlay, smoothSubpath, findShapeAt } from '../vector/path.js';
import { CUSTOM_SHAPES, CUSTOM_SHAPE_OPTIONS, shapeToSubpaths } from '../vector/shapes.js';
import { VectorTool, modeOption, vectorStyleOptions } from './pen.js';

const K = 0.5522847498;

/* ------------------------------------------------------------------ */
/* Geometry builders                                                   */
/* ------------------------------------------------------------------ */

function pt(x, y, inH, outH) {
  return { x, y, in: inH || null, out: outH || null, corner: !inH && !outH };
}

/** Axis-aligned rectangle as a closed subpath. */
export function rectSubpath(r) {
  return {
    closed: true,
    points: [
      pt(r.x, r.y),
      pt(r.x + r.width, r.y),
      pt(r.x + r.width, r.y + r.height),
      pt(r.x, r.y + r.height),
    ],
  };
}

/**
 * Rounded rectangle.
 * @param {{x,y,width,height}} r
 * @param {number[]} radii [topLeft, topRight, bottomRight, bottomLeft]
 */
export function roundedRectSubpath(r, radii) {
  const lim = Math.min(r.width, r.height) / 2;
  const [a, b, c, d] = radii.map((v) => Math.max(0, Math.min(lim, v || 0)));
  if (!a && !b && !c && !d) return rectSubpath(r);
  const x0 = r.x, y0 = r.y, x1 = r.x + r.width, y1 = r.y + r.height;
  const p = [];

  if (a > 0) {
    p.push(pt(x0, y0 + a, null, { x: x0, y: y0 + a - a * K }));
    p.push(pt(x0 + a, y0, { x: x0 + a - a * K, y: y0 }, null));
  } else p.push(pt(x0, y0));

  if (b > 0) {
    p.push(pt(x1 - b, y0, null, { x: x1 - b + b * K, y: y0 }));
    p.push(pt(x1, y0 + b, { x: x1, y: y0 + b - b * K }, null));
  } else p.push(pt(x1, y0));

  if (c > 0) {
    p.push(pt(x1, y1 - c, null, { x: x1, y: y1 - c + c * K }));
    p.push(pt(x1 - c, y1, { x: x1 - c + c * K, y: y1 }, null));
  } else p.push(pt(x1, y1));

  if (d > 0) {
    p.push(pt(x0 + d, y1, null, { x: x0 + d - d * K, y: y1 }));
    p.push(pt(x0, y1 - d, { x: x0, y: y1 - d + d * K }, null));
  } else p.push(pt(x0, y1));

  return { closed: true, points: p };
}

/** Ellipse inscribed in a rectangle. */
export function ellipseSubpath(r) {
  const rx = r.width / 2, ry = r.height / 2;
  const cx = r.x + rx, cy = r.y + ry;
  const kx = rx * K, ky = ry * K;
  return {
    closed: true,
    points: [
      pt(cx, cy - ry, { x: cx - kx, y: cy - ry }, { x: cx + kx, y: cy - ry }),
      pt(cx + rx, cy, { x: cx + rx, y: cy - ky }, { x: cx + rx, y: cy + ky }),
      pt(cx, cy + ry, { x: cx + kx, y: cy + ry }, { x: cx - kx, y: cy + ry }),
      pt(cx - rx, cy, { x: cx - rx, y: cy + ky }, { x: cx - rx, y: cy - ky }),
    ],
  };
}

/**
 * Regular polygon or star.
 * @param {number} indent percentage the sides are pulled in by (stars only)
 */
export function polygonSubpath(cx, cy, radius, sides, star, indent, rotation, smooth) {
  const n = Math.max(3, Math.min(100, Math.round(sides)));
  const inner = radius * Math.max(0.02, 1 - (indent == null ? 50 : indent) / 100);
  const points = [];
  const count = star ? n * 2 : n;
  const step = (Math.PI * 2) / count;
  for (let i = 0; i < count; i++) {
    const rr = star && i % 2 ? inner : radius;
    const a = rotation + i * step;
    points.push(pt(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr));
  }
  const sp = { closed: true, points };
  if (smooth) smoothSubpath(sp, 0.8);
  return sp;
}

function arrowHead(tip, ux, uy, halfWidth, length, concavity) {
  const vx = -uy, vy = ux;
  const bx = tip.x - ux * length;
  const by = tip.y - uy * length;
  const mx = bx + ux * length * concavity;
  const my = by + uy * length * concavity;
  return {
    closed: true,
    points: [
      pt(bx + vx * halfWidth, by + vy * halfWidth),
      pt(tip.x, tip.y),
      pt(bx - vx * halfWidth, by - vy * halfWidth),
      pt(mx, my),
    ],
  };
}

/**
 * A line rendered as filled geometry: a shaft rectangle plus optional
 * arrowheads, each its own subpath (same winding so they union cleanly).
 */
export function lineSubpaths(p1, p2, weight, o = {}) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return [];
  const ux = dx / len, uy = dy / len;
  const vx = -uy, vy = ux;
  const half = Math.max(0.25, weight) / 2;
  const aw = (Math.max(1, weight) * (o.arrowWidth == null ? 500 : o.arrowWidth)) / 100 / 2;
  const al = (Math.max(1, weight) * (o.arrowLength == null ? 1000 : o.arrowLength)) / 100;
  const conc = Math.max(-0.5, Math.min(0.5, (o.concavity || 0) / 100));

  const startInset = o.arrowStart ? Math.min(al, len / 2) : 0;
  const endInset = o.arrowEnd ? Math.min(al, len / 2) : 0;
  const s = { x: p1.x + ux * startInset, y: p1.y + uy * startInset };
  const e = { x: p2.x - ux * endInset, y: p2.y - uy * endInset };

  const out = [{
    closed: true,
    points: [
      pt(s.x + vx * half, s.y + vy * half),
      pt(e.x + vx * half, e.y + vy * half),
      pt(e.x - vx * half, e.y - vy * half),
      pt(s.x - vx * half, s.y - vy * half),
    ],
  }];
  if (o.arrowEnd) out.push(arrowHead(p2, ux, uy, aw, al, conc));
  if (o.arrowStart) out.push(arrowHead(p1, -ux, -uy, aw, al, conc));
  return out;
}

/* ------------------------------------------------------------------ */
/* Context menu                                                        */
/* ------------------------------------------------------------------ */

/**
 * A command row that acts on `layer`.
 *
 * Command refs resolve against the *active* layer, so when the right-click
 * landed on a different shape layer the row selects it before running. Every
 * command used below only needs "some layer is active" to be enabled, so
 * selecting first cannot turn a live row into a dead one.
 */
function layerRow(doc, layer, id, over = {}) {
  if (doc.activeLayer() === layer) return cmd(id, over);
  const c = getCommand(id);
  if (!c) {
    console.warn(`[shape] unknown command: ${id}`);
    return null;
  }
  return {
    label: over.label || labelOf(id),
    accel: formatAccel(c.accel),
    run: () => {
      doc.setActiveLayer(layer.id);
      runCommand(id);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Base tool                                                           */
/* ------------------------------------------------------------------ */

class ShapeToolBase extends VectorTool {
  constructor(opts) {
    super({ cursor: 'crosshair', group: 'shape', groupOrder: 17, shortcut: 'U', ...opts });
    this.label = opts.label || opts.name || 'Shape';
    this.start = null;
    this.cur = null;
    this.last = null;
    this.spaceDown = false;
    this.preview = null;
    this.mods = { shiftKey: false, altKey: false };
  }

  onPointerDown(e) {
    if (!this.doc) return;
    this.start = { x: e.x, y: e.y };
    this.cur = { x: e.x, y: e.y };
    this.last = { x: e.x, y: e.y };
    this.mods = { shiftKey: e.shiftKey, altKey: e.altKey };
    this.dragging = true;
    this.preview = null;
    app.requestRender();
  }

  onPointerMove(e) {
    if (!this.dragging) return;
    if (this.spaceDown) {
      this.start.x += e.x - this.last.x;
      this.start.y += e.y - this.last.y;
    }
    this.last = { x: e.x, y: e.y };
    this.cur = { x: e.x, y: e.y };
    this.mods = { shiftKey: e.shiftKey, altKey: e.altKey };
    this.preview = this.buildSubpaths();
    app.requestRender();
  }

  onPointerUp() {
    if (!this.dragging) return;
    this.dragging = false;
    this.spaceDown = false;
    const subs = this.preview;
    this.preview = null;
    if (subs && subs.length) this.outputSubpaths(subs, this.label, this.shapeMeta());
    this.start = null;
    this.cur = null;
    app.requestRender();
  }

  onKeyDown(e) {
    if (!this.dragging) return false;
    if (e.code === 'Space' || e.key === ' ') { this.spaceDown = true; return true; }
    if (e.key === 'Escape') { this.cancel(); return true; }
    if (e.key === 'Shift' || e.key === 'Alt') {
      this.mods = { shiftKey: e.shiftKey, altKey: e.altKey };
      this.preview = this.buildSubpaths();
      app.requestRender();
      return false;
    }
    return false;
  }

  onKeyUp(e) {
    if (e.code === 'Space' || e.key === ' ') {
      const was = this.spaceDown;
      this.spaceDown = false;
      return was && this.dragging;
    }
    return false;
  }

  cancel() {
    this.dragging = false;
    this.spaceDown = false;
    this.preview = null;
    this.start = null;
    this.cur = null;
    app.requestRender();
  }

  /** Rectangle implied by the drag, honouring Shift and Alt. */
  dragRect() {
    const s = this.start, c = this.cur;
    let w = c.x - s.x;
    let h = c.y - s.y;
    if (this.mods.shiftKey) {
      const m = Math.max(Math.abs(w), Math.abs(h));
      w = (w < 0 ? -1 : 1) * m;
      h = (h < 0 ? -1 : 1) * m;
    }
    if (this.mods.altKey) {
      return { x: s.x - Math.abs(w), y: s.y - Math.abs(h), width: Math.abs(w) * 2, height: Math.abs(h) * 2 };
    }
    return {
      x: w < 0 ? s.x + w : s.x,
      y: h < 0 ? s.y + h : s.y,
      width: Math.abs(w),
      height: Math.abs(h),
    };
  }

  /** @returns {Array} subpaths — implemented by each tool */
  buildSubpaths() {
    return [];
  }

  /** Extra keys stored on `layer.shape` so the geometry can be re-derived. */
  shapeMeta() {
    return { baseName: this.label };
  }

  /** The shape layer under the cursor, else the active layer if it is one. */
  shapeLayerAt(e) {
    const doc = this.doc;
    if (!doc) return null;
    const hit = findShapeAt(doc, e.x, e.y, this.tol(6));
    if (hit && hit.target.kind === 'layer') return hit.target.layer;
    const a = doc.activeLayer();
    return a && a.type === LayerType.SHAPE ? a : null;
  }

  /** What you can do to the shape layer that was clicked. */
  contextMenu(e) {
    const doc = this.doc;
    const layer = this.shapeLayerAt(e);
    if (!layer) return [];
    const row = (id, over) => layerRow(doc, layer, id, over);
    return [
      doc.activeLayer() === layer ? null : { header: layer.name },
      row('layer.rasterize.shape', { label: 'Rasterize Layer' }),
      row('layer.style.options'),
      sep(),
      row('layer.duplicate'),
      row('layer.delete', { label: 'Delete Layer' }),
      sep(),
      row('layer.arrange.front'),
      row('layer.arrange.back'),
    ];
  }

  drawOverlay(ctx, view) {
    if (!this.preview || !this.preview.length) return;
    drawPathOverlay(ctx, this.preview, view, { handles: 'none', anchors: false });
  }
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

class RectangleTool extends ShapeToolBase {
  constructor() {
    super({
      id: 'rectangle', name: 'Rectangle Tool', label: 'Rectangle', icon: 'rectangle',
      options: [modeOption('shape'), ...vectorStyleOptions()],
    });
  }

  buildSubpaths() {
    const r = this.dragRect();
    if (r.width < 0.5 || r.height < 0.5) return [];
    return [rectSubpath(r)];
  }
}

class RoundedRectTool extends ShapeToolBase {
  constructor() {
    super({
      id: 'rounded-rect', name: 'Rounded Rectangle Tool', label: 'Rounded Rectangle', icon: 'rounded-rect',
      options: [
        modeOption('shape'),
        ...vectorStyleOptions(),
        { key: 'radius', label: 'Radius', type: 'number', min: 0, max: 2000, step: 1, default: 12, unit: 'px' },
        { key: 'independentCorners', label: 'Independent corners', type: 'checkbox', default: false },
        { key: 'radiusTL', label: 'Top left', type: 'number', min: 0, max: 2000, default: 12, unit: 'px', when: (s) => s.independentCorners },
        { key: 'radiusTR', label: 'Top right', type: 'number', min: 0, max: 2000, default: 12, unit: 'px', when: (s) => s.independentCorners },
        { key: 'radiusBR', label: 'Bottom right', type: 'number', min: 0, max: 2000, default: 12, unit: 'px', when: (s) => s.independentCorners },
        { key: 'radiusBL', label: 'Bottom left', type: 'number', min: 0, max: 2000, default: 12, unit: 'px', when: (s) => s.independentCorners },
      ],
    });
  }

  radii() {
    const s = this.state;
    if (!s.independentCorners) {
      const r = Number(s.radius) || 0;
      return [r, r, r, r];
    }
    return [Number(s.radiusTL) || 0, Number(s.radiusTR) || 0, Number(s.radiusBR) || 0, Number(s.radiusBL) || 0];
  }

  buildSubpaths() {
    const r = this.dragRect();
    if (r.width < 0.5 || r.height < 0.5) return [];
    return [roundedRectSubpath(r, this.radii())];
  }

  shapeMeta() {
    return { baseName: 'Rounded Rectangle', radius: Number(this.state.radius) || 0, corners: this.radii() };
  }
}

class EllipseTool extends ShapeToolBase {
  constructor() {
    super({
      id: 'ellipse', name: 'Ellipse Tool', label: 'Ellipse', icon: 'ellipse',
      options: [modeOption('shape'), ...vectorStyleOptions()],
    });
  }

  buildSubpaths() {
    const r = this.dragRect();
    if (r.width < 0.5 || r.height < 0.5) return [];
    return [ellipseSubpath(r)];
  }
}

class PolygonTool extends ShapeToolBase {
  constructor() {
    super({
      id: 'polygon', name: 'Polygon Tool', label: 'Polygon', icon: 'polygon',
      options: [
        modeOption('shape'),
        ...vectorStyleOptions(),
        { key: 'sides', label: 'Sides', type: 'number', min: 3, max: 100, step: 1, default: 5 },
        { key: 'star', label: 'Star', type: 'checkbox', default: false },
        { key: 'indent', label: 'Indent sides by', type: 'slider', min: 1, max: 99, step: 1, default: 50, unit: '%', when: (s) => s.star },
        { key: 'smoothCorners', label: 'Smooth corners', type: 'checkbox', default: false },
      ],
    });
  }

  /** The polygon always grows from the point where the drag started. */
  buildSubpaths() {
    const s = this.start, c = this.cur;
    const dx = c.x - s.x, dy = c.y - s.y;
    const radius = Math.hypot(dx, dy);
    if (radius < 1) return [];
    let angle = Math.atan2(dy, dx);
    if (this.mods.shiftKey) angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
    return [polygonSubpath(
      s.x, s.y, radius,
      Number(this.state.sides) || 5,
      !!this.state.star,
      Number(this.state.indent),
      angle,
      !!this.state.smoothCorners
    )];
  }

  shapeMeta() {
    return {
      baseName: this.state.star ? 'Star' : 'Polygon',
      sides: Number(this.state.sides) || 5,
      star: !!this.state.star,
      innerRadius: Math.max(0.02, 1 - (Number(this.state.indent) || 50) / 100),
      smoothCorners: !!this.state.smoothCorners,
    };
  }
}

class LineTool extends ShapeToolBase {
  constructor() {
    super({
      id: 'line', name: 'Line Tool', label: 'Line', icon: 'line',
      options: [
        modeOption('shape'),
        ...vectorStyleOptions(),
        { key: 'weight', label: 'Weight', type: 'number', min: 0.25, max: 400, step: 0.25, default: 3, unit: 'px' },
        { key: 'arrowStart', label: 'Arrow at start', type: 'checkbox', default: false },
        { key: 'arrowEnd', label: 'Arrow at end', type: 'checkbox', default: false },
        { key: 'arrowWidth', label: 'Arrow width', type: 'slider', min: 10, max: 1000, step: 10, default: 500, unit: '%', when: (s) => s.arrowStart || s.arrowEnd },
        { key: 'arrowLength', label: 'Arrow length', type: 'slider', min: 10, max: 5000, step: 10, default: 1000, unit: '%', when: (s) => s.arrowStart || s.arrowEnd },
        { key: 'concavity', label: 'Concavity', type: 'slider', min: -50, max: 50, step: 1, default: 0, unit: '%', when: (s) => s.arrowStart || s.arrowEnd },
      ],
    });
  }

  endpoints() {
    const s = this.start;
    let c = { x: this.cur.x, y: this.cur.y };
    if (this.mods.shiftKey) {
      const dx = c.x - s.x, dy = c.y - s.y;
      const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      c = { x: s.x + Math.cos(a) * len, y: s.y + Math.sin(a) * len };
    }
    if (this.mods.altKey) {
      // Alt draws outward from the centre in both directions.
      const dx = c.x - s.x, dy = c.y - s.y;
      return [{ x: s.x - dx, y: s.y - dy }, c];
    }
    return [s, c];
  }

  buildSubpaths() {
    const [a, b] = this.endpoints();
    const s = this.state;
    return lineSubpaths(a, b, Number(s.weight) || 1, {
      arrowStart: !!s.arrowStart,
      arrowEnd: !!s.arrowEnd,
      arrowWidth: Number(s.arrowWidth),
      arrowLength: Number(s.arrowLength),
      concavity: Number(s.concavity),
    });
  }

  shapeMeta() {
    return { baseName: 'Line', weight: Number(this.state.weight) || 1 };
  }
}

class CustomShapeTool extends ShapeToolBase {
  constructor() {
    super({
      id: 'custom-shape', name: 'Custom Shape Tool', label: 'Shape', icon: 'custom-shape',
      options: [
        modeOption('shape'),
        ...vectorStyleOptions(),
        { key: 'shape', label: 'Shape', type: 'select', options: CUSTOM_SHAPE_OPTIONS, default: CUSTOM_SHAPES[0].id },
        { key: 'preserveProportions', label: 'Preserve proportions', type: 'checkbox', default: false },
      ],
    });
  }

  buildSubpaths() {
    let r = this.dragRect();
    if (r.width < 0.5 || r.height < 0.5) return [];
    if (this.state.preserveProportions && !this.mods.shiftKey) {
      const m = Math.min(r.width, r.height);
      r = { x: r.x, y: r.y, width: m, height: m };
    }
    return shapeToSubpaths(this.state.shape, r.x, r.y, r.width, r.height);
  }

  shapeMeta() {
    const s = CUSTOM_SHAPES.find((x) => x.id === this.state.shape);
    return { baseName: s ? s.name : 'Shape', shapeId: this.state.shape };
  }
}

registerTool(new RectangleTool());
registerTool(new RoundedRectTool());
registerTool(new EllipseTool());
registerTool(new PolygonTool());
registerTool(new LineTool());
registerTool(new CustomShapeTool());
