import './dialogs.css';
import { el } from '../../core/util.js';
import { Dialog } from '../dialog.js';
import { app } from '../../core/app.js';
import {
  setCredential, forgetCredential, hasCredential, redactedCredential, credentialScope,
} from '../../ai/credentials.js';
import { getProvider } from '../../ai/providers/index.js';
import { consentedHosts, revokeAllConsent } from '../../ai/consent.js';

/**
 * API key entry.
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
 */
export async function showAiKeyDialog(providerId = 'openai') {
  const provider = getProvider(providerId);
  const name = provider ? provider.name : 'the provider';
  const host = provider && provider.endpoint ? new URL(provider.endpoint).host : '';

  const dialog = new Dialog({ title: `${name} API key`, width: 460 });

  const input = el('input.pk-input', {
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    autocapitalize: 'off',
    autocorrect: 'off',
    placeholder: (provider && provider.keyHint) || 'Paste your key',
  });

  const remember = el('input', { type: 'checkbox' });
  const rememberRow = el('label.pk-check', {}, remember, el('span', { text: 'Remember this key on this device' }));

  const current = hasCredential()
    ? el('div.pk-hint', {
      text: `A key is set: ${redactedCredential()}${credentialScope() === 'device' ? ' — remembered on this device' : ' — this session only'}`,
    })
    : null;

  dialog.setBody(
    el('div.pk-field', {},
      el('div.pk-hint', {
        text: host
          ? `Pikado sends this key to ${host} and nowhere else. There is no Pikado server, so nobody but you and ${name} ever sees it.`
          : `This key is used only to talk to ${name}. There is no Pikado server.`,
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
  );

  const agreed = consentedHosts();
  const consentNote = agreed.length
    ? el('div.pk-hint', { text: `Images may be sent without asking to: ${agreed.join(', ')}.` })
    : null;
  if (consentNote) dialog.body.appendChild(consentNote);

  const buttons = [{ label: 'Cancel', value: null, subtle: true }];
  if (hasCredential() || agreed.length) {
    buttons.push({
      /*
       * Forgets both the key and every "don't ask again", because a user
       * clearing their credentials means "undo the trust", not "undo half of it".
       */
      label: 'Forget everything',
      danger: true,
      onClick: async (dlg) => {
        await forgetCredential();
        revokeAllConsent();
        app.toast('The API key and every send permission have been forgotten.', 'ok');
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
      const persisted = await setCredential(value, { remember: remember.checked, provider: providerId });
      // Persistence can refuse — private browsing, a full quota — and the user
      // asked for it, so silence would be a small lie.
      if (remember.checked && !persisted) {
        app.toast('The key works for this session, but this browser would not store it.', 'warn', 5000);
      } else {
        app.toast(remember.checked ? 'Key saved on this device.' : 'Key set for this session.', 'ok');
      }
      dlg.close(true);
      return false;
    },
  });
  dialog.setButtons(buttons);

  return dialog.open();
}
