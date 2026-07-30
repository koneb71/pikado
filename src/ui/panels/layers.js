import './panels.css';
import './smart.css';
import { registerPanel, popupMenu } from '../panel-host.js';
import { app } from '../../core/app.js';
import { el, uid, rafThrottle, clamp } from '../../core/util.js';
import { icon } from '../icons.js';
import { BLEND_MODES } from '../../core/blend.js';
import { LayerType, createGroupLayer } from '../../core/layer.js';
import { hasStyles } from '../../effects/styles.js';
import { listAdjustments } from '../../adjustments/registry.js';
import { toHex } from '../../core/color.js';
import { paramDialog } from '../dialog.js';
import * as ops from '../../layers/ops.js';
import {
  isSmartLayer, getSmartFilters, toggleSmartFilter, setSmartFiltersEnabled,
  removeSmartFilter, reorderSmartFilters, editSmartFilter, editSmartContents,
} from '../../core/smart.js';

/**
 * The Layers panel — blend/opacity/lock header, a filter row, the layer tree
 * with masks, effects, clipping and groups, drag-and-drop reordering and the
 * Photoshop bottom button strip.
 */

const THUMB = 34;

const BLEND_GROUP_LABELS = ['Normal', 'Darken', 'Lighten', 'Contrast', 'Comparative', 'Component'];

const EFFECT_NAMES = {
  dropShadow: 'Drop Shadow',
  innerShadow: 'Inner Shadow',
  outerGlow: 'Outer Glow',
  innerGlow: 'Inner Glow',
  bevelEmboss: 'Bevel & Emboss',
  satin: 'Satin',
  colorOverlay: 'Color Overlay',
  gradientOverlay: 'Gradient Overlay',
  patternOverlay: 'Pattern Overlay',
  stroke: 'Stroke',
};

const COLOR_LABELS = [
  { value: 'none', label: 'None', css: 'transparent' },
  { value: 'red', label: 'Red', css: '#b04141' },
  { value: 'orange', label: 'Orange', css: '#b8762f' },
  { value: 'yellow', label: 'Yellow', css: '#b3a52f' },
  { value: 'green', label: 'Green', css: '#4a8f45' },
  { value: 'blue', label: 'Blue', css: '#3f6fa8' },
  { value: 'violet', label: 'Violet', css: '#75509c' },
  { value: 'gray', label: 'Gray', css: '#767676' },
];

const KIND_TYPES = {
  all: null,
  pixel: LayerType.RASTER,
  adjustment: LayerType.ADJUSTMENT,
  type: LayerType.TEXT,
  shape: LayerType.SHAPE,
  smart: LayerType.SMART,
  group: LayerType.GROUP,
};

/* ------------------------------------------------------------------ */

registerPanel({
  id: 'layers',
  title: 'Layers',
  icon: 'copy',
  group: 'top',
  order: 0,
  defaultOpen: true,
  minHeight: 190,
  build: buildLayersPanel,
});

