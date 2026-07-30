import { el } from '../core/util.js';
import { toHex, parseColor } from '../core/color.js';
import { OVERLAY } from './brand.js';

/**
 * Dialog framework + automatic form generation.
 *
 * `buildForm(params, state, onChange)` turns an array of ParamDescriptors into
 * a live control panel. Filters, adjustments and tool option bars all use it,
 * so implementations never write UI code.
 *
 * ParamDescriptor:
 *   {key, label, type, min, max, step, default, options, unit, hint, when}
 *   type: slider | number | select | checkbox | color | angle | text | textarea
 *       | radio | range2 | label | separator | button | curve | gradient | custom
 *   `when(state)` -> boolean controls conditional visibility.
 *   `render(container, state, onChange, descriptor)` for type 'custom'.
 */

let zTop = 1000;

export class Dialog {
  constructor({ title = '', width = 380, resizable = false, className = '' } = {}) {
    this.title = title;
    this.width = width;
    this.result = null;
    this._resolve = null;
    this._onClose = [];

    this.overlay = el('div.pk-dialog-overlay');
    this.root = el('div.pk-dialog' + (className ? `.${className}` : ''), { style: { width: `${width}px` } });
    this.header = el('div.pk-dialog-header', {},
      el('span.pk-dialog-title', { text: title }),
      el('button.pk-dialog-close', { title: 'Close', onclick: () => this.close(null) }, '×')
    );
    this.body = el('div.pk-dialog-body');
    this.footer = el('div.pk-dialog-footer');
    this.root.append(this.header, this.body, this.footer);
    this.overlay.append(this.root);

    if (resizable) this.root.classList.add('resizable');
    this._makeDraggable();

    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) this.close(null);
    });
    this._keyHandler = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); this.close(null); }
      else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) {
        const ok = this.footer.querySelector('.pk-btn.primary');
        if (ok) { e.stopPropagation(); e.preventDefault(); ok.click(); }
      }
    };
  }

  _makeDraggable() {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    this.header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      const r = this.root.getBoundingClientRect();
      ox = r.left; oy = r.top;
      sx = e.clientX; sy = e.clientY;
      this.root.style.position = 'fixed';
      this.root.style.margin = '0';
      this.root.style.left = `${ox}px`;
      this.root.style.top = `${oy}px`;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      this.root.style.left = `${ox + e.clientX - sx}px`;
      this.root.style.top = `${oy + e.clientY - sy}px`;
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  }

  setBody(...nodes) {
    this.body.replaceChildren(...nodes.flat());
    return this;
  }

  /** buttons: [{label, value, primary, onClick}] */
  setButtons(buttons) {
    this.footer.replaceChildren(
      ...buttons.map((b) =>
        el('button.pk-btn' + (b.primary ? '.primary' : '') + (b.subtle ? '.subtle' : ''), {
          text: b.label,
          onclick: () => {
            if (b.onClick && b.onClick(this) === false) return;
            if (b.value !== undefined) this.close(b.value);
          },
        })
      )
    );
    return this;
  }

  open() {
    this.overlay.style.zIndex = String(++zTop);
    document.body.appendChild(this.overlay);
    window.addEventListener('keydown', this._keyHandler, true);

    // The overlay starts at opacity 0 and transitions in once `.open` lands, so
    // the class has to be added on a later tick or the transition never plays.
    // requestAnimationFrame alone is not enough: a backgrounded tab never fires
    // it, which leaves the dialog mounted but permanently invisible. Race it
    // against a timer so the dialog always becomes visible.
    let shown = false;
    const reveal = () => {
      if (shown) return;
      shown = true;
      this.overlay.classList.add('open');
      const f = this.body.querySelector('input,select,textarea,button');
      if (f && f.type !== 'range') f.focus();
    };
    requestAnimationFrame(reveal);
    setTimeout(reveal, 40);

    return new Promise((res) => { this._resolve = res; });
  }

  close(value) {
    if (!this.overlay.isConnected) return;
    window.removeEventListener('keydown', this._keyHandler, true);
    this.overlay.classList.remove('open');
    this.overlay.remove();
    for (const fn of this._onClose) fn(value);
    if (this._resolve) this._resolve(value);
    this._resolve = null;
  }

  onClose(fn) {
    this._onClose.push(fn);
    return this;
  }
}

