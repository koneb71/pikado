import { registerFilter, makeRandom, separableConvolve, gaussianKernel } from './registry.js';
import { app } from '../core/app.js';
import { createCanvas, imageDataToCanvas, getImageData, clamp, clamp255, deg2rad, lerp } from '../core/util.js';
import { luminance, toCss } from '../core/color.js';

/**
 * Filter > Stylize.
 *
 * Neighbourhood operators run against a premultiplied copy of the source so
 * partially transparent pixels never contribute phantom colour, and the
 * original alpha is preserved unless the effect is explicitly about coverage.
 */

/* ------------------------------------------------------------------ */
/* Local helpers                                                       */
/* ------------------------------------------------------------------ */

function premultiply(data) {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    out[i] = data[i] * a;
    out[i + 1] = data[i + 1] * a;
    out[i + 2] = data[i + 2] * a;
    out[i + 3] = data[i + 3];
  }
  return out;
}

/** Bilinear sample of a premultiplied Float32 buffer, clamped at the edges. */
function sampleClamp(src, w, h, x, y, out) {
  x = x < 0 ? 0 : x > w - 1 ? w - 1 : x;
  y = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
  for (let k = 0; k < 4; k++) {
    const a = src[i00 + k] + (src[i10 + k] - src[i00 + k]) * fx;
    const b = src[i01 + k] + (src[i11 + k] - src[i01 + k]) * fx;
    out[k] = a + (b - a) * fy;
  }
}

/** Straight (unpremultiplied) luminance of pixel i. */
function lumAt(data, i) {
  return luminance(data[i], data[i + 1], data[i + 2]);
}

const SOBEL_X = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
const SOBEL_Y = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

/* ------------------------------------------------------------------ */
/* Diffuse                                                             */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'diffuse',
  name: 'Diffuse...',
  menu: 'Stylize',
  params: [
    {
      key: 'mode', label: 'Mode', type: 'select', default: 'normal',
      options: [
        { value: 'normal', label: 'Normal' },
        { value: 'darken', label: 'Darken Only' },
        { value: 'lighten', label: 'Lighten Only' },
        { value: 'anisotropic', label: 'Anisotropic' },
      ],
    },
    { key: 'amount', label: 'Amount', type: 'slider', min: 1, max: 100, step: 1, default: 25 },
  ],
  apply(imageData, p) {
    const { width: w, height: h, data } = imageData;
    const src = new Uint8ClampedArray(data);
    const rnd = makeRandom(0x51f7);
    const r = Math.max(1, Math.round((p.amount / 100) * 8));
    const mode = p.mode;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        let sx, sy;
        if (mode === 'anisotropic') {
          // Smear along the edge (perpendicular to the luminance gradient).
          let gx = 0, gy = 0;
          for (let k = 0; k < 9; k++) {
            const nx = clamp(x + (k % 3) - 1, 0, w - 1);
            const ny = clamp(y + ((k / 3) | 0) - 1, 0, h - 1);
            const l = lumAt(src, (ny * w + nx) * 4);
            gx += l * SOBEL_X[k];
            gy += l * SOBEL_Y[k];
          }
          const len = Math.hypot(gx, gy);
          const t = (rnd() * 2 - 1) * r;
          if (len < 1) {
            sx = x + Math.round(t);
            sy = y + Math.round((rnd() * 2 - 1) * r);
          } else {
            sx = Math.round(x + (-gy / len) * t);
            sy = Math.round(y + (gx / len) * t);
          }
        } else {
          sx = x + Math.round((rnd() * 2 - 1) * r);
          sy = y + Math.round((rnd() * 2 - 1) * r);
        }
        sx = clamp(sx, 0, w - 1);
        sy = clamp(sy, 0, h - 1);
        const j = (sy * w + sx) * 4;
        if (mode === 'darken' && lumAt(src, j) >= lumAt(src, i)) continue;
        if (mode === 'lighten' && lumAt(src, j) <= lumAt(src, i)) continue;
        data[i] = src[j]; data[i + 1] = src[j + 1]; data[i + 2] = src[j + 2]; data[i + 3] = src[j + 3];
      }
    }
    return imageData;
  },
});

