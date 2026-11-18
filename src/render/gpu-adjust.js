import { createCanvas } from '../core/util.js';
import { applyAdjustment, getAdjustment } from '../adjustments/registry.js';
import { BLEND_WGSL } from './gpu-blend-wgsl.js';
import {
  getGPUDevice, fitsTexture, uploadCanvas, beginPresent, endPresent, presentFormat, pipelineCache,
  onDeviceLost, GPU_MIN_PIXELS,
} from './gpu-device.js';

/**
 * Adjustment layers on WebGPU.
 *
 * An adjustment layer re-processes everything composited below it, on every
 * redraw — brush frames included. The CPU path reads the whole accumulated
 * canvas back with getImageData, runs the adjustment in JS and writes it with
 * putImageData: ~45 ms per adjustment layer at 12 MP. Here the canvas goes up
 * as a texture, each pixel is looked up in a table, and the result comes back
 * as a canvas; nothing is read back to the CPU.
 *
 * **The tables are the adjustments themselves.** Rather than a second,
 * shader-language implementation of each of the twenty-odd adjustments that
 * could drift from the first, every table is built by running the adjustment's
 * own `apply` over every input it can see:
 *
 *   lut1d  per-channel adjustments (Levels, Curves, Brightness/Contrast,
 *          Exposure, Invert, Posterize, Color Balance and Photo Filter without
 *          Preserve Luminosity): a 256-pixel grey ramp gives the three channel
 *          tables. Built in microseconds, so it runs on every slider move.
 *   lut3d  any other adjustment that depends only on the pixel's own colour
 *          (Hue/Saturation, Vibrance, Black & White, Channel Mixer, Selective
 *          Color, Threshold, Gradient Map, …): all 256³ colours, as a
 *          4096 x 4096 image, give a table indexed by the exact bytes. It costs
 *          about one CPU frame to build, so it is built only when the same
 *          settings come round twice — a slider being dragged changes them
 *          every frame and keeps the CPU path it always had; painting with the
 *          layer in place reuses one table for the whole stroke.
 *
 * Either way the output is the adjustment's own output for those bytes:
 * exact, discontinuities and all. Adjustments that look at neighbours or
 * image statistics (Shadows/Highlights, Equalize, HDR Toning's local and
 * equalize methods, the Auto commands, Gradient Map with dither) decline, and
 * the CPU runs them.
 *
 * The bytes the table is indexed by are what getImageData would have returned
 * (pk_unpremultiply8), alpha-0 pixels stay transparent as the CPU skips them,
 * and the result is stored premultiplied as putImageData would. The masking,
 * clipping and blending the compositor does afterwards are unchanged.
 */

const LUT1D = new Set(['brightness-contrast', 'levels', 'curves', 'exposure', 'invert', 'posterize']);
const LUT3D = new Set([
  'vibrance', 'hue-saturation', 'black-white', 'channel-mixer', 'color-lookup', 'threshold',
  'selective-color', 'desaturate', 'replace-color',
]);

/** 'lut1d', 'lut3d', or null when the adjustment needs more than the pixel's colour. */
export function adjustmentGPUMode(kind, params) {
  const def = getAdjustment(kind);
  if (!def) return null;
  const p = { ...def.defaults, ...(params || {}) };
  if (LUT1D.has(kind)) return 'lut1d';
  if (kind === 'color-balance' || kind === 'photo-filter') return p.preserveLuminosity === false ? 'lut1d' : 'lut3d';
  if (kind === 'gradient-map') return p.dither ? null : 'lut3d';
  if (kind === 'hdr-toning') return p.method === 'exposure' || p.method === 'highlight' ? 'lut3d' : null;
  if (LUT3D.has(kind)) return 'lut3d';
  return null;
}

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

const keyOf = (kind, params) => `${kind}|${JSON.stringify(params || {})}`;

