import { LayerType } from '../core/layer.js';
import { getComposite } from '../render/compositor.js';
import { createCanvas, ctx2dRead } from '../core/util.js';
import { parseColor } from '../core/color.js';
import { resolveTextProps, measureTextLayer } from '../text/text-render.js';
import { postScriptFace } from '../text/fonts.js';
import { subpathsBounds } from '../vector/path.js';

/**
 * Photoshop (.psd) writer.
 *
 * Produces a version-1 PSD with:
 *   - an image-resources section carrying the document resolution, the alpha
 *     channel names (1006) and their display info (1053 / 1077), the guides
 *     (1032) and the vector paths (2000-2997 plus the name in 2999),
 *   - one layer record per raster-like layer plus open/close markers for
 *     groups (`lsct`), unicode names (`luni`), user masks and layer effects
 *     (`lfx2`),
 *   - live type layers (`TySh`: transform, text descriptor with an EngineData
 *     style run, warp descriptor) and live shape layers (`vmsk` vector mask
 *     plus a `SoCo`/`GdFl`/`PtFl` fill and a `vstk`/`vscg` stroke),
 *   - RLE (PackBits) compressed channels throughout, and
 *   - the flattened composite as the merged image at the end of the file,
 *     followed by one extra channel per saved alpha channel and, when the
 *     document has a live selection, one more holding that selection.
 *
 * Adjustment layers have no pixels of their own. Photoshop stores them as a
 * normal layer record with a zero-area rectangle and one *empty* channel per
 * required channel id; the live adjustment lives entirely in the additional
 * layer information. We do exactly the same, and write two things there:
 *
 *   1. the legacy binary key for the six adjustments Photoshop documents in a
 *      simple non-descriptor form (`nvrt`, `post`, `thrs`, `brit`, `levl`,
 *      `curv`), so real Photoshop and Photopea show a live adjustment, and
 *   2. a Pikado-private `8BIM`/`pkAd` block holding `{kind, params}` as JSON —
 *      written for *every* adjustment layer, including the six above.
 *
 * The private block is what makes a Pikado -> PSD -> Pikado round trip lossless
 * for all 24 adjustment kinds; `psd-read.js` prefers it whenever it is present.
 * Unknown additional-layer-info keys are skipped by every conforming reader, so
 * carrying it costs nothing in interoperability.
 *
 * Type and shape layers get the same treatment: the interoperable blocks are
 * always written, and `pkTx` / `pkSh` ride alongside them carrying `layer.text`
 * and `layer.shape` verbatim. Photoshop's own model has no room for our font
 * ids, 100..900 weights or the polygon/star parameters a frozen path cannot
 * express, so without them a round trip through the file would quietly
 * approximate. Strip the private blocks and the file still opens as live text
 * and live shapes — that path is exercised by the round-trip tests.
 */

/* ------------------------------------------------------------------ */
/* ByteWriter                                                          */
/* ------------------------------------------------------------------ */

const DOUBLE_BUFFER = new ArrayBuffer(8);
const DOUBLE_VIEW = new DataView(DOUBLE_BUFFER);
const DOUBLE_BYTES = new Uint8Array(DOUBLE_BUFFER);

/** Growable big-endian byte sink. Every integer in a PSD is big-endian. */
export class ByteWriter {
  constructor(capacity = 1 << 16) {
    this.u8 = new Uint8Array(capacity);
    this.len = 0;
  }

  _grow(n) {
    if (this.len + n <= this.u8.length) return;
    let cap = this.u8.length || 1024;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.u8.subarray(0, this.len));
    this.u8 = next;
  }

  get length() { return this.len; }

  byte(v) { this._grow(1); this.u8[this.len++] = v & 255; return this; }

  uint16(v) {
    this._grow(2);
    this.u8[this.len++] = (v >>> 8) & 255;
    this.u8[this.len++] = v & 255;
    return this;
  }

  int16(v) { return this.uint16(v < 0 ? v + 0x10000 : v); }

  uint32(v) {
    this._grow(4);
    this.u8[this.len++] = (v >>> 24) & 255;
    this.u8[this.len++] = (v >>> 16) & 255;
    this.u8[this.len++] = (v >>> 8) & 255;
    this.u8[this.len++] = v & 255;
    return this;
  }

  int32(v) { return this.uint32(v < 0 ? v + 0x100000000 : v); }

  /** IEEE-754 64-bit float, big-endian — descriptor `doub` and `UntF`. */
  double(v) {
    this._grow(8);
    DOUBLE_VIEW.setFloat64(0, Number.isFinite(v) ? v : 0);
    this.u8.set(DOUBLE_BYTES, this.len);
    this.len += 8;
    return this;
  }

  bytes(arr) {
    this._grow(arr.length);
    this.u8.set(arr, this.len);
    this.len += arr.length;
    return this;
  }

  /** Latin-1 / ASCII text, written verbatim. */
  ascii(s) {
    this._grow(s.length);
    for (let i = 0; i < s.length; i++) this.u8[this.len++] = s.charCodeAt(i) & 255;
    return this;
  }

  zeros(n) {
    this._grow(n);
    this.len += n;
    return this;
  }

  /** Length byte + text, padded so (1 + length) is a multiple of `pad`. */
  pascal(s, pad = 2) {
    const bytes = [];
    for (let i = 0; i < s.length && bytes.length < 255; i++) {
      const c = s.charCodeAt(i);
      bytes.push(c < 256 ? c : 63); // '?' for anything outside Latin-1
    }
    this.byte(bytes.length);
    this.bytes(Uint8Array.from(bytes));
    const rem = (bytes.length + 1) % pad;
    if (rem) this.zeros(pad - rem);
    return this;
  }

  /** uint32 character count followed by UTF-16BE code units. */
  unicodeString(s) {
    this.uint32(s.length);
    for (let i = 0; i < s.length; i++) this.uint16(s.charCodeAt(i));
    return this;
  }

  /**
   * The null-terminated flavour Photoshop uses *inside descriptors*: the count
   * includes the terminator. Readers that trim trailing nulls (ours does) are
   * happy either way, but Photoshop itself only writes this one.
   */
  unicodeStringZ(s) {
    this.uint32(s.length + 1);
    for (let i = 0; i < s.length; i++) this.uint16(s.charCodeAt(i));
    this.uint16(0);
    return this;
  }

  /** Rewrite a previously reserved uint32 (used for section lengths). */
  patchUint32(at, v) {
    this.u8[at] = (v >>> 24) & 255;
    this.u8[at + 1] = (v >>> 16) & 255;
    this.u8[at + 2] = (v >>> 8) & 255;
    this.u8[at + 3] = v & 255;
    return this;
  }

  alignTo(n) {
    const rem = this.len % n;
    if (rem) this.zeros(n - rem);
    return this;
  }

  toUint8Array() { return this.u8.subarray(0, this.len); }
}

/* ------------------------------------------------------------------ */
/* PackBits                                                            */
/* ------------------------------------------------------------------ */

/**
 * PackBits-compress one scan line into `w` and return the byte count written.
 * The per-row byte counts are the part readers are most sensitive to, so this
 * returns the exact number of bytes appended.
 */
function packRow(w, src, offset, length) {
  // Worst case is one control byte per 128 literals, so reserve once and then
  // write straight into the backing array — byte-at-a-time is far too slow for
  // multi-megapixel channels.
  w._grow(length + Math.ceil(length / 128) + 4);
  const out = w.u8;
  const base = w.len;
  let o = base;
  let i = 0;

  while (i < length) {
    // How long is the run of identical bytes starting here?
    let run = 1;
    while (run < 128 && i + run < length && src[offset + i + run] === src[offset + i]) run++;

    if (run >= 2) {
      out[o++] = 257 - run;
      out[o++] = src[offset + i];
      i += run;
      continue;
    }

    // Literal run: stop when three identical bytes start a worthwhile run.
    const start = i;
    let lit = 0;
    while (i < length && lit < 128) {
      if (i + 2 < length && src[offset + i] === src[offset + i + 1] && src[offset + i + 1] === src[offset + i + 2]) break;
      i++;
      lit++;
    }
    out[o++] = lit - 1;
    for (let k = 0; k < lit; k++) out[o++] = src[offset + start + k];
  }

  w.len = o;
  return o - base;
}

/**
 * Write a full channel: 2-byte compression id, the per-row byte-count table,
 * then the packed rows. Returns the total number of bytes written.
 */
function writeChannel(w, plane, width, height) {
  const before = w.length;
  w.uint16(1); // RLE
  const tableAt = w.length;
  w.zeros(height * 2);
  const counts = new Uint16Array(height);
  for (let y = 0; y < height; y++) counts[y] = packRow(w, plane, y * width, width);
  for (let y = 0; y < height; y++) {
    w.u8[tableAt + y * 2] = (counts[y] >>> 8) & 255;
    w.u8[tableAt + y * 2 + 1] = counts[y] & 255;
  }
  return w.length - before;
}

/** An empty channel: compression 0 with no pixel data. */
function writeEmptyChannel(w) {
  w.uint16(0);
  return 2;
}

/* ------------------------------------------------------------------ */
/* Photoshop object descriptors                                        */
/* ------------------------------------------------------------------ */

/**
 * Adobe's "object descriptor" — the self-describing key/value tree Photoshop
 * uses for everything it added after the binary era: layer effects (`lfx2`),
 * fill layers, type layers, most modern adjustments.
 *
 * A descriptor is `{name, classID, items}` where `items` is a plain object
 * mapping a key to a *tagged value* built with the `DESC` helpers below.
 * Object key order is preserved by JavaScript for string keys, which is what
 * lets us emit keys in the order Photoshop does.
 *
 *   DESC.obj('RGBC', { 'Rd  ': DESC.doub(255) })
 *   DESC.list([DESC.long(1), DESC.long(2)])
 *
 * Keys and class ids are four characters when possible; anything else is
 * written in the length-prefixed form. Read back by `readDescriptor` in
 * `psd-read.js`, which accepts exactly the same set of types.
 */

/** @typedef {{t:string, v:*, unit?:string, enumType?:string}} DescValue */

export const DESC = {
  /** @returns {DescValue} an `Objc` descriptor. */
  obj(classID, items, name = '') { return { t: 'Objc', v: { name, classID, items } }; },
  /** @returns {DescValue} a `VlLs` list of values. */
  list(values) { return { t: 'VlLs', v: values }; },
  /** @returns {DescValue} a `doub` 64-bit float. */
  doub(v) { return { t: 'doub', v: Number(v) || 0 }; },
  /** @returns {DescValue} a `long` 32-bit signed integer. */
  long(v) { return { t: 'long', v: Math.round(Number(v) || 0) }; },
  /** @returns {DescValue} a `bool`. */
  bool(v) { return { t: 'bool', v: !!v }; },
  /** @returns {DescValue} a `TEXT` unicode string. */
  text(v) { return { t: 'TEXT', v: v == null ? '' : String(v) }; },
  /** @returns {DescValue} an `enum` — both halves are key ids. */
  enm(enumType, value) { return { t: 'enum', enumType, v: value }; },
  /** @returns {DescValue} a `UntF` value with an explicit unit code. */
  untf(unit, v) { return { t: 'UntF', unit, v: Number(v) || 0 }; },
  /** Percent (`#Prc`) — Photoshop wants 0..100, so pass a percentage. */
  pct(v) { return DESC.untf('#Prc', v); },
  /** Pixels (`#Pxl`). */
  px(v) { return DESC.untf('#Pxl', v); },
  /** Degrees (`#Ang`). */
  ang(v) { return DESC.untf('#Ang', v); },
  /** Unitless (`#Nne`). */
  none(v) { return DESC.untf('#Nne', v); },
  /**
   * `tdta` — an opaque, length-prefixed byte string. Photoshop uses it for the
   * text engine's own serialisation (`EngineData`), which is not a descriptor.
   * @param {Uint8Array|number[]|string} bytes Latin-1 string or raw bytes.
   */
  raw(bytes) {
    if (typeof bytes === 'string') {
      const out = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i) & 255;
      return { t: 'tdta', v: out };
    }
    return { t: 'tdta', v: bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []) };
  },
};

/** Four-character keys carry a zero length; anything else is length-prefixed. */
function writeKeyId(w, key) {
  const s = String(key);
  if (s.length === 4) w.uint32(0);
  else w.uint32(s.length);
  w.ascii(s);
}