/* ------------------------------------------------------------------ */
/* Emboss                                                              */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'emboss',
  name: 'Emboss...',
  menu: 'Stylize',
  params: [
    { key: 'angle', label: 'Angle', type: 'angle', default: 135 },
    { key: 'height', label: 'Height', type: 'slider', min: 1, max: 100, step: 1, default: 3, unit: 'px' },
    { key: 'amount', label: 'Amount', type: 'slider', min: 1, max: 500, step: 1, default: 100, unit: '%' },
  ],
  apply(imageData, p) {
    const { width: w, height: h, data } = imageData;
    const src = premultiply(data);
    const rad = deg2rad(p.angle);
    const ox = Math.cos(rad) * p.height;
    const oy = -Math.sin(rad) * p.height;
    const k = p.amount / 100;
    const a = new Float32Array(4), b = new Float32Array(4);
    let i = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i += 4) {
        const alpha = data[i + 3];
        if (alpha === 0) { data[i] = 128; data[i + 1] = 128; data[i + 2] = 128; continue; }
        sampleClamp(src, w, h, x + ox, y + oy, a);
        sampleClamp(src, w, h, x - ox, y - oy, b);
        const inv = 255 / alpha;
        data[i] = 128 + (a[0] - b[0]) * k * inv;
        data[i + 1] = 128 + (a[1] - b[1]) * k * inv;
        data[i + 2] = 128 + (a[2] - b[2]) * k * inv;
      }
    }
    return imageData;
  },
});

