import { suite } from '../harness.js';
import {
  filters, FILTER_MENUS, getFilter, listFilters, filtersByMenu, runFilter,
  registerFilter, makeRandom, gaussianKernel,
} from '/src/filters/registry.js';
import {
  applyFilterCommand, processSurface, operableRect, operableSurface,
} from '/src/filters/run.js';
import { Selection } from '/src/core/selection.js';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/**
 * A deliberately awkward test image: two crossed ramps, a hard white block, a
 * hard black block, deterministic per-pixel noise in blue, and a fully
 * transparent block. Every filter class (convolution, morphology, warp,
 * generator) has something to bite on, and nothing here depends on
 * Math.random() or the clock.
 */
function testImage(w, h) {
  const img = new ImageData(w, h);
  const d = img.data;
  let s = 12345;
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
      d[i + 2] = 64 + Math.round(rnd() * 60);
      d[i + 3] = 255;
    }
  }
  const block = (x0, y0, size, r, g, b, a) => {
    for (let y = y0; y < y0 + size; y++) {
      for (let x = x0; x < x0 + size; x++) {
        const i = (y * w + x) * 4;
        d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
      }
    }
  };
  block(4, 4, 10, 255, 255, 255, 255);           // hard white edge
  block(w - 14, 4, 10, 0, 0, 0, 255);            // hard black edge
  block(2, h - 12, 8, 0, 0, 0, 0);               // transparent region
  return img;
}

/** A flat opaque field. */
function solid(w, h, r, g, b, a = 255) {
  const img = new ImageData(w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a; }
  return img;
}

const px = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
};

const opaqueCount = (img) => {
  let n = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] >= 250) n++;
  return n;
};

const anyOpaque = (img) => {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 0) return true;
  return false;
};

/**
 * A NaN can never survive a write into a Uint8ClampedArray — it clamps to 0 —
 * so checking for one is only meaningful together with the buffer type. If a
 * filter ever hands back one of the internal Float32 buffers instead of real
 * ImageData, this is what catches it.
 */
function badBytes(img) {
  if (!(img.data instanceof Uint8ClampedArray)) return 'data is not a Uint8ClampedArray';
  const d = img.data;
  for (let i = 0; i < d.length; i++) if (!Number.isFinite(d[i])) return `non-finite byte at ${i}`;
  return null;
}

/** Every numeric param at its max, every select/radio at its LAST option. */
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

/** The ctx a filter sees when run outside the document pipeline. */
const fctx = (img, app) => ({
  doc: { width: img.width, height: img.height },
  layer: null,
  rect: { x: 0, y: 0, width: img.width, height: img.height },
  width: img.width,
  height: img.height,
  isMask: false,
  app,
});

const run = (id, img, params, app) => runFilter(id, img, params, fctx(img, app));

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

