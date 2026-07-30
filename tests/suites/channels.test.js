import { suite } from '../harness.js';
import {
  channelViewOf, isFullChannelView, setChannelView, applyChannelView,
  getViewComposite, getComposite, compositeDocument,
} from '/src/render/compositor.js';
import { createRasterLayer } from '/src/core/layer.js';
import { createCanvas, ctx2d, ctx2dRead, loadImage } from '/src/core/util.js';
import { exportDocument } from '/src/io/save.js';
import { flattenImage } from '/src/layers/ops.js';

/**
 * Per-channel viewing.
 *
 * Hiding a channel in the Channels panel is a *view* setting, exactly as it is
 * in Photoshop: the canvas shows one channel as grey, or the remaining channels
 * with the hidden one zeroed, and everything that consumes the document's real
 * pixels — Save, Export, Flatten, a filter's input — must be completely
 * unaffected. That asymmetry is the whole point of these tests, and it is easy
 * to break by putting the filter one layer too deep in the compositor.
 *
 * The state lives on the document rather than in a module global so two open
 * tabs remember their own channel view, and it is deliberately left out of
 * `captureState()` — undo should not restore which channels you were looking at.
 */

/* ------------------------------------------------------------------ */
/* Local helpers                                                       */
/* ------------------------------------------------------------------ */

/** A document whose single layer is a flat, unambiguous colour. */
function flatDoc(t, r = 200, g = 120, b = 40) {
  const doc = t.doc(40, 30, null, 'channels');
  doc.layers.length = 0;
  const layer = createRasterLayer(doc.width, doc.height, 'flat');
  const c = ctx2d(layer.canvas);
  c.fillStyle = `rgb(${r},${g},${b})`;
  c.fillRect(0, 0, doc.width, doc.height);
  doc.layers.push(layer);
  doc.invalidate();
  return doc;
}

