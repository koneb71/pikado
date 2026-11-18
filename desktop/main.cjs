'use strict';

/**
 * Pikado's desktop app: the main process.
 *
 * One window showing the same build the web deploys, served from `app://pikado/`
 * (lib/protocol.cjs). Everything the page may ask of the system goes through the
 * small bridge in preload.cjs; this file answers it and owns what a browser tab
 * cannot do: opening files handed over by the OS, writing them back, the macOS
 * menu bar, the unsaved-changes prompt on quit, and updates.
 *
 * Development flags (ignored in a packaged build):
 *   --pikado-url=<origin>/   load the page from the Vite dev server instead
 *   --pikado-tests[=query]   run the browser test suite at <url>tests/, print the
 *                            result and exit 0 (all passed) or 1
 *   --pikado-devtools        open the developer tools
 * Any build:
 *   --pikado-smoke           load, wait for the app to start, print and exit
 */

const {
  app, BrowserWindow, Menu, dialog, ipcMain, protocol, screen, session, shell,
} = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { APP_SCHEME, APP_ORIGIN, mimeFor, resolveAppPath, isAppUrl } = require('./lib/protocol.cjs');
const { FileTokens, writeAtomic, isOpenable } = require('./lib/files.cjs');
const { buildTemplate } = require('./lib/menu.cjs');
const windowState = require('./lib/window-state.cjs');
const { createUpdater, RELEASES_URL } = require('./lib/updater.cjs');
const pkg = require('./package.json');

const IS_MAC = process.platform === 'darwin';

protocol.registerSchemesAsPrivileged([{
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
}]);
app.enableSandbox();

/* ------------------------------------------------------------------ */
/* Arguments                                                           */
/* ------------------------------------------------------------------ */

function parseArgs(argv, cwd = process.cwd()) {
  const out = { url: null, tests: null, smoke: false, devtools: false, files: [] };
  for (const a of argv.slice(1)) {
    if (a.startsWith('--pikado-url=')) out.url = a.slice('--pikado-url='.length);
    else if (a === '--pikado-tests') out.tests = '';
    else if (a.startsWith('--pikado-tests=')) out.tests = a.slice('--pikado-tests='.length);
    else if (a === '--pikado-smoke') out.smoke = true;
    else if (a === '--pikado-devtools') out.devtools = true;
    else if (!a.startsWith('-') && isOpenable(a)) {
      const abs = path.resolve(cwd, a);
      if (fs.existsSync(abs)) out.files.push(abs);
    }
  }
  if (app.isPackaged) {
    out.url = null;
    out.tests = null;
    out.devtools = false;
  }
  if (out.tests !== null && !out.url) out.tests = null;
  return out;
}

const args = parseArgs(process.argv);
const devOrigin = args.url ? new URL(args.url).origin : null;
const automated = args.tests !== null || args.smoke;
const rendererDir = app.isPackaged ? path.join(__dirname, 'renderer') : path.join(__dirname, '..', 'dist');
const startUrl = args.url
  ? (args.tests !== null ? new URL(`tests/?${args.tests}`, args.url).href : args.url)
  : `${APP_ORIGIN}/index.html`;

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

/** @type {BrowserWindow|null} */
let win = null;
let pageReady = false;
/** Paths the OS handed over before the page could take them. */
let pendingFiles = [...args.files];
const tokens = new FileTokens();
let lastSaveDir = null;
let updater = null;
let wantAutoUpdate = false;
/** The page's translations for the strings this process shows. */
let strings = {};
let lastMenu = null;

const S = (key, fallback) => strings[key] || fallback;

/** A message from our own page's main frame, and nothing else. */
function trusted(event) {
  const frame = event.senderFrame;
  return !!(win && frame && frame === win.webContents.mainFrame && isAppUrl(frame.url, devOrigin));
}

function memoryDefaultMB() {
  const quarter = os.totalmem() / 1048576 / 4;
  return Math.max(512, Math.min(4096, Math.round(quarter / 64) * 64));
}

