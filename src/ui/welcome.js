import { el } from '../core/util.js';
import { app } from '../core/app.js';
import { brandMark, BRAND } from './brand.js';
import { icon } from './icons.js';
import { confirmDialog } from './dialog.js';
import { IS_MAC } from '../commands/registry.js';
import {
  listRecent, openRecent, forgetRecent, storageUsage, sessionEvents,
} from '../io/session.js';
import './welcome.css';

/**
 * The start screen: what you see when no document is open.
 *
 * It is a workspace shelf rather than a landing page — the brand is stated once
 * and quietly, then the screen gets on with the two things you came for: making
 * a document, and returning to one you already made.
 *
 * Everything it lists comes from local storage (src/io/session.js), so it is
 * also the place the app admits where your work actually lives: in this browser.
 */

/** Sizes people actually start from, not a catalogue. */
const TEMPLATES = [
  { name: 'Desktop', width: 1920, height: 1080 },
  { name: 'Square post', width: 1080, height: 1080 },
  { name: 'Story', width: 1080, height: 1920 },
  { name: 'Social banner', width: 1200, height: 630 },
  { name: 'A4 at 300 dpi', width: 2480, height: 3508 },
  { name: 'Sketch', width: 800, height: 600 },
];

/** The template preview rectangle is drawn to fit inside this box, in px. */
const PREVIEW_BOX = { w: 64, h: 46 };

/**
 * The thumbnail frame's aspect ratio. Kept in step with `.pk-wc-thumb` in the
 * stylesheet: a thumbnail wider than the frame is sized by width, a taller one
 * by height, which is the one decision pure CSS cannot make for itself.
 */
const FRAME_RATIO = 16 / 10;

let root = null;
let recentsHost = null;
let storageEl = null;
let visible = false;
let wired = false;

/** Object URLs handed to <img>; revoked on every repaint or they leak. */
let thumbUrls = [];
/** Guards against an older repaint landing after a newer one. */
let paintToken = 0;

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/**
 * Byte sizes for prose, e.g. "340 MB".
 *
 * `formatBytes` in core/util.js is the status-bar style ("1.2 M") — terse for a
 * dense readout, but wrong in a sentence about how much of your disk is in use.
 */
function formatSize(bytes) {
  const n = Math.max(0, bytes || 0);
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1000) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1000) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** Whole calendar days from `then` to `now`, so "yesterday" means yesterday. */
function calendarDaysAgo(then, now) {
  const a = new Date(then).setHours(0, 0, 0, 0);
  const b = new Date(now).setHours(0, 0, 0, 0);
  return Math.round((b - a) / 86400000);
}

/**
 * "2 minutes ago", "yesterday", "12 Mar".
 *
 * Minutes and hours win under six hours even across midnight — being told that
 * something you touched 90 minutes ago happened "yesterday" is technically true
 * and useless.
 */