function writeDescriptorValue(w, value) {
  if (!value || typeof value !== 'object' || !value.t) {
    throw new Error('[psd] descriptor values must be built with the DESC helpers');
  }
  switch (value.t) {
    case 'Objc':
      w.ascii('Objc');
      writeDescriptorBody(w, value.v);
      return;
    case 'VlLs': {
      const list = value.v || [];
      w.ascii('VlLs');
      w.uint32(list.length);
      for (const item of list) writeDescriptorValue(w, item);
      return;
    }
    case 'doub':
      w.ascii('doub').double(value.v);
      return;
    case 'UntF':
      w.ascii('UntF').ascii(value.unit || '#Nne');
      w.double(value.v);
      return;
    case 'TEXT':
      w.ascii('TEXT').unicodeStringZ(value.v);
      return;
    case 'enum':
      w.ascii('enum');
      writeKeyId(w, value.enumType);
      writeKeyId(w, value.v);
      return;
    case 'long':
      w.ascii('long').int32(value.v);
      return;
    case 'bool':
      w.ascii('bool').byte(value.v ? 1 : 0);
      return;
    case 'tdta':
      w.ascii('tdta').uint32(value.v.length).bytes(value.v);
      return;
    default:
      throw new Error(`[psd] unsupported descriptor type "${value.t}"`);
  }
}

/** Name, class id, item count, then the items — no version prefix. */
function writeDescriptorBody(w, descriptor) {
  const items = descriptor.items || {};
  const keys = Object.keys(items);
  w.unicodeStringZ(descriptor.name || '');
  writeKeyId(w, descriptor.classID || 'null');
  w.uint32(keys.length);
  for (const key of keys) {
    writeKeyId(w, key);
    writeDescriptorValue(w, items[key]);
  }
}

/**
 * Serialise a descriptor with the version word every block wants in front.
 * @param {ByteWriter} w
 * @param {{name?:string, classID?:string, items:Object<string,DescValue>}} descriptor
 */
export function writeDescriptorBlock(w, descriptor) {
  w.uint32(16); // descriptor version, always 16
  writeDescriptorBody(w, descriptor);
  return w;
}

/* ------------------------------------------------------------------ */
/* Layer collection                                                    */
/* ------------------------------------------------------------------ */

const WRITE_BLEND_KEYS = {
  'pass-through': 'pass',
  normal: 'norm',
  dissolve: 'diss',
  darken: 'dark',
  multiply: 'mul ',
  'color-burn': 'idiv',
  'linear-burn': 'lbrn',
  'darker-color': 'dkCl',
  lighten: 'lite',
  screen: 'scrn',
  'color-dodge': 'div ',
  'linear-dodge': 'lddg',
  'lighter-color': 'lgCl',
  overlay: 'over',
  'soft-light': 'sLit',
  'hard-light': 'hLit',
  'vivid-light': 'vLit',
  'linear-light': 'lLit',
  'pin-light': 'pLit',
  'hard-mix': 'hMix',
  difference: 'diff',
  exclusion: 'smud',
  subtract: 'fsub',
  divide: 'fdiv',
  hue: 'hue ',
  saturation: 'sat ',
  color: 'colr',
  luminosity: 'lum ',
};

function blendKeyOf(id) {
  return WRITE_BLEND_KEYS[id] || 'norm';
}

/**
 * Flatten the tree into the bottom-first order PSD expects, inserting the
 * bounding divider before a group's children and the folder record after them.
 */
function collectRecords(list, out) {
  for (let i = list.length - 1; i >= 0; i--) {
    const layer = list[i];
    if (layer.type === LayerType.GROUP) {
      out.push({ layer, kind: 'divider' });
      collectRecords(layer.children || [], out);
      out.push({ layer, kind: 'group' });
    } else if (layer.type === LayerType.ADJUSTMENT) {
      // Zero-area record + empty channels, exactly how Photoshop stores these.
      out.push({ layer, kind: 'adjustment' });
    } else if (layer.type === LayerType.TEXT && layer.text) {
      // Live type layer: the rasterised pixels *and* a 'TySh' block.
      out.push({ layer, kind: 'text' });
    } else if (layer.type === LayerType.SHAPE && layer.shape && (layer.shape.subpaths || []).length
      && !shapeCarriesLiveCanvas(layer.shape, layer)) {
      // Live shape layer: the rasterised pixels *and* a vector mask + fill.
      out.push({ layer, kind: 'shape' });
    } else if (layer.canvas) {
      out.push({ layer, kind: 'layer' });
    }
  }
  return out;
}

/** Extract A/R/G/B planes for a rectangle of a layer canvas. */
function planesOf(canvas, x, y, width, height) {
  const data = ctx2dRead(canvas).getImageData(x, y, width, height).data;
  const n = width * height;
  const a = new Uint8Array(n);
  const r = new Uint8Array(n);
  const g = new Uint8Array(n);
  const b = new Uint8Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    r[p] = data[i];
    g[p] = data[i + 1];
    b[p] = data[i + 2];
    a[p] = data[i + 3];
  }
  return { a, r, g, b };
}

/** Greyscale plane for a layer mask (masks are stored as RGBA greyscale). */
function maskPlane(canvas, width, height) {
  const data = ctx2dRead(canvas).getImageData(0, 0, width, height).data;
  const n = width * height;
  const out = new Uint8Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    out[p] = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
  }
  return out;
}

