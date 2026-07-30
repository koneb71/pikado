import { registerPanel } from '../panel-host.js';
import { app } from '../../core/app.js';
import { el, uid, createCanvas, ctx2dRead } from '../../core/util.js';
import { Selection } from '../../core/selection.js';
import { getComposite, channelViewOf, setChannelView, isFullChannelView } from '../../render/compositor.js';
import { iconEl } from '../icons.js';
import { promptDialog } from '../dialog.js';
import './panels.css';
import './channels.css';

/**
 * The Channels panel.
 *
 * The R/G/B eyes drive `doc.channelView`, which the compositor applies as a
 * final pass in `getViewComposite()` — so hiding a channel changes what the
 * canvas shows and nothing else: export, flatten, Save and the eyedropper all
 * keep reading the full-colour composite. As in Photoshop, one visible channel
 * displays as greyscale, two or more zero the hidden ones, and the RGB
 * composite eye switches all three at once.
 *
 * Alpha channels have no eye: the compositor does not render them onto the
 * canvas, so an eye there would do nothing. They are loaded as selections
 * (Ctrl/Cmd-click or the footer button) instead.
 */

const THUMB_W = 38;
const THUMB_H = 28;

/** Downscale the composite once; every channel thumbnail reads from it. */
function compositeThumbData(doc) {
  const cv = createCanvas(THUMB_W, THUMB_H);
  const c = cv.getContext('2d');
  const s = Math.min(THUMB_W / doc.width, THUMB_H / doc.height);
  const w = Math.max(1, doc.width * s), h = Math.max(1, doc.height * s);
  c.imageSmoothingQuality = 'high';
  c.drawImage(getComposite(doc), (THUMB_W - w) / 2, (THUMB_H - h) / 2, w, h);
  return { canvas: cv, data: ctx2dRead(cv).getImageData(0, 0, THUMB_W, THUMB_H) };
}

