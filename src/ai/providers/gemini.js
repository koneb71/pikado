import { registerProvider } from './index.js';
import { authorizeRequest } from '../credentials.js';
import { mapHttpError, mapThrown, GenerationError, GEN_ERRORS } from '../errors.js';
import { createCanvas, ctx2d, loadImage } from '../../core/util.js';

/**
 * Google Gemini image generation.
 *
 * Three things differ from the OpenAI adapter, and all are worth knowing rather
 * than discovering.
 *
 * **The model is part of the URL.** OpenAI takes it as a form field; here it is
 * a path segment, so the endpoint has to be built per request rather than kept
 * in a constant. Only the path varies — the host is the same for every model,
 * which is what keeps consent-by-host correct across a model change.
 *
 * **Authentication is a header, not a query parameter.** Google's own
 * documentation offers `?key=…` as the convenient option, and it is the single
 * worst place to put a credential: query strings land in proxy access logs,
 * browser history and `Referer` headers. `x-goog-api-key` carries the same value
 * with none of that trail, so that is what this uses — and the test suite asserts
 * the URL has no query string at all.
 *
 * **There is no mask parameter.** OpenAI's edit endpoint takes a separate mask
 * image; Gemini's generateContent does not. So the mask is composited into the
 * image before sending — the region to be filled is knocked out to transparent —
 * and the prompt says what to do with the hole. The model may still return a
 * whole new frame rather than only the missing part, which is exactly why the
 * result is composited back through the layer mask: whatever it repaints outside
 * the selection is masked away, so the failure mode is "no worse than asked for"
 * rather than "silently replaced the picture".
 */

const HOST = 'https://generativelanguage.googleapis.com';

const THINKING = [
  { value: 'MINIMAL', label: 'Minimal — fastest' },
  { value: 'HIGH', label: 'High — thinks before drawing' },
];

/**
 * Models that take an image in and give an image back.
 *
 * **`efforts` is per model, and leaving it off is load-bearing.**
 * `thinkingLevel` is accepted by the 3.1 image models, has no documented level
 * control on 3 Pro (which thinks by default), and is a documented error on 2.5
 * Flash Image. A provider-wide effort list would send it to all four and break
 * two of them, which is why the field lives on the model rather than here.
 *
 * The `-preview` ids this file could have grown into — `gemini-3-pro-image-preview`,
 * `gemini-2.5-flash-image-preview` — are both shut down and would fail on the
 * model id alone. The GA ids carry no suffix.
 */
const MODELS = [
  { id: 'gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image — recommended', efforts: THINKING, defaultEffort: 'MINIMAL' },
  { id: 'gemini-3.1-flash-lite-image', label: 'Gemini 3.1 Flash Lite Image — cheapest', efforts: THINKING, defaultEffort: 'MINIMAL' },
  { id: 'gemini-3-pro-image', label: 'Gemini 3 Pro Image — always thinks' },
  { id: 'gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image (legacy)' },
];

const DEFAULT_MODEL = MODELS[0].id;

/**
 * The model rides in the URL path, not in the body and not in a query string.
 *
 * Only the path varies, so the *host* is fixed — which is what keeps consent
 * meaningful: the user agreed to send pictures to generativelanguage.googleapis.com,
 * and switching models does not change who receives them, so it correctly does
 * not ask again.
 */
function endpointFor(model) {
  return `${HOST}/v1beta/models/${model || DEFAULT_MODEL}:generateContent`;
}

/** Whether this model accepts a thinking level at all. */
function thinkingFor(model, level) {
  const m = MODELS.find((x) => x.id === model);
  if (!m || !m.efforts || !level) return null;
  return m.efforts.some((e) => e.value === level) ? level : null;
}

/** Base64 payload of a canvas, without the data-URL preamble. */
function toBase64(canvas) {
  return canvas.toDataURL('image/png').split(',')[1];
}

/**
 * Knock the fill region out of the image, since there is nowhere else to say it.
 *
 * The mask arrives in `alpha-holes` polarity — opaque everywhere except where the
 * fill goes — so `destination-in` keeps precisely the pixels to preserve and
 * clears the rest.
 *
 * @param {HTMLCanvasElement} image
 * @param {HTMLCanvasElement} mask
 * @returns {HTMLCanvasElement}
 */
export function punchMask(image, mask) {
  const out = createCanvas(image.width, image.height);
  const c = ctx2d(out);
  c.drawImage(image, 0, 0);
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(mask, 0, 0);
  c.globalCompositeOperation = 'source-over';
  return out;
}

