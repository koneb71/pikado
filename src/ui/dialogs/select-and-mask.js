import './dialogs.css';
import './select-and-mask.css';
import { el, createCanvas, ctx2d, ctx2dRead } from '../../core/util.js';
import { Dialog, buildForm } from '../dialog.js';
import { app } from '../../core/app.js';
import { getComposite } from '../../render/compositor.js';
import { Layer, LayerType, createRasterLayer } from '../../core/layer.js';
import { TRIMAP, grabcut, autoTrimap } from '../../select/grabcut.js';
import { refineSelection, decontaminateColors, edgeBand } from '../../select/refine.js';

/**
 * The Select and Mask workspace.
 *
 * A selection editor with its own canvas: paint what is definitely subject and
 * definitely background, let the graph cut work out the boundary, then refine
 * that boundary with matting, smoothing, feathering and edge shifting, watching
 * the result against black, white, the layers below, or as a plain mask.
 *
 * Two things about the architecture are worth knowing before changing anything
 * here.
 *
 * **The trimap is the document.** Everything the user paints goes into a trimap
 * (`src/select/grabcut.js`), never straight into a mask. The cut is re-run from
 * the trimap whenever the strokes change, and the refinements are re-run from
 * the cut whenever a slider moves. So the sliders are always non-destructive
 * relative to the strokes, and the strokes relative to each other — you can go
 * back to Radius after twenty brush strokes and it behaves as if you had set it
 * first. Nothing is baked until OK.
 *
 * **Two resolutions.** The cut runs on a downscaled copy (see `WORK_PIXELS`)
 * because a min-cut is superlinear in pixel count; the refinements run at full
 * document resolution, because that is where the edge detail is. The upscale in
 * between is bilinear-then-threshold rather than nearest, so the cut's boundary
 * arrives as a smooth contour for the matting pass to work on rather than as a
 * staircase.
 */

/** Cut resolution. A quarter megapixel is ~50 ms and keeps the workspace live. */
const WORK_PIXELS = 260000;

/** How the preview shows the selection. */
const VIEW_MODES = [
  { value: 'onion', label: 'Onion Skin', hint: 'Unselected areas fade out' },
  { value: 'ants', label: 'Marching Ants', hint: 'The classic dashed outline' },
  { value: 'overlay', label: 'Overlay', hint: 'Unselected areas tinted, like Quick Mask' },
  { value: 'black', label: 'On Black', hint: 'The selection over black' },
  { value: 'white', label: 'On White', hint: 'The selection over white' },
  { value: 'mask', label: 'Black & White', hint: 'The mask itself' },
  { value: 'layers', label: 'On Layers', hint: 'The selection over the layers below' },
];

/** Where the result goes when the workspace closes. */
const OUTPUTS = [
  { value: 'selection', label: 'Selection' },
  { value: 'mask', label: 'Layer Mask' },
  { value: 'layer', label: 'New Layer' },
  { value: 'layer-mask', label: 'New Layer with Layer Mask' },
  { value: 'document', label: 'New Document' },
];

const TOOLS = [
  { value: 'brush', label: 'Brush', hint: 'Paint subject; hold Alt to paint background' },
  { value: 'refine', label: 'Refine Edge', hint: 'Hand the boundary back to the matting pass' },
  { value: 'lasso', label: 'Lasso', hint: 'Enclose an area to mark it' },
];

/* ------------------------------------------------------------------ */
/* Scaling helpers                                                     */
/* ------------------------------------------------------------------ */

/** Work size for a document, never larger than the document itself. */
function workSize(w, h) {
  const scale = Math.min(1, Math.sqrt(WORK_PIXELS / (w * h)));
  return {
    w: Math.max(8, Math.round(w * scale)),
    h: Math.max(8, Math.round(h * scale)),
    scale,
  };
}

/** Scale a coverage mask with bilinear sampling. */
function scaleMask(mask, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return new Uint8ClampedArray(mask);
  const out = new Uint8ClampedArray(dw * dh);
  const fx = sw / dw, fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * fy - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), ty = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * fx - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), tx = sx - x0;
      const a = mask[y0 * sw + x0], b = mask[y0 * sw + x1];
      const c = mask[y1 * sw + x0], d = mask[y1 * sw + x1];
      out[y * dw + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  return out;
}

