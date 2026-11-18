import { WGSL_MATH } from './wgsl-math.js';
import { registerGPUStage, dataBuffer } from './gpu-filters.js';
import { pipelineCache, fitsStorage } from './gpu-device.js';

/**
 * Filter > Camera Raw on WebGPU: the `develop` stage.
 *
 * `developOnGPU` in src/filters/camera-raw.js builds a plan — every table,
 * gain, radius and the grain field, computed by the very functions the CPU
 * develop uses — and this runs it: the image in linear light as float32, one
 * pixel per invocation for the point stages and one line per invocation for
 * the blurs, back to bytes at the end. The stages, in Camera Raw's order:
 *
 *   pre      decode (TO_LINEAR), white balance, exposure, the tone-region
 *            curve, contrast, the tone curve
 *   local    Clarity, Texture: luminance, blurred as gaussianBlurBuffer blurs
 *            (a true kernel up to sigma 2.5, three box passes above), added back
 *            weighted towards the midtones
 *   colour   the HSL mixer, Vibrance, Saturation, black and white, colour grading
 *   local    Sharpening
 *   nr       luminance noise reduction, then colour noise reduction
 *   post     grain, vignette, encode (TO_SRGB) — alpha passes through
 *
 * Dehaze needs a global order statistic (the 99.9th percentile of its dark
 * channel), so a develop with Dehaze stays on the CPU.
 *
 * Constants live in one float array, C. The fixed part is laid out by the
 * offsets below, shared with camera-raw.js through DEVELOP_LAYOUT; kernels and
 * the grain field follow at offsets the plan records.
 */

export const DEVELOP_LAYOUT = {
  TOLIN: 0,        // 256
  TOSRGB: 256,     // 4097
  TONE: 4353,      // 257
  CONTRAST: 4610,  // 257
  CURVES: 4867,    // rgb, r, g, b: 256 each
  S: 5891,         // scalars, see S_* below
  BANDS: 5955,     // 8 bands x (hue, left gap, right gap, hue shift, sat, lum)
  VAR: 6016,       // kernels, grain field
};

/** Scalar slots, relative to DEVELOP_LAYOUT.S. */
export const S = {
  WB: 0, EXPK: 3, HAS_WB: 4, HAS_EXP: 5, HAS_TONE: 6, HAS_CONTRAST: 7, CURVE: 8, // CURVE..CURVE+3: rgb, r, g, b
  ANY_HSL: 12, VIBRANCE: 13, SATURATION: 14, BW: 15, DO_COLOUR: 16,
  HL_SAT: 17, SH_SAT: 18, PIVOT: 19, HL_TINT: 20, SH_TINT: 23,
  GRAIN: 26, GW: 27, GH: 28, GSCALE: 29, GOFF: 30,
  VIG: 31, VSTART: 32, VCX: 33, VCY: 34, VMAXR: 35,
  NR_LUM: 36, NR_THRESH: 37, NR_COL: 38,
};

const L = DEVELOP_LAYOUT;

const COMMON = /* wgsl */`${WGSL_MATH}
struct U { w: u32, h: u32, kr: i32, koff: u32, amount: f32, detail: f32, mode: u32, _p: u32 };
@group(0) @binding(0) var src: texture_2d<u32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba8uint, write>;
@group(0) @binding(2) var<storage, read_write> lin: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> pA: array<f32>;
@group(0) @binding(4) var<storage, read_write> pB: array<f32>;
@group(0) @binding(5) var<storage, read_write> pC: array<f32>;
@group(0) @binding(6) var<storage, read_write> pD: array<f32>;
@group(0) @binding(7) var<storage, read> C: array<f32>;
@group(0) @binding(8) var<uniform> P: U;

fn sc(i: u32) -> f32 { return C[${L.S}u + i]; }
fn clamp01(v: f32) -> f32 { return clamp(v, 0.0, 1.0); }
fn lum709(c: vec3<f32>) -> f32 { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }
// v ** e for v > 0, and 0 at or below it — the guard every call site in the JS has.
fn pw(v: f32, e: f32) -> f32 { if (v <= 0.0) { return 0.0; } return pow(v, e); }
fn sampleLUT(off: u32, v: f32) -> f32 {
  let x = clamp01(v) * 256.0;
  let i = min(255u, u32(x));
  let t = x - f32(i);
  return C[off + i] + (C[off + i + 1u] - C[off + i]) * t;
}
fn px(g: vec3<u32>) -> u32 { return g.y * P.w + g.x; }
`;

