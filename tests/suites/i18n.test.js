import { suite } from '../harness.js';
import { tokenize, extract, audit, hasTranslation, SKIP_FILES } from '/scripts/i18n-extract.mjs';

/*
 * The interface language: src/core/i18n.js and the code that draws text.
 *
 * Stateful checks go through `t.app.i18n` — the translator main.js booted
 * with — never through a fresh import, which on the dev server can be a
 * second copy of the module with its own idea of the current language (the
 * HMR trap in ARCHITECTURE.md). Every test that changes the language puts
 * English back before it returns, because every other suite compares English.
 */

/**
 * Run `fn` with a throwaway language active. The entry is put first in
 * LANGUAGES so it shadows a shipped language with the same tag, and is
 * removed again afterwards, as is the language.
 */
async function withLanguage(t, tag, entries, fn) {
  const { LANGUAGES, loadLanguage } = t.app.i18n;
  const entry = { tag, name: tag, load: async () => ({ default: entries }) };
  LANGUAGES.unshift(entry);
  try {
    await loadLanguage(tag);
    return await fn();
  } finally {
    LANGUAGES.splice(LANGUAGES.indexOf(entry), 1);
    await loadLanguage('en');
  }
}

/** Every source file, as the CLI reads them (scripts/i18n.mjs). */
function sourceFiles() {
  const raw = import.meta.glob('/src/**/*.js', { query: '?raw', import: 'default', eager: true });
  return Object.entries(raw)
    .map(([p, source]) => ({ path: p.replace(/^\//, ''), source }))
    .filter((f) => !SKIP_FILES.has(f.path) && !f.path.startsWith('src/locales/'))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

/* ------------------------------------------------------------------ */

suite('i18n: the suite itself runs in English', async (t) => {
  const { language, pinnedLanguage, tr } = t.app.i18n;
  // Verified to fail: with the <meta name="pikado-language"> removed from
  // tests/index.html and the browser's language set to zh-CN, the app boots
  // in Chinese and every label assertion in the suite would compare against
  // the wrong language — this is the assertion that says why.
  t.eq(pinnedLanguage(), 'en', 'the test page pins English');
  t.eq(language(), 'en', 'and the app booted in it');
  t.eq(document.documentElement.lang, 'en', '<html lang> says so');
  t.eq(tr('Gaussian Blur...'), 'Gaussian Blur...', 'English is its own translation');
});

suite('i18n: English is the key, and missing text falls back to it', async (t) => {
  const { tr, msg, missingStrings } = t.app.i18n;
  await withLanguage(t, 'xx', {
    'Gaussian Blur': 'Flou gaussien',
    'Levels...': 'Niveaux...',
    'Layer "{name}" is locked.': 'Le calque « {name} » est verrouillé.',
    Background: 'Arrière-plan',
    Untranslated: '',
    constructor: 'trap',
  }, () => {
    t.eq(tr('Gaussian Blur'), 'Flou gaussien', 'an exact key is translated');
    t.eq(tr('No such string'), 'No such string', 'a missing key falls back to the English');
    t.ok(missingStrings().includes('No such string'), 'and is recorded for translators');
    t.eq(tr('Untranslated'), 'Untranslated', 'an empty translation means "not yet", not ""');

    // Ellipsis folding: one translation for "X" and "X...".
    // Verified to fail: with the fold removed from lookup() in i18n.js these
    // come back as the untranslated English.
    t.eq(tr('Gaussian Blur...'), 'Flou gaussien...', 'the menu form finds the plain name');
    t.eq(tr('Gaussian Blur…'), 'Flou gaussien…', 'with either ellipsis');
    t.eq(tr('Levels'), 'Niveaux', 'and the plain name finds the menu form');

    // Placeholders carry data, and data is never translated — even data that
    // happens to be spelled like a key.
    t.eq(tr('Layer "{name}" is locked.', { name: 'Background' }),
      'Le calque « Background » est verrouillé.', 'a layer named "Background" keeps its name');
    t.eq(tr('Layer "{name}" is locked.', { name: msg('Background') }),
      'Le calque « Arrière-plan » est verrouillé.', 'only a msg() parameter is translated');
    t.eq(tr('Nothing to {verb}', {}), 'Nothing to {verb}', 'a missing parameter stays visible, not blank');

    t.eq(tr('constructor'), 'trap', 'a key spelled like an Object property is still just a key');
    t.eq(tr('toString'), 'toString', 'and an Object property is never mistaken for a translation');
    t.eq(tr(tr('Gaussian Blur')), 'Flou gaussien', 'translating a translation changes nothing');
  });
  t.eq(t.app.i18n.language(), 'en', 'English is back afterwards');
});

suite('i18n: plurals follow the language’s own rules', async (t) => {
  const { trn } = t.app.i18n;
  t.eq(trn('{count} layer', '{count} layers', 1), '1 layer', 'English singular');
  t.eq(trn('{count} layer', '{count} layers', 0), '0 layers', 'English zero is plural');
  t.eq(trn('{count} layer', '{count} layers', 2, { extra: 'x' }), '2 layers', 'English plural');

  // Ukrainian has one / few / many; a two-form plural cannot express it.
  // Verified to fail: selecting the form with `count === 1 ? one : other`
  // instead of Intl.PluralRules gives "3 шарів" and "21 шарів".
  await withLanguage(t, 'uk', {
    '{count} layer': { one: '{count} шар', few: '{count} шари', many: '{count} шарів', other: '{count} шару' },
  }, () => {
    t.eq(trn('{count} layer', '{count} layers', 1), '1 шар', 'one');
    t.eq(trn('{count} layer', '{count} layers', 3), '3 шари', 'few');
    t.eq(trn('{count} layer', '{count} layers', 5), '5 шарів', 'many');
    t.eq(trn('{count} layer', '{count} layers', 21), '21 шар', '21 is "one" in Ukrainian');
    t.eq(trn('{count} layer', '{count} layers', 1.5), '1.5 шару', 'a fraction is "other"');
  });
  // A language with one form can give a plain string.
  await withLanguage(t, 'ja', { '{count} layer': '{count} 枚のレイヤー' }, () => {
    t.eq(trn('{count} layer', '{count} layers', 1), '1 枚のレイヤー', 'one form for one');
    t.eq(trn('{count} layer', '{count} layers', 7), '7 枚のレイヤー', 'and for many');
  });
});

suite('i18n: choosing a language', async (t) => {
  const { pickLanguage, chooseLanguage, PSEUDO_LANGUAGE } = t.app.i18n;
  const have = ['en', 'zh-CN', 'zh-TW', 'pt-BR', 'fr'];
  const cases = [
    [['zh-CN', 'en'], 'zh-CN', 'an exact tag'],
    [['zh'], 'zh-CN', 'bare Chinese reads Simplified'],
    [['zh-SG'], 'zh-CN', 'Singapore reads Simplified'],
    [['zh-HK'], 'zh-TW', 'Hong Kong reads Traditional'],
    [['zh-MO'], 'zh-TW', 'Macao reads Traditional'],
    [['zh-Hant'], 'zh-TW', 'a script tag on its own'],
    [['pt-PT'], 'pt-BR', 'the same language from another region'],
    [['fr-CA', 'zh-CN'], 'fr', 'the first preference that matches wins'],
    [['en-GB', 'zh-CN'], 'en', 'English first means English, though Chinese is available'],
    [['tlh', 'not a tag!', 'zh-CN'], 'zh-CN', 'unknown and malformed tags are skipped'],
    [[], 'en', 'no preference at all'],
  ];
  for (const [wanted, expected, why] of cases) t.eq(pickLanguage(wanted, have), expected, `${why}: ${wanted.join(', ') || '(none)'}`);

  // Verified to fail: matching Chinese by language alone (dropping the script
  // comparison) serves Simplified to a Traditional reader who asked for
  // English next.
  t.eq(pickLanguage(['zh-TW', 'en'], ['en', 'zh-CN']), 'en', 'one Chinese script is never served for the other');

  t.eq(chooseLanguage({ pinned: 'en', preference: 'zh-CN', browser: ['zh-CN'] }), 'en', 'a pin beats everything');
  t.eq(chooseLanguage({ pinned: PSEUDO_LANGUAGE }), PSEUDO_LANGUAGE, 'including into the pseudo-language');
  t.eq(chooseLanguage({ preference: 'zh-CN', browser: ['fr'] }), 'zh-CN', 'a stored preference beats the browser');
  t.eq(chooseLanguage({ preference: 'auto', browser: ['zh-CN'] }), 'zh-CN', '"auto" follows the browser');
  t.eq(chooseLanguage({ preference: 'xx-gone', browser: ['zh-CN'] }), 'zh-CN', 'a preference for a language no longer shipped is ignored');
});

suite('i18n: history labels stay English and are shown translated', async (t) => {
  const { msg } = t.app.i18n;
  const { historyLabel } = await import('/src/core/history.js');
  const { labelOf } = await import('/src/commands/registry.js');
  const doc = t.doc(40, 40, '#ffffff');

  doc.commit('Brush Stroke');
  doc.commit(msg('Fade {action}', { action: msg('Gaussian Blur') }));
  const h = doc.history;
  const plain = h.states[h.index - 1];
  const composed = h.states[h.index];

  // The English is what stateIcon() reads and what the suite asserts on.
  // Verified to fail: storing the msg() itself as `label` makes this a
  // Message object, not a string, and every label assertion in the suite
  // that compares with t.eq then fails.
  t.eq(composed.label, 'Fade Gaussian Blur', 'an interpolated label is stored as English');
  t.eq(typeof composed.label, 'string', 'as a string');
  t.eq(plain.label, 'Brush Stroke', 'a plain label is stored as given');

  await withLanguage(t, 'xx', {
    'Brush Stroke': 'Coup de pinceau',
    'Fade {action}': 'Estomper : {action}',
    'Gaussian Blur': 'Flou gaussien',
    'Undo {action}': 'Annuler {action}',
  }, () => {
    t.eq(historyLabel(plain), 'Coup de pinceau', 'shown in the current language');
    // Verified to fail: without the kept msg(), the composed English
    // "Fade Gaussian Blur" is not a key and stays English here.
    t.eq(historyLabel(composed), 'Estomper : Flou gaussien', 'an interpolated label is translated whole, its parts too');
    t.eq(composed.label, 'Fade Gaussian Blur', 'while the stored label stays English');
    t.eq(labelOf('edit.undo'), 'Annuler Estomper : Flou gaussien', 'Edit > Undo names the step in the same language');
  });
});

suite('i18n: forms translate what they declare, never what they are given', async (t) => {
  const { buildForm } = await import('/src/ui/dialog.js');
  await withLanguage(t, 'xx', {
    Amount: 'Quantité', Background: 'Arrière-plan', Merged: 'Fusionné', Radius: 'Rayon',
    'Larger values blur more.': 'Plus la valeur est grande, plus le flou est fort.', pixels: 'pixels (fr)',
  }, () => {
    const form = buildForm([
      { key: 'amount', label: 'Amount', type: 'slider', min: 0, max: 10, unit: 'pixels', hint: 'Larger values blur more.' },
      // A literal list is interface text…
      { key: 'fixed', label: 'Radius', type: 'select', options: [{ value: 'bg', label: 'Background' }] },
      // …a function's list is data, shown as it comes: here a layer the user
      // named "Background", which must not turn into "Arrière-plan".
      { key: 'layer', label: 'Radius', type: 'select', options: () => [{ value: '', label: 'Merged' }, { value: 'l1', label: 'Background' }] },
    ], { amount: 1, fixed: 'bg', layer: 'l1' }, () => {});
    const text = form.node.textContent;
    t.ok(text.includes('Quantité') && text.includes('Rayon'), 'labels are translated');
    t.ok(text.includes('pixels (fr)'), 'units are translated');
    t.ok(text.includes('Plus la valeur est grande'), 'hints are translated');
    const [fixed, data] = form.node.querySelectorAll('select');
    t.eq(fixed.options[0].textContent, 'Arrière-plan', 'a literal option list is translated');
    // Verified to fail: translating every option label, as buildForm did for
    // literal arrays before options could be functions, shows the user's layer
    // "Background" as "Arrière-plan" here.
    t.eq([...data.options].map((o) => o.textContent), ['Merged', 'Background'], 'a function’s options are shown exactly as given');
    t.eq(data.value, 'l1', 'and their values still work');
  });
});

suite('i18n: keyboard names follow the language', async (t) => {
  const { formatAccel, IS_MAC } = await import('/src/commands/registry.js');
  if (IS_MAC) { t.ok(true, 'macOS shows ⌘⌥⇧ symbols, which need no translation'); return; }
  t.eq(formatAccel('Ctrl+Shift+S'), 'Ctrl+Shift+S', 'English unchanged');
  await withLanguage(t, 'xx', { Ctrl: 'Strg', Shift: 'Umschalt', Alt: 'Alt' }, () => {
    t.eq(formatAccel('Ctrl+Shift+S'), 'Strg+Umschalt+S', 'German keyboards say Strg and Umschalt');
    t.eq(formatAccel('Alt+Ctrl+I'), 'Alt+Strg+I', 'in any order');
    t.eq(formatAccel('F7'), 'F7', 'a function key is left alone');
  });
  await withLanguage(t, 'xx', { 'Delete|key': 'Entf', Backspace: 'Rück' }, () => {
    t.eq(formatAccel('Delete'), 'Entf', 'and so are named keys');
    t.eq(formatAccel('Alt+Backspace'), 'Alt+Rück', 'after a modifier too');
  });
});

suite('i18n: the language picker lists languages in their own names', async (t) => {
  const { languageOptions } = await import('/src/ui/language.js');
  const { LANGUAGES } = t.app.i18n;
  await withLanguage(t, 'xx', { English: 'Anglais', 'Automatic — {language}': 'Automatique — {language}' }, () => {
    const opts = languageOptions();
    t.eq(opts[0].value, 'auto', 'Automatic comes first');
    t.ok(opts[0].label.startsWith('Automatique — '), 'and is itself translated');
    // Verified to fail: building the options as a literal array (or calling
    // tr() on each name) shows "Anglais" here — and a reader who cannot read
    // the current language can no longer find their own.
    const en = opts.find((o) => o.value === 'en');
    t.eq(en && en.label, 'English', 'English is listed as "English" whatever the interface language');
    for (const l of LANGUAGES.filter((x) => x.tag !== 'xx')) {
      const o = opts.find((x) => x.value === l.tag);
      t.eq(o && o.label, l.name, `${l.tag} is listed under its own name`);
    }
  });
});

suite('i18n: the extractor reads JavaScript, not text that looks like it', async (t) => {
  // Each of these trips a regex over the source, and so would the stale-key
  // check, which decides whether a translation is still used.
  const src = [
    "const re = /'quoted' isn't a string/g;",
    "const n = a / b; tr('After a division');",
    "// tr('in a line comment')",
    "/* tr('in a block comment') */",
    "const s = `hole ${tr('Inside a hole')} done`;",
    "el('p', { text: tr('One sentence ' + 'in two parts.') });",
    "registerTool({ id: 'brush', name: 'Brush Tool', options: [{ key: 'x', label: 'Mode', options: ['Normal', 'Multiply', 'brush-id'] }] });",
    "x = cond ? label : 'not a property value';",
    "doc.commit('Brush Stroke'); doc.commit(msg('Rotate {degrees}°', { degrees }));",
    "trn('{count} layer', '{count} layers', n);",
    "tr(`Composed ${badly}`);",
    "function rotateLayers(doc, kind, label) { doc.commit(label); }",
    "const rotateTwice = (doc, why) => { rotateLayers(doc, 'cw', why); };",
    "rotateTwice(doc, 'Rotate Twice'); rotateLayers(doc, 'ccw', 'Rotate Back');",
    "doc.commit(handle ? 'Edit Handle' : 'Move Points');",
  ].join('\n');
  const toks = tokenize(src);
  t.ok(toks.some((k) => k.type === 'regex' && k.value.includes("'quoted'")), 'a regex literal is one token');
  const { strings, problems } = extract([{ path: 'x.js', source: src }]);
  const found = [...strings.keys()];
  // Verified to fail: treating every `/` as division turns the regex into a
  // string "quoted" and the rest of the line into garbage.
  t.notOk(found.some((s) => s.includes('quoted')), 'nothing inside a regex is taken for a string');
  t.notOk(found.some((s) => s.includes('comment')), 'nothing inside a comment');
  t.ok(found.includes('After a division'), 'a division is not mistaken for the start of a regex');
  t.ok(found.includes('Inside a hole'), 'a tr() inside a template hole is found');
  t.ok(found.includes('One sentence in two parts.'), 'a concatenation is one string, as it is at runtime');
  t.ok(found.includes('Brush Tool') && found.includes('Mode'), 'registry and descriptor text fields');
  t.ok(found.includes('Normal') && found.includes('Multiply'), 'a literal options array');
  t.notOk(found.includes('brush-id') || found.includes('brush'), 'identifiers in those positions are not text');
  t.notOk(found.includes('not a property value'), 'a ternary branch is not an object property');
  t.ok(found.includes('Brush Stroke') && found.includes('Rotate {degrees}°'), 'history labels, plain and msg()');
  t.eq(strings.get('{count} layer') && strings.get('{count} layer').plural, '{count} layers', 'trn() keeps both forms');
  t.eq(problems.length, 1, 'and a tr() given a composed template is reported');
  // Verified to fail: without labelTakers() neither label is found, and a
  // label nobody extracts is one no translator is ever asked for.
  t.ok(found.includes('Rotate Back'), 'a history label passed through a helper is found');
  t.ok(found.includes('Rotate Twice'), 'and through a helper that calls a helper');
  t.notOk(found.includes('cw') || found.includes('ccw'), 'but not the helper’s other arguments');
  t.ok(found.includes('Edit Handle') && found.includes('Move Points'), 'both branches of a ternary label');
});

suite('i18n: every catalogue agrees with the source', async (t) => {
  const { LANGUAGES } = t.app.i18n;
  const source = extract(sourceFiles());
  t.eq(source.problems.map((p) => `${p.location} ${p.message}`), [], 'the source has no tr() misuse');
  t.gt(source.strings.size, 1500, `the extractor found the interface (${source.strings.size} strings)`);

  // The surfaces nobody can miss: menu titles, every tool, every panel tab.
  const { MENU_TREE } = await import('/src/commands/definitions.js');
  const { tools } = await import('/src/tools/base.js');
  const { PANELS } = await import('/src/ui/panel-host.js');
  const chrome = [
    ...MENU_TREE.map((m) => m.label),
    ...[...tools.values()].map((tool) => tool.name),
    ...[...PANELS.values()].map((p) => p.title),
  ];

  for (const lang of LANGUAGES.filter((l) => l.load)) {
    const catalogue = (await lang.load()).default;
    const a = audit(catalogue, source, lang.tag);
    // Verified to fail: rewording the Layers panel's 'Lock transparent
    // pixels' tooltip leaves its translations behind as stale keys, listed
    // here for every language.
    t.eq(a.stale, [], `${lang.tag}: every key is still used somewhere`);
    t.eq(a.badPlaceholders.map((p) => p.key), [], `${lang.tag}: every translation keeps its {placeholders}`);
    t.eq(a.badPlurals.map((p) => `${p.key}: ${p.problem}`), [], `${lang.tag}: plural forms are ones the language has`);
    t.eq(chrome.filter((s) => !hasTranslation(catalogue, s)), [], `${lang.tag}: menus, tools and panels are all translated`);
  }
});

/* ------------------------------------------------------------------ */
/* The sweep                                                           */
/* ------------------------------------------------------------------ */

/** Every visible string under `root`: text nodes and the attributes people read. */
function textsOf(root) {
  const out = [];
  const data = (n) => n.parentElement && n.parentElement.closest('[translate="no"]');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const s = n.nodeValue.trim();
    if (s && !data(n)) out.push(s);
  }
  for (const e of root.querySelectorAll('[title],[placeholder],[aria-label]')) {
    if (e.closest('[translate="no"]')) continue;
    for (const a of ['title', 'placeholder', 'aria-label']) {
      const v = e.getAttribute(a);
      if (v && v.trim()) out.push(v.trim());
    }
  }
  return out;
}

/**
 * Strings that reached the screen without passing through tr(): an English
 * word left outside the pseudo-language's ⟦brackets⟧. Inside the brackets is
 * fine — that is a placeholder's value, which is data.
 */
function leaks(texts, allowed = () => false) {
  return [...new Set(texts)].filter((s) => /[A-Za-z]{3,}/.test(s.replace(/⟦[^⟧]*⟧/g, '')) && !allowed(s));
}

/** Let the click handlers and rebuilds the interface schedules run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

suite('i18n: every menu, tool and dialog goes through tr()', async (t) => {
  // The pseudo-language turns every translated string into ⟦…⟧, so anything
  // still plain English escaped translation. This drives the real interface:
  // it opens every menu and submenu, puts every tool in the options bar and
  // the status bar, remounts the chrome that is safe to remount, and opens a
  // handful of dialogs, then reads what is on screen.
  //
  // Verified to fail: dropping the tr() from the menu bar's filter items
  // (menubar.js filterItems) lists every filter name here.
  const app = t.app;
  const { loadLanguage, PSEUDO_LANGUAGE, tr } = app.i18n;
  const { tools } = await import('/src/tools/base.js');
  const { resolveItems } = await import('/src/ui/canvas-menu.js');
  const { buildToolbar } = await import('/src/ui/toolbar.js');
  const { buildTabBar } = await import('/src/ui/tabbar.js');
  const { buildPanelDock } = await import('/src/ui/panel-host.js');
  const { installWelcome } = await import('/src/ui/welcome.js');

  const doc = t.doc(64, 64, '#ffffff', '◆◆');
  const layerNames = new Set(doc.flatLayers().map((l) => l.name));
  const dataNames = (s) => app.docs.some((d) => s.startsWith(d.name)) || layerNames.has(s);
  const startTool = app.tool && app.tool.id;
  const found = { menus: [], options: [], status: [], context: [], chrome: [], dialogs: [] };

  await loadLanguage(PSEUDO_LANGUAGE);
  try {
    /* Menus: every top-level menu, and every submenu inside it. */
    const openRecent = tr('Open Recent');
    const readPopup = async (popup) => {
      for (const node of popup.querySelectorAll(':scope > .pk-menu-item')) {
        const label = node.querySelector('.pk-menu-label');
        found.menus.push(...textsOf(node));
        if (!node.classList.contains('has-sub') || node.classList.contains('disabled')) continue;
        if (label && label.textContent === openRecent) continue; // recent files are the user's names
        // Opening a sibling's submenu replaces the last one, so find the new popup
        // by identity, not by counting.
        const before = new Set(document.querySelectorAll('.pk-menu'));
        node.dispatchEvent(new MouseEvent('mouseenter'));
        await settle();
        const fresh = [...document.querySelectorAll('.pk-menu')].find((m) => !before.has(m));
        if (fresh) await readPopup(fresh);
      }
    };
    for (const btn of document.querySelectorAll('#menubar .pk-menu-btn')) {
      btn.click();
      await settle();
      const menus = document.querySelectorAll('.pk-menu');
      if (menus.length) await readPopup(menus[menus.length - 1]);
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    }

    /* Every tool: its options bar, the status bar, its right-click menu. */
    const ids = [...tools.keys()];
    for (const tool of tools.values()) {
      // setTool() does nothing for the tool already active, so step off it first.
      if (app.tool === tool) app.setTool(ids.find((id) => id !== tool.id));
      app.setTool(tool.id);
      await settle();
      found.options.push(...textsOf(document.getElementById('optionsbar')).map((s) => `${tool.id}: ${s}`));
      for (const sel of ['.pk-sb-tool', '.pk-sb-hint']) {
        const node = document.querySelector(`#statusbar ${sel}`);
        if (node) found.status.push(`${tool.id}: ${node.textContent}`);
      }
      let items = [];
      try {
        items = resolveItems(await tool.contextMenu({ x: 20, y: 20, sx: 20, sy: 20, button: 2, buttons: 2, pressure: 0.5, native: null }) || []);
      } catch { /* a tool that needs a drag first; the shared tail is still checked through others */ }
      for (const it of items) for (const s of [it.label, it.header]) if (s && !dataNames(s)) found.context.push(`${tool.id}: ${s}`);
    }

    /* Chrome that is built once at boot, remounted in the pseudo-language. */
    buildToolbar(document.getElementById('toolbar'));
    buildTabBar(document.getElementById('tabbar'));
    buildPanelDock(document.getElementById('panels'));
    installWelcome(document.getElementById('canvas-area'));
    await settle();
    found.chrome.push(...textsOf(document.getElementById('toolbar')));
    found.chrome.push(...textsOf(document.getElementById('tabbar')));
    for (const head of document.querySelectorAll('#panels .pk-pgroup-head')) found.chrome.push(...textsOf(head));
    const welcome = document.querySelector('.pk-welcome');
    // The recent-projects list is the user's names and the browser's own date phrases.
    for (const part of welcome.querySelectorAll(':scope .pk-wc-head, :scope .pk-wc-sec-head, :scope .pk-wc-tpls, :scope .pk-wc-foot')) {
      found.chrome.push(...textsOf(part).filter((s) => !/\bago\b|^now$|^yesterday$/i.test(s)));
    }

    /* Dialogs, opened for real and closed with Escape. */
    const dialogs = [
      ['Preferences', async () => (await import('/src/ui/dialogs/preferences.js')).showPreferencesDialog()],
      ['Image Size', async () => (await import('/src/ui/dialogs/image-size.js')).showImageSizeDialog(doc)],
      ['Canvas Size', async () => (await import('/src/ui/dialogs/canvas-size.js')).showCanvasSizeDialog(doc)],
      ['New Document', async () => (await import('/src/ui/dialogs/new-document.js')).showNewDocumentDialog()],
      ['Gaussian Blur', async () => (await import('/src/filters/run.js')).applyFilterCommand('gaussian-blur')],
      ['Levels', async () => (await import('/src/filters/run.js')).applyAdjustmentCommand('levels')],
    ];
    for (const [name, open] of dialogs) {
      const before = document.querySelectorAll('.pk-dialog-overlay').length;
      const pending = open().catch(() => {});
      for (let i = 0; i < 40 && document.querySelectorAll('.pk-dialog-overlay').length <= before; i++) await new Promise((r) => setTimeout(r, 10));
      const overlays = document.querySelectorAll('.pk-dialog-overlay');
      const dlg = overlays[overlays.length - 1];
      if (!dlg || overlays.length <= before) { t.ok(false, `${name}: the dialog opened`); continue; }
      found.dialogs.push(...textsOf(dlg).map((s) => `${name}: ${s}`));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await pending;
    }
  } finally {
    await loadLanguage('en');
    buildToolbar(document.getElementById('toolbar'));
    buildTabBar(document.getElementById('tabbar'));
    buildPanelDock(document.getElementById('panels'));
    installWelcome(document.getElementById('canvas-area'));
    if (startTool) app.setTool(startTool);
  }

  const strip = (s) => s.replace(/^[\w-]+: /, '').replace(/^[A-Z][\w ]+: /, '');
  t.gt(found.menus.length, 400, `the menus were read (${found.menus.length} strings)`);
  t.gt(found.options.length, 150, `the options bar was read for every tool (${found.options.length} strings)`);
  t.eq(leaks(found.menus, dataNames), [], 'menus: nothing escaped translation');
  t.eq(leaks(found.options.map(strip)), [], 'options bar: nothing escaped translation');
  t.eq(leaks(found.status.map(strip)), [], 'status bar: nothing escaped translation');
  t.eq(leaks(found.context.map(strip)), [], 'right-click menus: nothing escaped translation');
  t.eq(leaks(found.chrome, dataNames), [], 'toolbar, tabs, panel tabs and start screen: nothing escaped translation');
  t.eq(leaks(found.dialogs.map(strip)), [], 'dialogs: nothing escaped translation');
});

suite('i18n: a translated Background survives a PSD round trip', async (t) => {
  // A PSD marks its Background layer only by name. New documents now name it
  // in the interface language, so a Chinese user's background is "背景", and
  // psd-read used to recognise nothing but /^background$/i.
  // Verified to fail: with isBackgroundName() reduced to that regex, the
  // reopened bottom layer is an ordinary unlocked layer.
  const { writePSD } = await import('/src/io/psd-write.js');
  const { readPSD } = await import('/src/io/psd-read.js');
  const { PikaDocument } = await import('/src/core/document.js');
  await withLanguage(t, 'xx', { Background: '背景', 'Layer {number}': '图层 {number}' }, async () => {
    const doc = PikaDocument.blank(32, 24, 'psd', '#ffffff');
    const bg = doc.layers[doc.layers.length - 1];
    t.eq(bg.name, '背景', 'a new document names its background in the interface language');
    t.ok(bg.isBackground, 'and it is the background');
    const out = await readPSD(await (await writePSD(doc)).arrayBuffer());
    const back = out.layers[out.layers.length - 1];
    t.eq(back.name, '背景', 'the name comes back');
    t.ok(back.isBackground, 'and so does its Background status');
  });
  // And a file from a localised Photoshop, opened in English.
  const doc = PikaDocument.blank(16, 16, 'de', '#ffffff');
  doc.layers[doc.layers.length - 1].name = 'Hintergrund';
  const out = await readPSD(await (await writePSD(doc)).arrayBuffer());
  t.ok(out.layers[out.layers.length - 1].isBackground, 'German Photoshop’s "Hintergrund" is a background too');
});

suite('i18n: a helper\u2019s text position belongs to its own file unless exported', async (t) => {
  // Verified to fail: matching helpers by bare name across files (the first
  // version) extracted 65 lines of the PSD writer's EngineData — every
  // push('\t/EngineDict') — because another file had a local push(label).
  const files = [
    { path: 'a.js', source: "const push = (label) => out.push({ label });\npush('Interface A');\nexport function badge(title) { return el('span', { title }); }" },
    { path: 'b.js', source: "const L = []; const push = (...lines) => L.push(...lines);\npush('\\t/EngineDict');\nbadge('Interface B');" },
  ];
  const found = [...extract(files).strings.keys()];
  t.ok(found.includes('Interface A'), 'a local helper is followed in its own file');
  t.notOk(found.includes('\t/EngineDict'), 'but a same-named function elsewhere is not that helper');
  t.ok(found.includes('Interface B'), 'an exported helper is followed wherever it is called');
});

suite('i18n: a context separates one English word with two meanings', async (t) => {
  const { tr, msg } = t.app.i18n;
  const { formatAccel, IS_MAC } = await import('/src/commands/registry.js');
  t.eq(tr('Delete|key'), 'Delete', 'English drops the context');
  t.eq(String(msg('Delete|key')), 'Delete', 'and so does a message’s English');
  // Verified to fail: without context, the key and the command share one key,
  // and a German menu shows the Delete key as "Löschen" (or every Delete
  // button as "Entf").
  await withLanguage(t, 'xx', { Delete: 'Löschen', 'Delete|key': 'Entf' }, () => {
    t.eq(tr('Delete'), 'Löschen', 'the command');
    t.eq(tr('Delete|key'), 'Entf', 'the key');
    if (!IS_MAC) t.eq(formatAccel('Delete'), 'Entf', 'and an accelerator names the key, not the command');
  });
  await withLanguage(t, 'xx', { Delete: 'Löschen' }, () => {
    t.eq(tr('Delete|key'), 'Delete', 'an untranslated context falls back to English, not to the other meaning');
  });
});

suite('i18n: a new adjustment layer is named in the interface language', async (t) => {
  // Verified to fail: before adjustment layers were named after their
  // adjustment, this came out "levels" in every language.
  const { addAdjustmentLayer } = await import('/src/layers/ops.js');
  const { historyLabel } = await import('/src/core/history.js');
  const doc = t.doc(20, 20, '#ffffff');
  await withLanguage(t, 'xx', { Levels: 'Niveaux', 'New {name} Layer': 'Nouveau calque {name}' }, () => {
    const l = addAdjustmentLayer(doc, 'levels');
    t.eq(l.name, 'Niveaux 1', 'named in the language it was made in');
    const step = doc.history.states[doc.history.index];
    t.eq(step.label, 'New Levels Layer', 'its history step is stored in English');
    t.eq(historyLabel(step), 'Nouveau calque Niveaux', 'and shown in the language');
  });
});
