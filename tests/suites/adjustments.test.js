import { suite } from '../harness.js';
import {
  adjustments, registerAdjustment, getAdjustment, listAdjustments, defaultParams,
  applyAdjustment, buildLUT, applyLUT, mixImageData,
} from '/src/adjustments/registry.js';
import { defaultLevels, luma8 } from '/src/adjustments/basic.js';
import { defaultCurves } from '/src/ui/curve-editor.js';
import { defaultGradient } from '/src/ui/gradient-editor.js';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/**
 * The 24 ids ARCHITECTURE.md pins down as fixed. Adjustment ids are persisted
 * inside .pika documents as adjustment-layer payloads, so renaming one is a
 * file-format break — hence the hard-coded list.
 */
const ARCHITECTURE_IDS = [
  'brightness-contrast', 'levels', 'curves', 'exposure', 'vibrance', 'hue-saturation',
  'color-balance', 'black-white', 'photo-filter', 'channel-mixer', 'color-lookup',
  'invert', 'posterize', 'threshold', 'gradient-map', 'selective-color',
  'shadows-highlights', 'desaturate', 'equalize', 'replace-color', 'hdr-toning',
  'auto-tone', 'auto-contrast', 'auto-color',
];

/** Ramps, hard blocks, deterministic noise, a transparent block, a 90-alpha block. */
function testImage(w, h) {
  const img = new ImageData(w, h);
  const d = img.data;
  let s = 987;
  const rnd = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      d[i] = Math.round((x * 255) / (w - 1));
      d[i + 1] = Math.round((y * 255) / (h - 1));
      d[i + 2] = 40 + Math.round(rnd() * 160);
      d[i + 3] = 255;
    }
  }
  const block = (x0, y0, bw, bh, fn) => {
    for (let y = y0; y < y0 + bh; y++) {
      for (let x = x0; x < x0 + bw; x++) fn((y * w + x) * 4);
    }
  };
  block(4, 4, 10, 10, (i) => { d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; });
  block(4, h - 14, 10, 10, (i) => { d[i + 3] = 0; });    // fully transparent
  block(16, h - 14, 10, 10, (i) => { d[i + 3] = 90; });  // partially transparent
  return img;
}

/** One pixel per grey level, 0..255. */
function greyRamp() {
  const img = new ImageData(256, 1);
  const d = img.data;
  for (let x = 0; x < 256; x++) {
    d[x * 4] = x; d[x * 4 + 1] = x; d[x * 4 + 2] = x; d[x * 4 + 3] = 255;
  }
  return img;
}

/** A grey image whose values only span `lo..hi` — deliberately low contrast. */
function bandedGrey(w, h, lo, hi) {
  const img = new ImageData(w, h);
  const d = img.data;
  const span = hi - lo + 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = lo + (x % span);
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
  }
  return img;
}

/** A full-range grey ramp, every level 0..255 present many times over. */
function fullRangeGrey(w, h) {
  const img = new ImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = Math.round((x * 255) / (w - 1));
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
  }
  return img;
}

const px = (img, x, y = 0) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
};

const valueRange = (img) => {
  let lo = 255, hi = 0;
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    if (d[i] < lo) lo = d[i];
    if (d[i] > hi) hi = d[i];
  }
  return [lo, hi];
};

const alphaOf = (img) => {
  const out = new Uint8ClampedArray(img.data.length >> 2);
  for (let i = 3, k = 0; i < img.data.length; i += 4, k++) out[k] = img.data[i];
  return out;
};

/** Every numeric param at its max, every select at its LAST option. */
function extremeParams(def) {
  const p = { ...def.defaults };
  for (const d of def.params || []) {
    if (d.key === undefined) continue;
    if (d.type === 'slider' || d.type === 'number') {
      if (Number.isFinite(d.max)) p[d.key] = d.max;
    } else if (d.type === 'select' || d.type === 'radio') {
      const opts = d.options || [];
      const last = opts[opts.length - 1];
      if (last != null) p[d.key] = typeof last === 'object' ? last.value : last;
    } else if (d.type === 'checkbox') {
      p[d.key] = true;
    }
  }
  return p;
}

const run = (id, img, params) => {
  applyAdjustment(id, img, params, {});
  return img;
};

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

