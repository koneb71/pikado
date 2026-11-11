import { suite } from '../harness.js';
import { createCanvas } from '/src/core/util.js';
import { duplicateDocument } from '/src/commands/image-ops.js';

function fixture(t, axis = 'v', pos = 30) {
  const app = t.app, view = app.view;
  const doc = t.doc(100, 80, 'transparent');
  doc.guides = [{ axis, pos }];
  doc.commit('New Guide');
  const old = { snap: app.snap, showGuides: app.showGuides, showRulers: app.showRulers,
    viewport: { ...app.viewport }, tool: app.tool.id, capture: view.canvas.setPointerCapture, areaStyle: view.area.style.cssText };
  view.area.style.minWidth = "800px";
  view.area.style.minHeight = "600px";
  app.snap = false;
  app.showGuides = app.showRulers = true;
  app.setTool('move');
  const state = { ...app.tool.state };
  Object.assign(app.tool.state, { autoSelect: false, showTransform: false });
  Object.assign(app.viewport, { scale: 2, offsetX: 200, offsetY: 150, rotation: 0, viewWidth: 800, viewHeight: 600 });
  // Synthetic pointer events do not create a browser-owned pointer to capture.
  // All input dispatch, hit testing, snapping and history code remains real.
  view.canvas.setPointerCapture = () => {};
  const pointer = (type, x, y, extra = {}, target = view.canvas) => {
    const rect = view.canvas.getBoundingClientRect();
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
      clientX: rect.left + x, clientY: rect.top + y, pointerId: 1, button: 0,
      buttons: type === 'pointerup' ? 0 : 1, ...extra }));
  };
  const key = (key, extra = {}) => view.canvas.dispatchEvent(new KeyboardEvent('keydown', {
    key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    bubbles: true, cancelable: true, ...extra,
  }));
  return { app, view, doc, pointer, key, cleanup() {
    window.dispatchEvent(new Event('blur'));
    app.setTool('move'); app.tool.cancel(); Object.assign(app.tool.state, state);
    view.canvas.setPointerCapture = old.capture;
    view.area.style.cssText = old.areaStyle;
    view._pointerDown = view._panning = view._spaceDown = false;
    Object.assign(app.viewport, old.viewport);
    app.snap = old.snap; app.showGuides = old.showGuides; app.showRulers = old.showRulers;
    app.setTool(old.tool);
  } };
}

// Verified on upstream: the guide remains at 30 rather than 55, and the
// workspace pixel beyond the artwork is transparent rather than guide-coloured.
suite('guides / existing guides drag outside the artwork and span the workspace', async (t) => {
  const f = fixture(t);
  try {
    f.pointer('pointermove', 260, 400);
    t.eq(f.view.canvas.style.cursor, 'col-resize', 'hover shows a draggable vertical guide');
    f.pointer('pointerdown', 260, 400);
    f.pointer('pointermove', 310, 400);
    f.pointer('pointerup', 310, 400);
    t.eq(f.doc.guides[0].pos, 55, 'the existing guide follows a 25-document-pixel drag');
    t.eq(f.doc.history.states[f.doc.history.index].label, 'Move Guide', 'the drag records a guide move');
    f.doc.history.undo();
    t.eq(f.doc.guides[0].pos, 30, 'undo restores the original guide');
    f.doc.history.redo();
    t.eq(f.doc.guides[0].pos, 55, 'redo restores the moved guide');
    const canvas = createCanvas(800, 600), ctx = canvas.getContext('2d');
    f.view._drawGuides(ctx, f.app.viewport.matrix(), f.doc);
    t.gt(t.bytes(canvas)[(550 * 800 + 310) * 4 + 3], 0, 'guide reaches the workspace beyond the artwork');
  } finally { f.cleanup(); }
});

