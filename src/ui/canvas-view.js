import { app } from '../core/app.js';
import { getViewComposite } from '../render/compositor.js';
import { createCanvas } from '../core/util.js';
import { trn } from '../core/i18n.js';
import { snapLines } from '../core/snapping.js';
import { OVERLAY } from './brand.js';
import { guideAt, guideSegment, isGuideDragging, startGuideDrag } from './guides.js';
import {
  artworkOf, clearDropTarget, copyIntoDocument, documentTabUnder, setDropTarget,
} from './cross-doc-drag.js';

/**
 * The document view: draws the composite plus all on-canvas chrome
 * (checkerboard, marching ants, guides, grid, tool overlays) and turns raw
 * pointer events into the normalised events tools consume.
 */
export class CanvasView {
  constructor(canvasEl, areaEl) {
    this.canvas = canvasEl;
    this.area = areaEl;
    this.ctx = canvasEl.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;

    this.antsOffset = 0;
    this.antsTimer = null;
    this._pointerDown = false;
    this._lastDoc = null;
    this._spaceDown = false;
    this._panning = false;
    this._panStart = null;
    this._checker = null;
    this.cursorDoc = { x: 0, y: 0 };

    this._bind();
    this._observeSize();
    app.on('render', () => this.draw());
    app.on('view-change', () => this.draw());
    app.on('tool-change', () => this.updateCursor());
  }

  /* ---------------------------------------------------------------- */

  _observeSize() {
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(this.area);
    this.resize();
  }

  resize() {
    const r = this.area.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    // The first resize() runs from the constructor, before the flex layout has
    // settled, so the area rect can still be 0x0 (clamped to 1x1 above). Fitting
    // against that produces scale = 1/docWidth. Only treat a genuinely usable
    // size as "sized", and fit the first time we get one.
    const hadUsableSize = this._hasUsableSize === true;
    if (w > 1 && h > 1) this._hasUsableSize = true;
    app.viewport.setViewSize(w, h);
    if (!hadUsableSize && this._hasUsableSize && app.activeDoc) app.fitView();
    this.draw();
  }

  /* ---------------------------------------------------------------- */
  /* Drawing                                                           */
  /* ---------------------------------------------------------------- */

  draw() {
    const ctx = this.ctx;
    const view = app.viewport;
    const doc = app.activeDoc;

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, view.viewWidth, view.viewHeight);

    if (!doc) {
      ctx.restore();
      return;
    }

    const m = view.matrix();

    // --- drop the artboard onto the surround -----------------------------
    // A soft shadow under the document makes it read as a physical sheet on a
    // neutral table, which is also the cue that tells you where the artboard
    // ends and the (identically neutral) surround begins.
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = 26;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    this._pathDocRect(ctx, m, doc);
    ctx.fill();
    ctx.restore();

    // --- checkerboard behind the document -------------------------------
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.beginPath();
    this._pathDocRect(ctx, m, doc);
    ctx.clip();
    ctx.fillStyle = this._checkerPattern(ctx);
    // Keep the checker in screen space so it does not shimmer while zooming.
    ctx.fillRect(0, 0, view.viewWidth, view.viewHeight);
    ctx.restore();

    // --- composite ------------------------------------------------------
    // The *view* composite: identical to getComposite() unless the Channels
    // panel has hidden a channel, which is a viewing aid only — everything that
    // leaves the app (export, flatten, save) still reads the full-colour one.
    const composite = getViewComposite(doc);
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.imageSmoothingEnabled = view.scale < 1;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(composite, 0, 0);
    ctx.restore();

