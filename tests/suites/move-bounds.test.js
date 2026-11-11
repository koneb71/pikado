import { suite } from '../harness.js';
import { createRasterLayer } from '/src/core/layer.js';
import { compositeDocument } from '/src/render/compositor.js';
import { nudgeLayers, alignLayers } from '/src/tools/move.js';
import { layerBounds } from '/src/core/layer-bounds.js';
import { savePKD, loadPKD } from '/src/io/pkd.js';
import { writePSD } from '/src/io/psd-write.js';
import { readPSD } from '/src/io/psd-read.js';

function fixture(t) {
  const doc = t.doc(32, 32, 'transparent');
  const layer = createRasterLayer(32, 32, 'Moving pixels');
  t.fill(layer, '#ff0000', 4, 4, 24, 24);
  doc.addLayer(layer);
  const app = t.app;
  app.setTool('move');
  const move = app.tool;
  const state = { ...move.state };
  Object.assign(move.state, { autoSelect: false, showTransform: false });
  const drag = (dx, dy, release = true) => {
    const e = { x: 8, y: 8, sx: 8, sy: 8, ctrlKey: true };
    move.onPointerDown(e);
    move.onPointerMove({ ...e, x: 8 + dx, y: 8 + dy });
    if (release) move.onPointerUp(e);
  };
  const shot = () => new Uint8ClampedArray(t.bytes(compositeDocument(doc)));
  return { doc, layer, move, drag, shot, cleanup() { move.cancel(); Object.assign(move.state, state); } };
}

// Verified against the unmodified Move tool: moving 20 px right and back has
// a mean byte difference of 47.8125 instead of 0. Rendering and history must
// not consume off-canvas pixels.
suite('move / whole layers survive moves beyond every canvas edge', async (t) => {
  const f = fixture(t);
  try {
    const before = f.shot();
    for (const [dx, dy] of [[20, 0], [-20, 0], [0, 20], [0, -20], [80, -80]]) {
      f.drag(dx, dy);
      f.shot();
      f.doc.activeLayer().thumbnail();
      f.doc.memoryUse();
      t.eq(layerBounds(f.doc.activeLayer())?.x, 4 + dx, `bounds follow horizontal displacement ${dx}`);
      t.eq(layerBounds(f.doc.activeLayer())?.y, 4 + dy, `bounds follow vertical displacement ${dy}`);
      f.drag(-dx, -dy);
      t.eq(t.mad(f.shot(), before), 0, `round trip ${dx},${dy} keeps every pixel`);
    }
    nudgeLayers(f.doc, 80, 0);
    f.shot();
    nudgeLayers(f.doc, -80, 0);
    t.eq(t.mad(f.shot(), before), 0, 'keyboard nudges keep pixels outside the document');
    f.drag(20, 0);
    alignLayers(f.doc, 'center-h');
    t.eq(t.mad(f.shot(), before), 0, 'alignment measures and moves the full layer');
    f.doc.history.clear('Initial');
    f.drag(-20, 0);
    f.doc.history.undo();
    t.eq(t.mad(f.shot(), before), 0, 'undo restores all pixels');
    f.doc.history.redo();
    f.drag(20, 0);
    t.eq(t.mad(f.shot(), before), 0, 'redo retains the off-canvas pixels');
    f.drag(80, -80, false);
    f.move.cancel();
    t.eq(t.mad(f.shot(), before), 0, 'cancelling restores the original position and pixels');
  } finally { f.cleanup(); }
});

suite('move / linked masks and layered files retain off-canvas pixels', async (t) => {
  const f = fixture(t);
  try {
    f.layer.addMask(32, 32);
    t.fill({ canvas: f.layer.mask }, '#000000', 4, 4, 5, 24);
    f.layer.touchMask();
    f.layer.blendMode = 'multiply';
    f.layer.fillOpacity = 0.7;
    f.doc.commit('Mask');
    const before = f.shot();
    f.drag(-20, 20);
    f.shot();
    f.drag(20, -20);
    t.eq(t.mad(f.shot(), before), 0, 'linked mask and blend settings survive a round trip');
    f.drag(80, -80);
    f.shot();
    const layer = f.doc.activeLayer();
    const tile = layer.tile, mask = layer.maskTile;
    for (const format of ['PKD', 'PSD']) {
      const blob = await (format === 'PKD' ? savePKD(f.doc) : writePSD(f.doc));
      t.is(layer.tile, tile, `${format} saving does not materialise the source pixels`);
      t.is(layer.maskTile, mask, `${format} saving does not materialise the source mask`);
      const restored = await (format === 'PKD'
        ? loadPKD(await blob.arrayBuffer())
        : readPSD(await blob.arrayBuffer(), { ignorePrivate: true }));
      const active = restored.flatLayers().find((l) => l.name === 'Moving pixels');
      t.app.addDocument(restored);
      try {
        restored.setActiveLayer(active.id);
        nudgeLayers(restored, -80, 80);
        const actual = t.bytes(compositeDocument(restored));
        // PSD quantises fill opacity to 8 bits.
        t.ok(actual.every((v, i) => Math.abs(v - before[i]) <= 1), `${format} restores the complete layer and mask`);
      } finally { t.app.closeDocument(restored); t.app.setActiveDoc(f.doc); }
    }
  } finally { f.cleanup(); }
});
