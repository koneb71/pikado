import { suite } from '../harness.js';
import { runFilter } from '/src/filters/registry.js';
import { applyLiquifyMesh, createLiquifyMesh, liquifyDab, previewLiquifyOnGPU } from '/src/filters/distort.js';
import { gpuReady, setGPUEnabled, GPU_MIN_PIXELS } from '/src/render/gpu-device.js';
import { runStagesOnGPU, gpuFiltersBroken, gpuFilterStats } from '/src/render/gpu-filters.js';
import { warpOnGPU, warpStage, WARP_MAP, WARP_EDGE } from '/src/render/gpu-warp.js';
import { createCanvas, ctx2dRead } from '/src/core/util.js';

/**
 * Filters on WebGPU: the shared plumbing (src/render/gpu-filters.js) and the
 * warp stage behind Filter > Distort and Liquify (src/render/gpu-warp.js).
 *
 * A GPU filter returns what `getImageData(putImageData(x))` gives for the CPU
 * filter's result `x` — the next thing every caller does with it. So each
 * comparison puts the CPU result through that same round trip first; what
 * remains is float32 against float64 arithmetic and the trig, a count here and
 * there.
 */

async function needDevice(t) {
  if (await gpuReady()) return true;
  t.ok(true, 'WebGPU is not available in this browser — GPU filter parity NOT exercised here');
  return false;
}

/** What a canvas stores for these bytes: the round trip every filter result takes. */
function canvasRoundTrip(img) {
  const c = createCanvas(img.width, img.height);
  c.getContext('2d').putImageData(img, 0, 0);
  return ctx2dRead(c).getImageData(0, 0, img.width, img.height);
}

/** A photo-like fixture: gradients, hard and soft edges, and a translucent band. */
function fixture(w = 480, h = 320) {
  const c = createCanvas(w, h);
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#1d3b72');
  g.addColorStop(0.5, '#e8b04a');
  g.addColorStop(1, '#2f8f5b');
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);
  x.fillStyle = '#ffffff';
  for (let i = 0; i < 12; i++) x.fillRect((i * w) / 12, 0, 2, h);
  x.fillStyle = '#c0182a';
  x.beginPath();
  x.arc(w * 0.4, h * 0.55, h * 0.25, 0, Math.PI * 2);
  x.fill();
  x.clearRect(w * 0.75, h * 0.1, w * 0.2, h * 0.3);
  const img = ctx2dRead(c).getImageData(0, 0, w, h);
  // A translucent band: alpha falls across it, so premultiplied rounding shows.
  for (let y = Math.floor(h * 0.7); y < Math.floor(h * 0.85); y++) {
    for (let xx = 0; xx < w; xx++) img.data[(y * w + xx) * 4 + 3] = 20 + Math.floor((xx / w) * 220);
  }
  return img;
}

const clone = (img) => new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);

/**
 * Per-channel differences: the worst, how many pixels exceed `tol`, the mean.
 * Colour is only compared where both are at least half opaque — below that a
 * count of premultiplied rounding is 255/alpha counts of colour either way.
 */
function diff(a, b, tol = 2) {
  const A = a.data, B = b.data;
  let worst = 0, over = 0, sum = 0;
  for (let i = 0; i < A.length; i += 4) {
    let m = Math.abs(A[i + 3] - B[i + 3]);
    sum += m;
    if (A[i + 3] >= 128 && B[i + 3] >= 128) {
      for (let k = 0; k < 3; k++) {
        const d = Math.abs(A[i + k] - B[i + k]);
        sum += d;
        if (d > m) m = d;
      }
    }
    if (m > worst) worst = m;
    if (m > tol) over++;
  }
  return { worst, over, mean: sum / (A.length), pixels: A.length / 4 };
}

/** Run `fn` with WebGPU on, then off; `ran` says whether the GPU took the first run. */
function bothWays(fn) {
  try {
    setGPUEnabled(true);
    const before = gpuFilterStats().runs;
    const gpu = fn();
    const ran = gpuFilterStats().runs > before;
    setGPUEnabled(false);
    const cpu = canvasRoundTrip(fn());
    return { gpu, cpu, ran };
  } finally {
    setGPUEnabled(true);
  }
}

/* ================================================================== */

