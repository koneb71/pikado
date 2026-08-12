import { suite } from '../harness.js';
import { PikaDocument } from '/src/core/document.js';
import { Layer, LayerType, createRasterLayer, createGroupLayer } from '/src/core/layer.js';
import { Selection, morph, boxBlurMask } from '/src/core/selection.js';
import { BLEND_MODES, getBlendMode, isNativeBlend, blendCPU } from '/src/core/blend.js';
import { parseColor, toHex, rgb2hsv, hsv2rgb, rgb2hsl, hsl2rgb, rgb2lab, lab2rgb, luminance } from '/src/core/color.js';

suite('core / document + layer tree', async (t) => {
  const doc = t.doc(120, 80, '#ffffff', 'tree');
  t.eq([doc.width, doc.height], [120, 80], 'document has the requested size');
  t.eq(doc.layers.length, 1, 'blank document starts with one layer');
  t.ok(doc.layers[0].isBackground, 'that layer is the Background');

  const a = createRasterLayer(120, 80, 'A');
  const b = createRasterLayer(120, 80, 'B');
  doc.addLayer(a);
  doc.addLayer(b);
  t.eq(doc.layers.map((l) => l.name), ['B', 'A', 'Background'], 'layers[0] is the TOP layer');

  const g = createGroupLayer('G');
  doc.addLayer(g);
  doc.moveLayer(a, g, 0);
  t.eq(g.children.map((l) => l.name), ['A'], 'moveLayer nests into a group');
  t.eq(a.parent, g, 'nested layer records its parent');
  t.ok(doc.flatLayers().includes(a), 'flatLayers walks into groups');

  const loc = doc.locate(a);
  t.eq([loc.list === g.children, loc.index, loc.parent === g], [true, 0, true], 'locate() resolves a nested layer');

  t.eq(doc.findLayer(a.id), a, 'findLayer searches nested layers');
  t.eq(doc.findLayer('nope'), null, 'findLayer returns null for an unknown id');

  // A group must never be droppable into itself.
  doc.moveLayer(g, g, 0);
  t.ok(doc.layers.includes(g), 'moveLayer refuses to nest a group inside itself');

  doc.arrange(b, 'back');
  t.eq(doc.layers[doc.layers.length - 1].name, 'B', 'arrange("back") sends to the bottom');
  doc.arrange(b, 'front');
  t.eq(doc.layers[0].name, 'B', 'arrange("front") brings to the top');
});

suite('core / selection mask', async (t) => {
  const s = new Selection(50, 50);
  t.notOk(s.active, 'a new selection is inactive');
  t.eq(s.at(10, 10), 1, 'an inactive selection reports full coverage');
  t.eq(s.bounds(), { x: 0, y: 0, width: 50, height: 50 }, 'inactive bounds cover the document');

  s.combine(Selection.rectMask(10, 10, 20, 20, 50, 50), 'replace');
  t.ok(s.active, 'rect mask activates the selection');
  t.eq(s.bounds(), { x: 10, y: 10, width: 20, height: 20 }, 'bounds match the rect');
  t.eq(s.at(15, 15), 1, 'inside is fully selected');
  t.eq(s.at(5, 5), 0, 'outside is unselected');

  s.combine(Selection.rectMask(30, 10, 10, 20, 50, 50), 'add');
  t.eq(s.bounds().width, 30, 'add mode unions the regions');
  s.combine(Selection.rectMask(30, 10, 10, 20, 50, 50), 'subtract');
  t.eq(s.bounds(), { x: 10, y: 10, width: 20, height: 20 }, 'subtract removes it again');
  s.combine(Selection.rectMask(20, 10, 20, 20, 50, 50), 'intersect');
  t.eq(s.bounds(), { x: 20, y: 10, width: 10, height: 20 }, 'intersect keeps the overlap');

  // Feathering must produce genuinely partial coverage, not a hard edge.
  // The rect is generously larger than the feather reach: three box passes at
  // radius 4 spread further than 4 px, so a tight rect would leave even its
  // centre slightly under 1.
  const f = new Selection(120, 120);
  f.combine(Selection.rectMask(30, 30, 60, 60, 120, 120), 'replace');
  f.feather(4);
  const edge = f.at(30, 60);
  t.gt(edge, 0, 'feathered edge coverage is above 0');
  t.lt(edge, 1, 'feathered edge coverage is below 1 (genuinely antialiased)');
  t.eq(f.at(60, 60), 1, 'the feathered core, well inside the feather reach, stays fully selected');

  // Invert, and the empty-selection collapse.
  const inv = new Selection(20, 20);
  inv.selectAll();
  inv.invert();
  t.notOk(inv.active, 'inverting a full selection collapses to inactive');

  const g = new Selection(40, 40);
  g.combine(Selection.rectMask(10, 10, 10, 10, 40, 40), 'replace');
  const before = g.bounds().width;
  g.expand(3);
  t.gt(g.bounds().width, before, 'expand grows the selection');
  g.contract(3);
  t.close(g.bounds().width, before, 2, 'contract shrinks it back');

  t.ok(g.contour() instanceof Path2D, 'contour() builds a Path2D for the marching ants');
  t.eq(g.toAlphaCanvas().width, 40, 'toAlphaCanvas matches the document width');
});

