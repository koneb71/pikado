import { suite } from '../harness.js';
import { createRasterLayer } from '/src/core/layer.js';
import {
  installDesktop, uninstallDesktop, isDesktop, nativeMenuPayload, showUpdateState, keyEventInit,
} from '/src/io/desktop.js';
import { openFiles } from '/src/io/open.js';
import { saveDocument } from '/src/io/save.js';
import { savePKD, loadPKD } from '/src/io/pkd.js';
import { MENU_TREE } from '/src/commands/definitions.js';
import { menuSnapshot } from '/src/ui/menubar.js';
import { IS_MAC, getCommand } from '/src/commands/registry.js';

/**
 * The page's side of the desktop app (src/io/desktop.js), driven by a fake
 * bridge — the real one is desktop/preload.cjs, and desktop/test/ covers the
 * main process. Each suite installs the bridge and uninstalls it again, so the
 * suites after these see the page exactly as a browser runs it. Inside the
 * desktop app (`npm run desktop:test`) the real bridge is set aside meanwhile.
 */

/** Run `fn` with the page as a browser has it, restoring a real bridge after. */
async function aside(fn) {
  const real = isDesktop();
  if (real) uninstallDesktop();
  try {
    return await fn();
  } finally {
    if (real) installDesktop();
  }
}

/** A bridge that keeps files in memory and records what the page asked of it. */
function fakeBridge({ nativeMenu = false, pickedToken = null } = {}) {
  const files = new Map();
  const calls = { writes: [], edits: [], menus: [], installs: 0, opened: [], ready: 0, strings: null };
  const listeners = {};
  const listen = (name) => (cb) => {
    listeners[name] = cb;
    return () => {
      if (listeners[name] === cb) delete listeners[name];
    };
  };
  const b = {
    platform: nativeMenu ? 'darwin' : 'linux',
    version: '9.9.9',
    memoryDefaultMB: 1024,
    updates: true,
    nativeMenu,
    ready: async () => {
      calls.ready++;
      return true;
    },
    onOpenFiles: listen('open'),
    onMenuAction: listen('menu'),
    onUpdateState: listen('update'),
    onFullScreen: listen('fullscreen'),
    tokenForFile: async (file) => (pickedToken && /\.pkd$/i.test(file.name) ? pickedToken : null),
    readFile: async (token) => files.get(token),
    writeFile: async (token, bytes) => {
      files.set(token, bytes);
      calls.writes.push(token);
      return true;
    },
    saveDialog: async () => null,
    setMenu: (payload) => calls.menus.push(payload),
    nativeEdit: (op) => calls.edits.push(op),
    setStrings: (map) => {
      calls.strings = map;
    },
    checkForUpdates: async () => ({ status: 'checking' }),
    installUpdate: async () => {
      calls.installs++;
    },
    setAutoUpdate: () => {},
    openReleases: (url) => calls.opened.push(url),
  };
  return { b, files, calls, listeners };
}

