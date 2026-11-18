'use strict';

/**
 * The bridge: everything the page may ask of the desktop, as
 * `window.pikadoDesktop`. Runs sandboxed, with context isolation, in the main
 * frame only; the page never sees ipcRenderer, Node or a file path.
 *
 * src/io/desktop.js is the only page code that uses it. Its absence is how the
 * page knows it is running in a browser.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const info = ipcRenderer.sendSync('desktop:info');

/** Subscribe to a main-process event; returns the unsubscribe function. */
const listen = (channel) => (callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

if (info) {
  contextBridge.exposeInMainWorld('pikadoDesktop', Object.freeze({
    platform: info.platform,
    version: info.version,
    memoryDefaultMB: info.memoryDefaultMB,
    /** Whether this build can update itself (a packaged app). */
    updates: info.updates,
    /** Whether the menus live in the system menu bar (macOS). */
    nativeMenu: info.nativeMenu,

    /** The page is listening: deliver any files the OS has handed over. */
    ready: () => ipcRenderer.invoke('desktop:ready'),
    /** Files from the OS: [{token, name, bytes}]. */
    onOpenFiles: listen('desktop:open-files'),
    /** A token for a File the user picked or dropped, or null (no file on disk). */
    tokenForFile: (file) => {
      let file_path = '';
      try {
        file_path = webUtils.getPathForFile(file);
      } catch {
        file_path = '';
      }
      return file_path ? ipcRenderer.invoke('desktop:token-for-path', file_path) : Promise.resolve(null);
    },
    readFile: (token) => ipcRenderer.invoke('desktop:read', token),
    writeFile: (token, bytes) => ipcRenderer.invoke('desktop:write', token, bytes),
    /** The system Save dialog: {token, name} or null when cancelled. */
    saveDialog: (opts) => ipcRenderer.invoke('desktop:save-dialog', opts),

    /** Replace the macOS menu bar with this snapshot of the page's menus. */
    setMenu: (payload) => ipcRenderer.send('desktop:set-menu', payload),
    /** A menu item was chosen: {id, viaKey}. */
    onMenuAction: listen('desktop:menu-action'),
    /** Run a text-editing command (copy, paste, …) in the focused field. */
    nativeEdit: (op) => ipcRenderer.send('desktop:native-edit', op),
    /** Translations for the few strings the main process shows itself. */
    setStrings: (map) => ipcRenderer.send('desktop:set-strings', map),
    onFullScreen: listen('desktop:fullscreen'),

    onUpdateState: listen('desktop:update-state'),
    checkForUpdates: () => ipcRenderer.invoke('desktop:check-updates'),
    installUpdate: () => ipcRenderer.invoke('desktop:install-update'),
    setAutoUpdate: (on) => ipcRenderer.send('desktop:set-auto-update', !!on),
    openReleases: (url) => ipcRenderer.send('desktop:open-external', url),
  }));
}
