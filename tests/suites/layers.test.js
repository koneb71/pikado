import { suite } from '../harness.js';
import {
  addRasterLayer, nextLayerName, duplicateLayers, deleteLayers,
  groupLayers, ungroupLayers,
  mergeDown, mergeSelected, mergeVisible, flattenImage, stampVisible,
  addLayerMask, deleteLayerMask, applyLayerMask, toggleMaskEnabled,
  addAdjustmentLayer, toggleClipping, setLayerProps, rasterizeLayer,
  trimDocument, convertBackgroundToLayer, convertLayerToBackground,
} from '/src/layers/ops.js';
import { createRasterLayer, createGroupLayer, LayerType } from '/src/core/layer.js';
import { compositeDocument } from '/src/render/compositor.js';
import { Selection } from '/src/core/selection.js';
import { PaintStroke } from '/src/paint/brush-engine.js';
import { processSurface, commitSurface } from '/src/filters/run.js';
import { runFilter } from '/src/filters/registry.js';
import { applyAdjustment } from '/src/adjustments/registry.js';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** An independent copy of the document's composite bytes. */
function shot(t, doc) {
  return new Uint8ClampedArray(t.bytes(compositeDocument(doc)));
}

/** A dynamics-free brush, so a stroke is reproducible to the pixel. */
function brush(o) {
  return {
    size: 14, hardness: 1, opacity: 1, flow: 1, spacing: 0.2,
    smoothing: 0, pressureSize: false, pressureOpacity: false,
    sizeJitter: 0, opacityJitter: 0, scatter: 0, angleJitter: 0, airbrush: false,
    ...o,
  };
}

function addFilled(doc, name, color, x, y, w, h) {
  const l = createRasterLayer(doc.width, doc.height, name);
  const c = l.canvas.getContext('2d');
  c.fillStyle = color;
  c.fillRect(x, y, w, h);
  doc.addLayer(l);
  return l;
}

/* ------------------------------------------------------------------ */
/* Create / name / duplicate / delete                                  */
/* ------------------------------------------------------------------ */

suite('layers / add, name, duplicate, delete', async (t) => {
  const doc = t.doc(60, 60, '#ffffff', 'ops');
  t.eq(doc.layers.map((l) => l.name), ['Background'], 'precondition: a blank doc has just the Background');

  const a = addRasterLayer(doc);
  t.eq(a.name, 'Layer 1', 'addRasterLayer names the first layer "Layer 1"');
  t.eq(doc.layers.map((l) => l.name), ['Layer 1', 'Background'], 'it lands above the active layer');
  t.eq(doc.activeLayerId, a.id, 'and becomes active');
  t.eq(doc.history.labels().at(-1), 'New Layer', 'addRasterLayer records its own history entry');
  t.eq([a.canvas.width, a.canvas.height], [60, 60], 'the new buffer is document-sized');

  t.eq(nextLayerName(doc), 'Layer 2', 'nextLayerName skips the name already in use');
  const b = addRasterLayer(doc);
  const c = addRasterLayer(doc);
  t.eq([b.name, c.name], ['Layer 2', 'Layer 3'], 'consecutive layers never collide');
  // A gap in the middle must be reused rather than skipped past.
  doc.removeLayer(b);
  t.eq(nextLayerName(doc), 'Layer 2', 'a freed name is reused');
  const d = addRasterLayer(doc);
  t.eq(d.name, 'Layer 2', 'so the next layer takes it');
  t.eq(new Set(doc.flatLayers().map((l) => l.name)).size, doc.flatLayers().length,
    'no two layers in the document share a name');

  /* duplicateLayers */
  const src = doc.findLayer(a.id);
  t.fill(src, '#ff0000', 0, 0, 30, 30);
  const [copy] = duplicateLayers(doc, [src]);
  t.eq(copy.name, 'Layer 1 copy', 'a duplicate is named "<name> copy"');
  t.eq(t.px(copy.canvas, 10, 10), '255,0,0,255', 'the duplicate carries the pixels');
  t.ok(copy.canvas !== src.canvas, 'the duplicate owns its own buffer');
  t.eq(doc.locate(copy).index, doc.locate(src).index - 1, 'the copy sits directly above the original');
  t.eq(doc.selectedLayerIds, [copy.id], 'the copy becomes the selection');
  // Independence: editing the copy must not touch the original.
  t.fill(copy, '#00ff00', 0, 0, 30, 30);
  t.eq(t.px(src.canvas, 10, 10), '255,0,0,255', 'editing the copy leaves the original alone');

  /* deleteLayers */
  const n = doc.flatLayers().length;
  deleteLayers(doc, [copy]);
  t.eq(doc.flatLayers().length, n - 1, 'deleteLayers removes the layer');
  t.eq(doc.findLayer(copy.id), null, 'and it is gone from the tree');

  const all = doc.flatLayers();
  deleteLayers(doc, all);
  t.eq(doc.flatLayers().length, all.length, 'deleting every layer is refused');
  while (doc.flatLayers().length > 1) deleteLayers(doc, [doc.layers[0]]);
  const last = doc.layers[0];
  const idx = doc.history.index;
  deleteLayers(doc, [last]);
  t.eq(doc.layers.length, 1, 'the last remaining layer cannot be deleted');
  t.eq(doc.history.index, idx, 'a refused delete records no history entry');
});

