/**
 * Image providers.
 *
 * A provider is a plain object, not a class — there is nothing to subclass and
 * nothing to inherit, which is what keeps the next one cheap to add.
 *
 * **Isolation rule, and it is load-bearing:** nothing under `src/ai/providers/`
 * may import from `src/core/`, `src/ui/` or `src/render/`, except
 * `src/core/util.js` for canvas helpers. `src/ai/generative-fill.js` is the only
 * file in `src/ai/` that knows what a document or a layer is. That is what lets a
 * later on-device provider — running a local model, needing no key and making no
 * network request at all — drop in here as an ordinary peer rather than as a
 * second architecture.
 *
 * Providers are handed **canvases, not encoded bytes**. A local model reading an
 * ImageData or a GPU texture would otherwise pay a pointless PNG round trip on
 * both sides; each adapter encodes for its own transport if it has one.
 *
 * @typedef {object} ImageProvider
 * @property {string} id
 * @property {string} name       shown in the dialog title and in every error message
 * @property {boolean} needsKey  false for a local model
 * @property {string} endpoint   '' when there is no network call
 * @property {string} keyHint    placeholder text, and where to get a key
 * @property {number[]} sizes    supported square edges, largest first
 * @property {'alpha-holes'|'white-fills'|'black-fills'} maskPolarity
 * @property {(req: GenerationRequest) => Promise<GenerationResult>} generate
 *
 * @typedef {object} GenerationRequest
 * @property {string} prompt
 * @property {HTMLCanvasElement} image  size x size crop
 * @property {HTMLCanvasElement} mask   size x size, already in this provider's polarity
 * @property {number} size
 * @property {AbortSignal} signal
 *
 * @typedef {object} GenerationResult
 * @property {HTMLImageElement|HTMLCanvasElement} image
 */

const providers = new Map();

/** @param {ImageProvider} def */
export function registerProvider(def) {
  if (!def || !def.id) throw new Error('a provider needs an id');
  providers.set(def.id, def);
  return def;
}

/** @returns {ImageProvider|null} */
export function getProvider(id) {
  return providers.get(id) || null;
}

/** @returns {ImageProvider[]} */
export function listProviders() {
  return [...providers.values()];
}

/** For a `select` param descriptor. */
export function providerOptions() {
  return listProviders().map((p) => ({ value: p.id, label: p.name }));
}
