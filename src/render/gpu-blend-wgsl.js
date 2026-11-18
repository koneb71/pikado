/**
 * The ten blend modes Canvas2D lacks, as WGSL functions any WebGPU shader can
 * include. `gpu-blend.js` runs them one layer at a time; a compositor that keeps
 * the whole stack on the GPU uses the same functions, so the two can never
 * disagree about what Vivid Light is.
 *
 * The maths mirrors `blendCPU` (src/core/blend.js) and the WebGL2 shader in
 * gpu-blend.js line for line, including where they round:
 *
 *   pk_unpremultiply8   a premultiplied texel as getImageData would return it:
 *                       alpha and colour rounded to bytes, colour divided out
 *                       and rounded again. blendCPU only ever sees those bytes.
 *   pk_blend            Photoshop's rule — the blend applies only where the
 *                       backdrop exists — then the result rounded to straight
 *                       bytes (what putImageData stores) and premultiplied.
 *
 * Inputs and output are premultiplied 0..1, as a canvas or an rgba8unorm
 * texture holds them. The source is self-contained; dissolve's random number
 * comes in as `rnd`, so each caller seeds it its own way (pk_hash in
 * wgsl-math.js is the usual choice).
 */

/** Mode name -> the id `pk_blend` switches on. Also the ids the WebGL2 shader uses. */
export const BLEND_MODE_IDS = {
  'linear-burn': 1,
  'vivid-light': 2,
  'linear-light': 3,
  'pin-light': 4,
  'hard-mix': 5,
  subtract: 6,
  divide: 7,
  'darker-color': 8,
  'lighter-color': 9,
  dissolve: 10,
};

export const BLEND_WGSL = /* wgsl */`
fn pk_lum(c: vec3<f32>) -> f32 { return 0.3 * c.r + 0.59 * c.g + 0.11 * c.b; }

// Separable blend functions on 0..1 channel values.
fn pk_blend_sep(mode: u32, b: f32, s: f32) -> f32 {
  switch mode {
    case 1u: { return b + s - 1.0; }                              // linear burn
    case 2u: {                                                     // vivid light
      if (s <= 0.5) {
        if (s <= 0.0) { return 0.0; }
        return 1.0 - min(1.0, (1.0 - b) / (2.0 * s));
      }
      if (s >= 1.0) { return 1.0; }
      return min(1.0, b / (2.0 * (1.0 - s)));
    }
    case 3u: { return b + 2.0 * s - 1.0; }                       // linear light
    case 4u: {                                                     // pin light
      if (s <= 0.5) { return min(b, 2.0 * s); }
      return max(b, 2.0 * s - 1.0);
    }
    case 5u: { return select(0.0, 1.0, b + 2.0 * s - 1.0 >= 0.5); } // hard mix
    case 6u: { return b - s; }                                     // subtract
    case 7u: {                                                     // divide
      if (s <= 0.0) { return 1.0; }
      return min(1.0, b / s);
    }
    default: { return s; }
  }
}

fn pk_unpremultiply8(p: vec4<f32>) -> vec3<f32> {
  let a = floor(p.a * 255.0 + 0.5);
  if (a <= 0.0) { return vec3<f32>(0.0); }
  let c = floor(p.rgb * 255.0 + 0.5);
  return min(floor(c * 255.0 / a + 0.5), vec3<f32>(255.0)) / 255.0;
}

// Blend premultiplied source Sp onto premultiplied backdrop Bp at opacity.
// rnd in [0, 1) is used by dissolve only.
fn pk_blend(mode: u32, Bp: vec4<f32>, Sp: vec4<f32>, opacity: f32, rnd: f32) -> vec4<f32> {
  let B = pk_unpremultiply8(Bp);
  let S = pk_unpremultiply8(Sp);
  let sa = Sp.a * opacity;
  let ba = Bp.a;

  if (mode == 10u) {                                               // dissolve
    if (sa > 0.0 && rnd < sa) { return vec4<f32>(S, 1.0); }
    return Bp;
  }
  if (sa <= 0.0) { return Bp; }

  let ra = sa + ba * (1.0 - sa);
  if (ra <= 0.0) { return vec4<f32>(0.0); }

  var blended: vec3<f32>;
  if (mode == 8u || mode == 9u) {                                  // darker / lighter colour
    var takeSrc = pk_lum(S) > pk_lum(B);
    if (mode == 8u) { takeSrc = pk_lum(S) < pk_lum(B); }
    blended = select(B, S, takeSrc);
  } else {
    blended = vec3<f32>(pk_blend_sep(mode, B.r, S.r), pk_blend_sep(mode, B.g, S.g),
                        pk_blend_sep(mode, B.b, S.b));
  }
  blended = clamp(blended, vec3<f32>(0.0), vec3<f32>(1.0));

  // The blend applies only where the backdrop exists; elsewhere the source
  // shows through unblended.
  let cs = S * (1.0 - ba) + blended * ba;
  let rgb = (cs * sa + B * ba * (1.0 - sa)) / ra;

  // Round to straight bytes as putImageData stores them, then premultiply.
  let rgb8 = floor(clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0)) * 255.0 + 0.5) / 255.0;
  let ra8 = floor(ra * 255.0 + 0.5) / 255.0;
  return vec4<f32>(rgb8 * ra8, ra8);
}
`;
