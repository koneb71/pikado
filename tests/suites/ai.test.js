import { suite } from '../harness.js';
import {
  planFrame, cropToRequest, requestMask, patchFromResult, maskToGreyCanvas, fillCoverage,
} from '/src/ai/geometry.js';
import { runGenerativeFill, applyGeneratedFill, layerNameFor } from '/src/ai/generative-fill.js';
import { getProvider, registerProvider, listProviders } from '/src/ai/providers/index.js';
import { MOCK_DELAY, MOCK_FAILURE } from '/src/ai/providers/mock.js';
import { extractImage, buildRequest } from '/src/ai/providers/openai.js';
import { GEN_ERRORS, GenerationError, mapHttpError, mapThrown, messageFor } from '/src/ai/errors.js';
import { setCredential, forgetAllCredentials } from '/src/ai/credentials.js';
import { grantConsent, revokeConsent, hasConsent, hostOf } from '/src/ai/consent.js';
import { getComposite } from '/src/render/compositor.js';
import { createCanvas, ctx2d } from '/src/core/util.js';

/**
 * Generative Fill.
 *
 * Nothing here touches the network. The provider contract is satisfied by the
 * mock provider, which is the whole reason it exists — the failure paths are the
 * ones that matter most and the ones a real API is least willing to produce on
 * demand.
 *
 * The geometry is where this feature is right or wrong, so it gets the most
 * attention, and it is checked by *invariants* rather than by hand-copied magic
 * numbers: a crop that fails to contain the selection leaves part of the
 * selection unfilled no matter how plausible its coordinates look.
 */

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

const FRAME_CASES = [
  ['small selection, big document', { x: 900, y: 900, width: 200, height: 200 }, 2000, 2000],
  ['flush against the top-left', { x: 0, y: 0, width: 100, height: 100 }, 2000, 2000],
  ['flush against the bottom-right', { x: 1900, y: 1900, width: 100, height: 100 }, 2000, 2000],
  ['document smaller than the request', { x: 100, y: 80, width: 60, height: 40 }, 300, 200],
  ['selection wider than it is tall', { x: 0, y: 150, width: 1200, height: 100 }, 1200, 400],
  ['the whole document', { x: 0, y: 0, width: 500, height: 500 }, 500, 500],
  ['a single pixel', { x: 250, y: 250, width: 1, height: 1 }, 600, 600],
  ['a tall thin strip', { x: 300, y: 0, width: 4, height: 800 }, 900, 800],
];

suite('ai / planFrame contains the selection and stays in the document', async (t) => {
  /*
   * Two invariants that no arrangement of the maths may break. Violating the
   * first silently leaves part of what the user selected unfilled; violating the
   * second reads pixels that do not exist.
   */
  for (const [name, bounds, dw, dh] of FRAME_CASES) {
    const f = planFrame(bounds, dw, dh);
    const c = f.crop;
    t.ok(
      c.x <= bounds.x && c.y <= bounds.y
      && c.x + c.width >= bounds.x + bounds.width
      && c.y + c.height >= bounds.y + bounds.height,
      `${name}: the crop contains the whole selection`,
    );
    t.ok(
      c.x >= 0 && c.y >= 0 && c.x + c.width <= dw && c.y + c.height <= dh,
      `${name}: the crop stays inside the document`,
    );
    t.gt(f.scale, 0, `${name}: the scale is positive`);
  }
});

suite('ai / planFrame grows for free rather than upscaling', async (t) => {
  /*
   * The naive implementation takes the bounding box plus a margin and scales it
   * up to the request size, which throws away real neighbouring pixels in order
   * to send invented ones. Here a 200x200 selection sits in a 2000x2000
   * document, so a full 1024x1024 crop of genuine pixels is available at no cost.
   * Verified to fail without the "grow for free" line: the crop comes back
   * 300x300 at scale 3.41.
   */
  const f = planFrame({ x: 900, y: 900, width: 200, height: 200 }, 2000, 2000, { size: 1024 });
  t.eq(`${f.crop.width}x${f.crop.height}`, '1024x1024', 'the crop grows to the request size');
  t.close(f.scale, 1, 1e-9, 'so nothing is resampled at all');

  // At an edge it must slide, not shrink — shrinking gives the model least
  // context exactly where it already has least.
  const corner = planFrame({ x: 0, y: 0, width: 100, height: 100 }, 2000, 2000, { size: 1024 });
  t.eq(`${corner.crop.x},${corner.crop.y}`, '0,0', 'at a corner the crop slides');
  t.eq(`${corner.crop.width}x${corner.crop.height}`, '1024x1024', 'and keeps its full size');

  // A document smaller than the request can only upscale, and must say so.
  const small = planFrame({ x: 100, y: 80, width: 60, height: 40 }, 300, 200, { size: 1024 });
  t.gt(small.scale, 1, 'a small document reports that it is upscaling');
  t.eq(`${small.crop.width}x${small.crop.height}`, '200x200', 'taking as much of the document as it can');
});