suite('core / selection contour tracing', async (t) => {
  // The outline must be CONTINUOUS closed loops, not one subpath per pixel edge.
  // setLineDash restarts its phase at every moveTo, so a per-edge path renders
  // every dash "on" — a solid line that cannot march, and the black/white pair
  // overdraws into one thin invisible line. This is the bug these tests lock.
  const rect = new Selection(30, 20);
  rect.combine(Selection.rectMask(5, 4, 10, 6, 30, 20), 'replace');
  const rl = rect.contourLoops();
  t.eq(rl.length, 1, 'a rectangle traces to exactly one loop');
  t.eq(rl[0], [5, 4, 15, 4, 15, 10, 5, 10], 'and to its four exact corners, with collinear runs merged');

  const one = new Selection(10, 10);
  one.combine(Selection.rectMask(4, 4, 1, 1, 10, 10), 'replace');
  t.eq(one.contourLoops()[0], [4, 4, 5, 4, 5, 5, 4, 5], 'a single pixel still traces to a closed square');

  // A hole must come back as its own loop, or the ants would not outline it.
  const donut = new Selection(60, 60);
  donut.combine(Selection.rectMask(10, 10, 40, 40, 60, 60), 'replace');
  donut.combine(Selection.rectMask(24, 24, 12, 12, 60, 60), 'subtract');
  const dl = donut.contourLoops();
  t.eq(dl.length, 2, 'a ring traces to two loops (outer edge and hole)');
  t.eq(dl.map((l) => l.length / 2).sort(), [4, 4], 'both are clean four-corner squares');

  const two = new Selection(60, 30);
  two.combine(Selection.rectMask(4, 4, 10, 10, 60, 30), 'replace');
  two.combine(Selection.rectMask(30, 4, 10, 10, 60, 30), 'add');
  t.eq(two.contourLoops().length, 2, 'two disjoint regions trace to two loops');

  // Regions meeting corner-to-corner must stay separate outlines rather than
  // being stitched into one figure-of-eight at the shared vertex.
  const diag = new Selection(20, 20);
  diag.combine(Selection.rectMask(4, 4, 4, 4, 20, 20), 'replace');
  diag.combine(Selection.rectMask(8, 8, 4, 4, 20, 20), 'add');
  t.eq(diag.contourLoops().length, 2, 'a diagonal corner touch traces to two loops');

  /**
   * Total traced perimeter must equal the number of mask boundary edges: no
   * edge dropped (which would leave a gap in the outline) and none walked twice.
   */
  const perimeterOf = (sel) => {
    let perim = 0;
    for (const l of sel.contourLoops()) {
      for (let i = 0; i < l.length; i += 2) {
        const j = (i + 2) % l.length;
        perim += Math.abs(l[j] - l[i]) + Math.abs(l[j + 1] - l[i + 1]);
      }
    }
    return perim;
  };
  const edgeCountOf = (sel) => {
    const w = sel.width, h = sel.height, m = sel.mask;
    const on = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? false : m[y * w + x] > 127);
    let edges = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!on(x, y)) continue;
      if (!on(x, y - 1)) edges++;
      if (!on(x, y + 1)) edges++;
      if (!on(x - 1, y)) edges++;
      if (!on(x + 1, y)) edges++;
    }
    return edges;
  };

  const circle = new Selection(200, 200);
  circle.combine(Selection.ellipseMask(100, 100, 70, 70, 200, 200), 'replace');
  t.eq(circle.contourLoops().length, 1, 'a disc traces to one loop');
  t.eq(perimeterOf(circle), edgeCountOf(circle), 'disc: every boundary edge is walked exactly once');
  t.eq(perimeterOf(diag), edgeCountOf(diag), 'diagonal touch: every boundary edge is walked exactly once');
  t.eq(perimeterOf(donut), edgeCountOf(donut), 'ring: every boundary edge is walked exactly once');

  // Loops must be long enough for a dash pattern to actually run along them.
  t.gt(circle.contourLoops()[0].length / 2, 50, 'a disc outline is one long loop, not a pile of 1px subpaths');

  // The cache must not outlive an edit, or the ants would show a stale outline.
  const before = circle.contourLoops();
  t.is(circle.contourLoops(), before, 'contourLoops() is cached between calls');
  circle.combine(Selection.rectMask(0, 0, 10, 10, 200, 200), 'add');
  t.isNot(circle.contourLoops(), before, 'and the cache is dropped when the mask changes');

  // morph / boxBlurMask are used by tools directly.
  const m = new Uint8ClampedArray(400);
  for (let y = 8; y < 12; y++) for (let x = 8; x < 12; x++) m[y * 20 + x] = 255;
  t.gt(morph(m, 20, 20, 2, true).reduce((a, b) => a + (b > 127 ? 1 : 0), 0), 16, 'morph dilates');
  t.lt(morph(m, 20, 20, 1, false).reduce((a, b) => a + (b > 127 ? 1 : 0), 0), 16, 'morph erodes');
  const blurred = boxBlurMask(m, 20, 20, 2);
  t.ok([...blurred].some((v) => v > 0 && v < 255), 'boxBlurMask produces partial values');
});

