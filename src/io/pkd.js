import { PikaDocument } from '../core/document.js';
import { getProfile, TRC, WHITE_POINTS } from '../color/icc.js';
import { Layer, LayerType } from '../core/layer.js';
import { createCanvas, ctx2d, loadImage } from '../core/util.js';

/**
 * `.pkd` — the lossless Pikado project format.
 *
 * Layout:
 *   0   8 bytes   ASCII magic "PIKADO01"
 *   8   4 bytes   uint32 (little-endian) manifest byte length
 *   12  n bytes   UTF-8 JSON manifest
 *   12+n …        payload blobs, back to back
 *
 * Pixel buffers are stored as PNG; anything else that is not JSON-safe (the
 * selection coverage mask, saved alpha channels) is stored as raw bytes. Both
 * are referenced from the manifest by `{__pk, blob}` markers, so the whole
 * layer tree — masks, groups, styles, text, shapes, adjustments — round-trips
 * without a bespoke schema per payload type.
 */

const MAGIC = 'PIKADO01';
const FORMAT_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Value encoding                                                      */
/* ------------------------------------------------------------------ */

function isCanvas(v) {
  return !!v && typeof v === 'object' && typeof v.getContext === 'function'
    && typeof v.width === 'number' && typeof v.height === 'number';
}

function isByteArray(v) {
  return v instanceof Uint8Array || v instanceof Uint8ClampedArray;
}

function canvasToPNG(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode a layer as PNG'))), 'image/png');
  });
}

function createEncoder() {
  /** @type {{kind:string, promise:Promise<Uint8Array>}[]} */
  const blobs = [];

  const push = (kind, promise) => {
    blobs.push({ kind, promise });
    return blobs.length - 1;
  };

  const encode = (value) => {
    if (value == null) return value === undefined ? null : null;
    if (isCanvas(value)) {
      return {
        __pk: 'canvas',
        width: value.width,
        height: value.height,
        blob: push('png', canvasToPNG(value).then((b) => b.arrayBuffer()).then((ab) => new Uint8Array(ab))),
      };
    }
    if (isByteArray(value)) {
      return { __pk: 'bytes', blob: push('raw', Promise.resolve(new Uint8Array(value))) };
    }
    if (Array.isArray(value)) return value.map(encode);
    const t = typeof value;
    if (t === 'number' || t === 'string' || t === 'boolean') return value;
    if (t !== 'object') return null;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'parent' || k.startsWith('_')) continue;
      out[k] = encode(v);
    }
    return out;
  };

  return { encode, blobs };
}

/**
 * Smart-object payloads embed a whole `PikaDocument` (see `src/core/smart.js`).
 * The generic encoder cannot walk one — it would follow `history.doc` straight
 * back into the parent document and recurse forever — so the contents get an
 * explicit `__pk:'smartdoc'` node holding the embedded layer tree.
 */
function encodeSmart(smart, enc, encodeLayer) {
  if (!smart) return null;
  const { source, ...rest } = smart;
  const out = enc.encode(rest) || {};
  if (source && Array.isArray(source.layers)) {
    out.source = {
      __pk: 'smartdoc',
      name: source.name,
      width: source.width,
      height: source.height,
      resolution: source.resolution,
      colorMode: source.colorMode,
      layers: source.layers.map((l) => encodeLayer(l)),
    };
  }
  return out;
}

function createDecoder(decoded) {
  const decode = (value) => {
    if (value == null) return null;
    if (Array.isArray(value)) return value.map(decode);
    if (typeof value !== 'object') return value;
    if (value.__pk === 'canvas' || value.__pk === 'bytes') return decoded[value.blob] ?? null;
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = decode(v);
    return out;
  };
  return decode;
}

/* ------------------------------------------------------------------ */
/* Save                                                                */
/* ------------------------------------------------------------------ */

/**
 * Serialise a document to a `.pkd` project blob.
 * @param {PikaDocument} doc
 * @returns {Promise<Blob>}
 */
/* ------------------------------------------------------------------ */
/* Colour profile                                                      */
/* ------------------------------------------------------------------ */

