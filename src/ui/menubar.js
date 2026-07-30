import { el } from '../core/util.js';
import { app } from '../core/app.js';
import { icon } from './icons.js';
import {
  getCommand, isChecked, isEnabled, labelOf, formatAccel, runCommand,
} from '../commands/registry.js';
import { FILTER_MENUS, filtersByMenu } from '../filters/registry.js';
import { listAdjustments } from '../adjustments/registry.js';
import { applyFilterCommand, applyAdjustmentCommand } from '../filters/run.js';
import { addAdjustmentLayer } from '../layers/ops.js';
import { toolGroups } from '../tools/base.js';
import './menubar.css';
import { brandLock, BRAND, installFavicon } from './brand.js';

/**
 * The application menu bar.
 *
 * The tree itself lives in `src/commands/definitions.js` (`MENU_TREE`); this
 * module only knows how to render it. Entries are command-id strings, `'---'`
 * separators, nested `{label, items}` groups, or `{label, dynamic}` groups whose
 * contents are enumerated from a registry at open time.
 */

/** @type {any[]} */
let MENU_TREE = [];

const bar = {
  root: null,
  menus: null,
  title: null,
  buttons: [],
  openIndex: -1,
  /** @type {HTMLElement[]} stack of open popups, index 0 = top level */
  popups: [],
};

let handlersInstalled = false;
const warnedMissing = new Set();

/**
 * Build the menu bar into `rootEl`.
 * @param {HTMLElement} rootEl
 */
export function buildMenubar(rootEl) {
  if (!rootEl) return;
  bar.root = rootEl;
  rootEl.replaceChildren();

  rootEl.appendChild(
    el('div.pk-brand', { title: `${BRAND.name} — ${BRAND.tagline}`, html: brandLock({ size: 21, wordSize: 15 }) })
  );

  bar.menus = el('nav.pk-menus', { role: 'menubar' });
  rootEl.appendChild(bar.menus);
  rootEl.appendChild(el('div.pk-spacer'));

  bar.title = el('div.pk-doc-title');
  rootEl.appendChild(bar.title);

  loadTree();
  syncTitle();

  app.on('ready', loadTree);
  for (const ev of ['docs-change', 'active-doc', 'doc-change', 'history-change']) app.on(ev, syncTitle);

  installFavicon();
  installGlobalHandlers();
}

/* ------------------------------------------------------------------ */
/* Tree loading                                                        */
/* ------------------------------------------------------------------ */

function loadTree() {
  import('../commands/definitions.js')
    .then((mod) => {
      const tree = mod && (mod.MENU_TREE || mod.default);
      MENU_TREE = Array.isArray(tree) ? tree : [];
      if (!Array.isArray(tree)) console.warn('[menubar] definitions.js exports no MENU_TREE');
      renderTopLevel();
    })
    .catch((err) => {
      console.warn('[menubar] menu definitions unavailable:', err && err.message);
      MENU_TREE = [];
      renderTopLevel();
    });
}

function renderTopLevel() {
  closeAll();
  bar.buttons = [];
  bar.menus.replaceChildren();
  MENU_TREE.forEach((entry, i) => {
    if (!entry || !entry.label) return;
    const btn = el('button.pk-menu-btn', {
      type: 'button',
      text: entry.label,
      'aria-haspopup': 'true',
      onclick: () => (bar.openIndex === i ? closeAll() : openTop(i)),
      onmouseenter: () => {
        if (bar.openIndex >= 0 && bar.openIndex !== i) openTop(i);
      },
    });
    bar.buttons[i] = btn;
    bar.menus.appendChild(btn);
  });
}

/* ------------------------------------------------------------------ */
/* Document title                                                      */
/* ------------------------------------------------------------------ */

function syncTitle() {
  if (!bar.title) return;
  const doc = app.activeDoc;
  if (!doc) {
    bar.title.replaceChildren(el('span.pk-doc-name.empty', { text: 'No document' }));
    return;
  }
  // NB: replaceChildren() is the native DOM API and stringifies null to the
  // text "null" — unlike el(), it does not skip empty children. Filter first.
  bar.title.replaceChildren(...[
    el('span.pk-doc-name', { text: doc.name }),
    el('span.pk-doc-meta', { text: `${doc.width} × ${doc.height}` }),
    doc.dirty ? el('span.pk-doc-dirty', { text: '●', title: 'Unsaved changes' }) : null,
  ].filter(Boolean));
}

