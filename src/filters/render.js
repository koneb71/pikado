import { registerFilter } from './registry.js';
import { app } from '../core/app.js';
import { createCanvas, getImageData, clamp, clamp255, deg2rad, lerp } from '../core/util.js';
import { parseColor, luminance } from '../core/color.js';

/**
 * Filter > Render.
 *
 * Generators write straight into the region they are given; `ctx.rect` is used
 * to anchor procedural noise to document coordinates so a selection renders
 * the same clouds it would have without one.
 */

/* ------------------------------------------------------------------ */
/* Noise                                                               */
/* ------------------------------------------------------------------ */

function hash2(x, y, seed) {
  let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0;
  n = (n ^ (n >>> 13)) | 0;
  n = Math.imul(n, 1274126177) | 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function smootherstep(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Fractal value noise over a w*h region, anchored at document offset (ox,oy).
 * Octave lattices are precomputed per scanline so the inner loop stays cheap.
 * @param {number} [step] document pixels per sample — >1 takes a coarse probe
 *   of a larger area for the same cost.
 * @returns {Float32Array} w*h values in 0..1
 */
function fbmField(w, h, ox, oy, seed, baseCell, octaves, roughness, step = 1) {
  const out = new Float32Array(w * h);
  const ix0 = new Int32Array(w);
  const fxs = new Float32Array(w);
  let amp = 1, norm = 0, cell = baseCell;

  for (let o = 0; o < octaves; o++) {
    const inv = 1 / Math.max(1, cell);
    for (let x = 0; x < w; x++) {
      const u = (x * step + ox) * inv;
      const c = Math.floor(u);
      ix0[x] = c;
      fxs[x] = smootherstep(u - c);
    }
    const s = seed + o * 7919;
    for (let y = 0; y < h; y++) {
      const v = (y * step + oy) * inv;
      const cy0 = Math.floor(v);
      const fy = smootherstep(v - cy0);
      const cy1 = cy0 + 1;
      const row = y * w;
      let prevC = 0x7fffffff, a = 0, b = 0, c2 = 0, d = 0;
      for (let x = 0; x < w; x++) {
        const cx0 = ix0[x];
        if (cx0 !== prevC) {
          const cx1 = cx0 + 1;
          a = hash2(cx0, cy0, s); b = hash2(cx1, cy0, s);
          c2 = hash2(cx0, cy1, s); d = hash2(cx1, cy1, s);
          prevC = cx0;
        }
        const fx = fxs[x];
        const top = a + (b - a) * fx;
        const bot = c2 + (d - c2) * fx;
        out[row + x] += (top + (bot - top) * fy) * amp;
      }
    }
    norm += amp;
    amp *= roughness;
    cell = Math.max(1, cell / 2);
  }

  const k = 1 / norm;
  for (let i = 0; i < out.length; i++) out[i] *= k;
  return out;
}

const CLOUD_PARAMS = [
  { key: 'seed', label: 'Seed', type: 'slider', min: 1, max: 9999, step: 1, default: 1234 },
  { key: 'scale', label: 'Scale', type: 'slider', min: 5, max: 400, step: 1, default: 100, unit: '%' },
  { key: 'roughness', label: 'Roughness', type: 'slider', min: 10, max: 90, step: 1, default: 50, unit: '%' },
];

function cloudField(imageData, p, ctx) {
  const w = imageData.width, h = imageData.height;
  const rect = (ctx && ctx.rect) || { x: 0, y: 0 };
  const doc = ctx && ctx.doc;
  // Cell size and contrast both key off the *document*, never the region, so a
  // selection renders exactly the clouds it would have rendered without one.
  const dw = doc ? doc.width : w, dh = doc ? doc.height : h;
  const base = Math.max(4, (Math.max(dw, dh) / 3) * (p.scale / 100));
  const octaves = clamp(Math.round(Math.log2(base)) + 1, 3, 9);
  const rough = clamp(p.roughness / 100, 0.1, 0.9);
  const seed = p.seed | 0;

  // Summed octaves cluster around 0.5, so the raw field never reaches either
  // end. A coarse probe of the whole document gives the stretch that makes the
  // clouds span foreground to background without depending on the region.
  const probe = fbmField(96, 96, 0, 0, seed, base, octaves, rough, Math.max(dw, dh) / 96);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < probe.length; i++) {
    const v = probe[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const gain = hi - lo > 1e-4 ? 1 / (hi - lo) : 1;

  const field = fbmField(w, h, rect.x, rect.y, seed, base, octaves, rough);
  for (let i = 0; i < field.length; i++) field[i] = (field[i] - lo) * gain;
  return field;
}

registerFilter({
  id: 'clouds',
  name: 'Clouds...',
  menu: 'Render',
  params: CLOUD_PARAMS,
  apply(imageData, p, ctx) {
    const data = imageData.data;
    const field = cloudField(imageData, p, ctx);
    const A = (ctx && ctx.app) || app;
    const fg = A.foreground, bg = A.background;
    for (let k = 0, i = 0; k < field.length; k++, i += 4) {
      const t = clamp(field[k], 0, 1);
      data[i] = fg.r + (bg.r - fg.r) * t;
      data[i + 1] = fg.g + (bg.g - fg.g) * t;
      data[i + 2] = fg.b + (bg.b - fg.b) * t;
      data[i + 3] = 255;
    }
    return imageData;
  },
});

registerFilter({
  id: 'difference-clouds',
  name: 'Difference Clouds...',
  menu: 'Render',
  params: CLOUD_PARAMS,
  apply(imageData, p, ctx) {
    const data = imageData.data;
    const field = cloudField(imageData, p, ctx);
    const A = (ctx && ctx.app) || app;
    const fg = A.foreground, bg = A.background;
    for (let k = 0, i = 0; k < field.length; k++, i += 4) {
      const t = clamp(field[k], 0, 1);
      const a = data[i + 3] / 255;
      const cr = fg.r + (bg.r - fg.r) * t;
      const cg = fg.g + (bg.g - fg.g) * t;
      const cb = fg.b + (bg.b - fg.b) * t;
      data[i] = Math.abs(data[i] * a - cr);
      data[i + 1] = Math.abs(data[i + 1] * a - cg);
      data[i + 2] = Math.abs(data[i + 2] * a - cb);
      data[i + 3] = 255;
    }
    return imageData;
  },
});

/* ------------------------------------------------------------------ */
/* Fibers                                                              */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'fibers',
  name: 'Fibers...',
  menu: 'Render',
  params: [
    { key: 'variance', label: 'Variance', type: 'slider', min: 1, max: 64, step: 1, default: 16 },
    { key: 'strength', label: 'Strength', type: 'slider', min: 1, max: 64, step: 1, default: 4 },
    { key: 'seed', label: 'Randomize', type: 'slider', min: 1, max: 9999, step: 1, default: 7 },
  ],
  apply(imageData, p, ctx) {
    const w = imageData.width, h = imageData.height, data = imageData.data;
    const A = (ctx && ctx.app) || app;
    const fg = A.foreground, bg = A.background;
    const seed = (p.seed | 0) || 1;

    // Longer fibers for a low variance; strength controls the contrast.
    const length = clamp(600 / p.variance, 2, 400);
    const k = 1 / length;
    const contrast = clamp(p.strength / 6, 0.2, 12);

    // Low frequency wander so the fibers are not perfectly vertical.
    const wander = fbmField(w, h, 0, 0, seed + 331, Math.max(8, h / 6), 3, 0.5);
    const col = new Float32Array(w);
    for (let x = 0; x < w; x++) col[x] = hash2(x, 0, seed);

    const line = new Float32Array(w);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        col[x] = col[x] * (1 - k) + hash2(x, y + 1, seed) * k;
        line[x] = col[x];
      }
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const off = (wander[row + x] - 0.5) * 12;
        let sx = x + off;
        sx = sx < 0 ? 0 : sx > w - 1 ? w - 1 : sx;
        const x0 = Math.floor(sx), x1 = Math.min(w - 1, x0 + 1), fx = sx - x0;
        const v = line[x0] + (line[x1] - line[x0]) * fx;
        const t = clamp(0.5 + (v - 0.5) * contrast, 0, 1);
        const i = (row + x) * 4;
        data[i] = fg.r + (bg.r - fg.r) * t;
        data[i + 1] = fg.g + (bg.g - fg.g) * t;
        data[i + 2] = fg.b + (bg.b - fg.b) * t;
        data[i + 3] = 255;
      }
    }
    return imageData;
  },
});

