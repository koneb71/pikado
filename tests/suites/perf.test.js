import { suite } from '../harness.js';
import { createRasterLayer } from '/src/core/layer.js';
import { compositeDocument } from '/src/render/compositor.js';
import { blendCPU } from '/src/core/blend.js';
import { runFilter, getFilter } from '/src/filters/registry.js';
import { supportsCanvasFilter, blurCanvas } from '/src/render/fast-blur.js';
import { PaintStroke } from '/src/paint/brush-engine.js';
import { DEFAULT_STYLES } from '/src/effects/styles.js';
import { createCanvas, ctx2d, ctx2dRead } from '/src/core/util.js';

/**
 * Performance alarms.
 *
 * These are NOT benchmarks. Each one guards an optimisation that a plausible
 * refactor could quietly undo — the GPU blend shader, the GPU Gaussian, the
 * layer-effect region crop — and each threshold is roughly 5-10x the measured
 * cost on developer hardware so a slow or loaded machine will not flake. The
 * measured value goes into the assertion message so the trend is visible even
 * while everything passes.
 *
 * Every timing assertion is paired with a correctness assertion on the same
 * result, so a "fast" path that returns garbage cannot pass.
 */

const W = 2000;
const H = 1500;            // 3 MP — big enough for the JS paths to hurt
const MP = (W * H) / 1e6;

/** Channel value out of an ImageData. */
function chan(img, x, y, k) {
  return img.data[(y * img.width + x) * 4 + k];
}

/** Ground truth for one blended pixel, straight from the CPU reference. */
function cpuBlend(base, top, mode, opacity = 1) {
  const b = new ImageData(new Uint8ClampedArray(base), 1, 1);
  blendCPU(b, new ImageData(new Uint8ClampedArray(top), 1, 1), mode, opacity);
  return [b.data[0], b.data[1], b.data[2], b.data[3]];
}

function addLayer(t, doc, name, color, mode, rect = null) {
  const l = createRasterLayer(doc.width, doc.height, name);
  l.blendMode = mode;
  if (rect) t.fill(l, color, rect[0], rect[1], rect[2], rect[3]);
  else t.fill(l, color);
  doc.addLayer(l);
  return l;
}

/* ------------------------------------------------------------------ */

suite('perf / 3 MP composite with native and non-native blend modes', async (t) => {
  const doc = t.doc(W, H, '#ffffff', 'perf-composite');

  // Exact integer blend maths, so the "is it correct?" half of each assertion
  // is a hard equality rather than a fuzzy resemblance.
  addLayer(t, doc, 'mul-a', 'rgb(128,64,32)', 'multiply');          // white x c   = c
  addLayer(t, doc, 'mul-b', 'rgb(255,255,0)', 'multiply');          // zeroes blue
  addLayer(t, doc, 'scr', 'rgb(0,0,255)', 'screen');                // blue -> 255
  addLayer(t, doc, 'corner', 'rgb(10,20,30)', 'normal', [0, 0, 400, 300]);

  t.eq(doc.flatLayers().length, 5, 'the perf document has five layers');

  compositeDocument(doc);                                            // warm-up
  let native = null;
  const msNative = t.time(() => { native = compositeDocument(doc); });
  t.pixel(native, 1000, 750, '128,64,255,255',
    'native-blend composite is exact (white x (128,64,32) x (255,255,0), then screen blue)');
  t.pixel(native, 100, 100, '10,20,30,255', 'the topmost opaque layer wins inside its rect');
  t.lt(msNative, 150, `full ${MP} MP composite with native blend modes took ${msNative.toFixed(1)} ms (limit 150)`);

  // The alarm that matters: vivid-light has no Canvas2D operator. It used to run
  // per-pixel in JS and cost ~1 s at 12 MP; the shader path is what keeps this
  // under control. If it regresses, this assertion is where it shows up.
  addLayer(t, doc, 'vivid', 'rgb(192,192,192)', 'vivid-light');
  compositeDocument(doc);                                            // warm-up (shader compile)
  let vivid = null;
  const msVivid = t.time(() => { vivid = compositeDocument(doc); });

  const expect = cpuBlend([128, 64, 255, 255], [192, 192, 192, 255], 'vivid-light');
  const got = t.px(vivid, 1000, 750).split(',').map(Number);
  t.eq(expect[3], 255, 'the reference pixel is opaque');
  t.gt(Math.abs(expect[1] - 192), 20, 'precondition: vivid-light is genuinely not a plain "normal" draw here');
  for (let k = 0; k < 3; k++) {
    t.close(got[k], expect[k], 2,
      `vivid-light channel ${'rgb'[k]} matches the blendCPU reference (${got[k]} vs ${expect[k]})`);
  }
  t.eq(got[3], 255, 'and the composite stays opaque');
  t.lt(msVivid, 250, `${MP} MP composite including a vivid-light layer took ${msVivid.toFixed(1)} ms (limit 250)`);
});