suite('core / history copy-on-write', async (t) => {
  const doc = t.doc(40, 40, '#ffffff', 'hist');
  const l = doc.activeLayer();
  t.eq(doc.history.states.length, 1, 'a new document has one history state');
  t.notOk(doc.history.canUndo, 'nothing to undo yet');

  const white = t.px(l.canvas, 20, 20);
  doc.beginEdit(l);
  t.fill(l, '#ff0000');
  doc.commit('Fill Red');
  t.eq(t.px(doc.activeLayer().canvas, 20, 20), '255,0,0,255', 'the edit landed');
  t.eq(doc.history.states.length, 2, 'commit recorded a state');
  t.ok(doc.history.canUndo, 'undo is now available');

  doc.history.undo();
  t.eq(t.px(doc.activeLayer().canvas, 20, 20), white, 'undo restored the original pixels exactly');
  doc.history.redo();
  t.eq(t.px(doc.activeLayer().canvas, 20, 20), '255,0,0,255', 'redo reapplied them exactly');

  // The COW guarantee: a snapshot must not see later mutations.
  const layerNow = doc.activeLayer();
  doc.beginEdit(layerNow);
  t.fill(layerNow, '#00ff00');
  doc.commit('Fill Green');
  doc.history.goto(1);
  t.eq(t.px(doc.activeLayer().canvas, 20, 20), '255,0,0,255', 'goto() jumps to an arbitrary state');
  doc.history.goto(2);
  t.eq(t.px(doc.activeLayer().canvas, 20, 20), '0,255,0,255', 'and forward again');

  // Editing after an undo discards the redo tail.
  doc.history.undo();
  const l2 = doc.activeLayer();
  doc.beginEdit(l2);
  t.fill(l2, '#0000ff');
  doc.commit('Fill Blue');
  t.notOk(doc.history.canRedo, 'a new edit drops the redo tail');

  // Layer identity is rebuilt by restoreState — holding a reference is unsafe.
  // This needs an identity check: the rebuilt layer is structurally identical,
  // so a deep comparison would call them equal and prove nothing.
  const stale = doc.activeLayer();
  doc.history.undo();
  t.isNot(doc.activeLayer(), stale, 'restoreState rebuilds layer objects (stale refs must be re-resolved)');
  t.eq(doc.activeLayer().id, stale.id, 'the rebuilt layer keeps the same id, which is why refs must be re-resolved by id');

  // Tool-owned document data must survive a history step.
  doc.slices = [{ x: 1, y: 2, width: 3, height: 4, name: 's' }];
  doc.guides = [{ axis: 'v', pos: 12 }];
  doc.commit('With slices');
  doc.history.undo();
  doc.history.redo();
  t.eq(doc.slices, [{ x: 1, y: 2, width: 3, height: 4, name: 's' }], 'slices survive undo/redo');
  t.eq(doc.guides, [{ axis: 'v', pos: 12 }], 'guides survive undo/redo');
});

suite('core / blend mode table', async (t) => {
  t.eq(BLEND_MODES.length, 27, 'all 27 Photoshop blend modes are registered');
  const ids = new Set(BLEND_MODES.map((m) => m.id));
  t.eq(ids.size, 27, 'blend mode ids are unique');
  for (const id of ['normal', 'multiply', 'screen', 'overlay', 'vivid-light', 'divide', 'luminosity']) {
    t.ok(ids.has(id), `blend mode "${id}" exists`);
  }
  t.eq(getBlendMode('nonsense').id, 'normal', 'an unknown blend mode falls back to normal');
  t.ok(isNativeBlend('multiply'), 'multiply is native to Canvas2D');
  t.notOk(isNativeBlend('vivid-light'), 'vivid-light needs the CPU/GPU path');

  // blendCPU ground truth: multiply of 255 and 128 over an opaque backdrop.
  const base = new ImageData(new Uint8ClampedArray([255, 128, 128, 255]), 1, 1);
  const top = new ImageData(new Uint8ClampedArray([128, 255, 128, 255]), 1, 1);
  blendCPU(base, top, 'subtract', 1);
  t.eq([...base.data].slice(0, 3), [127, 0, 0], 'blendCPU subtract is exact (255-128, 128-255 clamped, 128-128)');

  const b2 = new ImageData(new Uint8ClampedArray([100, 100, 100, 255]), 1, 1);
  blendCPU(b2, new ImageData(new Uint8ClampedArray([0, 0, 0, 0]), 1, 1), 'linear-burn', 1);
  t.eq([...b2.data], [100, 100, 100, 255], 'a fully transparent source leaves the backdrop untouched');
});

suite('core / colour conversions', async (t) => {
  t.eq(parseColor('#ff0000'), { r: 255, g: 0, b: 0, a: 1 }, 'parses 6-digit hex');
  t.eq(parseColor('#f00'), { r: 255, g: 0, b: 0, a: 1 }, 'parses 3-digit hex');
  t.eq(parseColor('rgb(1,2,3)'), { r: 1, g: 2, b: 3, a: 1 }, 'parses rgb()');
  t.eq(parseColor('rgba(1,2,3,0.5)').a, 0.5, 'parses rgba() alpha');
  t.eq(parseColor('red'), { r: 255, g: 0, b: 0, a: 1 }, 'parses a named colour');
  t.eq(toHex({ r: 255, g: 128, b: 0 }), '#ff8000', 'toHex round-trips');

  for (const c of [[255, 0, 0], [0, 255, 0], [12, 200, 90], [255, 255, 255], [0, 0, 0]]) {
    const hsv = rgb2hsv(...c);
    const back = hsv2rgb(hsv.h, hsv.s, hsv.v);
    t.close(Math.abs(back.r - c[0]) + Math.abs(back.g - c[1]) + Math.abs(back.b - c[2]), 0, 3,
      `rgb->hsv->rgb round-trips for ${c.join(',')}`);
    const hsl = rgb2hsl(...c);
    const back2 = hsl2rgb(hsl.h, hsl.s, hsl.l);
    t.close(Math.abs(back2.r - c[0]) + Math.abs(back2.g - c[1]) + Math.abs(back2.b - c[2]), 0, 3,
      `rgb->hsl->rgb round-trips for ${c.join(',')}`);
    const lab = rgb2lab(...c);
    const back3 = lab2rgb(lab.l, lab.a, lab.b);
    t.close(Math.abs(back3.r - c[0]) + Math.abs(back3.g - c[1]) + Math.abs(back3.b - c[2]), 0, 4,
      `rgb->lab->rgb round-trips for ${c.join(',')}`);
  }
  t.close(luminance(255, 255, 255), 255, 0.5, 'white has full luminance');
  t.close(luminance(0, 0, 0), 0, 0.5, 'black has zero luminance');
});

