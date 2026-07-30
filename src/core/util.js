/**
 * Shared low-level helpers. Everything in Pikado that touches pixels goes
 * through these so canvas creation stays consistent (and easy to swap for
 * OffscreenCanvas later).
 */

let _uid = 0;
export function uid(prefix = 'id') {
  _uid += 1;
  return `${prefix}_${_uid.toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function createCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function ctx2d(canvas, opts) {
  return canvas.getContext('2d', { willReadFrequently: false, ...opts });
}

/** A context flagged for frequent getImageData — much faster for filters. */
export function ctx2dRead(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true });
}

export function cloneCanvas(src) {
  if (!src) return null;
  const c = createCanvas(src.width, src.height);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

export function clearCanvas(c) {
  c.getContext('2d').clearRect(0, 0, c.width, c.height);
}

export function resizeCanvas(c, w, h) {
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function getImageData(canvas, x = 0, y = 0, w = canvas.width, h = canvas.height) {
  return ctx2dRead(canvas).getImageData(x, y, Math.max(1, w), Math.max(1, h));
}

export function putImageData(canvas, data, x = 0, y = 0) {
  canvas.getContext('2d').putImageData(data, x, y);
}

export function imageDataToCanvas(data) {
  const c = createCanvas(data.width, data.height);
  c.getContext('2d').putImageData(data, 0, 0);
  return c;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function deg2rad(d) {
  return (d * Math.PI) / 180;
}

export function rad2deg(r) {
  return (r * 180) / Math.PI;
}

/** Nearest power-of-two-ish stepping used by the zoom control. */
export const ZOOM_STEPS = [
  0.0025, 0.005, 0.01, 0.02, 0.0333, 0.05, 0.0667, 0.0833, 0.125, 0.1667, 0.25,
  0.3333, 0.5, 0.6667, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 32,
];

export function nextZoom(cur, dir) {
  if (dir > 0) {
    for (const z of ZOOM_STEPS) if (z > cur + 1e-6) return z;
    return ZOOM_STEPS[ZOOM_STEPS.length - 1];
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < cur - 1e-6) return ZOOM_STEPS[i];
  return ZOOM_STEPS[0];
}

/** Format a byte count for the status bar. */
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} K`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} M`;
  return `${(n / 1073741824).toFixed(2)} G`;
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Load a File/Blob into an HTMLImageElement. */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error('Could not decode image'));
    if (src instanceof Blob) {
      const url = URL.createObjectURL(src);
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.src = url;
    } else {
      img.src = src;
    }
  });
}

export function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsArrayBuffer(file);
  });
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsText(file);
  });
}

/** requestAnimationFrame-coalesced callback. */
export function rafThrottle(fn) {
  let queued = false;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...lastArgs);
    });
  };
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Build a DOM element quickly: el('div.cls#id', {attrs}, children...) */
export function el(spec, attrs, ...children) {
  let tag = 'div';
  let cls = [];
  let id = null;
  const m = String(spec).match(/^([a-zA-Z0-9-]*)((?:[.#][^.#]+)*)$/);
  if (m) {
    if (m[1]) tag = m[1];
    const rest = m[2] || '';
    for (const part of rest.match(/[.#][^.#]+/g) || []) {
      if (part[0] === '.') cls.push(part.slice(1));
      else id = part.slice(1);
    }
  }
  const node = document.createElement(tag);
  if (cls.length) node.className = cls.join(' ');
  if (id) node.id = id;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'class') node.className = [node.className, v].filter(Boolean).join(' ');
      else node.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat(4)) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}
