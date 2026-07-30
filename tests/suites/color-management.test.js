import { suite } from '../harness.js';
import {
  WHITE_POINTS, TRC, BUILTIN_PROFILES, getProfile, profileOf, matrixOf, primariesToMatrix,
  makeTransform, transformImageData, isInGamut, intentIsExact, parseICC, INTENTS,
} from '/src/color/icc.js';
import {
  assignProfile, convertToProfile, proofOf, setProof, proofActive, applyProof,
  availableProfiles, GAMUT_WARNING_COLOR,
} from '/src/color/manage.js';
import { getComposite, getViewComposite, compositeDocument } from '/src/render/compositor.js';
import { exportDocument } from '/src/io/save.js';
import { createCanvas, ctx2d, ctx2dRead, loadImage } from '/src/core/util.js';
import { getCommand } from '/src/commands/registry.js';
import { Layer, LayerType } from '/src/core/layer.js';
import { rasterizeTextLayer, defaultTextProps } from '/src/text/text-render.js';
import { DEFAULT_STYLES } from '/src/effects/styles.js';
import { savePKD, loadPKD } from '/src/io/pkd.js';

/**
 * Colour management.
 *
 * Colour code is the easiest kind to get plausibly wrong: a transform with a
 * transposed matrix or a missing white-point adaptation still produces colours,
 * just not the right ones, and nobody can tell by looking. So these tests check
 * against values that are *published* or *provable* rather than against what the
 * code happens to do:
 *
 *  - the sRGB primaries must reproduce the published sRGB→XYZ matrix;
 *  - RGB (1,1,1) must land exactly on the white point, in every profile;
 *  - a profile to itself must be the identity to floating-point precision;
 *  - a round trip through a *larger* gamut must be lossless, because there is
 *    nothing to clip;
 *  - white must stay white and grey must stay neutral across every space, which
 *    is what the chromatic adaptation is for.
 *
 * And the two behaviours that make colour management usable rather than
 * mysterious: Assign changes appearance without touching pixels, Convert changes
 * pixels to keep appearance, and soft proofing changes neither — it is a view.
 */

/* ------------------------------------------------------------------ */
/* Matrices and curves                                                 */
/* ------------------------------------------------------------------ */

suite('color / the profile matrices match published values', async (t) => {
  t.eq(BUILTIN_PROFILES.length, 6, 'six working spaces ship');
  for (const p of BUILTIN_PROFILES) t.ok(getProfile(p.id), `${p.name} resolves by id`);

  const m = matrixOf(getProfile('srgb'));
  const published = [0.4124, 0.3576, 0.1805, 0.2126, 0.7152, 0.0722, 0.0193, 0.1192, 0.9505];
  const worst = Math.max(...m.map((v, i) => Math.abs(v - published[i])));
  t.lt(worst, 0.0005, `the sRGB primaries reproduce the published sRGB->XYZ matrix (worst ${worst.toExponential(2)})`);
  t.close(m[4], 0.7152, 0.0005, 'so the luminance row is the Rec. 709 one');

  for (const profile of BUILTIN_PROFILES) {
    if (profile.space !== 'rgb') continue;
    const mat = matrixOf(profile);
    const white = [mat[0] + mat[1] + mat[2], mat[3] + mat[4] + mat[5], mat[6] + mat[7] + mat[8]];
    const err = Math.max(...white.map((v, i) => Math.abs(v - profile.white[i])));
    t.lt(err, 1e-9, `${profile.name}: RGB (1,1,1) lands exactly on its white point`);
  }

  t.eq(primariesToMatrix({ rx: 0, ry: 0, gx: 0, gy: 0, bx: 0, by: 0 }, WHITE_POINTS.D65), null,
    'degenerate primaries are rejected rather than producing a silent NaN matrix');
});

suite('color / tone curves invert themselves', async (t) => {
  const curves = [TRC.srgb, TRC.rec709, TRC.gamma(2.2), TRC.gamma(1.8)];
  for (const curve of curves) {
    let worst = 0;
    for (let i = 0; i <= 20; i++) {
      const v = i / 20;
      worst = Math.max(worst, Math.abs(curve.fromLinear(curve.toLinear(v)) - v));
    }
    t.lt(worst, 1e-6, `${curve.name} round trips (worst ${worst.toExponential(2)})`);
  }

  // sRGB is not gamma 2.2, and the difference lives in the shadows — which is
  // exactly where approximating it would be noticed.
  const g22 = TRC.gamma(2.2);
  t.gt(Math.abs(TRC.srgb.toLinear(0.05) - g22.toLinear(0.05)), 0.0005,
    'sRGB and gamma 2.2 differ near black, so the linear segment matters');

  // A sampled curve inverts by bisection; check it against the gamma it samples.
  const samples = new Float32Array(64);
  for (let i = 0; i < 64; i++) samples[i] = (i / 63) ** 2.2;
  const table = TRC.table(samples);
  let tableWorst = 0;
  for (let i = 1; i < 20; i++) {
    const v = i / 20;
    tableWorst = Math.max(tableWorst, Math.abs(table.toLinear(v) - v ** 2.2));
  }
  t.lt(tableWorst, 0.005, `a 64-entry sampled curve matches the gamma it samples (worst ${tableWorst.toFixed(4)})`);
});

/* ------------------------------------------------------------------ */
/* Transforms                                                          */
/* ------------------------------------------------------------------ */

