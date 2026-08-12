import { uid, createCanvas, cloneCanvas, ctx2d } from './util.js';

/**
 * Deep-copying a Smart Object's embedded source needs PikaDocument, which
 * cannot be imported here (document.js imports this module). src/core/smart.js
 * installs the cloner at load time instead, which keeps the dependency
 * one-directional.
 * @type {((source:object)=>object)|null}
 */
let smartSourceCloner = null;

export function setSmartSourceCloner(fn) {
  smartSourceCloner = fn;
}

/**
 * Copy a smart payload for `Layer.clone()`.
 *
 * The duplicate gets its own source document and its own filter stack, so
 * editing one copy never changes the other. (Photoshop's Cmd+J makes *linked*
 * copies; we deliberately do not, because contents edits here install a fresh
 * source object, which would leave "linked" copies silently diverging.)
 */
function cloneSmartPayload(smart) {
  return {
    ...smart,
    source: smart.source && smartSourceCloner ? smartSourceCloner(smart.source) : smart.source,
    transform: smart.transform ? { ...smart.transform, matrix: [...(smart.transform.matrix || [])] } : smart.transform,
    filters: (smart.filters || []).map((f) => ({ ...f, params: { ...f.params } })),
  };
}

export const LayerType = {
  RASTER: 'raster',
  TEXT: 'text',
  SHAPE: 'shape',
  GROUP: 'group',
  ADJUSTMENT: 'adjustment',
  SMART: 'smart',
};

/**
 * A single layer.
 *
 * IMPORTANT ownership rule: `canvas` and `mask` are shared with history
 * snapshots. Never draw into them without calling `beginEdit()` first (or
 * `doc.beginEdit(layer)`), which swaps in a private copy so older undo states
 * keep their pixels.
 */
export class Layer {
  constructor(opts = {}) {
    this.id = opts.id || uid('layer');
    this.type = opts.type || LayerType.RASTER;
    this.name = opts.name || 'Layer';
    this.visible = opts.visible !== false;
    this.opacity = opts.opacity == null ? 1 : opts.opacity;
    this.fillOpacity = opts.fillOpacity == null ? 1 : opts.fillOpacity;
    this.blendMode = opts.blendMode || 'normal';
    this.clipped = !!opts.clipped;
    this.locked = opts.locked || { all: false, pixels: false, position: false, transparency: false };

    /*
     * Pixels live in exactly one of two forms.
     *
     * `_full` is a document-sized buffer, which is what everything in Pikado has
     * always assumed. `_tile` is the compact form — the pixels at their natural
     * size plus where they sit — which is how a PSD actually stores a layer and
     * how it stays cheap. A layer whose content is 120x120 in a 1600x1200
     * document costs 133x less as a tile, measured.
     *
     * Reading `.canvas` materialises a tile into `_full` and drops the tile, so
     * every one of the ~230 places that read it keep working unchanged. The
     * saving comes from the layers nobody ever reads that way — in a big PSD you
     * are only viewing, that is nearly all of them, because the compositor has a
     * fast path that draws the tile directly (see `tile` below).
     *
     * Materialising is one-way on purpose. Once `_full` exists it is what writers
     * mutate, so the tile can no longer be trusted as the source of truth and is
     * discarded rather than left to drift.
     */
    /** @type {HTMLCanvasElement|null} */
    this._full = opts.canvas || null;
    /** @type {{canvas: HTMLCanvasElement, x: number, y: number}|null} */
    this._tile = opts.tile || null;
    /** @type {HTMLCanvasElement|null} document-sized greyscale mask (white = visible) */
    this.mask = opts.mask || null;
    this.maskEnabled = opts.maskEnabled !== false;
    this.maskLinked = opts.maskLinked !== false;
    this.maskInverted = !!opts.maskInverted;
    /** Bumped whenever mask pixels change so the alpha cache can invalidate. */
    this.maskVersion = 0;
    this._maskAlpha = null;
    this._maskAlphaVersion = -1;

    /** Group children. layers[0] is the TOP-most child (same as the panel). */
    this.children = opts.children || (this.type === LayerType.GROUP ? [] : null);
    this.expanded = opts.expanded !== false;
    /** @type {Layer|null} */
    this.parent = null;

    /** Layer effects, see src/effects/styles.js */
    this.styles = opts.styles || null;

    /** Type-specific payloads. */
    this.text = opts.text || null;
    this.shape = opts.shape || null;
    this.adjustment = opts.adjustment || null;
    this.smart = opts.smart || null;

    /** Set when the layer is the locked bottom "Background". */
    this.isBackground = !!opts.isBackground;

    /** Whether the mask (rather than the pixels) currently receives painting. */
    this.editingMask = false;

    this.thumbDirty = true;
    this._thumb = null;
  }

