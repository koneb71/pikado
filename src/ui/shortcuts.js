import { app } from '../core/app.js';
import { getTool, toolGroups } from '../tools/base.js';
import { buildBindingMap, eventBinding, getCommand, isEnabled, runCommand } from '../commands/registry.js';
import { installRulers } from './rulers.js';
import './shortcuts.css';

/**
 * Global keyboard handling: command accelerators, tool letters, the space-bar
 * hand override, colour keys and the workspace chrome toggles.
 *
 * The active tool always gets first refusal on a key (so `[` / `]` and friends
 * reach brush tools); anything it does not consume falls through to the command
 * binding map and then to the built-in shortcuts below.
 */

/** letter -> the tool that letter selects by default. */
const TOOL_KEYS = {
  v: 'move',
  m: 'marquee-rect',
  l: 'lasso',
  w: 'quick-select',
  c: 'crop',
  i: 'eyedropper',
  j: 'spot-healing',
  b: 'brush',
  s: 'clone-stamp',
  y: 'history-brush',
  e: 'eraser',
  g: 'gradient',
  r: 'blur',
  o: 'dodge',
  p: 'pen',
  t: 'type',
  a: 'path-select',
  u: 'rectangle',
  h: 'hand',
  z: 'zoom',
};

const SCREEN_MODES = ['standard', 'full-menu', 'full'];
const SCREEN_MODE_NAMES = {
  standard: 'Standard Screen Mode',
  'full-menu': 'Full Screen With Menu Bar',
  full: 'Full Screen Mode',
};

let screenMode = 'standard';
let panelsHidden = false;
let rightHidden = false;

/** Remembers the last tool used inside each tool group, for letter cycling. */
const lastInGroup = new Map();
app.on('tool-change', (t) => {
  if (t && t.group) lastInGroup.set(t.group, t.id);
});

/** @type {Map<string,string>|null} */
let bindings = null;
let spaceDown = false;
let installed = false;

/**
 * Install the global key handlers.
 * @param {import('./canvas-view.js').CanvasView} canvasView
 */
export function installShortcuts(canvasView) {
  if (installed) return;
  installed = true;

  app.on('ready', () => { bindings = buildBindingMap(); });

  window.addEventListener('keydown', (e) => onKeyDown(e, canvasView));
  window.addEventListener('keyup', (e) => onKeyUp(e, canvasView));
  window.addEventListener('blur', () => releaseSpace(canvasView));

  // The rulers live in the canvas area and are not built by main.js.
  if (canvasView && canvasView.area) installRulers(canvasView.area);
}

/* ------------------------------------------------------------------ */
/* Key handling                                                        */
/* ------------------------------------------------------------------ */

function isEditable(target) {
  if (!target || target === document.body) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}

function onKeyDown(e, canvasView) {
  if (isEditable(e.target) && e.key !== 'Escape') return;

  // 1. The active tool sees every key first.
  if (app.tool && typeof app.tool.onKeyDown === 'function') {
    let consumed = false;
    try {
      consumed = app.tool.onKeyDown(e) === true;
    } catch (err) {
      console.error('[tool.onKeyDown]', err);
    }
    if (consumed) {
      e.preventDefault();
      return;
    }
  }

  // 2. Space = temporary Hand tool.
  if (e.code === 'Space' || e.key === ' ') {
    if (!spaceDown) {
      spaceDown = true;
      if (canvasView) canvasView.setSpaceDown(true);
      app.pushTempTool('hand');
    }
    e.preventDefault();
    return;
  }

  // 3. Registered command accelerators.
  if (!bindings) bindings = buildBindingMap();
  const binding = eventBinding(e);
  const cmdId = bindings.get(binding);
  if (cmdId && getCommand(cmdId)) {
    e.preventDefault();
    if (isEnabled(cmdId)) runCommand(cmdId);
    return;
  }

  const primary = e.metaKey || e.ctrlKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  // 4. Tool letters (Shift cycles inside the group).
  if (!primary && !e.altKey && /^Key[A-Z]$/.test(e.code)) {
    const letter = e.code.slice(3).toLowerCase();
    if (letter === 'x' && !e.shiftKey) { app.swapColors(); e.preventDefault(); return; }
    if (letter === 'd' && !e.shiftKey) { app.resetColors(); e.preventDefault(); return; }
    if (letter === 'q' && !e.shiftKey) { toggleQuickMask(); e.preventDefault(); return; }
    if (letter === 'f' && !e.shiftKey) { cycleScreenMode(); e.preventDefault(); return; }
    if (TOOL_KEYS[letter]) {
      selectToolFor(letter, e.shiftKey);
      e.preventDefault();
      return;
    }
  }

  // 5. Panel visibility.
  if (e.key === 'Tab' && !primary && !e.altKey) {
    if (e.shiftKey) toggleRightDock();
    else togglePanels();
    e.preventDefault();
    return;
  }

  // 6. Zoom fallbacks (only reached when no command claimed them).
  if (primary && !e.altKey) {
    if (key === '=' || key === '+') { zoomStep(1); e.preventDefault(); return; }
    if (key === '-' || key === '_') { zoomStep(-1); e.preventDefault(); return; }
    if (key === '0') { app.fitView(); e.preventDefault(); return; }
    if (key === '1') { setZoom(1); e.preventDefault(); return; }
  }

  // 7. Commit / cancel the current interaction.
  if (e.key === 'Enter' && !primary) {
    if (app.tool) {
      try { app.tool.commit(); } catch (err) { console.error(err); }
    }
    e.preventDefault();
    return;
  }
  if (e.key === 'Escape') {
    if (app.tool) {
      try { app.tool.cancel(); } catch (err) { console.error(err); }
    }
    e.preventDefault();
  }
}

