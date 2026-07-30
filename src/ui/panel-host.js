import { el, clamp } from '../core/util.js';
import { icon } from './icons.js';
import './panels/panels.css';

/**
 * The right-hand panel dock.
 *
 * Panels self-register at module scope with `registerPanel()`; `buildPanelDock()`
 * then renders every registered panel as a stack of collapsible *groups*. Panels
 * that share a `group` become tabs inside one group, exactly like Photoshop's
 * docked panel groups. The divider between two groups resizes them.
 *
 * Open/collapsed state, the active tab of each group and the group heights are
 * persisted in `localStorage` under `pikado.panels`.
 */

const STORAGE_KEY = 'pikado.panels';

/** Vertical order of the known groups; unknown groups are appended. */
const GROUP_ORDER = ['top', 'mid', 'bottom'];
/** Default share of the dock height each group receives. */
const GROUP_WEIGHT = { top: 3.4, mid: 1, bottom: 2.2 };

const HEAD_H = 27;

/** @type {Map<string, object>} panel id -> definition */
export const PANELS = new Map();

let dockRoot = null;
/** @type {Map<string, {root:HTMLElement, body:HTMLElement, tabs:Map<string,HTMLElement>, menuBtn:HTMLElement, panels:object[]}>} */
const groupNodes = new Map();
let renderQueued = false;

/* ------------------------------------------------------------------ */
/* Persisted preferences                                               */
/* ------------------------------------------------------------------ */

const prefs = loadPrefs();

function loadPrefs() {
  const base = { panels: {}, groups: {} };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      base.panels = parsed.panels && typeof parsed.panels === 'object' ? parsed.panels : {};
      base.groups = parsed.groups && typeof parsed.groups === 'object' ? parsed.groups : {};
    }
  } catch {
    /* corrupt or unavailable storage — fall back to defaults */
  }
  return base;
}

const savePrefs = (() => {
  let t = null;
  return () => {
    clearTimeout(t);
    t = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
      } catch {
        /* private mode / quota — preferences are a nicety, never fatal */
      }
    }, 180);
  };
})();

function groupPrefs(gid) {
  let g = prefs.groups[gid];
  if (!g) {
    g = { collapsed: false, active: null, weight: GROUP_WEIGHT[gid] || 1 };
    prefs.groups[gid] = g;
  }
  if (typeof g.weight !== 'number' || !isFinite(g.weight) || g.weight <= 0) g.weight = GROUP_WEIGHT[gid] || 1;
  return g;
}

function isVisible(p) {
  const st = prefs.panels[p.id];
  return st && typeof st.visible === 'boolean' ? st.visible : p.defaultOpen;
}

