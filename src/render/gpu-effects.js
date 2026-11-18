import { createCanvas } from '../core/util.js';
import { WGSL_MATH } from './wgsl-math.js';
import {
  encodeDistance, distanceCap, MAX_DISTANCE_CAP, DT_GROW, DT_GLOW_EDGE, DT_DIST,
} from './gpu-distance.js';
import { gaussianKernel } from '../filters/registry.js';
import {
  getGPUDevice, gpuGeneration, fitsTexture, fitsStorage,
  uploadCanvas, beginPresent, endPresent, presentFormat, GPU_MIN_PIXELS,
} from './gpu-device.js';

/**
 * Drop shadow, outer glow, inner shadow and inner glow on WebGPU.
 *
 * On the CPU these effects cost a `getImageData`, three to five full-region
 * JS loops, a blur that round-trips through ImageData, and a `putImageData` —
 * ~60-110 ms per recomposite for a shape covering half of a 12 MP document. Here
 * the layer is uploaded once, every step runs in a compute pass, and the
 * coloured result is drawn back once.
 *
 * Each pass mirrors a CPU function in `src/effects/` exactly, and must keep doing
 * so — the parity suite in tests/suites/gpu-effects.test.js holds them together:
 *
 *   extract   offsetAlpha        whole-pixel offset, zeros shifted in;
 *             (inner shadow)     or invertField + offsetFieldClamped
 *   distance  spreadAlpha        Spread / Choke (gpu-distance.js)
 *             signedDistance     Inner Glow's falloff
 *   gauss     blurField <= 16    gaussianKernel(radius / 2): zero outside the
 *                                region for outer effects (what Canvas2D's
 *                                blur() does), clamped for inner ones
 *   box       blurField >  16    three clamped box passes, same boxR, running sums
 *   final     noiseField, knockOutField or clipField, alphaToCanvas / fillField
 *
 * Contract, the same as `blendOnGPU`: `effectFieldOnGPU` returns a canvas, or
 * `null` and the caller runs its CPU path. Null for: no device yet, a region
 * under GPU_MIN_PIXELS (the CPU path is a few ms there and bit-exact), one too
 * large for the device, a Spread / Choke / glow size past MAX_DISTANCE_CAP, or
 * any error.
 */

/** Below this the CPU renders the effect in a few ms (re-exported from gpu-device.js). */
export { GPU_MIN_PIXELS };

const WG = 16;  // per-pixel passes: 16x16 workgroups
const WG1 = 64; // per-row / per-column passes

/** Bits of Params.flags. */
const INVERT = 1;           // extract: 255 - alpha (inner shadow's matte)
const CLAMP_OFFSET = 2;     // extract: clamp the shifted read instead of zero-filling
const CLAMP_BLUR = 4;       // gauss: clamp at the region's border instead of zero
const CLIP = 8;             // final: field * alpha (inner effects), not field * (1 - alpha)
const RAMP_AFTER_NOISE = 16; // final: a gradient's ramp follows the noisy field (inner glow)
const INVERT_FIELD = 32;    // final: 255 - field before anything else (satin's Invert)
const NO_MATTE = 64;        // final: neither clip nor knock out (stroke)
const SATIN = 128;          // extract: |alpha at -offset - alpha at -offset2|, zeros shifted in

const PARAMS_WGSL = /* wgsl */`
struct Params {
  w: u32, h: u32,
  dx: i32, dy: i32,
  kr: i32,          // Gaussian kernel radius, or box radius
  useLut: u32,
  noise: f32,
  flags: u32,
  color: vec3<f32>, // 0..255
  mode: u32,        // stroke position: 0 inside, 1 centre, 2 outside
  dx2: i32, dy2: i32, // satin's second offset
  _p0: u32, _p1: u32,
};
`;

