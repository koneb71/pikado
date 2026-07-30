import { app } from '../core/app.js';
import { createCanvas, uid } from '../core/util.js';
import { toCss, toHex } from '../core/color.js';
import { BLEND_MODES, isNativeBlend, gcoFor, blendCPU } from '../core/blend.js';
import { morph } from '../core/selection.js';
import { compositeDocument, setLayerPreview } from '../render/compositor.js';
import { getPatterns as builtinPatterns } from '../paint/patterns.js';
import { Layer, LayerType } from '../core/layer.js';
import { paramDialog, promptDialog } from '../ui/dialog.js';

/**
 * Edit > Fill, Edit > Stroke, Edit > Define Pattern and Content-Aware Fill.
 *
 * Everything here builds a *paint* canvas (the colour/pattern/inpainted pixels
 * limited to the region being filled) and then composites it onto the layer's
 * surface with a blend mode and opacity, so a Fill behaves exactly like
 * painting a solid stroke with those settings.
 */

const FILL_CONTENTS = [
  { value: 'foreground', label: 'Foreground Color' },
  { value: 'background', label: 'Background Color' },
  { value: 'color', label: 'Color...' },
  { value: 'content-aware', label: 'Content-Aware' },
  { value: 'pattern', label: 'Pattern' },
  { value: 'history', label: 'History' },
  { value: 'black', label: 'Black' },
  { value: 'gray50', label: '50% Gray' },
  { value: 'white', label: 'White' },
];

const BLEND_OPTIONS = BLEND_MODES.map((m) => ({ value: m.id, label: m.name }));

/* ------------------------------------------------------------------ */
/* Pattern library                                                     */
/* ------------------------------------------------------------------ */

/** Patterns the user defined this session, newest first. */
function customPatterns() {
  if (!app.patterns) app.patterns = [];
  return app.patterns;
}

/**
 * Every pattern Fill and the fill layers can use: the ones defined with
 * Edit > Define Pattern first, then the built-in library.
 * @returns {{id:string,name:string,canvas:HTMLCanvasElement}[]}
 */
export function getPatterns() {
  return [...customPatterns(), ...builtinPatterns()];
}

/**
 * Edit > Define Pattern — stores the selected rectangle (or the whole layer)
 * as a tileable pattern usable by Fill and the Pattern Stamp.
 */
export async function definePattern(doc) {
  if (!doc) return null;
  const layer = doc.activeLayer();
  const src = layer && layer.canvas ? layer.canvas : compositeDocument(doc);
  const b = doc.selection.active ? doc.selection.bounds() : { x: 0, y: 0, width: doc.width, height: doc.height };
  if (!b || b.width < 1 || b.height < 1) {
    app.toast('Select a rectangle to define a pattern from.');
    return null;
  }
  const tile = createCanvas(b.width, b.height);
  tile.getContext('2d').drawImage(src, -b.x, -b.y);

  const fallback = `Pattern ${customPatterns().length + 1}`;
  const name = await promptDialog('Pattern name', fallback, 'Pattern Name');
  if (name == null) return null;
  const entry = { id: uid('pat'), name: name.trim() || fallback, canvas: tile };
  customPatterns().unshift(entry);
  app.emit('patterns-change', entry);
  app.toast(`Defined pattern "${entry.name}" (${b.width} × ${b.height})`, 'ok');
  return entry;
}

/* ------------------------------------------------------------------ */
/* Surfaces and compositing                                            */
/* ------------------------------------------------------------------ */

/** The canvas a fill/stroke should modify on this layer. */
function targetSurface(doc, layer) {
  if (!layer) return null;
  if (layer.editingMask && layer.mask) return { canvas: layer.mask, isMask: true };
  if (!layer.canvas) return null;
  return { canvas: layer.canvas, isMask: false };
}

function canEdit(doc, layer) {
  if (!layer) {
    app.toast('No layer selected.');
    return false;
  }
  if (layer.locked.all || layer.locked.pixels) {
    app.toast(`Layer "${layer.name}" is locked.`);
    return false;
  }
  if (!targetSurface(doc, layer)) {
    app.toast('This layer has no pixels to fill. Rasterize it first.');
    return false;
  }
  return true;
}