/** Content bounds clamped to the document, or null when the layer is empty. */
function rectOf(layer, doc) {
  const bounds = layer.contentBounds();
  if (!bounds) return null;
  const left = Math.max(0, bounds.x);
  const top = Math.max(0, bounds.y);
  const right = Math.min(doc.width, bounds.x + bounds.width);
  const bottom = Math.min(doc.height, bounds.y + bounds.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

/* ------------------------------------------------------------------ */
/* Writer                                                              */
/* ------------------------------------------------------------------ */

/**
 * The name of the alpha channel that carries the live selection.
 *
 * Photoshop has no place for an active selection in the file format at all —
 * the only thing it *does* persist is a saved selection, which is an alpha
 * channel. So the selection travels as one more alpha channel under this name,
 * and `psd-read.js` turns that channel back into `doc.selection` instead of
 * listing it in the Channels panel. Anything else opening the file sees a
 * perfectly ordinary saved selection.
 */
export const SELECTION_CHANNEL_NAME = 'Pikado Selection';

/**
 * Serialise a document to a Photoshop file.
 * @param {import('../core/document.js').PikaDocument} doc
 * @returns {Promise<Blob>} a `.psd` blob
 */
export async function writePSD(doc) {
  const width = doc.width;
  const height = doc.height;
  const w = new ByteWriter(1 << 20);
  const extras = collectExtraChannels(doc);

  /* --- File header ------------------------------------------------- */
  w.ascii('8BPS');
  w.uint16(1);       // version 1 (PSD)
  w.zeros(6);        // reserved
  w.uint16(4 + extras.length); // RGB + transparency + one per alpha channel
  w.uint32(height);
  w.uint32(width);
  w.uint16(8);       // 8 bits per channel
  w.uint16(3);       // RGB colour mode

  /* --- Colour mode data (empty for RGB) ---------------------------- */
  w.uint32(0);

  /* --- Image resources --------------------------------------------- */
  const resourcesLengthAt = w.length;
  w.uint32(0);
  const resourcesStart = w.length;
  writeResolutionResource(w, doc.resolution || 72);
  if (extras.length) {
    writeAlphaNamesResource(w, extras);
    writeDisplayInfoResources(w, extras);
  }
  if (doc.guides && doc.guides.length) writeGuidesResource(w, doc.guides);
  writePathResources(w, doc);
  w.patchUint32(resourcesLengthAt, w.length - resourcesStart);

  /* --- Layer and mask information ---------------------------------- */
  const layerMaskLengthAt = w.length;
  w.uint32(0);
  const layerMaskStart = w.length;

  const records = collectRecords(doc.layers, []);
  if (records.length) {
    const layerInfoLengthAt = w.length;
    w.uint32(0);
    const layerInfoStart = w.length;

    // A negative count tells readers the merged image carries transparency.
    w.int16(-records.length);

    // Pass 1: the records themselves, remembering where each channel-length
    // field sits so it can be patched once the pixels are written.
    const pending = [];
    for (const record of records) pending.push(writeLayerRecord(w, record, doc));

    // Pass 2: channel pixels, in the same order.
    for (let i = 0; i < records.length; i++) writeChannelData(w, records[i], pending[i], doc);

    w.alignTo(2);
    w.patchUint32(layerInfoLengthAt, w.length - layerInfoStart);
  } else {
    w.uint32(0); // no layer info
  }

  w.uint32(0); // global layer mask info
  w.patchUint32(layerMaskLengthAt, w.length - layerMaskStart);

  /* --- Merged image ------------------------------------------------ */
  const composite = getComposite(doc);
  const flat = composite.width === width && composite.height === height ? composite : scaleTo(composite, width, height);
  const { a, r, g, b } = planesOf(flat, 0, 0, width, height);

  // Colour + transparency first, then one plane per extra channel. Readers
  // pair those up with the names in image resource 1006.
  const planes = [r, g, b, a, ...extras.map((ch) => ch.plane)];

  w.uint16(1); // RLE
  const tableAt = w.length;
  w.zeros(planes.length * height * 2);
  const counts = new Uint16Array(planes.length * height);
  for (let c = 0; c < planes.length; c++) {
    for (let y = 0; y < height; y++) counts[c * height + y] = packRow(w, planes[c], y * width, width);
  }
  for (let i = 0; i < counts.length; i++) {
    w.u8[tableAt + i * 2] = (counts[i] >>> 8) & 255;
    w.u8[tableAt + i * 2 + 1] = counts[i] & 255;
  }

  return new Blob([w.toUint8Array()], { type: 'image/vnd.adobe.photoshop' });
}

function scaleTo(src, width, height) {
  const out = createCanvas(width, height);
  out.getContext('2d').drawImage(src, 0, 0, width, height);
  return out;
}

/* ------------------------------------------------------------------ */
/* Image resources                                                     */
/* ------------------------------------------------------------------ */

/**
 * `8BIM` + uint16 id + pascal name + uint32 length + data, padded to an even
 * length (the declared length excludes the pad byte).
 */
function writeResource(w, id, name, write) {
  w.ascii('8BIM');
  w.uint16(id);
  w.pascal(name || '', 2);
  const lengthAt = w.length;
  w.uint32(0);
  const start = w.length;
  write(w);
  const len = w.length - start;
  w.patchUint32(lengthAt, len);
  if (len & 1) w.zeros(1);
}

function writeResolutionResource(w, resolution) {
  writeResource(w, 1005, '', (b) => {
    const fixed = Math.round(resolution * 65536);
    b.uint32(fixed); // horizontal resolution, 16.16 fixed
    b.uint16(1);     // display unit: pixels per inch
    b.uint16(1);     // width unit: inches
    b.uint32(fixed); // vertical resolution
    b.uint16(1);
    b.uint16(1);
  });
}

/** 1006 — the alpha channel names, packed Pascal strings with no padding. */
function writeAlphaNamesResource(w, channels) {
  writeResource(w, 1006, '', (b) => {
    for (const ch of channels) b.pascal(ch.name || 'Alpha', 1);
  });
}

/**
 * One 13-byte display record per alpha channel: colour space, four 16-bit
 * colour components, the overlay opacity and the channel kind. Kind 0 is
 * "selected areas", which is what our channels mean — white is selected.
 */
function writeDisplayRecord(b) {
  b.uint16(0);      // colour space: RGB
  b.uint16(65535);  // red
  b.uint16(0);
  b.uint16(0);
  b.uint16(0);
  b.uint16(50);     // overlay opacity, 0..100
  b.byte(0);        // kind: 0 = selected areas
}

/** 1053 (pre-CS3) and 1077 (CS3 and later) carry the same records. */
function writeDisplayInfoResources(w, channels) {
  writeResource(w, 1053, '', (b) => {
    for (let i = 0; i < channels.length; i++) writeDisplayRecord(b);
  });
  writeResource(w, 1077, '', (b) => {
    b.uint32(1); // version
    for (let i = 0; i < channels.length; i++) writeDisplayRecord(b);
  });
}

/**
 * 1032 — grid and guides. The header carries the (unused by us) grid cycle,
 * then one record per guide: the location as a 27.5 fixed-point number, so
 * pixels × 32, plus a direction byte where 0 is vertical and 1 horizontal.
 */
function writeGuidesResource(w, guides) {
  writeResource(w, 0x0408, '', (b) => {
    b.uint32(1);   // version
    b.uint32(576); // grid cycle across: 18 pt in 1/32 pt units
    b.uint32(576); // grid cycle down
    b.uint32(guides.length);
    for (const g of guides) {
      const pos = Number(g.pos) || 0;
      b.uint32(Math.max(0, Math.round(pos * 32)));
      b.byte(g.axis === 'h' ? 1 : 0);
    }
  });
}

/* --- Vector paths (resources 2000-2997, name in 2999) -------------- */

const PATH_FIXED_824 = 16777216; // 2^24

/** 8.24 fixed point: a fraction of the document width or height. */
function writeFixed824(w, value) {
  const v = Number.isFinite(value) ? Math.max(-127, Math.min(127, value)) : 0;
  w.int32(Math.round(v * PATH_FIXED_824));
}

/** Every path record is a uint16 selector plus exactly 24 bytes of data. */
function writePathRecord(w, selector, write) {
  w.uint16(selector);
  const start = w.length;
  if (write) write(w);
  const used = w.length - start;
  if (used > 24) throw new Error('[psd] path record overflow');
  if (used < 24) w.zeros(24 - used);
}

/**
 * A Bezier knot: preceding control point, anchor, leaving control point — each
 * as vertical then horizontal, both fractions of the document size.
 */
function writeKnot(w, point, width, height) {
  const inH = point.in || point;
  const outH = point.out || point;
  writeFixed824(w, inH.y / height);
  writeFixed824(w, inH.x / width);
  writeFixed824(w, point.y / height);
  writeFixed824(w, point.x / width);
  writeFixed824(w, outH.y / height);
  writeFixed824(w, outH.x / width);
}

function writePathBody(w, path, width, height) {
  // Photoshop opens every path resource with the fill-rule record.
  writePathRecord(w, 6, null);
  for (const sp of path.subpaths || []) {
    const points = (sp && sp.points) || [];
    if (!points.length) continue;
    const closed = !!sp.closed;
    writePathRecord(w, closed ? 0 : 3, (b) => b.uint16(points.length));
    for (const pt of points) {
      // "Linked" means the two handles are locked to one another; a corner
      // point with no handles at all is always the unlinked flavour.
      const linked = !!(pt.in && pt.out) && pt.corner === false;
      const selector = closed ? (linked ? 1 : 2) : (linked ? 4 : 5);
      writePathRecord(w, selector, (b) => writeKnot(b, pt, width, height));
    }
  }
}

function writePathResources(w, doc) {
  const paths = (doc.paths || []).filter((p) => p && (p.subpaths || []).some((sp) => sp && (sp.points || []).length));
  if (!paths.length) return;
  // 2000..2997 is the whole range Photoshop reserves for paths.
  const max = Math.min(paths.length, 998);
  if (paths.length > max) {
    console.warn(`[psd] only the first ${max} paths fit in image resources 2000-2997; ${paths.length - max} were not written`);
  }
  for (let i = 0; i < max; i++) {
    const path = paths[i];
    const name = path.name || `Path ${i + 1}`;
    writeResource(w, 2000 + i, name, (b) => writePathBody(b, path, doc.width, doc.height));
  }
  // 2999 is the clipping-path resource: the path name, its flatness and the
  // fill rule. We only ever use the name.
  writeResource(w, 2999, '', (b) => {
    b.pascal(paths[0].name || 'Path 1', 1);
    b.uint32(0); // flatness, 16.16 fixed
    b.uint16(0); // fill rule
  });
}

/**
 * Every extra channel the merged image section carries: the document's saved
 * alpha channels, then the live selection when there is one.
 * @returns {{name:string, plane:Uint8Array}[]}
 */
function collectExtraChannels(doc) {
  const out = [];
  for (const ch of doc.alphaChannels || []) {
    if (!ch) continue;
    out.push({ name: ch.name || 'Alpha', plane: channelPlane(ch, doc.width, doc.height) });
  }
  if (doc.selection && doc.selection.active) {
    const mask = doc.selection.mask;
    const plane = new Uint8Array(doc.width * doc.height);
    plane.set(mask.subarray(0, Math.min(mask.length, plane.length)));
    out.push({ name: SELECTION_CHANNEL_NAME, plane });
  }
  return out;
}

/** Greyscale plane for one alpha channel, from its canvas or its raw mask. */
function channelPlane(ch, width, height) {
  if (ch.canvas) {
    const src = ch.canvas.width === width && ch.canvas.height === height ? ch.canvas : scaleTo(ch.canvas, width, height);
    return maskPlane(src, width, height);
  }
  if (ch.mask && ch.mask.length === width * height) {
    const plane = new Uint8Array(width * height);
    plane.set(ch.mask);
    return plane;
  }
  throw new Error(`The alpha channel "${ch.name || 'Alpha'}" has no pixel data to save`);
}

/**
 * Write a single layer record. Returns the plan the pixel pass needs:
 * the rectangle, the channel list and where each length field lives.
 */
function writeLayerRecord(w, record, doc) {
  const { layer, kind } = record;
  const isDivider = kind === 'divider';
  const isGroup = kind === 'group' || isDivider;
  const isAdjustment = kind === 'adjustment';

  // Adjustment layers get top = left = bottom = right = 0.
  const rect = isGroup || isAdjustment ? null : rectOf(layer, doc);
  const top = rect ? rect.top : 0;
  const left = rect ? rect.left : 0;
  const bottom = rect ? rect.bottom : 0;
  const right = rect ? rect.right : 0;

  w.int32(top);
  w.int32(left);
  w.int32(bottom);
  w.int32(right);

  const hasMask = !isDivider && !!layer.mask;
  const channelIds = [-1, 0, 1, 2];
  if (hasMask) channelIds.push(-2);

  w.uint16(channelIds.length);
  const lengthSlots = [];
  for (const id of channelIds) {
    w.int16(id);
    lengthSlots.push(w.length);
    w.uint32(0); // patched after the pixels are written
  }

  w.ascii('8BIM');
  if (isDivider) w.ascii('norm');
  else w.ascii(blendKeyOf(layer.blendMode));

  w.byte(Math.round(Math.max(0, Math.min(1, layer.opacity == null ? 1 : layer.opacity)) * 255));
  w.byte(isDivider ? 0 : layer.clipped ? 1 : 0);
  // bit 1 = hidden, bit 3 = "bit 4 is meaningful", bit 4 = pixels irrelevant.
  let flags = 8;
  if (!isDivider && layer.visible === false) flags |= 2;
  if (isGroup || isAdjustment) flags |= 16;
  w.byte(flags);
  w.byte(0); // filler

  const extraLengthAt = w.length;
  w.uint32(0);
  const extraStart = w.length;

  // Layer mask data — our masks always cover the whole document.
  if (hasMask) {
    w.uint32(20);
    w.int32(0);
    w.int32(0);
    w.int32(doc.height);
    w.int32(doc.width);
    w.byte(0); // default colour: black outside the rectangle (unused here)
    let maskFlags = 0;
    // Bit 0 is "position relative to layer", which is the inverse of Photoshop's
    // link toggle: a linked mask moves with the layer, so it is NOT relative.
    if (layer.maskLinked === false) maskFlags |= 1;
    if (layer.maskEnabled === false) maskFlags |= 2;
    if (layer.maskInverted) maskFlags |= 4;
    w.byte(maskFlags);
    w.zeros(2);
  } else {
    w.uint32(0);
  }

  w.uint32(0); // blending ranges

  const name = isDivider ? '</Layer group>' : layer.name || 'Layer';
  w.pascal(name, 4);

  // Unicode name.
  w.ascii('8BIM');
  w.ascii('luni');
  const luniAt = w.length;
  w.uint32(0);
  const luniStart = w.length;
  w.unicodeString(name);
  w.alignTo(2);
  w.patchUint32(luniAt, w.length - luniStart);

  // Fill opacity. Photoshop defaults this to 255 when the key is absent, so
  // without it a layer with Fill < 100 % reopens fully filled.
  if (!isDivider && layer.fillOpacity != null && layer.fillOpacity < 1) {
    w.ascii('8BIM');
    w.ascii('iOpa');
    w.uint32(4);
    w.byte(Math.round(Math.max(0, Math.min(1, layer.fillOpacity)) * 255));
    w.zeros(3);
  }

  // Section divider for groups.
  if (isGroup) {
    w.ascii('8BIM');
    w.ascii('lsct');
    w.uint32(12);
    w.uint32(isDivider ? 3 : layer.expanded === false ? 2 : 1);
    w.ascii('8BIM');
    w.ascii(isDivider ? 'norm' : blendKeyOf(layer.blendMode));
  }

  // Layer effects. Dividers are synthetic records with no styles of their own.
  if (!isDivider) writeLayerEffects(w, layer);

  // Adjustment payload: the legacy binary key when one exists, then always the
  // private Pikado block so the round trip is lossless.
  if (isAdjustment && layer.adjustment) {
    writeLegacyAdjustment(w, layer.adjustment);
    writePrivateAdjustment(w, layer.adjustment);
  }

  // Live type and vector content.
  if (kind === 'text') writeTypeLayer(w, layer);
  else if (kind === 'shape') writeShapeLayer(w, layer, doc);

  w.patchUint32(extraLengthAt, w.length - extraStart);

  return { rect, channelIds, lengthSlots, hasMask, isGroup };
}

/* ------------------------------------------------------------------ */
/* Adjustment layer information                                        */
/* ------------------------------------------------------------------ */

/**
 * `8BIM` + 4-char key + uint32 data length + data, padded to an even length
 * (the declared length excludes the pad byte, as Photoshop writes it).
 */
function writeBlock(w, key, write) {
  w.ascii('8BIM');
  w.ascii(key);
  const lengthAt = w.length;
  w.uint32(0);
  const start = w.length;
  if (write) write(w);
  const len = w.length - start;
  w.patchUint32(lengthAt, len);
  if (len & 1) w.zeros(1);
  return len;
}

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const clampi = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

/**
 * The six adjustments Photoshop stores in a simple documented binary form.
 * Everything else is carried by the private block alone — Photoshop needs a
 * full descriptor for those, and a half-written descriptor is worse than none.
 */
function writeLegacyAdjustment(w, adjustment) {
  const kind = adjustment.kind;
  const p = adjustment.params || {};

  switch (kind) {
    case 'invert':
      // 'nvrt' carries no data at all.
      writeBlock(w, 'nvrt', null);
      return;

    case 'posterize':
      // int16 level count. Our range (2..255) is Photoshop's range.
      writeBlock(w, 'post', (b) => b.int16(clampi(num(p.levels, 4), 2, 255)));
      return;

    case 'threshold':
      // int16 threshold level, 1..255 in both models.
      writeBlock(w, 'thrs', (b) => b.int16(clampi(num(p.level, 128), 1, 255)));
      return;

    case 'brightness-contrast':
      writeBlock(w, 'brit', (b) => {
        // Our sliders use Photoshop's *modern* ranges (brightness -150..150,
        // contrast -50..100); the legacy 'brit' record is -100..100 on both
        // axes, so rescale rather than clipping the ends off. Contrast is
        // asymmetric, so each half is scaled against its own limit.
        const brightness = clampi((num(p.brightness, 0) / 150) * 100, -100, 100);
        const rawContrast = num(p.contrast, 0);
        const contrast = clampi(rawContrast < 0 ? (rawContrast / 50) * 100 : rawContrast, -100, 100);
        b.int16(brightness);
        b.int16(contrast);
        b.int16(128); // mean value the legacy algorithm pivots contrast around
        b.byte(0);    // lab colour flag
      });
      return;

    case 'levels':
      writeBlock(w, 'levl', (b) => writeLevelsBody(b, p.levels));
      return;

    case 'curves':
      writeBlock(w, 'curv', (b) => writeCurvesBody(b, p.curves));
      return;

    default:
      // vibrance, selective-color, shadows-highlights, color-lookup,
      // hdr-toning, replace-color, equalize, auto-*, gradient-map,
      // channel-mixer, black-white, photo-filter, color-balance,
      // hue-saturation, exposure and desaturate have no simple legacy form.
  }
}

/** One 10-byte Levels record: input black/white, output black/white, gamma×100. */
function writeLevelRecord(w, L) {
  const src = L && typeof L === 'object' ? L : {};
  const ib = clampi(num(src.ib, 0), 0, 253);
  const iw = clampi(num(src.iw, 255), ib + 2, 255);
  w.uint16(ib);
  w.uint16(iw);
  w.uint16(clampi(num(src.ob, 0), 0, 255));
  w.uint16(clampi(num(src.ow, 255), 0, 255));
  w.uint16(clampi(num(src.ig, 1) * 100, 10, 999)); // gamma is stored ×100
}

const IDENTITY_LEVEL = { ib: 0, iw: 255, ob: 0, ow: 255, ig: 1 };

/** 'levl': uint16 version then exactly 29 channel records. */
function writeLevelsBody(w, levels) {
  const v = levels && typeof levels === 'object' ? levels : {};
  w.uint16(2); // version
  const order = ['rgb', 'r', 'g', 'b'];
  for (let i = 0; i < 29; i++) {
    writeLevelRecord(w, (order[i] && v[order[i]]) || IDENTITY_LEVEL);
  }
}

const IDENTITY_CURVE = [{ x: 0, y: 0 }, { x: 255, y: 255 }];

function curvePoints(points) {
  if (!Array.isArray(points) || points.length < 2) return IDENTITY_CURVE;
  const pts = points
    .filter((pt) => pt && Number.isFinite(Number(pt.x)) && Number.isFinite(Number(pt.y)))
    .map((pt) => ({ x: clampi(Number(pt.x), 0, 255), y: clampi(Number(pt.y), 0, 255) }))
    .sort((a, b) => a.x - b.x);
  // Photoshop caps a curve at 19 points; drop interior points evenly if needed.
  if (pts.length > 19) {
    const kept = [pts[0]];
    for (let i = 1; i < 18; i++) kept.push(pts[Math.round((i * (pts.length - 1)) / 18)]);
    kept.push(pts[pts.length - 1]);
    return kept;
  }
  return pts.length >= 2 ? pts : IDENTITY_CURVE;
}

/**
 * 'curv': padding byte, uint16 version, a uint32 channel bit set (bit 0 is the
 * composite, bits 1..3 are R/G/B) and then one point list per selected bit —
 * each point stored output-first, as the format requires.
 */
function writeCurvesBody(w, curves) {
  const c = curves && typeof curves === 'object' ? curves : {};
  const order = ['rgb', 'r', 'g', 'b'];
  w.byte(0);
  w.uint16(1); // version
  w.uint32(0b1111); // composite + red + green + blue
  for (const ch of order) {
    const pts = curvePoints(c[ch]);
    w.uint16(pts.length);
    for (const pt of pts) {
      w.uint16(pt.y); // output
      w.uint16(pt.x); // input
    }
  }
}

/**
 * The Pikado-private adjustment block.
 *
 * Signature `8BIM`, key `pkAd` — "Pikado Adjustment". `pkAd` is not, and has
 * never been, a Photoshop additional-layer-info key, and the mixed-case shape
 * keeps it clear of Adobe's own naming; conforming readers skip keys they do
 * not know, so Photoshop, Photopea and psd-tools all ignore it safely.
 *
 * Data layout (all integers big-endian, like everything else in a PSD):
 *
 *   0   4 bytes   ASCII magic 'PKAD'
 *   4   2 bytes   uint16 format version (currently 1)
 *   6   4 bytes   uint32 length in bytes of the JSON payload
 *  10   n bytes   UTF-8 JSON: {"kind": <pikado adjustment id>, "params": {...}}
 *
 * The block is then padded to an even total length like any other tagged block.
 */
function writePrivateAdjustment(w, adjustment) {
  let value;
  try {
    JSON.stringify(adjustment.params || {});
    value = { kind: adjustment.kind, params: adjustment.params || {} };
  } catch (err) {
    // A params object that cannot be serialised must not lose the layer.
    console.warn('[psd] adjustment params could not be serialised', err);
    value = { kind: adjustment.kind, params: {} };
  }
  writePrivatePayload(w, 'pkAd', 'PKAD', value, 'adjustment');
}

/**
 * Every property name anywhere inside `value`, sorted — a `JSON.stringify`
 * property list, which fixes the order objects are written in.
 *
 * Because the list also *filters*, it has to name every key in the tree or
 * serialisation would silently drop the ones it misses; array elements are
 * unaffected by a property list, so indices need no entry. Returns undefined for
 * a value with no object in it, which leaves `stringify` in its default mode.
 */
function sortedKeys(value) {
  const keys = new Set();
  const seen = new Set();
  const walk = (v) => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { for (const item of v) walk(item); return; }
    for (const k of Object.keys(v)) { keys.add(k); walk(v[k]); }
  };
  walk(value);
  return keys.size ? [...keys].sort() : undefined;
}

/**
 * The shared body of every Pikado-private block: a four-character magic, a
 * uint16 format version, a uint32 byte count and that many bytes of UTF-8 JSON.
 * `pkAd` carries `{kind, params}`, `pkTx` carries `layer.text` and `pkSh`
 * carries `layer.shape`. All three are keys Adobe has never used, and every
 * conforming reader skips additional-layer-info keys it does not know.
 *
 * @param {ByteWriter} w
 * @param {string} key the four-character block key
 * @param {string} magic the four-character payload magic
 * Keys are emitted in sorted order. `JSON.stringify` otherwise follows
 * insertion order, so the same document saved from memory and saved after a
 * reopen produced byte-different files that differed *only* in key order —
 * the payloads were equal as data. Sorting makes the bytes a function of the
 * content alone, which is what lets the round-trip test assert byte identity.
 *
 * @param {ByteWriter} w
 * @param {string} key the four-character block key
 * @param {string} magic the four-character payload magic
 * @param {*} value anything `JSON.stringify` accepts
 * @param {string} label used in the warning when serialisation fails
 */
function writePrivatePayload(w, key, magic, value, label) {
  let json;
  try {
    json = JSON.stringify(value, sortedKeys(value));
  } catch (err) {
    console.warn(`[psd] the ${label} could not be serialised; only the interoperable blocks were written`, err);
    return;
  }
  if (typeof json !== 'string') return;
  const payload = new TextEncoder().encode(json);
  writeBlock(w, key, (b) => {
    b.ascii(magic);
    b.uint16(1);
    b.uint32(payload.length);
    b.bytes(payload);
  });
}

/* ------------------------------------------------------------------ */
/* Layer effects — the 'lfx2' block                                    */
/* ------------------------------------------------------------------ */

/** Pikado blend id -> the enum value Photoshop uses inside effects. */
const EFFECT_BLEND_ENUMS = {
  normal: 'Nrml', dissolve: 'Dslv', darken: 'Drkn', multiply: 'Mltp',
  'color-burn': 'CBrn', 'linear-burn': 'linearBurn', 'darker-color': 'darkerColor',
  lighten: 'Lghn', screen: 'Scrn', 'color-dodge': 'CDdg', 'linear-dodge': 'linearDodge',
  'lighter-color': 'lighterColor', overlay: 'Ovrl', 'soft-light': 'SftL',
  'hard-light': 'HrdL', 'vivid-light': 'vividLight', 'linear-light': 'linearLight',
  'pin-light': 'pinLight', 'hard-mix': 'hardMix', difference: 'Dfrn', exclusion: 'Xclu',
  subtract: 'blendSubtraction', divide: 'blendDivide',
  hue: 'H   ', saturation: 'Strt', color: 'Clr ', luminosity: 'Lmns',
};

const frac01 = (v, fallback = 0) => {
  const n = Number.isFinite(Number(v)) ? Number(v) : fallback;
  return Math.max(0, Math.min(1, n));
};

/** Our opacities, spreads and chokes are 0..1; Photoshop wants a percentage. */
const asPercent = (v, fallback = 0) => DESC.pct(frac01(v, fallback) * 100);

function blendEnum(id) {
  return DESC.enm('BlnM', EFFECT_BLEND_ENUMS[id] || 'Nrml');
}

/** `RGBC` descriptor. Photoshop stores the components as 0..255 doubles. */
function colorDescriptor(color) {
  const c = parseColor(color || '#000000');
  return DESC.obj('RGBC', {
    'Rd  ': DESC.doub(c.r),
    'Grn ': DESC.doub(c.g),
    'Bl  ': DESC.doub(c.b),
  });
}

const FALLBACK_STOPS = [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }];

