import { registerFilter, makeRandom } from './registry.js';
import { gaussianBlurBuffer } from './blur.js';
import { curveParam, curveToLUT, isIdentityCurve, defaultCurves } from '../ui/curve-editor.js';

/**
 * Camera Raw.
 *
 * A develop module: white balance, tone, presence, colour mixing, detail,
 * effects and a tone curve, applied in one pass in the order Camera Raw applies
 * them. Registered as a filter, which is the whole trick — a filter is what a
 * Smart Object's filter stack stores, so putting Camera Raw here makes it
 * non-destructive on a Smart Object for free, editable and re-orderable, with no
 * new machinery at all.
 *
 * Two honest limitations up front:
 *
 *  - **This is the Camera Raw *filter*, not a raw converter.** It works on 8-bit
 *    RGB like Photoshop's own Camera Raw Filter does. Pikado cannot decode
 *    CR2/NEF/ARW — that needs per-sensor demosaicing and colour profiles, and it
 *    is not here. Recovery in Highlights and Blacks therefore has an 8-bit
 *    ceiling: what is clipped to 255 in the file is gone, and no slider can
 *    invent it. On real raw data those sliders reach further because the data
 *    does.
 *  - **Temperature is relative, not a Kelvin reading.** Real raw white balance
 *    multiplies sensor channels before demosaicing, and the Kelvin number means
 *    something because the sensor data is uncalibrated. An already-rendered sRGB
 *    image has no such number to set, so the slider runs −100…+100 and moves the
 *    correction along the daylight locus — which is exactly what Photoshop shows
 *    for the Camera Raw filter on a non-raw layer. The gains are von Kries
 *    channel multipliers, normalised to leave luminance alone.
 *
 * **Where the work happens.** Everything tonal runs in *linear light*, because
 * that is where exposure is a multiply and where blurring does not darken edges.
 * The sRGB transfer function is applied through 256-entry tables on the way in
 * and a scaled table on the way out, so the round trip costs two lookups rather
 * than two `Math.pow` calls per channel.
 *
 * **Cost.** Each of Clarity, Texture, Dehaze, Sharpening and Noise Reduction
 * needs its own blur, so a full-strength edit on a large image is several passes
 * over the pixels. Every stage is skipped entirely at its neutral value, and the
 * defaults are neutral, so a typical edit touches two or three.
 */

/* ------------------------------------------------------------------ */
/* sRGB transfer                                                       */
/* ------------------------------------------------------------------ */

const TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Encoded value for a linear one, via a 4096-entry table. */
const ENCODE_STEPS = 4096;
const TO_SRGB = new Uint8Array(ENCODE_STEPS + 1);
for (let i = 0; i <= ENCODE_STEPS; i++) {
  const l = i / ENCODE_STEPS;
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  TO_SRGB[i] = Math.max(0, Math.min(255, Math.round(s * 255)));
}
/*
 * Rounds rather than truncates. Near black one table step is about 0.8 sRGB
 * levels, so truncation biased every dark value downward and the linear round
 * trip was not value-preserving: several dark inputs came back one level lower
 * than they went in, which is a filter that is not quite the identity at its
 * defaults.
 */
const encode = (l) => TO_SRGB[l <= 0 ? 0 : l >= 1 ? ENCODE_STEPS : Math.round(l * ENCODE_STEPS)];

/** Rec. 709 luminance of a linear triple — the weighting sRGB is defined with. */
const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* ------------------------------------------------------------------ */
/* White balance                                                       */
/* ------------------------------------------------------------------ */

/**
 * CIE xy chromaticity of a correlated colour temperature.
 *
 * Kim et al.'s cubic approximation of the daylight/Planckian locus, which is the
 * one every colour library uses; accurate to well under a just-noticeable
 * difference across 1667–25000 K.
 */
function cctToXY(kelvin) {
  const T = Math.max(1667, Math.min(25000, kelvin));
  let x;
  if (T <= 4000) {
    x = -0.2661239e9 / T ** 3 - 0.2343589e6 / T ** 2 + 0.8776956e3 / T + 0.179910;
  } else {
    x = -3.0258469e9 / T ** 3 + 2.1070379e6 / T ** 2 + 0.2226347e3 / T + 0.240390;
  }
  let y;
  if (T <= 2222) y = -1.1063814 * x ** 3 - 1.34811020 * x ** 2 + 2.18555832 * x - 0.20219683;
  else if (T <= 4000) y = -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867;
  else y = 3.0817580 * x ** 3 - 5.87338670 * x ** 2 + 3.75112997 * x - 0.37001483;
  return { x, y };
}

/* XYZ (D65) -> linear sRGB, for turning a white point into channel gains. */
const XYZ_TO_RGB = [
  3.2404542, -1.5371385, -0.4985314,
  -0.9692660, 1.8760108, 0.0415560,
  0.0556434, -0.2040259, 1.0572252,
];
const mul3 = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
const D65 = [0.95047, 1, 1.08883];

/**
 * The colour temperature a slider position stands for.
 *
 * The slider is relative (−100…+100, 0 neutral) rather than absolute Kelvin, and
 * that is deliberate — it is what Photoshop shows for the Camera Raw *filter* on
 * a non-raw layer, for a good reason: an already-rendered sRGB image has no
 * sensor white balance to set, so "3200 K" would be a claim about the file that
 * nothing supports. What the slider means here is *how far along the daylight
 * locus to move*, which is a statement about the correction.
 *
 * Geometric rather than linear in Kelvin, because Kelvin is not perceptually
 * even: 3000→4000 K is a large visible change and 9000→10000 K is barely one.
 * ±100 lands at roughly 3900 K and 10900 K, which are strong corrections that
 * still keep every channel inside the sRGB gamut. (An earlier version took
 * absolute Kelvin down to 2000, where the blue multiplier exceeds 4x and blows
 * the channel on a mid grey.)
 */