suite('ai / the frame round trip is invertible', async (t) => {
  /*
   * Send a crop, get the same square back, and the pixels must return to the
   * document coordinates they came from. One assertion catches every sign error
   * and every centring error in the inset maths.
   */
  const src = createCanvas(1200, 400);
  const c = ctx2d(src);
  c.fillStyle = '#204080';
  c.fillRect(0, 0, 1200, 400);
  c.fillStyle = '#ff0000';
  c.fillRect(100, 150, 60, 60);

  const frame = planFrame({ x: 100, y: 150, width: 60, height: 60 }, 1200, 400);
  const req = cropToRequest(src, frame);
  t.eq(`${req.width}x${req.height}`, '1024x1024', 'the request is the provider square');

  const back = patchFromResult(req, frame);
  t.eq(`${back.width}x${back.height}`, `${frame.crop.width}x${frame.crop.height}`, 'the patch is crop-sized');
  t.pixel(back, 100 - frame.crop.x + 30, 150 - frame.crop.y + 30, '255,0,0,255',
    'the marked pixels come back where they started');

  /*
   * `inset` is stored as fractions rather than pixels precisely so that a
   * provider answering at a different resolution still lands correctly — it is
   * merely softer. Verified to fail if inset is stored in pixels: the patch
   * lands at a quarter offset.
   */
  const half = createCanvas(req.width / 2, req.height / 2);
  ctx2d(half).drawImage(req, 0, 0, half.width, half.height);
  const backHalf = patchFromResult(half, frame);
  t.pixel(backHalf, 100 - frame.crop.x + 30, 150 - frame.crop.y + 30, '255,0,0,255',
    'a half-size response still lands in the right place');
});

suite('ai / mask polarity and the two deliberate asymmetries', async (t) => {
  const W = 64, H = 64;
  const cov = new Uint8ClampedArray(W * H);
  for (let y = 20; y < 44; y++) for (let x = 20; x < 44; x++) cov[y * W + x] = 255;
  const frame = planFrame({ x: 20, y: 20, width: 24, height: 24 }, W, H, { size: 64 });

  /*
   * Every provider convention must mark the same 576 pixels. alpha-holes was
   * genuinely broken when first written and returned zero: staging holes as
   * transparent and drawing them over an opaque background does nothing, because
   * drawImage composites source-over. It needs destination-out.
   */
  for (const polarity of ['alpha-holes', 'white-fills', 'black-fills']) {
    const m = requestMask(cov, W, H, frame, { polarity, dilate: 0 });
    t.eq(fillCoverage(m, polarity), 576, `${polarity} marks exactly the selected pixels`);
  }

  // Dilation overshoots on purpose: a provider that reproduces the boundary a
  // pixel off would otherwise leave a halo of original pixels along the seam.
  const tight = fillCoverage(requestMask(cov, W, H, frame, { dilate: 0 }), 'alpha-holes');
  const grown = fillCoverage(requestMask(cov, W, H, frame, { dilate: 3 }), 'alpha-holes');
  t.gt(grown, tight, 'the request mask overshoots the selection');

  // ...and the layer mask does not, so a feathered selection still feathers.
  const soft = new Uint8ClampedArray(W * H);
  soft[10 * W + 10] = 200;
  soft[10 * W + 11] = 100;
  const grey = maskToGreyCanvas(soft, W, H);
  t.pixel(grey, 10, 10, '200,200,200,255', 'the layer mask keeps partial coverage');
  t.pixel(grey, 11, 10, '100,100,100,255', 'at every level, not just the top one');

  // The request mask hardens the same pixels, because a grey sent to a provider
  // is interpreted inconsistently between them.
  const hardened = requestMask(soft, W, H, planFrame({ x: 10, y: 10, width: 2, height: 1 }, W, H, { size: 64 }),
    { polarity: 'white-fills', dilate: 0 });
  t.eq(fillCoverage(hardened, 'white-fills'), 1, 'the request mask hardens at the threshold');
});

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

