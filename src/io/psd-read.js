import { PikaDocument } from '../core/document.js';
import { Layer, LayerType, createGroupLayer } from '../core/layer.js';
import { createCanvas, ctx2d, clamp, uid } from '../core/util.js';
import { app } from '../core/app.js';
import { DEFAULT_STYLES } from '../effects/styles.js';
import { getPattern } from '../paint/patterns.js';
import { rasterizeTextLayer } from '../text/text-render.js';
import { familyFromPostScriptName } from '../text/fonts.js';
import { rasterizeShapeLayer } from '../vector/path.js';
import { SELECTION_CHANNEL_NAME, PSD_DASH_PRESETS, pikadoGradientAngle } from './psd-write.js';

/**
 * Photoshop (.psd) and Photoshop Big (.psb) reader.
 *
 * Written from the Adobe file-format specification with no external
 * dependencies. The parser is deliberately forgiving: every optional section is
 * wrapped so that a block it cannot understand never prevents the file from
 * opening. When the layer section is missing or unusable the flattened
 * composite stored at the end of the file is used instead, so `readPSD` always
 * produces something the user can look at.
 */

/* ------------------------------------------------------------------ */
/* ByteReader                                                          */
/* ------------------------------------------------------------------ */

/** Big-endian cursor over an ArrayBuffer. All PSD integers are big-endian. */
export class ByteReader {
  constructor(buffer, offset = 0, length = null) {
    this.buf = buffer;
    this.u8 = new Uint8Array(buffer);
    this.view = new DataView(buffer);
    this.pos = offset;
    this.start = offset;
    this.end = length == null ? this.u8.length : Math.min(this.u8.length, offset + length);
  }

  get remaining() {
    return this.end - this.pos;
  }

  tell() { return this.pos; }
  seek(p) { this.pos = p; return this; }
  skip(n) { this.pos += n; return this; }
  eof() { return this.pos >= this.end; }

  _need(n) {
    if (this.pos + n > this.end) throw new Error('Unexpected end of PSD data');
  }

  readUint8() { this._need(1); return this.u8[this.pos++]; }
  readInt8() { this._need(1); return this.view.getInt8(this.pos++); }
  readUint16() { this._need(2); const v = this.view.getUint16(this.pos); this.pos += 2; return v; }
  readInt16() { this._need(2); const v = this.view.getInt16(this.pos); this.pos += 2; return v; }
  readUint32() { this._need(4); const v = this.view.getUint32(this.pos); this.pos += 4; return v; }
  readInt32() { this._need(4); const v = this.view.getInt32(this.pos); this.pos += 4; return v; }
  readUint64() { const hi = this.readUint32(); const lo = this.readUint32(); return hi * 4294967296 + lo; }
  readDouble() { this._need(8); const v = this.view.getFloat64(this.pos); this.pos += 8; return v; }

  /** Signed integer of 1, 2, 4 or 8 bytes. */
  readSigned(bytes = 4) {
    if (bytes === 1) return this.readInt8();
    if (bytes === 2) return this.readInt16();
    if (bytes === 8) { const v = this.readUint64(); return v > 2 ** 63 ? v - 2 ** 64 : v; }
    return this.readInt32();
  }

  /** 16.16 fixed point. */
  readFixed32() { return this.readInt32() / 65536; }

  readBytes(n) {
    const len = Math.max(0, Math.min(n, this.end - this.pos));
    const out = this.u8.subarray(this.pos, this.pos + len);
    this.pos += n;
    return out;
  }

  /** Latin-1 string of exactly `n` bytes. */
  readString(n) {
    const len = Math.max(0, Math.min(n, this.end - this.pos));
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(this.u8[this.pos + i]);
    this.pos += n;
    return s;
  }

  peekString(n, at = this.pos) {
    let s = '';
    for (let i = 0; i < n && at + i < this.end; i++) s += String.fromCharCode(this.u8[at + i]);
    return s;
  }

  /** Length-prefixed string padded so (1 + length) is a multiple of `pad`. */
  readPascalString(pad = 2) {
    const len = this.readUint8();
    const s = this.readString(len);
    const total = len + 1;
    const rem = total % pad;
    if (rem) this.skip(pad - rem);
    return s;
  }

  /** uint32 character count followed by UTF-16BE code units. */
  readUnicodeString() {
    const len = this.readUint32();
    if (len > this.remaining / 2 + 1) throw new Error('Bad unicode string length');
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = this.readUint16();
      if (c) s += String.fromCharCode(c);
    }
    return s;
  }

  /** 4-byte key, or a length-prefixed key when the length is non-zero. */
  readKeyId() {
    const len = this.readUint32();
    return this.readString(len === 0 ? 4 : len);
  }
}

/** PSB stores some lengths as 64-bit. */
function readLength(r, psb) {
  return psb ? r.readUint64() : r.readUint32();
}

/* ------------------------------------------------------------------ */
/* Lookup tables                                                       */
/* ------------------------------------------------------------------ */

const COLOR_MODE_NAMES = {
  0: 'Bitmap', 1: 'Grayscale', 2: 'Indexed', 3: 'RGB', 4: 'CMYK',
  7: 'Multichannel', 8: 'Duotone', 9: 'Lab',
};

/** PSD blend-mode key -> Pikado blend id. Covers every documented key. */
const BLEND_KEYS = {
  pass: 'pass-through',
  norm: 'normal',
  diss: 'dissolve',
  dark: 'darken',
  'mul ': 'multiply',
  idiv: 'color-burn',
  lbrn: 'linear-burn',
  dkCl: 'darker-color',
  lite: 'lighten',
  scrn: 'screen',
  'div ': 'color-dodge',
  lddg: 'linear-dodge',
  lgCl: 'lighter-color',
  over: 'overlay',
  sLit: 'soft-light',
  hLit: 'hard-light',
  vLit: 'vivid-light',
  lLit: 'linear-light',
  pLit: 'pin-light',
  hMix: 'hard-mix',
  diff: 'difference',
  smud: 'exclusion',
  fsub: 'subtract',
  fdiv: 'divide',
  'hue ': 'hue',
  'sat ': 'saturation',
  colr: 'color',
  'lum ': 'luminosity',
};

/** Descriptor enum values used for blend modes inside layer effects. */
const BLEND_ENUMS = {
  Nrml: 'normal', Dslv: 'dissolve', Drkn: 'darken', Mltp: 'multiply',
  CBrn: 'color-burn', linearBurn: 'linear-burn', darkerColor: 'darker-color',
  Lghn: 'lighten', Scrn: 'screen', CDdg: 'color-dodge', linearDodge: 'linear-dodge',
  lighterColor: 'lighter-color', Ovrl: 'overlay', SftL: 'soft-light', HrdL: 'hard-light',
  vividLight: 'vivid-light', linearLight: 'linear-light', pinLight: 'pin-light',
  hardMix: 'hard-mix', Dfrn: 'difference', Xclu: 'exclusion',
  blendSubtraction: 'subtract', blendDivide: 'divide',
  'H   ': 'hue', Strt: 'saturation', 'Clr ': 'color', Lmns: 'luminosity',
};

/** Tagged blocks whose length field is 64-bit in PSB files. */
const BIG_KEYS = new Set([
  'LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn', 'Alph',
  'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD', 'cinf', 'CgEd',
]);

/** Adjustment tagged-block key -> Pikado adjustment id. */
const ADJUSTMENT_KEYS = {
  brit: 'brightness-contrast',
  levl: 'levels',
  curv: 'curves',
  hue2: 'hue-saturation',
  blnc: 'color-balance',
  mixr: 'channel-mixer',
  vibA: 'vibrance',
  blwh: 'black-white',
  phfl: 'photo-filter',
  selc: 'selective-color',
  thrs: 'threshold',
  post: 'posterize',
  nvrt: 'invert',
  grdm: 'gradient-map',
};

/**
 * Pikado's private additional-layer-info key, written by `psd-write.js` for
 * every adjustment layer. See the comment on `writePrivateAdjustment` there for
 * the byte layout; the short version is 'PKAD' + uint16 version + uint32 length
 * + UTF-8 JSON `{kind, params}`. Photoshop ignores keys it does not know, and
 * we ignore this one when another application wrote the file.
 */
const PIKADO_ADJUSTMENT_KEY = 'pkAd';
const PIKADO_ADJUSTMENT_MAGIC = 'PKAD';

/**
 * The same container carries the live text and shape payloads: `pkTx` holds
 * `layer.text` and `pkSh` holds `layer.shape`. Both sit *next to* the
 * interoperable `TySh` / `vmsk` blocks rather than replacing them, so another
 * application still sees a real Photoshop type or shape layer; they exist only
 * so a Pikado -> PSD -> Pikado round trip keeps the properties Photoshop's own
 * model has no room for (our font ids, 100..900 weights, warp amounts as
 * fractions, the polygon/star parameters a path cannot express).
 */
const PIKADO_TEXT_KEY = 'pkTx';
const PIKADO_TEXT_MAGIC = 'PKTX';
const PIKADO_SHAPE_KEY = 'pkSh';
const PIKADO_SHAPE_MAGIC = 'PKSH';

/**
 * Decode one Pikado-private block: magic, uint16 version, uint32 length and
 * that many bytes of UTF-8 JSON.
 * @returns {*} the parsed value, or null when the block is not ours
 */
function readPikadoPayload(r, magic) {
  if (r.remaining < 10) return null;
  if (r.readString(4) !== magic) return null;
  if (r.readUint16() !== 1) return null;
  const length = r.readUint32();
  if (length <= 0 || length > r.remaining) return null;
  return JSON.parse(new TextDecoder().decode(r.readBytes(length).slice()));
}

/** Every adjustment id Pikado knows — see `src/adjustments/registry.js`. */
const PIKADO_ADJUSTMENT_IDS = new Set([
  'brightness-contrast', 'levels', 'curves', 'exposure', 'vibrance',
  'hue-saturation', 'color-balance', 'black-white', 'photo-filter',
  'channel-mixer', 'color-lookup', 'invert', 'posterize', 'threshold',
  'gradient-map', 'selective-color', 'shadows-highlights', 'desaturate',
  'equalize', 'replace-color', 'hdr-toning', 'auto-tone', 'auto-contrast',
  'auto-color',
]);

/** Decode one `pkAd` block, or null when it is not ours / not intelligible. */
function readPikadoAdjustment(r) {
  const value = readPikadoPayload(r, PIKADO_ADJUSTMENT_MAGIC);
  if (!value || typeof value.kind !== 'string') return null;
  if (!PIKADO_ADJUSTMENT_IDS.has(value.kind)) return null;
  const params = value.params && typeof value.params === 'object' && !Array.isArray(value.params) ? value.params : {};
  return { kind: value.kind, params };
}

const LAYER_COLOR_LABELS = ['none', 'red', 'orange', 'yellow', 'green', 'blue', 'violet', 'gray'];

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Parse a PSD/PSB file into a PikaDocument.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<PikaDocument>}
 */
/**
 * How much memory a layered import will actually cost, in bytes.
 *
 * Pikado stores every layer buffer at document size (golden rule 3), so a PSD's
 * cost here has almost nothing to do with its file size and everything to do
 * with layer count times document area. A 0.3 MB file with 24 small layers on a
 * 1600x1200 canvas needs 176 MB — measured, not estimated. The masks are counted
 * at a third of a full buffer because only some layers carry one.
 *
 * Exported so the open path and the tests can ask the same question the importer
 * asks itself.
 *
 * @param {number} layerCount
 * @param {number} width
 * @param {number} height
 * @returns {number} bytes
 */
export function projectedLayerBytes(layerCount, width, height, records = null) {
  /*
   * Layers are stored at their own size now, so the cost is the sum of the
   * layers' own rectangles rather than layer count times canvas area. Those
   * rectangles are right there in the records, which makes this an actual
   * measurement instead of a worst case.
   *
   * Using the old worst case would now be actively harmful: it puts a 60-layer
   * 4000x3000 file at 3.6 GB and offers to flatten it, when the same file really
   * opens fully layered in 99 MB. Warning someone away from a document that
   * would have been fine is worse than not warning at all.
   */
  if (Array.isArray(records) && records.length) {
    let bytes = 0;
    for (const r of records) {
      const w = Math.max(0, (r.right || 0) - (r.left || 0));
      const h = Math.max(0, (r.bottom || 0) - (r.top || 0));
      bytes += w * h * 4;
    }
    return Math.round(bytes * 1.33);
  }
  // No records to inspect: fall back to the pessimistic figure.
  return Math.round(layerCount * width * height * 4 * 1.33);
}

/**
 * @param {ArrayBuffer} arrayBuffer
 * @param {{budgetBytes?: number, onOversize?: (info: object) => Promise<string>|string}} [opts]
 *   `onOversize` is asked what to do when the projected cost exceeds the budget,
 *   and answers 'flatten', 'proceed' or 'cancel'. With no handler the import
 *   proceeds, which keeps every existing caller and every test behaving exactly
 *   as before.
 */