suite('filters / registry integrity', async (t) => {
  t.eq(filters.size, 61, 'all 61 filters are registered');
  t.eq(new Set([...filters.keys()]).size, 61, 'filter ids are unique');

  const problems = [];
  for (const [id, def] of filters) {
    if (def.id !== id) problems.push(`${id}: id does not match its registry key`);
    if (!def.name) problems.push(`${id}: no name`);
    if (!FILTER_MENUS.includes(def.menu)) problems.push(`${id}: menu "${def.menu}" is not in FILTER_MENUS`);
    if (typeof def.apply !== 'function') problems.push(`${id}: no apply()`);
    if (!def.defaults) problems.push(`${id}: no defaults`);
    // Defaults must be *derived from* the params, key for key.
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
  t.eq(problems, [], 'every filter has an id, a name, a FILTER_MENUS menu and params-derived defaults');

  // Menu partition. Locking the per-menu counts catches a filter that was
  // dropped or filed under the wrong submenu, which a bare total would miss.
  t.eq(FILTER_MENUS, ['Blur', 'Distort', 'Noise', 'Pixelate', 'Render', 'Sharpen', 'Stylize', 'Other'],
    'FILTER_MENUS is the eight Photoshop submenus, in order');
  const counts = {};
  for (const m of FILTER_MENUS) counts[m] = listFilters(m).length;
  t.eq(counts, { Blur: 11, Distort: 11, Noise: 5, Pixelate: 7, Render: 6, Sharpen: 5, Stylize: 10, Other: 6 },
    'each submenu holds the expected number of filters');
  t.eq(Object.values(counts).reduce((a, b) => a + b, 0), 61, 'the submenus partition every filter');

  const byMenu = filtersByMenu();
  t.eq([...byMenu.keys()], FILTER_MENUS, 'filtersByMenu() keys follow FILTER_MENUS order');
  let total = 0;
  for (const [, list] of byMenu) total += list.length;
  t.eq(total, 61, 'filtersByMenu() loses nothing');
  const blur = byMenu.get('Blur').map((f) => f.name);
  t.eq(blur, [...blur].sort((a, b) => a.localeCompare(b)), 'filtersByMenu() sorts each submenu by name');

  t.eq(getFilter('gaussian-blur').menu, 'Blur', 'getFilter resolves a known id');
  t.eq(getFilter('no-such-filter'), null, 'getFilter returns null for an unknown id');
  await t.throws(() => registerFilter({ name: 'No Id' }), 'registerFilter rejects a definition without an id');

  // needsDialog is derived: no params means run-immediately.
  const noParams = [...filters.values()].filter((f) => !(f.params || []).length);
  t.ok(noParams.length > 0, 'some filters take no params');
  t.eq(noParams.filter((f) => f.needsDialog).map((f) => f.id), [],
    'a parameterless filter never asks for a dialog');
  t.ok(getFilter('gaussian-blur').needsDialog, 'a parameterised filter does ask for a dialog');

  // An unknown id must be a no-op rather than a throw.
  const img = testImage(16, 16);
  const before = new Uint8ClampedArray(img.data);
  const res = run('no-such-filter', img, {}, t.app);
  t.eq(res, img, 'runFilter returns the input ImageData for an unknown id');
  t.eq(t.mad(res.data, before), 0, 'and leaves the pixels alone');
});

/* ------------------------------------------------------------------ */
/* Smoke: every filter, at defaults                                    */
/* ------------------------------------------------------------------ */

suite('filters / every filter runs at its defaults', async (t) => {
  const reference = testImage(96, 96);
  const opaqueBefore = opaqueCount(reference);
  t.eq(opaqueBefore, 96 * 96 - 64, 'the fixture is opaque except for one 8x8 transparent block');

  const unchanged = [];
  for (const [id, def] of filters) {
    const img = testImage(96, 96);
    const before = new Uint8ClampedArray(img.data);
    const problems = [];
    let res = null;
    try {
      res = runFilter(id, img, { ...def.defaults }, fctx(img, t.app));
    } catch (err) {
      problems.push(`threw: ${(err && err.message) || err}`);
    }
    if (res) {
      if (!(res instanceof ImageData)) problems.push('did not yield ImageData');
      else {
        if (res.width !== 96 || res.height !== 96) problems.push(`size became ${res.width}x${res.height}`);
        const bad = badBytes(res);
        if (bad) problems.push(bad);
        const after = opaqueCount(res);
        // A destroyed alpha channel is the usual symptom of a broken
        // premultiply/unpremultiply round trip.
        if (after < opaqueBefore * 0.5) problems.push(`alpha destroyed: ${opaqueBefore} -> ${after} opaque px`);
        let same = res.data.length === before.length;
        if (same) for (let i = 0; i < res.data.length; i++) if (res.data[i] !== before[i]) { same = false; break; }
        if (same) unchanged.push(id);
      }
    }
    t.eq(problems, [], `filter "${id}" runs cleanly at its defaults`);
  }

  // Exactly four filters are the identity at their defaults, and each has a
  // reason to be: no distortion, no mesh, an identity kernel, a zero offset.
  // Anything else appearing here means a filter has silently stopped working.
  t.eq(unchanged.sort(), ['custom', 'lens-correction', 'liquify', 'offset'],
    'only the four genuinely neutral filters leave the image bit-identical at defaults');
});

/* ------------------------------------------------------------------ */
/* Smoke: every filter, at extremes                                    */
/* ------------------------------------------------------------------ */

suite('filters / every filter survives extreme parameters', async (t) => {
  const gone = [];
  for (const [id, def] of filters) {
    const img = testImage(48, 48);
    const problems = [];
    let res = null;
    try {
      res = runFilter(id, img, extremeParams(def), fctx(img, t.app));
    } catch (err) {
      problems.push(`threw: ${(err && err.message) || err}`);
    }
    if (res) {
      if (res.width !== 48 || res.height !== 48) problems.push(`size became ${res.width}x${res.height}`);
      const bad = badBytes(res);
      if (bad) problems.push(bad);
      if (!anyOpaque(res)) gone.push(id);
    }
    t.eq(problems, [], `filter "${id}" survives every parameter at its maximum`);
  }
  // Only the two filters that legitimately can consume the whole image at an
  // extreme setting (a 255px extrusion, a 100px erosion) may end up empty.
  t.eq(gone.sort(), ['extrude', 'minimum'],
    'no other filter throws its alpha channel away at maximum settings');
});

/* ------------------------------------------------------------------ */
/* Ground truth — exact answers                                        */
/* ------------------------------------------------------------------ */

suite('filters / offset is a pure pixel shift', async (t) => {
  const w = 8, h = 8;
  const img = new ImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      d[i] = x * 30; d[i + 1] = y * 30; d[i + 2] = (x * y) % 256; d[i + 3] = 200 + x;
    }
  }
  const src = new Uint8ClampedArray(d);
  run('offset', img, { horizontal: 3, vertical: -2, undefinedAreas: 'wrap' }, t.app);

  let mismatches = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sy = (y + 2) % h, sx = (x - 3 + w) % w;
      const o = (y * w + x) * 4, s = (sy * w + sx) * 4;
      for (let c = 0; c < 4; c++) if (img.data[o + c] !== src[s + c]) mismatches++;
    }
  }
  t.eq(mismatches, 0, 'offset(+3,-2) with wrap is exactly a torus shift of every channel');
  t.ne(px(img, 0, 0), [src[0], src[1], src[2], src[3]], 'and it really moved something (0,0) changed');

  // Transparent mode must clear, not wrap.
  const img2 = new ImageData(w, h);
  img2.data.set(src);
  run('offset', img2, { horizontal: 3, vertical: 0, undefinedAreas: 'transparent' }, t.app);
  t.eq(px(img2, 0, 0), [0, 0, 0, 0], 'undefinedAreas=transparent clears the vacated column');
  t.eq(px(img2, 3, 4), [0, 120, 0, 200], 'while the shifted body is the original column 0');

  // Repeat mode must smear the edge column.
  const img3 = new ImageData(w, h);
  img3.data.set(src);
  run('offset', img3, { horizontal: 3, vertical: 0, undefinedAreas: 'repeat' }, t.app);
  t.eq(px(img3, 0, 4), px(img3, 2, 4), 'undefinedAreas=repeat replicates the edge pixel');
});

