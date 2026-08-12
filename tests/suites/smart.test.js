import { suite } from '../harness.js';
import { PikaDocument } from '/src/core/document.js';
import { LayerType } from '/src/core/layer.js';
import {
  createSmartObject, isSmartLayer, getSmartTransform, getSmartFilters,
  setSmartTransform, resetSmartTransform, addSmartFilter, removeSmartFilter,
  reorderSmartFilters, toggleSmartFilter, setSmartFiltersEnabled, editSmartFilter,
  renderSmartObject, matrixMultiply, decomposeMatrix, composeMatrix, IDENTITY_MATRIX,
  NO_PERSPECTIVE, toMatrix3, fromMatrix3, matrix3Multiply, applyMatrix3, invertMatrix3,
  unitSquareToQuad, rectToQuad, identityWarp, evalWarp,
  getSmartPerspective, getSmartWarp, hasSmartShape, clearSmartShape,
} from '/src/core/smart.js';
import { convertToSmartObject, rasterizeLayer } from '/src/layers/ops.js';
import { startTransform, setTransformNumeric, commitTransform } from '/src/tools/transform.js';
import { createCanvas, ctx2d } from '/src/core/util.js';

/**
 * Smart Objects.
 *
 * The whole promise of a Smart Object is that `layer.canvas` is only a *cache*:
 * every render starts again from the embedded source document, so a transform is
 * a matrix you can change your mind about rather than a resample you cannot take
 * back. These tests are mostly about that — they compare pixel buffers byte for
 * byte and they always establish that the "before" and "after" they compare
 * genuinely differ, otherwise a broken non-destructive path would sail through.
 *
 * Trap worth repeating: `doc.history.undo()` rebuilds every Layer object
 * (`restoreState` -> `Layer.fromSnapshot`), so a Layer reference taken before an
 * undo is dead afterwards. Everything below re-resolves with `doc.findLayer(id)`.
 */

/* ------------------------------------------------------------------ */
/* Local helpers                                                       */
/* ------------------------------------------------------------------ */

/** Round a matrix so float noise does not break an equality assertion. */
function m6(m, places = 4) {
  const f = 10 ** places;
  return m.map((n) => Math.round(n * f) / f);
}

/** Scale-about-nothing matrix: source pixels land at the origin, scaled by k. */
function scaleMatrix(k) {
  return [k, 0, 0, k, 0, 0];
}

/** The destructive equivalent of a scale round-trip: resample down, then up. */
function destructiveRoundTrip(src, k) {
  const w = Math.max(1, Math.round(src.width * k));
  const h = Math.max(1, Math.round(src.height * k));
  const small = createCanvas(w, h);
  const sc = ctx2d(small);
  sc.imageSmoothingEnabled = true;
  sc.imageSmoothingQuality = 'high';
  sc.drawImage(src, 0, 0, w, h);
  const back = createCanvas(src.width, src.height);
  const bc = ctx2d(back);
  bc.imageSmoothingEnabled = true;
  bc.imageSmoothingQuality = 'high';
  bc.drawImage(small, 0, 0, src.width, src.height);
  return back;
}

/** A committed detail layer, plus the smart layer it was converted into. */
function smartFromDetail(t, size = 200, name = 'smart') {
  const doc = t.doc(size, size, '#ffffff', name);
  const raster = doc.activeLayer();
  doc.beginEdit(raster);
  t.detail(raster);
  doc.commit('Detail');
  const original = t.bytes(raster.canvas);
  const smart = createSmartObject(doc, [raster]);
  return { doc, smart, original };
}