/** Nearest-neighbour scale for a label field, where interpolation is meaningless. */
function scaleLabels(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return new Uint8Array(src);
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y + 0.5) * (sh / dh)));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x + 0.5) * (sw / dw)));
      out[y * dw + x] = src[sy * sw + sx];
    }
  }
  return out;
}

/** Downscale an ImageData through a canvas, which uses the browser's filter. */
function scaleImage(image, dw, dh) {
  const src = createCanvas(image.width, image.height);
  ctx2d(src).putImageData(image, 0, 0);
  const dst = createCanvas(dw, dh);
  const c = ctx2d(dst);
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(src, 0, 0, dw, dh);
  return ctx2dRead(dst).getImageData(0, 0, dw, dh);
}

/* ------------------------------------------------------------------ */
/* The workspace                                                       */
/* ------------------------------------------------------------------ */

/**
 * Open Select and Mask on a document.
 * @param {import('../../core/document.js').PikaDocument} doc
 * @param {{subject?:boolean}} [opts] `subject` starts from an automatic guess
 * @returns {Promise<boolean>} whether a result was applied
 */
export async function showSelectAndMask(doc, opts = {}) {
  if (!doc) return false;
  const W = doc.width, H = doc.height;
  const full = ctx2dRead(getComposite(doc)).getImageData(0, 0, W, H);
  const work = workSize(W, H);
  const workImage = scaleImage(full, work.w, work.h);

  /* --- state ---------------------------------------------------------- */

  const state = {
    view: 'onion',
    opacity: 60,
    tool: 'brush',
    brushSize: Math.max(6, Math.round(Math.min(W, H) / 24)),
    radius: 0,
    smart: false,
    smooth: 0,
    feather: 0,
    contrast: 0,
    shift: 0,
    decontaminate: false,
    decontaminateAmount: 60,
    output: 'selection',
  };

  /**
   * User paint at work resolution; `0xff` means "the user has not painted here".
   *
   * Kept strictly separate from the seed below, and for a reason that is visible
   * rather than theoretical: the stroke overlay draws this buffer, so folding
   * Select Subject's result into it would tint the entire canvas green and red
   * and make On Black show dark red instead of black.
   */
  const strokes = new Uint8Array(work.w * work.h).fill(0xff);
  /** Pixels the Refine Edge brush handed back to the matting pass. */
  const refineBand = new Uint8Array(work.w * work.h);
  /**
   * The starting labels the cut refines: from the live selection, from saliency,
   * or from a previous Select Subject. Replaced wholesale, never painted into.
   */
  let baseTrimap = null;
  /** The last cut, at work resolution. */
  let cutMask = null;
  /** The refined mask at full resolution — what OK will use. */
  let finalMask = null;

  const startMask = doc.selection && doc.selection.active
    ? new Uint8ClampedArray(doc.selection.mask)
    : null;

  /* --- seed ----------------------------------------------------------- */

  /** The initial labels: the live selection where there is one, else saliency. */
  function initialTrimap() {
    const n = work.w * work.h;
    if (!startMask) return autoTrimap(workImage).trimap;

    const small = scaleMask(startMask, W, H, work.w, work.h);
    const trimap = new Uint8Array(n);
    // The existing selection is a suggestion, not a constraint: a band around its
    // edge becomes "maybe" so the cut can improve on it, while the confident
    // interior and exterior stay put and give the colour models something to fit.
    const reach = Math.max(3, 6 * work.scale);
    const { dist } = edgeBand(small, work.w, work.h, reach);
    for (let i = 0; i < n; i++) {
      const inside = small[i] > 127;
      const near = Math.abs(dist[i]) <= reach;
      if (near) trimap[i] = inside ? TRIMAP.MAYBE_FG : TRIMAP.MAYBE_BG;
      else trimap[i] = inside ? TRIMAP.FG : TRIMAP.BG;
    }
    return trimap;
  }

  /** The seed with the user's paint applied on top, which is what the cut sees. */
  function seedTrimap() {
    if (!baseTrimap) baseTrimap = initialTrimap();
    const trimap = new Uint8Array(baseTrimap);
    for (let i = 0; i < trimap.length; i++) {
      // Paint is a hard constraint and overrides the seed.
      if (strokes[i] === TRIMAP.FG || strokes[i] === TRIMAP.BG) { trimap[i] = strokes[i]; continue; }
      // The Refine Edge brush does the opposite: it demotes a hard label back to
      // "maybe", handing that stretch of boundary back to the solver.
      if (refineBand[i]) {
        if (trimap[i] === TRIMAP.FG) trimap[i] = TRIMAP.MAYBE_FG;
        else if (trimap[i] === TRIMAP.BG) trimap[i] = TRIMAP.MAYBE_BG;
      }
    }
    return trimap;
  }

  /**
   * Adopt a finished cut as the new seed, so later strokes refine *it* rather
   * than starting again from saliency. The band around the boundary stays
   * "maybe" — freezing it would stop the cut from ever moving the edge again.
   */
  function adoptAsSeed(mask) {
    const reach = Math.max(2, 4 * work.scale);
    const { dist } = edgeBand(mask, work.w, work.h, reach);
    const next = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) {
      const inside = mask[i] > 127;
      const near = Math.abs(dist[i]) <= reach;
      if (near) next[i] = inside ? TRIMAP.MAYBE_FG : TRIMAP.MAYBE_BG;
      else next[i] = inside ? TRIMAP.FG : TRIMAP.BG;
    }
    baseTrimap = next;
  }

  /* --- the two-stage recompute ---------------------------------------- */

  let cutPending = false;

  function runCut() {
    const trimap = seedTrimap();
    const res = grabcut(workImage, trimap, { iterations: 3 });
    cutMask = res.mask;
    cutPending = false;
  }

  function runRefine() {
    if (!cutMask) runCut();
    let mask = scaleMask(cutMask, work.w, work.h, W, H);
    // The bilinear upscale leaves a soft ramp the width of the scale factor.
    // Matting wants that (it is a better starting guess than a staircase), but
    // without matting it would read as an unrequested feather, so harden it.
    if (!(state.radius > 0)) {
      for (let i = 0; i < mask.length; i++) mask[i] = mask[i] > 127 ? 255 : 0;
    }
    finalMask = refineSelection(full, mask, W, H, state);
  }

  function recompute({ cut = false } = {}) {
    if (cut) cutPending = true;
    if (cutPending) runCut();
    runRefine();
    draw();
  }

  /* --- preview -------------------------------------------------------- */

  const preview = el('canvas.pk-sam-canvas');
  const previewWrap = el('div.pk-sam-view', {}, preview);
  const status = el('div.pk-sam-status');

  /** Fit the document into the available box, at device pixel ratio. */
  function fitPreview() {
    const box = previewWrap.getBoundingClientRect();
    const availW = Math.max(120, box.width - 2);
    const availH = Math.max(120, box.height - 2);
    const z = Math.min(availW / W, availH / H);
    const cssW = Math.round(W * z), cssH = Math.round(H * z);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    preview.style.width = `${cssW}px`;
    preview.style.height = `${cssH}px`;
    preview.width = Math.max(1, Math.round(cssW * dpr));
    preview.height = Math.max(1, Math.round(cssH * dpr));
    return z;
  }

  /**
   * Composite `full` against the chosen backdrop, masked by `finalMask`.
   *
   * The modes divide into three shapes: the mask on its own, the document with
   * an overlay drawn on the *unselected* part, and the cut-out over a backdrop.
   */
  function renderPreviewImage() {
    const out = createCanvas(W, H);
    const c = ctx2d(out);
    const mode = state.view;
    const fade = Math.max(0, Math.min(100, state.opacity)) / 100;

    if (mode === 'mask') {
      const img = new ImageData(W, H);
      for (let i = 0; i < W * H; i++) {
        const o = i * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = finalMask[i];
        img.data[o + 3] = 255;
      }
      c.putImageData(img, 0, 0);
      return out;
    }

    if (mode === 'ants') {
      c.drawImage(getComposite(doc), 0, 0);
      return out;
    }

    if (mode === 'overlay') {
      // Quick Mask's own convention: the document, tinted where coverage is low.
      c.drawImage(getComposite(doc), 0, 0);
      const tint = new ImageData(W, H);
      for (let i = 0; i < W * H; i++) {
        const o = i * 4;
        tint.data[o] = 255;
        tint.data[o + 3] = Math.round((255 - finalMask[i]) * fade);
      }
      const tc = createCanvas(W, H);
      ctx2d(tc).putImageData(tint, 0, 0);
      c.drawImage(tc, 0, 0);
      return out;
    }

    // The remaining modes show the cut-out itself over a backdrop.
    const cut = new ImageData(W, H);
    cut.data.set(full.data);
    for (let i = 0; i < W * H; i++) cut.data[i * 4 + 3] = finalMask[i];
    if (state.decontaminate) decontaminateColors(cut, finalMask, state.decontaminateAmount);

    if (mode === 'black' || mode === 'white') {
      c.fillStyle = mode === 'black' ? '#000000' : '#ffffff';
      c.fillRect(0, 0, W, H);
    } else if (mode === 'layers') {
      // "On Layers" means everything under the active layer — what you are
      // actually compositing the selection against.
      c.drawImage(underlyingComposite(doc), 0, 0);
    } else if (mode === 'onion') {
      // Onion skin keeps a ghost of the whole document behind the cut-out.
      c.save();
      c.globalAlpha = 1 - fade;
      c.drawImage(getComposite(doc), 0, 0);
      c.restore();
    }

    const tmp = createCanvas(W, H);
    ctx2d(tmp).putImageData(cut, 0, 0);
    c.drawImage(tmp, 0, 0);
    return out;
  }

  function draw() {
    const z = fitPreview();
    const c = ctx2d(preview);
    const dpr = preview.width / Math.max(1, parseFloat(preview.style.width));
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, preview.width, preview.height);
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(renderPreviewImage(), 0, 0, preview.width, preview.height);

    if (state.view === 'ants') drawAnts(c, z * dpr);
    drawStrokeOverlay(c, z * dpr);

    let selected = 0;
    for (let i = 0; i < finalMask.length; i++) selected += finalMask[i];
    const pct = (selected / (finalMask.length * 255)) * 100;
    status.textContent = `${pct.toFixed(1)}% selected · cut at ${work.w}×${work.h}, refined at ${W}×${H}`;
  }

  /** Marching ants, traced from the mask's own contour loops. */
  function drawAnts(c, z) {
    const loops = contourFromMask(finalMask, W, H);
    c.save();
    c.setTransform(z, 0, 0, z, 0, 0);
    c.lineWidth = 1 / z;
    for (const pass of [0, 1]) {
      c.strokeStyle = pass ? '#000' : '#fff';
      c.setLineDash(pass ? [4 / z, 4 / z] : []);
      c.lineDashOffset = pass ? 4 / z : 0;
      c.beginPath();
      for (const loop of loops) {
        if (loop.length < 2) continue;
        c.moveTo(loop[0].x, loop[0].y);
        for (let i = 1; i < loop.length; i++) c.lineTo(loop[i].x, loop[i].y);
        c.closePath();
      }
      c.stroke();
    }
    c.restore();
  }

  /** Faint marks where the user has painted, so the strokes are visible. */
  function drawStrokeOverlay(c, z) {
    const n = work.w * work.h;
    let any = false;
    for (let i = 0; i < n; i++) if (strokes[i] !== 0xff || refineBand[i]) { any = true; break; }
    if (!any) return;
    const img = new ImageData(work.w, work.h);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (strokes[i] === TRIMAP.FG) { img.data[o] = 90; img.data[o + 1] = 220; img.data[o + 2] = 130; img.data[o + 3] = 70; }
      else if (strokes[i] === TRIMAP.BG) { img.data[o] = 240; img.data[o + 1] = 80; img.data[o + 2] = 90; img.data[o + 3] = 70; }
      else if (refineBand[i]) { img.data[o] = 250; img.data[o + 1] = 210; img.data[o + 2] = 80; img.data[o + 3] = 60; }
    }
    const cv = createCanvas(work.w, work.h);
    ctx2d(cv).putImageData(img, 0, 0);
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.imageSmoothingEnabled = true;
    c.drawImage(cv, 0, 0, preview.width, preview.height);
    c.restore();
  }

  /* --- painting -------------------------------------------------------- */

  let painting = false;
  let lastPoint = null;
  let lassoPoints = null;

  /** Preview coordinates -> work-resolution coordinates. */
  function toWork(e) {
    const r = preview.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * work.w;
    const y = ((e.clientY - r.top) / r.height) * work.h;
    return { x, y };
  }

  function stampAt(x, y, label, radius) {
    const r = Math.max(0.6, radius);
    const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(work.w - 1, Math.ceil(x + r));
    const y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(work.h - 1, Math.ceil(y + r));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        if (Math.hypot(px - x, py - y) > r) continue;
        const i = py * work.w + px;
        if (label === 'refine') { refineBand[i] = 1; strokes[i] = 0xff; }
        else { strokes[i] = label; refineBand[i] = 0; }
      }
    }
  }

  function strokeTo(a, b, label, radius) {
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / Math.max(0.5, radius * 0.4)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      stampAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, label, radius);
    }
  }

  /** The label a press should paint, given the tool and modifiers. */
  function labelFor(e) {
    if (state.tool === 'refine') return 'refine';
    return e.altKey ? TRIMAP.BG : TRIMAP.FG;
  }

  preview.addEventListener('pointerdown', (e) => {
    // Capture keeps a stroke alive when the pointer leaves the canvas, but it
    // throws for a pointer id the browser does not know about (a synthetic
    // event, a pointer that has already been released). Losing capture costs a
    // stroke that ends early; letting it throw here would abort the stroke
    // before it started.
    try { preview.setPointerCapture(e.pointerId); } catch { /* capture is optional */ }
    painting = true;
    const p = toWork(e);
    const radius = (state.brushSize / 2) * work.scale;
    if (state.tool === 'lasso') {
      lassoPoints = [p];
    } else {
      lastPoint = p;
      stampAt(p.x, p.y, labelFor(e), radius);
      draw();
    }
    e.preventDefault();
  });

  preview.addEventListener('pointermove', (e) => {
    if (!painting) return;
    const p = toWork(e);
    if (state.tool === 'lasso') {
      lassoPoints.push(p);
      draw();
      // Draw the in-progress loop on top of the frame we just rendered.
      const c = ctx2d(preview);
      const sx = preview.width / work.w, sy = preview.height / work.h;
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.strokeStyle = '#ffffff';
      c.lineWidth = 1.5;
      c.setLineDash([5, 4]);
      c.beginPath();
      c.moveTo(lassoPoints[0].x * sx, lassoPoints[0].y * sy);
      for (const q of lassoPoints.slice(1)) c.lineTo(q.x * sx, q.y * sy);
      c.stroke();
      c.restore();
      return;
    }
    strokeTo(lastPoint, p, labelFor(e), (state.brushSize / 2) * work.scale);
    lastPoint = p;
    draw();
  });

  const endStroke = (e) => {
    if (!painting) return;
    painting = false;
    if (state.tool === 'lasso' && lassoPoints && lassoPoints.length > 2) {
      fillLasso(lassoPoints, labelFor(e));
      lassoPoints = null;
    }
    lastPoint = null;
    recompute({ cut: true });
  };
  preview.addEventListener('pointerup', endStroke);
  preview.addEventListener('pointercancel', endStroke);

  /** Rasterise the lasso polygon into the stroke buffer. */
  function fillLasso(points, label) {
    const cv = createCanvas(work.w, work.h);
    const c = ctx2d(cv);
    c.fillStyle = '#fff';
    c.beginPath();
    c.moveTo(points[0].x, points[0].y);
    for (const p of points.slice(1)) c.lineTo(p.x, p.y);
    c.closePath();
    c.fill();
    const d = ctx2dRead(cv).getImageData(0, 0, work.w, work.h).data;
    for (let i = 0; i < work.w * work.h; i++) {
      if (d[i * 4 + 3] < 128) continue;
      if (label === 'refine') { refineBand[i] = 1; strokes[i] = 0xff; }
      else { strokes[i] = label; refineBand[i] = 0; }
    }
  }

  /* --- controls -------------------------------------------------------- */

  const params = [
    { key: 'view', label: 'View', type: 'select', options: VIEW_MODES },
    { key: 'opacity', label: 'Opacity', type: 'slider', min: 0, max: 100, unit: '%',
      when: (s) => s.view === 'onion' || s.view === 'overlay' },
    { type: 'separator' },
    { key: 'tool', label: 'Tool', type: 'radio', options: TOOLS },
    { key: 'brushSize', label: 'Brush Size', type: 'slider', min: 1, max: Math.max(40, Math.round(Math.min(W, H) / 2)), unit: 'px' },
    { type: 'separator' },
    { type: 'label', label: 'Edge Detection' },
    { key: 'radius', label: 'Radius', type: 'slider', min: 0, max: 100, unit: 'px' },
    { key: 'smart', label: 'Smart Radius', type: 'checkbox' },
    { type: 'label', label: 'Global Refinements' },
    { key: 'smooth', label: 'Smooth', type: 'slider', min: 0, max: 20 },
    { key: 'feather', label: 'Feather', type: 'slider', min: 0, max: 50, unit: 'px' },
    { key: 'contrast', label: 'Contrast', type: 'slider', min: 0, max: 100, unit: '%' },
    { key: 'shift', label: 'Shift Edge', type: 'slider', min: -100, max: 100, unit: '%' },
    { type: 'separator' },
    { type: 'label', label: 'Output Settings' },
    { key: 'decontaminate', label: 'Decontaminate Colors', type: 'checkbox' },
    { key: 'decontaminateAmount', label: 'Amount', type: 'slider', min: 0, max: 100, unit: '%',
      when: (s) => s.decontaminate },
    { key: 'output', label: 'Output To', type: 'select', options: OUTPUTS },
  ];

  let form = null;
  const onChange = (key, value) => {
    state[key] = value;
    if (form) form.refresh();
    // Only the strokes change the cut; every slider here is downstream of it.
    if (key === 'view' || key === 'opacity' || key === 'tool' || key === 'brushSize'
      || key === 'output' || key === 'decontaminate' || key === 'decontaminateAmount') {
      draw();
    } else {
      recompute();
    }
  };

  /* --- assembly -------------------------------------------------------- */

  const dialog = new Dialog({ title: 'Select and Mask', width: 980, className: 'pk-sam' });
  form = buildForm(params, state, onChange);

  /** Saliency guess -> cut -> adopt as the seed. Shared by the button and open. */
  function selectSubject() {
    strokes.fill(0xff);
    refineBand.fill(0);
    const guess = autoTrimap(workImage);
    const res = grabcut(workImage, guess.trimap, { iterations: 3 });
    cutMask = res.mask;
    cutPending = false;
    adoptAsSeed(cutMask);
    if (!guess.confident) app.toast('No obvious subject — paint a few strokes to guide it.', 'info');
    runRefine();
  }

  const actions = el('div.pk-sam-actions', {},
    el('button.pk-btn.subtle', {
      text: 'Select Subject',
      title: 'Guess the subject with saliency plus a graph cut — no model, so no magic',
      onclick: () => { selectSubject(); draw(); },
    }),
    el('button.pk-btn.subtle', {
      text: 'Reset',
      onclick: () => {
        strokes.fill(0xff);
        refineBand.fill(0);
        baseTrimap = null;
        Object.assign(state, { radius: 0, smart: false, smooth: 0, feather: 0, contrast: 0, shift: 0 });
        form.refresh();
        recompute({ cut: true });
      },
    })
  );

  dialog.setBody(
    el('div.pk-sam-layout', {},
      el('div.pk-sam-main', {}, previewWrap, status),
      el('div.pk-sam-side', {}, actions, form.node)
    )
  );

  let applied = false;
  dialog.setButtons([
    { label: 'Cancel', value: false, subtle: true },
    {
      label: 'OK',
      primary: true,
      onClick: () => { applied = true; return true; },
      value: true,
    },
  ]);

  const onResize = () => draw();
  window.addEventListener('resize', onResize);
  dialog.onClose(() => window.removeEventListener('resize', onResize));

  const opened = dialog.open();

  // First render. Select Subject on open when asked for, otherwise the cut is
  // seeded from whatever selection already exists.
  if (opts.subject) selectSubject();
  else recompute({ cut: true });
  draw();

  const ok = await opened;
  if (!ok || !applied) return false;

  applyOutput(doc, finalMask, state);
  return true;
}

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