/**
 * `Grdn` descriptor. Stop locations are 0..4096 `long`s, so a position round
 * trips to within 1/4096.
 */
function gradientDescriptor(stops) {
  const list = Array.isArray(stops) && stops.length >= 2 ? stops : FALLBACK_STOPS;
  const colors = list.map((s) => DESC.obj('Clrt', {
    'Clr ': colorDescriptor(s && s.color),
    Type: DESC.enm('Clry', 'UsrS'),
    Lctn: DESC.long(Math.round(frac01(s && s.pos) * 4096)),
    Mdpn: DESC.long(50),
  }));
  const transparency = [0, 1].map((pos) => DESC.obj('TrnS', {
    Opct: DESC.pct(100),
    Lctn: DESC.long(pos * 4096),
    Mdpn: DESC.long(50),
  }));
  return DESC.obj('Grdn', {
    'Nm  ': DESC.text('Custom'),
    GrdF: DESC.enm('GrdF', 'CstS'),
    Intr: DESC.doub(4096),
    Clrs: DESC.list(colors),
    Trns: DESC.list(transparency),
  });
}

/**
 * `Ptrn` descriptor. Photoshop names a tile in the document's pattern table;
 * we have no such table, so both the name and the identifier carry our own
 * pattern id — `psd-read.js` restores it when the id is still in the library.
 */
function patternDescriptor(patternId) {
  const id = patternId == null ? '' : String(patternId);
  return DESC.obj('Ptrn', { 'Nm  ': DESC.text(id), Idnt: DESC.text(id) });
}

function pointDescriptor(x, y) {
  return DESC.obj('Pnt ', { Hrzn: DESC.pct(x), Vrtc: DESC.pct(y) });
}

/** A `Pnt ` in pixels — what the live-shape origination blocks use. */
function pixelPointDescriptor(x, y) {
  return DESC.obj('Pnt ', { Hrzn: DESC.px(x), Vrtc: DESC.px(y) });
}

/**
 * Gradient angles: which way is positive.
 *
 * Photoshop's `Angl` is measured **anticlockwise from the positive x axis** —
 * 0° puts the first stop at the left, 90° puts it at the bottom.
 *
 * Pikado has two gradient renderers and they do *not* agree:
 *
 *   - `src/paint/gradients.js` (`axisFrom`) and the layer-effect renderer in
 *     `src/effects/effect-renderers.js` (`gradientAxis`) both build their axis
 *     with `dy = -sin(angle)`, which in a y-down canvas is anticlockwise. Those
 *     already match Photoshop, so `lfx2` gradient angles are written verbatim.
 *   - `makeFillStyle` in `src/vector/path.js` — the renderer behind a shape or
 *     fill layer's gradient — uses `dy = +sin(angle)`, i.e. **clockwise**. Its
 *     90° puts the first stop at the *top*, the mirror image of Photoshop's.
 *
 * So a `GdFl` angle, and only a `GdFl` angle, has to change sign in both
 * directions. Negating is an involution, so the Pikado round trip is exact; the
 * point of doing it is that Photoshop then orients the gradient the same way we
 * render it. If this ever looks wrong again, check which of the two renderers
 * the layer in question actually uses before flipping the sign back.
 */
const psdGradientAngle = (pikadoAngle) => -num(pikadoAngle, 0);

/** The inverse of `psdGradientAngle`; used by `psd-read.js` on `GdFl` only. */
export const pikadoGradientAngle = (psdAngle) => -num(psdAngle, 0);