function buildLayersPanel(bodyEl) {
  bodyEl.classList.add('pk-panel-flush');

  /* ---------------- header: filter, blend/opacity, locks --------------- */

  const filterKind = el('select.pk-select.pk-lay-filter-kind', {
    title: 'Filter type',
    onchange: () => {
      syncFilterInputs();
      scheduleRefresh(true);
    },
  });
  for (const o of ['Kind', 'Name', 'Effect', 'Mode', 'Attribute', 'Color']) {
    filterKind.appendChild(el('option', { value: o.toLowerCase(), text: o }));
  }

  const filterValue = el('select.pk-select.pk-lay-filter-text', {
    onchange: () => scheduleRefresh(true),
  });
  const filterText = el('input.pk-input.pk-lay-filter-text', {
    type: 'text',
    placeholder: 'Search…',
    oninput: () => scheduleRefresh(true),
  });
  const filterToggle = el('button.pk-icon-btn.pk-lay-filter-toggle', {
    type: 'button',
    title: 'Turn layer filtering on/off',
    html: icon('search', { size: 14 }),
    onclick: () => {
      filterOn = !filterOn;
      filterToggle.classList.toggle('off', !filterOn);
      scheduleRefresh(true);
    },
  });
  let filterOn = true;

  const filterRow = el('div.pk-lay-hrow', {}, filterKind, filterValue, filterText, filterToggle);

  const blendSel = el('select.pk-select', {
    title: 'Blending mode',
    onchange: () => {
      const doc = app.activeDoc;
      if (!doc) return;
      const list = targetLayers(doc);
      if (!list.length) return;
      for (const l of list) l.blendMode = blendSel.value;
      doc.commit('Blending Mode');
    },
  });
  let blendHasPassThrough = null;

  const opacity = makeAmount('Opacity', (doc, list, v, live) => {
    for (const l of list) l.opacity = v / 100;
    live ? doc.touch('opacity') : doc.commit('Layer Opacity');
  });
  const fill = makeAmount('Fill', (doc, list, v, live) => {
    for (const l of list) l.fillOpacity = v / 100;
    live ? doc.touch('fill') : doc.commit('Fill Opacity');
  });

  const lockBtns = [
    lockButton('transparency', 'grid', 'Lock transparent pixels'),
    lockButton('pixels', 'brush', 'Lock image pixels'),
    lockButton('position', 'move', 'Lock position'),
    lockButton('all', 'lock', 'Lock all'),
  ];

  const blendRow = el('div.pk-lay-hrow', {}, blendSel, opacity.node);
  const lockRow = el('div.pk-lay-hrow', {},
    el('span.pk-lay-hlabel', { text: 'Lock' }),
    el('div.pk-lay-locks', {}, ...lockBtns.map((b) => b.node)),
    el('span.pk-spacer'),
    fill.node
  );

  const head = el('div.pk-lay-head', {}, filterRow, blendRow, lockRow);

  /* ---------------------------- the list ------------------------------ */

  const rowsEl = el('div.pk-lay-rows');
  const dropLine = el('div.pk-lay-dropline', { hidden: true });
  const listEl = el('div.pk-lay-list', {}, rowsEl, dropLine);
  const emptyEl = el('div.pk-panel-empty', { text: 'No document open.' });

  /* --------------------------- bottom strip --------------------------- */

  const foot = el('div.pk-lay-foot', {},
    footBtn('link', 'Link layers', () => withDoc(toggleLink)),
    footBtn('fx', 'Add a layer style', (e) => withDoc((doc) => {
      const l = doc.activeLayer();
      if (!l) return;
      const r = e.currentTarget.getBoundingClientRect();
      fxMenu(doc, l, r.left, r.top);
    })),
    footBtn('mask', 'Add layer mask', (e) => withDoc((doc) => {
      const l = doc.activeLayer();
      if (!l) return;
      if (l.mask) { app.toast('Layer already has a mask.'); return; }
      const kind = e.altKey ? (doc.selection.active ? 'hide-selection' : 'hide-all')
        : (doc.selection.active ? 'reveal-selection' : 'reveal-all');
      ops.addLayerMask(doc, l, kind);
    })),
    footBtn('adjustment', 'Create new fill or adjustment layer', (e) => withDoc((doc) => {
      const r = e.currentTarget.getBoundingClientRect();
      adjustmentMenu(doc, r.left, r.top);
    })),
    footBtn('folder', 'Create a new group', () => withDoc((doc) => {
      const sel = doc.selectedLayers();
      if (sel.length > 1) ops.groupLayers(doc, sel);
      else {
        const g = createGroupLayer(nextGroupName(doc));
        doc.addLayer(g);
        doc.commit('New Group');
      }
    })),
    footBtn('plus', 'Create a new layer', () => withDoc((doc) => ops.addRasterLayer(doc))),
    footBtn('trash', 'Delete layer', () => withDoc((doc) => ops.deleteLayers(doc, doc.selectedLayers())))
  );

  const root = el('div.pk-lay', {}, head, listEl, emptyEl, foot);
  bodyEl.appendChild(root);

  /* ---------------------------- panel state --------------------------- */

  /** @type {Map<string, HTMLElement>} layer id -> row node */
  const rowsById = new Map();
  const fxOpen = new Set();
  let renamingId = null;
  let dragging = false;
  let suppressClick = false;
  let lastThumbPass = 0;
  let lastDocId = null;
  let dragState = null;

  const scheduleRefreshRaf = rafThrottle(() => refresh());
  let forceNext = false;
  function scheduleRefresh(force) {
    if (force) forceNext = true;
    scheduleRefreshRaf();
  }

  /* ------------------------------ helpers ----------------------------- */

  function withDoc(fn) {
    const doc = app.activeDoc;
    if (!doc) return;
    fn(doc);
  }

  function targetLayers(doc) {
    const sel = doc.selectedLayers();
    if (sel.length) return sel;
    const a = doc.activeLayer();
    return a ? [a] : [];
  }

  function footBtn(iconName, title, onClick) {
    return el('button.pk-icon-btn', { type: 'button', title, html: icon(iconName, { size: 15 }), onclick: onClick });
  }

  function lockButton(key, iconName, title) {
    const node = el('button.pk-icon-btn', {
      type: 'button', title, html: icon(iconName, { size: 13 }),
      onclick: () => withDoc((doc) => {
        const list = targetLayers(doc);
        if (!list.length) return;
        const on = !list.every((l) => l.locked[key]);
        for (const l of list) {
          l.locked = { ...l.locked, [key]: on };
          if (key === 'all' && on) l.locked = { all: true, pixels: true, position: true, transparency: true };
          if (key === 'all' && !on) l.locked = { all: false, pixels: false, position: false, transparency: false };
        }
        doc.commit(on ? 'Lock Layer' : 'Unlock Layer');
      }),
    });
    return { key, node };
  }

  /** `Opacity: [num] [range]` pair that drives every selected layer. */
  function makeAmount(label, write) {
    const num = el('input.pk-input.pk-num-mini', { type: 'number', min: 0, max: 100, step: 1, value: 100 });
    const range = el('input.pk-range.pk-range-mini', { type: 'range', min: 0, max: 100, step: 1, value: 100 });
    const push = (v, live) => {
      const doc = app.activeDoc;
      if (!doc) return;
      const list = targetLayers(doc);
      if (!list.length) return;
      write(doc, list, clamp(Math.round(v), 0, 100), live);
    };
    range.addEventListener('input', () => { num.value = range.value; push(Number(range.value), true); });
    range.addEventListener('change', () => push(Number(range.value), false));
    num.addEventListener('input', () => {
      const v = Number(num.value);
      if (Number.isNaN(v)) return;
      range.value = clamp(v, 0, 100);
      push(v, true);
    });
    num.addEventListener('change', () => push(Number(num.value) || 0, false));
    const node = el('div.pk-lay-op', {}, el('span.pk-lay-hlabel', { text: label }), num, range);
    return {
      node,
      set(v) {
        const s = String(Math.round(v * 100));
        if (document.activeElement !== num) num.value = s;
        range.value = s;
      },
      enable(on) { num.disabled = !on; range.disabled = !on; },
    };
  }

  function syncFilterInputs() {
    const kind = filterKind.value;
    const useText = kind === 'name' || kind === 'effect';
    filterText.hidden = !useText;
    filterValue.hidden = useText;
    if (useText) return;
    const opts = filterOptions(kind);
    const prev = filterValue.value;
    filterValue.replaceChildren(...opts.map((o) => el('option', { value: o.value, text: o.label })));
    filterValue.value = opts.some((o) => o.value === prev) ? prev : opts[0].value;
  }

  function filterOptions(kind) {
    if (kind === 'kind') {
      return [
        { value: 'all', label: 'All' }, { value: 'pixel', label: 'Pixel' },
        { value: 'adjustment', label: 'Adjustment' }, { value: 'type', label: 'Type' },
        { value: 'shape', label: 'Shape' }, { value: 'smart', label: 'Smart Object' },
        { value: 'group', label: 'Group' },
      ];
    }
    if (kind === 'mode') return BLEND_MODES.map((m) => ({ value: m.id, label: m.name }));
    if (kind === 'color') return COLOR_LABELS.map((c) => ({ value: c.value, label: c.label }));
    return [
      { value: 'visible', label: 'Visible' }, { value: 'hidden', label: 'Hidden' },
      { value: 'locked', label: 'Locked' }, { value: 'unlocked', label: 'Unlocked' },
      { value: 'masked', label: 'Has mask' }, { value: 'clipped', label: 'Clipped' },
      { value: 'styled', label: 'Has effects' }, { value: 'linked', label: 'Linked' },
    ];
  }

  function filterActive() {
    if (!filterOn) return false;
    const kind = filterKind.value;
    if (kind === 'name' || kind === 'effect') return filterText.value.trim().length > 0;
    if (kind === 'kind') return filterValue.value !== 'all';
    return true;
  }

  function matches(l) {
    const kind = filterKind.value;
    if (kind === 'kind') return l.type === KIND_TYPES[filterValue.value];
    if (kind === 'name') return l.name.toLowerCase().includes(filterText.value.trim().toLowerCase());
    if (kind === 'effect') {
      const q = filterText.value.trim().toLowerCase();
      const s = l.styles || {};
      return Object.keys(s).some((k) => s[k] && s[k].enabled && (EFFECT_NAMES[k] || k).toLowerCase().includes(q));
    }
    if (kind === 'mode') return l.blendMode === filterValue.value;
    if (kind === 'color') return (l.colorLabel || 'none') === filterValue.value;
    switch (filterValue.value) {
      case 'visible': return !!l.visible;
      case 'hidden': return !l.visible;
      case 'locked': return !!(l.locked.all || l.locked.pixels || l.locked.position || l.locked.transparency);
      case 'unlocked': return !(l.locked.all || l.locked.pixels || l.locked.position || l.locked.transparency);
      case 'masked': return !!l.mask;
      case 'clipped': return !!l.clipped;
      case 'styled': return hasStyles(l);
      case 'linked': return !!l.linkId;
      default: return true;
    }
  }

  /** Visible rows top-to-bottom, honouring group expansion and the filter. */
  function collectRows(doc) {
    const filtering = filterActive();
    const out = [];
    const walk = (list, depth, parent) => {
      for (const l of list) {
        const kids = l.children || null;
        const selfMatch = !filtering || matches(l);
        const subMatch = filtering && kids ? hasMatch(kids) : false;
        const shown = selfMatch || subMatch;
        if (shown) out.push({ layer: l, depth, parent });
        if (kids && (l.expanded || subMatch)) walk(kids, depth + (shown ? 1 : 0), l);
      }
    };
    const hasMatch = (list) => list.some((l) => matches(l) || (l.children && hasMatch(l.children)));
    walk(doc.layers, 0, null);
    return out;
  }

  /* ------------------------------- rows ------------------------------- */

  function makeRow() {
    const eye = el('button.pk-icon-btn.pk-lay-eye', { type: 'button', title: 'Toggle layer visibility' });
    const pad = el('span.pk-lay-pad');
    const tri = el('button.pk-icon-btn.pk-lay-tri', { type: 'button', title: 'Expand / collapse group', html: icon('chevron', { size: 11 }) });
    const clip = el('span.pk-lay-clip', { html: icon('chevron-right', { size: 11 }), hidden: true, title: 'Clipped to the layer below' });
    const thumbCv = el('canvas', { width: THUMB, height: THUMB });
    const smartBadge = el('span.pk-lay-smartbadge', {
      hidden: true, title: 'Smart Object — double-click the thumbnail to edit its contents',
      html: icon('image', { size: 9 }),
    });
    const thumbBox = el('div.pk-lay-thumbbox.pk-checker', { title: 'Edit layer pixels' }, thumbCv, smartBadge);
    const iconBox = el('div.pk-lay-groupico', { hidden: true });
    const linkBtn = el('button.pk-lay-masklink', { type: 'button', title: 'Link / unlink mask', html: icon('link', { size: 12 }), hidden: true });
    const maskCv = el('canvas', { width: THUMB, height: THUMB });
    const maskBox = el('div.pk-lay-thumbbox.mask', { title: 'Edit layer mask', hidden: true }, maskCv);
    const name = el('span.pk-lay-name');
    const fxBtn = el('button.pk-icon-btn.pk-lay-fxbadge', { type: 'button', title: 'Layer effects', html: icon('fx', { size: 13 }), hidden: true });
    const linkIco = el('span', { html: icon('link', { size: 12 }), title: 'Linked', hidden: true });
    const lockIco = el('span', { html: icon('lock', { size: 12 }), title: 'Locked', hidden: true });
    const colorBar = el('span.pk-lay-colorbar');
    const badges = el('div.pk-lay-badges', {}, fxBtn, linkIco, lockIco);
    const main = el('div.pk-lay-main', {}, eye, pad, tri, clip, thumbBox, iconBox, linkBtn, maskBox, name, badges, colorBar);
    const fxList = el('div.pk-lay-fxlist', { hidden: true });
    const row = el('div.pk-lay-row', {}, main, fxList);

    row._p = { eye, pad, tri, clip, thumbCv, thumbBox, smartBadge, iconBox, linkBtn, maskCv, maskBox, name, fxBtn, linkIco, lockIco, colorBar, fxList, main };
    row._item = null;

    /* --- interaction ------------------------------------------------- */

    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      const doc = app.activeDoc, l = row._item && row._item.layer;
      if (!doc || !l) return;
      if (e.altKey) soloLayer(doc, l);
      else { l.visible = !l.visible; doc.commit(l.visible ? 'Show Layer' : 'Hide Layer'); }
    });

    tri.addEventListener('click', (e) => {
      e.stopPropagation();
      const doc = app.activeDoc, l = row._item && row._item.layer;
      if (!doc || !l || !l.children) return;
      l.expanded = !l.expanded;
      scheduleRefresh(true);
    });

    const pickTarget = (wantMask) => (e) => {
      e.stopPropagation();
      if (suppressClick) return;
      const doc = app.activeDoc, l = row._item && row._item.layer;
      if (!doc || !l) return;
      if (doc.activeLayerId !== l.id) doc.setActiveLayer(l.id);
      l.editingMask = wantMask && !!l.mask;
      doc.emit('selection-change');
    };
    thumbBox.addEventListener('click', pickTarget(false));
    iconBox.addEventListener('click', pickTarget(false));
    maskBox.addEventListener('click', pickTarget(true));

    thumbBox.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const doc = app.activeDoc, l = row._item && row._item.layer;
      if (!doc || !isSmartLayer(l)) return;
      editSmartContents(doc, l);
    });

    linkBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const doc = app.activeDoc, l = row._item && row._item.layer;
      if (!doc || !l || !l.mask) return;
      l.maskLinked = !l.maskLinked;
      doc.commit(l.maskLinked ? 'Link Mask' : 'Unlink Mask');
    });

    fxBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const l = row._item && row._item.layer;
      if (!l) return;
      if (fxOpen.has(l.id)) fxOpen.delete(l.id);
      else fxOpen.add(l.id);
      scheduleRefresh(true);
    });

    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRename(row);
    });

    main.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button') || e.target.closest('input')) return;
      const doc = app.activeDoc, item = row._item;
      if (!doc || !item) return;
      selectFromEvent(doc, item.layer, e);
      beginDrag(e, item);
    });

    main.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, input, .pk-lay-name, .pk-lay-thumbbox')) return;
      const doc = app.activeDoc, l = row._item && row._item.layer;
      if (!doc || !l) return;
      openStyleDialog(doc, l);
    });

    main.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const doc = app.activeDoc, l = row._item && row._item.layer;
      if (!doc || !l) return;
      if (!doc.selectedLayerIds.includes(l.id)) doc.setActiveLayer(l.id);
      layerContextMenu(doc, l, e.clientX, e.clientY);
    });

    return row;
  }

  function startRename(row) {
    const doc = app.activeDoc, l = row._item && row._item.layer;
    if (!doc || !l) return;
    renamingId = l.id;
    const input = el('input.pk-lay-name-input', { type: 'text', value: l.name });
    row._p.name.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      renamingId = null;
      const v = input.value.trim();
      if (save && v && v !== l.name) ops.setLayerProps(doc, l, { name: v }, 'Rename Layer');
      else scheduleRefresh(true);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  function applyRow(row, item, doc, selSet) {
    const l = item.layer;
    const p = row._p;
    row._item = item;
    row.dataset.id = l.id;

    const isGroup = l.type === LayerType.GROUP;
    const isAdj = l.type === LayerType.ADJUSTMENT;
    const locked = !!(l.locked.all || l.locked.pixels || l.locked.position || l.locked.transparency);

    row.classList.toggle('selected', selSet.has(l.id));
    row.classList.toggle('active', doc.activeLayerId === l.id);
    row.classList.toggle('hiddenlayer', !l.visible);

    p.eye.innerHTML = icon(l.visible ? 'eye' : 'eye-off', { size: 14 });
    p.eye.classList.toggle('off', !l.visible);

    p.pad.style.width = `${item.depth * 13 + (l.clipped ? 8 : 0)}px`;
    /* Nesting depth as an attribute so the stylesheet can draw an indent guide
       on child rows only (the clipping offset must not trigger one). */
    row.dataset.depth = String(item.depth);
    p.tri.classList.toggle('hidden', !isGroup);
    p.tri.classList.toggle('closed', isGroup && !l.expanded);
    p.clip.hidden = !l.clipped;

    const showIconBox = isGroup || isAdj;
    p.thumbBox.hidden = showIconBox;
    p.iconBox.hidden = !showIconBox;
    if (showIconBox) {
      p.iconBox.innerHTML = icon(isGroup ? (l.expanded ? 'folder-open' : 'folder') : 'adjustment', { size: 20 });
    }
    p.thumbBox.classList.toggle('target', !!l.mask && !l.editingMask);
    p.smartBadge.hidden = l.type !== LayerType.SMART;

    p.maskBox.hidden = !l.mask;
    p.linkBtn.hidden = !l.mask;
    p.linkBtn.classList.toggle('off', !l.maskLinked);
    p.maskBox.classList.toggle('target', !!l.mask && !!l.editingMask);
    p.maskBox.style.opacity = l.mask && !l.maskEnabled ? '.4' : '';

    if (renamingId !== l.id) p.name.textContent = l.name;

    const anyStyle = hasAnyStyle(l);
    p.fxBtn.hidden = !anyStyle;
    p.fxBtn.style.opacity = hasStyles(l) ? '' : '.45';
    p.lockIco.hidden = !locked;
    p.linkIco.hidden = !l.linkId;
    const lab = COLOR_LABELS.find((c) => c.value === (l.colorLabel || 'none'));
    p.colorBar.style.background = lab && lab.value !== 'none' ? lab.css : 'transparent';

    buildFxList(row, l, doc, anyStyle);
  }

  function buildFxList(row, l, doc, hasAny) {
    const list = row._p.fxList;
    const rows = smartFilterRows(l, doc);
    if ((!hasAny || !fxOpen.has(l.id)) && !rows.length) {
      list.hidden = true;
      list.replaceChildren();
      return;
    }
    list.hidden = false;
    if (!hasAny || !fxOpen.has(l.id)) {
      list.replaceChildren(...rows);
      return;
    }
    const styles = l.styles || {};
    const configured = Object.keys(EFFECT_NAMES).filter((k) => styles[k] && typeof styles[k] === 'object');
    const anyOn = configured.some((k) => styles[k].enabled);

    rows.push(
      el('div.pk-lay-fxrow.head', {},
        el('button.pk-icon-btn' + (anyOn ? '' : '.off'), {
          type: 'button', title: 'Show / hide all effects', html: icon(anyOn ? 'eye' : 'eye-off', { size: 12 }),
          onclick: (e) => {
            e.stopPropagation();
            for (const k of configured) styles[k].enabled = !anyOn;
            doc.commit(anyOn ? 'Hide All Effects' : 'Show All Effects');
          },
        }),
        el('span.pk-lay-fxname', { text: 'Effects', onclick: () => openStyleDialog(doc, l) })
      )
    );
    for (const key of configured) {
      const cfg = styles[key];
      rows.push(el('div.pk-lay-fxrow', {},
        el('button.pk-icon-btn' + (cfg.enabled ? '' : '.off'), {
          type: 'button', title: 'Toggle effect', html: icon(cfg.enabled ? 'eye' : 'eye-off', { size: 12 }),
          onclick: (e) => {
            e.stopPropagation();
            cfg.enabled = !cfg.enabled;
            doc.commit(`${cfg.enabled ? 'Show' : 'Hide'} ${EFFECT_NAMES[key]}`);
          },
        }),
        el('span.pk-lay-fxname', { text: EFFECT_NAMES[key], onclick: () => openStyleDialog(doc, l, key) })
      ));
    }
    list.replaceChildren(...rows);
  }

  /**
   * Smart filters render as child rows under the smart layer: a header that
   * toggles the whole stack and one row per filter with its own eye. They are
   * always visible (they change what the layer looks like), double-click
   * re-opens the filter's dialog and right-click reorders or removes.
   */
  function smartFilterRows(l, doc) {
    if (!isSmartLayer(l)) return [];
    const filters = getSmartFilters(l);
    if (!filters.length) return [];
    const anyOn = filters.some((f) => f.enabled);

    const rows = [
      el('div.pk-lay-fxrow.head.smart', {},
        el('button.pk-icon-btn' + (anyOn ? '' : '.off'), {
          type: 'button', title: 'Show / hide all smart filters',
          html: icon(anyOn ? 'eye' : 'eye-off', { size: 12 }),
          onclick: (e) => { e.stopPropagation(); setSmartFiltersEnabled(doc, l, !anyOn); },
        }),
        el('span.pk-lay-fxname', {
          text: 'Smart Filters',
          title: 'Applied to the embedded contents on every render',
        })
      ),
    ];

    filters.forEach((f, i) => {
      rows.push(el('div.pk-lay-fxrow.smart' + (f.enabled ? '' : '.disabled'), {
        oncontextmenu: (e) => {
          e.preventDefault();
          e.stopPropagation();
          smartFilterMenu(doc, l, f, i, filters.length, e.clientX, e.clientY);
        },
      },
      el('button.pk-icon-btn' + (f.enabled ? '' : '.off'), {
        type: 'button', title: 'Toggle smart filter',
        html: icon(f.enabled ? 'eye' : 'eye-off', { size: 12 }),
        onclick: (e) => { e.stopPropagation(); toggleSmartFilter(doc, l, f.id); },
      }),
      el('span.pk-lay-fxname', {
        text: f.name,
        title: 'Double-click to edit these settings',
        ondblclick: (e) => { e.stopPropagation(); editSmartFilter(doc, l, f.id); },
      })));
    });
    return rows;
  }

  function smartFilterMenu(doc, layer, entry, index, count, x, y) {
    popupMenu([
      { label: 'Edit Smart Filter…', run: () => editSmartFilter(doc, layer, entry.id) },
      { label: entry.enabled ? 'Disable' : 'Enable', run: () => toggleSmartFilter(doc, layer, entry.id) },
      { separator: true },
      { label: 'Move Up', disabled: index === 0, run: () => reorderSmartFilters(doc, layer, index, index - 1) },
      { label: 'Move Down', disabled: index >= count - 1, run: () => reorderSmartFilters(doc, layer, index, index + 1) },
      { separator: true },
      { label: 'Delete Smart Filter', run: () => removeSmartFilter(doc, layer, entry.id) },
    ], x, y);
  }

  /** True when the layer carries any configured effect, enabled or not. */
  function hasAnyStyle(l) {
    const s = l.styles;
    if (!s) return false;
    return Object.keys(EFFECT_NAMES).some((k) => s[k] && typeof s[k] === 'object');
  }

  function drawThumbs(row, l) {
    const p = row._p;
    if (!p.thumbBox.hidden) {
      const c = p.thumbCv.getContext('2d');
      c.clearRect(0, 0, THUMB, THUMB);
      const t = l.thumbnail(THUMB);
      if (t) c.drawImage(t, 0, 0);
    }
    if (!p.maskBox.hidden && l.mask) {
      const c = p.maskCv.getContext('2d');
      c.clearRect(0, 0, THUMB, THUMB);
      const s = Math.min(THUMB / l.mask.width, THUMB / l.mask.height);
      const w = l.mask.width * s, h = l.mask.height * s;
      c.imageSmoothingQuality = 'low';
      c.drawImage(l.mask, (THUMB - w) / 2, (THUMB - h) / 2, w, h);
    }
  }

  function signature(item, doc, selSet) {
    const l = item.layer;
    const s = l.styles;
    let fx = '';
    if (s) for (const k of Object.keys(s)) if (s[k] && typeof s[k] === 'object') fx += `${k}${s[k].enabled ? 1 : 0}`;
    const sf = getSmartFilters(l).map((f) => `${f.id}${f.enabled ? 1 : 0}`).join(',');
    return [
      item.depth, l.name, l.visible ? 1 : 0, l.type, l.clipped ? 1 : 0, l.expanded ? 1 : 0,
      l.mask ? 1 : 0, l.maskEnabled ? 1 : 0, l.maskLinked ? 1 : 0, l.editingMask ? 1 : 0,
      l.locked.all ? 'a' : '', l.locked.pixels ? 'p' : '', l.locked.position ? 'm' : '', l.locked.transparency ? 't' : '',
      l.linkId || '', l.colorLabel || '', fx, sf, fxOpen.has(l.id) ? 1 : 0,
      selSet.has(l.id) ? 1 : 0, doc.activeLayerId === l.id ? 1 : 0,
    ].join('');
  }

  /* ----------------------------- refresh ------------------------------ */

  function refresh() {
    if (dragging) return;
    const force = forceNext;
    forceNext = false;

    const doc = app.activeDoc;
    listEl.hidden = !doc;
    emptyEl.hidden = !!doc;
    head.style.visibility = doc ? '' : 'hidden';
    if (!doc) {
      rowsEl.replaceChildren();
      rowsById.clear();
      return;
    }
    if (lastDocId !== doc.id) {
      lastDocId = doc.id;
      rowsEl.replaceChildren();
      rowsById.clear();
      fxOpen.clear();
    }

    syncHeader(doc);

    const now = performance.now();
    const allowThumbs = force || now - lastThumbPass > 110;
    if (allowThumbs) lastThumbPass = now;

    const selSet = new Set(doc.selectedLayerIds);
    const items = collectRows(doc);
    const nodes = [];
    const seen = new Set();

    for (const item of items) {
      const id = item.layer.id;
      seen.add(id);
      let row = rowsById.get(id);
      if (!row) {
        row = makeRow();
        rowsById.set(id, row);
      }
      const sig = signature(item, doc, selSet);
      const changed = row._sig !== sig;
      row._item = item;
      if (changed || force) {
        applyRow(row, item, doc, selSet);
        row._sig = sig;
      }
      if (changed || allowThumbs) drawThumbs(row, item.layer);
      nodes.push(row);
    }

    for (const [id, node] of [...rowsById]) {
      if (!seen.has(id)) {
        node.remove();
        rowsById.delete(id);
      }
    }

    // Reconcile order in place — cheap when nothing moved.
    for (let i = 0; i < nodes.length; i++) {
      const cur = rowsEl.childNodes[i];
      if (cur !== nodes[i]) rowsEl.insertBefore(nodes[i], cur || null);
    }
    while (rowsEl.childNodes.length > nodes.length) rowsEl.lastChild.remove();
  }

  function syncHeader(doc) {
    const l = doc.activeLayer();
    const isGroup = !!l && l.type === LayerType.GROUP;
    if (blendHasPassThrough !== isGroup) {
      blendHasPassThrough = isGroup;
      fillBlendSelect(blendSel, isGroup);
    }
    blendSel.disabled = !l;
    blendSel.value = l ? l.blendMode : 'normal';
    if (!blendSel.value) blendSel.value = 'normal';
    opacity.enable(!!l);
    fill.enable(!!l);
    opacity.set(l ? (l.opacity == null ? 1 : l.opacity) : 1);
    fill.set(l ? (l.fillOpacity == null ? 1 : l.fillOpacity) : 1);
    for (const b of lockBtns) {
      b.node.classList.toggle('active', !!(l && l.locked[b.key]));
      b.node.disabled = !l;
    }
  }

  /* --------------------------- drag & drop ---------------------------- */

  function beginDrag(e, item) {
    const doc = app.activeDoc;
    if (!doc) return;
    const startX = e.clientX, startY = e.clientY;
    let started = false;

    const move = (ev) => {
      if (!started) {
        if (Math.abs(ev.clientY - startY) < 4 && Math.abs(ev.clientX - startX) < 4) return;
        const sel = doc.selectedLayers();
        const set = sel.includes(item.layer) && sel.length > 1 ? sel : [item.layer];
        if (set.some((l) => l.isBackground)) {
          app.toast('The Background layer is locked in place.');
          cleanup();
          return;
        }
        started = true;
        dragging = true;
        dragState = { layers: set, target: null, intoRow: null };
        listEl.classList.add('dragging');
        for (const l of set) {
          const r = rowsById.get(l.id);
          if (r) r.classList.add('dragged');
        }
      }
      autoScroll(ev);
      updateDropTarget(ev);
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };

    const up = () => {
      cleanup();
      if (!started) return;
      const state = dragState;
      dragState = null;
      dragging = false;
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      listEl.classList.remove('dragging');
      dropLine.hidden = true;
      if (state && state.intoRow) state.intoRow.classList.remove('into');
      for (const r of rowsById.values()) r.classList.remove('dragged');
      if (state && state.target) applyDrop(doc, state.layers, state.target);
      scheduleRefresh(true);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function autoScroll(ev) {
    const r = listEl.getBoundingClientRect();
    if (ev.clientY < r.top + 22) listEl.scrollTop -= 10;
    else if (ev.clientY > r.bottom - 22) listEl.scrollTop += 10;
  }

  function updateDropTarget(ev) {
    const doc = app.activeDoc;
    if (!doc || !dragState) return;
    if (dragState.intoRow) {
      dragState.intoRow.classList.remove('into');
      dragState.intoRow = null;
    }

    const dragged = dragState.layers;
    const blocked = (l) => dragged.includes(l) || dragged.some((d) => isAncestor(d, l));

    let hitRow = null, rel = 0;
    for (const node of rowsEl.childNodes) {
      const r = node._p.main.getBoundingClientRect();
      if (ev.clientY >= r.top && ev.clientY < r.bottom) {
        hitRow = node;
        rel = (ev.clientY - r.top) / Math.max(1, r.height);
        break;
      }
    }

    let target = null;
    let lineTop = 0;
    let depth = 0;

    if (!hitRow) {
      const first = rowsEl.firstChild;
      const last = rowsEl.lastChild;
      if (!first) {
        dragState.target = { parent: null, index: 0 };
        dropLine.hidden = true;
        return;
      }
      const topR = first._p.main.getBoundingClientRect();
      if (ev.clientY < topR.top) {
        target = { parent: null, index: 0 };
        lineTop = first.offsetTop;
      } else {
        target = { parent: null, index: doc.layers.length };
        lineTop = last.offsetTop + last.offsetHeight;
      }
    } else {
      const item = hitRow._item;
      const l = item.layer;
      const isGroup = l.type === LayerType.GROUP;
      if (isGroup && rel > 0.28 && rel < 0.72 && !blocked(l)) {
        dragState.target = { parent: l, index: 0 };
        dragState.intoRow = hitRow;
        hitRow.classList.add('into');
        dropLine.hidden = true;
        return;
      }
      const loc = doc.locate(l);
      if (!loc) return;
      if (rel < 0.5) {
        target = { parent: loc.parent, index: loc.index };
        lineTop = hitRow.offsetTop;
        depth = item.depth;
      } else if (isGroup && l.expanded && l.children && l.children.length && !blocked(l)) {
        target = { parent: l, index: 0 };
        lineTop = hitRow.offsetTop + hitRow._p.main.offsetHeight;
        depth = item.depth + 1;
      } else {
        target = { parent: loc.parent, index: loc.index + 1 };
        lineTop = hitRow.offsetTop + hitRow.offsetHeight;
        depth = item.depth;
      }
    }

    if (target.parent && blocked(target.parent)) {
      dragState.target = null;
      dropLine.hidden = true;
      return;
    }
    dragState.target = target;
    dropLine.hidden = false;
    dropLine.style.top = `${lineTop}px`;
    dropLine.style.left = `${24 + depth * 13}px`;
  }

  function applyDrop(doc, layers, target) {
    const parentList = target.parent ? target.parent.children : doc.layers;
    const dragged = new Set(layers);
    // Anchor on the first layer at/after the insertion point that is not moving.
    let ref = null;
    for (let i = target.index; i < parentList.length; i++) {
      if (!dragged.has(parentList[i])) { ref = parentList[i]; break; }
    }
    const flat = doc.flatLayers();
    const ordered = [...layers].sort((a, b) => flat.indexOf(a) - flat.indexOf(b));
    let moved = false;
    for (const l of ordered) {
      const list = target.parent ? target.parent.children : doc.layers;
      const at = ref ? list.indexOf(ref) : list.length;
      doc.moveLayer(l, target.parent, at < 0 ? list.length : at);
      moved = true;
    }
    if (moved) doc.commit('Reorder Layers');
  }

  /* ------------------------------ actions ----------------------------- */

  function selectFromEvent(doc, layer, e) {
    const additive = e.ctrlKey || e.metaKey;
    const range = e.shiftKey;
    doc.setActiveLayer(layer.id, additive, range);
    if (!additive && !range && layer.linkId) {
      const ids = doc.flatLayers().filter((x) => x.linkId === layer.linkId).map((x) => x.id);
      if (ids.length > 1) {
        doc.selectedLayerIds = ids;
        doc.activeLayerId = layer.id;
        doc.emit('selection-change');
      }
    }
  }

  function toggleLink(doc) {
    const sel = doc.selectedLayers();
    if (sel.length < 2) {
      const l = doc.activeLayer();
      if (l && l.linkId) {
        const id = l.linkId;
        for (const x of doc.flatLayers()) if (x.linkId === id) x.linkId = null;
        doc.commit('Unlink Layers');
      } else app.toast('Select two or more layers to link.');
      return;
    }
    const first = sel[0].linkId;
    if (first && sel.every((l) => l.linkId === first)) {
      for (const l of sel) l.linkId = null;
      doc.commit('Unlink Layers');
    } else {
      const id = uid('link');
      for (const l of sel) l.linkId = id;
      doc.commit('Link Layers');
    }
  }

  function layerContextMenu(doc, layer, x, y) {
    const sel = doc.selectedLayers();
    const many = sel.length > 1;
    popupMenu([
      { label: many ? 'Duplicate Layers' : 'Duplicate Layer', run: () => ops.duplicateLayers(doc, sel) },
      { label: many ? 'Delete Layers' : 'Delete Layer', run: () => ops.deleteLayers(doc, sel) },
      { separator: true },
      { label: 'Blending Options…', run: () => openStyleDialog(doc, layer) },
      { label: layer.clipped ? 'Release Clipping Mask' : 'Create Clipping Mask', run: () => ops.toggleClipping(doc, layer) },
      { separator: true },
      { label: 'Group Layers', run: () => ops.groupLayers(doc, sel.length ? sel : [layer]) },
      { label: 'Ungroup Layers', disabled: layer.type !== LayerType.GROUP, run: () => ops.ungroupLayers(doc, layer) },
      { separator: true },
      { label: 'Merge Down', run: () => ops.mergeDown(doc, layer) },
      { label: 'Merge Visible', run: () => ops.mergeVisible(doc) },
      { label: 'Flatten Image', run: () => ops.flattenImage(doc) },
      { separator: true },
      { label: 'Rasterize Layer', disabled: layer.type === LayerType.RASTER, run: () => ops.rasterizeLayer(doc, layer) },
      { label: 'Rasterize Layer Style', disabled: !hasStyles(layer), run: () => ops.rasterizeLayerStyle(doc, layer) },
      { label: 'Convert to Smart Object', run: () => ops.convertToSmartObject(doc, sel.length ? sel : [layer]) },
      { label: 'Edit Contents', disabled: !isSmartLayer(layer), run: () => editSmartContents(doc, layer) },
      { separator: true },
      layer.mask
        ? { label: 'Apply Layer Mask', run: () => ops.applyLayerMask(doc, layer) }
        : { label: 'Add Layer Mask', run: () => ops.addLayerMask(doc, layer, doc.selection.active ? 'reveal-selection' : 'reveal-all') },
      layer.mask ? { label: 'Delete Layer Mask', run: () => ops.deleteLayerMask(doc, layer) } : null,
      layer.mask ? { label: layer.maskEnabled ? 'Disable Layer Mask' : 'Enable Layer Mask', run: () => ops.toggleMaskEnabled(doc, layer) } : null,
      { separator: true },
      layer.isBackground
        ? { label: 'Layer From Background', run: () => ops.convertBackgroundToLayer(doc, layer) }
        : { label: 'Background From Layer', disabled: layer.type !== LayerType.RASTER, run: () => ops.convertLayerToBackground(doc, layer) },
      { label: 'Layer Properties…', run: () => showLayerProperties(doc, layer) },
    ], x, y);
  }

  function fxMenu(doc, layer, x, y) {
    const styles = layer.styles || {};
    const items = [
      { label: 'Blending Options…', run: () => openStyleDialog(doc, layer) },
      { separator: true },
    ];
    for (const [key, label] of Object.entries(EFFECT_NAMES)) {
      items.push({
        label: `${label}…`,
        checked: !!(styles[key] && styles[key].enabled),
        run: () => openStyleDialog(doc, layer, key),
      });
    }
    items.push(
      { separator: true },
      {
        label: 'Clear Layer Style',
        disabled: !hasStyles(layer),
        run: () => { layer.styles = null; doc.commit('Clear Layer Style'); },
      }
    );
    popupMenu(items, x, y, { align: 'left' });
  }

  function adjustmentMenu(doc, x, y) {
    const items = [
      {
        label: 'Solid Color…',
        run: () => {
          const hex = toHex(app.foreground);
          ops.addFillLayer(doc, 'solid', { color: hex, fill: hex });
        },
      },
      {
        label: 'Gradient…',
        run: () => ops.addFillLayer(doc, 'gradient', {
          angle: 90,
          stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }],
        }),
      },
      { separator: true },
    ];
    const list = listAdjustments().filter((a) => a.layerable !== false);
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const a of list) {
      items.push({
        label: a.name.replace(/(\.\.\.|…)$/, ''),
        run: () => ops.addAdjustmentLayer(doc, a.id),
      });
    }
    popupMenu(items, x, y, { align: 'left' });
  }

  function panelMenu() {
    const doc = app.activeDoc;
    if (!doc) return [];
    const l = doc.activeLayer();
    return [
      { label: 'New Layer', run: () => ops.addRasterLayer(doc) },
      { label: 'New Group', run: () => { const g = createGroupLayer(nextGroupName(doc)); doc.addLayer(g); doc.commit('New Group'); } },
      { label: 'Duplicate Layer', disabled: !l, run: () => ops.duplicateLayers(doc, doc.selectedLayers()) },
      { label: 'Delete Layer', disabled: !l, run: () => ops.deleteLayers(doc, doc.selectedLayers()) },
      { separator: true },
      { label: 'Merge Down', disabled: !l, run: () => ops.mergeDown(doc, l) },
      { label: 'Merge Visible', run: () => ops.mergeVisible(doc) },
      { label: 'Flatten Image', run: () => ops.flattenImage(doc) },
      { separator: true },
      { label: 'Expand All Groups', run: () => setAllExpanded(doc, true) },
      { label: 'Collapse All Groups', run: () => setAllExpanded(doc, false) },
      { separator: true },
      { label: 'Layer Properties…', disabled: !l, run: () => showLayerProperties(doc, l) },
    ];
  }

  function setAllExpanded(doc, on) {
    for (const l of doc.flatLayers()) if (l.children) l.expanded = on;
    scheduleRefresh(true);
  }

  /* --------------------------- event wiring --------------------------- */

  const onStructure = () => scheduleRefresh(true);
  const onChange = () => scheduleRefresh(false);
  app.on('doc-structure', onStructure);
  app.on('doc-selection', onStructure);
  app.on('active-doc', onStructure);
  app.on('history-change', onStructure);
  app.on('doc-change', onChange);
  app.on('doc-resize', onChange);

  syncFilterInputs();
  refresh();

  return {
    refresh: () => scheduleRefresh(false),
    menu: panelMenu,
    destroy() {
      app.off('doc-structure', onStructure);
      app.off('doc-selection', onStructure);
      app.off('active-doc', onStructure);
      app.off('history-change', onStructure);
      app.off('doc-change', onChange);
      app.off('doc-resize', onChange);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function fillBlendSelect(sel, includePassThrough) {
  sel.replaceChildren();
  if (includePassThrough) sel.appendChild(el('option', { value: 'pass-through', text: 'Pass Through' }));
  let group = -1;
  let og = null;
  for (const m of BLEND_MODES) {
    if (m.group !== group) {
      group = m.group;
      og = el('optgroup', { label: BLEND_GROUP_LABELS[group] || String(group) });
      sel.appendChild(og);
    }
    og.appendChild(el('option', { value: m.id, text: m.name }));
  }
}

function isAncestor(ancestor, layer) {
  let p = layer.parent;
  while (p) {
    if (p === ancestor) return true;
    p = p.parent;
  }
  return false;
}

function nextGroupName(doc) {
  const names = new Set(doc.flatLayers().map((l) => l.name));
  let n = 1;
  while (names.has(`Group ${n}`)) n++;
  return `Group ${n}`;
}

/** Alt-click on the eye: show only this layer, or restore everything. */
function soloLayer(doc, layer) {
  const all = doc.flatLayers();
  const keep = new Set();
  for (let l = layer; l; l = l.parent) keep.add(l.id);
  if (layer.children) for (const d of doc.flatLayers(layer.children, [])) keep.add(d.id);
  const alreadySolo = all.every((x) => keep.has(x.id) || !x.visible);
  for (const x of all) x.visible = alreadySolo ? true : keep.has(x.id);
  doc.commit(alreadySolo ? 'Show All Layers' : 'Show Only This Layer');
}

/** Lazily open the layer style dialog; the effects module owns it. */
async function openStyleDialog(doc, layer, effectId) {
  try {
    const mod = await import('../../effects/styles-dialog.js');
    const fn = mod.showLayerStyleDialog || mod.default;
    if (typeof fn !== 'function') throw new Error('Layer style dialog is unavailable.');
    await fn(doc, layer, effectId);
  } catch (err) {
    console.error(err);
    app.toast(err && err.message ? err.message : 'Could not open layer styles.', 'error');
  }
}

async function showLayerProperties(doc, layer) {
  const state = { name: layer.name, colorLabel: layer.colorLabel || 'none' };
  const result = await paramDialog({
    title: 'Layer Properties',
    width: 320,
    preview: false,
    state,
    params: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'colorLabel', label: 'Color', type: 'select', options: COLOR_LABELS.map((c) => ({ value: c.value, label: c.label })) },
    ],
  });
  if (!result) return;
  const name = String(result.name || '').trim() || layer.name;
  ops.setLayerProps(doc, layer, { name, colorLabel: result.colorLabel }, 'Layer Properties');
}
