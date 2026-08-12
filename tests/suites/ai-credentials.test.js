import { suite } from '../harness.js';
import {
  setCredential, forgetCredential, forgetAllCredentials, hasCredential, credentialScope,
  redactedCredential, redact, scrubSecrets, authorizeRequest, loadCredentials,
  configuredProviders,
} from '/src/ai/credentials.js';
import { kvGet, kvSet, kvDelete, putDoc, getDocData } from '/src/io/store.js';
import { savePKD } from '/src/io/pkd.js';
import { buildRequest } from '/src/ai/providers/openai.js';
import { buildRequest as buildGeminiRequest } from '/src/ai/providers/gemini.js';

/**
 * The API key must not leak.
 *
 * This suite is the reason the feature is shaped the way it is. Every assertion
 * below corresponds to a way a credential has escaped from a real application at
 * some point: into a saved file, into an autosave, into a log line, into a URL
 * that ended up in a proxy access log, or onto a screen during a screen share.
 *
 * The canary is scanned for as *bytes* over whole blobs rather than by inspecting
 * fields, because the interesting failures are the ones nobody predicted the
 * shape of.
 */

const CANARY = 'sk-canary-PIKADO-0000-0000-4f2a';

/** Every byte of a blob as a string, so a substring search finds the key anywhere. */
async function blobText(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  }
  return s;
}

/** Run `fn` with the canary held, then always put the world back. */
async function withCanary(fn, opts = {}) {
  const prior = await kvGet('ai.credentials');
  try {
    await setCredential('openai', CANARY, opts);
    return await fn();
  } finally {
    await forgetAllCredentials();
    if (prior) await kvSet('ai.credentials', prior);
    else await kvDelete('ai.credentials');
  }
}

suite('ai credentials / the key never reaches a saved document', async (t) => {
  /*
   * savePKD and captureState are field whitelists rather than object walkers, so
   * the single rule "the key is never a property of a Document or a Layer" closes
   * .pkd, session autosave, history and PSD export at once. These assertions are
   * what keep that true. Verified to fail by assigning doc.aiKey = CANARY before
   * the save.
   */
  await withCanary(async () => {
    const doc = t.doc(64, 48, '#ffffff', 'leak');
    doc.history.record('edit');

    const blob = await savePKD(doc);
    t.notOk((await blobText(blob)).includes(CANARY), 'a saved .pkd does not contain the key');

    const state = JSON.stringify(doc.captureState(), (k, v) => (
      v && typeof v === 'object' && v.getContext ? '[canvas]' : v
    ));
    t.notOk(state.includes(CANARY), 'a history snapshot does not contain the key');

    await putDoc({
      id: 'leak-test', name: doc.name, width: doc.width, height: doc.height,
      updatedAt: Date.now(), bytes: blob.size, data: blob, thumb: null,
    });
    const stored = await getDocData('leak-test');
    if (stored) t.notOk((await blobText(stored)).includes(CANARY), 'nor does an autosaved copy');
    else t.ok(true, 'storage unavailable in this browser, so there is nothing to leak into');
  });
});

suite('ai credentials / nothing is written to disk by default', async (t) => {
  /*
   * The default is memory only. A drive-by script that dumps every storage area
   * must come away with nothing. Verified to fail by flipping the default in
   * setCredential to persist.
   */
  const prior = await kvGet('ai.credentials');
  try {
    await forgetAllCredentials();
    await setCredential('openai', CANARY);
    t.ok(hasCredential('openai'), 'the key works for this session');
    t.eq(credentialScope('openai'), 'memory', 'and is held in memory');

    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      t.notOk(String(localStorage.getItem(k)).includes(CANARY), `localStorage[${k}] is clean`);
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      t.notOk(String(sessionStorage.getItem(k)).includes(CANARY), `sessionStorage[${k}] is clean`);
    }
    const rec = await kvGet('ai.credentials');
    t.notOk(rec, 'and IndexedDB holds nothing at all');
  } finally {
    await forgetAllCredentials();
    if (prior) await kvSet('ai.credentials', prior);
  }
});