const EXTRACT_WGSL = /* wgsl */`${PARAMS_WGSL}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> alphaBuf: array<f32>;
@group(0) @binding(2) var<storage, read_write> field: array<f32>;
@group(0) @binding(3) var<uniform> P: Params;

fn a255(x: i32, y: i32) -> f32 {
  return round(textureLoad(src, vec2<i32>(x, y), 0).a * 255.0);
}

@compute @workgroup_size(${WG}, ${WG})
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.w || g.y >= P.h) { return; }
  let i = g.y * P.w + g.x;
  alphaBuf[i] = a255(i32(g.x), i32(g.y));
  var sx = i32(g.x) - P.dx;
  var sy = i32(g.y) - P.dy;
  var v = 0.0;
  if ((P.flags & ${SATIN}u) != 0u) {
    var a1 = 0.0;
    var a2 = 0.0;
    let tx = i32(g.x) - P.dx2;
    let ty = i32(g.y) - P.dy2;
    if (sx >= 0 && sy >= 0 && sx < i32(P.w) && sy < i32(P.h)) { a1 = a255(sx, sy); }
    if (tx >= 0 && ty >= 0 && tx < i32(P.w) && ty < i32(P.h)) { a2 = a255(tx, ty); }
    v = abs(a1 - a2);
  } else if ((P.flags & ${CLAMP_OFFSET}u) != 0u) {
    v = a255(clamp(sx, 0, i32(P.w) - 1), clamp(sy, 0, i32(P.h) - 1));
  } else if (sx >= 0 && sy >= 0 && sx < i32(P.w) && sy < i32(P.h)) {
    v = a255(sx, sy);
  }
  if ((P.flags & ${INVERT}u) != 0u) { v = 255.0 - v; }
  field[i] = v;
}
`;

/** One separable Gaussian pass; AXIS 0 = horizontal, 1 = vertical. Zero outside, or clamped. */
const GAUSS_WGSL = /* wgsl */`${PARAMS_WGSL}
override AXIS: u32 = 0u;
@group(0) @binding(0) var<storage, read> inF: array<f32>;
@group(0) @binding(1) var<storage, read_write> outF: array<f32>;
@group(0) @binding(2) var<storage, read> kern: array<f32>;
@group(0) @binding(3) var<uniform> P: Params;

@compute @workgroup_size(${WG}, ${WG})
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.w || g.y >= P.h) { return; }
  let x = i32(g.x);
  let y = i32(g.y);
  let w = i32(P.w);
  let h = i32(P.h);
  let clampEdges = (P.flags & ${CLAMP_BLUR}u) != 0u;
  var s = 0.0;
  for (var k = -P.kr; k <= P.kr; k++) {
    var sx = x;
    var sy = y;
    if (AXIS == 0u) { sx = x + k; } else { sy = y + k; }
    if (clampEdges) {
      sx = clamp(sx, 0, w - 1);
      sy = clamp(sy, 0, h - 1);
    }
    if (sx >= 0 && sx < w && sy >= 0 && sy < h) {
      s += inF[u32(sy * w + sx)] * kern[u32(k + P.kr)];
    }
  }
  outF[g.y * P.w + g.x] = s;
}
`;

/**
 * One box pass along a row (AXIS 0) or a column (AXIS 1), one invocation per
 * line, with the same running sum and clamped edges as `boxBlurPass`.
 */
const BOX_WGSL = /* wgsl */`${PARAMS_WGSL}
override AXIS: u32 = 0u;
@group(0) @binding(0) var<storage, read> inF: array<f32>;
@group(0) @binding(1) var<storage, read_write> outF: array<f32>;
@group(0) @binding(2) var<uniform> P: Params;

@compute @workgroup_size(${WG1})
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  var lines = P.h;
  var len = P.w;
  if (AXIS == 1u) { lines = P.w; len = P.h; }
  let line = g.x;
  if (line >= lines) { return; }
  // Element n of this line lives at base + n * step.
  var base = line * P.w;
  var step = 1u;
  if (AXIS == 1u) { base = line; step = P.w; }
  let r = P.kr;
  let last = i32(len) - 1;
  let norm = 1.0 / f32(2 * r + 1);
  var sum = 0.0;
  for (var i = -r; i <= r; i++) {
    sum += inF[base + u32(clamp(i, 0, last)) * step];
  }
  for (var n = 0; n <= last; n++) {
    outF[base + u32(n) * step] = sum * norm;
    sum += inF[base + u32(clamp(n + r + 1, 0, last)) * step]
         - inF[base + u32(clamp(n - r, 0, last)) * step];
  }
}
`;