suite('gpu filters / the readback is exactly a canvas round trip', async (t) => {
  // Verified to fail with the present pass truncating (c * a / 255, floored)
  // instead of rounding: translucent colours came back up to 2 counts low.
  if (!(await needDevice(t))) return;
  // Every (colour, alpha) pair: x is the colour, y the alpha, twice over.
  const w = 512, h = 256;
  const img = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      img.data[i] = x & 255; img.data[i + 1] = 255 - (x & 255); img.data[i + 2] = (x * 7) & 255;
      img.data[i + 3] = y;
    }
  }
  t.gt(w * h, GPU_MIN_PIXELS, 'precondition: the image is big enough for the GPU');
  const expected = canvasRoundTrip(img);
  const got = runStagesOnGPU(clone(img), [{ kind: 'copy' }]);
  t.ok(got instanceof ImageData, 'a copy stage runs on the GPU');
  const d = diff(got, expected, 0);
  t.eq(d.worst, 0, `every colour at every alpha reads back as a canvas would store it (worst ${d.worst})`);
});

suite('gpu filters / every distortion matches the CPU', async (t) => {
  if (!(await needDevice(t))) return;
  const base = fixture();
  const cases = [
    ['displace, perlin, repeat edges', 'displace', { horizontal: 25, vertical: -18 }],
    ['displace, checkers tiled, wrap', 'displace', { mapType: 'checkers', fit: 'tile', detail: 20, undefinedAreas: 'wrap' }],
    ['pinch +60%', 'pinch', { amount: 60 }],
    ['pinch -80% (bulge)', 'pinch', { amount: -80 }],
    ['polar, rectangular to polar', 'polar-coordinates', { mode: 'rect2polar' }],
    ['polar, polar to rectangular', 'polar-coordinates', { mode: 'polar2rect' }],
    ['ripple, large', 'ripple', { amount: 300, size: 'large' }],
    ['shear, wrap', 'shear', { amount: 60, frequency: 2, undefinedAreas: 'wrap' }],
    ['spherize', 'spherize', { amount: 100 }],
    ['spherize, horizontal, -70%', 'spherize', { amount: -70, mode: 'horizontal' }],
    ['spherize, vertical', 'spherize', { amount: 80, mode: 'vertical' }],
    ['twirl 300°', 'twirl', { angle: 300 }],
    ['twirl -999°', 'twirl', { angle: -999 }],
    ['wave, triangle, wrap', 'wave', { type: 'triangle', undefinedAreas: 'wrap' }],
    ['wave, square', 'wave', { type: 'square' }],
    ['zigzag, pond', 'zigzag', { amount: 70, ridges: 7 }],
    ['zigzag, around centre', 'zigzag', { amount: -60, ridges: 4, style: 'around' }],
    ['zigzag, out from centre', 'zigzag', { amount: 90, ridges: 9, style: 'out' }],
  ];
  for (const [label, id, params] of cases) {
    const { gpu, cpu, ran } = bothWays(() => runFilter(id, clone(base), params));
    t.ok(ran, `${label}: the GPU ran it`);
    const d = diff(gpu, cpu);
    // A pixel lands on the other side of a square wave's step, or of the
    // polar seam, only where the two disagree in the last float32 bit.
    t.lt(d.over, d.pixels * 0.0001 + 1, `${label}: within 2 counts everywhere but ${d.over} px (worst ${d.worst})`);
    t.lt(d.mean, 0.05, `${label}: mean difference ${d.mean.toFixed(4)}`);
  }
  t.ok(!gpuFiltersBroken(), 'no WebGPU validation error switched the GPU filters off');
});

suite('gpu filters / trig accurate far from the centre', async (t) => {
  // WGSL only promises sin/cos to 2^-11 and atan2 to 4096 ULP; at a radius of
  // 800 that is most of a pixel. Some GPUs' builtins are far better than the
  // promise (Apple's, in Chrome, pass this as they are), so the shader uses
  // its own (wgsl-math.js). Verified to fail with the builtins rounded to the
  // promised 2^-11: the 720° twirl was off by up to 42 counts at 15 835
  // pixels, the polar conversion by 16 at 17 918.
  if (!(await needDevice(t))) return;
  const big = fixture(1600, 1200);
  for (const [label, id, params] of [
    ['twirl 720° at 1600x1200', 'twirl', { angle: 720 }],
    ['rectangular to polar at 1600x1200', 'polar-coordinates', { mode: 'rect2polar' }],
  ]) {
    const { gpu, cpu, ran } = bothWays(() => runFilter(id, clone(big), params));
    t.ok(ran, `${label}: the GPU ran it`);
    const d = diff(gpu, cpu);
    t.lt(d.over, d.pixels * 0.0001 + 1, `${label}: within 2 counts everywhere but ${d.over} px (worst ${d.worst})`);
    t.lt(d.mean, 0.05, `${label}: mean difference ${d.mean.toFixed(4)}`);
  }
});