const BEVEL_STYLE_ENUMS = {
  inner: 'InrB', outer: 'OtrB', emboss: 'Embs', pillow: 'PlEb', stroke: 'strokeEmboss',
};
const BEVEL_TECHNIQUE_ENUMS = {
  smooth: 'SfBL', 'chisel-hard': 'PrBL', 'chisel-soft': 'Slmt',
};
const GRADIENT_STYLE_ENUMS = {
  linear: 'Lnr ', radial: 'Rdl ', angle: 'Angl', reflected: 'Rflc', diamond: 'Dmnd',
};
const STROKE_POSITION_ENUMS = { outside: 'OutF', inside: 'InsF', center: 'CtrF' };
const STROKE_FILL_ENUMS = { color: 'SClr', gradient: 'GrFl', pattern: 'Ptrn' };

/**
 * One descriptor per effect, keyed the way Photoshop keys them. Only effects
 * present in `layer.styles` are written, disabled ones included: `enab` carries
 * the toggle, so a configured-but-off effect survives the round trip.
 */
const EFFECT_DESCRIPTORS = {
  dropShadow: (c) => ['DrSh', DESC.obj('DrSh', {
    enab: DESC.bool(c.enabled),
    'Md  ': blendEnum(c.blendMode || 'multiply'),
    'Clr ': colorDescriptor(c.color),
    Opct: asPercent(c.opacity, 0.75),
    uglg: DESC.bool(c.useGlobalLight !== false),
    lagl: DESC.ang(num(c.angle, 120)),
    Dstn: DESC.px(num(c.distance, 5)),
    Ckmt: asPercent(c.spread, 0),
    blur: DESC.px(num(c.size, 5)),
    Nose: asPercent(c.noise, 0),
    AntA: DESC.bool(false),
    layerConceals: DESC.bool(true),
  })],
  innerShadow: (c) => ['IrSh', DESC.obj('IrSh', {
    enab: DESC.bool(c.enabled),
    'Md  ': blendEnum(c.blendMode || 'multiply'),
    'Clr ': colorDescriptor(c.color),
    Opct: asPercent(c.opacity, 0.75),
    uglg: DESC.bool(c.useGlobalLight !== false),
    lagl: DESC.ang(num(c.angle, 120)),
    Dstn: DESC.px(num(c.distance, 5)),
    Ckmt: asPercent(c.choke, 0),
    blur: DESC.px(num(c.size, 5)),
    Nose: asPercent(c.noise, 0),
    AntA: DESC.bool(false),
  })],
  outerGlow: (c) => ['OrGl', DESC.obj('OrGl', {
    enab: DESC.bool(c.enabled),
    'Md  ': blendEnum(c.blendMode || 'screen'),
    'Clr ': colorDescriptor(c.color),
    Opct: asPercent(c.opacity, 0.75),
    GlwT: DESC.enm('BETE', 'SfBL'),
    Ckmt: asPercent(c.spread, 0),
    blur: DESC.px(num(c.size, 10)),
    Nose: asPercent(c.noise, 0),
    ShdN: DESC.pct(0),
    AntA: DESC.bool(false),
  })],
  innerGlow: (c) => ['IrGl', DESC.obj('IrGl', {
    enab: DESC.bool(c.enabled),
    'Md  ': blendEnum(c.blendMode || 'screen'),
    'Clr ': colorDescriptor(c.color),
    Opct: asPercent(c.opacity, 0.75),
    GlwT: DESC.enm('BETE', 'SfBL'),
    Ckmt: asPercent(c.choke, 0),
    blur: DESC.px(num(c.size, 10)),
    Nose: asPercent(c.noise, 0),
    ShdN: DESC.pct(0),
    glwS: DESC.enm('IGSr', c.source === 'center' ? 'SrcC' : 'SrcE'),
    AntA: DESC.bool(false),
  })],
  bevelEmboss: (c) => ['ebbl', DESC.obj('ebbl', {
    enab: DESC.bool(c.enabled),
    hglM: blendEnum(c.highlightMode || 'screen'),
    hglC: colorDescriptor(c.highlightColor || '#ffffff'),
    hglO: asPercent(c.highlightOpacity, 0.75),
    sdwM: blendEnum(c.shadowMode || 'multiply'),
    sdwC: colorDescriptor(c.shadowColor || '#000000'),
    sdwO: asPercent(c.shadowOpacity, 0.75),
    bvlT: DESC.enm('bvlT', BEVEL_TECHNIQUE_ENUMS[c.technique] || 'SfBL'),
    bvlS: DESC.enm('BESl', BEVEL_STYLE_ENUMS[c.style] || 'InrB'),
    uglg: DESC.bool(c.useGlobalLight !== false),
    lagl: DESC.ang(num(c.angle, 120)),
    Lald: DESC.ang(num(c.altitude, 30)),
    srgR: DESC.pct(num(c.depth, 1) * 100),
    blur: DESC.px(num(c.size, 5)),
    bvlD: DESC.enm('BESs', c.direction === 'down' ? 'In  ' : 'Out '),
    Sftn: DESC.px(num(c.soften, 0)),
    useShape: DESC.bool(false),
    useTexture: DESC.bool(false),
  })],
  satin: (c) => ['ChFX', DESC.obj('ChFX', {
    enab: DESC.bool(c.enabled),
    'Md  ': blendEnum(c.blendMode || 'multiply'),
    'Clr ': colorDescriptor(c.color),
    Opct: asPercent(c.opacity, 0.5),
    lagl: DESC.ang(num(c.angle, 19)),
    Dstn: DESC.px(num(c.distance, 11)),
    blur: DESC.px(num(c.size, 14)),
    Invr: DESC.bool(c.invert !== false),
    AntA: DESC.bool(false),
  })],
  colorOverlay: (c) => ['SoFi', DESC.obj('SoFi', {
    enab: DESC.bool(c.enabled),
    'Md  ': blendEnum(c.blendMode || 'normal'),
    'Clr ': colorDescriptor(c.color),
    Opct: asPercent(c.opacity, 1),
  })],
  gradientOverlay: (c) => ['GrFl', DESC.obj('GrFl', {
    enab: DESC.bool(c.enabled),
    'Md  ': blendEnum(c.blendMode || 'normal'),
    Opct: asPercent(c.opacity, 1),
    Grad: gradientDescriptor(c.stops),
    Type: DESC.enm('GrdT', GRADIENT_STYLE_ENUMS[c.style] || 'Lnr '),
    Rvrs: DESC.bool(c.reverse),
    Angl: DESC.ang(num(c.angle, 90)),
    'Scl ': DESC.pct(num(c.scale, 1) * 100),
    Algn: DESC.bool(true),
    Ofst: pointDescriptor(0, 0),
  })],
  patternOverlay: (c) => ['patternFill', DESC.obj('patternFill', {
    enab: DESC.bool(c.enabled),
    'Md  ': blendEnum(c.blendMode || 'normal'),
    Opct: asPercent(c.opacity, 1),
    Ptrn: patternDescriptor(c.patternId),
    Angl: DESC.ang(0),
    'Scl ': DESC.pct(num(c.scale, 1) * 100),
    Algn: DESC.bool(true),
    phase: pointDescriptor(0, 0),
  })],
  stroke: (c) => ['FrFX', DESC.obj('FrFX', {
    enab: DESC.bool(c.enabled),
    Styl: DESC.enm('FStl', STROKE_POSITION_ENUMS[c.position] || 'OutF'),
    PntT: DESC.enm('FrFl', STROKE_FILL_ENUMS[c.fillType] || 'SClr'),
    'Md  ': blendEnum(c.blendMode || 'normal'),
    Opct: asPercent(c.opacity, 1),
    'Sz  ': DESC.px(num(c.size, 3)),
    'Clr ': colorDescriptor(c.color),
    Grad: gradientDescriptor(c.stops),
    Angl: DESC.ang(num(c.angle, 90)),
    Type: DESC.enm('GrdT', 'Lnr '),
    Rvrs: DESC.bool(false),
    'Scl ': DESC.pct(100),
  })],
};

/**
 * Write `layer.styles` as an `lfx2` additional-layer-info block.
 * Nothing is written when the layer carries no styles at all.
 */
function writeLayerEffects(w, layer) {
  const styles = layer && layer.styles;
  if (!styles || typeof styles !== 'object') return;

  const items = {
    'Scl ': DESC.pct(100),
    masterFXSwitch: DESC.bool(true),
  };
  let written = 0;
  for (const id of Object.keys(EFFECT_DESCRIPTORS)) {
    const cfg = styles[id];
    if (!cfg || typeof cfg !== 'object') continue;
    const [key, value] = EFFECT_DESCRIPTORS[id](cfg);
    items[key] = value;
    written++;
  }
  if (!written) return;

  writeBlock(w, 'lfx2', (b) => {
    b.uint32(0); // object effects version
    writeDescriptorBlock(b, { classID: 'null', items });
  });
}

/* ------------------------------------------------------------------ */
/* Type layers — the 'TySh' block                                      */
/* ------------------------------------------------------------------ */

/**
 * The face a type layer's font resolves to.
 *
 * A PSD names one *face* — one font file — by its PostScript name, so bold and
 * italic belong in that name whenever the family genuinely ships them as
 * separate files: `Arial-BoldMT` rather than `ArialMT` plus `/FauxBold`.
 * `postScriptFace` in `src/text/fonts.js` owns the per-family table and hands
 * back the faux flags for whatever the family cannot supply for real (Tahoma
 * has no italic file; Impact has nothing but a regular).
 *
 * Not verified against Photoshop — no install was available here. What *is*
 * verified is that every name written round trips back to the same family,
 * weight and slant through `familyFromPostScriptName`, and that the names are
 * the documented constants of the shipping font files rather than constructions
 * of our own. A name Photoshop cannot resolve is worse than faux styling, which
 * is why the table lists a face only where it is a known constant.
 */
function textFace(t) {
  return postScriptFace(t.font, t.weight, t.italic || t.style === 'italic' ? 'italic' : 'normal');
}

/** `/Justification` in EngineData, and the order `psd-read.js` decodes. */
const TEXT_JUSTIFICATION = { left: 0, right: 1, center: 2, justify: 3 };

/** `/AntiAlias` in EngineData. */
const TEXT_ANTIALIAS = { none: 0, sharp: 1, crisp: 2, strong: 3, smooth: 4 };

/** The `AntA` descriptor enum, which is what Photoshop's UI actually reads. */
const ANTIALIAS_ENUMS = {
  none: 'Anno', sharp: 'antiAliasSharp', crisp: 'antiAliasCrisp',
  strong: 'antiAliasStrong', smooth: 'antiAliasSmooth',
};

/** Pikado warp style -> the `warpStyle` enum value. */
const WARP_STYLE_ENUMS = {
  none: 'warpNone', arc: 'warpArc', arch: 'warpArch', bulge: 'warpBulge',
  flag: 'warpFlag', wave: 'warpWave', fish: 'warpFish', rise: 'warpRise',
};

/**
 * A literal string inside EngineData: `(`, a UTF-16BE byte-order mark, the
 * UTF-16BE code units, `)`. Bytes that would end the literal are backslash
 * escaped. The result is a Latin-1 JS string — one character per byte.
 */
function engineString(s) {
  const text = s == null ? '' : String(s);
  let out = '(þÿ';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    for (const b of [(code >>> 8) & 255, code & 255]) {
      if (b === 0x28 || b === 0x29 || b === 0x5c) out += '\\';
      out += String.fromCharCode(b);
    }
  }
  return `${out})`;
}

/** EngineData writes every real number with a decimal point. */
function engineNumber(v) {
  const n = Number.isFinite(Number(v)) ? Number(v) : 0;
  const r = Math.round(n * 1e4) / 1e4;
  return Number.isInteger(r) ? `${r}.0` : String(r);
}

const engineBool = (v) => (v ? 'true' : 'false');

/**
 * The `/StyleSheetData` dictionary — one style run covers the whole string, so
 * this is the only place the font, size, colour and decorations are stated.
 */
