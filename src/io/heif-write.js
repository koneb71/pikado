import { createCanvas, ctx2d, ctx2dRead } from '../core/util.js';
import { msg, tr } from '../core/i18n.js';

/**
 * Writing HEIC.
 *
 * No WebAssembly HEVC encoder is worth shipping — libheif-js, which opens HEIC
 * here, is built without one — so this uses the encoder the browser already
 * has, through WebCodecs, and writes the HEIF container around its output by
 * hand. Safari has one everywhere; Chrome and Edge have one on macOS and Windows
 * (and Android/ChromeOS) through the platform's hardware encoder. Firefox and
 * Chromium on Linux do not, and the Export dialog says so instead of offering a
 * button that cannot work.
 *
 * The layout is the one an iPhone writes:
 *
 *   - the image is cut into **512x512 tiles**, each coded as its own HEVC
 *     picture, and reassembled by a `grid` item. That keeps every picture inside
 *     what a hardware encoder accepts, at any document size.
 *   - the colour conversion to YCbCr is done **here**, not by the browser, and
 *     the file says exactly which one was used (full-range BT.601, in an `nclx`
 *     property). A browser's RGB→YUV conversion is not specified and differs
 *     between engines; a decoder told the wrong matrix shifts every colour.
 *   - transparency is a second grid, of the alpha values coded as luma, linked
 *     to the first as its `auxl` alpha plane. Only written when the picture has
 *     any transparency — an opaque photo stays a plain photo.
 *
 * `muxHEIF` is the container writer and nothing else: given coded tiles, it is
 * a pure function, which is what lets the suite test it with tiles from a real
 * encoder on a machine whose browser has none.
 */

const TILE = 512;
const CODEC = 'hvc1.1.6.L93.B0';     // Main profile, Main tier, level 3.1: 512x512 fits

/** Full-range BT.601, the JPEG matrix, in sRGB primaries and transfer. */
const NCLX = { primaries: 1, transfer: 13, matrix: 6, fullRange: true };
const FRAME_COLOUR = { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'smpte170m', fullRange: true };

const UNSUPPORTED = msg('HEIC export needs an HEVC encoder, and this browser has none. Safari, or Chrome and Edge on macOS or Windows, can write HEIC.');

/* ------------------------------------------------------------------ */
/* Support                                                             */
/* ------------------------------------------------------------------ */

function baseConfig(width, height) {
  return {
    codec: CODEC,
    width,
    height,
    hevc: { format: 'hevc' },
    latencyMode: 'quality',
    hardwareAcceleration: 'no-preference',
    framerate: 1,
  };
}

/**
 * The config to encode with, preferring a fixed quantizer — which is what
 * "quality" actually means for a still — and falling back to a bitrate.
 */
async function pickConfig(width, height, quality) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoEncoder.isConfigSupported !== 'function') return null;
  const quantized = { ...baseConfig(width, height), bitrateMode: 'quantizer' };
  try {
    const res = await VideoEncoder.isConfigSupported(quantized);
    if (res && res.supported) return { config: quantized, quantizer: quantizerFor(quality) };
  } catch (err) { /* not a mode this browser knows */ }
  const rated = { ...baseConfig(width, height), bitrateMode: 'variable', bitrate: bitrateFor(width, height, quality) };
  try {
    const res = await VideoEncoder.isConfigSupported(rated);
    if (res && res.supported) return { config: rated, quantizer: null };
  } catch (err) { /* no HEVC at all */ }
  return null;
}

/**
 * Quality 0..1 to an HEVC quantizer, 51 (worst) .. 0. The curve spends most of
 * the slider where the visible differences are: 0.8 lands near QP 20, which is
 * about where an HEVC still stops showing artefacts at normal viewing size.
 */
export function quantizerFor(quality) {
  const q = Math.max(0, Math.min(1, quality));
  return Math.round(51 * Math.pow(1 - q, 0.6));
}

/** One frame per second, so the bitrate *is* the size budget of a tile. */
function bitrateFor(width, height, quality) {
  const q = Math.max(0, Math.min(1, quality));
  return Math.round(width * height * (0.1 + 4 * q * q * q));
}

let supportPromise = null;

/**
 * Whether this browser can write HEIC, and why not when it cannot.
 * @returns {Promise<{ok:boolean, reason:string}>}
 */
