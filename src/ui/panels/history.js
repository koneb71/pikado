import './panels.css';
import { registerPanel, popupMenu } from '../panel-host.js';
import { app } from '../../core/app.js';
import { el, createCanvas, rafThrottle } from '../../core/util.js';
import { icon } from '../icons.js';
import { PikaDocument } from '../../core/document.js';
import { getComposite } from '../../render/compositor.js';
import { promptDialog } from '../dialog.js';

/**
 * The History panel: snapshots on top, the undo stack below.
 *
 * History states hold *references* to the live pixel buffers (copy-on-write
 * guarantees they are never mutated behind our back), so snapshots simply keep
 * the object returned by `doc.captureState()` — cloning it would multiply the
 * document's memory use for nothing.
 */

registerPanel({
  id: 'history',
  title: 'History',
  icon: 'history',
  group: 'bottom',
  order: 1,
  defaultOpen: true,
  minHeight: 110,
  build: buildHistoryPanel,
});

function buildHistoryPanel(bodyEl) {
  bodyEl.classList.add('pk-panel-flush');

  const snapsEl = el('div.pk-hist-snaps');
  const statesEl = el('div.pk-hist-states');
  const emptyEl = el('div.pk-panel-empty', { text: 'No document open.' });

  const foot = el('div.pk-hist-foot', {},
    btn('copy', 'Create new document from current state', () => withDoc(newDocumentFromState)),
    btn('image', 'Create new snapshot', () => withDoc(takeSnapshot)),
    btn('trash', 'Delete', () => withDoc(deleteSelected))
  );

  const root = el('div.pk-hist', {}, snapsEl, statesEl, emptyEl, foot);
  bodyEl.appendChild(root);

  /** index into doc.snapshots, or -1 for none, -2 for the "Original" entry. */
  let selectedSnap = -1;
  let lastDocId = null;
  /** @type {Map<string, HTMLCanvasElement>} doc id -> opening thumbnail */
  const originThumbs = new Map();

  const refresh = rafThrottle(render);

  function btn(name, title, onClick) {
    return el('button.pk-icon-btn', { type: 'button', title, html: icon(name, { size: 15 }), onclick: onClick });
  }

  function withDoc(fn) {
    const doc = app.activeDoc;
    if (!doc) return;
    fn(doc);
  }

  /* ----------------------------- rendering ---------------------------- */

  function render() {
    const doc = app.activeDoc;
    emptyEl.hidden = !!doc;
    snapsEl.hidden = !doc;
    statesEl.hidden = !doc;
    if (!doc) {
      snapsEl.replaceChildren();
      statesEl.replaceChildren();
      return;
    }
    if (lastDocId !== doc.id) {
      lastDocId = doc.id;
      selectedSnap = -1;
    }
    if (!originThumbs.has(doc.id)) originThumbs.set(doc.id, miniThumb(doc));

    renderSnapshots(doc);
    renderStates(doc);
  }

  function renderSnapshots(doc) {
    const rows = [];
    rows.push(snapRow(doc, {
      name: doc.name,
      thumb: originThumbs.get(doc.id),
    }, -2, () => {
      selectedSnap = -2;
      doc.history.goto(0);
      refresh();
    }));

    const snaps = doc.snapshots || [];
    snaps.forEach((s, i) => {
      rows.push(snapRow(doc, s, i, () => {
        selectedSnap = i;
        restoreSnapshot(doc, s);
      }));
    });
    snapsEl.replaceChildren(...rows);
  }

  function snapRow(doc, snap, index, onClick) {
    const thumb = snap.thumb || miniThumb(doc);
    const row = el('div.pk-hist-item.pk-hist-snap' + (selectedSnap === index ? '.selected' : ''), {
      title: snap.name,
      onclick: onClick,
      oncontextmenu: (e) => {
        e.preventDefault();
        if (index < 0) return;
        popupMenu([
          { label: 'Rename Snapshot…', run: () => renameSnapshot(doc, snap) },
          { label: 'Delete Snapshot', run: () => { (doc.snapshots || []).splice(index, 1); selectedSnap = -1; refresh(); } },
          { separator: true },
          { label: 'New Document from Snapshot', run: () => newDocumentFrom(doc, snap.state, snap.name) },
        ], e.clientX, e.clientY);
      },
    });
    thumb.classList.add('pk-hist-thumb');
    row.append(thumb, el('span.pk-hist-label', { text: snap.name }));
    return row;
  }

  function renderStates(doc) {
    const h = doc.history;
    const rows = h.states.map((s, i) => {
      const row = el('div.pk-hist-item' + (i === h.index ? '.current' : i > h.index ? '.future' : ''), {
        title: s.label,
        onclick: () => {
          selectedSnap = -1;
          h.goto(i);
          refresh();
        },
        oncontextmenu: (e) => {
          e.preventDefault();
          stateMenu(doc, i, e.clientX, e.clientY);
        },
      });
      row.append(
        el('span.pk-hist-ico', { html: icon(stateIcon(s.label), { size: 14 }) }),
        el('span.pk-hist-label', { text: s.label }),
        el('span.pk-hist-brush', { html: icon('history-brush', { size: 12 }), title: 'History Brush source', hidden: doc.historyBrushSource !== i })
      );
      return row;
    });
    statesEl.replaceChildren(...rows);
    const cur = statesEl.children[h.index];
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }

  function stateMenu(doc, i, x, y) {
    const h = doc.history;
    popupMenu([
      {
        label: 'Set as History Brush source',
        checked: doc.historyBrushSource === i,
        run: () => {
          doc.historyBrushSource = doc.historyBrushSource === i ? null : i;
          refresh();
        },
      },
      { separator: true },
      { label: 'New Snapshot from This State', run: () => snapshotFrom(doc, h.states[i]) },
      { label: 'New Document from This State', run: () => newDocumentFrom(doc, h.states[i].state, h.states[i].label) },
      { separator: true },
      {
        label: 'Delete This State and Later',
        disabled: i === 0,
        run: () => truncateHistory(doc, i),
      },
    ], x, y);
  }

  /* ------------------------------ actions ----------------------------- */

  function takeSnapshot(doc) {
    if (!doc.snapshots) doc.snapshots = [];
    // captureState() shares the pixel buffers with the live layers; copy-on-write
    // keeps them valid, so this costs almost nothing.
    doc.snapshots.push({
      name: `Snapshot ${doc.snapshots.length + 1}`,
      state: doc.captureState(),
      thumb: miniThumb(doc),
    });
    selectedSnap = doc.snapshots.length - 1;
    app.toast('Snapshot created.', 'ok', 1400);
    refresh();
  }

  function snapshotFrom(doc, entry) {
    if (!entry) return;
    if (!doc.snapshots) doc.snapshots = [];
    doc.snapshots.push({ name: entry.label, state: entry.state, thumb: entry.thumb || miniThumb(doc) });
    refresh();
  }

  function restoreSnapshot(doc, snap) {
    doc.restoreState(snap.state);
    doc.commit(`Snapshot: ${snap.name}`);
    doc.emit('structure');
    refresh();
  }

  async function renameSnapshot(doc, snap) {
    const name = await promptDialog('Snapshot name', snap.name, 'Rename Snapshot');
    if (name == null) return;
    const v = String(name).trim();
    if (v) snap.name = v;
    refresh();
  }

  function newDocumentFromState(doc) {
    const entry = doc.history.states[doc.history.index];
    if (!entry) return;
    newDocumentFrom(doc, entry.state, entry.label);
  }

  function newDocumentFrom(doc, state, label) {
    if (!state) return;
    const nd = new PikaDocument({
      width: state.width,
      height: state.height,
      name: `${doc.name} (${label || 'state'})`,
    });
    nd.resolution = doc.resolution;
    nd.restoreState(state);
    nd.history.clear('Duplicate State');
    app.addDocument(nd);
    app.toast('New document created from history state.', 'ok');
  }

  function deleteSelected(doc) {
    if (selectedSnap >= 0 && doc.snapshots && doc.snapshots[selectedSnap]) {
      doc.snapshots.splice(selectedSnap, 1);
      selectedSnap = -1;
      refresh();
      return;
    }
    truncateHistory(doc, doc.history.index);
  }

  /** Drop `from` and every later state, then step back to the one before it. */
  function truncateHistory(doc, from) {
    const h = doc.history;
    const keep = Math.max(1, from);
    if (keep >= h.states.length) return;
    h.states.length = keep;
    h.index = keep - 1;
    h.suspend();
    try {
      doc.restoreState(h.states[h.index].state);
    } finally {
      h.resume();
    }
    h.emit('change');
    doc.emit('change', { reason: 'history' });
    doc.emit('structure');
    refresh();
  }

  function panelMenu() {
    const doc = app.activeDoc;
    if (!doc) return [];
    return [
      { label: 'New Snapshot', run: () => takeSnapshot(doc) },
      { label: 'New Document from Current State', run: () => newDocumentFromState(doc) },
      { separator: true },
      { label: 'Clear History', run: () => { doc.history.clear('Clear History'); refresh(); } },
      {
        label: 'Clear History Brush Source',
        disabled: doc.historyBrushSource == null,
        run: () => { doc.historyBrushSource = null; refresh(); },
      },
    ];
  }

  /* --------------------------- event wiring --------------------------- */

  const onChange = () => refresh();
  app.on('history-change', onChange);
  app.on('active-doc', onChange);
  app.on('docs-change', onChange);
  app.on('doc-structure', onChange);

  render();

  return {
    refresh,
    menu: panelMenu,
    destroy() {
      app.off('history-change', onChange);
      app.off('active-doc', onChange);
      app.off('docs-change', onChange);
      app.off('doc-structure', onChange);
    },
  };
}