suite('adjustments / registry integrity', async (t) => {
  t.eq(adjustments.size, 24, 'all 24 adjustments are registered');
  t.eq(new Set([...adjustments.keys()]).size, 24, 'adjustment ids are unique');
  t.eq(listAdjustments().length, 24, 'listAdjustments() returns every one');

  const missing = ARCHITECTURE_IDS.filter((id) => !adjustments.has(id));
  t.eq(missing, [], 'every id ARCHITECTURE.md pins down exists in the registry');
  const extra = [...adjustments.keys()].filter((id) => !ARCHITECTURE_IDS.includes(id));
  t.eq(extra, [], 'and nothing is registered that ARCHITECTURE.md does not list');

  const problems = [];
  for (const [id, def] of adjustments) {
    if (def.id !== id) problems.push(`${id}: id does not match its registry key`);
    if (!def.name) problems.push(`${id}: no name`);
    if (!def.group) problems.push(`${id}: no group`);
    if (typeof def.apply !== 'function') problems.push(`${id}: no apply()`);
    if (typeof def.layerable !== 'boolean') problems.push(`${id}: layerable is not a boolean`);
    const keys = (def.params || []).filter((p) => p.key !== undefined).map((p) => p.key);
    if (Object.keys(def.defaults).length !== new Set(keys).size) {
      problems.push(`${id}: defaults has ${Object.keys(def.defaults).length} keys, params has ${new Set(keys).size}`);
    }
    for (const p of def.params || []) {
      if (p.key === undefined) continue;
      if (JSON.stringify(def.defaults[p.key]) !== JSON.stringify(p.default)) {
        problems.push(`${id}: defaults.${p.key} does not match the param default`);
      }
    }
  }
  t.eq(problems, [], 'every adjustment has an id, a name, a group, an apply() and params-derived defaults');

  t.eq([...new Set([...adjustments.values()].map((a) => a.group))].sort(), ['auto', 'color', 'map', 'tone'],
    'adjustments fall into the four menu groups');
  t.eq([...adjustments.values()].filter((a) => !a.layerable).map((a) => a.id), ['auto-tone', 'auto-contrast', 'auto-color'],
    'only the three Auto commands are destructive-only (they read the whole histogram)');

  t.eq(getAdjustment('levels').name, 'Levels...', 'getAdjustment resolves a known id');
  t.eq(getAdjustment('no-such-adjustment'), null, 'getAdjustment returns null for an unknown id');
  await t.throws(() => registerAdjustment({ name: 'No Id' }), 'registerAdjustment rejects a definition without an id');

  // defaultParams must hand out a deep copy, or a dialog would edit the registry.
  const p1 = defaultParams('levels');
  p1.levels.rgb.ib = 99;
  t.eq(defaultParams('levels').levels.rgb.ib, 0, 'defaultParams() returns a deep clone, not the registry object');
  t.eq(defaultParams('no-such-adjustment'), {}, 'defaultParams() of an unknown id is an empty object');

  // An unknown id must be a silent no-op — a corrupt document must not crash
  // the compositor.
  const img = testImage(16, 16);
  const before = new Uint8ClampedArray(img.data);
  t.eq(applyAdjustment('no-such-adjustment', img, {}, {}), img, 'applyAdjustment returns the ImageData for an unknown id');
  t.eq(t.mad(img.data, before), 0, 'and changes nothing');
});

suite('adjustments / shared LUT helpers', async (t) => {
  const lut = buildLUT((i) => 255 - i);
  t.eq(lut.length, 256, 'buildLUT covers all 256 levels');
  t.eq([lut[0], lut[128], lut[255]], [255, 127, 0], 'buildLUT evaluates the function per level');
  t.ok(lut instanceof Uint8ClampedArray, 'buildLUT clamps by construction');
  t.eq(buildLUT(() => 900)[7], 255, 'and an out-of-range result clamps to 255');

  const img = new ImageData(new Uint8ClampedArray([10, 20, 30, 255, 10, 20, 30, 0]), 2, 1);
  applyLUT(img, lut, null, lut);
  t.eq(px(img, 0), [245, 20, 225, 255], 'applyLUT skips a null channel and maps the rest');
  t.eq(px(img, 1), [10, 20, 30, 0], 'applyLUT skips fully transparent pixels');

  const orig = new ImageData(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1);
  const adj = new ImageData(new Uint8ClampedArray([100, 200, 40, 255]), 1, 1);
  mixImageData(orig, adj, 0.25);
  t.eq([...adj.data], [25, 50, 10, 255], 'mixImageData blends the adjusted result back by amount');
});