/** Wait for a `paramDialog` to mount, apply edits, accept it. */
async function driveParamDialog(promise, edits) {
  let overlay = null;
  for (let i = 0; i < 60 && !overlay; i++) {
    overlay = [...document.querySelectorAll('.pk-dialog-overlay')].pop() || null;
    if (!overlay) await new Promise((r) => setTimeout(r, 16));
  }
  if (!overlay) return { ok: false, why: 'no dialog appeared' };
  for (const [selector, value] of edits) {
    const input = overlay.querySelector(selector);
    if (!input) return { ok: false, why: `no ${selector} in the dialog` };
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const okBtn = overlay.querySelector('.pk-btn.primary');
  if (!okBtn) return { ok: false, why: 'no OK button' };
  okBtn.click();
  const result = await Promise.race([
    promise,
    new Promise((r) => setTimeout(() => r('__timeout__'), 2000)),
  ]);
  // Never leave a modal behind for the suites that run after this one.
  for (const o of document.querySelectorAll('.pk-dialog-overlay')) o.remove();
  return result === '__timeout__' ? { ok: false, why: 'dialog never resolved' } : { ok: true, result };
}

/* ------------------------------------------------------------------ */

suite('smart / conversion captures a real embedded document', async (t) => {
  const doc = t.doc(120, 90, '#ffffff', 'convert');
  const raster = doc.activeLayer();
  doc.beginEdit(raster);
  t.fill(raster, '#3366cc');
  raster.name = 'Artwork';
  doc.commit('Fill');
  const rasterId = raster.id;
  const before = t.bytes(raster.canvas);

  const smart = createSmartObject(doc, [raster]);
  t.ok(smart, 'createSmartObject returns the new layer');
  t.eq(smart.type, LayerType.SMART, 'the new layer is of type "smart"');
  t.ok(isSmartLayer(smart), 'isSmartLayer accepts it');
  t.ok(smart.smart.source instanceof PikaDocument, 'smart.source is a real PikaDocument');
  t.eq([smart.smart.source.width, smart.smart.source.height], [120, 90], 'the source is document-sized');
  t.eq(smart.smart.source.layers.length, 1, 'the source carries the original layer');
  t.eq(smart.smart.source.layers[0].id, rasterId, 'layer ids are preserved inside the source');
  t.eq(smart.smart.source.layers[0].name, 'Artwork', 'and so is the layer name');
  t.notOk(smart.smart.source.layers[0].isBackground, 'the embedded copy is no longer the Background');
  t.eq(t.mad(t.bytes(smart.smart.source.layers[0].canvas), before), 0,
    'the embedded pixels are byte-identical to the layer that was converted');
  t.eq(m6(getSmartTransform(smart)), [1, 0, 0, 1, 0, 0], 'the transform starts as the identity');
  t.eq(getSmartFilters(smart).length, 0, 'no smart filters yet');
  t.eq([smart.smart.sourceWidth, smart.smart.sourceHeight], [120, 90], 'sourceWidth/Height record the source size');

  t.eq(t.mad(t.bytes(smart.canvas), before), 0,
    'the identity render reproduces the original pixels exactly');
  t.eq(doc.flatLayers().length, 1, 'the original layer was replaced, not duplicated');
  t.eq(doc.findLayer(rasterId), null, 'the original layer is gone from the parent document');
  t.eq(doc.history.states[doc.history.index].label, 'Convert to Smart Object', 'conversion is one history step');

  // Converting a Smart Object again is refused rather than nested silently.
  t.eq(createSmartObject(doc, [smart]), null, 'converting a Smart Object again is refused');

  // The ops wrapper is the path the menu and the Layers panel use.
  const doc2 = t.doc(60, 60, '#ffffff', 'convert-ops');
  const l2 = doc2.activeLayer();
  doc2.beginEdit(l2);
  t.fill(l2, '#00aa44');
  doc2.commit('Fill');
  const smart2 = convertToSmartObject(doc2, [l2]);
  t.eq(smart2 && smart2.type, LayerType.SMART, 'ops.convertToSmartObject produces a smart layer too');
  t.eq(t.px(smart2.canvas, 30, 30), '0,170,68,255', 'and renders the captured colour');
});

suite('smart / scaling down and back up is lossless', async (t) => {
  const { doc, smart, original } = smartFromDetail(t, 200, 'lossless');
  const id = smart.id;
  const sourceBytes = t.bytes(smart.smart.source.layers[0].canvas);
  t.eq(t.mad(t.bytes(smart.canvas), original), 0, 'baseline: the smart render starts identical to the original');

  // --- down to 10% ---
  setSmartTransform(doc, smart, scaleMatrix(0.1));
  const tenPercent = t.bytes(doc.findLayer(id).canvas);
  const madTen = t.mad(tenPercent, original);
  t.gt(madTen, 20, `the 10% render differs substantially from the original (mad ${madTen.toFixed(1)})`);

  // --- and back to 100% ---
  setSmartTransform(doc, smart, IDENTITY_MATRIX.slice());
  const restored = t.bytes(doc.findLayer(id).canvas);
  const madRestored = t.mad(restored, original);
  t.eq(madRestored, 0, `10% -> 100% restores the pixels exactly (mad ${madRestored})`);

  // The control: doing the same trip destructively wrecks the detail. Without
  // this the assertion above could be passing for a trivial reason.
  const baked = createCanvas(200, 200);
  ctx2d(baked).putImageData(new ImageData(new Uint8ClampedArray(original), 200, 200), 0, 0);
  const madDestructive = t.mad(t.bytes(destructiveRoundTrip(baked, 0.1)), original);
  t.gt(madDestructive, 8,
    `the destructive drawImage round trip degrades badly (mad ${madDestructive.toFixed(1)} vs 0 for the smart object)`);
  t.gt(madDestructive, madRestored + 8, 'the smart round trip is dramatically better than the destructive one');

  // --- five more cycles: no drift, and the source never moves ---
  for (let i = 0; i < 5; i++) {
    setSmartTransform(doc, doc.findLayer(id), scaleMatrix(0.1 + i * 0.05));
    setSmartTransform(doc, doc.findLayer(id), IDENTITY_MATRIX.slice());
  }
  const afterCycles = t.bytes(doc.findLayer(id).canvas);
  t.eq(t.mad(afterCycles, original), 0, 'six scale round trips still leave zero drift');
  t.eq(t.mad(t.bytes(doc.findLayer(id).smart.source.layers[0].canvas), sourceBytes), 0,
    'the embedded source pixels are byte-identical after every transform');

  // Rotation composes the same way.
  const rot = composeMatrix({ centerX: 100, centerY: 100, scaleX: 0.25, scaleY: 0.25, angle: 0.7 }, 200, 200);
  setSmartTransform(doc, doc.findLayer(id), rot);
  const rotated = t.bytes(doc.findLayer(id).canvas);
  t.gt(t.mad(rotated, original), 20, 'a rotated + scaled render genuinely differs');
  const dec = decomposeMatrix(getSmartTransform(doc.findLayer(id)), 200, 200);
  t.close(dec.scaleX, 0.25, 1e-6, 'decomposeMatrix recovers the scale it was composed from');
  t.close(dec.angle, 0.7, 1e-6, 'decomposeMatrix recovers the angle');
  t.close(dec.centerX, 100, 1e-6, 'decomposeMatrix recovers the centre');

  resetSmartTransform(doc, doc.findLayer(id));
  t.eq(m6(getSmartTransform(doc.findLayer(id))), [1, 0, 0, 1, 0, 0], 'resetSmartTransform returns to the identity');
  t.eq(t.mad(t.bytes(doc.findLayer(id).canvas), original), 0,
    'and the pixels come all the way back from a rotated 25% render');
  t.eq(t.mad(t.bytes(doc.findLayer(id).smart.source.layers[0].canvas), sourceBytes),
    0, 'the embedded source is still byte-identical after rotation');

  // An invalid matrix must be rejected, not installed.
  t.eq(setSmartTransform(doc, doc.findLayer(id), [1, 0, 0, 1, 0]), null, 'a 5-element matrix is rejected');
  t.eq(setSmartTransform(doc, doc.findLayer(id), [1, 0, 0, NaN, 0, 0]), null, 'a matrix containing NaN is rejected');
  t.eq(m6(getSmartTransform(doc.findLayer(id))), [1, 0, 0, 1, 0, 0], 'the transform is untouched by a rejected matrix');

  // matrixMultiply is the primitive the transform tool composes with.
  t.eq(m6(matrixMultiply(scaleMatrix(10), [0.1, 0, 0, 0.1, 90, 90])), [1, 0, 0, 1, 900, 900],
    'matrixMultiply(A,B) applies B first, then A');
});

suite('smart / smart filters stack, toggle and reorder', async (t) => {
  const { doc, smart } = smartFromDetail(t, 160, 'sfilters');
  const id = smart.id;
  const sourceBytes = t.bytes(smart.smart.source.layers[0].canvas);
  const r0 = t.bytes(smart.canvas);

  // An unknown id must be refused. "invert" is an ADJUSTMENT, not a filter, so
  // it is exactly the id a caller gets wrong.
  t.eq(addSmartFilter(doc, smart, 'invert'), null, 'addSmartFilter rejects "invert" (an adjustment, not a filter)');
  t.eq(addSmartFilter(doc, smart, 'no-such-filter'), null, 'addSmartFilter rejects an unregistered id');
  t.eq(getSmartFilters(doc.findLayer(id)).length, 0, 'nothing was added to the stack');
  t.eq(t.mad(t.bytes(doc.findLayer(id).canvas), r0), 0, 'and the render is untouched');

  const blur = addSmartFilter(doc, doc.findLayer(id), 'gaussian-blur', { radius: 6 });
  t.ok(blur && blur.id, 'addSmartFilter returns the stack entry');
  t.eq(blur.filterId, 'gaussian-blur', 'the entry records the filter id');
  t.eq(blur.params.radius, 6, 'the entry records the params it was given');
  t.ok(blur.enabled, 'a new smart filter is enabled');
  const r1 = t.bytes(doc.findLayer(id).canvas);
  t.gt(t.mad(r1, r0), 2, `one smart filter changes the render (mad ${t.mad(r1, r0).toFixed(2)})`);

  const mosaic = addSmartFilter(doc, doc.findLayer(id), 'mosaic', { cellSize: 16 });
  t.eq(getSmartFilters(doc.findLayer(id)).length, 2, 'a second smart filter stacks on top');
  const r2 = t.bytes(doc.findLayer(id).canvas);
  t.gt(t.mad(r2, r1), 2, `the second filter changes the render again (mad ${t.mad(r2, r1).toFixed(2)})`);

  // Disabling the mosaic must reproduce the blur-only render *exactly*: the
  // chain is re-run from the source, it is not "un-applied".
  t.ok(toggleSmartFilter(doc, doc.findLayer(id), mosaic.id), 'toggleSmartFilter reports success');
  t.notOk(getSmartFilters(doc.findLayer(id))[1].enabled, 'the entry is now disabled but still present');
  t.eq(getSmartFilters(doc.findLayer(id)).length, 2, 'toggling off does not delete the entry');
  const rOff = t.bytes(doc.findLayer(id).canvas);
  t.eq(t.mad(rOff, r1), 0, 'with the mosaic disabled the render is byte-identical to the blur-only render');
  t.gt(t.mad(rOff, r2), 2, 'and genuinely differs from the both-enabled render');

  toggleSmartFilter(doc, doc.findLayer(id), mosaic.id);
  t.ok(getSmartFilters(doc.findLayer(id))[1].enabled, 're-enabled');
  t.eq(t.mad(t.bytes(doc.findLayer(id).canvas), r2), 0, 'toggling back on restores the render exactly');
  t.eq(getSmartFilters(doc.findLayer(id))[1].params.cellSize, 16, 'and the settings survived the round trip');

  // Order matters: blur-then-mosaic is not mosaic-then-blur.
  t.ok(reorderSmartFilters(doc, doc.findLayer(id), 0, 1), 'reorderSmartFilters reports success');
  t.eq(getSmartFilters(doc.findLayer(id)).map((f) => f.filterId), ['mosaic', 'gaussian-blur'],
    'the stack order changed');
  const r3 = t.bytes(doc.findLayer(id).canvas);
  t.gt(t.mad(r3, r2), 2, `filter order changes the result (mad ${t.mad(r3, r2).toFixed(2)})`);
  t.notOk(reorderSmartFilters(doc, doc.findLayer(id), 1, 1), 'reordering onto itself is a no-op');

  reorderSmartFilters(doc, doc.findLayer(id), 0, 1);
  t.eq(getSmartFilters(doc.findLayer(id)).map((f) => f.filterId), ['gaussian-blur', 'mosaic'], 'order restored');
  t.eq(t.mad(t.bytes(doc.findLayer(id).canvas), r2), 0, 'and so is the render, exactly');

  // setSmartFiltersEnabled is one history step for the whole stack.
  t.ok(setSmartFiltersEnabled(doc, doc.findLayer(id), false), 'setSmartFiltersEnabled(false) reports a change');
  t.eq(getSmartFilters(doc.findLayer(id)).filter((f) => f.enabled).length, 0, 'every filter is off');
  t.eq(t.mad(t.bytes(doc.findLayer(id).canvas), r0), 0, 'with every filter off the render equals the unfiltered source');
  t.notOk(setSmartFiltersEnabled(doc, doc.findLayer(id), false), 'a no-op call reports no change');
  setSmartFiltersEnabled(doc, doc.findLayer(id), true);
  t.eq(t.mad(t.bytes(doc.findLayer(id).canvas), r2), 0, 'and turning them all back on is exact');

  // Removing the mosaic must land back on the blur-only state precisely.
  t.ok(removeSmartFilter(doc, doc.findLayer(id), mosaic.id), 'removeSmartFilter reports success');
  t.eq(getSmartFilters(doc.findLayer(id)).length, 1, 'the stack is one shorter');
  t.eq(t.mad(t.bytes(doc.findLayer(id).canvas), r1), 0, 'removing the second filter returns exactly to the earlier state');
  t.notOk(removeSmartFilter(doc, doc.findLayer(id), mosaic.id), 'removing it twice is refused');

  t.eq(t.mad(t.bytes(doc.findLayer(id).smart.source.layers[0].canvas), sourceBytes), 0,
    'the embedded source pixels are byte-identical after the whole filter session');

  // editSmartFilter re-opens the filter's dialog and rewrites its params.
  const entryId = getSmartFilters(doc.findLayer(id))[0].id;
  const driven = await driveParamDialog(
    editSmartFilter(doc, doc.findLayer(id), entryId),
    [['input.pk-num', 24]]
  );
  t.ok(driven.ok, `editSmartFilter opens a re-editable dialog${driven.ok ? '' : ` (${driven.why})`}`);
  if (driven.ok) {
    t.eq(driven.result, true, 'editSmartFilter reports that it committed');
    t.eq(getSmartFilters(doc.findLayer(id)).length, 1, 'editing does not add a second entry');
    t.eq(getSmartFilters(doc.findLayer(id))[0].params.radius, 24, 'editSmartFilter updated the params');
    const r4 = t.bytes(doc.findLayer(id).canvas);
    t.gt(t.mad(r4, r1), 2, `and the render followed the new radius (mad ${t.mad(r4, r1).toFixed(2)})`);
    t.eq(t.mad(t.bytes(doc.findLayer(id).smart.source.layers[0].canvas), sourceBytes), 0,
      'editing a smart filter still leaves the source untouched');
  }
  t.eq(document.querySelectorAll('.pk-dialog-overlay').length, 0, 'no dialog is left behind');
});

suite('smart / undo and redo walk the filter stack and the transform', async (t) => {
  const doc = t.doc(120, 120, '#ffffff', 'shistory');
  const raster = doc.activeLayer();
  doc.beginEdit(raster);
  t.detail(raster);
  doc.commit('Detail');

  const smart = createSmartObject(doc, [raster]);   // state 2
  const id = smart.id;
  const bConvert = t.bytes(smart.canvas);

  addSmartFilter(doc, doc.findLayer(id), 'gaussian-blur', { radius: 5 });   // state 3
  const bBlur = t.bytes(doc.findLayer(id).canvas);

  addSmartFilter(doc, doc.findLayer(id), 'mosaic', { cellSize: 12 });       // state 4
  const bMosaic = t.bytes(doc.findLayer(id).canvas);

  setSmartTransform(doc, doc.findLayer(id), scaleMatrix(0.5));              // state 5
  const bScaled = t.bytes(doc.findLayer(id).canvas);

  t.eq(doc.history.states.length, 6, 'five commits plus the initial state');
  t.gt(t.mad(bBlur, bConvert), 2, 'precondition: each step really changed the render (convert -> blur)');
  t.gt(t.mad(bMosaic, bBlur), 2, 'precondition: blur -> mosaic changed the render');
  t.gt(t.mad(bScaled, bMosaic), 20, 'precondition: mosaic -> 50% changed the render');

  doc.history.undo();
  let l = doc.findLayer(id);
  t.eq(m6(getSmartTransform(l)), [1, 0, 0, 1, 0, 0], 'undo walks the transform back to the identity');
  t.eq(getSmartFilters(l).map((f) => f.filterId), ['gaussian-blur', 'mosaic'], 'the filter stack is still both filters');
  t.eq(t.mad(t.bytes(l.canvas), bMosaic), 0, 'and the pixels match that state exactly');

  doc.history.undo();
  l = doc.findLayer(id);
  t.eq(getSmartFilters(l).map((f) => f.filterId), ['gaussian-blur'], 'a second undo pops the mosaic off the stack');
  t.eq(t.mad(t.bytes(l.canvas), bBlur), 0, 'pixels match the blur-only render exactly');

  doc.history.undo();
  l = doc.findLayer(id);
  t.eq(getSmartFilters(l).length, 0, 'a third undo empties the stack');
  t.ok(isSmartLayer(l), 'the layer is still a Smart Object with its source intact');
  t.eq(t.mad(t.bytes(l.canvas), bConvert), 0, 'pixels match the freshly converted render exactly');

  doc.history.redo();
  doc.history.redo();
  doc.history.redo();
  l = doc.findLayer(id);
  t.eq(getSmartFilters(l).map((f) => f.filterId), ['gaussian-blur', 'mosaic'], 'redo restores the whole stack');
  t.eq(getSmartFilters(l)[1].params.cellSize, 12, 'and each filter keeps its params');
  t.eq(m6(getSmartTransform(l)), [0.5, 0, 0, 0.5, 0, 0], 'redo restores the transform');
  t.eq(t.mad(t.bytes(l.canvas), bScaled), 0, 'and the pixels are byte-identical to before the undos');

  // One more undo/redo pair after re-resolving, to be sure the payload is not
  // shared with the snapshot it came from.
  doc.history.undo();
  setSmartTransform(doc, doc.findLayer(id), scaleMatrix(0.25));
  t.notOk(doc.history.canRedo, 'editing after an undo drops the redo tail');
  doc.history.undo();
  t.eq(m6(getSmartTransform(doc.findLayer(id))), [1, 0, 0, 1, 0, 0],
    'the older snapshot still holds its own transform (payloads are never mutated in place)');
});

suite('smart / a duplicate is fully independent', async (t) => {
  const { doc, smart } = smartFromDetail(t, 120, 'sdup');
  const id = smart.id;
  addSmartFilter(doc, doc.findLayer(id), 'gaussian-blur', { radius: 4 });

  const copy = doc.duplicateLayer(doc.findLayer(id));
  doc.commit('Duplicate Layer');
  const copyId = copy.id;
  t.eq(copy.type, LayerType.SMART, 'the duplicate is still a Smart Object');
  t.ne(copyId, id, 'the duplicate has its own layer id');
  t.ok(copy.smart.source instanceof PikaDocument, 'the duplicate has a source document');
  t.notOk(copy.smart.source === doc.findLayer(id).smart.source, 'it is NOT the same source object');
  t.notOk(copy.smart.filters === doc.findLayer(id).smart.filters, 'and NOT the same filters array');
  t.eq(t.mad(t.bytes(copy.canvas), t.bytes(doc.findLayer(id).canvas)), 0,
    'the duplicate renders identically to start with');

  const origRender = t.bytes(doc.findLayer(id).canvas);
  const copyRender = t.bytes(copy.canvas);
  const origSource = t.bytes(doc.findLayer(id).smart.source.layers[0].canvas);
  const copySource = t.bytes(copy.smart.source.layers[0].canvas);

  // --- direction 1: filter the copy ---
  addSmartFilter(doc, doc.findLayer(copyId), 'mosaic', { cellSize: 10 });
  t.eq(getSmartFilters(doc.findLayer(copyId)).length, 2, 'the copy now has two filters');
  t.eq(getSmartFilters(doc.findLayer(id)).length, 1, 'the original still has one');
  t.gt(t.mad(t.bytes(doc.findLayer(copyId).canvas), copyRender), 2, 'the copy re-rendered');
  t.eq(t.mad(t.bytes(doc.findLayer(id).canvas), origRender), 0, 'the original render did not move');

  // --- direction 2: paint into the copy's embedded source ---
  const copySrc = doc.findLayer(copyId).smart.source;
  const copySrcLayer = copySrc.layers[0];
  copySrc.beginEdit(copySrcLayer);
  t.fill(copySrcLayer, '#ff00ff');
  copySrc.commit('Paint contents');
  renderSmartObject(doc.findLayer(copyId), doc);
  t.eq(t.px(doc.findLayer(copyId).smart.source.layers[0].canvas, 60, 60), '255,0,255,255',
    'the copy\'s embedded pixels changed');
  t.eq(t.mad(t.bytes(doc.findLayer(id).smart.source.layers[0].canvas), origSource), 0,
    'the original\'s embedded pixels are untouched');
  t.eq(t.mad(t.bytes(doc.findLayer(id).canvas), origRender), 0, 'and its render is untouched');

  // --- direction 3: and the other way round ---
  const origSrc = doc.findLayer(id).smart.source;
  const origSrcLayer = origSrc.layers[0];
  origSrc.beginEdit(origSrcLayer);
  t.fill(origSrcLayer, '#00ffff');
  origSrc.commit('Paint contents');
  renderSmartObject(doc.findLayer(id), doc);
  t.eq(t.px(doc.findLayer(id).smart.source.layers[0].canvas, 60, 60), '0,255,255,255',
    'the original\'s embedded pixels changed');
  t.eq(t.px(doc.findLayer(copyId).smart.source.layers[0].canvas, 60, 60), '255,0,255,255',
    'the copy\'s embedded pixels kept their own value');
  t.gt(t.mad(t.bytes(doc.findLayer(copyId).smart.source.layers[0].canvas), copySource), 20,
    'precondition: the copy\'s source really had been changed away from the shared original');
});

suite('smart / editing the embedded source is picked up', async (t) => {
  const { doc, smart } = smartFromDetail(t, 120, 'scontents');
  const id = smart.id;
  const before = t.bytes(smart.canvas);

  const src = smart.smart.source;
  const srcLayer = src.layers[0];
  const historyBefore = src.history.index;

  src.beginEdit(srcLayer);
  const c = ctx2d(srcLayer.canvas);
  c.fillStyle = '#ff0000';
  c.fillRect(0, 0, 60, 120);
  src.commit('Paint inside the Smart Object');
  t.gt(src.history.index, historyBefore, 'the embedded document recorded its own history step');

  // No explicit cache invalidation: the render cache key folds in the source
  // document's history position, so a committed edit there is enough.
  renderSmartObject(doc.findLayer(id), doc);
  t.eq(t.px(doc.findLayer(id).canvas, 30, 60), '255,0,0,255',
    'the re-render picks up an edit made straight to the embedded source');
  t.gt(t.mad(t.bytes(doc.findLayer(id).canvas), before), 20, 'the render genuinely changed');

  // Scaling now resamples the *edited* source, not a stale cache.
  setSmartTransform(doc, doc.findLayer(id), scaleMatrix(0.5));
  const half = t.bytes(doc.findLayer(id).canvas);
  setSmartTransform(doc, doc.findLayer(id), IDENTITY_MATRIX.slice());
  t.gt(t.mad(half, t.bytes(doc.findLayer(id).canvas)), 20, 'precondition: the 50% render differs');
  t.eq(t.px(doc.findLayer(id).canvas, 30, 60), '255,0,0,255', 'and the edit survives a scale round trip');
});

suite('smart / free transform is non-destructive on a smart layer', async (t) => {
  const { doc, smart, original } = smartFromDetail(t, 200, 'sfree');
  const id = smart.id;
  doc.setActiveLayer(id);

  // --- shrink to 10% through the real free-transform session ---
  const s1 = startTransform(doc, { layers: [doc.findLayer(id)] });
  t.ok(s1, 'startTransform opens a session on the smart layer');
  t.eq([s1.bounds.x, s1.bounds.y, s1.bounds.width, s1.bounds.height], [0, 0, 200, 200],
    'the session bounds are the opaque content bounds');
  t.ok(s1.baseSmart && s1.baseSmart[0], 'the session captured the layer\'s base matrix (matrix composition path)');
  setTransformNumeric({ width: 10, height: 10 });
  t.ok(commitTransform(), 'commitTransform bakes the session');

  const l1 = doc.findLayer(id);
  t.eq(l1.type, LayerType.SMART, 'the layer is still a Smart Object after Free Transform');
  t.eq(m6(getSmartTransform(l1)), [0.1, 0, 0, 0.1, 90, 90],
    'Free Transform composed a matrix instead of resampling (scale 0.1 about the centre)');
  const shrunk = t.bytes(l1.canvas);
  t.gt(t.mad(shrunk, original), 20, `precondition: the 10% render differs from the original (mad ${t.mad(shrunk, original).toFixed(1)})`);
  t.eq(l1.contentBounds(), { x: 90, y: 90, width: 20, height: 20 }, 'the rendered content is the expected 20x20 box');

  // --- and back to 1000% ---
  const s2 = startTransform(doc, { layers: [doc.findLayer(id)] });
  t.ok(s2, 'a second session opens on the shrunken layer');
  setTransformNumeric({ width: 1000, height: 1000 });
  commitTransform();

  const l2 = doc.findLayer(id);
  t.eq(l2.type, LayerType.SMART, 'still a Smart Object after the second Free Transform');
  t.eq(m6(getSmartTransform(l2)), [1, 0, 0, 1, 0, 0], 'the two sessions composed back to the identity matrix');
  const back = t.bytes(l2.canvas);
  t.eq(t.mad(back, original), 0, `Free Transform 10% then 1000% restores the pixels exactly (mad ${t.mad(back, original)})`);

  // The control: the same two sessions on a RASTER layer resample twice and lose
  // the detail, which is what proves the assertion above is about the smart path.
  const docR = t.doc(200, 200, '#ffffff', 'sfree-raster');
  const raster = docR.activeLayer();
  docR.beginEdit(raster);
  t.detail(raster);
  docR.commit('Detail');
  const rasterOriginal = t.bytes(raster.canvas);
  docR.setActiveLayer(raster.id);
  startTransform(docR, { layers: [docR.findLayer(raster.id)] });
  setTransformNumeric({ width: 10, height: 10 });
  commitTransform();
  startTransform(docR, { layers: [docR.findLayer(raster.id)] });
  setTransformNumeric({ width: 1000, height: 1000 });
  commitTransform();
  const rasterMad = t.mad(t.bytes(docR.findLayer(raster.id).canvas), rasterOriginal);
  t.gt(rasterMad, 8, `the same trip on a raster layer degrades badly (mad ${rasterMad.toFixed(1)})`);
  t.gt(rasterMad, 8 + t.mad(back, original), 'so the smart layer is measurably better, not accidentally equal');
});

suite('smart / rasterize bakes the render and drops the payload', async (t) => {
  const { doc, smart } = smartFromDetail(t, 120, 'sraster');
  const id = smart.id;
  addSmartFilter(doc, doc.findLayer(id), 'gaussian-blur', { radius: 5 });
  setSmartTransform(doc, doc.findLayer(id), scaleMatrix(0.6));
  const rendered = t.bytes(doc.findLayer(id).canvas);

  rasterizeLayer(doc, doc.findLayer(id));
  const l = doc.findLayer(id);
  t.eq(l.type, LayerType.RASTER, 'the layer became a plain raster layer');
  t.eq(l.smart, null, 'the smart payload is dropped');
  t.notOk(isSmartLayer(l), 'isSmartLayer now rejects it');
  t.notOk(l._smartCache, 'the render cache is dropped too');
  t.eq(t.mad(t.bytes(l.canvas), rendered), 0,
    'the baked pixels are byte-identical to the smart render (filters + transform included)');
  t.eq(doc.history.states[doc.history.index].label, 'Rasterize Layer', 'rasterizing is its own history step');

  // And after rasterizing, the smart API refuses to touch it.
  t.eq(setSmartTransform(doc, l, scaleMatrix(2)), null, 'setSmartTransform refuses a rasterized layer');
  t.eq(addSmartFilter(doc, l, 'gaussian-blur'), null, 'addSmartFilter refuses a rasterized layer');
  t.eq(t.mad(t.bytes(doc.findLayer(id).canvas), rendered), 0, 'and the pixels stayed put');
});

/* ------------------------------------------------------------------ */
/* Perspective and warp                                                */
/* ------------------------------------------------------------------ */

/**
 * The projective and warp halves of a smart transform.
 *
 * `getSmartMatrix3` composes the affine matrix with a separate projective row,
 * `H = A · P`, so perspective can be edited without disturbing scale or rotation
 * and vice versa. The warp is a 4x4 bicubic Bézier control grid in *source*
 * pixels, which is what lets it survive a later scale unchanged.
 *
 * The matrix helpers get exact assertions because everything above them inherits
 * their error, and the pixel assertions always check that clearing a shape gets
 * the original render back byte for byte — a "non-destructive" transform that
 * cannot be undone exactly is not one.
 */

suite('smart / the matrix helpers are exact', async (t) => {
  // decompose -> compose is the identity, on a matrix with every term active.
  // Both halves need the source size: the decomposition is around the source's
  // centre, so `centerX/centerY` are meaningless without it.
  const SW = 120, SH = 80;
  const cases = [
    [1, 0, 0, 1, 0, 0],
    [2, 0, 0, 3, 17, -5],
    [1.5, 0.7, -0.4, 2.2, 30, 40],
    [-1, 0, 0, 1, 12, 0],           // mirrored
    [0.3, 0.9, -0.9, 0.3, -8, 60],  // rotation + scale
  ];
  let worst = 0;
  for (const m of cases) {
    const round = composeMatrix(decomposeMatrix(m, SW, SH), SW, SH);
    for (let i = 0; i < 6; i++) worst = Math.max(worst, Math.abs(round[i] - m[i]));
  }
  t.lt(worst, 1e-9, `decompose -> compose reproduces every matrix (worst error ${worst.toExponential(2)})`);

  // toMatrix3 / fromMatrix3 round trip. fromMatrix3 splits the homography back
  // into `{matrix, perspective}` rather than returning a bare six-tuple.
  const affine = [1.5, 0.7, -0.4, 2.2, 30, 40];
  const flat = fromMatrix3(toMatrix3(affine, NO_PERSPECTIVE));
  t.eq(m6(flat.matrix), m6(affine), 'a matrix with no perspective survives the 3x3 detour unchanged');
  t.eq(m6(flat.perspective), [0, 0], 'and comes back with an empty projective row');

  const split = fromMatrix3(toMatrix3(affine, [0.001, -0.0004]));
  t.eq(m6(split.matrix), m6(affine), 'the affine part is recovered even with perspective present');
  t.eq(m6(split.perspective, 8), m6([0.001, -0.0004], 8), 'and the projective row with it');
  t.eq(fromMatrix3([1, 0, 0, 0, 1, 0, 0, 0, 0]), null, 'a degenerate homography is rejected rather than guessed at');

  // A 3x3 times its own inverse is the identity.
  const H = toMatrix3(affine, [0.001, -0.0004]);
  const I = matrix3Multiply(H, invertMatrix3(H));
  const expect = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let inv = 0;
  for (let i = 0; i < 9; i++) inv = Math.max(inv, Math.abs(I[i] / I[8] - expect[i]));
  t.lt(inv, 1e-9, `H · H⁻¹ is the identity (worst error ${inv.toExponential(2)})`);

  // unitSquareToQuad must land the four corners of the unit square on the quad.
  const quad = [{ x: 10, y: 20 }, { x: 190, y: 5 }, { x: 175, y: 120 }, { x: 25, y: 150 }];
  const M = unitSquareToQuad(quad);
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
  let qerr = 0;
  corners.forEach(([u, v], i) => {
    const p = applyMatrix3(M, u, v);
    qerr = Math.max(qerr, Math.abs(p.x - quad[i].x), Math.abs(p.y - quad[i].y));
  });
  t.lt(qerr, 1e-6, `unitSquareToQuad maps all four corners onto the quad (worst error ${qerr.toExponential(2)})`);

  // rectToQuad is the same thing for an arbitrary source rectangle.
  const box = { x: 5, y: 7, width: 80, height: 60 };
  const R = rectToQuad(box, quad);
  const boxCorners = [
    [box.x, box.y], [box.x + box.width, box.y],
    [box.x + box.width, box.y + box.height], [box.x, box.y + box.height],
  ];
  let rerr = 0;
  boxCorners.forEach(([x, y], i) => {
    const p = applyMatrix3(R, x, y);
    rerr = Math.max(rerr, Math.abs(p.x - quad[i].x), Math.abs(p.y - quad[i].y));
  });
  t.lt(rerr, 1e-6, `rectToQuad maps the rectangle's corners onto the quad (worst error ${rerr.toExponential(2)})`);
});

suite('smart / the warp grid starts neutral and interpolates', async (t) => {
  // identityWarp needs its size — called with no arguments it produces NaN, which
  // the validator correctly rejects, and which reads as "warp is broken".
  const w = identityWarp(120, 90);
  t.eq(w.length, 4, 'the grid has four rows');
  t.eq(w[0].length, 4, 'and four columns');
  t.ok(w.every((row) => row.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))),
    'every control point is a real number');
  t.eq([w[0][0].x, w[0][0].y], [0, 0], 'the top-left control point sits at the source origin');
  t.eq([w[3][3].x, w[3][3].y], [120, 90], 'and the bottom-right at the far corner');

  // An untouched grid must evaluate to the point it stands over.
  const probes = [[0, 0], [0.5, 0.5], [1, 1], [0.25, 0.75]];
  let worst = 0;
  for (const [u, v] of probes) {
    const p = evalWarp(w, u, v);
    worst = Math.max(worst, Math.abs(p.x - u * 120), Math.abs(p.y - v * 90));
  }
  t.lt(worst, 1e-6, `a neutral grid is the identity map (worst error ${worst.toExponential(2)})`);

  // Move one interior point and the surface should follow it, locally.
  const bent = identityWarp(120, 90);
  bent[1][1] = { x: bent[1][1].x, y: bent[1][1].y - 30 };
  const mid = evalWarp(bent, 1 / 3, 1 / 3);
  t.lt(mid.y, evalWarp(w, 1 / 3, 1 / 3).y - 1, 'dragging a control point pulls the surface with it');
  t.close(evalWarp(bent, 1, 1).y, 90, 1e-6, 'while the far corner stays exactly where it was');
});