  /* ------------------------------------------------------------------ */

  /**
   * The document-sized pixel buffer, materialising a tile if that is all we have.
   *
   * Reading this is what costs memory, so the hot paths deliberately do not:
   * `snapshot()`, `thumb()` and the compositor's fast path all go through `tile`
   * instead. Anything else can read `.canvas` and get exactly what it always got.
   */
  get canvas() {
    if (this._full) return this._full;
    if (!this._tile) return null;
    const { canvas: src, x, y, docWidth, docHeight } = this._tile;
    const out = createCanvas(docWidth, docHeight);
    ctx2d(out).drawImage(src, x, y);
    this._full = out;
    this._tile = null;
    return out;
  }

  set canvas(cv) {
    this._full = cv || null;
    this._tile = null;
  }

  /**
   * The compact form, or null when the pixels are already document-sized.
   *
   * Consumers that can honour an offset should prefer this and leave the layer
   * compact. Everyone else reads `.canvas` and pays for the expansion.
   */
  get tile() {
    return this._tile;
  }

  /**
   * Store pixels compactly: `src` sits at (x, y) in a `docWidth` x `docHeight`
   * document. Replaces whatever was there.
   */
  setTile(src, x, y, docWidth, docHeight) {
    this._full = null;
    this._tile = src ? { canvas: src, x, y, docWidth, docHeight } : null;
    this.thumbDirty = true;
    return this;
  }

  /**
   * The buffer object currently holding this layer's pixels, whichever form it
   * is in — a stable identity for caching against, without materialising.
   *
   * Copy-on-write makes this a sound invalidation key: `beginEdit` replaces
   * whichever buffer exists, so a new object means new pixels. Callers that key
   * a cache on `layer.canvas` instead would expand every layer they merely
   * measured, which is how snapping a layer into place could otherwise cost a
   * document its compact form.
   *
   * @returns {HTMLCanvasElement|null}
   */
  pixelKey() {
    return this._full || (this._tile ? this._tile.canvas : null);
  }

  /** Bytes of pixel buffer this layer holds, without materialising anything. */
  pixelBytes() {
    if (this._full) return this._full.width * this._full.height * 4;
    if (this._tile) return this._tile.canvas.width * this._tile.canvas.height * 4;
    return 0;
  }

  get isRasterLike() {
    return this.type !== LayerType.GROUP && this.type !== LayerType.ADJUSTMENT;
  }

  ensureCanvas(w, h) {
    if (!this.canvas) this.canvas = createCanvas(w, h);
    else if (this.canvas.width !== w || this.canvas.height !== h) {
      const old = this.canvas;
      this.canvas = createCanvas(w, h);
      ctx2d(this.canvas).drawImage(old, 0, 0);
    }
    return this.canvas;
  }

  getContext() {
    return this.canvas ? this.canvas.getContext('2d') : null;
  }

