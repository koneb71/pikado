'use strict';

/**
 * The macOS menu bar, built from what the page sends.
 *
 * The page owns the menus: it walks its own MENU_TREE (src/ui/menubar.js
 * `menuSnapshot`) with every label already translated and every enabled and
 * checked state already evaluated, and sends that tree with an `actionId` on
 * each leaf. This module turns it into an Electron template whose clicks call
 * `onAction(actionId, viaKey)`; the page runs the item, or — when the click was
 * really a key press the menu caught (`viaKey`) — replays the key into itself,
 * so the active tool still gets first refusal exactly as in the browser.
 *
 * Only shortcuts with Cmd (Pikado's `Ctrl`) become menu shortcuts. A bare letter,
 * Enter, Delete or an F-key is shown nowhere and left to the page: as a menu
 * shortcut it would fire while typing in a text field.
 *
 * Pure: no Electron import, so it is unit-tested with `node --test`.
 */

const KEYS = {
  esc: 'Escape', escape: 'Escape', enter: 'Enter', return: 'Enter', delete: 'Delete', del: 'Delete',
  backspace: 'Backspace', pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End',
  space: 'Space', tab: 'Tab', up: 'Up', down: 'Down', left: 'Left', right: 'Right', '+': 'Plus',
};

/**
 * Pikado's accelerator ("Shift+Ctrl+]") in Electron's form ("CmdOrCtrl+Shift+]"),
 * or null for none. Pikado's Ctrl is Cmd on macOS, which is what CmdOrCtrl means.
 * @param {string} accel
 * @returns {string|null}
 */
function toElectronAccelerator(accel) {
  if (!accel || typeof accel !== 'string') return null;
  const parts = accel.split('+').map((p) => p.trim());
  // "Ctrl++" splits into an empty last part: the key is the plus sign.
  if (accel.endsWith('++')) parts.splice(-2, 2, '+');
  let ctrl = false, alt = false, shift = false, key = '';
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'ctrl' || l === 'cmd' || l === 'command' || l === 'cmdorctrl') ctrl = true;
    else if (l === 'alt' || l === 'opt' || l === 'option') alt = true;
    else if (l === 'shift') shift = true;
    else if (p) key = p;
  }
  if (!key) return null;
  const named = KEYS[key.toLowerCase()];
  if (named) key = named;
  else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(key)) key = key.toUpperCase();
  else if (key.length === 1) key = key.toUpperCase();
  else return null;
  return [ctrl && 'CmdOrCtrl', alt && 'Alt', shift && 'Shift', key].filter(Boolean).join('+');
}

/** Whether a menu should claim this shortcut: only with Cmd (Pikado's Ctrl). */
function registersAsMenuShortcut(accel) {
  const a = toElectronAccelerator(accel);
  return !!a && a.startsWith('CmdOrCtrl+');
}

/** A comparable form of an Electron accelerator: modifiers sorted, case folded. */
function normAccel(a) {
  if (!a) return '';
  const parts = a.split('+').map((p) => p.toLowerCase());
  const key = parts.pop();
  const mods = parts.map((m) => (m === 'command' || m === 'cmd' || m === 'cmdorctrl' || m === 'commandorcontrol' ? 'cmd' : m === 'option' ? 'alt' : m));
  return [...new Set(mods)].sort().concat(key).join('+');
}