const PRE = /* wgsl */`
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.w || g.y >= P.h) { return; }
  let p = textureLoad(src, vec2<i32>(g.xy), 0);
  var c = vec3<f32>(C[${L.TOLIN}u + p.r], C[${L.TOLIN}u + p.g], C[${L.TOLIN}u + p.b]);
  if (sc(${S.HAS_WB}u) != 0.0) { c *= vec3<f32>(sc(${S.WB}u), sc(${S.WB + 1}u), sc(${S.WB + 2}u)); }
  if (sc(${S.HAS_EXP}u) != 0.0) { c *= sc(${S.EXPK}u); }
  if (sc(${S.HAS_TONE}u) != 0.0) {
    let l = lum709(c);
    let le = clamp01(pw(l, 1.0 / 2.2));
    let tv = sampleLUT(${L.TONE}u, le);
    if (tv != le) {
      let targetLin = pow(tv, 2.2);
      let EPS = 1e-5;
      let gain = targetLin / max(l, EPS);
      var wgt = 1.0;
      if (l < EPS) { wgt = l / EPS; }
      if (wgt >= 1.0) { c *= gain; } else { c = c * gain * wgt + vec3<f32>((1.0 - wgt) * targetLin); }
    }
  }
  if (sc(${S.HAS_CONTRAST}u) != 0.0) {
    for (var k = 0; k < 3; k++) {
      c[k] = pw(sampleLUT(${L.CONTRAST}u, clamp01(pw(c[k], 1.0 / 2.2))), 2.2);
    }
  }
  let useRgb = sc(${S.CURVE}u) != 0.0;
  for (var k = 0u; k < 3u; k++) {
    let useCh = sc(${S.CURVE + 1}u + k) != 0.0;
    if (!useRgb && !useCh) { continue; }
    var e = clamp01(pw(c[k], 1.0 / 2.2)) * 255.0;
    if (useCh) { e = C[${L.CURVES}u + (k + 1u) * 256u + u32(pk_jsround(e))]; }
    if (useRgb) { e = C[${L.CURVES}u + u32(pk_jsround(e))]; }
    c[k] = pw(e / 255.0, 2.2);
  }
  lin[px(g)] = vec4<f32>(c, f32(p.a) / 255.0);
}
`;

const LUM = /* wgsl */`
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.w || g.y >= P.h) { return; }
  let i = px(g);
  pA[i] = lum709(lin[i].rgb);
}
`;

const COPY = /* wgsl */`
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.w || g.y >= P.h) { return; }
  let i = px(g);
  pB[i] = pA[i];
}
`;

/** convolveBuffer's single-channel pass: pA -> pB, clamped edges. */
const GAUSS = /* wgsl */`
override AXIS: u32 = 0u;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.w || g.y >= P.h) { return; }
  let x = i32(g.x);
  let y = i32(g.y);
  var s = 0.0;
  for (var k = -P.kr; k <= P.kr; k++) {
    var sx = x;
    var sy = y;
    if (AXIS == 0u) { sx = clamp(x + k, 0, i32(P.w) - 1); } else { sy = clamp(y + k, 0, i32(P.h) - 1); }
    s += pA[u32(sy) * P.w + u32(sx)] * C[P.koff + u32(k + P.kr)];
  }
  pB[px(g)] = s;
}
`;

