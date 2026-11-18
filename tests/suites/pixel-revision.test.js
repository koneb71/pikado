import { suite } from '../harness.js';
import { createRasterLayer } from '/src/core/layer.js';
import { bufferRevision } from '/src/core/pixel-revision.js';
import { createCanvas } from '/src/core/util.js';

/**
 * Pixel revisions (src/core/pixel-revision.js): what tells a cache that a
 * layer's pixels changed, given that a live stroke writes into the same buffer
 * on every frame. Each check names the line whose removal makes it fail.
 */

function twoLayers(t) {
  const doc = t.doc(60, 40, '#ffffff', 'revisions');
  const a = doc.addLayer(createRasterLayer(60, 40, 'A'));
  const b = doc.addLayer(createRasterLayer(60, 40, 'B'));
  t.fill(a, '#ff0000', 5, 5, 10, 10);
  t.fill(b, '#0000ff', 30, 5, 10, 10);
  doc.commit('setup');
  return { doc, a, b };
}

suite('pixel revision / edits bump, untouched layers do not', async (t) => {
  const { doc, a, b } = twoLayers(t);
  const frozen = a.pixelKey();
  const frozenRev = a.pixelRevision();

  doc.beginEdit(a);
  t.isNot(a.pixelKey(), frozen, 'beginEdit gives the layer a fresh buffer (copy-on-write)');
  t.gt(a.pixelRevision(), frozenRev, 'and the fresh buffer has a newer revision');            // Layer.beginEdit bump
  t.eq(bufferRevision(frozen), frozenRev, 'while the frozen buffer history holds keeps its own');

  const bRev = b.pixelRevision();
  let last = a.pixelRevision();
  let rose = 0;
  for (let i = 0; i < 5; i++) {
    a.canvas.getContext('2d').fillRect(i, 0, 1, 1);
    doc.touch('paint');
    if (a.pixelRevision() > last) rose++;
    last = a.pixelRevision();
  }
  t.eq(rose, 5, 'a layer mid-edit gets a new revision on every touch');                       // invalidate's _live bump
  t.eq(b.pixelRevision(), bRev, 'the layer nobody is editing keeps its revision through all of it');

  doc.commit('paint');
  const settled = a.pixelRevision();
  doc.touch('other');
  doc.touch('other');
  t.eq(a.pixelRevision(), settled, 'once committed, touches no longer bump it');             // History.record settles
});

suite('pixel revision / undo brings buffers back with their revisions', async (t) => {
  const { doc, a } = twoLayers(t);
  const before = { key: a.pixelKey(), rev: a.pixelRevision() };
  doc.beginEdit(a);
  a.canvas.getContext('2d').fillRect(0, 0, 3, 3);
  doc.commit('paint');
  const after = { key: a.pixelKey(), rev: a.pixelRevision() };
  t.gt(after.rev, before.rev, 'the edit produced a newer revision');

  doc.history.undo();
  const undone = doc.findLayer(a.id);
  t.is(undone.pixelKey(), before.key, 'undo restores the buffer from before the edit');
  t.eq(undone.pixelRevision(), before.rev, 'with the revision it had then — a cache built on it is still good');
  doc.history.redo();
  const redone = doc.findLayer(a.id);
  t.is(redone.pixelKey(), after.key, 'redo restores the edited buffer');
  t.eq(redone.pixelRevision(), after.rev, 'and its revision');
});

suite('pixel revision / moving a buffer is not changing it', async (t) => {
  const doc = t.doc(60, 40, '#ffffff', 'rev-move');
  const l = doc.addLayer(createRasterLayer(60, 40, 'L'));
  const tile = createCanvas(10, 10);
  tile.getContext('2d').fillRect(0, 0, 10, 10);
  l.setTile(tile, 5, 5, 60, 40);
  const r0 = l.pixelRevision();
  t.gt(r0, 0, 'a buffer handed to setTile is stamped');
  l.setTile(tile, 20, 7, 60, 40);
  t.eq(l.pixelRevision(), r0, 'the same buffer at a new offset keeps its revision');           // setTile's identity check
  const other = createCanvas(10, 10);
  l.setTile(other, 20, 7, 60, 40);
  t.gt(l.pixelRevision(), r0, 'a different buffer gets a new one');

  // A whole-layer drag edits with live: false, so its frames do not bump.
  doc.beginEdit(l, { live: false });
  const moving = l.pixelRevision();
  for (let i = 0; i < 4; i++) {
    l.setTile(l.pixelKey(), 20 + i, 7, 60, 40);
    doc.touch('move');
  }
  t.eq(l.pixelRevision(), moving, 'a layer moved with live: false keeps its revision for the whole drag');
});

suite('pixel revision / masks and ending an edit', async (t) => {
  const { doc, a } = twoLayers(t);
  a.addMask(60, 40);
  const m0 = a.maskRevision();
  t.gt(m0, 0, 'a new mask is stamped');
  a.mask.getContext('2d').fillRect(0, 0, 5, 5);
  a.touchMask();
  t.gt(a.maskRevision(), m0, 'touchMask bumps the mask revision');                             // touchMask bump

  doc.beginEdit(a);
  t.ok(a._live, 'beginEdit marks the layer live');
  doc.endEdit(a);
  t.eq(a._live, 0, 'endEdit stops treating it as live');
  const r = a.pixelRevision();
  doc.touch('x');
  t.eq(a.pixelRevision(), r, 'so touches stop bumping it');

  const before = a.pixelRevision();
  doc.invalidatePixels(a);
  t.gt(a.pixelRevision(), before, 'invalidatePixels bumps a layer written outside an edit');
});
