import { registerPanel } from '../panel-host.js';
import { app } from '../../core/app.js';
import { el, clamp } from '../../core/util.js';
import { LayerType } from '../../core/layer.js';
import { parseColor, toHex } from '../../core/color.js';
import { iconEl } from '../icons.js';
import { colorSwatchButton } from '../color-picker.js';
import { normalizeFontId, BROWSE_FONTS } from '../../text/fonts.js';
import { fontOptions, resolveFontChoice } from '../font-field.js';
import './panels.css';
import './character.css';

/**
 * The Character panel (with a Paragraph section).
 *
 * With a text layer active it edits `layer.text` and re-rasterises through
 * `rasterizeTextLayer`; otherwise it edits `app.textDefaults`, which the Type
 * tool uses for the next text layer it creates.
 */

const DEFAULT_TEXT = {
  fontFamily: 'system',
  fontStyle: 'regular',
  fontSize: 24,
  leading: 0,          // 0 = auto (1.2 × size)
  tracking: 0,         // 1/1000 em
  kerning: 'metrics',
  verticalScale: 100,
  horizontalScale: 100,
  baselineShift: 0,
  color: '#000000',
  fauxBold: false,
  fauxItalic: false,
  underline: false,
  strikethrough: false,
  allCaps: false,
  smallCaps: false,
  superscript: false,
  subscript: false,
  antiAlias: 'smooth',
  align: 'left',
  indentLeft: 0,
  indentRight: 0,
  indentFirst: 0,
  spaceBefore: 0,
  spaceAfter: 0,
  hyphenate: false,
};

if (!app.textDefaults) app.textDefaults = { ...DEFAULT_TEXT };

const STYLES = [
  { value: 'regular', label: 'Regular' },
  { value: 'italic', label: 'Italic' },
  { value: 'bold', label: 'Bold' },
  { value: 'bold italic', label: 'Bold Italic' },
];

const ANTIALIAS = [
  { value: 'none', label: 'None' },
  { value: 'sharp', label: 'Sharp' },
  { value: 'crisp', label: 'Crisp' },
  { value: 'strong', label: 'Strong' },
  { value: 'smooth', label: 'Smooth' },
];

const TOGGLES = [
  { key: 'fauxBold', label: 'B', title: 'Faux Bold', className: 'is-bold' },
  { key: 'fauxItalic', label: 'I', title: 'Faux Italic', className: 'is-italic' },
  { key: 'underline', label: 'U', title: 'Underline', className: 'is-under' },
  { key: 'strikethrough', label: 'S', title: 'Strikethrough', className: 'is-strike' },
  { key: 'allCaps', label: 'TT', title: 'All Caps' },
  { key: 'smallCaps', label: 'Tt', title: 'Small Caps' },
  { key: 'superscript', label: 'T¹', title: 'Superscript' },
  { key: 'subscript', label: 'T₁', title: 'Subscript' },
];

/** Superscript and subscript cannot both be on. */
const EXCLUSIVE = { superscript: 'subscript', subscript: 'superscript' };

let rasterizer = null;

async function rasterize(doc, layer) {
  if (!rasterizer) {
    const mod = await import('../../text/text-render.js');
    rasterizer = mod.rasterizeTextLayer;
  }
  doc.beginEdit(layer);
  // rasterizeTextLayer() also stores the canvas on the layer, but assign the
  // return value explicitly so this does not depend on that side effect.
  const cv = await rasterizer(layer, doc);
  if (cv) layer.canvas = cv;
  layer.thumbDirty = true;
}