/**
 * Pull the generated image out of a Gemini response.
 *
 * Exported because it is the only real logic in this file and can be checked
 * against captured payloads with no network. Gemini can answer 200 with no image
 * at all — a safety block arrives that way, as does a model that decided to reply
 * with text — so those are distinguished rather than reported as a generic
 * malformed response.
 *
 * @param {object} json
 * @returns {string} a data: URL
 * @throws {GenerationError}
 */
export function extractImage(json) {
  const provider = 'Gemini';
  const blocked = json && json.promptFeedback && json.promptFeedback.blockReason;
  if (blocked) {
    throw new GenerationError(GEN_ERRORS.REFUSED, `blocked: ${blocked}`, { provider });
  }
  const candidate = json && Array.isArray(json.candidates) ? json.candidates[0] : null;
  const finish = candidate && candidate.finishReason;
  if (finish && /SAFETY|BLOCK|PROHIBITED|RECITATION/i.test(finish)) {
    throw new GenerationError(GEN_ERRORS.REFUSED, `finishReason: ${finish}`, { provider });
  }
  const parts = (candidate && candidate.content && candidate.content.parts) || [];
  for (const part of parts) {
    // camelCase on the way out, snake_case on the way in — accept both rather
    // than depending on which the API happens to emit.
    const inline = part.inlineData || part.inline_data;
    if (inline && inline.data) {
      const mime = inline.mimeType || inline.mime_type || 'image/png';
      return `data:${mime};base64,${inline.data}`;
    }
  }
  const said = parts.map((p) => p.text).filter(Boolean).join(' ').trim();
  throw new GenerationError(
    GEN_ERRORS.BAD_RESPONSE,
    said ? `the model replied with text instead of an image: ${said.slice(0, 200)}` : 'no image in the response',
    { provider },
  );
}

/**
 * Build the request without sending it, so the test suite can assert what would
 * go over the wire — no query string, exactly one header carrying the key, and
 * nothing sensitive in the body.
 *
 * @returns {{url: string, init: RequestInit}}
 */
export function buildRequest({ prompt, imageBase64, mimeType = 'image/png', model = DEFAULT_MODEL, thinkingLevel = '' }) {
  const level = thinkingFor(model, thinkingLevel);
  const body = JSON.stringify({
    contents: [{
      parts: [
        {
          text: `${prompt}\n\nThe supplied image has a transparent region. Fill that region so it `
            + 'blends seamlessly with the surrounding image, matching its lighting, perspective, '
            + 'grain and style. Return the completed image.',
        },
        { inline_data: { mime_type: mimeType, data: imageBase64 } },
      ],
    }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      // Present only when the chosen model accepts it. 2.5 Flash Image rejects
      // a thinking level outright, so an unconditional field would turn a
      // working legacy model into a hard failure.
      ...(level ? { thinkingConfig: { thinkingLevel: level } } : {}),
    },
  });
  return {
    url: endpointFor(model),
    init: authorizeRequest('gemini', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
      // Google's key header carries the value bare — no "Bearer" scheme.
    }, { headerName: 'x-goog-api-key', scheme: '' }),
  };
}

registerProvider({
  id: 'gemini',
  name: 'Gemini',
  needsKey: true,
  // Only ever read for its host, which every model shares — see endpointFor.
  endpoint: endpointFor(DEFAULT_MODEL),
  keyHint: 'AIza… — from aistudio.google.com/apikey',
  sizes: [1024],
  maskPolarity: 'alpha-holes',
  models: MODELS,
  defaultModel: DEFAULT_MODEL,
  effortLabel: 'Thinking',
  effortHint: 'Thinking lets the model plan before it draws. Only the 3.1 models take a level; '
    + '3 Pro always thinks and 2.5 Flash cannot.',

  async generate({ prompt, image, mask, model, effort, signal }) {
    const composited = punchMask(image, mask);
    const { url, init } = buildRequest({
      prompt, imageBase64: toBase64(composited), model: model || DEFAULT_MODEL, thinkingLevel: effort,
    });

    let res;
    try {
      res = await fetch(url, { ...init, signal });
    } catch (err) {
      throw mapThrown(err, 'Gemini');
    }

    if (!res.ok) {
      let body = null;
      try { body = await res.json(); } catch { /* a non-JSON error body is still an error */ }
      const headers = { 'retry-after': res.headers.get('retry-after') || '' };
      throw mapHttpError(res.status, body, 'Gemini', headers);
    }

    let json;
    try {
      json = await res.json();
    } catch {
      throw new GenerationError(GEN_ERRORS.BAD_RESPONSE, 'the response was not JSON', { provider: 'Gemini' });
    }
    return { image: await loadImage(extractImage(json)) };
  },
});