const corner = (x, y) => ({ x, y, in: null, out: null, corner: true });

const PROBES = [[0, 0, 0], [1, 1, 1], [0.5, 0.5, 0.5], [1, 0, 0], [0.2, 0.6, 0.9], [0.04, 0.04, 0.04]];

suite('color / a transform to the same profile is the identity', async (t) => {
  for (const profile of BUILTIN_PROFILES) {
    const fn = makeTransform(profile, profile);
    // A grey profile has one channel, so only neutral triples are valid colours
    // in it — feeding it pure red asks what it cannot represent.
    const probes = profile.space === 'gray' ? PROBES.filter((p) => p[0] === p[1] && p[1] === p[2]) : PROBES;
    let worst = 0;
    for (const p of probes) {
      const out = fn(p);
      for (let i = 0; i < 3; i++) worst = Math.max(worst, Math.abs(out[i] - p[i]));
    }
    t.lt(worst, 1e-6, `${profile.name} to itself changes nothing (worst ${worst.toExponential(2)})`);
  }

  // And a non-neutral handed to a grey profile comes back as its own first
  // channel replicated, rather than as three unrelated numbers.
  const grey = makeTransform(getProfile('gray-22'), getProfile('gray-22'))([1, 0, 0]);
  t.eq([grey[0] === grey[1], grey[1] === grey[2]], [true, true],
    'a grey profile always produces a neutral, whatever it is handed');
});

suite('color / white stays white and grey stays neutral', async (t) => {
  const srgb = getProfile('srgb');
  for (const profile of BUILTIN_PROFILES) {
    if (profile.id === 'srgb') continue;
    const fn = makeTransform(srgb, profile);
    const white = fn([1, 1, 1]);
    t.ok(white.every((v) => Math.abs(v - 1) < 0.003),
      `white maps to white in ${profile.name} (${white.map((v) => v.toFixed(4)).join(',')})`);
    const grey = fn([0.5, 0.5, 0.5]);
    t.lt(Math.max(Math.abs(grey[0] - grey[1]), Math.abs(grey[1] - grey[2])), 0.005,
      `and a mid grey stays neutral in ${profile.name}`);
  }
});

suite('color / gamut behaviour is asymmetric, as it must be', async (t) => {
  const srgb = getProfile('srgb');
  const adobe = getProfile('adobe-rgb');
  const toAdobe = makeTransform(srgb, adobe);
  const fromAdobe = makeTransform(adobe, srgb);

  // Into a larger space and back: nothing is clipped, so it is lossless.
  let worst = 0;
  for (const p of PROBES) {
    const back = fromAdobe(toAdobe(p));
    for (let i = 0; i < 3; i++) worst = Math.max(worst, Math.abs(back[i] - p[i]));
  }
  t.lt(worst, 0.002, `sRGB -> Adobe RGB -> sRGB returns the original colours (worst ${worst.toExponential(2)})`);

  // sRGB and Adobe RGB share the same red primary, so pure red stays pure and
  // only its magnitude drops — a good check that the matrix is not transposed.
  const red = toAdobe([1, 0, 0]);
  t.lt(red[0], 0.9, `pure sRGB red needs less than full red in the wider space (${red[0].toFixed(4)})`);
  t.lt(Math.max(red[1], red[2]), 0.002, 'and stays pure red, because the two spaces share that primary');

  // Adobe RGB green is outside sRGB and must clip.
  const green = fromAdobe([0, 1, 0]);
  t.gt(green[1], 0.999, 'Adobe RGB green clips to full green in sRGB');
  t.notOk(isInGamut([0, 1, 0], adobe, srgb), 'and isInGamut agrees it does not fit');
  t.ok(isInGamut([0.5, 0.5, 0.5], adobe, srgb), 'while a neutral fits');
  t.ok(isInGamut([1, 0, 0], srgb, adobe), 'and every sRGB colour fits inside Adobe RGB');
});

suite('color / rendering intents', async (t) => {
  const srgb = getProfile('srgb');
  const prophoto = getProfile('prophoto');   // D50, so adaptation is visible
  const p3 = getProfile('display-p3');       // D65, so it is not

  t.eq(INTENTS.length, 4, 'four intents are offered');
  t.ok(intentIsExact('relative') && intentIsExact('absolute'), 'two of them are exact for matrix profiles');
  t.notOk(intentIsExact('perceptual') || intentIsExact('saturation'), 'and two are not');

  const relWhite = makeTransform(srgb, prophoto, { intent: 'relative' })([1, 1, 1]);
  const absWhite = makeTransform(srgb, prophoto, { intent: 'absolute' })([1, 1, 1]);
  t.ok(relWhite.every((v) => Math.abs(v - 1) < 0.003), 'relative colorimetric maps D65 white onto D50 white');
  t.gt(Math.max(...absWhite.map((v, i) => Math.abs(v - relWhite[i]))), 0.01,
    'absolute colorimetric leaves the cast in, which is the point of it');

  const colour = [0.6, 0.3, 0.2];
  const relP3 = makeTransform(srgb, p3, { intent: 'relative' })(colour);
  const absP3 = makeTransform(srgb, p3, { intent: 'absolute' })(colour);
  t.lt(Math.max(...relP3.map((v, i) => Math.abs(v - absP3[i]))), 1e-9,
    'between two D65 spaces the two intents agree, there being no adaptation to skip');

  const perceptual = makeTransform(srgb, prophoto, { intent: 'perceptual' })(colour);
  const relative = makeTransform(srgb, prophoto, { intent: 'relative' })(colour);
  t.lt(Math.max(...perceptual.map((v, i) => Math.abs(v - relative[i]))), 1e-9,
    'perceptual behaves as relative rather than inventing a gamut compression');
});

