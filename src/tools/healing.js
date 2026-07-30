import { Tool, registerTool } from './base.js';
import { app } from '../core/app.js';
import { EffectStroke, brushOptionDescriptors, brushFromOptions } from '../paint/brush-engine.js';
import { createCanvas, cloneCanvas, ctx2dRead, clamp, clamp255 } from '../core/util.js';
import { Selection, morph } from '../core/selection.js';
import { getComposite } from '../render/compositor.js';
import { BrushToolBase, tweakDefaults, blurImageData, brushContextMenu } from './brush.js';
import { makeTiledCanvas, patternOptions } from '../paint/patterns.js';
import { OVERLAY } from '../ui/brand.js';
import { cmd, sep } from '../ui/canvas-menu.js';

/**
 * Healing family: Spot Healing Brush, Healing Brush, Patch and Red Eye.
 *
 * The common trick in all of them is *low-frequency correction*: copied or
 * synthesised pixels carry the texture, but their overall colour and
 * brightness are pulled onto the destination so the repair disappears into its
 * surroundings.
 */

/* ================================================================== */
/* Shared pixel maths                                                  */
/* ================================================================== */

/** Premultiplied RGBA float copy of an ImageData. */
function toPremul(img) {
  const d = img.data;
  const out = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    out[i] = d[i] * a;
    out[i + 1] = d[i + 1] * a;
    out[i + 2] = d[i + 2] * a;
    out[i + 3] = d[i + 3];
  }
  return out;
}

/** Grids this small are solved directly instead of being coarsened again. */
const SOLVE_DIRECT_SIDE = 24;

/**
 * Gauss-Seidel relaxation of `hole` cells towards the mean of their four
 * neighbours. Everything outside the hole acts as a fixed boundary. The scan
 * direction alternates so information travels inward from every side.
 *
 * @param {Float32Array} buf `ch`-interleaved field, mutated in place
 */
function relax(buf, w, h, hole, ch, iterations) {
  const acc = new Float32Array(4);
  for (let it = 0; it < iterations; it++) {
    const forward = it % 2 === 0;
    for (let n = 0; n < w * h; n++) {
      const p = forward ? n : w * h - 1 - n;
      if (!hole[p]) continue;
      const x = p % w, y = (p - x) / w;
      let cnt = 0;
      for (let k = 0; k < ch; k++) acc[k] = 0;
      if (x > 0) { const q = (p - 1) * ch; for (let k = 0; k < ch; k++) acc[k] += buf[q + k]; cnt++; }
      if (x < w - 1) { const q = (p + 1) * ch; for (let k = 0; k < ch; k++) acc[k] += buf[q + k]; cnt++; }
      if (y > 0) { const q = (p - w) * ch; for (let k = 0; k < ch; k++) acc[k] += buf[q + k]; cnt++; }
      if (y < h - 1) { const q = (p + w) * ch; for (let k = 0; k < ch; k++) acc[k] += buf[q + k]; cnt++; }
      if (!cnt) continue;
      const i = p * ch;
      for (let k = 0; k < ch; k++) buf[i + k] = acc[k] / cnt;
    }
  }
}

/**
 * Laplace fill of `hole`, using everything outside it as fixed boundary values.
 *
 * Plain relaxation needs on the order of (hole diameter)² sweeps to converge,
 * so a big brush would either stall for seconds or leave a visibly flat patch.
 * This is a multigrid V-cycle instead: halve the grid, solve there, prolong the
 * answer back and smooth it. Cost is linear in the area and a 480×480 region
 * lands within a couple of tenths of a grey level of the exact solution.
 *
 * Hole cells must already hold a seed value (the caller's ring mean).
 *
 * @param {Float32Array} buf `ch`-interleaved field, mutated in place
 * @param {Uint8Array} hole 1 = unknown
 * @param {number} ch channels per cell (3 or 4)
 * @param {number} [sweeps] smoothing sweeps per level
 */
