import './styles.css';

import { app } from './core/app.js';
import { CanvasView } from './ui/canvas-view.js';
import { el } from './core/util.js';
import { brandMark } from './ui/brand.js';

/* --- registration side effects ------------------------------------- */
/* Each module registers itself with the relevant registry on import.   */

// Tools
import './tools/move.js';
import './tools/marquee.js';
import './tools/lasso.js';
import './tools/wand.js';
import './tools/crop.js';
import './tools/eyedropper.js';
import './tools/healing.js';
import './tools/brush.js';
import './tools/stamp.js';
import './tools/history-brush.js';
import './tools/eraser.js';
import './tools/gradient.js';
import './tools/focus.js';
import './tools/tone.js';
import './tools/pen.js';
import './tools/type.js';
import './tools/path-select.js';
import './tools/shape.js';
import './tools/nav.js';

// Filters
import './filters/blur.js';
import './filters/distort.js';
import './filters/noise.js';
import './filters/pixelate.js';
import './filters/render.js';
import './filters/sharpen.js';
import './filters/stylize.js';
import './filters/other.js';

// Adjustments
import './adjustments/basic.js';
import './adjustments/advanced.js';

// Layer effects
import './effects/effect-renderers.js';

// Panels — imported for their registerPanel() side effect, before the dock is built.
import './ui/panels/layers.js';
import './ui/panels/channels.js';
import './ui/panels/paths.js';
import './ui/panels/color.js';
import './ui/panels/swatches.js';
import './ui/panels/properties.js';
import './ui/panels/history.js';
import './ui/panels/navigator.js';
import './ui/panels/info.js';
import './ui/panels/character.js';

// Commands (must come after tools/filters so menus can enumerate them)
import './commands/definitions.js';

// UI
import { buildMenubar } from './ui/menubar.js';
import { buildToolbar } from './ui/toolbar.js';
import { buildOptionsBar } from './ui/options-bar.js';
import { buildStatusBar } from './ui/statusbar.js';
import { buildTabBar } from './ui/tabbar.js';
import { buildPanelDock } from './ui/panel-host.js';
import { installShortcuts } from './ui/shortcuts.js';
import { installFileDrop, openFiles } from './io/open.js';
import { installCanvasMenu } from './ui/canvas-menu.js';
import { tools } from './tools/base.js';

/* ------------------------------------------------------------------ */

/**
 * Hand the app singleton to every registered tool.
 *
 * Tool.init(app) is the documented contract ("called once when the app boots"),
 * but nothing used to call it, so `this.app` — and therefore the `this.doc`
 * getter — stayed null for every tool that did not assign it in its own
 * constructor. That silently disabled Move, Hand, Zoom, Rotate View, Gradient,
 * Paint Bucket, Eyedropper, Color Sampler, Ruler, Note and Artboard.
 *
 * init() is idempotent (it only assigns this.app), so tools that already
 * self-assign are unaffected.
 */
function initTools() {
  for (const tool of tools.values()) {
    try {
      tool.init(app);
    } catch (err) {
      console.error(`[tool ${tool.id}] init failed`, err);
    }
  }
}

function boot() {
  const canvasEl = document.getElementById('view');
  const areaEl = document.getElementById('canvas-area');

  initTools();

  const view = new CanvasView(canvasEl, areaEl);
  app.view = view;

  buildMenubar(document.getElementById('menubar'));
  buildToolbar(document.getElementById('toolbar'));
  buildOptionsBar(document.getElementById('optionsbar'));
  buildTabBar(document.getElementById('tabbar'));
  buildStatusBar(document.getElementById('statusbar'));
  buildPanelDock(document.getElementById('panels'));

  installShortcuts(view);
  installCanvasMenu(view);
  installFileDrop(areaEl);
  installToasts();
  installBusy();
  installWelcome(areaEl);

  app.setTool('move');
  app.ready = true;
  app.emit('ready');

  // Start with a document so the app is immediately usable.
  if (!app.activeDoc) {
    app.newDocument({ width: 1280, height: 800, name: 'Untitled-1', fill: '#ffffff' });
  }

  window.addEventListener('beforeunload', (e) => {
    if (app.docs.some((d) => d.dirty)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

/* ------------------------------------------------------------------ */

function installToasts() {
  const host = document.getElementById('toasts');
  app.on('toast', ({ message, kind, ms }) => {
    const node = el(`div.pk-toast.${kind}`, { text: message });
    host.appendChild(node);
    setTimeout(() => {
      node.style.transition = 'opacity .2s';
      node.style.opacity = '0';
      setTimeout(() => node.remove(), 220);
    }, ms);
  });
}

function installBusy() {
  const box = document.getElementById('busy');
  const label = document.getElementById('busy-label');
  let depth = 0;
  app.on('busy', ({ label: text, active }) => {
    depth += active ? 1 : -1;
    depth = Math.max(0, depth);
    label.textContent = text || 'Working…';
    box.hidden = depth === 0;
  });
}

/** Placeholder shown when every document is closed. */
function installWelcome(areaEl) {
  const welcome = el('div.pk-empty.pk-welcome', {},
    el('div.pk-welcome-mark', { html: brandMark({ size: 60, title: 'Pikado' }) }),
    el('h1', { text: 'Pikado' }),
    el('p', { text: 'An image studio that runs entirely in your browser. Open a photo, drop a file anywhere, or start from a blank canvas.' }),
    el('div.pk-empty-actions', {},
      el('button.pk-btn.primary', { text: 'New document', onclick: () => import('./ui/dialogs/new-document.js').then((m) => m.showNewDocumentDialog()) }),
      el('button.pk-btn', { text: 'Open…', onclick: () => document.getElementById('file-input').click() })
    ),
    el('p', {}, el('kbd', { text: 'Ctrl' }), ' + ', el('kbd', { text: 'O' }), ' to open · ', el('kbd', { text: 'Ctrl' }), ' + ', el('kbd', { text: 'N' }), ' for a new document')
  );
  welcome.style.position = 'absolute';
  welcome.style.inset = '0';
  areaEl.appendChild(welcome);

  const sync = () => {
    welcome.style.display = app.activeDoc ? 'none' : 'flex';
  };
  app.on('docs-change', sync);
  app.on('active-doc', sync);
  sync();

  const input = document.getElementById('file-input');
  input.addEventListener('change', () => {
    if (input.files && input.files.length) openFiles([...input.files]);
    input.value = '';
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