const kelvinForSlider = (s) => 6500 * 2 ** ((Number(s) || 0) / 100 * 0.75);

/**
 * Per-channel multipliers that white-balance linear sRGB by `temperature` with a
 * green-magenta `tint`, or null when both are neutral.
 *
 * **Direction.** Raising the temperature makes the picture *warmer* and lowering
 * it makes it *cooler* — the same way round as the blue-to-yellow gradient under
 * Camera Raw's own slider. (It reads backwards if you think of it as "the light
 * was this colour, remove it"; the slider is named for the result, not the cause.)
 *
 * **Why multipliers rather than a full adaptation matrix.** A proper Bradford
 * transform between white points is the colorimetrically correct operation, and
 * the first version of this did exactly that. The problem is that adapting a
 * rendered sRGB image to a white point far from D65 lands outside the sRGB gamut,
 * so the matrix returns *negative* channel values: at 2000 K a neutral grey came
 * back with red clipped to zero. Scaling the three channels — von Kries
 * adaptation carried out in RGB, which is what a raw converter does to sensor
 * data anyway — can never produce a negative, so the extremes stay usable.
 * The multipliers are normalised to preserve luminance, so temperature changes
 * colour without also changing exposure.
 *
 * @param {number} temperature -100..100; positive is warmer
 * @param {number} tint -100..100; positive is magenta, negative green
 * @returns {{r:number, g:number, b:number}|null}
 */
function whiteBalanceGains(temperature, tint) {
  const s = Number(temperature) || 0;
  const g = Number(tint) || 0;
  if (Math.abs(s) < 0.01 && Math.abs(g) < 0.01) return null;

  const { x, y } = cctToXY(kelvinForSlider(s));
  // The requested white point, and D65, as linear sRGB.
  const target = mul3(XYZ_TO_RGB, [x / y, 1, (1 - x - y) / y]);
  const neutral = mul3(XYZ_TO_RGB, D65);

  // neutral / target, not target / neutral. Dividing *by* the requested white
  // point corrects the image toward it; multiplying by it would paint the
  // illuminant's own colour onto the picture, which puts the slider the wrong way
  // round — 2500 K would come out orange instead of blue.
  const safe = (v) => (Math.abs(v) < 1e-6 ? 1e-6 : v);
  let mr = neutral[0] / safe(target[0]);
  let mg = neutral[1] / safe(target[1]);
  let mb = neutral[2] / safe(target[2]);

  // Tint is the correction perpendicular to the temperature axis: positive
  // magenta means *less* green, which is what makes it the opposite of a green
  // cast rather than another way to add one.
  const shift = 1 - g / 250;
  mg *= shift;

  // Normalise so a neutral keeps its luminance: this is a colour control, and
  // it should not double as an exposure control.
  const l = 0.2126 * mr + 0.7152 * mg + 0.0722 * mb;
  if (!(l > 1e-6)) return null;
  return { r: mr / l, g: mg / l, b: mb / l };
}

/* ------------------------------------------------------------------ */
/* Tone helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Smooth region weights for the four tone sliders, from a 0..1 *perceptual*
 * lightness (the encoded value, not linear light).
 *
 * The four overlap deliberately, as they do in Camera Raw: Blacks and Whites act
 * on the very ends, Shadows and Highlights across the broad lower and upper
 * halves. Powers of the value and its complement keep every weight continuous,
 * so no slider can produce a visible band where its region stops.
 *
 * These are deliberately *not* damped at the extremes. An earlier version
 * multiplied the Shadows weight by `1 - (1-l)^3` to keep it out of Blacks'
 * territory, which took the weight at the bottom of the range down to 0.23 and
 * made Shadows +80 move a very dark patch by four levels out of 255 — a control
 * that appeared to do nothing. Overlap is the correct behaviour: the two sliders
 * are meant to stack there.
 */
const wBlacks = (l) => (1 - l) ** 6;
const wShadows = (l) => (1 - l) ** 2.2;
const wHighlights = (l) => l ** 2.2;
const wWhites = (l) => l ** 6;

/* ------------------------------------------------------------------ */
/* Tone transfer curves                                                */
/* ------------------------------------------------------------------ */

const LUT_STEPS = 256;

/**
 * Sample a 257-entry transfer curve with linear interpolation.
 * @param {Float32Array} lut
 * @param {number} v 0..1
 */
function sampleLUT(lut, v) {
  const x = (v < 0 ? 0 : v > 1 ? 1 : v) * LUT_STEPS;
  const i = Math.min(LUT_STEPS - 1, x | 0);
  const t = x - i;
  return lut[i] + (lut[i + 1] - lut[i]) * t;
}

/**
 * Force a transfer curve to be non-decreasing, in place. A backstop; the curves
 * below are built monotonic.
 */
function enforceMonotonic(lut) {
  for (let i = 1; i <= LUT_STEPS; i++) if (lut[i] < lut[i - 1]) lut[i] = lut[i - 1];
  return lut;
}

/**
 * The tone-region transfer curve, in encoded lightness.
 *
 * Four sliders, applied as four **strictly monotone** operations composed in order.
 * That construction is the point, and it took three wrong versions to arrive at:
 *
 *   1. Summing weight bumps onto the identity made the curve NON-MONOTONIC.
 *      `wBlacks` is `(1-l)^6`, derivative -6 at black, so at Blacks +100 the
 *      transfer slope was `1 + 0.3 x (-6)` — negative. Darker in, lighter out.
 *   2. Clamping the running maximum afterwards made it monotonic by flattening the
 *      whole would-have-inverted stretch to one value: the shadows posterised into a
 *      single tone. Scaling the delta to its largest monotonic fraction had the same
 *      character — a near-zero slope across a range, because all the lift sat where
 *      the weight was steep.
 *   3. A monotone spline through five control points spread the lift out, but the
 *      points themselves can be contradictory (Shadows +100 pushes the quarter tone
 *      above the midpoint), and forcing them into order flattened a segment instead.
 *      At the extreme — every slider pushed inward — the whole ramp collapsed to one
 *      tone.
 *
 * Composing operations that are each strictly increasing cannot produce a plateau at
 * all, whatever the sliders say, because the slope of a composition is the product
 * of the slopes and none of them is zero. Clipping still happens where the user asks
 * for it — crushing blacks clips at the bottom, that is what crushing means — but
 * nothing collapses in the middle.
 *
 *   Blacks / Whites  move the endpoints  (a levels-style remap)
 *   Shadows          lifts or lowers the darks, holding 0 and 1 fixed
 *   Highlights       pulls or pushes the brights, holding 0 and 1 fixed
 */
