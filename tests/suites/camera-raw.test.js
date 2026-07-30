import { suite } from '../harness.js';
import { developImage, isNeutralDevelop, CAMERA_RAW_DEFAULTS, CAMERA_RAW_BANDS } from '/src/filters/camera-raw.js';
import { getFilter } from '/src/filters/registry.js';
import { getCommand } from '/src/commands/registry.js';
import {
  isSmartLayer, addSmartFilter, removeSmartFilter, toggleSmartFilter, getSmartFilters,
} from '/src/core/smart.js';
import { convertToSmartObject } from '/src/layers/ops.js';
import { ctx2d, ctx2dRead } from '/src/core/util.js';

/**
 * Camera Raw.
 *
 * A develop module is a long chain of controls, and the failure mode is not that
 * one of them throws — it is that one of them is *inverted*, or too weak to do
 * anything, or fights the one next to it. So every test here asks a slider
 * whether it does what its name says, in the direction its name implies, with a
 * measurement rather than a glance:
 *
 *  - Exposure +1 EV must be a genuine doubling of *linear* light, which lands a
 *    mid grey at 176 and not at 255.
 *  - Temperature must warm when positive, cool when negative, move monotonically
 *    over its whole range, keep luminance, and never clip a channel.
 *  - Each tone slider must move its own region and leave the others alone.
 *  - Vibrance must favour muted colour over saturated, or it is just Saturation.
 *  - Noise reduction must remove noise *and* keep an edge, since a plain blur
 *    would pass the first half of that on its own.
 *
 * The suite also pins the property that makes the whole module worth having: as a
 * registered filter, Camera Raw is a smart filter, and at its defaults it renders
 * the source byte for byte.
 */

/* ------------------------------------------------------------------ */
/* Fixture                                                             */
/* ------------------------------------------------------------------ */

const W = 96, H = 96;

/**
 * A frame with something for every control to bite on: a mid-grey field, a deep
 * shadow, a near-white, a strongly saturated red and a gently saturated
 * skin-like tone (the two saturations are what separate Vibrance from
 * Saturation).
 */
function fixture() {
  const img = new ImageData(W, H);
  const set = (x0, y0, x1, y1, r, g, b) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * 4;
        img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
  };
  set(0, 0, W, H, 128, 128, 128);
  set(4, 4, 28, 28, 22, 22, 22);
  set(68, 4, 92, 28, 238, 238, 238);
  set(4, 68, 28, 92, 200, 40, 40);
  set(68, 68, 92, 92, 150, 120, 110);
  return img;
}

