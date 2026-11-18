import { suite } from '../harness.js';
import { compositeDocument } from '/src/render/compositor.js';
import { createRasterLayer } from '/src/core/layer.js';
import { DEFAULT_STYLES, renderers, alphaOf, belowEffectResults } from '/src/effects/styles.js';
import { gpuReady, getGPUDevice, setGPUEnabled } from '/src/render/gpu-device.js';
import { effectFieldOnGPU, GPU_MIN_PIXELS, gpuEffectsBroken } from '/src/render/gpu-effects.js';
import { createCanvas, ctx2dRead } from '/src/core/util.js';

/**
 * Drop shadow, outer glow, inner shadow and inner glow on WebGPU
 * (src/render/gpu-effects.js, with Spread / Choke / Inner Glow's falloff from
 * src/render/gpu-distance.js).
 *
 * The GPU path replaces the CPU renderer wholesale for big regions, so the
 * thing to guard is that the two agree. Every parity case renders the SAME
 * environment twice — WebGPU on, then off — and compares. A real disagreement
 * (an offset with the wrong sign, a blur branch picked at the wrong radius, noise
 * hashed from the wrong index, colour unpremultiplied twice) moves alpha by tens
 * of counts; what is left after a faithful port is 8-bit rounding, the Canvas2D
 * blur the CPU path uses for radii up to 16 rounding its input and output to
 * bytes, and f32 against f64 sums: a few counts at most, at a handful of pixels.
 *
 * Where the browser has no WebGPU these suites say so in a visible assertion
 * rather than passing on nothing.
 */

/** A region comfortably above GPU_MIN_PIXELS with soft and hard edges and a half-transparent block. */
function makeEnv(w = 700, h = 500) {
  const c = createCanvas(w, h);
  const x = c.getContext('2d');
  x.fillStyle = 'rgb(200,30,30)';
  x.beginPath();
  x.ellipse(w / 2, h / 2, w * 0.3, h * 0.25, 0.3, 0, Math.PI * 2);
  x.fill();
  x.globalAlpha = 0.5;
  x.fillRect(w * 0.1, h * 0.1, w * 0.15, h * 0.2);
  let alpha = null;
  const env = {
    w, h, src: c, layer: {}, doc: {}, styles: {}, globalLight: 120,
    offsetX: 0, offsetY: 0, docW: w, docH: h, alphaReads: 0,
    get alpha() {
      env.alphaReads++;
      if (!alpha) alpha = alphaOf(c);
      return alpha;
    },
  };
  return env;
}

/**
 * Alpha: worst and mean difference. RGB: worst difference where both sides are
 * at least half opaque. Both paths store premultiplied bytes, and reading one
 * back divides by alpha, so a single count of rounding becomes 255 / alpha
 * counts of colour — four at alpha 64 on a channel like #e3, whichever path
 * rendered it. From alpha 128 up that is at most two.
 */
function compare(a, b) {
  const A = ctx2dRead(a).getImageData(0, 0, a.width, a.height).data;
  const B = ctx2dRead(b).getImageData(0, 0, b.width, b.height).data;
  let maxAlpha = 0, sumAlpha = 0, maxRGB = 0, inked = 0;
  for (let i = 0; i < A.length; i += 4) {
    const da = Math.abs(A[i + 3] - B[i + 3]);
    if (da > maxAlpha) maxAlpha = da;
    sumAlpha += da;
    if (B[i + 3] > 0) inked++;
    if (A[i + 3] >= 128 && B[i + 3] >= 128) {
      for (let k = 0; k < 3; k++) maxRGB = Math.max(maxRGB, Math.abs(A[i + k] - B[i + k]));
    }
  }
  return { maxAlpha, meanAlpha: sumAlpha / (A.length / 4), maxRGB, inked };
}

