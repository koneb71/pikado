import { suite } from '../harness.js';
import {
  setCredential, forgetCredential, hasCredential, credentialScope,
  redactedCredential, redact, scrubSecrets, authorizeRequest, loadCredential,
} from '/src/ai/credentials.js';
import { kvGet, kvSet, kvDelete, putDoc, getDocData } from '/src/io/store.js';
import { savePKD } from '/src/io/pkd.js';
import { buildRequest } from '/src/ai/providers/openai.js';

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
  const prior = await kvGet('ai.credential');
  try {
    await setCredential(CANARY, opts);
    return await fn();
  } finally {
    await forgetCredential();
    if (prior) await kvSet('ai.credential', prior);
    else await kvDelete('ai.credential');
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
  const prior = await kvGet('ai.credential');
  try {
    await forgetCredential();
    await setCredential(CANARY);
    t.ok(hasCredential(), 'the key works for this session');
    t.eq(credentialScope(), 'memory', 'and is held in memory');

    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      t.notOk(String(localStorage.getItem(k)).includes(CANARY), `localStorage[${k}] is clean`);
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      t.notOk(String(sessionStorage.getItem(k)).includes(CANARY), `sessionStorage[${k}] is clean`);
    }
    const rec = await kvGet('ai.credential');
    t.notOk(rec, 'and IndexedDB holds nothing at all');
  } finally {
    await forgetCredential();
    if (prior) await kvSet('ai.credential', prior);
  }
});

suite('ai credentials / forgetting actually forgets', async (t) => {
  /*
   * A forget that only nulls the module variable looks right for the rest of the
   * session and then reloads the key on the next boot — the worst outcome,
   * because the user believes it is gone. Verified to fail by removing the
   * kvDelete call from forgetCredential.
   */
  const prior = await kvGet('ai.credential');
  try {
    await setCredential(CANARY, { remember: true });
    t.eq(credentialScope(), 'device', 'remembering says so');
    t.ok(await kvGet('ai.credential'), 'and writes to IndexedDB');

    await forgetCredential();
    t.notOk(hasCredential(), 'forgetting clears memory');
    t.eq(await kvGet('ai.credential'), null, 'and removes the record entirely');

    t.notOk(await loadCredential(), 'so a fresh boot finds nothing');
    t.notOk(hasCredential(), 'and comes up with no key');
  } finally {
    await forgetCredential();
    if (prior) await kvSet('ai.credential', prior);
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
    t.eq(redactedCredential(), redact(CANARY), 'the display form is the redacted form');
    t.notOk(redactedCredential().includes('0000'), 'and shows none of the body');
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
  await forgetCredential();
  try { authorizeRequest({ method: 'POST' }); } catch { threw = true; }
  t.ok(threw, 'and with no key it refuses to build a request rather than sending an empty one');
});

suite('ai credentials / hasCredential stays synchronous', async (t) => {
  /*
   * Command enabled() predicates are called synchronously by the menu bar, and
   * isEnabled does `return !!c.enabled()`. A Promise is truthy — so an async
   * hasCredential would silently enable every AI menu item with no key present.
   * Verified to fail by adding `async` to it.
   */
  await forgetCredential();
  t.eq(typeof hasCredential(), 'boolean', 'it returns a boolean, not a Promise');
  t.eq(hasCredential(), false, 'false when there is no key');
  await withCanary(() => {
    t.eq(hasCredential(), true, 'and true when there is one');
  });
});
