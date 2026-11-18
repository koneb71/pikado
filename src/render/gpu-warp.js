import { WGSL_MATH } from './wgsl-math.js';
import {
  registerGPUStage, computePipeline, bindGroup, dataBuffer, runStagesOnGPU, runStagesToCanvas,
} from './gpu-filters.js';

/**
 * Filter > Distort and Liquify on WebGPU: the `warp` stage.
 *
 * Every distortion in src/filters/distort.js inverse-maps — for each output
 * pixel it computes where in the source to read, and samples there
 * bilinearly in premultiplied space. This is that loop as one compute pass,
 * mirroring `warp`, `premultiply` and `sampleEdge` there:
 *
 *   premultiply   round(c * a / 255) in integers, as the Uint8ClampedArray
 *                 copy rounds it (there is never a tie)
 *   sampleEdge    the same four taps and weights, and the same three edge
 *                 rules: clamp, wrap, or nothing past the border
 *   unpremultiply alpha <= 0.4 is transparent; else round-half-even bytes
 *
 * The source coordinate comes from one of the maps below, chosen per run by
 * `map`. Where a map has a part that depends only on x or only on y (Wave,
 * Ripple, Shear, Polar to Rectangular), the filter tabulates that part on the
 * CPU in float64 and the shader reads the table, so those coordinates are the
 * CPU's to the last float32 bit. The rest compute in the shader, with the trig
 * from wgsl-math.js rather than WGSL's builtins, which only promise to be
 * within 4096 ULP — enough to put a twirl a pixel off at a radius of 2000.
 *
 * Maps and their `f` parameters (aux is a float array the map reads):
 *   SHIFT      x + aux[f0 + y], y + aux[f1 + x]
 *   PINCH      cx, cy, rx, ry, q
 *   SPHERIZE   cx, cy, rx, ry, k, mode (0 both, 1 horizontal, 2 vertical)
 *   TWIRL      cx, cy, rmax, maxAngle (radians)
 *   ZIGZAG     cx, cy, rmax, amp, k, radial, angular
 *   POLAR_R2P  cx, cy, rmax, w - 1, h - 1
 *   POLAR_P2R  cx, cy; aux = sin(a(x)) [w], cos(a(x)) [w], r(y) [h]
 *   DISPLACE   kx, ky, horizontal, vertical, g; aux = dx [g*g], dy [g*g]
 *   LIQUIFY    n, iw, ih, w, h; aux = mesh dx [n*n], mesh dy [n*n]
 */

export const WARP_MAP = {
  SHIFT: 1, PINCH: 2, SPHERIZE: 3, TWIRL: 4, ZIGZAG: 5, POLAR_R2P: 6, POLAR_P2R: 7, DISPLACE: 8, LIQUIFY: 9,
};

/** distort.js's EDGE_CLAMP / EDGE_WRAP / EDGE_NONE. */
export const WARP_EDGE = { CLAMP: 0, WRAP: 1, NONE: 2 };