/** boxPassH / boxPassV: one line per invocation, pA -> pB, the edge pixels extended. */
const BOX = /* wgsl */`
override AXIS: u32 = 0u;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  var lines = P.h;
  var len = P.w;
  if (AXIS == 1u) { lines = P.w; len = P.h; }
  let line = g.x;
  if (line >= lines) { return; }
  var base = line * P.w;
  var step = 1u;
  if (AXIS == 1u) { base = line; step = P.w; }
  let r = P.kr;
  let last = i32(len) - 1;
  let norm = 1.0 / f32(2 * r + 1);
  var sum = 0.0;
  for (var i = -r; i <= r; i++) { sum += pA[base + u32(clamp(i, 0, last)) * step]; }
  for (var n = 0; n <= last; n++) {
    pB[base + u32(n) * step] = sum * norm;
    sum += pA[base + u32(clamp(n + r + 1, 0, last)) * step] - pA[base + u32(clamp(n - r, 0, last)) * step];
  }
}
`;

/** localContrast's apply: pA = luminance, pB = blurred, pC = fine. mode 0 = midtone weight, 1 = flat. */
const LOCAL = /* wgsl */`
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.w || g.y >= P.h) { return; }
  let i = px(g);
  let l = pA[i];
  var diff = l - pB[i];
  if (P.detail > 0.0) { diff = diff * (1.0 - P.detail) + (l - pC[i]) * P.detail; }
  let lc = clamp01(l);
  var wgt = 1.0;
  if (P.mode == 0u) { wgt = 4.0 * lc * (1.0 - lc); }
  let k = P.amount * wgt;
  if (k == 0.0) { return; }
  let add = diff * k;
  lin[i] = vec4<f32>(lin[i].rgb + vec3<f32>(add), lin[i].a);
}
`;

