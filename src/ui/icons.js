/**
 * Icon set. `icon(name)` returns an inline SVG string sized 16×16 that
 * inherits `currentColor` via `stroke="currentColor"`.
 *
 * Anything drawing UI should use these names rather than inventing markup, so
 * the toolbar, panels and menus stay visually consistent.
 */

const P = {
  /* --- tools --- */
  move: '<path d="M8 1.5v13M1.5 8h13M8 1.5 5.5 4M8 1.5 10.5 4M8 14.5 5.5 12M8 14.5 10.5 12M1.5 8 4 5.5M1.5 8 4 10.5M14.5 8 12 5.5M14.5 8 12 10.5"/>',
  artboard: '<rect x="2" y="3.5" width="12" height="10" rx="1"/><path d="M2 6h12"/>',
  'marquee-rect': '<rect x="2" y="3.5" width="12" height="9" stroke-dasharray="2.4 1.8"/>',
  'marquee-ellipse': '<ellipse cx="8" cy="8" rx="6" ry="4.5" stroke-dasharray="2.4 1.8"/>',
  'marquee-row': '<path d="M1.5 6.5h13M1.5 9.5h13" stroke-dasharray="2.4 1.8"/>',
  'marquee-col': '<path d="M6.5 1.5v13M9.5 1.5v13" stroke-dasharray="2.4 1.8"/>',
  lasso: '<path d="M8 13.2c-3.4 0-6-2.2-6-5S4.6 3 8 3s6 2.3 6 5.1c0 1.7-1 3.2-2.6 4.1-.8.5-1.1 1-1.1 1.7 0 .6-.4 1-1 1s-1-.5-1-1.1c0-.5.2-.9.5-1.3"/>',
  'lasso-poly': '<path d="M2.5 9 6 3l4.5 3.5L14 4l-1.5 8.5-7 .5z" stroke-dasharray="2.6 1.6"/>',
  'lasso-magnetic': '<path d="M4 3v5a4 4 0 0 0 8 0V3M4 6h3M9 6h3"/>',
  wand: '<path d="M11 2.2 13.8 5 6 12.8 3.2 10zM10 3.2l2.8 2.8M2.5 3.5v2M1.5 4.5h2M12.5 10.5v2M11.5 11.5h2"/>',
  'quick-select': '<circle cx="6.5" cy="8" r="4" stroke-dasharray="2.2 1.6"/><path d="M11 4.5v5M8.5 7h5"/>',
  crop: '<path d="M4 1.5v10.5h10.5M1.5 4H12v10.5"/>',
  'crop-perspective': '<path d="M2 12.5 4.5 3.5h7L14 12.5z" stroke-dasharray="2.4 1.6"/>',
  slice: '<path d="M2 4h5v5H2zM9 4h5v5H9zM2 11h5v3H2z"/>',
  eyedropper: '<path d="m9.5 3.5 3 3M11 2l3 3-1.5 1.5-3-3zM10.5 5.5 4 12l-1.8.6L2.8 11 9.3 4.4z"/>',
  'color-sampler': '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3"/>',
  ruler: '<path d="M1.5 10 10 1.5l4.5 4.5L6 14.5zM4 7.5l1.5 1.5M6 5.5 7.5 7M8 3.5 9.5 5"/>',
  note: '<path d="M3 2.5h10v8l-3 3H3z"/><path d="M13 10.5h-3v3"/>',
  healing: '<path d="M6 2.5h4v3.5h3.5v4H10v3.5H6V10H2.5V6H6z"/>',
  'healing-brush': '<path d="M3 13c1.5-3 3.5-6 6-8.5M11.5 2.5 13.5 4.5 11 7 9 5z"/><circle cx="4" cy="12" r="1.6"/>',
  patch: '<path d="M2.5 6.5 6.5 2.5l7 7-4 4z" stroke-dasharray="2.4 1.6"/><path d="M5 9l2-2"/>',
  'red-eye': '<path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4z"/><circle cx="8" cy="8" r="1.8"/>',
  brush: '<path d="M12.5 2.5c1 1 1 2 0 3l-5 5-3-3 5-5c1-1 2-1 3 0zM4.5 7.5l3 3-2 2c-1 1-3 1-3.5.5s-.5-2.5.5-3.5z"/>',
  pencil: '<path d="m10.5 2 3.5 3.5L5.5 14 1.5 15l1-4zM9 3.5 12.5 7"/>',
  'mixer-brush': '<path d="M11.5 2.5c1.2 1.2 1.2 2.4 0 3.6l-5 5-3.6-3.6 5-5c1.2-1.2 2.4-1.2 3.6 0z"/><circle cx="12.5" cy="12" r="2"/>',
  'color-replace': '<circle cx="6" cy="8" r="4"/><path d="M10.5 4.5 14 8l-3.5 3.5"/>',
  stamp: '<path d="M5 6.5V5a3 3 0 0 1 6 0v1.5M3 6.5h10L12 11H4zM4 11v2.5h8V11"/>',
  'pattern-stamp': '<path d="M5 6.5V5a3 3 0 0 1 6 0v1.5M3 6.5h10L12 11H4z"/><path d="M5 8.5h6M5 10h6"/>',
  'history-brush': '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 3v3h3M8 5.5V8l2 1.5"/>',
  'art-history': '<path d="M3 8a5 5 0 1 0 1.5-3.5M3 3.5V7h3.5"/><path d="M8 6c1 1 1.5 2 1 3s-1.5 1-2 .5"/>',
  eraser: '<path d="m6 13.5-3.5-3.5a1.5 1.5 0 0 1 0-2l6-6a1.5 1.5 0 0 1 2 0l3 3a1.5 1.5 0 0 1 0 2l-6.5 6.5zM5 7.5 9.5 12M2.5 13.5h11"/>',
  'bg-eraser': '<path d="m6 13-3.5-3.5a1.5 1.5 0 0 1 0-2l6-6a1.5 1.5 0 0 1 2 0l3 3a1.5 1.5 0 0 1 0 2L7 13z" stroke-dasharray="2.4 1.6"/>',
  'magic-eraser': '<path d="m5 13-3-3 7-7 3 3z"/><path d="M12 2.5v2M11 3.5h2M13 11v2M12 12h2"/>',
  gradient: '<rect x="2" y="4" width="12" height="8" rx="1"/><path d="M3.5 11h9" stroke-width="3" stroke-opacity=".2"/><path d="M2 12h12" stroke-opacity=".5"/>',
  bucket: '<path d="M6.5 2.5 13 9l-5.5 5.5L1.5 8l5-5.5zM3 8h9"/><path d="M14 11c.7 1 1 1.6 1 2a1 1 0 0 1-2 0c0-.4.3-1 1-2z"/>',
  blur: '<path d="M8 2s4 4.2 4 6.6A4 4 0 0 1 4 8.6C4 6.2 8 2 8 2z"/>',
  sharpen: '<path d="M8 2 13 13H3z"/>',
  smudge: '<path d="M5 13c-1.5 0-2.5-1-2.5-2.4C2.5 8 8 2 8 2s2 2.2 3 4c1 1.7-.5 3-1.5 2.5-.8-.4-.5-1.5.5-1.5"/>',
  dodge: '<circle cx="6.5" cy="6.5" r="3.5"/><path d="M9.5 12.5c2.2 0 4-1.4 4-3"/>',
  burn: '<path d="M8 2c0 2-3 3.5-3 6.5a3 3 0 0 0 6 0C11 6 8 4.5 8 2z"/>',
  sponge: '<path d="M2.5 8.5c0-3 2.4-5 5.5-5s5.5 2 5.5 5v3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/><path d="M5.5 6.5h.01M8 5.5h.01M10.5 6.5h.01M6.5 9h.01M9.5 9h.01"/>',
  pen: '<path d="M8 1.5 12 6l-4 8.5L4 6z"/><path d="M4 6h8"/>',
  'pen-free': '<path d="M2 12c3-6 6-8 9-8.5M11 2 14 5l-2 1.5L9.5 4z"/>',
  'pen-curvature': '<path d="M2 11c4 0 4-6 8-6"/><circle cx="2" cy="11" r="1.4"/><circle cx="10" cy="5" r="1.4"/>',
  'pen-add': '<path d="M2 11c4 0 6-6 12-6"/><path d="M6 6.5v3M4.5 8h3"/>',
  'pen-delete': '<path d="M2 11c4 0 6-6 12-6"/><path d="M4.5 8h3"/>',
  'pen-convert': '<path d="M2 12c3 0 4-8 12-8"/><path d="M8 5.5 10 8l-2.5 1.5z"/>',
  type: '<path d="M2.5 3.5h11M8 3.5v10M5.5 13.5h5"/>',
  'type-vertical': '<path d="M3.5 2.5v11M3.5 8h10M13.5 5.5v5"/>',
  'type-mask': '<path d="M2.5 3.5h11M8 3.5v10" stroke-dasharray="2.2 1.6"/>',
  'path-select': '<path d="m3 2.5 9 5.5-4 1-1.5 4z"/>',
  'direct-select': '<path d="m3 2.5 9 5.5-4 1-1.5 4z" fill="none"/><rect x="1.5" y="1" width="2" height="2"/>',
  rectangle: '<rect x="2" y="4" width="12" height="8" rx="0.5"/>',
  'rounded-rect': '<rect x="2" y="4" width="12" height="8" rx="2.5"/>',
  ellipse: '<ellipse cx="8" cy="8" rx="6" ry="4.5"/>',
  polygon: '<path d="M8 2 14 6.4 11.7 13.4H4.3L2 6.4z"/>',
  line: '<path d="M2 13 14 3"/>',
  'custom-shape': '<path d="M8 13.5 3 9a3 3 0 0 1 5-3.4A3 3 0 0 1 13 9z"/>',
  hand: '<path d="M5 8V4.2a1.2 1.2 0 0 1 2.4 0V8m0-4.3a1.2 1.2 0 0 1 2.4 0V8m0-3.3a1.2 1.2 0 0 1 2.4 0v5.1c0 2-1.6 3.7-3.6 3.7H8.6c-1 0-1.9-.4-2.6-1.1L3 9.4a1.2 1.2 0 0 1 1.8-1.6L5 8"/>',
  'rotate-view': '<path d="M13 8a5 5 0 1 1-1.5-3.6M13.5 2v3h-3"/>',
  zoom: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/>',

  /* --- panel + menu --- */
  eye: '<path d="M1.5 8s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4-6.5-4-6.5-4z"/><circle cx="8" cy="8" r="1.7"/>',
  'eye-off': '<path d="M2 2l12 12M6.2 6.3A2 2 0 0 0 8 10a2 2 0 0 0 1.8-1.1M4.2 4.4C2.6 5.5 1.5 8 1.5 8s2.4 4 6.5 4c1 0 2-.2 2.8-.6M12.4 10A9 9 0 0 0 14.5 8S12.1 4 8 4c-.5 0-1 .1-1.4.2"/>',
  lock: '<rect x="3" y="7" width="10" height="7" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  unlock: '<rect x="3" y="7" width="10" height="7" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.8-1"/>',
  link: '<path d="M6.5 9.5a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-.8.8M9.5 6.5a2.5 2.5 0 0 0-3.5 0l-2 2a2.5 2.5 0 0 0 3.5 3.5l.8-.8"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  minus: '<path d="M3 8h10"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5 5 13.5h6l.5-9M6.5 7v4M9.5 7v4"/>',
  copy: '<rect x="5" y="5" width="9" height="9" rx="1"/><path d="M11 5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2"/>',
  folder: '<path d="M1.5 4.5h4l1.5 2h7.5v7h-13z"/>',
  'folder-open': '<path d="M1.5 4.5h4l1.5 2h5.5v1.5M1.5 6.5h13l-1.5 7h-11.5z"/>',
  mask: '<rect x="2" y="3" width="12" height="10" rx="1"/><circle cx="8" cy="8" r="3" fill="currentColor" stroke="none"/>',
  adjustment: '<circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" stroke="none"/>',
  fx: '<path d="M3.5 12.5V6a2 2 0 0 1 2-2h1M3 8h3.5M8.5 12.5 12.5 4M12.5 12.5 8.5 4"/>',
  chevron: '<path d="m5 6 3 3 3-3"/>',
  'chevron-right': '<path d="m6 4 3.5 4L6 12"/>',
  'chevron-left': '<path d="m10 4-3.5 4L10 12"/>',
  'chevron-up': '<path d="m5 10 3-3 3 3"/>',
  check: '<path d="m3.5 8.5 3 3 6-7"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  undo: '<path d="M3 8a5 5 0 1 1 1.6 3.7M2.5 3.5v4h4"/>',
  redo: '<path d="M13 8a5 5 0 1 0-1.6 3.7M13.5 3.5v4h-4"/>',
  history: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
  grid: '<path d="M2 6h12M2 10h12M6 2v12M10 2v12"/>',
  'flip-h': '<path d="M8 2v12M2 5.5 6 8l-4 2.5zM14 5.5 10 8l4 2.5z"/>',
  'flip-v': '<path d="M2 8h12M5.5 2 8 6l2.5-4zM5.5 14 8 10l2.5 4z"/>',
  'align-left': '<path d="M2.5 2v12M5 5h8M5 11h5"/>',
  'align-center-h': '<path d="M8 2v12M4 5h8M5.5 11h5"/>',
  'align-right': '<path d="M13.5 2v12M3 5h8M6 11h5"/>',
  'align-top': '<path d="M2 2.5h12M5 5v8M11 5v5"/>',
  'align-center-v': '<path d="M2 8h12M5 4v8M11 5.5v5"/>',
  'align-bottom': '<path d="M2 13.5h12M5 3v8M11 6v5"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/>',
  settings: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8 3.4 3.4"/>',
  image: '<rect x="2" y="3" width="12" height="10" rx="1"/><circle cx="5.5" cy="6.5" r="1.2"/><path d="m2.5 11.5 3.5-3 3 2.5 2.5-2 2.5 2.5"/>',
  text: '<path d="M3 4h10M8 4v9M6 13h4"/>',
  save: '<path d="M2.5 2.5h8.5L13.5 5v8.5h-11z"/><path d="M5 2.5v4h5v-4M5 13.5v-4h6v4"/>',
  open: '<path d="M1.5 12.5V4a1 1 0 0 1 1-1h3.5l1.5 2h6a1 1 0 0 1 1 1v1.5M1.5 12.5l2-6h12l-2 6z"/>',
  export: '<path d="M8 10.5V2M5 5l3-3 3 3M2.5 10v3.5h11V10"/>',
  merge: '<path d="M4 3h8M4 6.5h8M6 10h4M7 13.5h2"/>',
  visible: '<path d="M1.5 8s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4-6.5-4-6.5-4z"/><circle cx="8" cy="8" r="1.7"/>',
  refresh: '<path d="M13.5 8a5.5 5.5 0 1 1-1.7-4M13.5 2.5V7h-4.5"/>',
  info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.2v4M8 5h.01"/>',
  swatch: '<rect x="2" y="2" width="5" height="5"/><rect x="9" y="2" width="5" height="5"/><rect x="2" y="9" width="5" height="5"/><rect x="9" y="9" width="5" height="5"/>',
  channels: '<circle cx="6" cy="6" r="4"/><circle cx="10" cy="6" r="4"/><circle cx="8" cy="10" r="4"/>',
  path: '<path d="M2 12c0-6 12 0 12-8"/><rect x="1" y="11" width="2" height="2"/><rect x="13" y="3" width="2" height="2"/>',
  navigator: '<rect x="2" y="3" width="12" height="10" rx="1"/><rect x="4.5" y="5" width="6" height="5" stroke-dasharray="2 1.4"/>',
  properties: '<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/><circle cx="6" cy="4" r="1.4" fill="currentColor"/><circle cx="10" cy="8" r="1.4" fill="currentColor"/><circle cx="5" cy="12" r="1.4" fill="currentColor"/>',
};

/**
 * @param {string} name key in the icon table
 * @param {{size?:number, className?:string}} [opts]
 * @returns {string} SVG markup
 */
export function icon(name, opts = {}) {
  const body = P[name];
  const size = opts.size || 16;
  if (!body) {
    return `<svg viewBox="0 0 16 16" width="${size}" height="${size}" class="${opts.className || ''}"><rect x="3" y="3" width="10" height="10" rx="2" stroke="currentColor" fill="none" stroke-dasharray="2 2"/></svg>`;
  }
  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}" class="${opts.className || ''}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

/** Build an <svg> element instead of a string. */
export function iconEl(name, opts = {}) {
  const span = document.createElement('span');
  span.className = 'pk-ico';
  span.innerHTML = icon(name, opts);
  return span.firstElementChild;
}

export function hasIcon(name) {
  return Object.prototype.hasOwnProperty.call(P, name);
}

export const ICON_NAMES = Object.keys(P);