/* ------------------------------------------------------------------ */
/* Lens Flare                                                          */
/* ------------------------------------------------------------------ */

const LENS_TYPES = {
  '50-300': { core: 0.055, halo: 0.30, rays: 10, rayLen: 0.42, ghosts: 11, ring: 0.62, ringWidth: 0.10, anam: 0, tint: [255, 236, 205] },
  '35': { core: 0.075, halo: 0.44, rays: 6, rayLen: 0.30, ghosts: 7, ring: 0.78, ringWidth: 0.16, anam: 0, tint: [255, 226, 190] },
  '105': { core: 0.042, halo: 0.22, rays: 14, rayLen: 0.50, ghosts: 6, ring: 0.46, ringWidth: 0.07, anam: 0, tint: [255, 244, 226] },
  movie: { core: 0.05, halo: 0.26, rays: 4, rayLen: 0.34, ghosts: 5, ring: 0.40, ringWidth: 0.06, anam: 1, tint: [206, 230, 255] },
};

function drawFlare(w, h, p) {
  const spec = LENS_TYPES[p.lensType] || LENS_TYPES['50-300'];
  const cv = createCanvas(w, h);
  const c = cv.getContext('2d');
  const diag = Math.hypot(w, h);
  const fx = (p.centerX / 100) * w;
  const fy = (p.centerY / 100) * h;
  const cx = w / 2, cy = h / 2;
  const b = clamp(p.brightness / 100, 0.1, 3);
  const tint = spec.tint;
  c.globalCompositeOperation = 'lighter';

  const soft = (x, y, r, stops) => {
    if (r <= 0) return;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    for (const [t, col] of stops) g.addColorStop(clamp(t, 0, 1), col);
    c.fillStyle = g;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  };

  // Warm halo and hot core.
  soft(fx, fy, diag * spec.halo * b, [
    [0, `rgba(${tint[0]},${tint[1]},${tint[2]},${0.30 * b})`],
    [0.35, `rgba(${tint[0]},${Math.round(tint[1] * 0.8)},${Math.round(tint[2] * 0.55)},${0.12 * b})`],
    [1, 'rgba(0,0,0,0)'],
  ]);
  soft(fx, fy, diag * spec.core * b, [
    [0, `rgba(255,255,255,${0.95 * b})`],
    [0.25, `rgba(255,252,240,${0.7 * b})`],
    [1, 'rgba(255,190,120,0)'],
  ]);

  // Chromatic ring around the core.
  const rr = diag * spec.ring * 0.5;
  const rw = spec.ringWidth;
  const ring = c.createRadialGradient(fx, fy, rr * (1 - rw), fx, fy, rr * (1 + rw));
  ring.addColorStop(0, 'rgba(0,0,0,0)');
  ring.addColorStop(0.25, `rgba(255,60,40,${0.13 * b})`);
  ring.addColorStop(0.45, `rgba(240,230,60,${0.15 * b})`);
  ring.addColorStop(0.62, `rgba(60,235,120,${0.13 * b})`);
  ring.addColorStop(0.82, `rgba(70,130,255,${0.14 * b})`);
  ring.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = ring;
  c.beginPath();
  c.arc(fx, fy, rr * (1 + rw), 0, Math.PI * 2);
  c.fill();

  // Star rays.
  c.save();
  c.translate(fx, fy);
  for (let i = 0; i < spec.rays; i++) {
    const a = (i / spec.rays) * Math.PI * 2 + 0.3;
    const len = diag * spec.rayLen * (0.55 + ((i * 37) % 11) / 11 * 0.75) * b;
    c.save();
    c.rotate(a);
    const g = c.createLinearGradient(0, 0, len, 0);
    g.addColorStop(0, `rgba(255,248,235,${0.5 * b})`);
    g.addColorStop(0.15, `rgba(255,225,190,${0.18 * b})`);
    g.addColorStop(1, 'rgba(255,180,120,0)');
    c.fillStyle = g;
    const halfW = Math.max(1.2, diag * 0.0045);
    c.beginPath();
    c.moveTo(0, -halfW);
    c.lineTo(len, -halfW * 0.15);
    c.lineTo(len, halfW * 0.15);
    c.lineTo(0, halfW);
    c.closePath();
    c.fill();
    c.restore();
  }
  c.restore();

  // Anamorphic streak (movie primes) — long, horizontal and blue.
  if (spec.anam) {
    const len = w * 0.95 * b;
    const g = c.createLinearGradient(fx - len, fy, fx + len, fy);
    g.addColorStop(0, 'rgba(60,120,255,0)');
    g.addColorStop(0.5, `rgba(150,205,255,${0.55 * b})`);
    g.addColorStop(1, 'rgba(60,120,255,0)');
    c.fillStyle = g;
    const th = Math.max(2, diag * 0.006);
    c.beginPath();
    c.moveTo(fx - len, fy);
    c.lineTo(fx, fy - th);
    c.lineTo(fx + len, fy);
    c.lineTo(fx, fy + th);
    c.closePath();
    c.fill();
  }

  // Ghosts marching along the line through the frame centre.
  const dx = cx - fx, dy = cy - fy;
  const n = spec.ghosts;
  for (let i = 0; i < n; i++) {
    const t = -0.55 + (i / (n - 1 || 1)) * 2.35;
    const gx = fx + dx * t * 2;
    const gy = fy + dy * t * 2;
    const seedy = (i * 53) % 17;
    const rad = diag * (0.012 + (seedy % 5) * 0.012) * (1 + Math.abs(t) * 0.4);
    const hue = (i * 47 + 20) % 360;
    const alpha = (0.10 + (seedy % 3) * 0.035) * b;
    if (i % 3 === 2) {
      // hollow chromatic ghost
      const gr = c.createRadialGradient(gx, gy, rad * 0.55, gx, gy, rad);
      gr.addColorStop(0, 'rgba(0,0,0,0)');
      gr.addColorStop(0.6, `hsla(${hue},90%,62%,${alpha})`);
      gr.addColorStop(0.85, `hsla(${(hue + 60) % 360},90%,70%,${alpha * 0.8})`);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = gr;
      c.beginPath();
      c.arc(gx, gy, rad, 0, Math.PI * 2);
      c.fill();
    } else {
      soft(gx, gy, rad, [
        [0, `hsla(${hue},85%,68%,${alpha})`],
        [0.7, `hsla(${(hue + 40) % 360},85%,60%,${alpha * 0.5})`],
        [1, 'rgba(0,0,0,0)'],
      ]);
    }
  }
  return cv;
}

