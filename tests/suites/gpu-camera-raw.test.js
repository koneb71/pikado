import { suite } from '../harness.js';
import { runFilter } from '/src/filters/registry.js';
import { developOnGPU, developPlan } from '/src/filters/camera-raw.js';
import { gpuReady, setGPUEnabled } from '/src/render/gpu-device.js';
import { gpuFilterStats, gpuFiltersBroken } from '/src/render/gpu-filters.js';
import { createCanvas, ctx2dRead } from '/src/core/util.js';

/**
 * Filter > Camera Raw on WebGPU (src/render/gpu-develop.js).
 *
 * Each case develops the same image with WebGPU on and off and compares, the
 * CPU result put through the canvas round trip a filter result always takes
 * (see gpu-filters.test.js). Every stage is exercised on its own — so a
 * mistake names its stage — and then all together.
 */

async function needDevice(t) {
  if (await gpuReady()) return true;
  t.ok(true, 'WebGPU is not available in this browser — Camera Raw on the GPU NOT exercised here');
  return false;
}

function canvasRoundTrip(img) {
  const c = createCanvas(img.width, img.height);
  c.getContext('2d').putImageData(img, 0, 0);
  return ctx2dRead(c).getImageData(0, 0, img.width, img.height);
}

/** Photo-like: a sky gradient, saturated objects, deep shadows, noise and a soft edge. */
function photo(w = 400, h = 300) {
  const c = createCanvas(w, h);
  const x = c.getContext('2d');
  const sky = x.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#5b8fd6'); sky.addColorStop(0.6, '#e9d3a8'); sky.addColorStop(1, '#3a2a1a');
  x.fillStyle = sky; x.fillRect(0, 0, w, h);
  const colours = ['#d62828', '#f77f00', '#fcbf49', '#2a9d8f', '#3a86ff', '#8338ec', '#ff006e', '#06d6a0'];
  colours.forEach((col, i) => { x.fillStyle = col; x.fillRect(20 + i * (w - 40) / 8, h * 0.55, (w - 60) / 8, h * 0.2); });
  x.fillStyle = '#0a0a0a'; x.fillRect(0, h * 0.85, w * 0.4, h * 0.15);
  x.fillStyle = 'rgba(255,255,255,0.9)'; x.beginPath(); x.arc(w * 0.75, h * 0.25, h * 0.12, 0, Math.PI * 2); x.fill();
  const img = ctx2dRead(c).getImageData(0, 0, w, h);
  let s = 12345;
  for (let i = 0; i < img.data.length; i += 4) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const n = ((s >>> 16) % 13) - 6;
    for (let k = 0; k < 3; k++) img.data[i + k] = Math.max(0, Math.min(255, img.data[i + k] + n));
  }
  return img;
}

const clone = (img) => new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);

function compare(a, b) {
  let worst = 0, sum = 0;
  for (let i = 0; i < a.data.length; i++) {
    if ((i & 3) === 3) continue;
    const d = Math.abs(a.data[i] - b.data[i]);
    if (d > worst) worst = d;
    sum += d;
  }
  return { worst, mean: sum / (a.data.length * 0.75) };
}

function develop(base, params) {
  try {
    setGPUEnabled(true);
    const before = gpuFilterStats().runs;
    const gpu = runFilter('camera-raw', clone(base), params);
    const ran = gpuFilterStats().runs > before;
    setGPUEnabled(false);
    const cpu = canvasRoundTrip(runFilter('camera-raw', clone(base), params));
    return { gpu, cpu, ran };
  } finally {
    setGPUEnabled(true);
  }
}