export async function readPSD(arrayBuffer, opts = {}) {
  if (!arrayBuffer || arrayBuffer.byteLength < 26) throw new Error('The file is too small to be a PSD');
  const r = new ByteReader(arrayBuffer);

  const signature = r.readString(4);
  if (signature !== '8BPS') throw new Error('Not a Photoshop file (the 8BPS signature is missing)');
  const version = r.readUint16();
  if (version !== 1 && version !== 2) throw new Error(`Unsupported PSD version ${version}`);
  const psb = version === 2;
  r.skip(6); // reserved

  const channelCount = r.readUint16();
  const height = r.readUint32();
  const width = r.readUint32();
  const depth = r.readUint16();
  const colorMode = r.readUint16();

  if (depth !== 8 && depth !== 16) {
    throw new Error(`Unsupported bit depth: ${depth} bits per channel. Pikado can open 8- and 16-bit files.`);
  }
  if (colorMode !== 3 && colorMode !== 1) {
    const nm = COLOR_MODE_NAMES[colorMode] || `mode ${colorMode}`;
    throw new Error(`Unsupported colour mode: ${nm}. Pikado can open RGB and Grayscale files.`);
  }
  if (width < 1 || height < 1) throw new Error('The PSD reports an empty canvas');
  if (width * height > 120e6) throw new Error(`The image is too large to open (${width}×${height})`);

  const ctx = {
    buf: arrayBuffer, psb, depth, colorMode, width, height, channelCount,
    mergedHasAlpha: channelCount > (colorMode === 1 ? 1 : 3),
    skipped: new Set(), warnings: [],
  };

  // --- Colour mode data (palette for indexed/duotone; unused for RGB/Gray).
  const cmdLength = r.readUint32();
  r.skip(cmdLength);

  // --- Image resources.
  const resLength = r.readUint32();
  const resourcesStart = r.tell();
  const resources = safe(
    () => parseImageResources(new ByteReader(arrayBuffer, resourcesStart, resLength), ctx),
    { alphaNames: [], guides: [], paths: [] },
  );
  r.seek(resourcesStart + resLength);

  // The header counts colour channels, the composite's transparency and the
  // saved alpha channels together. 1006 names the last group, which is what
  // tells us whether the composite carries transparency at all.
  const colorChannels = colorMode === 1 ? 1 : 3;
  ctx.mergedHasAlpha = channelCount - colorChannels - resources.alphaNames.length >= 1;

  // --- Layer and mask information.
  const lmLength = readLength(r, psb);
  const lmStart = r.tell();
  let parsed = null;
  if (lmLength > 0) {
    try {
      parsed = parseLayerAndMask(arrayBuffer, lmStart, lmLength, ctx);
    } catch (err) {
      console.warn('[psd] layer section unreadable, falling back to the composite', err);
      ctx.warnings.push('The layer section could not be read — the flattened image was used instead.');
      parsed = null;
    }
  }
  r.seek(lmStart + lmLength);
  const mergedStart = r.tell();

  const doc = new PikaDocument({ width, height, name: 'Untitled', resolution: resources.resolution || 72 });
  doc.colorMode = colorMode === 1 ? 'gray' : 'rgb';

  let built = [];
  if (parsed && parsed.records.length) {
    /*
     * Ask before allocating a gigabyte.
     *
     * This is the check the importer never had: line 297 bounds the *document*,
     * but the thing that kills the tab is layer count times document area, and
     * that cost is invisible from the file size. Canvas backing store also lives
     * outside the JS heap, so nothing in the app — not `performance.memory`, not
     * `doc.memoryUse()` after the fact — notices before the browser does.
     *
     * The fallback is free: every PSD already carries a flattened composite for
     * compatibility, and the branch below reaches for it whenever `built` is
     * empty. So "open it flattened" costs one document-sized canvas instead of
     * N, and needs no new decoding path.
     */
    const projected = projectedLayerBytes(parsed.records.length, width, height, parsed.records);
    const budget = opts.budgetBytes || Infinity;
    if (projected > budget && typeof opts.onOversize === 'function') {
      const choice = await opts.onOversize({
        layers: parsed.records.length, width, height, projectedBytes: projected, budgetBytes: budget,
      });
      if (choice === 'cancel') throw new Error('Import cancelled');
      if (choice === 'flatten') {
        ctx.warnings.push(
          `This file's ${parsed.records.length} layers would need about `
          + `${Math.round(projected / 1048576)} MB, so it was opened flattened.`,
        );
        parsed = null;
      }
    }
  }
  if (parsed && parsed.records.length) {
    try {
      built = await buildLayers(parsed.records, doc, ctx);
    } catch (err) {
      console.warn('[psd] layer reconstruction failed', err);
      ctx.warnings.push('Some layers could not be reconstructed — the flattened image was used instead.');
      built = [];
    }
  }

  if (built.length) {
    doc.layers = built;
    const last = built[built.length - 1];
    if (last && last.type === LayerType.RASTER && /^background$/i.test(last.name)) {
      last.isBackground = true;
      last.locked = { ...last.locked, position: true };
    }
  } else {
    // Fall back to the flattened composite stored at the end of the file.
    const canvas = await readCompositeImage(arrayBuffer, mergedStart, ctx);
    if (!canvas) {
      throw new Error(
        'This PSD has no flattened copy inside it — it was saved with '
        + '"Maximize Compatibility" turned off — and its layers could not be '
        + 'rebuilt, so there is nothing to open. Re-saving it from Photoshop with '
        + 'that option on will fix it.',
      );
    }
    const bg = new Layer({ type: LayerType.RASTER, name: 'Background', canvas });
    bg.isBackground = true;
    bg.locked = { ...bg.locked, position: true };
    doc.layers = [bg];
  }

  applyDocumentExtras(doc, arrayBuffer, mergedStart, ctx, resources);

  const flat = doc.flatLayers();
  doc.activeLayerId = flat.length ? flat[0].id : null;
  doc.selectedLayerIds = doc.activeLayerId ? [doc.activeLayerId] : [];
  doc.history.clear('Open');
  doc.dirty = false;

  if (ctx.skipped.size) {
    const names = [...ctx.skipped].slice(0, 4).join(', ');
    const more = ctx.skipped.size > 4 ? ` and ${ctx.skipped.size - 4} more` : '';
    app.toast(`ZIP-compressed channels could not be decoded on: ${names}${more}`, 'warn', 6000);
  }
  for (const w of ctx.warnings) app.toast(w, 'warn', 5000);

  return doc;
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch (err) {
    console.warn('[psd]', err);
    return fallback;
  }
}

/**
 * Everything that belongs to the document rather than to a single layer: the
 * guides, the vector paths, the saved alpha channels — and the live selection,
 * which travels as one of those channels (see `SELECTION_CHANNEL_NAME`).
 */
function applyDocumentExtras(doc, buf, mergedStart, ctx, resources) {
  doc.guides = (resources.guides || []).filter((g) => g && Number.isFinite(g.pos));

  doc.paths = (resources.paths || []).map((p, i) => {
    let name = p.name;
    if (!name && i === 0 && resources.clippingPathName) name = resources.clippingPathName;
    return { id: uid('path'), name: name || `Path ${i + 1}`, subpaths: p.subpaths };
  });

  const channels = safe(() => readAlphaChannels(buf, mergedStart, ctx, resources.alphaNames || []), []);
  for (const ch of channels) {
    if (ch.name === SELECTION_CHANNEL_NAME) {
      const mask = new Uint8ClampedArray(doc.width * doc.height);
      mask.set(ch.plane.subarray(0, mask.length));
      doc.selection.set(mask);
      continue;
    }
    doc.alphaChannels.push({ id: ch.id, name: ch.name, canvas: ch.canvas });
  }
}

/* ------------------------------------------------------------------ */
/* Image resources                                                     */
/* ------------------------------------------------------------------ */

function parseImageResources(r, ctx) {
  const out = { alphaNames: [], guides: [], paths: [] };
  while (r.remaining >= 12) {
    const sig = r.readString(4);
    if (sig !== '8BIM') break;
    const id = r.readUint16();
    const name = r.readPascalString(2);
    const size = r.readUint32();
    const dataStart = r.tell();
    if (id === 1005) {
      // ResolutionInfo: horizontal DPI as 16.16 fixed point.
      const hRes = r.readFixed32();
      if (hRes > 0 && hRes < 100000) out.resolution = Math.round(hRes * 100) / 100;
    } else if (id === 1006) {
      out.alphaNames = safe(() => readAlphaNames(new ByteReader(r.buf, dataStart, size)), []);
    } else if (id === 1032) {
      out.guides = safe(() => readGuides(new ByteReader(r.buf, dataStart, size)), []);
    } else if (id === 1037) {
      out.globalAngle = r.readInt32();
    } else if (id >= 2000 && id <= 2997) {
      const subpaths = safe(() => readPathResource(new ByteReader(r.buf, dataStart, size), ctx), []);
      if (subpaths.length) out.paths.push({ name, subpaths });
    } else if (id === 2999) {
      out.clippingPathName = safe(() => new ByteReader(r.buf, dataStart, size).readPascalString(1), '');
    }
    r.seek(dataStart + size + (size & 1));
  }
  return out;
}

/** 1006 — packed Pascal strings, one per alpha channel, no padding. */
function readAlphaNames(r) {
  const names = [];
  while (r.remaining >= 1 && names.length < 256) {
    const name = r.readPascalString(1);
    if (!name && r.remaining <= 0) break;
    names.push(name);
  }
  return names;
}

/**
 * 1032 — the grid/guide header followed by one record per guide: a 27.5
 * fixed-point location (pixels × 32) and a direction byte, 0 = vertical.
 */
function readGuides(r) {
  const version = r.readUint32();
  if (version !== 1) return [];
  r.skip(8); // grid cycle across / down
  const count = r.readUint32();
  if (count > 8192) throw new Error('Implausible guide count');
  const guides = [];
  for (let i = 0; i < count; i++) {
    if (r.remaining < 5) break;
    const pos = r.readUint32() / 32;
    const horizontal = r.readUint8() === 1;
    if (!Number.isFinite(pos)) continue;
    guides.push({ axis: horizontal ? 'h' : 'v', pos });
  }
  return guides;
}

/* --- Vector paths (image resources 2000-2997) ---------------------- */

const PATH_FIXED_824 = 16777216; // 2^24

/** 8.24 fixed point, signed: the value is a fraction of the document size. */
function readFixed824(r) {
  return r.readInt32() / PATH_FIXED_824;
}

const PATH_EPSILON = 1e-4;

/**
 * A path resource is a flat run of 26-byte records: a uint16 selector plus 24
 * bytes of payload. Selectors 0/3 open a closed/open subpath and give its knot
 * count; 1/2 and 4/5 are the knots themselves. Everything else (fill rules,
 * clipboard records) is skipped.
 */
function readPathResource(r, ctx) {
  const width = ctx.width;
  const height = ctx.height;
  const subpaths = [];
  let current = null;
  let expected = 0;

  while (r.remaining >= 26) {
    const selector = r.readUint16();
    const end = r.tell() + 24;
    if (selector === 0 || selector === 3) {
      expected = r.readUint16();
      current = { closed: selector === 0, points: [] };
      if (expected > 0 && expected <= 32768) subpaths.push(current);
      else current = null;
    } else if (selector >= 1 && selector <= 5) {
      // A knot: preceding control point, anchor, leaving control point, each
      // stored vertical-first as a fraction of the document height / width.
      const inY = readFixed824(r) * height;
      const inX = readFixed824(r) * width;
      const y = readFixed824(r) * height;
      const x = readFixed824(r) * width;
      const outY = readFixed824(r) * height;
      const outX = readFixed824(r) * width;
      if (!current) {
        // A knot with no length record in front of it: keep the geometry
        // rather than dropping it, in an open subpath of its own.
        current = { closed: selector <= 2, points: [] };
        subpaths.push(current);
      }
      const inH = Math.abs(inX - x) > PATH_EPSILON || Math.abs(inY - y) > PATH_EPSILON ? { x: inX, y: inY } : null;
      const outH = Math.abs(outX - x) > PATH_EPSILON || Math.abs(outY - y) > PATH_EPSILON ? { x: outX, y: outY } : null;
      current.points.push({ x, y, in: inH, out: outH, corner: !inH && !outH });
      if (expected > 0 && current.points.length >= expected) current = null;
    }
    r.seek(end);
  }
  return subpaths.filter((sp) => sp.points.length);
}

/* ------------------------------------------------------------------ */
/* Layer and mask information                                          */
/* ------------------------------------------------------------------ */

