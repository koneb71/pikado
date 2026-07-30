/**
 * Path Selection (black arrow) and Direct Selection (white arrow).
 *
 * Both operate on the same "vector targets" as the pen tools: shape layers
 * and the entries in `doc.paths`. Edits are previewed with `doc.touch()` and
 * recorded once on pointer-up.
 */

import { app } from '../core/app.js';
import { Tool, registerTool } from './base.js';
import {
  cloneSubpaths, drawPathOverlay, hitTestPoint, vectorTargets, findShapeAt,
  activeVectorTarget, beginVectorEdit, touchVectorTarget, refreshShapeLayer,
  removePoint,
} from '../vector/path.js';

function targetKey(t) {
  if (!t) return '';
  return t.kind === 'layer' ? `L:${t.layer.id}` : `P:${t.path.id}`;
}

/** Write `origin` translated by (dx, dy) back into the live subpaths. */
function applyTranslated(dest, origin, dx, dy) {
  for (let i = 0; i < dest.length && i < origin.length; i++) {
    const sp = dest[i], o = origin[i];
    for (let j = 0; j < sp.points.length && j < o.points.length; j++) {
      const p = sp.points[j], q = o.points[j];
      p.x = q.x + dx;
      p.y = q.y + dy;
      if (p.in && q.in) { p.in.x = q.in.x + dx; p.in.y = q.in.y + dy; }
      if (p.out && q.out) { p.out.x = q.out.x + dx; p.out.y = q.out.y + dy; }
    }
  }
}

function drawMarquee(ctx, view, a, b) {
  const p = view.toScreen(a.x, a.y);
  const q = view.toScreen(b.x, b.y);
  const x = Math.min(p.x, q.x), y = Math.min(p.y, q.y);
  const w = Math.abs(q.x - p.x), h = Math.abs(q.y - p.y);
  ctx.save();
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,0,0,.7)';
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  ctx.strokeStyle = '#ffffff';
  ctx.lineDashOffset = 4;
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Path Selection                                                      */
/* ------------------------------------------------------------------ */

class PathSelectTool extends Tool {
  constructor() {
    super({
      id: 'path-select', name: 'Path Selection Tool', icon: 'path-select', cursor: 'default',
      shortcut: 'A', group: 'path-select', groupOrder: 16,
      options: [
        {
          key: 'show', label: 'Show', type: 'select', default: 'all',
          options: [{ value: 'all', label: 'All paths' }, { value: 'active', label: 'Active only' }],
        },
      ],
    });
    this.app = app;
    /** @type {object[]} selected targets */
    this.sel = [];
    this.drag = null;
  }

  onActivate() {
    const t = activeVectorTarget(this.doc);
    this.sel = t ? [t] : [];
    app.requestRender();
  }

  onDeactivate() {
    this.drag = null;
  }

  tol() {
    return 5 / Math.max(0.02, app.viewport.scale);
  }

  /** Re-resolve stored selections against the live document. */
  syncSelection() {
    const doc = this.doc;
    if (!doc) { this.sel = []; return; }
    const live = vectorTargets(doc);
    const keys = new Set(this.sel.map(targetKey));
    this.sel = live.filter((t) => keys.has(targetKey(t)));
  }

