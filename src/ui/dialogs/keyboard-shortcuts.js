import './dialogs.css';
import { app } from '../../core/app.js';
import { el, debounce } from '../../core/util.js';
import { Dialog } from '../dialog.js';
import {
  commands, getCommand, labelOf, formatAccel, accelBinding, eventBinding, runCommand, isEnabled, IS_MAC,
} from '../../commands/registry.js';

/**
 * Edit > Keyboard Shortcuts.
 *
 * Overrides live in `localStorage["pikado.shortcuts"]` as `{commandId: accel}`.
 * `applyStoredShortcuts()` writes them onto the registered commands *before*
 * `installShortcuts()` builds its binding map, and the capture-phase listener
 * below makes changes made during the session take effect immediately.
 */

const STORAGE_KEY = 'pikado.shortcuts';

const GROUPS = [
  ['file.', 'File'],
  ['edit.', 'Edit'],
  ['image.', 'Image'],
  ['adjust.', 'Adjustments'],
  ['adjlayer.', 'Adjustment Layers'],
  ['layer.', 'Layer'],
  ['type.', 'Type'],
  ['select.', 'Select'],
  ['filter.', 'Filter'],
  ['view.', 'View'],
  ['window.', 'Window'],
  ['help.', 'Help'],
  ['tool.', 'Tools'],
];

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

let overrides = load();
let bindingMap = new Map();
let recording = false;

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    /* Quota or private mode — the change still applies for this session. */
  }
}

function rebuildBindingMap() {
  bindingMap = new Map();
  for (const [id, accel] of Object.entries(overrides)) {
    const b = accelBinding(accel);
    if (b) bindingMap.set(b, id);
  }
}

/**
 * Push every stored override onto its command. Call once at start-up, before
 * the global shortcut handler snapshots the accelerators.
 */
export function applyStoredShortcuts() {
  for (const [id, accel] of Object.entries(overrides)) {
    const cmd = getCommand(id);
    if (!cmd) continue;
    if (cmd.defaultAccel === undefined) cmd.defaultAccel = cmd.accel || '';
    cmd.accel = accel;
  }
  rebuildBindingMap();
  app.emit('shortcuts-change');
}

/** The accelerator a command shipped with. */
export function defaultAccelOf(cmd) {
  return cmd.defaultAccel === undefined ? cmd.accel || '' : cmd.defaultAccel;
}

function setOverride(id, accel) {
  const cmd = getCommand(id);
  if (!cmd) return;
  if (cmd.defaultAccel === undefined) cmd.defaultAccel = cmd.accel || '';
  if (accel == null) {
    delete overrides[id];
    cmd.accel = cmd.defaultAccel;
  } else {
    overrides[id] = accel;
    cmd.accel = accel;
  }
  persist();
  rebuildBindingMap();
  app.emit('shortcuts-change');
}

/* ------------------------------------------------------------------ */
/* Runtime dispatch for overridden bindings                            */
/* ------------------------------------------------------------------ */

function isTextEntry(node) {
  if (!node) return false;
  return node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable;
}