function parseLayerAndMask(buf, start, length, ctx) {
  const r = new ByteReader(buf, start, length);
  const layerInfoLength = readLength(r, ctx.psb);
  const layerInfoStart = r.tell();
  let records = [];

  if (layerInfoLength > 0) {
    records = parseLayerInfo(new ByteReader(buf, layerInfoStart, layerInfoLength), ctx);
    r.seek(layerInfoStart + layerInfoLength + (layerInfoLength & 1));
  }

  // Global layer mask info.
  if (r.remaining >= 4) {
    const globalLength = r.readUint32();
    r.skip(globalLength);
  }

  // Document-level tagged blocks. 16- and 32-bit files keep their layers here.
  const globals = r.remaining >= 12 ? safe(() => parseTaggedBlocks(r, ctx), []) : [];
  if (!records.length) {
    for (const block of globals) {
      if (block.key !== 'Lr16' && block.key !== 'Lr32') continue;
      records = safe(() => parseLayerInfo(new ByteReader(buf, block.start, block.length), ctx), []);
      if (records.length) break;
    }
  }
  return { records, globals };
}

function parseLayerInfo(r, ctx) {
  const signedCount = r.readInt16();
  const count = Math.abs(signedCount);
  if (signedCount < 0) ctx.mergedHasAlpha = true;
  if (count === 0 || count > 20000) return [];

  const records = [];
  for (let i = 0; i < count; i++) records.push(parseLayerRecord(r, ctx));

  // Channel pixels follow the records, in exactly the same order.
  for (const rec of records) {
    for (const ch of rec.channels) {
      ch.start = r.tell();
      ch.end = Math.min(r.end, ch.start + ch.length);
      r.skip(ch.length);
    }
  }
  return records;
}

function parseLayerRecord(r, ctx) {
  const top = r.readInt32();
  const left = r.readInt32();
  const bottom = r.readInt32();
  const right = r.readInt32();

  const channelCount = r.readUint16();
  if (channelCount > 64) throw new Error('Implausible channel count in a layer record');
  const channels = [];
  for (let i = 0; i < channelCount; i++) {
    const id = r.readInt16();
    const length = readLength(r, ctx.psb);
    channels.push({ id, length, start: 0, end: 0 });
  }

  r.skip(4); // '8BIM'
  const blendKey = r.readString(4);
  const opacity = r.readUint8();
  const clipping = r.readUint8();
  const flags = r.readUint8();
  r.skip(1); // filler

  const extraLength = r.readUint32();
  const extraEnd = r.tell() + extraLength;

  // --- Layer mask / adjustment data.
  let mask = null;
  const maskLength = r.readUint32();
  if (maskLength >= 18) {
    const maskEnd = r.tell() + maskLength;
    const mt = r.readInt32(), ml = r.readInt32(), mb = r.readInt32(), mr = r.readInt32();
    const defaultColor = r.readUint8();
    const maskFlags = r.readUint8();
    mask = {
      top: mt, left: ml, bottom: mb, right: mr,
      defaultColor,
      relative: !!(maskFlags & 1),
      disabled: !!(maskFlags & 2),
      inverted: !!(maskFlags & 4),
    };
    r.seek(maskEnd);
  } else {
    r.skip(maskLength);
  }

  // --- Blending ranges (not modelled).
  const rangesLength = r.readUint32();
  r.skip(rangesLength);

  // --- Name (MacRoman pascal string, padded to a multiple of four).
  let name = '';
  try {
    name = r.readPascalString(4);
  } catch (err) {
    name = '';
  }

  // --- Additional layer information.
  let blocks = [];
  if (extraEnd > r.tell() + 8) {
    blocks = safe(() => parseTaggedBlocks(new ByteReader(r.buf, r.tell(), extraEnd - r.tell()), ctx), []);
  }
  r.seek(extraEnd);

  return {
    top, left, bottom, right, channels, blendKey, opacity, clipping, flags,
    mask, name, blocks,
    visible: !(flags & 2),
  };
}

function isBlockSignature(r, at) {
  const s = r.peekString(4, at);
  return s === '8BIM' || s === '8B64';
}

function parseTaggedBlocks(r, ctx) {
  const blocks = [];
  while (r.remaining >= 12) {
    if (!isBlockSignature(r, r.pos)) break;
    const blockStart = r.pos;
    r.skip(4);
    const key = r.readString(4);
    const length = ctx.psb && BIG_KEYS.has(key) ? r.readUint64() : r.readUint32();
    const dataStart = r.tell();
    if (length < 0 || dataStart + length > r.end + 4) break;
    blocks.push({ key, start: dataStart, length: Math.min(length, r.end - dataStart) });

    // Blocks are padded, but Photoshop is inconsistent about 2 vs 4 bytes.
    // Re-sync on the next signature instead of trusting a fixed padding.
    let next = dataStart + length;
    let resolved = -1;
    for (let k = 0; k < 4; k++) {
      if (next + k + 4 > r.end) break;
      if (isBlockSignature(r, next + k)) { resolved = next + k; break; }
    }
    r.seek(resolved >= 0 ? resolved : next);
    // Guard against a non-advancing cursor. This compares against the start of
    // the block, not its data, so a legitimately zero-length block (`nvrt`, for
    // one) still leaves the following blocks readable.
    if (r.pos <= blockStart) break;
  }
  return blocks;
}

/* ------------------------------------------------------------------ */
/* Channel decoding                                                    */
/* ------------------------------------------------------------------ */

/** PackBits (RLE) expansion, one scan line per entry in `counts`. */
function unpackRLE(u8, from, hardEnd, counts, rowBytes, rows) {
  const out = new Uint8Array(rowBytes * rows);
  let o = 0;
  let pos = from;
  for (let y = 0; y < rows; y++) {
    const rowEnd = Math.min(hardEnd, pos + counts[y]);
    const lineEnd = o + rowBytes;
    let p = pos;
    while (p < rowEnd && o < lineEnd) {
      const n = u8[p++];
      if (n < 128) {
        const run = n + 1;
        for (let i = 0; i < run && o < lineEnd && p < hardEnd; i++) out[o++] = u8[p++];
      } else if (n > 128) {
        const run = 257 - n;
        const v = u8[p++];
        for (let i = 0; i < run && o < lineEnd; i++) out[o++] = v;
      }
      // n === 128 is a no-op marker.
    }
    o = lineEnd;
    pos += counts[y];
  }
  return out;
}

/** Zlib/deflate via the platform DecompressionStream — no library needed. */
async function inflate(bytes) {
  if (typeof DecompressionStream === 'undefined') return null;
  const attempt = async (format) => {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  try {
    return await attempt('deflate');
  } catch (err) {
    try {
      return await attempt('deflate-raw');
    } catch (err2) {
      return null;
    }
  }
}

/** Undo the per-row delta encoding used by "ZIP with prediction". */
function undoPrediction(data, width, height, depth) {
  if (depth === 8) {
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 1; x < width; x++) data[row + x] = (data[row + x] + data[row + x - 1]) & 255;
    }
    return data;
  }
  // 16-bit: the deltas are on big-endian 16-bit samples.
  const rowBytes = width * 2;
  for (let y = 0; y < height; y++) {
    const row = y * rowBytes;
    let prev = (data[row] << 8) | data[row + 1];
    for (let x = 1; x < width; x++) {
      const i = row + x * 2;
      const v = (prev + ((data[i] << 8) | data[i + 1])) & 0xffff;
      data[i] = v >> 8;
      data[i + 1] = v & 255;
      prev = v;
    }
  }
  return data;
}

/** Normalise raw channel bytes to one 8-bit sample per pixel. */
function toSamples(raw, width, height, depth) {
  const n = width * height;
  const out = new Uint8Array(n);
  if (!raw) return out;
  if (depth === 16) {
    for (let i = 0; i < n; i++) out[i] = raw[i * 2] || 0; // high byte ≈ value / 257
  } else {
    out.set(raw.subarray(0, Math.min(n, raw.length)));
  }
  return out;
}

/**
 * Decode one channel of one layer into a `width × height` 8-bit plane.
 * Returns null when the compression scheme is not supported.
 */
async function decodeChannel(buf, ch, width, height, ctx, label) {
  if (!ch || ch.length < 2 || width <= 0 || height <= 0) return null;
  const r = new ByteReader(buf, ch.start, ch.end - ch.start);
  const compression = r.readUint16();
  const bytesPerSample = ctx.depth === 16 ? 2 : 1;
  const rowBytes = width * bytesPerSample;
  const total = rowBytes * height;

  let raw = null;
  if (compression === 0) {
    raw = r.readBytes(total);
  } else if (compression === 1) {
    const counts = new Uint32Array(height);
    for (let y = 0; y < height; y++) counts[y] = ctx.psb ? r.readUint32() : r.readUint16();
    raw = unpackRLE(r.u8, r.pos, r.end, counts, rowBytes, height);
  } else if (compression === 2 || compression === 3) {
    const inflated = await inflate(r.u8.subarray(r.pos, r.end));
    if (!inflated) {
      ctx.skipped.add(label || 'layer');
      return null;
    }
    raw = inflated.length >= total ? inflated : padTo(inflated, total);
    if (compression === 3) undoPrediction(raw, width, height, ctx.depth);
  } else {
    ctx.skipped.add(label || 'layer');
    return null;
  }
  return toSamples(raw, width, height, ctx.depth);
}

function padTo(bytes, total) {
  const out = new Uint8Array(total);
  out.set(bytes.subarray(0, Math.min(total, bytes.length)));
  return out;
}

/* ------------------------------------------------------------------ */
/* Layer reconstruction                                                */
/* ------------------------------------------------------------------ */

/**
 * Hand the event loop back for one turn.
 *
 * `await` on an already-resolved value only queues a *microtask*, which never
 * lets the browser paint or deliver input — and every await under buildLayers is
 * that kind on the raw and RLE paths, which is what Photoshop writes for 8-bit
 * files. Measured: a 4 ms interval fired zero times across a 349 ms import, so
 * the whole thing was one uninterrupted task and the busy spinner was a still
 * frame.
 *
 * `setTimeout`, and specifically not the clever alternatives, because this was
 * measured rather than assumed. Burning 12 ms twelve times over while a 4 ms
 * interval ran alongside:
 *
 *   microtask only      0 other tasks ran
 *   MessageChannel      0 other tasks ran
 *   setTimeout(0)       7 other tasks ran
 *
 * MessageChannel is the usual recommendation for a "fast macrotask", and it is
 * genuinely a macrotask — but the browser drains the whole message queue before
 * it gets back to timers, so it starves exactly the work we are yielding for.
 * `requestAnimationFrame` and `scheduler.yield()` are both worse here for a
 * different reason: neither is dependable in a hidden tab, and an import that
 * stops making progress when the user switches tabs is a far worse bug than a
 * slow one. setTimeout's 4 ms clamp is the price, and it is worth paying.
 */
let lastYieldAt = 0;

/**
 * Yield only when it would buy something, and only when it is cheap.
 *
 * Two refinements over yielding on a fixed layer count, both measured:
 *
 * **On a time budget, not a counter.** A yield every N layers makes a small file
 * pay for a problem it does not have. Yielding only once ~16 ms of work has piled
 * up means a quick import barely yields at all while a heavy one hands the
 * browser roughly a frame's worth of breathing room, which is all it needs.
 *
 * **Not at all when the tab is hidden.** `setTimeout` is throttled to about once
 * a second in a background tab: a 41-layer import that took 172 ms visible took
 * 5.0 s hidden, purely in yields. But a hidden tab has nothing to paint and no
 * input to deliver, so the yield was buying nothing in exchange — the right move
 * is to run flat out and let it finish sooner. Switching tabs mid-import now
 * makes it faster rather than thirty times slower.
 */
function maybeYield() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return null;
  const now = performance.now();
  if (now - lastYieldAt < 16) return null;
  lastYieldAt = now;
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

async function buildLayers(records, doc, ctx) {
  // The file stores layers bottom-first. Section dividers arrive as a closing
  // marker (type 3) before the children and the folder itself (type 1/2) after
  // them, so a simple stack rebuilds the tree in one pass.
  const stack = [];
  let current = [];
  lastYieldAt = performance.now();

  for (const rec of records) {
    const breather = maybeYield();
    if (breather) await breather;
    const info = interpretBlocks(rec, ctx);
    const divider = info.sectionType;

    if (divider === 3) {
      stack.push(current);
      current = [];
      continue;
    }

    if (divider === 1 || divider === 2) {
      const group = createGroupLayer(info.name || rec.name || 'Group');
      applyCommon(group, rec, info);
      group.blendMode = info.sectionBlend || (rec.blendKey === 'norm' ? 'pass-through' : blendIdOf(rec.blendKey));
      group.expanded = divider === 1;
      group.children = current.slice().reverse();
      for (const child of group.children) child.parent = group;
      await attachMask(group, rec, doc, ctx);
      current = stack.length ? stack.pop() : [];
      current.push(group);
      continue;
    }

    const layer = await buildLeafLayer(rec, info, doc, ctx);
    if (layer) current.push(layer);
  }

  while (stack.length) {
    const outer = stack.pop();
    outer.push(...current);
    current = outer;
  }
  return current.reverse();
}