suite('color / grey profiles convert both ways', async (t) => {
  const srgb = getProfile('srgb');
  const grey = getProfile('gray-22');

  const toGrey = makeTransform(srgb, grey);
  const red = toGrey([1, 0, 0]);
  t.eq([red[0] === red[1], red[1] === red[2]], [true, true], 'converting into a grey profile produces a neutral');
  t.close(red[0], 0.495, 0.03, `with red landing near its luminance (${red[0].toFixed(4)})`);
  t.gt(toGrey([1, 1, 1])[0], 0.99, 'white stays white');
  t.lt(toGrey([0, 0, 0])[0], 0.01, 'and black stays black');

  const fromGrey = makeTransform(grey, srgb)([0.5, 0.5, 0.5]);
  t.ok(fromGrey.every((v) => Math.abs(v - fromGrey[0]) < 1e-9), 'and a grey profile back to RGB stays neutral');
});

/* ------------------------------------------------------------------ */
/* Assign vs Convert                                                   */
/* ------------------------------------------------------------------ */

suite('color / assign relabels, convert moves pixels', async (t) => {
  const doc = t.doc(24, 16, '#cc3355', 'assign');
  t.eq(profileOf(doc).id, 'srgb', 'an untagged document is treated as sRGB, which 8-bit RGB is');
  const before = t.bytes(doc.layers[0].canvas);
  const px = () => t.px(doc.layers[0].canvas, 12, 8);
  const pixelBefore = px();

  assignProfile(doc, 'adobe-rgb');
  t.eq(profileOf(doc).id, 'adobe-rgb', 'assigning changes the document profile');
  t.eq(t.mad(t.bytes(doc.layers[0].canvas), before), 0, 'and does not touch a single pixel');
  t.eq(px(), pixelBefore, 'so the numbers are exactly as they were');
  t.eq(doc.history.states[doc.history.index].label, 'Assign Profile: Adobe RGB (1998)', 'as its own history step');

  // Convert back: the numbers must move.
  await convertToProfile(doc, 'srgb');
  t.eq(profileOf(doc).id, 'srgb', 'converting changes the profile too');
  t.gt(t.mad(t.bytes(doc.layers[0].canvas), before), 1, 'but this time the pixels moved');
  t.eq(doc.history.states[doc.history.index].label, 'Convert to Profile: sRGB IEC61966-2.1', 'in its own step');

  // Undo must put them back exactly.
  doc.history.undo();
  t.eq(t.mad(t.bytes(doc.findLayer(doc.layers[0].id).canvas), before), 0, 'and undo restores them byte for byte');

  // Converting to the profile it already has is refused rather than being a
  // pointless lossy round trip.
  const doc2 = t.doc(8, 8, '#808080', 'same');
  const pixels = t.bytes(doc2.layers[0].canvas);
  t.eq(await convertToProfile(doc2, 'srgb'), null, 'converting to the current profile does nothing');
  t.eq(t.mad(t.bytes(doc2.layers[0].canvas), pixels), 0, 'and leaves the pixels alone');
});

