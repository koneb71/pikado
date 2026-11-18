/**
 * Pixel revisions: a number that changes whenever a pixel buffer's contents do.
 *
 * `layer.pixelKey()` says *which* buffer holds a layer's pixels, and
 * copy-on-write (`beginEdit`) gives every edit session a new one. That is not
 * enough to cache against: a brush stroke writes into the same buffer on every
 * frame of the stroke, and a cache keyed on the buffer alone would keep serving
 * the first frame. So each buffer also carries a revision, bumped by the edit
 * lifecycle (see `Layer.beginEdit`, `PikaDocument.invalidate`) every time its
 * contents may have changed.
 *
 * Revisions live with the buffer, not the Layer object. Undo rebuilds Layer
 * objects from snapshots that share the old buffers; keyed this way, a buffer
 * that comes back from history keeps the revision it had, and caches built
 * against it are still valid. One clock serves every buffer, so a revision is
 * never reused: a buffer's revision only ever moves to a value no buffer has
 * had before.
 */

const revisions = new WeakMap();
let clock = 0;

/** The buffer's current revision; 0 for a buffer nothing has bumped yet. */
export function bufferRevision(buf) {
  return (buf && revisions.get(buf)) || 0;
}

/** Record that `buf`'s contents (may) have changed. Returns the new revision. */
export function bumpBuffer(buf) {
  if (!buf) return 0;
  clock++;
  revisions.set(buf, clock);
  return clock;
}
