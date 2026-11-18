import { registerGPUStage, dataBuffer, runStagesOnGPU } from './gpu-filters.js';
import { pipelineCache, fitsStorage } from './gpu-device.js';
import { WGSL_MATH } from './wgsl-math.js';

/**
 * The heavy filters on WebGPU: the `imgf` stage.
 *
 * Each op mirrors a CPU filter in src/filters/ line for line, including where
 * the CPU rounds and the alpha cut-off it unpremultiplies with (0.4 in
 * `unpremultiplyInto`, 0.5 in `separableConvolve`):
 *
 *   blur        premultiply, a separable kernel or box passes (as
 *               gaussianBlurBuffer / boxBlurBuffer / convolveBuffer run them),
 *               unpremultiply — Box Blur, Blur, Blur More, and Gaussian
 *               Blur where the browser has no canvas blur (Safari)
 *   unsharp     blur a premultiplied copy, then unsharpPass: thresholds, the
 *               Sobel gate, "keep the pixel" where the blur's alpha is <= 0.4
 *               — Unsharp Mask, Sharpen (More, Edges), Smart Sharpen (Gaussian)
 *   highpass    four premultiplied planes, three box passes, the combine
 *   range       rangeBlurImageData: horizontal pass into float, vertical
 *               pass out to bytes — Surface Blur, Smart Blur (Normal)
 *   median      an exact per-channel median by bitwise selection, optionally
 *               Dust & Scratches' restore; radius <= 5
 *   despeckle   SOFT3 blur, unpremultiply to bytes, then the Sobel blend back
 *   noise       Add Noise: the CPU's own xorshift generator, jumped ahead to
 *               each pixel's draw with 32x32 GF(2) matrices, so every pixel
 *               gets the very numbers the sequential CPU loop gives it
 *
 * The ops that blur keep the image in float planes in between (16 bytes a
 * pixel each, two of them) and decline when that does not fit; Median and
 * Add Noise go straight from texture to texture.
 */

const L_WGSL = /* wgsl */`${WGSL_MATH}
struct U {
  w: u32, h: u32, kr: i32, koff: u32,
  a0: f32, a1: f32, a2: f32, a3: f32,
  i0: u32, i1: u32, i2: u32, i3: u32,
};
@group(0) @binding(0) var src: texture_2d<u32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba8uint, write>;
@group(0) @binding(2) var<storage, read_write> pA: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> pB: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> C: array<f32>;
@group(0) @binding(5) var<uniform> P: U;
@group(0) @binding(6) var<storage, read> M: array<u32>;

fn idx(x: i32, y: i32) -> u32 {
  return u32(clamp(y, 0, i32(P.h) - 1)) * P.w + u32(clamp(x, 0, i32(P.w) - 1));
}
fn px(x: i32, y: i32) -> vec4<f32> {
  return vec4<f32>(textureLoad(src, vec2<i32>(clamp(x, 0, i32(P.w) - 1), clamp(y, 0, i32(P.h) - 1)), 0));
}
fn u8v(v: vec4<f32>) -> vec4<u32> {
  return vec4<u32>(u32(pk_u8(v.x)), u32(pk_u8(v.y)), u32(pk_u8(v.z)), u32(pk_u8(v.w)));
}
fn rd(dir: u32, i: u32) -> vec4<f32> { if (dir == 0u) { return pA[i]; } return pB[i]; }
fn wr(dir: u32, i: u32, v: vec4<f32>) { if (dir == 0u) { pB[i] = v; } else { pA[i] = v; } }
// luminancePlane + sobelMagnitude, on straight bytes, clamped.
fn lum(x: i32, y: i32) -> f32 { let p = px(x, y); return 0.299 * p.r + 0.587 * p.g + 0.114 * p.b; }
fn sobel(x: i32, y: i32) -> f32 {
  let a = lum(x - 1, y - 1); let b = lum(x, y - 1); let c = lum(x + 1, y - 1);
  let d = lum(x - 1, y); let f = lum(x + 1, y);
  let g = lum(x - 1, y + 1); let i = lum(x, y + 1); let j = lum(x + 1, y + 1);
  let gx = (c + 2.0 * f + j) - (a + 2.0 * d + g);
  let gy = (g + 2.0 * i + j) - (a + 2.0 * b + c);
  return sqrt(gx * gx + gy * gy) / 4.0;
}
fn smooth01(t: f32) -> f32 { if (t <= 0.0) { return 0.0; } if (t >= 1.0) { return 1.0; } return t * t * (3.0 - 2.0 * t); }
`;