function laplaceFill(buf, w, h, hole, ch, sweeps = 4) {
  if (Math.max(w, h) <= SOLVE_DIRECT_SIDE) {
    relax(buf, w, h, hole, ch, 200);
    return;
  }

  const cw = Math.ceil(w / 2), chh = Math.ceil(h / 2);
  const coarse = new Float32Array(cw * chh * ch);
  const chole = new Uint8Array(cw * chh);
  const known = new Float32Array(4), all = new Float32Array(4);

  // Restrict. A coarse cell that keeps boundary status must average *only* its
  // known pixels — letting the hole seed leak into the boundary biases every
  // level above it and is the difference between a 0.3% and a 4% error.
  for (let cy = 0; cy < chh; cy++) {
    const yEnd = Math.min(h, cy * 2 + 2);
    for (let cx = 0; cx < cw; cx++) {
      const xEnd = Math.min(w, cx * 2 + 2);
      let n = 0, kn = 0;
      for (let k = 0; k < ch; k++) { known[k] = 0; all[k] = 0; }
      for (let y = cy * 2; y < yEnd; y++) {
        for (let x = cx * 2; x < xEnd; x++) {
          const p = y * w + x, q = p * ch;
          n++;
          for (let k = 0; k < ch; k++) all[k] += buf[q + k];
          if (!hole[p]) {
            kn++;
            for (let k = 0; k < ch; k++) known[k] += buf[q + k];
          }
        }
      }
      if (!n) continue;
      const cp = cy * cw + cx, cq = cp * ch;
      if (kn * 2 >= n) {
        chole[cp] = 0;
        for (let k = 0; k < ch; k++) coarse[cq + k] = known[k] / kn;
      } else {
        chole[cp] = 1;
        for (let k = 0; k < ch; k++) coarse[cq + k] = all[k] / n;
      }
    }
  }

  laplaceFill(coarse, cw, chh, chole, ch, sweeps);

  // Prolong. Coarse cell c is centred on fine index 2c + 0.5, hence the 0.25.
  for (let y = 0; y < h; y++) {
    const fy = y / 2 - 0.25;
    const y0 = clamp(Math.floor(fy), 0, chh - 1);
    const ty = clamp(fy - y0, 0, 1);
    const y1 = Math.min(chh - 1, y0 + 1);
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!hole[p]) continue;
      const fx = x / 2 - 0.25;
      const x0 = clamp(Math.floor(fx), 0, cw - 1);
      const tx = clamp(fx - x0, 0, 1);
      const x1 = Math.min(cw - 1, x0 + 1);
      const q00 = (y0 * cw + x0) * ch, q10 = (y0 * cw + x1) * ch;
      const q01 = (y1 * cw + x0) * ch, q11 = (y1 * cw + x1) * ch;
      const o = p * ch;
      for (let k = 0; k < ch; k++) {
        const a = coarse[q00 + k] + (coarse[q10 + k] - coarse[q00 + k]) * tx;
        const b = coarse[q01 + k] + (coarse[q11 + k] - coarse[q01 + k]) * tx;
        buf[o + k] = a + (b - a) * ty;
      }
    }
  }

  relax(buf, w, h, hole, ch, sweeps);
}

/** Smooth pseudo-random field, used to synthesise texture. */
function noiseField(w, h, cell, seed) {
  const gw = Math.ceil(w / cell) + 2, gh = Math.ceil(h / cell) + 2;
  const g = new Float32Array(gw * gh);
  let s = seed >>> 0;
  for (let i = 0; i < g.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    g[i] = s / 4294967296 - 0.5;
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = y / cell, jy = Math.floor(fy), ty = fy - jy;
    const sy = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < w; x++) {
      const fx = x / cell, jx = Math.floor(fx), tx = fx - jx;
      const sx = tx * tx * (3 - 2 * tx);
      const a = g[jy * gw + jx], b = g[jy * gw + jx + 1];
      const c = g[(jy + 1) * gw + jx], d = g[(jy + 1) * gw + jx + 1];
      const top = a + (b - a) * sx, bot = c + (d - c) * sx;
      out[y * w + x] = top + (bot - top) * sy;
    }
  }
  return out;
}

/* ================================================================== */
/* Spot Healing Brush                                                  */
/* ================================================================== */

/**
 * Repair the disc of radius `size/2` at the dab centre using the ring of
 * pixels immediately around it, then match the result to the ring's colour.
 */