export function heicEncodeSupport() {
  if (!supportPromise) {
    supportPromise = pickConfig(TILE, TILE, 0.8)
      .then((picked) => (picked ? { ok: true, reason: '' } : { ok: false, reason: tr(UNSUPPORTED) }))
      .catch(() => ({ ok: false, reason: tr(UNSUPPORTED) }));
  }
  return supportPromise;
}

/* ------------------------------------------------------------------ */
/* Encoding                                                            */
/* ------------------------------------------------------------------ */

const roundUp = (n, to) => Math.ceil(n / to) * to;

/**
 * The tile size for an image: 512, or the image itself rounded up to a
 * multiple of 16 when it is smaller — a 64 px icon does not need to be coded
 * as a 512 px picture. 4:2:0 needs even sizes, and hardware encoders work in
 * 16-pixel blocks.
 */
export function tileSizeFor(width, height) {
  return {
    tileW: Math.min(TILE, Math.max(64, roundUp(width, 16))),
    tileH: Math.min(TILE, Math.max(64, roundUp(height, 16))),
  };
}

/**
 * One tile of the source, with its edges extended past the image. Padding with
 * black instead would put a hard edge just outside the crop, and the encoder
 * would spend bits on it and ring back into the visible pixels.
 */
function cutTile(source, x, y, tileW, tileH) {
  const tile = createCanvas(tileW, tileH);
  const c = ctx2dRead(tile);
  c.imageSmoothingEnabled = false;
  const w = Math.min(tileW, source.width - x);
  const h = Math.min(tileH, source.height - y);
  c.drawImage(source, x, y, w, h, 0, 0, w, h);
  if (w < tileW) c.drawImage(tile, w - 1, 0, 1, h, w, 0, tileW - w, h);
  if (h < tileH) c.drawImage(tile, 0, h - 1, tileW, 1, 0, h, tileW, tileH - h);
  return c.getImageData(0, 0, tileW, tileH);
}

/**
 * RGBA to planar I420 with the full-range BT.601 matrix. Chroma is the average
 * of each 2x2 block. With `alpha`, luma is the alpha value and chroma neutral —
 * the alpha plane is a monochrome picture.
 */
export function toI420(image, alpha = false) {
  const { width, height, data } = image;
  const cw = width >> 1;
  const ch = height >> 1;
  const out = new Uint8Array(width * height + 2 * cw * ch);
  const u = width * height;
  const v = u + cw * ch;
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    out[i] = alpha
      ? data[p + 3]
      : Math.round(0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]);
  }
  if (alpha) {
    out.fill(128, u);
    return out;
  }
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const p = (((y * 2 + dy) * width) + x * 2 + dx) * 4;
          r += data[p]; g += data[p + 1]; b += data[p + 2];
        }
      }
      r /= 4; g /= 4; b /= 4;
      const k = y * cw + x;
      out[u + k] = clamp8(128 - 0.168736 * r - 0.331264 * g + 0.5 * b);
      out[v + k] = clamp8(128 + 0.5 * r - 0.418688 * g - 0.081312 * b);
    }
  }
  return out;
}

/** A private copy of an ArrayBuffer or view, which the encoder may reuse. */
function copyBytes(source) {
  return ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice()
    : new Uint8Array(source).slice();
}

const clamp8 = (n) => (n < 0 ? 0 : n > 255 ? 255 : Math.round(n));