suite('ai / every failure says what it is and what to do', async (t) => {
  const P = 'Test Provider';
  t.eq(mapHttpError(401, { error: { message: 'bad key' } }, P).code, GEN_ERRORS.BAD_KEY, '401 is a bad key');
  t.eq(mapHttpError(403, {}, P).code, GEN_ERRORS.BAD_KEY, 'and so is 403');
  t.eq(mapHttpError(429, {}, P, { 'retry-after': '30' }).code, GEN_ERRORS.RATE_LIMIT, '429 is a rate limit');
  t.eq(mapHttpError(402, {}, P).code, GEN_ERRORS.QUOTA, '402 is out of credit');
  t.eq(mapHttpError(400, { error: { code: 'content_policy_violation' } }, P).code, GEN_ERRORS.REFUSED,
    'a moderation code is a refusal, not a malformed request');
  t.eq(mapHttpError(503, {}, P).code, GEN_ERRORS.SERVER, '5xx is the provider, not the user');
  t.eq(mapThrown(new TypeError('Failed to fetch'), P).code, GEN_ERRORS.OFFLINE, 'a bare TypeError means no network');
  t.eq(mapThrown(new DOMException('x', 'AbortError'), P).code, GEN_ERRORS.ABORTED, 'an abort is not an error');
  t.eq(mapThrown(new DOMException('x', 'TimeoutError'), P).code, GEN_ERRORS.TIMEOUT, 'a timeout is its own thing');

  // A rate limit is only useful if it says how long.
  const limited = mapHttpError(429, {}, P, { 'retry-after': '30' });
  t.ok(messageFor(limited).text.includes('30 seconds'), 'the wait is quoted from Retry-After');

  /*
   * The sweep that stops a new code shipping with a generic fallback: every code
   * must produce a real sentence that names the provider. Verified to fail by
   * adding a code to GEN_ERRORS without a case in messageFor.
   */
  for (const code of Object.values(GEN_ERRORS)) {
    const { text } = messageFor(new GenerationError(code, '', { provider: P }));
    t.gt(text.length, 20, `${code} has a real message`);
    t.ok(!text.includes('undefined'), `${code} does not leak an undefined`);
    if (code !== GEN_ERRORS.OFFLINE) t.ok(text.includes(P), `${code} names the provider`);
  }
});

suite('ai / the OpenAI adapter reads real response shapes', async (t) => {
  t.ok(extractImage({ data: [{ b64_json: 'AAAA' }] }).startsWith('data:image/png;base64,'),
    'a base64 payload becomes a data URL');
  t.eq(extractImage({ data: [{ url: 'https://example.test/a.png' }] }), 'https://example.test/a.png',
    'a URL payload is passed through');
  let threw = null;
  try { extractImage({ data: [] }); } catch (e) { threw = e; }
  t.eq(threw && threw.code, GEN_ERRORS.BAD_RESPONSE, 'an empty payload is a bad response, not a crash');
});

/* ------------------------------------------------------------------ */
/* The document half                                                   */
/* ------------------------------------------------------------------ */

/** A doc with a rectangular selection, ready to fill. */
function docWithSelection(t, w = 400, h = 300) {
  const doc = t.doc(w, h, '#ffffff', 'gf');
  const mask = new Uint8ClampedArray(w * h);
  for (let y = 100; y < 160; y++) for (let x = 100; x < 180; x++) mask[y * w + x] = 255;
  doc.selection.set(mask);
  return doc;
}

