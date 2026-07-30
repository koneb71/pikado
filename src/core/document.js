import { Emitter } from './emitter.js';
import { Layer, LayerType, createRasterLayer } from './layer.js';
import { Selection } from './selection.js';
import { History } from './history.js';
import { uid, createCanvas, cloneCanvas, ctx2d } from './util.js';

/**
 * A Pikado document.
 *
 * Layer ordering convention (used everywhere): **`layers[0]` is the TOP-most
 * layer**, matching what the Layers panel shows. The compositor therefore
 * walks the array backwards.
 */
export class PikaDocument extends Emitter {
  constructor({ width = 800, height = 600, name = 'Untitled', resolution = 72 } = {}) {
    super();
    this.id = uid('doc');
    this.name = name;
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.resolution = resolution;
    this.colorMode = 'rgb';

    /** @type {Layer[]} index 0 = top */
    this.layers = [];
    this.activeLayerId = null;
    this.selectedLayerIds = [];

    this.selection = new Selection(this.width, this.height);
    this.history = new History(this);

    /** Alpha channels saved via Select > Save Selection. */
    this.alphaChannels = [];
    /** Vector paths from the Pen tool (Paths panel). */
    this.paths = [];
    this.activePathId = null;

    this.guides = [];
    this.quickMask = false;
    this.dirty = false;
    this.filePath = null;
    this.fileHandle = null;

    /** Cached composite; invalidated by `invalidate()`. */
    this._composite = null;
    this._compositeValid = false;

    this.view = { scale: 1, offsetX: 0, offsetY: 0, rotation: 0 };
  }

  /* ------------------------------------------------------------------ */
  /* Construction helpers                                                */
  /* ------------------------------------------------------------------ */

  static blank(width, height, name, fill = '#ffffff') {
    const doc = new PikaDocument({ width, height, name });
    if (fill === 'transparent' || fill === null) {
      const l = createRasterLayer(width, height, 'Layer 1');
      doc.layers.push(l);
      doc.activeLayerId = l.id;
    } else {
      const bg = createRasterLayer(width, height, 'Background');
      const c = bg.canvas.getContext('2d');
      c.fillStyle = fill;
      c.fillRect(0, 0, width, height);
      bg.isBackground = true;
      bg.locked = { ...bg.locked, position: true };
      doc.layers.push(bg);
      doc.activeLayerId = bg.id;
    }
    doc.selectedLayerIds = [doc.activeLayerId];
    doc.history.clear('New');
    return doc;
  }

  static fromImage(img, name = 'Image') {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const doc = new PikaDocument({ width: w, height: h, name });
    const l = createRasterLayer(w, h, 'Background');
    l.canvas.getContext('2d').drawImage(img, 0, 0);
    l.isBackground = true;
    doc.layers.push(l);
    doc.activeLayerId = l.id;
    doc.selectedLayerIds = [l.id];
    doc.history.clear('Open');
    return doc;
  }

  /* ------------------------------------------------------------------ */
  /* Layer tree access                                                   */
  /* ------------------------------------------------------------------ */

  /** Depth-first list of every layer, top to bottom. */
  flatLayers(list = this.layers, out = []) {
    for (const l of list) {
      out.push(l);
      if (l.children) this.flatLayers(l.children, out);
    }
    return out;
  }

  findLayer(id, list = this.layers) {
    for (const l of list) {
      if (l.id === id) return l;
      if (l.children) {
        const f = this.findLayer(id, l.children);
        if (f) return f;
      }
    }
    return null;
  }

  /** The array that directly contains `layer`, plus its index in it. */
  locate(layer, list = this.layers, parent = null) {
    const i = list.indexOf(layer);
    if (i >= 0) return { list, index: i, parent };
    for (const l of list) {
      if (l.children) {
        const f = this.locate(layer, l.children, l);
        if (f) return f;
      }
    }
    return null;
  }

  activeLayer() {
    return this.findLayer(this.activeLayerId);
  }

  selectedLayers() {
    return this.selectedLayerIds.map((id) => this.findLayer(id)).filter(Boolean);
  }