function toneRegionLUT(shadows, highlights, whites, blacks) {
  const lut = new Float32Array(LUT_STEPS + 1);

  // Endpoint moves. A positive Blacks raises the black point (greying the shadows,
  // slope 1 - B, no clipping); a negative one deepens it (slope 1/(1-B), clipping at
  // the bottom). Whites is the mirror image.
  const b = blacks * 0.25;
  const w = whites * 0.25;

  /*
   * Region shaping, applied to HALF the range each.
   *
   * A gamma over the whole range is strictly increasing and fixes both endpoints,
   * which is why it was tempting — but it is not confined: a Highlights gamma pulls
   * the midtones and shadows down too, and measured on a test patch, Highlights -80
   * took a shadow from 22 to 11. That is exactly the crosstalk the sliders exist to
   * avoid, and it is worse than the weight-based version it replaced.
   *
   * Applying each gamma to its own half of the range — rescaled to 0..1 so the gamma
   * still fixes both ends of that half — confines it completely. Both halves meet at
   * the midpoint with the same value, so the curve is continuous, and each piece is
   * strictly increasing, so the whole is monotone. The slope changes at the midpoint;
   * that kink is invisible in practice, and it is a far better trade than a slider
   * that moves tones it does not name.
   */
  /*
   * The exponent is 2^(-slider·k), NOT 1/(1 + slider·k).
   *
   * The reciprocal form looks equivalent and is not: it needs k < 1 to keep the
   * denominator positive, and confining each gamma to half the range meant k had to
   * rise to about 1.3 for the sliders to stay effective. At k = 1.3 anything past
   * |slider| = 0.77 drives the denominator NEGATIVE — the exponent flips sign, the
   * power explodes, and half the tonal range collapses to a single value. Highlights
   * +100 flattened everything above mid grey to 128.
   *
   * An exponential is positive for every input, symmetric in log space (so +50 and
   * -50 are equal and opposite), and has no pole to fall into.
   */
  const shadowGamma = 2 ** (-shadows * 1.6);
  const highlightGamma = 2 ** (highlights * 1.6);

  for (let i = 0; i <= LUT_STEPS; i++) {
    let v = i / LUT_STEPS;

    if (b > 0) v = v * (1 - b) + b;
    else if (b < 0) v = (v + b) / (1 + b);

    if (w > 0) v = v / (1 - Math.min(0.9, w));
    else if (w < 0) v = v * (1 + w);

    v = clamp01(v);

    if (shadows && v < 0.5) {
      const u = v / 0.5;
      v = 0.5 * (u <= 0 ? 0 : u ** shadowGamma);
    }
    if (highlights && v > 0.5) {
      // On the complement within the upper half, so it shapes the bright end.
      const u = (v - 0.5) / 0.5;
      v = 0.5 + 0.5 * (u >= 1 ? 1 : 1 - (1 - u) ** highlightGamma);
    }

    lut[i] = clamp01(v);
  }
  return enforceMonotonic(lut);
}

/**
 * The contrast transfer curve: a genuine sigmoid about middle grey.
 *
 * A straight linear stretch through the midpoint is what this used to be, and it
 * clips: at +100 everything above about 0.7 became pure white and everything below
 * about 0.3 pure black, so the slider destroyed the ends long before it finished
 * its travel. A smoothstep-shaped S keeps the ends compressed instead of clipped,
 * which is what "contrast" is supposed to mean, and it is monotonic by
 * construction — but it is checked anyway, because the check is nearly free.
 */
function contrastLUT(amount) {
  const a = Math.max(-1, Math.min(1, amount));
  const lut = new Float32Array(LUT_STEPS + 1);
  for (let i = 0; i <= LUT_STEPS; i++) {
    const v = i / LUT_STEPS;
    // smoothstep is the S; the identity is the straight line; `a` blends between
    // them, and negative `a` blends toward the inverse S, which flattens contrast.
    const s = v * v * (3 - 2 * v);
    const flat = 0.5 + (v - 0.5) * 0.45;
    lut[i] = clamp01(a >= 0 ? v + (s - v) * a : v + (flat - v) * -a);
  }
  return enforceMonotonic(lut);
}

/**
 * A midtone-weighted local contrast pass — Clarity, Texture and Sharpening all
 * reduce to this with different radii and weightings.
 *
 * @param {Float32Array} lin interleaved linear RGBA
 * @param {number} w
 * @param {number} h
 * @param {number} sigma blur radius
 * @param {number} amount signed strength
 * @param {(l:number)=>number} weight per-pixel weighting from luminance
 * @param {number} [detail] 0..1; 1 keeps fine detail only, 0 the whole difference
 */