suite('ai / a generation lands as one masked layer and one undo step', async (t) => {
  MOCK_DELAY.ms = 0;
  MOCK_FAILURE.code = null;
  const provider = getProvider('mock');
  t.ok(provider, 'the mock provider is registered');

  const doc = docWithSelection(t);
  const bg = doc.layers[0];
  const bgId = bg.id;
  const bgCanvas = bg.canvas;
  const before = doc.history.states.length;

  const layer = await runGenerativeFill(doc, { provider, prompt: 'a blue vase' });

  t.eq(doc.layers.length, 2, 'the fill arrives as a new layer rather than overwriting');
  t.eq(doc.layers[0].id, layer.id, 'on top of the stack');
  t.eq(`${layer.canvas.width}x${layer.canvas.height}`, '400x300', 'with a document-sized buffer');
  t.ok(layer.mask, 'and a mask, so it is not baked in');
  t.eq(layer.name, 'a blue vase', 'named after the prompt, so a stack of attempts is readable');
  t.eq(doc.history.states.length - before, 1, 'exactly one undo step');

  /*
   * The assertion that fails the moment somebody "helpfully" composites in
   * place. Identity, not deep equality — a deep compare would pass vacuously.
   */
  t.is(doc.findLayer(bgId).canvas, bgCanvas, 'the layer underneath was never copy-on-written');

  const composite = getComposite(doc);
  t.ne(t.px(composite, 140, 130), '255,255,255,255', 'generated pixels show inside the selection');
  t.pixel(composite, 10, 10, '255,255,255,255', 'and nothing at all outside it');
  t.ok(doc.selection.mask, 'the selection survives, so a variation can be generated immediately');

  doc.history.undo();
  t.eq(doc.layers.length, 1, 'undo removes the whole thing');
  t.pixel(getComposite(doc), 140, 130, '255,255,255,255', 'and the pixels underneath are untouched');
});

suite('ai / a generation that cannot be trusted commits nothing', async (t) => {
  MOCK_DELAY.ms = 0;
  MOCK_FAILURE.code = null;
  const provider = getProvider('mock');

  // Aborting must leave no trace.
  {
    const doc = docWithSelection(t);
    const before = doc.history.states.length;
    MOCK_DELAY.ms = 50;
    const ac = new AbortController();
    const p = runGenerativeFill(doc, { provider, prompt: 'x', signal: ac.signal });
    ac.abort();
    let code = null;
    try { await p; } catch (e) { code = e.code; }
    MOCK_DELAY.ms = 0;
    t.eq(code, GEN_ERRORS.ABORTED, 'an abort reports as an abort');
    t.eq(doc.layers.length, 1, 'and adds no layer');
    t.eq(doc.history.states.length, before, 'and no history entry');
  }

  /*
   * A generation takes tens of seconds and the document stays editable
   * throughout. A buffer built for the old size would violate the
   * document-sized-buffer rule silently, so nothing is committed.
   */
  {
    const doc = docWithSelection(t);
    const before = doc.history.states.length;
    MOCK_DELAY.ms = 30;
    const p = runGenerativeFill(doc, { provider, prompt: 'x' });
    doc.resample(200, 150);
    let code = null;
    try { await p; } catch (e) { code = e.code; }
    MOCK_DELAY.ms = 0;
    t.ok(code, 'a document resized mid-flight is refused');
    t.eq(doc.layers.length, 1, 'no layer is added');
    // `resample` does not commit on its own — its caller does — so a refused
    // fill must leave the history exactly as it found it.
    t.eq(doc.history.states.length, before, 'and nothing is recorded in history');
  }

  // A provider that answers with the wrong aspect has produced meaningless
  // geometry, unlike a wrong size, which is merely soft.
  {
    const doc = docWithSelection(t);
    const wrongAspect = registerProvider({
      id: 'test-wrong-aspect',
      name: 'Wrong Aspect',
      needsKey: false,
      endpoint: '',
      sizes: [64],
      maskPolarity: 'alpha-holes',
      async generate() { return { image: createCanvas(64, 32) }; },
    });
    let code = null;
    try { await runGenerativeFill(doc, { provider: wrongAspect, prompt: 'x' }); } catch (e) { code = e.code; }
    t.eq(code, GEN_ERRORS.BAD_RESPONSE, 'a non-square answer is refused');
    t.eq(doc.layers.length, 1, 'and nothing is committed');
  }
});