/** Noise, knockout (or clip) and colour, drawn straight into the presentation canvas. */
const FINAL_WGSL = /* wgsl */`${PARAMS_WGSL}${WGSL_MATH}
@group(0) @binding(0) var<storage, read> field: array<f32>;
@group(0) @binding(1) var<storage, read> alphaBuf: array<f32>;
@group(0) @binding(2) var<storage, read> lut: array<vec4<f32>>;
@group(0) @binding(3) var<uniform> P: Params;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  return vec4<f32>(p[vi], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let i = u32(pos.y) * P.w + u32(pos.x);
  var f = field[i];
  if ((P.flags & ${INVERT_FIELD}u) != 0u) { f = 255.0 - f; }
  var v = f;
  if (P.noise > 0.0) { v = v * (1.0 - P.noise * pk_hash(i)); }
  // Outer glow's gradient follows the field before noise; inner glow's after.
  var rampFrom = f;
  if ((P.flags & ${RAMP_AFTER_NOISE}u) != 0u) { rampFrom = v; }
  if ((P.flags & ${NO_MATTE}u) != 0u) {
    // the field already is the coverage (stroke)
  } else if ((P.flags & ${CLIP}u) != 0u) {
    v = v * (alphaBuf[i] / 255.0);
  } else {
    v = v * (1.0 - alphaBuf[i] / 255.0);
  }
  var rgb = P.color;
  var a = v;
  if (P.useLut != 0u) {
    // fillField: the ramp position, indexed with Math.round.
    let ramp = clamp(1.0 - rampFrom / 255.0, 0.0, 1.0);
    let e = lut[u32(clamp(floor(ramp * 255.0 + 0.5), 0.0, 255.0))];
    rgb = e.rgb;
    a = v * e.a;
  }
  // Uint8ClampedArray rounds half to even, as WGSL round() does.
  let a8 = round(clamp(a, 0.0, 255.0)) / 255.0;
  return vec4<f32>(round(clamp(rgb, vec3(0.0), vec3(255.0))) / 255.0 * a8, a8);
}
`;

/**
 * Stroke's band, from the grown fields: inside = alpha - shrink(size),
 * centre = grow(size/2) - shrink(size/2), outside = grow(size) - alpha.
 * shrink(r) is 255 - grow(r) measured from the outside (seeds <= 127), which
 * is what spreadField's shrink is.
 */
const STROKE_BAND_WGSL = /* wgsl */`${PARAMS_WGSL}
@group(0) @binding(0) var<storage, read> grownAbove: array<f32>;   // fieldC (centre only)
@group(0) @binding(1) var<storage, read_write> field: array<f32>;  // fieldA
@group(0) @binding(2) var<storage, read> alphaBuf: array<f32>;
@group(0) @binding(3) var<uniform> P: Params;

@compute @workgroup_size(${WG}, ${WG})
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.w || g.y >= P.h) { return; }
  let i = g.y * P.w + g.x;
  let a = alphaBuf[i];
  let f = field[i];
  var band = 0.0;
  if (P.mode == 0u) { band = a - (255.0 - f); }
  else if (P.mode == 1u) { band = grownAbove[i] - (255.0 - f); }
  else { band = f - a; }
  field[i] = max(0.0, band);
}
`;

const BEVEL_PARAMS_WGSL = /* wgsl */`
struct Bevel {
  w: u32, h: u32,
  style: u32,       // 0 inner, 1 outer, 2 emboss, 3 pillow emboss
  _p: u32,
  size: f32, depth: f32, lz: f32, hiRange: f32,
  lx: f32, ly: f32, shRange: f32, hiOp: f32,
  hiColor: vec3<f32>, shOp: f32,
  shColor: vec3<f32>, _q: f32,
};
`;

/** signedDistance, the style's height (x 255, ready to blur) and the coverage mask. */
const BEVEL_HEIGHT_WGSL = /* wgsl */`${BEVEL_PARAMS_WGSL}
@group(0) @binding(0) var<storage, read_write> inner: array<f32>;  // fieldC: din in, mask out
@group(0) @binding(1) var<storage, read_write> outer: array<f32>;  // fieldA: dout in, height out
@group(0) @binding(2) var<storage, read> alphaBuf: array<f32>;
@group(0) @binding(3) var<uniform> B: Bevel;

@compute @workgroup_size(${WG}, ${WG})
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= B.w || g.y >= B.h) { return; }
  let i = g.y * B.w + g.x;
  let din = inner[i];
  let dout = outer[i];
  let a = alphaBuf[i];
  var sd: f32;
  if (din <= 1.5 && dout <= 1.5) { sd = a / 255.0 - 0.5; }
  else if (din > 0.0) { sd = din - 0.5; }
  else { sd = 0.5 - dout; }
  var ht: f32;
  if (B.style == 1u) { ht = clamp(1.0 + sd / B.size, 0.0, 1.0); }
  else if (B.style == 2u) { ht = clamp(0.5 + sd / (2.0 * B.size), 0.0, 1.0); }
  else if (B.style == 3u) { ht = clamp(abs(sd) / B.size, 0.0, 1.0); }
  else { ht = clamp(sd / B.size, 0.0, 1.0); }
  let grown = clamp((B.size - dout + 0.5) * 255.0, 0.0, 255.0);
  var m = grown;
  if (B.style == 0u) { m = a; } else if (B.style == 1u) { m = max(0.0, grown - a); }
  outer[i] = ht * 255.0;
  inner[i] = m;
}
`;