function localContrast(lin, w, h, sigma, amount, weight, detail = 0) {
  if (!amount) return;
  const n = w * h;
  // Work on luminance only: pushing local contrast per channel shifts hue, which
  // is exactly the crunchy look Clarity is not supposed to have.
  const lum = new Float32Array(n);
  for (let i = 0, p = 0; p < n; p++, i += 4) lum[p] = luminance(lin[i], lin[i + 1], lin[i + 2]);
  const blurred = new Float32Array(lum);
  gaussianBlurBuffer(blurred, w, h, sigma, 1);

  let fine = null;
  if (detail > 0) {
    // "Detail" suppresses the low-frequency half of the difference, so the pass
    // sharpens texture without also raising broad local contrast.
    fine = new Float32Array(lum);
    gaussianBlurBuffer(fine, w, h, Math.max(0.6, sigma * 0.35), 1);
  }

  for (let i = 0, p = 0; p < n; p++, i += 4) {
    const l = lum[p];
    let diff = l - blurred[p];
    if (fine) diff = diff * (1 - detail) + (l - fine[p]) * detail;
    const k = amount * weight(clamp01(l));
    if (!k) continue;
    const add = diff * k;
    // Add the same absolute amount to all three channels: that is a luminance
    // change, so saturation is untouched.
    lin[i] += add;
    lin[i + 1] += add;
    lin[i + 2] += add;
  }
}

/* ------------------------------------------------------------------ */
/* HSL / colour mixer                                                  */
/* ------------------------------------------------------------------ */

/**
 * The eight colour bands, by hue centre in degrees. Camera Raw's own set.
 * Weights are a raised cosine over ±45°, so adjacent bands cross over smoothly
 * and the eight weights sum to roughly one everywhere.
 */
const BANDS = [
  { key: 'red', label: 'Reds', hue: 0 },
  { key: 'orange', label: 'Oranges', hue: 30 },
  { key: 'yellow', label: 'Yellows', hue: 60 },
  { key: 'green', label: 'Greens', hue: 120 },
  { key: 'aqua', label: 'Aquas', hue: 180 },
  { key: 'blue', label: 'Blues', hue: 240 },
  { key: 'purple', label: 'Purples', hue: 280 },
  { key: 'magenta', label: 'Magentas', hue: 320 },
];

/**
 * Band weight for a hue, as a partition of unity.
 *
 * Each band's window reaches exactly to its neighbouring centres rather than a
 * fixed ±60 degrees, and falls as a raised cosine across that span. Two facts make
 * this the right shape:
 *
 *   - the eight centres are NOT evenly spaced (0, 30, 60, 120, 180, 240, 280, 320),
 *     so a fixed window overlapped three bands around orange and two around green.
 *     The weights then summed to about 2 in one place and 1.5 in another, and the
 *     same slider value did visibly different amounts of work depending on hue.
 *   - normalising a fixed window by the total weight fixes that ratio but breaks
 *     something users rely on: with neighbours at zero diluting it, one band's
 *     slider at -100 could only remove 44% of its own hue's saturation. Reds at
 *     -100 has to fully desaturate red.
 *
 * Reaching to the neighbours gives both. For a hue a fraction `t` of the way from
 * one centre to the next, the two weights are `(1 + cos πt)/2` and `(1 - cos πt)/2`,
 * which sum to exactly 1 — so a single band at full strength owns its own centre
 * completely, and every hue in between receives exactly what its two bands ask for.
 */
const BAND_GAPS = BANDS.map((band, i) => {
  const prev = BANDS[(i - 1 + BANDS.length) % BANDS.length].hue;
  const next = BANDS[(i + 1) % BANDS.length].hue;
  const wrap = (d) => ((d % 360) + 360) % 360;
  return { left: wrap(band.hue - prev) || 360, right: wrap(next - band.hue) || 360 };
});

function bandWeight(hue, centre) {
  const i = BANDS.findIndex((b) => b.hue === centre);
  if (i < 0) return 0;
  let d = ((hue - centre) % 360 + 360) % 360;
  if (d > 180) d -= 360;                       // signed offset, -180..180
  const span = d >= 0 ? BAND_GAPS[i].right : BAND_GAPS[i].left;
  const a = Math.abs(d);
  if (a >= span) return 0;
  return 0.5 * (1 + Math.cos((a / span) * Math.PI));
}

/** RGB (0..1, any space) -> HSL with hue in degrees. */
function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-9) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  if (s <= 1e-9) return [l, l, l];
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

/* ------------------------------------------------------------------ */
/* The develop pipeline                                                */
/* ------------------------------------------------------------------ */