suite('ai / nothing is sent without a key and without consent', async (t) => {
  MOCK_DELAY.ms = 0;
  const doc = docWithSelection(t);

  /*
   * The gate lives in the AI layer rather than the dialog, so calling the
   * command directly — from a script, a shortcut, or the console — still cannot
   * send anything the user has not agreed to. It fails closed.
   * Verified to fail by moving either check into the dialog.
   */
  const cloud = registerProvider({
    id: 'test-cloud',
    name: 'Test Cloud',
    needsKey: true,
    endpoint: 'https://api.example.test/v1/edits',
    sizes: [64],
    maskPolarity: 'alpha-holes',
    async generate() { throw new Error('the provider must never be reached in this test'); },
  });
  const host = hostOf(cloud.endpoint);
  revokeConsent(host);
  await forgetAllCredentials();

  let code = null;
  try { await runGenerativeFill(doc, { provider: cloud, prompt: 'x' }); } catch (e) { code = e.code; }
  t.eq(code, GEN_ERRORS.NO_KEY, 'with no key it refuses before touching the network');

  await setCredential(cloud.id, 'sk-test-0000000000000000', { remember: false });
  code = null;
  try { await runGenerativeFill(doc, { provider: cloud, prompt: 'x' }); } catch (e) { code = e.code; }
  t.eq(code, GEN_ERRORS.NO_CONSENT, 'and with a key but no consent it still refuses');

  t.notOk(hasConsent(host), 'consent is not granted as a side effect of having a key');
  grantConsent(host);
  t.ok(hasConsent(host), 'granting consent is what opens the gate');
  revokeConsent(host);
  await forgetAllCredentials();
  t.eq(doc.layers.length, 1, 'and no attempt added a layer');
});

suite('ai / layer names stay readable', async (t) => {
  t.eq(layerNameFor(''), 'Generative Fill', 'an empty prompt still names the layer');
  t.eq(layerNameFor('  a blue vase  '), 'a blue vase', 'whitespace is tidied');
  const long = layerNameFor('a very long description of something elaborate indeed');
  t.lt(long.length, 32, 'a long prompt is truncated');
  t.ok(long.endsWith('…'), 'and says that it was');
});

suite('ai / providers stay isolated from Pikado', async (t) => {
  /*
   * The registry is what lets a later on-device provider — no key, no network —
   * drop in as an ordinary peer. If a provider ever needs a special case in the
   * caller, that seam has been broken.
   */
  const ids = listProviders().map((p) => p.id);
  t.ok(ids.includes('mock'), 'the mock is registered');
  t.ok(ids.includes('openai'), 'and so is OpenAI');
  for (const p of listProviders()) {
    t.ok(typeof p.generate === 'function', `${p.id} implements generate`);
    t.ok(typeof p.maskPolarity === 'string', `${p.id} declares its mask convention`);
    t.ok(Array.isArray(p.sizes) && p.sizes.length > 0, `${p.id} declares its sizes`);
    t.ok(typeof p.needsKey === 'boolean', `${p.id} says whether it needs a key`);
  }
});

suite('ai / every model a provider offers is one it could actually call', async (t) => {
  const { modelChoices, defaultModelOf, effortChoices } = await import('/src/ai/providers/index.js');
  await import('/src/ai/providers/openai.js');
  await import('/src/ai/providers/gemini.js');

  /*
   * The assertion that catches a pinned dead model id — the failure mode this
   * whole feature grew out of, since the file shipped asking for gpt-image-1
   * long after it stopped being the right default, and Gemini's -preview ids
   * are shut down outright.
   *
   * Verified to fail by setting Gemini's defaultModel to
   * 'gemini-3-pro-image-preview', which was shut down in June 2026 and is not
   * in the list.
   */
  for (const p of listProviders()) {
    const models = modelChoices(p);
    if (!models.length) {
      t.notOk(p.defaultModel, `${p.id} offers no models and claims no default`);
      continue;
    }
    for (const m of models) {
      t.ok(m.id && m.label, `${p.id}: every model has an id and a label`);
      t.ok(!m.id.includes('preview'), `${p.id}: ${m.id} is not a preview id`);
      t.ok(!('efforts' in m) || (Array.isArray(m.efforts) && m.efforts.length),
        `${p.id}: ${m.id} either has efforts or does not mention them`);
    }
    t.ok(models.some((m) => m.id === defaultModelOf(p)), `${p.id}'s default is one it offers`);
    t.ok(p.effortLabel || !models.some((m) => m.efforts),
      `${p.id} names its effort dial if it has one`);
  }

  // Gemini's is the split that matters: the dial exists on two of four.
  const gem = getProvider('gemini');
  t.ok(effortChoices(gem, 'gemini-3.1-flash-image').length, '3.1 Flash offers a thinking level');
  t.eq(effortChoices(gem, 'gemini-2.5-flash-image').length, 0, 'and 2.5 Flash offers none');
});