/* ------------------------------------------------------------------ */
/* Grouping                                                            */
/* ------------------------------------------------------------------ */

suite('layers / group and ungroup preserve order and the composite', async (t) => {
  const doc = t.doc(100, 100, '#ffffff', 'group');
  const a = addFilled(doc, 'A', '#ff0000', 0, 0, 60, 60);
  const b = addFilled(doc, 'B', '#0000ff', 30, 30, 60, 60);
  t.eq(doc.layers.map((l) => l.name), ['B', 'A', 'Background'], 'precondition: B is above A');
  const before = shot(t, doc);
  t.eq(t.px(compositeDocument(doc), 40, 40), '0,0,255,255', 'precondition: B covers A where they overlap');

  // Passed in the "wrong" order on purpose: the group must use panel order.
  const g = groupLayers(doc, [a, b]);
  t.eq(g.type, LayerType.GROUP, 'groupLayers makes a group layer');
  t.eq(g.name, 'Group 1', 'the first group is named "Group 1"');
  t.eq(g.children.map((l) => l.name), ['B', 'A'], 'children keep their stacking order (top first)');
  t.ok(g.children.every((k) => k.parent === g), 'every child points at the group as its parent');
  t.eq(doc.layers.map((l) => l.name), ['Group 1', 'Background'], 'the group replaced them in the root list');
  t.eq(g.blendMode, 'pass-through', 'a fresh group passes through');
  t.close(t.mad(before, shot(t, doc)), 0, 0.01, 'grouping does not change a single composited pixel');

  const g2 = groupLayers(doc, [doc.findLayer(g.id)]);
  t.eq(g2.name, 'Group 2', 'group names do not collide');
  ungroupLayers(doc, g2);

  ungroupLayers(doc, doc.findLayer(g.id));
  t.eq(doc.layers.map((l) => l.name), ['B', 'A', 'Background'], 'ungroup restores the children in order');
  t.ok(doc.layers.every((l) => l.parent === null), 'ungrouped children lose their parent pointer');
  t.eq(doc.findLayer(g.id), null, 'the group itself is gone');
  t.close(t.mad(before, shot(t, doc)), 0, 0.01, 'and the composite is back to exactly where it started');
});

/* ------------------------------------------------------------------ */
/* Merging                                                             */
/* ------------------------------------------------------------------ */

suite('layers / mergeDown keeps the lower blend mode and the composite', async (t) => {
  const doc = t.doc(100, 100, '#ffffff', 'mergedown');
  // Lower layer with a NON-NORMAL blend mode: its mode has to survive onto the
  // merged result, otherwise the picture changes.
  const lower = addFilled(doc, 'Lower', '#0000ff', 10, 10, 50, 50);
  lower.blendMode = 'multiply';
  const upper = addFilled(doc, 'Upper', '#ff0000', 40, 40, 50, 50);
  t.eq(doc.layers.map((l) => l.name), ['Upper', 'Lower', 'Background'], 'precondition: stack order');
  const before = shot(t, doc);

  const merged = mergeDown(doc, doc.findLayer(upper.id));
  t.eq(merged.blendMode, 'multiply', "the lower layer's blend mode survives the merge");
  t.eq(merged.name, 'Lower', 'the merged layer keeps the lower layer name');
  t.eq(merged.opacity, 1, 'the merged layer is fully opaque');
  t.eq(doc.layers.map((l) => l.name), ['Lower', 'Background'], 'two layers became one');
  t.ok(doc.layers[1].isBackground, 'the merged layer landed at the right depth, above the Background');
  t.close(t.mad(before, shot(t, doc)), 0, 0.6, 'the visible result is preserved');

  // Merging into the Background keeps it the Background.
  const b2 = mergeDown(doc, doc.layers[0]);
  t.eq(b2.name, 'Background', 'merging into the Background keeps its name');
  t.ok(b2.isBackground, 'and its Background flag');

  // Nothing below, and groups, are refused.
  const idx = doc.history.index;
  mergeDown(doc, doc.layers[0]);
  t.eq(doc.history.index, idx, 'merging the bottom layer down is refused');
  const l = addRasterLayer(doc);
  groupLayers(doc, [l]);
  const above = addRasterLayer(doc);
  const idx2 = doc.history.index;
  mergeDown(doc, above);
  t.eq(doc.history.index, idx2, 'merging into a group is refused');
});

