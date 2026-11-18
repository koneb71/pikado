import { pipelineCache } from './gpu-device.js';

/**
 * The exact Euclidean distance transform (src/core/distance.js) on WebGPU.
 *
 * The CPU version is Felzenszwalb and Huttenlocher's: a pass down every column
 * for the vertical distance to the nearest seed, then a pass along every row
 * taking the lower envelope of parabolas. Building that envelope is a little
 * sequential per row and its breakpoints are not exact in f32, so the row pass
 * here is the brute-force form of the same minimum instead:
 *
 *   d^2(x, y) = min over |k| <= C of  k^2 + g(x + k, y)^2
 *
 * one invocation per pixel, stopping as soon as k^2 alone exceeds the best
 * found. Every term is a small integer, so the result is the *same integer*
 * the CPU computes — for every pixel whose distance is at most the cap C. Past
 * the cap both callers' outputs are saturated (a spread's ramp has reached 0,
 * an inner glow's edge has faded out), so capping changes nothing. A caller
 * picks C with `distanceCap(r)` and declines above `MAX_DISTANCE_CAP`, where
 * the row pass gets too long to be worth it.
 *
 * Two outputs, chosen by the row pass's MODE:
 *   DT_GROW       spreadField's coverage: clamp((rad - d + 0.5) * 255)
 *   DT_GLOW_EDGE  Inner Glow's falloff from signedDistance — inside pixels
 *                 only; an outside pixel's signed distance is negative, which
 *                 always gives a full edge, so it needs no transform at all.
 */

export const DT_GROW = 0;
export const DT_GLOW_EDGE = 1;

/** Rows longer than this many taps either way decline to the CPU. */
export const MAX_DISTANCE_CAP = 256;

/** The search radius that keeps every unsaturated output exact for a radius `r`. */
export function distanceCap(r) {
  return Math.ceil(r + 0.5) + 1;
}

const DT_PARAMS = /* wgsl */`
struct DT {
  w: u32, h: u32,
  cap: u32,
  flags: u32,       // 1 = seeds are values > 127 (else <= 127); 2 = invert the glow edge
  rad: f32,         // DT_GROW: how far to grow
  size: f32,        // DT_GLOW_EDGE: the glow's size and the span of its ramp
  span: f32,
  _pad: f32,
};
`;

/** One invocation per column: the vertical distance to the nearest seed, capped at cap + 1. */
const DT_COL_WGSL = /* wgsl */`${DT_PARAMS}
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> g: array<f32>;
@group(0) @binding(2) var<uniform> P: DT;

fn isSeed(v: f32) -> bool {
  if ((P.flags & 1u) != 0u) { return v > 127.0; }
  return v <= 127.0;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x;
  if (x >= P.w) { return; }
  let far = f32(P.cap + 1u);
  var run = far;
  for (var y = 0u; y < P.h; y++) {
    let i = y * P.w + x;
    if (isSeed(src[i])) { run = 0.0; } else { run = min(run + 1.0, far); }
    g[i] = run;
  }
  run = far;
  for (var y = i32(P.h) - 1; y >= 0; y--) {
    let i = u32(y) * P.w + x;
    if (isSeed(src[i])) { run = 0.0; } else { run = min(run + 1.0, far); }
    g[i] = min(g[i], run);
  }
}
`;