/** Everything below the active layer, for the "On Layers" view. */
function underlyingComposite(doc) {
  const active = doc.activeLayer();
  const out = createCanvas(doc.width, doc.height);
  if (!active) return out;
  const idx = doc.layers.indexOf(active);
  if (idx < 0) return getComposite(doc);
  const c = ctx2d(out);
  for (let i = doc.layers.length - 1; i > idx; i--) {
    const l = doc.layers[i];
    if (!l.visible || !l.canvas) continue;
    c.save();
    c.globalAlpha = l.opacity;
    c.drawImage(l.canvas, 0, 0);
    c.restore();
  }
  return out;
}

/** Write the finished mask wherever the Output To setting says. */
function applyOutput(doc, mask, state) {
  const W = doc.width, H = doc.height;
  const maskCanvas = () => {
    const cv = createCanvas(W, H);
    const img = new ImageData(W, H);
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = mask[i];
      img.data[o + 3] = 255;
    }
    ctx2d(cv).putImageData(img, 0, 0);
    return cv;
  };
  const cutPixels = () => {
    const src = ctx2dRead(getComposite(doc)).getImageData(0, 0, W, H);
    for (let i = 0; i < W * H; i++) src.data[i * 4 + 3] = Math.round((src.data[i * 4 + 3] * mask[i]) / 255);
    if (state.decontaminate) decontaminateColors(src, mask, state.decontaminateAmount);
    const cv = createCanvas(W, H);
    ctx2d(cv).putImageData(src, 0, 0);
    return cv;
  };

  const active = doc.activeLayer();
  switch (state.output) {
    case 'mask': {
      if (!active) break;
      doc.beginEdit(active);
      active.mask = maskCanvas();
      active.maskEnabled = true;
      active.maskVersion++;
      doc.selection.clear();
      doc.commit('Select and Mask');
      break;
    }
    case 'layer': {
      const l = new Layer({ type: LayerType.RASTER, name: 'Refined', canvas: cutPixels() });
      doc.addLayer(l, { above: doc.layers[0] });
      doc.selection.clear();
      doc.commit('Select and Mask');
      break;
    }
    case 'layer-mask': {
      const base = createRasterLayer(W, H, 'Refined');
      ctx2d(base.canvas).drawImage(getComposite(doc), 0, 0);
      base.mask = maskCanvas();
      base.maskEnabled = true;
      doc.addLayer(base, { above: doc.layers[0] });
      doc.selection.clear();
      doc.commit('Select and Mask');
      break;
    }
    case 'document': {
      // `fill`, not `background`: a white Background layer under the cut-out
      // would make the whole document opaque and throw away the matte.
      const next = app.newDocument({ width: W, height: H, name: `${doc.name} refined`, fill: 'transparent' });
      if (next) {
        const l = next.layers[0];
        ctx2d(l.canvas).drawImage(cutPixels(), 0, 0);
        l.thumbDirty = true;
        next.commit('Select and Mask');
      }
      break;
    }
    case 'selection':
    default: {
      doc.selection.set(new Uint8ClampedArray(mask));
      doc.commit('Select and Mask');
      break;
    }
  }
  doc.invalidate();
  doc.emit('structure');
}