/* ------------------------------------------------------------------ */
/* Single instance and files from the OS                               */
/* ------------------------------------------------------------------ */

// A second launch hands its files to the running window and exits. The test
// and smoke runs stay independent of any app the user has open.
const primary = automated || app.requestSingleInstanceLock();
if (!primary) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv, cwd) => {
    const { files } = parseArgs(argv, cwd);
    if (files.length) openPaths(files);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

// Finder and the Dock deliver files this way, possibly before `ready`.
app.on('open-file', (event, file) => {
  event.preventDefault();
  if (!isOpenable(file)) return;
  openPaths([file]);
});

function openPaths(paths) {
  pendingFiles.push(...paths);
  if (app.isReady() && !win) createWindow();
  flushFiles();
}

async function flushFiles() {
  if (!win || !pageReady || !pendingFiles.length) return;
  const paths = pendingFiles.splice(0);
  const files = [];
  for (const file of paths) {
    try {
      const bytes = await fsp.readFile(file);
      files.push({ token: tokens.mint(file), name: path.basename(file), bytes });
      app.addRecentDocument(file);
    } catch (err) {
      console.warn('[desktop] could not read', file, err && err.message);
    }
  }
  if (files.length && win) win.webContents.send('desktop:open-files', files);
}

/* ------------------------------------------------------------------ */
/* The window                                                          */
/* ------------------------------------------------------------------ */

function createWindow() {
  const dir = app.getPath('userData');
  const state = windowState.load(dir, screen.getAllDisplays());
  win = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(Number.isFinite(state.x) ? { x: state.x, y: state.y } : {}),
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Pikado',
    backgroundColor: '#1b1b1f',
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    // Centred in the page's 42px app bar, which src/io/desktop.css makes the title strip.
    trafficLightPosition: IS_MAC ? { x: 14, y: 14 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      // The test suite asserts time limits; a background window must not be
      // throttled while it runs.
      backgroundThrottling: !automated,
    },
  });
  if (state.maximized) win.maximize();
  windowState.track(win, dir);

  win.once('ready-to-show', () => {
    if (automated) win.showInactive();
    else win.show();
  });
  win.on('closed', () => {
    win = null;
    pageReady = false;
  });
  win.on('enter-full-screen', () => win.webContents.send('desktop:fullscreen', true));
  win.on('leave-full-screen', () => win.webContents.send('desktop:fullscreen', false));

  const wc = win.webContents;
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) pageReady = false;
  });

  // The page blocks unload while it holds unsaved work that autosave is not
  // keeping. A browser asks the user; Electron would silently refuse to close.
  wc.on('will-prevent-unload', (event) => {
    if (automated) {
      event.preventDefault();
      return;
    }
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: [S('quitAnyway', 'Quit Without Saving'), S('cancel', 'Cancel')],
      defaultId: 1,
      cancelId: 1,
      message: S('unsavedTitle', 'You have unsaved changes.'),
      detail: S('unsavedDetail', 'Documents that have not been saved or autosaved will be lost.'),
    });
    if (choice === 0) event.preventDefault();
  });

  if (args.devtools) wc.openDevTools({ mode: 'detach' });
  win.loadURL(startUrl);

  if (args.tests !== null) runTests();
  else if (args.smoke) runSmoke();
}

/* ------------------------------------------------------------------ */
/* Automation: the test suite and the smoke check                      */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    if (!win) return null;
    const value = await win.webContents.executeJavaScript(expression, true).catch(() => null);
    if (value) return value;
  }
  return null;
}