registerPanel({
  id: 'character',
  title: 'Character',
  icon: 'text',
  group: 'bottom',
  order: 4,
  defaultOpen: true,
  build(body) {
    body.classList.add('pkt-body');
    const controls = [];
    let queue = Promise.resolve();

    const textLayer = () => {
      const doc = app.activeDoc;
      const l = doc && doc.activeLayer();
      return l && l.type === LayerType.TEXT && l.text ? l : null;
    };

    const source = () => {
      const l = textLayer();
      return l ? l.text : app.textDefaults;
    };

    const get = (key) => {
      const v = source()[key];
      return v == null ? DEFAULT_TEXT[key] : v;
    };

    const applyToLayer = (commitLabel) => {
      const doc = app.activeDoc;
      const layer = textLayer();
      if (!doc || !layer) return;
      queue = queue
        .then(async () => {
          await rasterize(doc, layer);
          if (commitLabel) doc.commit(commitLabel);
          else doc.touch('text');
        })
        .catch((err) => {
          console.error(err);
          app.toast('Could not re-render the text layer.', 'error');
        });
    };

    /**
     * @param {string} key
     * @param {any} value
     * @param {boolean} live true while dragging — no history entry yet
     */
    const set = (key, value, live) => {
      const target = source();
      target[key] = value;
      if (EXCLUSIVE[key] && value) target[EXCLUSIVE[key]] = false;
      applyToLayer(live ? null : 'Character');
      sync();
    };

    /* ---- control builders --------------------------------------- */

    const numField = (label, key, { min = -9999, max = 9999, step = 1, unit = '', hint = '' } = {}) => {
      const input = el('input.pk-input.pkt-num', { type: 'number', min, max, step });
      input.addEventListener('input', () => {
        if (input.value === '') return;
        const v = Number(input.value);
        if (Number.isFinite(v)) set(key, clamp(v, min, max), true);
      });
      input.addEventListener('change', () => {
        if (input.value === '') return;
        const v = Number(input.value);
        if (Number.isFinite(v)) set(key, clamp(v, min, max), false);
      });
      controls.push(() => { if (document.activeElement !== input) input.value = get(key); });
      return el('label.pkt-field', { title: hint },
        el('span.pkt-label', { text: label }),
        input,
        unit ? el('span.pk-unit', { text: unit }) : null
      );
    };

    const selectField = (label, key, options) => {
      const sel = el('select.pk-select.pkt-select');
      for (const o of options) {
        const value = typeof o === 'string' ? o : o.value;
        const text = typeof o === 'string' ? o : o.label;
        sel.appendChild(el('option', { value, text }));
      }
      sel.addEventListener('change', () => set(key, sel.value, false));
      controls.push(() => { sel.value = get(key); });
      return el('label.pkt-field.pkt-wide', {},
        el('span.pkt-label', { text: label }),
        sel
      );
    };

    /*
     * The font row rebuilds its options on every sync rather than being built
     * once, because the list grows: a family downloaded while the panel is open
     * has to appear, and a layer can carry a family that is not in the list at
     * all. It used to be a fixed list of raw CSS names ('Arial', 'sans-serif'),
     * which is a different vocabulary from the ids the Type tool writes — so
     * this select showed the wrong family for every layer the Type tool made,
     * and PSD export of one of its values silently lost the real face.
     */
    const fontField = () => {
      const sel = el('select.pk-select.pkt-select');
      sel.addEventListener('change', async () => {
        const previous = normalizeFontId(get('fontFamily'));
        // The last row opens the catalogue rather than naming a font.
        const picked = await resolveFontChoice(sel.value, previous);
        if (!picked) { sel.value = previous; return; }
        set('fontFamily', picked, false);
      });
      controls.push(() => {
        const current = normalizeFontId(get('fontFamily'));
        const opts = fontOptions(current);
        const same = sel.options.length === opts.length
          && opts.every((o, i) => sel.options[i] && sel.options[i].value === o.value);
        if (!same) sel.replaceChildren(...opts.map((o) => el('option', { value: o.value, text: o.label })));
        sel.value = current;
      });
      return el('label.pkt-field.pkt-wide', {},
        el('span.pkt-label', { text: 'Font' }), sel);
    };

    const checkField = (label, key) => {
      const input = el('input', { type: 'checkbox' });
      input.addEventListener('change', () => set(key, input.checked, false));
      controls.push(() => { input.checked = !!get(key); });
      return el('label.pk-check.pkt-check', {}, input, el('span', { text: label }));
    };

    /* ---- character section --------------------------------------- */

    const toggleStrip = el('div.pkt-toggles');
    for (const t of TOGGLES) {
      const btn = el(`button.pkt-toggle${t.className ? `.${t.className}` : ''}`, {
        type: 'button', title: t.title, text: t.label,
        onclick: () => set(t.key, !get(t.key), false),
      });
      controls.push(() => btn.classList.toggle('is-on', !!get(t.key)));
      toggleStrip.appendChild(btn);
    }

    const colorBtn = colorSwatchButton(
      () => get('color'),
      (c) => set('color', toHex(parseColor(c)), false),
      { title: 'Text Color', live: false }
    );
    controls.push(() => colorBtn.sync());

    const charSection = el('div.pkt-section', {},
      fontField(),
      selectField('Style', 'fontStyle', STYLES),
      el('div.pkt-pair', {},
        numField('Size', 'fontSize', { min: 1, max: 1600, unit: 'px' }),
        numField('Leading', 'leading', { min: 0, max: 3000, unit: 'px', hint: '0 = automatic (1.2 × size)' })
      ),
      el('div.pkt-pair', {},
        numField('Tracking', 'tracking', { min: -1000, max: 1000, hint: 'Letter spacing in 1/1000 em' }),
        selectField('Kerning', 'kerning', [
          { value: 'metrics', label: 'Metrics' },
          { value: 'optical', label: 'Optical' },
          { value: 'none', label: 'Off' },
        ])
      ),
      el('div.pkt-pair', {},
        numField('V scale', 'verticalScale', { min: 5, max: 1000, unit: '%' }),
        numField('H scale', 'horizontalScale', { min: 5, max: 1000, unit: '%' })
      ),
      el('div.pkt-pair', {},
        numField('Baseline', 'baselineShift', { min: -500, max: 500, unit: 'px' }),
        el('label.pkt-field', {}, el('span.pkt-label', { text: 'Color' }), colorBtn)
      ),
      toggleStrip,
      selectField('Anti-alias', 'antiAlias', ANTIALIAS)
    );

    /* ---- paragraph section ---------------------------------------- */

    const alignStrip = el('div.pkt-aligns');
    const ALIGNS = [
      { value: 'left', icon: 'align-left', title: 'Align left' },
      { value: 'center', icon: 'align-center-h', title: 'Align centre' },
      { value: 'right', icon: 'align-right', title: 'Align right' },
    ];
    for (const a of ALIGNS) {
      const btn = el('button.pk-icon-btn.pkt-align', { type: 'button', title: a.title, onclick: () => set('align', a.value, false) }, iconEl(a.icon));
      controls.push(() => btn.classList.toggle('active', get('align') === a.value));
      alignStrip.appendChild(btn);
    }
    const justifyBtn = el('button.pkt-toggle.pkt-justify', {
      type: 'button', title: 'Justify', text: 'J',
      onclick: () => set('align', 'justify', false),
    });
    controls.push(() => justifyBtn.classList.toggle('is-on', get('align') === 'justify'));
    alignStrip.appendChild(justifyBtn);

    const paraSection = el('div.pkt-section', {},
      alignStrip,
      el('div.pkt-pair', {},
        numField('Indent L', 'indentLeft', { min: -2000, max: 2000, unit: 'px' }),
        numField('Indent R', 'indentRight', { min: -2000, max: 2000, unit: 'px' })
      ),
      el('div.pkt-pair', {},
        numField('First line', 'indentFirst', { min: -2000, max: 2000, unit: 'px' }),
        numField('Space ↑', 'spaceBefore', { min: 0, max: 2000, unit: 'px' })
      ),
      el('div.pkt-pair', {},
        numField('Space ↓', 'spaceAfter', { min: 0, max: 2000, unit: 'px' }),
        checkField('Hyphenate', 'hyphenate')
      )
    );

    const scope = el('div.pkt-scope');

    body.append(
      scope,
      charSection,
      el('div.pkt-heading', { text: 'Paragraph' }),
      paraSection
    );

    /* ---- sync ----------------------------------------------------- */

    const sync = () => {
      const l = textLayer();
      scope.textContent = l
        ? `Editing “${l.name}”`
        : 'No text layer selected — these are the defaults for the next one.';
      scope.classList.toggle('is-defaults', !l);
      for (const fn of controls) fn();
    };

    app.on('active-doc', sync);
    app.on('doc-structure', sync);
    app.on('doc-selection', sync);

    sync();
    return { refresh: sync };
  },
});