function healSpot(region, meta, readCtx, surface, type) {
  const R = Math.max(1.5, meta.size / 2);
  const pad = clamp(Math.round(R * 0.6) + 2, 3, 40);
  const cx = meta.x, cy = meta.y;

  const ex0 = clamp(Math.floor(cx - R - pad), 0, surface.width);
  const ey0 = clamp(Math.floor(cy - R - pad), 0, surface.height);
  const ex1 = clamp(Math.ceil(cx + R + pad), 0, surface.width);
  const ey1 = clamp(Math.ceil(cy + R + pad), 0, surface.height);
  const ew = ex1 - ex0, eh = ey1 - ey0;
  if (ew < 5 || eh < 5) return;

  const src = readCtx.getImageData(ex0, ey0, ew, eh);
  const buf = toPremul(src);
  const hole = new Uint8Array(ew * eh);
  const ringIdx = [];
  let rr = 0, rg = 0, rb = 0, ra = 0;
  let vr = 0, vg = 0, vb = 0;

  for (let j = 0; j < eh; j++) {
    for (let i = 0; i < ew; i++) {
      const dx = ex0 + i + 0.5 - cx, dy = ey0 + j + 0.5 - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const p = j * ew + i;
      if (dist <= R) hole[p] = 1;
      else if (dist <= R + pad) {
        ringIdx.push(p);
        const q = p * 4;
        rr += buf[q]; rg += buf[q + 1]; rb += buf[q + 2]; ra += buf[q + 3];
      }
    }
  }
  const rn = ringIdx.length;
  if (!rn) return;
  rr /= rn; rg /= rn; rb /= rn; ra /= rn;
  for (const p of ringIdx) {
    const q = p * 4;
    vr += (buf[q] - rr) ** 2; vg += (buf[q + 1] - rg) ** 2; vb += (buf[q + 2] - rb) ** 2;
  }
  const sdR = Math.sqrt(vr / rn), sdG = Math.sqrt(vg / rn), sdB = Math.sqrt(vb / rn);

  // Mirror the ring inward: reflect each hole pixel across the hole boundary.
  const mirror = new Float32Array(ew * eh * 4);
  if (type !== 'texture') {
    for (let j = 0; j < eh; j++) {
      for (let i = 0; i < ew; i++) {
        const p = j * ew + i;
        if (!hole[p]) continue;
        const dx = ex0 + i + 0.5 - cx, dy = ey0 + j + 0.5 - cy;
        const dist = Math.max(0.001, Math.sqrt(dx * dx + dy * dy));
        const refl = clamp(2 * R - dist, R + 0.5, R + pad - 0.5);
        const mx = clamp(Math.round(cx + (dx / dist) * refl - ex0), 0, ew - 1);
        const my = clamp(Math.round(cy + (dy / dist) * refl - ey0), 0, eh - 1);
        const q = (my * ew + mx) * 4, o = p * 4;
        mirror[o] = buf[q]; mirror[o + 1] = buf[q + 1];
        mirror[o + 2] = buf[q + 2]; mirror[o + 3] = buf[q + 3];
      }
    }
  }

  // Smooth base: seed the hole with the ring mean, then diffuse inward.
  // Proximity Match replaces the hole outright, so it can skip the solve.
  for (let p = 0; p < ew * eh; p++) {
    if (!hole[p]) continue;
    const q = p * 4;
    buf[q] = rr; buf[q + 1] = rg; buf[q + 2] = rb; buf[q + 3] = ra;
  }
  if (type !== 'proximity') laplaceFill(buf, ew, eh, hole, 4);

  if (type === 'proximity') {
    // Straight mirrored copy — keeps every bit of the surrounding structure.
    for (let p = 0; p < ew * eh; p++) {
      if (!hole[p]) continue;
      const q = p * 4;
      buf[q] = mirror[q]; buf[q + 1] = mirror[q + 1];
      buf[q + 2] = mirror[q + 2]; buf[q + 3] = mirror[q + 3];
    }
  } else if (type === 'texture') {
    // Synthesise grain with the ring's own statistics.
    const n1 = noiseField(ew, eh, Math.max(2, R * 0.28), 0x9e37 ^ (ex0 * 31 + ey0));
    const n2 = noiseField(ew, eh, Math.max(1.5, R * 0.11), 0x51ed ^ (ex0 * 17 + ey0 * 7));
    for (let p = 0; p < ew * eh; p++) {
      if (!hole[p]) continue;
      const t = (n1[p] * 1.25 + n2[p] * 0.75) * 2;
      const q = p * 4;
      buf[q] += t * sdR;
      buf[q + 1] += t * sdG;
      buf[q + 2] += t * sdB;
    }
  } else {
    // Content-aware: structure from the mirror near the rim, fading into the
    // smooth diffusion toward the middle of the blemish.
    for (let j = 0; j < eh; j++) {
      for (let i = 0; i < ew; i++) {
        const p = j * ew + i;
        if (!hole[p]) continue;
        const dx = ex0 + i + 0.5 - cx, dy = ey0 + j + 0.5 - cy;
        const t = Math.pow(clamp(Math.sqrt(dx * dx + dy * dy) / R, 0, 1), 0.75);
        const q = p * 4;
        buf[q] += (mirror[q] - buf[q]) * t;
        buf[q + 1] += (mirror[q + 1] - buf[q + 1]) * t;
        buf[q + 2] += (mirror[q + 2] - buf[q + 2]) * t;
        buf[q + 3] += (mirror[q + 3] - buf[q + 3]) * t;
      }
    }
  }

  // Match the filled area's mean to the ring so the repair blends.
  let hr = 0, hg = 0, hb = 0, hn = 0;
  for (let p = 0; p < ew * eh; p++) {
    if (!hole[p]) continue;
    const q = p * 4;
    hr += buf[q]; hg += buf[q + 1]; hb += buf[q + 2];
    hn++;
  }
  if (hn) {
    const dr = rr - hr / hn, dg = rg - hg / hn, db = rb - hb / hn;
    for (let p = 0; p < ew * eh; p++) {
      if (!hole[p]) continue;
      const q = p * 4;
      buf[q] += dr; buf[q + 1] += dg; buf[q + 2] += db;
    }
  }

  // Write the healed disc back into the dab region.
  const d = region.data;
  for (let j = 0; j < region.height; j++) {
    const ey = meta.rectY + j - ey0;
    if (ey < 0 || ey >= eh) continue;
    for (let i = 0; i < region.width; i++) {
      const ex = meta.rectX + i - ex0;
      if (ex < 0 || ex >= ew) continue;
      const p = ey * ew + ex;
      if (!hole[p]) continue;
      const q = p * 4, o = (j * region.width + i) * 4;
      const a = clamp(buf[q + 3], 0, 255);
      const af = a / 255;
      d[o] = af > 0.002 ? clamp255(buf[q] / af) : 0;
      d[o + 1] = af > 0.002 ? clamp255(buf[q + 1] / af) : 0;
      d[o + 2] = af > 0.002 ? clamp255(buf[q + 2] / af) : 0;
      d[o + 3] = clamp255(a);
    }
  }
}