/** Composite `paint` onto a copy of `src`, honouring blend mode and opacity. */
function paintOnto(src, paint, { blendMode = 'normal', opacity = 1, preserveTransparency = false }) {
  const out = createCanvas(src.width, src.height);
  const c = out.getContext('2d');
  c.drawImage(src, 0, 0);
  if (opacity <= 0) return out;

  let top = paint;
  if (preserveTransparency) {
    top = createCanvas(src.width, src.height);
    const tc = top.getContext('2d');
    tc.drawImage(paint, 0, 0);
    tc.globalCompositeOperation = 'destination-in';
    tc.drawImage(src, 0, 0);
    tc.globalCompositeOperation = 'source-over';
  }

  if (isNativeBlend(blendMode)) {
    c.save();
    c.globalAlpha = opacity;
    c.globalCompositeOperation = gcoFor(blendMode);
    c.drawImage(top, 0, 0);
    c.restore();
    return out;
  }
  const base = c.getImageData(0, 0, out.width, out.height);
  const topData = top.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, out.width, out.height);
  blendCPU(base, topData, blendMode, opacity);
  c.putImageData(base, 0, 0);
  return out;
}

/** Alpha-only canvas from a coverage mask. */
function maskToAlpha(mask, w, h) {
  const img = new ImageData(w, h);
  const d = img.data;
  for (let p = 0, i = 3; p < w * h; p++, i += 4) d[i] = mask[p];
  const cv = createCanvas(w, h);
  cv.getContext('2d').putImageData(img, 0, 0);
  return cv;
}

/** Clip a full-size paint canvas to the active selection. */
function clipToSelection(doc, paint) {
  if (!doc.selection.active) return paint;
  const out = createCanvas(paint.width, paint.height);
  const c = out.getContext('2d');
  c.drawImage(paint, 0, 0);
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(doc.selection.toAlphaCanvas(), 0, 0);
  return out;
}

/* ------------------------------------------------------------------ */
/* Fill content sources                                                */
/* ------------------------------------------------------------------ */

function solidCanvas(doc, css) {
  const cv = createCanvas(doc.width, doc.height);
  const c = cv.getContext('2d');
  c.fillStyle = css;
  c.fillRect(0, 0, doc.width, doc.height);
  return cv;
}

function patternCanvas(doc, patternId, scale = 1) {
  const list = getPatterns();
  const entry = list.find((p) => p.id === patternId) || list[0];
  if (!entry) return null;
  let tile = entry.canvas;
  if (scale !== 1) {
    const t = createCanvas(Math.max(1, tile.width * scale), Math.max(1, tile.height * scale));
    const tc = t.getContext('2d');
    tc.imageSmoothingQuality = 'high';
    tc.drawImage(tile, 0, 0, t.width, t.height);
    tile = t;
  }
  const cv = createCanvas(doc.width, doc.height);
  const c = cv.getContext('2d');
  const pat = c.createPattern(tile, 'repeat');
  if (!pat) return null;
  c.fillStyle = pat;
  c.fillRect(0, 0, doc.width, doc.height);
  return cv;
}

/** Pixels of the active layer as they were in the document's first history state. */
function historyCanvas(doc, layer) {
  const first = doc.history.states[0];
  if (!first) return null;
  const find = (list) => {
    for (const s of list || []) {
      if (s.id === layer.id) return s;
      if (s.children) {
        const f = find(s.children);
        if (f) return f;
      }
    }
    return null;
  };
  const snap = find(first.state.layers);
  if (!snap || !snap.canvas) return null;
  const cv = createCanvas(doc.width, doc.height);
  cv.getContext('2d').drawImage(snap.canvas, 0, 0);
  return cv;
}

/**
 * Build the paint canvas for a fill.
 * @returns {HTMLCanvasElement|null}
 */
function buildFillPaint(doc, layer, opts) {
  switch (opts.use) {
    case 'foreground': return solidCanvas(doc, toCss(app.foreground));
    case 'background': return solidCanvas(doc, toCss(app.background));
    case 'color': return solidCanvas(doc, opts.color || '#000000');
    case 'black': return solidCanvas(doc, '#000000');
    case 'white': return solidCanvas(doc, '#ffffff');
    case 'gray50': return solidCanvas(doc, '#808080');
    case 'pattern': return patternCanvas(doc, opts.pattern, opts.patternScale || 1);
    case 'history': return historyCanvas(doc, layer);
    default: return null;
  }
}

/* ------------------------------------------------------------------ */
/* Fill                                                                */
/* ------------------------------------------------------------------ */