function blendIdOf(key) {
  return BLEND_KEYS[key] || 'normal';
}

/** A closed rectangular subpath in the vector model used by src/vector/path.js. */
function rectSubpaths(x, y, w, h) {
  const pt = (px, py) => ({ x: px, y: py, in: null, out: null, corner: true });
  return [{ closed: true, points: [pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)] }];
}

/** True when every pixel of a canvas is fully transparent. */
function isBlankCanvas(canvas) {
  if (!canvas || !canvas.width || !canvas.height) return true;
  const d = canvas.getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false;
  return true;
}

/**
 * Re-render a live text or shape layer from its own model — that is what makes
 * it editable rather than a picture of itself.
 *
 * When the re-render comes out empty although the file did carry pixels (a font
 * we cannot load, a geometry we cannot rebuild) the stored raster is kept and
 * the user is told, rather than the layer silently disappearing.
 */
/**
 * One blank canvas, shared by every layer in this file that has no pixels.
 *
 * Photoshop writes an unpainted layer as a zero-size rect with four empty
 * channels — eight bytes — and every fill layer (solid, gradient, pattern) is
 * stored the same way, as an empty pixel rect plus a descriptor. Pikado was
 * answering each of those with its own document-sized canvas: measured, 40 such
 * layers at 1200x900 cost 164.8 MB, and at 4000x3000 each one is 48 MB of
 * provably transparent pixels for 8 bytes of file.
 *
 * Sharing is safe because `Layer.beginEdit()` clones `this.canvas`
 * unconditionally before any write (src/core/layer.js:124), so a layer stops
 * sharing the moment anyone paints on it. Only the layers nobody touches keep
 * pointing at the one blank, which is exactly the set worth not paying for.
 */
function blankFor(doc, ctx) {
  const b = ctx.blank;
  if (b && b.width === doc.width && b.height === doc.height) return b;
  ctx.blank = createCanvas(doc.width, doc.height);
  return ctx.blank;
}

function revive(layer, stored, render, ctx, label) {
  const out = render();
  if (isBlankCanvas(out) && stored && !isBlankCanvas(stored)) {
    layer.canvas = stored;
    layer.thumbDirty = true;
    ctx.warnings.push(`"${label}" could not be re-rendered from its live data — the stored pixels were kept.`);
    return;
  }
  layer.canvas = out;
  layer.thumbDirty = true;
}

/** A pattern fill carries a live tile, which no file format can hold. */
function attachPatternCanvas(fill) {
  if (!fill || typeof fill !== 'object' || fill.type !== 'pattern' || fill.canvas) return fill;
  const entry = fill.patternId ? getPattern(fill.patternId) : null;
  if (entry) return { ...fill, canvas: entry.canvas };
  console.warn(`[psd] the pattern "${fill.patternId || ''}" is not in this library; the shape keeps its geometry but loses its tile`);
  return { ...fill, type: 'solid', color: fill.color || '#808080' };
}

/** `layer.shape` restored from the private `pkSh` payload. */
function restorePrivateShape(shape) {
  const out = { ...shape };
  if (!Array.isArray(out.subpaths)) out.subpaths = [];
  out.fill = attachPatternCanvas(out.fill);
  return out;
}

/** The fill half of a shape layer, from its `SoCo` / `GdFl` / `PtFl` block. */
function shapeFillOf(info) {
  if (info.vectorStroke && info.vectorStroke.fillEnabled === false) return 'none';
  const f = info.fill;
  if (!f) return { type: 'solid', color: '#000000' };
  if (f.fillKind === 'gradient') {
    return { type: f.style === 'radial' ? 'radial' : 'linear', stops: f.stops, angle: f.angle };
  }
  if (f.fillKind === 'pattern') {
    return attachPatternCanvas({ type: 'pattern', patternId: f.patternId, scale: f.scale });
  }
  return { type: 'solid', color: f.color || '#000000' };
}

/** `layer.shape` rebuilt from the interoperable `vmsk` / fill / `vstk` blocks. */
function vectorShapeOf(info, doc) {
  const mask = info.vectorMask;
  const subpaths = mask && mask.subpaths.length ? mask.subpaths : rectSubpaths(0, 0, doc.width, doc.height);
  const s = info.vectorStroke;
  const stroke = s && s.enabled && s.width > 0
    ? {
      enabled: true,
      color: info.vectorStrokeColor || s.color,
      width: s.width,
      align: s.align,
      cap: s.cap,
      join: s.join,
      miterLimit: s.miterLimit,
      dash: s.dash,
    }
    : { enabled: false, color: '#000000', width: 1, align: 'center', cap: 'butt', join: 'miter', dash: 'solid' };
  const shape = { kind: 'shape', subpaths, fill: shapeFillOf(info), stroke };
  applyOrigination(shape, info.vectorOrigination);
  return shape;
}

/**
 * Fold a `vogk` origination block back onto the live-shape keys our tools read,
 * so a reopened polygon still knows it has five sides and a reopened line still
 * knows its weight. Geometry always comes from the path — these are the
 * parameters the path cannot carry.
 */
function applyOrigination(shape, origin) {
  if (!origin) return;

  if (origin.corners && origin.corners.some((v) => v > 0)) {
    shape.corners = origin.corners;
    // Our `radius` is the one uniform value the Rounded Rectangle tool edits;
    // four different corners have no single number to stand for them.
    if (origin.corners.every((v) => v === origin.corners[0])) shape.radius = origin.corners[0];
  }

  if (origin.sides != null) {
    shape.sides = origin.sides;
    shape.star = !!origin.star;
    shape.innerRadius = origin.innerRadius;
    shape.smoothCorners = !!origin.smoothCorners;
  }

  if (origin.weight != null && origin.weight > 0) {
    shape.weight = origin.weight;
    // Only claim arrowheads when the file says so; a plain line must not gain a
    // pair of them on the way back in.
    if (origin.arrowStart || origin.arrowEnd) {
      shape.arrowStart = !!origin.arrowStart;
      shape.arrowEnd = !!origin.arrowEnd;
      shape.arrowWidth = origin.arrowWidth;
      shape.arrowLength = origin.arrowLength;
      shape.concavity = origin.concavity;
    }
  }
}

function applyCommon(layer, rec, info) {
  layer.name = info.name || rec.name || layer.name;
  layer.visible = rec.visible;
  layer.opacity = rec.opacity / 255;
  layer.clipped = rec.clipping === 1;
  if (info.fillOpacity != null) layer.fillOpacity = info.fillOpacity;
  if (info.styles) layer.styles = info.styles;
  if (info.colorLabel) layer.colorLabel = info.colorLabel;
  if (info.layerId != null) layer.psdLayerId = info.layerId;
}

async function buildLeafLayer(rec, info, doc, ctx) {
  const width = rec.right - rec.left;
  const height = rec.bottom - rec.top;
  const label = info.name || rec.name || 'layer';

  let canvas = null;
  let tile = null;
  if (width > 0 && height > 0 && width * height <= 200e6) {
    const planes = {};
    for (const ch of rec.channels) {
      if (ch.id === -2 || ch.id === -3) continue;
      planes[ch.id] = await decodeChannel(ctx.buf, ch, width, height, ctx, label);
    }
    const gray = ctx.colorMode === 1;
    const R = planes[0];
    const G = gray ? planes[0] : planes[1];
    const B = gray ? planes[0] : planes[2];
    const A = planes[-1];
    if (R || G || B || A) {
      const img = new ImageData(width, height);
      const d = img.data;
      for (let p = 0, i = 0; p < width * height; p++, i += 4) {
        d[i] = R ? R[p] : 0;
        d[i + 1] = G ? G[p] : 0;
        d[i + 2] = B ? B[p] : 0;
        d[i + 3] = A ? A[p] : 255;
      }
      /*
       * Kept at its natural size rather than expanded to the document.
       *
       * This is the whole point: a PSD already stores each layer as a small tile
       * plus where it sits, and expanding that to a document-sized buffer was
       * throwing the compactness away. A 120x120 layer in a 1600x1200 document
       * costs 133x less this way, and the compositor draws it at its offset
       * without ever expanding it.
       */
      const tileCanvas = createCanvas(width, height);
      tileCanvas.getContext('2d').putImageData(img, 0, 0);
      tile = { canvas: tileCanvas, x: rec.left, y: rec.top, docWidth: doc.width, docHeight: doc.height };
    }
  }

  let layer;
  if (info.adjustment) {
    layer = new Layer({ type: LayerType.ADJUSTMENT, name: label, adjustment: info.adjustment });
  } else if (info.text) {
    layer = new Layer({ type: LayerType.TEXT, name: label, canvas: canvas || (tile ? null : blankFor(doc, ctx)), tile });
    layer.text = info.text;
    revive(layer, canvas, () => rasterizeTextLayer(layer, doc), ctx, label);
  } else if (info.shape || info.vectorMask) {
    layer = new Layer({ type: LayerType.SHAPE, name: label, canvas: canvas || (tile ? null : blankFor(doc, ctx)), tile });
    layer.shape = info.shape ? restorePrivateShape(info.shape) : vectorShapeOf(info, doc);
    revive(layer, canvas, () => rasterizeShapeLayer(layer, doc), ctx, label);
  } else if (info.fill) {
    layer = new Layer({ type: LayerType.SHAPE, name: label, canvas: canvas || (tile ? null : blankFor(doc, ctx)), tile });
    // Fill layers cover the whole canvas; giving them explicit geometry keeps
    // them re-rasterisable if the user edits the fill later.
    layer.shape = { ...info.fill, subpaths: rectSubpaths(0, 0, doc.width, doc.height) };
  } else {
    layer = new Layer({ type: LayerType.RASTER, name: label, canvas: canvas || (tile ? null : blankFor(doc, ctx)), tile });
  }

  applyCommon(layer, rec, info);
  layer.blendMode = blendIdOf(rec.blendKey) === 'pass-through' ? 'normal' : blendIdOf(rec.blendKey);
  await attachMask(layer, rec, doc, ctx);
  return layer;
}

/** Rebuild a user layer mask as a document-sized greyscale canvas. */
async function attachMask(layer, rec, doc, ctx) {
  const m = rec.mask;
  if (!m) return;
  const channel = rec.channels.find((c) => c.id === -2) || rec.channels.find((c) => c.id === -3);
  if (!channel) return;
  const mw = m.right - m.left;
  const mh = m.bottom - m.top;

  const canvas = createCanvas(doc.width, doc.height);
  const c = canvas.getContext('2d');
  c.fillStyle = m.defaultColor >= 128 ? '#ffffff' : '#000000';
  c.fillRect(0, 0, doc.width, doc.height);

  if (mw > 0 && mh > 0 && mw * mh <= 200e6) {
    const plane = await decodeChannel(ctx.buf, channel, mw, mh, ctx, layer.name);
    if (plane) {
      const img = new ImageData(mw, mh);
      const d = img.data;
      for (let p = 0, i = 0; p < mw * mh; p++, i += 4) {
        const v = plane[p];
        d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
      }
      const tile = createCanvas(mw, mh);
      tile.getContext('2d').putImageData(img, 0, 0);
      c.drawImage(tile, m.left, m.top);
    }
  }

  layer.mask = canvas;
  layer.maskEnabled = !m.disabled;
  layer.maskInverted = !!m.inverted;
  // "Position relative to layer" is the inverse of the link toggle.
  layer.maskLinked = !m.relative;
  layer.touchMask();
}

/* ------------------------------------------------------------------ */
/* Additional layer information                                        */
/* ------------------------------------------------------------------ */

