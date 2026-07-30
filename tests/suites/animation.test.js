import { suite } from '../harness.js';
import {
  DEFAULT_DELAY, captureFrame, updateFrame, applyFrame, framesOf, hasAnimation,
  activeFrame, frameIndex, ensureTimeline, addFrame, removeFrame, moveFrame,
  setFrameDelay, framesFromLayers, tweenFrames, reverseFrames, clearTimeline,
} from '/src/core/animation.js';
import { encodeAnimatedGIF } from '/src/io/gif.js';
import { exportDocument } from '/src/io/save.js';
import { createRasterLayer } from '/src/core/layer.js';
import { compositeDocument } from '/src/render/compositor.js';
import { createCanvas, ctx2d, ctx2dRead } from '/src/core/util.js';

/**
 * Frame animation.
 *
 * A frame is a *record of layer state*, not a copy of the picture, so the tests
 * that matter are about that indirection holding up: a frame must apply to the
 * layers, an edit must write back into the frame being shown, one frame must not
 * contaminate another, and undo must restore the whole timeline.
 *
 * The GIF assertions decode the file back through the browser's own decoder
 * rather than trusting the bytes we wrote. A GIF that only *we* can read is not
 * an export — and the encoder has form here: the single-frame path once shipped
 * an LZW bug that produced files no decoder accepted.
 */

/* ------------------------------------------------------------------ */
/* Fixture                                                             */
/* ------------------------------------------------------------------ */

/** A document with a white background plus three flat colour layers. */
function threeColourDoc(t, w = 48, h = 32) {
  const doc = t.doc(w, h, '#ffffff', 'anim');
  for (const colour of ['#ff0000', '#00ff00', '#0000ff']) {
    const layer = createRasterLayer(w, h, colour);
    const c = ctx2d(layer.canvas);
    c.fillStyle = colour;
    c.fillRect(0, 0, w, h);
    doc.layers.unshift(layer);
  }
  doc.commit('Layers');
  return doc;
}

const centre = (canvas) => {
  const d = ctx2dRead(canvas).getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data;
  return [d[0], d[1], d[2]];
};

/* ------------------------------------------------------------------ */
/* The model                                                           */
/* ------------------------------------------------------------------ */

suite('animation / a timeline starts from the document as it stands', async (t) => {
  const doc = threeColourDoc(t);
  t.eq(framesOf(doc).length, 0, 'a new document has no timeline');
  t.notOk(hasAnimation(doc), 'and reports no animation');

  const shownBefore = t.bytes(compositeDocument(doc));
  ensureTimeline(doc);
  t.eq(framesOf(doc).length, 1, 'creating one makes a single frame');
  t.eq(activeFrame(doc).delay, DEFAULT_DELAY, 'with the default delay');
  t.eq(t.mad(t.bytes(compositeDocument(doc)), shownBefore), 0,
    'and creating a timeline never changes what you are looking at');

  // Calling it again must not add a second frame.
  ensureTimeline(doc);
  t.eq(framesOf(doc).length, 1, 'and it is idempotent');
});

suite('animation / frames record layer state, not pixels', async (t) => {
  const doc = threeColourDoc(t);
  ensureTimeline(doc);
  const first = activeFrame(doc);
  const top = doc.layers[0];

  const second = addFrame(doc);
  t.eq(framesOf(doc).length, 2, 'a new frame is added');
  t.eq(doc.activeFrameId, second.id, 'and selected');
  t.eq(JSON.stringify(second.state), JSON.stringify(first.state), 'copying the current frame\'s state');

  // Change the document, then write it back into the frame being shown.
  top.visible = false;
  updateFrame(doc, second);
  t.eq(second.state[top.id].visible, false, 'the frame picks up the change');
  t.eq(first.state[top.id].visible, true, 'and the other frame is untouched');

  applyFrame(doc, first);
  t.eq(top.visible, true, 'stepping back to the first frame restores its state');
  t.eq(doc.activeFrameId, first.id, 'and makes it the active frame');
  applyFrame(doc, second);
  t.eq(top.visible, false, 'and forward again');

  // A layer the frame has never seen must be left alone, not hidden: adding a
  // layer must not make it vanish from every existing frame.
  const fresh = createRasterLayer(doc.width, doc.height, 'new');
  doc.layers.unshift(fresh);
  fresh.visible = true;
  applyFrame(doc, first);
  t.eq(fresh.visible, true, 'a layer added after a frame was made stays visible in it');

  // Opacity travels too.
  top.opacity = 0.4;
  updateFrame(doc, activeFrame(doc));
  t.close(activeFrame(doc).state[top.id].opacity, 0.4, 1e-9, 'opacity is recorded');
  top.opacity = 1;
  applyFrame(doc, activeFrame(doc));
  t.close(top.opacity, 0.4, 1e-9, 'and restored');
});

