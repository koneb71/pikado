import { createCanvas } from '../core/util.js';
import {
  getGPUDevice, fitsTexture, beginPresent, endPresent, presentFormat, pipelineCache, GPU_MIN_PIXELS,
} from './gpu-device.js';

/**
 * Filters on WebGPU: the plumbing every GPU filter shares.
 *
 * A filter's contract is `apply(imageData)` — straight-alpha bytes in, bytes
 * out, synchronously. So an image goes up as its raw bytes (`writeTexture`
 * into an `rgba8uint` texture: no colour conversion, no rounding), runs
 * through one or more *stages*, each a compute pass from one such texture to
 * another, and comes back once:
 *
 *   present   the final texture is drawn into a webgpu canvas premultiplied,
 *             rounded exactly as putImageData stores straight bytes
 *             (round(c * a / 255)); that canvas is drawn into a 2D canvas in
 *             the same task and read with getImageData.
 *
 * So a GPU filter's result is byte for byte what `getImageData(putImageData(x))`
 * gives for the CPU filter's result `x` — which is what every caller does next
 * anyway: the filter runner and smart filters both put the result into a
 * canvas. Opaque pixels come back unchanged; translucent ones as any canvas
 * would store them.
 *
 * Stages are registered by kind (gpu-warp.js: 'warp'; gpu-develop.js:
 * 'develop'; 'copy' here) and chained by `runStagesOnGPU`: a run of stages costs
 * one upload and one readback, with 8-bit straight bytes between stages, as
 * between CPU filters.
 *
 * Every entry point returns null (or false) for "use the CPU": no device, an
 * image under GPU_MIN_PIXELS, too big for a texture, an unknown stage, or any
 * error.
 */

const kinds = new Map();
let broken = false;

/**
 * What a filter's `gpuStage` returns when its settings change nothing: a chain
 * drops it instead of running a pass.
 */
export const IDENTITY_STAGE = Object.freeze({ kind: 'identity' });
const stats = { runs: 0 };

/** How many stage runs the GPU has taken, for tests proving a path ran. */
export function gpuFilterStats() {
  return { ...stats };
}

/**
 * Register a stage kind.
 * @param {string} kind
 * @param {{encode(d:GPUDevice, pass:GPUComputePassEncoder, inTex:GPUTexture, outTex:GPUTexture,
 *          stage:object, w:number, h:number):(void|(() => void)), accepts?(stage:object, w:number, h:number, d:GPUDevice):boolean}} impl
 *   `encode` may return a function to run once the work is submitted.
 */
export function registerGPUStage(kind, impl) {
  kinds.set(kind, impl);
}

/** The device for a `w x h` image, or null when the GPU should not take it. */
export function gpuImageDevice(w, h) {
  if (broken) return null;
  const d = getGPUDevice();
  if (!d) return null;
  if (w * h < GPU_MIN_PIXELS || !fitsTexture(d, w, h)) return null;
  return d;
}

/** True once a validation error has switched GPU filters off for this session. */
export function gpuFiltersBroken() {
  return broken;
}

/* ------------------------------------------------------------------ */
/* Textures                                                            */
/* ------------------------------------------------------------------ */

const images = new WeakMap(); // device -> { a, b, w, h }

/** Two `rgba8uint` textures to ping-pong between, reused while the size holds. */
function imageTextures(d, w, h) {
  let t = images.get(d);
  if (!t || t.w !== w || t.h !== h) {
    if (t) { t.a.destroy(); t.b.destroy(); }
    const make = () => d.createTexture({
      size: [w, h],
      format: 'rgba8uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST,
    });
    t = { a: make(), b: make(), w, h };
    images.set(d, t);
  }
  return t;
}

/** Drop the image textures (a dialog closing, say). The next run makes new ones. */
export function trimGPUScratch() {
  const d = getGPUDevice();
  const t = d && images.get(d);
  if (t) {
    t.a.destroy();
    t.b.destroy();
    images.delete(d);
  }
}

function writeImage(d, tex, imageData) {
  const { width: w, height: h, data } = imageData;
  d.queue.writeTexture({ texture: tex }, data, { bytesPerRow: w * 4, rowsPerImage: h }, [w, h]);
}

/* ------------------------------------------------------------------ */
/* Present                                                             */
/* ------------------------------------------------------------------ */

const PRESENT_WGSL = /* wgsl */`
@group(0) @binding(0) var img: texture_2d<u32>;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  return vec4<f32>(p[vi], 0.0, 1.0);
}

// Straight bytes to what putImageData stores: round(c * a / 255), computed
// exactly in integers (2ca + 255 is odd, so there is never a tie to break).
@fragment
fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let p = textureLoad(img, vec2<i32>(pos.xy), 0);
  let c = (p.rgb * p.a * 2u + vec3<u32>(255u)) / 510u;
  return vec4<f32>(vec3<f32>(c), f32(p.a)) / 255.0;
}
`;

const COPY_WGSL = /* wgsl */`
@group(0) @binding(0) var src: texture_2d<u32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba8uint, write>;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let size = textureDimensions(src);
  if (g.x >= size.x || g.y >= size.y) { return; }
  textureStore(dst, vec2<i32>(g.xy), textureLoad(src, vec2<i32>(g.xy), 0));
}
`;

