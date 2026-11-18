/**
 * WGSL helpers shared by every WebGPU module, as one source string to prepend
 * to a shader. Each one exists because a WGSL builtin does not do what the JS
 * it mirrors does, and the parity suites compare the two to a count or two:
 *
 *   pk_jsround(x)   Math.round: halves go up. WGSL `round` sends halves to even.
 *   pk_u8(x)        a Uint8ClampedArray store: clamp to 0..255, halves to even,
 *                   which *is* WGSL `round`.
 *   pk_hash(i)      hashRandom() in src/effects/effect-renderers.js. u32
 *                   multiplication wraps exactly as Math.imul does.
 *   pk_sincos(x)    sin and cos to about 1e-7, where WGSL only promises an
 *                   absolute error of 2^-11 — up to a whole pixel of a twirl at
 *                   a radius of 2000.
 *   pk_atan2(y, x)  atan2 to about 2e-7 radians; the builtin's bound is 4096 ULP.
 *   pk_asin(x)      asin to about 2e-7, built on pk_atan2.
 *
 * The trig is a range reduction plus a short polynomial in f32, so every GPU
 * gives the same answer to the last few bits, rather than whatever the
 * driver's builtin happens to do.
 */
export const WGSL_MATH = /* wgsl */`
fn pk_jsround(x: f32) -> f32 { return floor(x + 0.5); }
fn pk_u8(x: f32) -> f32 { return clamp(round(x), 0.0, 255.0); }

fn pk_hash(i: u32) -> f32 {
  var x = i * 374761393u + 668265263u;
  x = (x ^ (x >> 13u)) * 1274126177u;
  return f32(x ^ (x >> 16u)) / 4294967296.0;
}

// sin and cos on [-pi/4, pi/4]: Taylor terms through x^11 and x^12, both well
// under f32 precision there.
fn pk_sin_k(x: f32) -> f32 {
  let z = x * x;
  return x * (1.0 + z * (-1.0 / 6.0 + z * (1.0 / 120.0 + z * (-1.0 / 5040.0
    + z * (1.0 / 362880.0 + z * (-1.0 / 39916800.0))))));
}
fn pk_cos_k(x: f32) -> f32 {
  let z = x * x;
  return 1.0 + z * (-0.5 + z * (1.0 / 24.0 + z * (-1.0 / 720.0
    + z * (1.0 / 40320.0 + z * (-1.0 / 3628800.0 + z * (1.0 / 479001600.0))))));
}

// Returns vec2(sin x, cos x). The reduction subtracts n*pi/2 in three parts
// (Cody-Waite): the first two have few enough significant bits that n times
// them is exact in f32 for any n below 2^12, so it stays accurate out to
// |x| of a few thousand radians.
fn pk_sincos(x: f32) -> vec2<f32> {
  let n = floor(x * 0.63661977236758134 + 0.5);
  let r = ((x - n * 1.5703125) - n * 4.838705062866211e-4) - n * -4.371138828673793e-8;
  let s = pk_sin_k(r);
  let c = pk_cos_k(r);
  let q = i32(n) & 3;
  if (q == 0) { return vec2<f32>(s, c); }
  if (q == 1) { return vec2<f32>(c, -s); }
  if (q == 2) { return vec2<f32>(-s, -c); }
  return vec2<f32>(-c, s);
}

// atan on [0, 1] through a reduction to |t| <= tan(pi/12) and a series.
fn pk_atan01(a: f32) -> f32 {
  var t = a;
  var off = 0.0;
  // tan(pi/12) = 2 - sqrt(3)
  if (t > 0.2679491924311228) {
    t = (t * 1.7320508075688772 - 1.0) / (t + 1.7320508075688772);
    off = 0.5235987755982988; // pi/6
  }
  let z = t * t;
  let p = t * (1.0 + z * (-1.0 / 3.0 + z * (1.0 / 5.0 + z * (-1.0 / 7.0 + z * (1.0 / 9.0
    + z * (-1.0 / 11.0 + z * (1.0 / 13.0)))))));
  return off + p;
}

fn pk_atan2(y: f32, x: f32) -> f32 {
  let ax = abs(x);
  let ay = abs(y);
  if (ax == 0.0 && ay == 0.0) { return 0.0; }
  var r: f32;
  if (ay <= ax) { r = pk_atan01(ay / ax); } else { r = 1.5707963267948966 - pk_atan01(ax / ay); }
  if (x < 0.0) { r = 3.141592653589793 - r; }
  if (y < 0.0) { r = -r; }
  return r;
}

fn pk_asin(x: f32) -> f32 {
  let c = clamp(x, -1.0, 1.0);
  return pk_atan2(c, sqrt(max(0.0, 1.0 - c * c)));
}
`;