const dev = (params) => developImage(fixture(), params);
const at = (img, x, y) => {
  const i = (y * W + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
const grey = (img) => at(img, 48, 48);
const shadow = (img) => at(img, 16, 16);
const white = (img) => at(img, 80, 16);
const red = (img) => at(img, 16, 80);
const skin = (img) => at(img, 80, 80);
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const sat = ([r, g, b]) => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx ? (mx - mn) / mx : 0;
};

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

suite('camera raw / registers as a filter, so it is also a smart filter', async (t) => {
  const f = getFilter('camera-raw');
  t.ok(f, 'the filter is registered');
  t.eq(f.menu, 'Other', 'in a real filter menu, which is what makes it available to a smart object');
  t.ok(f.preview, 'with preview enabled');
  t.ok(f.needsDialog, 'and a dialog');

  const panels = f.params.filter((p) => p.type === 'label').map((p) => p.label);
  t.eq(panels, ['White Balance', 'Tone', 'Presence', 'Tone Curve', 'Color Mixer', 'Color Grading', 'Detail', 'Effects'],
    'the controls are grouped into the panels Camera Raw uses');
  t.ok(f.params.some((p) => p.key === 'curves'), 'the tone curve editor is one of them');
  t.eq(CAMERA_RAW_BANDS.length, 8, 'the colour mixer has eight bands');
  for (const band of CAMERA_RAW_BANDS) {
    t.ok(f.params.some((p) => p.key === `${band.key}Sat`), `${band.label} has a saturation control`);
  }

  const cmd = getCommand('filter.camera-raw');
  t.ok(cmd, 'there is a top-level command for it');
  t.eq(cmd.accel, 'Shift+Ctrl+A', 'with Photoshop\'s shortcut');
});

suite('camera raw / the defaults are exactly the identity', async (t) => {
  const before = fixture();
  const after = dev({});
  t.eq(t.mad(before.data, after.data), 0, 'every control at its default changes nothing at all');
  t.ok(isNeutralDevelop({}), 'isNeutralDevelop agrees');
  t.ok(isNeutralDevelop(CAMERA_RAW_DEFAULTS), 'and agrees about the defaults object');
  t.notOk(isNeutralDevelop({ exposure: 0.1 }), 'a moved slider is not neutral');
  t.notOk(isNeutralDevelop({ treatment: 'bw' }), 'nor is a changed treatment');
});

/* ------------------------------------------------------------------ */
/* Exposure and white balance                                          */
/* ------------------------------------------------------------------ */

suite('camera raw / exposure is a stop of linear light', async (t) => {
  const base = fixture();
  t.eq(grey(base)[0], 128, 'the fixture field is mid grey (precondition)');

  const up = dev({ exposure: 1 });
  const down = dev({ exposure: -1 });
  // 128 encoded is 0.2158 linear; doubling gives 0.4316, which encodes to 176.
  // Getting 255 here would mean the multiply happened in the encoded domain.
  t.close(grey(up)[0], 176, 2, `+1 EV doubles linear light (got ${grey(up)[0]})`);
  t.close(grey(down)[0], 92, 2, `-1 EV halves it (got ${grey(down)[0]})`);
  t.eq(grey(dev({ exposure: 0 }))[0], 128, 'and zero is exact');
});

suite('camera raw / temperature warms one way and cools the other', async (t) => {
  const base = fixture();
  const readings = [-100, -60, -20, 0, 20, 60, 100].map((s) => {
    const g = grey(dev({ temperature: s }));
    return { s, g, ratio: g[0] / g[2] };
  });

  const cool = readings.find((r) => r.s === -100).g;
  const warm = readings.find((r) => r.s === 100).g;
  t.gt(cool[2], cool[0] + 15, `a negative temperature cools (${cool})`);
  t.gt(warm[0], warm[2] + 12, `a positive one warms (${warm})`);
  t.eq(grey(dev({ temperature: 0 })), grey(base), 'zero is exactly the identity');

  // Monotonic across the whole range: a slider that reverses anywhere is unusable.
  let monotonic = true;
  for (let i = 1; i < readings.length; i++) if (readings[i].ratio <= readings[i - 1].ratio) monotonic = false;
  t.ok(monotonic, `the warm/cool balance moves monotonically (${readings.map((r) => `${r.s}:${r.ratio.toFixed(2)}`).join(' ')})`);

  // No position may clip: the first implementation used absolute Kelvin and a
  // Bradford adaptation, which drove red to 0 on a mid grey at 2000 K.
  const clipped = readings.filter((r) => r.g.some((c) => c <= 3 || c >= 252));
  t.eq(clipped.map((r) => r.s), [], 'no slider position clips a channel');

  // It is a colour control, not an exposure control.
  const drift = Math.max(...readings.map((r) => Math.abs(lum(r.g) - lum(grey(base)))));
  t.lt(drift, 14, `luminance is preserved across the range (worst drift ${drift.toFixed(1)})`);

  const magenta = grey(dev({ tint: 60 }));
  const green = grey(dev({ tint: -60 }));
  t.lt(magenta[1], magenta[0], `positive tint is magenta (${magenta})`);
  t.gt(green[1], green[0], `negative tint is green (${green})`);
});

/* ------------------------------------------------------------------ */
/* Tone                                                                */
/* ------------------------------------------------------------------ */

suite('camera raw / each tone slider moves its own region', async (t) => {
  const base = fixture();
  const b = { shadow: lum(shadow(base)), white: lum(white(base)), grey: lum(grey(base)) };

  const lifted = dev({ shadows: 80 });
  t.gt(lum(shadow(lifted)), b.shadow + 25, `Shadows +80 lifts the dark patch (${b.shadow.toFixed(0)} -> ${lum(shadow(lifted)).toFixed(0)})`);
  t.close(lum(white(lifted)), b.white, 6, 'and barely touches the near-white');

  const recovered = dev({ highlights: -80 });
  t.lt(lum(white(recovered)), b.white - 25, `Highlights -80 recovers the bright patch (${b.white.toFixed(0)} -> ${lum(white(recovered)).toFixed(0)})`);
  t.close(lum(shadow(recovered)), b.shadow, 6, 'and leaves the shadow alone');
  t.gt(lum(white(dev({ highlights: 80 }))), b.white, 'Highlights +80 goes the other way');

  t.lt(lum(shadow(dev({ blacks: -70 }))), b.shadow - 5, 'Blacks negative deepens the darkest tones');
  t.gt(lum(shadow(dev({ blacks: 70 }))), b.shadow + 5, 'Blacks positive raises them');
  t.gt(lum(white(dev({ whites: 70 }))), b.white + 3, 'Whites positive raises the brightest');
  t.lt(lum(white(dev({ whites: -70 }))), b.white - 3, 'Whites negative lowers them');

  // A tone move is a gain on all three channels, so colour must survive it.
  const toned = dev({ shadows: 60, highlights: -60 });
  t.close(sat(red(toned)), sat(red(base)), 0.08, 'a tone move keeps saturation');
});

suite('camera raw / the tone curve is well behaved across every slider', async (t) => {
  /*
   * A grey ramp is the only way to see what a tone curve actually does, and this one
   * went through four wrong shapes before it behaved. Each failure is a distinct mode,
   * and each is checked here:
   *
   *   inversion  — summed weight bumps gave the curve a negative slope at black:
   *                darker input, lighter output.
   *   collapse   — clamping the running maximum afterwards flattened the whole
   *                would-have-inverted stretch into one tone.
   *   contradiction — a spline through control points that a slider pair can push out
   *                of order flattened a segment instead.
   *   sign flip  — a 1/(1 + slider·k) exponent with k > 1 goes NEGATIVE past
   *                |slider| = 1/k, exploding the power and collapsing half the range.
   *                It only showed at the extremes, so the sweep runs the extremes.
   *   crosstalk  — a gamma over the whole range is not confined: Highlights pulled a
   *                shadow patch from 22 down to 11.
   */
  const W = 128;
  const ramp = () => {
    const img = new ImageData(W, 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const v = Math.round((x / (W - 1)) * 255);
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
    return img;
  };
  const row = (params) => {
    const img = developImage(ramp(), params);
    return Array.from({ length: W }, (_, x) => img.data[(2 * W + x) * 4]);
  };
  const analyse = (out) => {
    let inversions = 0, longest = 1, run = 1, at = 0;
    for (let i = 1; i < out.length; i++) {
      if (out[i] < out[i - 1]) inversions++;
      // Runs at 0 or 255 are clipping, which is a legitimate result of asking to
      // crush blacks or blow whites. A run in the INTERIOR is the defect.
      if (out[i] === out[i - 1] && out[i] !== 0 && out[i] !== 255) {
        run++;
        if (run > longest) { longest = run; at = out[i]; }
      } else run = 1;
    }
    return { inversions, longest, at, distinct: new Set(out).size };
  };

  const base = row({});
  const problems = [];
  for (const key of ['shadows', 'highlights', 'whites', 'blacks']) {
    for (const value of [-100, -80, -50, -20, 20, 50, 80, 100]) {
      const r = analyse(row({ [key]: value }));
      if (r.inversions) problems.push(`${key} ${value}: ${r.inversions} inversions`);
      if (r.longest > 6) problems.push(`${key} ${value}: interior plateau of ${r.longest} at ${r.at}`);
      if (r.distinct < 40) problems.push(`${key} ${value}: only ${r.distinct} of 128 levels survive`);
    }
  }
  t.eq(problems.slice(0, 4), [], 'every slider, across its whole range, stays monotonic and graduated');

  // Region confinement. The ramp indices are a deep shadow and a near-white.
  const shadow = 11, bright = 119;
  const hiDown = row({ highlights: -80 });
  t.lt(hiDown[bright], base[bright] - 25, `Highlights -80 recovers the bright end (${base[bright]} -> ${hiDown[bright]})`);
  t.close(hiDown[shadow], base[shadow], 2, 'and does not touch the shadow at all');
  t.gt(row({ highlights: 80 })[bright], base[bright], 'Highlights +80 goes the other way');

  const shUp = row({ shadows: 80 });
  t.gt(shUp[shadow], base[shadow] + 25, `Shadows +80 lifts the dark end (${base[shadow]} -> ${shUp[shadow]})`);
  t.close(shUp[bright], base[bright], 2, 'and does not touch the bright end');
  t.lt(row({ shadows: -80 })[shadow], base[shadow], 'Shadows -80 deepens it');

  // The worst combination: everything pushed inward at once.
  const inward = analyse(row({ shadows: 100, highlights: -100, whites: -100, blacks: 100 }));
  t.eq(inward.inversions, 0, 'all four pushed inward stays monotonic');
  t.lt(inward.longest, 7, 'without a plateau');
  t.gt(inward.distinct, 55, `and keeps the ramp graduated (${inward.distinct} of 128 levels)`);
});

suite('camera raw / contrast pivots on middle grey', async (t) => {
  const base = fixture();
  const hard = dev({ contrast: 70 });
  const soft = dev({ contrast: -70 });

  t.lt(lum(shadow(hard)), lum(shadow(base)), 'positive contrast darkens the shadow');
  t.gt(lum(white(hard)), lum(white(base)), 'and brightens the highlight');
  t.close(lum(grey(hard)), lum(grey(base)), 3, 'while middle grey stays put');

  t.gt(lum(shadow(soft)), lum(shadow(base)), 'negative contrast lifts the shadow');
  t.lt(lum(white(soft)), lum(white(base)), 'and lowers the highlight');
});

/* ------------------------------------------------------------------ */
/* Colour                                                              */
/* ------------------------------------------------------------------ */

suite('camera raw / vibrance is not just saturation', async (t) => {
  const base = fixture();
  const vib = dev({ vibrance: 80 });
  const satur = dev({ saturation: 80 });

  t.gt(sat(skin(vib)), sat(skin(base)), 'vibrance raises saturation');
  t.eq(sat(grey(vib)) < 0.02, true, 'and leaves a neutral neutral');

  // The point of Vibrance: proportionally more effect on the muted colour than
  // on the already-saturated one, compared with plain Saturation.
  const mutedRatio = (sat(skin(vib)) - sat(skin(base))) / Math.max(1e-6, sat(skin(satur)) - sat(skin(base)));
  const vividRatio = (sat(red(vib)) - sat(red(base))) / Math.max(1e-6, sat(red(satur)) - sat(red(base)));
  t.gt(mutedRatio, vividRatio,
    `it favours the muted colour (${mutedRatio.toFixed(2)}x of saturation's effect) over the saturated one (${vividRatio.toFixed(2)}x)`);

  t.lt(sat(red(dev({ saturation: -100 }))), 0.02, 'saturation -100 is monochrome');
});

suite('camera raw / black and white is a channel mix', async (t) => {
  const bw = dev({ treatment: 'bw' });
  let coloured = 0;
  for (let i = 0; i < bw.data.length; i += 4) {
    if (Math.abs(bw.data[i] - bw.data[i + 1]) > 1 || Math.abs(bw.data[i + 1] - bw.data[i + 2]) > 1) coloured++;
  }
  t.eq(coloured, 0, 'no colour survives the conversion');

  // The band luminance sliders are the mixer, which is what makes it a
  // conversion rather than a desaturation.
  const redUp = dev({ treatment: 'bw', redLum: 100 });
  t.gt(lum(red(redUp)), lum(red(bw)) + 4,
    `raising the red band brightens the red patch (${lum(red(bw)).toFixed(0)} -> ${lum(red(redUp)).toFixed(0)})`);
  t.close(lum(grey(redUp)), lum(grey(bw)), 2, 'while a neutral is unaffected, having no hue to match');
});

suite('camera raw / the colour mixer works per band', async (t) => {
  const base = fixture();
  const shifted = dev({ redHue: 100 });
  t.gt(at(shifted, 16, 80)[1], at(base, 16, 80)[1], 'a red hue shift rotates the red patch toward yellow');
  t.close(lum(grey(shifted)), lum(grey(base)), 2, 'and leaves neutrals alone');

  const desatRed = dev({ redSat: -100 });
  t.lt(sat(red(desatRed)), sat(red(base)) * 0.5, 'a band saturation cut desaturates that band');
  t.close(sat(skin(desatRed)), sat(skin(base)), 0.25, 'without flattening a different hue as much');
});

suite('camera raw / the colour bands are a partition of unity', async (t) => {
  /*
   * The eight band centres are unevenly spaced (0, 30, 60, 120, 180, 240, 280, 320),
   * so a fixed ±60 degree window overlapped three bands around orange and two around
   * green: the same slider did about twice as much work on an orange as on a green.
   *
   * Normalising by the total weight fixes that ratio and breaks something worse —
   * with its neighbours sitting at zero, one band at -100 could only remove 44% of
   * its own hue's saturation, when "Reds -100" has to fully desaturate red. So each
   * band's window reaches exactly to its neighbouring centres instead, which sums to
   * one by construction AND leaves each band owning its own centre outright.
   *
   * Both halves are asserted here, because fixing either one alone regressed the
   * other.
   */
  const hslPatch = (hue) => {
    const img = new ImageData(8, 8);
    const ch = (n) => {
      const k = (n + hue / 30) % 12;
      return 255 * (0.5 - 0.5 * Math.max(-1, Math.min(1, Math.min(k - 3, 9 - k))));
    };
    for (let i = 0; i < 64; i++) {
      const o = i * 4;
      img.data[o] = Math.round(ch(0));
      img.data[o + 1] = Math.round(ch(8));
      img.data[o + 2] = Math.round(ch(4));
      img.data[o + 3] = 255;
    }
    return img;
  };
  const satOf = (img) => {
    const d = img.data;
    const mx = Math.max(d[0], d[1], d[2]), mn = Math.min(d[0], d[1], d[2]);
    return mx ? (mx - mn) / mx : 0;
  };
  const dropAt = (hue, params) => {
    const before = satOf(hslPatch(hue));
    const after = satOf(developImage(hslPatch(hue), params));
    return before > 0.01 ? (before - after) / before : 0;
  };

  // Every band, at its own centre, must be fully effective — including the ones
  // whose neighbours are only 30 degrees away.
  for (const band of CAMERA_RAW_BANDS) {
    const drop = dropAt(band.hue, { [`${band.key}Sat`]: -100 });
    t.gt(drop, 0.85, `${band.label} at -100 desaturates its own centre (${(drop * 100).toFixed(0)}%)`);
  }

  // And must stop at its neighbours' centres, so the bands do not fight.
  t.lt(dropAt(30, { redSat: -100 }), 0.15, 'Reds does not reach the orange centre');
  t.lt(dropAt(0, { orangeSat: -100 }), 0.15, 'and Oranges does not reach the red centre');
  t.lt(dropAt(120, { redSat: -100 }), 0.03, 'nor anywhere far away');

  // Smoothly, not as a step: halfway between two centres both contribute.
  const between = dropAt(15, { redSat: -100 });
  t.gt(between, 0.2, `midway between two centres the roll-off is partial (${(between * 100).toFixed(0)}%)`);
  t.lt(between, 0.9, 'rather than a hard step');
});

suite('camera raw / colour grading tints the ends separately', async (t) => {
  const graded = dev({ shadowHue: 220, shadowSat: 80, highlightHue: 45, highlightSat: 80 });
  const s = shadow(graded), w = white(graded);
  t.gt(s[2], s[0], `the shadows go blue (${s})`);
  t.gt(w[0], w[2], `the highlights go yellow (${w})`);

  const noSat = dev({ shadowHue: 220, highlightHue: 45 });
  t.eq(t.mad(noSat.data, fixture().data), 0, 'with both saturations at zero it is the identity, whatever the hues say');
});

/* ------------------------------------------------------------------ */
/* Detail and effects                                                  */
/* ------------------------------------------------------------------ */

/**
 * The step across the dark patch boundary (the edge sits at x = 28), sampled
 * `d` pixels either side.
 *
 * The distance matters, in opposite directions for the two things it measures.
 * A local-contrast pass only acts within about its own radius of an edge, so
 * Clarity and Sharpening have to be measured close in (d = 2) or the samples are
 * two untouched flat areas that report "no change" whatever the slider does.
 * Edge *preservation* under noise reduction is the reverse: the interesting
 * question is whether the smoothing reached across, so it is measured further
 * out (d = 4), where a wide blur would have flattened the step.
 */
const edgeStep = (img, d = 2) => Math.abs(lum(at(img, 28 + d, 14)) - lum(at(img, 28 - d, 14)));

suite('camera raw / clarity and sharpening raise local contrast', async (t) => {
  const base = fixture();
  const clarity = dev({ clarity: 80 });
  t.gt(edgeStep(clarity), edgeStep(base), `clarity raises the step at an edge (${edgeStep(base).toFixed(1)} -> ${edgeStep(clarity).toFixed(1)})`);
  t.close(lum(grey(clarity)), lum(grey(base)), 3, 'without shifting a flat area');

  const sharp = dev({ sharpenAmount: 120 });
  t.gt(edgeStep(sharp), edgeStep(base), `sharpening raises it too (${edgeStep(base).toFixed(1)} -> ${edgeStep(sharp).toFixed(1)})`);
  t.eq(t.mad(dev({ sharpenAmount: 0, sharpenRadius: 3, sharpenDetail: 100 }).data, base.data), 0,
    'and at zero amount the radius and detail settings do nothing at all');
});

suite('camera raw / noise reduction removes noise and keeps edges', async (t) => {
  // A flat field with a hard edge, plus noise on top.
  const build = () => {
    const img = new ImageData(W, H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const v = x < 28 && y < 28 ? 22 : 128;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
    let s = 11;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    for (let p = 0; p < W * H; p++) {
      const o = p * 4, n = (rnd() - 0.5) * 60;
      for (let c = 0; c < 3; c++) img.data[o + c] = Math.max(0, Math.min(255, img.data[o + c] + n));
    }
    return img;
  };
  const variance = (img) => {
    let sum = 0, sq = 0, n = 0;
    for (let y = 40; y < 60; y++) {
      for (let x = 40; x < 60; x++) { const v = lum(at(img, x, y)); sum += v; sq += v * v; n++; }
    }
    return sq / n - (sum / n) ** 2;
  };

  const noisy = build();
  const v0 = variance(noisy), s0 = edgeStep(noisy, 4);
  t.gt(v0, 150, 'the fixture really is noisy (precondition)');

  const strong = developImage(build(), { noiseLuminance: 90 });
  t.lt(variance(strong), v0 * 0.4, `at 90 most of the variance is gone (${v0.toFixed(0)} -> ${variance(strong).toFixed(0)})`);
  // The half that a plain blur would fail: an edge 4px away must survive. A wide
  // blur passes the variance test and quietly erodes this by 40%.
  t.gt(edgeStep(strong, 4), s0 * 0.85, `and an edge keeps its step (${s0.toFixed(0)} -> ${edgeStep(strong, 4).toFixed(0)})`);

  const mild = developImage(build(), { noiseLuminance: 25 });
  t.gt(variance(mild), variance(strong), 'a lower amount removes less, so the slider has range');

  // Colour noise: chroma speckle must go without a luminance change.
  const chromaNoisy = () => {
    const img = build();
    let s = 5;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    for (let p = 0; p < W * H; p++) {
      const o = p * 4, n = (rnd() - 0.5) * 60;
      img.data[o] = Math.max(0, Math.min(255, img.data[o] + n));
      img.data[o + 2] = Math.max(0, Math.min(255, img.data[o + 2] - n));
    }
    return img;
  };
  const spread = (img) => {
    let sum = 0, n = 0;
    for (let y = 40; y < 60; y++) for (let x = 40; x < 60; x++) { const [r, , b] = at(img, x, y); sum += Math.abs(r - b); n++; }
    return sum / n;
  };
  const c0 = spread(chromaNoisy());
  const fixed = developImage(chromaNoisy(), { noiseColor: 90 });
  t.lt(spread(fixed), c0 * 0.5, `colour noise reduction removes chroma speckle (${c0.toFixed(1)} -> ${spread(fixed).toFixed(1)})`);
});

suite('camera raw / effects behave as named', async (t) => {
  const base = fixture();
  const corner = (img) => lum(at(img, 2, 2));

  t.lt(corner(dev({ vignette: -90 })), corner(base) - 3, 'a negative vignette darkens the corner');
  t.gt(corner(dev({ vignette: 90 })), corner(base), 'a positive one lightens it');
  t.close(lum(grey(dev({ vignette: -90 }))), lum(grey(base)), 2, 'and the centre is left alone either way');

  const flatVariance = (img) => {
    let sum = 0, sq = 0, n = 0;
    for (let y = 40; y < 60; y++) for (let x = 40; x < 60; x++) { const v = lum(at(img, x, y)); sum += v; sq += v * v; n++; }
    return sq / n - (sum / n) ** 2;
  };
  t.eq(Math.round(flatVariance(base)), 0, 'the flat field starts perfectly flat');
  t.gt(flatVariance(dev({ grain: 90 })), 1, 'grain adds variance to it');
  t.eq(t.mad(dev({ grain: 0, grainSize: 90 }).data, base.data), 0, 'and grain size alone does nothing');

  /*
   * Dehaze, on an image that actually has haze in it — a veil mixed over the
   * fixture. Testing it on the plain fixture was worthless: the assertion was
   * `lt(after, before + 1)`, which passes when Dehaze does nothing at all, and a
   * haze-free image is close to the no-op case anyway. So build the veil, then
   * require the contrast across it to come back.
   */
  const hazed = (() => {
    const img = fixture();
    const veil = 0.55, air = 210;
    for (let i = 0; i < img.data.length; i += 4) {
      for (let c = 0; c < 3; c++) img.data[i + c] = Math.round(img.data[i + c] * (1 - veil) + air * veil);
    }
    return img;
  })();
  const spread = (img) => lum(white(img)) - lum(shadow(img));
  const hazedSpread = spread(hazed);
  const cleared = developImage((() => {
    const c2 = new ImageData(W, H);
    c2.data.set(hazed.data);
    return c2;
  })(), { dehaze: 80 });
  t.lt(hazedSpread, spread(base) - 40, `the hazed fixture really has lost its contrast (${hazedSpread.toFixed(0)} vs ${spread(base).toFixed(0)})`);
  t.gt(spread(cleared), hazedSpread + 15,
    `dehaze restores contrast across the veil (${hazedSpread.toFixed(0)} -> ${spread(cleared).toFixed(0)})`);
  t.lt(lum(shadow(cleared)), lum(shadow(hazed)) - 5, 'by pulling the lifted blacks back down');

  /*
   * Negative dehaze must ADD veil. Two wrong versions to guard against, so the
   * assertions name both:
   *
   *   - reflecting the dehazed value about the input, which overshot past about -40
   *     into crushed blacks and clipped highlights;
   *   - running the forward model with the transmission estimated from the image's
   *     EXISTING haze, which is near 1 wherever the image is dark and clear, so
   *     almost no veil reached the dark regions haze affects most.
   *
   * "Stays in range" was the original assertion here and it cannot fail — the data is
   * a Uint8ClampedArray, so every value is 0..255 by construction, whatever the maths
   * did. It is replaced by measurements that can.
   */
  const veiled = dev({ dehaze: -80 });
  t.lt(spread(veiled), spread(base) - 10,
    `negative dehaze flattens contrast (${spread(base).toFixed(0)} -> ${spread(veiled).toFixed(0)})`);
  /*
   * +80, not +8. The original threshold was set just above "goes up at all", and
   * both wrong versions above go up a little: measured on this fixture they lift
   * the shadow patch from 22 to 31 and 32, which cleared a +8 bar with room to
   * spare. The forward model lifts it to 191. Anything in between separates them;
   * +80 sits far from both.
   */
  t.gt(lum(shadow(veiled)), lum(shadow(base)) + 80,
    `lifting the blacks rather than crushing them (${lum(shadow(base)).toFixed(0)} -> ${lum(shadow(veiled)).toFixed(0)})`);
  t.lt(lum(white(veiled)), lum(white(base)) + 1, 'and pulling the whites down rather than blowing them');

  // Monotone in the amount: -80 must veil more than -30, not overshoot past it.
  const mild = dev({ dehaze: -30 });
  t.lt(spread(veiled), spread(mild), 'more negative dehaze means more veil, not an overshoot');
  t.gt(lum(shadow(veiled)), lum(shadow(mild)), 'and a higher black point');
});

/* ------------------------------------------------------------------ */
/* As a smart filter                                                   */
/* ------------------------------------------------------------------ */

suite('camera raw / is non-destructive on a Smart Object', async (t) => {
  const doc = t.doc(120, 90, '#808080', 'camera-raw-smart');
  const layer = doc.activeLayer();
  const c = ctx2d(layer.canvas);
  c.fillStyle = '#808080';
  c.fillRect(0, 0, 120, 90);
  c.fillStyle = '#c04030';
  c.fillRect(10, 10, 40, 40);
  doc.commit('Paint');
  const original = t.bytes(layer.canvas);

  const smart = convertToSmartObject(doc);
  t.ok(isSmartLayer(smart), 'the layer converts to a Smart Object');
  const id = smart.id;
  const px = (x, y) => {
    const d = ctx2dRead(doc.findLayer(id).canvas).getImageData(x, y, 1, 1).data;
    return [d[0], d[1], d[2]];
  };

  addSmartFilter(doc, doc.findLayer(id), 'camera-raw', {});
  const stack = getSmartFilters(doc.findLayer(id));
  t.eq(stack.length, 1, 'Camera Raw joins the smart filter stack');
  t.eq(stack[0].filterId, 'camera-raw', 'as itself');
  t.eq(t.mad(t.bytes(doc.findLayer(id).canvas), original), 0,
    'and at its defaults it renders the source byte for byte');

  removeSmartFilter(doc, doc.findLayer(id), 0);
  addSmartFilter(doc, doc.findLayer(id), 'camera-raw', { exposure: 1, saturation: 60 });
  t.gt(px(60, 45)[0], 165, 'with settings the render shows them');

  toggleSmartFilter(doc, doc.findLayer(id), 0);
  t.eq(t.mad(t.bytes(doc.findLayer(id).canvas), original), 0, 'disabling it restores the source byte for byte');
  toggleSmartFilter(doc, doc.findLayer(id), 0);
  t.gt(px(60, 45)[0], 165, 're-enabling brings the develop back');

  // Two +1 EV filters must equal one +2 EV filter: each render restarts from the
  // source, so nothing compounds through a resample.
  addSmartFilter(doc, doc.findLayer(id), 'camera-raw', { exposure: 1 });
  const stacked = px(60, 45)[0];
  removeSmartFilter(doc, doc.findLayer(id), 1);
  removeSmartFilter(doc, doc.findLayer(id), 0);
  addSmartFilter(doc, doc.findLayer(id), 'camera-raw', { exposure: 2 });
  t.close(stacked, px(60, 45)[0], 2, `two +1 EV filters land where one +2 EV does (${stacked} vs ${px(60, 45)[0]})`);

  removeSmartFilter(doc, doc.findLayer(id), 0);
  t.eq(t.mad(t.bytes(doc.findLayer(id).canvas), original), 0, 'and the source survives all of it intact');
});

/* ------------------------------------------------------------------ */
/* the shapes the tone chain must have                                 */
/* ------------------------------------------------------------------ */

/** Develop a flat patch of one colour and read the result back. */
function flat(rgb, params) {
  const img = new ImageData(8, 8);
  for (let i = 0; i < 64; i += 1) {
    img.data[i * 4] = rgb[0];
    img.data[i * 4 + 1] = rgb[1];
    img.data[i * 4 + 2] = rgb[2];
    img.data[i * 4 + 3] = 255;
  }
  const out = developImage(img, params);
  return [out.data[80], out.data[81], out.data[82]];
}

/** Develop a 0..255 grey ramp and return the red channel. */
function rampOf(params) {
  const img = new ImageData(256, 1);
  for (let x = 0; x < 256; x += 1) {
    img.data[x * 4] = x; img.data[x * 4 + 1] = x; img.data[x * 4 + 2] = x; img.data[x * 4 + 3] = 255;
  }
  const out = developImage(img, params);
  return Array.from({ length: 256 }, (_, x) => out.data[x * 4]);
}

suite('camera raw / negative dehaze veils towards the light, not the dark', async (t) => {
  /*
   * Haze is bright: it is scattered daylight, so adding it washes a picture out.
   * The airlight estimate has to come from the image at the haziest pixels, not
   * from the dark channel's own value — the dark channel of a saturated subject
   * is zero everywhere, so reading the value back gave a near-black airlight and
   * negative Dehaze *darkened* saturated pictures. Measured before the fix: pure
   * red at -100 went to (144,55,55).
   */
  const red = flat([255, 0, 0], { dehaze: -100 });
  t.gt(red[1], 150, 'veiling pure red raises its green channel towards the light');
  t.gt(red[2], 150, 'and its blue channel with it');
  t.eq(red[0], 255, 'while the red channel stays up');

  const blue = flat([0, 128, 255], { dehaze: -100 });
  t.gt(blue[0], 150, 'veiling a saturated blue lifts its red channel too');
  t.ok(blue[2] >= blue[1] && blue[1] >= blue[0], 'and the hue order survives the veil');

  // The direction has to hold with amount, not just at the extreme.
  const mild = flat([255, 0, 0], { dehaze: -40 });
  t.gt(mild[1], 0, 'a mild veil already lifts the dark channels');
  t.lt(mild[1], red[1], 'and a stronger one lifts them further');

  // Removing haze must still be the other direction.
  t.eq(flat([255, 0, 0], { dehaze: 0 }).join(), '255,0,0', 'dehaze 0 is the identity');
});

suite('camera raw / the tone curve has no kink at mid grey', async (t) => {
  /*
   * The Shadows and Highlights curves each own half the range, which is what
   * keeps them from moving tones they do not name. Swapping between them AT the
   * midpoint left the slope jumping by up to 9.2x, and a slope discontinuity is
   * what the eye reads as a Mach band — at Shadows +100 / Highlights +100 the
   * ramp went 126,127,128 -> 128,128,128 and then climbed away in 3s.
   */
  const r = rampOf({ shadows: 100, highlights: 100 });
  const slopeL = (r[128] - r[124]) / 4;
  const slopeR = (r[132] - r[128]) / 4;
  t.gt(slopeL, 0, 'the curve is still rising just below mid grey');
  t.lt(slopeR / slopeL, 3, `the slope across mid grey is continuous enough (ratio ${(slopeR / slopeL).toFixed(2)})`);

  // No plateau: three inputs must not collapse onto one output.
  let plateau = 0;
  for (let i = 120; i < 140; i += 1) if (r[i] === r[i - 1]) plateau += 1;
  t.lt(plateau, 3, `no flat spot around mid grey (${plateau} repeated levels in 120..140)`);

  // Monotone for every combination, which is the property the halves buy.
  for (const [s, h] of [[100, 100], [-100, -100], [100, -100], [-100, 100], [60, 20]]) {
    const ramp = rampOf({ shadows: s, highlights: h });
    let ok = true;
    for (let i = 1; i < 256; i += 1) if (ramp[i] < ramp[i - 1]) ok = false;
    t.ok(ok, `shadows ${s} with highlights ${h} stays monotone`);
  }

  // And the confinement the halves exist for is still there.
  const base = rampOf({});
  const hi = rampOf({ highlights: -80 });
  t.close(hi[22], base[22], 2, 'Highlights -80 leaves a deep shadow where it was');
});

suite('camera raw / lifting near-black keeps its colour', async (t) => {
  /*
   * Moving a pixel's luminance by scaling its channels keeps the hue, but the
   * ratio is meaningless at pure black, so lifting black has to write a value
   * instead. Choosing between the two on a hard threshold was visible: a dark
   * blue just under it was rewritten as neutral grey. Before the fix, Shadows
   * +100 at Exposure -3 took (0,0,1..3) to (11,11,11), (19,19,19), (21,21,21)
   * and then (0,0,4) to (0,0,94) — grey, grey, grey, then blue.
   */
  const img = new ImageData(10, 1);
  for (let x = 0; x < 10; x += 1) {
    img.data[x * 4] = 0; img.data[x * 4 + 1] = 0; img.data[x * 4 + 2] = x; img.data[x * 4 + 3] = 255;
  }
  const out = developImage(img, { exposure: -3, shadows: 100 });
  const px = (x) => [out.data[x * 4], out.data[x * 4 + 1], out.data[x * 4 + 2]];

  for (let x = 1; x < 10; x += 1) {
    const [r, g, b] = px(x);
    t.gt(b, r, `input (0,0,${x}) stays blue rather than turning grey`);
    t.eq(r, g, `and stays neutral in the channels it started neutral in (x=${x})`);
  }

  // The blue channel has to climb steadily — the old hard switch put a cliff in it.
  let rising = true;
  for (let x = 2; x < 10; x += 1) if (px(x)[2] < px(x - 1)[2]) rising = false;
  t.ok(rising, 'the blue channel rises monotonically through the lift');
  t.eq(px(0).join(), '0,0,0', 'and true black stays black');
});
