/**
 * Pikado brand.
 *
 * The mark is a diamond of two overlapping planes with a concentric aperture
 * knocked out of the middle. It says what the app is: planes composited over
 * each other, seen through an opening, with colour where they overlap.
 *
 * Two constraints drove the design:
 *   - The aperture is a real mask, not a shape filled with the background
 *     colour, so the mark sits correctly on dark, light and mid surfaces.
 *   - The silhouette carries the identity, so it still reads at 13-16 px where
 *     an outline or a thin seam would soften into mush.
 *
 * Gradient ids are suffixed per instance: several marks share a page and
 * duplicate ids would make every one of them use the first mark's gradient.
 */

export const BRAND = {
  name: 'Pikado',
  tagline: 'Image studio',
  violet: '#7C6AF6',
  violetDeep: '#4B3BD6',
  violetLift: '#9B7CFF',
  cyan: '#35D0E8',
  cyanLift: '#5FDCEA',
};

/**
 * Canvas-overlay colours.
 *
 * On-canvas chrome — transform handles, guides, crop boxes, brush crosshairs —
 * is drawn with `ctx.strokeStyle`, so it cannot read a CSS custom property.
 * These are the same values as the corresponding tokens in styles.css; keeping
 * them in one exported object stops the old Adobe blue creeping back in.
 */
export const OVERLAY = {
  accent: '#7C6AF6',
  accentHi: '#9B8CFF',
  accentSoft: 'rgba(124, 106, 246, 0.75)',
  handleFill: '#FFFFFF',
  handleStroke: 'rgba(10, 10, 14, 0.9)',
  guide: '#35D0E8',
  smartGuide: '#FF4D9D',
  warn: '#FFC46B',
};

let uid = 0;

/**
 * The mark on its own.
 * @param {{size?:number, className?:string, title?:string}} [opts]
 * @returns {string} SVG markup
 */
export function brandMark({ size = 24, className = '', title = '' } = {}) {
  const n = `pk${++uid}`;
  return `<svg class="pk-mark ${className}" width="${size}" height="${size}" viewBox="0 0 32 32" role="${title ? 'img' : 'presentation'}"${title ? ` aria-label="${title}"` : ' aria-hidden="true"'}>
  <defs>
    <linearGradient id="${n}a" x1="0" y1="0" x2=".85" y2="1">
      <stop offset="0" stop-color="${BRAND.violet}"/><stop offset="1" stop-color="${BRAND.violetDeep}"/>
    </linearGradient>
    <linearGradient id="${n}b" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="${BRAND.cyanLift}"/><stop offset="1" stop-color="${BRAND.violetLift}"/>
    </linearGradient>
    <mask id="${n}m">
      <rect width="32" height="32" fill="#fff"/>
      <path d="M16 10.4 L21.6 16 L16 21.6 L10.4 16z" fill="#000"/>
    </mask>
  </defs>
  <g mask="url(#${n}m)">
    <path d="M16 2.6 L29.4 16 L16 29.4 L2.6 16z" fill="url(#${n}a)"/>
    <path d="M16 2.6 L29.4 16 L16 16z" fill="url(#${n}b)" opacity=".92"/>
  </g>
</svg>`;
}

/**
 * Mark + wordmark, for the app bar and the welcome screen.
 * @param {{size?:number, wordSize?:number, className?:string}} [opts]
 */
export function brandLock({ size = 22, wordSize = 15, className = '' } = {}) {
  return `<span class="pk-brand ${className}">${brandMark({ size, title: BRAND.name })}<span class="pk-wordmark" style="font-size:${wordSize}px">${BRAND.name}</span></span>`;
}

/** An <svg> element rather than a string. */
export function brandMarkEl(opts) {
  const holder = document.createElement('span');
  holder.innerHTML = brandMark(opts);
  return holder.firstElementChild;
}

/** A favicon data URI. Standalone so it needs no runtime ids. */
export function faviconDataURI() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<defs>
<linearGradient id="a" x1="0" y1="0" x2=".85" y2="1"><stop offset="0" stop-color="${BRAND.violet}"/><stop offset="1" stop-color="${BRAND.violetDeep}"/></linearGradient>
<linearGradient id="b" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="${BRAND.cyanLift}"/><stop offset="1" stop-color="${BRAND.violetLift}"/></linearGradient>
<mask id="m"><rect width="32" height="32" fill="#fff"/><path d="M16 10.4 L21.6 16 L16 21.6 L10.4 16z" fill="#000"/></mask>
</defs>
<g mask="url(#m)"><path d="M16 2.6 L29.4 16 L16 29.4 L2.6 16z" fill="url(#a)"/><path d="M16 2.6 L29.4 16 L16 16z" fill="url(#b)" opacity=".92"/></g>
</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Point the document's favicon at the mark. */
export function installFavicon() {
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/svg+xml';
  link.href = faviconDataURI();
}
