import { suite } from '../harness.js';
import { runFilter, makeRandom } from '/src/filters/registry.js';
import { gpuReady, setGPUEnabled, GPU_MIN_PIXELS } from '/src/render/gpu-device.js';
import { gpuFilterStats } from '/src/render/gpu-filters.js';
import { xorshiftJump, filterOnGPU } from '/src/render/gpu-image-filters.js';
import { premultiplyImageData, gaussianBlurBuffer, unpremultiplyInto, gaussianBlurGPUStage } from '/src/filters/blur.js';
import { supportsCanvasFilter } from '/src/render/fast-blur.js';
import { createCanvas, ctx2dRead } from '/src/core/util.js';

/**
 * The heavy filters on WebGPU (src/render/gpu-image-filters.js): sharpening,
 * the blurs, High Pass, Surface and Smart Blur, Median, Dust & Scratches,
 * Despeckle and Add Noise.
 *
 * As in gpu-filters.test.js, a GPU filter returns what
 * `getImageData(putImageData(x))` gives for the CPU result `x`, so each CPU
 * result goes through that round trip before the comparison. What is left is
 * float32 against float64: a count at a rounding boundary, here and there.
 */

async function needDevice(t) {
  if (await gpuReady()) return true;
  t.ok(true, 'WebGPU is not available in this browser — GPU image filter parity NOT exercised here');
  return false;
}

function canvasRoundTrip(img) {
  const c = createCanvas(img.width, img.height);
  c.getContext('2d').putImageData(img, 0, 0);
  return ctx2dRead(c).getImageData(0, 0, img.width, img.height);
}

/** Gradients, hard and soft edges, fine noise, a hole and a translucent band. */
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
  // Speckle: what Median, Dust & Scratches and Despeckle are for.
  const rand = makeRandom(99);
  for (let k = 0; k < 2500; k++) {
    const i = Math.floor(rand() * w * h) * 4;
    if (img.data[i + 3] === 0) continue;
    const v = rand() < 0.5 ? 0 : 255;
    img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v;
  }
  // A translucent band: alpha falls across it, so premultiplied rounding shows.
  for (let y = Math.floor(h * 0.7); y < Math.floor(h * 0.85); y++) {
    for (let xx = 0; xx < w; xx++) img.data[(y * w + xx) * 4 + 3] = 20 + Math.floor((xx / w) * 220);
  }
  return img;
}

const clone = (img) => new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);

/** Worst channel difference (colour only where both are at least half opaque), count over `tol`, mean. */
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
  return { worst, over, mean: sum / A.length, pixels: A.length / 4 };
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

/**
 * GPU against CPU for each case: within 2 counts except at most 0.01% of
 * pixels, mean under 0.05 — or exactly equal when `exact`. `reference`, when
 * given, computes the CPU side instead of the filter with WebGPU off; `run`
 * replaces runFilter for the GPU side.
 */
function parity(t, cases, { exact = false, reference = null, run = runFilter } = {}) {
  const base = fixture();
  t.gt(base.width * base.height, GPU_MIN_PIXELS, 'precondition: the fixture is big enough for the GPU');
  for (const [id, params, label] of cases) {
    const name = label || `${id} ${JSON.stringify(params)}`;
    const both = bothWays(() => run(id, clone(base), params));
    const { gpu, ran } = both;
    const cpu = reference ? canvasRoundTrip(reference(clone(base), params)) : both.cpu;
    t.ok(ran, `${name}: ran on the GPU`);
    const d = diff(gpu, cpu, exact ? 0 : 2);
    if (exact) {
      t.eq(d.worst, 0, `${name}: identical to the CPU (worst ${d.worst}, ${d.over} pixels differ)`);
    } else {
      t.ok(d.over <= Math.ceil(d.pixels * 1e-4) && d.mean < 0.05,
        `${name}: matches the CPU (worst ${d.worst}, ${d.over} pixels over 2, mean ${d.mean.toFixed(4)})`);
    }
  }
}

/* ================================================================== */