suite('animation / frames render differently', async (t) => {
  const doc = threeColourDoc(t);
  framesFromLayers(doc);
  const frames = framesOf(doc);
  t.eq(frames.length, 4, 'Make Frames From Layers gives one frame per layer');

  const visibleNames = (f) => doc.flatLayers().filter((l) => f.state[l.id] && f.state[l.id].visible).map((l) => l.name);
  t.eq(frames.map((f) => visibleNames(f).length), [1, 1, 1, 1], 'each frame shows exactly one layer');
  t.eq(visibleNames(frames[0])[0], 'Background', 'bottom layer first, as Photoshop does');

  const shots = frames.map((f) => { applyFrame(doc, f); return centre(compositeDocument(doc)).join(','); });
  t.eq(new Set(shots).size, 4, `every frame composites to a different picture (${shots.join(' | ')})`);
  t.eq(shots[1], '255,0,0', 'and the second frame really is the red layer');
});

suite('animation / editing the timeline', async (t) => {
  const doc = threeColourDoc(t);
  framesFromLayers(doc);
  const frames = framesOf(doc);

  setFrameDelay(doc, 250);
  t.ok(frames.every((f) => f.delay === 250), 'setting a delay with no list applies to every frame');
  setFrameDelay(doc, 500, [frames[1]]);
  t.eq([frames[0].delay, frames[1].delay], [250, 500], 'or to just the frames passed in');

  const first = frames[0];
  moveFrame(doc, first, 2);
  t.eq(framesOf(doc)[2], first, 'a frame can be moved');
  t.eq(framesOf(doc).length, 4, 'without gaining or losing any');

  const before = framesOf(doc).map((f) => f.id);
  reverseFrames(doc);
  t.eq(framesOf(doc).map((f) => f.id), [...before].reverse(), 'and the order can be reversed');

  const count = framesOf(doc).length;
  removeFrame(doc, framesOf(doc)[0]);
  t.eq(framesOf(doc).length, count - 1, 'a frame can be deleted');
  t.ok(framesOf(doc).some((f) => f.id === doc.activeFrameId), 'and something is still selected afterwards');

  // The last frame cannot go: a timeline with no frames is not a timeline.
  while (framesOf(doc).length > 1) removeFrame(doc, framesOf(doc)[0]);
  t.eq(removeFrame(doc, framesOf(doc)[0]), false, 'the last frame refuses to be deleted');
  t.eq(framesOf(doc).length, 1, 'and stays');

  clearTimeline(doc);
  t.eq(framesOf(doc).length, 0, 'the whole timeline can be dropped');
});

suite('animation / tween interpolates opacity', async (t) => {
  const doc = threeColourDoc(t);
  ensureTimeline(doc);
  const top = doc.layers[0];
  const a = activeFrame(doc);
  top.opacity = 1;
  updateFrame(doc, a);
  const b = addFrame(doc);
  top.opacity = 0;
  updateFrame(doc, b);

  const made = tweenFrames(doc, a, b, 3);
  t.eq(made.length, 3, 'tween inserts the number of frames asked for');
  t.eq(framesOf(doc).length, 5, 'between the two originals');
  t.eq(framesOf(doc)[0], a, 'with the first original still first');
  t.eq(framesOf(doc)[4], b, 'and the second still last');

  const opacities = made.map((f) => f.state[top.id].opacity);
  t.ok(opacities.every((v, i) => i === 0 || v < opacities[i - 1]),
    `opacity descends across the tween (${opacities.map((v) => v.toFixed(2)).join(' -> ')})`);
  t.close(opacities[1], 0.5, 1e-6, 'and the middle frame is halfway');

  // Non-adjacent frames are not a tween.
  t.eq(tweenFrames(doc, framesOf(doc)[0], framesOf(doc)[4], 2), [], 'tweening non-adjacent frames does nothing');
});

