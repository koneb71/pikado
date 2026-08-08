import './dialogs.css';
import { el } from '../../core/util.js';
import { Dialog } from '../dialog.js';
import { grantConsent, hasConsent, hostOf } from '../../ai/consent.js';

/**
 * "This is about to leave your computer."
 *
 * Pikado has never sent a user's work anywhere, and the whole README says so.
 * This dialog is the moment that stops being true, so it is written to be read
 * rather than dismissed: it names the host, lists what goes and what does not,
 * and does not pretend Pikado has any say over what happens at the other end.
 *
 * Asked separately from key entry on purpose. Pasting a key to see whether the
 * feature works at all is not the same as agreeing to upload a picture, and a
 * user is entitled to the second question even after answering the first.
 *
 * @param {object} provider
 * @returns {Promise<boolean>} whether to proceed
 */
export async function showAiConsentDialog(provider) {
  const host = hostOf(provider.endpoint);
  if (!host || hasConsent(host)) return true;

  const dialog = new Dialog({ title: `Send this image to ${provider.name}?`, width: 500 });
  const dontAsk = el('input', { type: 'checkbox' });

  dialog.setBody(
    el('div.pk-hint', { text: 'Pikado has never sent your work anywhere. This feature does.' }),
    el('div.pk-field', {},
      el('label', { text: `Leaving this computer, to ${host}` }),
      el('ul.pk-list', {},
        el('li', { text: 'the selected part of your image, and some of what surrounds it, as a PNG' }),
        el('li', { text: 'the prompt you type' }),
        el('li', { text: 'your API key, in a request header' }))),
    el('div.pk-field', {},
      el('label', { text: 'Not leaving' }),
      el('ul.pk-list', {},
        el('li', { text: 'your other open documents, your layer names and your file names' }),
        el('li', { text: 'your edit history, and anything else stored in this browser' }))),
    el('div.pk-hint', {
      text: `What ${provider.name} stores, and for how long, is governed by their terms and not `
        + 'by Pikado. Read them before sending anything you would not post publicly.',
    }),
    el('label.pk-check', {}, dontAsk, el('span', { text: `Don't ask again for ${host}` })),
  );

  dialog.setButtons([
    { label: 'Cancel', value: false, subtle: true },
    {
      label: 'Send',
      primary: true,
      onClick: (dlg) => {
        grantConsent(host, { remember: dontAsk.checked });
        dlg.close(true);
        return false;
      },
    },
  ]);

  return !!(await dialog.open());
}