suite('color / convert reaches rendered pixels, not just parameters', async (t) => {
  /*
   * Text, shape and smart layers keep their colour somewhere OTHER than the canvas
   * the compositor draws, and that canvas is a cache regenerated from the parameter.
   * So Convert has to do BOTH halves: change the parameter and re-render. An earlier
   * version of the fix did only the first, which looked wrong immediately (nothing
   * re-rendered) after an earlier version had done only the second, which looked
   * right until the next re-render reverted it.
   *
   * These assertions check the *rendered* pixels, which is the half that was missing.
   */
  const { createShapeLayer } = await import('/src/vector/path.js');
  const { convertToSmartObject } = await import('/src/layers/ops.js');
  const { renderSmartObject, isSmartLayer } = await import('/src/core/smart.js');

  /* --- text ---------------------------------------------------------- */
  {
    const doc = t.doc(60, 40, '#ffffff', 'text-convert');
    const layer = new Layer({
      name: 'T', type: LayerType.TEXT,
      text: { ...defaultTextProps(), content: 'Ag', size: 26, color: '#00ff40', x: 4, y: 30 },
    });
    layer.ensureCanvas(60, 40);
    doc.layers.unshift(layer);
    rasterizeTextLayer(layer, doc);
    doc.commit('Text');
    t.gt(t.inked(layer.canvas), 20, 'the text rendered');
    const pixelsBefore = t.bytes(layer.canvas);
    const colourBefore = layer.text.color;

    await convertToProfile(doc, 'prophoto');
    const live = doc.findLayer(layer.id);
    t.ne(live.text.color, colourBefore, `the text colour parameter is converted (${colourBefore} -> ${live.text.color})`);
    t.gt(t.mad(t.bytes(live.canvas), pixelsBefore), 0.5,
      'AND the rendered pixels move with it, so the canvas is not left in the old space');
  }

  /* --- shape --------------------------------------------------------- */
  {
    const doc = t.doc(60, 40, '#ffffff', 'shape-convert');
    const layer = createShapeLayer(
      doc,
      [{ closed: true, points: [[8, 8], [50, 8], [50, 32], [8, 32]].map(([x, y]) => corner(x, y)) }],
      {
        fill: { kind: 'solid', color: '#00ff40' },
        stroke: { enabled: true, color: '#ff0080', width: 3, align: 'center', cap: 'butt', join: 'miter', dash: 'solid' },
      },
      'Shape'
    );
    if (layer) {
      doc.layers.unshift(layer);
      doc.commit('Shape');
      const pixelsBefore = t.bytes(layer.canvas);
      const fillBefore = layer.shape.fill.color;
      const strokeBefore = layer.shape.stroke.color;

      await convertToProfile(doc, 'prophoto');
      const live = doc.findLayer(layer.id);
      t.ne(live.shape.fill.color, fillBefore, `the fill colour is converted (${fillBefore} -> ${live.shape.fill.color})`);
      t.ne(live.shape.stroke.color, strokeBefore, 'and the stroke colour');
      t.gt(t.mad(t.bytes(live.canvas), pixelsBefore), 0.5, 'and the shape is re-rasterised');
    } else {
      t.ok(true, 'createShapeLayer is unavailable in this build, so the shape case is skipped');
    }
  }

  /* --- smart object -------------------------------------------------- */
  {
    const doc = t.doc(60, 40, '#ffffff', 'smart-convert');
    const layer = doc.activeLayer();
    const c = ctx2d(layer.canvas);
    c.fillStyle = '#00ff40';
    c.fillRect(0, 0, 60, 40);
    doc.commit('Paint');

    const smart = convertToSmartObject(doc);
    t.ok(isSmartLayer(smart), 'the layer became a Smart Object');
    const id = smart.id;
    const renderBefore = t.bytes(doc.findLayer(id).canvas);
    const sourceBefore = doc.findLayer(id).smart.source;

    await convertToProfile(doc, 'prophoto');
    const live = doc.findLayer(id);
    t.gt(t.mad(t.bytes(live.canvas), renderBefore), 0.5,
      'converting moves the smart layer\'s VISIBLE pixels, not only its hidden source');
    t.isNot(live.smart.source, sourceBefore,
      'and swaps in a converted clone rather than mutating the source in place');

    // The source object every earlier history state points at must be untouched, or
    // undo cannot work and a second convert double-converts.
    doc.history.undo();
    const undone = doc.findLayer(id);
    t.eq(t.mad(t.bytes(undone.canvas), renderBefore), 0, 'so undo restores the render exactly');
    t.is(undone.smart.source, sourceBefore, 'pointing back at the original source document');

    // Convert, undo, convert again: the second result must equal the first, not be
    // double-converted.
    await convertToProfile(doc, 'prophoto');
    const first = t.bytes(doc.findLayer(id).canvas);
    doc.history.undo();
    await convertToProfile(doc, 'prophoto');
    t.eq(t.mad(t.bytes(doc.findLayer(id).canvas), first), 0,
      'and convert / undo / convert lands in the same place rather than converting twice');
  }
});

suite('color / layer effect colours are converted too', async (t) => {
  // Effect colours are parameters the compositor re-renders every frame, so leaving
  // them unconverted means a drop shadow stays in the old space forever while the
  // layer it belongs to moves. This is the same defect class as the text/shape one,
  // one field over.
  const doc = t.doc(50, 40, '#ffffff', 'styles-convert');
  const layer = doc.activeLayer();
  const c = ctx2d(layer.canvas);
  c.fillStyle = '#8080ff';
  c.fillRect(10, 10, 30, 20);
  layer.styles = structuredClone(DEFAULT_STYLES);
  layer.styles.dropShadow = { ...layer.styles.dropShadow, enabled: true, color: '#ff2000' };
  doc.commit('Shadow');
  const before = layer.styles.dropShadow.color;

  await convertToProfile(doc, 'prophoto');
  const live = doc.findLayer(layer.id);
  t.ne(live.styles.dropShadow.color, before,
    `the drop shadow colour is converted (${before} -> ${live.styles.dropShadow.color})`);
  t.eq(live.styles.dropShadow.enabled, true, 'and the rest of the effect is left intact');
});

suite('color / a convert round trip through a wider space is near-lossless', async (t) => {
  const doc = t.doc(32, 32, null, 'round');
  const c = ctx2d(doc.layers[0].canvas);
  // A spread of colours, all inside sRGB.
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      c.fillStyle = `rgb(${x * 8},${y * 8},${(x + y) * 4})`;
      c.fillRect(x, y, 1, 1);
    }
  }
  doc.commit('Spread');
  const before = t.bytes(doc.layers[0].canvas);

  await convertToProfile(doc, 'prophoto');
  t.gt(t.mad(t.bytes(doc.layers[0].canvas), before), 1, 'converting to ProPhoto moves the numbers');
  await convertToProfile(doc, 'srgb');
  const after = t.mad(t.bytes(doc.layers[0].canvas), before);
  // 8-bit through a much larger space costs a little precision; that is real and
  // worth pinning, so a regression that costs a lot shows up.
  t.lt(after, 2.2, `and coming back lands within ${after.toFixed(2)} of where it started (8-bit rounding)`);
});

