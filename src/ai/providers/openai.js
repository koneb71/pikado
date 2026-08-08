import { registerProvider } from './index.js';
import { authorizeRequest } from '../credentials.js';
import { mapHttpError, mapThrown, GenerationError, GEN_ERRORS } from '../errors.js';
import { canvasToPngBlob } from '../geometry.js';
import { loadImage } from '../../core/util.js';

/**
 * OpenAI image edits.
 *
 * The adapter is deliberately thin: assemble a request, hand it to `fetch`, turn
 * the answer into an image. Everything with any judgement in it — what to crop,
 * how the mask is oriented, what the failure means, where the pixels land — lives
 * outside this file, so a second provider is about sixty lines and the parts that
 * can be tested offline stay testable.
 *
 * `extractImage` is exported for exactly that reason: it is the one piece of real
 * logic here, and it can be checked against captured payloads without a network.
 *
 * Two things worth knowing about calling any model API straight from a browser.
 * It only works at all because the vendor sends permissive CORS headers, which is
 * theirs to change. And the user's key is in the tab, so it is exposed to
 * anything that can run script on this origin — which is why it is the user's own
 * key, why it is never persisted unless they ask, and why the README now says so.
 */

const ENDPOINT = 'https://api.openai.com/v1/images/edits';

/**
 * Pull the image out of a response body.
 *
 * The shape has changed across model generations — `b64_json` for some, `url`
 * for others — so both are handled rather than assuming whichever one was
 * current when this was written.
 *
 * @param {object} json
 * @returns {string} a data: or https: URL
 * @throws {GenerationError} BAD_RESPONSE when there is no image in there
 */
export function extractImage(json) {
  const first = json && Array.isArray(json.data) ? json.data[0] : null;
  if (first && typeof first.b64_json === 'string' && first.b64_json.length > 0) {
    return `data:image/png;base64,${first.b64_json}`;
  }
  if (first && typeof first.url === 'string' && first.url.length > 0) return first.url;
  throw new GenerationError(GEN_ERRORS.BAD_RESPONSE, 'no image in the response', { provider: 'OpenAI' });
}

/**
 * Build the request without sending it.
 *
 * Split out so the test suite can assert what *would* go over the wire — the
 * method, that the URL carries no query string, that exactly one header holds the
 * key and the body does not — with no network involved.
 *
 * @returns {{url: string, init: RequestInit}}
 */
export function buildRequest({ prompt, imageBlob, maskBlob, size, model = 'gpt-image-1' }) {
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('n', '1');
  form.append('size', `${size}x${size}`);
  form.append('image', imageBlob, 'image.png');
  form.append('mask', maskBlob, 'mask.png');
  // authorizeRequest is the only thing that can see the key, and it writes it
  // into a header. Nothing above ever holds the string.
  return { url: ENDPOINT, init: authorizeRequest('openai', { method: 'POST', body: form }) };
}

registerProvider({
  id: 'openai',
  name: 'OpenAI',
  needsKey: true,
  endpoint: ENDPOINT,
  keyHint: 'sk-… — from platform.openai.com/api-keys',
  sizes: [1024],
  // OpenAI replaces wherever the mask is transparent.
  maskPolarity: 'alpha-holes',

  async generate({ prompt, image, mask, size, signal }) {
    const [imageBlob, maskBlob] = await Promise.all([
      canvasToPngBlob(image),
      canvasToPngBlob(mask),
    ]);
    const { url, init } = buildRequest({ prompt, imageBlob, maskBlob, size });

    let res;
    try {
      res = await fetch(url, { ...init, signal });
    } catch (err) {
      throw mapThrown(err, 'OpenAI');
    }

    if (!res.ok) {
      let body = null;
      try { body = await res.json(); } catch { /* a non-JSON error body is still an error */ }
      const headers = { 'retry-after': res.headers.get('retry-after') || '' };
      throw mapHttpError(res.status, body, 'OpenAI', headers);
    }

    let json;
    try {
      json = await res.json();
    } catch {
      throw new GenerationError(GEN_ERRORS.BAD_RESPONSE, 'the response was not JSON', { provider: 'OpenAI' });
    }
    return { image: await loadImage(extractImage(json)) };
  },
});
