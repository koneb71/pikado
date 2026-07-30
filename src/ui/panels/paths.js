import { registerPanel } from '../panel-host.js';
import { app } from '../../core/app.js';
import { el, uid, createCanvas } from '../../core/util.js';
import { toCss } from '../../core/color.js';
import { Selection } from '../../core/selection.js';
import { getTool } from '../../tools/base.js';
import { PaintStroke, brushFromOptions } from '../../paint/brush-engine.js';
import { pathToPath2D, pathToSelectionMask } from '../../vector/path.js';
import { iconEl } from '../icons.js';
import { promptDialog } from '../dialog.js';
import './panels.css';
import './paths.css';

/**
 * The Paths panel: the document's vector paths, plus fill / stroke / selection
 * conversions. "Make Work Path" traces the current selection with marching
 * squares and fits corner-preserving bezier subpaths to the result.
 */

const THUMB_W = 38;
const THUMB_H = 28;
const TRACE_TOLERANCE = 2;

/* ------------------------------------------------------------------ */
/* Selection -> bezier path                                            */
/* ------------------------------------------------------------------ */

/**
 * Trace the boundary of a coverage mask as closed loops of unit edges.
 * Each inside pixel contributes the edges it does not share with a neighbour,
 * oriented so the loops are consistently wound.
 */
function traceContours(mask, w, h, threshold = 128) {
  const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] >= threshold;
  /** @type {Map<string, number[][]>} start vertex -> outgoing end vertices */
  const edges = new Map();
  const addEdge = (x0, y0, x1, y1) => {
    const k = `${x0},${y0}`;
    const arr = edges.get(k);
    if (arr) arr.push([x1, y1]);
    else edges.set(k, [[x1, y1]]);
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inside(x, y)) continue;
      if (!inside(x, y - 1)) addEdge(x, y, x + 1, y);
      if (!inside(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
      if (!inside(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
      if (!inside(x - 1, y)) addEdge(x, y + 1, x, y);
    }
  }

  const loops = [];
  const limit = 4 * w * h + 8;
  for (const [key, bucket] of edges) {
    while (bucket.length) {
      const [sx, sy] = key.split(',').map(Number);
      const pts = [];
      let cx = sx, cy = sy;
      let guard = 0;
      while (guard++ < limit) {
        const list = edges.get(`${cx},${cy}`);
        if (!list || !list.length) break;
        const [nx, ny] = list.shift();
        pts.push({ x: cx, y: cy });
        cx = nx;
        cy = ny;
        if (cx === sx && cy === sy) break;
      }
      if (pts.length >= 4) loops.push(pts);
    }
  }
  return loops;
}

/** Drop mid-points that lie on the straight line between their neighbours. */
function dropCollinear(pts) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i], a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const cross = (p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x);
    if (Math.abs(cross) > 1e-9) out.push(p);
  }
  return out.length >= 3 ? out : pts;
}

/** Ramer–Douglas–Peucker on an open polyline. */
function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const first = pts[0], last = pts[pts.length - 1];
  const dx = last.x - first.x, dy = last.y - first.y;
  const len = Math.hypot(dx, dy);
  let idx = -1, maxDist = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const d = len < 1e-9
      ? Math.hypot(p.x - first.x, p.y - first.y)
      : Math.abs(dy * p.x - dx * p.y + last.x * first.y - last.y * first.x) / len;
    if (d > maxDist) { maxDist = d; idx = i; }
  }
  if (maxDist <= eps || idx < 0) return [first, last];
  const left = rdp(pts.slice(0, idx + 1), eps);
  const right = rdp(pts.slice(idx), eps);
  return left.slice(0, -1).concat(right);
}

/** Simplify a closed loop, keeping the start anchored at an extreme point. */
function simplifyLoop(pts, eps) {
  const clean = dropCollinear(pts);
  if (clean.length < 4) return clean;
  let start = 0;
  for (let i = 1; i < clean.length; i++) {
    if (clean[i].y < clean[start].y || (clean[i].y === clean[start].y && clean[i].x < clean[start].x)) start = i;
  }
  const rotated = clean.slice(start).concat(clean.slice(0, start));
  const open = rotated.concat([rotated[0]]);
  const simplified = rdp(open, eps);
  simplified.pop();
  return simplified.length >= 3 ? simplified : rotated;
}

