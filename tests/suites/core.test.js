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