function setVisible(p, v) {
  if (!prefs.panels[p.id]) prefs.panels[p.id] = {};
  prefs.panels[p.id].visible = !!v;
  savePrefs();
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

/**
 * Register a panel. Call at module scope — `src/main.js` imports panel modules
 * purely for this side effect.
 *
 * @param {object} def
 * @param {string} def.id                 unique id ('layers', 'color', …)
 * @param {string} def.title              tab caption
 * @param {string} def.icon               key in ui/icons.js
 * @param {string} def.group              'top' | 'mid' | 'bottom' (or your own)
 * @param {number} def.order              position inside the group
 * @param {(body:HTMLElement)=>({refresh?:Function, destroy?:Function, menu?:Function}|void)} def.build
 *        called once, the first time the panel becomes visible
 * @param {boolean} [def.defaultOpen=true]
 * @param {number} [def.minHeight=90]     minimum body height in px
 * @param {Function|Array} [def.menu]     optional panel fly-out menu
 * @returns {object} the stored definition
 */
export function registerPanel(def) {
  if (!def || !def.id) throw new Error('registerPanel: a panel needs an id');
  const p = {
    id: def.id,
    title: def.title || def.id,
    icon: def.icon || 'properties',
    group: def.group || 'bottom',
    order: def.order == null ? 100 : def.order,
    build: def.build,
    defaultOpen: def.defaultOpen !== false,
    minHeight: def.minHeight || 90,
    menu: def.menu || null,
    /* runtime */
    node: null,
    api: null,
    built: false,
  };
  PANELS.set(p.id, p);
  if (dockRoot) queueRender();
  return p;
}

/* ------------------------------------------------------------------ */
/* Public control surface                                              */
/* ------------------------------------------------------------------ */

/** True when the panel is docked, expanded and the front tab of its group. */
export function isPanelOpen(id) {
  const p = PANELS.get(id);
  if (!p || !isVisible(p)) return false;
  const g = groupPrefs(p.group);
  return !g.collapsed && g.active === id;
}

/**
 * True when the panel is in the dock at all — including as a background tab.
 * This, not `isPanelOpen`, is what the Window menu ticks: a docked panel sitting
 * behind a sibling tab is still open as far as the user is concerned.
 */
export function isPanelVisible(id) {
  const p = PANELS.get(id);
  return !!p && isVisible(p);
}

/** Show the panel, expand its group and bring it to the front of the tabs. */
export function openPanel(id) {
  const p = PANELS.get(id);
  if (!p) return;
  const wasHidden = !isVisible(p);
  setVisible(p, true);
  const g = groupPrefs(p.group);
  g.collapsed = false;
  g.active = id;
  savePrefs();
  if (wasHidden) render();
  else sync();
}

/** Remove the panel from the dock. */
export function closePanel(id) {
  const p = PANELS.get(id);
  if (!p || !isVisible(p)) return;
  setVisible(p, false);
  const g = groupPrefs(p.group);
  if (g.active === id) g.active = null;
  savePrefs();
  render();
}

export function togglePanel(id) {
  if (isPanelOpen(id)) closePanel(id);
  else openPanel(id);
}

/** Ask a built panel to re-read the document. No-op when it is hidden. */
export function refreshPanel(id) {
  const p = PANELS.get(id);
  if (!p || !p.built || !p.api || typeof p.api.refresh !== 'function') return;
  if (!isPanelOpen(id)) return;
  try {
    p.api.refresh();
  } catch (err) {
    console.error(`[panel:${id}] refresh`, err);
  }
}

/* ------------------------------------------------------------------ */
/* Dock construction                                                   */
/* ------------------------------------------------------------------ */

/**
 * Mount the dock into `rootEl` (the `#panels` aside).
 * @param {HTMLElement} rootEl
 */
export function buildPanelDock(rootEl) {
  dockRoot = rootEl;
  rootEl.classList.add('pk-dock');
  render();
  return {
    refresh: () => {
      for (const id of PANELS.keys()) refreshPanel(id);
    },
  };
}

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

/** Groups in dock order, each with its panels in `order`. */
function groupList() {
  const byGroup = new Map();
  for (const p of PANELS.values()) {
    if (!byGroup.has(p.group)) byGroup.set(p.group, []);
    byGroup.get(p.group).push(p);
  }
  const ids = [...byGroup.keys()].sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a);
    const ib = GROUP_ORDER.indexOf(b);
    return (ia < 0 ? 500 : ia) - (ib < 0 ? 500 : ib) || String(a).localeCompare(String(b));
  });
  return ids.map((id) => ({
    id,
    panels: byGroup.get(id).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)),
  }));
}

function render() {
  if (!dockRoot) return;
  groupNodes.clear();
  const frag = document.createDocumentFragment();

  const groups = groupList()
    .map((g) => ({ id: g.id, panels: g.panels.filter(isVisible) }))
    .filter((g) => g.panels.length > 0);

  const order = groups.map((g) => g.id);

  groups.forEach((g, gi) => {
    frag.appendChild(buildGroup(g));
    if (gi < groups.length - 1) frag.appendChild(buildDivider(gi, order));
  });

  dockRoot.replaceChildren(frag);
  sync();
}

