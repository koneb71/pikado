import { clamp255 } from './util.js';

/**
 * Blend modes.
 *
 * Canvas2D natively implements most Photoshop separable + non-separable modes
 * through `globalCompositeOperation`. The ones it lacks (Linear Burn, Vivid
 * Light, Divide, Darker Color, ...) fall back to a per-pixel CPU pass in
 * `blendCPU`. `gco: null` marks a mode that needs the CPU path.
 */

export const BLEND_MODES = [
  { id: 'normal', name: 'Normal', gco: 'source-over', group: 0 },
  { id: 'dissolve', name: 'Dissolve', gco: null, group: 0 },

  { id: 'darken', name: 'Darken', gco: 'darken', group: 1 },
  { id: 'multiply', name: 'Multiply', gco: 'multiply', group: 1 },
  { id: 'color-burn', name: 'Color Burn', gco: 'color-burn', group: 1 },
  { id: 'linear-burn', name: 'Linear Burn', gco: null, group: 1 },
  { id: 'darker-color', name: 'Darker Color', gco: null, group: 1 },

  { id: 'lighten', name: 'Lighten', gco: 'lighten', group: 2 },
  { id: 'screen', name: 'Screen', gco: 'screen', group: 2 },
  { id: 'color-dodge', name: 'Color Dodge', gco: 'color-dodge', group: 2 },
  { id: 'linear-dodge', name: 'Linear Dodge (Add)', gco: 'lighter', group: 2 },
  { id: 'lighter-color', name: 'Lighter Color', gco: null, group: 2 },

  { id: 'overlay', name: 'Overlay', gco: 'overlay', group: 3 },
  { id: 'soft-light', name: 'Soft Light', gco: 'soft-light', group: 3 },
  { id: 'hard-light', name: 'Hard Light', gco: 'hard-light', group: 3 },
  { id: 'vivid-light', name: 'Vivid Light', gco: null, group: 3 },
  { id: 'linear-light', name: 'Linear Light', gco: null, group: 3 },
  { id: 'pin-light', name: 'Pin Light', gco: null, group: 3 },
  { id: 'hard-mix', name: 'Hard Mix', gco: null, group: 3 },

  { id: 'difference', name: 'Difference', gco: 'difference', group: 4 },
  { id: 'exclusion', name: 'Exclusion', gco: 'exclusion', group: 4 },
  { id: 'subtract', name: 'Subtract', gco: null, group: 4 },
  { id: 'divide', name: 'Divide', gco: null, group: 4 },

  { id: 'hue', name: 'Hue', gco: 'hue', group: 5 },
  { id: 'saturation', name: 'Saturation', gco: 'saturation', group: 5 },
  { id: 'color', name: 'Color', gco: 'color', group: 5 },
  { id: 'luminosity', name: 'Luminosity', gco: 'luminosity', group: 5 },
];

/** Groups appear separated by rules in the Layers-panel dropdown. */
export const BLEND_GROUPS = [0, 1, 2, 3, 4, 5];

const BY_ID = new Map(BLEND_MODES.map((m) => [m.id, m]));

export function getBlendMode(id) {
  return BY_ID.get(id) || BY_ID.get('normal');
}

export function blendName(id) {
  return getBlendMode(id).name;
}

export function isNativeBlend(id) {
  return !!getBlendMode(id).gco;
}

export function gcoFor(id) {
  return getBlendMode(id).gco || 'source-over';
}

/* ------------------------------------------------------------------ */
/* CPU implementations for the modes Canvas2D does not provide         */
/* ------------------------------------------------------------------ */

const lum = (r, g, b) => 0.3 * r + 0.59 * g + 0.11 * b;

/** Per-channel separable blend functions on 0..255 values. */
const SEPARABLE = {
  'linear-burn': (b, s) => b + s - 255,
  'vivid-light': (b, s) => (s <= 127.5 ? (s <= 0 ? 0 : 255 - Math.min(255, ((255 - b) * 255) / (2 * s))) : s >= 255 ? 255 : Math.min(255, (b * 255) / (2 * (255 - s)))),
  'linear-light': (b, s) => b + 2 * s - 255,
  'pin-light': (b, s) => (s <= 127.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 255)),
  'hard-mix': (b, s) => (b + 2 * s - 255 >= 127.5 ? 255 : 0),
  subtract: (b, s) => b - s,
  divide: (b, s) => (s === 0 ? 255 : Math.min(255, (b * 255) / s)),
};

/**
 * Blend `top` (source) into `base` (backdrop) in place on `base`.
 * Both are ImageData with straight (non-premultiplied) alpha.
 *
 * @param {ImageData} base   backdrop, mutated in place
 * @param {ImageData} top    source layer pixels
 * @param {string} mode      blend mode id
 * @param {number} opacity   0..1 applied to the source
 */
export function blendCPU(base, top, mode, opacity = 1) {
  const B = base.data, S = top.data, n = B.length;
  const sep = SEPARABLE[mode];

  if (sep) {
    for (let i = 0; i < n; i += 4) {
      const sa = (S[i + 3] / 255) * opacity;
      if (sa === 0) continue;
      const ba = B[i + 3] / 255;
      const ra = sa + ba * (1 - sa);
      if (ra === 0) { B[i + 3] = 0; continue; }
      for (let k = 0; k < 3; k++) {
        const bc = B[i + k], sc = S[i + k];
        const blended = clamp255(sep(bc, sc));
        // Photoshop composites the blend result only where backdrop exists.
        const cs = sc * (1 - ba) + blended * ba;
        B[i + k] = clamp255((cs * sa + bc * ba * (1 - sa)) / ra);
      }
      B[i + 3] = Math.round(ra * 255);
    }
    return base;
  }

  if (mode === 'darker-color' || mode === 'lighter-color') {
    const wantDark = mode === 'darker-color';
    for (let i = 0; i < n; i += 4) {
      const sa = (S[i + 3] / 255) * opacity;
      if (sa === 0) continue;
      const ba = B[i + 3] / 255;
      const ra = sa + ba * (1 - sa);
      if (ra === 0) { B[i + 3] = 0; continue; }
      const lb = lum(B[i], B[i + 1], B[i + 2]);
      const ls = lum(S[i], S[i + 1], S[i + 2]);
      const pick = wantDark ? (ls < lb ? S : B) : ls > lb ? S : B;
      for (let k = 0; k < 3; k++) {
        const bc = B[i + k], sc = S[i + k];
        const blended = pick[i + k];
        const cs = sc * (1 - ba) + blended * ba;
        B[i + k] = clamp255((cs * sa + bc * ba * (1 - sa)) / ra);
      }
      B[i + 3] = Math.round(ra * 255);
    }
    return base;
  }

  if (mode === 'dissolve') {
    for (let i = 0; i < n; i += 4) {
      const sa = (S[i + 3] / 255) * opacity;
      if (sa === 0) continue;
      if (Math.random() < sa) {
        B[i] = S[i]; B[i + 1] = S[i + 1]; B[i + 2] = S[i + 2]; B[i + 3] = 255;
      }
    }
    return base;
  }

  // Unknown mode -> plain source-over.
  for (let i = 0; i < n; i += 4) {
    const sa = (S[i + 3] / 255) * opacity;
    if (sa === 0) continue;
    const ba = B[i + 3] / 255;
    const ra = sa + ba * (1 - sa);
    for (let k = 0; k < 3; k++) B[i + k] = clamp255((S[i + k] * sa + B[i + k] * ba * (1 - sa)) / (ra || 1));
    B[i + 3] = Math.round(ra * 255);
  }
  return base;
}
