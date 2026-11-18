import { suite } from '../harness.js';
import { createRasterLayer, Layer } from '/src/core/layer.js';
import {
  compositeDocument, getComposite, setLayerPreview, setCompositeVerify, compositeVerifyStats,
  compositeVerifyEnabled,
} from '/src/render/compositor.js';
import { DEFAULT_STYLES, renderers } from '/src/effects/styles.js';
import { effectCacheStats, setEffectCacheBudget, effectCacheBudget, clearEffectCache } from '/src/effects/effect-cache.js';
import { setGPUEnabled, gpuReady } from '/src/render/gpu-device.js';
import { createCanvas, ctx2dRead } from '/src/core/util.js';

/**
 * The layer-effect cache (src/effects/effect-cache.js) behind the live
 * composite.
 *
 * Two promises, tested from both sides:
 *   - reuse: painting, undoing or re-styling something else must not re-run a
 *     styled layer's renderers (counted with spies on the renderer map);
 *   - truth: every live composite must equal a from-scratch render, however
 *     the styled layer itself is edited — through the real tools, in-place
 *     style edits, previews and history.
 */

const SPIED = ['dropShadow', 'stroke', 'innerGlow', 'outerGlow', 'gradientOverlay'];

/**
 * Count renderer calls, restoring the real renderers whatever happens. Verify
 * mode (?verifycomposite=1) re-renders every live composite from scratch, which
 * would count as calls, so it is off while a spy counts.
 */
function spyRenderers() {
  const counts = Object.fromEntries(SPIED.map((k) => [k, 0]));
  const originals = new Map();
  const verifying = compositeVerifyEnabled();
  setCompositeVerify(false);
  for (const id of SPIED) {
    const fn = renderers.get(id);
    originals.set(id, fn);
    renderers.set(id, (cfg, env) => { counts[id]++; return fn(cfg, env); });
  }
  return {
    counts,
    total: () => SPIED.reduce((s, k) => s + counts[k], 0),
    reset() { for (const k of SPIED) counts[k] = 0; },
    restore() {
      for (const [id, fn] of originals) renderers.set(id, fn);
      setCompositeVerify(verifying);
    },
  };
}

function same(a, b) {
  const A = ctx2dRead(a).getImageData(0, 0, a.width, a.height).data;
  const B = ctx2dRead(b).getImageData(0, 0, b.width, b.height).data;
  if (A.length !== B.length) return false;
  for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) return false;
  return true;
}

/**
 * A 900x600 document: a styled shape S, and an empty layer P above it to paint
 * on. Region sizes put S's effects on whichever renderer path applies.
 */
function scene(t, name) {
  const doc = t.doc(900, 600, '#ffffff', name);
  const S = doc.addLayer(createRasterLayer(900, 600, 'Styled'));
  t.fill(S, '#3366cc', 250, 150, 300, 200);
  S.styles = {
    dropShadow: { ...DEFAULT_STYLES.dropShadow, enabled: true, size: 14, distance: 10, useGlobalLight: false, angle: 120 },
    stroke: { ...DEFAULT_STYLES.stroke, enabled: true, size: 4, position: 'outside', color: '#ff0000' },
    innerGlow: { ...DEFAULT_STYLES.innerGlow, enabled: true, size: 12 },
  };
  const P = doc.addLayer(createRasterLayer(900, 600, 'Paint'));
  doc.commit('setup');
  return { doc, S, P };
}

const ptr = { pressure: 1, pointerType: 'mouse', button: 0, buttons: 1, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };

/** Drag the current tool from (x0,y0) to (x1,y1) in `n` frames, compositing live after each. */
function dragTool(t, doc, x0, y0, x1, y1, n, onFrame) {
  const tool = t.app.tool;
  tool.onPointerDown({ ...ptr, x: x0, y: y0, sx: x0, sy: y0 });
  onFrame && onFrame(0);
  for (let i = 1; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * i) / n;
    tool.onPointerMove({ ...ptr, x, y, sx: x, sy: y });
    onFrame && onFrame(i);
  }
  tool.onPointerUp({ ...ptr, x: x1, y: y1, sx: x1, sy: y1 });
}

function withTool(t, id, fn) {
  const app = t.app;
  const prev = app.tool && app.tool.id;
  const prevFg = app.foreground;
  try {
    app.setTool(id);
    return fn(app.tool);
  } finally {
    if (app.tool && app.tool.cancel) app.tool.cancel();
    app.setForeground(prevFg);
    if (prev) app.setTool(prev);
  }
}