/**
 * Turn a simplified polygon into bezier anchor points. Sharp turns become true
 * corners (zero-length handles); gentle ones get Catmull-Rom style tangents.
 */
function toBezierSubpath(pts, cornerDeg = 50, smoothness = 0.36) {
  const n = pts.length;
  const cornerRad = (cornerDeg * Math.PI) / 180;
  const points = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    const inV = { x: p.x - prev.x, y: p.y - prev.y };
    const outV = { x: next.x - p.x, y: next.y - p.y };
    const turn = Math.abs(
      ((Math.atan2(outV.y, outV.x) - Math.atan2(inV.y, inV.x) + Math.PI * 3) % (Math.PI * 2)) - Math.PI
    );
    if (turn > cornerRad) {
      points.push({ x: p.x, y: p.y, in: { x: p.x, y: p.y }, out: { x: p.x, y: p.y } });
      continue;
    }
    const tx = next.x - prev.x, ty = next.y - prev.y;
    const tl = Math.hypot(tx, ty) || 1;
    const ux = tx / tl, uy = ty / tl;
    const dIn = Math.hypot(inV.x, inV.y) * smoothness;
    const dOut = Math.hypot(outV.x, outV.y) * smoothness;
    points.push({
      x: p.x, y: p.y,
      in: { x: p.x - ux * dIn, y: p.y - uy * dIn },
      out: { x: p.x + ux * dOut, y: p.y + uy * dOut },
    });
  }
  return { closed: true, points };
}

/** Full selection -> subpath list. */
function traceSelection(selection, tolerance = TRACE_TOLERANCE) {
  const w = selection.width, h = selection.height;
  const mask = selection.mask;
  if (!mask) return [];
  const loops = traceContours(mask, w, h);
  const out = [];
  for (const loop of loops) {
    const simple = simplifyLoop(loop, tolerance);
    if (simple.length >= 3) out.push(toBezierSubpath(simple));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Path geometry helpers                                               */
/* ------------------------------------------------------------------ */

function cubicAt(a, c1, c2, b, t) {
  const mt = 1 - t;
  const w0 = mt * mt * mt, w1 = 3 * mt * mt * t, w2 = 3 * mt * t * t, w3 = t * t * t;
  return {
    x: a.x * w0 + c1.x * w1 + c2.x * w2 + b.x * w3,
    y: a.y * w0 + c1.y * w1 + c2.y * w2 + b.y * w3,
  };
}

/** Sample a subpath into a polyline in document space. */
function flattenSubpath(sp) {
  const pts = sp.points || [];
  if (pts.length < 2) return pts.map((p) => ({ x: p.x, y: p.y }));
  const out = [{ x: pts[0].x, y: pts[0].y }];
  const n = pts.length;
  const segs = sp.closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const c1 = a.out || a, c2 = b.in || b;
    const approx = Math.hypot(c1.x - a.x, c1.y - a.y) + Math.hypot(c2.x - c1.x, c2.y - c1.y) + Math.hypot(b.x - c2.x, b.y - c2.y);
    const steps = Math.max(2, Math.min(160, Math.ceil(approx / 2)));
    for (let s = 1; s <= steps; s++) out.push(cubicAt(a, c1, c2, b, s / steps));
  }
  return out;
}

function pathIsEmpty(path) {
  return !path || !path.subpaths || !path.subpaths.some((sp) => (sp.points || []).length > 1);
}

function pathThumb(doc, path) {
  const cv = createCanvas(THUMB_W, THUMB_H);
  const c = cv.getContext('2d');
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, THUMB_W, THUMB_H);
  if (pathIsEmpty(path)) return cv;
  const s = Math.min(THUMB_W / doc.width, THUMB_H / doc.height);
  c.save();
  c.translate((THUMB_W - doc.width * s) / 2, (THUMB_H - doc.height * s) / 2);
  c.scale(s, s);
  c.strokeStyle = '#1c1c1c';
  c.lineWidth = Math.max(0.5, 1 / s);
  c.stroke(pathToPath2D(path));
  c.restore();
  return cv;
}