const COLOUR = /* wgsl */`
fn bandWeight(hue: f32, b: u32) -> f32 {
  let o = ${L.BANDS}u + b * 6u;
  var d = ((hue - C[o]) % 360.0 + 360.0) % 360.0;
  if (d > 180.0) { d -= 360.0; }
  var span = C[o + 1u];
  if (d >= 0.0) { span = C[o + 2u]; }
  let a = abs(d);
  if (a >= span) { return 0.0; }
  return 0.5 * (1.0 + pk_sincos((a / span) * 3.141592653589793).y);
}

fn rgbToHsl(c: vec3<f32>) -> vec3<f32> {
  let mx = max(c.r, max(c.g, c.b));
  let mn = min(c.r, min(c.g, c.b));
  let l = (mx + mn) / 2.0;
  let d = mx - mn;
  if (d < 1e-9) { return vec3<f32>(0.0, 0.0, l); }
  var s = d / (mx + mn);
  if (l > 0.5) { s = d / (2.0 - mx - mn); }
  var h: f32;
  if (mx == c.r) { h = ((c.g - c.b) / d) % 6.0; }
  else if (mx == c.g) { h = (c.b - c.r) / d + 2.0; }
  else { h = (c.r - c.g) / d + 4.0; }
  h *= 60.0;
  if (h < 0.0) { h += 360.0; }
  return vec3<f32>(h, s, l);
}

fn hslToRgb(h: f32, s: f32, l: f32) -> vec3<f32> {
  if (s <= 1e-9) { return vec3<f32>(l); }
  let c = (1.0 - abs(2.0 * l - 1.0)) * s;
  let hp = ((h % 360.0) + 360.0) % 360.0 / 60.0;
  let x = c * (1.0 - abs((hp % 2.0) - 1.0));
  var r = 0.0; var g = 0.0; var b = 0.0;
  if (hp < 1.0) { r = c; g = x; }
  else if (hp < 2.0) { r = x; g = c; }
  else if (hp < 3.0) { g = c; b = x; }
  else if (hp < 4.0) { g = x; b = c; }
  else if (hp < 5.0) { r = x; b = c; }
  else { r = c; b = x; }
  let m = l - c / 2.0;
  return vec3<f32>(r + m, g + m, b + m);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= P.w || gid.y >= P.h) { return; }
  let i = px(gid);
  var c = lin[i].rgb;
  let anyHsl = sc(${S.ANY_HSL}u) != 0.0;
  if (sc(${S.DO_COLOUR}u) != 0.0) {
    var rgb = vec3<f32>(clamp01(pw(c.r, 1.0 / 2.2)), clamp01(pw(c.g, 1.0 / 2.2)), clamp01(pw(c.b, 1.0 / 2.2)));
    let hsl = rgbToHsl(rgb);
    var hue = hsl.x; var sat = hsl.y; var light = hsl.z;
    if (anyHsl && sat > 0.004) {
      var dh = 0.0; var ds = 0.0; var dl = 0.0;
      for (var b = 0u; b < 8u; b++) {
        let wgt = bandWeight(hue, b);
        if (wgt == 0.0) { continue; }
        let o = ${L.BANDS}u + b * 6u;
        dh += wgt * C[o + 3u];
        ds += wgt * C[o + 4u];
        dl += wgt * C[o + 5u];
      }
      hue += dh;
      sat = clamp01(sat * (1.0 + ds));
      light = clamp01(light + dl * 0.35 * (1.0 - abs(2.0 * light - 1.0) * 0.5));
    }
    let vib = sc(${S.VIBRANCE}u);
    if (vib != 0.0) { sat = clamp01(sat * (1.0 + vib * (1.0 - sat) * 1.5)); }
    let satAdj = sc(${S.SATURATION}u);
    if (satAdj != 0.0) { sat = clamp01(sat * (1.0 + satAdj)); }
    if (sc(${S.BW}u) != 0.0) {
      var mixed = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
      if (anyHsl) {
        var dl = 0.0;
        for (var b = 0u; b < 8u; b++) {
          let wgt = bandWeight(hue, b);
          if (wgt != 0.0) { dl += wgt * C[${L.BANDS}u + b * 6u + 5u]; }
        }
        mixed = clamp01(mixed + dl * 0.5 * sat);
      }
      rgb = vec3<f32>(clamp01(mixed));
    } else {
      rgb = hslToRgb(hue, sat, light);
    }
    c = vec3<f32>(pw(clamp01(rgb.r), 2.2), pw(clamp01(rgb.g), 2.2), pw(clamp01(rgb.b), 2.2));
  }
  let hlSat = sc(${S.HL_SAT}u);
  let shSat = sc(${S.SH_SAT}u);
  if (hlSat != 0.0 || shSat != 0.0) {
    let pivot = sc(${S.PIVOT}u);
    let l = clamp01(pw(lum709(c), 1.0 / 2.2));
    let up = clamp01((l - pivot) / max(0.05, 1.0 - pivot));
    let down = clamp01((pivot - l) / max(0.05, pivot));
    for (var k = 0u; k < 3u; k++) {
      var v = clamp01(pw(c[k], 1.0 / 2.2));
      if (hlSat != 0.0) { v = v + (sc(${S.HL_TINT}u + k) - 0.5) * hlSat * up * 0.6; }
      if (shSat != 0.0) { v = v + (sc(${S.SH_TINT}u + k) - 0.5) * shSat * down * 0.6; }
      c[k] = pw(clamp01(v), 2.2);
    }
  }
  lin[i] = vec4<f32>(c, lin[i].a);
}
`;

/** Luminance noise reduction: pA = luminance, pB = its blur. */
const NR_LUM = /* wgsl */`
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.w || g.y >= P.h) { return; }
  let i = px(g);
  let diff = pB[i] - pA[i];
  let th = sc(${S.NR_THRESH}u);
  let keep = exp(-(diff * diff) / (th * th));
  let delta = diff * keep * sc(${S.NR_LUM}u);
  lin[i] = vec4<f32>(lin[i].rgb + vec3<f32>(delta), lin[i].a);
}
`;

/** The chroma planes for colour noise reduction: pA = blue - Y, pB = red - Y. */
const YCC = /* wgsl */`
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.w || g.y >= P.h) { return; }
  let i = px(g);
  let c = lin[i].rgb;
  let l = lum709(c);
  pA[i] = c.b - l;
  pB[i] = c.r - l;
}
`;

/** Colour noise reduction: pA = blurred blue - Y, pB = blurred red - Y. */
const NR_COL = /* wgsl */`
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.w || g.y >= P.h) { return; }
  let i = px(g);
  let c = lin[i].rgb;
  let l = lum709(c);
  let tr = l + pB[i];
  let tb = l + pA[i];
  let tg = (l - 0.2126 * tr - 0.0722 * tb) / 0.7152;
  let amt = sc(${S.NR_COL}u);
  lin[i] = vec4<f32>(c + (vec3<f32>(tr, tg, tb) - c) * amt, lin[i].a);
}
`;

