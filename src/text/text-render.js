/**
 * Text layout, rasterisation and warping.
 *
 * Canonical `layer.text` payload:
 * ```
 * { content, font, size, weight, style, color, align, lineHeight, letterSpacing,
 *   x, y, boxWidth, boxHeight, paragraph, underline, strikethrough, vertical,
 *   antialias, baselineShift, warp: { style, bend, h, v } }
 * ```
 *
 * `lineHeight` is a multiplier of the type size (1.2 = 120%). Values above 5
 * are treated as an absolute pixel leading so either convention works.
 *
 * Point text (`paragraph: false`) anchors `(x, y)` at the **first baseline**;
 * paragraph text anchors `(x, y)` at the **top-left of the box** and wraps to
 * `boxWidth`. `textOrigin()` resolves both to the layout box's top-left, which
 * is also what the type tool uses to place its editing textarea.
 *
 * Other modules write the same properties under Photoshop-flavoured names
 * (`fontSize`, `leading`, `tracking`, …). `resolveTextProps()` folds those in
 * and `syncTextAliases()` mirrors the canonical values back out, so the
 * Character panel, the Properties panel, PSD import and the type tools all
 * drive the same renderer. See `ALIASES` below.
 */

import { createCanvas, ctx2d, clamp } from '../core/util.js';
import { fontCssString, fontMetrics, measureRun, measureChars, normalizeFontId } from './fonts.js';

export const WARP_STYLES = [
  { value: 'none', label: 'None' },
  { value: 'arc', label: 'Arc' },
  { value: 'arch', label: 'Arch' },
  { value: 'bulge', label: 'Bulge' },
  { value: 'flag', label: 'Flag' },
  { value: 'wave', label: 'Wave' },
  { value: 'fish', label: 'Fish' },
  { value: 'rise', label: 'Rise' },
];

/** Defaults for a brand new text layer. */
export function defaultTextProps(over = {}) {
  return {
    content: '',
    font: 'system',
    size: 48,
    weight: 400,
    style: 'normal',
    color: '#000000',
    align: 'left',
    lineHeight: 1.2,
    letterSpacing: 0,
    x: 0,
    y: 0,
    boxWidth: 0,
    boxHeight: 0,
    paragraph: false,
    vertical: false,
    underline: false,
    strikethrough: false,
    baselineShift: 0,
    antialias: 'smooth',
    warp: { style: 'none', bend: 0, h: 0, v: 0 },
    ...over,
  };
}

