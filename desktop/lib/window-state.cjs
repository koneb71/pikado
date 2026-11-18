'use strict';

/**
 * The window's size and position, remembered between launches in
 * `<userData>/window-state.json`. A saved position that is no longer on any
 * display (a monitor was unplugged) is dropped, so the window never opens
 * off-screen.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT = { width: 1440, height: 900, maximized: false };

function load(dir, displays) {
  let state = { ...DEFAULT };
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'window-state.json'), 'utf8'));
    if (saved && saved.width > 0 && saved.height > 0) state = { ...state, ...saved };
  } catch {
    /* first launch, or an unreadable file: the defaults */
  }
  if (Number.isFinite(state.x) && Number.isFinite(state.y)) {
    const visible = (displays || []).some(({ workArea: a }) =>
      state.x < a.x + a.width && state.x + state.width > a.x && state.y < a.y + a.height && state.y + state.height > a.y);
    if (!visible) {
      delete state.x;
      delete state.y;
    }
  }
  return state;
}

/** Save the window's bounds whenever it stops moving or resizing, and on close. */
function track(win, dir) {
  let timer = null;
  const save = () => {
    if (win.isDestroyed()) return;
    const maximized = win.isMaximized() || win.isFullScreen();
    const bounds = maximized ? win.getNormalBounds() : win.getBounds();
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'window-state.json'), JSON.stringify({ ...bounds, maximized }));
    } catch {
      /* a read-only profile: the next launch uses the defaults */
    }
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  win.on('resize', later);
  win.on('move', later);
  win.on('close', save);
}

module.exports = { load, track };