/* ------------------------------------------------------------------ */
/* Opening / closing                                                   */
/* ------------------------------------------------------------------ */

function installGlobalHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;

  document.addEventListener('pointerdown', (e) => {
    if (bar.openIndex < 0) return;
    if (bar.root && bar.root.contains(e.target)) return;
    if (bar.popups.some((p) => p.contains(e.target))) return;
    closeAll();
  }, true);

  window.addEventListener('keydown', (e) => {
    if (bar.openIndex < 0) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (bar.popups.length > 1) {
        bar.popups.pop().remove();
      } else {
        closeAll();
      }
    }
  }, true);

  window.addEventListener('blur', () => closeAll());
  window.addEventListener('resize', () => closeAll());
}

function openTop(i) {
  closeAll();
  const entry = MENU_TREE[i];
  const btn = bar.buttons[i];
  if (!entry || !btn) return;
  bar.openIndex = i;
  btn.classList.add('open');
  const r = btn.getBoundingClientRect();
  openPopup(normalizeList(entry.items || []), r.left, r.bottom + 1, 0);
}

function closeAll() {
  while (bar.popups.length) bar.popups.pop().remove();
  if (bar.openIndex >= 0 && bar.buttons[bar.openIndex]) bar.buttons[bar.openIndex].classList.remove('open');
  bar.openIndex = -1;
}

function openPopup(items, x, y, depth) {
  while (bar.popups.length > depth) bar.popups.pop().remove();
  const menu = el('div.pk-menu', { role: 'menu' });
  if (!items.length) menu.appendChild(el('div.pk-menu-item.disabled', {}, el('span.pk-menu-tick'), el('span.pk-menu-label', { text: '(empty)' })));
  for (const it of items) menu.appendChild(buildItem(it, depth));
  menu.style.left = '-9999px';
  menu.style.top = '0px';
  document.body.appendChild(menu);

  const r = menu.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + r.width > window.innerWidth - 4) left = Math.max(4, window.innerWidth - r.width - 4);
  if (top + r.height > window.innerHeight - 4) top = Math.max(4, window.innerHeight - r.height - 4);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  bar.popups.push(menu);
  return menu;
}

function openSubmenu(item, itemEl, depth) {
  const children = typeof item.children === 'function' ? item.children() : item.children;
  const r = itemEl.getBoundingClientRect();
  const menu = openPopup(children || [], r.right - 3, r.top - 5, depth + 1);
  const mr = menu.getBoundingClientRect();
  // Flip to the left of the parent when there is no room on the right.
  if (r.right - 3 + mr.width > window.innerWidth - 4) {
    menu.style.left = `${Math.round(Math.max(4, r.left - mr.width + 3))}px`;
  }
  return menu;
}

function buildItem(it, depth) {
  if (it.type === 'sep') return el('div.pk-menu-sep');

  const enabled = it.enabled !== false;
  const hasChildren = !!it.children;
  const node = el(
    `div.pk-menu-item${enabled ? '' : '.disabled'}${hasChildren ? '.has-sub' : ''}`,
    { role: 'menuitem' },
    el('span.pk-menu-tick', { html: it.checked ? icon('check', { size: 11 }) : '' }),
    el('span.pk-menu-label', { text: it.label }),
    el('span.pk-menu-accel', { text: it.accel || '' }),
    el('span.pk-menu-arrow', { html: hasChildren ? icon('chevron-right', { size: 11 }) : '' })
  );

  node.addEventListener('mouseenter', () => {
    while (bar.popups.length > depth + 1) bar.popups.pop().remove();
    const parent = node.parentElement;
    if (parent) for (const sib of parent.children) sib.classList.remove('active');
    node.classList.add('active');
    if (hasChildren && enabled) openSubmenu(it, node, depth);
  });

  if (!enabled) {
    node.addEventListener('click', (e) => e.stopPropagation());
    return node;
  }

  node.addEventListener('click', (e) => {
    e.stopPropagation();
    if (hasChildren) {
      openSubmenu(it, node, depth);
      return;
    }
    closeAll();
    if (it.run) {
      try {
        const r = it.run();
        if (r && typeof r.catch === 'function') r.catch((err) => console.error('[menubar]', err));
      } catch (err) {
        console.error('[menubar]', err);
      }
    }
  });

  return node;
}

/* ------------------------------------------------------------------ */
/* Entry normalisation                                                 */
/* ------------------------------------------------------------------ */

