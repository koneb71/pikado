import { suite } from '../harness.js';
import { makeTip, brushFromOptions, DEFAULT_BRUSH, PaintStroke, EffectStroke } from '/src/paint/brush-engine.js';
import { createRasterLayer } from '/src/core/layer.js';
import { Selection } from '/src/core/selection.js';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** Alpha byte of one pixel. */
function alphaAt(canvas, x, y) {
  return canvas.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data[3];
}

function rgbaAt(canvas, x, y) {
  return [...canvas.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data];
}

/**
 * A brush with every dynamic switched off, so a dab's geometry is a pure
 * function of the arguments. `pressureSize` and `smoothing` default ON in
 * DEFAULT_BRUSH and would make the maths unknowable.
 */
function B(o) {
  return {
    size: 16, hardness: 1, opacity: 1, flow: 1, spacing: 0.1,
    smoothing: 0, pressureSize: false, pressureOpacity: false,
    sizeJitter: 0, opacityJitter: 0, scatter: 0, angleJitter: 0, airbrush: false,
    ...o,
  };
}

/** How many pixels along the tip's horizontal centre line are partial alpha. */
function softEdgePixels(tip) {
  const d = tip.getContext('2d', { willReadFrequently: true })
    .getImageData(0, (tip.height / 2) | 0, tip.width, 1).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 8 && d[i] < 247) n++;
  return n;
}

/* ------------------------------------------------------------------ */
/* Tips                                                                */
/* ------------------------------------------------------------------ */