suite('layers / mergeSelected lands at the right depth', async (t) => {
  const doc = t.doc(100, 100, '#ffffff', 'mergesel');
  // Three non-overlapping layers so the merge cannot change the picture, with a
  // NON-selected layer sandwiched between the two that get merged.
  const c = addFilled(doc, 'C', '#0000ff', 70, 10, 20, 20);
  c.blendMode = 'multiply';
  const b = addFilled(doc, 'B', '#00ff00', 40, 10, 20, 20);
  const a = addFilled(doc, 'A', '#ff0000', 10, 10, 20, 20);
  t.eq(doc.layers.map((l) => l.name), ['A', 'B', 'C', 'Background'], 'precondition: stack order');
  const before = shot(t, doc);

  doc.selectedLayerIds = [a.id, c.id];
  const merged = mergeSelected(doc);
  t.eq(merged.name, 'A', 'the merged layer takes the top selected name');
  t.eq(merged.blendMode, 'multiply', "the bottom-most selected layer's blend mode survives");
  t.eq(doc.layers.map((l) => l.name), ['B', 'A', 'Background'],
    'the merge lands where the lowest selected layer was, NOT under the Background');
  t.ok(doc.layers[2].isBackground, 'the Background is still the bottom layer');
  t.close(t.mad(before, shot(t, doc)), 0, 0.6, 'the visible result is preserved');
  t.eq(t.px(compositeDocument(doc), 15, 15), '255,0,0,255', 'the top region still shows A');
  t.eq(t.px(compositeDocument(doc), 75, 15), '0,0,255,255', 'and the bottom region still shows C');

  // A single selected layer degrades to mergeDown.
  const one = doc.layers[0];
  doc.selectedLayerIds = [one.id];
  const n = doc.layers.length;
  mergeSelected(doc);
  t.eq(doc.layers.length, n - 1, 'mergeSelected with one layer selected merges it down');
});

suite('layers / mergeVisible and flattenImage', async (t) => {
  /* mergeVisible must not fall below a hidden layer that was underneath. */
  const doc = t.doc(60, 60, 'transparent', 'mergevis');
  const hidden = doc.activeLayer();
  hidden.name = 'Hidden';
  t.fill(hidden, '#ffff00');
  hidden.visible = false;
  const v1 = addFilled(doc, 'V1', '#ff0000', 0, 0, 30, 60);
  const v2 = addFilled(doc, 'V2', '#0000ff', 30, 0, 30, 60);
  t.eq(doc.layers.map((l) => l.name), ['V2', 'V1', 'Hidden'], 'precondition: the hidden layer is at the bottom');
  const before = shot(t, doc);
  t.eq(t.px(compositeDocument(doc), 10, 10), '255,0,0,255', 'precondition: the hidden layer is not visible');

  const m = mergeVisible(doc);
  t.eq(m.name, 'Merged', 'a merge of non-Background layers is called "Merged"');
  t.eq(doc.layers.map((l) => l.name), ['Merged', 'Hidden'], 'the hidden layer stays BELOW the merge result');
  t.notOk(doc.layers[1].visible, 'and stays hidden');
  t.close(t.mad(before, shot(t, doc)), 0, 0.01, 'mergeVisible preserves the visible result exactly');

  /* With a Background at the bottom the result stays the Background. */
  const doc2 = t.doc(60, 60, '#ffffff', 'mergevis2');
  addFilled(doc2, 'Top', '#ff0000', 0, 0, 30, 30);
  const before2 = shot(t, doc2);
  const m2 = mergeVisible(doc2);
  t.eq([m2.name, m2.isBackground], ['Background', true], 'merging onto the Background keeps it the Background');
  t.eq(doc2.layers.length, 1, 'everything collapsed into one layer');
  t.close(t.mad(before2, shot(t, doc2)), 0, 0.01, 'and the picture is unchanged');

  /* flattenImage composites onto white. */
  const doc3 = t.doc(60, 60, 'transparent', 'flatten');
  const base = doc3.activeLayer();
  t.fill(base, '#ff0000', 0, 0, 40, 40);
  const semi = addFilled(doc3, 'Semi', '#0000ff', 20, 20, 40, 40);
  semi.opacity = 0.5;
  const onWhite = document.createElement('canvas');
  onWhite.width = 60; onWhite.height = 60;
  const oc = onWhite.getContext('2d');
  oc.fillStyle = '#ffffff';
  oc.fillRect(0, 0, 60, 60);
  oc.drawImage(compositeDocument(doc3), 0, 0);
  t.eq(t.px(compositeDocument(doc3), 55, 55), '0,0,255,128', 'precondition: the composite has partial alpha');

  const flat = flattenImage(doc3);
  t.eq(doc3.layers.length, 1, 'flattenImage leaves exactly one layer');
  t.eq([flat.name, flat.isBackground], ['Background', true], 'and it is the Background');
  t.close(t.mad(t.bytes(onWhite), shot(t, doc3)), 0, 0.6,
    'the flattened pixels equal the old composite over white');
  t.eq(t.px(flat.canvas, 55, 5), '255,255,255,255', 'empty areas became white, not transparent');

  /* stampVisible keeps the originals. */
  const doc4 = t.doc(40, 40, '#ffffff', 'stamp');
  addFilled(doc4, 'S', '#ff0000', 0, 0, 20, 20);
  const n = doc4.layers.length;
  const st = stampVisible(doc4);
  t.eq(doc4.layers.length, n + 1, 'stampVisible adds a layer and keeps the originals');
  t.eq(t.px(st.canvas, 5, 5), '255,0,0,255', 'the stamp holds the flattened pixels');
});

