import { suite } from '../harness.js';
import { createSmartObject, addSmartFilter, composeSmartCanvas } from '/src/core/smart.js';
import { filters as FILTERS } from '/src/filters/registry.js';
import { gpuReady, setGPUEnabled } from '/src/render/gpu-device.js';
import { gpuFilterStats } from '/src/render/gpu-filters.js';
import { ctx2dRead } from '/src/core/util.js';

/**
 * Smart filter stacks: consecutive GPU-capable filters run as one chain on
 * WebGPU (src/core/smart.js applySmartFilters), and a filter dialog previews
 * the top of a stack without re-running what sits below it.
 */

function smartDoc(t, size, name) {
  const doc = t.doc(size, size, '#ffffff', name);
  const raster = doc.activeLayer();
  doc.beginEdit(raster);
  t.detail(raster);
  doc.commit('Detail');
  return { doc, smart: createSmartObject(doc, [raster]) };
}

const bytes = (cv) => ctx2dRead(cv).getImageData(0, 0, cv.width, cv.height).data;
function worst(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

suite('gpu chains / a stack of GPU filters runs as one chain', async (t) => {
  if (!(await gpuReady())) {
    t.ok(true, 'WebGPU is not available in this browser — GPU chains NOT exercised here');
    return;
  }
  // Verified to fail running each filter as its own GPU run: 3 runs, not 1.
  const { doc, smart } = smartDoc(t, 400, 'chain');
  for (const [id, params] of [['twirl', { angle: 120 }], ['camera-raw', { exposure: 0.5, clarity: 30 }], ['wave', {}]]) {
    addSmartFilter(doc, doc.findLayer(smart.id), id, params);
  }
  const layer = doc.findLayer(smart.id);
  const before = gpuFilterStats().runs;
  const gpu = composeSmartCanvas(layer.smart, doc.width, doc.height, layer, null);
  t.eq(gpuFilterStats().runs - before, 1, 'twirl, Camera Raw and wave ran as a single GPU run');
  setGPUEnabled(false);
  let cpu;
  try {
    cpu = composeSmartCanvas(layer.smart, doc.width, doc.height, layer, null);
  } finally {
    setGPUEnabled(true);
  }
  t.lt(worst(bytes(gpu), bytes(cpu)), 4, 'and the chain matches the stack run filter by filter on the CPU');

  // A filter with no GPU stage breaks the chain in two.
  const { doc: doc2, smart: s2 } = smartDoc(t, 400, 'chain-broken');
  for (const [id, params] of [['twirl', { angle: 120 }], ['median', { radius: 2 }], ['wave', {}]]) {
    addSmartFilter(doc2, doc2.findLayer(s2.id), id, params);
  }
  const l2 = doc2.findLayer(s2.id);
  const b2 = gpuFilterStats().runs;
  composeSmartCanvas(l2.smart, doc2.width, doc2.height, l2, null);
  t.eq(gpuFilterStats().runs - b2, 2, 'twirl | median | wave: two GPU runs either side of the CPU median');
});

suite('gpu chains / a filter dialog re-runs only what changed', async (t) => {
  // Verified to fail without the prefix cache: the blur and solarize below
  // the previewed filter re-ran on every preview.
  const { doc, smart } = smartDoc(t, 160, 'prefix');
  addSmartFilter(doc, doc.findLayer(smart.id), 'gaussian-blur', { radius: 3 });
  addSmartFilter(doc, doc.findLayer(smart.id), 'solarize', {});
  const layer = doc.findLayer(smart.id);
  const counts = { 'gaussian-blur': 0, solarize: 0, mosaic: 0 };
  const originals = new Map();
  for (const id of Object.keys(counts)) {
    const def = FILTERS.get(id);
    originals.set(id, def.apply);
    def.apply = (...args) => { counts[id]++; return originals.get(id).apply(def, args); };
  }
  const n = () => [counts['gaussian-blur'], counts.solarize, counts.mosaic];
  try {
    const prefix = new Map();
    // What a Mosaic dialog previews: the stack, plus Mosaic at the slider's value.
    const stack = (cellSize) => ({
      ...layer.smart,
      filters: [...layer.smart.filters, { id: 'x', filterId: 'mosaic', params: { cellSize }, enabled: true }],
    });
    composeSmartCanvas(stack(8), doc.width, doc.height, layer, null, prefix);
    t.eq(n(), [1, 1, 1], 'the first preview runs the whole stack');
    const second = composeSmartCanvas(stack(12), doc.width, doc.height, layer, null, prefix);
    t.eq(n(), [1, 1, 2], 'moving the slider re-runs only Mosaic, not the blur and solarize below it');
    composeSmartCanvas(stack(12), doc.width, doc.height, layer, null, prefix);
    t.eq(n(), [1, 1, 2], 'and the same value again re-runs nothing');
    const fresh = composeSmartCanvas(stack(12), doc.width, doc.height, layer, null, null);
    t.eq(worst(bytes(second), bytes(fresh)), 0, 'the preview is exactly the full render');
  } finally {
    for (const [id, fn] of originals) FILTERS.get(id).apply = fn;
  }
});
