import { app } from '../core/app.js';
import { ctx2dRead, ctx2d } from '../core/util.js';
import { registerProofRenderer } from '../render/compositor.js';
import { parseColor, toHex } from '../core/color.js';
import {
  BUILTIN_PROFILES, DEFAULT_PROFILE_ID, getProfile, profileOf, transformImageData,
  makeTransform, isInGamut, intentIsExact, parseICC, extractEmbeddedProfile,
} from './icc.js';

/**
 * Colour management operations: Assign Profile, Convert to Profile, and soft
 * proofing.
 *
 * The distinction that matters, and the reason these are two commands rather than
 * one:
 *
 *   **Assign** changes the label on the pixels. The numbers do not move, so the
 *   picture *looks different* — you are saying "these numbers were always Adobe
 *   RGB, I mislabelled them".
 *
 *   **Convert** changes the numbers so the picture looks the same in the new
 *   space. Colours outside the destination gamut cannot survive that and are
 *   clipped, which is why converting into a smaller space is lossy and converting
 *   back does not restore them.
 *
 * Soft proofing is neither: it is a *view* setting, stored on the document and
 * applied by the compositor as a final pass, exactly like the channel view. The
 * document's pixels are untouched, so Save, Export and every filter see the real
 * numbers.
 */

/** Profiles the UI offers, embedded first when the document carries one. */
export function availableProfiles(doc) {
  const current = doc && doc.profile;
  const list = [...BUILTIN_PROFILES];
  if (current && current.embedded) list.unshift(current);
  return list;
}

/**
 * Assign a profile: relabel the document without touching a pixel.
 *
 * @param {object} doc
 * @param {object|string|null} profile a profile, an id, or null for "untagged"
 */
export function assignProfile(doc, profile) {
  if (!doc) return null;
  const next = typeof profile === 'string' ? getProfile(profile) : profile;
  doc.profile = next || getProfile(DEFAULT_PROFILE_ID);
  // Pixels do not change, but the *interpretation* does, so anything caching a
  // rendered version has to redraw.
  doc.invalidate();
  doc.commit(`Assign Profile: ${doc.profile.name}`);
  return doc.profile;
}

/**
 * Convert the document to another profile: move every pixel so the appearance is
 * preserved.
 *
 * What gets converted, and why it is not simply "every canvas":
 *
 *   - **raster pixels** — converted, obviously.
 *   - **masks** — NOT converted. A mask is coverage, not colour; running it
 *     through a tone curve would change what it masks.
 *   - **adjustment layers** — nothing to convert. They hold parameters and
 *     re-process whatever is beneath them, which is already converted.
 *   - **text and shape layers** — their *colours* are converted, not their
 *     canvases. That canvas is a cache regenerated from the layer's parameters,
 *     so converting the pixels would look right until the next re-rasterise
 *     silently reverted it to the unconverted colour.
 *   - **Smart Objects** — the embedded source document is converted, recursively,
 *     and the layer re-rendered. Converting only the cached render has the same
 *     problem: any later edit re-renders from an unconverted source.
 *
 * @param {{intent?:string, blackPoint?:boolean}} [opts]
 */
export async function convertToProfile(doc, profile, opts = {}) {
  if (!doc) return null;
  const to = typeof profile === 'string' ? getProfile(profile) : profile;
  if (!to) return null;
  const from = profileOf(doc);
  if (from === to || (from.id === to.id && !from.embedded && !to.embedded)) {
    app.toast(`This document is already ${to.name}.`, 'info');
    return null;
  }
  // Text, shape and smart layers have to be re-rendered, which needs modules a
  // colour module cannot import at the top without a cycle. Awaiting here is what
  // makes "converted" mean the visible pixels too, not just the parameters.
  await primeColorHelpers();
  convertSurfaces(doc, from, to, opts);
  doc.profile = to;
  doc.invalidate();
  doc.commit(`Convert to Profile: ${to.name}`);
  return to;
}