suite('gpu camera raw / each stage matches the CPU develop', async (t) => {
  if (!(await needDevice(t))) return;
  const base = photo();
  const cases = [
    ['exposure +1.3', { exposure: 1.3 }],
    ['white balance', { temperature: 60, tint: -40 }],
    ['tone regions', { highlights: -70, shadows: 80, whites: 30, blacks: -25 }],
    ['contrast +60', { contrast: 60 }],
    ['contrast -50', { contrast: -50 }],
    ['tone curve', { curves: { rgb: [{ x: 0, y: 0 }, { x: 90, y: 60 }, { x: 255, y: 255 }], r: [{ x: 0, y: 20 }, { x: 255, y: 235 }], g: null, b: [{ x: 0, y: 0 }, { x: 128, y: 150 }, { x: 255, y: 255 }] } }],
    ['clarity +80 (the box blur)', { clarity: 80 }],
    ['texture -60 (kernel blur and detail)', { texture: -60 }],
    ['colour mixer', { redHue: 40, orangeSat: -70, blueLum: 50, greenSat: 60, magentaHue: -30, aquaLum: -40 }],
    ['vibrance and saturation', { vibrance: 70, saturation: -30 }],
    ['black and white with the mixer', { treatment: 'bw', redLum: 60, blueLum: -50 }],
    ['colour grading', { highlightSat: 60, shadowSat: 50, highlightHue: 40, shadowHue: 210, splitBalance: 30 }],
    ['sharpening', { sharpenAmount: 120, sharpenRadius: 1.4, sharpenDetail: 60 }],
    ['noise reduction', { noiseLuminance: 70, noiseColor: 60 }],
    ['grain', { grain: 70, grainSize: 60 }],
    ['vignette', { vignette: -70, vignetteMidpoint: 30 }],
  ];
  for (const [label, params] of cases) {
    const { gpu, cpu, ran } = develop(base, params);
    t.ok(ran, `${label}: the GPU ran it`);
    const d = compare(gpu, cpu);
    t.lt(d.worst, 3, `${label}: within 2 levels of the CPU (worst ${d.worst})`);
    t.lt(d.mean, 0.1, `${label}: mean difference ${d.mean.toFixed(4)}`);
  }
  t.ok(!gpuFiltersBroken(), 'no WebGPU validation error switched the GPU filters off');
});

suite('gpu camera raw / everything at once, and a large clarity', async (t) => {
  if (!(await needDevice(t))) return;
  const all = {
    temperature: -30, tint: 15, exposure: 0.4, contrast: 25, highlights: -40, shadows: 35, whites: 10,
    blacks: -10, texture: 30, clarity: 40, vibrance: 30, saturation: 10, orangeSat: -20, blueHue: 25,
    highlightSat: 20, shadowSat: 25, sharpenAmount: 60, noiseLuminance: 30, noiseColor: 40,
    grain: 25, vignette: -30,
  };
  const r = develop(photo(), all);
  t.ok(r.ran, 'the GPU ran the full develop');
  const d = compare(r.gpu, r.cpu);
  t.lt(d.worst, 4, `every stage at once: within 3 levels (worst ${d.worst})`);
  t.lt(d.mean, 0.1, `mean difference ${d.mean.toFixed(4)}`);

  const big = develop(photo(1200, 800), { clarity: 70 });
  t.ok(big.ran, 'a 1200x800 clarity ran on the GPU (sigma 4: three box passes)');
  const db = compare(big.gpu, big.cpu);
  t.lt(db.worst, 3, `and matches the CPU within 2 levels (worst ${db.worst})`);
});

suite('gpu camera raw / what stays on the CPU', async (t) => {
  const base = photo();
  const before = gpuFilterStats().runs;
  const neutral = runFilter('camera-raw', clone(base), {});
  t.eq(gpuFilterStats().runs, before, 'a neutral develop never reaches the GPU');
  t.eq(compare(neutral, base).worst, 0, 'and hands the pixels back untouched');

  t.is(developPlan({ dehaze: 40 }, 400, 300), null, 'Dehaze has no GPU plan (it needs a whole-image percentile)');
  const b2 = gpuFilterStats().runs;
  const a = runFilter('camera-raw', clone(base), { dehaze: 40, exposure: 0.5 });
  t.eq(gpuFilterStats().runs, b2, 'so a develop with Dehaze runs on the CPU');
  setGPUEnabled(false);
  let b;
  try {
    b = runFilter('camera-raw', clone(base), { dehaze: 40, exposure: 0.5 });
    t.is(developOnGPU(clone(base), { exposure: 1 }), null, 'with WebGPU off the GPU develop declines');
  } finally {
    setGPUEnabled(true);
  }
  t.eq(compare(a, b).worst, 0, 'byte-identical with WebGPU on or off');
});
