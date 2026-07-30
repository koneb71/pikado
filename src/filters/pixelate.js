/**
 * Filter > Pixelate — Color Halftone, Crystallize, Facet, Fragment,
 * Mezzotint, Mosaic and Pointillize.
 *
 * Anything that averages pixels does so premultiplied, so a cell that is half
 * transparent keeps the colour of its opaque half instead of fading to black.
 */

import { registerFilter, makeRandom } from './registry.js';
import { premultiplyImageData, unpremultiplyInto, motionBlurBuffer } from './blur.js';
import { app } from '../core/app.js';

/* ------------------------------------------------------------------ */
/* Mosaic                                                              */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'mosaic',
  name: 'Mosaic...',
  menu: 'Pixelate',
  params: [
    { key: 'cellSize', label: 'Cell Size', type: 'slider', min: 2, max: 200, step: 1, default: 10, unit: 'square' },
  ],
  apply(imageData, p) {
    const w = imageData.width, h = imageData.height, d = imageData.data;
    const cell = Math.max(2, Math.round(p.cellSize));
    for (let by = 0; by < h; by += cell) {
      const ye = Math.min(h, by + cell);
      for (let bx = 0; bx < w; bx += cell) {
        const xe = Math.min(w, bx + cell);
        let sr = 0, sg = 0, sb = 0, sa = 0, cnt = 0;
        for (let y = by; y < ye; y++) {
          let i = (y * w + bx) * 4;
          for (let x = bx; x < xe; x++, i += 4) {
            const a = d[i + 3], f = a / 255;
            sr += d[i] * f; sg += d[i + 1] * f; sb += d[i + 2] * f; sa += a;
            cnt++;
          }
        }
        const aAvg = sa / cnt;
        const r = sa > 0 ? (sr * 255) / sa : 0;
        const g = sa > 0 ? (sg * 255) / sa : 0;
        const b = sa > 0 ? (sb * 255) / sa : 0;
        for (let y = by; y < ye; y++) {
          let i = (y * w + bx) * 4;
          for (let x = bx; x < xe; x++, i += 4) {
            d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = aAvg;
          }
        }
      }
    }
  },
});

/* ------------------------------------------------------------------ */
/* Jittered seed grid, shared by Crystallize and Pointillize            */
/* ------------------------------------------------------------------ */

function seedGrid(w, h, cell, seed) {
  const gw = Math.ceil(w / cell) + 2;
  const gh = Math.ceil(h / cell) + 2;
  const rand = makeRandom(seed);
  const px = new Float32Array(gw * gh);
  const py = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const k = j * gw + i;
      px[k] = (i - 1) * cell + cell * (0.12 + 0.76 * rand());
      py[k] = (j - 1) * cell + cell * (0.12 + 0.76 * rand());
    }
  }
  return { gw, gh, px, py, cell };
}

registerFilter({
  id: 'crystallize',
  name: 'Crystallize...',
  menu: 'Pixelate',
  params: [
    { key: 'cellSize', label: 'Cell Size', type: 'slider', min: 3, max: 300, step: 1, default: 10 },
  ],
  apply(imageData, p) {
    const w = imageData.width, h = imageData.height, d = imageData.data;
    const cell = Math.max(3, Math.round(p.cellSize));
    const g = seedGrid(w, h, cell, 20260729);
    const cells = g.gw * g.gh;
    const owner = new Int32Array(w * h);
    const sum = new Float64Array(cells * 4);
    const cnt = new Float64Array(cells);

    for (let y = 0; y < h; y++) {
      const gyc = Math.floor(y / cell) + 1;
      for (let x = 0; x < w; x++) {
        const gxc = Math.floor(x / cell) + 1;
        let best = -1, bestD = Infinity;
        for (let dj = -1; dj <= 1; dj++) {
          const j = gyc + dj;
          if (j < 0 || j >= g.gh) continue;
          for (let di = -1; di <= 1; di++) {
            const i = gxc + di;
            if (i < 0 || i >= g.gw) continue;
            const k = j * g.gw + i;
            const dx = g.px[k] - x, dy = g.py[k] - y;
            const dist = dx * dx + dy * dy;
            if (dist < bestD) { bestD = dist; best = k; }
          }
        }
        if (best < 0) best = Math.min(cells - 1, gyc * g.gw + gxc);
        const q = y * w + x, si = q * 4;
        owner[q] = best;
        const a = d[si + 3], f = a / 255;
        sum[best * 4] += d[si] * f;
        sum[best * 4 + 1] += d[si + 1] * f;
        sum[best * 4 + 2] += d[si + 2] * f;
        sum[best * 4 + 3] += a;
        cnt[best]++;
      }
    }

    const outR = new Float32Array(cells);
    const outG = new Float32Array(cells);
    const outB = new Float32Array(cells);
    const outA = new Float32Array(cells);
    for (let k = 0; k < cells; k++) {
      const n = cnt[k];
      if (!n) continue;
      const sa = sum[k * 4 + 3];
      outA[k] = sa / n;
      if (sa > 0) {
        outR[k] = (sum[k * 4] * 255) / sa;
        outG[k] = (sum[k * 4 + 1] * 255) / sa;
        outB[k] = (sum[k * 4 + 2] * 255) / sa;
      }
    }
    for (let q = 0, i = 0; q < w * h; q++, i += 4) {
      const k = owner[q];
      d[i] = outR[k]; d[i + 1] = outG[k]; d[i + 2] = outB[k]; d[i + 3] = outA[k];
    }
  },
});

