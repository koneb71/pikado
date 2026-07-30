import { suite } from '../harness.js';
import { compositeDocument, getComposite, blendOnto } from '/src/render/compositor.js';
import { blendOnGPU, shouldBlendOnGPU, canBlendOnGPU, isGPUModeSupported } from '/src/render/gpu-blend.js';
import { BLEND_MODES, blendCPU, isNativeBlend } from '/src/core/blend.js';
import { createRasterLayer, createGroupLayer, createAdjustmentLayer } from '/src/core/layer.js';
import { createCanvas, ctx2dRead } from '/src/core/util.js';
import { defaultStyle } from '/src/effects/styles.js';

/**
 * Compositing semantics, locked to exact pixel maths.
 *
 * The blend-mode ground truth uses two colour pairs chosen so that every value
 * lands on a whole number:
 *
 *   pair A  base #aa5500 = (170, 85, 0)   top #33cc66 = (51, 204, 102)
 *   pair B  base #3366c8 = (51, 102, 200) top #9999ff = (153, 153, 255)
 *
 * 170/85/0 are exact thirds of 255 and 51/102/153/204 exact fifths, so products
 * b*s/255 (multiply, screen, overlay, hard light, exclusion) are integers with
 * no rounding to argue about. Pair B exists only for Divide, where b*255/s has
 * to divide exactly.
 *
 * Both surfaces are fully opaque, so every mode collapses to
 * `result = clamp(blend(b, s))` — for the native Canvas2D modes by the W3C
 * compositing spec, and for the CPU modes because blendCPU's ra/cs terms reduce
 * to the blend value when sa = ba = 1.
 */

/* Pixel as numbers rather than the harness' "r,g,b,a" string. */
function chans(t, canvas, x, y) {
  return t.px(canvas, x, y).split(',').map(Number);
}