/** The centre pixel of a canvas as an [r,g,b,a] array. */
function centre(canvas) {
  const d = ctx2dRead(canvas).getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

suite('channels / the view starts full and merges patches', async (t) => {
  const doc = flatDoc(t);
  const view = channelViewOf(doc);
  t.eq([view.r, view.g, view.b], [true, true, true], 'a new document shows all three channels');
  t.ok(isFullChannelView(view), 'and reports itself as a full view');

  t.ok(setChannelView(doc, { g: false }), 'hiding green reports a change, so the caller repaints');
  t.notOk(setChannelView(doc, { g: false }), 'hiding it again reports no change, so the caller does not');
  t.eq([channelViewOf(doc).r, channelViewOf(doc).g, channelViewOf(doc).b], [true, false, true],
    'and only the channel named in the patch moved');
  t.notOk(isFullChannelView(channelViewOf(doc)), 'the view is no longer full');

  // A partially-written object (say, one restored from an older session) must be
  // repaired rather than trusted.
  doc.channelView = { r: false };
  const fixed = channelViewOf(doc);
  t.eq([fixed.r, fixed.g, fixed.b], [false, true, true], 'a half-written view is completed with visible defaults');

  // Undo must not restore which channels you were looking at.
  const state = doc.captureState();
  t.notOk(Object.prototype.hasOwnProperty.call(state, 'channelView'),
    'the channel view is not part of the history state');
});

/* ------------------------------------------------------------------ */
/* What the canvas shows                                               */
/* ------------------------------------------------------------------ */

suite('channels / one channel alone shows as grey, two or more zero the rest', async (t) => {
  const doc = flatDoc(t, 200, 120, 40);
  t.eq(centre(getViewComposite(doc)), [200, 120, 40, 255], 'the full view is the document itself');

  setChannelView(doc, { g: false, b: false });
  t.eq(centre(getViewComposite(doc)), [200, 200, 200, 255], 'red alone is shown as its own greyscale');

  setChannelView(doc, { r: false, g: true, b: false });
  t.eq(centre(getViewComposite(doc)), [120, 120, 120, 255], 'green alone likewise');

  setChannelView(doc, { r: false, g: false, b: true });
  t.eq(centre(getViewComposite(doc)), [40, 40, 40, 255], 'and blue alone');

  setChannelView(doc, { r: true, g: true, b: false });
  t.eq(centre(getViewComposite(doc)), [200, 120, 0, 255], 'with two channels shown, the hidden one is zeroed rather than greyed');

  setChannelView(doc, { r: false, g: false, b: false });
  t.eq(centre(getViewComposite(doc)), [0, 0, 0, 255], 'hiding everything leaves black, not transparency');

  setChannelView(doc, { r: true, g: true, b: true });
  t.eq(centre(getViewComposite(doc)), [200, 120, 40, 255], 'and turning them all back on restores the document exactly');
});

suite('channels / applyChannelView only touches the context it is given', async (t) => {
  const cv = createCanvas(4, 4);
  const c = ctx2d(cv);
  c.fillStyle = 'rgb(200,120,40)';
  c.fillRect(0, 0, 4, 4);

  t.notOk(applyChannelView(c, { r: true, g: true, b: true }), 'a full view is a no-op and says so');
  t.eq(centre(cv), [200, 120, 40, 255], 'and leaves the pixels alone');

  t.ok(applyChannelView(c, { r: true, g: false, b: false }), 'a restricted view reports that it wrote');
  t.eq(centre(cv), [200, 200, 200, 255], 'and greys the surviving channel in place');
});

/* ------------------------------------------------------------------ */
/* Everything else must ignore it                                      */
/* ------------------------------------------------------------------ */

suite('channels / hiding a channel changes the view and nothing else', async (t) => {
  const doc = flatDoc(t, 200, 120, 40);
  setChannelView(doc, { g: false, b: false });   // looking at red alone
  t.eq(centre(getViewComposite(doc)), [200, 200, 200, 255], 'the canvas is showing the red channel');

  t.eq(centre(getComposite(doc)), [200, 120, 40, 255],
    'getComposite — what filters, effects and history read — is untouched');

  t.eq(centre(compositeDocument(doc)), [200, 120, 40, 255], 'compositeDocument returns the real colours');

  const blob = await exportDocument(doc, { format: 'png', save: false });
  const img = await loadImage(blob);
  const shot = createCanvas(img.naturalWidth || img.width, img.naturalHeight || img.height);
  ctx2d(shot).drawImage(img, 0, 0);
  t.eq(centre(shot), [200, 120, 40, 255], 'a PNG export contains the document, not the view');

  flattenImage(doc);
  t.eq(centre(doc.layers[0].canvas), [200, 120, 40, 255], 'and flattening bakes the real colours too');
  t.eq([channelViewOf(doc).r, channelViewOf(doc).g, channelViewOf(doc).b], [true, false, false],
    'while the view setting itself survives the flatten');
});

suite('channels / the view composite is cached but never stale', async (t) => {
  const doc = flatDoc(t, 200, 120, 40);
  setChannelView(doc, { g: false, b: false });
  const first = getViewComposite(doc);
  t.is(getViewComposite(doc), first, 'asking twice with nothing changed returns the same canvas');

  setChannelView(doc, { r: true, g: true, b: false });
  const second = getViewComposite(doc);
  t.isNot(second, first, 'changing which channels are shown produces a new one');
  t.eq(centre(second), [200, 120, 0, 255], 'with the new channels applied');

  // Now change the pixels underneath: the cache keys on the composite it was
  // built from, so a repaint has to invalidate it.
  const c = ctx2d(doc.layers[0].canvas);
  c.fillStyle = 'rgb(10,20,30)';
  c.fillRect(0, 0, doc.width, doc.height);
  doc.invalidate();
  t.eq(centre(getViewComposite(doc)), [10, 20, 0, 255], 'editing the document refreshes the channel view');
});
