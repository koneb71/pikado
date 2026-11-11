import { app } from '../core/app.js';
import { snapGuidePos, clearSnapLines } from '../core/snapping.js';

export const RULER_SIZE = 20;
const HIT_RADIUS = 5; // CSS pixels, independent of zoom and device pixel ratio.
let drag = null;

export function isGuideDragging() { return drag !== null; }

export function guideAt(sx, sy) {
  if (!app.showGuides || !app.activeDoc) return null;
  const p = app.viewport.toDoc(sx, sy);
  let nearest = null, distance = HIT_RADIUS;
  for (const guide of app.activeDoc.guides) {
    const d = Math.abs((guide.axis === 'v' ? p.x : p.y) - guide.pos) * app.viewport.scale;
    if (d <= distance) { nearest = guide; distance = d; }
  }
  return nearest;
}

/** Clip an infinite document guide to the visible workspace, including rotation. */
export function guideSegment(guide, view) {
  const vertical = guide.axis === 'v';
  const p = view.toScreen(vertical ? guide.pos : 0, vertical ? 0 : guide.pos);
  const angle = view.rotation || 0;
  const dx = vertical ? -Math.sin(angle) : Math.cos(angle);
  const dy = vertical ? Math.cos(angle) : Math.sin(angle);
  let lo = -Infinity, hi = Infinity;
  for (const [origin, direction, size] of [[p.x, dx, view.viewWidth], [p.y, dy, view.viewHeight]]) {
    if (Math.abs(direction) < 1e-10) {
      if (origin < 0 || origin > size) return null;
    } else {
      const a = -origin / direction, b = (size - origin) / direction;
      lo = Math.max(lo, Math.min(a, b));
      hi = Math.min(hi, Math.max(a, b));
    }
  }
  if (lo > hi) return null;
  return [{ x: p.x + lo * dx, y: p.y + lo * dy }, { x: p.x + hi * dx, y: p.y + hi * dy }];
}

/** Shared gesture for ruler-created guides and guides picked up on the canvas. */
export function startGuideDrag(area, guide, event, { isNew = false, onEnd = () => {} } = {}) {
  if (drag || !app.activeDoc || event.button !== 0) return false;
  const doc = app.activeDoc;
  const originalPos = guide.pos;
  const point = (e) => {
    const r = area.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, width: r.width, height: r.height };
  };
  const docPos = (e) => {
    const p = point(e), d = app.viewport.toDoc(p.x, p.y);
    return guide.axis === 'v' ? d.x : d.y;
  };
  // Use displacement from the grab point, not an offset round trip: decimal
  // guide positions such as 0.1 must survive a click without rounding to 0.
  const startPos = docPos(event);
  const samePointer = (e) => e.pointerId === event.pointerId;
  const consume = (e) => { e.preventDefault(); e.stopImmediatePropagation?.(); };
  const move = (e) => {
    if (!samePointer(e)) return;
    consume(e);
    const pointerPos = docPos(e);
    const delta = pointerPos - startPos;
    const pos = isNew ? pointerPos : originalPos + delta;
    // A click (or returning to the starting point) preserves imported fractions.
    if (!isNew && delta === 0) { guide.pos = originalPos; clearSnapLines(); }
    else guide.pos = Math.round(snapGuidePos(pos, guide.axis, doc, { excludeGuide: guide, event: e }));
    app.requestRender();
  };
  const remove = () => {
    const index = doc.guides.indexOf(guide);
    if (index >= 0) doc.guides.splice(index, 1);
  };
  const cleanup = () => {
    window.removeEventListener('pointermove', move, { capture: true });
    window.removeEventListener('pointerup', finish, { capture: true });
    window.removeEventListener('pointercancel', pointerCancel, { capture: true });
    window.removeEventListener('keydown', keydown, { capture: true });
    window.removeEventListener('blur', cancel);
    offDoc();
    offHistory();
    drag = null;
    clearSnapLines();
    app.requestRender();
    onEnd();
  };
  const cancel = () => {
    if (isNew) remove();
    else guide.pos = originalPos;
    cleanup();
  };
  const pointerCancel = (e) => { if (samePointer(e)) { consume(e); cancel(); } };
  const keydown = (e) => {
    if (e.key === 'Escape') { consume(e); cancel(); return; }
    // Modifiers remain available for snapping. Arrow keys must not nudge the
    // selected layer while the pointer is holding a guide.
    if (['Control', 'Meta', 'Shift', 'Alt', 'AltGraph'].includes(e.key)) return;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) { consume(e); return; }
    // Restore the preview before Undo, Save, tool switches or other commands
    // reach the normal shortcut handler. Pointer-up must not commit afterwards.
    cancel();
  };
  const finish = (e) => {
    if (!samePointer(e)) return;
    const p = point(e);
    const inset = app.showRulers ? RULER_SIZE : 0;
    const dropped = p.x >= inset && p.y >= inset && p.x < p.width && p.y < p.height;
    move(e);
    if (!dropped) remove();
    cleanup();
    if (isNew ? dropped : (!dropped || guide.pos !== originalPos)) {
      doc.commit(isNew ? 'New Guide' : dropped ? 'Move Guide' : 'Delete Guide');
    }
  };
  const offDoc = app.on('active-doc', cancel);
  const offHistory = doc.history.on('change', () => {
    // History can also be restored from a menu/panel. Its new guide objects
    // supersede this gesture; leave the restored state intact and only detach.
    if (!doc.guides.includes(guide)) cleanup();
  });
  drag = { guide };
  if (isNew) { doc.guides.push(guide); app.showGuides = true; move(event); }
  else consume(event);
  window.addEventListener('pointermove', move, { capture: true });
  window.addEventListener('pointerup', finish, { capture: true });
  window.addEventListener('pointercancel', pointerCancel, { capture: true });
  window.addEventListener('keydown', keydown, { capture: true });
  window.addEventListener('blur', cancel);
  return true;
}