function collapseSeparators(items) {
  const out = [];
  for (const it of items) {
    if (it.type === 'separator' && (!out.length || out[out.length - 1].type === 'separator')) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop();
  return out;
}

/**
 * One node of the page's tree as an Electron menu item.
 * @param {object} node {type?, label, enabled, checked, checkable, accel, actionId, submenu}
 * @param {(actionId:number, viaKey:boolean) => void} onAction
 */
function toItem(node, onAction) {
  if (!node || node.type === 'separator') return { type: 'separator' };
  const item = { label: String(node.label || ''), enabled: node.enabled !== false };
  if (Array.isArray(node.submenu)) {
    item.submenu = collapseSeparators(node.submenu.map((n) => toItem(n, onAction)));
    return item;
  }
  if (node.checkable) {
    item.type = 'checkbox';
    item.checked = !!node.checked;
  }
  if (registersAsMenuShortcut(node.accel)) item.accelerator = toElectronAccelerator(node.accel);
  const id = node.actionId;
  item.click = (_menuItem, _window, event) => onAction(id, !!(event && event.triggeredByAccelerator));
  return item;
}

/**
 * The whole macOS template: the app menu, then Pikado's menus. The standard
 * window commands go at the top of Pikado's own Window menu (a separate one
 * when there is none), and Help becomes the system Help menu, with its search.
 *
 * The standard app and window commands keep their usual shortcuts unless
 * Pikado already uses that key — Cmd+H is Pikado's, so Hide has none, and Cmd+M
 * is Curves, so Minimize has none. `taken` lists Pikado's shortcuts, in either
 * Pikado's form or Electron's.
 *
 * @param {{menus: object[], app?: {about?: object, settings?: object, updates?: object}, taken?: string[]}} payload
 * @param {{appName: string, strings?: Record<string,string>, onAction: Function,
 *          roles: Record<string, Function>, developer?: boolean}} opts
 */
function buildTemplate(payload, opts) {
  const { appName, onAction, roles } = opts;
  const s = { ...DEFAULT_STRINGS, ...(opts.strings || {}) };
  const fill = (text) => text.replace('{app}', appName);
  const taken = new Set((payload.taken || []).map((a) => normAccel(toElectronAccelerator(a) || a)));
  /** A standard command, with its usual shortcut unless Pikado has that key. */
  const std = (label, accelerator, run) => {
    const item = { label, click: () => run() };
    if (accelerator && !taken.has(normAccel(accelerator))) item.accelerator = accelerator;
    return item;
  };
  const appItems = payload.app || {};
  const fromNode = (node) => (node ? toItem(node, onAction) : null);

  const appMenu = {
    label: appName,
    submenu: collapseSeparators([
      fromNode(appItems.about),
      appItems.updates ? fromNode(appItems.updates) : null,
      { type: 'separator' },
      fromNode(appItems.settings),
      { type: 'separator' },
      { label: s.services, role: 'services' },
      { type: 'separator' },
      std(fill(s.hide), 'Command+H', roles.hide),
      std(s.hideOthers, 'Command+Alt+H', roles.hideOthers),
      std(s.showAll, null, roles.unhide),
      { type: 'separator' },
      std(fill(s.quit), 'Command+Q', roles.quit),
    ].filter(Boolean)),
  };

  const windowItems = [
    std(s.minimize, 'Command+M', roles.minimize),
    std(s.zoom, null, roles.zoom),
    std(s.fullScreen, 'Control+Command+F', roles.fullScreen),
    std(s.front, null, roles.front),
    { type: 'separator' },
  ];

  let hasWindow = false;
  const pikadoMenus = (payload.menus || []).map((m) => {
    const menu = {
      label: String(m.label || ''),
      submenu: collapseSeparators((m.submenu || []).map((n) => toItem(n, onAction))),
    };
    if (m.key === 'Window') {
      hasWindow = true;
      menu.role = 'window';
      menu.submenu = collapseSeparators([...windowItems, ...menu.submenu]);
    } else if (m.key === 'Help') {
      menu.role = 'help';
    }
    return menu;
  });

  const template = [appMenu, ...pikadoMenus];
  if (!hasWindow) template.push({ label: s.window, role: 'window', submenu: collapseSeparators(windowItems) });
  if (opts.developer) {
    template.push({
      label: 'Developer',
      submenu: [
        { label: 'Reload', click: () => roles.reload() },
        { label: 'Toggle Developer Tools', click: () => roles.devTools() },
      ],
    });
  }
  return template;
}

/** English fallbacks; the page sends its translations with `setStrings`. */
const DEFAULT_STRINGS = {
  services: 'Services',
  hide: 'Hide {app}',
  hideOthers: 'Hide Others',
  showAll: 'Show All',
  quit: 'Quit {app}',
  window: 'Window',
  minimize: 'Minimize',
  zoom: 'Zoom',
  fullScreen: 'Toggle Full Screen',
  front: 'Bring All to Front',
};

module.exports = {
  toElectronAccelerator, registersAsMenuShortcut, normAccel, buildTemplate, toItem, collapseSeparators, DEFAULT_STRINGS,
};