class SpotHealingTool extends BrushToolBase {
  constructor() {
    super({
      id: 'spot-healing', name: 'Spot Healing Brush Tool', icon: 'healing',
      cursor: 'crosshair', shortcut: 'J', group: 'healing', groupOrder: 6,
      strokeLabel: 'Spot Healing Brush',
      options: [
        ...tweakDefaults(brushOptionDescriptors({ opacity: false, flow: false, airbrush: false }), { size: 30, hardness: 100 }),
        { key: 'type', label: 'Type', type: 'radio', default: 'content-aware',
          options: [
            { value: 'content-aware', label: 'Content-Aware' },
            { value: 'texture', label: 'Create Texture' },
            { value: 'proximity', label: 'Proximity Match' },
          ] },
      ],
    });
  }

  makeStroke(e, doc, layer) {
    const target = layer.paintTarget();
    const readCtx = ctx2dRead(target);
    const type = this.state.type;
    return new EffectStroke({
      doc,
      layer,
      target,
      brush: brushFromOptions(this.state, { flow: 1, spacing: 0.3, pressureSize: false }),
      strength: 1,
      op: (region, meta) => {
        healSpot(region, meta, readCtx, target, type);
        return region;
      },
    });
  }
}

registerTool(new SpotHealingTool());

/* ================================================================== */
/* Healing Brush                                                       */
/* ================================================================== */

/** Alpha-weighted mean *straight* colour of the ring band around the dab. */
function ringMean(data, w, h, ox, oy, cx, cy, R, pad) {
  let r = 0, g = 0, b = 0, wsum = 0;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const dx = ox + i + 0.5 - cx, dy = oy + j + 0.5 - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= R || dist > R + pad) continue;
      const q = (j * w + i) * 4;
      const al = data[q + 3] / 255;
      if (al <= 0) continue;
      r += data[q] * al; g += data[q + 1] * al; b += data[q + 2] * al;
      wsum += al;
    }
  }
  if (wsum <= 0.001) return null;
  return { r: r / wsum, g: g / wsum, b: b / wsum };
}

class HealingBrushTool extends BrushToolBase {
  constructor() {
    super({
      id: 'healing-brush', name: 'Healing Brush Tool', icon: 'healing-brush',
      cursor: 'crosshair', shortcut: 'J', group: 'healing', groupOrder: 6,
      strokeLabel: 'Healing Brush',
      options: [
        ...tweakDefaults(brushOptionDescriptors({ opacity: false, flow: false, airbrush: false }), { size: 30, hardness: 100 }),
        { key: 'source', label: 'Source', type: 'radio', default: 'sampled',
          options: [
            { value: 'sampled', label: 'Sampled' },
            { value: 'pattern', label: 'Pattern' },
          ] },
        { key: 'pattern', label: 'Pattern', type: 'select', options: patternOptions(), default: 'grain',
          when: (s) => s.source === 'pattern' },
        { key: 'aligned', label: 'Aligned', type: 'checkbox', default: true },
        { key: 'sampleAllLayers', label: 'Sample All Layers', type: 'checkbox', default: false },
      ],
    });
    this.source = null;
    this.offset = null;
    this.livePoint = null;
  }

  onPointerDown(e) {
    if (e.button === 0 && e.altKey) {
      this.source = { x: e.x, y: e.y };
      this.offset = null;
      app.toast('Healing source set.', 'ok', 1200);
      app.requestRender();
      return;
    }
    super.onPointerDown(e);
  }

  beforeStroke(e) {
    if (this.state.source === 'pattern') return true;
    if (!this.source) {
      app.toast('Alt-click to define a healing source first.', 'warn');
      return false;
    }
    return true;
  }

