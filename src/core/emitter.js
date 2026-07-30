/** Minimal synchronous event emitter used by documents, the app and panels. */
export class Emitter {
  constructor() {
    this._handlers = new Map();
  }

  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }

  once(event, fn) {
    const off = this.on(event, (...a) => {
      off();
      fn(...a);
    });
    return off;
  }

  off(event, fn) {
    const set = this._handlers.get(event);
    if (set) set.delete(fn);
  }

  emit(event, ...args) {
    const set = this._handlers.get(event);
    if (set) for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`[emitter:${event}]`, err);
      }
    }
    const all = this._handlers.get('*');
    if (all) for (const fn of [...all]) {
      try {
        fn(event, ...args);
      } catch (err) {
        console.error('[emitter:*]', err);
      }
    }
  }

  removeAll(event) {
    if (event) this._handlers.delete(event);
    else this._handlers.clear();
  }
}