/** Every parameter, at its neutral value. */
export const CAMERA_RAW_DEFAULTS = {
  treatment: 'color',
  temperature: 0,
  tint: 0,
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  texture: 0,
  clarity: 0,
  dehaze: 0,
  vibrance: 0,
  saturation: 0,
  curves: null,
  sharpenAmount: 0,
  sharpenRadius: 1,
  sharpenDetail: 25,
  noiseLuminance: 0,
  noiseColor: 0,
  vignette: 0,
  vignetteMidpoint: 50,
  grain: 0,
  grainSize: 25,
  splitBalance: 0,
  highlightHue: 45,
  highlightSat: 0,
  shadowHue: 220,
  shadowSat: 0,
};
for (const b of BANDS) {
  CAMERA_RAW_DEFAULTS[`${b.key}Hue`] = 0;
  CAMERA_RAW_DEFAULTS[`${b.key}Sat`] = 0;
  CAMERA_RAW_DEFAULTS[`${b.key}Lum`] = 0;
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** True when every control is at its neutral value, so the filter is a no-op. */
export function isNeutralDevelop(p = {}) {
  const q = { ...CAMERA_RAW_DEFAULTS, ...p };
  for (const [k, v] of Object.entries(CAMERA_RAW_DEFAULTS)) {
    if (k === 'curves') {
      if (q.curves && !identityCurves(q.curves)) return false;
      continue;
    }
    if (q[k] !== v) return false;
  }
  return true;
}

function identityCurves(curves) {
  if (!curves) return true;
  for (const ch of ['rgb', 'r', 'g', 'b']) {
    const pts = curves[ch];
    if (pts && pts.length && !isIdentityCurve(pts)) return false;
  }
  return true;
}

/**
 * Develop an image in place.
 *
 * The stage order is Camera Raw's own and is not arbitrary: white balance before
 * exposure because exposure is a multiply that must not change hue; the tone
 * region sliders before contrast so contrast operates on the recovered range;
 * the tone curve after them because it is the user's final say on tonality;
 * presence and colour after tone because they read luminance; sharpening and
 * noise reduction last but before the effects, because grain and vignette must
 * not be sharpened.
 *
 * @param {ImageData} image mutated in place
 * @param {object} params see `CAMERA_RAW_DEFAULTS`
 * @returns {ImageData} the same object
 */
export function developImage(image, params = {}) {
  const p = { ...CAMERA_RAW_DEFAULTS, ...params };
  const w = image.width, h = image.height, n = w * h;
  const d = image.data;
  if (!n) return image;

  /* --- to linear light ------------------------------------------------ */
  const lin = new Float32Array(n * 4);
  for (let i = 0; i < n * 4; i += 4) {
    lin[i] = TO_LINEAR[d[i]];
    lin[i + 1] = TO_LINEAR[d[i + 1]];
    lin[i + 2] = TO_LINEAR[d[i + 2]];
    lin[i + 3] = d[i + 3] / 255;
  }

  /* --- 1. white balance ---------------------------------------------- */
  const wb = whiteBalanceGains(p.temperature, p.tint);
  if (wb) {
    for (let i = 0; i < n * 4; i += 4) {
      lin[i] *= wb.r;
      lin[i + 1] *= wb.g;
      lin[i + 2] *= wb.b;
    }
  }

  /* --- 2. exposure ---------------------------------------------------- */
  const exposure = num(p.exposure);
  if (exposure) {
    const k = 2 ** exposure;
    for (let i = 0; i < n * 4; i += 4) { lin[i] *= k; lin[i + 1] *= k; lin[i + 2] *= k; }
  }

  /* --- 3. tone regions ------------------------------------------------ */
  const hi = num(p.highlights) / 100;
  const sh = num(p.shadows) / 100;
  const wh = num(p.whites) / 100;
  const bl = num(p.blacks) / 100;
  if (hi || sh || wh || bl) {
    const lut = toneRegionLUT(sh, hi, wh, bl);
    for (let i = 0; i < n * 4; i += 4) {
      const l = luminance(lin[i], lin[i + 1], lin[i + 2]);
      const le = clamp01(l <= 0 ? 0 : l ** (1 / 2.2));
      const target = sampleLUT(lut, le);
      if (target === le) continue;
      const targetLin = target ** 2.2;
      if (l < 1e-5) {
        // Pure black has no ratio to scale; lifting it has to write the value.
        lin[i] = lin[i + 1] = lin[i + 2] = targetLin;
        continue;
      }
      const gain = targetLin / l;
      lin[i] *= gain; lin[i + 1] *= gain; lin[i + 2] *= gain;
    }
  }

  /* --- 4. contrast ---------------------------------------------------- */
  const contrast = num(p.contrast) / 100;
  if (contrast) {
    const lut = contrastLUT(contrast);
    for (let i = 0; i < n * 4; i += 4) {
      for (let c = 0; c < 3; c++) {
        const v = lin[i + c];
        const e = v <= 0 ? 0 : v ** (1 / 2.2);
        lin[i + c] = sampleLUT(lut, clamp01(e)) ** 2.2;
      }
    }
  }

  /* --- 5. tone curve -------------------------------------------------- */
  if (p.curves && !identityCurves(p.curves)) {
    const luts = {};
    for (const ch of ['rgb', 'r', 'g', 'b']) {
      const pts = p.curves[ch];
      luts[ch] = pts && pts.length && !isIdentityCurve(pts) ? curveToLUT(pts) : null;
    }
    const map = (v, ch) => {
      let e = clamp01(v <= 0 ? 0 : v ** (1 / 2.2)) * 255;
      if (luts[ch]) e = luts[ch][Math.round(e)];
      if (luts.rgb) e = luts.rgb[Math.round(e)];
      return (e / 255) ** 2.2;
    };
    for (let i = 0; i < n * 4; i += 4) {
      lin[i] = map(lin[i], 'r');
      lin[i + 1] = map(lin[i + 1], 'g');
      lin[i + 2] = map(lin[i + 2], 'b');
    }
  }

  /* --- 6. presence ---------------------------------------------------- */
  // Texture is fine detail; Clarity is broad midtone contrast. Both are the same
  // pass with different radii, and both are weighted away from the extremes so
  // they do not halo against a sky or crush a shadow.
  const midWeight = (l) => 4 * l * (1 - l);
  // Clarity's radius scales with the image, because "broad local contrast" means
  // a fraction of the frame rather than a fixed pixel count — but with a real
  // floor. An earlier `min(w,h)/400 + 1` gave 1.2 px on a small image, which is
  // Texture's job, not Clarity's, and left the slider doing almost nothing.
  localContrast(lin, w, h, Math.max(3, Math.min(w, h) / 200), num(p.clarity) / 100 * 1.6, midWeight);
  localContrast(lin, w, h, 1.2, num(p.texture) / 100 * 1.2, midWeight, 0.5);

  const dehaze = num(p.dehaze) / 100;
  if (dehaze) applyDehaze(lin, w, h, dehaze);

  /* --- 7. colour ------------------------------------------------------ */
  const bw = p.treatment === 'bw';
  const anyHsl = BANDS.some((b) => p[`${b.key}Hue`] || p[`${b.key}Sat`] || p[`${b.key}Lum`]);
  const vibrance = num(p.vibrance) / 100;
  const saturation = num(p.saturation) / 100;

  if (anyHsl || vibrance || saturation || bw) {
    for (let i = 0; i < n * 4; i += 4) {
      // Colour work happens in gamma space: HSL is defined there, and a hue
      // rotation in linear light does not look like a hue rotation.
      let r = clamp01(lin[i] <= 0 ? 0 : lin[i] ** (1 / 2.2));
      let g = clamp01(lin[i + 1] <= 0 ? 0 : lin[i + 1] ** (1 / 2.2));
      let b = clamp01(lin[i + 2] <= 0 ? 0 : lin[i + 2] ** (1 / 2.2));
      let [hue, sat, light] = rgbToHsl(r, g, b);

      if (anyHsl && sat > 0.004) {
        // The band weights are a partition of unity, so this is already a weighted
        // average — see `bandWeight`. No normalisation, which would dilute a single
        // band's slider by its neighbours sitting at zero.
        let dh = 0, ds = 0, dl = 0;
        for (const band of BANDS) {
          const wgt = bandWeight(hue, band.hue);
          if (!wgt) continue;
          dh += wgt * num(p[`${band.key}Hue`]) * 0.3;
          ds += wgt * num(p[`${band.key}Sat`]) / 100;
          dl += wgt * num(p[`${band.key}Lum`]) / 100;
        }
        hue += dh;
        sat = clamp01(sat * (1 + ds));
        light = clamp01(light + dl * 0.35 * (1 - Math.abs(2 * light - 1) * 0.5));
      }

      if (vibrance) {
        // Vibrance is saturation weighted against what is already saturated, so
        // skin and other near-neutrals move far less than a flat colour.
        sat = clamp01(sat * (1 + vibrance * (1 - sat) * 1.5));
      }
      if (saturation) sat = clamp01(sat * (1 + saturation));

      if (bw) {
        /*
         * Black and white is a channel mix, not a desaturation, and the base grey
         * has to be a *luminance* — the weighted sum the eye actually responds to.
         * Using HSL's lightness, (max + min) / 2, as this once did, ignores which
         * channel is bright: pure red and pure cyan both come out at 0.5, so the
         * two are indistinguishable in the conversion, which is precisely the
         * distinction a black-and-white conversion exists to control.
         */
        let mixed = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (anyHsl) {
          let dl = 0;
          for (const band of BANDS) {
            const wgt = bandWeight(hue, band.hue);
            if (wgt) dl += wgt * num(p[`${band.key}Lum`]) / 100;
          }
          // Scaled by saturation, so the mixer moves colours and leaves neutrals.
          mixed = clamp01(mixed + dl * 0.5 * sat);
        }
        r = g = b = clamp01(mixed);
      } else {
        [r, g, b] = hslToRgb(hue, sat, light);
      }

      lin[i] = clamp01(r) ** 2.2;
      lin[i + 1] = clamp01(g) ** 2.2;
      lin[i + 2] = clamp01(b) ** 2.2;
    }
  }

  /* --- 8. colour grading (split toning) ------------------------------- */
  const hlSat = num(p.highlightSat) / 100, shSat = num(p.shadowSat) / 100;
  if (hlSat || shSat) {
    const balance = num(p.splitBalance) / 100;
    const hlTint = hslToRgb(num(p.highlightHue, 45), 1, 0.5);
    const shTint = hslToRgb(num(p.shadowHue, 220), 1, 0.5);
    const pivot = clamp01(0.5 + balance * 0.35);
    for (let i = 0; i < n * 4; i += 4) {
      const l = clamp01(luminance(lin[i], lin[i + 1], lin[i + 2]) ** (1 / 2.2));
      const up = clamp01((l - pivot) / Math.max(0.05, 1 - pivot));
      const down = clamp01((pivot - l) / Math.max(0.05, pivot));
      for (let c = 0; c < 3; c++) {
        let v = clamp01(lin[i + c] <= 0 ? 0 : lin[i + c] ** (1 / 2.2));
        if (hlSat) v = v + (hlTint[c] - 0.5) * hlSat * up * 0.6;
        if (shSat) v = v + (shTint[c] - 0.5) * shSat * down * 0.6;
        lin[i + c] = clamp01(v) ** 2.2;
      }
    }
  }

  /* --- 9. detail ------------------------------------------------------ */
  const sharpen = num(p.sharpenAmount) / 100;
  if (sharpen) {
    localContrast(
      lin, w, h,
      Math.max(0.5, num(p.sharpenRadius, 1)),
      sharpen * 2.2,
      () => 1,
      clamp01(num(p.sharpenDetail, 25) / 100)
    );
  }
  const nrLum = num(p.noiseLuminance) / 100;
  const nrCol = num(p.noiseColor) / 100;
  if (nrLum || nrCol) reduceNoise(lin, w, h, nrLum, nrCol);

  /* --- 10. effects ---------------------------------------------------- */
  const grain = num(p.grain) / 100;
  if (grain) applyGrain(lin, w, h, grain, num(p.grainSize, 25));

  const vig = num(p.vignette) / 100;
  if (vig) applyVignette(lin, w, h, vig, num(p.vignetteMidpoint, 50));

  /* --- back to sRGB --------------------------------------------------- */
  for (let i = 0; i < n * 4; i += 4) {
    d[i] = encode(lin[i]);
    d[i + 1] = encode(lin[i + 1]);
    d[i + 2] = encode(lin[i + 2]);
  }
  return image;
}

/* ------------------------------------------------------------------ */
/* Stages that need their own pass                                     */
/* ------------------------------------------------------------------ */

/**
 * Dehaze, by the dark-channel prior.
 *
 * Haze is an additive veil: `I = J·t + A·(1 - t)`, where `A` is the airlight and
 * `t` the transmission. In a haze-free patch at least one colour channel is very
 * dark, so the local minimum across channels ("dark channel") estimates how much
 * veil is present; the brightest few per cent of the dark channel estimates `A`.
 * Inverting gives `J = (I - A)/t + A`.
 *
 * A negative amount runs the same model forward and *adds* veil, which is what
 * Camera Raw's negative Dehaze does.
 */
function applyDehaze(lin, w, h, amount) {
  const n = w * h;
  const dark = new Float32Array(n);
  for (let i = 0, p = 0; p < n; p++, i += 4) {
    dark[p] = Math.min(lin[i], lin[i + 1], lin[i + 2]);
  }
  // A local minimum over a small window, which is what makes it a *dark channel*
  // rather than a per-pixel minimum; then a blur so the transmission map is
  // smooth and does not produce blocky halos.
  const radius = Math.max(2, Math.round(Math.min(w, h) / 120));
  const minned = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius), y1 = Math.min(h - 1, y + radius);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius), x1 = Math.min(w - 1, x + radius);
      let m = 1;
      for (let sy = y0; sy <= y1; sy++) {
        const row = sy * w;
        for (let sx = x0; sx <= x1; sx++) {
          const v = dark[row + sx];
          if (v < m) m = v;
        }
      }
      minned[y * w + x] = m;
    }
  }
  gaussianBlurBuffer(minned, w, h, radius, 1);

  // Airlight: the mean of the brightest 0.1% of the dark channel.
  const sorted = Float32Array.from(minned).sort();
  const from = Math.max(0, Math.floor(sorted.length * 0.999));
  let A = 0;
  for (let i = from; i < sorted.length; i++) A += sorted[i];
  A = Math.max(0.05, A / Math.max(1, sorted.length - from));

  const strength = Math.min(0.95, Math.abs(amount) * 0.95);
  const adding = amount < 0;
  /*
   * Adding haze needs a DIFFERENT transmission map from removing it.
   *
   * The estimated map describes the veil already present, so it is near 1 wherever
   * the image is dark and clear — and `A·(1 - t)` there is near zero. Running it
   * forward therefore added almost no veil to exactly the dark regions haze affects
   * most, which is the opposite of hazy. Real haze thickens with distance and, absent
   * a depth map, the honest approximation is uniform: every pixel gets the same
   * transmission, so the whole image lifts and flattens the way a veil makes it.
   */
  const uniformT = 1 - strength * 0.8;
  for (let i = 0, p = 0; p < n; p++, i += 4) {
    const t = adding ? uniformT : Math.max(0.1, 1 - strength * (minned[p] / A));
    for (let c = 0; c < 3; c++) {
      const I = lin[i + c];
      /*
       * Positive: invert the haze model, J = (I - A)/t + A.
       * Negative: run the SAME model forward, I' = I*t + A*(1 - t), which is what
       * adding atmospheric veil actually is.
       *
       * The earlier negative branch reflected the dehazed value about the input
       * (`I + (I - J)`). That is not the forward model: because dehazing divides by
       * t, reflecting it multiplies the deviation by 1/t rather than by t, so past
       * about -40 the "added haze" overshot into crushed blacks and clipped
       * highlights instead of the flat, lifted look haze has.
       */
      lin[i + c] = adding ? I * t + A * (1 - t) : (I - A) / t + A;
    }
  }
}