/*
 * `smart.js`, `text-render.js` and `path.js` all pull in enough of the app that
 * importing them at the top of a colour module risks a cycle, and Convert is a
 * once-in-a-while command — so they are resolved lazily and cached. A missing
 * module degrades to "the parameter is converted but the cache is not re-rendered",
 * which is logged rather than silent.
 */
let helpers = null;
function loadHelpers() {
  if (helpers) return helpers;
  helpers = { ready: false };
  return helpers;
}

export async function primeColorHelpers() {
  const [smart, text, path] = await Promise.all([
    import('../core/smart.js'),
    import('../text/text-render.js'),
    import('../vector/path.js'),
  ]);
  helpers = {
    ready: true,
    cloneSourceDocument: smart.cloneSourceDocument,
    renderSmartObject: smart.renderSmartObject,
    rasterizeTextLayer: text.rasterizeTextLayer,
    rasterizeShapeLayer: path.rasterizeShapeLayer,
  };
  return helpers;
}

const cloneSmartSource = (source) => {
  const h = loadHelpers();
  if (h.ready) return h.cloneSourceDocument(source, source.name);
  console.warn('[color] colour helpers were not primed; the smart source is converted in place');
  return source;
};
const renderSmart = (layer, doc) => {
  const h = loadHelpers();
  if (h.ready) h.renderSmartObject(layer, doc);
  else console.warn('[color] smart layer not re-rendered: helpers not primed');
};
const rasterizeText = (layer, doc) => {
  const h = loadHelpers();
  if (h.ready) h.rasterizeTextLayer(layer, doc);
};
const rasterizeShape = (layer, doc) => {
  const h = loadHelpers();
  if (h.ready) layer.canvas = h.rasterizeShapeLayer(layer, doc);
};

/** One colour string through the transform, back as a hex string. */
function convertColorString(value, from, to, opts) {
  if (typeof value !== 'string' || !value) return value;
  const c = parseColor(value);
  if (!c) return value;
  const fn = makeTransform(from, to, opts);
  const out = fn([c.r / 255, c.g / 255, c.b / 255]);
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return toHex({ r: clamp(out[0]), g: clamp(out[1]), b: clamp(out[2]), a: c.a }, c.a < 1);
}

/**
 * Convert every colour-bearing surface and parameter in a document.
 *
 * The hard part is not the pixels — it is that several layer types keep their
 * colour somewhere OTHER than the canvas the compositor draws, and the canvas is a
 * cache regenerated from that somewhere. Converting the cache alone looks right
 * until the next re-render silently reverts it; converting the source alone looks
 * WRONG immediately, because nothing re-renders. Both halves are needed, and an
 * earlier version of this function did exactly one of them for each type.
 */
function convertSurfaces(doc, from, to, opts, depth = 0) {
  // A Smart Object can contain a Smart Object. Real files do not nest deeply, and a
  // cycle would be a corrupt document, so cap it rather than trusting the data.
  if (depth > 8) return;

  for (const layer of doc.flatLayers()) {
    if (layer.type === 'adjustment') continue;

    doc.beginEdit(layer);

    // Layer effects hold their own colours and are re-rendered by the compositor on
    // every frame, so they are pure parameters: convert them and nothing else.
    if (layer.styles) layer.styles = convertStyles(layer.styles, from, to, opts);

    if (layer.smart && layer.smart.source) {
      /*
       * Convert a CLONE and swap it in, rather than converting the embedded document
       * in place. `Layer.snapshot()` copies the smart payload shallowly, so every
       * history state shares one source object: mutating it escapes history
       * entirely, which made Convert un-undoable for smart contents and made
       * convert/undo/convert double-convert the pixels.
       */
      const source = cloneSmartSource(layer.smart.source);
      convertSurfaces(source, from, to, opts, depth + 1);
      source.profile = to;
      layer.smart = {
        ...layer.smart,
        source,
        sourceVersion: (layer.smart.sourceVersion || 0) + 1,
      };
      layer._smartCache = null;
      // And re-render, or the visible pixels stay in the old space until something
      // else happens to touch the layer.
      renderSmart(layer, doc);
      layer.thumbDirty = true;
      continue;
    }

    if (layer.text) {
      layer.text = { ...layer.text, color: convertColorString(layer.text.color, from, to, opts) };
      rasterizeText(layer, doc);
      layer.thumbDirty = true;
      continue;
    }

    if (layer.shape) {
      layer.shape = convertShape(layer.shape, from, to, opts);
      rasterizeShape(layer, doc);
      layer.thumbDirty = true;
      continue;
    }

    if (!layer.canvas) continue;
    const cv = layer.canvas;
    const img = ctx2dRead(cv).getImageData(0, 0, cv.width, cv.height);
    transformImageData(img, from, to, opts);
    ctx2d(cv).putImageData(img, 0, 0);
    layer.thumbDirty = true;
  }
}

