import { el, rafThrottle } from '../core/util.js';
import { app } from '../core/app.js';
import { icon } from './icons.js';
import { confirmDialog } from './dialog.js';
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
      onclick: () => app.setActiveDoc(doc),
      onmousedown: (e) => {
        if (e.button === 1) {
          e.preventDefault();
          closeDoc(doc);
        }
      },
    },
      el('span.pk-tab-name.pk-truncate', { text: doc.name }),
      doc.dirty ? el('span.pk-tab-dirty', { title: 'Unsaved changes' }) : null,
      el('button.pk-tab-close', {
        type: 'button',
        title: 'Close',
        html: icon('close', { size: 10 }),
        onclick: (e) => { e.stopPropagation(); closeDoc(doc); },
      })
    );
    root.appendChild(tab);
  }

  root.appendChild(
    el('button.pk-tab-new', {
      type: 'button',
      title: 'New document',
      html: icon('plus', { size: 13 }),
      onclick: newDocument,
    })
  );
}

async function closeDoc(doc) {
  if (doc.dirty) {
    const ok = await confirmDialog(
      `"${doc.name}" has unsaved changes. Close it anyway?`,
      'Close Document',
      'Close Without Saving'
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
    app.toast('The New Document dialog is unavailable.', 'error');
  }
}