/** One invocation per pixel: the nearest seed along the row, then the chosen output. */
const DT_ROW_WGSL = /* wgsl */`${DT_PARAMS}
override MODE: u32 = 0u;
@group(0) @binding(0) var<storage, read> g: array<f32>;
@group(0) @binding(1) var<storage, read_write> outF: array<f32>;
@group(0) @binding(2) var<storage, read> alphaBuf: array<f32>;
@group(0) @binding(3) var<uniform> P: DT;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= P.w || gid.y >= P.h) { return; }
  let row = gid.y * P.w;
  let x = i32(gid.x);
  let w = i32(P.w);
  let C = i32(P.cap);
  let far = f32(P.cap + 1u);
  let g0 = g[row + gid.x];
  var best = min(far * far, g0 * g0);
  for (var k = 1; k <= C; k++) {
    let kk = f32(k * k);
    if (kk >= best) { break; }
    if (x - k >= 0) { let v = g[row + u32(x - k)]; best = min(best, kk + v * v); }
    if (x + k < w) { let v = g[row + u32(x + k)]; best = min(best, kk + v * v); }
  }
  // best is an exact integer. WGSL's sqrt need not be correctly rounded, and a
  // perfect square (every distance straight along an axis) lands a spread's
  // ramp exactly on a half count, where 11.9999 and 12 round apart — so
  // return those exactly, as the CPU's correctly rounded sqrt does.
  var d = sqrt(best);
  let r = round(d);
  if (r * r == best) { d = r; }
  let i = row + gid.x;
  if (MODE == 0u) {
    outF[i] = clamp((P.rad - d + 0.5) * 255.0, 0.0, 255.0);
    return;
  }
  var e = 255.0;
  let a = alphaBuf[i];
  if (a > 127.0) {
    var sd = d - 0.5;
    if (d <= 1.5) { sd = a / 255.0 - 0.5; }
    e = 255.0 * clamp((P.size - sd) / P.span, 0.0, 1.0);
  }
  if ((P.flags & 2u) != 0u) { e = 255.0 - e; }
  outF[i] = e;
}
`;

function pipelines(d) {
  const cache = pipelineCache(d);
  let p = cache.get('distance');
  if (p) return p;
  const compute = (code, constants) => d.createComputePipeline({
    layout: 'auto',
    compute: { module: d.createShaderModule({ code }), entryPoint: 'main', constants },
  });
  p = {
    col: compute(DT_COL_WGSL),
    grow: compute(DT_ROW_WGSL, { MODE: DT_GROW }),
    glow: compute(DT_ROW_WGSL, { MODE: DT_GLOW_EDGE }),
  };
  cache.set('distance', p);
  return p;
}

/**
 * Record the two distance passes into an open compute pass.
 *
 * @param {GPUDevice} d
 * @param {GPUComputePassEncoder} pass
 * @param {{src:GPUBuffer, g:GPUBuffer, out:GPUBuffer, alpha:GPUBuffer}} bufs
 *   `src` holds the field whose > 127 (or <= 127) pixels are the seeds; `g`
 *   is scratch; `out` receives the result and may be `src`; `alpha` is the
 *   layer's alpha, read by DT_GLOW_EDGE. All are f32 per pixel.
 * @param {{w:number, h:number, mode:number, cap:number, seedsAbove:boolean,
 *          rad?:number, size?:number, span?:number, invert?:boolean}} o
 */
export function encodeDistance(d, pass, bufs, o) {
  const p = pipelines(d);
  const params = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
  const raw = params.getMappedRange();
  new Uint32Array(raw, 0, 4).set([o.w, o.h, o.cap, (o.seedsAbove ? 1 : 0) | (o.invert ? 2 : 0)]);
  new Float32Array(raw, 16, 3).set([o.rad || 0, o.size || 0, o.span || 1]);
  params.unmap();

  const bg = (pipeline, buffers) => d.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: buffers.map((b, binding) => ({ binding, resource: { buffer: b } })),
  });
  pass.setPipeline(p.col);
  pass.setBindGroup(0, bg(p.col, [bufs.src, bufs.g, params]));
  pass.dispatchWorkgroups(Math.ceil(o.w / 64));

  const row = o.mode === DT_GROW ? p.grow : p.glow;
  pass.setPipeline(row);
  pass.setBindGroup(0, bg(row, [bufs.g, bufs.out, bufs.alpha, params]));
  pass.dispatchWorkgroups(Math.ceil(o.w / 16), Math.ceil(o.h / 16));
}