/** A shape's fill and stroke colours, converted. */
function convertShape(shape, from, to, opts) {
  const out = { ...shape };
  if (out.fill) {
    out.fill = { ...out.fill };
    if (out.fill.color) out.fill.color = convertColorString(out.fill.color, from, to, opts);
    if (Array.isArray(out.fill.stops)) {
      out.fill.stops = out.fill.stops.map((st) => ({ ...st, color: convertColorString(st.color, from, to, opts) }));
    }
  }
  if (out.stroke && out.stroke.color) {
    out.stroke = { ...out.stroke, color: convertColorString(out.stroke.color, from, to, opts) };
  }
  return out;
}

/**
 * Layer-effect colours, converted.
 *
 * Effects are the case one field over from the one the earlier fix addressed: a drop
 * shadow's colour is a parameter the compositor re-renders every frame, so leaving
 * it unconverted means the shadow stays in the old space forever while the layer it
 * belongs to moves.
 */
function convertStyles(styles, from, to, opts) {
  const out = structuredClone(styles);
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && /^(color|highlightColor|shadowColor)$/.test(key)) {
        node[key] = convertColorString(value, from, to, opts);
      } else if (value && typeof value === 'object') {
        walk(value);
      }
    }
  };
  walk(out);
  return out;
}

/* ------------------------------------------------------------------ */
/* Soft proofing                                                       */
/* ------------------------------------------------------------------ */

/** The proof settings, created on first use. */
export function proofOf(doc) {
  if (!doc) return null;
  if (!doc.proof || typeof doc.proof !== 'object') {
    doc.proof = { enabled: false, profileId: 'adobe-rgb', intent: 'relative', blackPoint: true, gamutWarning: false };
  }
  return doc.proof;
}

/**
 * Merge proof settings.
 * @returns {boolean} whether anything changed, so the caller knows to repaint
 */
export function setProof(doc, patch) {
  const proof = proofOf(doc);
  if (!proof || !patch) return false;
  let changed = false;
  for (const key of ['enabled', 'profileId', 'intent', 'blackPoint', 'gamutWarning']) {
    if (patch[key] === undefined) continue;
    if (proof[key] !== patch[key]) { proof[key] = patch[key]; changed = true; }
  }
  if (changed) {
    doc._proofCache = null;
    doc.invalidate();
  }
  return changed;
}

export function proofActive(doc) {
  const proof = doc && doc.proof;
  return !!(proof && proof.enabled && getProfile(proof.profileId));
}

/** A short description of what is being simulated, for the title bar. */
export function proofLabel(doc) {
  if (!proofActive(doc)) return '';
  const proof = proofOf(doc);
  const to = getProfile(proof.profileId);
  const exact = intentIsExact(proof.intent);
  return `Proof: ${to.name}${exact ? '' : ' (relative)'}${proof.gamutWarning ? ' + gamut warning' : ''}`;
}