const K = {
  // premultiplyImageData: src -> pA
  PREMULT: `
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.w || g.y >= P.h) { return; }
  let p = vec4<f32>(textureLoad(src, vec2<i32>(g.xy), 0));
  let f = p.a / 255.0;
  pA[g.y * P.w + g.x] = vec4<f32>(p.rgb * f, p.a);
}`,
  // convolveBuffer's pass: clamped taps of C[koff..]
  CONV: `
override AXIS: u32 = 0u;
override DIR: u32 = 0u;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.w || g.y >= P.h) { return; }
  let x = i32(g.x); let y = i32(g.y);
  var s = vec4<f32>(0.0);
  for (var k = -P.kr; k <= P.kr; k++) {
    var i: u32;
    if (AXIS == 0u) { i = idx(x + k, y); } else { i = idx(x, y + k); }
    s += rd(DIR, i) * C[P.koff + u32(k + P.kr)];
  }
  wr(DIR, g.y * P.w + g.x, s);
}`,
  // boxPassH / boxPassV: one line per invocation, running sum, edges extended
  BOX: `
override AXIS: u32 = 0u;
override DIR: u32 = 0u;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  var lines = P.h; var len = P.w;
  if (AXIS == 1u) { lines = P.w; len = P.h; }
  let ln = g.x;
  if (ln >= lines) { return; }
  var base = ln * P.w; var stride = 1u;
  if (AXIS == 1u) { base = ln; stride = P.w; }
  let r = P.kr;
  let last = i32(len) - 1;
  let norm = 1.0 / f32(2 * r + 1);
  var sum = vec4<f32>(0.0);
  for (var i = -r; i <= r; i++) { sum += rd(DIR, base + u32(clamp(i, 0, last)) * stride); }
  for (var n = 0; n <= last; n++) {
    wr(DIR, base + u32(n) * stride, sum * norm);
    sum += rd(DIR, base + u32(clamp(n + r + 1, 0, last)) * stride) - rd(DIR, base + u32(clamp(n - r, 0, last)) * stride);
  }
}`,
  // unpremultiplyInto (cut a0): pA -> dst
  UNPREM: `
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.w || g.y >= P.h) { return; }
  let b = pA[g.y * P.w + g.x];
  var o = vec4<u32>(0u);
  if (b.a > P.a0) { o = u8v(vec4<f32>(b.rgb * (255.0 / b.a), b.a)); }
  textureStore(dst, vec2<i32>(g.xy), o);
}`,
  // unsharpPass: src (straight) + pA (blurred, premultiplied) -> dst
  UNSHARP: `
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.w || g.y >= P.h) { return; }
  let x = i32(g.x); let y = i32(g.y);
  let d = vec4<f32>(textureLoad(src, vec2<i32>(g.xy), 0));
  let b = pA[g.y * P.w + g.x];
  var gate = 1.0;
  if (P.i0 == 1u) { gate = smooth01((sobel(x, y) - 6.0) / 20.0); }
  if (b.a <= 0.4 || gate <= 0.0) { textureStore(dst, vec2<i32>(g.xy), vec4<u32>(d)); return; }
  var dd = d.rgb - b.rgb * (255.0 / b.a);
  let hard = P.a1;
  let soft = P.a2;
  if (hard > 0.0) { dd = select(dd, vec3<f32>(0.0), (dd > vec3<f32>(-hard)) & (dd < vec3<f32>(hard))); }
  if (soft > 0.0) {
    dd = select(select(vec3<f32>(0.0), dd + soft, dd < vec3<f32>(-soft)), dd - soft, dd > vec3<f32>(soft));
  }
  let k = P.a0 * gate;
  let o = d.rgb + dd * k;
  textureStore(dst, vec2<i32>(g.xy), vec4<u32>(u8v(vec4<f32>(o, d.a)).rgb, u32(d.a)));
}`,
  // high-pass combine: src + pA (blurred planes) -> dst
  HIGHPASS: `
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.w || g.y >= P.h) { return; }
  let d = vec4<f32>(textureLoad(src, vec2<i32>(g.xy), 0));
  if (d.a == 0.0) { textureStore(dst, vec2<i32>(g.xy), vec4<u32>(128u, 128u, 128u, 0u)); return; }
  let b = pA[g.y * P.w + g.x];
  var un = 0.0;
  if (b.a > 0.5) { un = 255.0 / b.a; }
  let o = d.rgb - b.rgb * un + 128.0;
  textureStore(dst, vec2<i32>(g.xy), vec4<u32>(u8v(vec4<f32>(o, d.a)).rgb, u32(d.a)));
}`,
  // rangePass: H from src bytes into pA (AXIS 0), V from pA out to dst bytes (AXIS 1)
  RANGE: `
override AXIS: u32 = 0u;
fn val(i: i32, x: i32, y: i32) -> vec4<f32> {
  if (AXIS == 0u) { return px(x + i, y); }
  return pA[idx(x, y + i)];
}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.w || g.y >= P.h) { return; }
  let x = i32(g.x); let y = i32(g.y);
  let c = val(0, x, y);
  var acc = c;
  var wsum = 1.0;
  let thr = P.a0;
  let invThr = 1.0 / max(1.0, thr);
  for (var t = 0u; t < P.i0; t++) {
    let k = i32(C[P.koff + t * 2u]);
    let base = C[P.koff + t * 2u + 1u];
    for (var s = 0; s < 2; s++) {
      var o = k;
      if (s == 0) { o = -k; }
      let v = val(o, x, y);
      let dv = abs(v - c);
      let dmax = max(max(dv.x, dv.y), max(dv.z, dv.w));
      var wrg = select(1.0, 0.0, dmax > thr);
      if (P.i1 == 1u) { wrg = 1.0 - dmax * invThr; }
      if (wrg > 0.0) {
        let ww = wrg * base;
        acc += v * ww;
        wsum += ww;
      }
    }
  }
  let r = acc / wsum;
  if (AXIS == 0u) { pA[g.y * P.w + g.x] = r; }
  else { textureStore(dst, vec2<i32>(g.xy), u8v(r)); }
}`,
  // median (and Dust & Scratches' restore): src -> dst
  MEDIAN: `
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.w || g.y >= P.h) { return; }
  let x = i32(g.x); let y = i32(g.y);
  let r = P.kr;
  let win = 2 * r + 1;
  let k = u32((win * win) >> 1u);
  var prefix = vec4<u32>(0u);
  for (var bit = 7; bit >= 0; bit--) {
    let cand = prefix | vec4<u32>(1u << u32(bit));
    var cnt = vec4<u32>(0u);
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r; dx <= r; dx++) {
        let v = textureLoad(src, vec2<i32>(clamp(x + dx, 0, i32(P.w) - 1), clamp(y + dy, 0, i32(P.h) - 1)), 0);
        cnt += select(vec4<u32>(0u), vec4<u32>(1u), v < cand);
      }
    }
    prefix = select(prefix, cand, cnt <= vec4<u32>(k));
  }
  var o = prefix;
  if (P.i0 == 1u) {
    let orig = textureLoad(src, vec2<i32>(g.xy), 0);
    let dv = vec4<i32>(orig) - vec4<i32>(prefix);
    let diff = max(max(abs(dv.x), abs(dv.y)), max(abs(dv.z), abs(dv.w)));
    if (f32(diff) <= P.a0) { o = orig; }
  }
  textureStore(dst, vec2<i32>(g.xy), o);
}`,
  // despeckle: src + pA (SOFT3-blurred, premultiplied) -> dst
  DESPECKLE: `
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.w || g.y >= P.h) { return; }
  let x = i32(g.x); let y = i32(g.y);
  let b = pA[g.y * P.w + g.x];
  var d = vec4<f32>(0.0);
  if (b.a > 0.4) { d = vec4<f32>(u8v(vec4<f32>(b.rgb * (255.0 / b.a), b.a))); }
  let t = smooth01((sobel(x, y) - 10.0) / 24.0);
  if (t > 0.0) {
    let orig = vec4<f32>(textureLoad(src, vec2<i32>(g.xy), 0));
    d = vec4<f32>(u8v(d + (orig - d) * t));
  }
  textureStore(dst, vec2<i32>(g.xy), vec4<u32>(d));
}`,
  // Add Noise: the CPU's xorshift, jumped ahead per pixel
  NOISE: `
fn stepX(s0: u32) -> u32 {
  var s = s0 ^ (s0 << 13u);
  s = s ^ bitcast<u32>(bitcast<i32>(s) >> 17u);
  return s ^ (s << 5u);
}
// M holds 27 matrices (powers 2^0..2^26), 32 rows each: bit j of row i set when
// output bit i takes input bit j.
fn jump(s0: u32, t: u32) -> u32 {
  var s = s0;
  for (var k = 0u; k < 27u; k++) {
    if (((t >> k) & 1u) == 0u) { continue; }
    var o = 0u;
    for (var i = 0u; i < 32u; i++) {
      if ((countOneBits(M[k * 32u + i] & s) & 1u) != 0u) { o |= 1u << i; }
    }
    s = o;
  }
  return s;
}
fn unit(s: u32) -> f32 { return f32(s >> 16u) / 65536.0 + f32(s & 65535u) / 4294967296.0; }
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.w || g.y >= P.h) { return; }
  let i = g.y * P.w + g.x;
  let d = vec4<f32>(textureLoad(src, vec2<i32>(g.xy), 0));
  let gaussian = P.i0 == 1u;
  let mono = P.i1 == 1u;
  var n = 1u;
  if (!mono) { n = 3u; }
  let j0 = i * n;                      // the first draw (or normal) this pixel uses
  var vals = vec3<f32>(0.0);
  if (!gaussian) {
    var s = jump(P.i2, j0 + 1u);       // state after j0 + 1 steps: draw number j0 (0-based)
    vals.x = unit(s) * 2.0 - 1.0;
    if (!mono) {
      s = stepX(s); vals.y = unit(s) * 2.0 - 1.0;
      s = stepX(s); vals.z = unit(s) * 2.0 - 1.0;
    }
  } else {
    // Normal j comes from pair j >> 1: draws 2p + 1 (radius) and 2p + 2 (angle),
    // cos for even j and sin for odd.
    let p0 = j0 >> 1u;
    var s = jump(P.i2, 2u * p0 + 1u);
    var pairU = unit(s);
    s = stepX(s);
    var pairA = unit(s);
    var p = p0;
    for (var c = 0u; c < n; c++) {
      let j = j0 + c;
      if ((j >> 1u) != p) {
        p = j >> 1u;
        s = stepX(s); pairU = unit(s);
        s = stepX(s); pairA = unit(s);
      }
      let u = max(pairU, 1e-7);
      let m = sqrt(-2.0 * log(u));
      let sc = pk_sincos(6.283185307179586 * pairA);
      var v = m * sc.y;
      if ((j & 1u) == 1u) { v = m * sc.x; }
      vals[c] = v;
    }
  }
  if (mono) { vals = vec3<f32>(vals.x); }
  let o = d.rgb + vals * P.a0;
  textureStore(dst, vec2<i32>(g.xy), vec4<u32>(u8v(vec4<f32>(o, d.a)).rgb, u32(d.a)));
}`,
};