/* ================================================================== */

suite('effect cache / painting another layer reuses a styled layer\'s effects', async (t) => {
  // Verified to fail: keying entries on a per-composite counter (so nothing is
  // ever reused) re-renders S's three effects on all 11 frames.
  const { doc, S, P } = scene(t, 'fx-reuse');
  const spy = spyRenderers();
  try {
    getComposite(doc); // warm
    const warm = spy.total();
    t.eq(warm, 3, 'the first live composite renders S\'s three effects once each');
    doc.setActiveLayer(P.id);
    let liveRenders = 0;
    const frames = [];
    withTool(t, 'brush', () => {
      t.app.setForeground('#00aa00');
      dragTool(t, doc, 100, 500, 800, 480, 10, () => {
        const before = spy.total();
        frames.push(getComposite(doc));
        liveRenders += spy.total() - before;
      });
    });
    t.eq(liveRenders, 0, `eleven frames of painting P re-ran none of S's renderers (${liveRenders})`);
    const before = spy.total();
    const live = getComposite(doc);
    t.eq(spy.total() - before, 0, 'nor did the composite after the stroke was committed');
    t.ok(same(live, compositeDocument(doc)), 'and the live composite is exactly a from-scratch render');
    t.gt(t.inked(P.canvas), 500, 'precondition: the brush really painted P');
  } finally {
    spy.restore();
  }
});

suite('effect cache / editing the styled layer itself is never stale', async (t) => {
  // Verified to fail: without the live-layer bump in PikaDocument.invalidate,
  // the brush and smudge frames on S show its first frame's shadow; with the
  // tile offset left out of the key, the moved layer keeps its old shadow.
  const { doc, S } = scene(t, 'fx-stale');
  doc.setActiveLayer(S.id);
  getComposite(doc);
  const spy = spyRenderers();
  try {
    let liveRenders = 0;
    const check = () => {
      const n = spy.total();
      const live = getComposite(doc);
      liveRenders += spy.total() - n;
      return same(live, compositeDocument(doc)) ? 0 : 1;
    };
    for (const [tool, setup] of [
      ['brush', () => t.app.setForeground('#ffcc00')],
      ['smudge', () => {}],
      ['gradient', () => t.app.setForeground('#00ffcc')],
    ]) {
      let stale = 0;
      withTool(t, tool, () => {
        setup();
        dragTool(t, doc, 300, 200, 480, 320, 6, () => { stale += check(); });
      });
      stale += check();
      t.eq(stale, 0, `${tool} on the styled layer: every live frame equals a fresh render`);
    }
    t.gt(liveRenders, 0, `and the live composites did re-run S's renderers (${liveRenders} calls)`);

    // Move the whole layer: same buffer, new offset.
    let stale = 0;
    withTool(t, 'move', (move) => {
      const state = { ...move.state };
      Object.assign(move.state, { autoSelect: false, showTransform: false });
      try {
        dragTool(t, doc, 400, 250, 470, 290, 5, () => { stale += check(); });
      } finally {
        Object.assign(move.state, state);
      }
    });
    stale += check();
    t.eq(stale, 0, 'moving the styled layer: every live frame equals a fresh render');
    t.ok(S.tile || doc.findLayer(S.id).tile, 'precondition: the move left the layer compact, at an offset');
  } finally {
    spy.restore();
  }
});

