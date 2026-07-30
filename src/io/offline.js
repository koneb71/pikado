import { app } from '../core/app.js';
import { el } from '../core/util.js';
import './offline.css';

/**
 * Offline support: registration of the app-shell worker, plus the one piece of
 * chrome that reports on it.
 *
 * Pikado never needed a server to do its work — every pixel is processed in the
 * tab and every project is stored in IndexedDB — so "offline" only ever meant
 * "the shell could not be downloaded". The worker in public/sw.js fixes that;
 * this module is the client half.
 *
 * The tone here is deliberate. Losing the network is not an error in an app that
 * keeps your work locally, so it gets a quiet pill in the menu bar rather than a
 * red banner, and a reassurance rather than a warning.
 */

const SETTLE_MS = 1400;
const OFFLINE_TOAST = 'Offline — your work is saved in this browser.';
const ONLINE_TOAST = 'Back online.';

let installed = false;
let indicator = null;
let updateBtn = null;

/** Debounce timer, so a flapping connection announces itself once. */
let settleTimer = null;
/** What the user was most recently told, so we never repeat ourselves. */
let announced = null;

/**
 * True when the browser reports no network.
 *
 * `navigator.onLine` is only trustworthy in the negative: false means there is
 * definitely no route out, true means there is a local interface and nothing
 * more. False is the direction this app cares about.
 * @returns {boolean}
 */
export function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * Register the service worker and wire the connection indicator.
 *
 * Safe to call more than once — the second call is a no-op.
 * @returns {boolean} true when this call did the wiring
 */
export function installOffline() {
  if (installed) return false;
  installed = true;

  buildIndicator();
  syncIndicator();

  window.addEventListener('online', onNetworkChange);
  window.addEventListener('offline', onNetworkChange);

  // Starting offline is not news: the user already knows, and the app works
  // regardless. The pill states it once, calmly; a toast on first paint would be
  // noise. Seeding `announced` with the boot state is what suppresses it.
  announced = isOffline() ? 'offline' : 'online';

  registerWorker();
  return true;
}

/* ------------------------------------------------------------------ */
/* The worker                                                          */
/* ------------------------------------------------------------------ */

function registerWorker() {
  if (!('serviceWorker' in navigator)) return;

  // A worker in front of the Vite dev server is actively harmful: it answers
  // module requests from its own cache, so source edits appear to do nothing and
  // HMR fights the cache. Registration is therefore production-only — and any
  // worker left over from testing a build is torn down here, because a dev
  // server and a preview build share an origin often enough that a stale worker
  // would otherwise haunt development.
  if (!import.meta.env.PROD) {
    navigator.serviceWorker.getRegistrations()
      .then((regs) => regs.forEach((reg) => reg.unregister()))
      .catch(() => { /* nothing registered, or workers blocked — either is fine */ });
    return;
  }

  // Resolved against the document so a deployment under a subdirectory finds
  // its own worker and scopes it to that subdirectory.
  const swUrl = new URL('sw.js', document.baseURI).href;

  // An uncontrolled page becoming controlled is the *first* registration, not an
  // update. Recording which case we are in is the only way to tell the two
  // apart when `controllerchange` fires.
  const hadController = !!navigator.serviceWorker.controller;
  let updateAnnounced = false;

  const announceUpdate = () => {
    if (updateAnnounced) return;
    updateAnnounced = true;
    // Never reload on the user's behalf. There may be an uncommitted brush
    // stroke or a half-filled dialog, and losing that to a background upgrade
    // would be a far worse bug than running a version-old build for a minute.
    if (updateBtn) updateBtn.hidden = false;
    app.toast('A new version of Pikado is ready — refresh when you are done to load it.', 'info', 7000);
  };

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) announceUpdate();
  });

  navigator.serviceWorker.register(swUrl).then((reg) => {
    reg.addEventListener('updatefound', () => {
      if (hadController) announceUpdate();
    });
  }).catch((err) => {
    // Private windows and some enterprise policies refuse workers outright. The
    // app stays fully functional; it just will not start without a network.
    console.info('[offline] service worker unavailable:', (err && err.message) || err);
  });
}

/* ------------------------------------------------------------------ */
/* The indicator                                                       */
/* ------------------------------------------------------------------ */

/**
 * Both pills live at the right end of the menu bar.
 *
 * buildMenubar() only ever replaces the children of its own nav and title
 * nodes, so appending to the bar itself survives every later rebuild.
 */
function buildIndicator() {
  const host = document.getElementById('menubar');
  if (!host) return;

  indicator = el('div.pk-net', {
    hidden: true,
    title: 'No network connection. Pikado runs locally and keeps your projects in this browser.',
  },
  el('span.pk-net-dot'),
  el('span.pk-net-label.pk-micro', { text: 'Offline' }));

  updateBtn = el('button.pk-net.pk-net-update', {
    hidden: true,
    type: 'button',
    title: 'Reload to run the newest version of Pikado.',
    onclick: () => location.reload(),
  },
  el('span.pk-net-dot'),
  el('span.pk-net-label.pk-micro', { text: 'Update ready' }));

  host.append(indicator, updateBtn);
}

function syncIndicator() {
  if (indicator) indicator.hidden = !isOffline();
}

/**
 * React to an `online`/`offline` event.
 *
 * The pill flips at once — it is a state readout, and lagging would make it
 * wrong — but the toast waits out a settling period. A tunnel or a Wi-Fi
 * handover produces a burst of both events, and one message per bounce would be
 * worse than saying nothing at all.
 */
function onNetworkChange() {
  syncIndicator();
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    const state = isOffline() ? 'offline' : 'online';
    if (state === announced) return;
    announced = state;
    if (state === 'offline') app.toast(OFFLINE_TOAST, 'info', 5000);
    else app.toast(ONLINE_TOAST, 'ok', 2000);
  }, SETTLE_MS);
}