const WARP_WGSL = /* wgsl */`${WGSL_MATH}
struct WarpP { w: u32, h: u32, map: u32, edge: u32, f: array<vec4<f32>, 4> };
@group(0) @binding(0) var src: texture_2d<u32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba8uint, write>;
@group(0) @binding(2) var<uniform> P: WarpP;
@group(0) @binding(3) var<storage, read> aux: array<f32>;

const TAU = 6.283185307179586;
const HALF_PI = 1.5707963267948966;

fn par(i: u32) -> f32 { return P.f[i / 4u][i % 4u]; }
fn tab(base: f32, i: i32) -> f32 { return aux[u32(i32(base) + i)]; }

// premultiply(): Uint8ClampedArray rounding of c * a / 255.
fn tap(x: i32, y: i32) -> vec4<f32> {
  let p = textureLoad(src, vec2<i32>(x, y), 0);
  if (p.a == 255u) { return vec4<f32>(p); }
  if (p.a == 0u) { return vec4<f32>(0.0); }
  let c = (p.rgb * p.a * 2u + vec3<u32>(255u)) / 510u;
  return vec4<f32>(vec3<f32>(c), f32(p.a));
}

fn edgeIndex(v: i32, n: i32) -> i32 {
  if (P.edge == 1u) { return ((v % n) + n) % n; }
  if (P.edge == 0u) { return clamp(v, 0, n - 1); }
  return v; // NONE: the caller skips it when out of range
}

// sampleEdge(): bilinear in premultiplied space.
fn sampleAt(co: vec2<f32>) -> vec4<f32> {
  let w = i32(P.w);
  let h = i32(P.h);
  let b = floor(co);
  let fr = co - b;
  var acc = vec4<f32>(0.0);
  for (var j = 0; j < 2; j++) {
    var wy = fr.y;
    if (j == 0) { wy = 1.0 - fr.y; }
    if (wy <= 0.0) { continue; }
    let sy = edgeIndex(i32(b.y) + j, h);
    if (P.edge == 2u && (sy < 0 || sy >= h)) { continue; }
    for (var i = 0; i < 2; i++) {
      var wx = fr.x;
      if (i == 0) { wx = 1.0 - fr.x; }
      if (wx <= 0.0) { continue; }
      let sx = edgeIndex(i32(b.x) + i, w);
      if (P.edge == 2u && (sx < 0 || sx >= w)) { continue; }
      acc += tap(sx, sy) * (wx * wy);
    }
  }
  return acc;
}

fn rotate(v: vec2<f32>, angle: f32) -> vec2<f32> {
  let sc = pk_sincos(angle);
  return vec2<f32>(v.x * sc.y - v.y * sc.x, v.x * sc.x + v.y * sc.y);
}

fn lens(d: f32, k: f32) -> f32 {
  if (d <= 0.0) { return 0.0; }
  if (d >= 1.0) { return 1.0; }
  let sphere = pk_asin(d) / HALF_PI;
  return d + (sphere - d) * k;
}

fn mapCoord(x: f32, y: f32) -> vec2<f32> {
  let id = vec2<f32>(x, y);
  switch P.map {
    case 1u: { // SHIFT
      return vec2<f32>(x + tab(par(0u), i32(y)), y + tab(par(1u), i32(x)));
    }
    case 2u: { // PINCH
      let n = vec2<f32>((x - par(0u)) / par(2u), (y - par(1u)) / par(3u));
      let d = sqrt(n.x * n.x + n.y * n.y);
      if (d >= 1.0 || d == 0.0) { return id; }
      let s = pow(d, par(4u)) / d;
      return vec2<f32>(par(0u) + n.x * s * par(2u), par(1u) + n.y * s * par(3u));
    }
    case 3u: { // SPHERIZE
      let cx = par(0u); let cy = par(1u); let rx = par(2u); let ry = par(3u); let k = par(4u);
      let mode = par(5u);
      if (mode == 1.0) {
        let nx = (x - cx) / rx;
        let d = abs(nx);
        if (d >= 1.0) { return id; }
        return vec2<f32>(cx + sign(nx) * lens(d, k) * rx, y);
      }
      if (mode == 2.0) {
        let ny = (y - cy) / ry;
        let d = abs(ny);
        if (d >= 1.0) { return id; }
        return vec2<f32>(x, cy + sign(ny) * lens(d, k) * ry);
      }
      let n = vec2<f32>((x - cx) / rx, (y - cy) / ry);
      let d = sqrt(n.x * n.x + n.y * n.y);
      if (d >= 1.0 || d == 0.0) { return id; }
      let s = lens(d, k) / d;
      return vec2<f32>(cx + n.x * s * rx, cy + n.y * s * ry);
    }
    case 4u: { // TWIRL: atan2(dy, dx) - maxAngle * f^2, as a rotation
      let c = vec2<f32>(par(0u), par(1u));
      let v = id - c;
      let r = sqrt(v.x * v.x + v.y * v.y);
      if (r >= par(2u)) { return id; }
      let f = 1.0 - r / par(2u);
      return c + rotate(v, -par(3u) * f * f);
    }
    case 5u: { // ZIGZAG
      let c = vec2<f32>(par(0u), par(1u));
      let v = id - c;
      let r = sqrt(v.x * v.x + v.y * v.y);
      if (r >= par(2u) || r == 0.0) { return id; }
      let d = r / par(2u);
      let push = par(3u) * pk_sincos(d * par(4u)).x * (1.0 - d);
      var sr = r;
      if (par(5u) != 0.0) { sr = r + push; }
      var turn = 0.0;
      if (par(6u) != 0.0) { turn = push / max(2.0, r); }
      return c + rotate(v, turn) * (sr / r);
    }
    case 6u: { // POLAR_R2P
      let dx = x - par(0u);
      let dy = y - par(1u);
      let r = sqrt(dx * dx + dy * dy);
      var a = pk_atan2(dx, -dy);
      if (a < 0.0) { a += TAU; }
      return vec2<f32>((a / TAU) * par(3u), (r / par(2u)) * par(4u));
    }
    case 7u: { // POLAR_P2R
      let r = tab(f32(2u * P.w), i32(y));
      return vec2<f32>(par(0u) + r * tab(0.0, i32(x)), par(1u) - r * tab(f32(P.w), i32(x)));
    }
    case 8u: { // DISPLACE: sampleField(), wrapped bilinear over a g x g field
      let g = i32(par(4u));
      let fx = x * par(0u);
      let fy = y * par(1u);
      let x0 = floor(fx);
      let y0 = floor(fy);
      let tx = fx - x0;
      let ty = fy - y0;
      let ix0 = ((i32(x0) % g) + g) % g;
      let iy0 = ((i32(y0) % g) + g) % g;
      let ix1 = (ix0 + 1) % g;
      let iy1 = (iy0 + 1) % g;
      let gg = g * g;
      let i00 = iy0 * g + ix0; let i10 = iy0 * g + ix1; let i01 = iy1 * g + ix0; let i11 = iy1 * g + ix1;
      let xa = aux[i00] + (aux[i10] - aux[i00]) * tx;
      let xb = aux[i01] + (aux[i11] - aux[i01]) * tx;
      let ya = aux[gg + i00] + (aux[gg + i10] - aux[gg + i00]) * tx;
      let yb = aux[gg + i01] + (aux[gg + i11] - aux[gg + i01]) * tx;
      return vec2<f32>(x + (xa + (xb - xa) * ty) * par(2u), y + (ya + (yb - ya) * ty) * par(3u));
    }
    case 9u: { // LIQUIFY: meshAt(), then step back along the forward displacement
      let n = i32(par(0u));
      let fx = clamp(x / par(1u), 0.0, 1.0) * f32(n - 1);
      let fy = clamp(y / par(2u), 0.0, 1.0) * f32(n - 1);
      let x0 = i32(floor(fx));
      let y0 = i32(floor(fy));
      let x1 = min(n - 1, x0 + 1);
      let y1 = min(n - 1, y0 + 1);
      let tx = fx - f32(x0);
      let ty = fy - f32(y0);
      let nn = n * n;
      let i00 = y0 * n + x0; let i10 = y0 * n + x1; let i01 = y1 * n + x0; let i11 = y1 * n + x1;
      let xa = aux[i00] + (aux[i10] - aux[i00]) * tx;
      let xb = aux[i01] + (aux[i11] - aux[i01]) * tx;
      let ya = aux[nn + i00] + (aux[nn + i10] - aux[nn + i00]) * tx;
      let yb = aux[nn + i01] + (aux[nn + i11] - aux[nn + i01]) * tx;
      return vec2<f32>(x - (xa + (xb - xa) * ty) * par(3u), y - (ya + (yb - ya) * ty) * par(4u));
    }
    default: { return id; }
  }
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.w || g.y >= P.h) { return; }
  let px = sampleAt(mapCoord(f32(g.x), f32(g.y)));
  var out = vec4<u32>(0u);
  if (px.a > 0.4) {
    let inv = 255.0 / px.a;
    out = vec4<u32>(vec3<u32>(vec3<f32>(pk_u8(px.r * inv), pk_u8(px.g * inv), pk_u8(px.b * inv))), u32(pk_u8(px.a)));
  }
  textureStore(dst, vec2<i32>(g.xy), out);
}
`;

