import { el } from '../core/util.js';
import { app } from '../core/app.js';
import { icon } from './icons.js';
import { toolGroups, getTool } from '../tools/base.js';
import { toCss } from '../core/color.js';
import { cycleScreenMode, getScreenMode, screenModeLabel, toggleQuickMask } from './shortcuts.js';
import './toolbar.css';

/**
 * The vertical tool strip.
 *
 * One button per tool group; the button shows the group's current member and a
 * corner triangle when the group holds more than one tool. Click-and-hold or
 * right-click opens the fly-out to switch members.
 */

const HOLD_MS = 350;

/** groupId -> currently selected tool id inside that group. */
const currentByGroup = new Map();
/** groupId -> function that repaints its button. */
const painters = new Map();

let flyout = null;
let tooltip = null;
let tipTimer = null;
let built = false;

/**
 * Build the toolbar into `rootEl`.
 * @param {HTMLElement} rootEl
 */
export function buildToolbar(rootEl) {
  if (!rootEl) return;
  rootEl.replaceChildren();

  for (const group of toolGroups) {
    if (!group.tools.length) continue;
    if (!currentByGroup.has(group.id)) currentByGroup.set(group.id, group.tools[0].id);
    rootEl.appendChild(makeGroupButton(group));
  }

  rootEl.appendChild(el('div.pk-tool-sep'));
  rootEl.appendChild(buildColorWell());
  rootEl.appendChild(el('div.pk-tool-sep'));
  rootEl.appendChild(buildExtras());

  if (!built) {
    built = true;
    app.on('tool-change', syncTools);
    app.on('color-change', syncColors);
    for (const ev of ['active-doc', 'doc-change', 'doc-selection']) app.on(ev, syncQuickMask);
    app.on('screen-mode', syncScreenMode);
    document.addEventListener('pointerdown', (e) => {
      if (flyout && !flyout.contains(e.target)) closeFlyout();
    }, true);
    window.addEventListener('keydown', (e) => {
      if (flyout && e.key === 'Escape') { e.stopPropagation(); closeFlyout(); }
    }, true);
    window.addEventListener('blur', () => { closeFlyout(); hideTooltip(); });
  }

  syncTools();
  syncColors();
  syncQuickMask();
  syncScreenMode();
}

/* ------------------------------------------------------------------ */
/* Tool buttons                                                        */
/* ------------------------------------------------------------------ */

function makeGroupButton(group) {
  const btn = el('button.pk-tool', { type: 'button', dataset: { group: group.id } });
  let holdTimer = null;
  let openedByHold = false;

  const paint = () => {
    const tool = getTool(currentByGroup.get(group.id)) || group.tools[0];
    // replaceChildren() stringifies null (it is not el()'s child handling).
    btn.replaceChildren(...[
      el('span.pk-tool-ico', { html: icon(tool.icon || tool.id, { size: 18 }) }),
      group.tools.length > 1 ? el('span.pk-tool-corner') : null,
    ].filter(Boolean));
    btn.classList.toggle('active', !!app.tool && app.tool.group === group.id);
    btn.dataset.tool = tool.id;
  };
  painters.set(group.id, paint);
  paint();

  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    openedByHold = false;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      holdTimer = null;
      openedByHold = true;
      hideTooltip();
      openFlyout(group, btn);
    }, HOLD_MS);
  });
  const cancelHold = () => { clearTimeout(holdTimer); holdTimer = null; };
  btn.addEventListener('pointerup', cancelHold);
  btn.addEventListener('pointerleave', cancelHold);
  btn.addEventListener('pointercancel', cancelHold);

  btn.addEventListener('click', () => {
    if (openedByHold) { openedByHold = false; return; }
    closeFlyout();
    const id = currentByGroup.get(group.id) || group.tools[0].id;
    app.setTool(id);
  });

  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    cancelHold();
    hideTooltip();
    openFlyout(group, btn);
  });

  btn.addEventListener('mouseenter', () => {
    const tool = getTool(currentByGroup.get(group.id)) || group.tools[0];
    scheduleTooltip(btn, tool);
  });
  btn.addEventListener('mouseleave', hideTooltip);

  return btn;
}

function syncTools() {
  const active = app.tool;
  if (active && active.group) currentByGroup.set(active.group, active.id);
  for (const paint of painters.values()) paint();
}

/* ------------------------------------------------------------------ */
/* Fly-out                                                             */
/* ------------------------------------------------------------------ */

function openFlyout(group, btn) {
  closeFlyout();
  if (group.tools.length <= 1) return;
  const r = btn.getBoundingClientRect();

  flyout = el('div.pk-flyout');
  for (const tool of group.tools) {
    const item = el('button.pk-flyout-item', {
      type: 'button',
      onclick: () => {
        currentByGroup.set(group.id, tool.id);
        closeFlyout();
        app.setTool(tool.id);
        syncTools();
      },
    },
      el('span.pk-flyout-ico', { html: icon(tool.icon || tool.id, { size: 16 }) }),
      el('span.pk-flyout-name', { text: tool.name }),
      tool.shortcut ? el('span.pk-flyout-key', { text: tool.shortcut.toUpperCase() }) : null
    );
    if (app.tool && app.tool.id === tool.id) item.classList.add('active');
    flyout.appendChild(item);
  }

  flyout.style.left = '-9999px';
  flyout.style.top = '0px';
  document.body.appendChild(flyout);

  const fr = flyout.getBoundingClientRect();
  let left = r.right + 4;
  let top = r.top - 2;
  if (left + fr.width > window.innerWidth - 6) left = Math.max(6, window.innerWidth - fr.width - 6);
  if (top + fr.height > window.innerHeight - 6) top = Math.max(6, window.innerHeight - fr.height - 6);
  flyout.style.left = `${Math.round(left)}px`;
  flyout.style.top = `${Math.round(top)}px`;
}