/* ------------------------------------------------------------------ */
/* Extrude                                                             */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'extrude',
  name: 'Extrude...',
  menu: 'Stylize',
  dialogWidth: 380,
  params: [
    {
      key: 'shape', label: 'Type', type: 'radio', default: 'blocks',
      options: [{ value: 'blocks', label: 'Blocks' }, { value: 'pyramids', label: 'Pyramids' }],
    },
    { key: 'size', label: 'Size', type: 'slider', min: 2, max: 255, step: 1, default: 30, unit: 'px' },
    { key: 'depth', label: 'Depth', type: 'slider', min: 1, max: 255, step: 1, default: 30 },
    {
      key: 'depthMode', label: 'Depth Mode', type: 'radio', default: 'random',
      options: [{ value: 'random', label: 'Random' }, { value: 'level', label: 'Level-based' }],
    },
    { key: 'solidFront', label: 'Solid Front Faces', type: 'checkbox', default: false, when: (s) => s.shape === 'blocks' },
    { key: 'maskIncomplete', label: 'Mask Incomplete Blocks', type: 'checkbox', default: false },
  ],
  apply(imageData, p) {
    const w = imageData.width, h = imageData.height;
    const size = clamp(Math.round(p.size), 2, 255);
    const cols = Math.max(1, Math.ceil(w / size));
    const rows = Math.max(1, Math.ceil(h / size));

    const srcCanvas = imageDataToCanvas(imageData);
    const small = createCanvas(cols, rows);
    const sctx = small.getContext('2d');
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(srcCanvas, 0, 0, w, h, 0, 0, cols, rows);
    const avg = getImageData(small).data;

    const out = createCanvas(w, h);
    const octx = out.getContext('2d');
    const rnd = makeRandom(0xe1e1);
    const cx = w / 2, cy = h / 2;

    const cells = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const x0 = i * size, y0 = j * size;
        const x1 = x0 + size, y1 = y0 + size;
        if (p.maskIncomplete && (x1 > w || y1 > h)) continue;
        const k = (j * cols + i) * 4;
        const alpha = avg[k + 3];
        const level = luminance(avg[k], avg[k + 1], avg[k + 2]) / 255;
        const t = p.depthMode === 'level' ? level : rnd();
        cells.push({ x0, y0, x1, y1, t, r: avg[k], g: avg[k + 1], b: avg[k + 2], a: alpha });
      }
    }
    cells.sort((a, b) => a.t - b.t);

    const project = (x, y, f) => [cx + (x - cx) * f, cy + (y - cy) * f];
    const shade = (c, m) => `rgba(${clamp255(Math.round(c.r * m))},${clamp255(Math.round(c.g * m))},${clamp255(Math.round(c.b * m))},${c.a / 255})`;

    for (const c of cells) {
      if (c.a === 0) continue;
      const f = 1 + (c.t * p.depth) / 255 * 0.55;
      const [fx0, fy0] = project(c.x0, c.y0, f);
      const [fx1, fy1] = project(c.x1, c.y0, f);
      const [fx2, fy2] = project(c.x1, c.y1, f);
      const [fx3, fy3] = project(c.x0, c.y1, f);

      if (p.shape === 'pyramids') {
        const [px, py] = project((c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2, f);
        const corners = [[c.x0, c.y0], [c.x1, c.y0], [c.x1, c.y1], [c.x0, c.y1]];
        const faceShade = [1.25, 0.95, 0.6, 0.82];
        for (let s = 0; s < 4; s++) {
          const a = corners[s], b = corners[(s + 1) % 4];
          octx.fillStyle = shade(c, faceShade[s]);
          octx.beginPath();
          octx.moveTo(a[0], a[1]);
          octx.lineTo(b[0], b[1]);
          octx.lineTo(px, py);
          octx.closePath();
          octx.fill();
        }
        continue;
      }

      const back = [[c.x0, c.y0], [c.x1, c.y0], [c.x1, c.y1], [c.x0, c.y1]];
      const front = [[fx0, fy0], [fx1, fy1], [fx2, fy2], [fx3, fy3]];
      const sideShade = [1.2, 0.95, 0.6, 0.82];
      for (let s = 0; s < 4; s++) {
        const a = back[s], b = back[(s + 1) % 4];
        const a2 = front[s], b2 = front[(s + 1) % 4];
        octx.fillStyle = shade(c, sideShade[s]);
        octx.beginPath();
        octx.moveTo(a[0], a[1]);
        octx.lineTo(b[0], b[1]);
        octx.lineTo(b2[0], b2[1]);
        octx.lineTo(a2[0], a2[1]);
        octx.closePath();
        octx.fill();
      }

      if (p.solidFront) {
        octx.fillStyle = shade(c, 1);
        octx.beginPath();
        octx.moveTo(fx0, fy0);
        octx.lineTo(fx1, fy1);
        octx.lineTo(fx2, fy2);
        octx.lineTo(fx3, fy3);
        octx.closePath();
        octx.fill();
      } else {
        octx.save();
        octx.beginPath();
        octx.moveTo(fx0, fy0);
        octx.lineTo(fx1, fy1);
        octx.lineTo(fx2, fy2);
        octx.lineTo(fx3, fy3);
        octx.closePath();
        octx.clip();
        const dw = fx1 - fx0, dh = fy3 - fy0;
        octx.drawImage(srcCanvas, c.x0, c.y0, c.x1 - c.x0, c.y1 - c.y0, fx0, fy0, dw, dh);
        octx.restore();
      }
    }
    return getImageData(out);
  },
});

