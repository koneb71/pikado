import { registerPanel } from '../panel-host.js';
import { app } from '../../core/app.js';
import { el, rafThrottle } from '../../core/util.js';
import { rgb2cmyk, toHex } from '../../core/color.js';
import { getComposite } from '../../render/compositor.js';
import './panels.css';
import './info.css';

/**
 * The Info panel: live pixel readouts under the cursor, cursor position,
 * selection or drag dimensions, document size, colour samplers and a reminder
 * of the active tool's modifier keys.
 */

const TOOL_HINTS = {
  move: 'Alt-drag duplicates · Shift constrains to 45° · arrows nudge',
  artboard: 'Drag to size · Alt-drag duplicates',
  marquee: 'Shift adds · Alt subtracts · Shift+Alt intersects · Space repositions while drawing',
  lasso: 'Shift adds · Alt subtracts · Alt-click for straight segments',
  wand: 'Shift adds · Alt subtracts · adjust Tolerance in the options bar',
  'quick-select': 'Shift adds · Alt subtracts · [ and ] resize the brush',
  crop: 'Shift constrains the ratio · Alt resizes from the centre · Enter commits',
  eyedropper: 'Alt-click samples into the background colour',
  'color-sampler': 'Click to place a sampler · Alt-click removes one',
  ruler: 'Drag to measure · Shift constrains to 45°',
  brush: 'Alt picks a colour · [ and ] resize · Shift-click draws a straight line',
  pencil: 'Alt picks a colour · Shift-click draws a straight line',
  eraser: '[ and ] resize · Shift-click erases a straight line',
  'clone-stamp': 'Alt-click sets the clone source',
  'pattern-stamp': 'Choose a pattern in the options bar',
  healing: 'Alt-click sets the source · [ and ] resize',
  gradient: 'Shift constrains the angle · Alt swaps the direction',
  bucket: 'Alt fills with the background colour · Tolerance in the options bar',
  blur: '[ and ] resize the tip',
  dodge: 'Alt temporarily switches Dodge and Burn',
  pen: 'Alt converts an anchor · Ctrl/Cmd temporarily selects points · Enter closes',
  type: 'Ctrl/Cmd-Enter commits · Escape cancels · drag to make a text box',
  'path-select': 'Shift adds to the selection · Alt-drag duplicates',
  shape: 'Shift constrains proportions · Alt draws from the centre',
  zoom: 'Alt zooms out · double-click for 100%',
  hand: 'Hold Space with any tool to pan',
};

function hintFor(tool) {
  if (!tool) return 'Space pans · Ctrl/Cmd + wheel zooms';
  return TOOL_HINTS[tool.id] || TOOL_HINTS[tool.group] || 'Space pans · Ctrl/Cmd + wheel zooms';
}

/** Read one composite pixel, or null when it is outside the canvas. */
function samplePixel(doc, x, y) {
  if (!doc || x < 0 || y < 0 || x >= doc.width || y >= doc.height) return null;
  const d = getComposite(doc).getContext('2d').getImageData(x, y, 1, 1).data;
  return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
}

