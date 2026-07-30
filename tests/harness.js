/**
 * Pikado test harness.
 *
 * These tests run in a real browser, not Node, because essentially every
 * subsystem depends on working Canvas2D or WebGL — a jsdom canvas would make the
 * suite meaningless. Open `/tests/` on the dev server, or drive it from
 * automation via `window.__pikadoTests`.
 *
 * Writing a suite:
 *
 *   import { suite } from '../harness.js';
 *
 *   suite('blend modes', async (t) => {
 *     const doc = t.doc(100, 100, '#ffffff');   // auto-closed after the suite
 *     t.eq(t.px(canvas, 50, 50), '128,128,64,255', 'multiply is exact');
 *   });
 *
 * Assertions record a result and keep going, so one failure does not hide the
 * rest of the suite. A thrown error fails the whole suite and is reported.
 */

/** @type {{name:string, fn:Function, only?:boolean, skip?:boolean}[]} */
export const suites = [];

export function suite(name, fn) {
  suites.push({ name, fn });
}

/** Run only this suite (handy while debugging a failure). */
export function suiteOnly(name, fn) {
  suites.push({ name, fn, only: true });
}

export function suiteSkip(name, fn) {
  suites.push({ name, fn, skip: true });
}

/* ------------------------------------------------------------------ */
/* Assertion context                                                   */
/* ------------------------------------------------------------------ */

class TestContext {
  constructor(suiteName) {
    this.suiteName = suiteName;
    this.results = [];
    this._docs = [];
    this._app = null;
  }

  _record(pass, message, detail) {
    this.results.push({ pass, message, detail: pass ? undefined : detail });
    return pass;
  }

  /** The live app singleton. Never import app.js directly in a test — see below. */
  get app() {
    return this._app;
  }

  /* --- assertions --- */

  ok(cond, message) {
    return this._record(!!cond, message, `expected truthy, got ${fmt(cond)}`);
  }

  notOk(cond, message) {
    return this._record(!cond, message, `expected falsy, got ${fmt(cond)}`);
  }

  eq(actual, expected, message) {
    const pass = deepEqual(actual, expected);
    return this._record(pass, message, `expected ${fmt(expected)}, got ${fmt(actual)}`);
  }

  ne(actual, expected, message) {
    return this._record(!deepEqual(actual, expected), message, `expected something other than ${fmt(expected)}`);
  }

  /**
   * Reference identity (`===`), not structural equality.
   *
   * `eq`/`ne` compare deeply, so two distinct objects with identical contents
   * count as equal — which silently defeats any test about object identity
   * (e.g. "undo rebuilt the layer objects", "the cache returned the same
   * canvas"). Use `is`/`isNot` for those.
   */
  is(actual, expected, message) {
    return this._record(actual === expected, message, 'expected the same object reference');
  }

  isNot(actual, expected, message) {
    return this._record(actual !== expected, message, 'expected a different object reference');
  }

  /** Numeric comparison with a tolerance. */
  close(actual, expected, tol, message) {
    const pass = Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
    return this._record(pass, message, `expected ${expected} +/- ${tol}, got ${actual}`);
  }

  lt(actual, limit, message) {
    return this._record(actual < limit, message, `expected < ${limit}, got ${actual}`);
  }

  gt(actual, limit, message) {
    return this._record(actual > limit, message, `expected > ${limit}, got ${actual}`);
  }

  /** Assert a thrown error. `fn` may be async. */
  async throws(fn, message) {
    try {
      await fn();
      return this._record(false, message, 'expected a throw, none happened');
    } catch {
      return this._record(true, message);
    }
  }

  /* --- pixel helpers --- */

  /** "r,g,b,a" at a pixel of a canvas. */
  px(canvas, x, y) {
    const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data;
    return `${d[0]},${d[1]},${d[2]},${d[3]}`;
  }

  /** Assert an exact pixel value. */
  pixel(canvas, x, y, expected, message) {
    const got = this.px(canvas, x, y);
    return this._record(got === expected, message || `pixel(${x},${y})`, `expected ${expected}, got ${got}`);
  }

  /** Mean absolute difference between two ImageData/Uint8 buffers. */
  mad(a, b) {
    const da = a.data || a, db = b.data || b;
    if (da.length !== db.length) return Infinity;
    let s = 0;
    for (let i = 0; i < da.length; i++) s += Math.abs(da[i] - db[i]);
    return s / da.length;
  }