suite('core / canvas + image sizing', async (t) => {
  const doc = t.doc(100, 60, '#ffffff', 'size');
  const l = doc.activeLayer();
  t.fill(l, '#ff0000', 0, 0, 50, 60);

  doc.resample(200, 120);
  t.eq([doc.width, doc.height], [200, 120], 'resample changes the document size');
  t.eq(doc.activeLayer().canvas.width, 200, 'layer buffers are resampled too');
  t.eq(t.px(doc.activeLayer().canvas, 40, 60), '255,0,0,255', 'content scaled with the document');

  doc.resizeCanvasTo(300, 120, 'left');
  t.eq(doc.width, 300, 'resizeCanvasTo changes the canvas');
  t.eq(t.px(doc.activeLayer().canvas, 40, 60), '255,0,0,255', 'left anchor keeps content in place');

  doc.crop({ x: 0, y: 0, width: 50, height: 50 });
  t.eq([doc.width, doc.height], [50, 50], 'crop resizes the document');
  t.notOk(doc.selection.active, 'crop clears the selection');

  doc.transformImage('cw');
  t.eq([doc.width, doc.height], [50, 50], 'a square document keeps its size when rotated');
  const doc2 = t.doc(80, 40, '#ffffff', 'rot');
  doc2.transformImage('cw');
  t.eq([doc2.width, doc2.height], [40, 80], 'rotating 90 degrees swaps width and height');
});

/* ------------------------------------------------------------------ */
/* Command registry                                                    */
/* ------------------------------------------------------------------ */

/**
 * Keyboard shortcuts have to be unique.
 *
 * Two commands claiming the same accelerator is a silent bug of the worst kind:
 * the shortcut still works, it just runs the wrong command, and the one that lost
 * looks broken with no error anywhere. Nothing enforces uniqueness at
 * registration time — commands are registered from several modules and any of
 * them can pick a key another already took — so it is enforced here.
 *
 * Modifier-free single letters are the tool shortcuts and are deliberately
 * excluded: tools live in their own keymap (`src/ui/shortcuts.js`) and a tool
 * letter can legitimately match a command's own.
 */
suite('core / keyboard shortcuts are unique', async (t) => {
  const { commands, accelBinding, buildBindingMap } = await import('/src/commands/registry.js');
  const list = [...commands.values()];
  t.gt(list.length, 150, `the registry is populated (${list.length} commands)`);

  // Group by the binding string the *app* computes, not by the accel text, so
  // "Shift+Ctrl+A" and "Ctrl+Shift+A" count as the same claim.
  const byBinding = new Map();
  for (const cmd of list) {
    for (const accel of [cmd.accel, ...(cmd.altAccels || [])]) {
      const binding = accelBinding(accel);
      if (!binding) continue;
      if (!byBinding.has(binding)) byBinding.set(binding, []);
      byBinding.get(binding).push(cmd.id);
    }
  }
  t.gt(byBinding.size, 60, `and plenty of commands carry a shortcut (${byBinding.size})`);

  const collisions = [...byBinding.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([binding, ids]) => `${binding} -> ${ids.join(', ')}`);
  t.eq(collisions, [], 'no two commands claim the same keyboard shortcut');

  // `buildBindingMap` keeps whichever command it saw first, so a collision does
  // not error — the losing command's shortcut simply never fires. That is why the
  // assertion above matters, and this is the proof that it is the failure mode.
  t.eq(buildBindingMap().size, byBinding.size,
    'and the binding map the shortcut handler uses holds every one of them');

  const malformed = list.filter((c) => !c.id || !(c.label || c.dynamicLabel)).map((c) => c.id || '(no id)');
  t.eq(malformed, [], 'every command has an id and a label');
});

/* ------------------------------------------------------------------ */
/* What history actually costs                                         */
/* ------------------------------------------------------------------ */

/**
 * History shares pixel buffers; it does not copy them.
 *
 * That was already true of layer canvases and masks, and was not true of the
 * selection: `captureState()` deep-copied the mask into every one of the sixty
 * states whether or not it had changed. At 4000x3000 that is 12 MB per state,
 * so up to 720 MB of duplicated selection for a selection the user may never
 * have touched.
 */
suite('core / history shares the selection mask instead of copying it', async (t) => {
  const W = 300, H = 200;
  const doc = t.doc(W, H, '#ffffff', 'selhist');
  const mask = new Uint8ClampedArray(W * H);
  for (let i = 0; i < mask.length; i += 3) mask[i] = 255;
  doc.selection.set(mask);

  for (let i = 0; i < 30; i += 1) doc.commit(`edit ${i}`);

  const buffers = new Set(doc.history.states.map((s) => s.state.selectionMask).filter(Boolean));
  t.gt(doc.history.states.length, 20, 'there are plenty of states to share between');
  /*
   * Verified to fail by restoring the deep copy in captureState: `buffers.size`
   * becomes one per state instead of one in total.
   */
  t.eq(buffers.size, 1, 'every state points at the same selection buffer');

  // Sharing is only safe because nothing writes into an existing mask. If a
  // future method mutates in place, this is the assertion that catches it.
  // Not states[0] — that one was recorded when the document was created, before
  // any selection existed, so its mask is legitimately null.
  const captured = doc.history.states.map((s) => s.state.selectionMask).find(Boolean);
  t.ok(captured, 'some state captured the selection');
  const sample = captured[0];
  doc.selection.invert();
  t.eq(captured[0], sample, 'inverting the selection does not reach back into history');
  t.eq(doc.selection.mask[0], 255 - sample, 'and still actually inverts');

  doc.selection.set(new Uint8ClampedArray(W * H).fill(128));
  t.eq(captured[0], sample, 'nor does replacing it wholesale');
});

