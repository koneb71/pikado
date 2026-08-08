import './dialogs.css';
import { el } from '../../core/util.js';
import { Dialog } from '../dialog.js';
import { app } from '../../core/app.js';
import {
  setCredential, forgetCredential, forgetAllCredentials, hasCredential,
  redactedCredential, credentialScope, configuredProviders,
} from '../../ai/credentials.js';
import { getProvider, listProviders } from '../../ai/providers/index.js';
import { consentedHosts, revokeAllConsent } from '../../ai/consent.js';

/**
 * API key entry, one provider at a time.
 *
 * Hand-built rather than `paramDialog`, for two reasons that both matter.
 * `buildForm`'s text control renders a plain `<input type=text>` — no password
 * masking, autocomplete off, or spellcheck off — and a key typed into a
 * spellchecked field is a key sent to a spellchecker. And `paramDialog` resolves
 * its promise with the whole working-state object, which would hand the raw key
 * to whatever called it; here the field's value goes straight into
 * `setCredential` and is never returned to anyone.
 *
 * There is deliberately no reveal-eye toggle. The user can always paste the key
 * again, and a reveal button is a one-click leak during exactly the screen share
 * where someone is being helped with a problem.
 *
 * @param {string} providerId which provider's key to edit
 * @returns {Promise<boolean>} whether a key was saved
 */
export async function showAiKeyDialog(providerId = 'openai') {
  const provider = getProvider(providerId) || listProviders().find((p) => p.needsKey);
  if (!provider) {
    app.toast('No provider needs a key.', 'info');
    return false;
  }
  const id = provider.id;
  const host = provider.endpoint ? new URL(provider.endpoint).host : '';

  const dialog = new Dialog({ title: `${provider.name} API key`, width: 480 });

  const input = el('input.pk-input', {
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    autocapitalize: 'off',
    autocorrect: 'off',
    placeholder: provider.keyHint || 'Paste your key',
  });

  const remember = el('input', { type: 'checkbox' });
  const rememberRow = el('label.pk-check', {}, remember, el('span', { text: 'Remember this key on this device' }));

  /*
   * Every provider that needs a key, and whether one is set — because with more
   * than one provider "is a key configured?" is an ambiguous question, and a user
   * who set an OpenAI key and then switched to Gemini should be able to see at a
   * glance which of the two is missing rather than discovering it on a failure.
   */
  const keyed = listProviders().filter((p) => p.needsKey);
  const summary = keyed.length > 1
    ? el('div.pk-hint', {
      text: `Keys held: ${keyed.map((p) => (hasCredential(p.id)
        ? `${p.name} ${redactedCredential(p.id)}`
        : `${p.name} — none`)).join(' · ')}`,
    })
    : null;

  const current = hasCredential(id)
    ? el('div.pk-hint', {
      text: `Current ${provider.name} key: ${redactedCredential(id)}`
        + (credentialScope(id) === 'device' ? ' — remembered on this device' : ' — this session only'),
    })
    : null;

  const agreed = consentedHosts();
  const consentNote = agreed.length
    ? el('div.pk-hint', { text: `Images may be sent without asking to: ${agreed.join(', ')}.` })
    : null;

  dialog.setBody(
    el('div.pk-field', {},
      el('div.pk-hint', {
        text: host
          ? `Pikado sends this key to ${host} and nowhere else. There is no Pikado server, so nobody but you and ${provider.name} ever sees it.`
          : `This key is used only to talk to ${provider.name}. There is no Pikado server.`,
      }),
      input),
    rememberRow,
    el('div.pk-hint', {
      text: 'By default the key is kept in this tab\'s memory only, so closing the tab or '
        + 'refreshing forgets it. Remembering stores it in this browser\'s local database in '
        + 'plain text — anyone who can use this browser profile, and any script that runs on '
        + 'this page, can read it. Use a key with a spending limit you could afford to lose.',
    }),
    ...(current ? [current] : []),
    ...(summary ? [summary] : []),
    ...(consentNote ? [consentNote] : []),
  );

  const buttons = [{ label: 'Cancel', value: null, subtle: true }];

  if (hasCredential(id)) {
    buttons.push({
      label: `Forget ${provider.name} key`,
      onClick: async (dlg) => {
        await forgetCredential(id);
        app.toast(`The ${provider.name} key has been forgotten.`, 'ok');
        dlg.close(false);
        return false;
      },
    });
  }

  if (configuredProviders().length || agreed.length) {
    buttons.push({
      /*
       * Forgets every key and every "don't ask again", because a user clearing
       * their credentials means "undo the trust", not "undo part of it".
       */
      label: 'Forget everything',
      danger: true,
      onClick: async (dlg) => {
        await forgetAllCredentials();
        revokeAllConsent();
        app.toast('Every API key and send permission has been forgotten.', 'ok');
        dlg.close(false);
        return false;
      },
    });
  }

  buttons.push({
    label: 'Save',
    primary: true,
    onClick: async (dlg) => {
      const value = input.value.trim();
      if (!value) {
        app.toast('Paste a key first, or cancel.', 'warn');
        return false;
      }
      const persisted = await setCredential(id, value, { remember: remember.checked });
      // Persistence can refuse — private browsing, a full quota — and the user
      // asked for it, so silence would be a small lie.
      if (remember.checked && !persisted) {
        app.toast('The key works for this session, but this browser would not store it.', 'warn', 5000);
      } else {
        app.toast(remember.checked
          ? `${provider.name} key saved on this device.`
          : `${provider.name} key set for this session.`, 'ok');
      }
      dlg.close(true);
      return false;
    },
  });

  dialog.setButtons(buttons);
  return dialog.open();
}