suite('filters / solarize maps a known ramp', async (t) => {
  const inputs = [0, 50, 64, 127, 128, 192, 200, 255];
  const img = new ImageData(inputs.length, 1);
  for (let x = 0; x < inputs.length; x++) {
    const i = x * 4;
    img.data[i] = inputs[x]; img.data[i + 1] = inputs[x]; img.data[i + 2] = inputs[x]; img.data[i + 3] = 255;
  }
  run('solarize', img, {}, t.app);
  const got = inputs.map((_, x) => img.data[x * 4]);
  // v <= 127 passes through, v > 127 becomes 255 - v.
  t.eq(got, [0, 50, 64, 127, 127, 63, 55, 0], 'solarize is v>127 ? 255-v : v, exactly');
  t.eq([...img.data].filter((_, i) => i % 4 === 3), [255, 255, 255, 255, 255, 255, 255, 255],
    'solarize leaves alpha alone');
});

suite('filters / maximum and minimum are square morphology', async (t) => {
  // A white dot on black: maximum must dilate it into a (2r+1) square.
  const dot = solid(21, 21, 0, 0, 0);
  const c = (10 * 21 + 10) * 4;
  dot.data[c] = 255; dot.data[c + 1] = 255; dot.data[c + 2] = 255;
  run('maximum', dot, { radius: 2, preserve: 'squareness' }, t.app);

  let white = 0, wrong = 0;
  for (let y = 0; y < 21; y++) {
    for (let x = 0; x < 21; x++) {
      const inside = Math.max(Math.abs(x - 10), Math.abs(y - 10)) <= 2;
      const v = px(dot, x, y);
      const isWhite = v[0] === 255 && v[1] === 255 && v[2] === 255;
      if (isWhite) white++;
      if (isWhite !== inside) wrong++;
    }
  }
  t.eq(white, 25, 'maximum radius 2 dilates one dot into exactly 25 white pixels');
  t.eq(wrong, 0, 'and the white region is exactly the 5x5 Chebyshev disc around the dot');

  // A black dot on white: minimum must erode the white by the same radius.
  const hole = solid(21, 21, 255, 255, 255);
  hole.data[c] = 0; hole.data[c + 1] = 0; hole.data[c + 2] = 0;
  run('minimum', hole, { radius: 2, preserve: 'squareness' }, t.app);
  t.eq(px(hole, 12, 12), [0, 0, 0, 255], 'minimum radius 2 reaches the corner of the 5x5 square');
  t.eq(px(hole, 13, 10), [255, 255, 255, 255], 'and stops one pixel further out');

  // Radius 0 must be a strict no-op.
  const flat = testImage(24, 24);
  const before = new Uint8ClampedArray(flat.data);
  run('maximum', flat, { radius: 0, preserve: 'squareness' }, t.app);
  t.eq(t.mad(flat.data, before), 0, 'maximum radius 0 is a no-op');
});