function colorCss(c) {
  if (!c) return '#000000';
  if (typeof c === 'string') return c;
  if (typeof c === 'object' && 'r' in c) {
    return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${c.a == null ? 1 : c.a})`;
  }
  return String(c);
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** CSS font-weight keywords, so `weight: 'bold'` is not silently read as 400. */
const WEIGHT_KEYWORDS = {
  thin: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  normal: 400,
  regular: 400,
  book: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900,
  lighter: 300,
  bolder: 700,
};

/** Resolve a weight that may be a number, a numeric string, or a CSS keyword. */
function weightValue(v, d) {
  if (typeof v === 'string') {
    const k = WEIGHT_KEYWORDS[v.trim().toLowerCase().replace(/[\s-]/g, '')];
    if (k !== undefined) return k;
  }
  return num(v, d);
}

/** Leading in pixels. Multipliers (<= 5) scale the type size. */
export function resolveLineStep(lineHeight, size, natural) {
  if (lineHeight == null) return Math.max(1, natural || size * 1.2);
  const v = Number(lineHeight);
  if (!Number.isFinite(v) || v <= 0) return Math.max(1, natural || size * 1.2);
  return v > 5 ? v : Math.max(1, v * size);
}

/* ------------------------------------------------------------------ */
/* Property resolution (canonical keys + foreign aliases)              */
/* ------------------------------------------------------------------ */

/** canonical key -> the name other modules use for the same thing. */
const ALIASES = {
  content: 'text',
  font: 'fontFamily',
  size: 'fontSize',
  antialias: 'antiAlias',
  lineHeight: 'leading',       // px, 0 = auto
  letterSpacing: 'tracking',   // 1/1000 em
};

function sameish(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6;
  return a === b;
}

/**
 * Read one property. The stamp in `t._alias` records what was last mirrored
 * into the alias key, so an alias that changed behind our back wins; otherwise
 * the canonical key wins.
 * @returns {{value:any, fromAlias:boolean}}
 */
function pickAlias(t, canon) {
  const alias = ALIASES[canon];
  const a = alias ? t[alias] : undefined;
  const c = t[canon];
  if (a === undefined) return { value: c, fromAlias: false };
  if (c === undefined) return { value: a, fromAlias: true };
  const stamp = t._alias;
  if (stamp && sameish(a, stamp[alias])) return { value: c, fromAlias: false };
  return { value: a, fromAlias: true };
}

/** Same idea for the boolean bold/italic flags, which have several spellings. */
function pickFlag(t, stampKey, ...keys) {
  let present = false;
  let on = false;
  for (const k of keys) {
    if (t[k] === undefined) continue;
    present = true;
    if (t[k] === true) on = true;
  }
  const style = String(t.fontStyle || '');
  if (style) {
    present = true;
    if (stampKey === 'bold' ? /bold/i.test(style) : /italic|oblique/i.test(style)) on = true;
  }
  const stamp = t._alias;
  const changed = !present ? false : !stamp || stamp[stampKey] !== on;
  return { on, present, changed };
}

/**
 * Fold aliases, faux styles and `text.scale` (set by Image > Image Size) into
 * one canonical, ready-to-render property set. Never mutates its input.
 * @param {object} raw `layer.text`
 */
export function resolveTextProps(raw) {
  const t = raw || {};
  if (t.__resolved) return t;

  const scale = num(t.scale, 1) || 1;
  const size = Math.max(1, num(pickAlias(t, 'size').value, 16) * scale);

  const bold = pickFlag(t, 'bold', 'bold', 'fauxBold');
  const italicFlag = pickFlag(t, 'italic', 'italic', 'fauxItalic');
  const stamped = t._alias && typeof t._alias.bold === 'boolean';
  let weight;
  if (t.weight === undefined || bold.changed) weight = bold.on ? 700 : 400;
  else if (!stamped && bold.on) weight = Math.max(weightValue(t.weight, 400), 700);
  else weight = weightValue(t.weight, 400);
  let italic;
  if (italicFlag.changed || t.style === undefined) italic = italicFlag.on || t.style === 'italic';
  else italic = t.style === 'italic';

  const contentPick = pickAlias(t, 'content');
  const content = contentPick.value == null ? '' : String(contentPick.value);

  const fontPick = pickAlias(t, 'font');
  /*
   * Normalised here, at the one point every render path passes through, so a
   * layer carrying a display name or a raw CSS family — which the Character
   * panel used to write — heals on its first rasterisation rather than
   * degrading silently through `fontStack` and `postScriptFace`.
   */
  const font = normalizeFontId(fontPick.value || t.family || 'system');

  // Leading: an alias value is always absolute px (0 = auto); the canonical
  // key keeps the multiplier-or-px convention of `resolveLineStep`.
  const leadPick = pickAlias(t, 'lineHeight');
  let lineStep = null;
  if (leadPick.value != null) {
    const v = num(leadPick.value, 0);
    if (v > 0) lineStep = leadPick.fromAlias ? v * scale : (v > 5 ? v * scale : v * size);
  }

  const trackPick = pickAlias(t, 'letterSpacing');
  const letterSpacing = trackPick.fromAlias
    ? (num(trackPick.value, 0) / 1000) * size
    : num(trackPick.value, 0) * scale;

  const aaPick = pickAlias(t, 'antialias');

  const renderText = t.allCaps ? content.toLocaleUpperCase() : content;

  return {
    __resolved: true,
    content,
    renderText,
    font,
    size,
    weight,
    italic,
    style: italic ? 'italic' : 'normal',
    color: t.color == null ? (t.fill == null ? '#000000' : t.fill) : t.color,
    align: t.align || 'left',
    lineStep,
    lineHeight: lineStep == null ? null : lineStep,
    letterSpacing,
    x: num(t.x, 0) * scale,
    y: num(t.y, 0) * scale,
    boxWidth: Math.max(0, num(t.boxWidth, 0) * scale),
    boxHeight: Math.max(0, num(t.boxHeight, 0) * scale),
    paragraph: !!t.paragraph,
    vertical: !!t.vertical,
    underline: !!t.underline,
    strikethrough: !!t.strikethrough,
    baselineShift: num(t.baselineShift, 0) * scale,
    antialias: aaPick.value || 'smooth',
    warp: t.warp || { style: 'none', bend: 0, h: 0, v: 0 },
    scale: 1,
    srcs: {
      lead: leadPick.fromAlias,
      track: trackPick.fromAlias,
      bold: bold.changed,
      italic: italicFlag.changed,
    },
  };
}

/**
 * Canonicalise `layer.text` in place: adopt whatever a foreign panel changed,
 * fold `scale` in, then mirror every canonical value back into its alias so
 * panels that speak the other dialect show the right numbers. Called at the
 * start of every rasterisation, so the payload is self-healing.
 * @param {object} t `layer.text`
 * @returns {object} the same object
 */
export function syncTextAliases(t) {
  if (!t || typeof t !== 'object') return t;
  const r = resolveTextProps(t);

  t.content = r.content;
  t.font = r.font;
  t.size = r.size;
  t.weight = r.weight;
  t.style = r.style;
  t.color = r.color;
  t.align = r.align;
  t.letterSpacing = r.letterSpacing;
  // Keep a leading *multiplier* as a multiplier so it keeps tracking the type
  // size; adopt an absolute value when it came from `leading` or was scaled.
  if (r.srcs.lead || t.lineHeight === undefined) t.lineHeight = r.lineStep == null ? 0 : r.lineStep;
  else if (num(t.lineHeight, 0) > 5) t.lineHeight = r.lineStep;
  t.x = r.x;
  t.y = r.y;
  t.boxWidth = r.boxWidth;
  t.boxHeight = r.boxHeight;
  t.baselineShift = r.baselineShift;
  t.antialias = r.antialias;
  t.paragraph = r.paragraph;
  t.vertical = r.vertical;
  t.underline = r.underline;
  t.strikethrough = r.strikethrough;
  t.scale = 1;

  const boldOn = r.weight >= 600;
  const stamp = {};
  t.text = stamp.text = r.content;
  t.fontFamily = stamp.fontFamily = r.font;
  t.fontSize = stamp.fontSize = r.size;
  t.leading = stamp.leading = r.lineStep == null ? 0 : Math.round(r.lineStep * 100) / 100;
  t.tracking = stamp.tracking = Math.round((r.letterSpacing / r.size) * 1000);
  t.antiAlias = stamp.antiAlias = r.antialias;
  t.fontStyle = stamp.fontStyle = boldOn
    ? (r.italic ? 'bold italic' : 'bold')
    : (r.italic ? 'italic' : 'regular');
  t.bold = t.fauxBold = stamp.bold = boldOn;
  t.italic = t.fauxItalic = stamp.italic = r.italic;
  t._alias = stamp;
  return t;
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

function wrapParagraph(text, cssFont, ls, maxWidth) {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return [text];
  const chars = measureChars(text, cssFont, ls);
  const out = [];
  let start = 0;
  let lastSpace = -1;
  let w = 0;
  for (let i = 0; i < chars.length; i++) {
    const cw = chars[i].width + ls;
    if (chars[i].ch === ' ' || chars[i].ch === '\t') lastSpace = i;
    if (w + cw > maxWidth && i > start) {
      const br = lastSpace >= start ? lastSpace + 1 : i;
      out.push(text.slice(start, br));
      start = br;
      lastSpace = -1;
      w = 0;
      for (let k = start; k <= i; k++) w += chars[k].width + ls;
      continue;
    }
    w += cw;
  }
  out.push(text.slice(start));
  return out;
}

/**
 * Lay text out relative to the top-left of its box.
 * @param {object} textProps `layer.text` (raw or already resolved)
 * @param {number} [maxWidth] wrap width; `Infinity` for point text
 * @returns {{lines:object[], width:number, height:number, lineStep:number,
 *   ascent:number, descent:number, halfLeading:number, cssFont:string,
 *   letterSpacing:number, vertical:boolean, align:string, charStep:number,
 *   props:object}}
 */
export function layoutText(textProps, maxWidth = Infinity) {
  const t = resolveTextProps(textProps);
  const cssFont = fontCssString(t);
  const { ascent, descent } = fontMetrics(cssFont);
  const size = t.size;
  const ls = t.letterSpacing;
  const lineStep = t.lineStep == null ? Math.max(1, ascent + descent) : Math.max(1, t.lineStep);
  const align = t.align;
  const paras = t.renderText.split('\n');

  if (t.vertical) return layoutVertical(t, paras, { cssFont, ascent, descent, size, ls, lineStep, align, maxWidth });

  const halfLeading = (lineStep - (ascent + descent)) / 2;
  const raw = [];
  for (const p of paras) {
    const wrapped = wrapParagraph(p, cssFont, ls, maxWidth);
    wrapped.forEach((text, i) => raw.push({ text, lastOfPara: i === wrapped.length - 1 }));
  }

  const lines = raw.map((r, i) => ({
    text: r.text,
    width: measureRun(r.text, cssFont, ls),
    x: 0,
    baseline: halfLeading + ascent + i * lineStep,
    lastOfPara: r.lastOfPara,
    wordGap: 0,
  }));

  let maxLineWidth = 0;
  for (const l of lines) if (l.width > maxLineWidth) maxLineWidth = l.width;
  const boxW = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : maxLineWidth;

  for (const l of lines) {
    if (align === 'center') l.x = (boxW - l.width) / 2;
    else if (align === 'right') l.x = boxW - l.width;
    else if (align === 'justify' && !l.lastOfPara) {
      const spaces = (l.text.match(/ /g) || []).length;
      if (spaces > 0 && boxW > l.width) l.wordGap = (boxW - l.width) / spaces;
    }
  }

  return {
    lines,
    width: boxW,
    contentWidth: maxLineWidth,
    height: Math.max(lineStep, lines.length * lineStep),
    lineStep,
    charStep: 0,
    ascent,
    descent,
    halfLeading,
    cssFont,
    letterSpacing: ls,
    vertical: false,
    align,
    props: t,
  };
}

function layoutVertical(t, paras, m) {
  const { cssFont, ascent, descent, size, ls, lineStep, align, maxWidth } = m;
  const charStep = size + ls;
  const columns = [];
  const limit = Number.isFinite(maxWidth) && maxWidth > 0 ? Math.max(1, Math.floor(maxWidth / charStep)) : 0;
  for (const p of paras) {
    const glyphs = [...p];
    if (!limit || glyphs.length <= limit) columns.push(glyphs);
    else for (let i = 0; i < glyphs.length; i += limit) columns.push(glyphs.slice(i, i + limit));
  }
  if (!columns.length) columns.push([]);

  let maxLen = 0;
  for (const c of columns) if (c.length > maxLen) maxLen = c.length;
  const colHeight = Math.max(charStep, maxLen * charStep);
  const boxH = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : colHeight;
  const baseOffset = (charStep - (ascent + descent)) / 2 + ascent;

  const lines = columns.map((glyphs, j) => {
    const len = glyphs.length * charStep;
    let top = 0;
    if (align === 'center') top = (boxH - len) / 2;
    else if (align === 'right') top = boxH - len;
    return {
      text: glyphs.join(''),
      glyphs,
      width: charStep * glyphs.length,
      centerX: j * lineStep + lineStep / 2,
      top,
      chars: glyphs.map((ch, k) => ({ ch, baseline: top + k * charStep + baseOffset })),
    };
  });

  return {
    lines,
    width: columns.length * lineStep,
    contentWidth: columns.length * lineStep,
    height: boxH,
    lineStep,
    charStep,
    ascent,
    descent,
    halfLeading: (charStep - (ascent + descent)) / 2,
    cssFont,
    letterSpacing: ls,
    vertical: true,
    align,
    props: t,
  };
}

/**
 * Document-space top-left of the layout box.
 * @returns {{x:number, y:number}}
 */
export function textOrigin(textProps, lay) {
  const t = resolveTextProps(textProps);
  const x = t.x;
  const y = t.y;
  if (t.paragraph || t.vertical) return { x, y };
  let ox = x;
  if (lay.align === 'center') ox = x - lay.width / 2;
  else if (lay.align === 'right') ox = x - lay.width;
  return { x: ox, y: y - (lay.halfLeading + lay.ascent) };
}

/**
 * Bounding box of a text layer in document space.
 * @param {import('../core/layer.js').Layer} layer
 * @returns {{x:number, y:number, width:number, height:number, layout:object}}
 */
export function measureTextLayer(layer) {
  const raw = layer && layer.text;
  if (!raw) return { x: 0, y: 0, width: 0, height: 0, layout: null };
  const t = resolveTextProps(raw);
  const lay = layoutText(t, wrapWidthFor(t));
  const o = textOrigin(t, lay);
  const width = t.paragraph && !t.vertical ? (t.boxWidth || lay.width) : lay.width;
  const height = t.paragraph ? Math.max(t.boxHeight || 0, lay.height) : lay.height;
  return { x: o.x, y: o.y, width, height, layout: lay };
}

/** The wrap limit implied by the layer's own properties. */
export function wrapWidthFor(textProps) {
  const t = resolveTextProps(textProps);
  if (!t.paragraph) return Infinity;
  if (t.vertical) return t.boxHeight || Infinity;
  return t.boxWidth || Infinity;
}

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

function drawLayout(c, lay, ox, oy) {
  const t = lay.props;
  c.font = lay.cssFont;
  c.textBaseline = 'alphabetic';
  c.textAlign = 'left';
  c.fillStyle = colorCss(t.color);
  const ls = lay.letterSpacing;
  const rule = Math.max(1, t.size / 16);
  const shift = t.baselineShift || 0;

  if (lay.vertical) {
    for (const col of lay.lines) {
      for (const g of col.chars) {
        const w = measureRun(g.ch, lay.cssFont, 0);
        c.fillText(g.ch, ox + col.centerX - w / 2, oy + g.baseline - shift);
      }
      if (!col.chars.length) continue;
      const top = oy + col.chars[0].baseline - lay.ascent - shift;
      const h = col.chars.length * lay.charStep;
      if (t.underline) c.fillRect(ox + col.centerX + lay.charStep * 0.42, top, rule, h);
      if (t.strikethrough) c.fillRect(ox + col.centerX - rule / 2, top, rule, h);
    }
    return;
  }

  for (const line of lay.lines) {
    const y = oy + line.baseline - shift;
    const x0 = ox + line.x;
    if (line.wordGap > 0 || ls !== 0) {
      let x = x0;
      for (const ch of line.text) {
        c.fillText(ch, x, y);
        x += measureRun(ch, lay.cssFont, 0) + ls + (ch === ' ' ? line.wordGap : 0);
      }
    } else if (line.text) {
      c.fillText(line.text, x0, y);
    }
    const drawWidth = line.wordGap > 0 ? lay.width : line.width;
    if (t.underline && line.text) c.fillRect(x0, y + lay.descent * 0.45, drawWidth, rule);
    if (t.strikethrough && line.text) c.fillRect(x0, y - lay.ascent * 0.3, drawWidth, rule);
  }
}

function applyAntialias(cv, mode) {
  if (!mode || mode === 'smooth') return cv;
  const c = cv.getContext('2d', { willReadFrequently: true });
  const img = c.getImageData(0, 0, cv.width, cv.height);
  const d = img.data;
  if (mode === 'none') {
    for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 128 ? 255 : 0;
  } else {
    const gamma = mode === 'sharp' ? 1.25 : mode === 'crisp' ? 1.6 : mode === 'strong' ? 0.75 : 1;
    if (gamma === 1) return cv;
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = Math.round(255 * Math.pow(i / 255, gamma));
    for (let i = 3; i < d.length; i += 4) d[i] = lut[d[i]];
  }
  c.putImageData(img, 0, 0);
  return cv;
}

/* ------------------------------------------------------------------ */
/* Warping                                                            */
/* ------------------------------------------------------------------ */

function edgeDisplacement(style, bend, u, H) {
  const f = 4 * u * (1 - u);
  const s = u * u * (3 - 2 * u);
  const TAU = Math.PI * 2;
  switch (style) {
    case 'arc': return [-bend * H * f, -bend * H * f];
    case 'arch': return [-bend * H * f, 0];
    case 'bulge': return [-bend * H * 0.5 * f, bend * H * 0.5 * f];
    case 'flag': return [bend * H * 0.6 * Math.sin(TAU * u), bend * H * 0.6 * Math.sin(TAU * u + 0.7)];
    case 'wave': return [bend * H * 0.5 * Math.sin(TAU * u), bend * H * 0.5 * Math.sin(TAU * u + 2.4)];
    case 'fish': return [-bend * H * 0.5 * s, bend * H * 0.5 * s];
    case 'rise': return [-bend * H * u, -bend * H * u];
    default: return [0, 0];
  }
}

function normBend(v) {
  if (v == null) return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return clamp(Math.abs(n) > 1.0001 ? n / 100 : n, -1, 1);
}

/**
 * Warp a rendered text bitmap by remapping columns (vertical displacement of
 * the top and bottom edges) and then rows (horizontal distortion).
 * @param {HTMLCanvasElement} src
 * @param {{style:string, bend?:number, h?:number, v?:number}} warp
 * @param {{x:number, width:number, height:number}} content the tight text rect
 *   inside `src`, used to normalise the warp parameter
 * @returns {{canvas:HTMLCanvasElement, dx:number, dy:number}}
 */
export function warpCanvas(src, warp, content) {
  const style = warp && warp.style;
  const bend = normBend(warp && warp.bend);
  const hd = normBend(warp && warp.h);
  const vd = normBend(warp && warp.v);
  if (!style || style === 'none' || (!bend && !hd && !vd)) return { canvas: src, dx: 0, dy: 0 };

  const w = src.width;
  const h = src.height;
  const H = Math.max(1, content.height || h);
  const cx0 = content.x || 0;
  const cw = Math.max(1, content.width || w);

  // --- pass 1: per-column vertical displacement ----------------------
  const tops = new Float32Array(w);
  const bots = new Float32Array(w);
  let minTop = Infinity;
  let maxBot = -Infinity;
  for (let x = 0; x < w; x++) {
    const u = clamp((x + 0.5 - cx0) / cw, 0, 1);
    const [dT, dB] = edgeDisplacement(style, bend, u, H);
    const ve = vd * (u - 0.5) * H;
    const top = dT - ve / 2;
    const bot = h + dB + ve / 2;
    tops[x] = top;
    bots[x] = Math.max(top + 0.5, bot);
    if (tops[x] < minTop) minTop = tops[x];
    if (bots[x] > maxBot) maxBot = bots[x];
  }
  const outH = Math.max(1, Math.ceil(maxBot - minTop) + 2);
  const pass1 = createCanvas(w, outH);
  const c1 = ctx2d(pass1);
  c1.imageSmoothingEnabled = true;
  c1.imageSmoothingQuality = 'high';
  for (let x = 0; x < w; x++) {
    const dh = bots[x] - tops[x];
    c1.drawImage(src, x, 0, 1, h, x, tops[x] - minTop + 1, 1, dh);
  }
  let out = pass1;
  let dx = 0;
  const dy = minTop - 1;

  // --- pass 2: per-row horizontal distortion -------------------------
  if (hd) {
    const grow = 1 + Math.abs(hd) * 0.5;
    const outW = Math.max(1, Math.ceil(w * grow) + 2);
    const pass2 = createCanvas(outW, outH);
    const c2 = ctx2d(pass2);
    c2.imageSmoothingEnabled = true;
    c2.imageSmoothingQuality = 'high';
    const cxOut = outW / 2;
    for (let y = 0; y < outH; y++) {
      const v = outH <= 1 ? 0.5 : y / (outH - 1);
      const scale = Math.max(0.05, 1 + hd * (v - 0.5));
      const dw = w * scale;
      c2.drawImage(pass1, 0, y, w, 1, cxOut - dw / 2, y, dw, 1);
    }
    out = pass2;
    dx = -(outW - w) / 2;
  }
  return { canvas: out, dx, dy };
}

/* ------------------------------------------------------------------ */
/* Rasterisation                                                       */
/* ------------------------------------------------------------------ */

/**
 * Render a text layer into a document-sized canvas. The canvas is also stored
 * on the layer (that is what "re-rasterise" means for a live type layer), so
 * callers may either use the return value or simply call this and repaint.
 * Called by `src/layers/ops.js`, the panels and the type tools.
 * @param {import('../core/layer.js').Layer} layer
 * @param {import('../core/document.js').PikaDocument} doc
 * @returns {HTMLCanvasElement} a document-sized canvas
 */
export function rasterizeTextLayer(layer, doc) {
  const w = doc ? doc.width : 1;
  const h = doc ? doc.height : 1;
  const cv = createCanvas(w, h);
  const raw = layer && layer.text;
  if (!raw) return cv;

  syncTextAliases(raw);
  const t = resolveTextProps(raw);

  if (t.renderText !== '') {
    const lay = layoutText(t, wrapWidthFor(t));
    const origin = textOrigin(t, lay);

    const pad = Math.ceil(Math.max(6, t.size * 0.6));
    const tw = Math.max(1, Math.ceil(lay.width) + pad * 2);
    const th = Math.max(1, Math.ceil(lay.height) + pad * 2);
    const tmp = createCanvas(tw, th);
    drawLayout(ctx2d(tmp), lay, pad, pad);
    applyAntialias(tmp, t.antialias);

    let out = tmp;
    let ox = origin.x - pad;
    let oy = origin.y - pad;
    const warp = t.warp;
    if (warp && warp.style && warp.style !== 'none') {
      const r = warpCanvas(tmp, warp, { x: pad, width: lay.width, height: lay.height });
      out = r.canvas;
      ox += r.dx;
      oy += r.dy;
    }
    ctx2d(cv).drawImage(out, Math.round(ox), Math.round(oy));
  }

  if (layer) {
    layer.canvas = cv;
    layer.thumbDirty = true;
  }
  return cv;
}

/**
 * Coverage mask of the glyph shapes — the basis of the type-mask tool.
 * @returns {Uint8ClampedArray} `doc.width * doc.height` alpha values
 */
export function textLayerToMask(layer, doc) {
  const cv = rasterizeTextLayer(layer, doc);
  const d = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data;
  const out = new Uint8ClampedArray(cv.width * cv.height);
  for (let i = 0, p = 0; p < out.length; p++, i += 4) out[p] = d[i + 3];
  return out;
}