suite('gpu image filters / Add Noise jumps ahead to the very numbers the CPU draws', (t) => {
  // Verified to fail with the generator's >> 17 taken as a logical shift
  // (>>> 17) when building the matrices: every seed went wrong within its
  // first six draws, and the long jump missed.
  for (const seed of [1, 2, 8, 12346, 0xdeadbeef]) {
    const rand = makeRandom(seed);
    let ok = true, first = -1;
    for (let q = 0; q < 5000; q++) {
      const want = Math.round(rand() * 4294967296);
      // Draw q (0-based) is the state after q + 1 steps.
      if (xorshiftJump(seed, q + 1) !== want) { ok = false; first = q; break; }
    }
    t.ok(ok, `seed ${seed}: the first 5000 draws match makeRandom${ok ? '' : ` (first mismatch at draw ${first})`}`);
  }
  // A long jump, against stepping there one draw at a time.
  const rand = makeRandom(7);
  let s = 0;
  for (let q = 0; q < 3_000_001; q++) s = Math.round(rand() * 4294967296);
  t.eq(xorshiftJump(7, 3_000_001), s, 'and a jump of three million steps lands on the same state');
});

suite('gpu image filters / sharpening matches the CPU', async (t) => {
  // Verified to fail with the Sobel gate ignored in the shader (Sharpen Edges:
  // worst 91, 640 pixels over 2) and with the hard threshold the wrong way
  // round (Unsharp Mask's threshold case: worst 136).
  if (!(await needDevice(t))) return;
  parity(t, [
    ['sharpen', {}],
    ['sharpen-more', {}],
    ['sharpen-edges', {}],
    ['unsharp-mask', { amount: 150, radius: 1.5, threshold: 0 }],
    ['unsharp-mask', { amount: 300, radius: 6, threshold: 8 }],
    ['unsharp-mask', { amount: 80, radius: 40, threshold: 0 }],
    ['smart-sharpen', { amount: 200, radius: 1.5, reduceNoise: 30, remove: 'gaussian' }],
  ]);
});

/** Gaussian Blur's JS passes: what it gives in browsers without a canvas blur. */
function gaussianReference(img, p) {
  const buf = premultiplyImageData(img);
  gaussianBlurBuffer(buf, img.width, img.height, p.radius, 4);
  unpremultiplyInto(buf, img);
  return img;
}

suite('gpu image filters / the blurs match the CPU', async (t) => {
  // Verified to fail with the box pass's running sum keeping the sample that
  // leaves the window (worst 255), and with Blur More as one combined pass
  // instead of three rounded ones (worst 11, 312 pixels over 2).
  if (!(await needDevice(t))) return;
  // Gaussian Blur's GPU stage computes the JS passes' maths, so it is compared
  // with them (Chrome's canvas blur differs from those by up to 40 counts at
  // radius 8, on translucent edges).
  const gaussOnGPU = (id, img, p) => { filterOnGPU(img, gaussianBlurGPUStage(p.radius)); return img; };
  parity(t, [
    ['gaussian-blur', { radius: 1.5 }, 'gaussian-blur 1.5 (a kernel)'],
    ['gaussian-blur', { radius: 8 }, 'gaussian-blur 8 (three boxes)'],
    ['gaussian-blur', { radius: 60 }],
  ], { reference: gaussianReference, run: gaussOnGPU });
  // The filter itself takes the browser's canvas blur where there is one
  // (faster than the GPU's readback), and the GPU stage elsewhere.
  const canvasBlur = supportsCanvasFilter();
  const before = gpuFilterStats().runs;
  runFilter('gaussian-blur', clone(fixture()), { radius: 8 });
  t.eq(gpuFilterStats().runs > before, !canvasBlur,
    canvasBlur ? 'Gaussian Blur used this browser\'s canvas blur' : 'Gaussian Blur ran on the GPU (no canvas blur here)');
  parity(t, [
    ['box-blur', { radius: 5 }],
    ['blur', {}],
    ['blur-more', {}],
  ]);
});