function styleSheetData(style, indent) {
  const t = '\t'.repeat(indent);
  const i = `${t}\t`;
  return [
    `${t}<<`,
    `${i}/Font 0`,
    `${i}/FontSize ${engineNumber(style.size)}`,
    `${i}/FauxBold ${engineBool(style.fauxBold)}`,
    `${i}/FauxItalic ${engineBool(style.fauxItalic)}`,
    `${i}/AutoLeading ${engineBool(style.autoLeading)}`,
    `${i}/Leading ${engineNumber(style.leading)}`,
    `${i}/HorizontalScale 1.0`,
    `${i}/VerticalScale 1.0`,
    `${i}/Tracking ${Math.round(style.tracking)}`,
    `${i}/BaselineShift ${engineNumber(style.baselineShift)}`,
    `${i}/AutoKerning true`,
    `${i}/Kerning 0`,
    `${i}/FontCaps 0`,
    `${i}/FontBaseline 0`,
    `${i}/Underline ${engineBool(style.underline)}`,
    `${i}/Strikethrough ${engineBool(style.strikethrough)}`,
    `${i}/Ligatures true`,
    `${i}/DLigatures false`,
    `${i}/BaselineDirection 2`,
    `${i}/Tsume 0.0`,
    `${i}/StyleRunAlignment 2`,
    `${i}/Language 0`,
    `${i}/NoBreak false`,
    `${i}/FillColor`,
    `${i}<<`,
    `${i}\t/Type 1`,
    `${i}\t/Values [ ${engineNumber(style.alpha)} ${engineNumber(style.r)} ${engineNumber(style.g)} ${engineNumber(style.b)} ]`,
    `${i}>>`,
    `${i}/StrokeColor`,
    `${i}<<`,
    `${i}\t/Type 1`,
    `${i}\t/Values [ 1.0 0.0 0.0 0.0 ]`,
    `${i}>>`,
    `${i}/FillFlag true`,
    `${i}/StrokeFlag false`,
    `${i}/FillFirst true`,
    `${i}/YUnderline 1`,
    `${i}/OutlineWidth 1.0`,
    `${i}/CharacterDirection 0`,
    `${i}/HindiNumbers false`,
    `${i}/Kashida 1`,
    `${i}/DiacriticPos 2`,
    `${t}>>`,
  ];
}

/** The `/Properties` dictionary of a paragraph sheet. */
function paragraphProperties(style, indent) {
  const t = '\t'.repeat(indent);
  const i = `${t}\t`;
  return [
    `${t}<<`,
    `${i}/Justification ${style.justification}`,
    `${i}/FirstLineIndent 0.0`,
    `${i}/StartIndent 0.0`,
    `${i}/EndIndent 0.0`,
    `${i}/SpaceBefore 0.0`,
    `${i}/SpaceAfter 0.0`,
    `${i}/AutoHyphenate true`,
    `${i}/HyphenatedWordSize 6`,
    `${i}/PreHyphen 2`,
    `${i}/PostHyphen 2`,
    `${i}/ConsecutiveHyphens 8`,
    `${i}/Zone 36.0`,
    `${i}/WordSpacing [ .8 1.0 1.33 ]`,
    `${i}/LetterSpacing [ 0.0 0.0 0.0 ]`,
    `${i}/GlyphSpacing [ 1.0 1.0 1.0 ]`,
    `${i}/AutoLeading 1.2`,
    `${i}/LeadingType 0`,
    `${i}/Hanging false`,
    `${i}/Burasagari false`,
    `${i}/KinsokuOrder 0`,
    `${i}/EveryLineComposer false`,
    `${t}>>`,
  ];
}

/** `/ResourceDict` and `/DocumentResources` carry the same tables. */
function resourceDict(style, indent) {
  const t = '\t'.repeat(indent);
  const i = `${t}\t`;
  return [
    `${t}<<`,
    `${i}/KinsokuSet [ ]`,
    `${i}/MojiKumiSet [ ]`,
    `${i}/TheNormalStyleSheet 0`,
    `${i}/TheNormalParagraphSheet 0`,
    `${i}/ParagraphSheetSet [`,
    `${i}<<`,
    `${i}\t/Name ${engineString('Normal RGB')}`,
    `${i}\t/DefaultStyleSheet 0`,
    `${i}\t/Properties`,
    ...paragraphProperties(style, indent + 2),
    `${i}>>`,
    `${i}]`,
    `${i}/StyleSheetSet [`,
    `${i}<<`,
    `${i}\t/Name ${engineString('Normal RGB')}`,
    `${i}\t/StyleSheetData`,
    ...styleSheetData(style, indent + 2),
    `${i}>>`,
    `${i}]`,
    `${i}/FontSet [`,
    `${i}<<`,
    `${i}\t/Name ${engineString(style.fontName)}`,
    `${i}\t/Script 0`,
    `${i}\t/FontType 1`,
    `${i}\t/Synthetic 0`,
    `${i}>>`,
    `${i}]`,
    `${i}/SuperscriptSize .583`,
    `${i}/SuperscriptPosition .333`,
    `${i}/SubscriptSize .583`,
    `${i}/SubscriptPosition .333`,
    `${i}/SmallCapSize .7`,
    `${t}>>`,
  ];
}

/**
 * Build the `EngineData` blob for a type layer.
 *
 * EngineData is Adobe's own serialisation of the text engine's state — a
 * token stream of nested `<< /Key value >>` dictionaries, not a descriptor.
 * What is written here is the structure Photoshop emits for a single-style
 * type layer: an `/EngineDict` holding the string, one paragraph run per
 * paragraph and one style run for the whole string, plus the `/ResourceDict`
 * and `/DocumentResources` tables the engine resolves `/Font 0` against.
 *
 * @param {object} style the flattened run properties
 * @param {string} text the string, with `\r` paragraph separators
 * @returns {string} a Latin-1 string — one character per byte
 */
function buildEngineData(style, text) {
  // Photoshop terminates the stored string with a paragraph separator, and the
  // run-length arrays must cover it.
  const stored = `${text}\r`;
  const paragraphs = stored.split('\r').slice(0, -1).map((p) => p.length + 1);
  if (!paragraphs.length) paragraphs.push(1);
  const total = stored.length;

  const L = [];
  const push = (...lines) => L.push(...lines);

  push('');
  push('<<');
  push('\t/EngineDict');
  push('\t<<');
  push('\t\t/Editor');
  push('\t\t<<');
  push(`\t\t\t/Text ${engineString(stored)}`);
  push('\t\t>>');

  push('\t\t/ParagraphRun');
  push('\t\t<<');
  push('\t\t\t/DefaultRunData');
  push('\t\t\t<<');
  push('\t\t\t\t/ParagraphSheet');
  push('\t\t\t\t<<');
  push('\t\t\t\t\t/DefaultStyleSheet 0');
  push('\t\t\t\t\t/Properties');
  push('\t\t\t\t\t<<');
  push('\t\t\t\t\t>>');
  push('\t\t\t\t>>');
  push('\t\t\t\t/Adjustments');
  push('\t\t\t\t<<');
  push('\t\t\t\t\t/Axis [ 1.0 0.0 1.0 ]');
  push('\t\t\t\t\t/XY [ 0.0 0.0 ]');
  push('\t\t\t\t>>');
  push('\t\t\t>>');
  push('\t\t\t/RunArray [');
  for (let i = 0; i < paragraphs.length; i++) {
    push('\t\t\t<<');
    push('\t\t\t\t/ParagraphSheet');
    push('\t\t\t\t<<');
    push('\t\t\t\t\t/DefaultStyleSheet 0');
    push('\t\t\t\t\t/Properties');
    push(...paragraphProperties(style, 5));
    push('\t\t\t\t>>');
    push('\t\t\t\t/Adjustments');
    push('\t\t\t\t<<');
    push('\t\t\t\t\t/Axis [ 1.0 0.0 1.0 ]');
    push('\t\t\t\t\t/XY [ 0.0 0.0 ]');
    push('\t\t\t\t>>');
    push('\t\t\t>>');
  }
  push('\t\t\t]');
  push(`\t\t\t/RunLengthArray [ ${paragraphs.join(' ')} ]`);
  push('\t\t\t/IsJoinable 1');
  push('\t\t>>');

  push('\t\t/StyleRun');
  push('\t\t<<');
  push('\t\t\t/DefaultRunData');
  push('\t\t\t<<');
  push('\t\t\t\t/StyleSheet');
  push('\t\t\t\t<<');
  push('\t\t\t\t\t/StyleSheetData');
  push('\t\t\t\t\t<<');
  push('\t\t\t\t\t>>');
  push('\t\t\t\t>>');
  push('\t\t\t>>');
  push('\t\t\t/RunArray [');
  push('\t\t\t<<');
  push('\t\t\t\t/StyleSheet');
  push('\t\t\t\t<<');
  push('\t\t\t\t\t/StyleSheetData');
  push(...styleSheetData(style, 5));
  push('\t\t\t\t>>');
  push('\t\t\t>>');
  push('\t\t\t]');
  push(`\t\t\t/RunLengthArray [ ${total} ]`);
  push('\t\t\t/IsJoinable 2');
  push('\t\t>>');

  push('\t\t/GridInfo');
  push('\t\t<<');
  push('\t\t\t/GridIsOn false');
  push('\t\t\t/ShowGrid false');
  push('\t\t\t/GridSize 18.0');
  push('\t\t\t/GridLeading 22.0');
  push('\t\t\t/GridColor << /Type 1 /Values [ 0.0 0.0 0.0 1.0 ] >>');
  push('\t\t\t/GridLeadingFillColor << /Type 1 /Values [ 0.0 0.0 0.0 1.0 ] >>');
  push('\t\t\t/AlignLineHeightToGridFlags false');
  push('\t\t>>');
  push(`\t\t/AntiAlias ${style.antiAlias}`);
  push('\t\t/UseFractionalGlyphWidths true');
  push('\t\t/Rendered');
  push('\t\t<<');
  push('\t\t\t/Version 1');
  push('\t\t\t/Shapes');
  push('\t\t\t<<');
  push('\t\t\t\t/WritingDirection 0');
  push('\t\t\t\t/Children [');
  push('\t\t\t\t<<');
  push(`\t\t\t\t\t/ShapeType ${style.shapeType}`);
  push('\t\t\t\t\t/Procession 0');
  push('\t\t\t\t\t/Lines << /WritingDirection 0 /Children [ ] >>');
  push('\t\t\t\t\t/Cookie');
  push('\t\t\t\t\t<<');
  push('\t\t\t\t\t\t/Photoshop');
  push('\t\t\t\t\t\t<<');
  push(`\t\t\t\t\t\t\t/ShapeType ${style.shapeType}`);
  if (style.shapeType === 1) {
    push(`\t\t\t\t\t\t\t/BoxBounds [ 0.0 0.0 ${engineNumber(style.boxWidth)} ${engineNumber(style.boxHeight)} ]`);
  } else {
    push('\t\t\t\t\t\t\t/PointBase [ 0.0 0.0 ]');
  }
  push('\t\t\t\t\t\t\t/Base');
  push('\t\t\t\t\t\t\t<<');
  push(`\t\t\t\t\t\t\t\t/ShapeType ${style.shapeType}`);
  push('\t\t\t\t\t\t\t\t/TransformPoint0 [ 1.0 0.0 ]');
  push('\t\t\t\t\t\t\t\t/TransformPoint1 [ 0.0 1.0 ]');
  push('\t\t\t\t\t\t\t\t/TransformPoint2 [ 0.0 0.0 ]');
  push('\t\t\t\t\t\t\t>>');
  push('\t\t\t\t\t\t>>');
  push('\t\t\t\t\t>>');
  push('\t\t\t\t>>');
  push('\t\t\t\t]');
  push('\t\t\t>>');
  push('\t\t>>');
  push('\t>>');

  push('\t/ResourceDict');
  push(...resourceDict(style, 1));
  push('\t/DocumentResources');
  push(...resourceDict(style, 1));
  push('>>');
  push('');

  return L.join('\n');
}

/** Flatten `layer.text` into the single run EngineData and the descriptor need. */
function textRunStyle(layer) {
  const t = resolveTextProps(layer.text);
  const c = parseColor(t.color || '#000000');
  const size = Math.max(1, num(t.size, 24));
  const face = textFace(t);
  return {
    fontName: face.name,
    size,
    fauxBold: face.fauxBold,
    fauxItalic: face.fauxItalic,
    autoLeading: t.lineStep == null,
    leading: t.lineStep == null ? size * 1.2 : t.lineStep,
    tracking: size > 0 ? (num(t.letterSpacing, 0) / size) * 1000 : 0,
    baselineShift: num(t.baselineShift, 0),
    underline: !!t.underline,
    strikethrough: !!t.strikethrough,
    justification: TEXT_JUSTIFICATION[t.align] == null ? 0 : TEXT_JUSTIFICATION[t.align],
    antiAlias: TEXT_ANTIALIAS[t.antialias] == null ? 4 : TEXT_ANTIALIAS[t.antialias],
    shapeType: t.paragraph ? 1 : 0,
    boxWidth: t.boxWidth,
    boxHeight: t.boxHeight,
    alpha: c.a == null ? 1 : c.a,
    r: c.r / 255,
    g: c.g / 255,
    b: c.b / 255,
    props: t,
  };
}

