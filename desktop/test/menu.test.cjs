'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toElectronAccelerator, registersAsMenuShortcut, buildTemplate } = require('../lib/menu.cjs');

test("Pikado's shortcuts in Electron's form", () => {
  const cases = {
    'Ctrl+Z': 'CmdOrCtrl+Z',
    'Ctrl+Shift+Z': 'CmdOrCtrl+Shift+Z',
    'Shift+Ctrl+]': 'CmdOrCtrl+Shift+]',
    'Alt+Shift+Ctrl+W': 'CmdOrCtrl+Alt+Shift+W',
    'Ctrl+=': 'CmdOrCtrl+=',
    'Ctrl+-': 'CmdOrCtrl+-',
    'Ctrl+;': 'CmdOrCtrl+;',
    'Ctrl+0': 'CmdOrCtrl+0',
    'Ctrl+PageDown': 'CmdOrCtrl+PageDown',
    'Ctrl+Backspace': 'CmdOrCtrl+Backspace',
    'Ctrl++': 'CmdOrCtrl+Plus',
    Esc: 'Escape',
    Delete: 'Delete',
    'Shift+F5': 'Shift+F5',
    f12: 'F12',
    q: 'Q',
  };
  for (const [pikado, electron] of Object.entries(cases)) assert.equal(toElectronAccelerator(pikado), electron, pikado);
  assert.equal(toElectronAccelerator(''), null);
  assert.equal(toElectronAccelerator(undefined), null);
  assert.equal(toElectronAccelerator('Ctrl+Shift'), null, 'modifiers alone');
});

test('only shortcuts with Cmd become menu shortcuts', () => {
  // A bare key as a menu shortcut would fire while typing in a text field.
  for (const a of ['Ctrl+S', 'Alt+Ctrl+I', 'Shift+Ctrl+N']) assert.ok(registersAsMenuShortcut(a), a);
  for (const a of ['B', 'Q', 'Esc', 'Enter', 'Delete', 'F12', 'Shift+F5', 'Alt+Backspace', '']) {
    assert.ok(!registersAsMenuShortcut(a), a);
  }
});

const ROLES = Object.fromEntries(
  ['hide', 'hideOthers', 'unhide', 'quit', 'minimize', 'zoom', 'fullScreen', 'front', 'reload', 'devTools'].map((k) => [k, () => k]),
);

function build(payload, extra = {}) {
  const calls = [];
  const template = buildTemplate(payload, {
    appName: 'Pikado', roles: ROLES, onAction: (id, viaKey) => calls.push([id, viaKey]), ...extra,
  });
  return { template, calls };
}

const find = (items, label) => items.find((i) => i.label === label);

const PAYLOAD = {
  menus: [
    {
      key: 'Edit', label: 'Bearbeiten',
      submenu: [
        { label: 'Rückgängig', accel: 'Ctrl+Z', actionId: 1, enabled: true },
        { type: 'separator' },
        { type: 'separator' },
        { label: 'Lineale', accel: 'Ctrl+R', checkable: true, checked: true, actionId: 2 },
        { label: 'Pinsel', accel: 'B', checkable: true, checked: false, actionId: 3 },
        { label: 'Aus', enabled: false, actionId: 4 },
        { type: 'separator' },
      ],
    },
    { key: 'Window', label: 'Fenster', submenu: [{ label: 'Ebenen', actionId: 5 }] },
    { key: 'Help', label: 'Hilfe', submenu: [{ label: 'Tastaturbefehle', actionId: 6 }] },
  ],
  app: { about: { label: 'Über Pikado…', actionId: 7 }, settings: { label: 'Voreinstellungen…', accel: 'Ctrl+K', actionId: 8 } },
  taken: ['Ctrl+H', 'Ctrl+M', 'Ctrl+Z', 'Ctrl+R'],
};

test("the page's menus become the template, clicks and keys reaching the page", () => {
  // Verified to fail with triggeredByAccelerator ignored: a caught key press
  // reached the page as a click, skipping the active tool.
  const { template, calls } = build(PAYLOAD);
  const edit = find(template, 'Bearbeiten');
  assert.ok(edit, 'labels come as sent, already translated');
  const undo = find(edit.submenu, 'Rückgängig');
  assert.equal(undo.accelerator, 'CmdOrCtrl+Z');
  undo.click(null, null, { triggeredByAccelerator: false });
  undo.click(null, null, { triggeredByAccelerator: true });
  assert.deepEqual(calls, [[1, false], [1, true]]);

  const rulers = find(edit.submenu, 'Lineale');
  assert.equal(rulers.type, 'checkbox');
  assert.equal(rulers.checked, true);
  const brush = find(edit.submenu, 'Pinsel');
  assert.equal(brush.accelerator, undefined, 'a tool letter is not a menu shortcut');
  assert.equal(find(edit.submenu, 'Aus').enabled, false);
  assert.equal(edit.submenu.filter((i) => i.type === 'separator').length, 1, 'separators collapse');
  assert.notEqual(edit.submenu.at(-1).type, 'separator');
});

test("the standard commands give way to Pikado's shortcuts", () => {
  // Verified to fail with `taken` ignored: Hide claimed Cmd+H from Pikado.
  const { template } = build(PAYLOAD);
  const appMenu = template[0];
  assert.equal(appMenu.label, 'Pikado');
  assert.equal(find(appMenu.submenu, 'Hide Pikado').accelerator, undefined, 'Cmd+H is Pikado’s');
  assert.equal(find(appMenu.submenu, 'Hide Others').accelerator, 'Command+Alt+H');
  assert.equal(find(appMenu.submenu, 'Quit Pikado').accelerator, 'Command+Q');
  assert.equal(find(appMenu.submenu, 'Voreinstellungen…').accelerator, 'CmdOrCtrl+K', 'Settings keeps its own shortcut');
  assert.equal(find(appMenu.submenu, 'Quit Pikado').click(), 'quit');

  const win = find(template, 'Fenster');
  assert.equal(win.role, 'window', "Pikado's Window menu is the system one");
  assert.equal(find(win.submenu, 'Minimize').accelerator, undefined, 'Cmd+M is Curves');
  assert.equal(find(win.submenu, 'Toggle Full Screen').accelerator, 'Control+Command+F');
  assert.ok(find(win.submenu, 'Ebenen'), "and keeps Pikado's own items");
  assert.equal(template.filter((m) => m.role === 'window').length, 1, 'one Window menu');
  assert.equal(find(template, 'Hilfe').role, 'help');
});

test('translated standard commands, and the developer menu only when asked', () => {
  const { template } = build(PAYLOAD, { strings: { hide: 'Pikado ausblenden', quit: 'Pikado beenden' } });
  assert.ok(find(template[0].submenu, 'Pikado ausblenden'));
  assert.ok(find(template[0].submenu, 'Pikado beenden'));
  assert.equal(find(template, 'Developer'), undefined);
  assert.ok(find(build(PAYLOAD, { developer: true }).template, 'Developer'));
});

test('without a Window menu from the page there is still one', () => {
  const { template } = build({ menus: [{ key: 'File', label: 'File', submenu: [] }] });
  const win = template.find((m) => m.role === 'window');
  assert.ok(win);
  assert.equal(find(win.submenu, 'Minimize').accelerator, 'Command+M');
});