registerPanel({
  id: 'info',
  title: 'Info',
  icon: 'info',
  group: 'bottom',
  order: 3,
  defaultOpen: true,
  build(body) {
    body.classList.add('pki-body');

    let cursor = null;      // {x, y} in document pixels
    let dragFrom = null;    // anchor while a pointer button is held

    const val = (label) => {
      const v = el('span.pki-v', { text: '—' });
      return { row: el('div.pki-row', {}, el('span.pki-k', { text: label }), v), v };
    };

    const rgbBlock = el('div.pki-block');
    const rgbRows = ['R', 'G', 'B', 'A'].map((k) => {
      const f = val(`${k} :`);
      rgbBlock.appendChild(f.row);
      return f.v;
    });

    const cmykBlock = el('div.pki-block');
    const cmykRows = ['C', 'M', 'Y', 'K'].map((k) => {
      const f = val(`${k} :`);
      cmykBlock.appendChild(f.row);
      return f.v;
    });

    const hexRow = val('#');
    const posBlock = el('div.pki-block');
    const posX = val('X :'); const posY = val('Y :');
    posBlock.append(posX.row, posY.row, hexRow.row);

    const sizeBlock = el('div.pki-block');
    const dimW = val('W :'); const dimH = val('H :');
    const dimLabel = el('div.pki-sub', { text: 'Selection' });
    sizeBlock.append(dimLabel, dimW.row, dimH.row);

    const docLine = el('div.pki-doc', { text: 'No document' });
    const samplerHost = el('div.pki-samplers');
    const hintLine = el('div.pki-hint');

    body.append(
      el('div.pki-grid', {}, rgbBlock, cmykBlock, posBlock, sizeBlock),
      docLine,
      samplerHost,
      hintLine
    );

    const setAll = (nodes, text) => nodes.forEach((n) => { n.textContent = text; });

    const update = () => {
      const doc = app.activeDoc;

      if (!doc) {
        setAll(rgbRows, '—');
        setAll(cmykRows, '—');
        hexRow.v.textContent = '—';
        posX.v.textContent = posY.v.textContent = '—';
        dimW.v.textContent = dimH.v.textContent = '—';
        docLine.textContent = 'No document';
        samplerHost.replaceChildren();
        hintLine.textContent = hintFor(app.tool);
        return;
      }

      const px = cursor ? Math.floor(cursor.x) : null;
      const py = cursor ? Math.floor(cursor.y) : null;
      const c = cursor ? samplePixel(doc, px, py) : null;

      if (c) {
        rgbRows[0].textContent = String(c.r);
        rgbRows[1].textContent = String(c.g);
        rgbRows[2].textContent = String(c.b);
        rgbRows[3].textContent = `${Math.round(c.a * 100)}%`;
        const k = rgb2cmyk(c.r, c.g, c.b);
        cmykRows[0].textContent = `${Math.round(k.c * 100)}%`;
        cmykRows[1].textContent = `${Math.round(k.m * 100)}%`;
        cmykRows[2].textContent = `${Math.round(k.y * 100)}%`;
        cmykRows[3].textContent = `${Math.round(k.k * 100)}%`;
        hexRow.v.textContent = toHex(c).slice(1);
      } else {
        setAll(rgbRows, '—');
        setAll(cmykRows, '—');
        hexRow.v.textContent = '—';
      }

      posX.v.textContent = cursor ? String(px) : '—';
      posY.v.textContent = cursor ? String(py) : '—';

      if (dragFrom && cursor) {
        dimLabel.textContent = 'Drag';
        dimW.v.textContent = String(Math.round(Math.abs(cursor.x - dragFrom.x)));
        dimH.v.textContent = String(Math.round(Math.abs(cursor.y - dragFrom.y)));
      } else if (doc.selection.active) {
        const b = doc.selection.bounds();
        dimLabel.textContent = 'Selection';
        dimW.v.textContent = b ? String(b.width) : '0';
        dimH.v.textContent = b ? String(b.height) : '0';
      } else {
        dimLabel.textContent = 'Selection';
        dimW.v.textContent = '—';
        dimH.v.textContent = '—';
      }

      docLine.textContent = `${doc.name} — ${doc.width} × ${doc.height} px @ ${Math.round(doc.resolution || 72)} ppi`;

      const samplers = Array.isArray(doc.colorSamplers) ? doc.colorSamplers : [];
      samplerHost.replaceChildren(
        ...samplers.slice(0, 8).map((s, i) => {
          const sc = samplePixel(doc, Math.floor(s.x), Math.floor(s.y));
          const text = sc
            ? `#${i + 1}  R ${sc.r}  G ${sc.g}  B ${sc.b}   (${Math.round(s.x)}, ${Math.round(s.y)})`
            : `#${i + 1}  — outside the canvas`;
          const swatch = el('span.pki-sampler-chip', {
            style: { background: sc ? `rgb(${sc.r},${sc.g},${sc.b})` : 'transparent' },
          });
          return el('div.pki-sampler', {}, swatch, el('span', { text }));
        })
      );

      hintLine.textContent = hintFor(app.tool);
    };

    const scheduled = rafThrottle(update);

    app.on('cursor-move', (e) => {
      cursor = { x: e.x, y: e.y };
      if (e.buttons) {
        if (!dragFrom) dragFrom = { x: e.x, y: e.y };
      } else {
        dragFrom = null;
      }
      if (body.isConnected && body.offsetParent !== null) scheduled();
    });
    window.addEventListener('pointerup', () => {
      if (!dragFrom) return;
      dragFrom = null;
      scheduled();
    });

    app.on('doc-selection', scheduled);
    app.on('doc-change', scheduled);
    app.on('doc-resize', scheduled);
    app.on('active-doc', () => { cursor = null; dragFrom = null; update(); });
    app.on('tool-change', scheduled);

    update();
    return { refresh: update };
  },
});
