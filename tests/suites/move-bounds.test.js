import { suite } from '../harness.js';
import { createRasterLayer } from '/src/core/layer.js';
import { compositeDocument } from '/src/render/compositor.js';
import { nudgeLayers, alignLayers } from '/src/tools/move.js';
import { layerBounds } from '/src/core/layer-bounds.js';
import { savePKD, loadPKD } from '/src/io/pkd.js';
import { writePSD } from '/src/io/psd-write.js';
import { readPSD } from '/src/io/psd-read.js';
import { isEnabled } from '/src/commands/registry.js';
import { canFade } from '/src/commands/image-ops.js';
import { historySourceCanvasFor } from '/src/tools/history-brush.js';
import { fillSelection } from '/src/edit/fill-stroke.js';
import { copy } from '/src/edit/clipboard.js';
import { showApplyImageDialog, showCalculationsDialog } from '/src/commands/image-ops.js';
import { showFillDialog, showStrokeDialog, definePattern } from '/src/edit/fill-stroke.js';
import { sampleColor } from '/src/tools/eyedropper.js';
import { exportSVG } from '/src/io/svg.js';
import { currentHistogram } from '/src/ui/histogram.js';
import { operableSurface } from '/src/filters/run.js';

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

// Emulate a version-1 reader by removing only the optional tile extensions.
// Keep the real writer, binary payload and reader in the compatibility check.
async function withoutTileExtensions(blob) {
  const buffer = await blob.arrayBuffer();
  const size = new DataView(buffer).getUint32(8, true);
  const manifest = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, size)));
  const strip = (layers) => {
    for (const layer of layers) {
      delete layer.tile; delete layer.maskTile;
      if (layer.children) strip(layer.children);
    }
  };
  strip(manifest.layers);
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  const header = new Uint8Array(buffer.slice(0, 12));
  new DataView(header.buffer).setUint32(8, json.length, true);
  return new Blob([header, json, buffer.slice(12 + size)]).arrayBuffer();
}

// Verified before the compatibility fixes: opening Edit or copying reads the
// destructive canvas getter, so the round trip differs by 47.8125, not zero.
suite('move / menus and copying never consume off-canvas pixels', async (t) => {
  for (const operation of ['menu', 'copy']) {
    const f = fixture(t);
    try {
      const before = f.shot();
      f.drag(20, 0);
      const tile = f.layer.tile;
      if (operation === 'menu') {
        const menu = [...document.querySelectorAll('.pk-menu-btn')].find(b => b.textContent === 'Edit');
        menu.click();
        t.ok(isEnabled('edit.copy'), 'the real Edit menu enables Copy');
        menu.click();
        canFade(f.doc);
      } else await copy(f.doc);
      t.is(f.layer.tile, tile, `${operation} leaves the source tile intact`);
      f.drag(-20, 0);
      t.eq(t.mad(f.shot(), before), 0, `${operation} preserves every off-canvas pixel`);
    } finally { f.cleanup(); }
  }
});

// Previously a moved snapshot had canvas/mask = null, so both history brushes
// rejected it and Fill from History could not restore its pixels.
suite('move / tile snapshots remain usable by history painting and fills', async (t) => {
  const f = fixture(t);
  try {
    f.layer.addMask(32, 32);
    nudgeLayers(f.doc, 1, 0);
    f.doc.historyBrushSource = f.doc.history.index;
    const source = historySourceCanvasFor(f.doc, f.layer, { warn: false });
    t.ok(source, 'history brush reads a moved layer snapshot');
    if (source) t.pixel(source, 5, 4, '255,0,0,255', 'the history source honours the pixel offset');
    f.layer.editingMask = true;
    const mask = historySourceCanvasFor(f.doc, f.layer, { warn: false });
    t.ok(mask, 'history brush reads a moved mask snapshot');
    if (mask) t.pixel(mask, 5, 4, '255,255,255,255', 'the history mask honours its offset');
    f.layer.editingMask = false;
    f.doc.history.clear('Moved source');
    f.doc.beginEdit(f.layer, { surface: 'canvas' });
    t.fill(f.layer, '#0000ff'); f.doc.commit('Blue');
    fillSelection(f.doc, { use: 'history' });
    t.pixel(f.layer.canvas, 5, 4, '255,0,0,255', 'Fill from History restores pixels from the tile snapshot');
    t.pixel(f.layer.canvas, 0, 0, '0,0,255,255', 'transparent history pixels leave existing paint intact');
  } finally { f.cleanup(); }
});