function presentPipeline(d) {
  const cache = pipelineCache(d);
  let p = cache.get('image-present');
  if (!p) {
    const module = d.createShaderModule({ code: PRESENT_WGSL });
    p = d.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: presentFormat() }] },
      primitive: { topology: 'triangle-list' },
    });
    cache.set('image-present', p);
  }
  return p;
}

/** A compute pipeline from WGSL, built once per device under `name`. */
export function computePipeline(d, name, code, constants) {
  const cache = pipelineCache(d);
  let p = cache.get(name);
  if (!p) {
    p = d.createComputePipeline({
      layout: 'auto',
      compute: { module: d.createShaderModule({ code }), entryPoint: 'main', constants },
    });
    cache.set(name, p);
  }
  return p;
}

/** A bind group from a list of resources, bound in order from 0. */
export function bindGroup(d, pipeline, resources) {
  return d.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: resources.map((r, binding) => ({
      binding,
      resource: r instanceof GPUBuffer ? { buffer: r } : r,
    })),
  });
}

/** A buffer holding `data` (a typed array), for uniforms or read-only storage. */
export function dataBuffer(d, data, usage) {
  const size = Math.max(16, Math.ceil(data.byteLength / 4) * 4);
  const b = d.createBuffer({ size, usage, mappedAtCreation: true });
  new Uint8Array(b.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  b.unmap();
  return b;
}

registerGPUStage('copy', {
  encode(d, pass, inTex, outTex, stage, w, h) {
    const p = computePipeline(d, 'image-copy', COPY_WGSL);
    pass.setPipeline(p);
    pass.setBindGroup(0, bindGroup(d, p, [inTex.createView(), outTex.createView()]));
    pass.dispatchWorkgroups(Math.ceil(w / 16), Math.ceil(h / 16));
  },
});

/* ------------------------------------------------------------------ */
/* Running stages                                                      */
/* ------------------------------------------------------------------ */

/**
 * Encode the stages and the present pass; returns false when any stage
 * declines. The caller submits nothing — this submits, in the same task.
 */
function runInto(d, imageData, stages) {
  const w = imageData.width, h = imageData.height;
  for (const s of stages) {
    const k = kinds.get(s.kind);
    if (!k || (k.accepts && !k.accepts(s, w, h, d))) return false;
  }
  const t = imageTextures(d, w, h);
  writeImage(d, t.a, imageData);
  d.pushErrorScope('validation');
  const enc = d.createCommandEncoder();
  let cur = t.a, next = t.b;
  const after = [];
  if (stages.length) {
    const pass = enc.beginComputePass();
    for (const s of stages) {
      const done = kinds.get(s.kind).encode(d, pass, cur, next, s, w, h);
      if (typeof done === 'function') after.push(done);
      [cur, next] = [next, cur];
    }
    pass.end();
  }
  const view = beginPresent(d, w, h);
  const rp = enc.beginRenderPass({
    colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
  });
  const pp = presentPipeline(d);
  rp.setPipeline(pp);
  rp.setBindGroup(0, bindGroup(d, pp, [cur.createView()]));
  rp.draw(3);
  rp.end();
  d.queue.submit([enc.finish()]);
  // A stage's encode may return a clean-up (freeing scratch buffers), which
  // is safe once the work that uses them has been submitted.
  for (const f of after) f();
  d.popErrorScope().then((err) => {
    if (err) { broken = true; console.warn('[gpu-filters] disabled after a validation error:', err.message); }
  });
  stats.runs++;
  return true;
}

/**
 * Run `stages` over `imageData` and write the result back into it.
 * @param {ImageData} imageData
 * @param {{kind:string}[]} stages
 * @returns {ImageData|null} `imageData`, or null for "run the CPU path" (it is
 *   then untouched)
 */
export function runStagesOnGPU(imageData, stages) {
  const d = gpuImageDevice(imageData.width, imageData.height);
  if (!d) return null;
  try {
    const out = createCanvas(imageData.width, imageData.height);
    const ctx = out.getContext('2d', { willReadFrequently: true });
    if (!runInto(d, imageData, stages)) return null;
    endPresent(out);
    imageData.data.set(ctx.getImageData(0, 0, out.width, out.height).data);
    return imageData;
  } catch (err) {
    console.warn('[gpu-filters] failed, using the CPU path:', err && err.message);
    return null;
  }
}

/**
 * Run `stages` over `imageData` and draw the result into `ctx`'s canvas (which
 * must be the image's size), replacing it — no readback at all. For live
 * previews that only need to be seen.
 * @returns {boolean} false for "draw it the CPU way"
 */
export function runStagesToCanvas(imageData, stages, ctx) {
  const w = imageData.width, h = imageData.height;
  if (ctx.canvas.width !== w || ctx.canvas.height !== h) return false;
  const d = gpuImageDevice(w, h);
  if (!d) return false;
  try {
    if (!runInto(d, imageData, stages)) return false;
    endPresent(ctx.canvas);
    return true;
  } catch (err) {
    console.warn('[gpu-filters] preview failed, using the CPU path:', err && err.message);
    return false;
  }
}