  /**
   * Copy-on-write. Call before mutating pixels so the previous history state
   * keeps the old buffers.
   */
  /**
   * Fork this layer's buffers before writing to them.
   *
   * History snapshots share `canvas` and `mask` by reference, so a writer has to
   * take a private copy first. `surface` says which one is about to be written:
   * cloning both is the safe default and stays the default, but it is wrong
   * often enough to matter.
   *
   * `commitSurface` (src/filters/run.js) calls this and then *replaces*
   * `layer.canvas` outright — so the canvas clone is built and immediately
   * discarded, and on a masked layer the untouched mask is permanently forked
   * into a new buffer that every later snapshot then retains. That is 7.7 MB of
   * byte-identical mask kept alive per filter apply at 1600x1200, for a mask
   * nobody edited.
   *
   * @param {{surface?: 'canvas'|'mask'|'both'}} [opts]
   */
  beginEdit(opts = {}) {
    const surface = opts.surface || 'both';
    if (surface !== 'mask') {
      if (this._full) this._full = cloneCanvas(this._full);
      else if (this._tile) this._tile = { ...this._tile, canvas: cloneCanvas(this._tile.canvas) };
    }
    if (this.mask && surface !== 'canvas') {
      this.mask = cloneCanvas(this.mask);
      this.maskVersion++;
      this._maskAlphaVersion = -1;
    }
    this.thumbDirty = true;
    return this;
  }

  /** The surface tools should paint into, honouring mask-editing mode. */
  paintTarget() {
    return this.editingMask && this.mask ? this.mask : this.canvas;
  }

  addMask(w, h, fill = '#ffffff') {
    if (this.mask) return this.mask;
    this.mask = createCanvas(w, h);
    const c = this.mask.getContext('2d');
    c.fillStyle = fill;
    c.fillRect(0, 0, w, h);
    this.maskVersion++;
    this._maskAlphaVersion = -1;
    return this.mask;
  }

  removeMask() {
    this.mask = null;
    this.editingMask = false;
    this._maskAlpha = null;
    this._maskAlphaVersion = -1;
  }

  touchMask() {
    this.maskVersion++;
    this._maskAlphaVersion = -1;
    this.thumbDirty = true;
  }