suite('paint / makeTip geometry', async (t) => {
  // A tip canvas is size + 2 so a rotated ellipse always fits.
  t.eq(makeTip({ size: 20, hardness: 1 }).width, 22, 'a size-20 tip is a 22px canvas (size + 2 padding)');
  t.eq(makeTip({ size: 20.4, hardness: 1 }).width, 22, 'the size is rounded, not floored');
  t.eq(makeTip({ size: 1, hardness: 1 }).width, 3, 'a 1px tip still has its padding');

  // hardness. Both tips are size 20 => 22px canvas, centre (11,11), radius 10.
  const hard = makeTip({ size: 20, hardness: 1 });
  const soft = makeTip({ size: 20, hardness: 0 });
  t.eq(alphaAt(hard, 11, 11), 255, 'a hard tip is opaque at the centre');
  // hardness 0 means the falloff starts at the very centre, so the centre pixel
  // is near-opaque rather than exactly 255.
  t.gt(alphaAt(soft, 11, 11), 220, 'a soft tip is near-opaque at the centre');
  // 13/15/17/19 are 25% / 45% / 65% / 85% of the radius out along y = 11.
  t.eq([alphaAt(hard, 13, 11), alphaAt(hard, 15, 11), alphaAt(hard, 17, 11), alphaAt(hard, 19, 11)],
    [255, 255, 255, 255], 'a hard tip stays fully opaque out to 85% of its radius');
  const s13 = alphaAt(soft, 13, 11), s15 = alphaAt(soft, 15, 11);
  const s17 = alphaAt(soft, 17, 11), s19 = alphaAt(soft, 19, 11);
  t.lt(s13, alphaAt(soft, 11, 11), 'a soft tip has already fallen off at 25% of the radius');
  t.ok(s13 > s15 && s15 > s17 && s17 > s19, `a soft tip falls off monotonically (${s13},${s15},${s17},${s19})`);
  t.lt(s19, 60, 'the soft tip is nearly transparent at 85% of the radius');
  // The edge is where hard and soft genuinely differ.
  t.lt(softEdgePixels(hard), 5, 'a hard tip has at most a 2px antialiased rim per side');
  t.gt(softEdgePixels(soft), 12, 'a soft tip is partial alpha across most of its width');

  // roundness — measured on the aliased tip so the answer is exact.
  // dim 22, centre 11; inside iff dx^2 + (dy/roundness)^2 <= 100 with
  // dx = x + 0.5 - 11, dy = y + 0.5 - 11.
  const flat = makeTip({ size: 20, hardness: 1, roundness: 0.5, antialias: false });
  t.eq(alphaAt(flat, 20, 11), 255, 'roundness 0.5 keeps the full 20px width (x=20 is inside)');
  t.eq(alphaAt(flat, 21, 11), 0, 'and stops there (x=21 is outside)');
  t.eq(alphaAt(flat, 11, 15), 255, 'roundness 0.5 squashes the height to 10px (y=15 is inside)');
  t.eq(alphaAt(flat, 11, 16), 0, 'and stops there (y=16 is outside)');
  const round = makeTip({ size: 20, hardness: 1, roundness: 1, antialias: false });
  let nFlat = 0, nRound = 0;
  const fd = flat.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 22, 22).data;
  const rd = round.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 22, 22).data;
  for (let i = 3; i < fd.length; i += 4) { if (fd[i]) nFlat++; if (rd[i]) nRound++; }
  t.close(nRound / nFlat, 2, 0.15, 'halving the roundness halves the tip area');

  // angle. roundness 0.25 makes a 40x10 ellipse; rotating 90 degrees must make
  // it 10x40. dim 42, centre 21.
  const wide = makeTip({ size: 40, hardness: 1, roundness: 0.25, angle: 0 });
  const tall = makeTip({ size: 40, hardness: 1, roundness: 0.25, angle: 90 });
  t.eq([alphaAt(wide, 36, 21), alphaAt(wide, 21, 36)], [255, 0], 'angle 0 with roundness 0.25 is wide and flat');
  t.eq([alphaAt(tall, 36, 21), alphaAt(tall, 21, 36)], [0, 255], 'angle 90 rotates that ellipse upright');

  // antialias:false — the pencil tip. Strictly binary alpha, no grey.
  const pencil = makeTip({ size: 15, hardness: 1, antialias: false });
  const pd = pencil.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, pencil.width, pencil.height).data;
  let bad = 0, opaque = 0, clear = 0, colored = 0;
  for (let i = 0; i < pd.length; i += 4) {
    const a = pd[i + 3];
    if (a === 255) opaque++; else if (a === 0) clear++; else bad++;
    if (pd[i] || pd[i + 1] || pd[i + 2]) colored++;
  }
  t.eq(bad, 0, 'an aliased tip contains no partial alpha at all');
  t.ok(opaque > 0 && clear > 0, `an aliased tip has both solid and empty pixels (${opaque}/${clear})`);
  t.eq(colored, 0, 'a tip stores its shape in alpha only, RGB stays 0');
  // The antialiased tip of the same spec must NOT be binary — proves the flag matters.
  const aaSame = makeTip({ size: 15, hardness: 1, antialias: true });
  const ad = aaSame.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, aaSame.width, aaSame.height).data;
  let partial = 0;
  for (let i = 3; i < ad.length; i += 4) if (ad[i] > 0 && ad[i] < 255) partial++;
  t.gt(partial, 0, 'the antialiased tip of the same spec does have partial alpha');

  // Cache identity.
  const spec = { size: 24, hardness: 0.7, angle: 15, roundness: 0.8 };
  t.ok(makeTip(spec) === makeTip({ ...spec }), 'identical specs return the identical cached canvas');
  t.ok(makeTip(spec) !== makeTip({ ...spec, hardness: 0.71 }),
    'a different hardness is a different cache entry');
  t.ok(makeTip(spec) !== makeTip({ ...spec, antialias: false }),
    'the antialias flag is part of the cache key');
});

/* ------------------------------------------------------------------ */
/* PaintStroke — colour along the path                                 */
/* ------------------------------------------------------------------ */

