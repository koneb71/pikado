/**
 * GIF89a encoder, single frame and animated.
 *
 * Canvas cannot write GIF natively, so we quantise to a 256-colour palette with
 * median cut and LZW-compress the indices ourselves. Shared by the Export
 * dialog and by `exportDocument()` so both produce identical files.
 *
 * `encodeAnimatedGIF` gives each frame its **own** local colour table rather than
 * fitting one global palette to every frame. A global table is smaller, and it is
 * the wrong trade for an editor: an animation whose frames differ in colour — a
 * sky going from blue to orange — has to share 256 entries across all of them,
 * and every frame ends up visibly banded. A local table costs 768 bytes per frame
 * and each frame gets a palette fitted to itself.
 */

/** Median-cut palette over the image's colours (at most `maxColors` entries). */
export function buildPalette(data, maxColors) {
  const samples = [];
  const step = Math.max(1, Math.floor(data.length / 4 / 24000));
  for (let p = 0; p < data.length / 4; p += step) {
    const i = p * 4;
    if (data[i + 3] < 128) continue;
    samples.push([data[i], data[i + 1], data[i + 2]]);
  }
  if (!samples.length) samples.push([0, 0, 0]);

  let boxes = [samples];
  while (boxes.length < maxColors) {
    let bestIdx = -1, bestRange = 0, bestAxis = 0;
    boxes.forEach((box, idx) => {
      if (box.length < 2) return;
      for (let a = 0; a < 3; a++) {
        let lo = 255, hi = 0;
        for (const p of box) { if (p[a] < lo) lo = p[a]; if (p[a] > hi) hi = p[a]; }
        if (hi - lo > bestRange) { bestRange = hi - lo; bestIdx = idx; bestAxis = a; }
      }
    });
    if (bestIdx < 0 || bestRange === 0) break;
    const box = boxes[bestIdx];
    box.sort((x, y) => x[bestAxis] - y[bestAxis]);
    const mid = box.length >> 1;
    boxes.splice(bestIdx, 1, box.slice(0, mid), box.slice(mid));
  }

  return boxes.filter((b) => b.length).map((box) => {
    let r = 0, g = 0, b = 0;
    for (const p of box) { r += p[0]; g += p[1]; b += p[2]; }
    return [Math.round(r / box.length), Math.round(g / box.length), Math.round(b / box.length)];
  });
}

/** Variable-width LZW as GIF specifies it, returning a flat byte array. */
export function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const out = [];
  let bitBuffer = 0, bitCount = 0;
  const emit = (code, size) => {
    bitBuffer |= code << bitCount;
    bitCount += size;
    while (bitCount >= 8) {
      out.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  };

  let dict = new Map();
  let next = eoiCode + 1;
  let codeSize = minCodeSize + 1;
  emit(clearCode, codeSize);

  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix, codeSize);
    dict.set(key, next);
    next++;
    // The decoder's dictionary lags the encoder by one entry, so the width may
    // only grow once the *previous* free code no longer fits — `next > 1<<size`,
    // not `>=`. Bumping a code early makes every following code unreadable.
    if (next > (1 << codeSize) && codeSize < 12) codeSize++;
    if (next >= 4096) {
      emit(clearCode, codeSize);
      dict = new Map();
      next = eoiCode + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = k;
  }
  emit(prefix, codeSize);
  emit(eoiCode, codeSize);
  if (bitCount > 0) out.push(bitBuffer & 0xff);
  return out;
}

/**
 * Encode a canvas as a GIF89a blob.
 * @param {HTMLCanvasElement} canvas
 * @param {boolean} [transparent] reserve a palette slot for transparency
 * @returns {Blob}
 */
export function encodeGIF(canvas, transparent = true) {
  const w = canvas.width, h = canvas.height;
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const wantAlpha = transparent && (() => {
    for (let i = 3; i < data.length; i += 4) if (data[i] < 128) return true;
    return false;
  })();

  const palette = buildPalette(data, wantAlpha ? 255 : 256);
  const transIndex = wantAlpha ? palette.length : -1;
  if (wantAlpha) palette.push([0, 0, 0]);

  let bits = 1;
  while ((1 << bits) < palette.length) bits++;
  const tableSize = 1 << bits;

  // Quantising every pixel against the palette is the slow part; cache on the
  // top 6 bits per channel, which is visually indistinguishable here.
  const cache = new Map();
  const nearest = (r, g, b) => {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < palette.length; i++) {
      if (i === transIndex) continue;
      const p = palette[i];
      const d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    cache.set(key, best);
    return best;
  };

  const indices = new Uint8Array(w * h);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    indices[p] = wantAlpha && data[i + 3] < 128 ? transIndex : nearest(data[i], data[i + 1], data[i + 2]);
  }

  const bytes = [];
  const push = (...v) => bytes.push(...v);
  const pushStr = (s) => { for (const ch of s) bytes.push(ch.charCodeAt(0)); };
  const push16 = (v) => bytes.push(v & 0xff, (v >> 8) & 0xff);

  pushStr('GIF89a');
  push16(w); push16(h);
  push(0x80 | ((bits - 1) & 7), 0, 0); // global colour table, no background
  for (let i = 0; i < tableSize; i++) {
    const c = palette[i] || [0, 0, 0];
    push(c[0], c[1], c[2]);
  }
  if (wantAlpha) push(0x21, 0xf9, 0x04, 0x01, 0, 0, transIndex, 0); // graphic control ext
  push(0x2c); // image descriptor
  push16(0); push16(0); push16(w); push16(h);
  push(0);

  const minCodeSize = Math.max(2, bits);
  push(minCodeSize);
  const lzw = lzwEncode(indices, minCodeSize);
  for (let i = 0; i < lzw.length; i += 255) {
    const chunk = lzw.slice(i, i + 255);
    push(chunk.length, ...chunk);
  }
  push(0, 0x3b); // block terminator + trailer
  return new Blob([new Uint8Array(bytes)], { type: 'image/gif' });
}