function interpretBlocks(rec, ctx) {
  const info = { sectionType: 0 };
  for (const block of rec.blocks) {
    const r = () => new ByteReader(ctx.buf, block.start, block.length);
    switch (block.key) {
      case 'luni':
        safe(() => { info.name = r().readUnicodeString(); });
        break;
      case 'lsct':
      case 'lsdk': {
        safe(() => {
          const b = r();
          info.sectionType = b.readUint32();
          if (block.length >= 12) {
            b.skip(4);
            info.sectionBlend = blendIdOf(b.readString(4));
          }
        });
        break;
      }
      case 'lyid':
        safe(() => { info.layerId = r().readUint32(); });
        break;
      case 'lclr':
        safe(() => { info.colorLabel = LAYER_COLOR_LABELS[r().readUint16()] || null; });
        break;
      case 'iOpa':
        safe(() => { info.fillOpacity = r().readUint8() / 255; });
        break;
      case 'lfx2':
      case 'lmfx':
        safe(() => {
          const styles = readEffectsDescriptor(r());
          if (styles) {
            info.styles = styles;
            info.stylesFromDescriptor = true;
          }
        });
        break;
      case 'lrFX':
        // The Photoshop 5 block is a strict subset of what 'lfx2' carries, so
        // it only ever fills in for a layer that has no descriptor effects.
        if (!info.stylesFromDescriptor) safe(() => { info.styles = readLegacyEffects(r()) || info.styles; });
        break;
      case 'SoCo':
      case 'GdFl':
      case 'PtFl':
        safe(() => { info.fill = readFillLayer(r(), block.key); });
        break;
      case 'TySh':
      case 'TxLr':
        if (!info.textPrivate) safe(() => { info.text = readTypeTool(r()); });
        break;
      case 'tySh':
        if (!info.textPrivate) safe(() => { info.text = readLegacyTypeTool(r()); });
        break;
      case 'vmsk':
      case 'vsms':
        safe(() => { info.vectorMask = readVectorMask(r(), ctx); });
        break;
      case 'vstk':
        safe(() => { info.vectorStroke = readVectorStroke(r()); });
        break;
      case 'vscg':
        safe(() => { info.vectorStrokeColor = readVectorStrokeContent(r()); });
        break;
      case 'vogk':
        safe(() => { info.vectorOrigination = readVectorOrigination(r()); });
        break;
      case PIKADO_TEXT_KEY:
        safe(() => {
          const payload = readPikadoPayload(r(), PIKADO_TEXT_MAGIC);
          if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
            info.text = textPayload(payload);
            info.textPrivate = true;
          }
        });
        break;
      case PIKADO_SHAPE_KEY:
        safe(() => {
          const payload = readPikadoPayload(r(), PIKADO_SHAPE_MAGIC);
          if (payload && Array.isArray(payload.subpaths) && payload.subpaths.length) {
            info.shape = payload;
            info.shapePrivate = true;
          }
        });
        break;
      case PIKADO_ADJUSTMENT_KEY:
        safe(() => {
          const decoded = readPikadoAdjustment(r());
          if (decoded) {
            info.adjustment = decoded;
            info.adjustmentPrivate = true;
          }
        });
        break;
      default: {
        const adjustment = ADJUSTMENT_KEYS[block.key];
        // The private block is authoritative — it round trips every kind and
        // every parameter, where the legacy binary keys cover neither.
        if (adjustment && !info.adjustmentPrivate) {
          const params = safe(() => readAdjustment(block.key, r()), null);
          info.adjustment = { kind: adjustment, params: params || {} };
        }
        break;
      }
    }
  }
  return info;
}

/* ------------------------------------------------------------------ */
/* Adjustment blocks                                                   */
/* ------------------------------------------------------------------ */

/**
 * Translate one adjustment tagged block into the exact parameter object the
 * matching entry in `src/adjustments/*` expects. Getting the key names right
 * matters more than covering exotic blocks: a mismatch renders as "no effect".
 */
function readAdjustment(key, r) {
  switch (key) {
    case 'nvrt':
      return {};
    case 'thrs':
      return { level: clamp(r.readUint16(), 1, 255) };
    case 'post':
      return { levels: clamp(r.readUint16(), 2, 255) };
    case 'brit': {
      const brightness = r.readInt16();
      const contrast = r.readInt16();
      return { brightness, contrast, useLegacy: false };
    }
    case 'levl':
      return readLevels(r);
    case 'curv':
      return readCurves(r);
    case 'hue2':
      return readHueSaturation(r);
    case 'blnc': {
      const out = {};
      for (const tone of ['shadows', 'midtones', 'highlights']) {
        for (const axis of ['CR', 'MG', 'YB']) out[`${tone}${axis}`] = r.readInt16();
      }
      out.preserveLuminosity = r.remaining >= 1 ? r.readUint8() === 1 : true;
      return out;
    }
    case 'mixr':
      return readChannelMixer(r);
    case 'vibA': {
      const d = readDescriptorBlock(r);
      const it = (d && d.items) || {};
      return { vibrance: numberOf(it.vibrance, 0), saturation: numberOf(it.Strt, 0) };
    }
    case 'blwh': {
      const d = readDescriptorBlock(r);
      const it = (d && d.items) || {};
      return {
        reds: numberOf(it['Rd  '], 40), yellows: numberOf(it.Yllw, 60),
        greens: numberOf(it['Grn '], 40), cyans: numberOf(it['Cyn '], 60),
        blues: numberOf(it['Bl  '], 20), magentas: numberOf(it.Mgnt, 80),
        tint: it.useTint === true, tintColor: colorFromDescriptor(it.tintColor) || '#d9b48f',
      };
    }
    case 'phfl': {
      const version = r.readUint16();
      let color = '#ec8a00';
      if (version === 3) {
        r.skip(16); // XYZ colour — not worth converting, the default reads well
      } else {
        r.readUint16(); // colour space
        const comps = [r.readUint16(), r.readUint16(), r.readUint16(), r.readUint16()];
        color = hexOf(comps[0] / 257, comps[1] / 257, comps[2] / 257);
      }
      const density = r.remaining >= 4 ? clamp(r.readUint32(), 1, 100) : 25;
      const preserveLuminosity = r.remaining >= 1 ? r.readUint8() === 1 : true;
      // 'Custom' makes the adjustment use our `color` rather than a named preset.
      return { filter: 'Custom', color, density, preserveLuminosity };
    }
    case 'selc':
      return readSelectiveColor(r);
    case 'grdm':
      return readGradientMap(r);
    default:
      return {};
  }
}

function identityCurve() {
  return [{ x: 0, y: 0 }, { x: 255, y: 255 }];
}

/** One 10-byte Levels record. */
function readLevelRecord(r) {
  const ib = r.readUint16();
  const iw = r.readUint16();
  const ob = r.readUint16();
  const ow = r.readUint16();
  const gamma = r.readUint16();
  return { ib, iw, ob, ow, ig: gamma > 0 ? gamma / 100 : 1 };
}

/** 'levl' holds 29 channel records; for RGB the first four are the ones we use. */
function readLevels(r) {
  r.readUint16(); // version (= 2)
  const levels = { channel: 'rgb' };
  for (const ch of ['rgb', 'r', 'g', 'b']) {
    if (r.remaining < 10) break;
    levels[ch] = readLevelRecord(r);
  }
  return { levels };
}

/** 'curv': a channel bit set followed by one point list per selected channel. */
function readCurves(r) {
  const curves = { channel: 'rgb', rgb: identityCurve(), r: identityCurve(), g: identityCurve(), b: identityCurve() };
  r.readUint8(); // padding
  const version = r.readUint16();
  if (version !== 1 && version !== 4) return { curves };
  const channelBits = r.readUint32();
  const order = ['rgb', 'r', 'g', 'b'];
  for (let bit = 0; bit < 16; bit++) {
    if (!(channelBits & (1 << bit))) continue;
    if (r.remaining < 2) break;
    const count = r.readUint16();
    if (count < 2 || count > 19 || r.remaining < count * 4) break;
    const points = [];
    for (let i = 0; i < count; i++) {
      const output = r.readUint16();
      const input = r.readUint16();
      points.push({ x: Math.min(255, input), y: Math.min(255, output) });
    }
    points.sort((a, b) => a.x - b.x);
    if (order[bit]) curves[order[bit]] = points;
  }
  return { curves };
}

/**
 * 'hue2': colorize settings, the master band, then the six hue bands in the
 * same order our adjustment uses (reds → magentas).
 */
function readHueSaturation(r) {
  r.readUint16(); // version (= 2)
  const colorize = r.readUint8() === 1;
  r.readUint8(); // padding
  const out = {
    colorize,
    colorizeHue: ((r.readInt16() % 360) + 360) % 360,
    colorizeSat: r.readInt16(),
    colorizeLight: r.readInt16(),
  };
  const bands = ['master', 'reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'];
  for (const id of bands) {
    // Every band except the master is preceded by its four hue boundaries.
    if (id !== 'master') {
      if (r.remaining < 14) break;
      r.skip(8);
    } else if (r.remaining < 6) break;
    out[`${id}Hue`] = r.readInt16();
    out[`${id}Sat`] = r.readInt16();
    out[`${id}Light`] = r.readInt16();
  }
  return out;
}

/** 'mixr': four 5-short rows. Row 0 is the grey row in monochrome mode. */
function readChannelMixer(r) {
  r.readUint16(); // version (= 1)
  const monochrome = r.readUint16() === 1;
  const rows = [];
  while (rows.length < 4 && r.remaining >= 10) {
    rows.push([r.readInt16(), r.readInt16(), r.readInt16(), r.readInt16(), r.readInt16()]);
  }
  const out = {
    monochrome, outputChannel: 'red',
    redR: 100, redG: 0, redB: 0, redC: 0,
    greenR: 0, greenG: 100, greenB: 0, greenC: 0,
    blueR: 0, blueG: 0, blueB: 100, blueC: 0,
    grayR: 40, grayG: 40, grayB: 20, grayC: 0,
  };
  const put = (prefix, row) => {
    if (!row) return;
    out[`${prefix}R`] = row[0];
    out[`${prefix}G`] = row[1];
    out[`${prefix}B`] = row[2];
    out[`${prefix}C`] = row[4];
  };
  if (monochrome) put('gray', rows[0]);
  else { put('red', rows[0]); put('green', rows[1]); put('blue', rows[2]); }
  return out;
}

/**
 * 'selc': nine 8-byte CMYK records. Writers disagree about a reserved word and
 * a leading reserved record, so the layout is derived from the bytes present.
 */
function readSelectiveColor(r) {
  r.readUint16(); // version (= 1)
  const method = r.readUint16() === 1 ? 'absolute' : 'relative';
  if (r.remaining % 8 === 2) r.skip(2);
  if (r.remaining >= 80) r.skip(8); // leading reserved record
  const out = { method, color: 'reds' };
  for (const g of ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks']) {
    if (r.remaining < 8) break;
    out[`${g}C`] = r.readInt16();
    out[`${g}M`] = r.readInt16();
    out[`${g}Y`] = r.readInt16();
    out[`${g}K`] = r.readInt16();
  }
  return out;
}

/** 'grdm': the gradient-map ramp. Transparency stops are left fully opaque. */
function readGradientMap(r) {
  const gradient = {
    stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }],
    opacityStops: [{ pos: 0, opacity: 1 }, { pos: 1, opacity: 1 }],
  };
  r.readUint16(); // version
  const reverse = r.readUint8() === 1;
  const dither = r.readUint8() === 1;
  try {
    r.readUnicodeString(); // gradient name
    const count = r.readUint16();
    if (count >= 2 && count <= 64) {
      const stops = [];
      for (let i = 0; i < count; i++) {
        const location = r.readUint32();
        r.readUint32(); // midpoint
        r.readUint16(); // colour space
        const comps = [r.readUint16(), r.readUint16(), r.readUint16(), r.readUint16()];
        r.skip(2); // stop mode
        stops.push({ pos: clamp(location / 4096, 0, 1), color: hexOf(comps[0] / 257, comps[1] / 257, comps[2] / 257) });
      }
      stops.sort((a, b) => a.pos - b.pos);
      gradient.stops = stops;
    }
  } catch (err) {
    // Keep whatever was decoded — a black-to-white ramp is a usable fallback.
  }
  return { gradient, reverse, dither };
}

/* ------------------------------------------------------------------ */
/* Photoshop descriptors                                               */
/* ------------------------------------------------------------------ */

function readDescriptorBlock(r) {
  r.readUint32(); // descriptor version (16)
  return readDescriptor(r);
}

function readDescriptor(r) {
  const name = r.readUnicodeString();
  const classID = r.readKeyId();
  const count = r.readUint32();
  if (count > 4096) throw new Error('Implausible descriptor item count');
  const items = {};
  for (let i = 0; i < count; i++) {
    const key = r.readKeyId();
    items[key] = readDescriptorValue(r);
  }
  return { name, classID, items };
}

function readDescriptorValue(r) {
  const type = r.readString(4);
  switch (type) {
    case 'Objc':
    case 'GlbO':
      return readDescriptor(r);
    case 'VlLs': {
      const n = r.readUint32();
      if (n > 65536) throw new Error('Implausible descriptor list length');
      const list = [];
      for (let i = 0; i < n; i++) list.push(readDescriptorValue(r));
      return list;
    }
    case 'doub': return r.readDouble();
    case 'UntF': { const unit = r.readString(4); return { unit, value: r.readDouble() }; }
    case 'TEXT': return r.readUnicodeString();
    case 'enum': { const enumType = r.readKeyId(); return { enumType, value: r.readKeyId() }; }
    case 'long': return r.readInt32();
    case 'comp': return r.readUint64();
    case 'bool': return r.readUint8() === 1;
    case 'type':
    case 'GlbC': { const cname = r.readUnicodeString(); return { name: cname, classID: r.readKeyId() }; }
    case 'alis': { const n = r.readUint32(); r.skip(n); return null; }
    case 'tdta': { const n = r.readUint32(); return { raw: r.readBytes(n) }; }
    case 'obj ': {
      const n = r.readUint32();
      const refs = [];
      for (let i = 0; i < n; i++) refs.push(readReference(r));
      return refs;
    }
    default:
      throw new Error(`Unsupported descriptor type "${type}"`);
  }
}