function bytesEqual(a, b) {
  const A = ctx2dRead(a).getImageData(0, 0, a.width, a.height).data;
  const B = ctx2dRead(b).getImageData(0, 0, b.width, b.height).data;
  if (A.length !== B.length) return false;
  for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) return false;
  return true;
}

/** Render one effect with WebGPU on and off, restoring the switch whatever happens. */
function renderBoth(id, over, env = makeEnv()) {
  const cfg = { ...DEFAULT_STYLES[id], enabled: true, ...over };
  const fn = renderers.get(id);
  try {
    setGPUEnabled(true);
    const gpu = fn(cfg, env);
    setGPUEnabled(false);
    const cpu = fn(cfg, env);
    return { gpu, cpu, env };
  } finally {
    setGPUEnabled(true);
  }
}

async function needDevice(t) {
  const d = await gpuReady();
  if (!d) {
    t.ok(true, 'WebGPU is not available in this browser — GPU effect parity NOT exercised here');
    return false;
  }
  return true;
}

/* ================================================================== */

suite('gpu effects / drop shadow matches the CPU renderer', async (t) => {
  if (!(await needDevice(t))) return;

  const cases = [
    ['hard shadow (size 0) offset 20 px at 135°', { size: 0, distance: 20, angle: 135, useGlobalLight: false }, 0],
    ['size 5 — the Gaussian branch', { size: 5, distance: 5 }, 3],
    ['size 12 with 40% noise', { size: 12, distance: 9, noise: 0.4 }, 3],
    ['size 16 — the last Gaussian radius', { size: 16, distance: 0 }, 3],
    ['size 30 in blue — the box-blur branch', { size: 30, distance: 10, color: '#2050a0' }, 3],
    ['size 80 — wide box blur', { size: 80, distance: 25 }, 3],
    ['angle 300° (the other two quadrants)', { size: 8, distance: 30, angle: 300, useGlobalLight: false }, 3],
  ];
  for (const [label, over, tol] of cases) {
    const env = makeEnv();
    // Prove the GPU actually took this case — otherwise "matches" compares the CPU with itself.
    const direct = effectFieldOnGPU(env, { dx: 0, dy: 0, blurRadius: over.size, noise: 0, color: { r: 0, g: 0, b: 0 } });
    t.ok(direct instanceof HTMLCanvasElement, `${label}: the GPU path handles this region`);
    const { gpu, cpu } = renderBoth('dropShadow', over, env);
    const d = compare(gpu, cpu);
    t.gt(d.inked, 1000, `${label}: the shadow is not empty (${d.inked} px inked)`);
    t.lt(d.maxAlpha, tol + 1, `${label}: alpha within ${tol} counts of the CPU (worst ${d.maxAlpha})`);
    t.lt(d.meanAlpha, 0.1, `${label}: mean alpha difference under 0.1 (got ${d.meanAlpha.toFixed(4)})`);
    t.lt(d.maxRGB, 3, `${label}: colour within 2 counts where visible (worst ${d.maxRGB})`);
  }
  t.ok(!gpuEffectsBroken(), 'no WebGPU validation error switched the GPU effects off');
});