/**
 * `pathToSelectionMask` is owned by the vector module; fall back to rasterising
 * the Path2D if it hands back something unexpected.
 */
function maskForPath(doc, path) {
  const n = doc.width * doc.height;
  let mask = null;
  try {
    mask = pathToSelectionMask(path, doc.width, doc.height);
  } catch (err) {
    console.warn('[paths] pathToSelectionMask failed, rasterising the Path2D instead', err);
  }
  if (mask && mask.length === n) return mask instanceof Uint8ClampedArray ? mask : Uint8ClampedArray.from(mask);
  return Selection.rasterizePath(pathToPath2D(path), doc.width, doc.height);
}

/* ------------------------------------------------------------------ */

registerPanel({
  id: 'paths',
  title: 'Paths',
  icon: 'path',
  group: 'top',
  order: 2,
  defaultOpen: false,
  build(body) {
    body.classList.add('pkp-body');
    const list = el('div.pkp-list.pk-scroll');
    const footer = el('div.pkp-foot');
    body.append(list, footer);

    const doc = () => app.activeDoc;
    const activePath = () => {
      const d = doc();
      return d ? d.paths.find((p) => p.id === d.activePathId) || null : null;
    };

    const paintableLayer = () => {
      const d = doc();
      const l = d && d.activeLayer();
      if (!l || !l.canvas) {
        app.toast('Select a raster layer first.', 'warn');
        return null;
      }
      if (l.locked.all || l.locked.pixels) {
        app.toast(`Layer "${l.name}" is locked.`, 'warn');
        return null;
      }
      return l;
    };

    const requirePath = () => {
      const p = activePath();
      if (!p || pathIsEmpty(p)) {
        app.toast('Select a path with at least one segment.', 'warn');
        return null;
      }
      return p;
    };

    /* ---- actions ------------------------------------------------- */

    const fillPath = () => {
      const d = doc();
      const path = requirePath();
      if (!d || !path) return;
      const layer = paintableLayer();
      if (!layer) return;
      const tmp = createCanvas(d.width, d.height);
      const tc = tmp.getContext('2d');
      tc.fillStyle = toCss(app.foreground);
      tc.fill(pathToPath2D(path));
      if (d.selection.active) {
        tc.globalCompositeOperation = 'destination-in';
        tc.drawImage(d.selection.toAlphaCanvas(), 0, 0);
        tc.globalCompositeOperation = 'source-over';
      }
      d.beginEdit(layer);
      layer.paintTarget().getContext('2d').drawImage(tmp, 0, 0);
      d.commit('Fill Path');
    };

    const strokePath = () => {
      const d = doc();
      const path = requirePath();
      if (!d || !path) return;
      const layer = paintableLayer();
      if (!layer) return;
      const brushTool = getTool('brush');
      const brush = brushFromOptions(brushTool ? brushTool.state : {}, { smoothing: 0, airbrush: false });
      d.beginEdit(layer);
      const stroke = new PaintStroke({
        doc: d,
        layer,
        target: layer.paintTarget(),
        brush,
        mode: 'paint',
        color: toCss(app.foreground),
      });
      let drew = false;
      for (const sp of path.subpaths || []) {
        const line = flattenSubpath(sp);
        if (line.length < 2) continue;
        stroke.begin(line[0].x, line[0].y, 1);
        for (let i = 1; i < line.length; i++) stroke.move(line[i].x, line[i].y, 1);
        if (sp.closed) stroke.move(line[0].x, line[0].y, 1);
        stroke.end();
        drew = true;
      }
      if (!drew) {
        app.toast('That path has nothing to stroke.', 'warn');
        return;
      }
      stroke.flush();
      d.commit('Stroke Path');
    };

    const pathToSelection = () => {
      const d = doc();
      const path = requirePath();
      if (!d || !path) return;
      d.selection.set(maskForPath(d, path));
      d.commit('Make Selection from Path');
    };

    const selectionToPath = () => {
      const d = doc();
      if (!d) return;
      if (!d.selection.active) {
        app.toast('Make a selection first.', 'warn');
        return;
      }
      const subpaths = traceSelection(d.selection, TRACE_TOLERANCE);
      if (!subpaths.length) {
        app.toast('That selection is too small to trace.', 'warn');
        return;
      }
      const i = d.paths.findIndex((p) => p.isWork);
      const path = { id: i >= 0 ? d.paths[i].id : uid('path'), name: 'Work Path', isWork: true, subpaths };
      if (i >= 0) d.paths[i] = path;
      else d.paths.unshift(path);
      d.activePathId = path.id;
      d.commit('Make Work Path');
    };

    const newPath = () => {
      const d = doc();
      if (!d) return;
      let n = d.paths.length + 1;
      const taken = new Set(d.paths.map((p) => p.name));
      while (taken.has(`Path ${n}`)) n++;
      const path = { id: uid('path'), name: `Path ${n}`, subpaths: [] };
      d.paths.push(path);
      d.activePathId = path.id;
      d.commit('New Path');
    };

    const deletePath = () => {
      const d = doc();
      if (!d) return;
      const i = d.paths.findIndex((p) => p.id === d.activePathId);
      if (i < 0) {
        app.toast('Select a path to delete.', 'warn');
        return;
      }
      d.paths.splice(i, 1);
      d.activePathId = null;
      d.commit('Delete Path');
    };

    /* ---- rendering ----------------------------------------------- */

    const render = () => {
      const d = doc();
      list.replaceChildren();
      if (!d) {
        list.appendChild(el('div.pkp-empty', { text: 'No document open.' }));
        renderFooter();
        return;
      }

      if (!d.paths.some((p) => p.isWork)) {
        list.appendChild(el('div.pkp-row.is-ghost', {
          title: 'Draw with the Pen tool or use "Make work path from selection" to create one',
        },
          el('div.pkp-thumb.pk-checker'),
          el('span.pkp-name.pk-truncate', { text: 'Work Path' }),
          el('span.pkp-tag', { text: 'empty' })
        ));
      }

      for (const path of d.paths) {
        const row = el('div.pkp-row' + (path.id === d.activePathId ? '.is-selected' : ''), { title: path.name });
        const thumb = el('div.pkp-thumb.pk-checker', {}, pathThumb(d, path));
        const name = el('span.pkp-name.pk-truncate', { text: path.name });
        row.append(thumb, name);
        if (path.isWork) row.appendChild(el('span.pkp-tag', { text: 'work' }));
        row.addEventListener('click', () => {
          d.activePathId = path.id;
          render();
          d.emit('structure');
        });
        row.addEventListener('dblclick', async () => {
          const next = await promptDialog('Path name', path.name, 'Rename Path');
          if (next == null || !next.trim()) return;
          path.name = next.trim();
          if (path.isWork) path.isWork = false;
          d.commit('Rename Path');
        });
        list.appendChild(row);
      }

      list.appendChild(el('div.pkp-blank', {
        onclick: () => { d.activePathId = null; render(); d.emit('structure'); },
      }));
      renderFooter();
    };

    const renderFooter = () => {
      const d = doc();
      footer.replaceChildren(
        el('button.pk-icon-btn', { type: 'button', title: 'Fill path with the foreground colour', disabled: !d, onclick: fillPath }, iconEl('bucket')),
        el('button.pk-icon-btn', { type: 'button', title: 'Stroke path with the current brush', disabled: !d, onclick: strokePath }, iconEl('brush')),
        el('button.pk-icon-btn', { type: 'button', title: 'Load path as a selection', disabled: !d, onclick: pathToSelection }, iconEl('marquee-rect')),
        el('button.pk-icon-btn', { type: 'button', title: 'Make a work path from the selection', disabled: !d, onclick: selectionToPath }, iconEl('pen')),
        el('div.pk-spacer'),
        el('button.pk-icon-btn', { type: 'button', title: 'New path', disabled: !d, onclick: newPath }, iconEl('plus')),
        el('button.pk-icon-btn', { type: 'button', title: 'Delete path', disabled: !d, onclick: deletePath }, iconEl('trash'))
      );
    };

    let pending = null;
    const schedule = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        if (body.isConnected && body.offsetParent !== null) render();
      }, 120);
    };

    app.on('active-doc', schedule);
    app.on('doc-structure', schedule);
    app.on('doc-change', schedule);
    app.on('doc-resize', schedule);

    render();
    return { refresh: render };
  },
});