function normalizeList(list) {
  const out = [];
  for (const entry of list || []) {
    if (entry === '---' || entry === '-' || entry == null) {
      out.push({ type: 'sep' });
      continue;
    }
    if (typeof entry === 'string') {
      const item = commandItem(entry);
      if (item) out.push(item);
      continue;
    }
    if (typeof entry !== 'object') continue;

    if (entry.dynamic) {
      const items = dynamicItems(entry.dynamic);
      if (entry.label) out.push({ label: entry.label, children: items, enabled: items.length > 0 });
      else out.push(...items);
      continue;
    }
    if (Array.isArray(entry.items)) {
      const children = normalizeList(entry.items);
      out.push({ label: entry.label || '', children, enabled: children.length > 0 });
      continue;
    }
    if (entry.id) {
      const item = commandItem(entry.id);
      if (item) out.push(item);
    }
  }
  return collapseSeparators(out);
}

function collapseSeparators(items) {
  const out = [];
  for (const it of items) {
    if (it.type === 'sep') {
      if (!out.length || out[out.length - 1].type === 'sep') continue;
    }
    out.push(it);
  }
  while (out.length && out[out.length - 1].type === 'sep') out.pop();
  return out;
}

function commandItem(id) {
  const cmd = getCommand(id);
  if (!cmd) {
    if (!warnedMissing.has(id)) {
      warnedMissing.add(id);
      console.warn(`[menubar] no command registered for "${id}"`);
    }
    return null;
  }
  return {
    label: labelOf(id),
    accel: formatAccel(cmd.accel),
    checked: isChecked(id),
    enabled: isEnabled(id),
    run: () => runCommand(id),
  };
}

/* ------------------------------------------------------------------ */
/* Dynamic sections                                                    */
/* ------------------------------------------------------------------ */

function dynamicItems(kind) {
  switch (kind) {
    case 'filters': return filterItems();
    case 'adjustments': return adjustmentItems();
    case 'adjustment-layers': return adjustmentLayerItems();
    case 'documents': return documentItems();
    case 'tools': return toolItems();
    default:
      console.warn(`[menubar] unknown dynamic menu "${kind}"`);
      return [];
  }
}

function filterItems() {
  const byMenu = filtersByMenu();
  const hasDoc = !!app.activeDoc;
  const out = [];
  const seen = new Set();
  const push = (name) => {
    const list = byMenu.get(name) || [];
    if (!list.length) return;
    seen.add(name);
    out.push({
      label: name,
      children: list.map((f) => ({
        label: f.name,
        enabled: hasDoc,
        run: () => applyFilterCommand(f.id),
      })),
    });
  };
  for (const name of FILTER_MENUS) push(name);
  for (const name of byMenu.keys()) if (!seen.has(name)) push(name);
  return out;
}

function groupedAdjustments() {
  const groups = new Map();
  for (const a of listAdjustments()) {
    const key = a.group || 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  return groups;
}

function adjustmentItems() {
  const hasDoc = !!app.activeDoc;
  const out = [];
  for (const [, list] of groupedAdjustments()) {
    if (out.length) out.push({ type: 'sep' });
    for (const a of list) {
      out.push({ label: a.name, enabled: hasDoc, run: () => applyAdjustmentCommand(a.id) });
    }
  }
  return collapseSeparators(out);
}

function adjustmentLayerItems() {
  const hasDoc = !!app.activeDoc;
  const out = [];
  for (const [, list] of groupedAdjustments()) {
    const layerable = list.filter((a) => a.layerable);
    if (!layerable.length) continue;
    if (out.length) out.push({ type: 'sep' });
    for (const a of layerable) {
      out.push({
        label: a.name.replace(/\.\.\.$/, ''),
        enabled: hasDoc,
        run: () => {
          if (app.activeDoc) addAdjustmentLayer(app.activeDoc, a.id);
        },
      });
    }
  }
  return collapseSeparators(out);
}

function documentItems() {
  return app.docs.map((doc) => ({
    label: doc.name + (doc.dirty ? ' *' : ''),
    checked: doc === app.activeDoc,
    run: () => app.setActiveDoc(doc),
  }));
}

function toolItems() {
  const out = [];
  for (const group of toolGroups) {
    if (out.length) out.push({ type: 'sep' });
    for (const t of group.tools) {
      out.push({
        label: t.name,
        accel: t.shortcut || '',
        checked: app.tool === t,
        run: () => app.setTool(t.id),
      });
    }
  }
  return collapseSeparators(out);
}
