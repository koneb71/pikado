# Contributing to Pikado

Thanks for looking. Bug reports, fixes and new tools are all welcome.

This file is short on ceremony and long on the two or three conventions that are
easy to break by accident here. Both of the big ones exist because the project
has already been bitten by their absence, and the scars are in the git history.

## Getting set up

```bash
git clone https://github.com/koneb71/pikado.git
cd pikado
npm install
npm run dev
```

Vite builds it; no framework, no TypeScript, no compile step to understand —
`src/` is plain ES modules that a browser could load directly. If a change seems
to need a build tool, it probably does not. The single runtime dependency is
libheif-js, the HEIC decoder, loaded only when a HEIC is opened (see
`src/io/heif-read.js` for why it is imported by URL rather than bundled).

## Running the tests

```bash
npm test          # or open /tests/ on the dev server
```

The suite runs **in a real browser**, not in Node. That is not laziness: nearly
every subsystem here depends on genuine Canvas2D or WebGL behaviour, and a jsdom
canvas would turn the whole suite into a very confident tautology. The runner
boots the real app off-screen first, so tool registration, panels and menus are
exercised on the way in.

Results appear at the top of the page, and the full report is left on
`window.__pikadoTests` once `window.__pikadoTestsDone` is true, which is what
automation should read.

## The rule that matters most: your test must be able to fail

**Before you submit a test, break the code it is meant to catch and watch the
test go red.** Then put the code back.

This project has shipped assertions that could not fail — one compared a
`Uint8ClampedArray` against `0..255` (true by construction), one compared a loop
counter against a constant, one whole suite rested on a blanket `try/catch`, and
one dehaze threshold was set two units above the broken value it was written to
catch. Each looked like coverage and was worth nothing. Three separate audits
were needed to find them.

So: name the defect in the test's comment, and say what you did to confirm the
test catches it. A comment like

```js
// Verified to fail without the fix: with mapLayerGeometry removed from
// offsetLayer, this reports 8,8 instead of 68,48.
```

is worth more than three more assertions.

Prefer measurements to smoke. Exact pixel values, mean absolute difference,
pixel counts, timings with upper bounds — `t.eq`, `t.close`, `t.lt`, `t.gt`,
`t.pixel`, `t.mad`, `t.inked`. "It did not throw" is almost never a test.

## The other rule: the docs may not describe things that do not exist

README.md has a **What is *not* implemented** section, and it is meant to stay
accurate and slightly uncomfortable. If your change adds a feature, move the
entry out. If it only partly implements one, say what is missing rather than
quietly deleting the line.

The same goes for comments. A comment describing an approach that was replaced
is worse than no comment, because a reader will trust it. When you replace an
implementation, delete or rewrite the comment that explained the old one — and
if the old approach failed for an interesting reason, keep *that* as history,
which is genuinely useful, but make clear it is history.

## Interface text