suite('guides / cancellation, deletion and ruler creation share one gesture', async (t) => {
  const f = fixture(t);
  try {
    for (const reason of ['Escape', 'pointercancel', 'blur', 'active-doc']) {
      f.pointer('pointerdown', 260, 400);
      f.pointer('pointermove', 310, 400);
      if (reason === 'Escape') f.key('Escape');
      else if (reason === 'active-doc') f.app.emit('active-doc', f.doc);
      else if (reason === 'blur') window.dispatchEvent(new Event('blur'));
      else f.pointer(reason, 310, 400);
      f.pointer('pointerup', 330, 400);
      t.eq(f.doc.guides[0].pos, 30, `${reason} restores the original position`);
      t.eq(f.doc.history.states.length, 2, `${reason} adds no history`);
    }
    f.pointer('pointerdown', 260, 400);
    f.pointer('pointerup', 10, 400);
    t.eq(f.doc.guides.length, 0, 'dropping on a ruler deletes the guide');
    f.doc.history.undo();
    t.eq(f.doc.guides[0].pos, 30, 'deletion is undoable');
    const ruler = f.view.area.querySelector('.pk-ruler-h');
    f.pointer('pointerdown', 400, 10, {}, ruler);
    f.pointer('pointermove', 400, 250);
    f.pointer('pointerup', 400, 250);
    t.eq(f.doc.guides[1], { axis: 'h', pos: 50 }, 'a ruler creates and commits a horizontal guide');
    f.pointer('pointerdown', 600, 250);
    f.pointer('pointerup', 600, 290);
    t.eq(f.doc.guides[1].pos, 70, 'the newly created horizontal guide can be dragged again');
    f.pointer('pointerdown', 400, 10, {}, ruler);
    f.key('Escape');
    f.pointer('pointerup', 400, 280);
    t.eq(f.doc.guides.length, 2, 'cancelled ruler creation leaves no extra guide');
  } finally { f.cleanup(); }
});

suite('guides / drag shortcuts preserve undo, redo and fractional positions', async (t) => {
  const f = fixture(t);
  try {
    f.doc.guides[0].pos = 40; f.doc.commit('Move Guide');
    f.pointer('pointerdown', 280, 400);
    f.pointer('pointermove', 310, 400);
    f.key('ArrowRight');
    t.eq(f.doc.guides[0].pos, 55, 'arrow key leaves the drag preview intact');
    t.eq(f.doc.history.states.length, 3, 'arrow key does not nudge a layer');
    f.key('z', { metaKey: true });
    f.pointer('pointerup', 330, 400);
    t.eq(f.doc.guides[0].pos, 30, 'undo first cancels the preview, then restores history');
    t.ok(f.doc.history.canRedo, 'pointer release does not destroy redo');
    f.doc.history.redo();
    t.eq(f.doc.guides[0].pos, 40, 'the earlier move can still be redone');
    for (const scale of [0.25, 1, 2, 8]) {
      f.app.viewport.scale = scale;
      f.doc.guides[0].pos = 0.1;
      const x = 200 + 0.1 * scale - 4, n = f.doc.history.states.length;
      f.pointer('pointerdown', x, 400);
      f.pointer('pointerup', x, 400);
      t.eq(f.doc.guides[0].pos, 0.1, `click retains the fractional position at scale ${scale}`);
      t.eq(f.doc.history.states.length, n, 'click adds no history');
    }
  } finally { f.cleanup(); }
});

suite('guides / history snapshots and duplicated documents own their guides', async (t) => {
  const f = fixture(t);
  try {
    f.doc.guides[0].pos = 45; f.doc.commit('Move Guide');
    f.doc.history.undo();
    t.eq(f.doc.guides[0].pos, 30, 'editing a guide does not mutate the earlier snapshot');
    f.doc.guides[0].pos = 35;
    f.doc.history.redo(); f.doc.history.undo();
    t.eq(f.doc.guides[0].pos, 30, 'editing a restored guide leaves its history snapshot intact');
    duplicateDocument(f.doc);
    const copy = f.app.activeDoc;
    try {
      copy.guides[0].pos = 90;
      t.eq(f.doc.guides[0].pos, 30, 'moving the duplicate guide does not change the original');
    } finally { f.app.closeDocument(copy); f.app.setActiveDoc(f.doc); }
  } finally { f.cleanup(); }
});

suite('guides / rotated guides reach workspace edges and offscreen guides stay hidden', async (t) => {
  const f = fixture(t);
  try {
    const canvas = createCanvas(800, 600), ctx = canvas.getContext('2d');
    f.app.viewport.rotation = Math.PI / 4;
    f.view._drawGuides(ctx, f.app.viewport.matrix(), f.doc);
    const bytes = t.bytes(canvas);
    t.ok(bytes.slice(0, 800 * 4).some((v, i) => i % 4 === 3 && v > 0), 'rotated guide reaches the top workspace edge');
    t.ok(Array.from({ length: 600 }, (_, y) => bytes[(y * 800) * 4 + 3]).some(v => v > 0), 'rotated guide reaches the left workspace edge');
    ctx.clearRect(0, 0, 800, 600);
    f.doc.guides[0].pos = 10000;
    f.view._drawGuides(ctx, f.app.viewport.matrix(), f.doc);
    t.eq(t.inked(canvas), 0, 'a guide entirely outside the workspace is omitted');
  } finally { f.cleanup(); }
});