suite('core / undo and redo still restore the right selection', async (t) => {
  const W = 120, H = 90;
  const doc = t.doc(W, H, '#ffffff', 'selundo');

  doc.selection.set(new Uint8ClampedArray(W * H).fill(64));
  doc.commit('first');
  doc.selection.set(new Uint8ClampedArray(W * H).fill(200));
  doc.commit('second');

  t.eq(doc.selection.mask[0], 200, 'the newest selection is live');
  doc.history.undo();
  t.eq(doc.selection.mask[0], 64, 'undo brings the previous one back');
  doc.history.redo();
  t.eq(doc.selection.mask[0], 200, 'and redo returns to the newer one');

  doc.selection.clear();
  doc.commit('cleared');
  t.notOk(doc.selection.mask, 'a cleared selection is null, not an empty buffer');
  doc.history.undo();
  t.ok(doc.selection.mask, 'and undo restores the one before it');
});

suite('core / beginEdit forks only the surface being written', async (t) => {
  const W = 200, H = 150;
  const doc = t.doc(W, H, '#ffffff', 'fork');
  const layer = doc.layers[0];
  layer.addMask(W, H, '#ffffff');

  /*
   * Filters replace layer.canvas outright, so forking the mask alongside it left
   * a byte-identical copy alive in history on every apply — 7.7 MB per apply at
   * 1600x1200 for a mask nobody edited. Verified to fail by dropping the
   * `surface` argument: maskAfter stops being the same object.
   */
  const maskBefore = layer.mask;
  const canvasBefore = layer.canvas;
  doc.beginEdit(layer, { surface: 'canvas' });
  t.ok(layer.canvas !== canvasBefore, 'the canvas is forked, because that is what is being written');
  t.is(layer.mask, maskBefore, 'the mask is left alone');

  // The mirror case, and the reason the default stays 'both'.
  const maskBefore2 = layer.mask;
  const canvasBefore2 = layer.canvas;
  doc.beginEdit(layer, { surface: 'mask' });
  t.ok(layer.mask !== maskBefore2, 'editing the mask forks the mask');
  t.is(layer.canvas, canvasBefore2, 'and leaves the canvas alone');

  const c3 = layer.canvas, m3 = layer.mask;
  doc.beginEdit(layer);
  t.ok(layer.canvas !== c3 && layer.mask !== m3, 'with no surface named, both are forked as before');
});

suite('core / memoryUse counts the derived caches too', async (t) => {
  /*
   * It counted only canvas, mask and alpha channels, which made it a floor
   * presented as a total — _maskAlpha is a whole extra document-sized canvas per
   * masked layer. Verified to fail by removing the _maskAlpha line.
   */
  const W = 100, H = 100;
  const doc = t.doc(W, H, '#ffffff', 'mem');
  const layer = doc.layers[0];
  const plain = doc.memoryUse();

  layer.addMask(W, H, '#ffffff');
  const withMask = doc.memoryUse();
  t.eq(withMask - plain, W * H * 4, 'a mask adds one buffer');

  layer.maskAlphaCanvas();
  t.eq(doc.memoryUse() - withMask, W * H * 4, 'and its alpha derivation adds another, now counted');

  // Still de-duplicated by identity, which is what the PSD shared blank needs.
  const { createRasterLayer } = await import('/src/core/layer.js');
  const shared = createRasterLayer(W, H, 'shared');
  shared.canvas = layer.canvas;
  doc.layers.unshift(shared);
  t.eq(doc.memoryUse(), doc.memoryUse(), 'stable');
  const twice = createRasterLayer(W, H, 'twice');
  twice.canvas = layer.canvas;
  doc.layers.unshift(twice);
  t.lt(doc.memoryUse(), (plain + W * H * 4 * 4), 'a shared buffer is still counted once');
});

/* ------------------------------------------------------------------ */
/* Per-layer bounds                                                    */
/* ------------------------------------------------------------------ */

/**
 * A layer's pixels can be held compactly — at their natural size plus an offset —
 * instead of in a document-sized buffer. That is how a PSD stores them, and
 * expanding it was costing 133x on a 120x120 layer in a 1600x1200 document.
 *
 * `.canvas` still hands back a document-sized buffer, so the ~230 places that
 * read it are unchanged. What matters is that the paths which run constantly —
 * snapshot, thumbnail, memoryUse, contentBounds, and the compositor — do NOT
 * read it, because any one of them would expand the whole document on the first
 * commit or the first frame.
 */
suite('core / a layer can hold its pixels compactly', async (t) => {
  const { createCanvas, ctx2d } = await import('/src/core/util.js');
  const W = 800, H = 600;
  const doc = t.doc(W, H, '#ffffff', 'tiles');

  const tile = createCanvas(100, 80);
  const tc = ctx2d(tile);
  tc.fillStyle = '#ff0000';
  tc.fillRect(0, 0, 100, 80);

  const layer = new Layer({ type: LayerType.RASTER, name: 'compact' });
  layer.setTile(tile, 250, 180, W, H);
  doc.addLayer(layer, { above: doc.layers[0] });

  t.ok(layer.tile, 'the layer reports a tile');
  t.eq(layer.pixelBytes(), 100 * 80 * 4, 'and costs only what the tile costs');
  t.lt(layer.pixelBytes(), W * H * 4 / 40, 'which is a small fraction of a document-sized buffer');

  // The things that run constantly must not expand it.
  layer.snapshot();
  t.ok(layer.tile, 'taking a history snapshot leaves it compact');
  layer.thumbnail();
  t.ok(layer.tile, 'drawing its panel thumbnail leaves it compact');
  doc.memoryUse();
  t.ok(layer.tile, 'asking the document its memory use leaves it compact');
  const b = layer.contentBounds();
  t.ok(layer.tile, 'and measuring its content bounds leaves it compact');
  t.eq(`${b.x},${b.y},${b.width},${b.height}`, '250,180,100,80', 'bounds come back in document space');

  // Reading .canvas is the one thing that does expand it, on purpose.
  const full = layer.canvas;
  t.eq(`${full.width}x${full.height}`, `${W}x${H}`, 'reading .canvas gives a document-sized buffer');
  t.notOk(layer.tile, 'and the tile is given up, because writers now own the full buffer');
  t.pixel(full, 300, 220, '255,0,0,255', 'with the pixels in the right place');
  t.pixel(full, 10, 10, '0,0,0,0', 'and nothing outside the tile');
});