suite('gpu image filters / High Pass, Surface Blur and Smart Blur match the CPU', async (t) => {
  // Verified to fail with High Pass blurred through the Gaussian's small-sigma
  // kernel instead of its own three boxes (radius 3: worst 14, 748 pixels
  // over 2), and with Surface Blur's tent weight replaced by Smart Blur's
  // step (worst 39).
  if (!(await needDevice(t))) return;
  parity(t, [
    ['high-pass', { radius: 0.1 }, 'high-pass 0.1 (no blur at all)'],
    ['high-pass', { radius: 3 }],
    ['high-pass', { radius: 25 }],
    ['surface-blur', { radius: 5, threshold: 15 }],
    ['surface-blur', { radius: 30, threshold: 40 }],
    ['smart-blur', { radius: 5, threshold: 25, quality: 'medium', mode: 'normal' }],
    ['smart-blur', { radius: 12, threshold: 10, quality: 'high', mode: 'normal' }],
  ]);
});

suite('gpu image filters / Median, Dust & Scratches and Despeckle', async (t) => {
  // Verified to fail with the median's rank one too high (the 1-based middle
  // instead of the 0-based one): worst 198 to 255 on the speckled fixture.
  if (!(await needDevice(t))) return;
  // Median is an integer selection on both sides: exactly equal.
  parity(t, [
    ['median', { radius: 1 }],
    ['median', { radius: 3 }],
    ['median', { radius: 5 }],
    ['dust-scratches', { radius: 2, threshold: 12 }],
    ['dust-scratches', { radius: 4, threshold: 0 }],
  ], { exact: true });
  parity(t, [['despeckle', {}]]);
});

suite('gpu image filters / Add Noise matches the CPU draw for draw', async (t) => {
  // Verified to fail with each pixel's draws starting one later: worst 64 to
  // 181, most pixels moved.
  if (!(await needDevice(t))) return;
  parity(t, [
    ['add-noise', { amount: 25, distribution: 'uniform', monochromatic: false, seed: 1 }],
    ['add-noise', { amount: 25, distribution: 'uniform', monochromatic: true, seed: 3 }],
    ['add-noise', { amount: 40, distribution: 'gaussian', monochromatic: false, seed: 7 }],
    ['add-noise', { amount: 40, distribution: 'gaussian', monochromatic: true, seed: 12345 }],
  ]);
});

suite('gpu image filters / what stays on the CPU', async (t) => {
  // Verified to fail with the median's radius limit removed: Median at 6 and
  // Dust & Scratches at 9 ran on the GPU.
  if (!(await needDevice(t))) return;
  const base = fixture();
  for (const [id, params] of [
    ['median', { radius: 6 }],
    ['dust-scratches', { radius: 9, threshold: 4 }],
    ['smart-blur', { radius: 5, threshold: 25, quality: 'medium', mode: 'edge-only' }],
    ['smart-sharpen', { amount: 150, radius: 3, reduceNoise: 10, remove: 'lens' }],
    ['smart-sharpen', { amount: 150, radius: 3, reduceNoise: 10, remove: 'motion', angle: 30 }],
  ]) {
    const before = gpuFilterStats().runs;
    const on = runFilter(id, clone(base), params);
    t.eq(gpuFilterStats().runs, before, `${id} ${JSON.stringify(params)}: declined, the CPU ran it`);
    setGPUEnabled(false);
    let off;
    try { off = runFilter(id, clone(base), params); } finally { setGPUEnabled(true); }
    t.eq(diff(on, off, 0).worst, 0, `${id}: byte for byte the CPU result either way`);
  }
  // Under GPU_MIN_PIXELS nothing goes to the GPU.
  const small = fixture(200, 150);
  const before = gpuFilterStats().runs;
  runFilter('unsharp-mask', clone(small), { amount: 150, radius: 2, threshold: 0 });
  t.eq(gpuFilterStats().runs, before, 'a 200x150 image sharpens on the CPU');
});