function closeFlyout() {
  if (flyout) flyout.remove();
  flyout = null;
}

/* ------------------------------------------------------------------ */
/* Tooltip                                                             */
/* ------------------------------------------------------------------ */

function scheduleTooltip(anchor, tool) {
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => showTooltip(anchor, tool), 420);
}

function showTooltip(anchor, tool) {
  if (flyout) return;
  hideTooltip();
  tooltip = el('div.pk-tooltip', {},
    el('span', { text: tool.name }),
    tool.shortcut ? el('span.pk-tooltip-key', { text: tool.shortcut.toUpperCase() }) : null
  );
  document.body.appendChild(tooltip);
  const r = anchor.getBoundingClientRect();
  const t = tooltip.getBoundingClientRect();
  let top = r.top + (r.height - t.height) / 2;
  top = Math.max(4, Math.min(top, window.innerHeight - t.height - 4));
  tooltip.style.left = `${Math.round(Math.min(r.right + 8, window.innerWidth - t.width - 6))}px`;
  tooltip.style.top = `${Math.round(top)}px`;
}

function hideTooltip() {
  clearTimeout(tipTimer);
  tipTimer = null;
  if (tooltip) tooltip.remove();
  tooltip = null;
}

/* ------------------------------------------------------------------ */
/* Colour well                                                         */
/* ------------------------------------------------------------------ */

let fgFill = null;
let bgFill = null;

function buildColorWell() {
  fgFill = el('span.pk-swatch-fill');
  bgFill = el('span.pk-swatch-fill');

  const bg = el('button.pk-swatch.pk-swatch-bg.pk-checker', {
    type: 'button', title: 'Background Color',
    onclick: () => pickColor('bg'),
  }, bgFill);

  const fg = el('button.pk-swatch.pk-swatch-fg.pk-checker', {
    type: 'button', title: 'Foreground Color',
    onclick: () => pickColor('fg'),
  }, fgFill);

  const swap = el('button.pk-swatch-swap', {
    type: 'button', title: 'Swap Colors (X)',
    html: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3.5 6.5V3.5h6M3.5 6.5 5.5 4.5M3.5 6.5 1.5 4.5M12.5 9.5v3h-6M12.5 9.5l-2 2M12.5 9.5l2 2"/></svg>',
    onclick: () => app.swapColors(),
  });

  const defaults = el('button.pk-swatch-default', {
    type: 'button', title: 'Default Foreground and Background (D)',
    onclick: () => app.resetColors(),
  }, el('span.pk-swatch-default-bg'), el('span.pk-swatch-default-fg'));

  return el('div.pk-colorwell', {}, bg, fg, swap, defaults);
}

function syncColors() {
  if (fgFill) fgFill.style.background = toCss(app.foreground);
  if (bgFill) bgFill.style.background = toCss(app.background);
}

async function pickColor(which) {
  const isFg = which === 'fg';
  const apply = (c) => {
    if (!c) return;
    if (isFg) app.setForeground(c);
    else app.setBackground(c);
  };
  try {
    const mod = await import('./color-picker.js');
    const show = mod.showColorPicker || mod.default;
    if (typeof show !== 'function') throw new Error('showColorPicker is not exported');
    const res = await show({
      color: isFg ? app.foreground : app.background,
      title: isFg ? 'Foreground Color' : 'Background Color',
      onChange: apply,
    });
    if (res) apply(res.color !== undefined ? res.color : res);
  } catch (err) {
    console.warn('[toolbar] colour picker unavailable:', err && err.message);
    app.toast('Colour picker is unavailable.', 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Quick mask + screen mode                                            */
/* ------------------------------------------------------------------ */

let quickMaskBtn = null;
let screenBtn = null;

function buildExtras() {
  quickMaskBtn = el('button.pk-tool.pk-tool-extra', {
    type: 'button',
    title: 'Edit in Quick Mask Mode (Q)',
    html: icon('mask', { size: 18 }),
    onclick: () => { toggleQuickMask(); syncQuickMask(); },
  });

  screenBtn = el('button.pk-tool.pk-tool-extra', {
    type: 'button',
    html: icon('navigator', { size: 18 }),
    onclick: () => cycleScreenMode(),
  });

  return el('div.pk-tool-extras', {}, quickMaskBtn, screenBtn);
}

function syncQuickMask() {
  if (!quickMaskBtn) return;
  const on = !!(app.activeDoc && app.activeDoc.quickMask);
  quickMaskBtn.classList.toggle('active', on);
  quickMaskBtn.title = on ? 'Edit in Standard Mode (Q)' : 'Edit in Quick Mask Mode (Q)';
}

function syncScreenMode() {
  if (!screenBtn) return;
  const mode = getScreenMode();
  screenBtn.classList.toggle('active', mode !== 'standard');
  screenBtn.title = `${screenModeLabel(mode)} (F)`;
}