function pipelines(d) {
  const cache = pipelineCache(d);
  let p = cache.get('imgf');
  if (p) return p;
  const st = (type) => ({ visibility: GPUShaderStage.COMPUTE, buffer: { type } });
  const layout = d.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'uint' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8uint' } },
      { binding: 2, ...st('storage') },
      { binding: 3, ...st('storage') },
      { binding: 4, ...st('read-only-storage') },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 6, ...st('read-only-storage') },
    ],
  });
  const pl = d.createPipelineLayout({ bindGroupLayouts: [layout] });
  const make = (name, constants) => d.createComputePipeline({
    layout: pl,
    compute: { module: d.createShaderModule({ code: L_WGSL + K[name] }), entryPoint: 'main', constants },
  });
  p = {
    layout,
    premult: make('PREMULT'),
    // Horizontal pA -> pB, vertical pB -> pA: a blur step ends back in pA.
    convH: make('CONV', { AXIS: 0, DIR: 0 }),
    convV: make('CONV', { AXIS: 1, DIR: 1 }),
    boxH: make('BOX', { AXIS: 0, DIR: 0 }),
    boxV: make('BOX', { AXIS: 1, DIR: 1 }),
    unprem: make('UNPREM'),
    unsharp: make('UNSHARP'),
    highpass: make('HIGHPASS'),
    rangeH: make('RANGE', { AXIS: 0 }),
    rangeV: make('RANGE', { AXIS: 1 }),
    median: make('MEDIAN'),
    despeckle: make('DESPECKLE'),
    noise: make('NOISE'),
  };
  cache.set('imgf', p);
  return p;
}