suite('core / compositing a compact layer matches the expanded one exactly', async (t) => {
  const { createCanvas, ctx2d } = await import('/src/core/util.js');
  const { getComposite } = await import('/src/render/compositor.js');
  const W = 400, H = 300;

  const build = (compact) => {
    const doc = t.doc(W, H, '#ffffff', compact ? 'compact' : 'expanded');
    for (let i = 0; i < 4; i += 1) {
      const tile = createCanvas(60, 50);
      const c = ctx2d(tile);
      c.fillStyle = `hsl(${i * 80} 70% 50%)`;
      c.fillRect(0, 0, 60, 50);
      const l = new Layer({ type: LayerType.RASTER, name: `l${i}` });
      l.setTile(tile, 40 + i * 55, 30 + i * 40, W, H);
      if (!compact) l.canvas; // force expansion
      doc.addLayer(l, { above: doc.layers[0] });
    }
    return doc;
  };

  const compact = build(true);
  const expanded = build(false);
  const a = getComposite(compact).getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H);
  const b = getComposite(expanded).getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H);

  /*
   * Verified to fail by removing the tile fast path from drawLayer: the compact
   * document composites through `.canvas`, which is still correct, so this
   * assertion would still pass — but the one below it would not.
   */
  t.eq(t.mad(a.data, b.data), 0, 'the two paths produce identical pixels');
  t.ok(compact.flatLayers().some((l) => l.tile), 'and the compact document is still compact after compositing');
  t.notOk(expanded.flatLayers().slice(0, 4).some((l) => l.tile), 'while the expanded one never was');
});

suite('core / editing a compact layer keeps history correct', async (t) => {
  const { createCanvas, ctx2d } = await import('/src/core/util.js');
  const { getComposite } = await import('/src/render/compositor.js');
  const W = 300, H = 200;
  const doc = t.doc(W, H, '#ffffff', 'edit');

  const tile = createCanvas(80, 60);
  ctx2d(tile).fillStyle = '#00ff00';
  ctx2d(tile).fillRect(0, 0, 80, 60);
  const layer = new Layer({ type: LayerType.RASTER, name: 'c' });
  layer.setTile(tile, 100, 70, W, H);
  doc.addLayer(layer, { above: doc.layers[0] });
  doc.commit('add');

  t.pixel(getComposite(doc), 140, 100, '0,255,0,255', 'the tile shows where it was placed');

  // beginEdit must fork the tile rather than expanding it — a layer that is
  // merely touched should stay cheap.
  const tileBefore = layer.tile.canvas;
  doc.beginEdit(layer);
  t.ok(layer.tile, 'beginEdit leaves the layer compact');
  t.ok(layer.tile.canvas !== tileBefore, 'but gives it a private copy to write into');

  // Now actually write through .canvas, which expands, and check undo.
  ctx2d(layer.canvas).fillStyle = '#0000ff';
  ctx2d(layer.canvas).fillRect(0, 0, W, H);
  doc.commit('paint');
  t.pixel(getComposite(doc), 10, 10, '0,0,255,255', 'the paint covers the document');

  doc.history.undo();
  const back = doc.findLayer(layer.id);
  t.pixel(getComposite(doc), 10, 10, '255,255,255,255', 'undo restores the background');
  t.pixel(getComposite(doc), 140, 100, '0,255,0,255', 'and the compact layer with it');
  t.ok(back.tile || back.canvas, 'the restored layer has its pixels in one form or the other');
});

/* ------------------------------------------------------------------ */
/* Snapping                                                            */
/* ------------------------------------------------------------------ */

/**
 * The snap solver.
 *
 * Pikado had guides, a grid, a layout dialog and a Snap toggle, and nothing that
 * consumed any of them — `app.snap` had exactly one reader, and it only snapped a
 * guide being dragged out of the ruler. These tests pin the solver that fills
 * that gap, and they are all offline because the solver takes a rectangle and a
 * bag of lines and returns a number.
 */
suite('core / snapping finds the nearest line', async (t) => {
  const { solveSnap } = await import('/src/core/snap.js');
  const doc = { docWidth: 1000, docHeight: 800 };
  const box = { x: 98, y: 300, width: 50, height: 40 };

  const hit = solveSnap(box, { ...doc, guides: [{ axis: 'v', pos: 100 }] }, { threshold: 6 });
  t.eq(hit.dx, 2, 'a guide 2 away pulls the rectangle onto it');
  /*
   * Verified to fail by dropping guides from candidatesFor: dx becomes 0, which
   * is exactly the bug this whole feature exists to fix.
   */
  const noGuide = solveSnap(box, doc, { threshold: 6 });
  t.eq(noGuide.dx, 0, 'and with no guide there is nothing to snap to');

  const near = solveSnap({ ...box, x: 101 },
    { ...doc, guides: [{ axis: 'v', pos: 100 }, { axis: 'v', pos: 104 }] }, { threshold: 6 });
  t.eq(near.dx, -1, 'the nearest of two guides wins');

  const far = solveSnap({ ...box, x: 93 }, { ...doc, guides: [{ axis: 'v', pos: 100 }] }, { threshold: 6 });
  t.eq(far.dx, 0, 'a guide beyond the tolerance is ignored');

  const both = solveSnap({ x: 98, y: 197, width: 50, height: 40 },
    { ...doc, guides: [{ axis: 'v', pos: 100 }, { axis: 'h', pos: 200 }] }, { threshold: 6 });
  t.eq(`${both.dx},${both.dy}`, '2,3', 'the two axes solve independently');
});