function onKeyUp(e, canvasView) {
  if (app.tool && typeof app.tool.onKeyUp === 'function') {
    try {
      if (app.tool.onKeyUp(e) === true) return;
    } catch (err) {
      console.error('[tool.onKeyUp]', err);
    }
  }
  if (e.code === 'Space' || e.key === ' ') releaseSpace(canvasView);
}

function releaseSpace(canvasView) {
  if (!spaceDown) return;
  spaceDown = false;
  if (canvasView) canvasView.setSpaceDown(false);
  app.popTempTool();
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

function groupOf(toolId) {
  const t = getTool(toolId);
  return t ? t.group : null;
}

function groupTools(groupId) {
  const g = toolGroups.find((x) => x.id === groupId);
  return g ? g.tools : [];
}

function selectToolFor(letter, cycle) {
  const defaultId = TOOL_KEYS[letter];
  const group = groupOf(defaultId);
  if (!group) {
    if (getTool(defaultId)) app.setTool(defaultId);
    return;
  }
  const members = groupTools(group);
  const activeIsHere = app.tool && app.tool.group === group;

  if (cycle && members.length > 1) {
    const i = activeIsHere ? members.findIndex((t) => t.id === app.tool.id) : -1;
    const next = members[(i + 1) % members.length];
    lastInGroup.set(group, next.id);
    app.setTool(next.id);
    return;
  }
  if (activeIsHere) return; // already in this group — keep the current member
  const remembered = lastInGroup.get(group);
  app.setTool(remembered && getTool(remembered) ? remembered : defaultId);
}

/* ------------------------------------------------------------------ */
/* Zoom helpers                                                        */
/* ------------------------------------------------------------------ */

function zoomStep(dir) {
  if (!app.activeDoc) return;
  app.viewport.zoomStep(dir);
  app.emit('view-change');
  app.requestRender();
}

function setZoom(scale) {
  if (!app.activeDoc) return;
  app.viewport.setScale(scale);
  app.emit('view-change');
  app.requestRender();
}

/* ------------------------------------------------------------------ */
/* Workspace chrome (shared with the toolbar)                          */
/* ------------------------------------------------------------------ */

/** Toggle Quick Mask on the active document. */
export function toggleQuickMask() {
  for (const id of ['select.quick-mask', 'edit.quick-mask', 'view.quick-mask']) {
    if (getCommand(id)) {
      runCommand(id);
      return;
    }
  }
  const doc = app.activeDoc;
  if (!doc) return;
  doc.quickMask = !doc.quickMask;
  if (doc.quickMask && !doc.selection.active) {
    doc.selection.set(new Uint8ClampedArray(doc.width * doc.height));
  }
  doc.touch('quick-mask');
  app.emit('doc-selection', doc);
  app.toast(doc.quickMask ? 'Quick Mask on' : 'Quick Mask off');
}

/** @returns {string} the current screen mode id. */
export function getScreenMode() {
  return screenMode;
}

/** Human name of a screen mode, for tooltips. */
export function screenModeLabel(mode = screenMode) {
  return SCREEN_MODE_NAMES[mode] || mode;
}

/**
 * Switch screen mode.
 * @param {'standard'|'full-menu'|'full'} mode
 */
export function setScreenMode(mode) {
  if (!SCREEN_MODES.includes(mode)) return;
  screenMode = mode;
  const root = document.documentElement;
  root.classList.toggle('pk-screen-full-menu', mode === 'full-menu');
  root.classList.toggle('pk-screen-full', mode === 'full');
  app.emit('screen-mode', mode);
  app.requestRender();
}

/** Cycle Standard -> Full with menu bar -> Full. */
export function cycleScreenMode() {
  const next = SCREEN_MODES[(SCREEN_MODES.indexOf(screenMode) + 1) % SCREEN_MODES.length];
  setScreenMode(next);
  app.toast(screenModeLabel(next));
}

/** Tab — hide/show the toolbar, options bar and every dock. */
export function togglePanels(force) {
  panelsHidden = force === undefined ? !panelsHidden : !!force;
  if (!panelsHidden) rightHidden = false;
  syncChrome();
}

/** Shift+Tab — hide/show only the right-hand dock. */
export function toggleRightDock(force) {
  rightHidden = force === undefined ? !rightHidden : !!force;
  syncChrome();
}

export function panelsAreHidden() {
  return panelsHidden;
}

function syncChrome() {
  const root = document.documentElement;
  root.classList.toggle('pk-hide-panels', panelsHidden);
  root.classList.toggle('pk-hide-right', rightHidden && !panelsHidden);
  app.emit('chrome-change', { panelsHidden, rightHidden });
  app.requestRender();
}