/* ------------------------------------------------------------------ */
/* Masks                                                               */
/* ------------------------------------------------------------------ */

suite('layers / layer masks', async (t) => {
  const doc = t.doc(100, 100, '#ffffff', 'masks');

  const revealAll = addFilled(doc, 'reveal-all', '#ff0000', 0, 0, 100, 100);
  addLayerMask(doc, revealAll, 'reveal-all');
  t.eq([revealAll.mask.width, revealAll.mask.height], [100, 100], 'a mask is document-sized');
  t.eq(t.px(revealAll.mask, 50, 50), '255,255,255,255', 'reveal-all is a white mask');
  t.ok(revealAll.maskEnabled, 'a new mask is enabled');
  t.ok(revealAll.editingMask, 'and painting is switched to the mask');

  const idx = doc.history.index;
  addLayerMask(doc, revealAll, 'hide-all');
  t.eq(t.px(revealAll.mask, 50, 50), '255,255,255,255', 'a second mask is refused, the first survives');
  t.eq(doc.history.index, idx, 'and no history entry is recorded');

  const hideAll = addFilled(doc, 'hide-all', '#00ff00', 0, 0, 100, 100);
  addLayerMask(doc, hideAll, 'hide-all');
  t.eq(t.px(hideAll.mask, 50, 50), '0,0,0,255', 'hide-all is a black mask');
  t.eq(t.px(compositeDocument(doc), 50, 50), '255,0,0,255',
    'a hide-all mask really does hide the layer in the composite');

  toggleMaskEnabled(doc, hideAll);
  t.notOk(hideAll.maskEnabled, 'toggleMaskEnabled disables the mask');
  t.eq(t.px(compositeDocument(doc), 50, 50), '0,255,0,255', 'so the layer reappears');
  toggleMaskEnabled(doc, hideAll);
  t.ok(hideAll.maskEnabled, 'and toggles back on');
  t.eq(t.px(compositeDocument(doc), 50, 50), '255,0,0,255', 'hiding the layer again');
  hideAll.visible = false;

  /* selection-driven masks */
  doc.selection.combine(Selection.rectMask(0, 0, 50, 100, 100, 100), 'replace');
  const revealSel = addFilled(doc, 'reveal-sel', '#0000ff', 0, 0, 100, 100);
  addLayerMask(doc, revealSel, 'reveal-selection');
  t.eq(t.px(revealSel.mask, 25, 50), '255,255,255,255', 'reveal-selection is white inside the selection');
  t.eq(t.px(revealSel.mask, 75, 50), '0,0,0,255', 'and black outside it');
  revealSel.visible = false;

  const hideSel = addFilled(doc, 'hide-sel', '#0000ff', 0, 0, 100, 100);
  addLayerMask(doc, hideSel, 'hide-selection');
  t.eq(t.px(hideSel.mask, 25, 50), '0,0,0,255', 'hide-selection is black inside the selection');
  t.eq(t.px(hideSel.mask, 75, 50), '255,255,255,255', 'and white outside it');
  hideSel.visible = false;

  // With nothing selected the selection kinds degrade to reveal-all / hide-all.
  doc.selection.clear();
  t.notOk(doc.selection.active, 'precondition: the selection is gone');
  const noSelReveal = addFilled(doc, 'no-sel-reveal', '#0000ff', 0, 0, 100, 100);
  addLayerMask(doc, noSelReveal, 'reveal-selection');
  t.eq(t.px(noSelReveal.mask, 25, 50), '255,255,255,255', 'reveal-selection with no selection reveals all');
  noSelReveal.visible = false;
  const noSelHide = addFilled(doc, 'no-sel-hide', '#0000ff', 0, 0, 100, 100);
  addLayerMask(doc, noSelHide, 'hide-selection');
  t.eq(t.px(noSelHide.mask, 25, 50), '0,0,0,255', 'hide-selection with no selection hides all');
  noSelHide.visible = false;

  /* applyLayerMask bakes the mask into the pixels. */
  const apply = addFilled(doc, 'apply', '#ff00ff', 0, 0, 100, 100);
  addLayerMask(doc, apply, 'reveal-all');
  const mc = apply.mask.getContext('2d');
  mc.fillStyle = '#000000';
  mc.fillRect(50, 0, 50, 100);
  apply.touchMask();
  t.eq(t.px(apply.canvas, 75, 50), '255,0,255,255', 'precondition: the pixels are still there behind the mask');
  applyLayerMask(doc, apply);
  t.eq(apply.mask, null, 'applyLayerMask drops the mask');
  t.eq(t.px(apply.canvas, 75, 50), '0,0,0,0', 'the masked-out pixels are now genuinely transparent');
  t.eq(t.px(apply.canvas, 25, 50), '255,0,255,255', 'the revealed pixels are untouched');
  t.notOk(apply.editingMask, 'and mask-editing mode is off');

  /* deleteLayerMask throws the mask away without touching the pixels. */
  const del = addFilled(doc, 'delete', '#00ffff', 0, 0, 100, 100);
  addLayerMask(doc, del, 'hide-all');
  // x=25 because `apply` above was masked away on its right half.
  t.eq(t.px(compositeDocument(doc), 25, 50), '255,0,255,255', 'precondition: the hide-all mask hides it');
  deleteLayerMask(doc, del);
  t.eq(del.mask, null, 'deleteLayerMask removes the mask');
  t.eq(t.px(del.canvas, 50, 50), '0,255,255,255', 'the pixels survive');
  t.eq(t.px(compositeDocument(doc), 25, 50), '0,255,255,255', 'so the layer is visible again');
});