/** 1D tables by key; small, kept in a bounded Map. */
const tables1d = new Map();
/** 3D tables on the GPU by key: { texture, gen }. At most MAX_3D (64 MB each). */
const tables3d = new Map();
const MAX_3D = 3;
/** Keys seen once, waiting to come round again before a 3D table is built. */
const seenOnce = new Map();
const stats = { probes1d: 0, probes3d: 0, runs: 0 };

onDeviceLost(() => {
  for (const t of tables3d.values()) t.texture.destroy?.();
  tables3d.clear();
});

/** For tests: how many tables were built and how many GPU runs happened. */
export function gpuAdjustStats() {
  return { ...stats, tables3d: tables3d.size };
}

/** For tests: forget every table and every "seen once". */
export function clearAdjustmentTables() {
  tables1d.clear();
  for (const t of tables3d.values()) t.texture.destroy?.();
  tables3d.clear();
  seenOnce.clear();
}

function table1d(kind, params) {
  const key = keyOf(kind, params);
  let t = tables1d.get(key);
  if (t) return t;
  const ramp = new ImageData(256, 1);
  for (let i = 0; i < 256; i++) {
    ramp.data[i * 4] = i; ramp.data[i * 4 + 1] = i; ramp.data[i * 4 + 2] = i; ramp.data[i * 4 + 3] = 255;
  }
  applyAdjustment(kind, ramp, params);
  t = new Uint32Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    t[i * 4] = ramp.data[i * 4]; t[i * 4 + 1] = ramp.data[i * 4 + 1]; t[i * 4 + 2] = ramp.data[i * 4 + 2];
  }
  stats.probes1d++;
  if (tables1d.size > 64) tables1d.delete(tables1d.keys().next().value);
  tables1d.set(key, t);
  return t;
}

/** The 3D table, or null when this is the first time these settings were seen. */
function table3d(d, kind, params) {
  const key = keyOf(kind, params);
  const hit = tables3d.get(key);
  if (hit && hit.device === d) {
    tables3d.delete(key);
    tables3d.set(key, hit); // most recently used last
    return hit.texture;
  }
  if (!seenOnce.has(key)) {
    seenOnce.set(key, true);
    if (seenOnce.size > 32) seenOnce.delete(seenOnce.keys().next().value);
    return null;
  }
  // Every colour once: pixel p holds (r, g, b) = (p >> 16, p >> 8 & 255, p & 255).
  const probe = new ImageData(4096, 4096);
  const px = probe.data;
  for (let p = 0, i = 0; p < 16777216; p++, i += 4) {
    px[i] = p >> 16; px[i + 1] = (p >> 8) & 255; px[i + 2] = p & 255; px[i + 3] = 255;
  }
  applyAdjustment(kind, probe, params);
  const texture = d.createTexture({
    size: [256, 256, 256],
    dimension: '3d',
    format: 'rgba8uint',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  // x = blue, y = green, z = red: the texel at (b, g, r) is pixel p's.
  d.queue.writeTexture({ texture }, px, { bytesPerRow: 1024, rowsPerImage: 256 }, [256, 256, 256]);
  stats.probes3d++;
  while (tables3d.size >= MAX_3D) {
    const [oldKey, old] = tables3d.entries().next().value;
    old.texture.destroy();
    tables3d.delete(oldKey);
  }
  tables3d.set(key, { texture, device: d });
  return texture;
}

/* ------------------------------------------------------------------ */
/* The pass                                                            */
/* ------------------------------------------------------------------ */

const ADJUST_WGSL = /* wgsl */`${BLEND_WGSL}
struct Adjust { mode: u32, _p0: u32, _p1: u32, _p2: u32 };
@group(0) @binding(0) var acc: texture_2d<f32>;
@group(0) @binding(1) var<storage, read> lut1: array<vec4<u32>>;
@group(0) @binding(2) var lut3: texture_3d<u32>;
@group(0) @binding(3) var<uniform> A: Adjust;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  return vec4<f32>(p[vi], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let p = textureLoad(acc, vec2<i32>(pos.xy), 0);
  let a = u32(floor(p.a * 255.0 + 0.5));
  if (a == 0u) { return vec4<f32>(0.0); }
  // What getImageData would have handed the adjustment.
  let c = vec3<u32>(pk_unpremultiply8(p) * 255.0 + 0.5);
  var o: vec3<u32>;
  if (A.mode == 0u) {
    o = vec3<u32>(lut1[c.r].r, lut1[c.g].g, lut1[c.b].b);
  } else {
    o = textureLoad(lut3, vec3<i32>(i32(c.b), i32(c.g), i32(c.r)), 0).rgb;
  }
  // Stored as putImageData stores straight bytes: round(c * a / 255).
  let pm = (o * a * 2u + vec3<u32>(255u)) / 510u;
  return vec4<f32>(vec3<f32>(pm), f32(a)) / 255.0;
}
`;

let broken = false;
let dummy3d = null;

function pipeline(d) {
  const cache = pipelineCache(d);
  let p = cache.get('adjust');
  if (p) return p;
  const module = d.createShaderModule({ code: ADJUST_WGSL });
  p = d.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: presentFormat() }] },
    primitive: { topology: 'triangle-list' },
  });
  cache.set('adjust', p);
  return p;
}