/** Normals from the blurred height, the light, and the two tones, as one premultiplied canvas. */
const BEVEL_FINAL_WGSL = /* wgsl */`${BEVEL_PARAMS_WGSL}
@group(0) @binding(0) var<storage, read> height: array<f32>;  // fieldA, x 255
@group(0) @binding(1) var<storage, read> mask: array<f32>;    // fieldC
@group(0) @binding(2) var<uniform> B: Bevel;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  return vec4<f32>(p[vi], 0.0, 1.0);
}

fn H(x: i32, y: i32) -> f32 {
  let cx = clamp(x, 0, i32(B.w) - 1);
  let cy = clamp(y, 0, i32(B.h) - 1);
  return height[u32(cy) * B.w + u32(cx)] / 255.0;
}

@fragment
fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let x = i32(pos.x);
  let y = i32(pos.y);
  let m = mask[u32(y) * B.w + u32(x)];
  if (m <= 0.0) { return vec4<f32>(0.0); }
  let gx = ((H(x + 1, y) - H(x - 1, y)) / 2.0) * B.depth;
  let gy = ((H(x, y + 1) - H(x, y - 1)) / 2.0) * B.depth;
  let len = sqrt(gx * gx + gy * gy + 1.0);
  let ndotl = (-gx * B.lx - gy * B.ly + B.lz) / len;
  let delta = ndotl - B.lz;
  var tone: f32;
  var color: vec3<f32>;
  var op: f32;
  if (delta > 0.0) {
    tone = 255.0 * clamp(delta / B.hiRange, 0.0, 1.0) * (m / 255.0);
    color = B.hiColor; op = B.hiOp;
  } else {
    tone = 255.0 * clamp(-delta / B.shRange, 0.0, 1.0) * (m / 255.0);
    color = B.shColor; op = B.shOp;
  }
  // alphaToCanvas stores the tone as a byte; drawing it at the tone's opacity
  // scales that byte.
  let a8 = round(clamp(tone, 0.0, 255.0));
  let a = round(a8 * clamp(op, 0.0, 1.0)) / 255.0;
  return vec4<f32>(round(clamp(color, vec3(0.0), vec3(255.0))) / 255.0 * a, a);
}
`;

/* ------------------------------------------------------------------ */
/* Pipelines and buffers, cached per device                            */
/* ------------------------------------------------------------------ */

let state = null; // { gen, device, pipelines, buffers... }
let broken = false;

function compute(d, code, constants) {
  return d.createComputePipeline({
    layout: 'auto',
    compute: { module: d.createShaderModule({ code }), entryPoint: 'main', constants },
  });
}