registerFilter({
  id: 'pointillize',
  name: 'Pointillize...',
  menu: 'Pixelate',
  params: [
    { key: 'cellSize', label: 'Cell Size', type: 'slider', min: 3, max: 300, step: 1, default: 5 },
  ],
  apply(imageData, p) {
    const w = imageData.width, h = imageData.height, d = imageData.data;
    const cell = Math.max(3, Math.round(p.cellSize));
    const g = seedGrid(w, h, cell, 981171);
    const cells = g.gw * g.gh;

    // Block averages give each dot the colour of the area it sits on.
    const sum = new Float64Array(cells * 4);
    const cnt = new Float64Array(cells);
    for (let y = 0; y < h; y++) {
      const j = Math.floor(y / cell) + 1;
      for (let x = 0; x < w; x++) {
        const i = Math.floor(x / cell) + 1;
        const k = j * g.gw + i;
        if (k < 0 || k >= cells) continue;
        const si = (y * w + x) * 4;
        const a = d[si + 3], f = a / 255;
        sum[k * 4] += d[si] * f;
        sum[k * 4 + 1] += d[si + 1] * f;
        sum[k * 4 + 2] += d[si + 2] * f;
        sum[k * 4 + 3] += a;
        cnt[k]++;
      }
    }

    const bg = app.background || { r: 255, g: 255, b: 255, a: 1 };
    const bgR = bg.r, bgG = bg.g, bgB = bg.b, bgA = Math.round((bg.a == null ? 1 : bg.a) * 255);
    for (let i = 0; i < d.length; i += 4) {
      d[i] = bgR; d[i + 1] = bgG; d[i + 2] = bgB; d[i + 3] = bgA;
    }

    const rand = makeRandom(4242);
    for (let k = 0; k < cells; k++) {
      const rr = cell * 0.5 * (0.62 + 0.55 * rand());
      const n = cnt[k];
      if (!n) continue;
      const sa = sum[k * 4 + 3];
      const aAvg = sa / n;
      if (aAvg <= 0.5) continue;
      const cr = (sum[k * 4] * 255) / sa;
      const cg = (sum[k * 4 + 1] * 255) / sa;
      const cb = (sum[k * 4 + 2] * 255) / sa;
      const cxp = g.px[k], cyp = g.py[k];
      const y0 = Math.max(0, Math.ceil(cyp - rr));
      const y1 = Math.min(h - 1, Math.floor(cyp + rr));
      const r2 = rr * rr;
      for (let y = y0; y <= y1; y++) {
        const dy = y - cyp;
        const half = Math.sqrt(Math.max(0, r2 - dy * dy));
        const x0 = Math.max(0, Math.ceil(cxp - half));
        const x1 = Math.min(w - 1, Math.floor(cxp + half));
        let i = (y * w + x0) * 4;
        for (let x = x0; x <= x1; x++, i += 4) {
          d[i] = cr; d[i + 1] = cg; d[i + 2] = cb; d[i + 3] = aAvg;
        }
      }
    }
  },
});