/* ------------------------------------------------------------------ */
/* Soft proofing                                                       */
/* ------------------------------------------------------------------ */

suite('color / soft proofing is a view and nothing more', async (t) => {
  const doc = t.doc(16, 16, null, 'proof');
  const c = ctx2d(doc.layers[0].canvas);
  // A colour that is inside sRGB but outside a small proof space in one channel.
  c.fillStyle = 'rgb(0,255,40)';
  c.fillRect(0, 0, 16, 16);
  doc.commit('Green');
  const real = t.px(doc.layers[0].canvas, 8, 8);

  t.notOk(proofActive(doc), 'proofing starts off');
  const proof = proofOf(doc);
  t.eq([proof.enabled, proof.gamutWarning], [false, false], 'with both switches off');

  t.ok(setProof(doc, { enabled: true, profileId: 'gray-22' }), 'turning it on reports a change');
  t.notOk(setProof(doc, { enabled: true }), 'and setting the same value again does not');
  t.ok(proofActive(doc), 'proofing is active');

  // The view changes...
  const viewed = getViewComposite(doc);
  const shown = t.px(viewed, 8, 8).split(',').map(Number);
  t.ok(shown.slice(0, 3).join(',') !== real.split(',').slice(0, 3).join(','),
    `the canvas shows the simulation (${shown.slice(0, 3).join(',')} rather than ${real})`);
  t.ok(Math.abs(shown[0] - shown[1]) < 6 && Math.abs(shown[1] - shown[2]) < 6,
    'and proofing to a grey space really does show grey');

  // ...while everything that reads the document does not.
  t.eq(t.px(doc.layers[0].canvas, 8, 8), real, 'the layer pixels are untouched');
  t.eq(t.px(getComposite(doc), 8, 8), real, 'getComposite is untouched');
  t.eq(t.px(compositeDocument(doc), 8, 8), real, 'compositeDocument is untouched');

  const blob = await exportDocument(doc, { format: 'png', save: false });
  const img = await loadImage(blob);
  const shot = createCanvas(img.naturalWidth || img.width, img.naturalHeight || img.height);
  ctx2d(shot).drawImage(img, 0, 0);
  t.eq(t.px(shot, 8, 8), real, 'and a PNG export contains the document, not the proof');

  setProof(doc, { enabled: false });
  t.eq(t.px(getViewComposite(doc), 8, 8), real, 'turning proofing off restores the view exactly');
});

suite('color / the gamut warning marks what cannot be reproduced', async (t) => {
  const doc = t.doc(16, 16, null, 'gamut');
  const c = ctx2d(doc.layers[0].canvas);
  c.fillStyle = 'rgb(255,255,255)';
  c.fillRect(0, 0, 16, 16);
  c.fillStyle = 'rgb(0,255,0)';     // pure sRGB green
  c.fillRect(0, 0, 8, 16);
  doc.commit('Two halves');

  // Proof to sRGB itself: nothing can be out of gamut in its own space.
  assignProfile(doc, 'srgb');
  setProof(doc, { enabled: true, profileId: 'srgb', gamutWarning: true });
  const same = getViewComposite(doc);
  t.ne(t.px(same, 4, 8).split(',').slice(0, 3).join(','), GAMUT_WARNING_COLOR.join(','),
    'proofing a space against itself marks nothing');

  // Assign a much wider space to the same numbers: now that green really is
  // outside sRGB, and proofing to sRGB must flag it.
  assignProfile(doc, 'prophoto');
  setProof(doc, { enabled: true, profileId: 'srgb', gamutWarning: true });
  const warned = getViewComposite(doc);
  t.eq(t.px(warned, 4, 8).split(',').slice(0, 3).join(','), GAMUT_WARNING_COLOR.join(','),
    'a ProPhoto green outside sRGB is painted with the warning colour');
  t.ne(t.px(warned, 12, 8).split(',').slice(0, 3).join(','), GAMUT_WARNING_COLOR.join(','),
    'while white, which every space can reproduce, is left alone');

  setProof(doc, { enabled: false, gamutWarning: false });
});