  setActiveLayer(id, additive = false, range = false) {
    if (range && this.activeLayerId) {
      const flat = this.flatLayers();
      const a = flat.findIndex((l) => l.id === this.activeLayerId);
      const b = flat.findIndex((l) => l.id === id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        this.selectedLayerIds = flat.slice(lo, hi + 1).map((l) => l.id);
        this.activeLayerId = id;
        this.emit('selection-change');
        return;
      }
    }
    if (additive) {
      if (this.selectedLayerIds.includes(id)) this.selectedLayerIds = this.selectedLayerIds.filter((x) => x !== id);
      else this.selectedLayerIds.push(id);
      this.activeLayerId = this.selectedLayerIds[this.selectedLayerIds.length - 1] || null;
    } else {
      this.activeLayerId = id;
      this.selectedLayerIds = id ? [id] : [];
    }
    this.emit('selection-change');
  }

  /* ------------------------------------------------------------------ */
  /* Mutation                                                            */
  /* ------------------------------------------------------------------ */

  /** Insert `layer` above the active layer (or at `index` in `parentList`). */
  addLayer(layer, opts = {}) {
    const { above = this.activeLayer(), parent = null, index = null } = opts;
    layer.parent = parent;
    if (index != null) {
      const list = parent ? parent.children : this.layers;
      list.splice(index, 0, layer);
    } else if (above) {
      const loc = this.locate(above);
      if (loc) {
        layer.parent = loc.parent;
        loc.list.splice(loc.index, 0, layer);
      } else this.layers.unshift(layer);
    } else {
      (parent ? parent.children : this.layers).unshift(layer);
    }
    this.activeLayerId = layer.id;
    this.selectedLayerIds = [layer.id];
    this.invalidate();
    this.emit('structure');
    return layer;
  }

  removeLayer(layer) {
    const loc = this.locate(layer);
    if (!loc) return false;
    loc.list.splice(loc.index, 1);
    if (this.activeLayerId === layer.id) {
      const next = loc.list[loc.index] || loc.list[loc.index - 1] || loc.parent || this.flatLayers()[0];
      this.activeLayerId = next ? next.id : null;
      this.selectedLayerIds = this.activeLayerId ? [this.activeLayerId] : [];
    }
    this.selectedLayerIds = this.selectedLayerIds.filter((id) => this.findLayer(id));
    this.invalidate();
    this.emit('structure');
    return true;
  }

  /** Move `layer` so it sits at `index` inside `parent` (null = root). */
  moveLayer(layer, parent, index) {
    const loc = this.locate(layer);
    if (!loc) return;
    const target = parent ? parent.children : this.layers;
    // Guard against dropping a group into itself.
    if (parent) {
      let p = parent;
      while (p) {
        if (p === layer) return;
        p = p.parent;
      }
    }
    loc.list.splice(loc.index, 1);
    if (loc.list === target && loc.index < index) index--;
    layer.parent = parent;
    target.splice(Math.max(0, Math.min(target.length, index)), 0, layer);
    this.invalidate();
    this.emit('structure');
  }

  /** Raise/lower within the whole stack (Layer > Arrange). */
  arrange(layer, where) {
    const loc = this.locate(layer);
    if (!loc) return;
    const list = loc.list;
    const i = loc.index;
    let j = i;
    if (where === 'front') j = 0;
    else if (where === 'back') j = list.length - 1;
    else if (where === 'forward') j = Math.max(0, i - 1);
    else if (where === 'backward') j = Math.min(list.length - 1, i + 1);
    if (j === i) return;
    list.splice(i, 1);
    list.splice(j, 0, layer);
    this.invalidate();
    this.emit('structure');
  }

  duplicateLayer(layer) {
    const copy = layer.clone(true);
    copy.name = `${layer.name} copy`;
    copy.isBackground = false;
    const loc = this.locate(layer);
    copy.parent = loc.parent;
    loc.list.splice(loc.index, 0, copy);
    this.activeLayerId = copy.id;
    this.selectedLayerIds = [copy.id];
    this.invalidate();
    this.emit('structure');
    return copy;
  }

  /* ------------------------------------------------------------------ */
  /* Edit lifecycle (copy-on-write + history)                            */
  /* ------------------------------------------------------------------ */

  /**
   * Prepare layers for pixel mutation. Always pair with `commit(label)`.
   * @param {Layer|Layer[]} [layers]
   */
  beginEdit(layers) {
    const list = layers == null ? [this.activeLayer()] : Array.isArray(layers) ? layers : [layers];
    for (const l of list) if (l) l.beginEdit();
    return list;
  }

