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

Vite is the only dependency. No framework, no TypeScript, no compile step to
understand — `src/` is plain ES modules that a browser could load directly. If a
change seems to need a build tool, it probably does not.

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