/* ------------------------------------------------------------------ */
/* Smoke                                                              */
/* ------------------------------------------------------------------ */

suite('adjustments / every adjustment runs at defaults and extremes', async (t) => {
  // apply() is called directly rather than through applyAdjustment, which
  // swallows throws by design — a caught exception must still fail the test.
  const neutral = [];
  for (const [id, def] of adjustments) {
    for (const mode of ['defaults', 'extremes']) {
      const img = testImage(64, 64);
      const before = new Uint8ClampedArray(img.data);
      const alphaBefore = alphaOf(img);
      const params = mode === 'defaults' ? { ...def.defaults } : extremeParams(def);
      const problems = [];
      try {
        def.apply(img, { ...def.defaults, ...params }, {});
      } catch (err) {
        problems.push(`threw: ${(err && err.message) || err}`);
      }
      if (!(img.data instanceof Uint8ClampedArray)) problems.push('data is no longer a Uint8ClampedArray');
      for (let i = 0; i < img.data.length; i++) {
        if (!Number.isFinite(img.data[i])) { problems.push(`non-finite byte at ${i}`); break; }
      }
      if (img.width !== 64 || img.height !== 64) problems.push(`size became ${img.width}x${img.height}`);
      // Adjustments are colour maps: they must never touch alpha, at all.
      const alphaAfter = alphaOf(img);
      let alphaDrift = -1;
      for (let k = 0; k < alphaBefore.length; k++) {
        if (alphaBefore[k] !== alphaAfter[k]) { alphaDrift = k; break; }
      }
      if (alphaDrift >= 0) problems.push(`alpha changed at pixel ${alphaDrift}`);
      t.eq(problems, [], `adjustment "${id}" runs cleanly at its ${mode}`);

      if (mode === 'defaults') {
        let same = true;
        for (let i = 0; i < img.data.length; i++) if (img.data[i] !== before[i]) { same = false; break; }
        if (same) neutral.push(id);
      }
    }
  }

  // The ten slider-driven adjustments whose zeroed defaults mean "no change".
  // Everything else must do something the moment it is applied — an adjustment
  // drifting into this list is a silent regression.
  t.eq(neutral.sort(), [
    'brightness-contrast', 'channel-mixer', 'color-balance', 'curves', 'exposure',
    'hue-saturation', 'levels', 'replace-color', 'selective-color', 'vibrance',
  ], 'exactly the ten identity-at-default adjustments leave the image untouched');
});

suite('adjustments / adjustments are pure functions', async (t) => {
  // Three adjustments need a hand-built setting: levels and curves take
  // `custom` params the extremes sweep cannot fill in, and posterize is the
  // identity at its maximum of 255 levels. Without these, purity would only be
  // tested on their early-return paths.
  const ACTIVE = {
    posterize: () => ({ levels: 4 }),
    levels: () => {
      const L = defaultLevels();
      L.rgb = { ib: 20, ig: 1.6, iw: 220, ob: 5, ow: 250 };
      return { levels: L };
    },
    curves: () => {
      const C = defaultCurves();
      C.rgb = [{ x: 0, y: 20 }, { x: 128, y: 180 }, { x: 255, y: 235 }];
      return { curves: C };
    },
  };

  const drift = [];
  const mutated = [];
  const noop = [];
  for (const [id, def] of adjustments) {
    const params = { ...extremeParams(def), ...(ACTIVE[id] ? ACTIVE[id]() : {}) };
    const frozen = JSON.stringify(params);
    const a = testImage(48, 48);
    const b = testImage(48, 48);
    const start = new Uint8ClampedArray(a.data);
    // Precondition: the two fixtures are genuinely identical to begin with.
    if (t.mad(a.data, b.data) !== 0) drift.push(`${id}: fixture is not reproducible`);
    applyAdjustment(id, a, params, {});
    applyAdjustment(id, b, params, {});
    if (t.mad(a.data, b.data) !== 0) drift.push(id);
    if (JSON.stringify(params) !== frozen) mutated.push(id);
    // Precondition: purity is only interesting if the call did something.
    if (t.mad(a.data, start) === 0) noop.push(id);
  }
  t.eq(noop, [], 'every adjustment does real work at these settings, so the comparison below is not vacuous');
  t.eq(drift, [], 'every adjustment is a pure function of (imageData, params) — two runs agree bit for bit');
  t.eq(mutated, [], 'no adjustment mutates the params object it was handed');
});