/**
 * Noise reduction: edge-aware smoothing of luminance, plain smoothing of chroma.
 *
 * Luminance uses a bilateral-style blend — a blurred copy, mixed in only where
 * the local difference is small enough to be noise rather than an edge. That is
 * the whole reason a noise slider does not simply soften the picture. Chroma
 * noise is safe to blur outright, because the eye has far less spatial acuity
 * for colour than for brightness.
 */
function reduceNoise(lin, w, h, lumAmount, colorAmount) {
  const n = w * h;
  if (lumAmount > 0) {
    const lum = new Float32Array(n);
    for (let i = 0, p = 0; p < n; p++, i += 4) lum[p] = luminance(lin[i], lin[i + 1], lin[i + 2]);
    const smooth = new Float32Array(lum);
    // Deliberately a *small* radius. Noise is high frequency, so 1–2 px removes
    // it; a wide blur instead reaches across edges, and although the edge pixel
    // itself is protected by the difference test, its neighbours are not — a 3.5 px
    // radius eroded a hard step by 40% while looking perfectly edge-aware at the
    // edge itself.
    gaussianBlurBuffer(smooth, w, h, 0.7 + lumAmount * 1.3, 1);
    // Anything differing by more than this is treated as structure, not noise.
    // The range matters: at 0.06 the top of the slider only removed about half
    // the variance of visible sensor noise, because typical noise amplitude and
    // the threshold were the same size and the exponential cut the correction in
    // half exactly where it was needed.
    const threshold = 0.03 + lumAmount * 0.12;
    for (let i = 0, p = 0; p < n; p++, i += 4) {
      const diff = smooth[p] - lum[p];
      const keep = Math.exp(-(diff * diff) / (threshold * threshold));
      const delta = diff * keep * lumAmount;
      lin[i] += delta; lin[i + 1] += delta; lin[i + 2] += delta;
    }
  }
  if (colorAmount > 0) {
    const cb = new Float32Array(n), cr = new Float32Array(n), y = new Float32Array(n);
    for (let i = 0, p = 0; p < n; p++, i += 4) {
      const l = luminance(lin[i], lin[i + 1], lin[i + 2]);
      y[p] = l;
      cb[p] = lin[i + 2] - l;
      cr[p] = lin[i] - l;
    }
    const sigma = 1 + colorAmount * 5;
    gaussianBlurBuffer(cb, w, h, sigma, 1);
    gaussianBlurBuffer(cr, w, h, sigma, 1);
    for (let i = 0, p = 0; p < n; p++, i += 4) {
      const l = y[p];
      const targetR = l + cr[p], targetB = l + cb[p];
      // Rebuild green from the luminance definition so the mix stays neutral.
      const targetG = (l - 0.2126 * targetR - 0.0722 * targetB) / 0.7152;
      lin[i] += (targetR - lin[i]) * colorAmount;
      lin[i + 1] += (targetG - lin[i + 1]) * colorAmount;
      lin[i + 2] += (targetB - lin[i + 2]) * colorAmount;
    }
  }
}