// Previously both tools changed the materialised mask but saved its stale tile.
// Save/reopen and the next beginEdit each lost the visible gradient/bucket fill.
suite('move / gradient and bucket edits replace the moved mask source', async (t) => {
  const foreground = t.app.foreground;
  try {
    t.app.foreground = { r: 0, g: 0, b: 0, a: 1 };
    for (const id of ['gradient', 'bucket']) {
      const f = fixture(t);
      let tool, state;
      try {
        f.layer.addMask(32, 32); nudgeLayers(f.doc, 1, 0);
        f.layer.editingMask = true;
        const before = new Uint8ClampedArray(t.bytes(f.layer.mask));
        t.app.setTool(id); tool = t.app.tool; state = { ...tool.state };
        Object.assign(tool.state, { preset: 'black-to-white', type: 'linear', opacity: 100,
          mode: 'normal', dither: false, reverse: false, fill: 'foreground',
          tolerance: 255, contiguous: false, antialias: false, allLayers: false });
        tool.onPointerDown({ x: 0, y: 16 });
        if (id === 'gradient') { tool.onPointerMove({ x: 31, y: 16 }); tool.onPointerUp(); }
        const painted = new Uint8ClampedArray(t.bytes(f.layer.mask));
        t.gt(t.mad(painted, before), 0, `${id} really changes the mask`);
        const blob = await savePKD(f.doc);
        const restored = await loadPKD(await blob.arrayBuffer());
        const mask = restored.flatLayers().find(l => l.name === f.layer.name).mask;
        t.eq(t.mad(t.bytes(mask), painted), 0, `${id} survives PKD save and reopen`);
        f.doc.history.undo(); f.doc.history.redo();
        const active = f.doc.activeLayer();
        t.eq(t.mad(t.bytes(active.mask), painted), 0, `${id} survives undo and redo`);
        f.doc.beginEdit(active, { surface: 'mask' });
        t.eq(t.mad(t.bytes(active.mask), painted), 0, `${id} survives the next edit`);
      } finally {
        if (tool) { tool.cancel(); Object.assign(tool.state, state); }
        t.app.setTool('move'); f.cleanup();
      }
    }
  } finally { t.app.foreground = foreground; }
});

suite('move / PKD files retain a readable version-1 layer and mask', async (t) => {
  const f = fixture(t);
  try {
    f.layer.addMask(32, 32); nudgeLayers(f.doc, 1, 0);
    const expected = f.shot();
    const tile = f.layer.tile, maskTile = f.layer.maskTile;
    const blob = await savePKD(f.doc);
    const restored = await loadPKD(await withoutTileExtensions(blob));
    const layer = restored.flatLayers().find(l => l.name === f.layer.name);
    t.ok(layer.pixelKey(), 'a reader without tile support still gets the layer pixels');
    t.ok(layer.mask, 'a reader without tile support still gets the mask');
    t.eq(t.mad(t.bytes(compositeDocument(restored)), expected), 0, 'the legacy view preserves visible pixels and masking');
    t.is(f.layer.tile, tile, 'saving compatibility pixels leaves the original tile intact');
    t.is(f.layer.maskTile, maskTile, 'saving compatibility masks leaves the original tile intact');
  } finally { f.cleanup(); }
});