/* ------------------------------------------------------------------ */
/* Contour tracing for the ants preview                                */
/* ------------------------------------------------------------------ */

/**
 * Trace the 50% contour of a mask as closed loops.
 *
 * `Selection` already does this properly (`contourLoops`), but it works from a
 * live Selection object and this preview has a bare array, so the boundary-edge
 * walk is repeated here rather than a throwaway Selection being constructed on
 * every frame.
 */
function contourFromMask(mask, w, h) {
  const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] > 127;
  const segs = new Map();
  const key = (x, y) => `${x},${y}`;
  const add = (ax, ay, bx, by) => {
    const k = key(ax, ay);
    if (!segs.has(k)) segs.set(k, []);
    segs.get(k).push({ x: bx, y: by });
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!on(x, y)) continue;
      if (!on(x, y - 1)) add(x, y, x + 1, y);
      if (!on(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!on(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!on(x - 1, y)) add(x, y + 1, x, y);
    }
  }
  const loops = [];
  while (segs.size) {
    const startKey = segs.keys().next().value;
    let [cx, cy] = startKey.split(',').map(Number);
    const loop = [{ x: cx, y: cy }];
    for (;;) {
      const k = key(cx, cy);
      const outs = segs.get(k);
      if (!outs || !outs.length) break;
      const next = outs.pop();
      if (!outs.length) segs.delete(k);
      cx = next.x; cy = next.y;
      if (cx === loop[0].x && cy === loop[0].y) break;
      loop.push({ x: cx, y: cy });
    }
    if (loop.length > 2) loops.push(loop);
  }
  return loops;
}