Pikado speaks more than English (see [Translating Pikado](#translating-pikado)),
so text a person reads follows three habits. The full contract is under
*Interface language* in [ARCHITECTURE.md](ARCHITECTURE.md).

- **Declared text stays plain English.** A command's `label`, a tool's or
  filter's `name`, a panel's `title`, a ParamDescriptor's `label`/`hint`/`unit`
  and a literal `options` array are translated by whatever draws them. Write
  them as you always have.
- **Text you compose for someone now goes through `tr()`** — a toast, a dialog
  title or button, a menu built when it opens, an error the user will see, a
  default name like "Layer 3". Whole sentences, with named placeholders:
  `tr('Layer "{name}" is locked.', { name })`, never `'Layer "' + name + '"…'`,
  and `trn()` for anything with a count. A history label stays a plain English
  literal — the History panel translates it — unless it is interpolated, in
  which case it is a `msg()`.
- **A command's name, where it stands for the command** — a history step, a
  dialog's title, a layer named after an adjustment — is
  `commandName(label)`, given the menu label dots and all. It translates first
  and trims after, because the bare word can be another word: "Threshold" on
  its own is a slider, しきい値 in Japanese, and the adjustment is 2 階調化.
- **One English word, two words in Photoshop?** Give the use that is not the
  word's usual one a context after a bar — `'Type|kind'` for a filter's Type
  option, beside the Type menu's `'Type'` — and English shows only the part
  before it.
- **A user's data never goes through `tr()`**, and an option list that holds
  data (layer names, fonts) is a function rather than an array.

Run the app with `?lang=en-XA` to check your change: every translated string
comes back as `⟦Åççéñţéð···⟧`, so anything still plain English escaped. You do
not need to translate what you add — an untranslated string falls back to the
English, and translators pick it up from `node scripts/i18n.mjs`.

## Style

Match the code around you — comment density, naming, and idiom. A few specifics
that are not obvious:

- Comments explain **why**, not what. The valuable ones here record the approach
  that did not work and the measurement that proved it. Several took four
  attempts to get right and the comment is the only reason the fifth attempt
  does not repeat the first.
- Read the **Golden rules** at the top of [ARCHITECTURE.md](ARCHITECTURE.md)
  before touching layers. `doc.layers[0]` is the *top* layer; you must call
  `doc.beginEdit(layer)` before drawing into a layer buffer; if you move a
  layer's pixels you must move its authored geometry too.
- New filters, adjustments, tools, panels, commands and effect renderers are all
  a single `register*` call — see **Adding to it** in the README. Modules
  self-register on import; do not add a `register()` that `main.js` has to call.
- British spelling in prose — comments, docs, commit messages (`colour`,
  `centre`, `normalise`). **Menu items, dialog titles and identifiers keep US
  spelling**, because they mirror Photoshop's own names and a user hunting for
  *Color Range* should find it spelled the way they expect: `Proof Colors`,
  `Background Color`, `color-burn`, `treatment: 'color'`.

## Pull requests

- Branch off `main`.
- Keep one concern per PR. A bug fix and a refactor in the same diff are hard to
  review and harder to revert.
- Run the full suite and say the numbers in the PR description — `173 suites,
  2306 assertions, 0 failed` is the current baseline, and it should only go up.
- Commit messages: a short imperative subject, then prose explaining *why*. If
  you fixed a bug, give the concrete failing case with real values. Look at
  `git log` for the house style; it is unusually detailed on purpose, because
  the reasoning is the part that is expensive to reconstruct.

## Translating Pikado

A language is one JSON file, `src/locales/<tag>.json`, mapping the English
text to yours, plus one line in `LANGUAGES` in `src/core/i18n.js` naming the
language in itself. Nothing else needs to know it exists.

```bash
node scripts/i18n.mjs                    # how complete every language is
node scripts/i18n.mjs missing zh-CN      # what is still English, and where each string is used
node scripts/i18n.mjs sync zh-CN --fill  # add every missing key, empty, to translate in place
node scripts/i18n.mjs sync zh-CN         # tidy: source order, empty and stale entries dropped
node scripts/i18n.mjs check              # placeholders, plural forms, keys no longer used
```

- **Use Photoshop's own terms** in your language. Pikado's users know
  Photoshop; someone looking for 高斯模糊 or *Flou gaussien* should find exactly
  that.
- **Keep every `{placeholder}`** — rearrange them as your grammar needs, but
  do not rename, add or drop one. Keep a trailing `...`: it means a dialog
  follows. Where the source only ever uses a word with its dots, the bare word
  finds the same translation; where it uses both they are two keys, and can be
  two words — "Levels..." is the adjustment, "Levels" alone the Posterize
  slider (Tonwertkorrektur… and Stufen in German).
- **Plurals** are an object of your language's
  [CLDR plural categories](https://www.unicode.org/cldr/charts/latest/supplemental/language_plural_rules.html):
  `{"one": "{count} слой", "few": "{count} слоя", "many": "{count} слоёв", "other": "{count} слоя"}`.
  A language with one form writes a plain string.
- **A key that should stay as it is** ("sRGB IEC61966-2.1", "4K UHD") is
  copied as its own translation, so it counts as done.
- **A key ending in `|something`** carries a context, telling one meaning
  of an English word from another: `"Delete|key"` is the key on the keyboard
  (Entf in German), `"Delete"` the command (Löschen). Translate only the text
  before the bar.
- **Check it in place**: open Pikado with `?lang=<tag>` to see your language
  without changing your preference, click around, then run
  `pikado.i18n.missing()` in the browser console to list what that showed you
  in English.

An empty or missing entry falls back to English, so a partial translation is
safe to ship. Right-to-left languages need the layout mirrored as well, which
Pikado does not do yet.

## Reporting bugs

Open an issue at
[github.com/koneb71/pikado/issues](https://github.com/koneb71/pikado/issues)
with the browser and version, what you did, what happened, and what you
expected. A document that reproduces it is ideal — Pikado's own `.pkd` files
keep the full layer stack.

Because everything runs client-side and nothing is uploaded, there are no server
logs to check. Whatever you can capture from the browser console is the only
evidence there will be.

## Security

Pikado has no backend, no accounts and no network calls except an optional
Google Fonts stylesheet. That removes most of the usual attack surface, but not
all of it: the PSD, PNG and ICC parsers read untrusted bytes, and a malformed
file that hangs the tab or reads out of bounds is a real bug. Please report
those privately by email rather than in a public issue.