suite('animation / undo restores the timeline', async (t) => {
  const doc = threeColourDoc(t);
  framesFromLayers(doc);
  doc.commit('Animate');
  const count = framesOf(doc).length;
  const activeId = doc.activeFrameId;

  addFrame(doc);
  doc.commit('New Frame');
  t.eq(framesOf(doc).length, count + 1, 'a frame was added');

  doc.history.undo();
  t.eq(framesOf(doc).length, count, 'undo takes the frame back out');
  t.eq(doc.activeFrameId, activeId, 'and restores which frame was showing');

  doc.history.redo();
  t.eq(framesOf(doc).length, count + 1, 'redo puts it back');

  // captureState must carry the animation, or a history step silently drops it.
  const state = doc.captureState();
  t.ok(Array.isArray(state.frames), 'captureState carries the frames');
  t.eq(state.frames.length, count + 1, 'all of them');
  t.ok(Object.prototype.hasOwnProperty.call(state, 'activeFrameId'), 'and which one is active');
  t.ok(Object.prototype.hasOwnProperty.call(state, 'loopCount'), 'and the loop count');
});

/* ------------------------------------------------------------------ */
/* Animated GIF                                                        */
/* ------------------------------------------------------------------ */

suite('animation / animated GIF decodes back frame for frame', async (t) => {
  const doc = threeColourDoc(t);
  framesFromLayers(doc);
  setFrameDelay(doc, 120);
  doc.loopCount = 0;
  doc.commit('Animate');

  const frames = framesOf(doc).map((f) => {
    applyFrame(doc, f);
    const cv = createCanvas(doc.width, doc.height);
    ctx2d(cv).drawImage(compositeDocument(doc), 0, 0);
    return { canvas: cv, delay: f.delay };
  });

  const blob = encodeAnimatedGIF(frames, { loop: 0 });
  t.eq(blob.type, 'image/gif', 'the encoder returns a GIF blob');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  t.eq(String.fromCharCode(...bytes.subarray(0, 6)), 'GIF89a', 'with the GIF89a signature');

  const text = new TextDecoder('latin1').decode(bytes);
  t.ok(text.includes('NETSCAPE2.0'),
    'and the Netscape application extension, which is the only thing that makes a GIF loop');

  let controlBlocks = 0;
  for (let i = 0; i < bytes.length - 1; i++) if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9) controlBlocks++;
  t.eq(controlBlocks, frames.length, 'one graphic control block per frame');

  if ('ImageDecoder' in window) {
    const dec = new ImageDecoder({ data: bytes, type: 'image/gif' });
    await dec.tracks.ready;
    t.eq(dec.tracks.selectedTrack.frameCount, frames.length, 'the browser decodes every frame back');

    const cv = createCanvas(doc.width, doc.height);
    const readFrame = async (i) => {
      const f = await dec.decode({ frameIndex: i });
      const c = ctx2d(cv);
      c.clearRect(0, 0, cv.width, cv.height);
      c.drawImage(f.image, 0, 0);
      return centre(cv);
    };
    t.eq(await readFrame(1), [255, 0, 0], 'frame 2 comes back red');
    t.eq(await readFrame(2), [0, 255, 0], 'frame 3 green');
    t.eq(await readFrame(3), [0, 0, 255], 'frame 4 blue');
  } else {
    t.ok(true, 'ImageDecoder is unavailable here, so the decode check is skipped');
  }

  t.throws(() => encodeAnimatedGIF([]), 'encoding no frames is an error rather than an empty file');
});

suite('animation / export animates when the document has a timeline', async (t) => {
  const doc = threeColourDoc(t);
  framesFromLayers(doc);
  setFrameDelay(doc, 80);
  doc.commit('Animate');
  const showing = doc.activeFrameId;
  const visibleBefore = doc.flatLayers().map((l) => l.visible);

  const animated = await exportDocument(doc, { format: 'gif', save: false });
  const text = new TextDecoder('latin1').decode(new Uint8Array(await animated.arrayBuffer()));
  t.ok(text.includes('NETSCAPE2.0'), 'a GIF export animates without being asked');

  const still = await exportDocument(doc, { format: 'gif', save: false, animate: false });
  const stillText = new TextDecoder('latin1').decode(new Uint8Array(await still.arrayBuffer()));
  t.notOk(stillText.includes('NETSCAPE2.0'), 'while animate:false writes a single frame');

  // Rendering frames means applying them, so the document must be put back.
  t.eq(doc.activeFrameId, showing, 'exporting leaves the document on the frame it was showing');
  t.eq(doc.flatLayers().map((l) => l.visible), visibleBefore, 'with the layer visibility it had');

  // And a document with no timeline still exports a plain GIF.
  const plain = t.doc(32, 24, '#336699', 'plain');
  const plainGif = await exportDocument(plain, { format: 'gif', save: false });
  const plainText = new TextDecoder('latin1').decode(new Uint8Array(await plainGif.arrayBuffer()));
  t.notOk(plainText.includes('NETSCAPE2.0'), 'a document with no frames exports a still');
});
