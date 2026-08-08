import './dialogs.css';
import './generative-fill.css';
import { el } from '../../core/util.js';
import { Dialog } from '../dialog.js';
import { app } from '../../core/app.js';
import { runGenerativeFill } from '../../ai/generative-fill.js';
import { getProvider, listProviders, providerOptions } from '../../ai/providers/index.js';
import { hasCredential, scrubSecrets } from '../../ai/credentials.js';
import { hasConsent, hostOf } from '../../ai/consent.js';
import { messageFor, mapThrown, GEN_ERRORS } from '../../ai/errors.js';
import { showAiKeyDialog } from './ai-key.js';
import { showAiConsentDialog } from './ai-consent.js';
import { planFrame } from '../../ai/geometry.js';

/**
 * The Generative Fill dialog.
 *
 * Deliberately does NOT use `app.busy`. That helper is a binary spinner with no
 * cancellation, it is shared by some forty call sites, and — decisively — it
 * catches every error and reduces it to one generic toast, which would throw
 * away the specific, actionable messages in `errors.js`. So the dialog owns its
 * own lifecycle, and `src/core/app.js` is not touched at all: one self-contained
 * file against zero changes to a singleton every feature depends on.
 *
 * Cancellation is an `AbortController`. `Dialog.close()` runs `onClose` handlers,
 * so Escape and the overlay click already mean "cancel" with no changes to
 * `src/ui/dialog.js` — which is the meaning they should have had anyway.
 */

/** Survives a close, so reopening does not make the user retype their prompt. */
let lastPrompt = '';
let lastProviderId = '';

export async function showGenerativeFillDialog(doc = app.activeDoc) {
  if (!doc) return false;
  const bounds = doc.selection.bounds();
  if (!doc.selection.mask || !bounds || !bounds.width) {
    app.toast('Select the area to fill first.', 'warn');
    return false;
  }

  const providers = listProviders();
  if (!providers.length) {
    app.toast('No image provider is available.', 'error');
    return false;
  }
  let providerId = lastProviderId || (getProvider('openai') ? 'openai' : providers[0].id);

  const dialog = new Dialog({ title: 'Generative Fill', width: 480, className: 'pk-genfill' });
  let controller = null;
  let busy = false;

  const prompt = el('textarea.pk-input', {
    rows: 3,
    placeholder: 'Describe what should be there — for example, a stone path leading into trees',
    spellcheck: 'true',
  });
  prompt.value = lastPrompt;

  const providerSel = el('select.pk-input', {},
    ...providerOptions().map((o) => el('option', { value: o.value, text: o.label })));
  providerSel.value = providerId;

  const status = el('div.pk-genfill-status');
  const note = el('div.pk-hint');
  const bar = el('div.pk-genfill-bar', {}, el('div.pk-genfill-bar-fill'));
  bar.hidden = true;

  /** Tell the user, before they spend anything, that this will come back soft. */
  const syncNote = () => {
    const p = getProvider(providerSel.value);
    const size = (p && p.sizes && p.sizes[0]) || 1024;
    const frame = planFrame(bounds, doc.width, doc.height, { size });
    const region = Math.max(frame.crop.width, frame.crop.height);
    const bits = [];
    if (p && p.needsKey && !hasCredential()) bits.push('No API key set yet — you will be asked for one.');
    if (frame.scale < 1) {
      bits.push(`Generating at ${size}x${size} for a ${region}px region, so the fill will be softer than the rest of the image.`);
    }
    if (p && !p.needsKey) bits.push('This provider runs without a key and sends nothing anywhere.');
    note.textContent = bits.join(' ');
  };
  providerSel.addEventListener('change', () => { providerId = providerSel.value; syncNote(); });
  syncNote();

  const setBusy = (on, label) => {
    busy = on;
    bar.hidden = !on;
    prompt.disabled = on;
    providerSel.disabled = on;
    status.textContent = label || '';
    status.className = `pk-genfill-status${on ? ' busy' : ''}`;
    dialog.setButtons(on ? busyButtons : idleButtons);
  };

  const fail = (err) => {
    const mapped = mapThrown(err, (getProvider(providerSel.value) || {}).name || 'the provider');
    const { text, action } = messageFor(mapped);
    // Scrubbed even though provider errors are supposed to be rewritten: a 401
    // body that echoes the Authorization header back is a real thing, and this
    // text goes on screen.
    status.textContent = scrubSecrets(text);
    status.className = 'pk-genfill-status error';
    bar.hidden = true;
    prompt.disabled = false;
    providerSel.disabled = false;
    busy = false;
    dialog.setButtons(action === 'key' ? keyButtons : idleButtons);
  };

  const generate = async () => {
    const provider = getProvider(providerSel.value);
    if (!provider) return;
    const text = prompt.value.trim();
    if (!text) { app.toast('Describe what should be there first.', 'warn'); return; }
    lastPrompt = text;
    lastProviderId = provider.id;

    if (provider.needsKey && !hasCredential()) {
      const saved = await showAiKeyDialog(provider.id);
      if (!saved || !hasCredential()) return;
      syncNote();
    }
    if (provider.endpoint && !hasConsent(hostOf(provider.endpoint))) {
      const agreed = await showAiConsentDialog(provider);
      if (!agreed) return;
    }

    controller = new AbortController();
    const started = Date.now();
    setBusy(true, 'Generating…');
    const tick = setInterval(() => {
      if (!busy) return;
      const s = Math.round((Date.now() - started) / 1000);
      status.textContent = `Generating… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 1000);

    try {
      await runGenerativeFill(doc, { provider, prompt: text, signal: controller.signal });
      clearInterval(tick);
      dialog.close(true);
    } catch (err) {
      clearInterval(tick);
      if (err && err.code === GEN_ERRORS.ABORTED) {
        // Not an error, but the user should know it may still have cost them.
        app.toast(`Stopped. ${provider.name} may still charge for a generation already under way.`, 'info', 5000);
        setBusy(false, '');
        return;
      }
      fail(err);
    } finally {
      controller = null;
    }
  };

  const idleButtons = [
    { label: 'Cancel', value: false, subtle: true },
    { label: 'Generate', primary: true, onClick: () => { generate(); return false; } },
  ];
  const busyButtons = [
    { label: 'Cancel', primary: true, onClick: () => { if (controller) controller.abort(new DOMException('cancelled', 'AbortError')); return false; } },
  ];
  const keyButtons = [
    { label: 'Cancel', value: false, subtle: true },
    { label: 'Change key…', onClick: async () => { await showAiKeyDialog(providerSel.value); syncNote(); return false; } },
    { label: 'Try again', primary: true, onClick: () => { generate(); return false; } },
  ];

  dialog.setBody(
    el('div.pk-field', {}, el('label', { text: 'Describe the fill' }), prompt),
    el('div.pk-field', {}, el('label', { text: 'Provider' }), providerSel),
    note,
    bar,
    status,
  );
  dialog.setButtons(idleButtons);
  // Escape and the overlay click should mean cancel, and this is what makes them.
  dialog.onClose(() => { if (controller) controller.abort(new DOMException('closed', 'AbortError')); });

  return !!(await dialog.open());
}
