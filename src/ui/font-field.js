import { BROWSE_FONTS, fontFamilyOptions, normalizeFontId } from '../text/fonts.js';

/**
 * The one place the three font pickers agree.
 *
 * There are three of them — the Type tool's options bar, the Properties panel
 * and the Character panel — and until now each had its own idea of what a font
 * even is. They now share one option list and one rule for what happens when
 * "Browse Google Fonts…" is chosen.
 *
 * Deliberately not a custom popover control. A native `<select>` already gets
 * keyboard navigation, type-ahead and screen-reader behaviour right, and the
 * list it holds is what the user *has* — the built-ins plus anything
 * downloaded, typically under sixty. The 1,900-family catalogue lives behind
 * the last row, which is also where somebody scrolling a short list looking for
 * something would end up.
 */

/** Downloaded families, without making this module import the manager. */
let installedProvider = () => [];

export function setInstalledProvider(fn) {
  installedProvider = typeof fn === 'function' ? fn : () => [];
}

/** The options a font `select` should show right now. */
export function fontOptions(current) {
  return fontFamilyOptions(current, installedProvider());
}

/**
 * Resolve what a font picker's change means.
 *
 * @param {string} value what the control now holds
 * @param {string} previous what it held before, to restore on cancel
 * @returns {Promise<string|null>} the id to apply, or null to leave things alone
 */
export async function resolveFontChoice(value, previous) {
  if (value !== BROWSE_FONTS) return normalizeFontId(value);
  const { showFontsDialog } = await import('./dialogs/fonts.js');
  const picked = await showFontsDialog({ initial: previous });
  // Cancelling has to put the control back: the sentinel is not a font, and
  // leaving it selected would show "Browse Google Fonts…" as the layer's family.
  return picked ? normalizeFontId(picked) : null;
}