/* ------------------------------------------------------------------ */
/* Ground truth — exact answers                                        */
/* ------------------------------------------------------------------ */

suite('adjustments / invert, threshold, desaturate, posterize', async (t) => {
  // --- Invert ---
  const inv = new ImageData(new Uint8ClampedArray([
    0, 128, 255, 255,
    17, 34, 51, 0,       // fully transparent — must be left completely alone
    255, 255, 255, 255,
    200, 100, 50, 90,    // partially transparent — still inverted
  ]), 4, 1);
  run('invert', inv, {});
  t.eq(px(inv, 0), [255, 127, 0, 255], 'invert maps 0->255, 255->0 and 128->127 (255-v)');
  t.eq(px(inv, 2), [0, 0, 0, 255], 'white inverts to black');
  t.eq(px(inv, 1), [17, 34, 51, 0], 'invert skips fully transparent pixels');
  t.eq(px(inv, 3), [55, 155, 205, 90], 'but a partially transparent pixel is inverted');

  // --- Threshold ---
  const levels = [0, 50, 127, 128, 129, 200, 255];
  const thr = new ImageData(levels.length, 1);
  for (let x = 0; x < levels.length; x++) {
    const i = x * 4;
    thr.data[i] = levels[x]; thr.data[i + 1] = levels[x]; thr.data[i + 2] = levels[x]; thr.data[i + 3] = 255;
  }
  run('threshold', thr, { level: 128 });
  const got = levels.map((_, x) => px(thr, x)[0]);
  t.eq([...new Set(got)].sort((a, b) => a - b), [0, 255], 'threshold emits only 0 and 255');
  t.eq(got.slice(0, 3), [0, 0, 0], 'levels below the threshold go to black');
  t.eq(got.slice(4), [255, 255, 255], 'levels above the threshold go to white');
  // The implementation is `luma >= level`, so a neutral 128 at level 128 must be
  // white. luma8(128,128,128) is 127.99999999999999 in doubles, so it is not.
  t.eq(got[3], 255, 'a neutral 128 grey at threshold level 128 is white (luma >= level)');
  t.eq(px(thr, 0)[3], 255, 'threshold leaves alpha alone');

  // --- Desaturate (HSL lightness, matching Photoshop) ---
  const des = new ImageData(new Uint8ClampedArray([
    200, 50, 10, 255,
    0, 255, 100, 255,
    77, 77, 77, 255,
  ]), 3, 1);
  run('desaturate', des, {});
  t.eq(px(des, 0), [105, 105, 105, 255], 'desaturate uses (max+min)/2: (200+10)/2 = 105');
  t.eq(px(des, 1), [127, 127, 127, 255], '(255+0)/2 = 127 (integer halving)');
  t.eq(px(des, 2), [77, 77, 77, 255], 'an already-grey pixel is unchanged');
  for (let x = 0; x < 3; x++) {
    const p = px(des, x);
    t.eq([p[0] === p[1], p[1] === p[2]], [true, true], `desaturate gives r==g==b for pixel ${x}`);
  }

  // --- Posterize ---
  const p2 = run('posterize', greyRamp(), { levels: 2 });
  const set2 = [...new Set([...Array(256)].map((_, x) => px(p2, x)[0]))].sort((a, b) => a - b);
  t.eq(set2, [0, 255], 'posterize with 2 levels emits exactly {0,255}');
  t.eq([px(p2, 127)[0], px(p2, 128)[0]], [0, 255], 'and splits the ramp at the midpoint');

  const p4 = run('posterize', greyRamp(), { levels: 4 });
  const set4 = [...new Set([...Array(256)].map((_, x) => px(p4, x)[0]))].sort((a, b) => a - b);
  t.eq(set4, [0, 85, 170, 255], 'posterize with 4 levels emits exactly {0,85,170,255}');
  t.eq([px(p4, 0)[0], px(p4, 255)[0]], [0, 255], 'and keeps both endpoints');

  const p255 = run('posterize', greyRamp(), { levels: 255 });
  let identity = true;
  for (let x = 0; x < 256; x++) if (px(p255, x)[0] !== x) identity = false;
  t.ok(identity, 'posterize at 255 levels is the identity');
});

