import './dialogs.css';
import './fonts.css';
import { el } from '../../core/util.js';
import { app } from '../../core/app.js';
import { Dialog, confirmDialog } from '../dialog.js';
import { iconEl } from '../icons.js';
import {
  FONT_FAMILIES, fontStack, googleNameFor, normalizeFontId, GOOGLE_PREFIX,
} from '../../text/fonts.js';
import { loadCatalog, searchFamilies, catalogCategories, catalogSize } from '../../text/font-catalog.js';
import {
  installedFamilies, isInstalled, downloadFamily, removeFamily, hydrateInstalledFonts, webfontsAllowed,
} from '../../text/font-manager.js';
import { fontsUsedBy } from '../../text/font-table.js';
import { requestPreviews, previewState, onPreviewState, setPreviewText, retryFailedPreviews } from '../../text/font-previews.js';
import { isOffline } from '../../io/offline.js';

/**
 * The font browser.
 *
 * ~1,900 families, so the list is windowed: a spacer of the full height, a pool
 * of rows the size of the viewport, and `translateY` to put them under the
 * scroll position. That is not only about DOM cost — windowing means the code
 * already knows which families are visible, which is exactly what the preview
 * batcher needs. Plain rows plus an IntersectionObserver would be more
 * machinery to learn the same fact, and would fire in bursts of hundreds during
 * a fling.
 *
 * Downloading is always explicit. Selecting a row never costs a request; the
 * only thing that does is pressing Get, or choosing a family that is not local
 * and confirming with the primary button.
 */

const ROW_H = 34;
const OVERSCAN = 6;
const PREVIEW_KEY = 'pikado.fonts.preview';

/** Built-ins presented in the same shape as a catalogue entry. */
function builtinRows() {
  return FONT_FAMILIES.map((f) => ({
    family: f.name,
    id: f.id,
    category: (f.category || '').toLowerCase().replace('sans', 'sans-serif').replace('script', 'handwriting'),
    builtin: true,
    google: f.google || '',
  }));
}

function catalogRow(e) {
  return { family: e.family, id: `${GOOGLE_PREFIX}${e.family}`, category: e.category, builtin: false };
}

/**
 * @param {{initial?:string}} [opts]
 * @returns {Promise<string|null>} the chosen font id, or null
 */