/** The colour a gamut warning paints over out-of-gamut pixels. */
export const GAMUT_WARNING_COLOR = [128, 128, 128];

/**
 * Apply soft proofing to a rendered composite, in place.
 *
 * The simulation is a round trip: document space → proof space → document space.
 * Converting *only* into the proof space would answer the wrong question — the
 * point is to see, on this screen and in this space, what the proof space is
 * unable to reproduce. The clipping in the middle is where the answer comes from.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @returns {boolean} whether anything was drawn
 */
export function applyProof(ctx, doc) {
  if (!proofActive(doc)) return false;
  const proof = proofOf(doc);
  const from = profileOf(doc);
  const to = getProfile(proof.profileId);
  const w = ctx.canvas.width, h = ctx.canvas.height;
  if (w < 1 || h < 1) return false;

  const img = ctx.getImageData(0, 0, w, h);
  const opts = { intent: proof.intent, blackPoint: proof.blackPoint };

  if (proof.gamutWarning) {
    // Mark first, from the original numbers: after the round trip the clipped
    // pixels are indistinguishable from ones that were always in gamut.
    const d = img.data;
    const marks = new Uint8Array(w * h);
    const seen = new Map();
    for (let i = 0, p = 0; p < w * h; p++, i += 4) {
      if (d[i + 3] === 0) continue;
      const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      let bad = seen.get(key);
      if (bad === undefined) {
        bad = !isInGamut([d[i] / 255, d[i + 1] / 255, d[i + 2] / 255], from, to) ? 1 : 0;
        seen.set(key, bad);
      }
      marks[p] = bad;
    }
    transformImageData(img, from, to, opts);
    transformImageData(img, to, from, opts);
    for (let i = 0, p = 0; p < w * h; p++, i += 4) {
      if (!marks[p]) continue;
      d[i] = GAMUT_WARNING_COLOR[0];
      d[i + 1] = GAMUT_WARNING_COLOR[1];
      d[i + 2] = GAMUT_WARNING_COLOR[2];
    }
  } else {
    transformImageData(img, from, to, opts);
    transformImageData(img, to, from, opts);
  }

  ctx.putImageData(img, 0, 0);
  return true;
}

/* ------------------------------------------------------------------ */
/* Reading a profile out of a file                                     */
/* ------------------------------------------------------------------ */

/**
 * Look for an embedded profile in an opened file and attach it to the document.
 *
 * Deliberately quiet about failure. An unreadable or unsupported profile is
 * common (LUT-based profiles are everywhere) and is not the user's problem at the
 * moment they open a photograph — the document falls back to sRGB, which is what
 * an untagged 8-bit image is anyway. A *readable* profile that differs from sRGB
 * is worth a toast, because it changes how the file will look.
 *
 * @returns {Promise<object|null>} the profile, when one was adopted
 */
export async function adoptEmbeddedProfile(doc, fileBytes, { quiet = false } = {}) {
  if (!doc || !fileBytes) return null;
  let raw;
  try {
    raw = await extractEmbeddedProfile(fileBytes);
  } catch {
    return null;
  }
  if (!raw) return null;

  const result = parseICC(raw);
  if (!result.ok) {
    console.info(`[color] embedded profile ignored: ${result.reason}`);
    return null;
  }
  doc.profile = result.profile;
  doc.invalidate();
  if (!quiet) app.toast(`Colour profile: ${result.profile.name}`, 'info');
  return result.profile;
}

// The compositor cannot import this module (it would be a cycle), so hand it the
// proof renderer on import. `src/main.js` imports this module for the side effect.
registerProofRenderer(applyProof);

// Warm the re-render helpers while nothing is happening, so the first Convert does
// not pay for three dynamic imports. `convertToProfile` awaits them regardless.
primeColorHelpers().catch((err) => console.info('[color] helpers not preloaded', err));
