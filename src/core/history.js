import { Emitter } from './emitter.js';

/**
 * Snapshot-based undo history.
 *
 * Every entry captures the full layer tree *structure* plus references to the
 * pixel buffers that were live at that moment. Because tools call
 * `doc.beginEdit(layer)` (copy-on-write) before drawing, those references stay
 * valid forever — so a snapshot costs only a few hundred bytes unless pixels
 * actually changed.
 */
export class History extends Emitter {
  constructor(doc, limit = 60) {
    super();
    this.doc = doc;
    this.limit = limit;
    /** @type {{label:string, state:object, thumb:HTMLCanvasElement|null}[]} */
    this.states = [];
    this.index = -1;
    this.suspended = 0;
  }

  get canUndo() {
    return this.index > 0;
  }

  get canRedo() {
    return this.index < this.states.length - 1;
  }

  suspend() {
    this.suspended++;
  }

  resume() {
    this.suspended = Math.max(0, this.suspended - 1);
  }

  /** Push the document's *current* state as a new history entry. */
  record(label) {
    if (this.suspended) return;
    const state = this.doc.captureState();
    // Drop the redo tail.
    if (this.index < this.states.length - 1) this.states.length = this.index + 1;
    this.states.push({ label, state, thumb: null });
    if (this.states.length > this.limit) this.states.shift();
    this.index = this.states.length - 1;
    this.emit('change');
  }

  /** Replace the newest entry — used when a drag produces many micro-updates. */
  replaceTop(label) {
    if (this.suspended || this.index < 0) return this.record(label);
    this.states[this.index] = { label, state: this.doc.captureState(), thumb: null };
    this.emit('change');
  }

  undo() {
    if (!this.canUndo) return false;
    this.index--;
    this._apply();
    return true;
  }

  redo() {
    if (!this.canRedo) return false;
    this.index++;
    this._apply();
    return true;
  }

  /** Jump directly to a history entry (History panel click). */
  goto(i) {
    if (i < 0 || i >= this.states.length || i === this.index) return false;
    this.index = i;
    this._apply();
    return true;
  }

  _apply() {
    this.suspend();
    try {
      this.doc.restoreState(this.states[this.index].state);
    } finally {
      this.resume();
    }
    this.emit('change');
    this.doc.emit('change', { reason: 'history' });
    this.doc.emit('structure');
  }

  clear(label = 'Open') {
    this.states = [];
    this.index = -1;
    this.record(label);
  }

  labels() {
    return this.states.map((s) => s.label);
  }
}