suite('ai credentials / forgetting actually forgets', async (t) => {
  /*
   * A forget that only nulls the module variable looks right for the rest of the
   * session and then reloads the key on the next boot — the worst outcome,
   * because the user believes it is gone. Verified to fail by removing the
   * kvDelete call from forgetCredential.
   */
  const prior = await kvGet('ai.credentials');
  try {
    await setCredential('openai', CANARY, { remember: true });
    t.eq(credentialScope('openai'), 'device', 'remembering says so');
    t.ok(await kvGet('ai.credentials'), 'and writes to IndexedDB');

    await forgetAllCredentials();
    t.notOk(hasCredential('openai'), 'forgetting clears memory');
    t.eq(await kvGet('ai.credentials'), null, 'and removes the record entirely');

    t.notOk(await loadCredentials(), 'so a fresh boot finds nothing');
    t.notOk(hasCredential('openai'), 'and comes up with no key');
  } finally {
    await forgetAllCredentials();
    if (prior) await kvSet('ai.credentials', prior);
  }
});

suite('ai credentials / redaction never reveals the key', async (t) => {
  /*
   * Verified to fail by adding a `return raw` fallthrough for an unmatched
   * pattern, which is exactly how this kind of helper usually breaks.
   */
  t.eq(redact(''), '', 'nothing renders as nothing');
  t.eq(redact('short'), '…', 'a short secret reveals no characters at all');
  t.eq(redact('sk-proj-abcdefgh4f2a'), 'sk-…4f2a', 'a long one keeps its prefix and four characters');
  t.eq(redact('abcdefgh12345678'), '…5678', 'without a prefix it is just the tail');

  for (const sample of ['sk-proj-abcdefgh4f2a', 'abcdefgh12345678', 'x'.repeat(64), CANARY]) {
    const r = redact(sample);
    t.ne(r, sample, 'redaction never returns its input');
    t.notOk(r.includes(sample.slice(0, 8)), 'and never the leading characters');
    t.lt(r.length, sample.length, 'and is always shorter, so length is not a fingerprint');
  }

  await withCanary(() => {
    t.eq(redactedCredential('openai'), redact(CANARY), 'the display form is the redacted form');
    t.notOk(redactedCredential('openai').includes('0000'), 'and shows none of the body');
  });
});

suite('ai credentials / a leaked key is scrubbed on its way to the screen', async (t) => {
  /*
   * Provider errors are supposed to be rewritten rather than re-thrown, but a 401
   * body that echoes the Authorization header back is a real thing real APIs do,
   * and runCommand puts err.message on screen for five seconds — quite possibly
   * during the screen share where someone is being helped with the problem.
   * Verified to fail by making scrubSecrets return its input.
   */
  await withCanary(() => {
    const hostile = `401 Unauthorized: the key ${CANARY} is not valid`;
    const safe = scrubSecrets(hostile);
    t.notOk(safe.includes(CANARY), 'the key is removed from error text');
    t.ok(safe.includes(redact(CANARY)), 'and replaced by its redaction');
    t.ok(safe.includes('401 Unauthorized'), 'while the useful part survives');
  });
  t.eq(scrubSecrets('nothing to scrub'), 'nothing to scrub', 'text without a key is untouched');
});

suite('ai credentials / the key leaves only in a header', async (t) => {
  await withCanary(async () => {
    const form = new FormData();
    form.append('prompt', 'a blue vase');
    const { url, init } = buildRequest({
      prompt: 'a blue vase',
      imageBlob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      maskBlob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      size: 1024,
    });

    /*
     * A URL carrying a credential ends up in proxy logs, browser history and
     * Referer headers. Verified to fail by appending ?api_key= to the endpoint.
     */
    const parsed = new URL(url);
    t.eq(parsed.search, '', 'the URL carries no query string');
    t.notOk(url.includes(CANARY), 'and no key');
    t.ne(parsed.origin, location.origin, 'the request is cross-origin, so the service worker never sees it');
    t.eq(init.method, 'POST', 'and a POST, which the service worker ignores outright');

    const headerValues = Object.entries(init.headers || {});
    const carrying = headerValues.filter(([, v]) => String(v).includes(CANARY));
    t.eq(carrying.length, 1, 'exactly one header carries the key');
    t.eq(carrying[0][0], 'Authorization', 'and it is Authorization');

    t.eq(init.credentials, 'omit', 'no cookies ride along with it');
    t.eq(init.referrerPolicy, 'no-referrer', 'and the destination is not told where it came from');
    t.eq(init.cache, 'no-store', 'and nothing about it is cached');

    // The body is a FormData of image parts; the key must not be among them.
    let bodyText = '';
    for (const [k, v] of init.body.entries()) if (typeof v === 'string') bodyText += `${k}=${v};`;
    t.notOk(bodyText.includes(CANARY), 'the body does not repeat the key');
  });
});

