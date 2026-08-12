import './dialogs.css';
import './ai-guide.css';
import { el } from '../../core/util.js';
import { Dialog } from '../dialog.js';

/**
 * Help > Using Generative Fill.
 *
 * Generative Fill is the one feature in Pikado you cannot work out by clicking
 * around, because two of its steps happen somewhere other than the thing you
 * clicked: the key lives in a different dialog, and the model and effort live
 * in a third. It is also the only feature that spends the user's money and the
 * only one that sends their work anywhere, which makes "try it and see" the
 * wrong way to learn it.
 *
 * Written as instructions rather than reference. What each provider charges and
 * which model is current will drift, so this says what Pikado does and points
 * at the dialogs that hold the current answer, instead of restating numbers
 * that would quietly go stale.
 *
 * **The settings button resolves a sentinel rather than running a command.**
 * `runCommand` refuses to re-enter, and this dialog is itself being awaited by
 * one — so `runCommand('edit.ai-settings')` from in here is silently dropped,
 * which is exactly the shape of bug that looks like a dead button and no error.
 * The caller opens settings instead, inside the command already running.
 */

/** A numbered step: what to do, then what happens. */
function step(n, title, ...body) {
  return el('li.pkd-guide-step', {},
    el('span.pkd-guide-num', { text: String(n) }),
    el('div', {}, el('strong', { text: title }), ...body));
}

function p(text) {
  return el('p', { text });
}

export function showAiGuideDialog() {
  const dlg = new Dialog({ title: 'Using Generative Fill', width: 560, className: 'pkd-guide' });

  dlg.setBody(
    p('Select part of your picture, describe what should be there instead, and the '
      + 'result comes back as a new layer masked to your selection. Nothing is '
      + 'painted over: generate three attempts and keep the one that works.'),

    el('div.pkd-section', { text: 'Getting set up, once' }),
    el('ol.pkd-guide-steps', {},
      step(1, 'Get an API key. ',
        p('Pikado ships none and has no server that could hold one — a key in a '
          + 'client-side bundle is readable by anyone who opens devtools, so it '
          + 'has to be yours. OpenAI keys come from platform.openai.com/api-keys, '
          + 'Gemini keys from aistudio.google.com/apikey.'),
        p('Set a spending limit on it. It sits in a browser tab, which is not a vault.')),
      step(2, 'Paste it into Edit › AI Settings. ',
        p('Pick the provider at the top, paste the key, and choose a model. By '
          + 'default the key lives in this tab’s memory and a refresh forgets '
          + 'it; tick "Remember this key on this device" to keep it, which stores '
          + 'it in this browser’s local database in plain text.'))),

    el('div.pkd-section', { text: 'Every time' }),
    el('ol.pkd-guide-steps', {},
      step(1, 'Select the area to replace. ',
        p('Any selection tool. The menu item stays greyed out until something is '
          + 'selected on a pixel layer, because there is nothing to fill without one.')),
      step(2, 'Edit › Generative Fill. ',
        p('It sits next to Content-Aware Fill, which does a similar job locally, '
          + 'for free, and without sending anything anywhere — worth trying first '
          + 'for small blemishes and background patches.')),
      step(3, 'Describe what should be there. ',
        p('Describe the result, not the instruction: "a stone path leading into '
          + 'trees" works better than "remove the car". The area around your '
          + 'selection is sent as context, so the model can match the lighting '
          + 'and perspective already in the picture.')),
      step(4, 'Generate. ',
        p('The first time for each provider it asks for a key; the first time for '
          + 'each destination it asks, separately, whether it may send the image '
          + 'there. Both are one-off. The result arrives as a masked layer named '
          + 'after your prompt — if you want a little more of what it painted, '
          + 'paint the layer mask.'))),

    el('div.pkd-section', { text: 'Model and effort' }),
    p('Both live in Edit › AI Settings, per provider, and the effort dial also '
      + 'appears in the Generative Fill dialog because that is the moment it costs '
      + 'you something. Higher settings are slower and dearer; the cheapest model '
      + 'is a good way to see whether a prompt is going anywhere before spending '
      + 'on the good one.'),
    p('OpenAI calls it Quality, Gemini calls it Thinking, and image models have no '
      + '"reasoning effort" setting — that is a text-model idea. On Gemini the '
      + 'control disappears for models that do not accept one rather than sending '
      + 'a setting they would reject.'),

    el('div.pkd-section', { text: 'What it costs, and what it cannot do' }),
    el('ul', {},
      el('li', { text: 'Your provider bills you directly. Pikado never sees the bill and takes no cut.' }),
      el('li', {
        text: 'Generation is 1024×1024. Fill a region larger than that and the '
          + 'result is softer than the rest of the image — the dialog says so before '
          + 'you spend anything.',
      }),
      el('li', {
        text: 'Cancel stops Pikado waiting, but the provider may already have '
          + 'started and may still charge for it.',
      }),
      el('li', {
        text: 'A provider can refuse a prompt. That comes back as a refusal with '
          + 'its reason, not as a silent failure.',
      })),

    el('div.pkd-section', { text: 'What leaves your machine' }),
    p('Only the selected region and the pixels around it, only when you press '
      + 'Generate, and only after you have agreed to send to that host. Not the '
      + 'whole document, not your other open files, and nothing at all if you '
      + 'never use this feature.'),
    p('Your key is held so that no other part of Pikado can read it back — it can '
      + 'only be written into a request header — so it cannot end up in a saved '
      + '.pkd, an autosave, an exported PSD, or an error message on screen. '
      + 'Forgetting it, and every send permission, is one button in AI Settings.'),

    el('div.pkd-note', {
      text: 'Everything else in Pikado works with no key, no account and no network.',
    }),
  );

  dlg.setButtons([
    { label: 'Open AI Settings…', value: 'settings' },
    { label: 'Close', value: true, primary: true },
  ]);
  return dlg.open();
}