function buildGroup(g) {
  const gp = groupPrefs(g.id);
  if (!g.panels.some((p) => p.id === gp.active)) gp.active = g.panels[0].id;

  const tabs = new Map();
  const tabStrip = el('div.pk-ptabs' + (g.panels.length === 1 ? '.solo' : ''));
  for (const p of g.panels) {
    const tab = el('button.pk-ptab', {
      type: 'button',
      title: p.title,
      onclick: () => {
        const pr = groupPrefs(g.id);
        if (pr.active === p.id && !pr.collapsed) return;
        pr.active = p.id;
        pr.collapsed = false;
        savePrefs();
        sync();
      },
    },
      el('span.pk-ptab-ico', { html: icon(p.icon, { size: 13 }) }),
      el('span.pk-ptab-label', { text: p.title })
    );
    tabs.set(p.id, tab);
    tabStrip.appendChild(tab);
  }

  const menuBtn = el('button.pk-pgroup-menu.pk-icon-btn', {
    type: 'button',
    title: 'Panel menu',
    html: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 5h10M3 8h10M3 11h10"/></svg>',
    onclick: (e) => {
      e.stopPropagation();
      const p = PANELS.get(groupPrefs(g.id).active);
      const items = panelMenuItems(p);
      if (!items.length) return;
      const r = e.currentTarget.getBoundingClientRect();
      popupMenu(items, r.right, r.bottom + 2, { align: 'right' });
    },
  });

  const chevron = el('button.pk-pgroup-collapse.pk-icon-btn', {
    type: 'button',
    title: 'Collapse',
    html: icon('chevron', { size: 14 }),
    onclick: (e) => {
      e.stopPropagation();
      const pr = groupPrefs(g.id);
      pr.collapsed = !pr.collapsed;
      savePrefs();
      sync();
    },
  });

  const head = el('div.pk-pgroup-head', {
    ondblclick: (e) => {
      if (e.target.closest('button')) return;
      const pr = groupPrefs(g.id);
      pr.collapsed = !pr.collapsed;
      savePrefs();
      sync();
    },
  }, tabStrip, el('div.pk-pgroup-tools', {}, menuBtn, chevron));

  const body = el('div.pk-pgroup-body');
  for (const p of g.panels) {
    if (!p.node) p.node = el('div.pk-panel', { dataset: { panel: p.id } });
    body.appendChild(p.node);
  }

  const root = el('div.pk-pgroup', { dataset: { group: g.id } }, head, body);
  groupNodes.set(g.id, { root, head, body, tabs, menuBtn, chevron, panels: g.panels });
  return root;
}

/** Apply collapsed/active/height state without rebuilding the DOM. */
function sync() {
  for (const [gid, n] of groupNodes) {
    const gp = groupPrefs(gid);
    const collapsed = !!gp.collapsed;
    n.root.classList.toggle('collapsed', collapsed);
    n.root.style.flex = collapsed ? '0 0 auto' : `${gp.weight} 1 0px`;

    const active = PANELS.get(gp.active);
    n.root.style.minHeight = collapsed ? '' : `${HEAD_H + (active ? active.minHeight : 90)}px`;

    for (const p of n.panels) {
      const on = p.id === gp.active;
      const tab = n.tabs.get(p.id);
      if (tab) tab.classList.toggle('active', on);
      p.node.hidden = !on;
      if (on && !collapsed) {
        ensureBuilt(p);
        refreshPanel(p.id);
      }
    }
    n.menuBtn.hidden = !active || !panelMenuItems(active).length;
    n.chevron.title = collapsed ? 'Expand' : 'Collapse';
  }
  savePrefs();
}

function ensureBuilt(p) {
  if (p.built) return;
  p.built = true;
  try {
    p.api = (typeof p.build === 'function' ? p.build(p.node) : null) || null;
  } catch (err) {
    console.error(`[panel:${p.id}] build`, err);
    p.api = null;
    p.node.appendChild(el('div.pk-panel-error', { text: `${p.title} could not be built.` }));
  }
}