registerFilter({
  id: 'lens-flare',
  name: 'Lens Flare...',
  menu: 'Render',
  dialogWidth: 380,
  params: [
    { key: 'brightness', label: 'Brightness', type: 'slider', min: 10, max: 300, step: 1, default: 100, unit: '%' },
    {
      key: 'lensType', label: 'Lens Type', type: 'select', default: '50-300',
      options: [
        { value: '50-300', label: '50-300mm Zoom' },
        { value: '35', label: '35mm Prime' },
        { value: '105', label: '105mm Prime' },
        { value: 'movie', label: 'Movie Prime' },
      ],
    },
    { key: 'centerX', label: 'Flare Center X', type: 'slider', min: 0, max: 100, step: 0.5, default: 35, unit: '%' },
    { key: 'centerY', label: 'Flare Center Y', type: 'slider', min: 0, max: 100, step: 0.5, default: 30, unit: '%' },
  ],
  apply(imageData, p) {
    const w = imageData.width, h = imageData.height, data = imageData.data;
    const flare = getImageData(drawFlare(w, h, p)).data;
    for (let i = 0; i < data.length; i += 4) {
      const fa = flare[i + 3] / 255;
      if (fa <= 0) continue;
      const a0 = data[i + 3] / 255;
      const outA = a0 + (1 - a0) * fa;
      if (outA <= 0) continue;
      const inv = 1 / outA;
      data[i] = (data[i] * a0 + flare[i] * fa) * inv;
      data[i + 1] = (data[i + 1] * a0 + flare[i + 1] * fa) * inv;
      data[i + 2] = (data[i + 2] * a0 + flare[i + 2] * fa) * inv;
      data[i + 3] = outA * 255;
    }
    return imageData;
  },
});

