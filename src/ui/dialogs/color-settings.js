import './dialogs.css';
import { el } from '../../core/util.js';
import { Dialog, buildForm } from '../dialog.js';
import { app } from '../../core/app.js';
import { INTENTS, intentIsExact, profileOf } from '../../color/icc.js';
import {
  availableProfiles, assignProfile, convertToProfile, proofOf, setProof, proofLabel,
} from '../../color/manage.js';
import { tr } from '../../core/i18n.js';

/**
 * The three colour-management dialogs.
 *
 * Each one says, in the dialog itself, what it is going to do to the document —
 * because Assign and Convert differ in exactly the way that is invisible until
 * afterwards, and "which one did I want?" is the question these dialogs exist to
 * answer.
 */

/** Profile names are data, so the descriptors take this as a function and show them as they are. */
const profileOptions = (doc) => availableProfiles(doc).map((p) => ({ value: p.id === 'embedded' ? 'embedded' : p.id, label: p.name }));

/** Resolve an option value back to a profile object. */
function resolve(doc, value) {
  return availableProfiles(doc).find((p) => (p.id === 'embedded' ? 'embedded' : p.id) === value) || null;
}

/**
 * Where an opened photo's colours came from, when that was not sRGB. Opening
 * converts them to sRGB, so without this the file's own profile would simply
 * vanish from view — and that is what someone reaching for Assign or Convert
 * most needs to know.
 */
function sourceNote(doc) {
  if (!doc.sourceProfileName) return [];
  return [{
    type: 'label',
    className: 'pk-hint pk-source-profile',
    label: tr('Opened from a file tagged {profile}; its colours were converted to sRGB as it opened.', { profile: doc.sourceProfileName }),
  }];
}

/** Image > Assign Profile… */
export async function showAssignProfileDialog(doc = app.activeDoc) {
  if (!doc) return false;
  const current = profileOf(doc);
  const state = { profile: current.id === 'embedded' ? 'embedded' : current.id };

  const dialog = new Dialog({ title: tr('Assign Profile'), width: 420 });
  const form = buildForm([
    { type: 'label', label: tr('This document is currently {profile}', { profile: current.name }) },
    ...sourceNote(doc),
    { key: 'profile', label: 'Profile', type: 'select', options: () => profileOptions(doc) },
    {
      type: 'label',
      className: 'pk-hint',
      label: 'Assigning relabels the pixels without changing them, so the picture will '
        + 'look different. Use Convert to Profile to keep the appearance instead.',
    },
  ], state, (key, value) => { state[key] = value; });

  dialog.setBody(form.node);
  dialog.setButtons([
    { label: tr('Cancel'), value: false, subtle: true },
    { label: tr('Assign'), primary: true, value: true },
  ]);
  const ok = await dialog.open();
  if (!ok) return false;
  const next = resolve(doc, state.profile);
  if (!next) return false;
  assignProfile(doc, next);
  app.toast(tr('Assigned {profile}', { profile: next.name }), 'ok');
  return true;
}

/** Image > Convert to Profile… */
export async function showConvertProfileDialog(doc = app.activeDoc) {
  if (!doc) return false;
  const current = profileOf(doc);
  const state = {
    profile: current.id === 'embedded' ? 'embedded' : (current.id === 'srgb' ? 'adobe-rgb' : 'srgb'),
    intent: 'relative',
    blackPoint: true,
  };

  const dialog = new Dialog({ title: tr('Convert to Profile'), width: 440 });
  let form = null;
  const note = el('div.pk-hint');
  const syncNote = () => {
    const exact = intentIsExact(state.intent);
    note.textContent = exact
      ? tr('Colours outside the destination gamut are clipped; converting back will not restore them.')
      : tr('A matrix profile has no perceptual table, so this intent behaves as Relative Colorimetric.');
  };

  form = buildForm([
    { type: 'label', label: tr('Source: {profile}', { profile: current.name }) },
    ...sourceNote(doc),
    { key: 'profile', label: 'Destination', type: 'select', options: () => profileOptions(doc) },
    { key: 'intent', label: 'Intent', type: 'select', options: INTENTS },
    { key: 'blackPoint', label: 'Use Black Point Compensation', type: 'checkbox' },
    {
      type: 'label',
      className: 'pk-hint',
      // Honest about when it does nothing: the built-in spaces are idealised and
      // have a black point of zero, so there is nothing to compensate between them.
      label: 'Black point compensation only has an effect when a profile declares a '
        + 'real media black — an embedded profile with a bkpt tag. The built-in '
        + 'working spaces have a black point of zero.',
    },
  ], state, (key, value) => {
    state[key] = value;
    syncNote();
    form.refresh();
  });
  syncNote();

  dialog.setBody(form.node, note);
  dialog.setButtons([
    { label: tr('Cancel'), value: false, subtle: true },
    { label: tr('Convert'), primary: true, value: true },
  ]);
  const ok = await dialog.open();
  if (!ok) return false;
  const next = resolve(doc, state.profile);
  if (!next) return false;
  const done = await app.busy(tr('Converting…'), async () =>
    convertToProfile(doc, next, { intent: state.intent, blackPoint: state.blackPoint }));
  if (done) app.toast(tr('Converted to {profile}', { profile: done.name }), 'ok');
  return !!done;
}

/** View > Proof Setup… */
export async function showProofSetupDialog(doc = app.activeDoc) {
  if (!doc) return false;
  const proof = proofOf(doc);
  const before = { ...proof };
  const state = { ...proof };

  const dialog = new Dialog({ title: tr('Proof Setup'), width: 440 });
  let form = null;
  const apply = () => {
    setProof(doc, state);
    app.emit('doc-change', doc);
  };

  form = buildForm([
    { key: 'profileId', label: 'Simulate', type: 'select', options: () => profileOptions(doc).filter((o) => o.value !== 'embedded') },
    { key: 'intent', label: 'Intent', type: 'select', options: INTENTS },
    { key: 'blackPoint', label: 'Black Point Compensation', type: 'checkbox' },
    { key: 'enabled', label: 'Preview', type: 'checkbox' },
    { key: 'gamutWarning', label: 'Show out-of-gamut areas', type: 'checkbox' },
    {
      type: 'label',
      className: 'pk-hint',
      label: 'Proofing changes the view only. Export, Save and every filter keep reading '
        + 'the document\'s real colours.',
    },
  ], state, (key, value) => {
    state[key] = value;
    form.refresh();
    // Live: the point of a proof dialog is watching the canvas while you change it.
    apply();
  });

  dialog.setBody(form.node);
  dialog.setButtons([
    { label: tr('Cancel'), value: false, subtle: true },
    { label: tr('OK'), primary: true, value: true },
  ]);
  // Show the proof while the dialog is open, whatever it was before.
  apply();
  const ok = await dialog.open();
  if (!ok) {
    setProof(doc, before);
    app.emit('doc-change', doc);
    return false;
  }
  const label = proofLabel(doc);
  if (label) app.toast(label, 'info');
  return true;
}