suite('paint / PaintStroke lays colour on the path only', async (t) => {
  const doc = t.doc(100, 100, 'transparent', 'stroke');
  const layer = doc.activeLayer();
  t.eq(t.px(layer.canvas, 50, 50), '0,0,0,0', 'precondition: the layer starts empty');

  const s = new PaintStroke({
    doc, layer, target: layer.canvas, color: '#ff0000',
    brush: B({ size: 10, hardness: 1, spacing: 0.1 }),
  });
  s.begin(20, 50, 1);
  s.move(80, 50, 1);
  s.end();
  s.flush();

  t.eq(t.px(layer.canvas, 50, 50), '255,0,0,255', 'the stroke centre is the requested colour at full alpha');
  t.eq(t.px(layer.canvas, 20, 50), '255,0,0,255', 'the very first dab landed at the start point');
  t.eq(t.px(layer.canvas, 80, 50), '255,0,0,255', 'and the last dab at the end point');
  t.eq(t.px(layer.canvas, 50, 40), '0,0,0,0', '10px above the path (radius 5) is untouched');
  t.eq(t.px(layer.canvas, 10, 50), '0,0,0,0', 'before the start of the path is untouched');
  t.eq(t.px(layer.canvas, 90, 50), '0,0,0,0', 'past the end of the path is untouched');

  // The dirty box is what tells a tool whether anything changed at all.
  t.ok(s.dirty && s.dirty.x0 <= 15 && s.dirty.x1 >= 85, `dirty box spans the stroke (${JSON.stringify(s.dirty)})`);

  // A dab entirely off-canvas must not claim to have touched anything.
  const off = new PaintStroke({ doc, layer, target: layer.canvas, color: '#00ff00', brush: B({ size: 8 }) });
  off.begin(-400, -400, 1);
  off.end();
  t.eq(off.dirty, null, 'a stroke entirely off-canvas reports no dirty region');

  // {r,g,b,a} colours work as well as CSS strings.
  const l2 = createRasterLayer(100, 100, 'obj colour');
  doc.addLayer(l2);
  const s2 = new PaintStroke({
    doc, layer: l2, target: l2.canvas, color: { r: 0, g: 0, b: 255, a: 1 }, brush: B({ size: 10 }),
  });
  s2.begin(50, 50, 1);
  s2.end();
  s2.flush();
  t.eq(t.px(l2.canvas, 50, 50), '0,0,255,255', 'an {r,g,b,a} colour object is accepted');
});

/* ------------------------------------------------------------------ */
/* The opacity / flow model                                            */
/* ------------------------------------------------------------------ */

suite('paint / opacity caps a stroke, flow builds within it', async (t) => {
  const doc = t.doc(60, 60, 'transparent', 'flow');

  /* opacity 0.5, flow 1: overlap as much as you like, 50% is the ceiling. */
  const capL = doc.activeLayer();
  const cap = new PaintStroke({
    doc, layer: capL, target: capL.canvas, color: '#ff0000',
    brush: B({ size: 16, opacity: 0.5, flow: 1 }),
  });
  cap.stamp(30, 30, 1);
  cap.flush();
  const a1 = alphaAt(capL.canvas, 30, 30);
  t.close(a1, 128, 2, 'one dab at opacity 0.5 / flow 1 is 50% alpha (128)');
  for (let i = 0; i < 8; i++) cap.stamp(30, 30, 1);
  cap.flush();
  const a9 = alphaAt(capL.canvas, 30, 30);
  t.eq(a9, a1, 'nine overlapping dabs give the identical alpha — opacity caps the whole stroke');
  t.lt(a9, 140, 'a self-overlapping opacity-0.5 stroke never exceeds 50% coverage');

  // Same thing along an overlapping path rather than a single point, because
  // that is what a user actually does.
  const back = createRasterLayer(60, 60, 'back and forth');
  doc.addLayer(back);
  const bs = new PaintStroke({
    doc, layer: back, target: back.canvas, color: '#ff0000',
    brush: B({ size: 16, opacity: 0.5, flow: 1, spacing: 0.05 }),
  });
  bs.begin(10, 30, 1);
  bs.move(50, 30, 1);
  bs.move(10, 30, 1);
  bs.move(50, 30, 1);
  bs.end();
  bs.flush();
  t.gt(bs.dabCount, 100, `the path really did overlap itself (${bs.dabCount} dabs)`);
  t.close(alphaAt(back.canvas, 30, 30), 128, 3, 'painting back and forth still stops at 50% alpha');

  /* opacity 1, low flow: each dab adds 1-(1-flow) of what is missing. */
  const buildL = createRasterLayer(60, 60, 'build up');
  doc.addLayer(buildL);
  const build = new PaintStroke({
    doc, layer: buildL, target: buildL.canvas, color: '#ff0000',
    brush: B({ size: 16, opacity: 1, flow: 0.25 }),
  });
  const seq = [];
  for (let i = 0; i < 8; i++) {
    build.stamp(30, 30, 1);
    build.flush();
    seq.push(alphaAt(buildL.canvas, 30, 30));
  }
  t.close(seq[0], 64, 2, 'one dab at flow 0.25 is 25% alpha (255 * 0.25 = 64)');
  t.close(seq[1], 112, 3, 'two dabs reach 1 - 0.75^2 = 44% (112)');
  t.close(seq[3], 174, 4, 'four dabs reach 1 - 0.75^4 = 68% (174)');
  t.close(seq[7], 230, 6, 'eight dabs build up to 1 - 0.75^8 = 90% (230)');
  t.ok(seq.every((v, i) => i === 0 || v > seq[i - 1]), `flow build-up is monotonic (${seq.join(',')})`);
  t.lt(seq[7], 255, 'flow approaches full opacity without reaching it');

  // And with flow 1 / opacity 1 a single dab is already solid — the control.
  const solidL = createRasterLayer(60, 60, 'solid');
  doc.addLayer(solidL);
  const solid = new PaintStroke({
    doc, layer: solidL, target: solidL.canvas, color: '#ff0000', brush: B({ size: 16 }),
  });
  solid.stamp(30, 30, 1);
  solid.flush();
  t.eq(alphaAt(solidL.canvas, 30, 30), 255, 'flow 1 / opacity 1 is fully opaque in one dab');
});

