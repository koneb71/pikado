import { app } from '../core/app.js';
import { popupMenu, closeMenu } from './panel-host.js';
import { getCommand, isEnabled, isChecked, labelOf, formatAccel, runCommand } from '../commands/registry.js';

/**
 * The canvas context menu.
 *
 * Right-clicking the artboard offers what the active tool can do here, the way a
 * desktop editor does. Tools contribute their own entries by implementing
 * `contextMenu(e)` (see `Tool` in src/tools/base.js); this module resolves those
 * entries, appends the items that make sense for any tool, and shows the result
 * through the shared `popupMenu` the panels already use.
 *
 * Item shapes accepted from a tool:
 *   {command: 'select.deselect'}            — label, accelerator and enabled
 *                                             state all come from the registry
 *   {command: 'select.deselect', label: '…'} — same, with overrides
 *   {label, run, checked, disabled, accel}  — an explicit entry
 *   {separator: true} / {header: 'Text'}
 *
 * A tool returning `[]` (or nothing) still gets the shared tail, so right-click
 * is never a dead gesture.
 */

/** Shorthand for a command-backed item. */
export function cmd(id, over = {}) {
  return { command: id, ...over };
}

/** `sep()` reads better than a bare object in a long list. */
export function sep() {
  return { separator: true };
}

/**
 * Turn tool-supplied entries into `popupMenu` items, resolving command refs and
 * dropping anything that cannot apply right now.
 *
 * Commands that do not exist are skipped rather than rendered dead — a typo in a
 * tool's menu should not show the user a greyed mystery row.
 */
export function resolveItems(items) {
  const out = [];
  for (const raw of items || []) {
    if (!raw) continue;
    if (raw.separator || raw.header) { out.push(raw); continue; }

    if (raw.command) {
      const c = getCommand(raw.command);
      if (!c) {
        console.warn(`[canvas-menu] unknown command: ${raw.command}`);
        continue;
      }
      const enabled = isEnabled(raw.command);
      if (raw.hideWhenDisabled && !enabled) continue;
      out.push({
        label: raw.label || labelOf(raw.command),
        accel: raw.accel !== undefined ? raw.accel : formatAccel(c.accel),
        checked: raw.checked !== undefined ? raw.checked : isChecked(raw.command),
        disabled: !enabled,
        run: () => runCommand(raw.command),
      });
      continue;
    }

    if (raw.hideWhenDisabled && raw.disabled) continue;
    out.push(raw);
  }

  // Collapse separators that ended up leading, trailing or doubled once the
  // inapplicable items around them were dropped.
  const tidy = [];
  for (const it of out) {
    if (it.separator && (!tidy.length || tidy[tidy.length - 1].separator)) continue;
    tidy.push(it);
  }
  while (tidy.length && tidy[tidy.length - 1].separator) tidy.pop();
  return tidy;
}

/**
 * The entries offered regardless of tool: transform, then view. Deliberately
 * short — the tool's own items are the useful part, and a 30-row menu is worse
 * than none.
 */
function sharedTail() {
  const doc = app.activeDoc;
  const items = [];
  if (doc) {
    items.push(sep());
    items.push(cmd('edit.free-transform'));
    items.push(cmd('select.transform', { hideWhenDisabled: true }));
  }
  items.push(sep());
  items.push(cmd('view.fit'));
  items.push(cmd('view.zoom-100'));
  return items;
}

/**
 * Build and show the menu for a right-click on the canvas.
 * @param {object} e normalised pointer event (see Tool in src/tools/base.js)
 * @param {MouseEvent} native the raw event, for viewport coordinates
 */
export function showCanvasMenu(e, native) {
  const tool = app.tool;
  let toolItems = [];
  if (tool && typeof tool.contextMenu === 'function') {
    try {
      toolItems = tool.contextMenu(e) || [];
    } catch (err) {
      console.error(`[canvas-menu] ${tool.id}.contextMenu failed`, err);
      toolItems = [];
    }
  }

  const items = resolveItems([...toolItems, ...sharedTail()]);
  if (!items.length) return null;
  return popupMenu(items, native.clientX, native.clientY, { minWidth: 208 });
}

/**
 * Wire the artboard's context menu.
 * @param {import('./canvas-view.js').CanvasView} view
 */
export function installCanvasMenu(view) {
  view.canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!app.activeDoc) return;
    // Right-clicking must not also commit whatever the tool was mid-way through.
    const ev = view._normalize(e);
    view.cursorDoc = { x: ev.x, y: ev.y };
    showCanvasMenu(ev, e);
  });
}

export { closeMenu };