/**
 * The adjusted copy of `canvas` — what the CPU path builds with getImageData,
 * applyAdjustment and putImageData — or null to run that path.
 *
 * @param {HTMLCanvasElement} canvas the composite so far
 * @param {string} kind adjustment id
 * @param {object} params the layer's params
 * @returns {HTMLCanvasElement|null}
 */
export function adjustCanvasOnGPU(canvas, kind, params) {
  if (broken) return null;
  const d = getGPUDevice();
  if (!d) return null;
  const w = canvas.width, h = canvas.height;
  if (w * h < GPU_MIN_PIXELS || !fitsTexture(d, w, h)) return null;
  const mode = adjustmentGPUMode(kind, params);
  if (!mode) return null;
  try {
    let lut1 = null, lut3 = null;
    if (mode === 'lut1d') lut1 = table1d(kind, params);
    else {
      lut3 = table3d(d, kind, params);
      if (!lut3) return null;
    }
    const p = pipeline(d);
    if (!dummy3d || dummy3d.device !== d) {
      dummy3d = {
        device: d,
        texture: d.createTexture({ size: [1, 1, 1], dimension: '3d', format: 'rgba8uint', usage: GPUTextureUsage.TEXTURE_BINDING }),
      };
    }
    const lutBuf = d.createBuffer({ size: 256 * 16, usage: GPUBufferUsage.STORAGE, mappedAtCreation: true });
    if (lut1) new Uint32Array(lutBuf.getMappedRange()).set(lut1);
    lutBuf.unmap();
    const ubuf = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
    new Uint32Array(ubuf.getMappedRange())[0] = mode === 'lut1d' ? 0 : 1;
    ubuf.unmap();

    d.pushErrorScope('validation');
    const tex = uploadCanvas(d, canvas, { slot: 'adjust', premultiplied: true });
    const view = beginPresent(d, w, h);
    const enc = d.createCommandEncoder();
    const rp = enc.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    rp.setPipeline(p);
    rp.setBindGroup(0, d.createBindGroup({
      layout: p.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: tex.createView() },
        { binding: 1, resource: { buffer: lutBuf } },
        { binding: 2, resource: (lut3 || dummy3d.texture).createView({ dimension: '3d' }) },
        { binding: 3, resource: { buffer: ubuf } },
      ],
    }));
    rp.draw(3);
    rp.end();
    d.queue.submit([enc.finish()]);
    lutBuf.destroy();
    ubuf.destroy();
    d.popErrorScope().then((err) => {
      if (err) { broken = true; console.warn('[gpu-adjust] disabled after a validation error:', err.message); }
    });
    stats.runs++;
    return endPresent(createCanvas(w, h));
  } catch (err) {
    console.warn('[gpu-adjust] failed, using the CPU path:', err && err.message);
    return null;
  }
}