/**
 * Fill the active selection (or the whole layer) on the active layer.
 * @param {object} doc
 * @param {{use:string,color?:string,pattern?:string,patternScale?:number,
 *          blendMode?:string,opacity?:number,preserveTransparency?:boolean}} opts
 */
export function fillSelection(doc, opts = {}) {
  if (!doc) return false;
  const layer = doc.activeLayer();
  if (!canEdit(doc, layer)) return false;
  if (opts.use === 'content-aware') return contentAwareFill(doc, opts);

  const surf = targetSurface(doc, layer);
  const paint = buildFillPaint(doc, layer, opts);
  if (!paint) {
    app.toast(opts.use === 'pattern' ? 'That pattern is no longer available.' : 'Nothing to fill with.');
    return false;
  }
  const out = paintOnto(surf.canvas, clipToSelection(doc, paint), {
    blendMode: opts.blendMode || 'normal',
    opacity: opts.opacity == null ? 1 : opts.opacity,
    preserveTransparency: !!opts.preserveTransparency || (!surf.isMask && layer.locked.transparency),
  });

  doc.beginEdit(layer);
  if (surf.isMask) {
    layer.mask = out;
    layer.touchMask();
  } else {
    layer.canvas = out;
  }
  doc.commit('Fill');
  return true;
}

/** Live-preview version used by the Fill dialog. */
function previewFill(doc, layer, opts) {
  const surf = targetSurface(doc, layer);
  if (!surf || surf.isMask) return null;
  if (opts.use === 'content-aware') return null;
  const paint = buildFillPaint(doc, layer, opts);
  if (!paint) return null;
  return paintOnto(surf.canvas, clipToSelection(doc, paint), {
    blendMode: opts.blendMode || 'normal',
    opacity: opts.opacity == null ? 1 : opts.opacity,
    preserveTransparency: !!opts.preserveTransparency || layer.locked.transparency,
  });
}

/** Edit > Fill… */
export async function showFillDialog(doc) {
  if (!doc) return;
  const layer = doc.activeLayer();
  if (!canEdit(doc, layer)) return;

  const patterns = getPatterns();
  const state = {
    use: 'foreground',
    color: toHex(app.foreground),
    pattern: patterns.length ? patterns[0].id : '',
    patternScale: 1,
    blendMode: 'normal',
    opacity: 100,
    preserveTransparency: false,
  };

  const toOpts = (s) => ({
    use: s.use,
    color: s.color,
    pattern: s.pattern,
    patternScale: s.patternScale,
    blendMode: s.blendMode,
    opacity: s.opacity / 100,
    preserveTransparency: s.preserveTransparency,
  });

  const result = await paramDialog({
    title: 'Fill',
    width: 380,
    state,
    params: [
      { key: 'use', label: 'Contents', type: 'select', options: FILL_CONTENTS },
      { key: 'color', label: 'Color', type: 'color', when: (s) => s.use === 'color' },
      {
        key: 'pattern', label: 'Pattern', type: 'select',
        options: patterns.length ? patterns.map((p) => ({ value: p.id, label: p.name })) : [{ value: '', label: 'None defined' }],
        when: (s) => s.use === 'pattern',
      },
      { key: 'patternScale', label: 'Pattern Scale', type: 'slider', min: 0.1, max: 4, step: 0.1, when: (s) => s.use === 'pattern' },
      { type: 'separator' },
      { key: 'blendMode', label: 'Blending Mode', type: 'select', options: BLEND_OPTIONS },
      { key: 'opacity', label: 'Opacity', type: 'slider', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'preserveTransparency', label: 'Preserve Transparency', type: 'checkbox' },
    ],
    onPreview: (s) => {
      if (!s) {
        setLayerPreview(layer.id, null);
        doc.touch('preview');
        return;
      }
      setLayerPreview(layer.id, previewFill(doc, layer, toOpts(s)));
      doc.touch('preview');
    },
  });

  setLayerPreview(layer.id, null);
  doc.touch('preview');
  if (!result) return;
  await app.busy('Fill', async () => fillSelection(doc, toOpts(result)));
}

/* ------------------------------------------------------------------ */
/* Stroke                                                              */
/* ------------------------------------------------------------------ */

function fullMask(w, h) {
  return new Uint8ClampedArray(w * h).fill(255);
}