suite('gpu effects / outer glow matches the CPU renderer', async (t) => {
  if (!(await needDevice(t))) return;

  const cases = [
    ['solid glow, size 10', { size: 10 }],
    ['solid glow, size 40 with noise', { size: 40, noise: 0.3 }],
    ['gradient glow, red to blue', { size: 20, fillType: 'gradient', stops: [{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#0000ff' }] }],
    ['reversed gradient glow', { size: 24, fillType: 'gradient', reverse: true, stops: [{ pos: 0, color: '#00ff00' }, { pos: 1, color: '#ff00ff' }] }],
  ];
  for (const [label, over] of cases) {
    const { gpu, cpu } = renderBoth('outerGlow', over);
    const d = compare(gpu, cpu);
    t.gt(d.inked, 1000, `${label}: the glow is not empty (${d.inked} px inked)`);
    t.lt(d.maxAlpha, 4, `${label}: alpha within 3 counts of the CPU (worst ${d.maxAlpha})`);
    t.lt(d.meanAlpha, 0.1, `${label}: mean alpha difference under 0.1 (got ${d.meanAlpha.toFixed(4)})`);
    t.lt(d.maxRGB, 3, `${label}: colour within 2 counts where visible (worst ${d.maxRGB})`);
  }
});

/** The renderer's own GPU request for a case, so a test can prove the GPU took it. */
function directInner(env, kind, over) {
  const size = over.size ?? (kind === 'innerGlow' ? 10 : 5);
  const choke = (over.choke || 0) * size;
  return effectFieldOnGPU(env, kind === 'innerGlow'
    ? { kind, size, span: Math.max(0.001, size - choke), fromCenter: over.source === 'center',
      blurRadius: 1, noise: 0, color: { r: 0, g: 0, b: 0 } }
    : { kind, dx: 0, dy: 0, spread: choke, blurRadius: size - choke, noise: 0, color: { r: 0, g: 0, b: 0 } });
}

suite('gpu effects / inner shadow matches the CPU renderer', async (t) => {
  if (!(await needDevice(t))) return;

  const cases = [
    ['hard inner shadow (size 0) offset 12 px', { size: 0, distance: 12, angle: 135, useGlobalLight: false }],
    ['size 5 — the Gaussian branch, clamped', { size: 5, distance: 6 }],
    ['size 16 with 30% choke — the distance field', { size: 16, distance: 0, choke: 0.3 }],
    ['size 30 with 40% noise — the box branch', { size: 30, distance: 10, noise: 0.4 }],
    ['size 80 at 300°, choke 0.3', { size: 80, distance: 25, angle: 300, useGlobalLight: false, choke: 0.3 }],
  ];
  for (const [label, over] of cases) {
    const env = makeEnv();
    t.ok(directInner(env, 'innerShadow', over) instanceof HTMLCanvasElement, `${label}: the GPU path handles this region`);
    const { gpu, cpu } = renderBoth('innerShadow', { opacity: 1, ...over }, env);
    const d = compare(gpu, cpu);
    t.gt(d.inked, 1000, `${label}: the shadow is not empty (${d.inked} px inked)`);
    t.lt(d.maxAlpha, 4, `${label}: alpha within 3 counts of the CPU (worst ${d.maxAlpha})`);
    t.lt(d.meanAlpha, 0.1, `${label}: mean alpha difference under 0.1 (got ${d.meanAlpha.toFixed(4)})`);
    t.lt(d.maxRGB, 3, `${label}: colour within 2 counts where visible (worst ${d.maxRGB})`);
    t.eq(env.alphaReads, 1, `${label}: only the CPU render read the layer's alpha back`);
  }
});

suite('gpu effects / inner glow matches the CPU renderer', async (t) => {
  if (!(await needDevice(t))) return;

  const cases = [
    ['edge glow, size 10', { size: 10 }],
    ['edge glow, size 40, choke 0.5, noise 0.3', { size: 40, choke: 0.5, noise: 0.3 }],
    ['centre glow, size 25', { size: 25, source: 'center' }],
    ['gradient glow, size 120', { size: 120, fillType: 'gradient', stops: [{ pos: 0, color: '#ffff00' }, { pos: 1, color: '#0000ff' }] }],
    ['noisy reversed gradient, centre', { size: 30, source: 'center', noise: 0.5, fillType: 'gradient', reverse: true,
      stops: [{ pos: 0, color: '#00ff00' }, { pos: 1, color: '#ff00ff' }] }],
  ];
  for (const [label, over] of cases) {
    const env = makeEnv();
    t.ok(directInner(env, 'innerGlow', over) instanceof HTMLCanvasElement, `${label}: the GPU path handles this region`);
    const { gpu, cpu } = renderBoth('innerGlow', { opacity: 1, ...over }, env);
    const d = compare(gpu, cpu);
    t.gt(d.inked, 1000, `${label}: the glow is not empty (${d.inked} px inked)`);
    t.lt(d.maxAlpha, 4, `${label}: alpha within 3 counts of the CPU (worst ${d.maxAlpha})`);
    t.lt(d.meanAlpha, 0.1, `${label}: mean alpha difference under 0.1 (got ${d.meanAlpha.toFixed(4)})`);
    // A gradient glow looks its colour up by the blurred field. The CPU's
    // Canvas2D blur rounds that field to whole bytes and the GPU's does not,
    // so the two can pick neighbouring gradient entries — one step of the
    // ramp plus the premultiply rounding above: three counts at most.
    const rgbTol = over.fillType === 'gradient' ? 3 : 2;
    t.lt(d.maxRGB, rgbTol + 1, `${label}: colour within ${rgbTol} counts where visible (worst ${d.maxRGB})`);
    t.eq(env.alphaReads, 1, `${label}: only the CPU render read the layer's alpha back`);
  }
});

suite('gpu effects / Spread and Choke match the CPU renderer', async (t) => {
  if (!(await needDevice(t))) return;

  const cases = [
    ['drop shadow, spread 0.3', 'dropShadow', { size: 12, distance: 6, spread: 0.3 }],
    ['drop shadow, spread 0.8, size 60', 'dropShadow', { size: 60, distance: 0, spread: 0.8 }],
    ['outer glow, spread 0.4, gradient', 'outerGlow', { size: 20, spread: 0.4, fillType: 'gradient',
      stops: [{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#0000ff' }] }],
    ['inner shadow, choke 1.0 (no blur at all)', 'innerShadow', { size: 9, distance: 0, choke: 1 }],
  ];
  for (const [label, id, over] of cases) {
    const { gpu, cpu } = renderBoth(id, { opacity: 1, ...over });
    const d = compare(gpu, cpu);
    t.gt(d.inked, 1000, `${label}: the effect is not empty (${d.inked} px inked)`);
    t.lt(d.maxAlpha, 4, `${label}: alpha within 3 counts of the CPU (worst ${d.maxAlpha})`);
    t.lt(d.meanAlpha, 0.1, `${label}: mean alpha difference under 0.1 (got ${d.meanAlpha.toFixed(4)})`);
  }

  // Spread 100%: no blur at all, so the result IS the distance field's one-pixel
  // ramp. Any mistake in the transform — a cap one pixel short, a diagonal
  // measured wrong — shows up here undiluted.
  const env = makeEnv();
  const hard = renderBoth('dropShadow', { size: 12, distance: 0, spread: 1, opacity: 1 }, env);
  const A = ctx2dRead(hard.gpu).getImageData(0, 0, env.w, env.h).data;
  const B = ctx2dRead(hard.cpu).getImageData(0, 0, env.w, env.h).data;
  let worst = 0, differ = 0, ramp = 0;
  for (let i = 3; i < A.length; i += 4) {
    const dd = Math.abs(A[i] - B[i]);
    worst = Math.max(worst, dd);
    if (dd) differ++;
    if (B[i] > 0 && B[i] < 255) ramp++;
  }
  t.gt(ramp, 500, `the hard spread has an antialiased ramp to compare (${ramp} px)`);
  t.lt(worst, 2, `a hard 12 px spread is within one count of the CPU everywhere (worst ${worst})`);
  t.lt(differ, env.w * env.h * 0.0005, `and differs at fewer than 0.05% of pixels (${differ})`);
});

/** Count GPU effect runs by wrapping the device's queue submits around a render. */
function gpuRan(fn) {
  const proto = GPUQueue.prototype;
  const original = proto.submit;
  let n = 0;
  proto.submit = function (...args) { n++; return original.apply(this, args); };
  try {
    fn();
  } finally {
    proto.submit = original;
  }
  return n > 0;
}

function parity(t, id, cases, { rgbTol = 2, alphaTol = 3 } = {}) {
  for (const [label, over] of cases) {
    const env = makeEnv();
    let ran = false;
    let out;
    try {
      setGPUEnabled(true);
      ran = gpuRan(() => { out = renderers.get(id)({ ...DEFAULT_STYLES[id], enabled: true, opacity: 1, ...over }, env); });
    } finally {
      setGPUEnabled(true);
    }
    t.ok(ran, `${label}: the GPU path ran`);
    const { gpu, cpu } = renderBoth(id, { opacity: 1, ...over }, env);
    const d = compare(gpu, cpu);
    t.gt(d.inked, 500, `${label}: the effect is not empty (${d.inked} px inked)`);
    t.lt(d.maxAlpha, alphaTol + 1, `${label}: alpha within ${alphaTol} counts of the CPU (worst ${d.maxAlpha})`);
    t.lt(d.meanAlpha, 0.1, `${label}: mean alpha difference under 0.1 (got ${d.meanAlpha.toFixed(4)})`);
    t.lt(d.maxRGB, rgbTol + 1, `${label}: colour within ${rgbTol} counts where visible (worst ${d.maxRGB})`);
    if (!out) t.ok(false, `${label}: the GPU render returned nothing`);
  }
}

suite('gpu effects / satin matches the CPU renderer', async (t) => {
  if (!(await needDevice(t))) return;
  parity(t, 'satin', [
    ['default satin (inverted)', { invert: true }],
    ['not inverted, size 30 (box blur)', { invert: false, size: 30, distance: 20 }],
    ['angle 120, distance 40, blue', { angle: 120, distance: 40, size: 8, color: '#2244aa' }],
  ]);
});

suite('gpu effects / stroke matches the CPU renderer', async (t) => {
  if (!(await needDevice(t))) return;
  parity(t, 'stroke', [
    ['outside, size 6', { position: 'outside', size: 6, fillType: 'color', color: '#112233' }],
    ['inside, size 12', { position: 'inside', size: 12, fillType: 'color', color: '#aa0000' }],
    ['centre, size 9 (odd: half-pixel radii)', { position: 'center', size: 9, fillType: 'color', color: '#00aa00' }],
    ['outside, size 60', { position: 'outside', size: 60, fillType: 'color' }],
    ['gradient fill, not aligned with the layer', { position: 'outside', size: 10, fillType: 'gradient', alignWithLayer: false,
      stops: [{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#0000ff' }] }],
    ['pattern fill', { position: 'center', size: 14, fillType: 'pattern', patternId: 'checkerboard', patternScale: 1 }],
  ]);
});

suite('gpu effects / bevel and emboss matches the CPU renderer', async (t) => {
  if (!(await needDevice(t))) return;
  parity(t, 'bevelEmboss', [
    ['inner bevel, smooth, size 10', { style: 'inner', technique: 'smooth', size: 10 }],
    ['outer bevel, chisel hard, size 16', { style: 'outer', technique: 'chisel-hard', size: 16 }],
    ['emboss, chisel soft, size 24, down', { style: 'emboss', technique: 'chisel-soft', size: 24, direction: 'down' }],
    ['pillow emboss, size 12, soften 4', { style: 'pillow-emboss', size: 12, soften: 4 }],
    ['inner bevel, size 40 (box blur), altitude 60, angle 300', { style: 'inner', size: 40, altitude: 60, angle: 300, useGlobalLight: false }],
    ['coloured tones at half opacity', { style: 'inner', size: 8, highlightColor: '#ffee00', shadowColor: '#0000aa',
      highlightOpacity: 0.5, shadowOpacity: 0.6 }],
  ]);
});

suite('gpu effects / back-to-back effects in one task each get their own result', async (t) => {
  if (!(await needDevice(t))) return;

  // A composite renders every styled layer's effects in one synchronous task.
  // Safari once handed the SECOND result in a task back as a copy of the first,
  // because the results shared one webgpu canvas and drawImage re-served the
  // copy it had already taken. Two different shapes, rendered back to back with
  // nothing awaited in between, must each match their own CPU rendering.
  const shape = (rect) => {
    const env = makeEnv();
    const c = env.src.getContext('2d');
    c.clearRect(0, 0, env.w, env.h);
    c.fillStyle = 'rgb(200,30,30)';
    c.fillRect(...rect);
    return env;
  };
  const cfg = {
    ...DEFAULT_STYLES.dropShadow, enabled: true, size: 0, distance: 20,
    angle: 180, useGlobalLight: false, color: '#0000ff',
  };
  const a = shape([50, 50, 200, 100]);
  const b = shape([400, 300, 150, 120]);
  const fn = renderers.get('dropShadow');
  let gpuA, gpuB, gpuA2, cpuA, cpuB;
  try {
    setGPUEnabled(true);
    gpuA = fn(cfg, a);
    gpuB = fn(cfg, b);
    gpuA2 = fn(cfg, a);
    setGPUEnabled(false);
    cpuA = fn(cfg, a);
    cpuB = fn(cfg, b);
  } finally {
    setGPUEnabled(true);
  }
  t.ok(bytesEqual(gpuA, cpuA), 'the first effect in the task is exact (a hard shadow has no rounding)');
  t.ok(bytesEqual(gpuB, cpuB), 'the second, a different shape, is its own result, not a copy of the first');
  t.ok(bytesEqual(gpuA2, cpuA), 'and a third, back to the first shape, is right again');
});

suite('gpu effects / what stays on the CPU', async (t) => {
  const have = await gpuReady();

  // Switched off: no canvas, so the renderer runs exactly the code it always did.
  setGPUEnabled(false);
  try {
    t.is(getGPUDevice(), null, 'setGPUEnabled(false) hides the device');
    t.is(effectFieldOnGPU(makeEnv(), { dx: 0, dy: 0, blurRadius: 5, noise: 0, color: { r: 0, g: 0, b: 0 } }), null,
      'and effectFieldOnGPU declines, leaving the CPU path');
  } finally {
    setGPUEnabled(true);
  }

  // Under the threshold the CPU path is a few ms and bit-exact, so it keeps the job.
  const tiny = makeEnv(250, 200);
  t.lt(tiny.w * tiny.h, GPU_MIN_PIXELS, 'the small region really is under GPU_MIN_PIXELS');
  t.is(effectFieldOnGPU(tiny, { dx: 0, dy: 0, blurRadius: 5, noise: 0, color: { r: 0, g: 0, b: 0 } }), null,
    'a region under GPU_MIN_PIXELS is declined');
  const small = renderBoth('dropShadow', { size: 6, distance: 4 }, makeEnv(250, 200));
  t.ok(bytesEqual(small.gpu, small.cpu), 'so a small drop shadow is byte-identical with WebGPU on or off');

  // A spread so wide the GPU's row search would run past MAX_DISTANCE_CAP
  // stays on the CPU.
  t.is(effectFieldOnGPU(makeEnv(), { dx: 0, dy: 0, spread: 300, blurRadius: 0, noise: 0, color: { r: 0, g: 0, b: 0 } }), null,
    'a 300 px spread is declined');
  const spread = renderBoth('dropShadow', { size: 300, distance: 0, spread: 1 });
  t.ok(bytesEqual(spread.gpu, spread.cpu), 'so a 300 px spread is byte-identical on or off (CPU both times)');

  if (!have) {
    t.ok(true, 'WebGPU is not available in this browser — the lazy-alpha check below is NOT exercised');
    return;
  }
  // The point of the GPU path is skipping the readback: it must not touch env.alpha.
  const env = makeEnv();
  renderers.get('dropShadow')({ ...DEFAULT_STYLES.dropShadow, enabled: true, size: 5 }, env);
  t.eq(env.alphaReads, 0, 'the GPU drop shadow never reads env.alpha back from the canvas');
  setGPUEnabled(false);
  try {
    renderers.get('dropShadow')({ ...DEFAULT_STYLES.dropShadow, enabled: true, size: 5 }, env);
  } finally {
    setGPUEnabled(true);
  }
  t.gt(env.alphaReads, 0, 'while the CPU drop shadow does (so the counter is live)');

  // And through the real entry point: buildEnv must not read the cropped layer
  // back up front. At 1.4 MP the bounds scan is exact (above that it pads by a
  // reduced pixel), so a 900x600 shape at (250,200) with a size-5 shadow at
  // distance 5 — a reach of 14 px — crops to exactly 928x628: a size nothing
  // else in this call reads (the bounds scan reads the 1400x1000 layer).
  const doc = t.doc(1400, 1000, '#ffffff', 'gpu-fx-lazy-alpha');
  const layer = createRasterLayer(1400, 1000, 'shape');
  t.fill(layer, 'rgb(0,0,255)', 250, 200, 900, 600);
  layer.styles = { dropShadow: { ...DEFAULT_STYLES.dropShadow, enabled: true, size: 5, distance: 5 } };
  doc.addLayer(layer);
  const regionReads = (gpuOn) => {
    const proto = CanvasRenderingContext2D.prototype;
    const original = proto.getImageData;
    let n = 0;
    proto.getImageData = function (...args) {
      if (this.canvas.width === 928 && this.canvas.height === 628) n++;
      return original.apply(this, args);
    };
    setGPUEnabled(gpuOn);
    try {
      belowEffectResults(layer.canvas, layer, doc, 1400, 1000);
    } finally {
      proto.getImageData = original;
      setGPUEnabled(true);
    }
    return n;
  };
  t.eq(regionReads(true), 0, 'with WebGPU, compositing the shadow never reads the cropped layer back');
  t.gt(regionReads(false), 0, 'without it, the CPU path reads that exact region (so the probe is aimed right)');
});

suite('gpu effects / composite of a large shadowed layer', async (t) => {
  if (!(await needDevice(t))) return;

  // A shape covering most of a 1600x1200 document: the region is far above the
  // threshold, so the compositor goes through the GPU path end to end.
  const doc = t.doc(1600, 1200, '#ffffff', 'gpu-fx-composite');
  const layer = createRasterLayer(1600, 1200, 'shape');
  const c = layer.canvas.getContext('2d');
  c.fillStyle = 'rgb(255,0,0)';
  c.fillRect(200, 150, 1100, 800);
  layer.styles = {
    dropShadow: { ...DEFAULT_STYLES.dropShadow, enabled: true, size: 10, distance: 12, opacity: 1 },
    outerGlow: { ...DEFAULT_STYLES.outerGlow, enabled: true, size: 30 },
  };
  doc.addLayer(layer);

  let gpu, cpu;
  try {
    setGPUEnabled(true);
    gpu = compositeDocument(doc);
    setGPUEnabled(false);
    cpu = compositeDocument(doc);
  } finally {
    setGPUEnabled(true);
  }
  const d = compare(gpu, cpu);
  t.lt(d.maxAlpha, 1, 'both composites are fully opaque (white backdrop)');
  t.lt(d.maxRGB, 4, `composited colour within 3 counts of the CPU path (worst ${d.maxRGB})`);
  t.pixel(gpu, 700, 500, '255,0,0,255', 'the layer itself is untouched');
  // Global light 120° at distance 12 shifts the shadow (6, 10): its bottom edge
  // is at y = 959, ten pixels below the shape's, softened by a sigma-5 blur.
  const shadow = t.px(gpu, 700, 955).split(',').map(Number);
  t.lt(shadow[0], 200, `the shadow darkens the backdrop just below the shape (${shadow.join(',')})`);
  t.pixel(gpu, 700, 1100, '255,255,255,255', 'and is gone well below it');
});