  onPointerDown(e) {
    const doc = this.doc;
    if (!doc) return;
    this.syncSelection();
    const found = findShapeAt(doc, e.x, e.y, this.tol());
    if (!found) {
      if (!e.shiftKey) this.sel = [];
      app.requestRender();
      return;
    }
    const key = targetKey(found.target);
    const already = this.sel.some((t) => targetKey(t) === key);
    if (e.shiftKey) {
      if (already) this.sel = this.sel.filter((t) => targetKey(t) !== key);
      else this.sel.push(found.target);
    } else if (!already) {
      this.sel = [found.target];
    }
    if (found.target.kind === 'layer') doc.setActiveLayer(found.target.layer.id, e.shiftKey);
    else doc.activePathId = found.target.path.id;

    if (this.sel.length) {
      for (const t of this.sel) beginVectorEdit(doc, t);
      this.drag = {
        start: { x: e.x, y: e.y },
        moved: false,
        items: this.sel.map((t) => ({ t, origin: cloneSubpaths(t.subpaths) })),
      };
    }
    app.requestRender();
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d) return;
    const dx = e.x - d.start.x;
    const dy = e.y - d.start.y;
    if (!d.moved && Math.hypot(dx, dy) < 0.5) return;
    d.moved = true;
    for (const item of d.items) {
      applyTranslated(item.t.subpaths, item.origin, dx, dy);
      if (item.t.kind === 'layer') refreshShapeLayer(this.doc, item.t.layer);
    }
    this.doc.touch();
    app.requestRender();
  }

  onPointerUp() {
    const d = this.drag;
    this.drag = null;
    if (!d || !d.moved) return;
    for (const item of d.items) {
      if (item.t.kind === 'layer') refreshShapeLayer(this.doc, item.t.layer);
    }
    this.doc.commit('Move Path');
    app.requestRender();
  }

  onKeyDown(e) {
    const doc = this.doc;
    if (!doc || !this.sel.length) return false;
    const step = e.shiftKey ? 10 : 1;
    let dx = 0, dy = 0;
    if (e.key === 'ArrowLeft') dx = -step;
    else if (e.key === 'ArrowRight') dx = step;
    else if (e.key === 'ArrowUp') dy = -step;
    else if (e.key === 'ArrowDown') dy = step;
    if (dx || dy) {
      this.syncSelection();
      for (const t of this.sel) {
        beginVectorEdit(doc, t);
        applyTranslated(t.subpaths, cloneSubpaths(t.subpaths), dx, dy);
        if (t.kind === 'layer') refreshShapeLayer(doc, t.layer);
      }
      doc.commit('Move Path');
      app.requestRender();
      return true;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      this.syncSelection();
      const paths = this.sel.filter((t) => t.kind === 'path');
      if (!paths.length) return false;
      for (const t of paths) {
        const i = doc.paths.indexOf(t.path);
        if (i >= 0) doc.paths.splice(i, 1);
      }
      if (!doc.paths.some((p) => p.id === doc.activePathId)) doc.activePathId = doc.paths[0] ? doc.paths[0].id : null;
      this.sel = [];
      doc.commit('Delete Path');
      app.requestRender();
      return true;
    }
    return false;
  }

  drawOverlay(ctx, view) {
    const doc = this.doc;
    if (!doc) return;
    this.syncSelection();
    const selKeys = new Set(this.sel.map(targetKey));
    const showAll = this.state.show !== 'active';
    for (const t of vectorTargets(doc)) {
      const isSel = selKeys.has(targetKey(t));
      if (!isSel && !showAll) continue;
      const selected = new Set();
      if (isSel) {
        t.subpaths.forEach((sp, si) => sp.points.forEach((_, pi) => selected.add(`${si}:${pi}`)));
      }
      drawPathOverlay(ctx, t.subpaths, view, {
        color: isSel ? '#3da9ff' : 'rgba(140,190,255,.5)',
        handles: 'none',
        anchors: isSel,
        selected,
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Direct Selection                                                    */
/* ------------------------------------------------------------------ */

class DirectSelectTool extends Tool {
  constructor() {
    super({
      id: 'direct-select', name: 'Direct Selection Tool', icon: 'direct-select', cursor: 'default',
      shortcut: 'A', group: 'path-select', groupOrder: 16,
      options: [
        { key: 'showHandles', label: 'Show all handles', type: 'checkbox', default: false },
      ],
    });
    this.app = app;
    this.target = null;
    /** @type {Set<string>} keys of the form `${subpathIndex}:${pointIndex}` */
    this.selected = new Set();
    this.drag = null;
    this.marquee = null;
  }

  onActivate() {
    this.target = activeVectorTarget(this.doc);
    this.selected.clear();
    app.requestRender();
  }

  onDeactivate() {
    this.drag = null;
    this.marquee = null;
  }

  tol() {
    return 5 / Math.max(0.02, app.viewport.scale);
  }

  /** Re-resolve the stored target against the live document tree. */
  syncTarget() {
    const doc = this.doc;
    if (!doc) { this.target = null; return null; }
    if (this.target) {
      const key = targetKey(this.target);
      const live = vectorTargets(doc).find((t) => targetKey(t) === key);
      if (live) { this.target = live; return live; }
    }
    this.target = activeVectorTarget(doc);
    return this.target;
  }

  onPointerDown(e) {
    const doc = this.doc;
    if (!doc) return;
    const tol = this.tol();

    // Anchors and handles anywhere in the document take priority.
    let hitTarget = null;
    let hit = null;
    for (const t of vectorTargets(doc)) {
      const h = hitTestPoint(t.subpaths, e.x, e.y, tol);
      if (h) { hitTarget = t; hit = h; break; }
    }

    if (hit) {
      if (targetKey(hitTarget) !== targetKey(this.target)) {
        this.target = hitTarget;
        this.selected.clear();
      }
      if (hitTarget.kind === 'layer') doc.setActiveLayer(hitTarget.layer.id);
      else doc.activePathId = hitTarget.path.id;
      beginVectorEdit(doc, hitTarget);

      const key = `${hit.subpathIndex}:${hit.pointIndex}`;
      if (hit.kind === 'anchor') {
        if (e.shiftKey) {
          if (this.selected.has(key)) this.selected.delete(key);
          else this.selected.add(key);
        } else if (!this.selected.has(key)) {
          this.selected.clear();
          this.selected.add(key);
        }
        this.drag = {
          kind: 'anchors',
          start: { x: e.x, y: e.y },
          moved: false,
          origin: cloneSubpaths(hitTarget.subpaths),
        };
      } else {
        this.selected.clear();
        this.selected.add(key);
        this.drag = { kind: 'handle', which: hit.kind, si: hit.subpathIndex, pi: hit.pointIndex, moved: false, start: { x: e.x, y: e.y } };
      }
      app.requestRender();
      return;
    }

    // Nothing hit — start a marquee over the current (or clicked) target.
    const shape = findShapeAt(doc, e.x, e.y, tol);
    if (shape) {
      this.target = shape.target;
      if (shape.target.kind === 'layer') doc.setActiveLayer(shape.target.layer.id);
      else doc.activePathId = shape.target.path.id;
      if (!e.shiftKey) this.selected.clear();
      app.requestRender();
      return;
    }
    this.syncTarget();
    if (!e.shiftKey) this.selected.clear();
    this.marquee = { a: { x: e.x, y: e.y }, b: { x: e.x, y: e.y }, additive: e.shiftKey };
    app.requestRender();
  }

  onPointerMove(e) {
    const doc = this.doc;
    if (this.marquee) {
      this.marquee.b = { x: e.x, y: e.y };
      app.requestRender();
      return;
    }
    const d = this.drag;
    if (!d || !this.target) return;
    const dx = e.x - d.start.x;
    const dy = e.y - d.start.y;
    if (!d.moved && Math.hypot(dx, dy) < 0.4) return;
    d.moved = true;

    if (d.kind === 'anchors') {
      const subs = this.target.subpaths;
      for (const key of this.selected) {
        const [si, pi] = key.split(':').map(Number);
        const sp = subs[si];
        const o = d.origin[si];
        if (!sp || !o) continue;
        const p = sp.points[pi];
        const q = o.points[pi];
        if (!p || !q) continue;
        p.x = q.x + dx;
        p.y = q.y + dy;
        if (p.in && q.in) { p.in.x = q.in.x + dx; p.in.y = q.in.y + dy; }
        if (p.out && q.out) { p.out.x = q.out.x + dx; p.out.y = q.out.y + dy; }
      }
    } else {
      const sp = this.target.subpaths[d.si];
      const p = sp && sp.points[d.pi];
      if (!p) return;
      const other = d.which === 'in' ? 'out' : 'in';
      const keepLen = p[other] ? Math.hypot(p[other].x - p.x, p[other].y - p.y) : 0;
      p[d.which] = { x: e.x, y: e.y };
      if (!e.altKey && p[other] && keepLen > 0) {
        const vx = e.x - p.x, vy = e.y - p.y;
        const l = Math.hypot(vx, vy) || 1;
        p[other] = { x: p.x - (vx / l) * keepLen, y: p.y - (vy / l) * keepLen };
      }
      p.corner = false;
    }
    touchVectorTarget(doc, this.target);
    app.requestRender();
  }

  onPointerUp() {
    const doc = this.doc;
    if (this.marquee) {
      const m = this.marquee;
      this.marquee = null;
      const x0 = Math.min(m.a.x, m.b.x), x1 = Math.max(m.a.x, m.b.x);
      const y0 = Math.min(m.a.y, m.b.y), y1 = Math.max(m.a.y, m.b.y);
      const t = this.syncTarget();
      if (t && (x1 - x0 > 0.5 || y1 - y0 > 0.5)) {
        if (!m.additive) this.selected.clear();
        t.subpaths.forEach((sp, si) => sp.points.forEach((p, pi) => {
          if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) this.selected.add(`${si}:${pi}`);
        }));
      }
      app.requestRender();
      return;
    }
    const d = this.drag;
    this.drag = null;
    if (!d || !d.moved || !this.target) return;
    if (this.target.kind === 'layer') refreshShapeLayer(doc, this.target.layer);
    doc.commit(d.kind === 'handle' ? 'Edit Handle' : 'Move Anchor Points');
    app.requestRender();
  }

  onKeyDown(e) {
    const doc = this.doc;
    const t = this.syncTarget();
    if (!doc || !t || !this.selected.size) return false;

    if (e.key === 'Delete' || e.key === 'Backspace') {
      beginVectorEdit(doc, t);
      // Remove from the highest index down so earlier indices stay valid.
      const list = [...this.selected]
        .map((k) => k.split(':').map(Number))
        .sort((a, b) => (b[0] - a[0]) || (b[1] - a[1]));
      for (const [si, pi] of list) removePoint(t.subpaths, si, pi);
      this.selected.clear();
      if (t.kind === 'layer') refreshShapeLayer(doc, t.layer);
      doc.commit('Delete Anchor Points');
      app.requestRender();
      return true;
    }

    const step = e.shiftKey ? 10 : 1;
    let dx = 0, dy = 0;
    if (e.key === 'ArrowLeft') dx = -step;
    else if (e.key === 'ArrowRight') dx = step;
    else if (e.key === 'ArrowUp') dy = -step;
    else if (e.key === 'ArrowDown') dy = step;
    if (!dx && !dy) return false;

    beginVectorEdit(doc, t);
    for (const key of this.selected) {
      const [si, pi] = key.split(':').map(Number);
      const p = t.subpaths[si] && t.subpaths[si].points[pi];
      if (!p) continue;
      p.x += dx; p.y += dy;
      if (p.in) { p.in.x += dx; p.in.y += dy; }
      if (p.out) { p.out.x += dx; p.out.y += dy; }
    }
    if (t.kind === 'layer') refreshShapeLayer(doc, t.layer);
    doc.commit('Move Anchor Points');
    app.requestRender();
    return true;
  }

  drawOverlay(ctx, view) {
    const doc = this.doc;
    if (!doc) return;
    const t = this.syncTarget();
    const key = targetKey(t);
    for (const other of vectorTargets(doc)) {
      if (targetKey(other) === key) continue;
      drawPathOverlay(ctx, other.subpaths, view, {
        color: 'rgba(140,190,255,.45)', handles: 'none', anchors: false,
      });
    }
    if (t) {
      drawPathOverlay(ctx, t.subpaths, view, {
        handles: this.state.showHandles ? 'all' : 'selected',
        selected: this.selected,
      });
    }
    if (this.marquee) drawMarquee(ctx, view, this.marquee.a, this.marquee.b);
  }
}

registerTool(new PathSelectTool());
registerTool(new DirectSelectTool());
