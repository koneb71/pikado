import { PikaDocument } from '../core/document.js';
import { LayerType, createRasterLayer } from '../core/layer.js';
import { uid, createCanvas, ctx2d, loadImage } from '../core/util.js';
import { getComposite, compositeList } from '../render/compositor.js';
import { fontStack } from '../text/fonts.js';
import { hasStyles, applyLayerStyles } from '../effects/styles.js';

/**
 * SVG import and export.
 *
 * Import rasterises the drawing through a blob URL (the browser's own SVG
 * renderer) and *additionally* converts the primitive shapes it can understand
 * into `doc.paths` so they stay editable with the path tools.
 *
 * Export writes each raster layer as an embedded base64 PNG, shape layers as
 * real `<path>` elements and text layers as `<text>` elements.
 */

const MAX_RASTER_SIDE = 4000;

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

/** Convert a CSS/SVG length to user units. Percentages are not resolvable. */
function lengthOf(value) {
  if (!value) return 0;
  const m = /^\s*(-?[\d.]+)\s*(px|pt|pc|mm|cm|in|em|ex|%)?\s*$/.exec(String(value));
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return 0;
  switch (m[2]) {
    case 'pt': return n * (96 / 72);
    case 'pc': return n * 16;
    case 'mm': return n * (96 / 25.4);
    case 'cm': return n * (96 / 2.54);
    case 'in': return n * 96;
    case '%': return 0;
    default: return n;
  }
}

/**
 * Rasterise an SVG document and extract its primitive shapes.
 * @param {string} text raw SVG markup
 * @param {string} [name] document name
 * @returns {Promise<PikaDocument>}
 */
export async function importSVG(text, name = 'Drawing') {
  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (parsed.getElementsByTagName('parsererror').length) throw new Error('The SVG file could not be parsed');
  const svg = parsed.documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== 'svg') throw new Error('The file does not contain an <svg> element');

  const viewBox = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const hasViewBox = viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0;

  let width = lengthOf(svg.getAttribute('width'));
  let height = lengthOf(svg.getAttribute('height'));
  if ((!width || !height) && hasViewBox) {
    width = width || viewBox[2];
    height = height || viewBox[3];
  }
  if (!width || !height) { width = 512; height = 512; }

  const scale = Math.min(1, MAX_RASTER_SIDE / Math.max(width, height));
  const targetW = Math.max(1, Math.round(width * scale));
  const targetH = Math.max(1, Math.round(height * scale));

  // Re-serialise with an explicit pixel size so the browser rasterises at the
  // resolution we want rather than the intrinsic one.
  const clone = svg.cloneNode(true);
  if (!hasViewBox) clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  clone.setAttribute('width', String(targetW));
  clone.setAttribute('height', String(targetH));
  if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const markup = new XMLSerializer().serializeToString(clone);
  const img = await loadImage(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }));

  const doc = new PikaDocument({ width: targetW, height: targetH, name });
  const layer = createRasterLayer(targetW, targetH, name);
  ctx2d(layer.canvas).drawImage(img, 0, 0, targetW, targetH);
  doc.layers = [layer];
  doc.activeLayerId = layer.id;
  doc.selectedLayerIds = [layer.id];

  // Shapes are expressed in viewBox units; fold the raster scaling in so the
  // paths land exactly on the pixels that were drawn.
  const vbX = hasViewBox ? viewBox[0] : 0;
  const vbY = hasViewBox ? viewBox[1] : 0;
  const vbW = hasViewBox ? viewBox[2] : width;
  const vbH = hasViewBox ? viewBox[3] : height;
  const root = [targetW / vbW, 0, 0, targetH / vbH, -vbX * (targetW / vbW), -vbY * (targetH / vbH)];

  try {
    doc.paths = collectPaths(svg, root);
  } catch (err) {
    console.warn('[svg] shape extraction failed', err);
    doc.paths = [];
  }
  doc.activePathId = doc.paths.length ? doc.paths[0].id : null;

  doc.history.clear('Open');
  doc.dirty = false;
  return doc;
}

/* ---- transforms --------------------------------------------------- */