suite('ai / the chosen model and effort reach the provider', async (t) => {
  MOCK_DELAY.ms = 0;
  const doc = docWithSelection(t);
  let seen = null;
  const recorder = registerProvider({
    id: 'test-recorder',
    name: 'Test Recorder',
    needsKey: false,
    endpoint: '',
    sizes: [64],
    maskPolarity: 'alpha-holes',
    async generate(req) {
      seen = { model: req.model, effort: req.effort };
      const cv = createCanvas(64, 64);
      ctx2d(cv).fillRect(0, 0, 64, 64);
      return { image: cv };
    },
  });

  await runGenerativeFill(doc, { provider: recorder, prompt: 'x', model: 'm2', effort: 'high' });
  /*
   * Verified to fail by dropping `model` from the object literal passed to
   * provider.generate — which is what it looked like before, and which would
   * have made every one of these controls silently do nothing.
   */
  t.eq(seen && seen.model, 'm2', 'the model reaches the adapter');
  t.eq(seen && seen.effort, 'high', 'and so does the effort');
});

suite('ai / a model is a preference and a key is still not', async (t) => {
  const { getModel, setModel, getEffort, setEffort } = await import('/src/ai/model-prefs.js');
  const { allPrefs, setPrefs, commitPrefs } = await import('/src/ui/dialogs/preferences.js');
  const { setCredential, forgetAllCredentials } = await import('/src/ai/credentials.js');
  await import('/src/ai/providers/openai.js');
  const openai = getProvider('openai');

  const before = { models: allPrefs().aiModels, efforts: allPrefs().aiEfforts };
  try {
    setModel('openai', 'gpt-image-1.5');
    t.eq(getModel(openai), 'gpt-image-1.5', 'a chosen model round-trips through the prefs blob');

    /*
     * A stored id that the provider no longer offers must not be sent. Dropping
     * a retired model from the list is how it stops being used — no migration
     * step, and no request that fails on the model name.
     * Verified to fail by having getModel return the stored value unchecked.
     */
    setModel('openai', 'gpt-image-1');
    t.eq(getModel(openai), 'gpt-image-2', 'a model no longer offered falls back to the default');

    setEffort('openai', 'gpt-image-2', 'high');
    t.eq(getEffort(openai, 'gpt-image-2'), 'high', 'so does an effort');
    t.eq(getEffort(getProvider('mock'), 'anything'), '',
      'and a provider with no effort dial reports none');

    /*
     * The rule the whole credentials module exists to keep. Verified to fail by
     * writing the key into the prefs blob.
     */
    const CANARY = 'sk-prefs-canary-should-never-appear';
    await setCredential('openai', CANARY);
    t.notOk(JSON.stringify(allPrefs()).includes(CANARY), 'and the key is nowhere in the prefs blob');
    await forgetAllCredentials();

    /*
     * Preferences takes a snapshot when it opens, so committing it must merge
     * rather than assign — otherwise choosing a model in AI Settings while
     * Preferences is open is silently undone by clicking OK.
     * Verified to fail by restoring `stored = { ...working }`.
     */
    const snapshot = JSON.parse(JSON.stringify(allPrefs()));
    setModel('openai', 'gpt-image-1-mini');
    commitPrefs(snapshot, snapshot);
    t.eq(getModel(openai), 'gpt-image-1-mini', 'a pref written while Preferences was open survives its OK');
  } finally {
    setPrefs({ aiModels: before.models || {}, aiEfforts: before.efforts || {} });
  }
});

suite('ai / the test double is not offered to real users', async (t) => {
  const defs = await import('/src/commands/definitions.js');
  const { mockProviderRequested } = defs;

  /*
   * The mock is registered by importing it — which this suite does, so its
   * absence from the dropdown cannot be observed from in here. What can be
   * observed is the rule that decides whether the app imports it at all.
   *
   * Verified to fail by making mockProviderRequested return true, which is what
   * the app did in effect: the flag was described in a comment and never read.
   */
  t.ok(mockProviderRequested('?ai=mock'), 'the flag turns the mock on');
  t.notOk(mockProviderRequested(''), 'and an ordinary visit does not get it');
  t.notOk(mockProviderRequested('?ai=openai'), 'nor does another value');
  t.notOk(mockProviderRequested('?mock=1'), 'nor a differently named parameter');

  const help = defs.default.find((m) => m.label === 'Help');
  t.ok(help && help.items.includes('help.ai-guide'), 'the Generative Fill guide is in the Help menu');
});