suite('effect cache / style edits made in place are seen', async (t) => {
  // Verified to fail: keying effects on the styles object (identity) misses
  // every one of these edits, which all mutate it in place.
  const { doc, S } = scene(t, 'fx-inplace');
  getComposite(doc);
  const spy = spyRenderers();
  const fresh = (label) => t.ok(same(getComposite(doc), compositeDocument(doc)), `${label}: the live composite is fresh`);
  try {
    S.styles.dropShadow.distance = 30;
    doc.touch('layer-style');
    const n1 = spy.counts.dropShadow;
    fresh('shadow distance edited in place');
    t.gt(spy.counts.dropShadow, 0, 'the edit re-ran the shadow');

    // A colour changes nothing about where the effect reaches, so only the
    // effect's own key can notice it.
    const g = spy.counts.innerGlow;
    S.styles.innerGlow.color = '#00ff00';
    doc.touch('layer-style');
    fresh('inner glow colour edited in place');
    t.gt(spy.counts.innerGlow, g, 'the colour edit re-ran the inner glow');

    S.styles.stroke.enabled = false;
    doc.touch('layer-style');
    fresh('stroke switched off in place (the Layers panel eye)');

    S.styles.dropShadow.useGlobalLight = true;
    doc.touch('layer-style');
    getComposite(doc);
    const before = spy.counts.dropShadow;
    doc.globalLight = 30;
    doc.touch('global-light');
    fresh('global light changed');
    t.gt(spy.counts.dropShadow, before, 'a shadow using global light re-renders when the angle changes');
    t.gt(spy.counts.dropShadow, n1, 'sanity: counts only grow');

    S.styles.gradientOverlay = {
      ...DEFAULT_STYLES.gradientOverlay, enabled: true,
      stops: [{ pos: 0, color: 'foreground' }, { pos: 1, color: '#ffffff' }],
    };
    doc.touch('layer-style');
    getComposite(doc);
    const g0 = spy.counts.gradientOverlay;
    const prevFg = t.app.foreground;
    try {
      t.app.setForeground('#ff00ff');
      doc.touch('foreground');
      fresh('the foreground colour a gradient stop names changed');
      t.gt(spy.counts.gradientOverlay, g0, 'so the gradient overlay re-rendered');
      S.styles.gradientOverlay.stops = [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }];
      doc.touch('layer-style');
      getComposite(doc);
      const g1 = spy.counts.gradientOverlay;
      const d1 = spy.counts.dropShadow;
      t.app.setForeground('#00ffff');
      doc.touch('foreground');
      getComposite(doc);
      t.eq(spy.counts.gradientOverlay, g1, 'with no foreground stop, a new foreground re-renders nothing');
      t.eq(spy.counts.dropShadow, d1, 'and nothing else either');
    } finally {
      t.app.setForeground(prevFg);
    }
  } finally {
    spy.restore();
  }
});

suite('effect cache / opacity and fill are not render inputs', async (t) => {
  const { doc, S } = scene(t, 'fx-opacity');
  // Spy first: renderer identity is part of the key, so wrapping them after
  // the warm-up composite would itself force one re-render.
  const spy = spyRenderers();
  try {
    getComposite(doc);
    spy.reset();
    S.styles.dropShadow.opacity = 0.3;
    S.styles.stroke.opacity = 0.5;
    S.opacity = 0.8;
    doc.touch('opacity');
    const live = getComposite(doc);
    const n = spy.total();
    t.ok(same(live, compositeDocument(doc)), 'new effect and layer opacities draw correctly');
    t.eq(n, 0, 'without re-running any renderer');

    const stats = effectCacheStats(doc);
    S.fillOpacity = 0.4;
    doc.touch('fill');
    const n2 = spy.total();
    const live2 = getComposite(doc);
    t.eq(spy.total(), n2, 'changing Fill re-runs no renderer either');
    t.gt(effectCacheStats(doc).composes, stats.composes, 'it only recomposes the content with the cached effects');
    t.ok(same(live2, compositeDocument(doc)), 'and the result is exact');
  } finally {
    spy.restore();
  }
});

suite('effect cache / WebGPU on or off is part of the key', async (t) => {
  // Verified to fail: without the GPU state in the base key, switching WebGPU
  // off keeps serving the GPU-rendered results.
  if (!(await gpuReady())) {
    t.ok(true, 'WebGPU is not available in this browser — NOT exercised here');
    return;
  }
  const doc = t.doc(1200, 900, '#ffffff', 'fx-gpu-key');
  const S = doc.addLayer(createRasterLayer(1200, 900, 'Styled'));
  t.fill(S, '#3366cc', 200, 150, 800, 600);
  S.styles = { dropShadow: { ...DEFAULT_STYLES.dropShadow, enabled: true, size: 20, distance: 8 } };
  doc.commit('setup');
  const spy = spyRenderers();
  try {
    getComposite(doc);
    spy.reset();
    doc.touch('x');
    getComposite(doc);
    t.eq(spy.counts.dropShadow, 0, 'precondition: with nothing changed, the shadow is reused');
    setGPUEnabled(false);
    doc.touch('x');
    const cpu = getComposite(doc);
    t.eq(spy.counts.dropShadow, 1, 'turning WebGPU off re-renders the shadow');
    t.ok(same(cpu, compositeDocument(doc)), 'so the live composite matches the CPU render exactly');
  } finally {
    setGPUEnabled(true);
    spy.restore();
  }
});