/** Ring of `width` px along the selection edge. */
function strokeMask(mask, w, h, width, location) {
  let outer, inner;
  if (location === 'inside') {
    outer = mask;
    inner = morph(mask, w, h, width, false);
  } else if (location === 'outside') {
    outer = morph(mask, w, h, width, true);
    inner = mask;
  } else {
    outer = morph(mask, w, h, Math.ceil(width / 2), true);
    inner = morph(mask, w, h, Math.floor(width / 2), false);
  }
  const out = new Uint8ClampedArray(w * h);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, outer[i] - inner[i]);
  return out;
}

function buildStrokePaint(doc, opts) {
  const w = doc.width, h = doc.height;
  const base = doc.selection.active ? doc.selection.mask : fullMask(w, h);
  const ring = strokeMask(base, w, h, Math.max(1, Math.round(opts.width || 1)), opts.location || 'inside');
  const paint = solidCanvas(doc, opts.color || toCss(app.foreground));
  const c = paint.getContext('2d');
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(maskToAlpha(ring, w, h), 0, 0);
  c.globalCompositeOperation = 'source-over';
  return paint;
}

/**
 * Stroke the active selection edge (or the canvas edge when nothing is
 * selected) with a solid colour.
 */
export function strokeSelection(doc, opts = {}) {
  if (!doc) return false;
  const layer = doc.activeLayer();
  if (!canEdit(doc, layer)) return false;
  const surf = targetSurface(doc, layer);
  const paint = buildStrokePaint(doc, opts);
  const out = paintOnto(surf.canvas, paint, {
    blendMode: opts.blendMode || 'normal',
    opacity: opts.opacity == null ? 1 : opts.opacity,
    preserveTransparency: !!opts.preserveTransparency || (!surf.isMask && layer.locked.transparency),
  });
  doc.beginEdit(layer);
  if (surf.isMask) {
    layer.mask = out;
    layer.touchMask();
  } else {
    layer.canvas = out;
  }
  doc.commit('Stroke');
  return true;
}

/** Edit > Stroke… */
export async function showStrokeDialog(doc) {
  if (!doc) return;
  const layer = doc.activeLayer();
  if (!canEdit(doc, layer)) return;

  const state = {
    width: 3,
    color: toHex(app.foreground),
    location: 'inside',
    blendMode: 'normal',
    opacity: 100,
    preserveTransparency: false,
  };
  const toOpts = (s) => ({
    width: s.width,
    color: s.color,
    location: s.location,
    blendMode: s.blendMode,
    opacity: s.opacity / 100,
    preserveTransparency: s.preserveTransparency,
  });

  const result = await paramDialog({
    title: 'Stroke',
    width: 380,
    state,
    params: [
      { key: 'width', label: 'Width', type: 'slider', min: 1, max: 250, step: 1, unit: 'px' },
      { key: 'color', label: 'Color', type: 'color' },
      {
        key: 'location', label: 'Location', type: 'radio',
        options: [{ value: 'inside', label: 'Inside' }, { value: 'center', label: 'Center' }, { value: 'outside', label: 'Outside' }],
      },
      { type: 'separator' },
      { key: 'blendMode', label: 'Blending Mode', type: 'select', options: BLEND_OPTIONS },
      { key: 'opacity', label: 'Opacity', type: 'slider', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'preserveTransparency', label: 'Preserve Transparency', type: 'checkbox' },
    ],
    onPreview: (s) => {
      if (!s) {
        setLayerPreview(layer.id, null);
        doc.touch('preview');
        return;
      }
      const surf = targetSurface(doc, layer);
      if (surf && !surf.isMask) {
        const o = toOpts(s);
        setLayerPreview(layer.id, paintOnto(surf.canvas, buildStrokePaint(doc, o), {
          blendMode: o.blendMode,
          opacity: o.opacity,
          preserveTransparency: o.preserveTransparency || layer.locked.transparency,
        }));
      }
      doc.touch('preview');
    },
  });

  setLayerPreview(layer.id, null);
  doc.touch('preview');
  if (!result) return;
  await app.busy('Stroke', async () => strokeSelection(doc, toOpts(result)));
}

/* ------------------------------------------------------------------ */
/* Content-Aware Fill                                                  */
/* ------------------------------------------------------------------ */

const PATCH_R = 2;              // 5×5 comparison patch
const RANDOM_TRIES = 26;        // random exemplar probes per pixel
const MAX_HOLE_PIXELS = 90000;  // beyond this the fill runs at reduced scale