window.addEventListener('keydown', (e) => {
  if (recording || !bindingMap.size) return;
  if (isTextEntry(e.target)) return;
  if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return;
  const id = bindingMap.get(eventBinding(e));
  if (!id || !isEnabled(id)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  runCommand(id);
}, true);

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

function groupOf(id) {
  for (const [prefix, name] of GROUPS) if (id.startsWith(prefix)) return name;
  return 'Other';
}

function accelFromEvent(e) {
  const parts = [];
  if (IS_MAC ? e.metaKey : e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (k === ' ') k = 'Space';
  else if (k.length === 1) k = k.toUpperCase();
  parts.push(k);
  return parts.join('+');
}

/** Edit > Keyboard Shortcuts… */
export async function showKeyboardShortcutsDialog() {
  const dlg = new Dialog({ title: 'Keyboard Shortcuts', width: 660, className: 'pkd-keys' });

  const search = el('input.pk-input', { type: 'text', placeholder: 'Search commands or keys…' });
  const count = el('span.pk-hint');
  const scroll = el('div.pkd-keys-scroll');
  const table = el('table.pkd-keys-table');
  scroll.appendChild(table);

  let query = '';

  const rows = () => {
    const all = [...commands.values()];
    const q = query.trim().toLowerCase();
    const matched = all.filter((c) => {
      if (!q) return true;
      const accel = c.accel || '';
      return c.id.toLowerCase().includes(q)
        || String(labelOf(c.id)).toLowerCase().includes(q)
        || accel.toLowerCase().includes(q)
        || formatAccel(accel).toLowerCase().includes(q);
    });
    const grouped = new Map();
    for (const c of matched) {
      const g = groupOf(c.id);
      if (!grouped.has(g)) grouped.set(g, []);
      grouped.get(g).push(c);
    }
    for (const list of grouped.values()) list.sort((a, b) => String(labelOf(a.id)).localeCompare(String(labelOf(b.id))));
    return { grouped, total: matched.length };
  };

  function render() {
    const { grouped, total } = rows();
    const body = el('tbody');
    for (const [name, list] of grouped) {
      body.appendChild(el('tr.pkd-keys-group', {}, el('td', { colspan: 3, text: name })));
      for (const cmd of list) body.appendChild(renderRow(cmd));
    }
    table.replaceChildren(
      el('thead', {}, el('tr', {},
        el('th', { text: 'Command' }),
        el('th', { text: 'Shortcut', style: { width: '140px' } }),
        el('th', { text: '', style: { width: '60px' } })
      )),
      body
    );
    count.textContent = `${total} command${total === 1 ? '' : 's'}`;
  }

  function renderRow(cmd) {
    const isCustom = overrides[cmd.id] !== undefined;
    const btn = el('button.pkd-key-btn' + (isCustom ? '.custom' : ''), {
      type: 'button',
      text: cmd.accel ? formatAccel(cmd.accel) : '—',
      title: cmd.accel || 'No shortcut assigned',
    });
    const clearBtn = el('button.pk-btn.subtle.pkd-key-clear', {
      type: 'button', text: 'Reset',
      style: { padding: '2px 8px', height: 'auto' },
      onclick: () => { setOverride(cmd.id, null); render(); },
    });
    if (!isCustom) clearBtn.style.visibility = 'hidden';

    btn.addEventListener('click', () => {
      if (recording) return;
      recording = true;
      btn.classList.add('recording');
      btn.textContent = 'Press keys…';
      const onKey = (e) => {
        if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return;
        e.preventDefault();
        e.stopImmediatePropagation();
        window.removeEventListener('keydown', onKey, true);
        recording = false;
        if (e.key === 'Escape') { render(); return; }
        if (e.key === 'Backspace' || e.key === 'Delete') { setOverride(cmd.id, ''); render(); return; }
        const accel = accelFromEvent(e);
        const binding = accelBinding(accel);
        const clash = [...commands.values()].find((c) => c.id !== cmd.id && accelBinding(c.accel) === binding);
        setOverride(cmd.id, accel);
        if (clash) app.toast(`${formatAccel(accel)} was also used by "${labelOf(clash.id)}".`, 'warn', 4000);
        render();
      };
      window.addEventListener('keydown', onKey, true);
    });

    return el('tr', {},
      el('td', {}, el('div', { text: String(labelOf(cmd.id)) }), el('div.pk-hint', { text: cmd.id })),
      el('td', {}, btn),
      el('td', {}, clearBtn)
    );
  }

  search.addEventListener('input', debounce(() => { query = search.value; render(); }, 120));

  dlg.setBody(
    el('div', {},
      el('div.pkd-keys-search', {}, search, count),
      scroll,
      el('div.pkd-note', { style: { marginTop: '8px' }, text: 'Click a shortcut to record a new one. Press Backspace to remove it, Escape to cancel.' })
    )
  );

  dlg.setButtons([
    {
      label: 'Reset All', subtle: true,
      onClick: () => {
        for (const id of Object.keys(overrides)) setOverride(id, null);
        overrides = {};
        persist();
        rebuildBindingMap();
        render();
        return false;
      },
    },
    { label: 'Done', value: true, primary: true },
  ]);

  render();
  const res = await dlg.open();
  recording = false;
  return res;
}