function relativeTime(ms) {
  const now = Date.now();
  const diff = Math.max(0, now - ms);
  if (diff < 45000) return 'just now';
  const min = Math.round(diff / 60000);
  if (min < 2) return 'a minute ago';
  if (min < 60) return `${min} minutes ago`;
  const hr = Math.round(diff / 3600000);
  if (diff < 6 * 3600000) return hr < 2 ? 'an hour ago' : `${hr} hours ago`;
  const days = calendarDaysAgo(ms, now);
  if (days <= 0) return `${hr} hours ago`;
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

function header() {
  const newDoc = () => import('./dialogs/new-document.js').then((m) => m.showNewDocumentDialog());
  const openFile = () => {
    const input = document.getElementById('file-input');
    if (input) input.click();
  };

  return el('header.pk-wc-head', {},
    el('div.pk-wc-lock', {},
      el('span.pk-wc-mark', { html: brandMark({ size: 56, title: BRAND.name }) }),
      el('div', {},
        el('div.pk-wc-word', { text: BRAND.name }),
        el('div.pk-wc-tag', { text: BRAND.tagline })
      )
    ),
    el('p.pk-wc-lede', {
      text: 'A layered image editor that runs entirely on your machine. '
        + 'Start a blank canvas, open a photo, or pick up where you left off.',
    }),
    el('div.pk-wc-actions', {},
      el('button.pk-btn.primary', { type: 'button', text: 'New document', onclick: newDoc }),
      el('button.pk-btn', { type: 'button', text: 'Open file…', onclick: openFile }),
      el('span.pk-wc-drop', { text: 'or drop a file anywhere on this window' })
    )
  );
}

function sectionLabel(text) {
  return el('div.pk-wc-sec-head', {}, el('span.pk-micro', { text }));
}

function templateCard(t) {
  const s = Math.min(PREVIEW_BOX.w / t.width, PREVIEW_BOX.h / t.height);
  const w = Math.max(9, Math.round(t.width * s));
  const h = Math.max(9, Math.round(t.height * s));

  return el('button.pk-wc-tpl', {
    type: 'button',
    title: `New ${t.width} × ${t.height} document`,
    onclick: () => app.newDocument({ width: t.width, height: t.height, name: t.name, fill: '#ffffff' }),
  },
  el('span.pk-wc-tpl-stage', {},
    el('span.pk-wc-tpl-rect', { style: { width: `${w}px`, height: `${h}px` } })),
  el('span.pk-wc-tpl-name', { text: t.name }),
  el('span.pk-wc-tpl-dim.pk-tabular', { text: `${t.width} × ${t.height}` }));
}

function templates() {
  return el('section.pk-wc-sec', {},
    sectionLabel('Start from a template'),
    el('div.pk-wc-tpls', {}, ...TEMPLATES.map(templateCard)));
}

function thumbnail(rec) {
  if (!rec.thumb) {
    return el('span.pk-wc-noshot', {}, el('span', { html: icon('image', { size: 20 }) }));
  }
  const url = URL.createObjectURL(rec.thumb);
  thumbUrls.push(url);
  const ratio = (rec.width || 1) / (rec.height || 1);
  const fit = ratio >= FRAME_RATIO ? 'wide' : 'tall';
  return el(`span.pk-wc-shot.pk-checker.${fit}`, { style: { aspectRatio: `${rec.width} / ${rec.height}` } },
    el('img', { src: url, alt: '', draggable: 'false' }));
}

function recentCard(rec) {
  const stamp = new Date(rec.updatedAt);
  const open = el('button.pk-wc-open', {
    type: 'button',
    title: `${rec.name} — last saved ${stamp.toLocaleString()}`,
    onclick: () => { openRecent(rec.id); },
  },
  el('span.pk-wc-thumb', {}, thumbnail(rec)),
  el('span.pk-wc-body', {},
    el('span.pk-wc-name.pk-truncate', { text: rec.name }),
    el('span.pk-wc-sub.pk-tabular', { text: `${rec.width} × ${rec.height} · ${plural(rec.layers || 1, 'layer')}` }),
    el('span.pk-wc-sub.pk-tabular', { text: `${relativeTime(rec.updatedAt)} · ${formatSize(rec.bytes)}` })));

  const forget = el('button.pk-wc-forget', {
    type: 'button',
    title: 'Remove from this browser',
    'aria-label': `Remove ${rec.name} from this browser`,
    html: icon('close', { size: 12 }),
    onclick: async () => {
      const ok = await confirmDialog(
        `Remove "${rec.name}" from this browser? The stored copy is deleted and cannot be recovered.`,
        'Remove project', 'Remove', { danger: true });
      if (ok) await forgetRecent(rec.id);
    },
  });

  return el('div.pk-wc-recent', {}, open, forget);
}

/* ------------------------------------------------------------------ */
/* Painting                                                            */
/* ------------------------------------------------------------------ */

function releaseThumbs() {
  for (const url of thumbUrls) URL.revokeObjectURL(url);
  thumbUrls = [];
}

function paintRecents(list) {
  releaseThumbs();
  recentsHost.textContent = '';
  if (!list.length) {
    recentsHost.className = 'pk-wc-empty';
    recentsHost.appendChild(el('p.pk-wc-none', {
      text: 'No projects yet — anything you make is kept here automatically as you work.',
    }));
    return;
  }
  recentsHost.className = 'pk-wc-recents';
  for (const rec of list) recentsHost.appendChild(recentCard(rec));
}

function paintStorage(u) {
  const line = u.count
    ? `${plural(u.count, 'project')} · ${formatSize(u.bytes)} kept in this browser`
    : 'Your work is kept in this browser as you go';
  storageEl.textContent = line;
  storageEl.title = u.quota && u.quota.quota
    ? `This site is using ${formatSize(u.quota.used)} of about ${formatSize(u.quota.quota)} available. Nothing leaves your machine.`
    : 'Projects are stored locally. Nothing leaves your machine.';
}

/**
 * Re-read the recent projects and the storage figures, and repaint.
 * Safe to call before `installWelcome`, and safe to call repeatedly.
 */
export function refreshWelcome() {
  if (!root) return;
  const token = ++paintToken;
  Promise.all([listRecent(), storageUsage()]).then(([list, u]) => {
    if (token !== paintToken || !root) return;
    paintRecents(list);
    paintStorage(u);
  }).catch((err) => {
    console.warn('[welcome] could not read local projects:', err && err.message);
  });
}

/* ------------------------------------------------------------------ */
/* Mounting                                                            */
/* ------------------------------------------------------------------ */

/** Show whenever no document is open, hide otherwise. */
function sync() {
  if (!root) return;
  const show = !app.activeDoc;
  if (show === visible) return;
  visible = show;
  root.hidden = !show;
  // Coming back from a document: the list, and the clocks in it, are stale.
  if (show) refreshWelcome();
}

function keyHint(keys, label) {
  const parts = [];
  keys.forEach((k, i) => {
    // macOS writes chords as ⌘N; everywhere else the plus is expected.
    if (i && !IS_MAC) parts.push('+');
    parts.push(el('kbd', { text: k }));
  });
  return el('span.pk-wc-key', {}, ...parts, el('span', { text: label }));
}

function footer() {
  storageEl = el('span.pk-wc-storage');
  const mod = IS_MAC ? '⌘' : 'Ctrl';
  return el('footer.pk-wc-foot', {},
    el('span.pk-wc-keys', {},
      keyHint([mod, 'N'], 'New document'),
      keyHint([mod, 'O'], 'Open file')),
    storageEl);
}

/**
 * Mount the start screen into the canvas area. It fills the area and shows
 * itself whenever no document is open.
 * @param {HTMLElement} areaEl the `.pk-canvas-area` element
 * @returns {HTMLElement} the mounted root
 */
export function installWelcome(areaEl) {
  if (root) { releaseThumbs(); root.remove(); }

  recentsHost = el('div.pk-wc-recents');
  root = el('div.pk-welcome', {},
    el('div.pk-wc-inner', {},
      header(),
      templates(),
      el('section.pk-wc-sec', {}, sectionLabel('Recent projects'), recentsHost),
      footer()));
  areaEl.appendChild(root);

  // The subscriptions read the module-level `root`, so they survive a remount
  // and must only ever be made once — a second set would fire twice per event.
  if (!wired) {
    wired = true;
    app.on('docs-change', sync);
    app.on('active-doc', sync);
    sessionEvents.on('recents-change', () => { if (visible) refreshWelcome(); });
  }

  visible = !!app.activeDoc; // the opposite of the truth, so sync() acts
  sync();
  return root;
}
