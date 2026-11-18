import { app } from '../core/app.js';
import { msg, tr } from '../core/i18n.js';
import { openFiles, setHandleProvider } from './open.js';
import { showUpdatePill } from './offline.js';
import { IS_MAC, accelBinding, commands, registerCommand } from '../commands/registry.js';
import { MENU_TREE } from '../commands/definitions.js';
import { menuSnapshot } from '../ui/menubar.js';
import { BRAND } from '../ui/brand.js';
import './desktop.css';

/**
 * The page's side of the desktop app.
 *
 * `window.pikadoDesktop` is the bridge desktop/preload.cjs exposes; in a browser
 * there is none and nothing here runs. With it:
 *
 *   files       Files from the OS arrive as bytes with a token and are opened
 *               like any other. A token is all the page holds of a file on disk:
 *               `standInHandle` wraps one in the few methods Save, Revert and
 *               Open Recent call on a File System Access handle, so a `.pkd`
 *               opened from Finder, Explorer or the Open dialog saves back to
 *               itself. Real handles (Save As, a drop) are used as they are.
 *   menus       On macOS the menus move to the system menu bar: a snapshot of
 *               MENU_TREE is sent whenever something that changes it happens.
 *               A menu click runs the item. A key press the menu caught is
 *               replayed into the page, so the active tool still sees it first,
 *               exactly as when the page gets the key itself. In a text field,
 *               the editing keys run the field's own Copy, Paste and so on.
 *   updates     The main process checks GitHub Releases; this shows the result.
 *
 * Split from main.js and handed the bridge so the suite can drive it with a
 * fake one.
 */

/** The bridge in use, once installed. */
let bridge = null;
/** Undoes everything installDesktop attached. */
let cleanups = [];

export function isDesktop() {
  return !!bridge;
}

/**
 * Wire the page to the desktop bridge. Does nothing without one.
 * @param {object|null} [b] the bridge; defaults to `window.pikadoDesktop`
 * @returns {boolean} whether it installed
 */
export function installDesktop(b = (typeof window !== 'undefined' && window.pikadoDesktop) || null) {
  if (!b || bridge) return false;
  bridge = b;
  const keep = (off) => {
    if (typeof off === 'function') cleanups.push(off);
  };

  const root = document.documentElement;
  const classes = ['pk-desktop', `pk-desktop-${b.platform}`, ...(b.nativeMenu ? ['pk-native-menu'] : [])];
  root.classList.add(...classes);
  keep(() => root.classList.remove(...classes, 'pk-fullscreen'));
  if (b.onFullScreen) keep(b.onFullScreen((on) => root.classList.toggle('pk-fullscreen', !!on)));

  setHandleProvider(async (file) => {
    const token = await b.tokenForFile(file);
    return token ? standInHandle(b, token, file.name) : null;
  });
  keep(() => setHandleProvider(null));
  keep(b.onOpenFiles((list) => openFiles((list || []).map((f) => fileFromBridge(b, f)))));

  registerCommand({
    id: 'help.check-updates',
    label: 'Check for Updates…',
    reentrant: true,
    run: () => checkForUpdates(b),
  });
  keep(() => commands.delete('help.check-updates'));
  keep(b.onUpdateState((state) => showUpdateState(b, state)));
  b.setStrings(mainStrings());

  if (b.nativeMenu) {
    installNativeMenu(b, keep);
    installEditKeys(b, keep);
  }

  // Files the OS handed over before the page could take them come now.
  if (app.ready) b.ready();
  else keep(app.on('ready', () => b.ready()));
  return true;
}

/** Undo installDesktop: the page behaves as in a browser again. For the suite. */
export function uninstallDesktop() {
  for (const off of cleanups.splice(0).reverse()) {
    try {
      off();
    } catch (err) {
      console.error('[desktop]', err);
    }
  }
  clearTimeout(menuTimer);
  menuTimer = null;
  menuActions = new Map();
  bridge = null;
}

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

/**
 * A File System Access file handle, as far as Pikado uses one, for a file on
 * disk the page knows only by its token.
 * @param {object} b the bridge
 * @param {string} token
 * @param {string} name
 */
export function standInHandle(b, token, name) {
  return {
    kind: 'file',
    name,
    desktopToken: token,
    async getFile() {
      return new File([await b.readFile(token)], name);
    },
    async createWritable() {
      const parts = [];
      return {
        async write(data) {
          parts.push(data instanceof Blob ? data : new Blob([data && data.data !== undefined ? data.data : data]));
        },
        async close() {
          const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
          await b.writeFile(token, bytes);
        },
        async abort() {
          parts.length = 0;
        },
      };
    },
    async queryPermission() {
      return 'granted';
    },
    async requestPermission() {
      return 'granted';
    },
    async isSameEntry(other) {
      return !!other && other.desktopToken === token;
    },
  };
}