/* ------------------------------------------------------------------ */
/* Stages                                                              */
/* ------------------------------------------------------------------ */

/**
 * An `imgf` stage. `op` is one of the ops above; a `blur` plan is
 * `{kernel}` (one separable pass, as convolveBuffer) or `{boxes}` (box passes
 * H then V at each radius, as boxPassH/boxPassV), or null for none.
 */
export function imageFilterStage(op, o = {}) {
  return { kind: 'imgf', op, ...o };
}

/**
 * Run a filter's GPU stage (or stages) over `imageData` in place.
 * @returns {boolean} false for "run the CPU filter" (imageData untouched)
 */
export function filterOnGPU(imageData, st) {
  if (!st) return false;
  const stages = (Array.isArray(st) ? st : [st]).filter((s) => s.kind !== 'identity');
  if (!stages.length) return true;
  return runStagesOnGPU(imageData, stages) !== null;
}

/* ------------------------------------------------------------------ */
/* Add Noise's generator, jumped ahead                                 */
/* ------------------------------------------------------------------ */

/** One step of makeRandom's generator (src/filters/registry.js), exactly. */
function xorshiftStep(s) {
  s ^= s << 13; s >>>= 0;
  s ^= s >> 17;
  s ^= s << 5; s >>>= 0;
  return s;
}