/** Grey thumbnail of one RGB channel (or the luminance composite). */
function channelThumb(base, offset) {
  const cv = createCanvas(THUMB_W, THUMB_H);
  const out = new ImageData(THUMB_W, THUMB_H);
  const s = base.data.data, d = out.data;
  for (let i = 0; i < s.length; i += 4) {
    const a = s[i + 3] / 255;
    const v = offset < 0
      ? (s[i] * 0.299 + s[i + 1] * 0.587 + s[i + 2] * 0.114) * a
      : s[i + offset] * a;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  cv.getContext('2d').putImageData(out, 0, 0);
  return cv;
}

function canvasThumb(src) {
  const cv = createCanvas(THUMB_W, THUMB_H);
  const c = cv.getContext('2d');
  c.fillStyle = '#000';
  c.fillRect(0, 0, THUMB_W, THUMB_H);
  if (src) {
    const s = Math.min(THUMB_W / src.width, THUMB_H / src.height);
    const w = Math.max(1, src.width * s), h = Math.max(1, src.height * s);
    c.drawImage(src, (THUMB_W - w) / 2, (THUMB_H - h) / 2, w, h);
  }
  return cv;
}

/** Full-resolution coverage mask for one of the composite channels. */
function compositeChannelMask(doc, offset) {
  const d = ctx2dRead(getComposite(doc)).getImageData(0, 0, doc.width, doc.height).data;
  const mask = new Uint8ClampedArray(doc.width * doc.height);
  for (let i = 0, p = 0; p < mask.length; p++, i += 4) {
    const a = d[i + 3] / 255;
    mask[p] = offset < 0
      ? (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) * a
      : d[i + offset] * a;
  }
  return mask;
}

/** Alpha channels predate any Image Size change, so rescale when they differ. */
function maskFromChannelCanvas(doc, canvas) {
  let src = canvas;
  if (canvas.width !== doc.width || canvas.height !== doc.height) {
    src = createCanvas(doc.width, doc.height);
    const c = src.getContext('2d');
    c.fillStyle = '#000';
    c.fillRect(0, 0, doc.width, doc.height);
    c.drawImage(canvas, 0, 0, doc.width, doc.height);
  }
  return Selection.fromCanvas(src).mask;
}

function nextAlphaName(doc) {
  let n = doc.alphaChannels.length + 1;
  const taken = new Set(doc.alphaChannels.map((c) => c.name));
  while (taken.has(`Alpha ${n}`)) n++;
  return `Alpha ${n}`;
}

registerPanel({
  id: 'channels',
  title: 'Channels',
  icon: 'channels',
  group: 'top',
  order: 1,
  defaultOpen: true,
  build(body) {
    body.classList.add('pkch-body');
    let selectedId = 'composite';

    const list = el('div.pkch-list.pk-scroll');
    const footer = el('div.pkch-foot');
    body.append(list, footer);

    /* ---- actions ------------------------------------------------ */

    const doc = () => app.activeDoc;

    const loadSelection = (id) => {
      const d = doc();
      if (!d) return;
      let mask = null;
      if (id === 'composite') mask = compositeChannelMask(d, -1);
      else if (id === 'r') mask = compositeChannelMask(d, 0);
      else if (id === 'g') mask = compositeChannelMask(d, 1);
      else if (id === 'b') mask = compositeChannelMask(d, 2);
      else {
        const ch = d.alphaChannels.find((c) => c.id === id);
        if (!ch || !ch.canvas) {
          app.toast('Select a channel to load.');
          return;
        }
        mask = maskFromChannelCanvas(d, ch.canvas);
      }
      d.selection.set(mask);
      d.commit('Load Channel as Selection');
      app.toast('Channel loaded as a selection.', 'ok');
    };

    const saveSelection = () => {
      const d = doc();
      if (!d) return;
      if (!d.selection.active) {
        app.toast('There is no selection to save.', 'warn');
        return;
      }
      const ch = { id: uid('chan'), name: nextAlphaName(d), canvas: d.selection.toCanvas() };
      d.alphaChannels.push(ch);
      selectedId = ch.id;
      d.commit('Save Selection as Channel');
    };

    const newChannel = () => {
      const d = doc();
      if (!d) return;
      const cv = createCanvas(d.width, d.height);
      const c = cv.getContext('2d');
      c.fillStyle = '#000';
      c.fillRect(0, 0, d.width, d.height);
      const ch = { id: uid('chan'), name: nextAlphaName(d), canvas: cv };
      d.alphaChannels.push(ch);
      selectedId = ch.id;
      d.commit('New Channel');
    };

    const deleteChannel = () => {
      const d = doc();
      if (!d) return;
      const i = d.alphaChannels.findIndex((c) => c.id === selectedId);
      if (i < 0) {
        app.toast('Select an alpha channel to delete.', 'warn');
        return;
      }
      d.alphaChannels.splice(i, 1);
      selectedId = 'composite';
      d.commit('Delete Channel');
    };

    const toggleQuickMask = () => {
      const d = doc();
      if (!d) return;
      d.quickMask = !d.quickMask;
      if (d.quickMask && !d.selection.active) {
        app.toast('Quick Mask is on — it paints over the current selection.', 'info');
      }
      // View state only: no history entry, but the canvas must repaint.
      d.touch('quick-mask');
      render();
    };

    /** Flip one RGB channel's view visibility. View state: no history entry. */
    const toggleChannelView = (key) => {
      const d = doc();
      if (!d) return;
      const cv = channelViewOf(d);
      if (!setChannelView(d, { [key]: !cv[key] })) return;
      app.requestRender();
      render();
    };

    /**
     * The composite eye switches all three channels together: on when every
     * channel is visible, and clicking it while any channel is hidden brings
     * them all back — the same asymmetry Photoshop's RGB eye has.
     */
    const toggleCompositeView = () => {
      const d = doc();
      if (!d) return;
      const on = !isFullChannelView(channelViewOf(d));
      if (!setChannelView(d, { r: on, g: on, b: on })) return;
      app.requestRender();
      render();
    };

    /* ---- rows ---------------------------------------------------- */

    const makeRow = ({ id, name, thumb, eye, onRename, dim }) => {
      const row = el('div.pkch-row' + (selectedId === id ? '.is-selected' : '') + (dim ? '.is-hidden' : ''), {
        title: `${name} — Ctrl/Cmd-click to load as a selection`,
      });
      const eyeCell = el('div.pkch-eye');
      if (eye) {
        const b = el('button.pk-icon-btn.pkch-eyebtn' + (eye.on ? '' : '.is-off'), {
          type: 'button', title: eye.title,
          onclick: (e) => { e.stopPropagation(); eye.onToggle(); },
        }, iconEl(eye.on ? 'eye' : 'eye-off', { size: 14 }));
        eyeCell.appendChild(b);
      }
      const thumbCell = el('div.pkch-thumb.pk-checker');
      if (thumb) thumbCell.appendChild(thumb);
      const label = el('span.pkch-name.pk-truncate', { text: name });
      row.append(eyeCell, thumbCell, label);
      row.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey) {
          loadSelection(id);
          return;
        }
        selectedId = id;
        render();
      });
      if (onRename) row.addEventListener('dblclick', onRename);
      return row;
    };

    const render = () => {
      const d = doc();
      list.replaceChildren();
      if (!d) {
        list.appendChild(el('div.pkch-empty', { text: 'No document open.' }));
        renderFooter();
        return;
      }

      if (d.quickMask) {
        list.appendChild(makeRow({
          id: 'quickmask',
          name: 'Quick Mask',
          thumb: canvasThumb(d.selection.active ? d.selection.toCanvas() : null),
          eye: { on: true, title: 'Exit Quick Mask', onToggle: toggleQuickMask },
        }));
      }

      // Thumbnails always come from the true composite, never from the filtered
      // view — the point of the Red thumbnail is to show the red plate as it is.
      const base = compositeThumbData(d);
      const cv = channelViewOf(d);
      const allOn = isFullChannelView(cv);
      list.appendChild(makeRow({
        id: 'composite',
        name: 'RGB',
        thumb: base.canvas,
        dim: !allOn,
        eye: {
          on: allOn,
          title: allOn ? 'Hide all channels' : 'Show all channels',
          onToggle: toggleCompositeView,
        },
      }));
      for (const [key, name, offset] of [['r', 'Red', 0], ['g', 'Green', 1], ['b', 'Blue', 2]]) {
        list.appendChild(makeRow({
          id: key,
          name,
          thumb: channelThumb(base, offset),
          dim: !cv[key],
          eye: {
            on: cv[key],
            title: `${cv[key] ? 'Hide' : 'Show'} the ${name.toLowerCase()} channel`,
            onToggle: () => toggleChannelView(key),
          },
        }));
      }

      for (const ch of d.alphaChannels) {
        list.appendChild(makeRow({
          id: ch.id,
          name: ch.name,
          thumb: canvasThumb(ch.canvas),
          onRename: async () => {
            const next = await promptDialog('Channel name', ch.name, 'Rename Channel');
            if (next == null || !next.trim()) return;
            ch.name = next.trim();
            d.commit('Rename Channel');
          },
        }));
      }
      renderFooter();
    };

    const renderFooter = () => {
      const d = doc();
      footer.replaceChildren(
        el('button.pk-icon-btn', { type: 'button', title: 'Load channel as selection', disabled: !d, onclick: () => loadSelection(selectedId) }, iconEl('marquee-rect')),
        el('button.pk-icon-btn', { type: 'button', title: 'Save selection as channel', disabled: !d, onclick: saveSelection }, iconEl('mask')),
        el('button.pk-icon-btn' + (d && d.quickMask ? '.active' : ''), { type: 'button', title: 'Toggle Quick Mask', disabled: !d, onclick: toggleQuickMask }, iconEl('adjustment')),
        el('div.pk-spacer'),
        el('button.pk-icon-btn', { type: 'button', title: 'New channel', disabled: !d, onclick: newChannel }, iconEl('plus')),
        el('button.pk-icon-btn', { type: 'button', title: 'Delete channel', disabled: !d, onclick: deleteChannel }, iconEl('trash'))
      );
    };

    /* ---- wiring -------------------------------------------------- */

    let pending = null;
    const schedule = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        if (body.isConnected && body.offsetParent !== null) render();
      }, 140);
    };

    app.on('active-doc', () => { selectedId = 'composite'; schedule(); });
    app.on('doc-change', schedule);
    app.on('doc-structure', schedule);
    app.on('doc-selection', schedule);
    app.on('doc-resize', schedule);

    render();
    return { refresh: render };
  },
});