suite('filters / flat-field identities', async (t) => {
  // A flat field has no gradient anywhere, so the answers are exact.
  const edges = run('find-edges', solid(16, 16, 90, 120, 200), {}, t.app);
  t.eq(px(edges, 8, 8), [255, 255, 255, 255], 'find-edges on a flat field is white (zero gradient, Photoshop polarity)');
  t.eq(px(edges, 0, 0), [255, 255, 255, 255], 'including the clamped corner');
  // Non-vacuity: a real edge must be visibly darker than the flat answer.
  const stepImg = new ImageData(16, 16);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const i = (y * 16 + x) * 4;
      const v = x < 8 ? 0 : 255;
      stepImg.data[i] = v; stepImg.data[i + 1] = v; stepImg.data[i + 2] = v; stepImg.data[i + 3] = 255;
    }
  }
  run('find-edges', stepImg, {}, t.app);
  t.lt(px(stepImg, 8, 8)[0], 128, 'find-edges darkens a real edge, so the flat answer above is not vacuous');

  const hp = run('high-pass', solid(16, 16, 90, 120, 200), { radius: 10 }, t.app);
  t.eq(px(hp, 8, 8), [128, 128, 128, 255], 'high-pass on a flat field is mid-grey');
  t.eq(px(hp, 0, 15), [128, 128, 128, 255], 'including the clamped border');

  const em = run('emboss', solid(16, 16, 90, 120, 200), { angle: 135, height: 3, amount: 100 }, t.app);
  t.eq(px(em, 8, 8), [128, 128, 128, 255], 'emboss on a flat field is mid-grey');
  t.eq(px(em, 0, 0), [128, 128, 128, 255], 'including the clamped corner');
});

suite('filters / median removes salt and pepper', async (t) => {
  const w = 24, h = 24;
  const img = solid(w, h, 100, 100, 100);
  const spots = [[5, 5, 255], [12, 9, 255], [18, 17, 255], [8, 14, 0], [15, 4, 0]];
  for (const [x, y, v] of spots) {
    const i = (y * w + x) * 4;
    img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v;
  }
  // Precondition: the noise really is there.
  t.eq(px(img, 5, 5), [255, 255, 255, 255], 'the salt pixel is present before filtering');
  t.eq(px(img, 8, 14), [0, 0, 0, 255], 'the pepper pixel is present before filtering');

  run('median', img, { radius: 1 }, t.app);
  let offField = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = px(img, x, y);
      if (v[0] !== 100 || v[1] !== 100 || v[2] !== 100 || v[3] !== 255) offField++;
    }
  }
  t.eq(offField, 0, 'median radius 1 restores every pixel to the underlying flat 100 field');
});

suite('filters / mosaic honours its cell size', async (t) => {
  const w = 12, h = 12;
  const img = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      img.data[i] = x * 20; img.data[i + 1] = y * 20; img.data[i + 2] = 128; img.data[i + 3] = 255;
    }
  }
  run('mosaic', img, { cellSize: 4 }, t.app);
  // Cell (0,0) spans x,y in 0..3: mean red = mean(0,20,40,60) = 30, mean green
  // is the same by symmetry.
  t.eq(px(img, 0, 0), [30, 30, 128, 255], 'the first 4x4 cell holds the exact average of its 16 pixels');
  t.eq(px(img, 3, 3), [30, 30, 128, 255], 'the whole cell is flat');
  t.eq(px(img, 1, 2), [30, 30, 128, 255], 'every pixel inside the cell got the same value');
  // Cell (1,0) spans x in 4..7: mean red = mean(80,100,120,140) = 110.
  t.eq(px(img, 4, 0), [110, 30, 128, 255], 'the next cell along holds its own average, so the grid steps by 4');
  t.ne(px(img, 3, 0), px(img, 4, 0), 'the cell boundary at x=4 is a real discontinuity');
});