function fileFromBridge(b, { token, name, bytes }) {
  const file = new File([bytes], name);
  file.handle = standInHandle(b, token, name);
  return file;
}

/* ------------------------------------------------------------------ */
/* The macOS menu bar                                                  */
/* ------------------------------------------------------------------ */

/** Commands that live in the app menu on macOS rather than where MENU_TREE puts them. */
const APP_MENU = { 'help.about': 'about', 'edit.preferences': 'settings', 'help.check-updates': 'updates' };

/** What changes a label, a tick or whether an item is enabled. */
const MENU_EVENTS = [
  'ready', 'docs-change', 'active-doc', 'doc-change', 'history-change', 'tool-change',
  'doc-selection', 'command-done', 'prefs-change', 'shortcuts-change', 'chrome-change', 'screen-mode',
];

let menuActions = new Map();
let menuTimer = null;

/** The menu tree as the bridge sends it, and the actions its ids stand for. */
export function nativeMenuPayload() {
  const snap = menuSnapshot(MENU_TREE);
  const moved = {};
  const pluck = (nodes) => nodes.filter((node) => {
    const slot = node.commandId && APP_MENU[node.commandId];
    if (slot) {
      moved[slot] = node;
      return false;
    }
    if (node.submenu) node.submenu = pluck(node.submenu);
    return true;
  });
  for (const menu of snap.menus) menu.submenu = pluck(menu.submenu);
  const taken = [];
  for (const c of commands.values()) for (const a of [c.accel, ...(c.altAccels || [])]) if (a) taken.push(a);
  return { payload: { menus: snap.menus, app: moved, taken }, actions: snap.actions };
}

function sendMenu(b) {
  menuTimer = null;
  const { payload, actions } = nativeMenuPayload();
  menuActions = actions;
  b.setMenu(payload);
}

function installNativeMenu(b, keep) {
  const schedule = () => {
    if (!menuTimer) menuTimer = setTimeout(() => sendMenu(b), 100);
  };
  for (const ev of MENU_EVENTS) keep(app.on(ev, schedule));
  window.addEventListener('focus', schedule);
  keep(() => window.removeEventListener('focus', schedule));
  schedule();
  keep(b.onMenuAction(({ id, viaKey } = {}) => runMenuAction(b, id, viaKey)));
}

/**
 * A menu item was chosen. A click runs it; a key press the menu caught is
 * replayed into the page instead, so it goes through the same path as a key
 * the page received (the tool first, then the command bindings).
 */
export function runMenuAction(b, id, viaKey) {
  const action = menuActions.get(id);
  if (!action) return;
  if (viaKey && action.accel) {
    replayKey(b, action.accel);
    return;
  }
  try {
    const r = action.run && action.run();
    if (r && typeof r.catch === 'function') r.catch((err) => console.error('[desktop menu]', err));
  } catch (err) {
    console.error('[desktop menu]', err);
  }
}

/** The text-editing commands, by Pikado's binding for their key. */
const EDIT_KEYS = {
  'ctrl+z': 'undo', 'ctrl+shift+z': 'redo', 'ctrl+x': 'cut', 'ctrl+c': 'copy', 'ctrl+v': 'paste', 'ctrl+a': 'selectAll',
};

function isEditable(node) {
  if (!node || node === document.body) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true;
}

const CODES = {
  '=': 'Equal', '-': 'Minus', '[': 'BracketLeft', ']': 'BracketRight', ';': 'Semicolon', "'": 'Quote',
  ',': 'Comma', '.': 'Period', '/': 'Slash', '\\': 'Backslash', '`': 'Backquote',
};
const NAMED = { esc: 'Escape', escape: 'Escape', enter: 'Enter', delete: 'Delete', backspace: 'Backspace', pageup: 'PageUp', pagedown: 'PageDown' };

/** The KeyboardEvent init a real press of `accel` would produce (Pikado's Ctrl is Cmd on a Mac). */
export function keyEventInit(accel) {
  let ctrl = false, alt = false, shift = false, key = '';
  for (const part of String(accel).split('+').map((p) => p.trim())) {
    const l = part.toLowerCase();
    if (l === 'ctrl' || l === 'cmd') ctrl = true;
    else if (l === 'alt') alt = true;
    else if (l === 'shift') shift = true;
    else if (part) key = part;
  }
  if (!key) return null;
  let code;
  if (/^[a-z]$/i.test(key)) {
    code = `Key${key.toUpperCase()}`;
    key = shift ? key.toUpperCase() : key.toLowerCase();
  } else if (/^[0-9]$/.test(key)) {
    code = `Digit${key}`;
  } else if (CODES[key]) {
    code = CODES[key];
  } else if (NAMED[key.toLowerCase()]) {
    key = NAMED[key.toLowerCase()];
    code = key;
  } else if (/^F\d{1,2}$/i.test(key)) {
    key = key.toUpperCase();
    code = key;
  } else {
    return null;
  }
  return {
    key, code, metaKey: ctrl && IS_MAC, ctrlKey: ctrl && !IS_MAC, altKey: alt, shiftKey: shift, bubbles: true, cancelable: true,
  };
}