function setup(d) {
  if (state && state.gen === gpuGeneration() && state.device === d) return state;
  d.pushErrorScope('validation');
  const finalModule = d.createShaderModule({ code: FINAL_WGSL });
  const bevelModule = d.createShaderModule({ code: BEVEL_FINAL_WGSL });
  const s = {
    gen: gpuGeneration(),
    device: d,
    extract: compute(d, EXTRACT_WGSL),
    gaussH: compute(d, GAUSS_WGSL, { AXIS: 0 }),
    gaussV: compute(d, GAUSS_WGSL, { AXIS: 1 }),
    boxRow: compute(d, BOX_WGSL, { AXIS: 0 }),
    boxCol: compute(d, BOX_WGSL, { AXIS: 1 }),
    final: d.createRenderPipeline({
      layout: 'auto',
      vertex: { module: finalModule, entryPoint: 'vs' },
      fragment: { module: finalModule, entryPoint: 'fs', targets: [{ format: presentFormat() }] },
      primitive: { topology: 'triangle-list' },
    }),
    strokeBand: compute(d, STROKE_BAND_WGSL),
    bevelHeight: compute(d, BEVEL_HEIGHT_WGSL),
    bevelFinal: d.createRenderPipeline({
      layout: 'auto',
      vertex: { module: bevelModule, entryPoint: 'vs' },
      fragment: { module: bevelModule, entryPoint: 'fs', targets: [{ format: presentFormat() }] },
      primitive: { topology: 'triangle-list' },
    }),
    params: d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    bevel: d.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    kern: d.createBuffer({ size: 64 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
    lut: d.createBuffer({ size: 256 * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
    fieldBytes: 0,
    alphaBuf: null, fieldA: null, fieldB: null, fieldC: null,
  };
  d.popErrorScope().then((err) => {
    if (err) { broken = true; console.warn('[gpu-effects] pipeline creation failed:', err.message); }
  });
  state = s;
  return s;
}

/**
 * Grow (never shrink) the four field buffers to hold `bytes` each — about
 * 16 bytes a pixel of the largest region seen, ~190 MB after a 12 MP effect.
 */
function ensureFields(s, bytes) {
  if (s.fieldBytes >= bytes) return;
  for (const k of ['alphaBuf', 'fieldA', 'fieldB', 'fieldC']) {
    if (s[k]) s[k].destroy();
    s[k] = s.device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE });
  }
  s.fieldBytes = bytes;
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

/**
 * The blur `blurField(f, w, h, radius)` would apply, as a GPU plan.
 * Kept beside the shaders so the two branches cannot drift apart unnoticed.
 */
function blurPlan(radius) {
  if (!(radius > 0.05)) return null;
  if (radius <= 16) {
    const k = gaussianKernel(radius / 2);
    return { kind: 'gauss', kernel: k, kr: (k.length - 1) / 2 };
  }
  const sigma = radius / 2;
  const boxR = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2));
  return { kind: 'box', kr: boxR };
}

/**
 * Render an effect for the region in `env` on the GPU.
 *
 * @param {{w:number, h:number, src:HTMLCanvasElement}} env  the renderer environment
 * @param {object} p
 * @param {'outer'|'innerShadow'|'innerGlow'|'satin'|'strokeBand'|'bevel'} [p.kind='outer']
 *   'outer' is a drop shadow or an outer glow (they differ only in offset and fill)
 * @param {number} [p.dx] @param {number} [p.dy]  the whole-pixel offset, from
 *   `offsetVector` (outer and satin: zeros shift in; inner shadow: edges clamp)
 * @param {number} [p.dx2] @param {number} [p.dy2]  satin's second offset
 * @param {number} [p.spread]  Spread (outer) or Choke (inner shadow), in px
 * @param {number} [p.blurRadius]  what the CPU passes to blurField
 * @param {number} [p.size] @param {number} [p.span] @param {boolean} [p.fromCenter]
 *   inner glow's falloff, as its renderer computes them; for a stroke, its size
 * @param {'inside'|'center'|'outside'} [p.position]  stroke
 * @param {boolean} [p.invert]  satin
 * @param {object} [p.bevel]  bevel: {style, size, depth, lx, ly, lz, hiColor,
 *   hiOp, shColor, shOp} as the renderer computes them
 * @param {number} [p.noise]  0..1
 * @param {{r:number,g:number,b:number}} [p.color]
 * @param {{r,g,b,a}|null} [p.lut]  from `gradientLUT`, for a gradient fill
 * @returns {HTMLCanvasElement|null} the coloured effect, region sized, or null
 *   for "use the CPU path". A stroke band with no colour comes back black,
 *   ready to cut a gradient or pattern fill with.
 */
export function effectFieldOnGPU(env, p) {
  if (broken) return null;
  const d = getGPUDevice();
  if (!d) return null;
  const { w, h, src } = env;
  if (w * h < GPU_MIN_PIXELS) return null;
  if (!src || src.width !== w || src.height !== h) return null;
  if (!fitsTexture(d, w, h) || !fitsStorage(d, w * h * 4)) return null;
  const blur = blurPlan(p.blurRadius);
  if (blur && blur.kind === 'gauss' && blur.kernel.length > 64) return null;

  const kind = p.kind || 'outer';
  const inner = kind === 'innerShadow' || kind === 'innerGlow';
  // Distance passes: [{mode, cap, seedsAbove, rad?, out: 'A'|'C'}]
  const dists = [];
  if (kind === 'innerGlow') {
    dists.push({ mode: DT_GLOW_EDGE, cap: distanceCap(p.size), seedsAbove: false, out: 'A' });
  } else if (kind === 'strokeBand') {
    const r = p.position === 'center' ? p.size / 2 : p.size;
    if (p.position === 'center') {
      dists.push({ mode: DT_GROW, cap: distanceCap(r), seedsAbove: true, rad: r, out: 'C' });
    }
    dists.push({ mode: DT_GROW, cap: distanceCap(r), seedsAbove: p.position === 'outside', rad: r, out: 'A' });
  } else if (kind === 'bevel') {
    const cap = distanceCap(p.bevel.size);
    dists.push({ mode: DT_DIST, cap, seedsAbove: false, out: 'C' }); // din
    dists.push({ mode: DT_DIST, cap, seedsAbove: true, out: 'A' });  // dout
  } else if (kind !== 'satin' && p.spread > 0) {
    dists.push({ mode: DT_GROW, cap: distanceCap(p.spread), seedsAbove: true, rad: p.spread, out: 'A' });
  }
  if (dists.some((x) => x.cap > MAX_DISTANCE_CAP)) return null;

  let flags = 0;
  if (kind === 'innerShadow') flags |= INVERT | CLAMP_OFFSET;
  if (inner) flags |= CLAMP_BLUR | CLIP;
  if (kind === 'innerGlow') flags |= RAMP_AFTER_NOISE;
  if (kind === 'satin') flags |= SATIN | CLIP | (p.invert ? INVERT_FIELD : 0);
  if (kind === 'strokeBand') flags |= NO_MATTE;
  if (kind === 'bevel') flags |= CLAMP_BLUR;

  try {
    const s = setup(d);
    ensureFields(s, w * h * 4);

    const params = new ArrayBuffer(64);
    const u = new Uint32Array(params);
    const i = new Int32Array(params);
    const f = new Float32Array(params);
    const shift = kind === 'outer' || kind === 'innerShadow' || kind === 'satin';
    u[0] = w; u[1] = h;
    i[2] = shift ? p.dx | 0 : 0;
    i[3] = shift ? p.dy | 0 : 0;
    i[4] = blur ? blur.kr : 0;
    u[5] = p.lut ? 1 : 0;
    f[6] = p.noise > 0 ? p.noise : 0;
    u[7] = flags;
    f[8] = p.color ? p.color.r : 0;
    f[9] = p.color ? p.color.g : 0;
    f[10] = p.color ? p.color.b : 0;
    u[11] = p.position === 'inside' ? 0 : p.position === 'center' ? 1 : 2;
    i[12] = p.dx2 | 0;
    i[13] = p.dy2 | 0;
    d.queue.writeBuffer(s.params, 0, params);
    if (blur && blur.kind === 'gauss') d.queue.writeBuffer(s.kern, 0, blur.kernel);
    if (p.lut) {
      const L = new Float32Array(256 * 4);
      for (let k = 0; k < 256; k++) {
        L[k * 4] = p.lut.r[k]; L[k * 4 + 1] = p.lut.g[k]; L[k * 4 + 2] = p.lut.b[k]; L[k * 4 + 3] = p.lut.a[k];
      }
      d.queue.writeBuffer(s.lut, 0, L);
    }
    if (kind === 'bevel') d.queue.writeBuffer(s.bevel, 0, bevelParams(w, h, p.bevel));

    d.pushErrorScope('validation');
    const tex = uploadCanvas(d, src);
    const enc = d.createCommandEncoder();
    const pass = enc.beginComputePass();
    const bg = (pipeline, resources) => d.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: resources.map((r, binding) => ({ binding, resource: r })),
    });
    const buf = (b) => ({ buffer: b });
    const gx = Math.ceil(w / WG), gy = Math.ceil(h / WG);

    pass.setPipeline(s.extract);
    pass.setBindGroup(0, bg(s.extract, [tex.createView(), buf(s.alphaBuf), buf(s.fieldA), buf(s.params)]));
    pass.dispatchWorkgroups(gx, gy);

    // Spread / Choke grow the extracted field; Inner Glow builds its falloff,
    // a stroke its grown fields and a bevel its two distances, all from the
    // layer's alpha.
    for (const x of dists) {
      const fromAlpha = kind === 'innerGlow' || kind === 'strokeBand' || kind === 'bevel';
      encodeDistance(d, pass, {
        src: fromAlpha ? s.alphaBuf : s.fieldA,
        g: s.fieldB,
        out: x.out === 'C' ? s.fieldC : s.fieldA,
        alpha: s.alphaBuf,
      }, {
        w, h, mode: x.mode, cap: x.cap, seedsAbove: x.seedsAbove,
        rad: x.rad, size: p.size, span: p.span, invert: !!p.fromCenter,
      });
    }
    if (kind === 'strokeBand') {
      pass.setPipeline(s.strokeBand);
      pass.setBindGroup(0, bg(s.strokeBand, [buf(s.fieldC), buf(s.fieldA), buf(s.alphaBuf), buf(s.params)]));
      pass.dispatchWorkgroups(gx, gy);
    }
    if (kind === 'bevel') {
      pass.setPipeline(s.bevelHeight);
      pass.setBindGroup(0, bg(s.bevelHeight, [buf(s.fieldC), buf(s.fieldA), buf(s.alphaBuf), buf(s.bevel)]));
      pass.dispatchWorkgroups(gx, gy);
    }

    // Every blur ends back in fieldA, which is what the final pass reads.
    if (blur && blur.kind === 'gauss') {
      pass.setPipeline(s.gaussH);
      pass.setBindGroup(0, bg(s.gaussH, [buf(s.fieldA), buf(s.fieldB), buf(s.kern), buf(s.params)]));
      pass.dispatchWorkgroups(gx, gy);
      pass.setPipeline(s.gaussV);
      pass.setBindGroup(0, bg(s.gaussV, [buf(s.fieldB), buf(s.fieldA), buf(s.kern), buf(s.params)]));
      pass.dispatchWorkgroups(gx, gy);
    } else if (blur) {
      const rowBG = bg(s.boxRow, [buf(s.fieldA), buf(s.fieldB), buf(s.params)]);
      const colBG = bg(s.boxCol, [buf(s.fieldB), buf(s.fieldA), buf(s.params)]);
      for (let k = 0; k < 3; k++) {
        pass.setPipeline(s.boxRow);
        pass.setBindGroup(0, rowBG);
        pass.dispatchWorkgroups(Math.ceil(h / WG1));
        pass.setPipeline(s.boxCol);
        pass.setBindGroup(0, colBG);
        pass.dispatchWorkgroups(Math.ceil(w / WG1));
      }
    }
    pass.end();

    const view = beginPresent(d, w, h);
    const rp = enc.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    if (kind === 'bevel') {
      rp.setPipeline(s.bevelFinal);
      rp.setBindGroup(0, bg(s.bevelFinal, [buf(s.fieldA), buf(s.fieldC), buf(s.bevel)]));
    } else {
      rp.setPipeline(s.final);
      rp.setBindGroup(0, bg(s.final, [buf(s.fieldA), buf(s.alphaBuf), buf(s.lut), buf(s.params)]));
    }
    rp.draw(3);
    rp.end();
    d.queue.submit([enc.finish()]);
    d.popErrorScope().then((err) => {
      if (err) { broken = true; console.warn('[gpu-effects] disabled after a validation error:', err.message); }
    });

    return endPresent(createCanvas(w, h));
  } catch (err) {
    console.warn('[gpu-effects] failed, using the CPU path:', err && err.message);
    return null;
  }
}

/** The Bevel uniform, laid out as BEVEL_PARAMS_WGSL. */
function bevelParams(w, h, b) {
  const buf = new ArrayBuffer(80);
  const u = new Uint32Array(buf);
  const f = new Float32Array(buf);
  const STYLE = { inner: 0, outer: 1, emboss: 2, 'pillow-emboss': 3 };
  u[0] = w; u[1] = h; u[2] = STYLE[b.style] ?? 0;
  f[4] = b.size; f[5] = b.depth; f[6] = b.lz; f[7] = Math.max(0.001, 1 - b.lz);
  f[8] = b.lx; f[9] = b.ly; f[10] = Math.max(0.001, b.lz); f[11] = b.hiOp;
  f[12] = b.hiColor.r; f[13] = b.hiColor.g; f[14] = b.hiColor.b; f[15] = b.shOp;
  f[16] = b.shColor.r; f[17] = b.shColor.g; f[18] = b.shColor.b;
  return buf;
}

/** True once a validation error has switched the GPU effects off for this session. */
export function gpuEffectsBroken() {
  return broken;
}