function readReference(r) {
  const type = r.readString(4);
  switch (type) {
    case 'prop': { r.readUnicodeString(); r.readKeyId(); return { key: r.readKeyId() }; }
    case 'Clss': { r.readUnicodeString(); return { classID: r.readKeyId() }; }
    case 'Enmr': { r.readUnicodeString(); r.readKeyId(); r.readKeyId(); return { value: r.readKeyId() }; }
    case 'rele': { r.readUnicodeString(); r.readKeyId(); return { offset: r.readUint32() }; }
    case 'Idnt': return { identifier: r.readUint32() };
    case 'indx': return { index: r.readUint32() };
    case 'name': { r.readUnicodeString(); r.readKeyId(); return { name: r.readUnicodeString() }; }
    default:
      throw new Error(`Unsupported reference type "${type}"`);
  }
}

function numberOf(v, fallback = 0) {
  if (typeof v === 'number') return v;
  if (v && typeof v.value === 'number') return v.value;
  return fallback;
}

function hexOf(r, g, b) {
  const to = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

function colorFromDescriptor(d) {
  if (!d || !d.items) return null;
  const it = d.items;
  if (d.classID === 'RGBC' || ('Rd  ' in it)) {
    return hexOf(numberOf(it['Rd  ']), numberOf(it['Grn ']), numberOf(it['Bl  ']));
  }
  if (d.classID === 'Grsc' || ('Gry ' in it)) {
    const v = 255 - (numberOf(it['Gry ']) / 100) * 255;
    return hexOf(v, v, v);
  }
  if ('H   ' in it) {
    // HSB descriptor: convert through a temporary canvas-free formula.
    const h = numberOf(it['H   ']) / 360, s = numberOf(it.Strt) / 100, v = numberOf(it.Brgh) / 100;
    const i = Math.floor(h * 6), f = h * 6 - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    const rgb = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6] || [0, 0, 0];
    return hexOf(rgb[0] * 255, rgb[1] * 255, rgb[2] * 255);
  }
  return null;
}

function blendFromEnum(v, fallback = 'normal') {
  if (!v || !v.value) return fallback;
  return BLEND_ENUMS[v.value] || fallback;
}

/* ------------------------------------------------------------------ */
/* Layer effects                                                       */
/* ------------------------------------------------------------------ */

/**
 * Every style we produce is layered onto `DEFAULT_STYLES` so the effect
 * renderers always see a complete configuration, whatever the file omitted.
 */
function styleFrom(id, over) {
  return { ...structuredClone(DEFAULT_STYLES[id]), ...over, enabled: over.enabled !== false };
}

/**
 * Photoshop stores spread, choke and noise as percentages; our effect
 * renderers want the 0..1 fractions the Layer Style dialog produces.
 */
function fractionOf(v, fallback = 0) {
  return clamp(numberOf(v, fallback) / 100, 0, 1);
}

function readEffectsDescriptor(r) {
  r.readUint32(); // object effects version
  const d = readDescriptorBlock(r);
  const it = d.items || {};
  if (it.masterFXSwitch === false) return null;
  const styles = {};

  const common = (fx, extra = {}) => ({
    enabled: fx.items.enab !== false,
    color: colorFromDescriptor(fx.items['Clr ']) || '#000000',
    opacity: numberOf(fx.items.Opct, 75) / 100,
    blendMode: blendFromEnum(fx.items['Md  ']),
    noise: fractionOf(fx.items.Nose, 0),
    ...extra,
  });

  if (it.DrSh) {
    styles.dropShadow = common(it.DrSh, {
      angle: numberOf(it.DrSh.items.lagl, 120),
      useGlobalLight: it.DrSh.items.uglg !== false,
      distance: numberOf(it.DrSh.items.Dstn, 5),
      spread: fractionOf(it.DrSh.items.Ckmt, 0),
      size: numberOf(it.DrSh.items.blur, 5),
      blendMode: blendFromEnum(it.DrSh.items['Md  '], 'multiply'),
    });
  }
  if (it.IrSh) {
    styles.innerShadow = common(it.IrSh, {
      angle: numberOf(it.IrSh.items.lagl, 120),
      useGlobalLight: it.IrSh.items.uglg !== false,
      distance: numberOf(it.IrSh.items.Dstn, 5),
      choke: fractionOf(it.IrSh.items.Ckmt, 0),
      size: numberOf(it.IrSh.items.blur, 5),
      blendMode: blendFromEnum(it.IrSh.items['Md  '], 'multiply'),
    });
  }
  if (it.OrGl) {
    styles.outerGlow = common(it.OrGl, {
      spread: fractionOf(it.OrGl.items.Ckmt, 0),
      size: numberOf(it.OrGl.items.blur, 10),
      blendMode: blendFromEnum(it.OrGl.items['Md  '], 'screen'),
      color: colorFromDescriptor(it.OrGl.items['Clr ']) || '#ffe38a',
    });
  }
  if (it.IrGl) {
    styles.innerGlow = common(it.IrGl, {
      choke: fractionOf(it.IrGl.items.Ckmt, 0),
      size: numberOf(it.IrGl.items.blur, 10),
      source: it.IrGl.items.glwS && it.IrGl.items.glwS.value === 'SrcC' ? 'center' : 'edge',
      blendMode: blendFromEnum(it.IrGl.items['Md  '], 'screen'),
      color: colorFromDescriptor(it.IrGl.items['Clr ']) || '#ffe38a',
    });
  }
  if (it.ebbl) {
    const b = it.ebbl.items;
    const styleMap = { InrB: 'inner', OtrB: 'outer', Embs: 'emboss', PlEb: 'pillow', strokeEmboss: 'stroke' };
    const techMap = { SfBL: 'smooth', PrBL: 'chisel-hard', Slmt: 'chisel-soft' };
    styles.bevelEmboss = {
      enabled: b.enab !== false,
      style: styleMap[b.bvlS && b.bvlS.value] || 'inner',
      technique: techMap[b.bvlT && b.bvlT.value] || 'smooth',
      depth: numberOf(b.srgR, 100) / 100,
      direction: b.bvlD && b.bvlD.value === 'In  ' ? 'down' : 'up',
      size: numberOf(b.blur, 5),
      soften: numberOf(b.Sftn, 0),
      angle: numberOf(b.lagl, 120),
      altitude: numberOf(b.Lald, 30),
      useGlobalLight: b.uglg !== false,
      highlightColor: colorFromDescriptor(b.hglC) || '#ffffff',
      highlightOpacity: numberOf(b.hglO, 75) / 100,
      highlightMode: blendFromEnum(b.hglM, 'screen'),
      shadowColor: colorFromDescriptor(b.sdwC) || '#000000',
      shadowOpacity: numberOf(b.sdwO, 75) / 100,
      shadowMode: blendFromEnum(b.sdwM, 'multiply'),
    };
  }
  if (it.ChFX) {
    styles.satin = common(it.ChFX, {
      angle: numberOf(it.ChFX.items.lagl, 19),
      distance: numberOf(it.ChFX.items.Dstn, 11),
      size: numberOf(it.ChFX.items.blur, 14),
      invert: it.ChFX.items.Invr !== false,
    });
  }
  if (it.SoFi) {
    styles.colorOverlay = {
      enabled: it.SoFi.items.enab !== false,
      color: colorFromDescriptor(it.SoFi.items['Clr ']) || '#ff0000',
      opacity: numberOf(it.SoFi.items.Opct, 100) / 100,
      blendMode: blendFromEnum(it.SoFi.items['Md  ']),
    };
  }
  if (it.GrFl) {
    const g = it.GrFl.items;
    styles.gradientOverlay = {
      enabled: g.enab !== false,
      opacity: numberOf(g.Opct, 100) / 100,
      blendMode: blendFromEnum(g['Md  ']),
      angle: numberOf(g.Angl, 90),
      scale: numberOf(g['Scl '], 100) / 100,
      reverse: g.Rvrs === true,
      style: gradientStyleOf(g.Type),
      stops: gradientStops(g.Grad),
    };
  }
  if (it.patternFill) {
    styles.patternOverlay = {
      enabled: it.patternFill.items.enab !== false,
      opacity: numberOf(it.patternFill.items.Opct, 100) / 100,
      blendMode: blendFromEnum(it.patternFill.items['Md  ']),
      scale: numberOf(it.patternFill.items['Scl '], 100) / 100,
    };
    // Photoshop names a tile in the file's own pattern table, which we do not
    // read; our own writer puts a Pikado pattern id there instead. Leaving the
    // key out keeps the default tile when the id means nothing to us.
    const patternId = patternIdOf(it.patternFill.items.Ptrn);
    if (patternId) styles.patternOverlay.patternId = patternId;
  }
  if (it.FrFX) {
    const f = it.FrFX.items;
    const posMap = { OutF: 'outside', InsF: 'inside', CtrF: 'center' };
    styles.stroke = {
      enabled: f.enab !== false,
      size: numberOf(f['Sz  '], 3),
      position: posMap[f.Styl && f.Styl.value] || 'outside',
      blendMode: blendFromEnum(f['Md  ']),
      opacity: numberOf(f.Opct, 100) / 100,
      fillType: f.PntT && f.PntT.value === 'GrFl' ? 'gradient' : f.PntT && f.PntT.value === 'Ptrn' ? 'pattern' : 'color',
      color: colorFromDescriptor(f['Clr ']) || '#000000',
      stops: gradientStops(f.Grad),
      angle: numberOf(f.Angl, 90),
    };
  }

  const keys = Object.keys(styles);
  if (!keys.length) return null;
  const out = {};
  for (const id of keys) out[id] = styleFrom(id, styles[id]);
  return out;
}

/**
 * Gradient style enum. Photoshop pads the short keys out to four characters,
 * which is the form `readKeyId` hands back; the unpadded spellings are here
 * because other writers emit them.
 */
const GRADIENT_STYLES = {
  'Lnr ': 'linear', Lnr: 'linear',
  'Rdl ': 'radial', Rdl: 'radial',
  Angl: 'angle', Rflc: 'reflected', Dmnd: 'diamond',
};

function gradientStyleOf(type) {
  return (type && GRADIENT_STYLES[type.value]) || 'linear';
}

/** The Pikado pattern id inside a `Ptrn` descriptor, when we still have it. */
function patternIdOf(ptrn) {
  if (!ptrn || !ptrn.items) return null;
  const id = typeof ptrn.items.Idnt === 'string' ? ptrn.items.Idnt : null;
  if (!id) return null;
  return getPattern(id) ? id : null;
}

function gradientStops(grad) {
  const fallback = [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }];
  if (!grad || !grad.items || !Array.isArray(grad.items.Clrs)) return fallback;
  const stops = grad.items.Clrs.map((s) => ({
    pos: Math.max(0, Math.min(1, numberOf(s.items && s.items.Lctn, 0) / 4096)),
    color: colorFromDescriptor(s.items && s.items['Clr ']) || '#000000',
  }));
  return stops.length >= 2 ? stops : fallback;
}

/** Photoshop 5-era binary effects. */
function readLegacyEffects(r) {
  r.readUint16(); // version
  const count = r.readUint16();
  if (count > 32) return null;
  const styles = {};
  const readColor = () => {
    r.readUint16(); // colour space
    const c = [r.readUint16(), r.readUint16(), r.readUint16(), r.readUint16()];
    return hexOf(c[0] / 257, c[1] / 257, c[2] / 257);
  };

  for (let i = 0; i < count; i++) {
    if (r.remaining < 12) break;
    const sig = r.readString(4);
    if (sig !== '8BIM') break;
    const type = r.readString(4);
    const size = r.readUint32();
    const end = r.tell() + size;
    try {
      if (type === 'dsdw' || type === 'isdw') {
        r.readUint32();
        const blur = r.readUint16();
        r.readUint32(); // intensity
        const angle = r.readInt32() / 65536;
        const distance = r.readUint16();
        const color = readColor();
        r.skip(4);
        const blendMode = blendIdOf(r.readString(4));
        const enabled = r.readUint8() === 1;
        const useGlobalLight = r.readUint8() === 1;
        const opacity = r.readUint8() / 255;
        const shared = { enabled, color, opacity, blendMode, angle, useGlobalLight, distance, size: blur, noise: 0 };
        if (type === 'dsdw') styles.dropShadow = { ...shared, spread: 0 };
        else styles.innerShadow = { ...shared, choke: 0 };
      } else if (type === 'oglw' || type === 'iglw') {
        r.readUint32();
        const blur = r.readUint16();
        r.readUint32();
        const color = readColor();
        r.skip(4);
        const blendMode = blendIdOf(r.readString(4));
        const enabled = r.readUint8() === 1;
        const opacity = r.readUint8() / 255;
        if (type === 'oglw') styles.outerGlow = { enabled, color, opacity, blendMode, spread: 0, size: blur, noise: 0 };
        else styles.innerGlow = { enabled, color, opacity, blendMode, choke: 0, size: blur, source: 'edge', noise: 0 };
      } else if (type === 'sofi') {
        r.readUint32();
        r.skip(4);
        const blendMode = blendIdOf(r.readString(4));
        const color = readColor();
        const opacity = r.readUint8() / 255;
        const enabled = r.readUint8() === 1;
        styles.colorOverlay = { enabled, color, opacity, blendMode };
      }
    } catch (err) {
      // A malformed effect must not lose the rest of the layer.
    }
    r.seek(end);
  }
  const keys = Object.keys(styles);
  if (!keys.length) return null;
  const out = {};
  for (const id of keys) out[id] = styleFrom(id, styles[id]);
  return out;
}