/* ------------------------------------------------------------------ */
/* Lighting Effects                                                    */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'lighting-effects',
  name: 'Lighting Effects...',
  menu: 'Render',
  dialogWidth: 400,
  params: [
    {
      key: 'lightType', label: 'Light Type', type: 'select', default: 'spot',
      options: [
        { value: 'spot', label: 'Spot' },
        { value: 'omni', label: 'Omni' },
        { value: 'directional', label: 'Directional' },
      ],
    },
    { key: 'color', label: 'Light Color', type: 'color', default: '#ffffff' },
    { key: 'intensity', label: 'Intensity', type: 'slider', min: 0, max: 200, step: 1, default: 70 },
    { key: 'focus', label: 'Focus', type: 'slider', min: 1, max: 100, step: 1, default: 55, when: (s) => s.lightType !== 'directional' },
    { key: 'lightX', label: 'Light X', type: 'slider', min: -50, max: 150, step: 1, default: 50, unit: '%', when: (s) => s.lightType !== 'directional' },
    { key: 'lightY', label: 'Light Y', type: 'slider', min: -50, max: 150, step: 1, default: 50, unit: '%', when: (s) => s.lightType !== 'directional' },
    { key: 'direction', label: 'Direction', type: 'angle', default: 135, when: (s) => s.lightType === 'directional' },
    { type: 'separator' },
    { key: 'gloss', label: 'Gloss', type: 'slider', min: -100, max: 100, step: 1, default: 0 },
    { key: 'material', label: 'Material', type: 'slider', min: -100, max: 100, step: 1, default: 0 },
    { key: 'exposure', label: 'Exposure', type: 'slider', min: -100, max: 100, step: 1, default: 0 },
    { key: 'ambience', label: 'Ambience', type: 'slider', min: -100, max: 100, step: 1, default: 20 },
    { type: 'separator' },
    { key: 'texture', label: 'Texture Channel (bump from image)', type: 'checkbox', default: true },
    { key: 'height', label: 'Height', type: 'slider', min: 0, max: 100, step: 1, default: 50, when: (s) => !!s.texture },
  ],
  apply(imageData, p) {
    const w = imageData.width, h = imageData.height, data = imageData.data;
    const lc = parseColor(p.color);
    const lr = lc.r / 255, lg = lc.g / 255, lb = lc.b / 255;

    const ambient = clamp((p.ambience + 100) / 200, 0, 1);
    const expo = Math.pow(2, p.exposure / 100);
    const inten = p.intensity / 70;
    const shininess = Math.pow(2, ((p.gloss + 100) / 200) * 5 + 2);
    const metallic = clamp((p.material + 100) / 200, 0, 1);
    const bump = p.texture ? (p.height / 100) * 6 : 0;

    // Height map from the source luminance.
    let lum = null;
    if (bump > 0) {
      lum = new Float32Array(w * h);
      for (let k = 0, i = 0; k < w * h; k++, i += 4) {
        lum[k] = luminance(data[i], data[i + 1], data[i + 2]) / 255;
      }
    }

    const lightZ = Math.max(w, h) * 0.55;
    const px = (p.lightX / 100) * w;
    const py = (p.lightY / 100) * h;
    const spotR = (p.focus / 100) * Math.hypot(w, h) * 0.65;
    const dirAng = deg2rad(p.direction);
    const dlx = Math.cos(dirAng), dly = -Math.sin(dirAng), dlz = 0.85;
    const dlen = Math.hypot(dlx, dly, dlz);
    const type = p.lightType;

    let i = 0;
    for (let y = 0; y < h; y++) {
      const yUp = y > 0 ? y - 1 : 0, yDn = y < h - 1 ? y + 1 : h - 1;
      for (let x = 0; x < w; x++, i += 4) {
        let nx = 0, ny = 0, nz = 1;
        if (bump > 0) {
          const xL = x > 0 ? x - 1 : 0, xR = x < w - 1 ? x + 1 : w - 1;
          nx = -(lum[y * w + xR] - lum[y * w + xL]) * bump;
          ny = -(lum[yDn * w + x] - lum[yUp * w + x]) * bump;
        }
        const nlen = Math.sqrt(nx * nx + ny * ny + 1) || 1;
        nx /= nlen; ny /= nlen; nz = 1 / nlen;

        let lxv, lyv, lzv, atten = 1;
        if (type === 'directional') {
          lxv = dlx / dlen; lyv = dly / dlen; lzv = dlz / dlen;
        } else {
          const vx = px - x, vy = py - y, vz = lightZ;
          const vl = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
          lxv = vx / vl; lyv = vy / vl; lzv = vz / vl;
          const d = Math.hypot(px - x, py - y) / Math.max(1, spotR);
          atten = type === 'spot' ? Math.max(0, 1 - d * d) : 1 / (1 + d * d);
        }

        let diff = nx * lxv + ny * lyv + nz * lzv;
        diff = diff < 0 ? 0 : diff;
        const lightAmt = diff * inten * atten;

        // Blinn-Phong highlight against a viewer straight above.
        const hx = lxv, hy = lyv, hz = lzv + 1;
        const hl = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1;
        let sp = (nx * hx + ny * hy + nz * hz) / hl;
        sp = sp < 0 ? 0 : Math.pow(sp, shininess) * atten * inten;

        for (let c = 0; c < 3; c++) {
          const base = data[i + c];
          const lcc = c === 0 ? lr : c === 1 ? lg : lb;
          const lit = base * (ambient + lightAmt * lcc) * expo;
          const specColor = lerp(lcc * 255, base, metallic);
          data[i + c] = lit + sp * specColor * (0.35 + metallic * 0.65);
        }
      }
    }
    return imageData;
  },
});

/* ------------------------------------------------------------------ */
/* Color Fill                                                          */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'color-fill',
  name: 'Color Fill',
  menu: 'Render',
  apply(imageData, p, ctx) {
    const A = (ctx && ctx.app) || app;
    const c = A.foreground;
    const a = clamp255(Math.round((c.a == null ? 1 : c.a) * 255));
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = c.r; d[i + 1] = c.g; d[i + 2] = c.b; d[i + 3] = a;
    }
    return imageData;
  },
});
