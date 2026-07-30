import { uid } from './util.js';

/**
 * Frame animation.
 *
 * A frame is not a copy of the picture — it is a *record of layer state*: which
 * layers are visible and at what opacity. The document holds one set of layers,
 * and playing the animation walks the frames applying their records. That is how
 * Photoshop's frame animation works, and it is what makes a twenty-frame
 * animation cost twenty small objects rather than twenty copies of the canvas.
 *
 * The state lives on the document:
 *
 *   doc.frames         array of frame records, in playback order
 *   doc.activeFrameId  which one the canvas is currently showing
 *   doc.loopCount      0 = forever, otherwise the number of plays
 *
 * All three are part of `captureState()`, so undo restores an animation edit —
 * including which frame you were on, because stepping to a frame changes what the
 * canvas shows and an undo that left you looking at a different frame would be
 * disorienting.
 *
 * What a frame does *not* record: pixels, masks, blend modes, layer effects, or
 * the layer stack itself. Those are shared across every frame, which is the point
 * — paint once, and the change appears in every frame that shows the layer.
 *
 * Position is not recorded either, and that is a real limitation rather than an
 * oversight: layer buffers in Pikado are always document-sized with no per-layer
 * offset (see ARCHITECTURE.md), so there is nowhere for a per-frame position to
 * live and nothing in the compositor that would honour one. Animating movement
 * means duplicating the layer and moving the pixels, or animating opacity between
 * two layers. Inventing a `frameOffset` field would have produced a control that
 * stored a number and changed nothing on screen.
 */

/** Milliseconds per frame when nothing says otherwise. */
export const DEFAULT_DELAY = 100;

/** The delays Photoshop's frame-delay menu offers, in milliseconds. */
export const DELAY_PRESETS = [0, 100, 200, 300, 500, 1000, 2000, 5000];

/**
 * A frame record capturing the animatable properties of every layer.
 * @param {import('./document.js').PikaDocument} doc
 * @param {number} [delay] milliseconds
 */
export function captureFrame(doc, delay = DEFAULT_DELAY) {
  const state = {};
  for (const layer of doc.flatLayers()) {
    state[layer.id] = {
      visible: layer.visible !== false,
      opacity: layer.opacity == null ? 1 : layer.opacity,
    };
  }
  return { id: uid('frame'), delay: Math.max(0, Math.round(delay)), state };
}

/** Read the animatable properties of every layer into an existing frame. */
export function updateFrame(doc, frame) {
  if (!frame) return frame;
  const fresh = captureFrame(doc, frame.delay);
  frame.state = fresh.state;
  return frame;
}

/**
 * Apply a frame's record to the document's layers.
 *
 * A layer the frame has never heard of — added after the frame was made — is left
 * alone rather than hidden. Hiding it would be the more "correct" reading of an
 * incomplete record, and it is the wrong behaviour: adding a layer would make it
 * vanish from every existing frame.
 */
export function applyFrame(doc, frame) {
  if (!frame || !frame.state) return;
  for (const layer of doc.flatLayers()) {
    const s = frame.state[layer.id];
    if (!s) continue;
    layer.visible = s.visible !== false;
    layer.opacity = s.opacity == null ? 1 : s.opacity;
  }
  doc.activeFrameId = frame.id;
  doc.invalidate();
}

/** The frames array, created on first use. */
export function framesOf(doc) {
  if (!doc) return [];
  if (!Array.isArray(doc.frames)) doc.frames = [];
  return doc.frames;
}

/** True when the document has a timeline worth showing. */
export function hasAnimation(doc) {
  return framesOf(doc).length > 1;
}

export function activeFrame(doc) {
  const frames = framesOf(doc);
  if (!frames.length) return null;
  return frames.find((f) => f.id === doc.activeFrameId) || frames[0];
}

export function frameIndex(doc) {
  const frames = framesOf(doc);
  const i = frames.findIndex((f) => f.id === doc.activeFrameId);
  return i < 0 ? 0 : i;
}

/**
 * Start a timeline if there isn't one.
 *
 * The first frame is the document as it stands, so turning on animation never
 * changes what you are looking at.
 */
export function ensureTimeline(doc) {
  const frames = framesOf(doc);
  if (frames.length) return frames;
  frames.push(captureFrame(doc));
  doc.activeFrameId = frames[0].id;
  if (doc.loopCount == null) doc.loopCount = 0;
  return frames;
}