/* ------------------------------------------------------------------ */
/* Fill layers and type layers                                         */
/* ------------------------------------------------------------------ */

function readFillLayer(r, key) {
  const d = readDescriptorBlock(r);
  const it = d.items || {};
  if (key === 'SoCo') {
    return { kind: 'fill', fillKind: 'solid', color: colorFromDescriptor(it['Clr ']) || '#000000' };
  }
  if (key === 'GdFl') {
    return {
      kind: 'fill', fillKind: 'gradient',
      stops: gradientStops(it.Grad),
      // `GdFl` is rendered by `makeFillStyle`, whose angle runs the other way
      // round — see `psdGradientAngle` in psd-write.js.
      angle: pikadoGradientAngle(numberOf(it.Angl, 90)),
      scale: numberOf(it['Scl '], 100) / 100,
      reverse: it.Rvrs === true,
      style: gradientStyleOf(it.Type),
    };
  }
  return {
    kind: 'fill', fillKind: 'pattern',
    scale: numberOf(it['Scl '], 100) / 100,
    patternId: patternIdOf(it.Ptrn),
  };
}

/* ------------------------------------------------------------------ */
/* Vector masks and vector strokes                                     */
/* ------------------------------------------------------------------ */

/**
 * `vmsk` / `vsms` — a vector mask: version, flags and then exactly the 26-byte
 * path records image resources 2000-2997 hold, so the same decoder is reused.
 * @returns {{subpaths:Array, invert:boolean, disabled:boolean}}
 */
function readVectorMask(r, ctx) {
  r.readUint32(); // version (3)
  const flags = r.readUint32();
  return {
    subpaths: readPathResource(r, ctx),
    invert: !!(flags & 1),
    disabled: !!(flags & 4),
  };
}

const STROKE_CAPS = {
  strokeStyleButtCap: 'butt', strokeStyleRoundCap: 'round', strokeStyleSquareCap: 'square',
};
const STROKE_JOINS = {
  strokeStyleMiterJoin: 'miter', strokeStyleRoundJoin: 'round', strokeStyleBevelJoin: 'bevel',
};
const STROKE_ALIGNS = {
  strokeStyleAlignInside: 'inside', strokeStyleAlignCenter: 'center', strokeStyleAlignOutside: 'outside',
};

function enumValue(v, table, fallback) {
  return (v && table[v.value]) || fallback;
}

/**
 * A `strokeStyleLineDashSet` back to the dash our shape model wants.
 *
 * The set is stored as multiples of the line width, which is also the unit the
 * named presets in `src/vector/path.js` are defined in — so a set that matches
 * a preset comes back as that preset's name and stays editable as one in the
 * Properties panel. Anything else becomes an explicit array in document units,
 * which `dashArrayFor` accepts directly.
 *
 * @param {number[]} multiples the raw set, in line widths
 * @param {number} width the stroke width, for the numeric fallback
 * @returns {string|number[]} a preset id, or an array of document-unit lengths
 */
function dashFromMultiples(multiples, width) {
  const set = multiples.filter((n) => Number.isFinite(n) && n > 0);
  if (!set.length) return 'solid';
  for (const [name, preset] of Object.entries(PSD_DASH_PRESETS)) {
    if (preset.length !== set.length) continue;
    // The values travel as doubles, so compare with a tolerance rather than ===.
    if (preset.every((n, i) => Math.abs(n - set[i]) < 1e-4)) return name;
  }
  return set.map((n) => n * width);
}

/**
 * `vstk` — the CS6 vector stroke descriptor, mapped onto the stroke object
 * `src/vector/path.js` rasterises. The dash set is stored as multiples of the
 * line width, and comes back as a preset name when it matches one.
 * @returns {{enabled:boolean, color:string, width:number, align:string,
 *   cap:string, join:string, miterLimit:number, dash:*, fillEnabled:boolean}}
 */
function readVectorStroke(r) {
  const d = readDescriptorBlock(r);
  const it = d.items || {};
  const width = Math.max(0, numberOf(it.strokeStyleLineWidth, 1));
  const dashSet = Array.isArray(it.strokeStyleLineDashSet) ? it.strokeStyleLineDashSet : [];
  const dash = dashFromMultiples(dashSet.map((v) => numberOf(v, 0)), width);
  const content = it.strokeStyleContent;
  return {
    enabled: it.strokeEnabled !== false,
    fillEnabled: it.fillEnabled !== false,
    color: (content && colorFromDescriptor(content.items && content.items['Clr '])) || '#000000',
    width,
    align: enumValue(it.strokeStyleLineAlignment, STROKE_ALIGNS, 'center'),
    cap: enumValue(it.strokeStyleLineCapType, STROKE_CAPS, 'butt'),
    join: enumValue(it.strokeStyleLineJoinType, STROKE_JOINS, 'miter'),
    miterLimit: numberOf(it.strokeStyleMiterLimit, 10),
    dash,
  };
}

/** `keyOriginType` -> the live shape it describes. Mirrors `ORIGIN_TYPES`. */
const ORIGIN_KINDS = { 1: 'rect', 2: 'rounded-rect', 4: 'line', 5: 'ellipse', 6: 'polygon', 9: 'custom' };

/**
 * `vogk` — vector origination data, the "live shape" parameters Photoshop keeps
 * beside the frozen path.
 *
 * The path itself is authoritative for geometry; what this block adds is the
 * handful of parameters a path cannot express, so that reopening a polygon gives
 * back a polygon with a side count rather than a decagon-shaped path. Which keys
 * are documented and which are inferred is set out in `psd-write.js`.
 *
 * @returns {{kind:string, type:number, corners:number[]|null, sides?:number,
 *   star?:boolean, innerRadius?:number, smoothCorners?:boolean, weight?:number,
 *   arrowStart?:boolean, arrowEnd?:boolean, arrowWidth?:number,
 *   arrowLength?:number, concavity?:number}|null} corners are TL, TR, BR, BL
 */
function readVectorOrigination(r) {
  r.readUint32(); // vector origination version (1)
  const d = readDescriptorBlock(r);
  const list = d.items && d.items.keyDescriptorList;
  const first = Array.isArray(list) ? list[0] : null;
  const it = (first && first.items) || {};
  if (it.keyShapeInvalidated === true) return null;

  const type = numberOf(it.keyOriginType, 0);
  const kind = ORIGIN_KINDS[type] || null;
  const radii = it.keyOriginRRectRadii && it.keyOriginRRectRadii.items;
  const corners = radii
    ? [
      numberOf(radii.topLeft, 0), numberOf(radii.topRight, 0),
      numberOf(radii.bottomRight, 0), numberOf(radii.bottomLeft, 0),
    ]
    : null;
  const out = { kind, type, corners };

  if (kind === 'polygon' && it.keyOriginPolySides != null) {
    out.sides = Math.max(3, Math.min(100, Math.round(numberOf(it.keyOriginPolySides, 5))));
    out.star = it.keyOriginPolyStar === true;
    // Prefer the ratio; the indent percentage is its complement and is only
    // there for a reader that thinks in the Polygon tool's own slider.
    const ratio = it.keyOriginPolyStarRatio != null
      ? numberOf(it.keyOriginPolyStarRatio, 0.5)
      : 1 - numberOf(it.keyOriginPolyIndent, 50) / 100;
    out.innerRadius = Math.max(0.02, Math.min(1, ratio));
    out.smoothCorners = it.keyOriginPolySmoothCorners === true;
  }

  if (kind === 'line' && it.keyOriginLineWeight != null) {
    out.weight = Math.max(0, numberOf(it.keyOriginLineWeight, 1));
    out.arrowStart = it.keyOriginLineArrowSt === true;
    out.arrowEnd = it.keyOriginLineArrowEnd === true;
    out.arrowWidth = numberOf(it.keyOriginLineArrWdth, 500);
    out.arrowLength = numberOf(it.keyOriginLineArrLngth, 1000);
    out.concavity = numberOf(it.keyOriginLineArrConc, 0);
  }

  // A block with neither radii nor any recognised parameters says nothing our
  // shape model can use.
  if (!corners && out.sides == null && out.weight == null) return null;
  return out;
}

/** `vscg` — a four-character content key followed by that content's descriptor. */
function readVectorStrokeContent(r) {
  r.readString(4); // content key: SoCo / GdFl / PtFl
  const d = readDescriptorBlock(r);
  return colorFromDescriptor(d.items && d.items['Clr ']);
}

/**
 * Fill in the payload shape `src/text/text-render.js` documents.
 *
 * `warp` is deliberately *not* defaulted here: an inert warp and no warp render
 * identically (`rasterizeTextLayer` skips `style: 'none'`, and both
 * `resolveTextProps` and the two warp commands supply the same default), but the
 * writer persists whatever it is handed. Defaulting it made reopening a plain
 * type layer add 46 bytes of `{style:'none',bend:0,h:0,v:0}` to the file, so a
 * document that was byte-identical on the second save was not on the first.
 */
function textPayload(over) {
  return {
    content: '',
    font: 'system',
    size: 24,
    weight: 400,
    style: 'normal',
    color: '#000000',
    align: 'left',
    lineHeight: 1.2,
    letterSpacing: 0,
    x: 0,
    y: 0,
    boxWidth: 0,
    boxHeight: 0,
    paragraph: false,
    vertical: false,
    underline: false,
    strikethrough: false,
    antialias: 'smooth',
    ...over,
  };
}

/** PostScript font names map onto our family ids where one exists. */
const FONT_ALIASES = [
  [/^helveticaneue/i, 'helvetica'],
  [/^arial|helvetica|liberationsans/i, 'arial'],
  [/^verdana/i, 'verdana'],
  [/^tahoma/i, 'tahoma'],
  [/^trebuchet/i, 'trebuchet'],
  [/^segoe/i, 'segoe'],
  [/^gillsans/i, 'gill'],
  [/^futura|centurygothic/i, 'futura'],
  [/^impact/i, 'impact'],
  [/^times|liberationserif/i, 'times'],
  [/^georgia/i, 'georgia'],
  [/^garamond/i, 'garamond'],
  [/^palatino|bookantiqua/i, 'palatino'],
  [/^courier/i, 'courier'],
  [/^inter/i, 'inter'],
  [/^roboto/i, 'roboto'],
  [/^opensans/i, 'open-sans'],
  [/^lato/i, 'lato'],
  [/^montserrat/i, 'montserrat'],
  [/^poppins/i, 'poppins'],
  [/^raleway/i, 'raleway'],
  [/^oswald/i, 'oswald'],
  [/^playfair/i, 'playfair'],
  [/^merriweather/i, 'merriweather'],
  [/^jetbrains/i, 'jetbrains'],
  [/^menlo|consolas|couriernew/i, 'mono'],
  [/^comicsans/i, 'comic'],
  [/^brushscript/i, 'brush'],
  [/^pacifico/i, 'pacifico'],
  [/^lobster/i, 'lobster'],
  [/^dancingscript/i, 'dancing'],
];

function mapFontName(raw) {
  if (!raw) return { font: 'system', weight: 400, style: 'normal' };
  // A face we ourselves name maps back exactly — family, weight and slant —
  // rather than through the substring heuristics below.
  const exact = familyFromPostScriptName(raw);
  if (exact) return exact;
  const weight = /black|heavy/i.test(raw) ? 900 : /bold|semibold|demi/i.test(raw) ? 700 : /light|thin/i.test(raw) ? 300 : 400;
  const style = /italic|oblique/i.test(raw) ? 'italic' : 'normal';
  const stem = raw.replace(/[^A-Za-z]/g, '');
  for (const [re, id] of FONT_ALIASES) if (re.test(stem)) return { font: id, weight, style };
  // Unknown families still work: fontStack() falls back to "<name>, sans-serif".
  const family = raw.split(/[-,]/)[0].trim();
  return { font: family || 'system', weight, style };
}

/** `AntA` descriptor enum -> the `antialias` mode `text-render.js` applies. */
const ANTIALIAS_MODES = {
  Anno: 'none', antiAliasNone: 'none',
  antiAliasSharp: 'sharp', AnSh: 'sharp',
  antiAliasCrisp: 'crisp', AnCr: 'crisp',
  antiAliasStrong: 'strong', AnSt: 'strong',
  antiAliasSmooth: 'smooth', AnSm: 'smooth',
};