registerGPUStage('warp', {
  encode(d, pass, inTex, outTex, stage, w, h) {
    const p = computePipeline(d, 'warp', WARP_WGSL);
    const params = new ArrayBuffer(80);
    new Uint32Array(params, 0, 4).set([w, h, stage.map, stage.edge]);
    const f = new Float32Array(params, 16, 16);
    for (let i = 0; i < Math.min(16, stage.f.length); i++) f[i] = stage.f[i];
    const ubuf = dataBuffer(d, new Uint8Array(params), GPUBufferUsage.UNIFORM);
    const abuf = dataBuffer(d, stage.aux || new Float32Array(4), GPUBufferUsage.STORAGE);
    pass.setPipeline(p);
    pass.setBindGroup(0, bindGroup(d, p, [inTex.createView(), outTex.createView(), ubuf, abuf]));
    pass.dispatchWorkgroups(Math.ceil(w / 16), Math.ceil(h / 16));
  },
});

/**
 * A warp stage for `runStagesOnGPU`.
 * @param {number} map one of WARP_MAP
 * @param {number} edge one of WARP_EDGE
 * @param {number[]} f up to 16 parameters (see the table above)
 * @param {Float32Array} [aux]
 */
export function warpStage(map, edge, f, aux = null) {
  return { kind: 'warp', map, edge, f, aux };
}

/** Warp `imageData` in place on the GPU; null for "use the CPU loop". */
export function warpOnGPU(imageData, stage) {
  return runStagesOnGPU(imageData, [stage]);
}

/** Warp `imageData` straight into `ctx`'s canvas, for a preview; false for "draw it on the CPU". */
export function warpToCanvas(imageData, stage, ctx) {
  return runStagesToCanvas(imageData, [stage], ctx);
}