  /** Record a history entry and notify listeners. */
  commit(label) {
    this.dirty = true;
    this.invalidate();
    this.history.record(label);
    this.emit('change', { reason: label });
  }

  /** Notify listeners without touching history (live drag previews). */
  touch(reason = 'edit') {
    this.dirty = true;
    this.invalidate();
    this.emit('change', { reason });
  }

  invalidate() {
    this._compositeValid = false;
    for (const l of this.flatLayers()) l.thumbDirty = true;
  }

  /* ------------------------------------------------------------------ */
  /* History serialisation                                               */
  /* ------------------------------------------------------------------ */

  captureState() {
    return {
      width: this.width,
      height: this.height,
      layers: this.layers.map((l) => l.snapshot()),
      activeLayerId: this.activeLayerId,
      selectedLayerIds: [...this.selectedLayerIds],
      selectionMask: this.selection.mask ? new Uint8ClampedArray(this.selection.mask) : null,
      alphaChannels: this.alphaChannels.map((c) => ({ ...c })),
      paths: structuredClone(this.paths),
      guides: [...this.guides],
      quickMask: this.quickMask,
      // Tool-owned document data. These are plain values, so a structural
      // clone is enough — without them a history step silently drops them.
      slices: this.slices ? structuredClone(this.slices) : null,
      colorSamplers: this.colorSamplers ? structuredClone(this.colorSamplers) : null,
      notes: this.notes ? structuredClone(this.notes) : null,
      artboards: this.artboards ? structuredClone(this.artboards) : null,
      measurement: this.measurement ? { ...this.measurement } : null,
    };
  }

  restoreState(s) {
    const sizeChanged = this.width !== s.width || this.height !== s.height;
    this.width = s.width;
    this.height = s.height;
    this.layers = s.layers.map((x) => Layer.fromSnapshot(x));
    for (const l of this.layers) l.parent = null;
    this.activeLayerId = s.activeLayerId;
    this.selectedLayerIds = [...s.selectedLayerIds];
    if (sizeChanged) this.selection = new Selection(this.width, this.height);
    this.selection.width = this.width;
    this.selection.height = this.height;
    this.selection.set(s.selectionMask ? new Uint8ClampedArray(s.selectionMask) : null);
    this.alphaChannels = s.alphaChannels.map((c) => ({ ...c }));
    this.paths = structuredClone(s.paths);
    this.guides = [...s.guides];
    this.quickMask = s.quickMask;
    if (s.slices !== undefined) this.slices = s.slices ? structuredClone(s.slices) : null;
    if (s.colorSamplers !== undefined) this.colorSamplers = s.colorSamplers ? structuredClone(s.colorSamplers) : null;
    if (s.notes !== undefined) this.notes = s.notes ? structuredClone(s.notes) : null;
    if (s.artboards !== undefined) this.artboards = s.artboards ? structuredClone(s.artboards) : null;
    if (s.measurement !== undefined) this.measurement = s.measurement ? { ...s.measurement } : null;
    this.invalidate();
    this.emit('selection-change');
  }

  /* ------------------------------------------------------------------ */
  /* Canvas / image size                                                 */
  /* ------------------------------------------------------------------ */

  /** Resample every layer (Image > Image Size). */
  resample(w, h, smoothing = 'high') {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    const scaleCanvas = (src) => {
      if (!src) return null;
      const out = createCanvas(w, h);
      const c = out.getContext('2d');
      c.imageSmoothingEnabled = smoothing !== 'nearest';
      c.imageSmoothingQuality = smoothing === 'nearest' ? 'low' : smoothing;
      c.drawImage(src, 0, 0, w, h);
      return out;
    };
    for (const l of this.flatLayers()) {
      l.beginEdit();
      if (l.canvas) l.canvas = scaleCanvas(l.canvas);
      if (l.mask) { l.mask = scaleCanvas(l.mask); l.touchMask(); }
      if (l.text) l.text.scale = (l.text.scale || 1) * (w / this.width);
    }
    const sx = w / this.width, sy = h / this.height;
    for (const p of this.paths) for (const sp of p.subpaths || []) for (const pt of sp.points || []) {
      pt.x *= sx; pt.y *= sy;
      if (pt.in) { pt.in.x *= sx; pt.in.y *= sy; }
      if (pt.out) { pt.out.x *= sx; pt.out.y *= sy; }
    }
    this.width = w;
    this.height = h;
    this.selection.resize(w, h);
    this.invalidate();
    this.emit('resize');
  }