async function until(fn, ms = 4000) {
  const end = performance.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (performance.now() > end) return null;
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Let a command started by runCommand finish: it holds a lock until it settles. */
const settle = () => new Promise((r) => setTimeout(r, 0));

async function pkdBytes(t, name) {
  const src = t.doc(320, 240, '#ffffff', name);
  const red = src.addLayer(createRasterLayer(320, 240, 'Red'));
  t.fill(red, '#ff0000', 10, 10, 50, 50);
  src.commit('setup');
  return new Uint8Array(await (await savePKD(src)).arrayBuffer());
}

const layerNames = (doc) => doc.flatLayers().map((l) => l.name);

/** The node for a command anywhere in a snapshot tree. */
function findCommand(nodes, id) {
  for (const n of nodes || []) {
    if (n.commandId === id) return n;
    const inner = findCommand(n.submenu, id);
    if (inner) return inner;
  }
  return null;
}

/* ================================================================== */

suite('desktop / without a bridge the page is the browser app', (t) => aside(async () => {
  // Verified to fail with installDesktop not checking for a bridge: it threw
  // reading the platform of nothing.
  t.notOk(installDesktop(null), 'nothing to install');
  t.notOk(document.documentElement.classList.contains('pk-desktop'), 'no desktop class');
  const help = menuSnapshot(MENU_TREE).menus.find((m) => m.key === 'Help');
  t.notOk(findCommand(help.submenu, 'help.check-updates'), 'no Check for Updates… in a browser');
  t.notOk(getCommand('help.check-updates'), 'nor its command');
}));

suite('desktop / a file from the OS opens, and Save writes it back', (t) => aside(async () => {
  // Verified to fail with the stand-in handle's close() not passing the bytes
  // on: Save reported success and the file on disk was unchanged.
  const bytes = await pkdBytes(t, 'from-os-src');
  const fake = fakeBridge();
  fake.files.set('tok-1', bytes);
  let doc = null;
  try {
    t.ok(installDesktop(fake.b), 'installs with a bridge');
    t.ok(document.documentElement.classList.contains('pk-desktop-linux'), 'and marks the page');
    t.ok(fake.calls.strings && fake.calls.strings.quitAnyway, 'the main process gets its strings');

    const before = new Set(t.app.docs);
    fake.listeners.open([{ token: 'tok-1', name: 'art.pkd', bytes }]);
    doc = await until(() => t.app.docs.find((d) => !before.has(d)));
    t.ok(doc, 'the file opened as a document');
    t.eq(doc && doc.name, 'from-os-src', 'with its own name');
    t.eq(doc && doc.fileHandle && doc.fileHandle.desktopToken, 'tok-1', 'holding its file by token');

    const blue = doc.addLayer(createRasterLayer(320, 240, 'Blue'));
    t.fill(blue, '#0000ff', 100, 100, 40, 40);
    doc.commit('blue');
    t.ok(await saveDocument(doc), 'Save says it saved');
    t.eq(fake.calls.writes, ['tok-1'], 'once, to the file it came from');
    const back = await loadPKD(fake.files.get('tok-1').buffer);
    t.eq(layerNames(back), layerNames(doc), 'and the file now holds the edit');
    t.notOk(doc.dirty, 'the document is clean');
  } finally {
    uninstallDesktop();
    if (doc) t.app.closeDocument(doc);
  }
  t.notOk(document.documentElement.classList.contains('pk-desktop'), 'uninstalling removes the marks');
}));

suite('desktop / a .pkd picked in the Open dialog saves back to it', (t) => aside(async () => {
  // Verified to fail without the handle provider in openFile: the document had
  // no file handle, so Save would have asked where to save.
  const bytes = await pkdBytes(t, 'picked-src');
  const fake = fakeBridge({ pickedToken: 'picked-1' });
  const opened = [];
  try {
    installDesktop(fake.b);
    const [doc] = await openFiles([new File([bytes], 'picked.pkd')]);
    opened.push(doc);
    t.eq(doc && doc.fileHandle && doc.fileHandle.desktopToken, 'picked-1', 'the picked file is its handle');
    if (!doc || !doc.fileHandle) return;
    fake.files.set('picked-1', bytes);
    const file = await doc.fileHandle.getFile();
    t.ok(file instanceof File, 'Revert reads it back as a File');
    t.eq(file.size, bytes.length, 'through the bridge');
  } finally {
    uninstallDesktop();
    for (const d of opened.splice(0)) if (d) t.app.closeDocument(d);
  }
  const [plain] = await openFiles([new File([bytes], 'picked.pkd')]);
  t.notOk(plain && plain.fileHandle, 'without the bridge, File > Open gives no handle (as in a browser)');
  if (plain) t.app.closeDocument(plain);
}));

suite('desktop / the macOS menu bar is the page’s own menus', (t) => aside(async () => {
  // Verified to fail with a menu key replayed as a click: the active tool no
  // longer saw Cmd+A first.
  const doc = t.doc(200, 150, '#ffffff', 'menu-doc');
  t.app.setActiveDoc(doc);
  const fake = fakeBridge({ nativeMenu: true });
  // Help > Check for Updates… exists only where window.pikadoDesktop does. In
  // the desktop app it already does, and is read-only.
  const stub = !window.pikadoDesktop;
  if (stub) window.pikadoDesktop = fake.b;
  if (!t.app.tool) t.app.setTool('move');
  const tool = t.app.tool;
  const ownKeyDown = tool.onKeyDown;
  const input = document.body.appendChild(document.createElement('input'));
  try {
    installDesktop(fake.b);
    t.ok(document.documentElement.classList.contains('pk-native-menu'), 'the in-window menus give way');
    const payload = await until(() => fake.calls.menus.at(-1));
    t.ok(payload, 'the page sends its menus');
    t.eq(payload.menus.map((m) => m.key), MENU_TREE.map((m) => m.label), 'every top-level menu, in order');
    t.eq(payload.app.about.commandId, 'help.about', 'About goes to the app menu');
    t.eq(payload.app.settings.commandId, 'edit.preferences', 'so does Preferences');
    t.eq(payload.app.updates.commandId, 'help.check-updates', 'and Check for Updates…');
    t.notOk(findCommand(payload.menus, 'edit.preferences'), 'and leaves Edit');
    t.ok(payload.taken.includes('Ctrl+H'), "Pikado's shortcuts are listed for the app menu to avoid");

    const filters = payload.menus.find((m) => m.key === 'Filter');
    t.ok(JSON.stringify(filters).includes('Gaussian Blur'), 'the filters are listed');
    const windowMenu = payload.menus.find((m) => m.key === 'Window');
    const entry = JSON.stringify(windowMenu.submenu).includes('"label":"menu-doc"');
    t.ok(entry, 'and the open documents');

    // A session restoring in the background may switch documents: keep ours in front.
    const front = () => t.app.setActiveDoc(doc);
    front();
    const undoNow = findCommand(nativeMenuPayload().payload.menus, 'edit.undo');
    t.eq(undoNow.enabled, false, 'Undo is disabled on a fresh document');
    const L = doc.addLayer(createRasterLayer(200, 150, 'L'));
    t.fill(L, '#00ff00');
    doc.commit('paint');
    const fresh = await until(() => {
      front();
      const p = fake.calls.menus.at(-1);
      const n = findCommand(p.menus, 'edit.undo');
      return n && n.enabled ? p : null;
    });
    t.ok(fresh, 'and the menu is resent with it enabled after an edit');

    const latest = fake.calls.menus.at(-1);
    const all = findCommand(latest.menus, 'select.all');
    front();
    doc.selection.clear();
    fake.listeners.menu({ id: all.actionId, viaKey: false });
    t.ok(doc.selection.active, 'a click runs the item');
    await settle();

    front();
    doc.selection.clear();
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    fake.listeners.menu({ id: all.actionId, viaKey: true });
    t.ok(doc.selection.active, 'a caught Cmd+A runs it through the page’s keys');
    await settle();

    front();
    doc.selection.clear();
    const seen = [];
    tool.onKeyDown = (e) => {
      seen.push(`${e.metaKey || e.ctrlKey ? 'mod+' : ''}${e.key}`);
      return true;
    };
    fake.listeners.menu({ id: all.actionId, viaKey: true });
    t.eq(seen, ['mod+a'], 'the active tool sees the key first');
    t.notOk(doc.selection.active, 'and keeps it');
    tool.onKeyDown = ownKeyDown;

    const copy = findCommand(latest.menus, 'edit.copy');
    input.focus();
    fake.listeners.menu({ id: copy.actionId, viaKey: true });
    t.eq(fake.calls.edits, ['copy'], 'in a text field, Cmd+C copies the text');
    if (IS_MAC) {
      const ev = new KeyboardEvent('keydown', { ...keyEventInit('Ctrl+V'), bubbles: true, cancelable: true });
      input.dispatchEvent(ev);
      t.eq(fake.calls.edits, ['copy', 'paste'], 'and Cmd+V reaching the page pastes');
      t.ok(ev.defaultPrevented, 'without also reaching the menu');
    }
  } finally {
    tool.onKeyDown = ownKeyDown;
    input.remove();
    uninstallDesktop();
    if (stub) delete window.pikadoDesktop;
  }
  t.notOk(document.documentElement.classList.contains('pk-native-menu'), 'the in-window menus come back');
}));

suite('desktop / updates are shown and installed through the bridge', (t) => aside(async () => {
  // Verified to fail with the pill's click not wired to installUpdate.
  const fake = fakeBridge();
  const pill = document.querySelector('.pk-net-update');
  t.ok(pill, 'the update pill is in the app bar');
  if (!pill) return;
  try {
    installDesktop(fake.b);
    showUpdateState(fake.b, { status: 'ready', version: '1.2.3' });
    t.notOk(pill.hidden, 'a downloaded update shows the pill');
    t.ok(pill.textContent.includes('Restart'), `asking for a restart ("${pill.textContent.trim()}")`);
    pill.click();
    await until(() => fake.calls.installs);
    t.eq(fake.calls.installs, 1, 'which installs it');

    showUpdateState(fake.b, { status: 'available', version: '1.2.4', releasesUrl: 'https://github.com/koneb71/pikado/releases/latest' });
    pill.click();
    t.eq(fake.calls.opened, ['https://github.com/koneb71/pikado/releases/latest'], 'an update this build cannot install opens the release page');
  } finally {
    uninstallDesktop();
    pill.hidden = true;
  }
}));