export async function showFontsDialog(opts = {}) {
  const dlg = new Dialog({ title: 'Fonts', width: 760, className: 'pkf-dialog' });
  await Promise.all([loadCatalog(), hydrateInstalledFonts()]);

  let chosen = normalizeFontId(opts.initial || '');
  let scope = 'all';
  let category = '';
  let query = '';
  let rows = [];
  let active = -1;

  let sample = '';
  try { sample = localStorage.getItem(PREVIEW_KEY) || ''; } catch { /* private mode */ }
  setPreviewText(sample);

  /* --- controls ---------------------------------------------------- */

  const search = el('input.pk-input.pkf-search', { type: 'search', placeholder: 'Search fonts…' });
  const previewInput = el('input.pk-input.pkf-sample', { type: 'text', placeholder: 'Preview text…', value: sample });

  const cats = el('div.pkd-cats');
  const catButton = (value, label) => {
    const b = el('button.pkd-cat', { type: 'button', text: label, onclick: () => { category = value; paintChips(); rebuild(); } });
    b.dataset.value = value;
    return b;
  };
  const catButtons = [catButton('', 'All'), ...catalogCategories().map((c) => catButton(c, c.replace('-serif', ' Serif').replace(/^\w/, (m) => m.toUpperCase())))];
  cats.append(...catButtons);

  const scopes = el('div.pkd-seg');
  const scopeButtons = [['all', 'All'], ['downloaded', 'Downloaded'], ['document', 'In document']].map(([v, label]) => {
    const b = el('button.pk-seg-btn', { type: 'button', text: label, onclick: () => { scope = v; paintChips(); rebuild(); } });
    b.dataset.value = v;
    return b;
  });
  scopes.append(...scopeButtons);

  const paintChips = () => {
    for (const b of catButtons) b.classList.toggle('active', b.dataset.value === category);
    for (const b of scopeButtons) b.classList.toggle('active', b.dataset.value === scope);
  };
  paintChips();

  const strip = el('div.pkf-strip');
  strip.hidden = true;

  /* --- the windowed list ------------------------------------------- */

  const spacer = el('div.pkf-spacer');
  const pool = el('div.pkf-pool');
  const scroller = el('div.pkf-scroll.pk-scroll', { role: 'listbox', tabindex: '0' }, spacer, pool);
  const empty = el('div.pkf-empty');
  empty.hidden = true;

  const nodes = [];
  const footer = el('div.pkf-count');

  const rowNode = () => {
    const name = el('div.pkf-name.pk-truncate');
    const spec = el('div.pkf-spec');
    const action = el('div.pkf-action');
    const row = el('button.pkf-row', { type: 'button', role: 'option' }, name, spec, action);
    row.addEventListener('click', () => {
      const i = Number(row.dataset.index);
      if (Number.isFinite(i)) { active = i; chosen = rows[i].id; render(); syncPrimary(); }
    });
    return { row, name, spec, action };
  };

  const paintRow = (n, entry, index) => {
    n.row.dataset.index = String(index);
    n.row.id = `pkf-opt-${index}`;
    n.row.classList.toggle('active', index === active);
    n.name.textContent = entry.family;

    const st = entry.builtin || isInstalled(entry.id) ? 'ready' : previewState(entry.family);
    n.spec.textContent = sample || 'The quick brown fox';
    n.spec.style.fontFamily = st === 'ready' ? fontStack(entry.id, entry.category) : '';
    n.spec.classList.toggle('waiting', st === 'loading' || st === 'unknown');
    n.spec.classList.toggle('unavailable', st === 'failed' || st === 'offline');
    n.spec.title = st === 'offline' ? 'No preview while offline'
      : st === 'failed' ? 'The preview could not be loaded' : '';

    n.action.replaceChildren(...actionFor(entry));
  };

  const actionFor = (entry) => {
    if (entry.builtin && !entry.google) return [el('span.pkf-tag', { text: 'Built-in' })];
    if (isInstalled(entry.id)) {
      const meta = installedFamilies().find((f) => f.family === googleNameFor(entry.id));
      return [
        el('span.pkf-tag.ok', { text: meta ? `${Math.max(1, Math.round(meta.bytes / 1024))} KB` : 'Ready' }),
        el('button.pk-icon-btn.pkf-trash', {
          type: 'button', title: `Remove ${entry.family}`,
          onclick: async (ev) => { ev.stopPropagation(); await remove(entry); },
        }, iconEl('trash')),
      ];
    }
    const btn = el('button.pk-btn.subtle.pkf-get', {
      type: 'button',
      text: 'Get',
      disabled: isOffline() || !webfontsAllowed(),
      title: isOffline() ? 'You are offline'
        : !webfontsAllowed() ? 'Downloading fonts is turned off in Preferences' : '',
      onclick: (ev) => { ev.stopPropagation(); get(entry, btn); },
    });
    return [btn];
  };

  async function get(entry, btn) {
    const family = googleNameFor(entry.id) || entry.family;
    btn.disabled = true;
    btn.textContent = 'Getting…';
    try {
      await downloadFamily(family, {
        onProgress: (done, total) => { btn.textContent = total > 1 ? `${done}/${total}` : 'Getting…'; },
      });
      render();
      syncPrimary();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Retry';
      // A user-initiated download that fails should say so out loud, not only
      // as a tooltip on a row they may already have scrolled past.
      app.toast((err && err.message) || `${family} could not be downloaded.`, 'error', 5000);
    }
  }

  async function remove(entry) {
    const family = googleNameFor(entry.id) || entry.family;
    const users = [...app.docs].reduce((n, d) => n + ([...fontsUsedBy(d)].includes(entry.id) ? 1 : 0), 0);
    const ok = await confirmDialog(
      users
        ? `${family} is used by ${users} open ${users === 1 ? 'document' : 'documents'}. They will render in a substitute face.`
        : `Remove ${family}?`,
      `Remove ${family}`, 'Remove', { danger: true },
    );
    if (!ok) return;
    await removeFamily(family);
    rebuild();
  }

  /* --- windowing --------------------------------------------------- */

  const visibleRange = () => {
    const top = scroller.scrollTop;
    const count = Math.ceil(scroller.clientHeight / ROW_H) + OVERSCAN * 2;
    const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    return { first, last: Math.min(rows.length, first + count) };
  };

  const visibleRows = () => {
    const { first, last } = visibleRange();
    return rows.slice(first, last);
  };

  function render() {
    const { first, last } = visibleRange();
    const need = last - first;
    while (nodes.length < need) { const n = rowNode(); nodes.push(n); pool.appendChild(n.row); }
    for (let i = 0; i < nodes.length; i++) {
      const entry = rows[first + i];
      nodes[i].row.hidden = i >= need || !entry;
      if (entry && i < need) paintRow(nodes[i], entry, first + i);
    }
    pool.style.transform = `translateY(${first * ROW_H}px)`;
    spacer.style.height = `${rows.length * ROW_H}px`;

    // Only families with no local face need a specimen fetched.
    const wanted = visibleRows().filter((e) => !e.builtin && !isInstalled(e.id));
    if (wanted.length) requestPreviews(wanted, () => visibleRows().filter((e) => !e.builtin && !isInstalled(e.id)));
    syncStrip();
  }

  function rebuild() {
    const installedIds = new Set(installedFamilies().map((f) => f.id));
    const docIds = app.activeDoc ? fontsUsedBy(app.activeDoc) : new Set();

    let list;
    if (scope === 'downloaded') {
      list = installedFamilies().map((f) => ({ family: f.family, id: f.id, category: f.category, builtin: false }));
    } else if (scope === 'document') {
      list = [...docIds].map((id) => {
        const b = builtinRows().find((r) => r.id === id);
        return b || { family: googleNameFor(id) || id, id, category: '', builtin: false };
      });
    } else {
      list = [...builtinRows(), ...searchFamilies({ q: query, category }).map(catalogRow)];
    }

    // A catalogue family that is also a built-in is one family, not two.
    const seen = new Set();
    list = list.filter((e) => {
      const key = normalizeFontId(e.id);
      if (seen.has(key)) return false;
      seen.add(key);
      if (category && e.category !== category) return false;
      if (query && !e.family.toLowerCase().includes(query)) return false;
      return true;
    });

    rows = list;
    active = rows.findIndex((e) => normalizeFontId(e.id) === chosen);
    empty.hidden = rows.length > 0;
    empty.replaceChildren(
      el('p', { text: query ? `Nothing matches “${query}”.` : 'Nothing here yet.' }),
      el('button.pk-btn.subtle', {
        type: 'button', text: 'Clear filters',
        onclick: () => { query = ''; category = ''; scope = 'all'; search.value = ''; paintChips(); rebuild(); },
      }),
    );
    footer.textContent = `${rows.length.toLocaleString()} of ${catalogSize().toLocaleString()} families`
      + ` · ${installedIds.size} downloaded`;
    scroller.scrollTop = 0;
    render();
    syncPrimary();
  }

  function syncStrip() {
    const off = isOffline();
    const anyFailed = visibleRows().some((e) => previewState(e.family) === 'failed');
    strip.hidden = !off && !anyFailed;
    if (strip.hidden) return;
    strip.replaceChildren(
      el('span', { text: off ? 'Offline — previews and downloads are unavailable.' : 'Some previews could not be loaded.' }),
      ...(off ? [] : [el('button.pk-btn.subtle', {
        type: 'button', text: 'Retry previews',
        onclick: () => { retryFailedPreviews(); render(); },
      })]),
    );
  }

  /* --- wiring ------------------------------------------------------ */

  let searchTimer = null;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = search.value.trim().toLowerCase(); rebuild(); }, 120);
  });

  let sampleTimer = null;
  previewInput.addEventListener('input', () => {
    clearTimeout(sampleTimer);
    sampleTimer = setTimeout(() => {
      sample = previewInput.value;
      setPreviewText(sample);
      try { localStorage.setItem(PREVIEW_KEY, sample); } catch { /* private mode */ }
      render();
    }, 200);
  });

  scroller.addEventListener('scroll', () => render(), { passive: true });

  scroller.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Home') { e.preventDefault(); moveTo(0); }
    else if (e.key === 'End') { e.preventDefault(); moveTo(rows.length - 1); }
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Escape' && search.value) { e.stopPropagation(); search.value = ''; query = ''; rebuild(); }
  });

  const move = (d) => moveTo(active < 0 ? 0 : active + d);
  const moveTo = (i) => {
    if (!rows.length) return;
    active = Math.max(0, Math.min(rows.length - 1, i));
    chosen = rows[active].id;
    const top = active * ROW_H;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + ROW_H > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = top + ROW_H - scroller.clientHeight;
    }
    scroller.setAttribute('aria-activedescendant', `pkf-opt-${active}`);
    render();
    syncPrimary();
  };

  const offPreview = onPreviewState(() => render());
  const offFonts = app.on('fonts-changed', () => render());
  dlg.onClose(() => { offPreview(); offFonts(); });

  /* --- shell ------------------------------------------------------- */

  const syncPrimary = () => {
    const entry = rows[active];
    const needsGet = entry && !entry.builtin && !isInstalled(entry.id);
    dlg.setButtons([
      { label: 'Cancel', value: null, subtle: true },
      {
        label: needsGet ? 'Download and use' : 'Use font',
        primary: true,
        onClick: async (d) => {
          const e = rows[active];
          if (!e) { d.close(null); return false; }
          if (!e.builtin && !isInstalled(e.id)) {
            try { await downloadFamily(googleNameFor(e.id) || e.family); } catch (err) {
              app.toast((err && err.message) || 'The font could not be downloaded.', 'error', 5000);
              return false;
            }
          }
          d.close(e.id);
          return false;
        },
      },
    ]);
  };

  dlg.setBody(
    el('div.pkf-tools', {},
      el('div.pkf-tools-row', {}, search, previewInput),
      cats,
      scopes),
    strip,
    scroller,
    empty,
    footer,
  );

  rebuild();
  const result = await dlg.open();
  return result || null;
}