/**
 * `warpStyle` enum -> our warp id. Photoshop has more shapes than we render, so
 * the ones with no direct match fall back to the closest we do have.
 */
const WARP_STYLE_IDS = {
  warpNone: 'none', warpArc: 'arc', warpArcUpper: 'arc', warpArcLower: 'arc',
  warpArch: 'arch', warpBulge: 'bulge', warpInflate: 'bulge',
  warpShellUpper: 'arch', warpShellLower: 'arch',
  warpFlag: 'flag', warpWave: 'wave', warpFish: 'fish', warpFisheye: 'fish',
  warpRise: 'rise',
};

/**
 * The EngineData style run of a type layer.
 *
 * EngineData is a plain-text token stream of nested `<< /Key value >>`
 * dictionaries. Only one region matters here: the first `/StyleRun` entry,
 * which holds the font index, size, colour and decorations. Everything after
 * `/GridInfo` is the resource tables, whose `/Leading`, `/Justification` and
 * `/Name` entries would otherwise be mistaken for the real run — so the search
 * is confined to the run itself, and the font name is taken from `/FontSet`.
 */
function engineStyleRun(engine) {
  const runAt = engine.indexOf('/StyleRun');
  const gridAt = engine.indexOf('/GridInfo');
  const run = runAt < 0 ? engine : engine.slice(runAt, gridAt > runAt ? gridAt : undefined);
  const paraAt = engine.indexOf('/ParagraphRun');
  const para = paraAt < 0 ? engine : engine.slice(paraAt, runAt > paraAt ? runAt : undefined);
  const fontSetAt = engine.indexOf('/FontSet');
  const fontSet = fontSetAt < 0 ? engine : engine.slice(fontSetAt);
  return { run, para, fontSet };
}

/**
 * Type tool object setting (Photoshop 6 and later, keys 'TySh' / 'TxLr').
 *
 * The visible string lives in the descriptor; everything about how it looks is
 * inside the opaque EngineData blob, so we mine that for the properties our
 * text layers model. The warp descriptor that follows the text descriptor is
 * parsed too.
 */
function readTypeTool(r) {
  r.readUint16(); // version (1)
  const transform = [r.readDouble(), r.readDouble(), r.readDouble(), r.readDouble(), r.readDouble(), r.readDouble()];
  r.readUint16(); // text version (50)
  const descriptor = readDescriptorBlock(r);
  const it = descriptor.items || {};
  const content = typeof it['Txt '] === 'string' ? it['Txt '].replace(/\r\n?/g, '\n') : '';

  const scaleY = Math.hypot(transform[2], transform[3]) || 1;
  const engine = it.EngineData && it.EngineData.raw ? latin1(it.EngineData.raw) : '';
  const { run, para, fontSet } = engineStyleRun(engine);

  let size = 0;
  const sizeMatch = /\/FontSize\s+([\d.]+)/.exec(run);
  if (sizeMatch) size = parseFloat(sizeMatch[1]);

  const fontMatch = /\/Name\s*\(([^)]*)\)/.exec(fontSet) || /\/FontName\s*\(([^)]*)\)/.exec(engine);
  const rawFont = fontMatch ? fontMatch[1].replace(/[^\x20-\x7e]/g, '').trim() : '';
  const mapped = mapFontName(rawFont);
  const font = mapped.font;
  // A faux face means the family itself is regular and the weight/slant were
  // synthesised — which is exactly how our own writer stores bold and italic.
  const weight = /\/FauxBold\s+true/.test(run) ? 700 : mapped.weight;
  const style = /\/FauxItalic\s+true/.test(run) ? 'italic' : mapped.style;

  let color = '#000000';
  const colorMatch = /\/FillColor[\s\S]{0,160}?\/Values\s*\[\s*([\d.\s-]+)\]/.exec(run);
  if (colorMatch) {
    const v = colorMatch[1].trim().split(/\s+/).map(Number);
    if (v.length >= 4) color = hexOf(v[1] * 255, v[2] * 255, v[3] * 255);
  }

  const justMatch = /\/Justification\s+(\d)/.exec(para);
  const align = justMatch ? ['left', 'right', 'center', 'justify'][Number(justMatch[1])] || 'left' : 'left';

  const finalSize = Math.max(1, Math.round((size || 24) * scaleY * 100) / 100);

  // Leading is absolute points in EngineData; our model wants a multiplier.
  // `/AutoLeading true` means the run has no explicit leading at all.
  let lineHeight = 1.2;
  const leadingMatch = /\/Leading\s+([\d.]+)/.exec(run);
  if (leadingMatch && !/\/AutoLeading\s+true/.test(run)) {
    const leading = parseFloat(leadingMatch[1]) * scaleY;
    if (leading > 0) lineHeight = Math.round((leading / finalSize) * 1000) / 1000;
  }

  // Tracking is in 1/1000 em.
  let letterSpacing = 0;
  const trackMatch = /\/Tracking\s+(-?[\d.]+)/.exec(run);
  if (trackMatch) letterSpacing = Math.round(((parseFloat(trackMatch[1]) / 1000) * finalSize) * 100) / 100;

  const box = it.bounds && it.bounds.items ? it.bounds.items : null;
  const boxWidth = box ? Math.abs(numberOf(box.Rght, 0) - numberOf(box.Left, 0)) * scaleY : 0;
  const boxHeight = box ? Math.abs(numberOf(box.Btom, 0) - numberOf(box['Top '], 0)) * scaleY : 0;
  // `/ShapeType 1` is a text box; 0 is point text. `TextType` is what some
  // other writers put in the descriptor instead.
  const shapeType = /\/ShapeType\s+(\d)/.exec(engine);
  const paragraph = shapeType
    ? shapeType[1] === '1'
    : !!(it.TextType === 1 || (boxWidth > 1 && boxHeight > 1 && it.textGridding));

  const antialias = ANTIALIAS_MODES[it.AntA && it.AntA.value] || 'smooth';
  const vertical = !!(it.Ornt && it.Ornt.value === 'Vrtc');

  // --- the warp descriptor, which follows the text descriptor. `warpNone` maps
  // to 'none', which is left off the payload entirely: see `textPayload`.
  let warp = null;
  if (r.remaining > 6) {
    try {
      r.readUint16(); // warp version (1)
      const wd = readDescriptorBlock(r);
      const wi = wd.items || {};
      const id = WARP_STYLE_IDS[wi.warpStyle && wi.warpStyle.value];
      if (id && id !== 'none') {
        warp = {
          style: id,
          bend: numberOf(wi.warpValue, 0) / 100,
          h: numberOf(wi.warpPerspective, 0) / 100,
          v: numberOf(wi.warpPerspectiveOther, 0) / 100,
        };
      }
    } catch (err) {
      // A file with no warp section still has perfectly good text.
      console.warn('[psd] the type layer warp could not be read', err);
    }
  }

  return textPayload({
    content,
    font,
    weight,
    style,
    size: finalSize,
    color,
    align,
    lineHeight,
    letterSpacing,
    x: transform[4],
    y: transform[5],
    boxWidth: paragraph ? boxWidth : 0,
    boxHeight: paragraph ? boxHeight : 0,
    paragraph,
    vertical,
    antialias,
    ...(warp ? { warp } : null),
    underline: /\/Underline\s+true/.test(run),
    strikethrough: /\/Strikethrough\s+true/.test(run),
  });
}

/** Photoshop 5.0/5.5 type info ('tySh') — recover whatever text we can. */
function readLegacyTypeTool(r) {
  r.readUint16(); // version
  r.skip(48); // transform
  const raw = latin1(r.readBytes(r.remaining));
  // The string table is stored as null-terminated runs; take the longest.
  const candidates = raw.split(/[^\x20-\x7e]+/).filter((s) => s.length > 1);
  candidates.sort((a, b) => b.length - a.length);
  return textPayload({ content: (candidates[0] || '').trim() });
}

function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/* ------------------------------------------------------------------ */
/* Flattened composite (always present at the end of the file)         */
/* ------------------------------------------------------------------ */

/**
 * Decode a subset of the merged image section.
 *
 * Only the requested channel indexes are expanded — the RLE row-count table in
 * front of the pixel data gives the exact byte length of every channel, so the
 * ones nobody asked for cost an addition each. That is what makes reading the
 * saved alpha channels (which live *after* the composite) cheap even when the
 * layer section already supplied every layer.
 *
 * @param {number[]} wanted channel indexes, 0 = red
 * @returns {Map<number, Uint8Array>} index -> one 8-bit sample per pixel
 */
function decodeMergedPlanes(buf, offset, ctx, wanted) {
  const { width, height, depth, psb } = ctx;
  const out = new Map();
  if (offset + 2 > buf.byteLength) return out;

  const channels = Math.max(1, Math.min(ctx.channelCount, 64));
  const want = new Set(wanted.filter((i) => i >= 0 && i < channels));
  if (!want.size) return out;

  const r = new ByteReader(buf, offset);
  const compression = r.readUint16();
  const bytesPerSample = depth === 16 ? 2 : 1;
  const rowBytes = width * bytesPerSample;

  if (compression === 0) {
    for (let c = 0; c < channels; c++) {
      if (want.has(c)) out.set(c, toSamples(r.readBytes(rowBytes * height), width, height, depth));
      else r.skip(rowBytes * height);
    }
    return out;
  }
  if (compression !== 1) throw new Error('The flattened image uses an unsupported compression scheme');

  const counts = new Uint32Array(channels * height);
  for (let i = 0; i < counts.length; i++) counts[i] = psb ? r.readUint32() : r.readUint16();
  let pos = r.tell();
  for (let c = 0; c < channels; c++) {
    const rowCounts = counts.subarray(c * height, (c + 1) * height);
    if (want.has(c)) {
      out.set(c, toSamples(unpackRLE(r.u8, pos, r.end, rowCounts, rowBytes, height), width, height, depth));
    }
    for (let i = 0; i < rowCounts.length; i++) pos += rowCounts[i];
  }
  return out;
}

/** Index of the first channel that is neither colour nor transparency. */
function firstExtraChannel(ctx) {
  return (ctx.colorMode === 1 ? 1 : 3) + (ctx.mergedHasAlpha ? 1 : 0);
}

/**
 * The saved alpha channels: everything past the composite's own channels,
 * named by image resource 1006.
 * @returns {{id:string, name:string, canvas:HTMLCanvasElement}[]}
 */
function readAlphaChannels(buf, offset, ctx, names) {
  const start = firstExtraChannel(ctx);
  const count = Math.min(Math.max(0, ctx.channelCount - start), 64);
  if (count <= 0) return [];

  const wanted = [];
  for (let i = 0; i < count; i++) wanted.push(start + i);
  const planes = decodeMergedPlanes(buf, offset, ctx, wanted);

  const out = [];
  for (let i = 0; i < count; i++) {
    const plane = planes.get(start + i);
    if (!plane) continue;
    out.push({
      id: uid('chan'),
      name: names[i] || `Alpha ${i + 1}`,
      canvas: greyCanvas(plane, ctx.width, ctx.height),
      plane,
    });
  }
  return out;
}

/** One 8-bit plane as the greyscale RGBA canvas our channels are made of. */
function greyCanvas(plane, width, height) {
  const img = new ImageData(width, height);
  const d = img.data;
  for (let p = 0, i = 0; p < width * height; p++, i += 4) {
    const v = plane[p];
    d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
  }
  const cv = createCanvas(width, height);
  cv.getContext('2d').putImageData(img, 0, 0);
  return cv;
}

async function readCompositeImage(buf, offset, ctx) {
  const { width, height } = ctx;
  const canvas = createCanvas(width, height);
  if (offset + 2 > buf.byteLength) return canvas;

  const map = decodeMergedPlanes(buf, offset, ctx, [0, 1, 2, 3]);
  const planes = [map.get(0), map.get(1), map.get(2), map.get(3)];

  const gray = ctx.colorMode === 1;
  const R = planes[0];
  const G = gray ? planes[0] : planes[1];
  const B = gray ? planes[0] : planes[2];
  const alphaIndex = gray ? 1 : 3;
  const A = ctx.mergedHasAlpha ? planes[alphaIndex] : null;

  /*
   * No merged data at all means this file was saved with "Maximize
   * Compatibility" off, and there is no flattened composite to fall back to.
   * Returning the blank canvas here would hand back an empty document that looks
   * like a successful open — and now that an oversized file can be *routed* into
   * this path deliberately, a silent blank is the worst possible answer. Say so
   * instead, and let the caller decide.
   */
  if (!R && !G && !B) return null;

  const img = new ImageData(width, height);
  const d = img.data;
  for (let p = 0, i = 0; p < width * height; p++, i += 4) {
    d[i] = R ? R[p] : 0;
    d[i + 1] = G ? G[p] : 0;
    d[i + 2] = B ? B[p] : 0;
    d[i + 3] = A ? A[p] : 255;
  }
  canvas.getContext('2d').putImageData(img, 0, 0);
  return canvas;
}