let noiseMatrices = null;
/** 27 x 32 rows: the step matrix raised to 2^0 .. 2^26, over GF(2). */
export function xorshiftJumpMatrices() {
  if (noiseMatrices) return noiseMatrices;
  // The step is linear over GF(2): its matrix's column j is step(1 << j).
  const cols = new Uint32Array(32);
  for (let j = 0; j < 32; j++) cols[j] = xorshiftStep((1 << j) >>> 0);
  const rowsOf = (c) => {
    const r = new Uint32Array(32);
    for (let i = 0; i < 32; i++) {
      let row = 0;
      for (let j = 0; j < 32; j++) if ((c[j] >>> i) & 1) row |= 1 << j;
      r[i] = row >>> 0;
    }
    return r;
  };
  const apply = (rows, s) => {
    let o = 0;
    for (let i = 0; i < 32; i++) {
      let v = (rows[i] & s) >>> 0, par = 0;
      while (v) { par ^= 1; v &= v - 1; }
      if (par) o |= 1 << i;
    }
    return o >>> 0;
  };
  const out = new Uint32Array(27 * 32);
  let rows = rowsOf(cols);
  for (let k = 0; k < 27; k++) {
    out.set(rows, k * 32);
    // Square: column j of M^2 is M applied to column j of M.
    const c2 = new Uint32Array(32);
    for (let j = 0; j < 32; j++) c2[j] = apply(rows, apply(rows, (1 << j) >>> 0));
    rows = rowsOf(c2);
  }
  noiseMatrices = out;
  return out;
}