/* ------------------------------------------------------------------ */
/* Modes and clipping                                                  */
/* ------------------------------------------------------------------ */

suite('paint / erase, lockTransparency and selection clipping', async (t) => {
  const doc = t.doc(100, 100, 'transparent', 'clip');

  /* erase */
  const eL = doc.activeLayer();
  t.fill(eL, '#ff0000');
  t.eq(t.px(eL.canvas, 50, 50), '255,0,0,255', 'precondition: the layer is solid red');
  const er = new PaintStroke({
    doc, layer: eL, target: eL.canvas, mode: 'erase', brush: B({ size: 20, hardness: 1 }),
  });
  er.stamp(50, 50, 1);
  er.flush();
  t.eq(t.px(eL.canvas, 50, 50), '0,0,0,0', 'mode "erase" removes pixels entirely');
  t.eq(t.px(eL.canvas, 90, 50), '255,0,0,255', 'erasing leaves everything outside the dab alone');

  /* lockTransparency: red only in the left half, paint blue across the middle */
  const lockL = createRasterLayer(100, 100, 'locked');
  doc.addLayer(lockL);
  t.fill(lockL, '#ff0000', 0, 0, 50, 100);
  const lock = new PaintStroke({
    doc, layer: lockL, target: lockL.canvas, color: '#0000ff',
    lockTransparency: true, brush: B({ size: 20, spacing: 0.1 }),
  });
  lock.begin(20, 50, 1);
  lock.move(80, 50, 1);
  lock.end();
  lock.flush();
  t.eq(t.px(lockL.canvas, 25, 50), '0,0,255,255', 'lockTransparency lets paint land on existing pixels');
  t.eq(t.px(lockL.canvas, 75, 50), '0,0,0,0', 'lockTransparency keeps paint off transparent pixels');

  // Control: the identical stroke without the lock DOES reach x=75, so the
  // assertion above cannot pass for the wrong reason.
  const freeL = createRasterLayer(100, 100, 'unlocked');
  doc.addLayer(freeL);
  t.fill(freeL, '#ff0000', 0, 0, 50, 100);
  const free = new PaintStroke({
    doc, layer: freeL, target: freeL.canvas, color: '#0000ff', brush: B({ size: 20, spacing: 0.1 }),
  });
  free.begin(20, 50, 1);
  free.move(80, 50, 1);
  free.end();
  free.flush();
  t.eq(t.px(freeL.canvas, 75, 50), '0,0,255,255', 'control: without the lock the same stroke reaches x=75');

  /* selection clipping */
  doc.selection.combine(Selection.rectMask(0, 0, 50, 100, 100, 100), 'replace');
  t.ok(doc.selection.active, 'precondition: a selection is active');
  const selL = createRasterLayer(100, 100, 'selected');
  doc.addLayer(selL);
  const sel = new PaintStroke({
    doc, layer: selL, target: selL.canvas, color: '#00ff00', brush: B({ size: 20, spacing: 0.1 }),
  });
  sel.begin(20, 50, 1);
  sel.move(80, 50, 1);
  sel.end();
  sel.flush();
  t.eq(t.px(selL.canvas, 25, 50), '0,255,0,255', 'paint lands inside the selection');
  t.eq(t.px(selL.canvas, 75, 50), '0,0,0,0', 'an active selection confines the stroke');
  t.eq(t.px(selL.canvas, 49, 50), '0,255,0,255', 'right up to the selection edge');

  // selectionClip:false opts out — again proving the clip above did the work.
  const ignL = createRasterLayer(100, 100, 'ignores selection');
  doc.addLayer(ignL);
  const ign = new PaintStroke({
    doc, layer: ignL, target: ignL.canvas, color: '#00ff00',
    selectionClip: false, brush: B({ size: 20, spacing: 0.1 }),
  });
  ign.begin(20, 50, 1);
  ign.move(80, 50, 1);
  ign.end();
  ign.flush();
  t.eq(t.px(ignL.canvas, 75, 50), '0,255,0,255', 'selectionClip:false ignores the selection');
});