/** Grain, vignette and the encode back to bytes. */
const POST = /* wgsl */`
fn encode(v: f32) -> u32 {
  if (v <= 0.0) { return u32(C[${L.TOSRGB}u]); }
  if (v >= 1.0) { return u32(C[${L.TOSRGB + 4096}u]); }
  return u32(C[${L.TOSRGB}u + u32(pk_jsround(v * 4096.0))]);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.w || g.y >= P.h) { return; }
  let i = px(g);
  var c = lin[i].rgb;
  let strength = sc(${S.GRAIN}u);
  if (strength != 0.0) {
    let scale = sc(${S.GSCALE}u);
    let gw = u32(sc(${S.GW}u));
    let gh = u32(sc(${S.GH}u));
    let gy = min(gh - 1u, u32(f32(g.y) / scale));
    let gx = min(gw - 1u, u32(f32(g.x) / scale));
    let l = clamp01(pw(lum709(c), 1.0 / 2.2));
    let weight = 4.0 * l * (1.0 - l);
    c += vec3<f32>(C[u32(sc(${S.GOFF}u)) + gy * gw + gx] * strength * weight);
  }
  let vig = sc(${S.VIG}u);
  if (vig != 0.0) {
    let start = sc(${S.VSTART}u);
    let dx = f32(g.x) - sc(${S.VCX}u);
    let dy = f32(g.y) - sc(${S.VCY}u);
    let r = sqrt(dx * dx + dy * dy) / sc(${S.VMAXR}u);
    if (r > start) {
      let t = (r - start) / max(0.05, 1.0 - start);
      let f = t * t * (3.0 - 2.0 * t);
      c *= 1.0 + vig * f;
    }
  }
  let a = textureLoad(src, vec2<i32>(g.xy), 0).a;
  textureStore(dst, vec2<i32>(g.xy), vec4<u32>(encode(c.r), encode(c.g), encode(c.b), a));
}
`;

const KERNELS = { PRE, LUM, COPY, GAUSS, BOX, LOCAL, COLOUR, NR_LUM, YCC, NR_COL, POST };

function pipelines(d) {
  const cache = pipelineCache(d);
  let p = cache.get('develop');
  if (p) return p;
  const storage = (type) => ({ visibility: GPUShaderStage.COMPUTE, buffer: { type } });
  const layout = d.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'uint' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8uint' } },
      { binding: 2, ...storage('storage') },
      { binding: 3, ...storage('storage') },
      { binding: 4, ...storage('storage') },
      { binding: 5, ...storage('storage') },
      { binding: 6, ...storage('storage') },
      { binding: 7, ...storage('read-only-storage') },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });
  const pl = d.createPipelineLayout({ bindGroupLayouts: [layout] });
  const make = (name, constants) => d.createComputePipeline({
    layout: pl,
    compute: { module: d.createShaderModule({ code: COMMON + KERNELS[name] }), entryPoint: 'main', constants },
  });
  p = {
    layout,
    pre: make('PRE'), lum: make('LUM'), copy: make('COPY'),
    gaussH: make('GAUSS', { AXIS: 0 }), gaussV: make('GAUSS', { AXIS: 1 }),
    boxH: make('BOX', { AXIS: 0 }), boxV: make('BOX', { AXIS: 1 }),
    local: make('LOCAL'), colour: make('COLOUR'),
    nrLum: make('NR_LUM'), ycc: make('YCC'), nrCol: make('NR_COL'), post: make('POST'),
  };
  cache.set('develop', p);
  return p;
}