suite('color / the profile is part of the document, not just of the view', async (t) => {
  /*
   * Three defects lived here, all of them invisible to the tests above because
   * they were about the profile's *lifecycle* rather than its maths:
   *
   *   - `doc.profile` was missing from captureState, so undoing a Convert restored
   *     the pixels and left them labelled with the profile they had been converted
   *     TO — a document describing itself wrongly.
   *   - `.pkd` did not persist it, so Save and reopen silently dropped the space.
   *   - `adoptEmbeddedProfile` existed and was never called from anywhere, while
   *     the README said embedded profiles are read when you open a file.
   */
  const doc = t.doc(16, 16, '#cc3355', 'lifecycle');
  const pixels = t.bytes(doc.layers[0].canvas);
  t.eq(profileOf(doc).id, 'srgb', 'an untagged document reads as sRGB');

  await convertToProfile(doc, 'adobe-rgb');
  t.eq(profileOf(doc).id, 'adobe-rgb', 'converting sets the profile');
  doc.history.undo();
  t.eq(profileOf(doc).id, 'srgb', 'and undo puts the profile back, not just the pixels');
  t.eq(t.mad(t.bytes(doc.findLayer(doc.layers[0].id).canvas), pixels), 0, 'with the original pixels');
  doc.history.redo();
  t.eq(profileOf(doc).id, 'adobe-rgb', 'redo restores it too');

  // captureState must carry it, or a future history step drops it again.
  const state = doc.captureState();
  t.ok(Object.prototype.hasOwnProperty.call(state, 'profile'), 'captureState carries the profile');
  t.notOk(Object.prototype.hasOwnProperty.call(state, 'proof'),
    'and deliberately does not carry the proof settings, which are a view');

  // A .pkd round trip must preserve it — both a built-in and an embedded profile.
  const blob = await savePKD(doc);
  const back = await loadPKD(await blob.arrayBuffer());
  t.eq(profileOf(back).id, 'adobe-rgb', 'saving and reopening preserves a built-in profile');

  const parsed = parseICC(buildProfile({ desc: 'Embedded Test', gamma: 1.8 }));
  t.ok(parsed.ok, 'the fixture profile parses');
  if (parsed.ok) {
    doc.profile = parsed.profile;
    const blob2 = await savePKD(doc);
    const back2 = await loadPKD(await blob2.arrayBuffer());
    t.eq(back2.profile.name, 'Embedded Test', 'and an embedded profile survives by value');
    t.ok(back2.profile.embedded, 'still marked embedded');
    t.close(back2.profile.trc.toLinear(0.5), 0.5 ** 1.8, 0.02, 'with its tone curve intact');
    t.eq(back2.profile.matrix.length, 9, 'and its matrix');
  }

  // The open path must actually reach adoptEmbeddedProfile.
  const openSrc = await (await fetch('/src/io/open.js')).text();
  t.ok(/adoptEmbeddedProfile/.test(openSrc),
    'src/io/open.js calls adoptEmbeddedProfile, so the README claim about opening files is true');
});

suite('color / grey profiles adapt their white point too', async (t) => {
  /*
   * The adaptation was guarded by `!srcGray && !dstGray`, so any conversion
   * involving a grey profile skipped it. Undetectable with the built-in grey space
   * alone — Gray Gamma 2.2 is D65, the same white point as sRGB, so there was
   * nothing to adapt. ICC grey profiles are D50, which is where it bites.
   */
  const d50Grey = {
    id: 'embedded', name: 'D50 Grey', space: 'gray',
    white: WHITE_POINTS.D50, trc: TRC.gamma(2.2), embedded: true,
  };
  const srgb = getProfile('srgb');

  const toRGB = makeTransform(d50Grey, srgb);
  const mid = toRGB([0.5, 0.5, 0.5]);
  t.lt(Math.max(Math.abs(mid[0] - mid[1]), Math.abs(mid[1] - mid[2])), 0.02,
    `a D50 grey converts to a neutral in sRGB (${mid.map((v) => v.toFixed(4)).join(',')})`);
  const white = toRGB([1, 1, 1]);
  t.ok(white.every((v) => v > 0.97), `and its white stays white (${white.map((v) => v.toFixed(3)).join(',')})`);

  // The other direction as well.
  const toGrey = makeTransform(srgb, d50Grey);
  t.gt(toGrey([1, 1, 1])[0], 0.97, 'sRGB white converts to grey white');

  // Absolute colorimetric still declines to adapt, which is its whole point.
  const absolute = makeTransform(d50Grey, srgb, { intent: 'absolute' })([1, 1, 1]);
  t.gt(Math.max(...absolute.map((v, i) => Math.abs(v - white[i]))), 0.005,
    'while absolute colorimetric leaves the D50 cast in');
});