/**
 * Exemplar-based inpainting.
 *
 * Unknown pixels are filled outside-in (onion peel). For each one we score a
 * handful of candidate source pixels — the matches our already-filled
 * neighbours used, shifted by the same offset, plus random probes over the
 * known area — by the SSD of their 5×5 patch against the known part of the
 * target patch, and copy the best candidate's colour. That transplants real
 * texture instead of smearing an average, so the selected content disappears.
 *
 * @param {Uint8ClampedArray} data RGBA pixels, mutated in place
 * @param {number} w
 * @param {number} h
 * @param {Uint8Array} hole 1 where pixels must be regenerated
 */
function inpaint(data, w, h, hole) {
  const n = w * h;
  const known = new Uint8Array(n);
  let knownCount = 0;
  for (let i = 0; i < n; i++) {
    if (!hole[i] && data[i * 4 + 3] > 8) {
      known[i] = 1;
      knownCount++;
    }
  }
  if (!knownCount) return;

  // --- source pool: known pixels whose whole patch is known ---------------
  const pool = [];
  for (let y = PATCH_R; y < h - PATCH_R; y++) {
    for (let x = PATCH_R; x < w - PATCH_R; x++) {
      const i = y * w + x;
      if (!known[i]) continue;
      let ok = true;
      for (let dy = -PATCH_R; dy <= PATCH_R && ok; dy++) {
        for (let dx = -PATCH_R; dx <= PATCH_R; dx++) {
          if (!known[i + dy * w + dx]) { ok = false; break; }
        }
      }
      if (ok) pool.push(i);
    }
  }
  if (!pool.length) {
    for (let i = 0; i < n; i++) if (known[i]) pool.push(i);
  }

  // --- fill order: BFS outward from the hole boundary ---------------------
  const order = [];
  const queued = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!hole[i]) continue;
      const edge =
        (x > 0 && known[i - 1]) || (x < w - 1 && known[i + 1]) ||
        (y > 0 && known[i - w]) || (y < h - 1 && known[i + w]);
      if (edge) { order.push(i); queued[i] = 1; }
    }
  }
  if (!order.length) {
    for (let i = 0; i < n; i++) if (hole[i] && !queued[i]) { order.push(i); queued[i] = 1; break; }
  }
  for (let head = 0; head < order.length; head++) {
    const i = order[head];
    const x = i % w, y = (i / w) | 0;
    if (x > 0 && hole[i - 1] && !queued[i - 1]) { queued[i - 1] = 1; order.push(i - 1); }
    if (x < w - 1 && hole[i + 1] && !queued[i + 1]) { queued[i + 1] = 1; order.push(i + 1); }
    if (y > 0 && hole[i - w] && !queued[i - w]) { queued[i - w] = 1; order.push(i - w); }
    if (y < h - 1 && hole[i + w] && !queued[i + w]) { queued[i + w] = 1; order.push(i + w); }
  }
  // Anything unreachable (fully enclosed islands) still needs a turn.
  for (let i = 0; i < n; i++) if (hole[i] && !queued[i]) { queued[i] = 1; order.push(i); }

  const src = new Int32Array(n).fill(-1);
  const filled = new Uint8Array(n);
  const valid = (i) => known[i] || filled[i];

  /** SSD of the patch around `ti` against the patch around `si`. */
  const score = (tx, ty, sx, sy, best) => {
    let sum = 0, count = 0;
    for (let dy = -PATCH_R; dy <= PATCH_R; dy++) {
      const tyy = ty + dy, syy = sy + dy;
      if (tyy < 0 || tyy >= h || syy < 0 || syy >= h) continue;
      for (let dx = -PATCH_R; dx <= PATCH_R; dx++) {
        const txx = tx + dx, sxx = sx + dx;
        if (txx < 0 || txx >= w || sxx < 0 || sxx >= w) continue;
        const ti = tyy * w + txx;
        if (!valid(ti)) continue;
        const si = syy * w + sxx;
        if (!known[si]) continue;
        const a = ti * 4, b = si * 4;
        const dr = data[a] - data[b];
        const dg = data[a + 1] - data[b + 1];
        const db = data[a + 2] - data[b + 2];
        const da = data[a + 3] - data[b + 3];
        sum += dr * dr + dg * dg + db * db + da * da;
        count++;
        if (sum > best * (count || 1)) return Infinity;
      }
    }
    if (!count) return Infinity;
    return sum / count;
  };

  for (let k = 0; k < order.length; k++) {
    const t = order[k];
    const tx = t % w, ty = (t / w) | 0;
    let bestScore = Infinity;
    let bestSrc = -1;

    const test = (si) => {
      if (si < 0 || si >= n || !known[si]) return;
      const sx = si % w, sy = (si / w) | 0;
      const s = score(tx, ty, sx, sy, bestScore);
      if (s < bestScore) { bestScore = s; bestSrc = si; }
    };

    // Propagate the neighbours' matches — this is what makes the texture
    // continue coherently instead of turning into noise.
    if (tx > 0 && src[t - 1] >= 0) test(src[t - 1] + 1);
    if (tx < w - 1 && src[t + 1] >= 0) test(src[t + 1] - 1);
    if (ty > 0 && src[t - w] >= 0) test(src[t - w] + w);
    if (ty < h - 1 && src[t + w] >= 0) test(src[t + w] - w);

    for (let r = 0; r < RANDOM_TRIES; r++) {
      test(pool[(Math.random() * pool.length) | 0]);
    }

    if (bestSrc < 0) bestSrc = pool[(Math.random() * pool.length) | 0];
    const a = t * 4, b = bestSrc * 4;
    data[a] = data[b];
    data[a + 1] = data[b + 1];
    data[a + 2] = data[b + 2];
    data[a + 3] = data[b + 3];
    src[t] = bestSrc;
    filled[t] = 1;
  }

  smoothSeams(data, w, h, hole, src);
}