registerGPUStage('develop', {
  accepts(stage, w, h, d) {
    // The linear image is 16 bytes a pixel, plus four 4-byte planes.
    return fitsStorage(d, w * h * 16) && w * h * 32 <= 1024 * 1024 * 1024;
  },
  encode(d, pass, inTex, outTex, stage, w, h) {
    const plan = stage.plan;
    const p = pipelines(d);
    const n = w * h;
    const lin = d.createBuffer({ size: n * 16, usage: GPUBufferUsage.STORAGE });
    const planes = [0, 1, 2, 3].map(() => d.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE }));
    const C = dataBuffer(d, plan.C, GPUBufferUsage.STORAGE);
    const views = [inTex.createView(), outTex.createView()];
    const gx = Math.ceil(w / 16), gy = Math.ceil(h / 16);

    // Bind roles A..D to planes by index: [a, b, c, d] distinct.
    const run = (pipe, roles, u = {}, lines = 0) => {
      const ub = new ArrayBuffer(32);
      const ui = new Uint32Array(ub), si = new Int32Array(ub), f = new Float32Array(ub);
      ui[0] = w; ui[1] = h; si[2] = u.kr | 0; ui[3] = u.koff | 0;
      f[4] = u.amount || 0; f[5] = u.detail || 0; ui[6] = u.mode | 0;
      const U = dataBuffer(d, new Uint8Array(ub), GPUBufferUsage.UNIFORM);
      pass.setPipeline(pipe);
      pass.setBindGroup(0, d.createBindGroup({
        layout: p.layout,
        entries: [
          { binding: 0, resource: views[0] },
          { binding: 1, resource: views[1] },
          { binding: 2, resource: { buffer: lin } },
          ...roles.map((k, j) => ({ binding: 3 + j, resource: { buffer: planes[k] } })),
          { binding: 7, resource: { buffer: C } },
          { binding: 8, resource: { buffer: U } },
        ],
      }));
      if (lines) pass.dispatchWorkgroups(Math.ceil(lines / 64));
      else pass.dispatchWorkgroups(gx, gy);
    };
    const others = (...used) => [0, 1, 2, 3].filter((k) => !used.includes(k));
    /** gaussianBlurBuffer on plane `from`, result in plane `to`, `tmp` as scratch. */
    const blur = (from, to, tmp, b) => {
      if (b && b.kind === 'gauss') {
        run(p.gaussH, [from, tmp, ...others(from, tmp)], { kr: b.kr, koff: b.koff });
        run(p.gaussV, [tmp, to, ...others(tmp, to)], { kr: b.kr, koff: b.koff });
        return;
      }
      let cur = from;
      for (const r of (b && b.radii) || []) {
        run(p.boxH, [cur, tmp, ...others(cur, tmp)], { kr: r }, h);
        run(p.boxV, [tmp, to, ...others(tmp, to)], { kr: r }, w);
        cur = to;
      }
      // sigma too small to blur at all: the "blurred" plane is the plane itself.
      if (cur !== to) run(p.copy, [cur, to, ...others(cur, to)]);
    };
    const local = (s) => {
      // planes: 0 luminance, 1 blurred, 2 fine, 3 scratch
      run(p.lum, [0, 1, 2, 3]);
      blur(0, 1, 3, s.blur);
      if (s.detail > 0) blur(0, 2, 3, s.fineBlur);
      run(p.local, [0, 1, 2, 3], { amount: s.amount, detail: s.detail, mode: s.flat ? 1 : 0 });
    };

    run(p.pre, [0, 1, 2, 3]);
    for (const s of plan.steps) {
      if (s.k === 'local') local(s);
      else if (s.k === 'colour') run(p.colour, [0, 1, 2, 3]);
      else if (s.k === 'nrLum') {
        run(p.lum, [0, 1, 2, 3]);
        blur(0, 1, 3, s.blur);
        run(p.nrLum, [0, 1, 2, 3]);
      } else if (s.k === 'nrCol') {
        run(p.ycc, [0, 2, 1, 3]);            // cb -> 0, cr -> 2
        blur(0, 1, 3, s.blur);               // cb blurred -> 1
        blur(2, 0, 3, s.blur);               // cr blurred -> 0
        run(p.nrCol, [1, 0, 2, 3]);          // pA = cb, pB = cr
      }
    }
    run(p.post, [0, 1, 2, 3]);
    // Freed once the work is submitted; at 12 MP these are ~400 MB.
    return () => { lin.destroy(); for (const b of planes) b.destroy(); C.destroy(); };
  },
});