suite('ai credentials / authorizeRequest is the only way out', async (t) => {
  const mod = await import('/src/ai/credentials.js');
  /*
   * The load-bearing decision: with no exported getter, no other module can put
   * the key into a string at all — so no log line, URL, error message or
   * serialised object can carry it. Verified to fail by exporting a
   * getCredential().
   */
  const exported = Object.keys(mod);
  t.notOk(exported.some((n) => /^get(Credential|Key|ApiKey)$/i.test(n)),
    'the module exports no raw getter');
  await withCanary(() => {
    for (const name of exported) {
      const fn = mod[name];
      if (typeof fn !== 'function' || fn.length > 0) continue;
      let out;
      try { out = fn(); } catch { continue; }
      if (typeof out === 'string') {
        t.notOk(out.includes(CANARY), `${name}() does not return the raw key`);
      }
    }
  });

  let threw = false;
  await forgetAllCredentials();
  try { authorizeRequest('openai', { method: 'POST' }); } catch { threw = true; }
  t.ok(threw, 'and with no key it refuses to build a request rather than sending an empty one');
});

suite('ai credentials / hasCredential stays synchronous', async (t) => {
  /*
   * Command enabled() predicates are called synchronously by the menu bar, and
   * isEnabled does `return !!c.enabled()`. A Promise is truthy — so an async
   * hasCredential would silently enable every AI menu item with no key present.
   * Verified to fail by adding `async` to it.
   */
  await forgetAllCredentials();
  t.eq(typeof hasCredential('openai'), 'boolean', 'it returns a boolean, not a Promise');
  t.eq(hasCredential('openai'), false, 'false when there is no key');
  await withCanary(() => {
    t.eq(hasCredential('openai'), true, 'and true when there is one');
  });
});

suite('ai credentials / one provider\'s key never reaches another', async (t) => {
  /*
   * The bug that made keys per-provider in the first place. An earlier version
   * held a single key with a label saying whose it was, and the "is a key set?"
   * check ignored the label — so configuring OpenAI and then switching to Gemini
   * would have sent an OpenAI key to Google's endpoint.
   *
   * Verified to fail by making hasCredential ignore its argument, or by giving
   * authorizeRequest one shared key: the Gemini request comes back carrying the
   * OpenAI canary.
   */
  const prior = await kvGet('ai.credentials');
  const OPENAI_KEY = 'sk-canary-OPENAI-0000-0000-1111';
  const GEMINI_KEY = 'AIzaCANARYgemini00000000000002222';
  try {
    await forgetAllCredentials();
    await setCredential('openai', OPENAI_KEY);

    t.ok(hasCredential('openai'), 'the OpenAI key is set');
    t.notOk(hasCredential('gemini'), 'and that does NOT count as a Gemini key');
    t.eq(configuredProviders().join(), 'openai', 'only one provider is configured');

    // Building a Gemini request with no Gemini key must refuse outright rather
    // than fall back to whatever key happens to be lying around.
    let threw = false;
    try { buildGeminiRequest({ prompt: 'x', imageBase64: 'AAAA' }); } catch { threw = true; }
    t.ok(threw, 'a Gemini request cannot be built from an OpenAI key');

    await setCredential('gemini', GEMINI_KEY);
    t.ok(hasCredential('gemini'), 'both keys can be held at once');

    const gem = buildGeminiRequest({ prompt: 'x', imageBase64: 'AAAA' });
    const gemHeaders = JSON.stringify(gem.init.headers);
    t.ok(gemHeaders.includes(GEMINI_KEY), 'the Gemini request carries the Gemini key');
    t.notOk(gemHeaders.includes(OPENAI_KEY), 'and never the OpenAI one');

    const oa = buildRequest({
      prompt: 'x',
      imageBlob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
      maskBlob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
      size: 1024,
    });
    const oaHeaders = JSON.stringify(oa.init.headers);
    t.ok(oaHeaders.includes(OPENAI_KEY), 'and the OpenAI request carries the OpenAI key');
    t.notOk(oaHeaders.includes(GEMINI_KEY), 'and never the Gemini one');

    // Forgetting one must leave the other alone.
    await forgetCredential('openai');
    t.notOk(hasCredential('openai'), 'forgetting one provider clears it');
    t.ok(hasCredential('gemini'), 'and leaves the other in place');
  } finally {
    await forgetAllCredentials();
    if (prior) await kvSet('ai.credentials', prior);
  }
});