  /** Raw pixel bytes of a canvas. */
  bytes(canvas) {
    return canvas.getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, canvas.width, canvas.height).data;
  }

  /** Count of pixels whose alpha exceeds `threshold`. */
  inked(canvas, threshold = 8) {
    const d = this.bytes(canvas);
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > threshold) n++;
    return n;
  }

  /* --- fixtures --- */

  /**
   * A scratch document registered with the app and closed automatically when
   * the suite finishes.
   */
  doc(width = 100, height = 100, fill = '#ffffff', name = 'test') {
    const d = this._PikaDocument.blank(width, height, name, fill);
    this._app.addDocument(d);
    this._docs.push(d);
    return d;
  }

  /** Fill a layer's canvas with a solid colour. */
  fill(layer, color, x = 0, y = 0, w = null, h = null) {
    const c = layer.canvas.getContext('2d');
    c.fillStyle = color;
    c.fillRect(x, y, w == null ? layer.canvas.width : w, h == null ? layer.canvas.height : h);
    return layer;
  }

  /** A layer of fine detail, so resampling loss is measurable. */
  detail(layer) {
    const c = layer.canvas.getContext('2d');
    const w = layer.canvas.width, h = layer.canvas.height;
    for (let y = 0; y < h; y += 4) {
      for (let x = 0; x < w; x += 4) {
        c.fillStyle = `hsl(${(x + y) % 360},80%,${40 + ((x / 4 + y / 4) % 2) * 30}%)`;
        c.fillRect(x, y, 4, 4);
      }
    }
    c.strokeStyle = '#000';
    c.lineWidth = 1;
    for (let i = 0; i < w; i += 16) {
      c.beginPath(); c.moveTo(i, 0); c.lineTo(0, i); c.stroke();
    }
    return layer;
  }

  /** Elapsed ms for a synchronous call. */
  time(fn) {
    const s = performance.now();
    fn();
    return performance.now() - s;
  }

  _cleanup() {
    for (const d of this._docs) {
      try {
        this._app.closeDocument(d);
      } catch { /* already gone */ }
    }
    this._docs = [];
  }
}

function fmt(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean' || v == null) return String(v);
  try {
    const s = JSON.stringify(v);
    return s && s.length > 160 ? `${s.slice(0, 160)}…` : s;
  } catch {
    return Object.prototype.toString.call(v);
  }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a == null || b == null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

/* ------------------------------------------------------------------ */
/* Runner                                                             */
/* ------------------------------------------------------------------ */

/**
 * Hand control back to the browser so the page can paint between suites.
 *
 * NOT `setTimeout`: a backgrounded tab throttles timers to once per second, and
 * after a few minutes hidden, to roughly once per *minute*. With one yield per
 * suite that stalls a 70-suite run for over an hour, which is exactly what
 * happened. A MessageChannel task is not throttled.
 */
function yieldToBrowser() {
  return new Promise((resolve) => {
    if (typeof MessageChannel === 'function') {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        resolve();
      };
      ch.port2.postMessage(0);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * Bind to the LIVE app instance.
 *
 * On the Vite dev server modules are served with an HMR query string, so a bare
 * `import('/src/core/app.js')` instantiates a SECOND app object with empty
 * registries — tests would silently drive a dead app. Reaching the singleton
 * through an already-registered tool gets the real one.
 */
async function liveApp() {
  const { tools } = await import('/src/tools/base.js');
  const viaTool = tools.size ? [...tools.values()][0].app : null;
  if (viaTool) return viaTool;
  if (typeof window !== 'undefined' && window.pikado) return window.pikado;
  const mod = await import('/src/core/app.js');
  return mod.app;
}

export async function runAll({ onProgress } = {}) {
  const { PikaDocument } = await import('/src/core/document.js');
  const app = await liveApp();

  const only = suites.filter((s) => s.only);
  const list = (only.length ? only : suites).filter((s) => !s.skip);

  const report = { suites: [], passed: 0, failed: 0, errors: 0, startedAt: Date.now() };

  for (const s of list) {
    const t = new TestContext(s.name);
    t._app = app;
    t._PikaDocument = PikaDocument;
    const entry = { name: s.name, results: [], error: null, ms: 0 };
    const started = performance.now();
    try {
      await s.fn(t);
    } catch (err) {
      entry.error = (err && err.stack) || String(err);
      report.errors++;
    } finally {
      t._cleanup();
    }
    entry.ms = Math.round(performance.now() - started);
    entry.results = t.results;
    for (const r of t.results) r.pass ? report.passed++ : report.failed++;
    report.suites.push(entry);
    if (onProgress) onProgress(entry, report);
    await yieldToBrowser();
  }

  report.ms = Date.now() - report.startedAt;
  report.ok = report.failed === 0 && report.errors === 0;
  return report;
}
