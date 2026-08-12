import { getPref, setPrefs } from '../ui/dialogs/preferences.js';
import { defaultModelOf, defaultEffortOf, effortChoices } from './providers/index.js';

/**
 * Which model, and how hard it should work.
 *
 * A sibling of `consent.js` and for the same reason: it lives under `src/ai/`
 * but *not* under `src/ai/providers/`, so it may reach into the app for the
 * preferences store while the adapters stay isolated. An adapter never reads a
 * preference — the chosen values arrive as ordinary fields on the generation
 * request, which is what lets a provider be tested with no app around it.
 *
 * These belong in the `pikado.prefs` blob, unlike the API key, which is
 * deliberately kept out of it (see `credentials.js`). A model id is a
 * preference, not a secret: it is fine in a bug report, fine in a settings
 * export, and it should survive a refresh — which is exactly the set of
 * properties a key must not have.
 *
 * Effort is keyed by provider *and* model rather than by provider alone,
 * because the same word means different things on different models — OpenAI's
 * `quality` runs auto/low/medium/high on every GPT image model, Gemini's
 * thinking level is MINIMAL/HIGH and only exists on two of its four. Keyed by
 * provider alone, switching model would carry a value the new model cannot
 * accept.
 */

const MODEL_KEY = 'aiModels';
const EFFORT_KEY = 'aiEfforts';

function bag(key) {
  const v = getPref(key, {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/**
 * The model to use for a provider — the stored choice when it is still one the
 * provider offers, otherwise the provider's default.
 *
 * The "still offered" check is what stops a stored id outliving the model. A
 * provider dropping a retired id from its list is how that model stops being
 * used, with no migration step and no request that fails on the model name.
 *
 * @param {object} provider
 * @returns {string}
 */
export function getModel(provider) {
  if (!provider) return '';
  const stored = bag(MODEL_KEY)[provider.id];
  const offered = Array.isArray(provider.models) ? provider.models : [];
  if (stored && offered.some((m) => m.id === stored)) return stored;
  return defaultModelOf(provider);
}

/** @returns {void} */
export function setModel(providerId, modelId) {
  if (!providerId) return;
  setPrefs({ [MODEL_KEY]: { ...bag(MODEL_KEY), [providerId]: modelId } });
}

/**
 * The effort for a provider+model, or `''` when that model has no effort dial.
 * A stored value the model does not accept is discarded the same way a stale
 * model id is.
 */
export function getEffort(provider, modelId) {
  if (!provider || !modelId) return '';
  const allowed = effortChoices(provider, modelId);
  if (!allowed.length) return '';
  const stored = bag(EFFORT_KEY)[`${provider.id}:${modelId}`];
  if (stored && allowed.some((e) => e.value === stored)) return stored;
  return defaultEffortOf(provider, modelId);
}

/** @returns {void} */
export function setEffort(providerId, modelId, value) {
  if (!providerId || !modelId) return;
  setPrefs({ [EFFORT_KEY]: { ...bag(EFFORT_KEY), [`${providerId}:${modelId}`]: value } });
}