/* ------------------------------------------------------------------ */
/* Spacing                                                             */
/* ------------------------------------------------------------------ */

suite('paint / spacing controls the dab count', async (t) => {
  const doc = t.doc(100, 100, 'transparent', 'spacing');

  function run(spacing) {
    const l = createRasterLayer(100, 100, `sp ${spacing}`);
    doc.addLayer(l);
    const s = new PaintStroke({
      doc, layer: l, target: l.canvas, color: '#000000',
      brush: B({ size: 10, hardness: 1, spacing }),
    });
    s.begin(10, 50, 1);
    s.move(90, 50, 1);
    s.end();
    s.flush();
    return { dabs: s.dabCount, inked: t.inked(l.canvas) };
  }

  // step = spacing * size, so an 80px path emits floor(80 / step) dabs on top of
  // the one begin() lays down.
  const tight = run(0.1);   // step 1  -> 80 + 1
  const wide = run(1.0);    // step 10 -> 8 + 1
  const huge = run(4.0);    // step 40 -> 2 + 1
  t.eq(tight.dabs, 81, 'spacing 0.1 on a size-10 brush emits 81 dabs over 80px');
  t.eq(wide.dabs, 9, 'spacing 1.0 emits 9 dabs over the same path');
  t.eq(huge.dabs, 3, 'spacing 4.0 emits only 3 dabs');
  t.lt(wide.inked, tight.inked, 'wider spacing inks fewer pixels');
  t.lt(huge.inked, wide.inked, 'wider still inks fewer again');
  t.gt(tight.inked, 700, `the tight stroke really is a solid line (${tight.inked} px)`);
});

/* ------------------------------------------------------------------ */
/* EffectStroke                                                        */
/* ------------------------------------------------------------------ */