suite('perf / gaussian blur is radius-independent on 3 MP', async (t) => {
  t.ok(getFilter('gaussian-blur'), 'the gaussian-blur filter is registered');

  // A single hard vertical edge: easy to reason about, and the blurred profile
  // tells us the radius actually took effect.
  const src = createCanvas(W, H);
  const c = ctx2d(src);
  c.fillStyle = '#000000';
  c.fillRect(0, 0, W / 2, H);
  c.fillStyle = '#ffffff';
  c.fillRect(W / 2, 0, W / 2, H);
  const base = ctx2dRead(src).getImageData(0, 0, W, H);
  t.eq(chan(base, 100, 750, 0), 0, 'the source is black on the left');
  t.eq(chan(base, 1900, 750, 0), 255, 'and white on the right');

  const copy = () => new ImageData(new Uint8ClampedArray(base.data), W, H);
  const ctx = { width: W, height: H };

  runFilter('gaussian-blur', copy(), { radius: 10 }, ctx);            // warm-up

  const a = copy();
  const ms10 = t.time(() => runFilter('gaussian-blur', a, { radius: 10 }, ctx));
  const b = copy();
  const ms60 = t.time(() => runFilter('gaussian-blur', b, { radius: 60 }, ctx));

  // Correctness, radius 10.
  t.lt(chan(a, 100, 750, 0), 2, 'radius 10: far left stays black (edges clamp, they do not fade out)');
  t.gt(chan(a, 1900, 750, 0), 253, 'radius 10: far right stays white');
  t.close(chan(a, 1000, 750, 0), 130, 14, 'radius 10: the edge itself sits near mid grey');
  t.gt(chan(a, 1005, 750, 0), chan(a, 995, 750, 0), 'radius 10: the profile rises across the edge');
  t.gt(chan(a, 1030, 750, 0), 250, 'radius 10: 3 sigma past the edge is already white');

  // Correctness, radius 60 — and the same probe proves the radius is honoured.
  t.lt(chan(b, 100, 750, 0), 2, 'radius 60: far left stays black');
  t.gt(chan(b, 1900, 750, 0), 253, 'radius 60: far right stays white');
  t.close(chan(b, 1000, 750, 0), 130, 14, 'radius 60: the edge itself sits near mid grey');
  t.lt(chan(b, 1030, 750, 0), 240, 'radius 60: 0.5 sigma past the edge is still well short of white');
  t.gt(chan(b, 1030, 750, 0), 130, 'radius 60: but past the midpoint (a real Gaussian profile)');

  t.lt(ms10, 600, `gaussian-blur radius 10 on ${MP} MP took ${ms10.toFixed(1)} ms (limit 600)`);
  t.lt(ms60, 600, `gaussian-blur radius 60 on ${MP} MP took ${ms60.toFixed(1)} ms (limit 600)`);
  // The GPU filter is radius-independent; the old JS box passes were not. A 6x
  // radius must not cost anything like 6x.
  t.lt(ms60, ms10 * 3 + 200,
    `radius 60 (${ms60.toFixed(1)} ms) is not dramatically slower than radius 10 (${ms10.toFixed(1)} ms)`);
});