/* ------------------------------------------------------------------ */

function miniThumb(doc, w = 26, h = 22) {
  const cv = createCanvas(w, h);
  const c = cv.getContext('2d');
  c.fillStyle = '#161616';
  c.fillRect(0, 0, w, h);
  try {
    const comp = getComposite(doc);
    const s = Math.min(w / comp.width, h / comp.height);
    const dw = comp.width * s, dh = comp.height * s;
    c.imageSmoothingQuality = 'low';
    c.drawImage(comp, (w - dw) / 2, (h - dh) / 2, dw, dh);
  } catch (err) {
    console.error('[history] thumbnail', err);
  }
  return cv;
}

/** Pick an icon that hints at what the history entry did. */
function stateIcon(label) {
  const s = String(label || '').toLowerCase();
  if (s.includes('brush') || s.includes('pencil') || s.includes('paint')) return 'brush';
  if (s.includes('eras')) return 'eraser';
  if (s.includes('mask')) return 'mask';
  if (s.includes('delete') || s.includes('clear')) return 'trash';
  if (s.includes('duplicate') || s.includes('copy') || s.includes('paste')) return 'copy';
  if (s.includes('group')) return 'folder';
  if (s.includes('merge') || s.includes('flatten') || s.includes('stamp')) return 'merge';
  if (s.includes('crop') || s.includes('trim')) return 'crop';
  if (s.includes('select') || s.includes('marquee') || s.includes('lasso')) return 'marquee-rect';
  if (s.includes('gradient')) return 'gradient';
  if (s.includes('fill') || s.includes('bucket')) return 'bucket';
  if (s.includes('type') || s.includes('text')) return 'type';
  if (s.includes('shape') || s.includes('rectangle') || s.includes('ellipse')) return 'rectangle';
  if (s.includes('move') || s.includes('reorder') || s.includes('arrange') || s.includes('transform') || s.includes('rotate') || s.includes('flip')) return 'move';
  if (s.includes('blur') || s.includes('sharpen') || s.includes('noise') || s.includes('filter')) return 'blur';
  if (s.includes('opacity') || s.includes('blend') || s.includes('levels') || s.includes('curves') || s.includes('adjust') || s.includes('hue') || s.includes('exposure')) return 'adjustment';
  if (s.includes('layer')) return 'copy';
  if (s.includes('open') || s.includes('new') || s.includes('image size') || s.includes('canvas')) return 'image';
  if (s.includes('snapshot')) return 'history';
  return 'history';
}