/* ------------------------------------------------------------------ */
/* Adjustment layers, clipping, rasterize, trim, background            */
/* ------------------------------------------------------------------ */

suite('layers / adjustment layers and clipping', async (t) => {
  const doc = t.doc(60, 60, '#ffffff', 'adj');
  t.eq(t.px(compositeDocument(doc), 30, 30), '255,255,255,255', 'precondition: a white document');

  const adj = addAdjustmentLayer(doc, 'invert');
  t.eq(adj.type, LayerType.ADJUSTMENT, 'addAdjustmentLayer makes an adjustment layer');
  t.eq(adj.adjustment.kind, 'invert', 'carrying its kind');
  t.ok(adj.mask, 'and a mask');
  t.eq(t.px(adj.mask, 30, 30), '255,255,255,255', 'a full-white mask when nothing is selected');
  t.eq(t.px(compositeDocument(doc), 30, 30), '0,0,0,255', 'invert turns the white document black');
  t.eq(doc.history.labels().at(-1), 'New invert Layer', 'it records a labelled history entry');

  doc.history.undo();
  t.eq(t.px(compositeDocument(doc), 30, 30), '255,255,255,255', 'undo removes the adjustment');
  doc.history.redo();

  // With a selection the adjustment is masked to it.
  const doc2 = t.doc(60, 60, '#ffffff', 'adj2');
  doc2.selection.combine(Selection.rectMask(0, 0, 30, 60, 60, 60), 'replace');
  addAdjustmentLayer(doc2, 'invert');
  t.eq(t.px(compositeDocument(doc2), 15, 30), '0,0,0,255', 'the adjustment applies inside the selection');
  t.eq(t.px(compositeDocument(doc2), 45, 30), '255,255,255,255', 'and not outside it');

  /* clipping */
  const doc3 = t.doc(60, 60, '#ffffff', 'clip');
  const base = addFilled(doc3, 'Base', '#ff0000', 0, 0, 30, 60);
  const top = addFilled(doc3, 'Top', '#0000ff', 0, 0, 60, 60);
  t.eq(t.px(compositeDocument(doc3), 45, 30), '0,0,255,255', 'precondition: the top layer covers everything');
  toggleClipping(doc3, top);
  t.ok(top.clipped, 'toggleClipping marks the layer clipped');
  t.eq(t.px(compositeDocument(doc3), 15, 30), '0,0,255,255', 'a clipped layer still shows over its base');
  t.eq(t.px(compositeDocument(doc3), 45, 30), '255,255,255,255', 'but is cut off outside the base alpha');
  toggleClipping(doc3, top);
  t.notOk(top.clipped, 'toggling again releases the clipping mask');

  const bottom = doc3.layers[doc3.layers.length - 1];
  const idx = doc3.history.index;
  toggleClipping(doc3, bottom);
  t.notOk(bottom.clipped, 'the bottom layer has nothing to clip to');
  t.eq(doc3.history.index, idx, 'and the refusal records no history');
});