  makeStroke(e, doc, layer) {
    const target = layer.paintTarget();
    const usePattern = this.state.source === 'pattern';
    let dx = 0, dy = 0;
    let sourceCanvas;

    if (usePattern) {
      sourceCanvas = makeTiledCanvas(this.state.pattern, doc.width, doc.height, 1);
    } else {
      if (!this.state.aligned || !this.offset) {
        this.offset = { dx: Math.round(this.source.x - e.x), dy: Math.round(this.source.y - e.y) };
      }
      dx = this.offset.dx;
      dy = this.offset.dy;
      sourceCanvas = this.state.sampleAllLayers && !layer.editingMask
        ? cloneCanvas(getComposite(doc))
        : cloneCanvas(target);
    }

    const dstCtx = ctx2dRead(target);

    return new EffectStroke({
      doc,
      layer,
      target,
      brush: brushFromOptions(this.state, { flow: 1, spacing: 0.2, pressureSize: false }),
      strength: 1,
      op: (region, meta) => {
        const R = Math.max(1.5, meta.size / 2);
        const pad = clamp(Math.round(R * 0.6) + 2, 3, 40);
        const cx = meta.x, cy = meta.y;
        const ex0 = clamp(Math.floor(cx - R - pad), 0, target.width);
        const ey0 = clamp(Math.floor(cy - R - pad), 0, target.height);
        const ex1 = clamp(Math.ceil(cx + R + pad), 0, target.width);
        const ey1 = clamp(Math.ceil(cy + R + pad), 0, target.height);
        const ew = ex1 - ex0, eh = ey1 - ey0;
        if (ew < 3 || eh < 3) return region;

        const dst = dstCtx.getImageData(ex0, ey0, ew, eh).data;
        // The source rectangle may hang off the canvas: stage it so the read
        // is always in range (out-of-canvas reads come back transparent).
        const stage = createCanvas(ew, eh);
        stage.getContext('2d').drawImage(sourceCanvas, -(ex0 + dx), -(ey0 + dy));
        const srcData = ctx2dRead(stage).getImageData(0, 0, ew, eh).data;

        const dm = ringMean(dst, ew, eh, ex0, ey0, cx, cy, R, pad);
        const sm = ringMean(srcData, ew, eh, ex0, ey0, cx, cy, R, pad);
        const cr = dm && sm ? dm.r - sm.r : 0;
        const cg = dm && sm ? dm.g - sm.g : 0;
        const cb = dm && sm ? dm.b - sm.b : 0;

        const d = region.data;
        for (let j = 0; j < region.height; j++) {
          const sy = meta.rectY + j - ey0;
          if (sy < 0 || sy >= eh) continue;
          for (let i = 0; i < region.width; i++) {
            const sx = meta.rectX + i - ex0;
            if (sx < 0 || sx >= ew) continue;
            const q = (sy * ew + sx) * 4, o = (j * region.width + i) * 4;
            if (srcData[q + 3] <= 0) continue;
            // Copied texture, shifted onto the destination's own colour.
            d[o] = clamp255(srcData[q] + cr);
            d[o + 1] = clamp255(srcData[q + 1] + cg);
            d[o + 2] = clamp255(srcData[q + 2] + cb);
            d[o + 3] = Math.max(d[o + 3], srcData[q + 3]);
          }
        }
        return region;
      },
    });
  }

  onPointerMove(e) {
    if (this.stroke && this.offset && this.state.source === 'sampled') {
      this.livePoint = { x: e.x + this.offset.dx, y: e.y + this.offset.dy };
    }
    super.onPointerMove(e);
  }

  onPointerUp() {
    this.livePoint = null;
    super.onPointerUp();
  }

  cancel() {
    this.livePoint = null;
    super.cancel();
  }

  contextMenu() {
    // In Pattern mode there is no sample point at all, so the row would be
    // meaningless — leave it out rather than showing a dead entry.
    const extra = this.state.source === 'pattern' ? [] : [{
      label: 'Reset Healing Source',
      disabled: !this.source,
      run: () => {
        this.source = null;
        this.offset = null;
        this.livePoint = null;
        app.toast('Healing source cleared.', 'info', 1200);
        app.requestRender();
      },
    }];
    return brushContextMenu(this, extra);
  }

  drawOverlay(ctx, view) {
    if (this.state.source === 'sampled') {
      if (this.livePoint) this.drawCrosshair(ctx, view, this.livePoint.x, this.livePoint.y, '#ffd166');
      else if (this.source) this.drawCrosshair(ctx, view, this.source.x, this.source.y);
    }
    this.drawBrushCursor(ctx, view);
  }
}

registerTool(new HealingBrushTool());

/* ================================================================== */
/* Patch                                                               */
/* ================================================================== */

function translateMask(mask, w, h, dx, dy) {
  const out = new Uint8ClampedArray(w * h);
  dx = Math.round(dx); dy = Math.round(dy);
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= w) continue;
      out[y * w + x] = mask[sy * w + sx];
    }
  }
  return out;
}

function maskBounds(mask, w, h) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (mask[row + x] > 4) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

class PatchTool extends Tool {
  constructor() {
    super({
      id: 'patch', name: 'Patch Tool', icon: 'patch', cursor: 'crosshair', shortcut: 'J',
      group: 'healing', groupOrder: 6,
      options: [
        { key: 'mode', label: 'Mode', type: 'radio', default: 'normal',
          options: [
            { value: 'normal', label: 'Normal' },
            { value: 'content-aware', label: 'Content-Aware' },
          ] },
        { key: 'patchSource', label: 'Patch', type: 'radio', default: 'source',
          options: [
            { value: 'source', label: 'Source' },
            { value: 'destination', label: 'Destination' },
          ] },
        { key: 'transparent', label: 'Transparent', type: 'checkbox', default: false,
          hint: 'Transfer texture only, keeping the destination colour' },
      ],
    });
    this.app = app;
    /** @type {{x:number,y:number}[]} */
    this.points = [];
    this.phase = 'idle'; // idle | drawing | ready | moving
    this.offset = { dx: 0, dy: 0 };
    this._dragStart = null;
  }

  onDeactivate() {
    this.cancel();
  }

  cancel() {
    if (this.phase === 'idle' && !this.points.length) return;
    this.points = [];
    this.phase = 'idle';
    this.offset = { dx: 0, dy: 0 };
    app.requestRender();
  }

  _pathOf(points, dx = 0, dy = 0) {
    const p = new Path2D();
    if (points.length < 2) return p;
    p.moveTo(points[0].x + dx, points[0].y + dy);
    for (let i = 1; i < points.length; i++) p.lineTo(points[i].x + dx, points[i].y + dy);
    p.closePath();
    return p;
  }