/** Assert a pixel within `tol` counts per channel, reporting what we got. */
function nearPixel(t, canvas, x, y, expected, tol, message) {
  const got = chans(t, canvas, x, y);
  const d = Math.max(...expected.map((v, i) => Math.abs(got[i] - v)));
  t.close(d, 0, tol, `${message} (want ~${expected.join(',')}, got ${got.join(',')})`);
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

/* ------------------------------------------------------------------ */

suite('compositor / all 27 blend modes, exact', async (t) => {
  const doc = t.doc(24, 16, '#ffffff', 'blend');
  const baseId = doc.activeLayer().id;
  const topId = doc.addLayer(createRasterLayer(24, 16, 'top')).id;

  const blend = (baseColor, topColor, mode, opacity = 1) => {
    const b = doc.findLayer(baseId), s = doc.findLayer(topId);
    t.fill(b, baseColor);
    t.fill(s, topColor);
    s.blendMode = mode;
    s.opacity = opacity;
    return compositeDocument(doc);
  };

  const A_BASE = '#aa5500', A_TOP = '#33cc66';   // (170,85,0) over/under (51,204,102)
  const B_BASE = '#3366c8', B_TOP = '#9999ff';   // (51,102,200) / (153,153,255)

  // Hand-computed, exact. See the header for why these are integers.
  const EXACT = {
    normal: '51,204,102,255',
    dissolve: '51,204,102,255',          // sa == 1 => every pixel takes the source
    darken: '51,85,0,255',
    multiply: '34,68,0,255',             // 170*51/255, 85*204/255, 0
    'linear-burn': '0,34,0,255',         // b+s-255 clamped
    'darker-color': '170,85,0,255',      // lum 101.15 vs 146.88 -> keeps the backdrop
    lighten: '170,204,102,255',
    screen: '187,221,102,255',           // 255-(255-b)(255-s)/255
    'linear-dodge': '221,255,102,255',   // b+s clamped
    'lighter-color': '51,204,102,255',
    overlay: '119,136,0,255',
    'hard-light': '68,187,0,255',
    'linear-light': '17,238,0,255',      // b+2s-255
    'pin-light': '102,153,0,255',
    'hard-mix': '0,255,0,255',           // b+2s-255 >= 127.5 ? 255 : 0
    difference: '119,119,102,255',
    exclusion: '153,153,102,255',        // b+s-2bs/255
    subtract: '119,0,0,255',             // b-s clamped
  };

  // Modes whose exact value is a half-count (or, for the non-separable four,
  // depends on the platform's rounding of the luminosity maths). The expected
  // triples are still computed by hand from the spec, only the last count is
  // allowed to move.
  const NEAR = {
    'color-burn': [[0, 42, 0], 1],        // 1-min(1,(1-b)/s): 0, 42.5, 0
    'color-dodge': [[212, 255, 0], 1],    // min(1,b/(1-s)): 212.5, 255, 0
    'soft-light': [[136, 122, 0], 3],
    'vivid-light': [[42, 212, 0], 1],
    hue: [[0, 161, 54], 2],
    saturation: [[163, 87, 10], 2],
    color: [[5, 158, 56], 2],
    luminosity: [[216, 131, 46], 2],
  };

  t.eq(Object.keys(EXACT).length + Object.keys(NEAR).length + 1, 27,
    'every one of the 27 modes has a ground-truth expectation (+1 for divide)');

  for (const m of BLEND_MODES) {
    if (m.id === 'divide') {
      // b*255/s: 51*255/153=85, 102*255/153=170, 200*255/255=200.
      t.eq(t.px(blend(B_BASE, B_TOP, 'divide'), 12, 8), '85,170,200,255',
        'divide is exact: (51,102,200) / (153,153,255) = (85,170,200)');
      continue;
    }
    const cv = blend(A_BASE, A_TOP, m.id);
    if (EXACT[m.id]) t.eq(t.px(cv, 12, 8), EXACT[m.id], `${m.id} composites (170,85,0) under (51,204,102) exactly`);
    else {
      const [exp, tol] = NEAR[m.id];
      nearPixel(t, cv, 12, 8, [...exp, 255], tol, `${m.id} composites (170,85,0) under (51,204,102)`);
    }
  }

  // The value quoted in the architecture notes, as a second independent pair.
  t.eq(t.px(blend('#ff8080', '#80ff80', 'multiply'), 12, 8), '128,128,64,255',
    'multiply of #ff8080 under #80ff80 is exactly 128,128,64,255');

  // A transparent source must leave the backdrop untouched on the CPU path too.
  const clear = doc.findLayer(topId);
  clear.blendMode = 'vivid-light';
  clear.canvas.getContext('2d').clearRect(0, 0, 24, 16);
  t.fill(doc.findLayer(baseId), A_BASE);
  t.eq(t.px(compositeDocument(doc), 12, 8), '170,85,0,255',
    'a fully transparent source leaves the backdrop exactly as it was');
});

/* ------------------------------------------------------------------ */

suite('compositor / layer opacity vs fill opacity', async (t) => {
  const doc = t.doc(40, 40, '#000000', 'opacity');
  const baseId = doc.activeLayer().id;
  const top = doc.addLayer(createRasterLayer(40, 40, 'top'));
  const topId = top.id;
  t.fill(top, '#ffffff');

  const at = () => chans(t, compositeDocument(doc), 20, 20);

  t.eq(at().join(','), '255,255,255,255', 'a fully opaque layer hides the backdrop');

  doc.findLayer(topId).opacity = 0.2;
  nearPixel(t, compositeDocument(doc), 20, 20, [51, 51, 51, 255], 2,
    'layer opacity 0.2 puts white over black at 51/255');

  doc.findLayer(topId).opacity = 1;
  doc.findLayer(topId).fillOpacity = 0.2;
  nearPixel(t, compositeDocument(doc), 20, 20, [51, 51, 51, 255], 2,
    'fill opacity 0.2 alone does the same to plain pixels');

  doc.findLayer(topId).opacity = 0.5;
  nearPixel(t, compositeDocument(doc), 20, 20, [26, 26, 26, 255], 3,
    'layer opacity and fill opacity multiply (0.5 * 0.2)');

  // Now the part that actually distinguishes them: effects.
  const fx = t.doc(60, 60, '#ffffff', 'fillfx');
  const shapeId = fx.addLayer(createRasterLayer(60, 60, 'shape')).id;
  const sc = fx.findLayer(shapeId).canvas.getContext('2d');
  sc.fillStyle = '#000000';
  sc.fillRect(20, 20, 20, 20);

  const shape = fx.findLayer(shapeId);
  shape.fillOpacity = 0;
  t.eq(t.px(compositeDocument(fx), 30, 30), '255,255,255,255',
    'precondition: fill opacity 0 with no effects hides the layer completely');

  shape.styles = { colorOverlay: { ...defaultStyle('colorOverlay'), enabled: true, color: '#ff0000', opacity: 1 } };
  t.eq(t.px(compositeDocument(fx), 30, 30), '255,0,0,255',
    'fill opacity 0 hides the pixels but leaves a layer effect at full strength');
  t.eq(t.px(compositeDocument(fx), 5, 5), '255,255,255,255',
    'the effect stays inside the layer coverage');

  shape.fillOpacity = 1;
  shape.opacity = 0.2;
  nearPixel(t, compositeDocument(fx), 30, 30, [255, 204, 204, 255], 2,
    'layer opacity DOES scale the effect (red at 20% over white)');
});

/* ------------------------------------------------------------------ */

suite('compositor / layer masks', async (t) => {
  const doc = t.doc(60, 40, '#ffffff', 'mask');
  const top = doc.addLayer(createRasterLayer(60, 40, 'red'));
  const topId = top.id;
  t.fill(top, '#ff0000');

  top.addMask(60, 40, '#ffffff');
  const mc = top.mask.getContext('2d');
  mc.fillStyle = '#000000'; mc.fillRect(0, 0, 20, 40);
  mc.fillStyle = '#ffffff'; mc.fillRect(20, 0, 20, 40);
  mc.fillStyle = '#808080'; mc.fillRect(40, 0, 20, 40);
  top.touchMask();

  let cv = compositeDocument(doc);
  t.eq(t.px(cv, 10, 20), '255,255,255,255', 'a black mask region hides the layer entirely');
  t.eq(t.px(cv, 30, 20), '255,0,0,255', 'a white mask region shows it fully');
  t.ne(t.px(cv, 10, 20), t.px(cv, 30, 20), 'precondition: masked and unmasked pixels genuinely differ');
  // 0.299+0.587+0.114 == 1, so #808080 is mask alpha 128 exactly.
  nearPixel(t, cv, 50, 20, [255, 127, 127, 255], 2, 'mid-grey mask gives 128/255 coverage');

  doc.findLayer(topId).maskEnabled = false;
  cv = compositeDocument(doc);
  t.eq(t.px(cv, 10, 20), '255,0,0,255', 'disabling the mask restores the hidden pixels');
  t.eq(t.px(cv, 50, 20), '255,0,0,255', 'and the partial region too');

  const l = doc.findLayer(topId);
  l.maskEnabled = true;
  l.maskInverted = true;
  l.touchMask();                     // the alpha cache keys off maskVersion
  cv = compositeDocument(doc);
  t.eq(t.px(cv, 10, 20), '255,0,0,255', 'inverting the mask reveals what was hidden');
  t.eq(t.px(cv, 30, 20), '255,255,255,255', 'and hides what was shown');
  nearPixel(t, cv, 50, 20, [255, 128, 128, 255], 3, 'the mid-grey region stays partial when inverted');
});

/* ------------------------------------------------------------------ */

suite('compositor / clipping masks', async (t) => {
  // A clipped layer is limited to the base's alpha.
  const doc = t.doc(80, 60, '#ffffff', 'clip');
  const base = doc.addLayer(createRasterLayer(80, 60, 'base'));
  const bc = base.canvas.getContext('2d');
  bc.fillStyle = '#ff0000';
  bc.fillRect(10, 10, 40, 30);
  const clip = doc.addLayer(createRasterLayer(80, 60, 'clip'));
  t.fill(clip, '#0000ff');

  t.eq(t.px(compositeDocument(doc), 60, 45), '0,0,255,255',
    'precondition: unclipped, the top layer covers the whole canvas');
  clip.clipped = true;
  let cv = compositeDocument(doc);
  t.eq(t.px(cv, 20, 20), '0,0,255,255', 'a clipped layer paints inside the base');
  t.eq(t.px(cv, 60, 45), '255,255,255,255', 'and is cut away outside the base alpha');

  // The BASE's blend mode governs the whole clip group.
  const d2 = t.doc(80, 60, '#aaaaaa', 'clipblend');
  const b2 = d2.addLayer(createRasterLayer(80, 60, 'base'));
  const b2c = b2.canvas.getContext('2d');
  b2c.fillStyle = '#ffffff';
  b2c.fillRect(10, 10, 40, 30);
  b2.blendMode = 'multiply';
  const c2 = d2.addLayer(createRasterLayer(80, 60, 'clip'));
  t.fill(c2, '#999999');
  c2.clipped = true;
  c2.blendMode = 'normal';
  cv = compositeDocument(d2);
  // 170 * 153 / 255 = 102 exactly.
  t.eq(t.px(cv, 30, 25), '102,102,102,255',
    "the base's Multiply applies to the clip group's pixels (170*153/255)");
  t.ne(t.px(cv, 30, 25), '153,153,153,255',
    "the clipped layer's own Normal does not win over the base's blend mode");
  t.eq(t.px(cv, 70, 50), '170,170,170,255', 'outside the base the backdrop is untouched');

  // A run of clipped layers all clip to the same base.
  const d3 = t.doc(80, 60, '#ffffff', 'cliprun');
  const b3 = d3.addLayer(createRasterLayer(80, 60, 'base'));
  const b3c = b3.canvas.getContext('2d');
  b3c.fillStyle = '#ff0000';
  b3c.fillRect(10, 10, 40, 30);
  const c3a = d3.addLayer(createRasterLayer(80, 60, 'clipA'));
  t.fill(c3a, '#00ff00', 0, 0, 40, 60);
  const c3b = d3.addLayer(createRasterLayer(80, 60, 'clipB'));
  t.fill(c3b, '#0000ff', 40, 0, 40, 60);
  t.eq(t.px(compositeDocument(d3), 60, 25), '0,0,255,255',
    'precondition: the upper layer covers x>=40 while unclipped');
  c3a.clipped = true;
  c3b.clipped = true;
  cv = compositeDocument(d3);
  t.eq(t.px(cv, 20, 20), '0,255,0,255', 'the first clipped layer shows inside the base');
  t.eq(t.px(cv, 45, 25), '0,0,255,255', 'the second one clips to the SAME base');
  t.eq(t.px(cv, 60, 25), '255,255,255,255', 'neither leaks past the base horizontally');
  t.eq(t.px(cv, 45, 5), '255,255,255,255', 'nor vertically');
});

/* ------------------------------------------------------------------ */

suite('compositor / groups', async (t) => {
  const doc = t.doc(60, 60, '#ffffff', 'group');
  const g = doc.addLayer(createGroupLayer('G'));
  t.eq(g.blendMode, 'pass-through', 'a new group starts in pass-through');
  const top = createRasterLayer(60, 60, 'childTop');
  const bot = createRasterLayer(60, 60, 'childBottom');
  doc.addLayer(bot, { parent: g, index: 0 });
  doc.addLayer(top, { parent: g, index: 0 });
  t.eq(g.children.map((l) => l.name), ['childTop', 'childBottom'], 'children[0] is the top child');
  t.fill(top, '#ff0000', 0, 0, 20, 60);
  t.fill(bot, '#0000ff', 10, 0, 20, 60);

  let cv = compositeDocument(doc);
  t.eq(t.px(cv, 5, 30), '255,0,0,255', 'the top child renders');
  t.eq(t.px(cv, 15, 30), '255,0,0,255', 'and wins where the children overlap');
  t.eq(t.px(cv, 25, 30), '0,0,255,255', 'the bottom child renders where it is alone');
  t.eq(t.px(cv, 45, 30), '255,255,255,255', 'the backdrop shows where neither child paints');

  // A group mask applies to the whole group.
  g.addMask(60, 60, '#ffffff');
  const gm = g.mask.getContext('2d');
  gm.fillStyle = '#000000';
  gm.fillRect(0, 0, 20, 60);
  g.touchMask();
  cv = compositeDocument(doc);
  t.eq(t.px(cv, 5, 30), '255,255,255,255', 'the group mask hides the top child');
  t.eq(t.px(cv, 15, 30), '255,255,255,255', 'and the bottom child under the same mask pixels');
  t.eq(t.px(cv, 25, 30), '0,0,255,255', 'while unmasked group pixels survive');
  g.maskEnabled = false;
  t.eq(t.px(compositeDocument(doc), 5, 30), '255,0,0,255', 'disabling the group mask restores the children');

  // Group opacity is applied ONCE to the flattened group, not per child.
  const d2 = t.doc(60, 60, '#ffffff', 'groupop');
  const g2 = d2.addLayer(createGroupLayer('G2'));
  const t2 = createRasterLayer(60, 60, 'a');
  const b2 = createRasterLayer(60, 60, 'b');
  d2.addLayer(b2, { parent: g2, index: 0 });
  d2.addLayer(t2, { parent: g2, index: 0 });
  t.fill(t2, '#000000', 0, 0, 40, 60);
  t.fill(b2, '#000000', 20, 0, 40, 60);
  g2.opacity = 0.2;
  cv = compositeDocument(d2);
  const only = t.px(cv, 10, 30), both = t.px(cv, 30, 30), other = t.px(cv, 50, 30);
  nearPixel(t, cv, 10, 30, [204, 204, 204, 255], 2, 'group opacity 0.2 leaves black at 204 over white');
  t.eq(both, only, 'the overlap of two children is NOT darkened twice (opacity applied once)');
  t.eq(other, only, 'and the third region matches as well');

  // Pass-through lets a child blend with the backdrop; an explicit mode isolates.
  const d3 = t.doc(40, 40, '#aaaaaa', 'passthru');
  const g3 = d3.addLayer(createGroupLayer('G3'));
  const c3 = createRasterLayer(40, 40, 'child');
  d3.addLayer(c3, { parent: g3, index: 0 });
  t.fill(c3, '#999999');
  c3.blendMode = 'multiply';
  t.eq(t.px(compositeDocument(d3), 20, 20), '102,102,102,255',
    'pass-through: the child multiplies against the backdrop (170*153/255)');
  g3.blendMode = 'normal';
  t.eq(t.px(compositeDocument(d3), 20, 20), '153,153,153,255',
    'an isolated group blends the child against transparency, so Multiply degrades to source-over');
});

/* ------------------------------------------------------------------ */

suite('compositor / adjustment layers', async (t) => {
  const doc = t.doc(60, 40, '#aa5500', 'adj');
  const mid = doc.addLayer(createRasterLayer(60, 40, 'mid'));
  t.fill(mid, '#00ff00', 0, 0, 30, 40);
  const adj = doc.addLayer(createAdjustmentLayer('invert', {}, 60, 40, 'Invert'));

  let cv = compositeDocument(doc);
  t.eq(t.px(cv, 10, 20), '255,0,255,255', 'the adjustment inverts the layer beneath it (0,255,0 -> 255,0,255)');
  t.eq(t.px(cv, 40, 20), '85,170,255,255', 'and the backdrop further down (170,85,0 -> 85,170,255)');

  adj.visible = false;
  cv = compositeDocument(doc);
  t.eq(t.px(cv, 10, 20), '0,255,0,255', 'hiding the adjustment restores the original pixels');
  t.eq(t.px(cv, 40, 20), '170,85,0,255', 'exactly, everywhere');
  adj.visible = true;

  adj.addMask(60, 40, '#ffffff');
  const am = adj.mask.getContext('2d');
  am.fillStyle = '#000000';
  am.fillRect(0, 0, 30, 40);
  adj.touchMask();
  cv = compositeDocument(doc);
  t.eq(t.px(cv, 10, 20), '0,255,0,255', 'a masked-out adjustment leaves those pixels alone');
  t.eq(t.px(cv, 40, 20), '85,170,255,255', 'while the unmasked half is still adjusted');
  adj.removeMask();

  // Clipped: the adjustment may only touch its base, not the backdrop.
  const d2 = t.doc(60, 40, '#aa5500', 'adjclip');
  const base = d2.addLayer(createRasterLayer(60, 40, 'base'));
  const bc = base.canvas.getContext('2d');
  bc.fillStyle = '#00ff00';
  bc.fillRect(10, 10, 20, 20);
  const adj2 = d2.addLayer(createAdjustmentLayer('invert', {}, 60, 40, 'Invert'));
  t.eq(t.px(compositeDocument(d2), 50, 30), '85,170,255,255',
    'precondition: unclipped, the adjustment inverts the whole backdrop');
  adj2.clipped = true;
  cv = compositeDocument(d2);
  t.eq(t.px(cv, 20, 20), '255,0,255,255', 'a clipped adjustment inverts its base');
  t.eq(t.px(cv, 50, 30), '170,85,0,255', 'and leaves everything outside the base untouched');
});

/* ------------------------------------------------------------------ */

suite('compositor / GPU blend path matches the CPU path', async (t) => {
  const W = 700, H = 600;              // 420 000 px, just over the 400k threshold

  t.notOk(shouldBlendOnGPU(100, 100), 'a 10k-pixel surface stays on the exact CPU path');
  t.notOk(shouldBlendOnGPU(640, 624), '399 360 px is still below the GPU threshold');
  t.ok(shouldBlendOnGPU(W, H), '420 000 px is above the GPU threshold');
  t.ok(isGPUModeSupported('vivid-light'), 'vivid-light has a shader branch');
  t.notOk(isGPUModeSupported('multiply'), 'native Canvas2D modes never reach the GPU path');

  const small = createCanvas(64, 64);
  t.notOk(blendOnGPU(small.getContext('2d'), small, 'subtract', 1),
    'blendOnGPU declines a small surface so the CPU path stays bit-exact');

  const available = canBlendOnGPU(W, H);
  t.ok(available, 'WebGL2 is available for the shader path');

  const surface = (fn) => {
    const cv = createCanvas(W, H);
    const img = new ImageData(W, H);
    const d = img.data;
    for (let y = 0, i = 0; y < H; y++) {
      for (let x = 0; x < W; x++, i += 4) {
        const p = fn(x, y);
        d[i] = p[0]; d[i + 1] = p[1]; d[i + 2] = p[2]; d[i + 3] = p[3];
      }
    }
    cv.getContext('2d').putImageData(img, 0, 0);
    return cv;
  };

  // Every non-native mode except dissolve, which is deliberately random.
  const MODES = ['linear-burn', 'vivid-light', 'linear-light', 'pin-light', 'hard-mix',
    'subtract', 'divide', 'darker-color', 'lighter-color'];
  for (const m of MODES) t.notOk(isNativeBlend(m), `${m} needs the CPU/GPU path`);

  if (available) {
    // --- fully opaque: the two paths must agree exactly ---
    // Opaque pixels upload losslessly (nothing is premultiplied away), so the
    // only legitimate disagreements are (a) a single count of rounding where the
    // shader divides in float32 and blendCPU in float64, and (b) modes that pick
    // a whole pixel by luminance, where an exact tie can fall either way. Both
    // are asserted precisely rather than hidden behind a blanket tolerance.
    const EXACT = new Set(['linear-burn', 'linear-light', 'pin-light', 'hard-mix', 'subtract']);
    const DIVIDES = new Set(['vivid-light', 'divide']);
    const lum = (rr, gg, bb) => 0.3 * rr + 0.59 * gg + 0.11 * bb;

    const baseCv = surface((x, y) => [(x * 7 + y * 3) % 256, (x * 13) % 256, (y * 11) % 256, 255]);
    const srcCv = surface((x, y) => [(x * 5 + y * 17) % 256, (y * 23) % 256, (x * 3 + y * 7) % 256, 255]);
    const baseData = ctx2dRead(baseCv).getImageData(0, 0, W, H);
    const srcData = ctx2dRead(srcCv).getImageData(0, 0, W, H);
    const bb = baseData.data, ss = srcData.data;

    for (const mode of MODES) {
      const dst = createCanvas(W, H);
      const dctx = dst.getContext('2d');
      dctx.drawImage(baseCv, 0, 0);
      t.ok(blendOnGPU(dctx, srcCv, mode, 1), `blendOnGPU takes ${mode}`);
      const gpu = ctx2dRead(dst).getImageData(0, 0, W, H).data;
      const exp = new ImageData(new Uint8ClampedArray(bb), W, H);
      blendCPU(exp, srcData, mode, 1);
      const e = exp.data;

      let worst = 0, over = 0, tied = 0;
      for (let i = 0; i < e.length; i += 4) {
        let d = 0;
        for (let k = 0; k < 4; k++) {
          const v = Math.abs(gpu[i + k] - e[i + k]);
          if (v > d) d = v;
        }
        if (d > worst) worst = d;
        if (d > 1) {
          over++;
          if (Math.abs(lum(bb[i], bb[i + 1], bb[i + 2]) - lum(ss[i], ss[i + 1], ss[i + 2])) < 1e-4) tied++;
        }
      }

      if (EXACT.has(mode)) {
        t.eq(worst, 0, `GPU ${mode} is bit-identical to blendCPU on every opaque pixel`);
      } else if (DIVIDES.has(mode)) {
        t.eq(over, 0, `GPU ${mode} never differs from blendCPU by more than one count when opaque`);
        t.lt(worst, 2, `GPU ${mode} worst opaque error is float32-vs-float64 rounding only`);
      } else {
        t.eq(over, tied, `GPU ${mode} only disagrees with blendCPU on exact luminance ties (${over} px)`);
        t.lt(over, W * H * 0.0005, `and on fewer than 0.05% of opaque pixels (${over} of ${W * H})`);
      }
    }

    // --- semi-transparent: premultiplied 8-bit upload costs ~2 counts ---
    const baseT = surface((x, y) => [(x * 7 + y * 3) % 256, (x * 13) % 256, (y * 11) % 256,
      128 + ((x * 3 + y * 5) % 128)]);
    const srcT = surface((x, y) => [(x * 5 + y * 17) % 256, (y * 23) % 256, (x * 3 + y * 7) % 256,
      160 + ((x * 7) % 96)]);
    const baseTD = ctx2dRead(baseT).getImageData(0, 0, W, H);
    const srcTD = ctx2dRead(srcT).getImageData(0, 0, W, H);
    for (const mode of ['linear-burn', 'subtract', 'linear-light']) {
      const dst = createCanvas(W, H);
      const dctx = dst.getContext('2d');
      dctx.drawImage(baseT, 0, 0);
      t.ok(blendOnGPU(dctx, srcT, mode, 1), `blendOnGPU takes ${mode} on translucent pixels`);
      const gpu = ctx2dRead(dst).getImageData(0, 0, W, H);
      const exp = new ImageData(new Uint8ClampedArray(baseTD.data), W, H);
      blendCPU(exp, srcTD, mode, 1);
      t.lt(maxDiff(gpu.data, exp.data), 5, `GPU ${mode} stays within the documented ~2 counts when translucent`);
      t.lt(t.mad(gpu, exp), 0.5, `GPU ${mode} translucent mean error is negligible`);
    }
  }
});

/* ------------------------------------------------------------------ */

suite('compositor / getComposite caching + blendOnto', async (t) => {
  const doc = t.doc(40, 40, '#ffffff', 'cache');
  const a = getComposite(doc);
  t.ok(getComposite(doc) === a, 'getComposite returns the very same canvas until invalidation');
  t.eq(t.px(a, 20, 20), '255,255,255,255', 'and it holds the document content');

  const l = doc.activeLayer();
  t.fill(l, '#ff0000');
  t.ok(getComposite(doc) === a, 'writing pixels behind the compositor does not invalidate on its own');
  t.eq(t.px(getComposite(doc), 20, 20), '255,255,255,255', 'so the cached canvas still shows the old pixels');

  doc.invalidate();
  const b = getComposite(doc);
  t.ok(b !== a, 'invalidate() forces a fresh canvas');
  t.eq(t.px(b, 20, 20), '255,0,0,255', 'and the fresh composite picks up the new pixels');
  t.ok(getComposite(doc) === b, 'the new canvas is then cached in turn');
  t.ok(getComposite(doc, { ignoreEffects: true }) !== b, 'passing opts always bypasses the cache');

  // blendOnto is the primitive underneath all of the above.
  const dst = createCanvas(8, 8);
  const dctx = dst.getContext('2d');
  dctx.fillStyle = '#aa5500';
  dctx.fillRect(0, 0, 8, 8);
  const src = createCanvas(8, 8);
  const sctx = src.getContext('2d');
  sctx.fillStyle = '#33cc66';
  sctx.fillRect(0, 0, 8, 8);
  blendOnto(dctx, src, 'pin-light', 1, doc);
  t.eq(t.px(dst, 4, 4), '102,153,0,255', 'blendOnto runs a non-native mode through the CPU path exactly');
  blendOnto(dctx, src, 'normal', 0, doc);
  t.eq(t.px(dst, 4, 4), '102,153,0,255', 'blendOnto at opacity 0 is a no-op');
});