/** Add a frame after the active one, copying its state (Photoshop's New Frame). */
export function addFrame(doc, { after = null, copyState = true } = {}) {
  const frames = ensureTimeline(doc);
  const current = activeFrame(doc);
  const at = after ? frames.indexOf(after) : frames.indexOf(current);
  const frame = copyState && current
    ? { id: uid('frame'), delay: current.delay, state: structuredClone(current.state) }
    : captureFrame(doc);
  frames.splice(at + 1, 0, frame);
  doc.activeFrameId = frame.id;
  return frame;
}

/** Remove a frame. The last one cannot go: a timeline with no frames is not one. */
export function removeFrame(doc, frame) {
  const frames = framesOf(doc);
  if (frames.length <= 1) return false;
  const i = frames.indexOf(frame);
  if (i < 0) return false;
  frames.splice(i, 1);
  const next = frames[Math.min(i, frames.length - 1)];
  applyFrame(doc, next);
  return true;
}

/** Move a frame to a new index. */
export function moveFrame(doc, frame, toIndex) {
  const frames = framesOf(doc);
  const from = frames.indexOf(frame);
  if (from < 0) return false;
  const to = Math.max(0, Math.min(frames.length - 1, toIndex));
  if (to === from) return false;
  frames.splice(from, 1);
  frames.splice(to, 0, frame);
  return true;
}

/** Set the delay on a list of frames (or all of them). */
export function setFrameDelay(doc, delay, frames = null) {
  const list = frames && frames.length ? frames : framesOf(doc);
  const ms = Math.max(0, Math.round(delay));
  for (const f of list) f.delay = ms;
  return ms;
}

/**
 * One frame per layer, bottom layer first — Photoshop's "Make Frames From
 * Layers". Each frame shows exactly one layer, so a stack of drawings becomes an
 * animation without any per-frame editing.
 */
export function framesFromLayers(doc, { delay = DEFAULT_DELAY } = {}) {
  const stack = doc.layers.filter((l) => l.type !== 'group' || (l.children && l.children.length));
  if (!stack.length) return framesOf(doc);
  const frames = [];
  // `doc.layers[0]` is the top layer, so walk backwards for bottom-first order.
  for (let i = stack.length - 1; i >= 0; i--) {
    const shown = stack[i];
    const state = {};
    for (const layer of doc.flatLayers()) {
      const isShown = layer === shown || isDescendantOf(layer, shown);
      state[layer.id] = {
        visible: isShown,
        opacity: layer.opacity == null ? 1 : layer.opacity,
      };
    }
    frames.push({ id: uid('frame'), delay, state });
  }
  doc.frames = frames;
  applyFrame(doc, frames[0]);
  return frames;
}

function isDescendantOf(layer, ancestor) {
  for (let p = layer.parent; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

/**
 * Insert interpolated frames between two frames — Photoshop's Tween.
 *
 * Opacity interpolates linearly; visibility cannot, so it takes the value of
 * whichever end is nearer. A tween between two frames that differ only in which
 * layer is visible is therefore a cut at the midpoint rather than a cross-fade —
 * the cross-fade is what you get by animating *opacity*, which is the same
 * distinction Photoshop makes.
 *
 * @param {number} count how many frames to insert
 * @returns {object[]} the inserted frames
 */
export function tweenFrames(doc, from, to, count = 1) {
  const frames = framesOf(doc);
  const a = frames.indexOf(from), b = frames.indexOf(to);
  if (a < 0 || b < 0 || Math.abs(b - a) !== 1 || count < 1) return [];
  const made = [];
  for (let k = 1; k <= count; k++) {
    const t = k / (count + 1);
    const state = {};
    for (const id of Object.keys(from.state)) {
      const s = from.state[id];
      const e = to.state[id] || s;
      state[id] = {
        visible: t < 0.5 ? s.visible : e.visible,
        opacity: s.opacity + (e.opacity - s.opacity) * t,
      };
    }
    made.push({ id: uid('frame'), delay: from.delay, state });
  }
  frames.splice(Math.min(a, b) + 1, 0, ...made);
  return made;
}

/**
 * Reverse the frame order. Delays travel with their frames, which is what you
 * want when the timing is part of the motion.
 */
export function reverseFrames(doc) {
  framesOf(doc).reverse();
  return framesOf(doc);
}

/** Drop the timeline, leaving the layers exactly as the active frame shows them. */
export function clearTimeline(doc) {
  doc.frames = [];
  doc.activeFrameId = null;
}