/**
 * A colour profile, reduced to JSON.
 *
 * A built-in space travels as its id, so a later Pikado with a corrected matrix
 * writes the corrected one rather than a stale copy. An *embedded* profile has to
 * travel in full — the original ICC bytes are not kept once parsed, so there is
 * nothing to re-parse. Its tone curve is stored as the sample table when it has
 * one and as a gamma otherwise, since a curve object holds functions and functions
 * do not survive JSON.
 */
function encodeProfile(profile) {
  if (!profile) return null;
  if (!profile.embedded) return { id: profile.id };
  const trc = profile.trc || {};
  /*
   * The curve is always stored as a SAMPLE TABLE, whatever shape it had.
   * Reconstructing it from a name worked for the gamma case and quietly lost
   * everything else: an ICC parametric curve has no `.samples` and a name of
   * 'Parametric sRGB', so it came back as the plain sRGB curve regardless of its
   * real parameters. Sampling is exact to 8-bit either way and needs no guessing.
   */
  const samples = trc.samples
    ? [...trc.samples]
    : typeof trc.toLinear === 'function'
      ? Array.from({ length: 256 }, (_, i) => trc.toLinear(i / 255))
      : null;
  return {
    id: 'embedded',
    name: profile.name || 'Embedded profile',
    space: profile.space || 'rgb',
    white: profile.white ? [...profile.white] : null,
    matrix: profile.matrix ? [...profile.matrix] : null,
    // Without this, the bkpt-reading support was dead for any saved project.
    blackPoint: profile.blackPoint || 0,
    samples,
    gammaName: trc.name || null,
  };
}

/** The inverse of `encodeProfile`; null when the file predates profile support. */
function decodeProfile(stored) {
  if (!stored) return null;
  if (stored.id && stored.id !== 'embedded') return getProfile(stored.id);
  const gamma = /Gamma ([\d.]+)/.exec(stored.gammaName || '');
  return {
    id: 'embedded',
    name: stored.name || 'Embedded profile',
    space: stored.space || 'rgb',
    white: stored.white || WHITE_POINTS.D50,
    matrix: stored.matrix || null,
    blackPoint: stored.blackPoint || 0,
    // Samples first: every profile written by this version has them, whatever curve
    // shape it started as. The gamma fallback is only for files from before that.
    trc: stored.samples && stored.samples.length > 1
      ? TRC.table(Float32Array.from(stored.samples))
      : gamma ? TRC.gamma(Number(gamma[1])) : TRC.srgb,
    embedded: true,
  };
}

export async function savePKD(doc) {
  const enc = createEncoder();

  const encodeLayer = (layer) => ({
    id: layer.id,
    type: layer.type,
    name: layer.name,
    visible: layer.visible,
    opacity: layer.opacity,
    fillOpacity: layer.fillOpacity,
    blendMode: layer.blendMode,
    clipped: layer.clipped,
    locked: { ...layer.locked },
    isBackground: layer.isBackground,
    expanded: layer.expanded,
    editingMask: layer.editingMask,
    colorLabel: layer.colorLabel || null,
    linkId: layer.linkId || null,
    maskEnabled: layer.maskEnabled,
    maskLinked: layer.maskLinked,
    maskInverted: layer.maskInverted,
    canvas: layer.canvas ? enc.encode(layer.canvas) : null,
    mask: layer.mask ? enc.encode(layer.mask) : null,
    styles: enc.encode(layer.styles),
    text: enc.encode(layer.text),
    shape: enc.encode(layer.shape),
    adjustment: enc.encode(layer.adjustment),
    smart: encodeSmart(layer.smart, enc, encodeLayer),
    children: layer.children ? layer.children.map(encodeLayer) : null,
  });

  const manifest = {
    format: 'pikado',
    version: FORMAT_VERSION,
    created: new Date().toISOString(),
    doc: {
      name: doc.name,
      width: doc.width,
      height: doc.height,
      resolution: doc.resolution,
      colorMode: doc.colorMode,
      globalLight: doc.globalLight == null ? null : doc.globalLight,
      guides: doc.guides.map((g) => ({ ...g })),
      quickMask: !!doc.quickMask,
      /*
       * The colour profile. A built-in space travels as its id; an embedded
       * profile travels as the parsed description, primaries and curve, because
       * re-parsing needs the original ICC bytes and those are not kept.
       *
       * Without this, saving and reopening silently dropped the document's colour
       * space back to sRGB — while the README claimed the format preserves
       * everything.
       */
      profile: encodeProfile(doc.profile),
      // Frame animation. Plain data, so it travels as JSON with the rest of the
      // document header rather than as a blob.
      frames: Array.isArray(doc.frames) && doc.frames.length ? structuredClone(doc.frames) : null,
      activeFrameId: doc.activeFrameId || null,
      loopCount: doc.loopCount == null ? 0 : doc.loopCount,
      activeLayerId: doc.activeLayerId,
      selectedLayerIds: [...doc.selectedLayerIds],
      activePathId: doc.activePathId,
      paths: enc.encode(doc.paths),
      alphaChannels: enc.encode(doc.alphaChannels),
      selection: doc.selection.mask ? enc.encode(doc.selection.mask) : null,
    },
    layers: doc.layers.map(encodeLayer),
    blobs: [],
  };

  const payloads = await Promise.all(enc.blobs.map((b) => b.promise));
  let offset = 0;
  manifest.blobs = payloads.map((bytes, i) => {
    const entry = { kind: enc.blobs[i].kind, offset, length: bytes.length };
    offset += bytes.length;
    return entry;
  });

  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const header = new Uint8Array(12);
  for (let i = 0; i < 8; i++) header[i] = MAGIC.charCodeAt(i);
  new DataView(header.buffer).setUint32(8, manifestBytes.length, true);

  return new Blob([header, manifestBytes, ...payloads], { type: 'application/x-pikado' });
}