suite('adjustments / levels and curves', async (t) => {
  // Identity parameters must be bit-identical, not merely close.
  const ramp = testImage(64, 64);
  const before = new Uint8ClampedArray(ramp.data);
  run('levels', ramp, { levels: defaultLevels() });
  t.eq(t.mad(ramp.data, before), 0, 'levels at identity parameters is bit-identical to the input');

  const ramp2 = testImage(64, 64);
  const before2 = new Uint8ClampedArray(ramp2.data);
  run('curves', ramp2, { curves: defaultCurves() });
  t.eq(t.mad(ramp2.data, before2), 0, 'curves at identity parameters is bit-identical to the input');

  // Input black 64 / white 192 is a pure linear stretch.
  const L = defaultLevels();
  L.rgb = { ib: 64, ig: 1, iw: 192, ob: 0, ow: 255 };
  const img = run('levels', greyRamp(), { levels: L });
  t.eq(px(img, 64)[0], 0, 'levels input-black 64 maps 64 -> 0');
  t.eq(px(img, 192)[0], 255, 'levels input-white 192 maps 192 -> 255');
  t.eq(px(img, 128)[0], 128, 'the midpoint of 64..192 maps to 128');
  t.eq(px(img, 0)[0], 0, 'everything below the black point clips to 0');
  t.eq(px(img, 255)[0], 255, 'everything above the white point clips to 255');
  t.eq(px(img, 63)[0], 0, 'and 63 clips as well');
  t.eq(px(img, 65)[0], 2, '65 lands two levels up (255/128 per input level)');

  // Gamma. levelsLUT raises t to 1/ig, so ig=2 is a square root.
  const G = defaultLevels();
  G.rgb = { ib: 0, ig: 2, iw: 255, ob: 0, ow: 255 };
  const gimg = run('levels', greyRamp(), { levels: G });
  t.eq(px(gimg, 128)[0], Math.round(255 * Math.pow(128 / 255, 0.5)), 'gamma 2 maps 128 to round(255*(128/255)^0.5)');
  t.eq(px(gimg, 128)[0], 181, 'which is 181');
  t.eq([px(gimg, 0)[0], px(gimg, 255)[0]], [0, 255], 'gamma leaves both endpoints fixed');

  // Output range.
  const O = defaultLevels();
  O.rgb = { ib: 0, ig: 1, iw: 255, ob: 32, ow: 224 };
  const oimg = run('levels', greyRamp(), { levels: O });
  t.eq([px(oimg, 0)[0], px(oimg, 255)[0]], [32, 224], 'output black/white compress the range exactly');

  // A per-channel curve must touch only that channel.
  const C = defaultCurves();
  C.r = [{ x: 0, y: 255 }, { x: 255, y: 0 }];
  const cimg = run('curves', greyRamp(), { curves: C });
  t.eq(px(cimg, 0), [255, 0, 0, 255], 'a red-only inverting curve inverts red and leaves green/blue');
  t.eq(px(cimg, 255), [0, 255, 255, 255], 'at the other end of the ramp too');
});

suite('adjustments / brightness-contrast never darkens on a brightness lift', async (t) => {
  const ramp = greyRamp();
  const before = new Uint8ClampedArray(ramp.data);
  run('brightness-contrast', ramp, { brightness: 60, contrast: 0, useLegacy: false });

  let minDelta = Infinity, lifted = 0;
  for (let x = 0; x < 256; x++) {
    const delta = ramp.data[x * 4] - before[x * 4];
    if (delta < minDelta) minDelta = delta;
    if (delta > 0) lifted++;
  }
  t.gt(lifted, 200, 'a positive brightness lifts almost every level (so this is not a no-op)');
  t.eq(minDelta >= 0, true, `no level was darkened by a positive brightness (worst delta ${minDelta})`);
  t.eq([px(ramp, 0)[0], px(ramp, 255)[0]], [0, 255], 'the endpoints are gamma-fixed, so nothing clips');

  // And the other direction, for symmetry.
  const down = greyRamp();
  run('brightness-contrast', down, { brightness: -60, contrast: 0, useLegacy: false });
  let maxDelta = -Infinity;
  for (let x = 0; x < 256; x++) maxDelta = Math.max(maxDelta, down.data[x * 4] - x);
  t.eq(maxDelta <= 0, true, `a negative brightness never brightens a pixel (worst delta ${maxDelta})`);
});