suite('effect cache / previews, history and compact layers', async (t) => {
  const { doc, S, P } = scene(t, 'fx-misc');
  const spy = spyRenderers();
  try {
    getComposite(doc);
    // A preview stands in for S's pixels: its effects show, uncached.
    const stand = createCanvas(900, 600);
    stand.getContext('2d').fillRect(50, 50, 120, 90);
    setLayerPreview(S.id, stand);
    try {
      doc.touch('preview');
      t.ok(same(getComposite(doc), compositeDocument(doc)), 'a layer preview\'s effects show in the live composite');
    } finally {
      setLayerPreview(S.id, null);
    }
    doc.touch('preview');
    const n = spy.total();
    getComposite(doc);
    t.eq(spy.total(), n, 'clearing the preview goes back to the cached results, unrendered');

    // Undo of an edit to another layer re-renders nothing.
    doc.beginEdit(P);
    P.canvas.getContext('2d').fillRect(0, 0, 40, 40);
    doc.commit('paint');
    getComposite(doc);
    const n2 = spy.total();
    doc.history.undo();
    getComposite(doc);
    doc.history.redo();
    const redone = getComposite(doc);
    t.eq(spy.total() - n2, 0, 'undo and redo of an edit to another layer re-render none of S\'s effects');
    t.ok(same(redone, compositeDocument(doc)), 'and the composite after redo is exact');
  } finally {
    spy.restore();
  }

  // A compact (tile) layer: a hit must not build its document-sized view.
  const doc2 = t.doc(900, 600, '#ffffff', 'fx-tile');
  const L = doc2.addLayer(createRasterLayer(900, 600, 'tile'));
  const tile = createCanvas(200, 120);
  tile.getContext('2d').fillRect(0, 0, 200, 120);
  L.setTile(tile, 300, 200, 900, 600);
  L.styles = { dropShadow: { ...DEFAULT_STYLES.dropShadow, enabled: true, size: 10 } };
  doc2.commit('setup');
  getComposite(doc2);
  const orig = Layer.prototype.renderCanvas;
  let calls = 0;
  Layer.prototype.renderCanvas = function (...args) { if (this === L || this.id === L.id) calls++; return orig.apply(this, args); };
  const verifying = compositeVerifyEnabled();
  setCompositeVerify(false); // a from-scratch check render would build the view itself
  try {
    doc2.touch('x');
    getComposite(doc2);
  } finally {
    Layer.prototype.renderCanvas = orig;
    setCompositeVerify(verifying);
  }
  t.eq(calls, 0, 'a cache hit never asks a compact layer for its document-sized view');
  t.ok(L.tile, 'and the layer is still compact');
});

suite('effect cache / memory is counted and bounded', async (t) => {
  // Verified to fail: leaving the cache out of memoryUse() reports the same
  // figure with and without the cached results.
  const { doc } = scene(t, 'fx-memory');
  clearEffectCache(doc);
  doc.touch('x');
  const empty = doc.memoryUse();
  getComposite(doc);
  const stats = effectCacheStats(doc);
  t.gt(stats.bytes, 0, `the composite cached ${stats.bytes} bytes of results`);
  t.gt(doc.memoryUse(), empty, 'and the document\'s memory figure counts them');

  const prev = effectCacheBudget();
  setEffectCacheBudget(1024);
  try {
    clearEffectCache(doc);
    doc.touch('x');
    const live = getComposite(doc);
    t.eq(effectCacheStats(doc).entries, 0, 'over budget, nothing is kept');
    t.ok(same(live, compositeDocument(doc)), 'and the composite is still right');
  } finally {
    setEffectCacheBudget(prev);
  }
});

suite('effect cache / verify mode catches a write that skipped beginEdit', async (t) => {
  // The debugging aid for golden rule 2: a write into a styled layer without
  // beginEdit leaves the cache serving old effects, and ?verifycomposite=1
  // must say so.
  const { doc, S } = scene(t, 'fx-verify');
  getComposite(doc);
  const verifying = compositeVerifyEnabled();
  setCompositeVerify(true);
  try {
    const before = compositeVerifyStats().mismatches;
    S.canvas.getContext('2d').fillRect(600, 400, 80, 60); // no beginEdit
    doc.touch('rogue');
    getComposite(doc);
    t.gt(compositeVerifyStats().mismatches, before, 'the live composite is flagged as different from a fresh render');
    doc.invalidatePixels(S);
    getComposite(doc);
    const after = compositeVerifyStats().mismatches;
    doc.touch('again');
    getComposite(doc);
    t.eq(compositeVerifyStats().mismatches, after, 'after invalidatePixels the cache is right again');
  } finally {
    setCompositeVerify(verifying);
  }
});