/**
 * Film grain: monochrome noise, scaled up from a smaller field so "size" means
 * something, and weighted toward the midtones because grain is least visible in
 * deep shadow and blown highlight.
 */
function applyGrain(lin, w, h, amount, size) {
  const scale = Math.max(1, size / 25);
  const gw = Math.max(1, Math.round(w / scale));
  const gh = Math.max(1, Math.round(h / scale));
  const rnd = makeRandom(0x5eed);
  const field = new Float32Array(gw * gh);
  for (let i = 0; i < field.length; i++) field[i] = rnd() * 2 - 1;
  if (scale > 1.5) gaussianBlurBuffer(field, gw, gh, 0.5, 1);

  const strength = amount * 0.12;
  for (let y = 0; y < h; y++) {
    const gy = Math.min(gh - 1, (y / scale) | 0);
    for (let x = 0; x < w; x++) {
      const gx = Math.min(gw - 1, (x / scale) | 0);
      const i = (y * w + x) * 4;
      const l = clamp01(luminance(lin[i], lin[i + 1], lin[i + 2]) ** (1 / 2.2));
      const weight = 4 * l * (1 - l);
      const g = field[gy * gw + gx] * strength * weight;
      lin[i] += g; lin[i + 1] += g; lin[i + 2] += g;
    }
  }
}