/** Whether any pixel is less than fully opaque. */
function hasTransparency(source) {
  const d = ctx2dRead(source).getImageData(0, 0, source.width, source.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true;
  return false;
}

/**
 * Encode a canvas as HEIC.
 * @param {HTMLCanvasElement} source
 * @param {{quality?:number, transparent?:boolean}} [opts] quality 0..1
 * @returns {Promise<Blob>}
 */
export async function encodeHEIC(source, opts = {}) {
  const quality = opts.quality == null ? 0.8 : opts.quality;
  const width = source.width;
  const height = source.height;
  const { tileW, tileH } = tileSizeFor(width, height);
  const cols = Math.ceil(width / tileW);
  const rows = Math.ceil(height / tileH);
  if (cols > 256 || rows > 256) throw new Error(tr('the image is too large for a HEIC grid'));

  const picked = await pickConfig(tileW, tileH, quality);
  if (!picked) throw new Error(tr(UNSUPPORTED));
  const withAlpha = opts.transparent !== false && hasTransparency(source);

  const chunks = [];
  let description = null;
  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push(data);
      const config = metadata && metadata.decoderConfig;
      if (!description && config && config.description) description = copyBytes(config.description);
    },
    error: (err) => { failure = err; },
  });
  encoder.configure(picked.config);

  const options = picked.quantizer == null ? { keyFrame: true } : { keyFrame: true, hevc: { quantizer: picked.quantizer } };
  let index = 0;
  const encodePlanes = async (alpha) => {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (failure) throw failure;
        // Keep a few tiles in flight, not all of them: a big document is
        // hundreds of tiles, and each queued frame holds its pixels.
        while (encoder.encodeQueueSize > 4) await new Promise((res) => setTimeout(res, 4));
        const tile = cutTile(source, c * tileW, r * tileH, tileW, tileH);
        const frame = new VideoFrame(toI420(tile, alpha), {
          format: 'I420',
          codedWidth: tileW,
          codedHeight: tileH,
          timestamp: index++ * 1e6,
          duration: 1e6,
          colorSpace: FRAME_COLOUR,
        });
        encoder.encode(frame, options);
        frame.close();
      }
    }
  };

  try {
    await encodePlanes(false);
    if (withAlpha) await encodePlanes(true);
    await encoder.flush();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  if (failure) throw failure;
  const count = rows * cols;
  if (chunks.length !== count * (withAlpha ? 2 : 1)) throw new Error(tr('the HEVC encoder dropped tiles'));
  if (!description) throw new Error(tr('the HEVC encoder did not describe its output'));

  const bytes = muxHEIF({
    hvcC: description,
    tiles: chunks.slice(0, count),
    alphaTiles: withAlpha ? chunks.slice(count) : null,
    tileW, tileH, cols, rows, width, height,
    nclx: NCLX,
  });
  return new Blob([bytes], { type: 'image/heic' });
}

/* ------------------------------------------------------------------ */
/* The container                                                       */
/* ------------------------------------------------------------------ */

const u8 = (n) => Uint8Array.of(n & 0xff);
const u16 = (n) => Uint8Array.of((n >>> 8) & 0xff, n & 0xff);
const u32 = (n) => Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
const str = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function cat(...parts) {
  const flat = parts.flat(Infinity).filter(Boolean);
  const out = new Uint8Array(flat.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of flat) { out.set(p, at); at += p.length; }
  return out;
}

const box = (type, ...body) => {
  const payload = cat(...body);
  return cat(u32(payload.length + 8), str(type), payload);
};
const fullBox = (type, version, flags, ...body) => box(type, u8(version), u8(flags >> 16), u16(flags & 0xffff), ...body);

/** The grid descriptor, stored as the grid item's data. */
function gridData(rows, cols, width, height) {
  const wide = width > 0xffff || height > 0xffff;
  return cat(u8(0), u8(wide ? 1 : 0), u8(rows - 1), u8(cols - 1),
    wide ? [u32(width), u32(height)] : [u16(width), u16(height)]);
}

/**
 * Assemble a HEIC from coded tiles.
 *
 * @param {{hvcC:Uint8Array, tiles:Uint8Array[], alphaTiles?:Uint8Array[]|null,
 *          tileW:number, tileH:number, cols:number, rows:number,
 *          width:number, height:number,
 *          nclx:{primaries:number, transfer:number, matrix:number, fullRange:boolean}}} parts
 *   tiles in row-major order, each one length-prefixed HEVC NAL units as the
 *   hvcC record describes — exactly what a WebCodecs encoder emits in 'hevc'
 *   format.
 * @returns {Uint8Array}
 */