/** Menu items come from `def.menu` or from what `build()` returned. */
function panelMenuItems(p) {
  if (!p) return [];
  const src = (p.api && p.api.menu) || p.menu;
  if (!src) return [];
  try {
    const items = typeof src === 'function' ? src() : src;
    return Array.isArray(items) ? items.filter(Boolean) : [];
  } catch (err) {
    console.error(`[panel:${p.id}] menu`, err);
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Group resizing                                                      */
/* ------------------------------------------------------------------ */

function buildDivider(index, order) {
  const d = el('div.pk-pdivider');
  d.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const above = nearestExpanded(order, index, -1);
    const below = nearestExpanded(order, index + 1, 1);
    if (!above || !below) return;

    const na = groupNodes.get(above).root;
    const nb = groupNodes.get(below).root;
    const h0a = na.getBoundingClientRect().height;
    const h0b = nb.getBoundingClientRect().height;
    const wTotal = groupPrefs(above).weight + groupPrefs(below).weight;
    const minA = minHeightOf(above);
    const minB = minHeightOf(below);
    if (h0a + h0b < minA + minB) return;

    const startY = e.clientY;
    d.classList.add('active');
    d.setPointerCapture(e.pointerId);

    const move = (ev) => {
      const ha = clamp(h0a + (ev.clientY - startY), minA, h0a + h0b - minB);
      const hb = h0a + h0b - ha;
      const wa = Math.max(0.05, (wTotal * ha) / (ha + hb));
      groupPrefs(above).weight = wa;
      groupPrefs(below).weight = Math.max(0.05, wTotal - wa);
      na.style.flex = `${groupPrefs(above).weight} 1 0px`;
      nb.style.flex = `${groupPrefs(below).weight} 1 0px`;
    };
    const up = () => {
      d.classList.remove('active');
      d.removeEventListener('pointermove', move);
      d.removeEventListener('pointerup', up);
      d.removeEventListener('pointercancel', up);
      savePrefs();
    };
    d.addEventListener('pointermove', move);
    d.addEventListener('pointerup', up);
    d.addEventListener('pointercancel', up);
    e.preventDefault();
  });
  return d;
}

function nearestExpanded(order, from, dir) {
  for (let i = from; i >= 0 && i < order.length; i += dir) {
    if (!groupPrefs(order[i]).collapsed) return order[i];
  }
  return null;
}

function minHeightOf(gid) {
  const gp = groupPrefs(gid);
  const p = PANELS.get(gp.active);
  return HEAD_H + (p ? p.minHeight : 90);
}

/* ------------------------------------------------------------------ */
/* Popup menus (shared by every panel)                                 */
/* ------------------------------------------------------------------ */

let openMenu = null;

/**
 * Show a floating menu at viewport coordinates.
 * Items: `{label, run, checked, disabled, accel}`, `{separator:true}`,
 * `{header:'Text'}`.
 *
 * @param {Array<object>} items
 * @param {number} x viewport px
 * @param {number} y viewport px
 * @param {{align?:'left'|'right', minWidth?:number}} [opts]
 * @returns {HTMLElement|null}
 */
export function popupMenu(items, x, y, opts = {}) {
  closeMenu();
  const list = (items || []).filter(Boolean);
  if (!list.length) return null;

  const menu = el('div.pk-menu', { style: { left: '0px', top: '0px', minWidth: `${opts.minWidth || 170}px` } });
  for (const it of list) {
    if (it.separator) {
      menu.appendChild(el('div.pk-menu-sep'));
      continue;
    }
    if (it.header) {
      menu.appendChild(el('div.pk-menu-header', { text: it.header }));
      continue;
    }
    const btn = el('button.pk-menu-item', {
      type: 'button',
      disabled: !!it.disabled,
      onclick: () => {
        closeMenu();
        if (typeof it.run === 'function') {
          try {
            it.run();
          } catch (err) {
            console.error('[menu]', err);
          }
        }
      },
    },
      el('span.pk-menu-check', { html: it.checked ? icon('check', { size: 12 }) : '' }),
      el('span.pk-menu-label', { text: it.label }),
      it.accel ? el('span.pk-menu-accel', { text: it.accel }) : null
    );
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  let left = opts.align === 'right' ? x - r.width : x;
  let top = y;
  if (left + r.width > window.innerWidth - 4) left = window.innerWidth - r.width - 4;
  if (top + r.height > window.innerHeight - 4) top = Math.max(4, y - r.height);
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${Math.max(4, top)}px`;

  const away = (ev) => {
    if (!menu.contains(ev.target)) closeMenu();
  };
  const key = (ev) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      closeMenu();
    }
  };
  openMenu = {
    node: menu,
    dispose() {
      window.removeEventListener('mousedown', away, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', closeMenu);
      menu.remove();
    },
  };
  setTimeout(() => {
    window.addEventListener('mousedown', away, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', closeMenu);
  }, 0);
  return menu;
}

export function closeMenu() {
  if (!openMenu) return;
  const m = openMenu;
  openMenu = null;
  m.dispose();
}