const IDENTITY = [1, 0, 0, 1, 0, 0];

function multiply(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function applyMatrix(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

function parseTransform(value) {
  if (!value) return IDENTITY;
  let m = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let hit;
  while ((hit = re.exec(value))) {
    const args = hit[2].trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
    const rad = (d) => (d * Math.PI) / 180;
    let t = IDENTITY;
    switch (hit[1]) {
      case 'matrix': if (args.length >= 6) t = args.slice(0, 6); break;
      case 'translate': t = [1, 0, 0, 1, args[0] || 0, args[1] || 0]; break;
      case 'scale': t = [args[0] == null ? 1 : args[0], 0, 0, args[1] == null ? args[0] : args[1], 0, 0]; break;
      case 'rotate': {
        const a = rad(args[0] || 0);
        const r = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
        if (args.length >= 3) {
          t = multiply(multiply([1, 0, 0, 1, args[1], args[2]], r), [1, 0, 0, 1, -args[1], -args[2]]);
        } else t = r;
        break;
      }
      case 'skewX': t = [1, 0, Math.tan(rad(args[0] || 0)), 1, 0, 0]; break;
      case 'skewY': t = [1, Math.tan(rad(args[0] || 0)), 0, 1, 0, 0]; break;
      default: break;
    }
    m = multiply(m, t);
  }
  return m;
}

/* ---- shape -> subpaths -------------------------------------------- */

class PathBuilder {
  constructor() {
    this.subpaths = [];
    this.current = null;
    this.startX = 0;
    this.startY = 0;
    this.x = 0;
    this.y = 0;
  }

  moveTo(x, y) {
    this.current = { closed: false, points: [] };
    this.subpaths.push(this.current);
    this.current.points.push({ x, y, in: null, out: null, corner: true });
    this.startX = x; this.startY = y; this.x = x; this.y = y;
  }

  lineTo(x, y) {
    if (!this.current) return this.moveTo(x, y);
    this.current.points.push({ x, y, in: null, out: null, corner: true });
    this.x = x; this.y = y;
  }

  curveTo(x1, y1, x2, y2, x, y) {
    if (!this.current) this.moveTo(this.x, this.y);
    const points = this.current.points;
    const prev = points[points.length - 1];
    prev.out = { x: x1, y: y1 };
    prev.corner = !prev.in;
    points.push({ x, y, in: { x: x2, y: y2 }, out: null, corner: false });
    this.x = x; this.y = y;
  }

  close() {
    if (!this.current) return;
    this.current.closed = true;
    const points = this.current.points;
    // A closing point that lands on the start point is redundant — hand its
    // incoming handle to the first point instead.
    if (points.length > 1) {
      const first = points[0];
      const last = points[points.length - 1];
      if (Math.abs(last.x - first.x) < 1e-6 && Math.abs(last.y - first.y) < 1e-6) {
        first.in = last.in;
        first.corner = !first.in && !first.out;
        points.pop();
      }
    }
    this.x = this.startX; this.y = this.startY;
  }
}

function arcToCubics(x1, y1, rx, ry, phiDeg, largeArc, sweep, x2, y2) {
  if (!rx || !ry) return [[x1, y1, x2, y2, x2, y2]];
  const phi = (phiDeg * Math.PI) / 180;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;
  rx = Math.abs(rx); ry = Math.abs(ry);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }

  const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let numerator = rx * rx * ry * ry - denominator;
  if (numerator < 0) numerator = 0;
  const coefficient = (largeArc === sweep ? -1 : 1) * Math.sqrt(denominator === 0 ? 0 : numerator / denominator);
  const cxp = (coefficient * rx * y1p) / ry;
  const cyp = (-coefficient * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;

  const angle = (ux, uy, vx, vy) => {
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1;
    let a = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
  const theta1 = angle(1, 0, ux, uy);
  let sweepAngle = angle(ux, uy, vx, vy);
  if (!sweep && sweepAngle > 0) sweepAngle -= 2 * Math.PI;
  if (sweep && sweepAngle < 0) sweepAngle += 2 * Math.PI;

  const segments = Math.max(1, Math.ceil(Math.abs(sweepAngle) / (Math.PI / 2)));
  const delta = sweepAngle / segments;
  const k = (4 / 3) * Math.tan(delta / 4);
  const out = [];
  let theta = theta1;
  let px = x1, py = y1;
  for (let i = 0; i < segments; i++) {
    const next = theta + delta;
    const cos1 = Math.cos(theta), sin1 = Math.sin(theta);
    const cos2 = Math.cos(next), sin2 = Math.sin(next);
    const ex = cosP * rx * cos2 - sinP * ry * sin2 + cx;
    const ey = sinP * rx * cos2 + cosP * ry * sin2 + cy;
    const t1x = cosP * (-rx * sin1) - sinP * (ry * cos1);
    const t1y = sinP * (-rx * sin1) + cosP * (ry * cos1);
    const t2x = cosP * (-rx * sin2) - sinP * (ry * cos2);
    const t2y = sinP * (-rx * sin2) + cosP * (ry * cos2);
    out.push([px + k * t1x, py + k * t1y, ex - k * t2x, ey - k * t2y, ex, ey]);
    px = ex; py = ey; theta = next;
  }
  return out;
}

const PATH_TOKEN = /([MmZzLlHhVvCcSsQqTtAa])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;

function parsePathData(d) {
  const builder = new PathBuilder();
  const tokens = [];
  let hit;
  PATH_TOKEN.lastIndex = 0;
  while ((hit = PATH_TOKEN.exec(d))) tokens.push(hit[1] || parseFloat(hit[2]));

  let i = 0;
  let command = null;
  let lastCubic = null;
  let lastQuad = null;
  const num = () => (typeof tokens[i] === 'number' ? tokens[i++] : 0);

  while (i < tokens.length) {
    if (typeof tokens[i] === 'string') command = tokens[i++];
    if (!command) break;
    const relative = command === command.toLowerCase();
    const upper = command.toUpperCase();
    const ox = relative ? builder.x : 0;
    const oy = relative ? builder.y : 0;

    if (upper === 'M') {
      const x = num() + ox, y = num() + oy;
      builder.moveTo(x, y);
      command = relative ? 'l' : 'L';
      lastCubic = lastQuad = null;
    } else if (upper === 'L') {
      builder.lineTo(num() + ox, num() + oy);
      lastCubic = lastQuad = null;
    } else if (upper === 'H') {
      builder.lineTo(num() + ox, builder.y);
      lastCubic = lastQuad = null;
    } else if (upper === 'V') {
      builder.lineTo(builder.x, num() + oy);
      lastCubic = lastQuad = null;
    } else if (upper === 'C') {
      const x1 = num() + ox, y1 = num() + oy, x2 = num() + ox, y2 = num() + oy, x = num() + ox, y = num() + oy;
      builder.curveTo(x1, y1, x2, y2, x, y);
      lastCubic = { x: x2, y: y2 };
      lastQuad = null;
    } else if (upper === 'S') {
      const rx = lastCubic ? 2 * builder.x - lastCubic.x : builder.x;
      const ry = lastCubic ? 2 * builder.y - lastCubic.y : builder.y;
      const x2 = num() + ox, y2 = num() + oy, x = num() + ox, y = num() + oy;
      builder.curveTo(rx, ry, x2, y2, x, y);
      lastCubic = { x: x2, y: y2 };
      lastQuad = null;
    } else if (upper === 'Q' || upper === 'T') {
      let qx, qy;
      if (upper === 'Q') { qx = num() + ox; qy = num() + oy; }
      else {
        qx = lastQuad ? 2 * builder.x - lastQuad.x : builder.x;
        qy = lastQuad ? 2 * builder.y - lastQuad.y : builder.y;
      }
      const x = num() + ox, y = num() + oy;
      const sx = builder.x, sy = builder.y;
      builder.curveTo(
        sx + (2 / 3) * (qx - sx), sy + (2 / 3) * (qy - sy),
        x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y),
        x, y,
      );
      lastQuad = { x: qx, y: qy };
      lastCubic = null;
    } else if (upper === 'A') {
      const rx = num(), ry = num(), rot = num();
      const large = num() !== 0, sweep = num() !== 0;
      const x = num() + ox, y = num() + oy;
      for (const c of arcToCubics(builder.x, builder.y, rx, ry, rot, large, sweep, x, y)) {
        builder.curveTo(c[0], c[1], c[2], c[3], c[4], c[5]);
      }
      lastCubic = lastQuad = null;
    } else if (upper === 'Z') {
      builder.close();
      lastCubic = lastQuad = null;
    } else {
      break;
    }
  }
  return builder.subpaths;
}

function roundedRectSubpath(x, y, w, h, rx, ry) {
  const b = new PathBuilder();
  const k = 0.5522847498;
  if (rx <= 0 || ry <= 0) {
    b.moveTo(x, y);
    b.lineTo(x + w, y);
    b.lineTo(x + w, y + h);
    b.lineTo(x, y + h);
    b.close();
    return b.subpaths;
  }
  rx = Math.min(rx, w / 2);
  ry = Math.min(ry, h / 2);
  const cx = rx * k, cy = ry * k;
  b.moveTo(x + rx, y);
  b.lineTo(x + w - rx, y);
  b.curveTo(x + w - rx + cx, y, x + w, y + ry - cy, x + w, y + ry);
  b.lineTo(x + w, y + h - ry);
  b.curveTo(x + w, y + h - ry + cy, x + w - rx + cx, y + h, x + w - rx, y + h);
  b.lineTo(x + rx, y + h);
  b.curveTo(x + rx - cx, y + h, x, y + h - ry + cy, x, y + h - ry);
  b.lineTo(x, y + ry);
  b.curveTo(x, y + ry - cy, x + rx - cx, y, x + rx, y);
  b.close();
  return b.subpaths;
}

function ellipseSubpath(cx, cy, rx, ry) {
  const b = new PathBuilder();
  const k = 0.5522847498;
  b.moveTo(cx + rx, cy);
  b.curveTo(cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry);
  b.curveTo(cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy);
  b.curveTo(cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry);
  b.curveTo(cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy);
  b.close();
  return b.subpaths;
}

function pointListSubpath(value, closed) {
  const nums = String(value || '').trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
  if (nums.length < 4) return [];
  const b = new PathBuilder();
  b.moveTo(nums[0], nums[1]);
  for (let i = 2; i + 1 < nums.length; i += 2) b.lineTo(nums[i], nums[i + 1]);
  if (closed) b.close();
  return b.subpaths;
}

function subpathsFor(node) {
  const attr = (n, d = 0) => {
    const v = node.getAttribute(n);
    return v == null ? d : (lengthOf(v) || parseFloat(v) || 0);
  };
  switch (node.nodeName.toLowerCase()) {
    case 'path': return parsePathData(node.getAttribute('d') || '');
    case 'rect': {
      const w = attr('width'), h = attr('height');
      if (w <= 0 || h <= 0) return [];
      const rxAttr = node.getAttribute('rx');
      const ryAttr = node.getAttribute('ry');
      const rx = rxAttr != null ? attr('rx') : ryAttr != null ? attr('ry') : 0;
      const ry = ryAttr != null ? attr('ry') : rx;
      return roundedRectSubpath(attr('x'), attr('y'), w, h, rx, ry);
    }
    case 'circle': {
      const r = attr('r');
      return r > 0 ? ellipseSubpath(attr('cx'), attr('cy'), r, r) : [];
    }
    case 'ellipse': {
      const rx = attr('rx'), ry = attr('ry');
      return rx > 0 && ry > 0 ? ellipseSubpath(attr('cx'), attr('cy'), rx, ry) : [];
    }
    case 'line': {
      const b = new PathBuilder();
      b.moveTo(attr('x1'), attr('y1'));
      b.lineTo(attr('x2'), attr('y2'));
      return b.subpaths;
    }
    case 'polygon': return pointListSubpath(node.getAttribute('points'), true);
    case 'polyline': return pointListSubpath(node.getAttribute('points'), false);
    default: return [];
  }
}

function transformSubpaths(subpaths, matrix) {
  for (const sp of subpaths) {
    for (const p of sp.points) {
      const t = applyMatrix(matrix, p.x, p.y);
      p.x = t.x; p.y = t.y;
      if (p.in) { const q = applyMatrix(matrix, p.in.x, p.in.y); p.in = q; }
      if (p.out) { const q = applyMatrix(matrix, p.out.x, p.out.y); p.out = q; }
    }
  }
  return subpaths;
}

function collectPaths(root, matrix) {
  const paths = [];
  let index = 0;
  const walk = (node, parentMatrix) => {
    for (const child of node.children || []) {
      const tag = child.nodeName.toLowerCase();
      const local = multiply(parentMatrix, parseTransform(child.getAttribute('transform')));
      if (tag === 'g' || tag === 'svg' || tag === 'a') {
        walk(child, local);
        continue;
      }
      const subpaths = subpathsFor(child);
      if (!subpaths.length) continue;
      transformSubpaths(subpaths, local);
      index++;
      paths.push({
        id: uid('path'),
        name: child.getAttribute('id') || `${tag} ${index}`,
        subpaths,
      });
      if (paths.length >= 500) return;
    }
  };
  walk(root, matrix);
  return paths;
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

const CSS_BLEND_MODES = new Set([
  'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
]);

function cssBlend(id) {
  if (id === 'linear-dodge') return 'plus-lighter';
  return CSS_BLEND_MODES.has(id) ? id : 'normal';
}

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * The layer's pixels with its layer effects, fill opacity and mask applied —
 * everything except layer opacity and blend mode, which become SVG attributes.
 */
function bakedCanvas(layer, doc) {
  if (!layer.canvas) return null;
  const styled = hasStyles(layer);
  const masked = !!(layer.mask && layer.maskEnabled);
  const fill = layer.fillOpacity == null ? 1 : layer.fillOpacity;
  if (!styled && !masked && fill >= 1) return layer.canvas;

  const out = createCanvas(doc.width, doc.height);
  const c = out.getContext('2d');
  if (styled) {
    applyLayerStyles(c, layer.canvas, layer, doc, fill);
  } else {
    c.globalAlpha = fill;
    c.drawImage(layer.canvas, 0, 0);
    c.globalAlpha = 1;
  }
  if (masked) {
    const alpha = layer.maskAlphaCanvas();
    if (alpha) {
      c.globalCompositeOperation = 'destination-in';
      c.drawImage(alpha, 0, 0);
      c.globalCompositeOperation = 'source-over';
    }
  }
  return out;
}

function subpathsToD(subpaths) {
  const round = (n) => Math.round(n * 100) / 100;
  const out = [];
  for (const sp of subpaths || []) {
    const points = sp.points || [];
    if (points.length < 2) continue;
    out.push(`M ${round(points[0].x)} ${round(points[0].y)}`);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (a.out || b.in) {
        const c1 = a.out || a;
        const c2 = b.in || b;
        out.push(`C ${round(c1.x)} ${round(c1.y)} ${round(c2.x)} ${round(c2.y)} ${round(b.x)} ${round(b.y)}`);
      } else {
        out.push(`L ${round(b.x)} ${round(b.y)}`);
      }
    }
    if (sp.closed) {
      const a = points[points.length - 1];
      const b = points[0];
      if (a.out || b.in) {
        const c1 = a.out || a;
        const c2 = b.in || b;
        out.push(`C ${round(c1.x)} ${round(c1.y)} ${round(c2.x)} ${round(c2.y)} ${round(b.x)} ${round(b.y)}`);
      }
      out.push('Z');
    }
  }
  return out.join(' ');
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

const DASH_PATTERNS = { dashed: '6 4', dotted: '1 3' };

/**
 * Fill and stroke attributes for a shape layer, plus any `<defs>` markup a
 * gradient fill needs. Mirrors the model in `src/vector/path.js`.
 */
function shapePaint(shape, layerId) {
  let defs = '';
  let fillAttr = 'fill="none"';
  const fill = shape.fill;

  if (typeof fill === 'string' && fill !== 'none') {
    fillAttr = `fill="${escapeXml(fill)}"`;
  } else if (fill && typeof fill === 'object' && fill.type !== 'none') {
    const stops = Array.isArray(fill.stops) ? fill.stops : null;
    if (stops && stops.length && (fill.type === 'linear' || fill.type === 'gradient' || fill.type === 'radial')) {
      const gid = `grad-${layerId}`;
      const marks = stops
        .map((s) => `<stop offset="${round2(Math.max(0, Math.min(1, s.pos == null ? s.offset || 0 : s.pos)) * 100)}%" stop-color="${escapeXml(s.color || '#000000')}"${s.opacity == null || s.opacity >= 1 ? '' : ` stop-opacity="${round2(s.opacity)}"`} />`)
        .join('');
      if (fill.type === 'radial') {
        defs = `<radialGradient id="${gid}">${marks}</radialGradient>`;
      } else {
        const a = ((fill.angle || 0) * Math.PI) / 180;
        const dx = Math.cos(a) / 2, dy = Math.sin(a) / 2;
        defs = `<linearGradient id="${gid}" x1="${round2(0.5 - dx)}" y1="${round2(0.5 - dy)}" x2="${round2(0.5 + dx)}" y2="${round2(0.5 + dy)}">${marks}</linearGradient>`;
      }
      fillAttr = `fill="url(#${gid})"`;
    } else {
      fillAttr = `fill="${escapeXml(fill.color || '#000000')}"`;
    }
    if (fill.opacity != null && fill.opacity < 1) fillAttr += ` fill-opacity="${round2(fill.opacity)}"`;
  } else if (shape.kind === 'fill') {
    fillAttr = `fill="${escapeXml(shape.color || '#808080')}"`;
  }

  if (shape.fillRule === 'evenodd') fillAttr += ' fill-rule="evenodd"';

  const st = shape.stroke;
  let strokeAttr = '';
  if (st && st.enabled !== false && st.color && st.color !== 'none' && (st.width == null || st.width > 0)) {
    const dash = DASH_PATTERNS[st.dash];
    strokeAttr = ` stroke="${escapeXml(st.color)}" stroke-width="${round2(st.width == null ? 1 : st.width)}"` +
      ` stroke-linecap="${st.cap || 'butt'}" stroke-linejoin="${st.join || 'miter'}"` +
      (dash ? ` stroke-dasharray="${dash}"` : '');
  }

  return { defs, attrs: `${fillAttr}${strokeAttr}` };
}

function layerAttrs(layer) {
  const bits = [];
  const opacity = layer.opacity == null ? 1 : layer.opacity;
  if (opacity < 1) bits.push(`opacity="${Math.round(opacity * 1000) / 1000}"`);
  const blend = cssBlend(layer.blendMode);
  if (blend !== 'normal') bits.push(`style="mix-blend-mode:${blend}"`);
  return bits.length ? ` ${bits.join(' ')}` : '';
}

function emitLayer(layer, doc, out, indent) {
  if (!layer.visible) return;
  const pad = '  '.repeat(indent);
  const label = ` id="${escapeXml(layer.id)}" data-name="${escapeXml(layer.name)}"`;

  if (layer.type === LayerType.GROUP) {
    const children = layer.children || [];
    if (layer.mask && layer.maskEnabled) {
      // SVG has no direct equivalent of a group mask in our model, so the
      // group is flattened into one masked bitmap instead.
      const cv = createCanvas(doc.width, doc.height);
      const c = ctx2d(cv);
      compositeList(children, c, doc, {});
      const alpha = layer.maskAlphaCanvas();
      if (alpha) {
        c.globalCompositeOperation = 'destination-in';
        c.drawImage(alpha, 0, 0);
        c.globalCompositeOperation = 'source-over';
      }
      out.push(`${pad}<image${label}${layerAttrs(layer)} x="0" y="0" width="${doc.width}" height="${doc.height}" href="${cv.toDataURL('image/png')}" />`);
      return;
    }
    out.push(`${pad}<g${label}${layerAttrs(layer)}>`);
    for (let i = children.length - 1; i >= 0; i--) emitLayer(children[i], doc, out, indent + 1);
    out.push(`${pad}</g>`);
    return;
  }

  if (layer.type === LayerType.ADJUSTMENT) return;

  // Vector output can only be faithful when nothing else modifies the pixels;
  // masked or styled layers fall through to the embedded-bitmap path.
  const vectorOk = !(layer.mask && layer.maskEnabled) && !hasStyles(layer);

  if (vectorOk && layer.type === LayerType.SHAPE && layer.shape && layer.shape.subpaths && layer.shape.subpaths.length) {
    const d = subpathsToD(layer.shape.subpaths);
    if (d) {
      const paint = shapePaint(layer.shape, layer.id);
      if (paint.defs) out.push(`${pad}<defs>${paint.defs}</defs>`);
      out.push(`${pad}<path${label}${layerAttrs(layer)} d="${d}" ${paint.attrs} />`);
      return;
    }
  }

  if (vectorOk && layer.type === LayerType.TEXT && layer.text && layer.text.content) {
    const t = layer.text;
    const size = Math.max(1, t.size || 16);
    const anchor = t.align === 'center' ? 'middle' : t.align === 'right' ? 'end' : 'start';
    const x = round2(t.x || 0);
    // Point text anchors (x, y) at the first baseline; paragraph text anchors
    // at the top-left of the box, so it needs an approximate ascent added.
    const y = round2((t.y || 0) + (t.paragraph ? size * 0.8 : 0));
    const lines = String(t.content).split('\n');
    const lh = t.lineHeight == null ? 1.2 : t.lineHeight;
    const leading = round2(lh > 5 ? lh : lh * size);
    const extra = [
      `font-family="${escapeXml(fontStack(t.font || 'system'))}"`,
      `font-size="${round2(size)}"`,
      t.weight && t.weight !== 400 ? `font-weight="${t.weight}"` : '',
      t.style === 'italic' ? 'font-style="italic"' : '',
      t.letterSpacing ? `letter-spacing="${round2(t.letterSpacing)}"` : '',
      `fill="${escapeXml(t.color || '#000000')}"`,
      `text-anchor="${anchor}"`,
      t.underline ? 'text-decoration="underline"' : t.strikethrough ? 'text-decoration="line-through"' : '',
    ].filter(Boolean).join(' ');
    out.push(`${pad}<text${label}${layerAttrs(layer)} x="${x}" y="${y}" ${extra}>`);
    lines.forEach((line, i) => {
      out.push(`${pad}  <tspan x="${x}" dy="${i === 0 ? 0 : leading}">${escapeXml(line)}</tspan>`);
    });
    out.push(`${pad}</text>`);
    return;
  }

  const canvas = bakedCanvas(layer, doc);
  if (!canvas) return;
  const href = canvas.toDataURL('image/png');
  out.push(`${pad}<image${label}${layerAttrs(layer)} x="0" y="0" width="${doc.width}" height="${doc.height}" href="${href}" />`);
}

/**
 * Export a document as SVG: raster layers become embedded PNGs, shape layers
 * become `<path>` elements and text layers become `<text>` elements.
 * @param {import('../core/document.js').PikaDocument} doc
 * @returns {Blob} an `image/svg+xml` blob
 */
export function exportSVG(doc) {
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${doc.width}" height="${doc.height}" viewBox="0 0 ${doc.width} ${doc.height}">`);
  out.push(`  <title>${escapeXml(doc.name)}</title>`);

  const visible = doc.layers.some((l) => l.visible);
  if (!visible) {
    // Nothing renderable — fall back to the composite so the file is not blank.
    out.push(`  <image x="0" y="0" width="${doc.width}" height="${doc.height}" href="${getComposite(doc).toDataURL('image/png')}" />`);
  } else {
    for (let i = doc.layers.length - 1; i >= 0; i--) emitLayer(doc.layers[i], doc, out, 1);
  }

  out.push('</svg>');
  return new Blob([out.join('\n')], { type: 'image/svg+xml;charset=utf-8' });
}