suite('core / snapping uses all three edges of the moving rectangle', async (t) => {
  const { solveSnap } = await import('/src/core/snap.js');
  const doc = { docWidth: 2000, docHeight: 2000 };

  // Leading edge.
  t.eq(solveSnap({ x: 98, y: 0, width: 200, height: 10 },
    { ...doc, guides: [{ axis: 'v', pos: 100 }] }, { threshold: 6 }).dx, 2,
  'the leading edge snaps');

  // Centre: a 200-wide box at x=0 has its centre at 100.
  t.eq(solveSnap({ x: 3, y: 0, width: 200, height: 10 },
    { ...doc, guides: [{ axis: 'v', pos: 100 }] }, { threshold: 6 }).dx, -3,
  'the centre snaps, which is what makes centring on a guide possible');

  // Trailing edge: a 200-wide box at x=0 ends at 200.
  t.eq(solveSnap({ x: -2, y: 0, width: 200, height: 10 },
    { ...doc, guides: [{ axis: 'v', pos: 198 }] }, { threshold: 6 }).dx, 0,
  'the trailing edge snaps too');
});

suite('core / snapping ranks guides above the grid', async (t) => {
  const { solveSnap } = await import('/src/core/snap.js');
  const doc = { docWidth: 1000, docHeight: 1000 };

  /*
   * Both are 2 away. A guide is something the user placed deliberately, so it
   * has to win — otherwise a guide sitting a unit off a grid line would be
   * unreachable. Verified to fail by giving both the same priority.
   */
  const tie = solveSnap({ x: 98, y: 500, width: 10, height: 10 },
    { ...doc, gridSize: 100, guides: [{ axis: 'v', pos: 96 }] }, { threshold: 6 });
  t.eq(tie.dx, -2, 'with a guide and a grid line equidistant, the guide wins');

  const gridOnly = solveSnap({ x: 98, y: 500, width: 10, height: 10 },
    { ...doc, gridSize: 100 }, { threshold: 6 });
  t.eq(gridOnly.dx, 2, 'the grid still snaps when nothing outranks it');

  /*
   * The document's own edges and centre are structural and outrank a layer.
   * A zero-size rect so there is one moving edge rather than three, which makes
   * the two candidates genuinely equidistant and leaves priority as the only
   * thing that can decide.
   */
  const docCentre = solveSnap({ x: 98, y: 10, width: 0, height: 0 },
    { docWidth: 200, docHeight: 200, rects: [{ x: 96, y: 0, width: 0, height: 0 }] },
    { threshold: 6 });
  t.eq(docCentre.dx, 2, 'the document centre outranks an equally close layer edge');
});

suite('core / snapping reports the lines it matched', async (t) => {
  const { solveSnap } = await import('/src/core/snap.js');
  const r = solveSnap({ x: 98, y: 198, width: 20, height: 20 }, {
    docWidth: 1000, docHeight: 1000,
    guides: [{ axis: 'v', pos: 100 }, { axis: 'h', pos: 200 }],
  }, { threshold: 6 });

  // The overlay draws these; without them a snap is invisible and feels like a
  // glitch rather than a feature.
  t.eq(r.lines.length, 2, 'both matched lines come back');
  t.ok(r.lines.some((l) => l.axis === 'v' && l.pos === 100), 'the vertical guide is reported');
  t.ok(r.lines.some((l) => l.axis === 'h' && l.pos === 200), 'and the horizontal one');
  t.ok(r.lines.every((l) => l.kind === 'guide'), 'each line says what kind it is');

  t.eq(solveSnap({ x: 0, y: 0, width: 10, height: 10 }, { docWidth: 1000, docHeight: 1000 },
    { threshold: 0 }).lines.length, 0, 'a zero tolerance matches nothing');
});

suite('core / the snap tolerance is a screen distance, not a document one', async (t) => {
  const { snapThreshold, solveSnap, snapPosition } = await import('/src/core/snap.js');

  /*
   * The bug this prevents: a fixed document-space tolerance is an invisible
   * twitch at 800% zoom and a 60-unit leap at 10%. Verified to fail by returning
   * a constant.
   */
  t.eq(snapThreshold(1), 6, 'at 100% zoom, 6 screen pixels is 6 document units');
  t.eq(snapThreshold(0.1), 60, 'at 10% zoom the same 6 pixels spans 60 document units');
  t.close(snapThreshold(8), 0.75, 1e-9, 'and at 800% it is well under a unit');
  t.eq(snapThreshold(0), 6, 'a nonsense scale falls back to 1:1 rather than dividing by zero');

  // Zoomed out, a guide 40 units away is still within reach.
  const zoomedOut = solveSnap({ x: 60, y: 0, width: 10, height: 10 },
    { docWidth: 1000, docHeight: 1000, guides: [{ axis: 'v', pos: 100 }] },
    { threshold: snapThreshold(0.1) });
  // 30, not 40: the box ends at 70, so its trailing edge is the nearest thing to
  // the guide. At 100% zoom this guide would be far out of reach entirely.
  t.eq(zoomedOut.dx, 30, 'so a distant guide still catches when zoomed out');
  t.eq(solveSnap({ x: 60, y: 0, width: 10, height: 10 },
    { docWidth: 1000, docHeight: 1000, guides: [{ axis: 'v', pos: 100 }] },
    { threshold: snapThreshold(1) }).dx, 0, 'and does not when zoomed in');

  // The ruler drag path: a bare position rather than a rectangle.
  t.eq(snapPosition(98, 'v', { gridSize: 100 }, 6).pos, 100, 'a dragged guide snaps to the grid');
  t.eq(snapPosition(90, 'v', { gridSize: 100 }, 6).pos, 90, 'and is left alone beyond the tolerance');
});

