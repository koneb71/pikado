import { suite } from '../harness.js';
import { createRasterLayer, createAdjustmentLayer } from '/src/core/layer.js';
import { compositeDocument } from '/src/render/compositor.js';
import { gpuReady, setGPUEnabled } from '/src/render/gpu-device.js';
import { gpuAdjustStats, clearAdjustmentTables, adjustmentGPUMode } from '/src/render/gpu-adjust.js';
import { ctx2dRead } from '/src/core/util.js';

/**
 * Adjustment layers on WebGPU (src/render/gpu-adjust.js).
 *
 * The GPU looks each pixel up in a table built by running the adjustment's
 * own CPU code over every input it can see, so the result should be the CPU
 * result itself. Each case composites the same document with WebGPU on and
 * off: opaque pixels must match exactly; translucent ones go through the
 * browser's unpremultiply, which the shader mirrors to within a count.
 */

async function needDevice(t) {
  if (await gpuReady()) return true;
  t.ok(true, 'WebGPU is not available in this browser — adjustment layers on the GPU NOT exercised here');
  return false;
}

/**
 * Every hue at full and half saturation, a grey ramp through 128 (Threshold's
 * edge), a near-black ramp (Preserve Luminosity's grey branch), skin tones
 * (Vibrance's protection), a translucent band and a transparent corner.
 */
function fixtureDoc(t, name) {
  const W = 600, H = 400;
  const doc = t.doc(W, H, '#ffffff', name);
  const L = doc.addLayer(createRasterLayer(W, H, 'photo'));
  const img = new ImageData(W, H);
  const hsl = (h, s, l) => {
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let c;
      if (y < 120) c = hsl((x / W) * 360, y < 60 ? 1 : 0.5, 0.25 + (y % 60) / 120);
      else if (y < 160) c = [Math.round((x / W) * 255), Math.round((x / W) * 255), Math.round((x / W) * 255)];
      else if (y < 200) c = [x % 12, (x >> 2) % 9, (x >> 3) % 7];
      else if (y < 260) c = [200 + (x % 40), 140 + (x % 50), 110 + (y % 30)];
      else c = [(x * 7 + y * 3) % 256, (x * 13) % 256, (y * 11) % 256];
      img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2];
      img.data[i + 3] = y >= 340 ? 40 + (x % 200) : (x < 40 && y > 300 ? 0 : 255);
    }
  }
  L.canvas.getContext('2d').putImageData(img, 0, 0);
  doc.commit('fixture');
  return doc;
}

const bytes = (cv) => ctx2dRead(cv).getImageData(0, 0, cv.width, cv.height).data;

/** Composite with WebGPU on (twice, so a 3D table gets built) and off. */
function bothWays(doc) {
  try {
    setGPUEnabled(true);
    compositeDocument(doc);
    const before = gpuAdjustStats().runs;
    const gpu = bytes(compositeDocument(doc));
    const ran = gpuAdjustStats().runs > before;
    setGPUEnabled(false);
    const cpu = bytes(compositeDocument(doc));
    return { gpu, cpu, ran };
  } finally {
    setGPUEnabled(true);
  }
}

function diff(a, b) {
  let opaqueWorst = 0, worst = 0, sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    let m = 0;
    for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(a[i + k] - b[i + k]));
    if (b[i + 3] === 255 && m > opaqueWorst) opaqueWorst = m;
    if (m > worst) worst = m;
    sum += m;
  }
  return { opaqueWorst, worst, mean: sum / (a.length / 4) };
}

const CASES = [
  ['levels', { levels: { channel: 'rgb', rgb: { ib: 20, ig: 1.3, iw: 230, ob: 10, ow: 245 }, r: { ib: 0, ig: 0.8, iw: 255, ob: 0, ow: 255 } } }],
  ['curves', { curves: { channel: 'rgb', rgb: [{ x: 0, y: 0 }, { x: 90, y: 50 }, { x: 255, y: 255 }], r: null, g: [{ x: 0, y: 20 }, { x: 255, y: 230 }], b: null } }],
  ['brightness-contrast', { brightness: 40, contrast: 30 }],
  ['exposure', { exposure: 0.8, offset: -0.02, gamma: 1.2 }],
  ['invert', {}],
  ['posterize', { levels: 5 }],
  ['color-balance', { midtonesCR: 40, shadowsYB: -30, preserveLuminosity: false }],
  ['color-balance', { midtonesCR: 40, highlightsMG: 25, preserveLuminosity: true }],
  ['photo-filter', { density: 60, preserveLuminosity: true }],
  ['hue-saturation', { masterHue: 30, masterSat: 20, redsSat: -60, bluesLight: 40 }],
  ['hue-saturation', { colorize: true, colorizeHue: 200, colorizeSat: 40 }],
  ['vibrance', { vibrance: 70, saturation: -20 }],
  ['black-white', {}],
  ['channel-mixer', { redR: 80, redG: 40, blueB: 120 }],
  ['selective-color', { redsC: 30, neutralsK: -20, bluesY: 40 }],
  ['threshold', { level: 128 }],
  ['desaturate', {}],
  ['gradient-map', {}],
  ['replace-color', { targetColor: '#d62828', fuzziness: 60, hue: 90, saturation: 20 }],
  ['color-lookup', { lut: 'Crisp Warm', amount: 0.7 }],
];