/* ------------------------------------------------------------------ */
/* Facet / Fragment                                                    */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'facet',
  name: 'Facet',
  menu: 'Pixelate',
  params: [],
  needsDialog: false,
  apply(imageData) {
    const w = imageData.width, h = imageData.height, d = imageData.data;
    const src = new Uint8ClampedArray(d);
    const keys = new Int32Array(9);
    const idxs = new Int32Array(9);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let m = 0;
        for (let dy = -1; dy <= 1; dy++) {
          let yy = y + dy;
          yy = yy < 0 ? 0 : yy > h - 1 ? h - 1 : yy;
          for (let dx = -1; dx <= 1; dx++) {
            let xx = x + dx;
            xx = xx < 0 ? 0 : xx > w - 1 ? w - 1 : xx;
            const i = (yy * w + xx) * 4;
            idxs[m] = i;
            keys[m] = ((src[i + 3] >> 3) << 15) | ((src[i] >> 3) << 10) | ((src[i + 1] >> 3) << 5) | (src[i + 2] >> 3);
            m++;
          }
        }
        // Most common quantised colour in the 3x3 neighbourhood wins; the
        // written value is the mean of the members of that group.
        let best = 4, bestCount = 0;
        for (let a = 0; a < 9; a++) {
          let c = 0;
          const ka = keys[a];
          for (let b = 0; b < 9; b++) if (keys[b] === ka) c++;
          if (c > bestCount) { bestCount = c; best = a; }
        }
        const bk = keys[best];
        let sr = 0, sg = 0, sb = 0, cnt = 0;
        for (let b = 0; b < 9; b++) {
          if (keys[b] !== bk) continue;
          const i = idxs[b];
          sr += src[i]; sg += src[i + 1]; sb += src[i + 2];
          cnt++;
        }
        const o = (y * w + x) * 4;
        d[o] = sr / cnt; d[o + 1] = sg / cnt; d[o + 2] = sb / cnt;
      }
    }
  },
});

registerFilter({
  id: 'fragment',
  name: 'Fragment',
  menu: 'Pixelate',
  params: [],
  needsDialog: false,
  apply(imageData) {
    const w = imageData.width, h = imageData.height;
    const src = premultiplyImageData(imageData);
    const out = new Float32Array(src.length);
    const offs = [-4, -4, 4, -4, -4, 4, 4, 4];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
        for (let k = 0; k < 8; k += 2) {
          let sx = x + offs[k], sy = y + offs[k + 1];
          sx = sx < 0 ? 0 : sx > w - 1 ? w - 1 : sx;
          sy = sy < 0 ? 0 : sy > h - 1 ? h - 1 : sy;
          const si = (sy * w + sx) * 4;
          a0 += src[si]; a1 += src[si + 1]; a2 += src[si + 2]; a3 += src[si + 3];
        }
        const o = (y * w + x) * 4;
        out[o] = a0 / 4; out[o + 1] = a1 / 4; out[o + 2] = a2 / 4; out[o + 3] = a3 / 4;
      }
    }
    unpremultiplyInto(out, imageData);
  },
});

/* ------------------------------------------------------------------ */
/* Mezzotint                                                           */
/* ------------------------------------------------------------------ */

const MEZZOTINT_TYPES = {
  'fine-dots': { kind: 'dots', scale: 1 },
  'medium-dots': { kind: 'dots', scale: 2 },
  'grainy-dots': { kind: 'dots', scale: 3, grain: 0.45 },
  'coarse-dots': { kind: 'dots', scale: 4 },
  'short-lines': { kind: 'lines', len: 7 },
  'medium-lines': { kind: 'lines', len: 15 },
  'long-lines': { kind: 'lines', len: 33 },
  'short-strokes': { kind: 'strokes', len: 7 },
  'medium-strokes': { kind: 'strokes', len: 15 },
  'long-strokes': { kind: 'strokes', len: 33 },
};

function blockNoise(w, h, scale, rand) {
  const f = new Float32Array(w * h);
  if (scale <= 1) {
    for (let i = 0; i < f.length; i++) f[i] = rand();
    return f;
  }
  const bw = Math.ceil(w / scale), bh = Math.ceil(h / scale);
  const blocks = new Float32Array(bw * bh);
  for (let i = 0; i < blocks.length; i++) blocks[i] = rand();
  for (let y = 0; y < h; y++) {
    const by = Math.min(bh - 1, (y / scale) | 0);
    for (let x = 0; x < w; x++) f[y * w + x] = blocks[by * bw + Math.min(bw - 1, (x / scale) | 0)];
  }
  return f;
}

// Smearing collapses the distribution around 0.5; equalising restores a flat
// one so the dither still reproduces the original tones.
function equalizeField(f) {
  const n = f.length;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < n; i++) {
    if (f[i] < min) min = f[i];
    if (f[i] > max) max = f[i];
  }
  const span = max - min || 1;
  const hist = new Int32Array(256);
  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const b = ((f[i] - min) / span) * 255;
    const bi = b < 0 ? 0 : b > 255 ? 255 : b | 0;
    bin[i] = bi;
    hist[bi]++;
  }
  const cdf = new Float32Array(256);
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    cdf[v] = (acc + hist[v] * 0.5) / n;
    acc += hist[v];
  }
  for (let i = 0; i < n; i++) f[i] = cdf[bin[i]];
}