/** Light averaging only where two neighbouring pixels came from far-apart sources. */
function smoothSeams(data, w, h, hole, src) {
  const copy = new Uint8ClampedArray(data);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!hole[i] || src[i] < 0) continue;
      const s = src[i];
      let seam = false;
      for (const d of [-1, 1, -w, w]) {
        const q = src[i + d];
        if (q < 0) continue;
        const dx = (q % w) - (s % w) - (d === -1 ? -1 : d === 1 ? 1 : 0);
        const dy = ((q / w) | 0) - ((s / w) | 0) - (d === -w ? -1 : d === w ? 1 : 0);
        if (Math.abs(dx) + Math.abs(dy) > 1) { seam = true; break; }
      }
      if (!seam) continue;
      for (let k = 0; k < 4; k++) {
        const avg = (copy[(i - 1) * 4 + k] + copy[(i + 1) * 4 + k] + copy[(i - w) * 4 + k] + copy[(i + w) * 4 + k] + copy[i * 4 + k] * 2) / 6;
        data[i * 4 + k] = copy[i * 4 + k] * 0.45 + avg * 0.55;
      }
    }
  }
}

/** Build the 1/0 hole mask for the selection, plus its padded working rect. */
function holeRect(doc) {
  const b = doc.selection.bounds();
  if (!b) return null;
  const pad = Math.max(24, Math.round(Math.max(b.width, b.height) * 0.35));
  const x = Math.max(0, b.x - pad);
  const y = Math.max(0, b.y - pad);
  const x2 = Math.min(doc.width, b.x + b.width + pad);
  const y2 = Math.min(doc.height, b.y + b.height + pad);
  return { x, y, width: x2 - x, height: y2 - y };
}

/**
 * Edit > Content-Aware Fill. Regenerates the selected pixels from the
 * surrounding image so the selected content is genuinely removed.
 *
 * @param {object} doc
 * @param {{sampleAllLayers?:boolean, output?:'current'|'new-layer'}} [opts]
 */
