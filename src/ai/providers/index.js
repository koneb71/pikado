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
 * @property {ModelChoice[]} [models]   offered in the settings dialog; omit for one model
 * @property {string} [defaultModel]    must be one of `models`
 * @property {string} [effortLabel]     what this provider's effort dial is called
 * @property {string} [effortHint]      one line explaining it, shown under the control
 * @property {(req: GenerationRequest) => Promise<GenerationResult>} generate
 *
 * @typedef {object} ModelChoice
 * @property {string} id
 * @property {string} label
 * @property {{value: string, label: string}[]} [efforts]  omit when THIS model has no
 *   effort control — the list is per model, not per provider, because on both
 *   providers the dial exists on some models and is an error on others.
 * @property {string} [defaultEffort]
 *
 * @typedef {object} GenerationRequest
 * @property {string} prompt
 * @property {HTMLCanvasElement} image  size x size crop
 * @property {HTMLCanvasElement} mask   size x size, already in this provider's polarity
 * @property {number} size
 * @property {string} [model]   '' or absent means the provider's own default
 * @property {string} [effort]  ignored by a model that has no effort control
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

/**
 * The models a provider offers, or `[]` when it does not offer a choice.
 *
 * Empty rather than a one-entry list on purpose: the dialogs hide the whole row
 * when this is empty, so a provider that has nothing to choose — the mock, a
 * future on-device model — costs no UI and needs no special case.
 *
 * @returns {ModelChoice[]}
 */
export function modelChoices(provider) {
  return provider && Array.isArray(provider.models) ? provider.models : [];
}

/** The provider's default model id, or `''`. */
export function defaultModelOf(provider) {
  if (!provider) return '';
  const list = modelChoices(provider);
  if (provider.defaultModel && list.some((m) => m.id === provider.defaultModel)) return provider.defaultModel;
  return list.length ? list[0].id : '';
}

/**
 * The effort settings *this model* accepts, or `[]`.
 *
 * Per model rather than per provider because that is how the APIs are: OpenAI's
 * `quality` applies to every GPT image model, but Gemini's `thinkingLevel` is
 * accepted by the 3.1 image models, ignored by 3 Pro and a documented error on
 * 2.5 Flash Image. A provider-wide list would send it to all four.
 *
 * @returns {{value: string, label: string}[]}
 */
export function effortChoices(provider, modelId) {
  const list = modelChoices(provider);
  const model = list.find((m) => m.id === modelId) || list.find((m) => m.id === defaultModelOf(provider));
  return model && Array.isArray(model.efforts) ? model.efforts : [];
}

/** The default effort for a model, or `''` when it has no effort control. */
export function defaultEffortOf(provider, modelId) {
  const list = modelChoices(provider);
  const model = list.find((m) => m.id === modelId);
  if (!model || !Array.isArray(model.efforts) || !model.efforts.length) return '';
  if (model.defaultEffort && model.efforts.some((e) => e.value === model.defaultEffort)) return model.defaultEffort;
  return model.efforts[0].value;
}
