import { suite } from '../harness.js';
import { compositeDocument } from '/src/render/compositor.js';
import { createRasterLayer } from '/src/core/layer.js';
import { DEFAULT_STYLES, defaultStyle, hasStyles, enabledEffects, renderers } from '/src/effects/styles.js';

/**
 * The ten layer effects.
 *
 * Every test puts a hard-edged square on a transparent layer over a known
 * backdrop, enables ONE effect, and probes three places: inside the shape,
 * just outside the edge, and far away. That is what makes the assertions
 * non-vacuous — an effect that renders in the wrong place, or renders nothing,
 * changes at least one of the three.
 *
 * Shape geometry used almost everywhere: a 120x120 document with fillRect(40,
 * 40, 40, 40), i.e. opaque pixels at x,y in [40, 79] and alpha 0 elsewhere. No
 * antialiasing, so the alpha field is exactly 0 or 255.
 */

const SHAPE = [40, 40, 40, 40];

function fxDoc(t, { size = 120, bg = '#ffffff', shape = '#ff0000', rect = SHAPE, name = 'fx' } = {}) {
  const doc = t.doc(size, size, bg, name);
  const layer = doc.addLayer(createRasterLayer(size, size, 'shape'));
  const c = layer.canvas.getContext('2d');
  c.fillStyle = shape;
  c.fillRect(rect[0], rect[1], rect[2], rect[3]);
  layer.styles = {};
  return { doc, layer };
}

/** Enable exactly one effect with explicit parameters (no global-light drift). */
function only(layer, id, over = {}) {
  const cfg = { ...defaultStyle(id), enabled: true, ...over };
  layer.styles = { [id]: cfg };
  return cfg;
}

function chans(t, canvas, x, y) {
  return t.px(canvas, x, y).split(',').map(Number);
}

function r(t, canvas, x, y) {
  return chans(t, canvas, x, y)[0];
}