    // --- quick mask overlay --------------------------------------------
    if (doc.quickMask && doc.selection.active) {
      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
      ctx.globalAlpha = 0.5;
      ctx.drawImage(this._quickMaskCanvas(doc), 0, 0);
      ctx.restore();
    }

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // --- artboard edge ---------------------------------------------------
    // A light hairline, not a black outline: the shadow already separates the
    // sheet from the surround, so this only needs to crisp up the boundary.
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.09)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    this._pathDocRect(ctx, m, doc);
    ctx.stroke();
    ctx.restore();

    if (app.showGrid) this._drawGrid(ctx, m, doc);
    if (app.showGuides) this._drawGuides(ctx, m, doc);
    this._drawSnapLines(ctx, m, doc);
    if (!doc.quickMask) this._drawAnts(ctx, m, doc);

    // --- active tool overlay --------------------------------------------
    if (app.tool && app.tool.drawOverlay) {
      ctx.save();
      try {
        app.tool.drawOverlay(ctx, view);
      } catch (err) {
        console.error('[tool overlay]', err);
      }
      ctx.restore();
    }

    ctx.restore();
  }

  _pathDocRect(ctx, m, doc) {
    const p = [
      m.transformPoint(new DOMPoint(0, 0)),
      m.transformPoint(new DOMPoint(doc.width, 0)),
      m.transformPoint(new DOMPoint(doc.width, doc.height)),
      m.transformPoint(new DOMPoint(0, doc.height)),
    ];
    ctx.moveTo(p[0].x, p[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(p[i].x, p[i].y);
    ctx.closePath();
  }

  _checkerPattern(ctx) {
    if (!this._checker) {
      const c = createCanvas(16, 16);
      const g = c.getContext('2d');
      g.fillStyle = '#9a9a9a';
      g.fillRect(0, 0, 16, 16);
      g.fillStyle = '#6a6a6a';
      g.fillRect(0, 0, 8, 8);
      g.fillRect(8, 8, 8, 8);
      this._checker = c;
    }
    return ctx.createPattern(this._checker, 'repeat');
  }

  _quickMaskCanvas(doc) {
    if (this._qmVersion === doc.selection.version && this._qm) return this._qm;
    const w = doc.width, h = doc.height;
    const img = new ImageData(w, h);
    const d = img.data;
    const mask = doc.selection.mask;
    for (let i = 0, p = 0; p < w * h; p++, i += 4) {
      const cov = mask ? mask[p] : 255;
      d[i] = 255; d[i + 1] = 0; d[i + 2] = 0;
      d[i + 3] = 255 - cov;
    }
    const cv = createCanvas(w, h);
    cv.getContext('2d').putImageData(img, 0, 0);
    this._qm = cv;
    this._qmVersion = doc.selection.version;
    return cv;
  }

  _drawGrid(ctx, m, doc) {
    const view = app.viewport;
    if (view.scale * app.gridSize < 4) return;
    ctx.save();
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.lineWidth = 1 / view.scale;
    const sub = app.gridSize / Math.max(1, app.gridSubdivisions);
    ctx.strokeStyle = 'rgba(140,140,140,.16)';
    ctx.beginPath();
    for (let x = 0; x <= doc.width; x += sub) { ctx.moveTo(x, 0); ctx.lineTo(x, doc.height); }
    for (let y = 0; y <= doc.height; y += sub) { ctx.moveTo(0, y); ctx.lineTo(doc.width, y); }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(160,180,220,.34)';
    ctx.beginPath();
    for (let x = 0; x <= doc.width; x += app.gridSize) { ctx.moveTo(x, 0); ctx.lineTo(x, doc.height); }
    for (let y = 0; y <= doc.height; y += app.gridSize) { ctx.moveTo(0, y); ctx.lineTo(doc.width, y); }
    ctx.stroke();
    ctx.restore();
  }

  _drawGuides(ctx, m, doc) {
    if (!doc.guides.length) return;
    const view = app.viewport;
    ctx.save();
    // Guides belong to document coordinates, but span the entire workspace.
    ctx.lineWidth = 1;
    ctx.strokeStyle = OVERLAY.guide;
    ctx.beginPath();
    for (const g of doc.guides) {
      const segment = guideSegment(g, view);
      if (!segment) continue;
      ctx.moveTo(segment[0].x, segment[0].y);
      ctx.lineTo(segment[1].x, segment[1].y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Smart guides: what the thing being dragged is currently lined up with.
   *
   * Only ever non-empty during a drag — `snapping.js` records the lines as it
   * solves and the tool clears them on pointer-up — so this needs no state of
   * its own and no "am I dragging" test. They are deliberately not gated on
   * `app.showGuides`: that hides the guides you placed, and these are feedback
   * about the drag in your hand.
   */
  _drawSnapLines(ctx, m, doc) {
    const lines = snapLines();
    if (!lines.length) return;
    const view = app.viewport;
    ctx.save();
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.lineWidth = 1 / view.scale;
    ctx.strokeStyle = OVERLAY.smartGuide;
    ctx.beginPath();
    for (const l of lines) {
      if (l.axis === 'v') { ctx.moveTo(l.pos, 0); ctx.lineTo(l.pos, doc.height); }
      else { ctx.moveTo(0, l.pos); ctx.lineTo(doc.width, l.pos); }
    }
    ctx.stroke();
    ctx.restore();
  }

  _drawAnts(ctx, m, doc) {
    const path = doc.selection.contour();
    if (!path) return;
    const view = app.viewport;
    ctx.save();
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.lineWidth = 1 / view.scale;
    ctx.setLineDash([4 / view.scale, 4 / view.scale]);
    ctx.lineDashOffset = -this.antsOffset / view.scale;
    ctx.strokeStyle = '#000';
    ctx.stroke(path);
    ctx.lineDashOffset = (-this.antsOffset + 4) / view.scale;
    ctx.strokeStyle = '#fff';
    ctx.stroke(path);
    ctx.restore();
    this._ensureAntsRunning();
  }

  _ensureAntsRunning() {
    if (this.antsTimer) return;
    this.antsTimer = setInterval(() => {
      const doc = app.activeDoc;
      if (!doc || !doc.selection.active || doc.quickMask) {
        clearInterval(this.antsTimer);
        this.antsTimer = null;
        return;
      }
      this.antsOffset = (this.antsOffset + 1) % 8;
      this.draw();
    }, 110);
  }

  /* ---------------------------------------------------------------- */
  /* Input                                                             */
  /* ---------------------------------------------------------------- */

  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this._onDown(e));
    c.addEventListener('pointermove', (e) => this._onMove(e));
    c.addEventListener('pointerleave', () => { if (!isGuideDragging()) this.updateCursor(); });
    window.addEventListener('pointerup', (e) => this._onUp(e));
    window.addEventListener('pointercancel', (e) => this._onUp(e));
    c.addEventListener('dblclick', (e) => {
      const ev = this._normalize(e);
      if (app.tool) app.tool.onDoubleClick(ev);
    });
    c.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
  }

  _normalize(e) {
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const d = app.viewport.toDoc(sx, sy);
    const prev = this._lastDoc || d;
    const ev = {
      x: d.x, y: d.y,
      sx, sy,
      dx: d.x - prev.x, dy: d.y - prev.y,
      pressure: e.pressure && e.pointerType === 'pen' ? e.pressure : 1,
      pointerType: e.pointerType || 'mouse',
      button: e.button, buttons: e.buttons,
      shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey,
      native: e,
    };
    return ev;
  }

  _onDown(e) {
    if (!app.activeDoc) return;
    if (isGuideDragging()) return;

    // The right button opens the context menu and must never reach the tool —
    // otherwise right-clicking with the brush lays down a stroke behind the menu.
    if (e.button === 2) return;

    this.canvas.setPointerCapture?.(e.pointerId);
    const ev = this._normalize(e);
    this._lastDoc = { x: ev.x, y: ev.y };

    // Middle-drag or space-drag always pans, regardless of tool.
    if (e.button === 1 || this._spaceDown) {
      this._panning = true;
      this._panStart = { sx: ev.sx, sy: ev.sy, ox: app.viewport.offsetX, oy: app.viewport.offsetY };
      e.preventDefault();
      return;
    }
    const guide = e.button === 0 && this._guideAt(ev);
    if (guide && startGuideDrag(this.area, guide, e, { onEnd: () => this.updateCursor() })) {
      this.canvas.style.cursor = guide.axis === 'v' ? 'col-resize' : 'row-resize';
      return;
    }
    this._pointerDown = true;
    if (app.tool) app.tool.onPointerDown(ev);
    e.preventDefault();
  }

  _onMove(e) {
    if (!app.activeDoc) return;
    if (isGuideDragging()) return;
    const ev = this._normalize(e);
    this.cursorDoc = { x: ev.x, y: ev.y };
    app.emit('cursor-move', ev);

    if (this._panning) {
      app.viewport.offsetX = this._panStart.ox + (ev.sx - this._panStart.sx);
      app.viewport.offsetY = this._panStart.oy + (ev.sy - this._panStart.sy);
      app.emit('view-change');
      this.draw();
      this._lastDoc = { x: ev.x, y: ev.y };
      return;
    }
    const guide = !this._pointerDown && this._guideAt(ev);
    if (guide) this.canvas.style.cursor = guide.axis === 'v' ? 'col-resize' : 'row-resize';
    else this.updateCursor();
    if (app.tool) app.tool.onPointerMove(ev);
    this._crossDocHover(e);
    this._lastDoc = { x: ev.x, y: ev.y };
  }

  /**
   * Light another document's tab while a Move drag is held over it.
   *
   * The canvas takes `setPointerCapture` on pointerdown, so this handler keeps
   * firing once the cursor has left the canvas — and the tab itself never
   * receives a pointer event, which is why the tab is found by hit-testing the
   * point rather than by listening on it.
   */
  _crossDocHover(e) {
    if (!this._pointerDown) return;
    const held = this._crossDocSource();
    if (!held) return;
    setDropTarget(documentTabUnder(e.clientX, e.clientY, held.doc));
  }

  /**
   * The layers a Move press is holding, whether or not the tool took the drag.
   *
   * `tool.blocked` is the case that matters in practice: the Move tool refuses
   * to start a drag on a locked layer, and a freshly opened image is a single
   * locked Background — so without this, the one gesture people reach for
   * first does nothing at all.
   */
  _crossDocSource() {
    // Deliberately does NOT test `_pointerDown`: `_onUp` clears it before it
    // asks, so gating here silently disabled every release.
    const tool = app.tool;
    if (!tool || tool.id !== 'move') return null;
    const held = tool.drag || tool.blocked;
    if (!held) return null;
    const doc = held.doc || app.activeDoc;
    const layers = (held.layers || []).filter(Boolean);
    return doc && layers.length ? { doc, layers } : null;
  }

  /**
   * A Move drag released over another document's tab copies the layers there
   * instead of finishing the move.
   *
   * The drag is *aborted*, not committed, so the source document is left as it
   * was — dragging a layer between two open documents copies it, the way it
   * does in Photoshop, rather than taking it out of where it came from. Abort
   * first and the pixels read for the copy are the ones from before the drag
   * started, not wherever the cursor had pushed them to.
   *
   * @returns {boolean} true when the release was consumed
   */
  _crossDocRelease(e) {
    const held = this._crossDocSource();
    if (!held) return false;
    const dest = documentTabUnder(e.clientX, e.clientY, held.doc);
    if (!dest) return false;
    const tool = app.tool;
    // A drag the tool took is aborted, not committed. A press it refused never
    // started one, so there is nothing to abort — only the pending complaint
    // about the lock to drop, since this was a copy and not a move.
    if (tool.drag && typeof tool.abortDrag === 'function') tool.abortDrag();
    tool.blocked = null;
    const { doc: source, layers } = held;
    const name = layers.length === 1 ? layers[0].name : trn('{count} layer', '{count} layers', layers.length);
    copyIntoDocument(dest, artworkOf(source, layers), name);
    return true;
  }

  _onUp(e) {
    if (this._panning) {
      this._panning = false;
      this._panStart = null;
      return;
    }
    if (!this._pointerDown) return;
    this._pointerDown = false;
    clearDropTarget();
    if (!app.activeDoc) return;
    if (this._crossDocRelease(e)) {
      this._lastDoc = null;
      return;
    }
    const ev = this._normalize(e);
    if (app.tool) app.tool.onPointerUp(ev);
    this._lastDoc = null;
  }

  _onWheel(e) {
    if (!app.activeDoc) return;
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;

    if (app.tool && app.tool.onWheel && app.tool.onWheel({ ...this._normalize(e), deltaY: e.deltaY })) {
      e.preventDefault();
      return;
    }

    // Ctrl/Cmd or pinch = zoom; plain wheel = scroll; shift+wheel = horizontal.
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      app.viewport.zoomBy(Math.pow(1.0022, -e.deltaY * 1.6), sx, sy);
    } else if (e.shiftKey) {
      e.preventDefault();
      app.viewport.pan(-e.deltaY, 0);
    } else {
      e.preventDefault();
      app.viewport.pan(-e.deltaX, -e.deltaY);
    }
    app.emit('view-change');
    this.draw();
  }

  setSpaceDown(down) {
    this._spaceDown = down;
    this.updateCursor();
  }

  _guideAt(ev) {
    // Match the Move tool convention; Ctrl/Cmd also lets other tools pick guides.
    if (this._spaceDown || app.transformSession) return null;
    if (app.tool?.id !== 'move' && !ev.ctrlKey && !ev.metaKey) return null;
    return guideAt(ev.sx, ev.sy);
  }

  updateCursor() {
    if (this._spaceDown) { this.canvas.style.cursor = 'grab'; return; }
    this.canvas.style.cursor = app.tool ? app.tool.getCursor() : 'default';
  }
}