/**
 * Post-crop vignette. Positive lightens the corners, negative darkens them;
 * `midpoint` moves where the falloff begins.
 */
function applyVignette(lin, w, h, amount, midpoint) {
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const maxR = Math.hypot(cx, cy) || 1;
  const start = clamp01(midpoint / 100) * 0.9;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = Math.hypot(x - cx, y - cy) / maxR;
      if (r <= start) continue;
      const t = (r - start) / Math.max(0.05, 1 - start);
      // Smoothstep, so there is no visible ring where the vignette starts.
      const f = t * t * (3 - 2 * t);
      const gain = 1 + amount * f;
      const i = (y * w + x) * 4;
      lin[i] *= gain; lin[i + 1] *= gain; lin[i + 2] *= gain;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

const slider = (key, label, min, max, def, unit, step) => ({
  key, label, type: 'slider', min, max, default: def, unit, step: step == null ? 1 : step,
});

const hslRows = [];
for (const b of BANDS) {
  hslRows.push(slider(`${b.key}Hue`, `${b.label} Hue`, -100, 100, 0));
  hslRows.push(slider(`${b.key}Sat`, `${b.label} Saturation`, -100, 100, 0));
  hslRows.push(slider(`${b.key}Lum`, `${b.label} Luminance`, -100, 100, 0));
}

registerFilter({
  id: 'camera-raw',
  name: 'Camera Raw Filter...',
  menu: 'Other',
  preview: true,
  needsDialog: true,
  dialogWidth: 460,
  params: [
    { key: 'treatment', label: 'Treatment', type: 'radio', default: 'color',
      options: [{ value: 'color', label: 'Color' }, { value: 'bw', label: 'Black & White' }] },

    { type: 'label', label: 'White Balance' },
    slider('temperature', 'Temperature', -100, 100, 0),
    slider('tint', 'Tint', -100, 100, 0),

    { type: 'label', label: 'Tone' },
    slider('exposure', 'Exposure', -5, 5, 0, 'EV', 0.05),
    slider('contrast', 'Contrast', -100, 100, 0),
    slider('highlights', 'Highlights', -100, 100, 0),
    slider('shadows', 'Shadows', -100, 100, 0),
    slider('whites', 'Whites', -100, 100, 0),
    slider('blacks', 'Blacks', -100, 100, 0),

    { type: 'label', label: 'Presence' },
    slider('texture', 'Texture', -100, 100, 0),
    slider('clarity', 'Clarity', -100, 100, 0),
    slider('dehaze', 'Dehaze', -100, 100, 0),
    slider('vibrance', 'Vibrance', -100, 100, 0),
    slider('saturation', 'Saturation', -100, 100, 0),

    { type: 'label', label: 'Tone Curve' },
    curveParam({ key: 'curves' }),

    { type: 'label', label: 'Color Mixer' },
    ...hslRows,

    { type: 'label', label: 'Color Grading' },
    slider('shadowHue', 'Shadow Hue', 0, 360, 220, '°'),
    slider('shadowSat', 'Shadow Saturation', 0, 100, 0),
    slider('highlightHue', 'Highlight Hue', 0, 360, 45, '°'),
    slider('highlightSat', 'Highlight Saturation', 0, 100, 0),
    slider('splitBalance', 'Balance', -100, 100, 0),

    { type: 'label', label: 'Detail' },
    slider('sharpenAmount', 'Sharpening', 0, 150, 0),
    slider('sharpenRadius', 'Radius', 0.5, 3, 1, 'px', 0.1),
    slider('sharpenDetail', 'Detail', 0, 100, 25),
    slider('noiseLuminance', 'Luminance Noise Reduction', 0, 100, 0),
    slider('noiseColor', 'Color Noise Reduction', 0, 100, 0),

    { type: 'label', label: 'Effects' },
    slider('grain', 'Grain', 0, 100, 0),
    slider('grainSize', 'Grain Size', 5, 100, 25),
    slider('vignette', 'Vignette', -100, 100, 0),
    slider('vignetteMidpoint', 'Vignette Midpoint', 0, 100, 50),
  ],
  apply(imageData, params) {
    // Every control neutral: hand the pixels back untouched rather than paying
    // for a linear round trip that cannot change anything.
    if (isNeutralDevelop(params)) return imageData;
    return developImage(imageData, params);
  },
});

export { BANDS as CAMERA_RAW_BANDS, defaultCurves };
