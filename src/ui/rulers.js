import { el, rafThrottle } from '../core/util.js';
import { app } from '../core/app.js';
import './rulers.css';

/**
 * Horizontal and vertical rulers drawn over the canvas area.
 *
 * They follow `app.viewport`, tick in `app.units`, track the cursor and let you
 * drag a new guide out onto the document. Visibility follows `app.showRulers`.
 */

export const RULER_SIZE = 20;

const PX_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const CM_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200];
const MM_STEPS = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
const IN_STEPS = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32, 64];
const PT_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
const PCT_STEPS = [1, 2, 5, 10, 20, 25, 50, 100];

let installed = false;

/**
 * Attach the rulers to the canvas area element.
 * @param {HTMLElement} areaEl the `#canvas-area` container
 */
export function installRulers(areaEl) {
  if (!areaEl || installed) return;
  installed = true;

  const hEl = el('canvas.pk-ruler.pk-ruler-h');
  const vEl = el('canvas.pk-ruler.pk-ruler-v');
  const corner = el('div.pk-ruler-corner');
  areaEl.append(hEl, vEl, corner);

  const state = {
    areaEl, hEl, vEl, corner,
    hctx: hEl.getContext('2d'),
    vctx: vEl.getContext('2d'),
    cursor: null,
    drag: null,
    dpr: window.devicePixelRatio || 1,
  };

  const draw = rafThrottle(() => redraw(state));
  const resize = () => { resizeCanvases(state); redraw(state); };

  const ro = new ResizeObserver(resize);
  ro.observe(areaEl);
  resize();

  for (const ev of ['render', 'view-change', 'active-doc', 'doc-resize', 'docs-change', 'doc-change']) {
    app.on(ev, draw);
  }
  app.on('cursor-move', (e) => {
    state.cursor = { x: e.sx, y: e.sy };
    draw();
  });

  hEl.addEventListener('pointerdown', (e) => startGuide(state, 'h', e));
  vEl.addEventListener('pointerdown', (e) => startGuide(state, 'v', e));
  window.addEventListener('keydown', (e) => {
    if (state.drag && e.key === 'Escape') {
      e.stopPropagation();
      cancelGuide(state);
    }
  }, true);

  return state;
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

function resizeCanvases(s) {
  const r = s.areaEl.getBoundingClientRect();
  s.dpr = window.devicePixelRatio || 1;
  const hw = Math.max(1, Math.round(r.width - RULER_SIZE));
  const vh = Math.max(1, Math.round(r.height - RULER_SIZE));

  s.hEl.style.width = `${hw}px`;
  s.hEl.style.height = `${RULER_SIZE}px`;
  s.hEl.width = Math.round(hw * s.dpr);
  s.hEl.height = Math.round(RULER_SIZE * s.dpr);

  s.vEl.style.width = `${RULER_SIZE}px`;
  s.vEl.style.height = `${vh}px`;
  s.vEl.width = Math.round(RULER_SIZE * s.dpr);
  s.vEl.height = Math.round(vh * s.dpr);
}

function visible() {
  return !!(app.showRulers && app.activeDoc);
}

/* ------------------------------------------------------------------ */
/* Units                                                               */
/* ------------------------------------------------------------------ */

/**
 * How many document pixels one display unit spans, plus sensible tick steps.
 * @param {'x'|'y'} axis
 */
function unitInfo(axis) {
  const doc = app.activeDoc;
  const res = (doc && doc.resolution) || 72;
  switch (app.units) {
    case 'cm': return { per: res / 2.54, steps: CM_STEPS, decimals: 2 };
    case 'mm': return { per: res / 25.4, steps: MM_STEPS, decimals: 1 };
    case 'in': return { per: res, steps: IN_STEPS, decimals: 3 };
    case 'pt': return { per: res / 72, steps: PT_STEPS, decimals: 1 };
    case 'pica': return { per: res / 6, steps: PT_STEPS, decimals: 1 };
    case 'percent': return {
      per: Math.max(1, ((axis === 'x' ? doc && doc.width : doc && doc.height) || 100) / 100),
      steps: PCT_STEPS,
      decimals: 0,
    };
    default: return { per: 1, steps: PX_STEPS, decimals: 0 };
  }
}

function chooseStep(steps, pxPerUnit, minPx) {
  for (const s of steps) if (s * pxPerUnit >= minPx) return s;
  return steps[steps.length - 1];
}

function formatTick(value, decimals) {
  if (decimals === 0) return String(Math.round(value));
  const s = value.toFixed(decimals);
  return s.replace(/\.?0+$/, '');
}

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

function redraw(s) {
  const show = visible();
  s.hEl.style.display = show ? '' : 'none';
  s.vEl.style.display = show ? '' : 'none';
  s.corner.style.display = show ? '' : 'none';
  if (!show) return;

  drawRuler(s, 'x');
  drawRuler(s, 'y');
}

function drawRuler(s, axis) {
  const horizontal = axis === 'x';
  const ctx = horizontal ? s.hctx : s.vctx;
  const cssW = horizontal ? s.hEl.width / s.dpr : s.vEl.width / s.dpr;
  const cssH = horizontal ? s.hEl.height / s.dpr : s.vEl.height / s.dpr;
  const length = horizontal ? cssW : cssH;
  const thickness = horizontal ? cssH : cssW;

  ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = '#2b2b2b';
  ctx.fillRect(0, 0, cssW, cssH);

  const vp = app.viewport;
  const scale = vp.scale;
  const offset = horizontal ? vp.offsetX : vp.offsetY;
  const info = unitInfo(axis);
  const pxPerUnit = info.per * scale;
  if (!Number.isFinite(pxPerUnit) || pxPerUnit <= 0) return;

  // Ruler pixel <-> document coordinate (the ruler starts RULER_SIZE in).
  const toDoc = (p) => (p + RULER_SIZE - offset) / scale;
  const toRuler = (docPos) => docPos * scale + offset - RULER_SIZE;

  // Highlight the part of the ruler the document occupies.
  const doc = app.activeDoc;
  if (doc) {
    const a = toRuler(0);
    const b = toRuler(horizontal ? doc.width : doc.height);
    ctx.fillStyle = 'rgba(255,255,255,.07)';
    if (horizontal) ctx.fillRect(a, 0, b - a, thickness);
    else ctx.fillRect(0, a, thickness, b - a);
  }

  const step = chooseStep(info.steps, pxPerUnit, 62);
  let sub = 10;
  while (sub > 1 && (step * pxPerUnit) / sub < 6) sub = sub === 10 ? 5 : sub === 5 ? 2 : 1;

  const firstMajor = Math.floor(toDoc(0) / info.per / step) * step;
  const endUnit = toDoc(length) / info.per;
  const minor = step / sub;
  const count = Math.ceil((endUnit - firstMajor) / minor) + sub;
  if (!Number.isFinite(count) || count < 0 || count > 6000) return;

  ctx.font = '9px -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textBaseline = 'alphabetic';

  ctx.beginPath();
  ctx.strokeStyle = '#6f6f6f';
  ctx.lineWidth = 1;

  const labels = [];
  for (let k = 0; k <= count; k++) {
    const raw = firstMajor + k * minor;
    const value = Math.abs(raw) < minor / 1e6 ? 0 : raw;
    const p = Math.round(toRuler(value * info.per)) + 0.5;
    if (p < -2 || p > length + 2) continue;
    const isMajor = k % sub === 0;
    const isHalf = !isMajor && sub % 2 === 0 && k % (sub / 2) === 0;
    const len = isMajor ? thickness : isHalf ? 7 : 4;
    if (horizontal) {
      ctx.moveTo(p, thickness - len);
      ctx.lineTo(p, thickness);
    } else {
      ctx.moveTo(thickness - len, p);
      ctx.lineTo(thickness, p);
    }
    if (isMajor) labels.push({ p, text: formatTick(value, info.decimals) });
  }
  ctx.stroke();

  ctx.fillStyle = '#b6b6b6';
  for (const l of labels) {
    if (horizontal) {
      ctx.fillText(l.text, l.p + 3, 9);
    } else {
      ctx.save();
      ctx.translate(9, l.p - 3);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(l.text, 0, 0);
      ctx.restore();
    }
  }

  // Cursor marker.
  if (s.cursor) {
    const screen = horizontal ? s.cursor.x : s.cursor.y;
    const p = Math.round(screen - RULER_SIZE) + 0.5;
    ctx.strokeStyle = '#e8e8e8';
    ctx.beginPath();
    if (horizontal) { ctx.moveTo(p, 0); ctx.lineTo(p, thickness); }
    else { ctx.moveTo(0, p); ctx.lineTo(thickness, p); }
    ctx.stroke();
  }

  // Edge line.
  ctx.strokeStyle = '#171717';
  ctx.beginPath();
  if (horizontal) { ctx.moveTo(0, cssH - 0.5); ctx.lineTo(cssW, cssH - 0.5); }
  else { ctx.moveTo(cssW - 0.5, 0); ctx.lineTo(cssW - 0.5, cssH); }
  ctx.stroke();
}

/* ------------------------------------------------------------------ */
/* Guide dragging                                                      */
/* ------------------------------------------------------------------ */

function startGuide(s, from, e) {
  const doc = app.activeDoc;
  if (!doc || e.button !== 0) return;
  e.preventDefault();

  const axis = from === 'h' ? 'h' : 'v';
  const guide = { axis, pos: 0 };
  doc.guides.push(guide);
  app.showGuides = true;

  s.drag = { doc, guide };
  moveGuide(s, e);

  const onMove = (ev) => moveGuide(s, ev);
  const onUp = (ev) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    finishGuide(s, ev);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function areaPoint(s, e) {
  const r = s.areaEl.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function moveGuide(s, e) {
  if (!s.drag) return;
  const guide = s.drag.guide;
  const p = areaPoint(s, e);
  const d = app.viewport.toDoc(p.x, p.y);
  let pos = guide.axis === 'h' ? d.y : d.x;
  if (app.snap && app.gridSize > 0) {
    const g = app.gridSize;
    const snapped = Math.round(pos / g) * g;
    if (Math.abs(snapped - pos) * app.viewport.scale < 6) pos = snapped;
  }
  guide.pos = Math.round(pos);
  app.requestRender();
}

function finishGuide(s, e) {
  if (!s.drag) return;
  const { doc, guide } = s.drag;
  const p = areaPoint(s, e);
  const dropped = p.x > RULER_SIZE && p.y > RULER_SIZE;
  s.drag = null;

  const i = doc.guides.indexOf(guide);
  if (!dropped) {
    if (i >= 0) doc.guides.splice(i, 1);
    app.requestRender();
    return;
  }
  doc.commit('New Guide');
}

function cancelGuide(s) {
  if (!s.drag) return;
  const { doc, guide } = s.drag;
  s.drag = null;
  const i = doc.guides.indexOf(guide);
  if (i >= 0) doc.guides.splice(i, 1);
  app.requestRender();
}