  /**
   * Mask converted to an alpha-only canvas (luminance -> alpha) suitable as a
   * `destination-in` source. Cached against `maskVersion`.
   */
  maskAlphaCanvas() {
    if (!this.mask) return null;
    if (this._maskAlpha && this._maskAlphaVersion === this.maskVersion) return this._maskAlpha;
    const w = this.mask.width, h = this.mask.height;
    const src = this.mask.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h);
    const out = new ImageData(w, h);
    const s = src.data, d = out.data;
    const inv = this.maskInverted;
    for (let i = 0; i < s.length; i += 4) {
      let l = (s[i] * 0.299 + s[i + 1] * 0.587 + s[i + 2] * 0.114) * (s[i + 3] / 255);
      if (inv) l = 255 - l;
      d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = l;
    }
    const cv = createCanvas(w, h);
    cv.getContext('2d').putImageData(out, 0, 0);
    this._maskAlpha = cv;
    this._maskAlphaVersion = this.maskVersion;
    return cv;
  }

  /* ------------------------------------------------------------------ */

  /** Deep-ish clone. Pixel buffers are copied so the clone is independent. */
  clone(newIds = true) {
    const l = new Layer({
      id: newIds ? undefined : this.id,
      type: this.type,
      name: this.name,
      visible: this.visible,
      opacity: this.opacity,
      fillOpacity: this.fillOpacity,
      blendMode: this.blendMode,
      clipped: this.clipped,
      locked: { ...this.locked },
      canvas: this._full ? cloneCanvas(this._full) : null,
      tile: this._tile ? { ...this._tile, canvas: cloneCanvas(this._tile.canvas) } : null,
      mask: cloneCanvas(this.mask),
      maskEnabled: this.maskEnabled,
      maskLinked: this.maskLinked,
      maskInverted: this.maskInverted,
      styles: this.styles ? structuredClone(this.styles) : null,
      text: this.text ? structuredClone(this.text) : null,
      shape: this.shape ? structuredClone(this.shape) : null,
      adjustment: this.adjustment ? structuredClone(this.adjustment) : null,
      smart: this.smart ? cloneSmartPayload(this.smart) : null,
      isBackground: this.isBackground,
      expanded: this.expanded,
    });
    if (this.children) {
      l.children = this.children.map((c) => {
        const cc = c.clone(newIds);
        cc.parent = l;
        return cc;
      });
    }
    return l;
  }

  /**
   * Shallow structural snapshot used by History. Pixel buffers are *shared*
   * (copy-on-write guarantees they will not be mutated afterwards).
   */
  snapshot() {
    return {
      id: this.id,
      type: this.type,
      name: this.name,
      visible: this.visible,
      opacity: this.opacity,
      fillOpacity: this.fillOpacity,
      blendMode: this.blendMode,
      clipped: this.clipped,
      locked: { ...this.locked },
      // Whichever form the pixels are in — never `this.canvas`, which would
      // materialise every layer in the document on every single commit.
      canvas: this._full,
      tile: this._tile,
      mask: this.mask,
      maskEnabled: this.maskEnabled,
      maskLinked: this.maskLinked,
      maskInverted: this.maskInverted,
      editingMask: this.editingMask,
      styles: this.styles ? structuredClone(this.styles) : null,
      text: this.text ? structuredClone(this.text) : null,
      shape: this.shape ? structuredClone(this.shape) : null,
      adjustment: this.adjustment ? structuredClone(this.adjustment) : null,
      smart: this.smart ? { ...this.smart } : null,
      isBackground: this.isBackground,
      expanded: this.expanded,
      children: this.children ? this.children.map((c) => c.snapshot()) : null,
    };
  }

  static fromSnapshot(s) {
    const l = new Layer({ ...s, id: s.id });
    l.editingMask = !!s.editingMask;
    l.children = s.children ? s.children.map((c) => {
      const cc = Layer.fromSnapshot(c);
      cc.parent = l;
      return cc;
    }) : (s.type === LayerType.GROUP ? [] : null);
    l.maskVersion = 1;
    return l;
  }

  /** Opaque bounding box of the layer pixels, or null when fully empty. */
  contentBounds() {
    /*
     * Scans the tile when there is one, and returns document-space coordinates
     * either way. Two wins, not one: it does not materialise, and it reads a
     * 120x120 buffer instead of a 1600x1200 one to answer the same question.
     * PSD export calls this on every layer and then crops to it, so this is the
     * hot path for saving as well as for aligning.
     */
    const t = this._tile;
    if (t) {
      const tw = t.canvas.width, th = t.canvas.height;
      const td = t.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, tw, th).data;
      let tMinX = tw, tMinY = th, tMaxX = -1, tMaxY = -1;
      for (let y = 0; y < th; y++) {
        const row = y * tw * 4;
        for (let x = 0; x < tw; x++) {
          if (td[row + x * 4 + 3] !== 0) {
            if (x < tMinX) tMinX = x;
            if (x > tMaxX) tMaxX = x;
            if (y < tMinY) tMinY = y;
            if (y > tMaxY) tMaxY = y;
          }
        }
      }
      if (tMaxX < 0) return null;
      return {
        x: tMinX + t.x, y: tMinY + t.y,
        width: tMaxX - tMinX + 1, height: tMaxY - tMinY + 1,
      };
    }
    if (!this._full) return null;
    const w = this._full.width, h = this._full.height;
    const d = this._full.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      for (let x = 0; x < w; x++) {
        if (d[row + x * 4 + 3] !== 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  /** 40×40 thumbnail used by the Layers panel. */
  thumbnail(size = 40) {
    if (!this.thumbDirty && this._thumb && this._thumb.width === size) return this._thumb;
    const cv = createCanvas(size, size);
    const c = cv.getContext('2d');
    /*
     * Drawn from the tile when there is one. The Layers panel asks every layer
     * for a thumbnail on every render, so reading `.canvas` here would expand the
     * whole document to full size the moment a PSD finished importing — which is
     * exactly the cost this is meant to avoid.
     *
     * The tile is scaled as if it were document-sized so the thumbnail frames the
     * layer the same way either form does, rather than zooming into the content.
     */
    const t = this.type === LayerType.GROUP ? null : this._tile;
    const src = t ? t.canvas : (this.type === LayerType.GROUP ? null : this._full);
    if (src) {
      const boxW = t ? t.docWidth : src.width;
      const boxH = t ? t.docHeight : src.height;
      const s = Math.min(size / boxW, size / boxH);
      c.imageSmoothingQuality = 'high';
      c.drawImage(
        src,
        (size - boxW * s) / 2 + (t ? t.x * s : 0),
        (size - boxH * s) / 2 + (t ? t.y * s : 0),
        src.width * s, src.height * s,
      );
    }
    this._thumb = cv;
    this.thumbDirty = false;
    return cv;
  }
}

/* ---------------------------------------------------------------- */
/* Authored geometry                                                 */
/* ---------------------------------------------------------------- */

/**
 * Move a layer's *authored* geometry to follow its pixels.
 *
 * Text and shape layers hold two descriptions of the same thing: the rendered
 * canvas, and the parameters that produced it — `text.x/y`, `shape.subpaths`.
 * Anything that moves the pixels without moving the parameters leaves the two
 * disagreeing, and the disagreement is invisible until something re-renders
 * from the parameters. Then the layer silently jumps back to where it was
 * authored: move a caption and type one more character, and it hops across the
 * canvas.
 *
 * So every operation that transforms the canvas has to bring the parameters
 * with it. `mapPoint` maps document space to document space; `sizeScale` is the
 * matching scale factor for glyph size, which has no coordinate to map.
 *
 * One limit worth stating plainly: a text layer stores a position but not an
 * orientation, so under a rotation or a flip the anchor lands correctly and the
 * glyphs stay upright. Subpaths carry the full transform exactly.
 *
 * @param {Layer} layer
 * @param {(x: number, y: number) => {x: number, y: number}} mapPoint
 * @param {number} [sizeScale]
 */
export function mapLayerGeometry(layer, mapPoint, sizeScale = 1) {
  if (!layer) return;

  if (layer.text) {
    const p = mapPoint(num(layer.text.x), num(layer.text.y));
    const next = { ...layer.text, x: p.x, y: p.y };
    if (sizeScale !== 1) {
      next.scale = (num(layer.text.scale, 1) || 1) * sizeScale;
      // Box text wraps to a width in document space, so the box has to scale too
      // or the wrap points move relative to the glyphs.
      if (num(next.boxWidth)) next.boxWidth = num(next.boxWidth) * sizeScale;
      if (num(next.boxHeight)) next.boxHeight = num(next.boxHeight) * sizeScale;
    }
    layer.text = next;
  }

  if (layer.shape && Array.isArray(layer.shape.subpaths)) {
    layer.shape = {
      ...layer.shape,
      subpaths: layer.shape.subpaths.map((sp) => ({
        ...sp,
        points: (sp.points || []).map((pt) => {
          const a = mapPoint(num(pt.x), num(pt.y));
          const out = { ...pt, x: a.x, y: a.y };
          if (pt.in) { const q = mapPoint(num(pt.in.x), num(pt.in.y)); out.in = { x: q.x, y: q.y }; }
          if (pt.out) { const q = mapPoint(num(pt.out.x), num(pt.out.y)); out.out = { x: q.x, y: q.y }; }
          return out;
        }),
      })),
    };
    // A corner radius is a length, so it only survives a uniform scale.
    if (sizeScale !== 1 && num(layer.shape.radius)) {
      layer.shape.radius = num(layer.shape.radius) * sizeScale;
    }
  }
}

/** Translate authored geometry — the common case. */
export function translateLayerGeometry(layer, dx, dy) {
  if (!dx && !dy) return;
  mapLayerGeometry(layer, (x, y) => ({ x: x + dx, y: y + dy }));
}

function num(v, fallback = 0) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/* ---------------------------------------------------------------- */
/* Factory helpers                                                   */
/* ---------------------------------------------------------------- */

export function createRasterLayer(w, h, name = 'Layer') {
  return new Layer({ type: LayerType.RASTER, name, canvas: createCanvas(w, h) });
}

export function createGroupLayer(name = 'Group') {
  return new Layer({ type: LayerType.GROUP, name, children: [], blendMode: 'pass-through' });
}

export function createAdjustmentLayer(kind, params, w, h, name) {
  return new Layer({
    type: LayerType.ADJUSTMENT,
    name: name || kind,
    adjustment: { kind, params: params || {} },
  });
}