suite('perf / layer effects stay cropped to the layer content', async (t) => {
  // A hard-edged shadow with size 0 so every pixel of the expected result is
  // exactly predictable: offset 20 px to the right, knocked out under the layer.
  const shadow = {
    ...DEFAULT_STYLES.dropShadow,
    enabled: true, color: '#000000', opacity: 1, blendMode: 'normal',
    angle: 180, useGlobalLight: false, distance: 20, spread: 0, size: 0, noise: 0,
  };

  const doc = t.doc(W, H, '#ffffff', 'perf-shadow-small');
  const logo = createRasterLayer(W, H, 'logo');
  t.fill(logo, 'rgb(255,0,0)', 100, 100, 100, 80);
  logo.styles = { dropShadow: { ...shadow } };
  doc.addLayer(logo);

  compositeDocument(doc);                                            // warm-up
  let small = null;
  const msSmall = t.time(() => { small = compositeDocument(doc); });

  t.pixel(small, 150, 140, '255,0,0,255', 'the small layer itself still renders');
  t.pixel(small, 210, 140, '0,0,0,255', 'its drop shadow lands exactly 20 px to the right of the content');
  t.pixel(small, 150, 90, '255,255,255,255', 'above the content there is no shadow (offset is horizontal)');
  t.pixel(small, 1500, 1200, '255,255,255,255', 'the far corner of the canvas is untouched background');
  t.lt(msSmall, 400,
    `drop shadow on a 100x80 layer inside a ${MP} MP canvas took ${msSmall.toFixed(1)} ms (limit 400)`);

  // The four probes above are the real regression guard on the crop: the effect
  // is rendered into a ~168x148 sub-buffer and then blitted back at (region.x,
  // region.y), so an off-by-anything in that bookkeeping moves the shadow and
  // 210,140 stops being black.
  //
  // Control: the identical effect on a layer that covers the whole canvas, where
  // effectRegion() declines to crop. Reported for the trend — deliberately NOT
  // asserted as a ratio, because the crop drops the buffer under
  // fast-blur's GPU_MIN_PIXELS and the two paths are not comparable that way.
  const docFull = t.doc(W, H, '#ffffff', 'perf-shadow-full');
  const flood = createRasterLayer(W, H, 'flood');
  t.fill(flood, 'rgb(255,0,0)');
  flood.styles = { dropShadow: { ...shadow } };
  docFull.addLayer(flood);

  compositeDocument(docFull);                                        // warm-up
  let full = null;
  const msFull = t.time(() => { full = compositeDocument(docFull); });
  t.pixel(full, 1500, 1200, '255,0,0,255', 'the uncropped control composites correctly');
  t.lt(msFull, 900,
    `uncropped ${MP} MP drop shadow (the control for the crop above) took ${msFull.toFixed(1)} ms (limit 900)`);
});