suite('smart / perspective and warp are non-destructive', async (t) => {
  const { doc, smart } = smartFromDetail(t, 160, 'shape');
  const id = smart.id;
  const flat = t.bytes(doc.findLayer(id).canvas);
  t.notOk(hasSmartShape(doc.findLayer(id)), 'a fresh smart object has neither perspective nor warp');

  // --- perspective
  setSmartTransform(doc, doc.findLayer(id), getSmartTransform(doc.findLayer(id)), {
    perspective: [0.0012, -0.0008], label: 'Perspective',
  });
  const persp = doc.findLayer(id);
  t.eq(persp.type, LayerType.SMART, 'the layer is still a smart object afterwards');
  t.eq(m6(getSmartPerspective(persp)), m6([0.0012, -0.0008]), 'the projective row is stored as given');
  t.ok(hasSmartShape(persp), 'and the layer reports that it carries a shape');
  const withPersp = t.mad(t.bytes(persp.canvas), flat);
  t.gt(withPersp, 5, `the render really changed (mad ${withPersp.toFixed(1)})`);

  clearSmartShape(doc, doc.findLayer(id), { perspective: true, warp: false });
  t.eq(t.mad(t.bytes(doc.findLayer(id).canvas), flat), 0,
    'clearing the perspective restores the original render byte for byte');
  t.notOk(hasSmartShape(doc.findLayer(id)), 'and the layer no longer claims a shape');

  // --- warp
  const src = doc.findLayer(id).smart.source;
  const mesh = identityWarp(src.width, src.height);
  mesh[1][1] = { x: mesh[1][1].x + src.width * 0.25, y: mesh[1][1].y - src.height * 0.2 };
  mesh[2][2] = { x: mesh[2][2].x - src.width * 0.2, y: mesh[2][2].y + src.height * 0.25 };
  setSmartTransform(doc, doc.findLayer(id), getSmartTransform(doc.findLayer(id)), { warp: mesh, label: 'Warp' });

  const warped = doc.findLayer(id);
  t.ok(getSmartWarp(warped), 'the warp grid is stored');
  t.eq(warped.type, LayerType.SMART, 'and the layer is still a smart object');
  const withWarp = t.mad(t.bytes(warped.canvas), flat);
  t.gt(withWarp, 5, `the warp deforms the render (mad ${withWarp.toFixed(1)})`);

  // The warp lives in source pixels, so scaling down and back up must not
  // compound with it: the result has to match the warp at full size exactly.
  const before = t.bytes(doc.findLayer(id).canvas);
  setSmartTransform(doc, doc.findLayer(id), scaleMatrix(0.1));
  setSmartTransform(doc, doc.findLayer(id), scaleMatrix(1));
  t.eq(t.mad(t.bytes(doc.findLayer(id).canvas), before), 0,
    'scaling to 10% and back leaves the warped render byte-identical');

  clearSmartShape(doc, doc.findLayer(id), { perspective: true, warp: true });
  t.eq(getSmartWarp(doc.findLayer(id)), null, 'clearing drops the grid');
  t.eq(t.mad(t.bytes(doc.findLayer(id).canvas), flat), 0, 'and the original render comes back exactly');
});