function maxDiff(a, b) {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

/* ================================================================== */

suite('effects / drop shadow', async (t) => {
  const { doc, layer } = fxDoc(t);
  // angle 120, distance 5 -> dx = round(-cos120*5) = 3, dy = round(sin120*5) = 4,
  // so the shadow sits down-and-right of the shape.
  only(layer, 'dropShadow', {
    useGlobalLight: false, angle: 120, distance: 5, size: 5, spread: 0,
    opacity: 0.75, color: '#000000', blendMode: 'multiply', noise: 0,
  });
  let cv = compositeDocument(doc);

  const out = chans(t, cv, 81, 60);
  t.lt(out[0], 200, 'the shadow darkens a pixel just OUTSIDE the shape edge');
  t.eq([out[0] === out[1], out[1] === out[2], out[3]], [true, true, 255],
    'a black shadow multiplied over white stays neutral grey');
  t.eq(t.px(cv, 60, 60), '255,0,0,255', 'the shape itself is untouched (the shadow is knocked out under it)');
  t.eq(t.px(cv, 10, 10), '255,255,255,255', 'a pixel far from the shape is exactly the backdrop');
  t.eq(t.px(cv, 36, 36), '255,255,255,255', 'and nothing spills up-left, opposite the light');

  // distance
  only(layer, 'dropShadow', { useGlobalLight: false, angle: 120, distance: 5, size: 5, opacity: 0.75 });
  const near = r(t, compositeDocument(doc), 90, 90);
  only(layer, 'dropShadow', { useGlobalLight: false, angle: 120, distance: 30, size: 5, opacity: 0.75 });
  const far = r(t, compositeDocument(doc), 90, 90);
  t.gt(near, 250, 'at distance 5 the shadow has not reached (90,90)');
  t.lt(far, 200, 'at distance 30 it has — distance moves the shadow');

  // angle: 120 throws down-right, 300 throws up-left
  only(layer, 'dropShadow', { useGlobalLight: false, angle: 120, distance: 20, size: 4, opacity: 0.75 });
  const a120 = compositeDocument(doc);
  only(layer, 'dropShadow', { useGlobalLight: false, angle: 300, distance: 20, size: 4, opacity: 0.75 });
  const a300 = compositeDocument(doc);
  t.lt(r(t, a120, 85, 92), 200, 'angle 120 puts shadow down-right at (85,92)');
  t.gt(r(t, a300, 85, 92), 250, 'angle 300 leaves (85,92) clean');
  t.lt(r(t, a300, 35, 30), 200, 'angle 300 puts shadow up-left at (35,30)');
  t.gt(r(t, a120, 35, 30), 250, 'angle 120 leaves (35,30) clean');

  // size (blur radius)
  only(layer, 'dropShadow', { useGlobalLight: false, angle: 120, distance: 0, size: 2, opacity: 0.75 });
  const tight = r(t, compositeDocument(doc), 86, 60);
  only(layer, 'dropShadow', { useGlobalLight: false, angle: 120, distance: 0, size: 20, opacity: 0.75 });
  const wide = r(t, compositeDocument(doc), 86, 60);
  t.gt(tight, 250, 'size 2 does not reach 7px outside the shape');
  t.lt(wide, 240, 'size 20 does — size controls the reach');

  // opacity
  only(layer, 'dropShadow', { useGlobalLight: false, angle: 120, distance: 5, size: 5, opacity: 0.25 });
  const faint = r(t, compositeDocument(doc), 81, 60);
  only(layer, 'dropShadow', { useGlobalLight: false, angle: 120, distance: 5, size: 5, opacity: 0.75 });
  const strong = r(t, compositeDocument(doc), 81, 60);
  t.gt(faint - strong, 50, 'opacity scales the shadow (0.25 is much lighter than 0.75)');

  // colour
  only(layer, 'dropShadow', {
    useGlobalLight: false, angle: 120, distance: 5, size: 5, opacity: 0.75, color: '#0000ff',
  });
  const blue = chans(t, compositeDocument(doc), 81, 60);
  t.gt(blue[2] - blue[0], 100, 'a blue shadow leaves the blue channel alone and eats red');
});

/* ================================================================== */

suite('effects / inner shadow', async (t) => {
  const { doc, layer } = fxDoc(t);
  only(layer, 'innerShadow', {
    useGlobalLight: false, angle: 120, distance: 5, size: 5, choke: 0,
    opacity: 0.75, color: '#000000', blendMode: 'multiply', noise: 0,
  });
  let cv = compositeDocument(doc);

  const edge = chans(t, cv, 42, 60);
  t.lt(edge[0], 220, 'the inner shadow darkens just INSIDE the lit edge');
  t.eq([edge[1], edge[2], edge[3]], [0, 0, 255], 'multiplying black over red keeps green/blue at 0');
  t.eq(t.px(cv, 60, 60), '255,0,0,255', 'the middle of the shape is untouched');
  t.eq(t.px(cv, 85, 60), '255,255,255,255', 'nothing is drawn OUTSIDE the shape at all');
  t.eq(t.px(cv, 10, 10), '255,255,255,255', 'and the far backdrop is exactly clean');
  const opposite = r(t, cv, 77, 60);
  t.gt(opposite, 240, 'the opposite interior edge is nearly clean — the shadow is directional');
  t.gt(opposite - edge[0], 60, 'the lit edge is far darker than the far edge');

  // distance 0 removes the offset, so the shadow must ring the interior evenly
  only(layer, 'innerShadow', { useGlobalLight: false, angle: 120, distance: 0, size: 5, opacity: 0.75 });
  cv = compositeDocument(doc);
  t.lt(r(t, cv, 77, 60), opposite - 15, 'distance 0 brings the shadow round to the far edge as well');
  t.eq(t.px(cv, 42, 60), t.px(cv, 77, 60), 'and at distance 0 the two edges are exactly equal');
  t.eq(t.px(cv, 60, 60), '255,0,0,255', 'with the middle still untouched');

  // size
  only(layer, 'innerShadow', { useGlobalLight: false, angle: 120, distance: 5, size: 2, opacity: 0.75 });
  const tight = r(t, compositeDocument(doc), 55, 60);
  only(layer, 'innerShadow', { useGlobalLight: false, angle: 120, distance: 5, size: 20, opacity: 0.75 });
  const wide = r(t, compositeDocument(doc), 55, 60);
  t.gt(tight, 250, 'size 2 does not reach 15px into the shape');
  t.lt(wide, 240, 'size 20 does');

  // opacity
  only(layer, 'innerShadow', { useGlobalLight: false, angle: 120, distance: 5, size: 5, opacity: 0.2 });
  const faint = r(t, compositeDocument(doc), 42, 60);
  only(layer, 'innerShadow', { useGlobalLight: false, angle: 120, distance: 5, size: 5, opacity: 1 });
  const full = r(t, compositeDocument(doc), 42, 60);
  t.gt(faint - full, 50, 'opacity scales the inner shadow');

  // colour (Normal, so the colour is visible against the red content)
  only(layer, 'innerShadow', {
    useGlobalLight: false, angle: 120, distance: 5, size: 5, opacity: 1,
    blendMode: 'normal', color: '#0000ff',
  });
  const blue = chans(t, compositeDocument(doc), 42, 60);
  t.gt(blue[2], 100, 'a blue inner shadow puts blue inside the shape');

  // angle
  only(layer, 'innerShadow', { useGlobalLight: false, angle: 300, distance: 5, size: 5, opacity: 0.75 });
  cv = compositeDocument(doc);
  t.lt(r(t, cv, 77, 60), 220, 'angle 300 moves the inner shadow to the bottom-right edge');
  t.gt(r(t, cv, 42, 60), 250, 'and clears the top-left edge');
});

/* ================================================================== */

suite('effects / outer glow', async (t) => {
  // A Screen glow needs a dark backdrop to be visible at all.
  const { doc, layer } = fxDoc(t, { bg: '#202020' });
  only(layer, 'outerGlow', {
    size: 10, spread: 0, opacity: 0.75, color: '#ffe38a', blendMode: 'screen', noise: 0,
  });
  let cv = compositeDocument(doc);

  const out = chans(t, cv, 81, 60);
  t.gt(out[0], 55, 'the glow brightens pixels just OUTSIDE the shape');
  t.gt(out[1], 40, 'in green too — the glow colour is warm, not pure red');
  t.eq(t.px(cv, 60, 60), '255,0,0,255', 'the shape itself is untouched (the glow is knocked out under it)');
  t.eq(t.px(cv, 5, 5), '32,32,32,255', 'a far pixel is exactly the backdrop');

  // size
  only(layer, 'outerGlow', { size: 4, spread: 0, opacity: 0.75 });
  const tight = r(t, compositeDocument(doc), 95, 60);
  only(layer, 'outerGlow', { size: 30, spread: 0, opacity: 0.75 });
  const wide = r(t, compositeDocument(doc), 95, 60);
  t.close(tight, 32, 1, 'size 4 does not reach 16px out');
  t.gt(wide, 45, 'size 30 does');

  // spread hardens the falloff, pushing coverage outward
  only(layer, 'outerGlow', { size: 10, spread: 0, opacity: 1 });
  const soft = r(t, compositeDocument(doc), 86, 60);
  only(layer, 'outerGlow', { size: 10, spread: 0.8, opacity: 1 });
  const hard = r(t, compositeDocument(doc), 86, 60);
  t.gt(hard - soft, 30, 'spread 0.8 makes the glow much stronger 7px out');

  // opacity
  only(layer, 'outerGlow', { size: 10, spread: 0, opacity: 0.2 });
  const faint = r(t, compositeDocument(doc), 81, 60);
  only(layer, 'outerGlow', { size: 10, spread: 0, opacity: 1 });
  const full = r(t, compositeDocument(doc), 81, 60);
  t.gt(full - faint, 40, 'opacity scales the glow');

  // colour
  only(layer, 'outerGlow', { size: 10, spread: 0, opacity: 1, color: '#ff0000' });
  const red = chans(t, compositeDocument(doc), 81, 60);
  t.gt(red[0], 55, 'a red glow brightens red');
  t.eq(red[1], 32, 'and leaves green exactly at the backdrop value');
});

/* ================================================================== */

suite('effects / inner glow', async (t) => {
  // Dark shape so a Screen glow reads, light backdrop so leakage would show.
  const { doc, layer } = fxDoc(t, { shape: '#202020' });
  only(layer, 'innerGlow', {
    size: 10, choke: 0, opacity: 0.75, color: '#ffe38a', blendMode: 'screen',
    source: 'edge', noise: 0,
  });
  let cv = compositeDocument(doc);

  t.gt(r(t, cv, 42, 60), 100, 'the inner glow brightens just INSIDE the edge');
  t.eq(t.px(cv, 60, 60), '32,32,32,255', 'the middle of the shape is untouched at size 10');
  t.eq(t.px(cv, 85, 60), '255,255,255,255', 'nothing leaks OUTSIDE the shape');
  t.eq(t.px(cv, 5, 5), '255,255,255,255', 'the far backdrop is exactly clean');

  // size
  only(layer, 'innerGlow', { size: 4, choke: 0, opacity: 0.75, source: 'edge' });
  const tight = r(t, compositeDocument(doc), 52, 60);
  only(layer, 'innerGlow', { size: 20, choke: 0, opacity: 0.75, source: 'edge' });
  const wide = r(t, compositeDocument(doc), 52, 60);
  t.close(tight, 32, 1, 'size 4 does not reach 12px in');
  t.gt(wide, 60, 'size 20 does');

  // choke pushes full strength further in before the falloff starts
  only(layer, 'innerGlow', { size: 10, choke: 0, opacity: 1, source: 'edge' });
  const soft = r(t, compositeDocument(doc), 46, 60);
  only(layer, 'innerGlow', { size: 10, choke: 0.8, opacity: 1, source: 'edge' });
  const choked = r(t, compositeDocument(doc), 46, 60);
  t.gt(choked - soft, 30, 'choke 0.8 strengthens the glow 6px in');

  // source: centre glows from the middle out instead of from the edge in
  only(layer, 'innerGlow', { size: 10, choke: 0, opacity: 1, source: 'center' });
  cv = compositeDocument(doc);
  t.gt(r(t, cv, 60, 60), 100, 'source "center" glows in the middle of the shape');
  t.lt(r(t, cv, 42, 60), 150, 'and is weaker at the edge — the inverse of "edge"');

  // opacity + colour
  only(layer, 'innerGlow', { size: 10, choke: 0, opacity: 0.2, source: 'edge' });
  const faint = r(t, compositeDocument(doc), 42, 60);
  only(layer, 'innerGlow', { size: 10, choke: 0, opacity: 1, source: 'edge' });
  const full = r(t, compositeDocument(doc), 42, 60);
  t.gt(full - faint, 40, 'opacity scales the inner glow');
  only(layer, 'innerGlow', { size: 10, choke: 0, opacity: 1, source: 'edge', color: '#ff0000' });
  const red = chans(t, compositeDocument(doc), 42, 60);
  t.gt(red[0], 100, 'a red inner glow brightens red');
  t.eq(red[1], 32, 'and leaves green exactly at the shape value');
});

/* ================================================================== */

suite('effects / bevel and emboss', async (t) => {
  const { doc, layer } = fxDoc(t, { shape: '#808080' });
  const base = {
    style: 'inner', technique: 'smooth', depth: 1, direction: 'up', size: 5, soften: 0,
    angle: 120, altitude: 30, useGlobalLight: false,
    highlightColor: '#ffffff', highlightOpacity: 0.75, highlightMode: 'screen',
    shadowColor: '#000000', shadowOpacity: 0.75, shadowMode: 'multiply',
  };
  only(layer, 'bevelEmboss', base);
  let cv = compositeDocument(doc);

  const lit = r(t, cv, 43, 60), dark = r(t, cv, 77, 60);
  t.gt(lit, 140, 'the edge facing the light is highlighted');
  t.lt(dark, 80, 'the opposite edge is shaded');
  t.gt(lit - dark, 80, 'the two sides differ strongly');
  t.eq(t.px(cv, 60, 60), '128,128,128,255', 'the flat middle of the shape is exactly untouched');
  t.eq(t.px(cv, 85, 60), '255,255,255,255', 'an inner bevel draws nothing outside the shape');

  // depth 0 = a flat surface, so nothing may be shaded at all
  only(layer, 'bevelEmboss', { ...base, depth: 0 });
  cv = compositeDocument(doc);
  t.eq(t.px(cv, 43, 60), '128,128,128,255', 'depth 0 renders no highlight');
  t.eq(t.px(cv, 77, 60), '128,128,128,255', 'and no shadow');

  // angle flips which side is lit
  only(layer, 'bevelEmboss', { ...base, angle: 300 });
  cv = compositeDocument(doc);
  t.lt(r(t, cv, 43, 60), 80, 'angle 300 shades the left edge');
  t.gt(r(t, cv, 77, 60), 140, 'and lights the right one');

  // size widens the ramp
  only(layer, 'bevelEmboss', { ...base, size: 2 });
  t.eq(t.px(compositeDocument(doc), 50, 60), '128,128,128,255', 'size 2 does not reach 10px in');
  only(layer, 'bevelEmboss', { ...base, size: 15 });
  t.ne(t.px(compositeDocument(doc), 50, 60), '128,128,128,255', 'size 15 does');

  // altitude changes the shading; at 89 degrees the light is straight down
  only(layer, 'bevelEmboss', { ...base, altitude: 89 });
  t.ne(t.px(compositeDocument(doc), 43, 60), t.px(cv, 43, 60), 'altitude changes the shading');

  // opacity of the two halves
  only(layer, 'bevelEmboss', { ...base, highlightOpacity: 0.1 });
  const faint = r(t, compositeDocument(doc), 43, 60);
  t.lt(faint, lit - 20, 'highlightOpacity scales the highlight');
  only(layer, 'bevelEmboss', { ...base, shadowOpacity: 0.1 });
  t.gt(r(t, compositeDocument(doc), 77, 60), dark + 20, 'shadowOpacity scales the shadow');

  // highlight colour
  only(layer, 'bevelEmboss', { ...base, highlightColor: '#00ff00', highlightMode: 'normal' });
  const green = chans(t, compositeDocument(doc), 43, 60);
  t.gt(green[1] - green[0], 20, 'highlightColor changes the highlight hue');

  // an outer bevel shades OUTSIDE the shape instead
  only(layer, 'bevelEmboss', { ...base, style: 'outer' });
  t.ne(t.px(compositeDocument(doc), 82, 60), '255,255,255,255', 'an outer bevel shades outside the shape');
  only(layer, 'bevelEmboss', { ...base, style: 'inner' });
  t.eq(t.px(compositeDocument(doc), 82, 60), '255,255,255,255', 'while an inner bevel does not');
});

/* ================================================================== */

suite('effects / satin', async (t) => {
  const { doc, layer } = fxDoc(t);
  only(layer, 'satin', {
    color: '#000000', opacity: 0.5, blendMode: 'multiply',
    angle: 19, distance: 11, size: 14, invert: true,
  });
  let cv = compositeDocument(doc);

  const mid = chans(t, cv, 60, 60);
  t.lt(mid[0], 200, 'satin darkens the interior of the shape');
  t.eq([mid[1], mid[2], mid[3]], [0, 0, 255], 'and does so by multiplying, leaving g/b at 0');
  t.eq(t.px(cv, 85, 60), '255,255,255,255', 'satin never paints outside the shape');
  t.eq(t.px(cv, 5, 5), '255,255,255,255', 'nor anywhere near the backdrop');

  // invert flips the folds
  only(layer, 'satin', { color: '#000000', opacity: 0.5, blendMode: 'multiply', angle: 19, distance: 11, size: 14, invert: false });
  const plain = r(t, compositeDocument(doc), 60, 60);
  t.gt(plain - mid[0], 50, 'invert flips which parts of the fold are dark');

  // distance 0 collapses the two offsets, so (inverted) the whole shape darkens flat
  only(layer, 'satin', { color: '#000000', opacity: 0.5, blendMode: 'multiply', angle: 19, distance: 0, size: 14, invert: true });
  cv = compositeDocument(doc);
  t.close(r(t, cv, 60, 60), 127, 3, 'distance 0 gives a flat 50% darkening');
  t.eq(t.px(cv, 60, 60), t.px(cv, 50, 50), 'and it is uniform across the shape');

  // size
  only(layer, 'satin', { color: '#000000', opacity: 0.5, blendMode: 'multiply', angle: 19, distance: 11, size: 2, invert: true });
  const sharp = r(t, compositeDocument(doc), 60, 60);
  t.gt(Math.abs(sharp - mid[0]), 20, 'size changes the satin blur, and the result');

  // angle rotates the folds: (60,45) sits in a band at 90 but not at 0
  only(layer, 'satin', { color: '#000000', opacity: 0.6, blendMode: 'multiply', angle: 0, distance: 11, size: 6, invert: false });
  const at0 = r(t, compositeDocument(doc), 60, 45);
  only(layer, 'satin', { color: '#000000', opacity: 0.6, blendMode: 'multiply', angle: 90, distance: 11, size: 6, invert: false });
  const at90 = r(t, compositeDocument(doc), 60, 45);
  t.gt(at0 - at90, 50, 'angle rotates the satin bands');

  // opacity + colour
  only(layer, 'satin', { color: '#000000', opacity: 0.2, blendMode: 'multiply', angle: 19, distance: 11, size: 14, invert: true });
  const faint = r(t, compositeDocument(doc), 60, 60);
  t.gt(faint - mid[0], 30, 'opacity scales satin');
  only(layer, 'satin', { color: '#0000ff', opacity: 1, blendMode: 'normal', angle: 19, distance: 11, size: 14, invert: true });
  t.gt(chans(t, compositeDocument(doc), 60, 60)[2], 100, 'colour changes what satin paints');
});

/* ================================================================== */

suite('effects / colour, gradient and pattern overlays', async (t) => {
  const { doc, layer } = fxDoc(t, { shape: '#0000ff' });

  /* --- colour overlay --- */
  only(layer, 'colorOverlay', { color: '#ff0000', opacity: 1, blendMode: 'normal' });
  let cv = compositeDocument(doc);
  t.eq(t.px(cv, 60, 60), '255,0,0,255', 'a full-opacity colour overlay replaces the shape colour exactly');
  t.eq(t.px(cv, 85, 60), '255,255,255,255', 'and paints nothing outside the shape');
  only(layer, 'colorOverlay', { color: '#00ff00', opacity: 1, blendMode: 'normal' });
  t.eq(t.px(compositeDocument(doc), 60, 60), '0,255,0,255', 'the colour parameter is honoured exactly');
  only(layer, 'colorOverlay', { color: '#ff0000', opacity: 0.2, blendMode: 'normal' });
  const faint = chans(t, compositeDocument(doc), 60, 60);
  t.close(faint[0], 51, 2, 'opacity 0.2 mixes 51/255 of the overlay red');
  t.close(faint[2], 204, 2, 'leaving 204/255 of the blue underneath');
  only(layer, 'colorOverlay', { color: '#ff0000', opacity: 1, blendMode: 'multiply' });
  t.eq(t.px(compositeDocument(doc), 60, 60), '0,0,0,255', 'Multiply of red over blue is exactly black');

  /* --- gradient overlay --- */
  const grad = {
    opacity: 1, blendMode: 'normal', angle: 90, scale: 1, reverse: false, style: 'linear',
    stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }],
  };
  only(layer, 'gradientOverlay', grad);
  cv = compositeDocument(doc);
  const top = chans(t, cv, 60, 41), bottom = chans(t, cv, 60, 78);
  t.gt(top[0], 225, 'angle 90 puts the white end of the ramp at the top of the shape');
  t.lt(bottom[0], 30, 'and the black end at the bottom');
  t.gt(top[0] - bottom[0], 195, 'so it is a real gradient, not a flat fill');
  t.eq([top[0] === top[1], top[1] === top[2]], [true, true], 'a black-to-white ramp stays neutral');
  t.eq(t.px(cv, 85, 60), '255,255,255,255', 'the gradient is clipped to the shape');

  only(layer, 'gradientOverlay', { ...grad, reverse: true });
  cv = compositeDocument(doc);
  t.lt(r(t, cv, 60, 41), 30, 'reverse swaps the ends (top)');
  t.gt(r(t, cv, 60, 78), 225, 'reverse swaps the ends (bottom)');

  only(layer, 'gradientOverlay', { ...grad, angle: 0 });
  cv = compositeDocument(doc);
  t.lt(r(t, cv, 41, 60), 30, 'angle 0 runs the ramp left to right (left is black)');
  t.gt(r(t, cv, 78, 60), 225, 'and right is white');

  only(layer, 'gradientOverlay', { ...grad, scale: 0.5 });
  t.lt(r(t, compositeDocument(doc), 60, 72), 20, 'scale 0.5 compresses the ramp, clamping the ends');
  only(layer, 'gradientOverlay', { ...grad });
  t.gt(r(t, compositeDocument(doc), 60, 72), 35, 'while scale 1 still has mid-tone there');

  only(layer, 'gradientOverlay', { ...grad, style: 'radial' });
  t.lt(r(t, compositeDocument(doc), 60, 60), 40, 'a radial gradient puts the first stop at the centre');

  /* --- pattern overlay --- */
  t.eq(DEFAULT_STYLES.patternOverlay.patternId, 'checkerboard',
    'the pattern overlay default names the first tile in the library');
  only(layer, 'patternOverlay', { patternId: 'checkerboard', opacity: 1, blendMode: 'normal', scale: 1 });
  cv = compositeDocument(doc);
  // The checkerboard tile is exactly two colours; the shape must show both.
  const seen = new Set();
  for (let y = 42; y < 78; y++) for (let x = 42; x < 78; x++) seen.add(t.px(cv, x, y));
  t.eq([...seen].sort(), ['242,239,233,255', '63,67,74,255'],
    'the pattern paints exactly the checkerboard tile colours inside the shape');
  t.eq(t.px(cv, 85, 60), '255,255,255,255', 'and nothing outside it');

  const transitions = (canvas) => {
    let n = 0, prev = t.px(canvas, 42, 60);
    for (let x = 43; x < 78; x++) {
      const cur = t.px(canvas, x, 60);
      if (cur !== prev) n++;
      prev = cur;
    }
    return n;
  };
  const at1 = transitions(cv);
  only(layer, 'patternOverlay', { patternId: 'checkerboard', opacity: 1, blendMode: 'normal', scale: 0.5 });
  const atHalf = transitions(compositeDocument(doc));
  t.gt(at1, 0, 'the pattern genuinely varies across the shape');
  t.gt(atHalf, at1, 'scale 0.5 halves the cell size, so there are more transitions');

  only(layer, 'patternOverlay', { patternId: 'checkerboard', opacity: 0.5, blendMode: 'normal', scale: 1 });
  t.ne(t.px(compositeDocument(doc), 60, 60), '63,67,74,255', 'opacity mixes the pattern with the layer');

  only(layer, 'patternOverlay', { patternId: '', opacity: 1, blendMode: 'normal', scale: 1 });
  t.eq(t.px(compositeDocument(doc), 60, 60), '0,0,255,255', 'a pattern overlay with no pattern renders nothing');
});