function mezzotintField(w, h, cfg, seed) {
  const rand = makeRandom(seed);
  let f;
  if (cfg.kind === 'dots') {
    f = blockNoise(w, h, cfg.scale, rand);
    if (cfg.grain) {
      const g = cfg.grain;
      for (let i = 0; i < f.length; i++) f[i] = f[i] * (1 - g) + rand() * g;
    }
  } else if (cfg.kind === 'lines') {
    f = blockNoise(w, h, 1, rand);
    motionBlurBuffer(f, w, h, 0, cfg.len, 1);
  } else {
    f = blockNoise(w, h, 2, rand);
    motionBlurBuffer(f, w, h, 45, cfg.len, 1);
  }
  equalizeField(f);
  return f;
}

registerFilter({
  id: 'mezzotint',
  name: 'Mezzotint...',
  menu: 'Pixelate',
  params: [
    { key: 'type', label: 'Type', type: 'select', default: 'medium-dots', options: [
      { value: 'fine-dots', label: 'Fine dots' },
      { value: 'medium-dots', label: 'Medium dots' },
      { value: 'grainy-dots', label: 'Grainy dots' },
      { value: 'coarse-dots', label: 'Coarse dots' },
      { value: 'short-lines', label: 'Short lines' },
      { value: 'medium-lines', label: 'Medium lines' },
      { value: 'long-lines', label: 'Long lines' },
      { value: 'short-strokes', label: 'Short strokes' },
      { value: 'medium-strokes', label: 'Medium strokes' },
      { value: 'long-strokes', label: 'Long strokes' },
    ] },
  ],
  apply(imageData, p) {
    const w = imageData.width, h = imageData.height, d = imageData.data;
    const cfg = MEZZOTINT_TYPES[p.type] || MEZZOTINT_TYPES['medium-dots'];
    const fr = mezzotintField(w, h, cfg, 7717);
    const fg = mezzotintField(w, h, cfg, 21391);
    const fb = mezzotintField(w, h, cfg, 55051);
    for (let i = 0, q = 0; q < w * h; q++, i += 4) {
      d[i] = d[i] > fr[q] * 255 ? 255 : 0;
      d[i + 1] = d[i + 1] > fg[q] * 255 ? 255 : 0;
      d[i + 2] = d[i + 2] > fb[q] * 255 ? 255 : 0;
    }
  },
});

/* ------------------------------------------------------------------ */
/* Color Halftone                                                      */
/* ------------------------------------------------------------------ */

/**
 * Fraction of a screen cell covered by a square lattice of dots whose radius is
 * `t` pitches. Up to t = 1/2 the dots are disjoint; past that they overlap on
 * four sides, and at t = 1/sqrt(2) they meet at the corners and cover the cell.
 */
function latticeCoverage(t) {
  const area = Math.PI * t * t;
  if (t <= 0.5) return area;
  return area - 4 * t * t * Math.acos(1 / (2 * t)) + Math.sqrt(4 * t * t - 1);
}

/**
 * Invert `latticeCoverage` — the dot radius, in pitches, that lays down exactly
 * `ink` coverage. Sizing dots by sqrt(ink) instead would over-ink mid-tones by
 * pi/2 and turn a 50% grey almost black.
 */
function dotRadiusForInk(ink, pitch) {
  if (ink <= 0) return 0;
  // Full ink: reach half a pixel past the cell corner so the antialiased rims
  // of four neighbouring dots meet at solid, not at 50%.
  if (ink >= 1) return Math.SQRT1_2 + 0.5 / pitch;
  let lo = 0, hi = Math.SQRT1_2;
  for (let k = 0; k < 24; k++) {
    const t = (lo + hi) / 2;
    if (latticeCoverage(t) < ink) lo = t;
    else hi = t;
  }
  return (lo + hi) / 2;
}

