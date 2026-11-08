import { el, formatBytes, clamp, rafThrottle } from '../core/util.js';
import { app } from '../core/app.js';
import { msg, tr } from '../core/i18n.js';
import './statusbar.css';

/**
 * The bottom status bar: zoom control, document size, a switchable status
 * readout, the current tool, memory use and a modifier-key hint.
 */

/** Both the select's values and, translated, its labels. */
const STATUS_MODES = [
  'Document Sizes',
  'Document Profile',
  'Document Dimensions',
  'Scratch Sizes',
  'Efficiency',
  'Timing',
  'Current Tool',
];

const ZOOM_PRESETS = [1600, 800, 400, 200, 100, 66.67, 50, 33.33, 25, 12.5];

/** Modifier hints per tool id, falling back to the tool group. */
const TOOL_HINTS = {
  move: msg('Alt+drag duplicates · Shift constrains to an axis · Ctrl auto-selects'),
  crop: msg('Shift keeps the ratio · Alt resizes from the centre · Enter applies'),
  eyedropper: msg('Alt samples the background colour · Shift adds a sampler'),
  gradient: msg('Shift constrains the angle · Alt reverses the gradient'),
  bucket: msg('Shift fills everywhere · Alt samples the background colour'),
  wand: msg('Shift adds · Alt subtracts · Shift+Alt intersects'),
  'quick-select': msg('Shift adds · Alt subtracts · [ ] change the brush size'),
  hand: msg('Space+drag pans from any tool · Ctrl+0 fits the screen'),
  zoom: msg('Alt+click zooms out · Ctrl+= in · Ctrl+- out · Ctrl+1 for 100%'),
  type: msg('Enter adds a line · Esc commits · Ctrl+Enter commits'),
  'clone-stamp': msg('Alt+click sets the clone source · [ ] change the brush size'),
  'history-brush': msg('Alt+click sets the source state · [ ] change the brush size'),
};

const GROUP_HINTS = {
  marquee: msg('Shift constrains/adds · Alt draws from the centre/subtracts · Space moves'),
  lasso: msg('Shift adds · Alt subtracts · Backspace removes the last point'),
  brush: msg('[ ] size · Shift+[ ] hardness · Alt samples a colour · Shift draws a line'),
  eraser: msg('[ ] size · Shift+[ ] hardness · Shift erases a straight line'),
  stamp: msg('Alt+click sets the source · [ ] change the brush size'),
  focus: msg('[ ] size · Alt inverts the effect'),
  tone: msg('[ ] size · Alt inverts dodge/burn'),
  healing: msg('Alt+click sets the source · [ ] change the brush size'),
  pen: msg('Alt converts a point · Ctrl moves a point · Shift constrains the angle'),
  shape: msg('Shift constrains proportions · Alt draws from the centre'),
  'path-select': msg('Shift selects more · Alt duplicates the path'),
  nav: msg('Space+drag pans · Ctrl+wheel zooms · Ctrl+0 fits the screen'),
};

let nodes = null;
let statusMode = STATUS_MODES[0];
let lastTiming = 0;
let busyStart = 0;

/**
 * Build the status bar into `rootEl`.
 * @param {HTMLElement} rootEl
 */