/* ------------------------------------------------------------------ */
/* Load                                                                */
/* ------------------------------------------------------------------ */

async function pngToCanvas(bytes) {
  const blob = new Blob([bytes], { type: 'image/png' });
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    const canvas = createCanvas(bitmap.width, bitmap.height);
    ctx2d(canvas).drawImage(bitmap, 0, 0);
    if (bitmap.close) bitmap.close();
    return canvas;
  }
  const img = await loadImage(blob);
  const canvas = createCanvas(img.naturalWidth || img.width, img.naturalHeight || img.height);
  ctx2d(canvas).drawImage(img, 0, 0);
  return canvas;
}

/**
 * Rebuild a document from a `.pkd` project file.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<PikaDocument>}
 */
export async function loadPKD(arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer);
  if (u8.length < 12) throw new Error('The project file is empty');
  let magic = '';
  for (let i = 0; i < 8; i++) magic += String.fromCharCode(u8[i]);
  if (magic !== MAGIC) throw new Error('Not a Pikado project file');

  const manifestLength = new DataView(arrayBuffer).getUint32(8, true);
  if (12 + manifestLength > u8.length) throw new Error('The project file is truncated');
  const manifest = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + manifestLength)));
  if (manifest.format !== 'pikado') throw new Error('Unrecognised project manifest');

  const base = 12 + manifestLength;
  const decoded = await Promise.all((manifest.blobs || []).map(async (entry) => {
    const bytes = u8.subarray(base + entry.offset, base + entry.offset + entry.length);
    if (entry.kind === 'png') return pngToCanvas(bytes);
    return new Uint8ClampedArray(bytes);
  }));
  const decode = createDecoder(decoded);

  const info = manifest.doc || {};
  const doc = new PikaDocument({
    width: info.width || 1,
    height: info.height || 1,
    name: info.name || 'Untitled',
    resolution: info.resolution || 72,
  });
  doc.colorMode = info.colorMode || 'rgb';
  if (info.globalLight != null) doc.globalLight = info.globalLight;
  doc.guides = Array.isArray(info.guides) ? info.guides.map((g) => ({ ...g })) : [];
  doc.quickMask = !!info.quickMask;
  doc.profile = decodeProfile(info.profile);
  doc.frames = Array.isArray(info.frames) ? structuredClone(info.frames) : [];
  doc.activeFrameId = info.activeFrameId || null;
  doc.loopCount = info.loopCount == null ? 0 : info.loopCount;
  doc.paths = decode(info.paths) || [];
  doc.activePathId = info.activePathId || null;
  doc.alphaChannels = decode(info.alphaChannels) || [];

  const decodeLayer = (node, parent = null) => {
    const layer = new Layer({
      id: node.id,
      type: node.type || LayerType.RASTER,
      name: node.name,
      visible: node.visible,
      opacity: node.opacity,
      fillOpacity: node.fillOpacity,
      blendMode: node.blendMode,
      clipped: node.clipped,
      locked: node.locked ? { ...node.locked } : undefined,
      canvas: node.canvas ? decode(node.canvas) : null,
      mask: node.mask ? decode(node.mask) : null,
      maskEnabled: node.maskEnabled,
      maskLinked: node.maskLinked,
      maskInverted: node.maskInverted,
      styles: decode(node.styles),
      text: decode(node.text),
      shape: decode(node.shape),
      adjustment: decode(node.adjustment),
      smart: decodeSmart(node.smart),
      isBackground: node.isBackground,
      expanded: node.expanded,
      children: node.children ? [] : null,
    });
    layer.editingMask = !!node.editingMask;
    if (node.colorLabel) layer.colorLabel = node.colorLabel;
    if (node.linkId) layer.linkId = node.linkId;
    layer.parent = parent;
    if (node.children) layer.children = node.children.map((c) => decodeLayer(c, layer));
    else if (layer.type === LayerType.GROUP) layer.children = [];
    layer.touchMask();
    return layer;
  };

  /** Rebuild a smart-object payload, including its embedded document. */
  const decodeSmart = (node) => {
    if (!node) return null;
    const { source, ...rest } = node;
    const out = decode(rest) || {};
    let layers = null;
    if (source && source.__pk === 'smartdoc' && Array.isArray(source.layers)) {
      layers = source.layers.map((n) => decodeLayer(n, null));
    } else if (out.canvas) {
      // Projects written before smart objects were non-destructive stored only
      // a flattened copy — promote it so the layer still has editable contents.
      layers = [new Layer({ type: LayerType.RASTER, name: 'Layer 1', canvas: out.canvas })];
    }
    if (!layers || !layers.length) return out;
    const w = (source && source.width) || out.sourceWidth || out.width || layers[0].canvas.width;
    const h = (source && source.height) || out.sourceHeight || out.height || layers[0].canvas.height;
    const sd = new PikaDocument({
      width: w, height: h,
      name: (source && source.name) || out.name || 'Contents',
      resolution: (source && source.resolution) || 72,
    });
    sd.colorMode = (source && source.colorMode) || 'rgb';
    sd.layers = layers;
    sd.activeLayerId = layers[0].id;
    sd.selectedLayerIds = [layers[0].id];
    sd.history.clear('Smart Object');
    out.source = sd;
    out.sourceWidth = w;
    out.sourceHeight = h;
    out.sourceVersion = out.sourceVersion || 1;
    if (!out.transform || !Array.isArray(out.transform.matrix)) out.transform = { matrix: [1, 0, 0, 1, 0, 0] };
    if (!Array.isArray(out.filters)) out.filters = [];
    delete out.canvas;
    return out;
  };

  doc.layers = (manifest.layers || []).map((n) => decodeLayer(n, null));
  if (!doc.layers.length) doc.layers = [new Layer({ type: LayerType.RASTER, name: 'Layer 1', canvas: createCanvas(doc.width, doc.height) })];

  const selectionMask = info.selection ? decode(info.selection) : null;
  if (selectionMask && selectionMask.length === doc.width * doc.height) {
    doc.selection.set(new Uint8ClampedArray(selectionMask));
  }

  const flat = doc.flatLayers();
  const known = new Set(flat.map((l) => l.id));
  doc.activeLayerId = known.has(info.activeLayerId) ? info.activeLayerId : (flat[0] ? flat[0].id : null);
  doc.selectedLayerIds = (info.selectedLayerIds || []).filter((id) => known.has(id));
  if (!doc.selectedLayerIds.length && doc.activeLayerId) doc.selectedLayerIds = [doc.activeLayerId];

  doc.history.clear('Open');
  doc.dirty = false;
  return doc;
}