/** Replay a key press the menu caught: into the field's editing, or into the page. */
function replayKey(b, accel) {
  const target = document.activeElement;
  if (isEditable(target)) {
    const op = EDIT_KEYS[accelBinding(accel)];
    if (op) b.nativeEdit(op);
    return;
  }
  const init = keyEventInit(accel);
  if (!init) return;
  const node = target && target !== document.documentElement ? target : document.body;
  node.dispatchEvent(new KeyboardEvent('keydown', init));
  node.dispatchEvent(new KeyboardEvent('keyup', init));
}

/**
 * The editing keys in a text field, when they reach the page. A macOS text
 * field gets Copy, Paste and the rest only through the menu bar's Edit menu,
 * and Pikado's Edit items act on the image (and are disabled with no document
 * open), so the field's own command is run directly.
 */
function installEditKeys(b, keep) {
  const onKey = (e) => {
    if (!e.metaKey || e.ctrlKey || !isEditable(e.target)) return;
    const key = e.code && e.code.startsWith('Key') ? e.code.slice(3) : e.key;
    const op = EDIT_KEYS[accelBinding(`Ctrl+${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${key}`)];
    if (!op) return;
    e.preventDefault();
    e.stopPropagation();
    b.nativeEdit(op);
  };
  window.addEventListener('keydown', onKey, true);
  keep(() => window.removeEventListener('keydown', onKey, true));
}

/* ------------------------------------------------------------------ */
/* Strings the main process shows                                      */
/* ------------------------------------------------------------------ */

const STRINGS = {
  quitAnyway: msg('Quit Without Saving'),
  cancel: msg('Cancel'),
  unsavedTitle: msg('You have unsaved changes.'),
  unsavedDetail: msg('Documents that have not been saved or autosaved will be lost.'),
  services: msg('Services'),
  hide: msg('Hide {app}'),
  hideOthers: msg('Hide Others'),
  showAll: msg('Show All'),
  quit: msg('Quit {app}'),
  window: msg('Window'),
  minimize: msg('Minimize'),
  zoom: msg('Zoom'),
  fullScreen: msg('Toggle Full Screen'),
  front: msg('Bring All to Front'),
};

function mainStrings() {
  const out = {};
  for (const [key, text] of Object.entries(STRINGS)) out[key] = tr(text, { app: BRAND.name });
  return out;
}

/* ------------------------------------------------------------------ */
/* Updates                                                             */
/* ------------------------------------------------------------------ */

async function checkForUpdates(b) {
  const state = await b.checkForUpdates();
  if (state && state.status === 'unavailable') {
    app.toast(tr('Updates are checked only in the installed app.'), 'info');
  } else {
    app.toast(tr('Checking for updates…'), 'info', 2500);
  }
}

/**
 * Show what the updater found. Quiet unless there is something to do, or the
 * user asked (Check for Updates…).
 * @param {object} b the bridge
 * @param {{status: string, version?: string, manual?: boolean, message?: string, releasesUrl?: string}} state
 */
export function showUpdateState(b, state) {
  if (!state) return;
  const version = state.version || '';
  switch (state.status) {
    case 'ready':
      showUpdatePill({
        label: tr('Restart to update'),
        title: tr('Pikado {version} is ready. Restart to use it.', { version }),
        onClick: () => b.installUpdate(),
      });
      app.toast(tr('Pikado {version} is ready — restart when you are done to use it.', { version }), 'info', 7000);
      break;
    case 'available':
      // An unsigned Mac build cannot install updates itself.
      showUpdatePill({
        label: tr('Update available'),
        title: tr('Pikado {version} is available. Download it from GitHub.', { version }),
        onClick: () => b.openReleases(state.releasesUrl),
      });
      if (state.manual) app.toast(tr('Pikado {version} is available.', { version }), 'info', 5000);
      break;
    case 'downloading':
      if (state.manual) app.toast(tr('Downloading Pikado {version}…', { version }), 'info', 5000);
      break;
    case 'none':
      if (state.manual) app.toast(tr('Pikado is up to date.'), 'ok');
      break;
    case 'error':
      if (state.manual) app.toast(tr('Could not check for updates: {reason}', { reason: state.message || '' }), 'error', 6000);
      break;
    default:
      break;
  }
}
