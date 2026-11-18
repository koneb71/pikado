'use strict';

/**
 * Automatic updates from GitHub Releases (electron-updater).
 *
 * Packaged builds only, and only while the page's "Check for updates
 * automatically" preference is on — a manual Check for Updates… works either
 * way. It checks at launch and every six hours, downloads in the background and
 * tells the page, which shows an "Update ready — Restart" pill. Restarting goes
 * through the normal quit, so unsaved work still gets its prompt; an update
 * that is not installed then is installed at the next quit.
 *
 * macOS will only install an update into a signed app. An unsigned Mac build
 * (`pikadoSigned` is false in its package.json) therefore only checks, and
 * offers the release page instead.
 *
 * The page hears every change as `{status, version?, manual?, message?}` where
 * status is idle | checking | none | available | downloading | ready | error.
 */

const RELEASES_URL = 'https://github.com/koneb71/pikado/releases/latest';
const INTERVAL_MS = 6 * 60 * 60 * 1000;

function createUpdater({ canInstall, send, log = console }) {
  // Required lazily: electron-updater reads the packaged app-update.yml, which
  // an unpackaged (development) run does not have.
  const { autoUpdater } = require('electron-updater');
  autoUpdater.logger = null;
  autoUpdater.autoDownload = canInstall;
  autoUpdater.autoInstallOnAppQuit = canInstall;

  let enabled = false;
  let timer = null;
  let manual = false;
  let state = { status: 'idle' };

  const set = (next) => {
    state = { ...next, manual, releasesUrl: RELEASES_URL };
    send(state);
  };

  autoUpdater.on('checking-for-update', () => set({ status: 'checking' }));
  autoUpdater.on('update-not-available', () => {
    set({ status: 'none' });
    manual = false;
  });
  autoUpdater.on('update-available', (info) => {
    set({ status: canInstall ? 'downloading' : 'available', version: info && info.version });
    manual = false;
  });
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info && info.version }));
  autoUpdater.on('error', (err) => {
    log.warn('[updater]', err && err.message);
    set({ status: 'error', message: (err && err.message) || String(err) });
    manual = false;
  });

  const check = (byUser = false) => {
    manual = byUser;
    return autoUpdater.checkForUpdates().catch((err) => {
      log.warn('[updater] check failed:', err && err.message);
    });
  };

  return {
    get state() { return state; },
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      clearInterval(timer);
      timer = null;
      if (on) {
        check(false);
        timer = setInterval(() => check(false), INTERVAL_MS);
      }
    },
    check,
    install() {
      if (state.status === 'ready') autoUpdater.quitAndInstall();
    },
  };
}

module.exports = { createUpdater, RELEASES_URL };