suite('gpu adjustments / every pixel-local adjustment matches the CPU', async (t) => {
  if (!(await needDevice(t))) return;
  for (const [kind, params] of CASES) {
    const label = `${kind} ${JSON.stringify(params).slice(0, 50)}`;
    t.ok(adjustmentGPUMode(kind, params), `${kind}: has a GPU table`);
    const doc = fixtureDoc(t, `adj-${kind}`);
    doc.addLayer(createAdjustmentLayer(kind, params, doc.width, doc.height, kind));
    const { gpu, cpu, ran } = bothWays(doc);
    t.ok(ran, `${label}: the GPU ran it`);
    const d = diff(gpu, cpu);
    t.eq(d.opaqueWorst, 0, `${label}: every opaque pixel is exactly the CPU's`);
    t.lt(d.worst, 3, `${label}: translucent pixels within 2 counts (worst ${d.worst})`);
    t.lt(d.mean, 0.05, `${label}: mean difference ${d.mean.toFixed(4)}`);
  }
});

suite('gpu adjustments / masks, clipping and stacks are unchanged', async (t) => {
  if (!(await needDevice(t))) return;
  const doc = fixtureDoc(t, 'adj-stack');
  const hs = doc.addLayer(createAdjustmentLayer('hue-saturation', { masterHue: -40, masterSat: 30 }, 600, 400, 'HS'));
  hs.addMask(600, 400);
  hs.mask.getContext('2d').fillStyle = '#000';
  hs.mask.getContext('2d').fillRect(0, 0, 300, 400);
  const curves = doc.addLayer(createAdjustmentLayer('curves', { curves: { channel: 'rgb', rgb: [{ x: 0, y: 30 }, { x: 255, y: 220 }] } }, 600, 400, 'C'));
  curves.opacity = 0.6;
  curves.blendMode = 'multiply';
  const top = doc.addLayer(createRasterLayer(600, 400, 'top'));
  top.canvas.getContext('2d').fillStyle = 'rgba(30,200,90,0.8)';
  top.canvas.getContext('2d').fillRect(100, 100, 300, 200);
  const clipped = doc.addLayer(createAdjustmentLayer('invert', {}, 600, 400, 'inv'));
  clipped.clipped = true;
  const { gpu, cpu, ran } = bothWays(doc);
  t.ok(ran, 'the stack ran on the GPU');
  const d = diff(gpu, cpu);
  t.eq(d.opaqueWorst, 0, 'a masked, a blended and a clipped adjustment give exactly the CPU result on opaque pixels');
  t.lt(d.worst, 3, `and within 2 counts elsewhere (worst ${d.worst})`);
});

suite('gpu adjustments / tables are built once and reused', async (t) => {
  if (!(await needDevice(t))) return;
  // Verified to fail building tables per composite: the 3D probe count rose on
  // every brush frame.
  clearAdjustmentTables();
  const doc = fixtureDoc(t, 'adj-cache');
  doc.addLayer(createAdjustmentLayer('vibrance', { vibrance: 50 }, 600, 400, 'V'));
  doc.addLayer(createAdjustmentLayer('levels', { levels: { channel: 'rgb', rgb: { ib: 10, ig: 1.1, iw: 240, ob: 0, ow: 255 } } }, 600, 400, 'L'));
  const s0 = gpuAdjustStats();
  compositeDocument(doc);
  const s1 = gpuAdjustStats();
  t.eq(s1.probes3d - s0.probes3d, 0, 'the first composite with new settings builds no 3D table (the CPU runs it)');
  t.eq(s1.probes1d - s0.probes1d, 1, 'a 1D table is built straight away (it costs nothing)');
  compositeDocument(doc);
  const s2 = gpuAdjustStats();
  t.eq(s2.probes3d - s1.probes3d, 1, 'the same settings a second time build the 3D table');
  for (let i = 0; i < 5; i++) compositeDocument(doc);
  const s3 = gpuAdjustStats();
  t.eq(s3.probes3d - s2.probes3d, 0, 'five more composites build nothing');
  t.eq(s3.probes1d - s2.probes1d, 0, 'not even a 1D table');
  t.gt(s3.runs - s2.runs, 9, 'while both layers run on the GPU each time');
});

suite('gpu adjustments / what stays on the CPU', async (t) => {
  const kinds = [
    ['shadows-highlights', {}], ['equalize', {}], ['hdr-toning', { method: 'local' }],
    ['gradient-map', { dither: true }], ['auto-contrast', {}],
  ];
  for (const [kind, params] of kinds) {
    t.is(adjustmentGPUMode(kind, params), null, `${kind} ${JSON.stringify(params)}: needs more than the pixel's colour, so no GPU table`);
  }
  if (!(await gpuReady())) return;
  const doc = fixtureDoc(t, 'adj-decline');
  doc.addLayer(createAdjustmentLayer('equalize', {}, 600, 400, 'Eq'));
  const before = gpuAdjustStats().runs;
  const a = bytes(compositeDocument(doc));
  t.eq(gpuAdjustStats().runs, before, 'an Equalize layer never reaches the GPU');
  setGPUEnabled(false);
  let b;
  try {
    b = bytes(compositeDocument(doc));
  } finally {
    setGPUEnabled(true);
  }
  t.eq(diff(a, b).worst, 0, 'so it is byte-identical with WebGPU on or off');
});
