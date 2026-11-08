import { el, rafThrottle } from '../core/util.js';
import { app } from '../core/app.js';
import { tr } from '../core/i18n.js';
import { icon } from './icons.js';
import { confirmDialog } from './dialog.js';
import {
  artworkOfDocument, clearDropTarget, copyIntoDocument, documentTabUnder,
  overCanvasArea, paintDropTarget, setCanvasTarget, setDropTarget,
} from './cross-doc-drag.js';
import './tabbar.css';

/**
 * Document tabs. One tab per open document plus a button that opens the
 * New Document dialog.
 */

let root = null;
let installed = false;

/**
 * Build the tab bar into `rootEl`.
 * @param {HTMLElement} rootEl
 */
export function buildTabBar(rootEl) {
  if (!rootEl) return;
  root = rootEl;
  const queue = rafThrottle(render);
  if (!installed) {
    installed = true;
    for (const ev of ['docs-change', 'active-doc', 'doc-change', 'doc-resize', 'history-change']) app.on(ev, queue);
  }
  render();
}

function render() {
  if (!root) return;
  root.replaceChildren();

  for (const doc of app.docs) {
    const active = doc === app.activeDoc;
    const tab = el(`div.pk-tab${active ? '.active' : ''}`, {
      title: `${doc.name} — ${doc.width} × ${doc.height}`,
      dataset: { docId: doc.id },
      onclick: () => app.setActiveDoc(doc),
      onmousedown: (e) => {
        if (e.button === 1) {
          e.preventDefault();
          closeDoc(doc);
        }
      },
      onpointerdown: (e) => { if (e.button === 0) beginTabDrag(e, doc); },
    },
      // translate="no": the name is the user's, and a browser's own page
      // translation should leave it alone as well.
      el('span.pk-tab-name.pk-truncate', { text: doc.name, translate: 'no' }),
      doc.dirty ? el('span.pk-tab-dirty', { title: tr('Unsaved changes') }) : null,
      el('button.pk-tab-close', {
        type: 'button',
        title: tr('Close'),
        html: icon('close', { size: 10 }),
        onclick: (e) => { e.stopPropagation(); closeDoc(doc); },
      })
    );
    root.appendChild(tab);
  }

  root.appendChild(
    el('button.pk-tab-new', {
      type: 'button',
      title: tr('New document'),
      html: icon('plus', { size: 13 }),
      onclick: newDocument,
    })
  );

  // Every tab above is brand new, so a drop target lit before this rebuild has
  // just been thrown away with the old nodes. Put it back.
  paintDropTarget();
}

/**
 * Drag a document's tab onto another document to copy its picture in.
 *
 * An ordinary click on a tab still switches to it: a `click` only fires when
 * the release lands on the element the press started on, so a drag that ends
 * anywhere else never produces one. The 4px threshold matches the Layers
 * panel's, so the two drags start feeling the same way.
 */
function beginTabDrag(e, doc) {
  const startX = e.clientX, startY = e.clientY;
  let started = false;

  /** Where a release at (x, y) would put the picture, or null for nowhere. */
  const destinationAt = (x, y) => documentTabUnder(x, y, doc)
    || (overCanvasArea(x, y) && app.activeDoc && app.activeDoc !== doc ? app.activeDoc : null);

  const move = (ev) => {
    if (!started) {
      if (Math.abs(ev.clientX - startX) < 4 && Math.abs(ev.clientY - startY) < 4) return;
      started = true;
    }
    const onTab = documentTabUnder(ev.clientX, ev.clientY, doc);
    setDropTarget(onTab);
    setCanvasTarget(!onTab && !!destinationAt(ev.clientX, ev.clientY));
  };

  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (!started) return;
    const dest = destinationAt(ev.clientX, ev.clientY);
    clearDropTarget();
    if (dest) copyIntoDocument(dest, artworkOfDocument(doc), doc.name);
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

async function closeDoc(doc) {
  if (doc.dirty) {
    const ok = await confirmDialog(
      tr('"{name}" has unsaved changes. Close it anyway?', { name: doc.name }),
      tr('Close Document'),
      tr('Close Without Saving')
    );
    if (!ok) return;
  }
  app.closeDocument(doc);
}

async function newDocument() {
  try {
    const mod = await import('./dialogs/new-document.js');
    const show = mod.showNewDocumentDialog || mod.default;
    if (typeof show !== 'function') throw new Error('showNewDocumentDialog is not exported');
    await show();
  } catch (err) {
    console.warn('[tabbar] new-document dialog unavailable:', err && err.message);
    app.toast(tr('The New Document dialog is unavailable.'), 'error');
  }
}