suite('perf / one brush frame on a 3 MP layer', async (t) => {
  const doc = t.doc(W, H, 'transparent', 'perf-brush');
  const layer = doc.activeLayer();
  doc.beginEdit(layer);

  const stroke = new PaintStroke({
    doc,
    layer,
    target: layer.canvas,
    // Deterministic: no smoothing lag, no jitter, no pressure scaling.
    brush: {
      size: 40, hardness: 1, opacity: 1, flow: 1, spacing: 0.1,
      smoothing: 0, pressureSize: false, sizeJitter: 0, opacityJitter: 0,
      scatter: 0, angleJitter: 0, airbrush: false,
    },
    color: '#ff0000',
    mode: 'paint',
  });
  stroke.begin(100, 100, 1);
  stroke.flush();
  t.pixel(layer.canvas, 100, 100, '255,0,0,255', 'the first dab landed');
  t.pixel(layer.canvas, 250, 200, '0,0,0,0', 'precondition: the mid-stroke probe is still empty before the move');

  const msFrame = t.time(() => {
    stroke.move(400, 300, 1);
    stroke.flush();
  });

  t.pixel(layer.canvas, 250, 200, '255,0,0,255', 'the midpoint of the segment was painted opaque red');
  t.pixel(layer.canvas, 400, 300, '255,0,0,255', 'and so was the far end');
  t.pixel(layer.canvas, 1500, 1200, '0,0,0,0', 'nothing outside the stroke was touched');
  t.gt(stroke.dabCount, 80, `the frame emitted ${stroke.dabCount} dabs (360 px at 4 px spacing)`);
  t.lt(msFrame, 50, `one brush frame (move + flush) on a ${MP} MP layer took ${msFrame.toFixed(1)} ms (limit 50)`);

  stroke.end();
  doc.commit('Brush Tool');
});

suite('perf / copy-on-write beginEdit on a 3 MP layer', async (t) => {
  const doc = t.doc(W, H, '#ffffff', 'perf-cow');
  const layer = doc.activeLayer();
  doc.beginEdit(layer);
  t.fill(layer, 'rgb(12,34,56)');
  doc.commit('Fill');

  const snapshotBuffer = doc.findLayer(layer.id).canvas;
  t.eq(t.px(snapshotBuffer, 10, 10), '12,34,56,255', 'the committed buffer holds the fill');

  const live = doc.findLayer(layer.id);
  const ms = t.time(() => doc.beginEdit(live));
  // Identity, not deepEqual: two canvases have no own enumerable keys, so
  // `t.ne` would compare them as equal and the assertion would be vacuous.
  t.ok(live.canvas !== snapshotBuffer, 'beginEdit swapped in a private buffer');
  t.eq(t.mad(t.bytes(live.canvas), t.bytes(snapshotBuffer)), 0, 'the private buffer is pixel-identical');

  // The guarantee beginEdit exists for: later drawing must not reach the buffer
  // the history snapshot is holding.
  t.fill(live, 'rgb(200,100,50)');
  t.eq(t.px(live.canvas, 10, 10), '200,100,50,255', 'drawing hits the live buffer');
  t.eq(t.px(snapshotBuffer, 10, 10), '12,34,56,255', 'and leaves the snapshot buffer alone');
  t.lt(ms, 120, `doc.beginEdit on a ${MP} MP layer took ${ms.toFixed(1)} ms (limit 120)`);
});

suite('perf / Canvas2D filter support and edge clamping', async (t) => {
  // Everything in the blur/effect fast paths keys off this. When it is false the
  // JS fallbacks (gaussianBlurBuffer / blurAlphaJS) run instead — correct, but
  // ~30x slower, so the thresholds in this file assume the GPU path.
  t.ok(supportsCanvasFilter(),
    'supportsCanvasFilter() is true in this browser (when false, the JS fallback runs and is ~30x slower)');

  // The GPU path's one behavioural wrinkle: CSS blur treats outside-the-canvas
  // as transparent black, so an opaque image would fade at the border. The
  // padded edge-clamp is what makes it agree with the old JS path.
  const solid = createCanvas(400, 400);
  const c = ctx2d(solid);
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, 400, 400);

  const clamped = blurCanvas(solid, 20, true);
  const unclamped = blurCanvas(solid, 20, false);
  const cornerA = Number(t.px(unclamped, 0, 0).split(',')[3]);
  t.lt(cornerA, 200, `precondition: without clamping the corner fades to alpha ${cornerA}`);
  t.pixel(clamped, 0, 0, '255,255,255,255', 'edge clamping keeps an opaque corner fully opaque');
  t.pixel(clamped, 200, 200, '255,255,255,255', 'and blurring a solid colour leaves the middle unchanged');
});