suite('filters / gaussian blur', async (t) => {
  // Radius 0 must be bit-identical (the dialog's minimum is 0.1, but a preset
  // or a smart-filter payload can still carry 0).
  const img = testImage(32, 32);
  const before = new Uint8ClampedArray(img.data);
  run('gaussian-blur', img, { radius: 0 }, t.app);
  t.eq(t.mad(img.data, before), 0, 'gaussian-blur radius 0 is a bit-identical no-op');

  // A hard 0/255 edge must be pulled toward the middle. 64x8 keeps this on the
  // deterministic JS path (the GPU path only kicks in above 90k pixels).
  const w = 64, h = 8;
  const step = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = x < w / 2 ? 0 : 255;
      step.data[i] = v; step.data[i + 1] = v; step.data[i + 2] = v; step.data[i + 3] = 255;
    }
  }
  t.eq(px(step, 31, 4), [0, 0, 0, 255], 'the edge starts perfectly hard');
  run('gaussian-blur', step, { radius: 16 }, t.app);
  t.close(px(step, 31, 4)[0], 128, 8, 'the pixel left of the edge lands near mid-grey');
  t.close(px(step, 32, 4)[0], 128, 8, 'and so does the pixel right of it');
  t.lt(px(step, 32, 4)[0] - px(step, 31, 4)[0], 16, 'the 255-level step has collapsed to a few levels');
  t.gt(px(step, 0, 4)[0], 0, 'the far dark end has been lifted (edges are clamped, not faded)');
  t.lt(px(step, 63, 4)[0], 255, 'and the far bright end has been pulled down');
  t.eq(px(step, 0, 4)[3], 255, 'alpha is untouched by the blur');
});

suite('filters / seeded generators are deterministic', async (t) => {
  const grey = () => solid(16, 16, 120, 120, 120);
  const a = run('add-noise', grey(), { amount: 50, seed: 7 }, t.app);
  const b = run('add-noise', grey(), { amount: 50, seed: 7 }, t.app);
  const c = run('add-noise', grey(), { amount: 50, seed: 8 }, t.app);
  t.gt(t.mad(a.data, grey().data), 1, 'add-noise actually perturbs the field');
  t.eq(t.mad(a.data, b.data), 0, 'add-noise with the same seed is bit-identical');
  t.gt(t.mad(a.data, c.data), 0, 'add-noise with a different seed differs');

  const blank = () => new ImageData(32, 32);
  const c1 = run('clouds', blank(), { seed: 5, scale: 100, roughness: 50 }, t.app);
  const c2 = run('clouds', blank(), { seed: 5, scale: 100, roughness: 50 }, t.app);
  const c3 = run('clouds', blank(), { seed: 6, scale: 100, roughness: 50 }, t.app);
  t.eq(t.mad(c1.data, c2.data), 0, 'clouds with the same seed is bit-identical');
  t.gt(t.mad(c1.data, c3.data), 0, 'clouds with a different seed differs');
  t.eq(px(c1, 0, 0)[3], 255, 'clouds fills the region opaquely');

  // The shared PRNG itself.
  const r1 = makeRandom(42), r2 = makeRandom(42), r3 = makeRandom(43);
  const draw = (r) => [r(), r(), r(), r()];
  const s1 = draw(r1);
  t.eq(s1, draw(r2), 'makeRandom(seed) replays the same sequence');
  t.ne(s1, draw(r3), 'a different seed gives a different sequence');
  t.ok(s1.every((v) => v >= 0 && v < 1), 'makeRandom stays in [0,1)');

  // gaussianKernel is the maths every convolution filter leans on.
  const k = gaussianKernel(2);
  t.close([...k].reduce((a2, b2) => a2 + b2, 0), 1, 1e-5, 'gaussianKernel is normalised to sum 1');
  t.eq(k.length, 13, 'gaussianKernel(2) spans ceil(3*sigma) either side');
  t.eq(k[0], k[k.length - 1], 'gaussianKernel is symmetric');
  t.gt(k[6], k[5], 'and peaks in the centre');
  t.eq([...gaussianKernel(0)], [1], 'gaussianKernel(0) is the identity tap');
});

/* ------------------------------------------------------------------ */
/* The runner                                                          */
/* ------------------------------------------------------------------ */