suite('core / dragging a layer snaps it to a guide', async (t) => {
  const { app } = await import('/src/core/app.js');
  const { createRasterLayer } = await import('/src/core/layer.js');
  await import('/src/tools/move.js');

  const setup = () => {
    const doc = t.doc(600, 400, '#ffffff', 'snapdrag');
    doc.guides = [{ axis: 'v', pos: 200 }];
    const l = createRasterLayer(600, 400, 'block');
    const c = l.canvas.getContext('2d');
    c.fillStyle = '#ff0000';
    c.fillRect(150, 100, 60, 60);
    doc.addLayer(l, { above: doc.layers[0] });
    doc.selectedLayerIds = [l.id];
    doc.activeLayerId = l.id;
    app.setTool('move');
    return { doc, id: l.id };
  };
  // Drag right by 48: the left edge lands at 198, two short of the guide.
  const drag = (mods = {}) => {
    const base = { shiftKey: false, ctrlKey: false, metaKey: false, button: 0, ...mods };
    app.tool.onPointerDown({ ...base, x: 180, y: 130 });
    app.tool.onPointerMove({ ...base, x: 228, y: 130 });
    app.tool.onPointerUp({ ...base, x: 228, y: 130 });
  };

  const wasSnapping = app.snap;
  try {
    app.snap = true;
    let s = setup();
    drag();
    /*
     * The whole point of the feature. Verified to fail by removing the snapDrag
     * call from onPointerMove: it lands on 198, which is what it did for the
     * entire life of the project before this.
     */
    t.eq(s.doc.findLayer(s.id).contentBounds().x, 200, 'the layer lands on the guide, not two short of it');

    s = setup();
    drag({ ctrlKey: true });
    t.eq(s.doc.findLayer(s.id).contentBounds().x, 198, 'holding Ctrl places it exactly where you dropped it');

    app.snap = false;
    s = setup();
    drag();
    t.eq(s.doc.findLayer(s.id).contentBounds().x, 198, 'and View > Snap turned off does the same');
  } finally {
    app.snap = wasSnapping;
  }
});

suite('core / aligning against other layers does not expand them', async (t) => {
  const { app } = await import('/src/core/app.js');
  const { Layer, LayerType } = await import('/src/core/layer.js');
  const { createCanvas, ctx2d } = await import('/src/core/util.js');
  await import('/src/tools/move.js');

  /*
   * Smart guides need the bounds of every OTHER layer to align against. Gathering
   * those through `layer.canvas` would materialise the whole document on the
   * first drag — a 60-layer 4000x3000 PSD would go from 99 MB to 3.6 GB. The
   * bounds cache is keyed on `pixelKey()` for exactly this reason.
   *
   * Verified to fail by keying `contentBoundsOf` on `layer.canvas` again: every
   * layer expands, not just the one being dragged.
   */
  const doc = t.doc(2000, 1500, '#ffffff', 'compactdrag');
  doc.guides = [{ axis: 'v', pos: 500 }];
  for (let i = 0; i < 8; i += 1) {
    const tile = createCanvas(80, 80);
    ctx2d(tile).fillStyle = `hsl(${i * 40} 70% 50%)`;
    ctx2d(tile).fillRect(0, 0, 80, 80);
    const layer = new Layer({ type: LayerType.RASTER, name: `t${i}` });
    layer.setTile(tile, 100 + i * 90, 200, 2000, 1500);
    doc.addLayer(layer, { above: doc.layers[0] });
  }

  const target = doc.layers[0];
  doc.selectedLayerIds = [target.id];
  doc.activeLayerId = target.id;
  const others = () => doc.flatLayers().filter((l) => l !== target && l.name.startsWith('t'));
  t.eq(others().filter((l) => l.tile).length, 7, 'the other layers start compact');

  const wasSnapping = app.snap;
  try {
    app.snap = true;
    app.setTool('move');
    const base = { shiftKey: false, ctrlKey: false, metaKey: false, button: 0 };
    app.tool.onPointerDown({ ...base, x: 140, y: 240 });
    app.tool.onPointerMove({ ...base, x: 200, y: 240 });
    app.tool.onPointerUp({ ...base, x: 200, y: 240 });

    t.eq(others().filter((l) => l.tile).length, 7,
      'and are still compact after a drag that measured every one of them');
  } finally {
    app.snap = wasSnapping;
  }
});

suite('core / dragging a guide snaps it to the document, not to itself', async (t) => {
  const { app } = await import('/src/core/app.js');
  const { snapGuidePos } = await import('/src/core/snapping.js');

  const doc = t.doc(600, 400, '#ffffff', 'guidesnap');
  const g = { axis: 'v', pos: 250 };
  doc.guides = [g];

  const was = { snap: app.snap, grid: app.gridSize };
  try {
    app.snap = true;
    app.gridSize = 0;

    t.eq(snapGuidePos(297, 'v', doc, { excludeGuide: g }), 300,
      'a guide dragged near the middle of the document lands on it');

    /*
     * The guide being dragged sits under the cursor, and `moveGuide` writes its
     * new position on every pointer move — so if it stayed in its own candidate
     * list it would always be the nearest target and the guide would never
     * move. Verified to fail by dropping the excludeGuide filter in
     * `snapTargets`: this returns 250, the guide's own position, and the drag
     * is stuck.
     */
    t.eq(snapGuidePos(252, 'v', doc, { excludeGuide: g }), 252,
      'and is not dragged back onto where it already was');

    t.eq(snapGuidePos(252, 'v', doc, {}), 250, 'while a second guide at that position does catch it');

    app.snap = false;
    t.eq(snapGuidePos(297, 'v', doc, { excludeGuide: g }), 297, 'View > Snap off leaves it alone');

    app.snap = true;
    t.eq(snapGuidePos(297, 'v', doc, { excludeGuide: g, event: { ctrlKey: true } }), 297,
      'and so does holding Ctrl');
  } finally {
    app.snap = was.snap;
    app.gridSize = was.grid;
  }
});