/** `left/top/right/bottom` of the layout box, relative to the text anchor. */
function textBoundsOf(layer, t) {
  if (t.paragraph) return { left: 0, top: 0, right: t.boxWidth, bottom: t.boxHeight };
  const m = measureTextLayer(layer);
  return { left: m.x - t.x, top: m.y - t.y, right: m.x - t.x + m.width, bottom: m.y - t.y + m.height };
}

function boundsDescriptor(box, unit) {
  const v = (n) => DESC.untf(unit, n);
  return DESC.obj('Rctn', {
    'Top ': v(box.top), Left: v(box.left), Btom: v(box.bottom), Rght: v(box.right),
  });
}

/**
 * Write a type layer as Photoshop's `TySh` "type tool object setting":
 * the 2×3 transform, the text descriptor (string, orientation, anti-aliasing,
 * bounds and the EngineData blob) and the warp descriptor, followed by the
 * layer rectangle.
 *
 * The rasterised pixels are still written into the layer's channels, so a
 * reader that ignores `TySh` shows exactly the same image.
 */
function writeTypeLayer(w, layer) {
  const style = textRunStyle(layer);
  const t = style.props;
  const content = String(t.content || '').replace(/\r\n?/g, '\n').replace(/\n/g, '\r');
  const box = textBoundsOf(layer, t);
  const engine = buildEngineData(style, content);
  const warp = t.warp || { style: 'none', bend: 0, h: 0, v: 0 };
  const warpStyle = WARP_STYLE_ENUMS[warp.style] || 'warpNone';
  // Our bend/h/v are -1..1 fractions; Photoshop stores them as percentages.
  const pctOf = (v) => {
    const n = Number.isFinite(Number(v)) ? Number(v) : 0;
    return Math.abs(n) > 1.0001 ? n : n * 100;
  };

  writeBlock(w, 'TySh', (b) => {
    b.uint16(1); // type tool version
    // Transform: xx, xy, yx, yy, tx, ty. Our text carries no scale or rotation
    // of its own — the anchor is the whole transform.
    b.double(1).double(0).double(0).double(1).double(num(t.x, 0)).double(num(t.y, 0));

    b.uint16(50); // text descriptor version
    writeDescriptorBlock(b, {
      classID: 'TxLr',
      items: {
        'Txt ': DESC.text(content),
        textGridding: DESC.enm('textGridding', 'None'),
        Ornt: DESC.enm('Ornt', t.vertical ? 'Vrtc' : 'Hrzn'),
        AntA: DESC.enm('Annt', ANTIALIAS_ENUMS[t.antialias] || 'antiAliasSmooth'),
        TextIndex: DESC.long(0),
        bounds: boundsDescriptor(box, '#Pnt'),
        boundingBox: boundsDescriptor(box, '#Pxl'),
        EngineData: DESC.raw(engine),
      },
    });

    b.uint16(1); // warp descriptor version
    writeDescriptorBlock(b, {
      classID: 'warp',
      items: {
        warpStyle: DESC.enm('warpStyle', warpStyle),
        warpValue: DESC.doub(pctOf(warp.bend)),
        warpPerspective: DESC.doub(pctOf(warp.h)),
        warpPerspectiveOther: DESC.doub(pctOf(warp.v)),
        warpRotate: DESC.enm('Ornt', 'Hrzn'),
      },
    });

    b.int32(Math.round(box.left));
    b.int32(Math.round(box.top));
    b.int32(Math.round(box.right));
    b.int32(Math.round(box.bottom));
  });

  writePrivatePayload(w, 'pkTx', 'PKTX', layer.text, 'text layer properties');
}

/* ------------------------------------------------------------------ */
/* Shape layers — 'vmsk' + 'SoCo'/'GdFl'/'PtFl' + 'vstk'/'vscg'        */
/* ------------------------------------------------------------------ */

const STROKE_CAP_ENUMS = {
  butt: 'strokeStyleButtCap', round: 'strokeStyleRoundCap', square: 'strokeStyleSquareCap',
};
const STROKE_JOIN_ENUMS = {
  miter: 'strokeStyleMiterJoin', round: 'strokeStyleRoundJoin', bevel: 'strokeStyleBevelJoin',
};
const STROKE_ALIGN_ENUMS = {
  inside: 'strokeStyleAlignInside', center: 'strokeStyleAlignCenter', outside: 'strokeStyleAlignOutside',
};

/**
 * The named dash presets, as the multiples of line width that both Photoshop's
 * `strokeStyleLineDashSet` and `dashArrayFor` in `src/vector/path.js` use.
 *
 * This is a copy of `DASH_PRESETS` there, which is module-private; the two must
 * stay in step or a dashed stroke reopens with different gaps. `psd-read.js`
 * imports this one so at least both halves of the file format agree.
 */
export const PSD_DASH_PRESETS = {
  dash: [3, 2],
  'dash-tight': [2, 1],
  dot: [1, 2],
  'dash-dot': [4, 2, 1, 2],
  'long-dash': [7, 3],
};

/**
 * A stroke's dash pattern as the multiples of line width Photoshop stores.
 * A named preset is already in those units; an explicit array is in document
 * units, so it is divided through by the line width.
 * @returns {number[]} empty for a solid stroke
 */
function dashMultiples(dash, width) {
  if (!dash || dash === 'solid' || dash === 'none') return [];
  if (Array.isArray(dash)) {
    const w = Math.max(0.01, width);
    return dash.map(Number).filter((n) => Number.isFinite(n) && n > 0).map((n) => n / w);
  }
  const preset = PSD_DASH_PRESETS[dash];
  if (!preset) {
    console.warn(`[psd] the dash preset "${dash}" is not one this writer knows; the stroke was written solid`);
    return [];
  }
  return preset.slice();
}

/**
 * Normalise `layer.shape.fill` into one shape of object, mirroring
 * `normalizeFill` in `src/vector/path.js` (which is module-private there).
 * @returns {{kind:'solid'|'gradient'|'pattern'|'none', color?:string,
 *   stops?:object[], angle?:number, style?:string, scale?:number,
 *   patternId?:string}}
 */
function describeShapeFill(shape) {
  const f = shape.fill;
  if (f === 'none' || f === null) return { kind: 'none' };
  if (typeof f === 'string') return { kind: 'solid', color: f };
  if (f && typeof f === 'object') {
    if (f.type === 'none') return { kind: 'none' };
    if (f.type === 'pattern') return { kind: 'pattern', scale: num(f.scale, 1), patternId: f.patternId };
    if (f.type === 'linear' || f.type === 'gradient' || f.type === 'radial') {
      return {
        kind: 'gradient',
        stops: f.stops,
        angle: num(f.angle, 0),
        style: f.type === 'radial' ? 'radial' : 'linear',
      };
    }
    return { kind: 'solid', color: f.color || '#000000' };
  }
  if (shape.kind === 'fill') {
    if (shape.fillKind === 'gradient') {
      return { kind: 'gradient', stops: shape.stops, angle: num(shape.angle, 0), style: shape.style || 'linear' };
    }
    if (shape.fillKind === 'pattern') return { kind: 'pattern', scale: num(shape.scale, 1), patternId: shape.patternId };
    return { kind: 'solid', color: shape.color || '#808080' };
  }
  return { kind: 'solid', color: shape.color || '#000000' };
}

/** Same normalisation as `normalizeStroke` in `src/vector/path.js`. */
function describeShapeStroke(shape) {
  const s = shape.stroke;
  let st;
  if (s && typeof s === 'object' && !Array.isArray(s)) st = { ...s };
  else if (typeof s === 'string') st = { color: s };
  else if (s == null) st = {};
  else return null;
  if (st.enabled === false) return null;
  if (st.color == null) st.color = shape.strokeColor || null;
  if (st.width == null) {
    const flat = shape.strokeWidth != null ? shape.strokeWidth : shape.lineWidth;
    st.width = flat != null ? Number(flat) : 1;
  }
  if (st.align == null) st.align = shape.strokeAlign || 'center';
  if (!st.color || st.color === 'none') return null;
  if (!(Number(st.width) > 0)) return null;
  return st;
}

/** The `SoCo` / `GdFl` / `PtFl` content descriptor for a shape or fill layer. */
function fillContentDescriptor(fill) {
  if (fill.kind === 'gradient') {
    return ['GdFl', {
      classID: 'GdFl',
      items: {
        Grad: gradientDescriptor(fill.stops),
        // Sign-flipped — see `psdGradientAngle`.
        Angl: DESC.ang(psdGradientAngle(fill.angle)),
        Type: DESC.enm('GrdT', GRADIENT_STYLE_ENUMS[fill.style] || 'Lnr '),
        Rvrs: DESC.bool(false),
        Dthr: DESC.bool(false),
        Algn: DESC.bool(true),
        'Scl ': DESC.pct(100),
        Ofst: pointDescriptor(0, 0),
      },
    }];
  }
  if (fill.kind === 'pattern') {
    return ['PtFl', {
      classID: 'PtFl',
      items: {
        Ptrn: patternDescriptor(fill.patternId),
        Angl: DESC.ang(0),
        'Scl ': DESC.pct(num(fill.scale, 1) * 100),
        Algn: DESC.bool(true),
        phase: pointDescriptor(0, 0),
      },
    }];
  }
  // A shape with no fill still needs a content layer; `strokeStyleFillEnabled`
  // in the 'vstk' descriptor is what actually turns the fill off.
  return ['SoCo', {
    classID: 'SoCo',
    items: { 'Clr ': colorDescriptor(fill.kind === 'none' ? '#000000' : fill.color) },
  }];
}

/**
 * `vmsk` — the vector mask. Version, flags, then exactly the same 26-byte path
 * records that image resources 2000-2997 hold, so the stage-1 writer is reused.
 */
function writeVectorMask(w, subpaths, doc) {
  writeBlock(w, 'vmsk', (b) => {
    b.uint32(3); // version
    b.uint32(0); // flags: not inverted, linked, enabled
    writePathBody(b, { subpaths }, doc.width, doc.height);
  });
}

/** `vstk` — the Photoshop CS6 vector stroke descriptor. */
function writeVectorStroke(w, stroke, fill) {
  const width = stroke ? Math.max(0, num(stroke.width, 1)) : 1;
  const dash = stroke ? dashMultiples(stroke.dash, width) : [];
  writeBlock(w, 'vstk', (b) => {
    writeDescriptorBlock(b, {
      classID: 'strokeStyle',
      items: {
        strokeStyleVersion: DESC.long(2),
        strokeEnabled: DESC.bool(!!stroke),
        fillEnabled: DESC.bool(fill.kind !== 'none'),
        strokeStyleLineWidth: DESC.px(width),
        strokeStyleLineDashOffset: DESC.untf('#Pnt', 0),
        strokeStyleMiterLimit: DESC.doub(stroke ? num(stroke.miterLimit, 10) : 10),
        strokeStyleLineCapType: DESC.enm('strokeStyleLineCapType', STROKE_CAP_ENUMS[stroke && stroke.cap] || 'strokeStyleButtCap'),
        strokeStyleLineJoinType: DESC.enm('strokeStyleLineJoinType', STROKE_JOIN_ENUMS[stroke && stroke.join] || 'strokeStyleMiterJoin'),
        strokeStyleLineAlignment: DESC.enm('strokeStyleLineAlignment', STROKE_ALIGN_ENUMS[stroke && stroke.align] || 'strokeStyleAlignCenter'),
        strokeStyleScaleLock: DESC.bool(false),
        strokeStyleStrokeAdjust: DESC.bool(false),
        strokeStyleLineDashSet: DESC.list(dash.map((n) => DESC.none(n))),
        strokeStyleBlendMode: blendEnum('normal'),
        strokeStyleOpacity: DESC.pct(100),
        strokeStyleContent: DESC.obj('solidColorLayer', {
          'Clr ': colorDescriptor(stroke ? stroke.color : '#000000'),
        }),
        strokeStyleResolution: DESC.doub(72),
      },
    });
  });
}