async function runTests() {
  const result = await poll(`(() => {
    if (!window.__pikadoTestsDone) return null;
    const r = window.__pikadoTests;
    return {
      passed: r.passed, failed: r.failed, errors: r.errors, suites: r.suites.length,
      fails: r.suites.flatMap((s) => s.results.filter((a) => !a.pass).map((a) => s.name + ' :: ' + a.message)),
      threw: r.suites.filter((s) => s.error).map((s) => s.name + ' :: ' + s.error),
      userAgent: navigator.userAgent, webgpu: !!navigator.gpu,
    };
  })()`, 20 * 60 * 1000);
  if (!result) {
    console.error('[pikado tests] timed out or the page went away');
    app.exit(2);
    return;
  }
  console.log(`[pikado tests] ${result.userAgent}`);
  console.log(`[pikado tests] navigator.gpu: ${result.webgpu ? 'yes' : 'no'}`);
  for (const f of result.fails) console.log(`  FAIL ${f}`);
  for (const f of result.threw) console.log(`  THREW ${f}`);
  console.log(`[pikado tests] ${result.suites} suites, ${result.passed} passed, ${result.failed} failed, ${result.errors} threw`);
  app.exit(result.failed || result.errors ? 1 : 0);
}

async function runSmoke() {
  const result = await poll(`(() => window.pikado && window.pikado.ready ? {
    ready: true, desktop: !!window.pikadoDesktop, webgpu: !!navigator.gpu, url: location.href,
  } : null)()`, 60 * 1000);
  // The page sends its menus, and opens any files it was given, within moments.
  if (result) await sleep(2000);
  const menu = Menu.getApplicationMenu();
  const menus = menu ? menu.items.map((i) => `${i.label}(${i.submenu ? i.submenu.items.length : 0})`) : [];
  const docs = win ? await win.webContents.executeJavaScript(
    '(window.pikado ? window.pikado.docs : []).map((d) => [d.name, !!(d.fileHandle && d.fileHandle.desktopToken)])', true,
  ).catch(() => []) : [];
  console.log(`[pikado smoke] ${JSON.stringify({ ...(result || { ready: false }), menus, docs })}`);
  app.exit(result && result.ready && result.desktop && (!IS_MAC || menus.length > 3) ? 0 : 1);
}

/* ------------------------------------------------------------------ */
/* The macOS menu bar                                                  */
/* ------------------------------------------------------------------ */

function menuRoles() {
  return {
    hide: () => app.hide(),
    hideOthers: () => Menu.sendActionToFirstResponder('hideOtherApplications:'),
    unhide: () => Menu.sendActionToFirstResponder('unhideAllApplications:'),
    quit: () => app.quit(),
    minimize: () => win && win.minimize(),
    zoom: () => win && (win.isMaximized() ? win.unmaximize() : win.maximize()),
    fullScreen: () => win && win.setFullScreen(!win.isFullScreen()),
    front: () => Menu.sendActionToFirstResponder('arrangeInFront:'),
    reload: () => win && win.webContents.reload(),
    devTools: () => win && win.webContents.toggleDevTools(),
  };
}

