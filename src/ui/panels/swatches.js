import { registerPanel } from '../panel-host.js';
import { app } from '../../core/app.js';
import { el } from '../../core/util.js';
import { parseColor, toHex, hsv2rgb, cmyk2rgb, DEFAULT_SWATCHES } from '../../core/color.js';
import { iconEl } from '../icons.js';
import './panels.css';
import './swatches.css';

/**
 * The Swatches panel. The top grid holds the user's own swatches (persisted to
 * localStorage); below it sit read-only library groups.
 */

const STORE_KEY = 'pikado.swatches';

function loadUserSwatches() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (Array.isArray(raw) && raw.length) return raw.filter((s) => typeof s === 'string' || (s && typeof s.color === 'string'));
  } catch {
    /* corrupt or unavailable storage — fall through to the defaults */
  }
  return null;
}

function saveUserSwatches() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(app.swatches));
  } catch {
    /* storage disabled — swatches simply do not persist */
  }
}

// Restore on import so the rest of the app sees the user's palette immediately.
const stored = loadUserSwatches();
if (stored) app.swatches = stored;

const colorOf = (s) => (typeof s === 'string' ? s : s.color);
const nameOf = (s) => (typeof s === 'string' ? s : s.name || s.color);

/* ------------------------------------------------------------------ */
/* Library groups                                                      */
/* ------------------------------------------------------------------ */

function rgbGroup() {
  const out = [];
  for (let i = 0; i < 12; i++) out.push(toHex(hsv2rgb(i * 30, 1, 1)));    // pure hues
  for (let i = 0; i < 12; i++) out.push(toHex(hsv2rgb(i * 30, 1, 0.6)));  // shades
  for (let i = 0; i < 12; i++) out.push(toHex(hsv2rgb(i * 30, 0.45, 1))); // tints
  out.push('#000000', '#404040', '#808080', '#c0c0c0', '#ffffff');
  return out;
}

function cmykGroup() {
  const out = [];
  const inks = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1], [1, 1, 1], [0, 0, 0]];
  for (const k of [0, 0.25, 0.5]) {
    for (const [c, m, y] of inks) out.push(toHex(cmyk2rgb(c, m, y, k)));
  }
  return out;
}

function grayGroup() {
  const out = [];
  for (let i = 0; i <= 20; i++) {
    const v = Math.round(255 * (1 - i / 20));
    out.push(toHex({ r: v, g: v, b: v }));
  }
  return out;
}

function pastelGroup() {
  const out = [];
  for (const s of [0.16, 0.3, 0.44]) {
    for (let i = 0; i < 12; i++) out.push(toHex(hsv2rgb(i * 30, s, 1)));
  }
  return out;
}

function webGroup() {
  const steps = [0, 51, 102, 153, 204, 255];
  const out = [];
  for (const r of steps) for (const g of steps) for (const b of steps) out.push(toHex({ r, g, b }));
  return out;
}

const LIBRARIES = [
  { id: 'rgb', name: 'RGB', colors: rgbGroup() },
  { id: 'cmyk', name: 'CMYK', colors: cmykGroup() },
  { id: 'gray', name: 'Grayscale', colors: grayGroup() },
  { id: 'pastel', name: 'Pastels', colors: pastelGroup() },
  { id: 'web', name: 'Web', colors: webGroup() },
];

/* ------------------------------------------------------------------ */

registerPanel({
  id: 'swatches',
  title: 'Swatches',
  icon: 'swatch',
  group: 'mid',
  order: 1,
  defaultOpen: false,
  build(body) {
    body.classList.add('pksw-body');
    let selected = -1;

    const grid = el('div.pksw-grid');
    const groupHost = el('div.pksw-groups');

    const applySwatch = (hex, e) => {
      const c = parseColor(hex);
      if (e.altKey || e.button === 2 || e.type === 'contextmenu') app.setBackground(c);
      else app.setForeground(c);
    };

    const chip = (hex, title, onPick) => {
      const b = el('button.pksw-chip', { type: 'button', title, style: { background: hex } });
      b.addEventListener('click', (e) => onPick(e));
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); onPick(e); });
      return b;
    };

    const renderUser = () => {
      grid.replaceChildren();
      if (!app.swatches.length) {
        grid.appendChild(el('div.pksw-empty', { text: 'No swatches. Use + to add the foreground colour.' }));
        return;
      }
      app.swatches.forEach((s, i) => {
        const hex = colorOf(s);
        const b = chip(hex, nameOf(s), (e) => {
          selected = i;
          applySwatch(hex, e);
          renderUser();
        });
        if (i === selected) b.classList.add('is-selected');
        grid.appendChild(b);
      });
    };

    const renderLibraries = () => {
      groupHost.replaceChildren(
        ...LIBRARIES.map((lib) => {
          const inner = el('div.pksw-grid');
          for (const hex of lib.colors) inner.appendChild(chip(hex, hex, (e) => applySwatch(hex, e)));
          const arrow = iconEl('chevron-right', { size: 12 });
          const wrap = el('div.pksw-group', {},
            el('button.pksw-group-head', {
              type: 'button',
              onclick: () => {
                wrap.classList.toggle('is-open');
                arrow.style.transform = wrap.classList.contains('is-open') ? 'rotate(90deg)' : '';
              },
            }, arrow, el('span', { text: `${lib.name} (${lib.colors.length})` })),
            el('div.pksw-group-body', {}, inner)
          );
          return wrap;
        })
      );
    };

    const tools = el('div.pksw-tools', {},
      el('button.pk-icon-btn', {
        type: 'button', title: 'New swatch from the foreground colour',
        onclick: () => {
          const hex = toHex(app.foreground);
          const existing = app.swatches.findIndex((s) => colorOf(s).toLowerCase() === hex.toLowerCase());
          if (existing >= 0) {
            selected = existing;
          } else {
            app.swatches.push(hex);
            selected = app.swatches.length - 1;
            saveUserSwatches();
          }
          renderUser();
        },
      }, iconEl('plus')),
      el('button.pk-icon-btn', {
        type: 'button', title: 'Delete the selected swatch',
        onclick: () => {
          if (selected < 0 || selected >= app.swatches.length) {
            app.toast('Select a swatch first.');
            return;
          }
          app.swatches.splice(selected, 1);
          selected = Math.min(selected, app.swatches.length - 1);
          saveUserSwatches();
          renderUser();
        },
      }, iconEl('trash')),
      el('div.pk-spacer'),
      el('button.pk-btn.subtle.pksw-reset', {
        type: 'button', title: 'Restore the default swatch set',
        text: 'Reset',
        onclick: () => {
          app.swatches = [...DEFAULT_SWATCHES];
          selected = -1;
          saveUserSwatches();
          renderUser();
        },
      })
    );

    body.append(tools, grid, groupHost);
    renderUser();
    renderLibraries();

    return {
      refresh() {
        renderUser();
      },
    };
  },
});
