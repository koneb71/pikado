import { Emitter } from './emitter.js';
import { PikaDocument } from './document.js';
import { Viewport } from '../render/viewport.js';
import { parseColor, toHex, DEFAULT_SWATCHES } from './color.js';
import { tools, getTool } from '../tools/base.js';
import { rafThrottle } from './util.js';

/**
 * The application singleton. Everything the UI needs hangs off this object:
 * open documents, the active tool, colours, and the render request loop.
 */
class App extends Emitter {
  constructor() {
    super();
    /** @type {PikaDocument[]} */
    this.docs = [];
    /** @type {PikaDocument|null} */
    this.activeDoc = null;

    this.viewport = new Viewport();
    /** Per-document saved viewport state. */
    this._views = new Map();

    this.foreground = parseColor('#000000');
    this.background = parseColor('#ffffff');
    this.swatches = [...DEFAULT_SWATCHES];

    /** @type {import('../tools/base.js').Tool|null} */
    this.tool = null;
    this.previousToolId = null;
    /** Set while space/alt temporarily overrides the tool. */
    this.tempToolId = null;

    this.units = 'px';
    this.showGuides = true;
    this.showGrid = false;
    this.showRulers = true;
    this.snap = true;
    this.gridSize = 20;
    this.gridSubdivisions = 4;

    /** Modules push {label, run} for Filter > Last Filter. */
    this.lastFilter = null;

    /** Clipboard for Edit > Copy/Paste, holds an ImageData or canvas. */
    this.clipboard = null;

    /** Live free-transform session, see src/tools/transform.js */
    this.transformSession = null;

    this.requestRender = rafThrottle(() => this.emit('render'));
    this.ready = false;
  }

  /* --------------------------------------------------------------- */
  /* Documents                                                        */
  /* --------------------------------------------------------------- */

  addDocument(doc, activate = true) {
    this.docs.push(doc);
    doc.on('change', () => {
      if (doc === this.activeDoc) this.requestRender();
      this.emit('doc-change', doc);
    });
    doc.on('structure', () => {
      if (doc === this.activeDoc) this.requestRender();
      this.emit('doc-structure', doc);
    });
    doc.on('selection-change', () => {
      if (doc === this.activeDoc) this.requestRender();
      this.emit('doc-selection', doc);
    });
    doc.on('resize', () => {
      if (doc === this.activeDoc) this.requestRender();
      this.emit('doc-resize', doc);
    });
    doc.history.on('change', () => this.emit('history-change', doc));
    this.emit('docs-change');
    if (activate) this.setActiveDoc(doc);
    return doc;
  }

  newDocument(opts) {
    const doc = PikaDocument.blank(opts.width, opts.height, opts.name, opts.fill);
    doc.resolution = opts.resolution || 72;
    this.addDocument(doc);
    this.fitView();
    return doc;
  }

  closeDocument(doc) {
    const i = this.docs.indexOf(doc);
    if (i < 0) return;
    this.docs.splice(i, 1);
    this._views.delete(doc.id);
    this._dropTransformSession(doc);
    if (this.activeDoc === doc) this.setActiveDoc(this.docs[Math.min(i, this.docs.length - 1)] || null);
    this.emit('docs-change');
  }

  /**
   * A free-transform session belongs to one document, and it renders its live
   * preview straight into the layer pixels. Leaving that document without
   * resolving the session would strand a half-applied transform and leave the
   * Transform commands acting on layers the user can no longer see.
   *
   * src/tools/transform.js listens for this and commits; the event keeps app.js
   * from having to import it (transform.js already imports app).
   */
  _dropTransformSession(doc) {
    const s = this.transformSession;
    if (!s || (doc && s.doc !== doc)) return;
    this.emit('transform-session-ending', s);
    this.transformSession = null;
  }

  setActiveDoc(doc) {
    if (this.activeDoc === doc) return;
    if (this.activeDoc) this._views.set(this.activeDoc.id, this.viewport.serialize());
    if (this.transformSession && this.transformSession.doc !== doc) this._dropTransformSession(this.transformSession.doc);
    this.activeDoc = doc;
    if (doc) {
      const saved = this._views.get(doc.id);
      if (saved) this.viewport.restore(saved);
      else this.fitView();
    }
    this.emit('active-doc', doc);
    this.emit('docs-change');
    this.requestRender();
  }

  fitView(maxScale = 1) {
    if (!this.activeDoc) return;
    // The viewport has no usable size until the canvas area has been laid out.
    // Fitting against it would set scale = 1/docWidth; CanvasView.resize() fits
    // as soon as it gets a real size, so just skip.
    if (this.viewport.viewWidth <= 1 || this.viewport.viewHeight <= 1) return;
    this.viewport.fit(this.activeDoc.width, this.activeDoc.height, 48, maxScale);
    this.emit('view-change');
    this.requestRender();
  }

  /* --------------------------------------------------------------- */
  /* Tools                                                            */
  /* --------------------------------------------------------------- */

  setTool(id, { remember = true } = {}) {
    const next = getTool(id);
    if (!next || next === this.tool) return;
    // Safety net for tools registered after boot (main.js inits the rest):
    // without this, `tool.app` stays null and `tool.doc` never resolves.
    if (!next.app) next.init(this);
    if (this.tool) {
      try { this.tool.commit(); } catch (e) { console.error(e); }
      this.tool.onDeactivate();
      if (remember) this.previousToolId = this.tool.id;
    }
    this.tool = next;
    next.onActivate();
    this.emit('tool-change', next);
    this.requestRender();
  }

  /** Space-bar/temporary tool override (restored on key-up). */
  pushTempTool(id) {
    if (this.tempToolId || !this.tool) return;
    this.tempToolId = this.tool.id;
    this.setTool(id, { remember: false });
  }

  popTempTool() {
    if (!this.tempToolId) return;
    const id = this.tempToolId;
    this.tempToolId = null;
    this.setTool(id, { remember: false });
  }

  /* --------------------------------------------------------------- */
  /* Colours                                                          */
  /* --------------------------------------------------------------- */

  setForeground(c) {
    this.foreground = parseColor(c);
    this.emit('color-change');
  }

  setBackground(c) {
    this.background = parseColor(c);
    this.emit('color-change');
  }

  swapColors() {
    const t = this.foreground;
    this.foreground = this.background;
    this.background = t;
    this.emit('color-change');
  }

  resetColors() {
    this.foreground = parseColor('#000000');
    this.background = parseColor('#ffffff');
    this.emit('color-change');
  }

  /* --------------------------------------------------------------- */
  /* Feedback                                                         */
  /* --------------------------------------------------------------- */

  toast(message, kind = 'info', ms = 2600) {
    this.emit('toast', { message, kind, ms });
  }

  /** Wrap a long-running operation with a busy indicator. */
  async busy(label, fn) {
    this.emit('busy', { label, active: true });
    // Give the busy overlay a frame to paint before we block the main thread.
    // requestAnimationFrame does not fire while the tab is hidden, so race it
    // against a timer — otherwise backgrounding the tab mid-operation leaves
    // the spinner up forever and the operation never runs.
    await new Promise((r) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; r(); } };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      setTimeout(finish, 50);
    });
    try {
      return await fn();
    } catch (err) {
      console.error(err);
      this.toast(err && err.message ? err.message : String(err), 'error', 5000);
      return null;
    } finally {
      this.emit('busy', { label, active: false });
    }
  }
}

export const app = new App();

// Handy for debugging from the console.
if (typeof window !== 'undefined') window.pikado = app;
