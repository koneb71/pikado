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

  // Dehaze removes a veil, so it must deepen the dark end rather than lift it.
  t.lt(lum(shadow(dev({ dehaze: 70 }))), lum(shadow(base)) + 1, 'dehaze deepens the dark end');
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