/* ------------------------------------------------------------------ */
/* Find Edges                                                          */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'find-edges',
  name: 'Find Edges',
  menu: 'Stylize',
  apply(imageData) {
    const { width: w, height: h, data } = imageData;
    const src = premultiply(data);
    let i = 0;
    for (let y = 0; y < h; y++) {
      const yUp = y > 0 ? y - 1 : 0, yDn = y < h - 1 ? y + 1 : h - 1;
      for (let x = 0; x < w; x++, i += 4) {
        const alpha = data[i + 3];
        if (alpha === 0) { data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; continue; }
        const xL = x > 0 ? x - 1 : 0, xR = x < w - 1 ? x + 1 : w - 1;
        const inv = 255 / alpha;
        for (let c = 0; c < 3; c++) {
          const p00 = src[(yUp * w + xL) * 4 + c], p10 = src[(yUp * w + x) * 4 + c], p20 = src[(yUp * w + xR) * 4 + c];
          const p01 = src[(y * w + xL) * 4 + c], p21 = src[(y * w + xR) * 4 + c];
          const p02 = src[(yDn * w + xL) * 4 + c], p12 = src[(yDn * w + x) * 4 + c], p22 = src[(yDn * w + xR) * 4 + c];
          const gx = -p00 + p20 - 2 * p01 + 2 * p21 - p02 + p22;
          const gy = -p00 - 2 * p10 - p20 + p02 + 2 * p12 + p22;
          data[i + c] = 255 - Math.sqrt(gx * gx + gy * gy) * inv;
        }
      }
    }
    return imageData;
  },
});

/* ------------------------------------------------------------------ */
/* Glowing Edges                                                       */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'glowing-edges',
  name: 'Glowing Edges...',
  menu: 'Stylize',
  params: [
    { key: 'edgeWidth', label: 'Edge Width', type: 'slider', min: 1, max: 14, step: 1, default: 2 },
    { key: 'edgeBrightness', label: 'Edge Brightness', type: 'slider', min: 0, max: 20, step: 1, default: 6 },
    { key: 'smoothness', label: 'Smoothness', type: 'slider', min: 1, max: 15, step: 1, default: 5 },
  ],
  apply(imageData, p) {
    const { width: w, height: h, data } = imageData;
    // Smoothness softens the source before edges are traced.
    if (p.smoothness > 1) separableConvolve(imageData, gaussianKernel((p.smoothness - 1) * 0.35));
    const src = premultiply(data);
    const step = Math.max(1, Math.round(p.edgeWidth));
    const gain = (p.edgeBrightness / 5) * (1 / step) * 2.2;
    const a = new Float32Array(4), b = new Float32Array(4), c = new Float32Array(4), d = new Float32Array(4);
    let i = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i += 4) {
        const alpha = data[i + 3];
        if (alpha === 0) { data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; continue; }
        sampleClamp(src, w, h, x - step, y, a);
        sampleClamp(src, w, h, x + step, y, b);
        sampleClamp(src, w, h, x, y - step, c);
        sampleClamp(src, w, h, x, y + step, d);
        const inv = 255 / alpha;
        for (let k = 0; k < 3; k++) {
          const gx = b[k] - a[k], gy = d[k] - c[k];
          data[i + k] = Math.sqrt(gx * gx + gy * gy) * gain * inv;
        }
      }
    }
    if (p.smoothness > 1) separableConvolve(imageData, gaussianKernel((p.smoothness - 1) * 0.25));
    return imageData;
  },
});