/* ------------------------------------------------------------------ */
/* Simple helpers                                                      */
/* ------------------------------------------------------------------ */

export function alertDialog(message, title = 'Pikado') {
  const d = new Dialog({ title, width: 340 });
  d.setBody(el('p.pk-msg', { text: message }));
  d.setButtons([{ label: 'OK', value: true, primary: true }]);
  return d.open();
}

export function confirmDialog(message, title = 'Pikado', okLabel = 'OK') {
  const d = new Dialog({ title, width: 360 });
  d.setBody(el('p.pk-msg', { text: message }));
  d.setButtons([
    { label: 'Cancel', value: false, subtle: true },
    { label: okLabel, value: true, primary: true },
  ]);
  return d.open();
}

export function promptDialog(message, initial = '', title = 'Pikado') {
  const d = new Dialog({ title, width: 360 });
  const input = el('input.pk-input', { type: 'text', value: initial });
  d.setBody(el('div.pk-field', {}, el('label', { text: message }), input));
  d.setButtons([
    { label: 'Cancel', value: null, subtle: true },
    { label: 'OK', primary: true, onClick: (dlg) => { dlg.close(input.value); return false; } },
  ]);
  const p = d.open();
  requestAnimationFrame(() => { input.focus(); input.select(); });
  return p;
}

/**
 * A dialog whose body is an auto-generated form.
 * @returns {Promise<object|null>} the final state, or null on cancel.
 */
export function paramDialog({ title, params, state, width = 400, onPreview, onCommit, extraButtons = [], preview = true }) {
  const working = { ...state };
  const d = new Dialog({ title, width });
  let previewOn = true;

  const rerender = () => {
    if (previewOn && onPreview) onPreview(working);
  };

  const form = buildForm(params, working, (key, value) => {
    working[key] = value;
    form.refresh();
    rerender();
  });

  const previewToggle = el('label.pk-check.pk-preview-toggle', {},
    el('input', {
      type: 'checkbox', checked: true,
      onchange: (e) => {
        previewOn = e.target.checked;
        if (onPreview) onPreview(previewOn ? working : null);
      },
    }),
    el('span', { text: 'Preview' })
  );

  d.setBody(form.node);
  d.setButtons([
    ...(preview ? [] : []),
    { label: 'Cancel', value: null, subtle: true },
    { label: 'OK', primary: true, onClick: (dlg) => { dlg.close({ ...working }); return false; } },
    ...extraButtons,
  ]);
  if (preview) d.footer.prepend(previewToggle);

  d.onClose((v) => {
    if (onPreview) onPreview(null);
    if (v && onCommit) onCommit(v);
  });

  const p = d.open();
  rerender();
  return p;
}

/* ------------------------------------------------------------------ */
/* Form builder                                                        */
/* ------------------------------------------------------------------ */

/**
 * @param {object[]} params
 * @param {object} state
 * @param {(key:string, value:any)=>void} onChange
 * @returns {{node:HTMLElement, refresh:()=>void, controls:Map}}
 */
export function buildForm(params, state, onChange) {
  const node = el('div.pk-form');
  const controls = new Map();
  const rows = [];

  for (const p of params) {
    const row = buildControl(p, state, onChange, controls);
    if (!row) continue;
    rows.push({ p, row });
    node.appendChild(row);
  }

  const refresh = () => {
    for (const { p, row } of rows) {
      row.style.display = p.when && !p.when(state) ? 'none' : '';
    }
    for (const [key, setter] of controls) {
      if (setter.sync) setter.sync(state[key]);
    }
  };
  refresh();

  return { node, refresh, controls, state };
}