export function buildStatusBar(rootEl) {
  if (!rootEl) return;
  rootEl.replaceChildren();

  const zoomInput = el('input.pk-input.pk-sb-zoom', { type: 'text', value: '100', title: tr('Zoom level') });
  const commitZoom = () => {
    const v = parseFloat(String(zoomInput.value).replace(/[^0-9.\-]/g, ''));
    if (!Number.isFinite(v) || v <= 0) { syncZoom(); return; }
    if (!app.activeDoc) { syncZoom(); return; }
    app.viewport.setScale(clamp(v / 100, 0.0025, 64));
    app.emit('view-change');
    app.requestRender();
    syncZoom();
  };
  zoomInput.addEventListener('change', commitZoom);
  zoomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.stopPropagation(); commitZoom(); zoomInput.blur(); }
  });

  const zoomSelect = el('select.pk-select.pk-sb-zoomsel', { title: tr('Zoom presets') },
    el('option', { value: '', text: tr('Custom') }),
    el('option', { value: 'fit', text: tr('Fit on Screen') }),
    el('option', { value: 'fill', text: tr('Fill Screen') }),
    ...ZOOM_PRESETS.map((z) => el('option', { value: String(z), text: `${z}%` }))
  );
  zoomSelect.addEventListener('change', () => {
    const v = zoomSelect.value;
    if (!app.activeDoc || !v) { syncZoom(); return; }
    if (v === 'fit') app.fitView();
    else if (v === 'fill') {
      app.viewport.fillScreen(app.activeDoc.width, app.activeDoc.height);
      app.emit('view-change');
    } else {
      app.viewport.setScale(Number(v) / 100);
      app.emit('view-change');
    }
    app.requestRender();
    syncZoom();
  });

  const dims = el('span.pk-sb-dims');
  const statusSelect = el('select.pk-select.pk-sb-mode', { title: tr('Status information') },
    ...STATUS_MODES.map((m) => el('option', { value: m, text: tr(m) }))
  );
  statusSelect.value = statusMode;
  statusSelect.addEventListener('change', () => {
    statusMode = statusSelect.value;
    sync();
  });

  const statusText = el('span.pk-sb-status');
  const toolName = el('span.pk-sb-tool');
  const memory = el('span.pk-sb-mem');
  const hint = el('span.pk-sb-hint.pk-truncate');

  rootEl.append(
    zoomInput,
    el('span.pk-unit', { text: '%' }),
    zoomSelect,
    el('div.pk-vsep'),
    dims,
    el('div.pk-vsep'),
    statusSelect,
    statusText,
    el('div.pk-vsep'),
    toolName,
    el('div.pk-vsep'),
    memory,
    el('div.pk-spacer'),
    hint
  );

  nodes = { zoomInput, zoomSelect, dims, statusText, toolName, memory, hint };

  app.on('busy', ({ active }) => {
    if (active) busyStart = performance.now();
    else if (busyStart) {
      lastTiming = (performance.now() - busyStart) / 1000;
      busyStart = 0;
      if (statusMode === 'Timing') sync();
    }
  });

  const queue = rafThrottle(sync);
  for (const ev of ['view-change', 'active-doc', 'docs-change', 'doc-resize', 'doc-change', 'doc-structure', 'tool-change', 'history-change', 'ready']) {
    app.on(ev, queue);
  }
  sync();
}

/* ------------------------------------------------------------------ */

function syncZoom() {
  if (!nodes) return;
  const pct = app.viewport.scale * 100;
  if (document.activeElement !== nodes.zoomInput) {
    nodes.zoomInput.value = pct >= 100 ? String(Math.round(pct)) : String(Math.round(pct * 100) / 100);
  }
  const match = ZOOM_PRESETS.find((z) => Math.abs(z - pct) < 0.05);
  nodes.zoomSelect.value = match != null ? String(match) : '';
}

function sync() {
  if (!nodes) return;
  const doc = app.activeDoc;
  syncZoom();

  nodes.dims.textContent = doc ? `${doc.width} × ${doc.height} px` : '—';
  nodes.toolName.textContent = app.tool ? tr(app.tool.name) : '—';
  nodes.memory.textContent = tr('Mem: {size}', { size: doc ? formatBytes(doc.memoryUse()) : '—' });
  nodes.statusText.textContent = statusValue(doc);
  nodes.hint.textContent = tr(hintFor(app.tool));
}

function heapLimit() {
  const m = performance && performance.memory;
  return m && m.jsHeapSizeLimit ? m.jsHeapSizeLimit : 2 * 1024 * 1024 * 1024;
}

function allDocsMemory() {
  let n = 0;
  for (const d of app.docs) n += d.memoryUse();
  return n;
}

function statusValue(doc) {
  if (!doc) return '—';
  switch (statusMode) {
    case 'Document Sizes':
      return `${formatBytes(doc.width * doc.height * 4)}/${formatBytes(doc.memoryUse())}`;
    case 'Document Profile':
      return doc.colorMode === 'gray' ? 'Gray Gamma 2.2' : 'sRGB IEC61966-2.1';
    case 'Document Dimensions':
      return `${doc.width} × ${doc.height} px @ ${doc.resolution || 72} ppi`;
    case 'Scratch Sizes':
      return `${formatBytes(allDocsMemory())}/${formatBytes(heapLimit())}`;
    case 'Efficiency': {
      const used = allDocsMemory() / heapLimit();
      return `${Math.max(5, Math.round(100 - used * 100))}%`;
    }
    case 'Timing':
      return `${lastTiming.toFixed(2)}s`;
    case 'Current Tool':
      return app.tool ? tr(app.tool.name) : '—';
    default:
      return '—';
  }
}

/** The modifier hint for a tool: English, as a string or a `msg()` — translate it to show it. */
function hintFor(tool) {
  if (!tool) return msg('Space+drag pans · Ctrl+wheel zooms');
  if (tool.hint) return tool.hint;
  if (TOOL_HINTS[tool.id]) return TOOL_HINTS[tool.id];
  if (GROUP_HINTS[tool.group]) return GROUP_HINTS[tool.group];
  return msg('Space+drag pans · Ctrl+wheel zooms · Tab hides the panels');
}