/* ------------------------------------------------------------------ */
/* Oil Paint                                                           */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'oil-paint',
  name: 'Oil Paint...',
  menu: 'Stylize',
  dialogWidth: 380,
  params: [
    { key: 'stylization', label: 'Stylization', type: 'slider', min: 0.1, max: 10, step: 0.1, default: 5 },
    { key: 'cleanliness', label: 'Cleanliness', type: 'slider', min: 0, max: 10, step: 0.1, default: 5 },
    { key: 'scale', label: 'Scale', type: 'slider', min: 1, max: 8, step: 1, default: 3 },
    { key: 'bristleDetail', label: 'Bristle Detail', type: 'slider', min: 0, max: 10, step: 0.1, default: 5 },
    { type: 'separator' },
    { key: 'shine', label: 'Shine', type: 'slider', min: 0, max: 10, step: 0.1, default: 2 },
    { key: 'angularDirection', label: 'Angular Direction', type: 'angle', default: 45 },
  ],
  apply(imageData, p) {
    const { width: w, height: h, data } = imageData;
    const R = clamp(Math.round(p.scale), 1, 8);
    const bins = clamp(Math.round(lerp(30, 6, p.cleanliness / 10)), 4, 32);
    const mix = clamp(p.stylization / 10, 0, 1);

    // Bin every pixel by intensity once.
    const binOf = new Uint8Array(w * h);
    for (let i = 0, k = 0; k < w * h; k++, i += 4) {
      const l = luminance(data[i], data[i + 1], data[i + 2]);
      binOf[k] = Math.min(bins - 1, (l * bins / 256) | 0);
    }

    const cnt = new Int32Array(bins);
    const sr = new Float64Array(bins), sg = new Float64Array(bins), sb = new Float64Array(bins), sa = new Float64Array(bins);
    const paint = new Uint8ClampedArray(data.length);

    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - R), y1 = Math.min(h - 1, y + R);
      cnt.fill(0); sr.fill(0); sg.fill(0); sb.fill(0); sa.fill(0);

      const column = (cxx, sign) => {
        if (cxx < 0 || cxx >= w) return;
        for (let yy = y0; yy <= y1; yy++) {
          const idx = yy * w + cxx;
          const bIdx = binOf[idx];
          const i4 = idx * 4;
          const al = data[i4 + 3] / 255;
          cnt[bIdx] += sign;
          sr[bIdx] += sign * data[i4] * al;
          sg[bIdx] += sign * data[i4 + 1] * al;
          sb[bIdx] += sign * data[i4 + 2] * al;
          sa[bIdx] += sign * data[i4 + 3];
        }
      };

      for (let cxx = -R; cxx <= R; cxx++) column(cxx, 1);

      for (let x = 0; x < w; x++) {
        let best = 0, bestN = -1;
        let tr = 0, tg = 0, tb = 0, ta = 0, tn = 0;
        for (let bi = 0; bi < bins; bi++) {
          const n = cnt[bi];
          if (n <= 0) continue;
          tn += n; tr += sr[bi]; tg += sg[bi]; tb += sb[bi]; ta += sa[bi];
          if (n > bestN) { bestN = n; best = bi; }
        }
        const o = (y * w + x) * 4;
        if (tn > 0) {
          const da = sa[best] / bestN;
          const ma = ta / tn;
          // dominant-bin colour blended toward the plain neighbourhood mean
          const outA = da + (ma - da) * (1 - mix);
          if (outA <= 0.5) {
            paint[o] = 0; paint[o + 1] = 0; paint[o + 2] = 0; paint[o + 3] = 0;
          } else {
            const dr = sr[best] / bestN, dg = sg[best] / bestN, db = sb[best] / bestN;
            const mr = tr / tn, mg = tg / tn, mb = tb / tn;
            const inv = 255 / outA;
            paint[o] = (dr + (mr - dr) * (1 - mix)) * inv;
            paint[o + 1] = (dg + (mg - dg) * (1 - mix)) * inv;
            paint[o + 2] = (db + (mb - db) * (1 - mix)) * inv;
            paint[o + 3] = outA;
          }
        }
        column(x - R, -1);
        column(x + R + 1, 1);
      }
    }

    // Bristle relief: light the painted surface using its own luminance as a bump.
    const bump = p.bristleDetail * 0.25;
    const shine = p.shine / 10;
    if (bump > 0 && shine > 0) {
      const ang = deg2rad(p.angularDirection);
      const lx = Math.cos(ang), ly = -Math.sin(ang), lz = 0.75;
      const ll = Math.hypot(lx, ly, lz);
      let i = 0;
      for (let y = 0; y < h; y++) {
        const yUp = y > 0 ? y - 1 : 0, yDn = y < h - 1 ? y + 1 : h - 1;
        for (let x = 0; x < w; x++, i += 4) {
          const xL = x > 0 ? x - 1 : 0, xR = x < w - 1 ? x + 1 : w - 1;
          const gx = (lumAt(paint, (y * w + xR) * 4) - lumAt(paint, (y * w + xL) * 4)) / 255;
          const gy = (lumAt(paint, (yDn * w + x) * 4) - lumAt(paint, (yUp * w + x) * 4)) / 255;
          const nx = -gx * bump, ny = -gy * bump, nz = 1;
          const nl = Math.hypot(nx, ny, nz);
          let dot = (nx * lx + ny * ly + nz * lz) / (nl * ll);
          dot = dot < 0 ? 0 : dot;
          const spec = Math.pow(dot, 24) * shine * 255;
          data[i] = paint[i] + spec;
          data[i + 1] = paint[i + 1] + spec;
          data[i + 2] = paint[i + 2] + spec;
          data[i + 3] = paint[i + 3];
        }
      }
    } else {
      data.set(paint);
    }
    return imageData;
  },
});