/* ------------------------------------------------------------------ */
/* Animation                                                           */
/* ------------------------------------------------------------------ */

/**
 * Quantise one canvas against its own palette.
 * @returns {{indices:Uint8Array, palette:number[][], transIndex:number, bits:number}}
 */
function quantize(canvas, transparent) {
  const w = canvas.width, h = canvas.height;
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const wantAlpha = transparent && (() => {
    for (let i = 3; i < data.length; i += 4) if (data[i] < 128) return true;
    return false;
  })();

  const palette = buildPalette(data, wantAlpha ? 255 : 256);
  const transIndex = wantAlpha ? palette.length : -1;
  if (wantAlpha) palette.push([0, 0, 0]);

  let bits = 1;
  while ((1 << bits) < palette.length) bits++;

  const cache = new Map();
  const nearest = (r, g, b) => {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < palette.length; i++) {
      if (i === transIndex) continue;
      const p = palette[i];
      const d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    cache.set(key, best);
    return best;
  };

  const indices = new Uint8Array(w * h);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    indices[p] = wantAlpha && data[i + 3] < 128 ? transIndex : nearest(data[i], data[i + 1], data[i + 2]);
  }
  return { indices, palette, transIndex, bits };
}

/**
 * Encode an animated GIF.
 *
 * @param {Array<{canvas:HTMLCanvasElement, delay?:number}>} frames delays in ms
 * @param {object} [opts]
 * @param {number} [opts.loop] 0 = forever (the default), else the number of plays
 * @param {boolean} [opts.transparent] honour alpha below 50%
 * @returns {Blob}
 */
export function encodeAnimatedGIF(frames, opts = {}) {
  const list = (frames || []).filter((f) => f && f.canvas);
  if (!list.length) throw new Error('encodeAnimatedGIF: no frames');
  const { loop = 0, transparent = true } = opts;
  const w = list[0].canvas.width, h = list[0].canvas.height;

  const bytes = [];
  const push = (...v) => { for (const x of v) bytes.push(x); };
  const pushStr = (s) => { for (const ch of s) bytes.push(ch.charCodeAt(0)); };
  const push16 = (v) => { bytes.push(v & 0xff, (v >> 8) & 0xff); };

  pushStr('GIF89a');
  push16(w); push16(h);
  // No global colour table: every frame carries its own, so the flags byte has
  // the global-table bit clear and the colour-resolution bits are meaningless.
  push(0x70, 0, 0);

  // The Netscape application extension is what makes a GIF loop. Nothing in the
  // GIF specification does — it is a de-facto standard every decoder implements.
  push(0x21, 0xff, 0x0b);
  pushStr('NETSCAPE2.0');
  push(0x03, 0x01);
  push16(Math.max(0, Math.min(65535, Math.round(loop))));
  push(0);

  for (const frame of list) {
    const { indices, palette, transIndex, bits } = quantize(frame.canvas, transparent);
    const tableSize = 1 << bits;

    /*
     * Delays travel in hundredths of a second, so a 100 ms frame is 10 and a
     * 30 ms frame rounds to 3. Zero is a trap: most browsers treat a 0 or 1
     * hundredth delay as "as fast as possible" and clamp it to about 100 ms, so a
     * frame asking for no delay plays *slower* than one asking for 20 ms. Ask for
     * the minimum that is honoured rather than the value that gets reinterpreted.
     */
    const hundredths = Math.max(2, Math.round((frame.delay == null ? 100 : frame.delay) / 10));
    // Disposal 2 (restore to background) so a frame with transparency does not
    // show the previous frame through its holes.
    const disposal = transIndex >= 0 ? 2 : 1;
    push(0x21, 0xf9, 0x04, (disposal << 2) | (transIndex >= 0 ? 1 : 0));
    push16(Math.min(65535, hundredths));
    push(transIndex >= 0 ? transIndex : 0, 0);

    push(0x2c);                                   // image descriptor
    push16(0); push16(0); push16(w); push16(h);
    push(0x80 | ((bits - 1) & 7));                // local colour table, size
    for (let i = 0; i < tableSize; i++) {
      const c = palette[i] || [0, 0, 0];
      push(c[0], c[1], c[2]);
    }

    const minCodeSize = Math.max(2, bits);
    push(minCodeSize);
    const lzw = lzwEncode(indices, minCodeSize);
    for (let i = 0; i < lzw.length; i += 255) {
      const chunk = lzw.slice(i, i + 255);
      push(chunk.length, ...chunk);
    }
    push(0);
  }

  push(0x3b);
  return new Blob([new Uint8Array(bytes)], { type: 'image/gif' });
}