/** The generator's state after `t` steps from `s0`, via the matrices (for tests). */
export function xorshiftJump(s0, t) {
  const M = xorshiftJumpMatrices();
  let s = s0 >>> 0;
  for (let k = 0; k < 27; k++) {
    if (!((t >>> k) & 1)) continue;
    let o = 0;
    for (let i = 0; i < 32; i++) {
      let v = (M[k * 32 + i] & s) >>> 0, par = 0;
      while (v) { par ^= 1; v &= v - 1; }
      if (par) o |= 1 << i;
    }
    s = o >>> 0;
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* Encoding                                                            */
/* ------------------------------------------------------------------ */

/** Median and Add Noise work straight from texture to texture. */
function usesPlanes(stage) {
  return stage.op !== 'median' && stage.op !== 'noise';
}

registerGPUStage('imgf', {
  accepts(stage, w, h, d) {
    if (usesPlanes(stage) && (!fitsStorage(d, w * h * 16) || w * h * 32 > 1024 * 1024 * 1024)) return false;
    if (stage.op === 'median' && !(stage.radius >= 1 && stage.radius <= 5)) return false;
    // Add Noise's jump covers 2^27 draws: three a pixel up to ~44 MP.
    if (stage.op === 'noise' && w * h * 3 + 3 >= 2 ** 27) return false;
    return true;
  },
  encode(d, pass, inTex, outTex, stage, w, h) {
    const p = pipelines(d);
    const n = w * h;
    const planes = usesPlanes(stage);
    const pA = d.createBuffer({ size: planes ? n * 16 : 16, usage: GPUBufferUsage.STORAGE });
    const pB = d.createBuffer({ size: planes && stage.blur ? n * 16 : 16, usage: GPUBufferUsage.STORAGE });
    // Constants: kernels and taps, laid out by the plan.
    const consts = [];
    const push = (arr) => { const off = consts.length; consts.push(...arr); return off; };
    const blurOps = [];
    const plan = stage.blur;
    if (plan && plan.kernel) blurOps.push({ conv: true, kr: (plan.kernel.length - 1) >> 1, koff: push(plan.kernel) });
    if (plan && plan.boxes) for (const r of plan.boxes) blurOps.push({ conv: false, kr: r });
    let rangeOff = 0;
    if (stage.op === 'range') {
      const flat = [];
      for (let t = 0; t < stage.taps.length; t++) flat.push(stage.taps[t], stage.spatial[t]);
      rangeOff = push(flat);
    }
    const C = dataBuffer(d, new Float32Array(consts.length ? consts : [0]), GPUBufferUsage.STORAGE);
    const Mb = dataBuffer(d, stage.op === 'noise' ? xorshiftJumpMatrices() : new Uint32Array(4), GPUBufferUsage.STORAGE);
    const views = [inTex.createView(), outTex.createView()];
    const gx = Math.ceil(w / 16), gy = Math.ceil(h / 16);
    const uniforms = [];
    const run = (pipe, u = {}, lines = 0) => {
      const ub = new ArrayBuffer(48);
      const ui = new Uint32Array(ub), si = new Int32Array(ub), f = new Float32Array(ub);
      ui[0] = w; ui[1] = h; si[2] = u.kr | 0; ui[3] = u.koff | 0;
      f[4] = u.a0 || 0; f[5] = u.a1 || 0; f[6] = u.a2 || 0; f[7] = u.a3 || 0;
      ui[8] = u.i0 >>> 0; ui[9] = u.i1 >>> 0; ui[10] = u.i2 >>> 0; ui[11] = u.i3 >>> 0;
      const U = dataBuffer(d, new Uint8Array(ub), GPUBufferUsage.UNIFORM);
      uniforms.push(U);
      pass.setPipeline(pipe);
      pass.setBindGroup(0, d.createBindGroup({
        layout: p.layout,
        entries: [
          { binding: 0, resource: views[0] },
          { binding: 1, resource: views[1] },
          { binding: 2, resource: { buffer: pA } },
          { binding: 3, resource: { buffer: pB } },
          { binding: 4, resource: { buffer: C } },
          { binding: 5, resource: { buffer: U } },
          { binding: 6, resource: { buffer: Mb } },
        ],
      }));
      if (lines) pass.dispatchWorkgroups(Math.ceil(lines / 64));
      else pass.dispatchWorkgroups(gx, gy);
    };
    // Blur pA in place (ping-pong through pB): H then V for each step.
    const blurA = () => {
      for (const b of blurOps) {
        if (b.conv) {
          run(p.convH, { kr: b.kr, koff: b.koff });
          run(p.convV, { kr: b.kr, koff: b.koff });
        } else {
          run(p.boxH, { kr: b.kr }, h);
          run(p.boxV, { kr: b.kr }, w);
        }
      }
    };

    switch (stage.op) {
      case 'blur':
        run(p.premult); blurA(); run(p.unprem, { a0: stage.cut ?? 0.4 });
        break;
      case 'unsharp':
        run(p.premult); blurA();
        run(p.unsharp, { a0: stage.amount, a1: stage.hard || 0, a2: stage.soft || 0, i0: stage.gate ? 1 : 0 });
        break;
      case 'highpass':
        run(p.premult); blurA(); run(p.highpass);
        break;
      case 'range':
        run(p.rangeH, { koff: rangeOff, a0: stage.thr, i0: stage.taps.length, i1: stage.tent ? 1 : 0 });
        run(p.rangeV, { koff: rangeOff, a0: stage.thr, i0: stage.taps.length, i1: stage.tent ? 1 : 0 });
        break;
      case 'median':
        run(p.median, { kr: stage.radius, i0: stage.dust ? 1 : 0, a0: stage.dust ? stage.threshold : 0 });
        break;
      case 'despeckle':
        run(p.premult); blurA(); run(p.despeckle);
        break;
      case 'noise':
        run(p.noise, { a0: stage.scale, i0: stage.gaussian ? 1 : 0, i1: stage.mono ? 1 : 0, i2: stage.seedState });
        break;
      default:
        throw new Error(`unknown imgf op ${stage.op}`);
    }
    return () => { pA.destroy(); pB.destroy(); C.destroy(); Mb.destroy(); for (const u of uniforms) u.destroy(); };
  },
});