suite('layers / rasterize, trim and the Background', async (t) => {
  /* rasterizeLayer on a group flattens it in place. */
  const doc = t.doc(80, 80, '#ffffff', 'raster');
  const a = addFilled(doc, 'A', '#ff0000', 0, 0, 40, 80);
  const b = addFilled(doc, 'B', '#0000ff', 20, 0, 40, 80);
  const g = groupLayers(doc, [a, b]);
  const before = shot(t, doc);
  t.eq(t.px(compositeDocument(doc), 30, 40), '0,0,255,255', 'precondition: B covers A inside the group');
  const flat = rasterizeLayer(doc, doc.findLayer(g.id));
  t.eq(flat.type, LayerType.RASTER, 'a rasterized group becomes a raster layer');
  t.eq(flat.name, 'Group 1', 'keeping the group name');
  t.eq(flat.blendMode, 'normal', 'pass-through becomes normal on the raster result');
  t.eq(flat.children, null, 'it has no children any more');
  t.close(t.mad(before, shot(t, doc)), 0, 0.6, 'rasterizing a group preserves the composite');

  const idx = doc.history.index;
  t.eq(rasterizeLayer(doc, flat), undefined, 'rasterizing a plain raster layer is a no-op');
  t.eq(doc.history.index, idx, 'and records no history');

  // A group whose OPACITY is not 1: flattenLayers() already bakes the group
  // opacity into the merged pixels, and rasterizeLayer then copies l.opacity
  // onto the new layer as well — so the result is drawn at opacity squared.
  const docO = t.doc(80, 80, '#ffffff', 'raster-opacity');
  const oa = addFilled(docO, 'A', '#000000', 0, 0, 80, 80);
  const go = groupLayers(docO, [oa]);
  go.opacity = 0.5;
  docO.commit('Group Opacity');
  const beforeO = shot(t, docO);
  const grey = t.px(compositeDocument(docO), 40, 40);
  t.close(Number(grey.split(',')[0]), 128, 2,
    'precondition: a 50% black group over white composites to mid grey');
  rasterizeLayer(docO, docO.findLayer(go.id));
  t.eq(t.px(compositeDocument(docO), 40, 40), grey,
    'rasterizing a 50%-opacity group must not apply that opacity twice');
  t.close(t.mad(beforeO, shot(t, docO)), 0, 0.6, 'rasterizing a group with opacity preserves the composite');

  /* trimDocument */
  const doc2 = t.doc(100, 100, 'transparent', 'trim');
  t.fill(doc2.activeLayer(), '#ff0000', 20, 30, 10, 10);
  trimDocument(doc2, 'transparent');
  t.eq([doc2.width, doc2.height], [10, 10], 'trim crops to the non-transparent bounds');
  t.eq(t.px(doc2.activeLayer().canvas, 0, 0), '255,0,0,255', 'the content moved to the origin');
  const idx2 = doc2.history.index;
  trimDocument(doc2, 'transparent');
  t.eq([doc2.width, doc2.height], [10, 10], 'trimming an already tight document does nothing');
  t.eq(doc2.history.index, idx2, 'and records no history');

  /* Background conversions */
  const doc3 = t.doc(50, 50, '#ffffff', 'bg');
  const bg = doc3.activeLayer();
  t.ok(bg.isBackground && bg.locked.position, 'precondition: the Background is position-locked');
  convertBackgroundToLayer(doc3, bg);
  t.notOk(bg.isBackground, 'convertBackgroundToLayer clears the flag');
  t.eq(bg.name, 'Layer 1', 'and renames it');
  t.notOk(bg.locked.position, 'and unlocks its position');

  const doc4 = t.doc(50, 50, 'transparent', 'bg2');
  const l = doc4.activeLayer();
  t.fill(l, '#ff0000', 0, 0, 25, 50);
  const above = addFilled(doc4, 'Above', '#0000ff', 0, 0, 10, 10);
  t.eq(t.px(l.canvas, 40, 25), '0,0,0,0', 'precondition: the layer is half transparent');
  convertLayerToBackground(doc4, l);
  t.ok(l.isBackground, 'convertLayerToBackground sets the flag');
  t.eq(l.name, 'Background', 'and the name');
  t.eq(t.px(l.canvas, 40, 25), '255,255,255,255', 'transparent pixels are filled with white');
  t.eq(t.px(l.canvas, 10, 25), '255,0,0,255', 'existing pixels survive');
  t.eq(doc4.layers.at(-1).id, l.id, 'the new Background moves to the bottom of the stack');
  t.eq(doc4.layers[0].id, above.id, 'the other layer stays on top');
});