/* ================================================================== */

suite('effects / stroke', async (t) => {
  const { doc, layer } = fxDoc(t);
  // Outside stroke, size 3: the chamfer field gives full coverage at 1-2px out
  // and half coverage at exactly 3px out, so (81,60) is solid and (84,60) clean.
  only(layer, 'stroke', {
    size: 3, position: 'outside', blendMode: 'normal', opacity: 1, fillType: 'color', color: '#000000',
  });
  let cv = compositeDocument(doc);
  t.eq(t.px(cv, 81, 60), '0,0,0,255', 'an outside stroke adds fully opaque pixels just beyond the edge');
  t.eq(t.px(cv, 80, 60), '0,0,0,255', 'right up against the edge');
  t.eq(t.px(cv, 84, 60), '255,255,255,255', 'and stops after `size` pixels');
  t.eq(t.px(cv, 60, 60), '255,0,0,255', 'with nothing at all in the middle of the shape');
  t.eq(t.px(cv, 41, 60), '255,0,0,255', 'nor just inside the edge');
  t.eq(t.px(cv, 60, 81), '0,0,0,255', 'the ring is on every side (bottom)');
  t.eq(t.px(cv, 39, 60), '0,0,0,255', 'and the left');

  only(layer, 'stroke', { size: 3, position: 'inside', blendMode: 'normal', opacity: 1, fillType: 'color', color: '#000000' });
  cv = compositeDocument(doc);
  t.eq(t.px(cv, 41, 60), '0,0,0,255', 'an inside stroke sits within the shape');
  t.eq(t.px(cv, 81, 60), '255,255,255,255', 'and adds nothing outside it');
  t.eq(t.px(cv, 60, 60), '255,0,0,255', 'still nothing in the middle');

  only(layer, 'stroke', { size: 4, position: 'center', blendMode: 'normal', opacity: 1, fillType: 'color', color: '#000000' });
  cv = compositeDocument(doc);
  t.eq(t.px(cv, 40, 60), '0,0,0,255', 'a centre stroke straddles the edge (inside half)');
  t.eq(t.px(cv, 80, 60), '0,0,0,255', 'and the outside half');
  t.eq(t.px(cv, 60, 60), '255,0,0,255', 'leaving the middle alone');

  only(layer, 'stroke', { size: 8, position: 'outside', blendMode: 'normal', opacity: 1, fillType: 'color', color: '#000000' });
  t.eq(t.px(compositeDocument(doc), 85, 60), '0,0,0,255', 'size 8 reaches 6px out where size 3 did not');

  only(layer, 'stroke', { size: 3, position: 'outside', blendMode: 'normal', opacity: 1, fillType: 'color', color: '#00ff00' });
  t.eq(t.px(compositeDocument(doc), 81, 60), '0,255,0,255', 'the stroke colour is used exactly');

  only(layer, 'stroke', { size: 3, position: 'outside', blendMode: 'normal', opacity: 0.5, fillType: 'color', color: '#000000' });
  const half = chans(t, compositeDocument(doc), 81, 60);
  t.close(half[0], 127, 2, 'opacity 0.5 halves the stroke over white');

  only(layer, 'stroke', { size: 0, position: 'outside', blendMode: 'normal', opacity: 1, fillType: 'color', color: '#000000' });
  cv = compositeDocument(doc);
  t.eq(t.px(cv, 81, 60), '255,255,255,255', 'size 0 renders no stroke at all');
  t.eq(t.px(cv, 60, 60), '255,0,0,255', 'and leaves the layer untouched');

  only(layer, 'stroke', {
    size: 6, position: 'outside', blendMode: 'normal', opacity: 1, fillType: 'gradient',
    angle: 0, stops: [{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#0000ff' }],
  });
  cv = compositeDocument(doc);
  const left = chans(t, cv, 36, 60), right = chans(t, cv, 83, 60);
  t.gt(left[0] - left[2], 100, 'a gradient stroke starts red on the left of the ring');
  t.gt(right[2] - right[0], 100, 'and ends blue on the right');
});

/* ================================================================== */

suite('effects / bookkeeping and disabled effects', async (t) => {
  const { doc, layer } = fxDoc(t);

  layer.styles = null;
  t.notOk(hasStyles(layer), 'a layer with no styles object has no styles');
  t.eq(enabledEffects(layer), [], 'and no enabled effects');
  const plain = t.bytes(compositeDocument(doc));

  layer.styles = {};
  t.notOk(hasStyles(layer), 'an empty styles object has no styles');

  // Every effect present but switched off must render nothing at all.
  layer.styles = {};
  for (const id of Object.keys(DEFAULT_STYLES)) layer.styles[id] = { ...defaultStyle(id), enabled: false, size: 30 };
  t.eq(Object.keys(layer.styles).length, 10, 'there are exactly ten layer effects');
  t.notOk(hasStyles(layer), 'ten disabled effects still count as no styles');
  t.eq(enabledEffects(layer), [], 'enabledEffects skips disabled entries');
  t.eq(t.mad(t.bytes(compositeDocument(doc)), plain), 0, 'a disabled effect renders literally nothing');

  layer.styles.dropShadow.enabled = true;
  layer.styles.innerGlow.enabled = true;
  layer.styles.stroke.enabled = true;
  t.ok(hasStyles(layer), 'one enabled effect flips hasStyles');
  t.eq(enabledEffects(layer), ['dropShadow', 'innerGlow', 'stroke'],
    'enabledEffects returns them in Photoshop stacking order (below effects first)');
  t.gt(t.mad(t.bytes(compositeDocument(doc)), plain), 0.5,
    'precondition: the enabled effects really do change the composite');
});

/* ================================================================== */

suite('effects / below-effects blend against the real backdrop', async (t) => {
  // A hard-edged shadow: distance 20 at angle 0 shifts the matte 20px left,
  // size 0 means no blur, so the visible shadow band is x in [20, 39] with
  // alpha exactly 255. Multiply of backdrop 170 by shadow 153 is 102 exactly.
  const cfg = {
    enabled: true, color: '#999999', opacity: 1, blendMode: 'multiply',
    useGlobalLight: false, angle: 0, distance: 20, size: 0, spread: 0, noise: 0,
  };

  const over = fxDoc(t, { bg: '#aaaaaa' });
  over.layer.styles = { dropShadow: { ...cfg } };
  let cv = compositeDocument(over.doc);
  t.eq(t.px(cv, 30, 60), '102,102,102,255',
    'a Multiply drop shadow really multiplies against the backdrop (170*153/255)');
  t.eq(t.px(cv, 60, 60), '255,0,0,255', 'the layer content still draws over it');

  const empty = fxDoc(t, { bg: 'transparent' });
  empty.layer.styles = { dropShadow: { ...cfg } };
  const emptyPx = t.px(compositeDocument(empty.doc), 30, 60);
  t.eq(emptyPx, '153,153,153,255',
    'over an empty canvas Multiply has nothing to blend with, so the shadow colour survives');
  t.ne(emptyPx, '102,102,102,255',
    'so the two differ — the shadow is NOT composited against transparency inside the layer');

  // Fill opacity must not touch the shadow; layer opacity must.
  over.layer.fillOpacity = 0;
  t.eq(t.px(compositeDocument(over.doc), 30, 60), '102,102,102,255',
    'fill opacity 0 leaves the drop shadow at full strength');
  over.layer.fillOpacity = 1;
  over.layer.opacity = 0.5;
  const dim = chans(t, compositeDocument(over.doc), 30, 60);
  t.close(dim[0], 136, 3, 'layer opacity 0.5 halves the shadow against the backdrop');
});

/* ================================================================== */

suite('effects / region cropping has no seam', async (t) => {
  /**
   * `effectRegion` crops the effect pipeline to the content bounds plus each
   * effect's reach. To prove the crop changes nothing, the same effect is
   * rendered twice: once on a lone 60x60 square (cropped to 208x208 at 96,96)
   * and once with 12x12 blocks in the four corners, which pushes the content
   * bounds to the whole canvas so cropping declines and the renderer sees the
   * full 400x400.
   *
   * Only the central 180x180 is compared. The corner blocks reach at most 12 +
   * 90 = 102 px (three box-blur passes of radius 30 for size 60), so they
   * cannot contribute anything inside x,y >= 110 — while 110 is still only 14px
   * from the crop boundary, which is where truncation would show.
   *
   * `envSizes` records what the renderer was actually handed, so a mistake that
   * left both documents on the same path could not pass silently.
   */
  const envSizes = [];
  const build = (styles, uncropped) => {
    const doc = t.doc(400, 400, '#ffffff', uncropped ? 'nocrop' : 'crop');
    const l = doc.addLayer(createRasterLayer(400, 400, 'shape'));
    const c = l.canvas.getContext('2d');
    c.fillStyle = '#000000';
    c.fillRect(170, 170, 60, 60);
    if (uncropped) {
      c.fillRect(0, 0, 12, 12);
      c.fillRect(388, 0, 12, 12);
      c.fillRect(0, 388, 12, 12);
      c.fillRect(388, 388, 12, 12);
    }
    l.styles = { [styles.id]: styles.cfg };
    const orig = renderers.get(styles.id);
    renderers.set(styles.id, (cfg, env) => { envSizes.push(env.w); return orig(cfg, env); });
    try {
      return compositeDocument(doc);
    } finally {
      renderers.set(styles.id, orig);
    }
  };
  const middle = (cv) => cv.getContext('2d', { willReadFrequently: true }).getImageData(110, 110, 180, 180).data;

  const cases = [
    ['a 60px drop shadow', {
      id: 'dropShadow',
      cfg: {
        ...defaultStyle('dropShadow'), enabled: true, useGlobalLight: false, angle: 90,
        distance: 0, size: 60, spread: 0, opacity: 1, color: '#000000', blendMode: 'normal', noise: 0,
      },
    }],
    ['a 60px outer glow', {
      id: 'outerGlow',
      cfg: {
        ...defaultStyle('outerGlow'), enabled: true, size: 60, spread: 0, opacity: 1,
        color: '#0000ff', blendMode: 'normal', noise: 0,
      },
    }],
    ['a 20px outside stroke', {
      id: 'stroke',
      cfg: {
        ...defaultStyle('stroke'), enabled: true, size: 20, position: 'outside',
        opacity: 1, blendMode: 'normal', fillType: 'color', color: '#00ff00',
      },
    }],
  ];

  for (const [label, styles] of cases) {
    envSizes.length = 0;
    const cropped = build(styles, false);
    const full = build(styles, true);
    // Precondition 1: the two documents must genuinely take different paths.
    t.lt(envSizes[0], 400, `precondition: ${label} on a lone shape is cropped to a sub-region`);
    t.eq(envSizes[1], 400, `precondition: ${label} on edge-to-edge content declines cropping`);
    // Precondition 2: the effect must actually be doing something in the
    // compared region, otherwise "they match" would be meaningless.
    let touched = 0;
    const mid = middle(cropped);
    for (let i = 0; i < mid.length; i += 4) {
      if (mid[i] !== 255 || mid[i + 1] !== 255 || mid[i + 2] !== 255) touched++;
    }
    t.gt(touched, 5000, `precondition: ${label} paints thousands of pixels in the compared region`);
    t.lt(maxDiff(mid, middle(full)), 5, `${label} renders identically cropped and uncropped`);
    t.lt(t.mad(mid, middle(full)), 0.05, `${label} has no measurable mean error from cropping`);
  }

  // No hard seam where the crop region ends. With size 60 and content at
  // x >= 170, the drop-shadow region starts near x = 96; walking across it the
  // value must decay smoothly and be essentially white by the boundary.
  // The scan stops at x = 168, two pixels short of the shape itself, so the only
  // step it can see is a seam in the shadow.
  const shadow = build(cases[0][1], false);
  let worstJump = 0, monotone = true, prev = r(t, shadow, 60, 200);
  for (let x = 61; x <= 168; x++) {
    const v = r(t, shadow, x, 200);
    if (Math.abs(v - prev) > worstJump) worstJump = Math.abs(v - prev);
    if (v > prev) monotone = false;
    prev = v;
  }
  t.lt(worstJump, 4, 'the shadow decays smoothly across the crop boundary — no seam');
  t.ok(monotone, 'and it darkens monotonically towards the shape — no bright halo at the crop edge');
  t.gt(r(t, shadow, 100, 200), 248, 'the effect has faded out before the crop boundary, so nothing is lost');
  t.lt(r(t, shadow, 240, 200), 220, 'while it is unmistakably present just outside the shape');
  t.eq(t.px(shadow, 200, 200), '0,0,0,255', 'and the shape itself is intact');
});

/* ================================================================== */

suite('effects / a tiny mark must keep its effects', async (t) => {
  /**
   * REAL BUG. `effectRegion` measures the content bounds with
   * `alphaBoundsFast`, which downscales the layer by 8 before scanning and
   * claims in its own comment that "any non-empty source block averages to a
   * non-zero alpha ... so this never reports a box smaller than the truth".
   * That is not true: Chrome's downscaler filters a mark of 4px or less away to
   * alpha 0 at unlucky offsets. `alphaBoundsFast` then returns null,
   * `effectRegion` hands back its 1x1 "empty layer: nothing can render" box,
   * and EVERY layer effect on that layer silently disappears — while the mark's
   * own pixels still draw, so the layer just looks like it has no styles.
   *
   * Which offsets fail is stable but depends on the mark's position modulo the
   * 8px grid (for a 4px mark: 30, 38, 46, 54, ... i.e. 6 mod 8; a 1px mark
   * fails at roughly three offsets in four), so nudging a layer by one pixel
   * makes its drop shadow pop in and out. Real content that hits this: hairline
   * pen strokes, 1px shape outlines, small text, dotted/dashed strokes.
   */
  const ring = (mark, p) => {
    const doc = t.doc(400, 400, '#ffffff', 'tiny');
    const l = doc.addLayer(createRasterLayer(400, 400, 'mark'));
    const c = l.canvas.getContext('2d');
    c.fillStyle = '#000000';
    c.fillRect(p, p, mark, mark);
    only(l, 'stroke', {
      size: 6, position: 'outside', blendMode: 'normal', opacity: 1, fillType: 'color', color: '#00ff00',
    });
    // 3px left of the mark, i.e. inside a 6px outside stroke.
    return t.px(compositeDocument(doc), p - 3, p + 1);
  };

  // Controls: marks big enough to survive the downscale work at every offset,
  // so the effect machinery itself is demonstrably fine.
  t.eq(ring(10, 30), '0,255,0,255', 'a 10px mark at offset 30 gets its outside stroke');
  t.eq(ring(6, 30), '0,255,0,255', 'a 6px mark at offset 30 gets its outside stroke');
  t.eq(ring(4, 60), '0,255,0,255', 'a 4px mark at offset 60 gets its outside stroke');

  // The bug: identical layers, only the offset or the size differs.
  t.eq(ring(4, 30), '0,255,0,255', 'a 4px mark at offset 30 must get the same stroke');
  t.eq(ring(3, 30), '0,255,0,255', 'a 3px mark at offset 30 must get its stroke');
  t.eq(ring(1, 24), '0,255,0,255', 'a single-pixel mark must get its stroke too');
});

/* ================================================================== */

suite('effects / cropping declines for a full-canvas layer', async (t) => {
  // The content covers 81% of the canvas, so its padded bounds fill the whole
  // document and effectRegion refuses to crop. The stroke must still render on
  // all four sides, right out to the canvas margin.
  const doc = t.doc(100, 100, '#ffffff', 'nocrop2');
  const layer = doc.addLayer(createRasterLayer(100, 100, 'big'));
  const c = layer.canvas.getContext('2d');
  c.fillStyle = '#ff0000';
  c.fillRect(5, 5, 90, 90);
  only(layer, 'stroke', {
    size: 3, position: 'outside', blendMode: 'normal', opacity: 1, fillType: 'color', color: '#000000',
  });
  const cv = compositeDocument(doc);
  t.eq(t.px(cv, 3, 50), '0,0,0,255', 'the ring renders on the left margin');
  t.eq(t.px(cv, 96, 50), '0,0,0,255', 'the right');
  t.eq(t.px(cv, 50, 3), '0,0,0,255', 'the top');
  t.eq(t.px(cv, 50, 96), '0,0,0,255', 'and the bottom');
  t.eq(t.px(cv, 50, 50), '255,0,0,255', 'the interior is untouched');
  t.eq(t.px(cv, 50, 6), '255,0,0,255', 'and so is just inside the edge');

  // An inner glow on the same layer must respect the document border rather
  // than treating it as a hole.
  only(layer, 'innerGlow', {
    size: 8, choke: 0, opacity: 1, color: '#ffffff', blendMode: 'normal', source: 'edge', noise: 0,
  });
  const cv2 = compositeDocument(doc);
  t.gt(r(t, cv2, 7, 50), 250, 'the inner glow lights the interior edge');
  t.eq(t.px(cv2, 50, 50), '255,0,0,255', 'and leaves the middle of a full-canvas layer alone');
  t.eq(t.px(cv2, 2, 50), '255,255,255,255', 'without spilling into the margin');
});