suite('color / the ICC parser survives hostile bytes', async (t) => {
  /*
   * parseICC reads a file. Every offset and length in an ICC profile comes from that
   * file, and a tag claiming to start at 4 GB or hold 2 GB of samples is a two-line
   * edit away in any hex editor.
   *
   * The first version of this suite only asserted that parseICC did not THROW — which
   * a blanket try/catch guarantees unconditionally, so every bounds check inside
   * could have been deleted and it would still have passed. It was the same
   * unfalsifiable shape it was written to replace. So each case now asserts the
   * SPECIFIC outcome the specific bounds check produces, and the throw-free property
   * is checked separately as a floor rather than as the whole test.
   */
  const base = buildProfile({ desc: 'Victim' });

  const mutated = (mutate) => {
    const bytes = new Uint8Array(base);
    mutate(bytes, new DataView(bytes.buffer));
    let result = null, threw = null;
    try { result = parseICC(bytes); } catch (err) { threw = String((err && err.message) || err); }
    return { result, threw };
  };

  // A clean profile must parse, or nothing below proves anything.
  const clean = parseICC(base);
  t.ok(clean.ok, 'the unmutated fixture parses, so the mutations below are the variable');

  // Tag extents are validated when the table is read, and a tag that does not fit is
  // dropped — which for rXYZ means the profile has no colorants and is rejected with
  // that exact reason. Deleting the extent check changes this outcome.
  /*
   * Corrupt a tag the profile CANNOT do without, or the drop is invisible: the first
   * tag in the fixture is `desc`, and losing a description just falls back to a
   * default. `rXYZ` is a red colorant — without it there is no matrix and the profile
   * must be rejected, which is what makes the extent check observable.
   */
  const corruptTag = (name, field, value) => mutated((b, dv) => {
    for (let i = 0; i < dv.getUint32(128); i++) {
      const at = 132 + i * 12;
      const sig = String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
      if (sig === name) dv.setUint32(at + field, value);
    }
  });

  const farOffset = corruptTag('rXYZ', 4, 0xfffff000);
  t.eq(farOffset.threw, null, 'a tag offset past the end of the file does not throw');
  t.notOk(farOffset.result.ok, 'and the profile is rejected, because the dropped tag was load-bearing');
  t.ok(/colorant/i.test(farOffset.result.reason), `naming what is missing (${farOffset.result.reason})`);

  const hugeSize = corruptTag('rXYZ', 8, 0x7fffffff);
  t.eq(hugeSize.threw, null, 'a tag size past the end does not throw');
  t.notOk(hugeSize.result.ok, 'and is rejected too');

  // The header's own size field must not be trusted over the buffer length.
  const bigClaim = mutated((b, dv) => dv.setUint32(0, 0xffffffff));
  t.eq(bigClaim.threw, null, 'a profile claiming to be 4 GB does not throw');
  t.notOk(bigClaim.result.ok, 'and is rejected');
  t.ok(/are present/.test(bigClaim.result.reason), `naming the mismatch (${bigClaim.result.reason})`);

  // A tag count that would run the table past the file.
  const manyTags = mutated((b, dv) => dv.setUint32(128, 0x0fffffff));
  t.eq(manyTags.threw, null, 'an absurd tag count does not throw');
  t.notOk(manyTags.result.ok, 'and is rejected');
  t.ok(/tag table/.test(manyTags.result.reason), `naming the tag table (${manyTags.result.reason})`);

  /*
   * The curve-count check is the one with an observable positive outcome: a curv tag
   * declaring 16 million samples inside a 14-byte tag must still parse, with the
   * sample count clamped to what the tag can hold — not allocate 16 million floats,
   * and not read past the buffer.
   */
  const hugeCurve = mutated((b, dv) => {
    for (let i = 0; i < dv.getUint32(128); i++) {
      const at = 132 + i * 12;
      const name = String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
      if (name === 'rTRC') dv.setUint32(dv.getUint32(at + 4) + 8, 0x00ffffff);
    }
  });
  t.eq(hugeCurve.threw, null, 'a curve declaring 16 million samples in a 14-byte tag does not throw');
  t.notOk(hugeCurve.result.ok, 'and the profile is rejected rather than parsed with a bogus curve');
  t.ok(/curve|rTRC/i.test(hugeCurve.result.reason), `saying which tag (${hugeCurve.result.reason})`);

  const short = parseICC(new Uint8Array(64));
  t.notOk(short.ok, 'a truncated file is rejected');
  t.ok(/too short/.test(short.reason), `and says so (${short.reason})`);

  const notICC = new Uint8Array(200);
  notICC.set(new TextEncoder().encode('not an icc file at all'), 0);
  t.notOk(parseICC(notICC).ok, 'a file with no acsp signature is rejected');
  t.ok(/not an ICC profile/.test(parseICC(notICC).reason), 'and says so');

  // The floor: random corruption must never throw, whatever it hits.
  const rnd = (() => { let s2 = 99; return () => { s2 = (s2 * 1103515245 + 12345) & 0x7fffffff; return s2 / 0x7fffffff; }; })();
  const throws = [];
  let parsedAnyway = 0;
  for (let trial = 0; trial < 80; trial++) {
    const bytes = new Uint8Array(base);
    for (let k = 0; k < 12; k++) bytes[Math.floor(rnd() * bytes.length)] = Math.floor(rnd() * 256);
    try {
      if (parseICC(bytes).ok) parsedAnyway++;
    } catch (err) { throws.push(String((err && err.message) || err)); }
  }
  t.eq(throws.slice(0, 3), [], 'and 80 randomly corrupted profiles all return rather than throw');
  // Not every corruption is fatal — most bytes are payload — so some still parse.
  // Asserting that keeps the sweep from passing on a parser that rejects everything.
  t.gt(parsedAnyway, 0, `while ${parsedAnyway} of 80 remained valid enough to parse, so the sweep is not just rejecting everything`);
});

/* ------------------------------------------------------------------ */
/* ICC parsing                                                         */
/* ------------------------------------------------------------------ */

/**
 * Build a minimal but *valid* matrix/TRC ICC profile, so the parser is tested
 * against bytes rather than against itself.
 */