/** `vscg` — the fill the vector stroke paints with: a key, then a descriptor. */
function writeVectorStrokeContent(w, key, descriptor) {
  writeBlock(w, 'vscg', (b) => {
    b.ascii(key);
    writeDescriptorBlock(b, descriptor);
  });
}

/**
 * `keyOriginType` — which live shape the origination block describes.
 *
 * 1, 2, 4 and 5 are corroborated by psd-tools' `Origination` factory, which
 * maps exactly those four onto Rectangle, RoundedRectangle, Line and Ellipse,
 * and 9 is the value Adobe's own developer forum shows for a named custom
 * shape. 6 for a polygon is *inferred*: it is the value left free below the
 * documented set, and Photoshop's live polygon (with it, the star) arrived after
 * the four that are documented.
 *
 * Evidence, stated plainly because this is exactly the kind of thing that gets
 * quietly forgotten: `keyOriginLine*` (type 4) are the names psd-tools reads, so
 * a Pikado line should open as a live line. The `keyOriginPoly*` names are **not**
 * documented anywhere public and no Photoshop install was available to check
 * them against. They are written anyway because the geometry never depends on
 * them — Photoshop draws the shape from the `vmsk` path either way — so the
 * worst case is the block being ignored and the frozen path appearing, which is
 * what happens today. What they do guarantee is that `psd-read.js` restores
 * `sides` / `star` / `innerRadius` from the interoperable blocks alone, with no
 * Pikado-private block involved.
 */
const ORIGIN_TYPES = { rect: 1, 'rounded-rect': 2, line: 4, ellipse: 5, polygon: 6 };

/** The four corner radii a rectangle-family shape carries, or null. */
function cornerRadiiOf(shape) {
  if (Array.isArray(shape.corners) && shape.corners.length === 4) {
    return shape.corners.map((v) => Math.max(0, num(v, 0)));
  }
  if (shape.radius != null) {
    const r = Math.max(0, num(shape.radius, 0));
    return [r, r, r, r];
  }
  return null;
}

const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * The two endpoints of a line shape, recovered from its shaft.
 *
 * `lineSubpaths` in `src/tools/shape.js` builds the shaft as
 * `[s+n, e+n, e-n, s-n]` where `n` is the half-weight normal, so the endpoints
 * are the midpoints of the two short edges — exact, not fitted. Arrowheads are
 * extra subpaths, and the shaft is then inset by the arrow length, so a line
 * that has them is only claimed as live when the shape also carries the arrow
 * parameters needed to describe them.
 *
 * @returns {{start:{x,y}, end:{x,y}, arrows:boolean}|null}
 */
function lineOriginOf(shape, subpaths) {
  if (shape.weight == null) return null;
  const weight = num(shape.weight, 0);
  if (!(weight > 0)) return null;
  const shaft = subpaths[0];
  if (!shaft || !shaft.closed || (shaft.points || []).length !== 4) return null;

  const hasArrowMeta = shape.arrowStart !== undefined || shape.arrowEnd !== undefined;
  if (subpaths.length !== 1 && !hasArrowMeta) return null;

  const p = shaft.points;
  const start = midpoint(p[0], p[3]);
  const end = midpoint(p[1], p[2]);
  // The short edge is the stroke weight; if it is not, this is not our shaft.
  const measured = Math.hypot(p[0].x - p[3].x, p[0].y - p[3].y);
  if (Math.abs(measured - Math.max(0.5, weight)) > 0.01) return null;
  if (Math.hypot(end.x - start.x, end.y - start.y) < 0.01) return null;
  return { start, end, arrows: hasArrowMeta };
}

/** Which live shape, if any, `layer.shape` is a parametric instance of. */
function originKindOf(shape, subpaths) {
  if (Number(shape.sides) >= 3) return 'polygon';
  if (lineOriginOf(shape, subpaths)) return 'line';
  const corners = cornerRadiiOf(shape);
  if (corners) return corners.some((v) => v > 0) ? 'rounded-rect' : 'rect';
  return null;
}

function radiiDescriptor(corners) {
  return DESC.obj('radii', {
    unitValueQuadVersion: DESC.long(1),
    topRight: DESC.px(corners[1]),
    topLeft: DESC.px(corners[0]),
    bottomLeft: DESC.px(corners[3]),
    bottomRight: DESC.px(corners[2]),
  });
}

function shapeBBoxDescriptor(box) {
  return DESC.obj('unitRect', {
    unitValueQuadVersion: DESC.long(1),
    'Top ': DESC.px(box.y),
    Left: DESC.px(box.x),
    Btom: DESC.px(box.y + box.height),
    Rght: DESC.px(box.x + box.width),
  });
}

/**
 * `vogk` — vector origination data, which is what makes Photoshop show a *live*
 * shape (parameters editable in the Properties panel) rather than a frozen path.
 *
 * Written for the four geometries we can describe parametrically: rectangles,
 * rounded rectangles, lines and polygons/stars. Ellipses and custom shapes
 * carry no marker on `layer.shape` that would distinguish them from an
 * arbitrary path, so they stay ordinary vector masks.
 *
 * Every flavour carries the shared keys — resolution, bounding box, identity
 * transform and origin index — because those are what Photoshop anchors a live
 * shape's handles to.
 */
function writeVectorOrigination(w, shape, subpaths) {
  const kind = originKindOf(shape, subpaths);
  if (!kind) return;
  const box = subpathsBounds(subpaths);
  if (!box) return;

  const items = {
    keyShapeInvalidated: DESC.bool(false),
    keyOriginType: DESC.long(ORIGIN_TYPES[kind]),
    keyOriginResolution: DESC.doub(72),
  };

  if (kind === 'rect' || kind === 'rounded-rect') {
    items.keyOriginRRectRadii = radiiDescriptor(cornerRadiiOf(shape));
  } else if (kind === 'line') {
    const line = lineOriginOf(shape, subpaths);
    items.keyOriginLineStart = pixelPointDescriptor(line.start.x, line.start.y);
    items.keyOriginLineEnd = pixelPointDescriptor(line.end.x, line.end.y);
    items.keyOriginLineWeight = DESC.doub(num(shape.weight, 1));
    items.keyOriginLineArrowSt = DESC.bool(!!shape.arrowStart);
    items.keyOriginLineArrowEnd = DESC.bool(!!shape.arrowEnd);
    // Photoshop's arrow proportions are percentages of the line weight, which
    // is the same unit the Line tool's own options use.
    items.keyOriginLineArrWdth = DESC.doub(shape.arrowWidth == null ? 500 : num(shape.arrowWidth, 500));
    items.keyOriginLineArrLngth = DESC.doub(shape.arrowLength == null ? 1000 : num(shape.arrowLength, 1000));
    items.keyOriginLineArrConc = DESC.long(Math.round(num(shape.concavity, 0)));
  } else if (kind === 'polygon') {
    const sides = clampi(num(shape.sides, 5), 3, 100);
    const star = !!shape.star;
    // Our `innerRadius` is the star's inner radius as a fraction of the outer
    // one; the Polygon tool's "Indent sides by" slider is its complement, and
    // that percentage is what a Photoshop star is parameterised by.
    const inner = Math.max(0.02, Math.min(1, num(shape.innerRadius, 0.5)));
    items.keyOriginPolySides = DESC.long(sides);
    items.keyOriginPolyStar = DESC.bool(star);
    items.keyOriginPolyStarRatio = DESC.doub(inner);
    items.keyOriginPolyIndent = DESC.pct((1 - inner) * 100);
    items.keyOriginPolySmoothCorners = DESC.bool(!!shape.smoothCorners);
    // A polygon's corners are sharp, so the radii quad is all zeros — the block
    // is still written because Photoshop reads it for every live shape.
    items.keyOriginRRectRadii = radiiDescriptor([0, 0, 0, 0]);
  }

  items.keyOriginShapeBBox = shapeBBoxDescriptor(box);
  items.Trnf = DESC.obj('Trnf', {
    xx: DESC.doub(1), xy: DESC.doub(0), yx: DESC.doub(0),
    yy: DESC.doub(1), tx: DESC.doub(0), ty: DESC.doub(0),
  });
  items.keyOriginIndex = DESC.long(0);

  writeBlock(w, 'vogk', (b) => {
    b.uint32(1); // vector origination version
    writeDescriptorBlock(b, {
      classID: 'null',
      items: { keyDescriptorList: DESC.list([DESC.obj('null', items)]) },
    });
  });
}

/**
 * Write a shape layer the way Photoshop stores one: a fill content block, the
 * path as a vector mask, and the stroke as `vstk` + `vscg`. The rasterised
 * pixels are still written into the layer's channels.
 */
function writeShapeLayer(w, layer, doc) {
  const shape = layer.shape;
  const subpaths = (shape.subpaths || []).filter((sp) => sp && (sp.points || []).length);
  if (!subpaths.length) {
    throw new Error(`The shape layer "${layer.name || 'Shape'}" has no path to save`);
  }
  const fill = describeShapeFill(shape);
  const stroke = describeShapeStroke(shape);
  const [fillKey, fillDescriptor] = fillContentDescriptor(fill);

  writeBlock(w, fillKey, (b) => writeDescriptorBlock(b, fillDescriptor));
  writeVectorMask(w, subpaths, doc);
  writeVectorOrigination(w, shape, subpaths);
  writeVectorStroke(w, stroke, fill);
  writeVectorStrokeContent(w, 'SoCo', {
    classID: 'SoCo',
    items: { 'Clr ': colorDescriptor(stroke ? stroke.color : '#000000') },
  });

  writePrivatePayload(w, 'pkSh', 'PKSH', serialisableShape(shape), 'shape layer properties');
}

/**
 * A shape whose paint is a live canvas with no id to find it by again.
 *
 * A pattern fill holds the tile itself; the tile cannot travel in a PSD, and
 * without a pattern id `psd-read.js` has nothing to re-resolve it from. Such a
 * layer is written as an ordinary raster layer instead — the pixels are then
 * exactly right, which matters more than a vector mask that would reopen
 * painted the wrong colour.
 */
function shapeCarriesLiveCanvas(shape, layer) {
  const isCanvas = (v) => !!v && typeof v === 'object' && typeof v.getContext === 'function';
  let live = false;
  for (const key of Object.keys(shape)) if (isCanvas(shape[key])) live = true;
  const f = shape.fill;
  if (f && typeof f === 'object' && isCanvas(f.canvas) && f.patternId == null) live = true;
  if (live) {
    console.warn(`[psd] "${layer.name || 'Shape'}" is filled with a pattern tile that has no id; it was saved as a raster layer so the pixels stay exact`);
  }
  return live;
}

/**
 * `layer.shape` reduced to something `JSON.stringify` can carry. A pattern fill
 * holds a live canvas, which cannot travel; the pattern id can, and
 * `psd-read.js` re-resolves it against the pattern library.
 */
function serialisableShape(shape) {
  const out = {};
  for (const key of Object.keys(shape)) {
    const v = shape[key];
    if (v && typeof v === 'object' && typeof v.getContext === 'function') continue;
    out[key] = v;
  }
  if (out.fill && typeof out.fill === 'object') {
    const f = { ...out.fill };
    delete f.canvas;
    out.fill = f;
  }
  return out;
}

function writeChannelData(w, record, plan, doc) {
  const { layer } = record;
  const { rect, channelIds, lengthSlots, hasMask } = plan;

  let planes = null;
  if (rect) {
    planes = planesOf(layer.canvas, rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top);
  }
  const rw = rect ? rect.right - rect.left : 0;
  const rh = rect ? rect.bottom - rect.top : 0;

  for (let i = 0; i < channelIds.length; i++) {
    const id = channelIds[i];
    let written;
    if (id === -2) {
      written = hasMask && layer.mask
        ? writeChannel(w, maskPlane(layer.mask, doc.width, doc.height), doc.width, doc.height)
        : writeEmptyChannel(w);
    } else if (!planes) {
      written = writeEmptyChannel(w);
    } else {
      const plane = id === -1 ? planes.a : id === 0 ? planes.r : id === 1 ? planes.g : planes.b;
      written = writeChannel(w, plane, rw, rh);
    }
    w.patchUint32(lengthSlots[i], written);
  }
}