suite('gpu filters / Liquify matches the CPU, and its preview skips the readback', async (t) => {
  if (!(await needDevice(t))) return;
  const base = fixture(600, 400);
  const mesh = createLiquifyMesh();
  const dab = (mode, u, v, extra = {}) => liquifyDab(mesh, {
    u, v, mode, radius: 120, pressure: 0.8, aspectW: 600, aspectH: 400, ...extra,
  });
  dab('push', 0.3, 0.4, { vx: 0.05, vy: 0.02 });
  dab('twirl-cw', 0.6, 0.5);
  dab('bloat', 0.45, 0.7);
  const { gpu, cpu, ran } = bothWays(() => applyLiquifyMesh(clone(base), mesh));
  t.ok(ran, 'the GPU ran the Liquify warp');
  const d = diff(gpu, cpu);
  t.gt(diff(cpu, canvasRoundTrip(base)).mean, 1, 'precondition: the mesh really moves pixels');
  t.lt(d.over, d.pixels * 0.0001 + 1, `the warp is within 2 counts everywhere but ${d.over} px (worst ${d.worst})`);
  t.lt(d.mean, 0.05, `mean difference ${d.mean.toFixed(4)}`);
  // Far from every dab the mesh is zero and nothing may move.
  const corner = (img) => { const o = []; for (let y = 0; y < 20; y++) for (let x = 560; x < 600; x++) o.push(...img.data.slice((y * 600 + x) * 4, (y * 600 + x) * 4 + 4)); return o; };
  const cg = corner(gpu), cc = corner(cpu);
  let worst = 0;
  for (let i = 0; i < cg.length; i++) worst = Math.max(worst, Math.abs(cg[i] - cc[i]));
  t.lt(worst, 2, `an untouched corner is unchanged on both (worst ${worst})`);

  // The preview: straight into the view canvas, never through putImageData.
  const view = createCanvas(600, 400);
  const vctx = view.getContext('2d');
  const proto = CanvasRenderingContext2D.prototype;
  const original = proto.putImageData;
  let puts = 0;
  proto.putImageData = function (...args) { if (this === vctx) puts++; return original.apply(this, args); };
  let ok;
  try {
    ok = previewLiquifyOnGPU(base, mesh, vctx);
  } finally {
    proto.putImageData = original;
  }
  t.ok(ok, 'the Liquify preview draws on the GPU');
  t.eq(puts, 0, 'without a single putImageData on the view');
  const shown = ctx2dRead(view).getImageData(0, 0, 600, 400);
  t.lt(diff(shown, gpu).worst, 1, 'and it shows exactly what the full warp computes');
});

suite('gpu filters / what stays on the CPU', async (t) => {
  const small = fixture(250, 200);
  t.lt(250 * 200, GPU_MIN_PIXELS, 'precondition: under GPU_MIN_PIXELS');
  const stage = warpStage(WARP_MAP.TWIRL, WARP_EDGE.CLAMP, [124.5, 99.5, 99.5, 1]);
  t.is(warpOnGPU(clone(small), stage), null, 'a small image is declined');
  const a = runFilter('twirl', clone(small), { angle: 200 });
  setGPUEnabled(false);
  let b;
  try {
    t.is(warpOnGPU(clone(fixture()), stage), null, 'with WebGPU switched off, every image is declined');
    b = runFilter('twirl', clone(small), { angle: 200 });
  } finally {
    setGPUEnabled(true);
  }
  t.eq(diff(a, b, 0).worst, 0, 'so a small twirl is byte-identical with WebGPU on or off');
  t.is(runStagesOnGPU(clone(fixture()), [{ kind: 'no-such-stage' }]), null, 'an unknown stage declines the whole run');
});