  /** Change the canvas without resampling (Image > Canvas Size). */
  resizeCanvasTo(w, h, anchor = 'center') {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    const ax = anchor.includes('left') ? 0 : anchor.includes('right') ? 1 : 0.5;
    const ay = anchor.includes('top') ? 0 : anchor.includes('bottom') ? 1 : 0.5;
    const dx = Math.round((w - this.width) * ax);
    const dy = Math.round((h - this.height) * ay);
    const shift = (src, fillWhite) => {
      if (!src) return null;
      const out = createCanvas(w, h);
      const c = out.getContext('2d');
      if (fillWhite) { c.fillStyle = '#fff'; c.fillRect(0, 0, w, h); }
      c.drawImage(src, dx, dy);
      return out;
    };
    for (const l of this.flatLayers()) {
      l.beginEdit();
      if (l.canvas) l.canvas = shift(l.canvas, false);
      if (l.mask) { l.mask = shift(l.mask, true); l.touchMask(); }
    }
    for (const p of this.paths) for (const sp of p.subpaths || []) for (const pt of sp.points || []) {
      pt.x += dx; pt.y += dy;
      if (pt.in) { pt.in.x += dx; pt.in.y += dy; }
      if (pt.out) { pt.out.x += dx; pt.out.y += dy; }
    }
    this.width = w;
    this.height = h;
    this.selection.resize(w, h);
    if (this.selection.mask) this.selection.translate(dx, dy);
    this.invalidate();
    this.emit('resize');
  }

  crop(rect) {
    const { x, y, width, height } = rect;
    const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
    const cut = (src) => {
      if (!src) return null;
      const out = createCanvas(w, h);
      out.getContext('2d').drawImage(src, -Math.round(x), -Math.round(y));
      return out;
    };
    for (const l of this.flatLayers()) {
      l.beginEdit();
      if (l.canvas) l.canvas = cut(l.canvas);
      if (l.mask) { l.mask = cut(l.mask); l.touchMask(); }
    }
    for (const p of this.paths) for (const sp of p.subpaths || []) for (const pt of sp.points || []) {
      pt.x -= x; pt.y -= y;
      if (pt.in) { pt.in.x -= x; pt.in.y -= y; }
      if (pt.out) { pt.out.x -= x; pt.out.y -= y; }
    }
    this.width = w;
    this.height = h;
    this.selection = new Selection(w, h);
    this.invalidate();
    this.emit('resize');
  }

  /** Flip or rotate the whole image. */
  transformImage(kind) {
    const swap = kind === 'cw' || kind === 'ccw';
    const w = swap ? this.height : this.width;
    const h = swap ? this.width : this.height;
    const apply = (src) => {
      if (!src) return null;
      const out = createCanvas(w, h);
      const c = out.getContext('2d');
      c.save();
      if (kind === 'cw') { c.translate(w, 0); c.rotate(Math.PI / 2); }
      else if (kind === 'ccw') { c.translate(0, h); c.rotate(-Math.PI / 2); }
      else if (kind === '180') { c.translate(w, h); c.rotate(Math.PI); }
      else if (kind === 'flip-h') { c.translate(w, 0); c.scale(-1, 1); }
      else if (kind === 'flip-v') { c.translate(0, h); c.scale(1, -1); }
      c.drawImage(src, 0, 0);
      c.restore();
      return out;
    };
    for (const l of this.flatLayers()) {
      l.beginEdit();
      if (l.canvas) l.canvas = apply(l.canvas);
      if (l.mask) { l.mask = apply(l.mask); l.touchMask(); }
    }
    this.width = w;
    this.height = h;
    this.selection = new Selection(w, h);
    this.invalidate();
    this.emit('resize');
  }

  /* ------------------------------------------------------------------ */

  /** Estimated memory footprint, for the status bar. */
  memoryUse() {
    let n = 0;
    for (const l of this.flatLayers()) {
      if (l.canvas) n += l.canvas.width * l.canvas.height * 4;
      if (l.mask) n += l.mask.width * l.mask.height * 4;
    }
    return n;
  }
}