suite('ai credentials / Gemini authenticates by header, not query string', async (t) => {
  /*
   * Google's own documentation offers `?key=…` as the convenient option, and it
   * is the worst possible place for a credential: query strings land in proxy
   * access logs, browser history and Referer headers. Verified to fail by
   * appending the key to the URL the way the quickstart does.
   */
  const prior = await kvGet('ai.credentials');
  const KEY = 'AIzaCANARYgemini00000000000003333';
  try {
    await forgetAllCredentials();
    await setCredential('gemini', KEY);
    const { url, init } = buildGeminiRequest({ prompt: 'a blue vase', imageBase64: 'AAAA' });

    const parsed = new URL(url);
    t.eq(parsed.search, '', 'the URL carries no query string at all');
    t.notOk(url.includes(KEY), 'and no key');
    t.eq(parsed.host, 'generativelanguage.googleapis.com', 'it goes to Google and nowhere else');
    t.ne(parsed.origin, location.origin, 'cross-origin, so the service worker never sees it');
    t.eq(init.method, 'POST', 'and a POST, which the service worker ignores outright');

    const carrying = Object.entries(init.headers).filter(([, v]) => String(v).includes(KEY));
    t.eq(carrying.length, 1, 'exactly one header carries the key');
    t.eq(carrying[0][0], 'x-goog-api-key', 'and it is the header Google expects');
    t.eq(carrying[0][1], KEY, 'sent bare, with no Bearer scheme Google would reject');

    t.notOk(String(init.body).includes(KEY), 'the JSON body does not repeat the key');
    t.ok(String(init.body).includes('inline_data'), 'and does carry the image inline');
    t.eq(init.referrerPolicy, 'no-referrer', 'Google is not told where the request came from');
    t.eq(init.credentials, 'omit', 'and no cookies ride along');
  } finally {
    await forgetAllCredentials();
    if (prior) await kvSet('ai.credentials', prior);
  }
});

suite('ai credentials / the chosen model and quality reach the wire, and nothing else does', async (t) => {
  // buildRequest goes through authorizeRequest, which refuses without one.
  await setCredential('openai', 'sk-model-test-key');
  const form = (init) => Object.fromEntries(
    [...init.body.entries()].filter(([, v]) => typeof v === 'string'));

  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
  const { init } = buildRequest({
    prompt: 'a stone path', imageBlob: blob, maskBlob: blob, size: 1024,
    model: 'gpt-image-1.5', quality: 'high',
  });
  const f = form(init);

  /*
   * Verified to fail by making buildRequest append a constant model instead of
   * its argument — which is what it did before, pinned to gpt-image-1, a model
   * that retires in October 2026.
   */
  t.eq(f.model, 'gpt-image-1.5', 'the chosen model is what gets asked for');
  t.eq(f.quality, 'high', 'and so is the chosen quality');

  /*
   * The two fields that turn a working request into a 400. `response_format` is
   * a dall-e-2 parameter and GPT image models always answer in base64;
   * `input_fidelity` is rejected outright by gpt-image-1-mini and cannot be
   * changed on gpt-image-2. Neither has any business here.
   * Verified to fail by appending either one.
   */
  t.notOk('response_format' in f, 'no response_format rides along');
  t.notOk('input_fidelity' in f, 'and no input_fidelity');
  t.notOk('reasoning_effort' in f, 'and no reasoning_effort, which images have no concept of');

  const bare = buildRequest({ prompt: 'x', imageBlob: blob, maskBlob: blob, size: 1024 });
  const bf = form(bare.init);
  t.eq(bf.model, 'gpt-image-2', 'the default is the model that is not on a retirement notice');
  t.notOk('quality' in bf, 'and quality is omitted when nothing asked for one');
  await forgetAllCredentials();
});