suite('adjustments / hue-saturation and gradient-map', async (t) => {
  // Saturation -100 must fully desaturate, whatever the hue.
  const img = new ImageData(new Uint8ClampedArray([
    200, 30, 60, 255,
    10, 180, 240, 255,
    90, 90, 90, 255,
    255, 0, 0, 255,
  ]), 4, 1);
  // Precondition: three of the four are genuinely saturated.
  t.eq([0, 1, 3].filter((x) => px(img, x)[0] !== px(img, x)[1]).length, 3, 'the fixture starts saturated');
  run('hue-saturation', img, { masterSat: -100 });
  for (let x = 0; x < 4; x++) {
    const p = px(img, x);
    t.eq([p[0] === p[1], p[1] === p[2]], [true, true], `saturation -100 gives r==g==b for pixel ${x}`);
  }
  t.eq(px(img, 0)[0], 115, 'and the grey it lands on is the HSL lightness: (200+30)/2 = 115');
  // Note the one-level difference from Desaturate above: this path rounds
  // 127.5 up, Desaturate's `(max+min)>>1` truncates it down.
  t.eq(px(img, 3)[0], 128, 'pure red desaturates to round(255/2) = 128');
  t.eq(px(img, 2), [90, 90, 90, 255], 'an already-grey pixel is unchanged');

  // Gradient Map with the default black->white gradient is exactly luminance.
  const g = run('gradient-map', greyRamp(), { gradient: defaultGradient(), reverse: false, dither: false });
  const vals = [...Array(256)].map((_, x) => px(g, x)[0]);
  let monotonic = true;
  for (let x = 1; x < 256; x++) if (vals[x] < vals[x - 1]) monotonic = false;
  t.ok(monotonic, 'gradient-map maps luminance monotonically');
  t.eq([vals[0], vals[255]], [0, 255], 'the default black->white gradient pins both ends');
  t.eq(vals[128], 128, 'and a mid grey maps to the middle of the gradient');

  // Reverse must actually reverse it — which also proves the mapping above is
  // a real lookup and not an accidental pass-through.
  const rev = run('gradient-map', greyRamp(), { gradient: defaultGradient(), reverse: true, dither: false });
  const rvals = [...Array(256)].map((_, x) => px(rev, x)[0]);
  t.eq([rvals[0], rvals[255]], [255, 0], 'reverse flips the gradient ends');
  let antitone = true;
  for (let x = 1; x < 256; x++) if (rvals[x] > rvals[x - 1]) antitone = false;
  t.ok(antitone, 'and the reversed mapping is monotonically decreasing');

  // A colour pixel must map by its luminance, not by any single channel.
  const col = new ImageData(new Uint8ClampedArray([200, 30, 60, 255]), 1, 1);
  run('gradient-map', col, { gradient: defaultGradient(), reverse: false, dither: false });
  const expect = Math.round(luma8(200, 30, 60));
  t.eq(px(col, 0), [expect, expect, expect, 255], `a colour pixel maps to its luminance (${expect})`);
});

suite('adjustments / auto tone, contrast and color', async (t) => {
  // A deliberately flat input: nothing outside 100..150.
  for (const id of ['auto-tone', 'auto-contrast', 'auto-color']) {
    const low = bandedGrey(64, 64, 100, 150);
    t.eq(valueRange(low), [100, 150], `${id}: the low-contrast fixture really spans only 100..150`);
    run(id, low, {});
    t.eq(valueRange(low), [0, 255], `${id} widens the histogram to the full 0..255 range`);
    // 0.1%/0.05% clipping cannot bite here — every level in the band occupies at
    // least 64 pixels of 4096 — so the endpoints are exact.
    t.eq(px(low, 0)[0], 0, `${id} maps the darkest input (100) to 0`);
    t.eq(px(low, 50)[0], 255, `${id} maps the brightest input (150) to 255`);
    t.eq(px(low, 25)[0], 128, `${id} maps the band midpoint (125) to 128`);
  }

  // An image that already spans 0..255 must come back untouched.
  for (const id of ['auto-tone', 'auto-contrast', 'auto-color']) {
    const full = fullRangeGrey(64, 64);
    t.eq(valueRange(full), [0, 255], `${id}: the full-range fixture spans 0..255 before the adjustment`);
    const before = new Uint8ClampedArray(full.data);
    run(id, full, {});
    t.eq(t.mad(full.data, before), 0, `${id} is a bit-identical no-op on an image that already spans 0..255`);
  }

  // Equalize belongs to the same family: it must flatten, not widen.
  const low = bandedGrey(64, 64, 100, 150);
  run('equalize', low, {});
  t.eq(valueRange(low), [0, 255], 'equalize also stretches a low-contrast image to the full range');
});