suite('smart / Skew Y reads back as Skew Y', async (t) => {
  const { authoredParams } = await import('/src/core/smart.js');
  const { savePKD, loadPKD } = await import('/src/io/pkd.js');

  const doc = PikaDocument.blank(200, 120, 'skew', '#ffffff');
  const base = doc.layers[0];
  const layer = createSmartObject(doc, [base]);
  const { sourceWidth: w, sourceHeight: h } = layer.smart;

  const authored = {
    centerX: 100, centerY: 60, scaleX: 1, scaleY: 1, angle: 0,
    skewX: 0, skewY: (12 * Math.PI) / 180,
  };
  const m = composeMatrix(authored, w, h);
  layer.smart.authored = { ...authored };
  setSmartTransform(doc, layer, m, { commit: false });

  /*
   * An affine matrix has one shear degree of freedom, and centre, scale and
   * rotation spend the other five — so the decomposition can only ever put the
   * whole shear in Skew X. It is not a rounding loss: the matrix genuinely does
   * not record which field was typed into, which is why the authored pair has
   * to be remembered alongside it.
   */
  const canonical = decomposeMatrix(getSmartTransform(layer), w, h);
  t.eq(canonical.skewY, 0, 'the canonical decomposition still reports no Skew Y');
  t.ok(Math.abs(canonical.skewX) > 0.01, 'having folded the shear into Skew X');

  /*
   * Verified to fail by having authoredParams return null unconditionally: the
   * panel falls back to the canonical form and Skew Y reads 0 again, which is
   * exactly the behaviour this replaces.
   */
  const back = authoredParams(layer.smart, getSmartTransform(layer), w, h);
  t.ok(back, 'the authored parameters are recovered');
  t.ok(Math.abs(back.skewY - authored.skewY) < 1e-9, 'with Skew Y intact');
  t.eq(Math.round(back.skewX * 1e9), 0, 'and Skew X still zero, as authored');

  /*
   * The memo is checked against the matrix rather than trusted. Anything else
   * moving the layer — Free Transform, an undo, a script — makes it stale, and
   * a stale memo must not be believed: the authored pair really has stopped
   * describing the layer at that point.
   * Verified to fail by returning the memo without comparing it.
   */
  setSmartTransform(doc, layer, composeMatrix({ ...authored, angle: 0.4 }, w, h), { commit: false });
  t.eq(authoredParams(layer.smart, getSmartTransform(layer), w, h), null,
    'a matrix moved by something else discards the memo');

  // And it survives a save, because it is part of the smart payload.
  layer.smart.authored = { ...authored };
  setSmartTransform(doc, layer, m, { commit: false });
  const reopened = await loadPKD(await (await savePKD(doc)).arrayBuffer());
  const rl = reopened.flatLayers().find((l) => l.smart);
  const after = authoredParams(rl.smart, getSmartTransform(rl), rl.smart.sourceWidth, rl.smart.sourceHeight);
  t.ok(after && Math.abs(after.skewY - authored.skewY) < 1e-6, 'and survives a round trip through .pkd');
});