suite('ai credentials / Gemini carries the model in the path and thinks only where it can', async (t) => {
  await setCredential('gemini', 'AIza-model-test-key');
  const args = { prompt: 'a stone path', imageBase64: 'AAAA' };

  const flash = buildGeminiRequest({ ...args, model: 'gemini-3.1-flash-image', thinkingLevel: 'HIGH' });
  const u = new URL(flash.url);
  /*
   * Verified to fail by putting the model in a query parameter: the key header
   * test next door already forbids a query string, and a model in one would be
   * the second thing to put in the URL that does not belong there.
   */
  t.ok(u.pathname.endsWith('/models/gemini-3.1-flash-image:generateContent'), 'the model is a path segment');
  t.eq(u.search, '', 'and the URL still carries no query string');
  t.eq(JSON.parse(flash.init.body).generationConfig.thinkingConfig.thinkingLevel, 'HIGH',
    'a model that takes a thinking level gets one');

  /*
   * The real 400 this guards. 2.5 Flash Image rejects a thinking level, and
   * 3 Pro has no documented control for it, so neither may be sent one.
   * Verified to fail by emitting thinkingConfig unconditionally.
   */
  for (const id of ['gemini-2.5-flash-image', 'gemini-3-pro-image']) {
    const body = JSON.parse(buildGeminiRequest({ ...args, model: id, thinkingLevel: 'HIGH' }).init.body);
    t.notOk('thinkingConfig' in body.generationConfig, `${id} is sent no thinking level`);
  }

  const bare = new URL(buildGeminiRequest(args).url);
  t.ok(bare.pathname.endsWith('/models/gemini-3.1-flash-image:generateContent'),
    'and the default model is the current one');
  await forgetAllCredentials();
});

suite('ai credentials / a remembered key comes back, and only once', async (t) => {
  const { resetCredentialLoad } = await import('/src/ai/credentials.js');
  await forgetAllCredentials();

  /*
   * A real reload, not a simulated one: put a key in the store the way
   * `remember: true` does, with nothing in memory. That is exactly the state a
   * user is in on their second visit.
   */
  await kvSet('ai.credentials', { openai: { key: 'sk-remembered-across-boots' } });
  t.notOk(hasCredential('openai'), 'a fresh boot starts with nothing in memory');

  /*
   * Through the app's own entry point, not by calling loadCredentials directly.
   * The bug this catches was never a broken function — it was a working one
   * that nothing called, so "Remember this key on this device" wrote to
   * IndexedDB, no code read it back, and the box behaved exactly like leaving
   * it unticked. A test of the function would have passed throughout.
   * Verified to fail by removing the loadCredentials call from loadAiProviders.
   */
  const { loadAiProviders } = await import('/src/commands/definitions.js');
  resetCredentialLoad();
  await loadAiProviders();
  t.ok(hasCredential('openai'), 'opening the AI feature restores it');
  t.ok(redactedCredential('openai').endsWith('oots'), 'and it is the key that was remembered');

  /*
   * Setting a key for this session only clears the remembered copy, which is
   * what makes a second restore harmless and the memoisation a saving rather
   * than a guard. Asserted because it is the reason the load can be
   * fire-and-forget at all.
   * Verified to fail by dropping the store cleanup from setCredential.
   */
  await setCredential('openai', 'sk-session-only-abcd');
  t.notOk(await kvGet('ai.credentials'),
    'a session-only key removes the remembered one from disk');

  await forgetAllCredentials();
  resetCredentialLoad();
});