/* ------------------------------------------------------------------ */
/* UNDO INTEGRITY SWEEP                                                */
/*                                                                     */
/* A long mixed sequence, recording the composite after every step.     */
/* Undo all the way back and redo all the way forward, comparing every  */
/* restored composite against what was recorded. A mismatch means the   */
/* operation named in the message mutated shared pixel buffers without  */
/* doc.beginEdit() — the snapshot then sees the NEW pixels.             */
/* ------------------------------------------------------------------ */

suite('layers / undo integrity sweep (20+ mixed operations)', async (t) => {
  const doc = t.doc(48, 48, '#ffffff', 'sweep');

  /**
   * Everything about the layer tree that undo must also restore — pixels alone
   * would let a structure-only step (grouping, a property change, a mask
   * toggle) pass vacuously.
   */
  function sig(d) {
    const one = (l) => ({
      id: l.id, type: l.type, name: l.name, visible: l.visible,
      opacity: l.opacity, fillOpacity: l.fillOpacity, blendMode: l.blendMode,
      clipped: l.clipped, isBackground: l.isBackground,
      mask: !!l.mask, maskEnabled: l.maskEnabled, editingMask: l.editingMask,
      adjustment: l.adjustment ? l.adjustment.kind : null,
      children: l.children ? l.children.map(one) : null,
    });
    return JSON.stringify({ w: d.width, h: d.height, active: d.activeLayerId, layers: d.layers.map(one) });
  }

  /** @type {{label:string, index:number, size:string, sig:string, bytes:Uint8ClampedArray}[]} */
  const steps = [];
  const skipped = [];

  function snap(label) {
    if (steps.length && doc.history.index === steps[steps.length - 1].index) {
      skipped.push(label);
      return;
    }
    steps.push({
      label,
      index: doc.history.index,
      size: `${doc.width}x${doc.height}`,
      sig: sig(doc),
      bytes: shot(t, doc),
    });
  }

  function paintOn(layer, color, x0, y0, x1, y1, size = 14) {
    doc.beginEdit(layer);
    const onMask = layer.editingMask && layer.mask;
    const s = new PaintStroke({
      doc, layer, target: layer.paintTarget(), color, brush: brush({ size }),
    });
    s.begin(x0, y0, 1);
    s.move(x1, y1, 1);
    s.end();
    s.flush();
    if (onMask) layer.touchMask();
    doc.commit('Paint');
  }

  function pixelOp(fn, label) {
    const layer = doc.activeLayer();
    commitSurface(doc, layer, processSurface(doc, layer, fn), label);
  }

  snap('start');

  paintOn(doc.activeLayer(), '#ff0000', 6, 6, 42, 42);
  snap('paint on the Background');

  addRasterLayer(doc);
  snap('addRasterLayer');

  paintOn(doc.activeLayer(), '#0000ff', 6, 42, 42, 6);
  snap('paint on the new layer');

  pixelOp((img, ctx) => runFilter('gaussian-blur', img, { radius: 3 }, ctx), 'Gaussian Blur');
  snap('gaussian-blur filter');

  pixelOp((img) => applyAdjustment('invert', img, {}), 'Invert');
  snap('invert adjustment');

  setLayerProps(doc, doc.activeLayer(), { opacity: 0.5 }, 'Layer Opacity');
  snap('setLayerProps opacity');

  setLayerProps(doc, doc.activeLayer(), { blendMode: 'multiply' }, 'Blend Mode');
  snap('setLayerProps blendMode');

  duplicateLayers(doc, [doc.activeLayer()]);
  snap('duplicateLayers');

  addLayerMask(doc, doc.activeLayer(), 'hide-all');
  snap('addLayerMask hide-all');

  paintOn(doc.activeLayer(), '#ffffff', 10, 24, 38, 24, 18);
  snap('paint on the layer mask');

  toggleMaskEnabled(doc, doc.activeLayer());
  snap('toggleMaskEnabled off');

  toggleMaskEnabled(doc, doc.activeLayer());
  snap('toggleMaskEnabled on');

  applyLayerMask(doc, doc.activeLayer());
  snap('applyLayerMask');

  addAdjustmentLayer(doc, 'brightness-contrast', { brightness: 40, contrast: 0 });
  snap('addAdjustmentLayer');

  addRasterLayer(doc);
  snap('addRasterLayer (second)');

  paintOn(doc.activeLayer(), '#00ff00', 24, 6, 24, 42);
  snap('paint on the second new layer');

  const grouped = groupLayers(doc, [doc.layers[0], doc.layers[1]]);
  snap('groupLayers');

  ungroupLayers(doc, doc.findLayer(grouped.id));
  snap('ungroupLayers');

  const solo = groupLayers(doc, [doc.layers[0]]);
  snap('groupLayers (single layer)');

  rasterizeLayer(doc, doc.findLayer(solo.id));
  snap('rasterizeLayer on a group');

  const doomed = addRasterLayer(doc);
  snap('addRasterLayer (to be deleted)');

  deleteLayers(doc, [doc.findLayer(doomed.id)]);
  snap('deleteLayers');

  toggleClipping(doc, doc.layers[1]);
  snap('toggleClipping on');

  toggleClipping(doc, doc.layers[1]);
  snap('toggleClipping off');

  mergeDown(doc, doc.layers[doc.layers.length - 2]);
  snap('mergeDown into the Background');

  doc.selectedLayerIds = [doc.layers[0].id, doc.layers[2].id];
  mergeSelected(doc);
  snap('mergeSelected across a sandwiched layer');

  mergeVisible(doc);
  snap('mergeVisible');

  flattenImage(doc);
  snap('flattenImage');

  convertBackgroundToLayer(doc, doc.activeLayer());
  snap('convertBackgroundToLayer');

  // Erase the top rows with square dabs on exact integer offsets, so the alpha
  // there is exactly 0 and the following trim has something to bite on.
  {
    const layer = doc.activeLayer();
    doc.beginEdit(layer);
    const s = new PaintStroke({
      doc, layer, target: layer.canvas, mode: 'erase',
      brush: brush({ size: 24, shape: 'square' }),
    });
    for (let x = -12; x <= 60; x += 12) s.stamp(x, 6, 1);
    s.flush();
    doc.commit('Erase Top Rows');
  }
  snap('erase the top rows');

  trimDocument(doc, 'transparent');
  snap('trimDocument (changes the document size)');

  /* --- the sequence itself has to have done what we think it did --- */
  t.eq(skipped, [], `every operation in the sweep recorded a history entry (skipped: ${skipped.join(', ') || 'none'})`);
  t.gt(steps.length, 25, `the sweep covers ${steps.length - 1} operations`);
  t.eq(steps.map((s) => s.index), steps.map((_, i) => i), 'each operation pushed exactly one history state');
  t.lt(doc.height, 48, 'precondition: the trim really did change the document size');
  // Every step must be observable in the pixels or in the tree, otherwise its
  // undo check below would pass no matter what.
  const invisible = steps.slice(1).filter((s, i) => {
    const prev = steps[i];
    return s.sig === prev.sig && s.size === prev.size && t.mad(prev.bytes, s.bytes) === 0;
  }).map((s) => s.label);
  t.eq(invisible, [], `precondition: every operation changed the composite or the tree (${invisible.join(', ') || 'all observable'})`);
  t.gt(steps.filter((s, i) => i > 0 && t.mad(steps[i - 1].bytes, s.bytes) > 0).length, 10,
    'and a good half of them changed pixels');

  /* --- undo all the way back --- */
  const undoFails = [];
  for (let i = steps.length - 1; i >= 1; i--) {
    t.ok(doc.history.undo(), `undo #${i} available ("${steps[i].label}")`);
    const want = steps[i - 1];
    const diff = `${doc.width}x${doc.height}` !== want.size ? Infinity : t.mad(want.bytes, shot(t, doc));
    if (!(diff <= 0.001)) undoFails.push(`#${i} "${steps[i].label}" (mad ${diff})`);
    if (sig(doc) !== want.sig) undoFails.push(`#${i} "${steps[i].label}" (layer tree)`);
    t.close(diff, 0, 0.001, `undo of #${i} "${steps[i].label}" restores the previous composite exactly`);
    t.eq(sig(doc), want.sig, `undo of #${i} "${steps[i].label}" restores the previous layer tree`);
  }
  t.eq(doc.history.index, 0, 'we are back at the first history state');
  t.eq(undoFails.length, 0,
    `FIRST BROKEN UNDO: ${undoFails[0] || 'none'} — that operation is missing its doc.beginEdit()`);

  /* --- and redo all the way forward --- */
  const redoFails = [];
  for (let i = 1; i < steps.length; i++) {
    t.ok(doc.history.redo(), `redo #${i} available ("${steps[i].label}")`);
    const want = steps[i];
    const diff = `${doc.width}x${doc.height}` !== want.size ? Infinity : t.mad(want.bytes, shot(t, doc));
    if (!(diff <= 0.001)) redoFails.push(`#${i} "${steps[i].label}" (mad ${diff})`);
    if (sig(doc) !== want.sig) redoFails.push(`#${i} "${steps[i].label}" (layer tree)`);
    t.close(diff, 0, 0.001, `redo of #${i} "${steps[i].label}" reproduces the composite exactly`);
  }
  t.eq(redoFails.length, 0, `FIRST BROKEN REDO: ${redoFails[0] || 'none'}`);
  t.notOk(doc.history.canRedo, 'the whole sequence has been replayed');
});