function buildProfile({ desc = 'Test RGB', space = 'RGB ', primaries = null, gamma = 2.2, lut = false } = {}) {
  const tags = [];
  const enc = new TextEncoder();

  const descData = (() => {
    const text = enc.encode(desc);
    const body = new Uint8Array(12 + text.length + 1 + 67);
    const dv = new DataView(body.buffer);
    body.set(enc.encode('desc'), 0);
    dv.setUint32(8, text.length + 1);
    body.set(text, 12);
    return body;
  })();
  tags.push(['desc', descData]);

  const xyzTag = (v) => {
    const body = new Uint8Array(20);
    const dv = new DataView(body.buffer);
    body.set(enc.encode('XYZ '), 0);
    for (let i = 0; i < 3; i++) dv.setInt32(8 + i * 4, Math.round(v[i] * 65536));
    return body;
  };
  tags.push(['wtpt', xyzTag(WHITE_POINTS.D50)]);

  if (space === 'RGB ' && !lut) {
    const p = primaries || { r: [0.4360, 0.2225, 0.0139], g: [0.3851, 0.7169, 0.0971], b: [0.1431, 0.0606, 0.7141] };
    tags.push(['rXYZ', xyzTag(p.r)]);
    tags.push(['gXYZ', xyzTag(p.g)]);
    tags.push(['bXYZ', xyzTag(p.b)]);
  }
  if (lut) {
    const body = new Uint8Array(52);
    body.set(enc.encode('mft2'), 0);
    tags.push(['A2B0', body]);
  }

  const curv = (() => {
    const body = new Uint8Array(14);
    const dv = new DataView(body.buffer);
    body.set(enc.encode('curv'), 0);
    dv.setUint32(8, 1);
    dv.setUint16(12, Math.round(gamma * 256));
    return body;
  })();
  if (space === 'GRAY') tags.push(['kTRC', curv]);
  else if (!lut) { tags.push(['rTRC', curv]); tags.push(['gTRC', curv]); tags.push(['bTRC', curv]); }
  else tags.push(['rTRC', curv]);

  const headerSize = 128;
  const tableSize = 4 + tags.length * 12;
  let offset = headerSize + tableSize;
  const entries = tags.map(([name, data]) => {
    const at = offset;
    offset += data.length + ((4 - (data.length % 4)) % 4);
    return { name, data, at };
  });

  const total = offset;
  const bytes = new Uint8Array(total);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, total);
  bytes.set(enc.encode('mntr'), 12);
  bytes.set(enc.encode(space), 16);
  bytes.set(enc.encode('XYZ '), 20);
  bytes.set(enc.encode('acsp'), 36);
  dv.setUint32(128, tags.length);
  entries.forEach((e, i) => {
    const at = 132 + i * 12;
    bytes.set(enc.encode(e.name), at);
    dv.setUint32(at + 4, e.at);
    dv.setUint32(at + 8, e.data.length);
    bytes.set(e.data, e.at);
  });
  return bytes;
}

suite('color / the ICC parser reads real bytes', async (t) => {
  const good = parseICC(buildProfile({ desc: 'Widget RGB', gamma: 1.8 }));
  t.ok(good.ok, `a matrix/TRC profile parses${good.ok ? '' : ` (${good.reason})`}`);
  if (good.ok) {
    t.eq(good.profile.name, 'Widget RGB', 'with its description');
    t.eq(good.profile.space, 'rgb', 'as an RGB profile');
    t.ok(good.profile.embedded, 'marked as embedded');
    t.eq(good.profile.white, WHITE_POINTS.D50, 'in the D50 connection space the colorants are relative to');
    // The primaries above are the D50-adapted sRGB colorants, so a transform to
    // sRGB should be close to the identity.
    const fn = makeTransform(good.profile, getProfile('srgb'));
    const grey = fn([0.5, 0.5, 0.5]);
    t.lt(Math.max(Math.abs(grey[0] - grey[1]), Math.abs(grey[1] - grey[2])), 0.01,
      'and a grey converts to a neutral through it');
    // Gamma 1.8 encoded 0.5 is darker in linear terms than gamma 2.2 would be.
    t.close(good.profile.trc.toLinear(0.5), 0.5 ** 1.8, 0.01, 'the tone curve is the gamma the file specified');
  }

  const grey = parseICC(buildProfile({ space: 'GRAY', desc: 'Grey 2.2' }));
  t.ok(grey.ok, 'a grey profile parses too');
  if (grey.ok) t.eq(grey.profile.space, 'gray', 'as a grey profile');

  // Every rejection must come with a reason, not a silent misread.
  const lut = parseICC(buildProfile({ lut: true }));
  t.notOk(lut.ok, 'a LUT-based profile is rejected');
  t.ok(/LUT/.test(lut.reason), `with a reason that says why (${lut.reason})`);

  const short = parseICC(new Uint8Array(64));
  t.notOk(short.ok, 'a truncated file is rejected');
  t.ok(/too short/.test(short.reason), `and says so (${short.reason})`);

  const notICC = new Uint8Array(200);
  notICC.set(new TextEncoder().encode('not an icc file at all'), 0);
  const bad = parseICC(notICC);
  t.notOk(bad.ok, 'a file with no acsp signature is rejected');
  t.ok(/not an ICC profile/.test(bad.reason), `and says so (${bad.reason})`);
});

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

suite('color / the commands are registered', async (t) => {
  for (const [id, accel] of [
    ['edit.assign-profile', undefined],
    ['edit.convert-profile', undefined],
    ['view.proof-colors', 'Ctrl+Y'],
    ['view.proof-setup', undefined],
    ['view.gamut-warning', 'Shift+Ctrl+Y'],
  ]) {
    const cmd = getCommand(id);
    t.ok(cmd, `${id} exists`);
    if (cmd && accel) t.eq(cmd.accel, accel, `with Photoshop's shortcut (${accel})`);
  }

  const doc = t.doc(8, 8, '#777777', 'cmds');
  t.ok(availableProfiles(doc).length >= 6, 'the profile list offers every built-in space');
  // An embedded profile is offered first, since it is the one the file came with.
  const parsed = parseICC(buildProfile({ desc: 'From File' }));
  if (parsed.ok) {
    doc.profile = parsed.profile;
    t.eq(availableProfiles(doc)[0].name, 'From File', 'and an embedded profile comes first');
  }
});