function buildScreen(plane, w, h, deg, pitch) {
  const a = (deg * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  const corners = [0, 0, w, 0, 0, h, w, h];
  for (let k = 0; k < 8; k += 2) {
    const cx = corners[k], cy = corners[k + 1];
    const u = cx * ca + cy * sa;
    const v = -cx * sa + cy * ca;
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  const ciMin = Math.floor(uMin / pitch) - 1, ciMax = Math.ceil(uMax / pitch) + 1;
  const cjMin = Math.floor(vMin / pitch) - 1, cjMax = Math.ceil(vMax / pitch) + 1;
  const gw = ciMax - ciMin + 1, gh = cjMax - cjMin + 1;
  const rad = new Float32Array(gw * gh);
  const off = pitch / 3;
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const cu = (i + ciMin) * pitch, cv = (j + cjMin) * pitch;
      let acc = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const su = cu + di * off, sv = cv + dj * off;
          let px = Math.round(su * ca - sv * sa);
          let py = Math.round(su * sa + sv * ca);
          px = px < 0 ? 0 : px > w - 1 ? w - 1 : px;
          py = py < 0 ? 0 : py > h - 1 ? h - 1 : py;
          acc += plane[py * w + px];
        }
      }
      rad[j * gw + i] = pitch * dotRadiusForInk(acc / 9, pitch);
    }
  }
  return { ca, sa, pitch, ciMin, cjMin, gw, gh, rad };
}

/**
 * Ink coverage at one pixel, 0..1. The dot rim is antialiased over one pixel:
 * a hard in/out test centres every dot on a pixel and biases small dots several
 * pixels heavier than their true area, which wrecks the tone curve.
 */
function screenInk(g, x, y) {
  const u = x * g.ca + y * g.sa;
  const v = -x * g.sa + y * g.ca;
  const ci = Math.round(u / g.pitch), cj = Math.round(v / g.pitch);
  let cov = 0;
  for (let dj = -1; dj <= 1; dj++) {
    const j = cj + dj - g.cjMin;
    if (j < 0 || j >= g.gh) continue;
    for (let di = -1; di <= 1; di++) {
      const i = ci + di - g.ciMin;
      if (i < 0 || i >= g.gw) continue;
      const r = g.rad[j * g.gw + i];
      if (r <= 0) continue;
      const du = u - (ci + di) * g.pitch;
      const dv = v - (cj + dj) * g.pitch;
      const c = r + 0.5 - Math.sqrt(du * du + dv * dv);
      if (c >= 1) return 1;
      if (c > cov) cov = c;
    }
  }
  return cov > 0 ? cov : 0;
}

registerFilter({
  id: 'color-halftone',
  name: 'Color Halftone...',
  menu: 'Pixelate',
  dialogWidth: 400,
  params: [
    { key: 'maxRadius', label: 'Max. Radius', type: 'slider', min: 4, max: 127, step: 1, default: 8, unit: 'px' },
    { key: 'angle1', label: 'Channel 1 (Cyan)', type: 'number', min: 0, max: 360, step: 1, default: 108, unit: '°' },
    { key: 'angle2', label: 'Channel 2 (Magenta)', type: 'number', min: 0, max: 360, step: 1, default: 162, unit: '°' },
    { key: 'angle3', label: 'Channel 3 (Yellow)', type: 'number', min: 0, max: 360, step: 1, default: 90, unit: '°' },
    { key: 'angle4', label: 'Channel 4 (Black)', type: 'number', min: 0, max: 360, step: 1, default: 45, unit: '°' },
  ],
  apply(imageData, p) {
    const w = imageData.width, h = imageData.height, d = imageData.data;
    const n = w * h;
    const planes = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    for (let i = 0, q = 0; q < n; q++, i += 4) {
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const k = 1 - mx;
      planes[3][q] = k;
      if (k < 1) {
        const inv = 1 / (1 - k);
        planes[0][q] = (1 - r - k) * inv;
        planes[1][q] = (1 - g - k) * inv;
        planes[2][q] = (1 - b - k) * inv;
      }
    }
    // Max. Radius is the radius of a fully inked dot, so the cell diagonal is
    // 2*maxRadius and neighbouring solid dots just meet at the corners.
    const pitch = Math.max(2, p.maxRadius * Math.SQRT2);
    const angles = [p.angle1, p.angle2, p.angle3, p.angle4];
    const screens = [];
    for (let c = 0; c < 4; c++) screens.push(buildScreen(planes[c], w, h, angles[c], pitch));
    for (let y = 0; y < h; y++) {
      let i = y * w * 4;
      for (let x = 0; x < w; x++, i += 4) {
        const ic = screenInk(screens[0], x, y);
        const im = screenInk(screens[1], x, y);
        const iy = screenInk(screens[2], x, y);
        const ik = screenInk(screens[3], x, y);
        const kf = 1 - ik;
        d[i] = 255 * (1 - ic) * kf;
        d[i + 1] = 255 * (1 - im) * kf;
        d[i + 2] = 255 * (1 - iy) * kf;
      }
    }
  },
});