suite('move / sampling, selection, export and cancelled dialogs preserve the source', async (t) => {
  const dialogs = [showApplyImageDialog, showCalculationsDialog, showFillDialog, showStrokeDialog, definePattern];
  const readers = [
    () => {
      const color = sampleColor(t.app.activeDoc, 26, 10, 1, 'layer');
      t.eq(color, { r: 255, g: 0, b: 0, a: 1 }, 'layer sampling honours the tile offset');
      const edge = sampleColor(t.app.activeDoc, 24, 4, 3, 'layer');
      t.close(edge.a, 4 / 9, 1e-12, 'averaging retains transparent neighbours at tile edges');
    },
    () => exportSVG(t.app.activeDoc),
    () => currentHistogram(),
    () => operableSurface(t.app.activeDoc, t.app.activeDoc.activeLayer()),
    () => {
      t.app.setTool('wand');
      t.app.tool.onPointerDown({ x: 26, y: 10 });
      t.app.activeDoc.selection.clear();
    },
  ];
  for (const operation of [...readers, ...dialogs]) {
    const f = fixture(t);
    try {
      const before = f.shot(); f.drag(20, 0);
      const tile = f.layer.tile;
      if (dialogs.includes(operation)) {
        const pending = operation(f.doc);
        const cancel = [...document.querySelectorAll('.pk-dialog button')].find(b => b.textContent === 'Cancel');
        t.ok(cancel, `${operation.name} opens its real dialog`);
        cancel.click(); await pending;
      } else operation();
      t.is(f.layer.tile, tile, `${operation.name || 'reader'} leaves the source tile intact`);
      t.app.setTool('move'); f.drag(-20, 0);
      t.eq(t.mad(f.shot(), before), 0, 'the layer moves back with every pixel intact');
    } finally { t.app.setTool('move'); f.cleanup(); }
  }
  for (const label of ['Layer', 'Select', 'Image', 'Filter']) {
    const f = fixture(t);
    try {
      const before = f.shot(); f.drag(20, 0);
      const menu = [...document.querySelectorAll('.pk-menu-btn')].find(b => b.textContent === label);
      menu.click(); menu.click();
      f.drag(-20, 0);
      t.eq(t.mad(f.shot(), before), 0, `${label} menu does not consume off-canvas pixels`);
    } finally { f.cleanup(); }
  }
});

suite('move / cancelling a mask gradient restores its complete off-canvas source', async (t) => {
  const f = fixture(t);
  try {
    f.layer.addMask(32, 32);
    const before = f.shot(); f.drag(20, 0);
    f.layer.editingMask = true;
    t.app.setTool('gradient');
    const tool = t.app.tool, state = { ...tool.state };
    try {
      Object.assign(tool.state, { preset: 'black-to-white', type: 'linear', opacity: 100, mode: 'normal', dither: false });
      tool.onPointerDown({ x: 0, y: 16 }); tool.onPointerMove({ x: 31, y: 16 });
      tool.cancel();
      t.ok(f.layer.maskTile, 'cancelling restores the complete mask tile');
      f.layer.editingMask = false;
      t.app.setTool('move'); f.drag(-20, 0);
      t.eq(t.mad(f.shot(), before), 0, 'cancelled preview does not discard off-canvas mask samples');
    } finally { tool.cancel(); Object.assign(tool.state, state); }
  } finally { t.app.setTool('move'); f.cleanup(); }
});

suite('move / the history memory budget counts pixel and mask tiles', async (t) => {
  const old = { enabled: t.app.autoPurgeHistory, limit: t.app.memoryLimitMB };
  const f = fixture(t);
  try {
    f.layer.addMask(32, 32);
    f.doc.history.clear('Initial');
    t.app.autoPurgeHistory = true; t.app.memoryLimitMB = 0.02;
    for (let i = 0; i < 12; i++) f.drag(1, 0);
    t.eq(f.doc.history.states.length, 5, 'tile snapshots trigger the existing minimum-five-state purge');
    t.ok(f.doc.history.canUndo, 'recent undo steps remain available');
  } finally {
    t.app.autoPurgeHistory = old.enabled; t.app.memoryLimitMB = old.limit; f.cleanup();
  }
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