function applyMenu(payload) {
  if (!IS_MAC) {
    Menu.setApplicationMenu(null);
    return;
  }
  lastMenu = payload || { menus: [] };
  const template = buildTemplate(lastMenu, {
    appName: app.getName(),
    strings,
    roles: menuRoles(),
    developer: !app.isPackaged,
    onAction: (id, viaKey) => {
      if (win) win.webContents.send('desktop:menu-action', { id, viaKey });
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ */
/* The bridge                                                          */
/* ------------------------------------------------------------------ */

const EDIT_OPS = new Set(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);

function installBridge() {
  ipcMain.on('desktop:info', (event) => {
    event.returnValue = trusted(event) ? {
      platform: process.platform,
      version: app.getVersion(),
      memoryDefaultMB: memoryDefaultMB(),
      updates: app.isPackaged,
      nativeMenu: IS_MAC,
    } : null;
  });

  ipcMain.handle('desktop:ready', (event) => {
    if (!trusted(event)) return false;
    pageReady = true;
    flushFiles();
    return true;
  });

  ipcMain.handle('desktop:token-for-path', (event, file) => {
    if (!trusted(event) || typeof file !== 'string' || !path.isAbsolute(file)) return null;
    return tokens.mint(file);
  });

  ipcMain.handle('desktop:read', async (event, token) => {
    const file = trusted(event) && tokens.path(token);
    if (!file) throw new Error('Unknown file');
    return fsp.readFile(file);
  });

  ipcMain.handle('desktop:write', async (event, token, bytes) => {
    const file = trusted(event) && tokens.path(token);
    if (!file) throw new Error('Unknown file');
    if (!(bytes instanceof Uint8Array)) throw new Error('Expected bytes');
    await writeAtomic(file, bytes);
    app.addRecentDocument(file);
    return true;
  });

  ipcMain.handle('desktop:save-dialog', async (event, opts = {}) => {
    if (!trusted(event) || !win) return null;
    const name = path.basename(String(opts.suggestedName || 'Untitled'));
    const filters = Array.isArray(opts.filters) ? opts.filters
      .filter((f) => f && typeof f.name === 'string' && Array.isArray(f.extensions))
      .map((f) => ({ name: f.name, extensions: f.extensions.map(String) })) : [];
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: path.join(lastSaveDir || app.getPath('documents'), name),
      filters,
    });
    if (canceled || !filePath) return null;
    lastSaveDir = path.dirname(filePath);
    return { token: tokens.mint(filePath), name: path.basename(filePath) };
  });

  ipcMain.on('desktop:set-menu', (event, payload) => {
    if (trusted(event) && payload && Array.isArray(payload.menus)) applyMenu(payload);
  });

  ipcMain.on('desktop:native-edit', (event, op) => {
    if (trusted(event) && EDIT_OPS.has(op) && win) win.webContents[op]();
  });

  ipcMain.on('desktop:set-strings', (event, map) => {
    if (!trusted(event) || !map || typeof map !== 'object') return;
    strings = Object.fromEntries(Object.entries(map).filter(([, v]) => typeof v === 'string'));
    if (lastMenu) applyMenu(lastMenu);
  });

  ipcMain.on('desktop:set-auto-update', (event, on) => {
    if (!trusted(event)) return;
    wantAutoUpdate = !!on;
    if (updater) updater.setEnabled(wantAutoUpdate);
  });

  ipcMain.handle('desktop:check-updates', (event) => {
    if (!trusted(event)) return null;
    if (!updater) return { status: 'unavailable' };
    updater.check(true);
    return updater.state;
  });

  ipcMain.handle('desktop:install-update', (event) => {
    if (trusted(event) && updater) updater.install();
  });

  ipcMain.on('desktop:open-external', (event, url) => {
    if (trusted(event) && typeof url === 'string' && url.startsWith('https://github.com/koneb71/pikado/')) {
      shell.openExternal(url);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Hardening                                                           */
/* ------------------------------------------------------------------ */

const ALLOWED_PERMISSIONS = new Set([
  'clipboard-read', 'clipboard-sanitized-write', 'fileSystem', 'persistent-storage', 'fullscreen',
]);

function harden() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isAppUrl(details.requestingUrl || '', devOrigin));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    ALLOWED_PERMISSIONS.has(permission) && isAppUrl(requestingOrigin || '', devOrigin));

  // Export As and friends download a blob: ask where, starting in Downloads.
  ses.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
  });

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (!isAppUrl(url, devOrigin)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
  });
}

/* ------------------------------------------------------------------ */
/* Startup                                                             */
/* ------------------------------------------------------------------ */

app.whenReady().then(() => {
  if (!primary) return;
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveAppPath(rendererDir, request.url);
    if (!file) return new Response('Not found', { status: 404 });
    try {
      const body = await fsp.readFile(file);
      return new Response(body, { headers: { 'content-type': mimeFor(file) } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  harden();
  installBridge();
  applyMenu(null);

  if (app.isPackaged && !automated) {
    updater = createUpdater({
      canInstall: !IS_MAC || pkg.pikadoSigned === true,
      send: (state) => win && win.webContents.send('desktop:update-state', state),
    });
    updater.setEnabled(wantAutoUpdate);
  }

  createWindow();
  app.on('activate', () => {
    if (!win) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!IS_MAC || automated) app.quit();
});

module.exports = { parseArgs, RELEASES_URL };