suite('paint / EffectStroke blends the op through the tip', async (t) => {
  const doc = t.doc(100, 100, 'transparent', 'effect');
  const layer = doc.activeLayer();
  t.fill(layer, '#ff0000');

  const seen = [];
  // hardness 0.5 gives a solid core out to 46% of the radius and a soft ramp
  // beyond it, so the centre and the rim get measurably different coverage.
  const st = new EffectStroke({
    doc, layer, target: layer.canvas, strength: 0.5,
    brush: B({ size: 40, hardness: 0.5 }),
    op(region, meta) {
      seen.push({
        first: [...region.data.slice(0, 4)],
        rectX: meta.rectX, rectY: meta.rectY, w: meta.width, h: meta.height,
        size: meta.size, strength: meta.strength,
      });
      const d = region.data;
      for (let i = 0; i < d.length; i += 4) { d[i] = 0; d[i + 1] = 255; d[i + 2] = 0; d[i + 3] = 255; }
      return region;
    },
  });
  st.stamp(50, 50, 1);

  t.eq(seen.length, 1, 'the op ran once per dab');
  t.eq(seen[0].first, [255, 0, 0, 255], 'the op receives the pixels that were already under the dab');
  // dim = 42, rx = round(50 - 21) = 29 and the whole tip fits inside 100x100.
  t.eq([seen[0].rectX, seen[0].rectY, seen[0].w, seen[0].h], [29, 29, 42, 42],
    'the region handed to the op is the tip-sized rect under the dab');
  t.eq(seen[0].size, 40, 'meta.size is the post-dynamics dab size');
  t.close(seen[0].strength, 0.5, 1e-9, 'meta.strength is strength x per-dab alpha');

  // Centre: tip alpha 255 * flow 1 => coverage 1 => the op result wins outright.
  t.eq(t.px(layer.canvas, 50, 50), '0,255,0,255', 'the dab centre is fully replaced by the op result');
  // Rim (68% of the radius, out in the ramp): partial tip alpha => a genuine
  // lerp between the old and the new colour.
  const rim = rgbaAt(layer.canvas, 63, 50);
  t.gt(rim[1], 20, `the rim moved towards the op result (g=${rim[1]})`);
  t.lt(rim[1], 235, `but not all the way (g=${rim[1]})`);
  t.close(rim[0] + rim[1], 255, 3, 'the rim is an exact lerp of red -> green through the tip alpha');
  t.lt(rim[1], rgbaAt(layer.canvas, 50, 50)[1], 'the centre therefore changed more than the rim');
  // Outside the tip rect nothing at all happens.
  t.eq(t.px(layer.canvas, 95, 50), '255,0,0,255', 'pixels outside the dab are untouched');
  t.eq(t.px(layer.canvas, 28, 50), '255,0,0,255', 'one pixel outside the dab rect is untouched');

  // An op that returns nothing still has its in-place mutation used.
  const l2 = createRasterLayer(100, 100, 'in place');
  doc.addLayer(l2);
  t.fill(l2, '#ff0000');
  const st2 = new EffectStroke({
    doc, layer: l2, target: l2.canvas, brush: B({ size: 20, hardness: 1 }),
    op(region) {
      const d = region.data;
      for (let i = 0; i < d.length; i += 4) { d[i] = 0; d[i + 2] = 255; }
    },
  });
  st2.stamp(50, 50, 1);
  t.eq(t.px(l2.canvas, 50, 50), '0,0,255,255', 'an op that mutates in place and returns void still applies');
  t.eq(st2.dabCount, 1, 'the dab counter advanced');
});

/* ------------------------------------------------------------------ */
/* brushFromOptions                                                    */
/* ------------------------------------------------------------------ */

suite('paint / brushFromOptions maps 0..100 onto 0..1', async (t) => {
  const b = brushFromOptions({
    size: 50, hardness: 40, opacity: 60, flow: 30, smoothing: 80, airbrush: true,
    spacing: 25, angle: 45, roundness: 50,
    sizeJitter: 10, opacityJitter: 20, scatter: 30, angleJitter: 40,
  });
  t.eq({
    size: b.size, hardness: b.hardness, opacity: b.opacity, flow: b.flow,
    smoothing: b.smoothing, airbrush: b.airbrush, spacing: b.spacing,
    angle: b.angle, roundness: b.roundness,
    sizeJitter: b.sizeJitter, opacityJitter: b.opacityJitter,
    scatter: b.scatter, angleJitter: b.angleJitter,
  }, {
    size: 50, hardness: 0.4, opacity: 0.6, flow: 0.3,
    smoothing: 0.8, airbrush: true, spacing: 0.25,
    angle: 45, roundness: 0.5,
    sizeJitter: 0.1, opacityJitter: 0.2, scatter: 0.3, angleJitter: 0.4,
  }, 'every percentage option becomes its 0..1 engine setting (size and angle stay raw)');

  const d = brushFromOptions({});
  t.eq([d.size, d.hardness, d.opacity, d.flow, d.spacing, d.roundness, d.airbrush],
    [30, 0.85, 1, 1, 0.08, 1, false], 'an empty options state falls back to the documented defaults');
  t.close(d.smoothing, 0.2, 1e-9, 'the options-bar smoothing default is 20%, not DEFAULT_BRUSH.smoothing');
  t.eq(DEFAULT_BRUSH.smoothing, 0.35, 'DEFAULT_BRUSH itself still smooths at 0.35');
  t.eq(d.shape, 'round', 'unmapped DEFAULT_BRUSH keys are carried through');

  // `extra` wins — this is how the pencil forces a hard aliased tip.
  const pencil = brushFromOptions({ size: 8, hardness: 20 }, { hardness: 1, antialias: false, spacing: 0.05 });
  t.eq([pencil.size, pencil.hardness, pencil.antialias, pencil.spacing], [8, 1, false, 0.05],
    'the `extra` argument overrides the mapped values');
  t.eq(brushFromOptions({ airbrush: 1 }).airbrush, true, 'airbrush is coerced to a boolean');
});