export function contentAwareFill(doc, opts = {}) {
  if (!doc) return false;
  const layer = doc.activeLayer();
  if (!canEdit(doc, layer)) return false;
  if (!doc.selection.active) {
    app.toast('Select the area to remove first.');
    return false;
  }
  const rect = holeRect(doc);
  if (!rect || rect.width < 3 || rect.height < 3) {
    app.toast('The selection is too small to fill.');
    return false;
  }

  const source = opts.sampleAllLayers ? compositeDocument(doc) : layer.canvas;
  if (!source) {
    app.toast('This layer has no pixels to sample.');
    return false;
  }

  // Work on the padded rectangle only.
  const work = createCanvas(rect.width, rect.height);
  work.getContext('2d').drawImage(source, -rect.x, -rect.y);

  const selMask = doc.selection.mask;
  let holeCount = 0;
  const hole = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) {
    const srow = (y + rect.y) * doc.width + rect.x;
    const drow = y * rect.width;
    for (let x = 0; x < rect.width; x++) {
      if (selMask[srow + x] > 127) { hole[drow + x] = 1; holeCount++; }
    }
  }
  if (!holeCount) {
    app.toast('The selection is empty.');
    return false;
  }

  let filled;
  if (holeCount > MAX_HOLE_PIXELS) {
    // Large areas are synthesised at reduced resolution and scaled back up;
    // the surrounding detail still drives the result.
    const f = Math.max(0.2, Math.sqrt(MAX_HOLE_PIXELS / holeCount));
    const sw = Math.max(8, Math.round(rect.width * f));
    const sh = Math.max(8, Math.round(rect.height * f));
    const small = createCanvas(sw, sh);
    const sc = small.getContext('2d', { willReadFrequently: true });
    sc.imageSmoothingQuality = 'high';
    sc.drawImage(work, 0, 0, sw, sh);
    const simg = sc.getImageData(0, 0, sw, sh);
    const shole = new Uint8Array(sw * sh);
    for (let y = 0; y < sh; y++) {
      const sy = Math.min(rect.height - 1, Math.floor((y + 0.5) / f));
      for (let x = 0; x < sw; x++) {
        const sx = Math.min(rect.width - 1, Math.floor((x + 0.5) / f));
        shole[y * sw + x] = hole[sy * rect.width + sx];
      }
    }
    inpaint(simg.data, sw, sh, shole);
    sc.putImageData(simg, 0, 0);
    filled = createCanvas(rect.width, rect.height);
    const fc = filled.getContext('2d');
    fc.imageSmoothingQuality = 'high';
    fc.drawImage(small, 0, 0, rect.width, rect.height);
  } else {
    const wc = work.getContext('2d', { willReadFrequently: true });
    const img = wc.getImageData(0, 0, rect.width, rect.height);
    inpaint(img.data, rect.width, rect.height, hole);
    wc.putImageData(img, 0, 0);
    filled = work;
  }

  // Keep only the selected pixels of the synthesised result.
  const patch = createCanvas(doc.width, doc.height);
  const pc = patch.getContext('2d');
  pc.drawImage(filled, rect.x, rect.y);
  pc.globalCompositeOperation = 'destination-in';
  pc.drawImage(doc.selection.toAlphaCanvas(), 0, 0);
  pc.globalCompositeOperation = 'source-over';

  if (opts.output === 'new-layer') {
    const nl = new Layer({ type: LayerType.RASTER, name: 'Content-Aware Fill', canvas: patch });
    doc.addLayer(nl);
    doc.commit('Content-Aware Fill');
    return true;
  }

  doc.beginEdit(layer);
  const out = createCanvas(doc.width, doc.height);
  const oc = out.getContext('2d');
  oc.drawImage(layer.canvas, 0, 0);
  // Remove the old pixels first so semi-transparent selections do not double up.
  oc.globalCompositeOperation = 'destination-out';
  oc.drawImage(doc.selection.toAlphaCanvas(), 0, 0);
  oc.globalCompositeOperation = 'source-over';
  oc.drawImage(patch, 0, 0);
  layer.canvas = out;
  doc.commit('Content-Aware Fill');
  return true;
}

/** Edit > Content-Aware Fill… with its options dialog. */
export async function showContentAwareFillDialog(doc) {
  if (!doc) return;
  if (!doc.selection.active) {
    app.toast('Select the area to remove first.');
    return;
  }
  const result = await paramDialog({
    title: 'Content-Aware Fill',
    width: 380,
    preview: false,
    state: { sampleAllLayers: false, output: 'current' },
    params: [
      { key: 'sampleAllLayers', label: 'Sample All Layers', type: 'checkbox' },
      {
        key: 'output', label: 'Output To', type: 'select',
        options: [{ value: 'current', label: 'Current Layer' }, { value: 'new-layer', label: 'New Layer' }],
      },
      { type: 'label', label: 'The selected pixels are re-synthesised from the surrounding image.' },
    ],
  });
  if (!result) return;
  await app.busy('Content-Aware Fill', async () => contentAwareFill(doc, result));
}