function buildControl(p, state, onChange, controls) {
  const change = (v) => onChange(p.key, v);

  if (p.type === 'separator') return el('hr.pk-sep');
  if (p.type === 'label') return el('div.pk-form-label', { text: p.label, class: p.className || '' });
  if (p.type === 'custom') {
    const holder = el('div.pk-field.pk-custom');
    if (p.label) holder.appendChild(el('label', { text: p.label }));
    const inner = el('div.pk-custom-body');
    holder.appendChild(inner);
    if (p.render) {
      const api = p.render(inner, state, onChange, p);
      if (api && api.sync) controls.set(p.key, api);
    }
    return holder;
  }
  if (p.type === 'button') {
    return el('div.pk-field', {}, el('button.pk-btn.subtle', { text: p.label, onclick: () => p.onClick && p.onClick(state, onChange) }));
  }

  const row = el('div.pk-field' + (p.type === 'checkbox' ? '.inline' : ''));
  if (p.label && p.type !== 'checkbox') row.appendChild(el('label', { text: p.label, for: `pk_${p.key}` }));

  switch (p.type) {
    case 'slider': {
      const wrap = el('div.pk-slider-row');
      const range = el('input.pk-range', {
        type: 'range', id: `pk_${p.key}`,
        min: p.min, max: p.max, step: p.step == null ? 1 : p.step,
        value: state[p.key],
      });
      const num = el('input.pk-num', {
        type: 'number', min: p.min, max: p.max, step: p.step == null ? 1 : p.step,
        value: state[p.key],
      });
      const unit = p.unit ? el('span.pk-unit', { text: p.unit }) : null;
      range.addEventListener('input', () => { num.value = range.value; change(Number(range.value)); });
      num.addEventListener('input', () => {
        let v = Number(num.value);
        if (Number.isNaN(v)) return;
        v = Math.min(p.max, Math.max(p.min, v));
        range.value = v;
        change(v);
      });
      wrap.append(range, num);
      if (unit) wrap.append(unit);
      row.appendChild(wrap);
      controls.set(p.key, { sync: (v) => { if (document.activeElement !== num) num.value = v; range.value = v; } });
      break;
    }
    case 'number': {
      const num = el('input.pk-input.pk-num-wide', {
        type: 'number', id: `pk_${p.key}`,
        min: p.min, max: p.max, step: p.step == null ? 1 : p.step, value: state[p.key],
      });
      num.addEventListener('input', () => {
        let v = Number(num.value);
        if (Number.isNaN(v)) return;
        if (p.min != null) v = Math.max(p.min, v);
        if (p.max != null) v = Math.min(p.max, v);
        change(v);
      });
      const holder = p.unit ? el('div.pk-slider-row', {}, num, el('span.pk-unit', { text: p.unit })) : num;
      row.appendChild(holder);
      controls.set(p.key, { sync: (v) => { if (document.activeElement !== num) num.value = v; } });
      break;
    }
    case 'text': {
      const input = el('input.pk-input', { type: 'text', id: `pk_${p.key}`, value: state[p.key] ?? '' });
      input.addEventListener('input', () => change(input.value));
      row.appendChild(input);
      controls.set(p.key, { sync: (v) => { if (document.activeElement !== input) input.value = v ?? ''; } });
      break;
    }
    case 'textarea': {
      const input = el('textarea.pk-input.pk-textarea', { id: `pk_${p.key}`, rows: p.rows || 4 });
      input.value = state[p.key] ?? '';
      input.addEventListener('input', () => change(input.value));
      row.appendChild(input);
      controls.set(p.key, { sync: (v) => { if (document.activeElement !== input) input.value = v ?? ''; } });
      break;
    }
    case 'select': {
      const sel = el('select.pk-select', { id: `pk_${p.key}` });
      for (const o of p.options || []) {
        const val = typeof o === 'object' ? o.value : o;
        const lab = typeof o === 'object' ? o.label : String(o);
        sel.appendChild(el('option', { value: val, text: lab }));
      }
      sel.value = state[p.key];
      sel.addEventListener('change', () => {
        const raw = sel.value;
        const opt = (p.options || []).find((o) => String(typeof o === 'object' ? o.value : o) === raw);
        change(typeof opt === 'object' ? opt.value : (Number.isFinite(Number(raw)) && raw !== '' && typeof (typeof opt === 'object' ? opt.value : opt) === 'number' ? Number(raw) : raw));
      });
      row.appendChild(sel);
      controls.set(p.key, { sync: (v) => { sel.value = v; } });
      break;
    }
    case 'radio': {
      const group = el('div.pk-radio-group');
      for (const o of p.options || []) {
        const val = typeof o === 'object' ? o.value : o;
        const lab = typeof o === 'object' ? o.label : String(o);
        const input = el('input', {
          type: 'radio', name: `pk_${p.key}`, value: val,
          checked: state[p.key] === val,
          onchange: () => change(val),
        });
        group.appendChild(el('label.pk-radio', {}, input, el('span', { text: lab })));
      }
      row.appendChild(group);
      controls.set(p.key, {
        sync: (v) => {
          for (const i of group.querySelectorAll('input')) i.checked = String(i.value) === String(v);
        },
      });
      break;
    }
    case 'checkbox': {
      const input = el('input', { type: 'checkbox', id: `pk_${p.key}`, checked: !!state[p.key] });
      input.addEventListener('change', () => change(input.checked));
      row.appendChild(el('label.pk-check', {}, input, el('span', { text: p.label })));
      controls.set(p.key, { sync: (v) => { input.checked = !!v; } });
      break;
    }
    case 'color': {
      const swatch = el('button.pk-color-swatch', {
        type: 'button', id: `pk_${p.key}`,
        style: { background: state[p.key] || '#000' },
      });
      const hidden = el('input', { type: 'color', value: normalizeHex(state[p.key]), style: { display: 'none' } });
      hidden.addEventListener('input', () => { swatch.style.background = hidden.value; change(hidden.value); });
      swatch.addEventListener('click', () => hidden.click());
      row.append(swatch, hidden);
      controls.set(p.key, { sync: (v) => { swatch.style.background = v; hidden.value = normalizeHex(v); } });
      break;
    }
    case 'angle': {
      const dial = el('canvas.pk-angle', { width: 46, height: 46 });
      const num = el('input.pk-num', { type: 'number', min: -360, max: 360, step: 1, value: state[p.key] });
      const draw = (deg) => {
        const c = dial.getContext('2d');
        c.clearRect(0, 0, 46, 46);
        c.strokeStyle = 'rgba(255,255,255,.28)';
        c.lineWidth = 1;
        c.beginPath(); c.arc(23, 23, 19, 0, Math.PI * 2); c.stroke();
        const r = (-deg * Math.PI) / 180;
        c.strokeStyle = OVERLAY.accentHi;
        c.lineWidth = 2;
        c.beginPath(); c.moveTo(23, 23); c.lineTo(23 + Math.cos(r) * 17, 23 + Math.sin(r) * 17); c.stroke();
      };
      const setFromEvent = (e) => {
        const r = dial.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        let deg = Math.round((-Math.atan2(dy, dx) * 180) / Math.PI);
        num.value = deg;
        draw(deg);
        change(deg);
      };
      let down = false;
      dial.addEventListener('mousedown', (e) => { down = true; setFromEvent(e); });
      window.addEventListener('mousemove', (e) => { if (down) setFromEvent(e); });
      window.addEventListener('mouseup', () => { down = false; });
      num.addEventListener('input', () => { const v = Number(num.value) || 0; draw(v); change(v); });
      draw(state[p.key] || 0);
      row.appendChild(el('div.pk-slider-row', {}, dial, num, el('span.pk-unit', { text: '°' })));
      controls.set(p.key, { sync: (v) => { if (document.activeElement !== num) num.value = v; draw(v || 0); } });
      break;
    }
    default:
      return null;
  }

  if (p.hint) row.appendChild(el('div.pk-hint', { text: p.hint }));
  return row;
}

function normalizeHex(v) {
  try {
    return toHex(parseColor(v || '#000000'));
  } catch {
    return '#000000';
  }
}