/* ------------------------------------------------------------------ */
/* Solarize                                                            */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'solarize',
  name: 'Solarize',
  menu: 'Stylize',
  apply(imageData) {
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 127) d[i] = 255 - d[i];
      if (d[i + 1] > 127) d[i + 1] = 255 - d[i + 1];
      if (d[i + 2] > 127) d[i + 2] = 255 - d[i + 2];
    }
    return imageData;
  },
});

/* ------------------------------------------------------------------ */
/* Tiles                                                               */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'tiles',
  name: 'Tiles...',
  menu: 'Stylize',
  dialogWidth: 380,
  params: [
    { key: 'tiles', label: 'Number Of Tiles', type: 'slider', min: 1, max: 99, step: 1, default: 10 },
    { key: 'maxOffset', label: 'Maximum Offset', type: 'slider', min: 1, max: 99, step: 1, default: 10, unit: '%' },
    {
      key: 'fill', label: 'Fill Empty Area With', type: 'radio', default: 'background',
      options: [
        { value: 'background', label: 'Background Color' },
        { value: 'foreground', label: 'Foreground Color' },
        { value: 'inverse', label: 'Inverse Image' },
        { value: 'unaltered', label: 'Unaltered Image' },
      ],
    },
  ],
  apply(imageData, p, ctx) {
    const w = imageData.width, h = imageData.height;
    const A = (ctx && ctx.app) || app;
    const srcCanvas = imageDataToCanvas(imageData);
    const out = createCanvas(w, h);
    const octx = out.getContext('2d');

    if (p.fill === 'background' || p.fill === 'foreground') {
      octx.fillStyle = toCss(p.fill === 'background' ? A.background : A.foreground);
      octx.fillRect(0, 0, w, h);
    } else if (p.fill === 'inverse') {
      const inv = new ImageData(new Uint8ClampedArray(imageData.data), w, h);
      const d = inv.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2];
      }
      octx.drawImage(imageDataToCanvas(inv), 0, 0);
    } else {
      octx.drawImage(srcCanvas, 0, 0);
    }

    const n = clamp(Math.round(p.tiles), 1, 99);
    const tw = w / n, th = h / n;
    const maxOx = (p.maxOffset / 100) * tw;
    const maxOy = (p.maxOffset / 100) * th;
    const rnd = makeRandom(0x71e5);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const sx = i * tw, sy = j * th;
        const sw = Math.min(tw, w - sx), sh = Math.min(th, h - sy);
        if (sw <= 0 || sh <= 0) continue;
        const dx = sx + (rnd() * 2 - 1) * maxOx;
        const dy = sy + (rnd() * 2 - 1) * maxOy;
        octx.drawImage(srcCanvas, sx, sy, sw, sh, dx, dy, sw, sh);
      }
    }
    return getImageData(out);
  },
});

