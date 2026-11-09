import { app } from '../core/app.js';
import { msg, tr } from '../core/i18n.js';

/**
 * Central command registry. Menus, keyboard shortcuts, panel buttons and the
 * options bar all dispatch through here so behaviour never drifts between
 * entry points.
 *
 * Command shape:
 *   {
 *     id: 'edit.undo',
 *     label: 'Undo',
 *     accel: 'Ctrl+Z',            // display + binding (Ctrl maps to Cmd on macOS)
 *     enabled: () => boolean,     // optional
 *     checked: () => boolean,     // optional, renders a tick in menus
 *     dynamicLabel: () => string, // optional
 *     run: async () => void,
 *   }
 *
 * `label` is English and stays English — `labelOf()` translates it for
 * display. A `dynamicLabel` returns text ready to show, so it translates
 * itself (`tr('Undo {action}', …)`); it often carries data, such as a file
 * name, that must not be translated.
 */

/** @type {Map<string, object>} */
export const commands = new Map();

export function registerCommand(cmd) {
  if (!cmd || !cmd.id) throw new Error('Command needs an id');
  commands.set(cmd.id, cmd);
  return cmd;
}

export function registerCommands(list) {
  for (const c of list) registerCommand(c);
}

export function getCommand(id) {
  return commands.get(id) || null;
}

export function isEnabled(id) {
  const c = commands.get(id);
  if (!c) return false;
  if (!c.enabled) return true;
  try {
    return !!c.enabled();
  } catch {
    return false;
  }
}

export function isChecked(id) {
  const c = commands.get(id);
  if (!c || !c.checked) return false;
  try {
    return !!c.checked();
  } catch {
    return false;
  }
}

/** A command's label as the interface shows it, in the current language. */
export function labelOf(id) {
  const c = commands.get(id);
  if (!c) return id;
  if (c.dynamicLabel) {
    try {
      return c.dynamicLabel();
    } catch {
      return tr(c.label);
    }
  }
  return tr(c.label);
}

let running = false;

export async function runCommand(id, ...args) {
  const c = commands.get(id);
  if (!c) {
    console.warn(`[command] unknown: ${id}`);
    return;
  }
  if (!isEnabled(id)) return;
  if (running && c.reentrant !== true) return;
  running = true;
  try {
    await c.run(...args);
  } catch (err) {
    console.error(`[command:${id}]`, err);
    app.toast(err && err.message ? err.message : String(err), 'error', 5000);
  } finally {
    running = false;
    app.emit('command-done', id);
  }
}

/* ------------------------------------------------------------------ */
/* Accelerator handling                                                */
/* ------------------------------------------------------------------ */

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * Key names as the keyboard prints them. A German keyboard says Strg, Umschalt
 * and Entf, and so do its menus; the bindings themselves never change. Delete
 * carries a context because the command of the same name is a different word
 * in most languages.
 */
const KEY_NAMES = {
  Ctrl: msg('Ctrl'), Shift: msg('Shift'), Alt: msg('Alt'), Esc: msg('Esc'), Enter: msg('Enter'),
  Delete: msg('Delete|key'), Backspace: msg('Backspace'), PageUp: msg('PageUp'), PageDown: msg('PageDown'),
};
const KEY_NAME_RE = new RegExp(`\\b(${Object.keys(KEY_NAMES).join('|')})\\b`, 'g');

/** Human-readable accelerator for menus. */
export function formatAccel(accel) {
  if (!accel) return '';
  if (!IS_MAC) return accel.replace(KEY_NAME_RE, (k) => tr(KEY_NAMES[k]));
  return accel
    .replace(/Ctrl\+/g, '⌘')
    .replace(/Cmd\+/g, '⌘')
    .replace(/Alt\+/g, '⌥')
    .replace(/Shift\+/g, '⇧')
    .replace(/\+/g, '');
}

/** Normalised binding key for a KeyboardEvent, e.g. "ctrl+shift+s". */
export function eventBinding(e) {
  const parts = [];
  const primary = IS_MAC ? e.metaKey : e.ctrlKey;
  const secondary = IS_MAC ? e.ctrlKey : false;
  if (primary) parts.push('ctrl');
  if (secondary) parts.push('meta');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  let k = e.key;
  if (k === ' ') k = 'space';
  else if (k.length === 1) k = k.toLowerCase();
  else k = k.toLowerCase();
  // Use the physical key for letters so Alt-modified layouts still match.
  if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3).toLowerCase();
  else if (/^Digit[0-9]$/.test(e.code)) k = e.code.slice(5);
  parts.push(k);
  return parts.join('+');
}

/** Normalised binding key for an accel string, e.g. "Ctrl+Shift+S". */
export function accelBinding(accel) {
  if (!accel) return null;
  const parts = accel.split('+').map((p) => p.trim()).filter(Boolean);
  const mods = [];
  let key = '';
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'ctrl' || l === 'cmd' || l === 'command') mods.push('ctrl');
    else if (l === 'alt' || l === 'opt' || l === 'option') mods.push('alt');
    else if (l === 'shift') mods.push('shift');
    else key = l;
  }
  const order = ['ctrl', 'meta', 'alt', 'shift'].filter((m) => mods.includes(m));
  if (key === 'space') key = 'space';
  return [...order, key].join('+');
}

/** Build a binding -> commandId map from every registered command. */
export function buildBindingMap() {
  const map = new Map();
  for (const c of commands.values()) {
    for (const accel of [c.accel, ...(c.altAccels || [])]) {
      const b = accelBinding(accel);
      if (b && !map.has(b)) map.set(b, c.id);
    }
  }
  return map;
}