export function muxHEIF(parts) {
  const { hvcC, tiles, tileW, tileH, cols, rows, width, height, nclx } = parts;
  const alphaTiles = parts.alphaTiles && parts.alphaTiles.length ? parts.alphaTiles : null;
  if (tiles.length !== rows * cols) throw new Error(`expected ${rows * cols} tiles, got ${tiles.length}`);
  if (alphaTiles && alphaTiles.length !== tiles.length) throw new Error('the alpha plane needs one tile per colour tile');

  // Item ids: the grid is 1 and the primary image; its tiles follow; the alpha
  // grid and its tiles come after.
  const gridId = 1;
  const tileIds = tiles.map((_, i) => 2 + i);
  const alphaId = alphaTiles ? 2 + tiles.length : 0;
  const alphaTileIds = alphaTiles ? alphaTiles.map((_, i) => alphaId + 1 + i) : [];

  const grid = gridData(rows, cols, width, height);
  // mdat payload order, with each item's data.
  const items = [
    { id: gridId, data: grid },
    ...(alphaTiles ? [{ id: alphaId, data: grid }] : []),
    ...tiles.map((data, i) => ({ id: tileIds[i], data })),
    ...(alphaTiles ? alphaTiles.map((data, i) => ({ id: alphaTileIds[i], data })) : []),
  ];

  // Properties, 1-based in ipma.
  const P = { hvcC: 1, ispeTile: 2, ispeFull: 3, colr: 4, pixi: 5, auxC: 6 };
  const ipco = box('ipco',
    box('hvcC', hvcC),
    fullBox('ispe', 0, 0, u32(tileW), u32(tileH)),
    fullBox('ispe', 0, 0, u32(width), u32(height)),
    box('colr', str('nclx'), u16(nclx.primaries), u16(nclx.transfer), u16(nclx.matrix), u8(nclx.fullRange ? 0x80 : 0)),
    fullBox('pixi', 0, 0, u8(3), u8(8), u8(8), u8(8)),
    alphaTiles ? fullBox('auxC', 0, 0, str('urn:mpeg:hevc:2015:auxid:1\0')) : null,
  );
  const essential = (index) => index | 0x80;
  const associations = [
    [gridId, [P.ispeFull, P.colr, P.pixi]],
    ...tileIds.map((id) => [id, [essential(P.hvcC), P.ispeTile, P.colr, P.pixi]]),
    ...(alphaTiles ? [[alphaId, [P.ispeFull, essential(P.auxC)]]] : []),
    ...alphaTileIds.map((id) => [id, [essential(P.hvcC), P.ispeTile]]),
  ];
  const ipma = fullBox('ipma', 0, 0, u32(associations.length),
    associations.map(([id, props]) => [u16(id), u8(props.length), props.map(u8)]));

  const infe = (id, type, hidden) => fullBox('infe', 2, hidden ? 1 : 0, u16(id), u16(0), str(type), u8(0));
  const iinf = fullBox('iinf', 0, 0, u16(items.length),
    infe(gridId, 'grid', false),
    tileIds.map((id) => infe(id, 'hvc1', true)),
    alphaTiles ? infe(alphaId, 'grid', true) : null,
    alphaTileIds.map((id) => infe(id, 'hvc1', true)));

  const reference = (type, from, to) => box(type, u16(from), u16(to.length), to.map(u16));
  const iref = fullBox('iref', 0, 0,
    reference('dimg', gridId, tileIds),
    alphaTiles ? reference('dimg', alphaId, alphaTileIds) : null,
    alphaTiles ? reference('auxl', alphaId, [gridId]) : null);

  const ftyp = box('ftyp', str('heic'), u32(0), str('mif1'), str('heic'));

  const buildMeta = (dataStart) => {
    let offset = dataStart;
    const extents = items.map((item) => {
      const entry = cat(u16(item.id), u16(0), u16(1), u32(offset), u32(item.data.length));
      offset += item.data.length;
      return entry;
    });
    return fullBox('meta', 0, 0,
      fullBox('hdlr', 0, 0, u32(0), str('pict'), u32(0), u32(0), u32(0), u8(0)),
      fullBox('pitm', 0, 0, u16(gridId)),
      // offset_size 4, length_size 4, base_offset_size 0
      fullBox('iloc', 0, 0, u8(0x44), u8(0x00), u16(items.length), extents),
      iinf,
      iref,
      box('iprp', ipco, ipma));
  };

  // Every field above is fixed-width, so the meta box is the same size whatever
  // offsets it carries: measure it once, then write it with the real ones.
  const metaSize = buildMeta(0).length;
  const dataStart = ftyp.length + metaSize + 8;
  const meta = buildMeta(dataStart);
  const payload = items.map((item) => item.data);
  const mdatSize = 8 + payload.reduce((n, p) => n + p.length, 0);
  return cat(ftyp, meta, u32(mdatSize), str('mdat'), payload);
}