/* ------------------------------------------------------------------ */
/* Trace Contour                                                       */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'trace-contour',
  name: 'Trace Contour...',
  menu: 'Stylize',
  params: [
    { key: 'level', label: 'Level', type: 'slider', min: 0, max: 255, step: 1, default: 128 },
    {
      key: 'edge', label: 'Edge', type: 'radio', default: 'lower',
      options: [{ value: 'lower', label: 'Lower' }, { value: 'upper', label: 'Upper' }],
    },
  ],
  apply(imageData, p) {
    const { width: w, height: h, data } = imageData;
    const src = new Uint8ClampedArray(data);
    const L = p.level;
    const lower = p.edge === 'lower';
    let i = 0;
    for (let y = 0; y < h; y++) {
      const yU = y > 0 ? y - 1 : y, yD = y < h - 1 ? y + 1 : y;
      for (let x = 0; x < w; x++, i += 4) {
        const xL = x > 0 ? x - 1 : x, xR = x < w - 1 ? x + 1 : x;
        const il = (y * w + xL) * 4, ir = (y * w + xR) * 4;
        const iu = (yU * w + x) * 4, id = (yD * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          // A contour runs where the channel crosses the level between
          // 4-neighbours; `lower` keeps the darker side of each crossing.
          const v = src[i + c] < L;
          const cross =
            (v !== (src[il + c] < L) || v !== (src[ir + c] < L) ||
             v !== (src[iu + c] < L) || v !== (src[id + c] < L)) &&
            (lower ? v : !v);
          data[i + c] = cross ? 0 : 255;
        }
      }
    }
    return imageData;
  },
});

/* ------------------------------------------------------------------ */
/* Wind                                                                */
/* ------------------------------------------------------------------ */

registerFilter({
  id: 'wind',
  name: 'Wind...',
  menu: 'Stylize',
  params: [
    {
      key: 'method', label: 'Method', type: 'radio', default: 'wind',
      options: [{ value: 'wind', label: 'Wind' }, { value: 'blast', label: 'Blast' }, { value: 'stagger', label: 'Stagger' }],
    },
    {
      key: 'direction', label: 'Direction', type: 'radio', default: 'right',
      options: [{ value: 'right', label: 'From The Right' }, { value: 'left', label: 'From The Left' }],
    },
  ],
  apply(imageData, p) {
    const { width: w, height: h, data } = imageData;
    const src = new Uint8ClampedArray(data);
    const rnd = makeRandom(0x7717);
    const dir = p.direction === 'right' ? -1 : 1;
    const method = p.method;
    const maxLen = method === 'blast' ? 30 : method === 'stagger' ? 18 : 11;
    const thresh = method === 'blast' ? 10 : 18;
    const density = method === 'wind' ? 0.45 : 0.72;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const nx = x - dir;
        if (nx < 0 || nx >= w) continue;
        const i = (y * w + x) * 4, j = (y * w + nx) * 4;
        const diff = Math.abs(lumAt(src, i) - lumAt(src, j)) + Math.abs(src[i + 3] - src[j + 3]);
        if (diff < thresh) continue;
        if (rnd() > density) continue;
        const len = 2 + Math.floor(rnd() * (maxLen * Math.min(1, diff / 160) + 2));
        let yy = y;
        for (let k = 1; k <= len; k++) {
          const xx = x + dir * k;
          if (xx < 0 || xx >= w) break;
          if (method === 'stagger' && k % 3 === 0) yy += rnd() < 0.5 ? -1 : 1;
          if (yy < 0 || yy >= h) break;
          const t = (1 - k / (len + 1)) * 0.85;
          const o = (yy * w + xx) * 4;
          // Streak the *upwind* neighbour's colour: `x` sits on the near side of
          // the edge, so smearing its own colour back over its own region would
          // be invisible. `nx` holds the colour the wind has to carry across.
          const a1 = src[j + 3], a2 = data[o + 3];
          const na = a2 + (a1 - a2) * t;
          if (na <= 0.5) { data[o + 3] = 0; continue; }
          for (let c = 0; c < 3; c++) {
            data[o + c] = (data[o + c] * a2 * (1 - t) + src[j + c] * a1 * t) / na;
          }
          data[o + 3] = na;
        }
      }
    }
    return imageData;
  },
});