suite('filters / runner honours the selection and history', async (t) => {
  const doc = t.doc(40, 40, '#ffffff', 'filter-run');
  // The runner reads app.activeDoc, so a wrong app instance would silently do
  // nothing. Assert the wiring before asserting the behaviour.
  t.eq(t.app.activeDoc, doc, 'the scratch document is the live active document');
  const layer = doc.activeLayer();
  t.eq(t.px(layer.canvas, 20, 20), '255,255,255,255', 'the layer starts white');

  doc.selection.combine(Selection.rectMask(10, 10, 20, 20, 40, 40), 'replace');
  t.ok(doc.selection.active, 'the selection is active');
  t.eq(operableRect(doc), { x: 10, y: 10, width: 20, height: 20 }, 'operableRect is the selection bounds');
  t.eq(operableSurface(doc, layer), { canvas: layer.canvas, isMask: false }, 'operableSurface targets the layer pixels');

  // processSurface must produce the result without touching the document.
  const out = processSurface(doc, layer, (img, ctx) =>
    runFilter('solarize', img, {}, { ...ctx, width: img.width, height: img.height, app: t.app }));
  t.eq([out.width, out.height], [40, 40], 'processSurface returns a full document-sized canvas');
  t.pixel(out, 20, 20, '0,0,0,255', 'solarize turned white into black inside the selection');
  t.pixel(out, 5, 5, '255,255,255,255', 'a pixel outside the selection is untouched');
  t.pixel(out, 9, 9, '255,255,255,255', 'the pixel one step outside the selection edge is untouched');
  t.pixel(out, 10, 10, '0,0,0,255', 'the first pixel inside the selection edge did change');
  t.pixel(layer.canvas, 20, 20, '255,255,255,255', 'processSurface left the document alone');

  // applyFilterCommand: parameterless filters skip the dialog entirely.
  const states = doc.history.states.length;
  await applyFilterCommand('solarize');
  t.eq(doc.history.states.length, states + 1, 'applyFilterCommand records exactly one history entry');
  t.eq(doc.history.states[doc.history.index].label, 'Solarize', 'the entry is labelled after the filter');

  // restoreState rebuilds layers, so never reuse `layer` past a commit.
  t.pixel(doc.activeLayer().canvas, 20, 20, '0,0,0,255', 'the filter landed inside the selection');
  t.pixel(doc.activeLayer().canvas, 5, 5, '255,255,255,255', 'and left everything outside it white');
  t.pixel(doc.activeLayer().canvas, 30, 30, '255,255,255,255', 'including the far side of the selection');
  t.eq(t.app.lastFilter.id, 'solarize', 'app.lastFilter remembers the filter for Ctrl+F');

  doc.history.undo();
  t.pixel(doc.activeLayer().canvas, 20, 20, '255,255,255,255', 'undo restores the pre-filter pixels exactly');

  // Without a selection the whole layer is fair game.
  const doc2 = t.doc(20, 20, '#ffffff', 'filter-all');
  t.eq(t.app.activeDoc, doc2, 'the second document became active');
  const states2 = doc2.history.states.length;
  await applyFilterCommand('solarize');
  t.eq(doc2.history.states.length, states2 + 1, 'still exactly one history entry with no selection');
  t.pixel(doc2.activeLayer().canvas, 0, 0, '0,0,0,255', 'the corner changed too when nothing is selected');
  t.pixel(doc2.activeLayer().canvas, 19, 19, '0,0,0,255', 'and so did the opposite corner');
});

/* ------------------------------------------------------------------ */
/* Purity                                                             */
/* ------------------------------------------------------------------ */

suite('filters / running the same filter twice is reproducible', async (t) => {
  // Any filter reading hidden global state (an uninitialised buffer, a shared
  // scratch array, Math.random) shows up here.
  const drift = [];
  const mutated = [];
  for (const [id, def] of filters) {
    const params = { ...def.defaults };
    const frozen = JSON.stringify(params);
    const imgA = testImage(48, 48);
    const imgB = testImage(48, 48);
    const a = runFilter(id, imgA, params, fctx(imgA, t.app));
    const b = runFilter(id, imgB, params, fctx(imgB, t.app));
    if (t.mad(a.data, b.data) !== 0) drift.push(id);
    if (JSON.stringify(params) !== frozen) mutated.push(id);
  }
  t.eq(drift, [], 'every filter is a pure function of (pixels, params) — two runs agree bit for bit');
  t.eq(mutated, [], 'no filter mutates the params object it was handed');
});