  _inside(x, y) {
    if (this.points.length < 3) return false;
    // Even-odd ray cast against the closed polygon.
    let hit = false;
    const pts = this.points;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-9) + xi) hit = !hit;
    }
    return hit;
  }

  onPointerDown(e) {
    if (e.button !== 0) return;
    if (!this.doc) return;
    if (this.phase === 'ready' && this._inside(e.x, e.y)) {
      this.phase = 'moving';
      this._dragStart = { x: e.x, y: e.y };
      this.offset = { dx: 0, dy: 0 };
      return;
    }
    this.phase = 'drawing';
    this.points = [{ x: e.x, y: e.y }];
    this.offset = { dx: 0, dy: 0 };
    app.requestRender();
  }

  onPointerMove(e) {
    if (this.phase === 'drawing') {
      const last = this.points[this.points.length - 1];
      if (Math.hypot(e.x - last.x, e.y - last.y) >= 1.5) {
        this.points.push({ x: e.x, y: e.y });
        app.requestRender();
      }
      return;
    }
    if (this.phase === 'moving') {
      this.offset = { dx: e.x - this._dragStart.x, dy: e.y - this._dragStart.y };
      app.requestRender();
    }
  }

  onPointerUp() {
    if (this.phase === 'drawing') {
      this.phase = this.points.length >= 3 ? 'ready' : 'idle';
      if (this.phase === 'idle') this.points = [];
      app.requestRender();
      return;
    }
    if (this.phase === 'moving') {
      const off = this.offset;
      this.phase = 'ready';
      if (Math.abs(off.dx) >= 1 || Math.abs(off.dy) >= 1) this._apply(off);
      this.offset = { dx: 0, dy: 0 };
      app.requestRender();
    }
  }

  onDoubleClick() {
    this.cancel();
  }

  contextMenu() {
    const s = this.state;
    const pick = (key, value, label) => ({
      label,
      checked: s[key] === value,
      run: () => this.setOption(key, value),
    });
    const items = [];
    if (this.points.length) {
      items.push({ label: 'Discard Patch Area', accel: 'Esc', run: () => this.cancel() });
      items.push(sep());
    }
    items.push({ header: 'Patch' });
    items.push(pick('mode', 'normal', 'Normal'));
    items.push(pick('mode', 'content-aware', 'Content-Aware'));
    items.push({
      label: 'Transparent',
      checked: !!s.transparent,
      run: () => this.setOption('transparent', !s.transparent),
    });
    items.push({ header: 'Patch From' });
    items.push(pick('patchSource', 'source', 'Source'));
    items.push(pick('patchSource', 'destination', 'Destination'));
    items.push(sep());
    items.push(cmd('edit.undo'));
    return items;
  }

  onKeyDown(e) {
    if (e.key === 'Escape' && this.points.length) {
      this.cancel();
      return true;
    }
    return false;
  }

  /** Heal the destination region using the pixels the patch was dragged onto. */
  _apply(offset) {
    if (!this.canPaint()) return;
    const doc = this.doc;
    const layer = doc.activeLayer();
    const w = doc.width, h = doc.height;

    const base = Selection.rasterizePath(this._pathOf(this.points), w, h);
    const toSource = this.state.patchSource === 'source';
    const destMask = toSource ? base : translateMask(base, w, h, offset.dx, offset.dy);
    const sdx = Math.round(toSource ? offset.dx : -offset.dx);
    const sdy = Math.round(toSource ? offset.dy : -offset.dy);

    const ringW = 6;
    const grown = morph(destMask, w, h, ringW, true);
    const bounds = maskBounds(grown, w, h);
    if (!bounds) {
      app.toast('The patch area is empty.', 'warn');
      return;
    }
    const bx = Math.max(0, bounds.x - 1), by = Math.max(0, bounds.y - 1);
    const bw = Math.min(w - bx, bounds.width + 2), bh = Math.min(h - by, bounds.height + 2);

    doc.beginEdit(layer);
    const surface = layer.paintTarget();
    const dstImg = ctx2dRead(surface).getImageData(bx, by, bw, bh);

    const stage = createCanvas(bw, bh);
    stage.getContext('2d').drawImage(surface, -(bx + sdx), -(by + sdy));
    const srcImg = ctx2dRead(stage).getImageData(0, 0, bw, bh);

    const dst = dstImg.data;
    const src = srcImg.data;
    const out = new Float32Array(bw * bh * 3);

    // Texture-only mode keeps the destination's low frequencies entirely.
    let dstLow = null, srcLow = null;
    if (this.state.transparent) {
      const sigma = Math.max(2, Math.min(bw, bh) * 0.06);
      dstLow = blurImageData(dstImg, sigma).data;
      srcLow = blurImageData(srcImg, sigma).data;
    }

    for (let p = 0, i = 0; p < bw * bh; p++, i += 4) {
      if (this.state.transparent) {
        out[p * 3] = dstLow[i] + (src[i] - srcLow[i]);
        out[p * 3 + 1] = dstLow[i + 1] + (src[i + 1] - srcLow[i + 1]);
        out[p * 3 + 2] = dstLow[i + 2] + (src[i + 2] - srcLow[i + 2]);
      } else {
        out[p * 3] = src[i];
        out[p * 3 + 1] = src[i + 1];
        out[p * 3 + 2] = src[i + 2];
      }
    }

    if (!this.state.transparent) {
      // Low-frequency correction: how far the source is from the destination,
      // measured on the ring and pushed into the patch.
      const inner = new Uint8Array(bw * bh);
      const ring = [];
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const g = (by + y) * w + (bx + x);
          const p = y * bw + x;
          if (destMask[g] > 127) inner[p] = 1;
          else if (grown[g] > 127) ring.push(p);
        }
      }
      if (this.state.mode === 'content-aware' && ring.length) {
        // Poisson-style: diffuse the ring difference across the whole patch.
        const field = new Float32Array(bw * bh * 3);
        for (const p of ring) {
          const i = p * 4;
          field[p * 3] = dst[i] - src[i];
          field[p * 3 + 1] = dst[i + 1] - src[i + 1];
          field[p * 3 + 2] = dst[i + 2] - src[i + 2];
        }
        // Seed the interior with the ring average so it converges quickly.
        let ar = 0, ag = 0, ab = 0;
        for (const p of ring) { ar += field[p * 3]; ag += field[p * 3 + 1]; ab += field[p * 3 + 2]; }
        ar /= ring.length; ag /= ring.length; ab /= ring.length;
        for (let p = 0; p < bw * bh; p++) {
          if (!inner[p]) continue;
          field[p * 3] = ar; field[p * 3 + 1] = ag; field[p * 3 + 2] = ab;
        }
        laplaceFill(field, bw, bh, inner, 3);
        for (let p = 0; p < bw * bh; p++) {
          out[p * 3] += field[p * 3];
          out[p * 3 + 1] += field[p * 3 + 1];
          out[p * 3 + 2] += field[p * 3 + 2];
        }
      } else if (ring.length) {
        let dr = 0, dg = 0, db = 0;
        for (const p of ring) {
          const i = p * 4;
          dr += dst[i] - src[i];
          dg += dst[i + 1] - src[i + 1];
          db += dst[i + 2] - src[i + 2];
        }
        dr /= ring.length; dg /= ring.length; db /= ring.length;
        for (let p = 0; p < bw * bh; p++) {
          out[p * 3] += dr; out[p * 3 + 1] += dg; out[p * 3 + 2] += db;
        }
      }
    }

    // Feather the edge of the patch a touch so the seam is invisible.
    const soft = softenMask(destMask, w, h, 1.5);
    const sel = doc.selection.active ? doc.selection.mask : null;
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const g = (by + y) * w + (bx + x);
        let m = soft[g] / 255;
        if (sel) m *= sel[g] / 255;
        if (m <= 0) continue;
        const p = y * bw + x, i = p * 4;
        dst[i] += (clamp255(out[p * 3]) - dst[i]) * m;
        dst[i + 1] += (clamp255(out[p * 3 + 1]) - dst[i + 1]) * m;
        dst[i + 2] += (clamp255(out[p * 3 + 2]) - dst[i + 2]) * m;
        // Texture-only patching must not disturb the destination's alpha.
        if (!this.state.transparent) dst[i + 3] += (src[i + 3] - dst[i + 3]) * m;
      }
    }

    surface.getContext('2d').putImageData(dstImg, bx, by);
    if (layer.editingMask) layer.touchMask();
    doc.commit('Patch');
  }

  drawOverlay(ctx, view) {
    if (this.points.length < 2) return;
    const draw = (dx, dy, dash) => {
      ctx.beginPath();
      const p0 = view.toScreen(this.points[0].x + dx, this.points[0].y + dy);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < this.points.length; i++) {
        const p = view.toScreen(this.points[i].x + dx, this.points[i].y + dy);
        ctx.lineTo(p.x, p.y);
      }
      if (this.phase !== 'drawing') ctx.closePath();
      ctx.setLineDash(dash);
      ctx.lineWidth = 1;
      ctx.lineDashOffset = 0;
      ctx.strokeStyle = 'rgba(0,0,0,.85)';
      ctx.stroke();
      ctx.lineDashOffset = dash[0];
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.stroke();
      ctx.lineDashOffset = 0;
    };

    ctx.save();
    draw(0, 0, [4, 4]);
    if (this.phase === 'moving' && (this.offset.dx || this.offset.dy)) {
      draw(this.offset.dx, this.offset.dy, [2, 3]);
      const a = view.toScreen(this.points[0].x, this.points[0].y);
      const b = view.toScreen(this.points[0].x + this.offset.dx, this.points[0].y + this.offset.dy);
      ctx.setLineDash([]);
      ctx.strokeStyle = OVERLAY.accent;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** 3x3 box blur of a coverage mask — just enough to kill the stair-steps. */
function softenMask(mask, w, h, radius) {
  const r = Math.max(1, Math.round(radius));
  const tmp = new Float32Array(w * h);
  const out = new Uint8ClampedArray(w * h);
  const div = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += mask[row + clamp(i, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / div;
      sum += mask[row + clamp(x + r + 1, 0, w - 1)] - mask[row + clamp(x - r, 0, w - 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += tmp[clamp(i, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / div;
      sum += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x];
    }
  }
  return out;
}

registerTool(new PatchTool());

/* ================================================================== */
/* Red Eye                                                             */
/* ================================================================== */

class RedEyeTool extends Tool {
  constructor() {
    super({
      id: 'red-eye', name: 'Red Eye Tool', icon: 'red-eye', cursor: 'crosshair', shortcut: 'J',
      group: 'healing', groupOrder: 6,
      options: [
        { key: 'pupilSize', label: 'Pupil Size', type: 'slider', min: 10, max: 100, step: 1, default: 50, unit: '%' },
        { key: 'darkenAmount', label: 'Darken Amount', type: 'slider', min: 0, max: 100, step: 1, default: 50, unit: '%' },
      ],
    });
    this.app = app;
    this.start = null;
    this.rect = null;
  }

  onPointerDown(e) {
    if (e.button !== 0) return;
    if (!this.doc) return;
    this.start = { x: e.x, y: e.y };
    this.rect = null;
    app.requestRender();
  }

  onPointerMove(e) {
    if (!this.start) return;
    this.rect = {
      x: Math.min(this.start.x, e.x),
      y: Math.min(this.start.y, e.y),
      width: Math.abs(e.x - this.start.x),
      height: Math.abs(e.y - this.start.y),
    };
    app.requestRender();
  }

  onPointerUp(e) {
    if (!this.start) return;
    let rect = this.rect;
    if (!rect || rect.width < 4 || rect.height < 4) {
      // A plain click works on a default-sized area around the pointer.
      const s = 44;
      rect = { x: e.x - s / 2, y: e.y - s / 2, width: s, height: s };
    }
    this.start = null;
    this.rect = null;
    this._apply(rect);
    app.requestRender();
  }

  cancel() {
    this.start = null;
    this.rect = null;
  }

  contextMenu() {
    // The tool is two sliders, so the preset ladder is the whole picker.
    const row = (key, pct) => ({
      label: `${pct}%`,
      checked: Math.round(this.state[key]) === pct,
      run: () => this.setOption(key, pct),
    });
    return [
      { header: 'Pupil Size' },
      row('pupilSize', 25), row('pupilSize', 50), row('pupilSize', 75),
      { header: 'Darken Amount' },
      row('darkenAmount', 25), row('darkenAmount', 50), row('darkenAmount', 75),
      sep(),
      cmd('edit.undo'),
    ];
  }

  _apply(rect) {
    if (!this.canPaint()) return;
    const doc = this.doc;
    const layer = doc.activeLayer();
    const x0 = clamp(Math.floor(rect.x), 0, doc.width);
    const y0 = clamp(Math.floor(rect.y), 0, doc.height);
    const x1 = clamp(Math.ceil(rect.x + rect.width), 0, doc.width);
    const y1 = clamp(Math.ceil(rect.y + rect.height), 0, doc.height);
    const w = x1 - x0, h = y1 - y0;
    if (w < 2 || h < 2) return;

    doc.beginEdit(layer);
    const surface = layer.paintTarget();
    const img = ctx2dRead(surface).getImageData(x0, y0, w, h);
    const d = img.data;

    const cx = w / 2, cy = h / 2;
    const rx = Math.max(1, (w / 2) * (this.state.pupilSize / 100) * 1.6);
    const ry = Math.max(1, (h / 2) * (this.state.pupilSize / 100) * 1.6);
    const darken = (this.state.darkenAmount / 100) * 0.85;
    const sel = doc.selection.active ? doc.selection.mask : null;
    let touched = 0;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (d[i + 3] === 0) continue;
        const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry;
        const dist = Math.sqrt(nx * nx + ny * ny);
        if (dist >= 1) continue;
        const falloff = clamp((1 - dist) / 0.35, 0, 1);

        const r = d[i], g = d[i + 1], b = d[i + 2];
        const other = (g + b) / 2;
        if (r < 40) continue;
        const ratio = r / Math.max(1, other);
        const redness = clamp((ratio - 1.35) / 0.9, 0, 1) * clamp((r - other) / 42, 0, 1);
        if (redness <= 0) continue;

        let m = redness * falloff;
        if (sel) m *= sel[(y0 + y) * doc.width + (x0 + x)] / 255;
        if (m <= 0) continue;

        // Kill the red channel by falling back to green/blue, then darken.
        const grey = Math.min(g, b) * 0.6 + other * 0.4;
        const target = grey * (1 - darken);
        d[i] += (target - r) * m;
        d[i + 1] += (target - g) * m;
        d[i + 2] += (target - b) * m;
        touched++;
      }
    }

    if (!touched) {
      app.toast('No red-eye pixels found in that area.', 'warn');
      return;
    }
    surface.getContext('2d').putImageData(img, x0, y0);
    if (layer.editingMask) layer.touchMask();
    doc.commit('Red Eye Removal');
  }

  drawOverlay(ctx, view) {
    if (!this.rect) return;
    const a = view.toScreen(this.rect.x, this.rect.y);
    const b = view.toScreen(this.rect.x + this.rect.width, this.rect.y + this.rect.height);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,.85)';
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.lineDashOffset = 4;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.restore();
  }
}

registerTool(new RedEyeTool());
