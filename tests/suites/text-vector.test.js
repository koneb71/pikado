import { suite } from '../harness.js';
import { Layer, LayerType } from '/src/core/layer.js';
import {
  rasterizeTextLayer, measureTextLayer, layoutText, textOrigin, textLayerToMask,
  resolveTextProps, defaultTextProps, resolveLineStep, WARP_STYLES,
} from '/src/text/text-render.js';
import { fontCssString, fontStack, measureRun, FONT_FAMILIES } from '/src/text/fonts.js';
import {
  createPath, createSubpath, createPoint, clonePath, pathToPath2D, pathBounds,
  hitTestPoint, hitTestSegment, insertPointAt, removePoint, convertPoint,
  transformPath, pathToSelectionMask, pointOnSegment, segmentCount,
  rasterizeShapeLayer,
} from '/src/vector/path.js';
import { CUSTOM_SHAPES, shapeToSubpaths, getCustomShape } from '/src/vector/shapes.js';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** A detached TEXT layer. rasterizeTextLayer only needs `doc` for its size. */
function textLayer(over) {
  const l = new Layer({ type: LayerType.TEXT, name: 'T' });
  l.text = defaultTextProps({ content: 'Hamburgefons', size: 36, x: 20, y: 70, ...over });
  return l;
}

function read(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, canvas.width, canvas.height);
}

/** Tight bounds of everything with alpha > 8, or null. */
function inkBounds(canvas) {
  const { data, width, height } = read(canvas);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** "r,g,b,a" of the first fully opaque pixel — the glyph's own colour. */
function firstOpaque(canvas) {
  const d = read(canvas).data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 255) return `${d[i]},${d[i + 1]},${d[i + 2]},255`;
  }
  return null;
}

/** FNV-1a over every byte — a cheap identity for "this render is different". */
function fingerprint(canvas) {
  const d = read(canvas).data;
  let h = 2166136261;
  for (let i = 0; i < d.length; i++) {
    h ^= d[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Covered area of a coverage mask, in pixels. */
function maskArea(mask) {
  let s = 0;
  for (let i = 0; i < mask.length; i++) s += mask[i];
  return s / 255;
}

const corner = (x, y) => ({ x, y, in: null, out: null, corner: true });
const rectSubpaths = (x, y, w, h) => [{
  closed: true,
  points: [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)],
}];

/* ------------------------------------------------------------------ */
/* text                                                               */
/* ------------------------------------------------------------------ */

suite('text / rasterisation + font weight', async (t) => {
  const doc = t.doc(240, 140, '#ffffff', 'text');

  const filled = rasterizeTextLayer(textLayer({ content: 'Hg' }), doc);
  t.eq([filled.width, filled.height], [240, 140], 'the rasterised canvas is document-sized');
  t.gt(t.inked(filled), 40, 'non-empty content lays down ink');

  const empty = rasterizeTextLayer(textLayer({ content: '' }), doc);
  t.eq(t.inked(empty, 0), 0, 'empty content renders nothing at all');
  const blank = rasterizeTextLayer(textLayer({ content: '   ' }), doc);
  t.eq(t.inked(blank, 0), 0, 'whitespace-only content lays down no ink either');

  // --- weight resolution: the bug was `weight: 'bold'` silently reading 400.
  const cases = [
    ['normal', 400], ['regular', 400], ['light', 300], ['semibold', 600],
    ['bold', 700], ['BOLD', 700], ['Bold', 700], ['black', 900],
    ['extra bold', 800], ['Extra-Bold', 800], ['thin', 100], ['medium', 500],
  ];
  const wrong = [];
  for (const [kw, expected] of cases) {
    const got = resolveTextProps({ weight: kw }).weight;
    if (got !== expected) wrong.push(`${kw}->${got} (want ${expected})`);
  }
  t.eq(wrong, [], 'every CSS weight keyword resolves to its numeric weight');
  t.eq(resolveTextProps({ weight: 500 }).weight, 500, 'a numeric weight passes through');
  t.eq(resolveTextProps({ weight: '600' }).weight, 600, 'a numeric string weight passes through');
  t.eq(resolveTextProps({ weight: 'nonsense' }).weight, 400, 'an unknown keyword falls back to 400');

  // The resolved weight has to reach the CSS font string, not just the object.
  t.ok(/(^|\s)700(\s|$)/.test(layoutText({ content: 'x', size: 20, weight: 'bold' }).cssFont),
    'weight "bold" reaches the canvas font shorthand as 700');
  t.ok(/(^|\s)400(\s|$)/.test(layoutText({ content: 'x', size: 20, weight: 'normal' }).cssFont),
    'weight "normal" reaches the canvas font shorthand as 400');

  // Rendered ink must genuinely get heavier, and the keyword must render
  // exactly like the number it stands for.
  const reg = rasterizeTextLayer(textLayer({ weight: 400 }), doc);
  const n700 = rasterizeTextLayer(textLayer({ weight: 700 }), doc);
  const kwBold = rasterizeTextLayer(textLayer({ weight: 'bold' }), doc);
  const n900 = rasterizeTextLayer(textLayer({ weight: 900 }), doc);
  const kwBlack = rasterizeTextLayer(textLayer({ weight: 'black' }), doc);

  t.gt(t.mad(read(reg), read(n700)), 0, 'weight 700 genuinely renders differently from 400 (precondition)');
  t.gt(t.inked(n700), t.inked(reg), 'weight 700 puts down more ink than 400');
  t.eq(t.mad(read(kwBold), read(n700)), 0, 'weight "bold" renders bit-identically to weight 700');
  t.gt(t.inked(kwBold), t.inked(reg), 'weight "bold" renders visibly heavier than 400');
  t.eq(t.mad(read(kwBlack), read(n900)), 0, 'weight "black" renders bit-identically to weight 900');
  t.gt(t.inked(kwBlack), t.inked(reg), 'weight "black" renders visibly heavier than 400');

  // syncTextAliases is expected to canonicalise the payload in place.
  const l = textLayer({ weight: 'bold' });
  rasterizeTextLayer(l, doc);
  t.eq(l.text.weight, 700, 'rasterising rewrites the keyword as the numeric weight');
  t.eq(l.text.bold, true, 'and mirrors it into the Photoshop-flavoured bold flag');
});

suite('text / size, colour, alignment, decoration', async (t) => {
  const doc = t.doc(240, 140, '#ffffff', 'text2');

  // --- size
  let prev = 0;
  const sizes = [12, 24, 48, 96];
  const badSizes = [];
  for (const size of sizes) {
    const w = measureTextLayer(textLayer({ size, content: 'Wide' })).width;
    if (!(w > prev)) badSizes.push(size);
    prev = w;
  }
  t.eq(badSizes, [], 'measureTextLayer width grows monotonically with the type size');
  t.gt(t.inked(rasterizeTextLayer(textLayer({ size: 60, content: 'Wm' }), doc)),
    t.inked(rasterizeTextLayer(textLayer({ size: 20, content: 'Wm' }), doc)),
    'bigger type lays down more ink');

  // --- colour: an opaque glyph pixel is exactly the requested colour.
  t.eq(firstOpaque(rasterizeTextLayer(textLayer({ color: '#ff0000', content: 'M' }), doc)),
    '255,0,0,255', 'glyph pixels are exactly the requested colour');
  t.eq(firstOpaque(rasterizeTextLayer(textLayer({ color: { r: 0, g: 128, b: 255, a: 1 }, content: 'M' }), doc)),
    '0,128,255,255', 'an {r,g,b,a} colour object renders exactly too');

  // --- alignment shifts the ink around the anchor in the right direction.
  const ax = 120;
  const bounds = {};
  for (const align of ['left', 'center', 'right']) {
    bounds[align] = inkBounds(rasterizeTextLayer(textLayer({ align, x: ax, content: 'align' }), doc));
    t.ok(bounds[align], `align "${align}" produced ink`);
  }
  t.close(bounds.left.minX, ax, 4, 'left-aligned point text starts at the anchor');
  t.close(bounds.right.maxX, ax, 4, 'right-aligned point text ends at the anchor');
  t.close((bounds.center.minX + bounds.center.maxX) / 2, ax, 4, 'centred point text straddles the anchor');
  t.gt(bounds.left.minX, bounds.center.minX, 'centre shifts the ink left of the left-aligned run');
  t.gt(bounds.center.minX, bounds.right.minX, 'right shifts it further left again');

  // --- lineHeight is a multiplier of the type size (exact arithmetic).
  const lay2 = layoutText({ content: 'A\nB', size: 40, lineHeight: 2 });
  t.eq(lay2.lineStep, 80, 'lineHeight 2 at size 40 is an 80 px line step');
  t.eq(lay2.height, 160, 'two lines at an 80 px step are 160 px tall');
  t.eq(lay2.lines.length, 2, 'a newline makes two lines');
  t.eq(layoutText({ content: 'A\nB', size: 40, lineHeight: 60 }).lineStep, 60,
    'a lineHeight above 5 is absolute pixel leading');
  t.eq(resolveLineStep(1.5, 40, 0), 60, 'resolveLineStep multiplies a small value by the size');
  t.eq(resolveLineStep(90, 40, 0), 90, 'resolveLineStep passes a large value through as pixels');
  const tallBounds = inkBounds(rasterizeTextLayer(textLayer({ content: 'A\nB', size: 24, lineHeight: 3, y: 40 }), doc));
  const tightBounds = inkBounds(rasterizeTextLayer(textLayer({ content: 'A\nB', size: 24, lineHeight: 1, y: 40 }), doc));
  t.gt(tallBounds.height, tightBounds.height, 'a bigger lineHeight makes the rendered block taller');

  // --- letterSpacing: added after every character, including the last.
  const w0 = measureTextLayer(textLayer({ content: 'IIII', letterSpacing: 0 })).width;
  const w10 = measureTextLayer(textLayer({ content: 'IIII', letterSpacing: 10 })).width;
  t.close(w10 - w0, 40, 0.001, 'letterSpacing 10 over 4 characters adds exactly 40 px');
  const narrow = inkBounds(rasterizeTextLayer(textLayer({ content: 'IIII', letterSpacing: 0, x: 20 }), doc));
  const wide = inkBounds(rasterizeTextLayer(textLayer({ content: 'IIII', letterSpacing: 10, x: 20 }), doc));
  t.gt(wide.width, narrow.width + 20, 'wider tracking makes a genuinely wider ink box');

  // --- underline / strikethrough each add ink.
  const plain = t.inked(rasterizeTextLayer(textLayer({ content: 'under' }), doc));
  const under = t.inked(rasterizeTextLayer(textLayer({ content: 'under', underline: true }), doc));
  const strike = t.inked(rasterizeTextLayer(textLayer({ content: 'under', strikethrough: true }), doc));
  const both = t.inked(rasterizeTextLayer(textLayer({ content: 'under', underline: true, strikethrough: true }), doc));
  t.gt(under, plain, 'underline adds ink');
  t.gt(strike, plain, 'strikethrough adds ink');
  t.gt(both, Math.max(under, strike), 'both rules together add more than either alone');
  const underBounds = inkBounds(rasterizeTextLayer(textLayer({ content: 'under', underline: true }), doc));
  const plainBounds = inkBounds(rasterizeTextLayer(textLayer({ content: 'under' }), doc));
  t.gt(underBounds.maxY, plainBounds.maxY, 'the underline sits below the baseline');

  // --- point text vs paragraph text.
  const long = 'wrapping paragraph text across several lines';
  const point = layoutText({ content: long, size: 16, paragraph: false });
  const para = layoutText({ content: long, size: 16, paragraph: true, boxWidth: 100 }, 100);
  t.eq(point.lines.length, 1, 'point text never wraps');
  t.gt(para.lines.length, 2, 'paragraph text wraps to boxWidth and produces more lines');
  const paraMeasure = measureTextLayer(textLayer({ content: long, size: 16, paragraph: true, boxWidth: 100, boxHeight: 90 }));
  t.eq(paraMeasure.width, 100, 'a paragraph box measures as wide as boxWidth');
  const paraWide = layoutText({ content: long, size: 16, paragraph: true, boxWidth: 220 }, 220);
  t.gt(para.lines.length, paraWide.lines.length, 'a narrower box wraps into more lines than a wide one');
  t.ok(para.lines.every((line) => line.width <= 104), 'no wrapped line overflows the box width');
  t.gt(t.inked(rasterizeTextLayer(textLayer({ content: long, size: 16, paragraph: true, boxWidth: 100, boxHeight: 90, x: 20, y: 20 }), doc)), 40,
    'paragraph text actually renders');
});

suite('text / measureTextLayer + warp', async (t) => {
  const doc = t.doc(240, 140, '#ffffff', 'text3');

  t.eq(measureTextLayer(new Layer({ type: LayerType.TEXT })), { x: 0, y: 0, width: 0, height: 0, layout: null },
    'a text layer with no payload measures as empty');

  const m = measureTextLayer(textLayer({ content: 'Measure', align: 'left', x: 20, y: 70, size: 36 }));
  t.eq(m.x, 20, 'left-aligned point text starts at text.x');
  t.lt(m.y, 70, 'the box top sits above the baseline');
  t.gt(m.width, 0, 'the measured width is positive');
  t.close(m.height, m.layout.lineStep, 0.001, 'a single line is exactly one line step tall');
  const centred = layoutText({ content: 'Measure', size: 36, align: 'center' });
  const o = textOrigin({ content: 'Measure', x: 20, y: 70, size: 36, align: 'center' }, centred);
  t.close(o.x, 20 - centred.width / 2, 1e-6, 'textOrigin centres the box on the anchor');
  t.close(textOrigin({ content: 'Measure', x: 20, y: 70, size: 36 }, m.layout).x, 20, 1e-6,
    'and leaves a left-aligned box at the anchor');

  // textLayerToMask is the type-mask tool's basis.
  const mask = textLayerToMask(textLayer({ content: 'Mask' }), doc);
  t.eq(mask.length, 240 * 140, 'the type mask is one byte per document pixel');
  t.gt(maskArea(mask), 20, 'the type mask covers the glyph area');

  // --- every warp style must change the render, and differ from the others.
  const base = rasterizeTextLayer(textLayer({ content: 'Warp', size: 34, x: 30, y: 80 }), doc);
  const baseBytes = read(base);
  const seen = new Map();
  const unchanged = [];
  for (const w of WARP_STYLES) {
    if (w.value === 'none') continue;
    const cv = rasterizeTextLayer(textLayer({
      content: 'Warp', size: 34, x: 30, y: 80, warp: { style: w.value, bend: 0.5, h: 0, v: 0 },
    }), doc);
    if (t.mad(baseBytes, read(cv)) === 0) unchanged.push(w.value);
    seen.set(w.value, `${t.inked(cv)}:${fingerprint(cv)}`);
  }
  t.eq(unchanged, [], 'every warp style changes the rendered bitmap');
  t.eq(new Set(seen.values()).size, seen.size, 'every warp style produces a distinct result');
  t.eq(seen.size, WARP_STYLES.length - 1, 'all seven warp styles were exercised');

  // A zero-amount warp is a no-op, so the "differs" test above is meaningful.
  const flat = rasterizeTextLayer(textLayer({
    content: 'Warp', size: 34, x: 30, y: 80, warp: { style: 'arc', bend: 0, h: 0, v: 0 },
  }), doc);
  t.eq(t.mad(baseBytes, read(flat)), 0, 'a warp with zero bend leaves the bitmap untouched');

  // fonts.js plumbing the renderer depends on.
  t.ok(fontStack('nope-not-a-family').length > 0, 'an unknown font id still resolves to a stack');
  t.eq(fontCssString({ style: 'italic', weight: 700, size: 24, font: 'courier' }),
    `italic 700 24px ${fontStack('courier')}`, 'fontCssString builds the CSS shorthand');
  t.gt(measureRun('MMMM', fontCssString({ size: 40, font: 'system' })),
    measureRun('MM', fontCssString({ size: 40, font: 'system' })), 'measureRun grows with the run length');
  t.eq(new Set(FONT_FAMILIES.map((f) => f.id)).size, FONT_FAMILIES.length, 'font family ids are unique');
});

/* ------------------------------------------------------------------ */
/* vector paths                                                       */
/* ------------------------------------------------------------------ */

suite('vector / path geometry + hit testing', async (t) => {
  const rect = createPath('R');
  rect.subpaths.push({ closed: true, points: [corner(10, 10), corner(50, 10), corner(50, 40), corner(10, 40)] });

  t.eq(createSubpath(true), { closed: true, points: [] }, 'createSubpath starts empty');
  t.eq(createPoint(3, 4), { x: 3, y: 4, in: null, out: null, corner: true }, 'createPoint with no handles is a corner');
  t.eq(createPoint(3, 4, { x: 1, y: 1 }).corner, false, 'a point carrying a handle is not a corner');

  t.ok(pathToPath2D(rect) instanceof Path2D, 'pathToPath2D builds a Path2D');
  t.eq(pathBounds(rect), { x: 10, y: 10, width: 40, height: 30 }, 'pathBounds of a rectangle is exact');
  t.eq(pathBounds(createPath('empty')), null, 'pathBounds of an empty path is null');
  t.eq(segmentCount(rect.subpaths[0]), 4, 'a closed 4-point subpath has 4 segments');

  // Bezier extrema must be included: p0 (0,50) c1 (0,0) c2 (100,0) p3 (100,50)
  // reaches y = 12.5 at t = 0.5, so the box is 37.5 tall, not 0.
  const curve = createPath('C');
  curve.subpaths.push({
    closed: false,
    points: [
      { x: 0, y: 50, in: null, out: { x: 0, y: 0 }, corner: false },
      { x: 100, y: 50, in: { x: 100, y: 0 }, out: null, corner: false },
    ],
  });
  const cb = pathBounds(curve);
  t.close(cb.y, 12.5, 1e-6, 'pathBounds includes the bezier extremum (y = 12.5)');
  t.close(cb.height, 37.5, 1e-6, 'so the curve box is exactly 37.5 tall');
  t.close(pointOnSegment(curve, 0, 0, 0.5).y, 12.5, 1e-6, 'pointOnSegment agrees at t = 0.5');

  // --- hit testing: anchors win over handles.
  const handled = createPath('H');
  handled.subpaths.push({
    closed: false,
    points: [
      { x: 20, y: 20, in: null, out: { x: 34, y: 20 }, corner: false },
      { x: 60, y: 20, in: { x: 46, y: 20 }, out: null, corner: false },
    ],
  });
  t.eq(hitTestPoint(handled, 20, 20, 5), { subpathIndex: 0, pointIndex: 0, kind: 'anchor' },
    'clicking an anchor returns the anchor');
  t.eq(hitTestPoint(handled, 34, 21, 5), { subpathIndex: 0, pointIndex: 0, kind: 'out' },
    'clicking an out handle returns that handle');
  t.eq(hitTestPoint(handled, 46, 20, 5), { subpathIndex: 0, pointIndex: 1, kind: 'in' },
    'clicking an in handle returns that handle');
  t.eq(hitTestPoint(handled, 100, 100, 5), null, 'nothing is hit far from the path');
  // An anchor 3 px from a handle must still return the anchor.
  const crowded = createPath('X');
  crowded.subpaths.push({
    closed: false,
    points: [
      { x: 20, y: 20, in: null, out: { x: 23, y: 20 }, corner: false },
      { x: 60, y: 20, in: null, out: null, corner: true },
    ],
  });
  t.eq(hitTestPoint(crowded, 21, 20, 5).kind, 'anchor', 'an anchor beats a handle sitting on top of it');

  // --- hitTestSegment
  const seg = hitTestSegment(rect, 30, 10, 5);
  t.eq([seg.subpathIndex, seg.segmentIndex], [0, 0], 'hitTestSegment finds the top edge');
  t.close(seg.t, 0.5, 0.02, 'and reports t near the middle of that edge');
  t.eq(hitTestSegment(rect, 30, 25, 5), null, 'the interior of a rectangle hits no segment');
  t.eq(hitTestSegment(rect, 10, 25, 5).segmentIndex, 3, 'the left edge is segment 3 of a closed rectangle');
});

suite('vector / path editing', async (t) => {
  // A circle, so the "insertion preserves the shape" test has curvature to lose.
  const circle = createPath('circle');
  circle.subpaths = shapeToSubpaths('circle', 10, 10, 80, 80);
  const before = pathToSelectionMask(circle, 100, 100);
  const beforeArea = maskArea(before);
  const beforePoints = circle.subpaths[0].points.length;

  const midpoint = pointOnSegment(clonePath(circle), 0, 0, 0.5);
  const ins = insertPointAt(circle, 0, 0, 0.5);
  t.eq(ins, { subpathIndex: 0, pointIndex: 1 }, 'insertPointAt reports the new index');
  t.eq(circle.subpaths[0].points.length, beforePoints + 1, 'insertPointAt adds exactly one point');
  const np = circle.subpaths[0].points[1];
  t.close(np.x, midpoint.x, 1e-6, 'the new anchor lands on the curve (x)');
  t.close(np.y, midpoint.y, 1e-6, 'the new anchor lands on the curve (y)');
  const after = pathToSelectionMask(circle, 100, 100);
  t.gt(beforeArea, 4000, 'the circle really is filled (precondition)');
  t.lt(t.mad(before, after), 0.05, 'de Casteljau insertion leaves the rasterised shape essentially unchanged');
  t.close(maskArea(after), beforeArea, 1, 'and the covered area is unchanged');

  // --- removePoint
  t.ok(removePoint(circle, 0, 1), 'removePoint removes an anchor');
  t.eq(circle.subpaths[0].points.length, beforePoints, 'the point count is back where it started');
  t.notOk(removePoint(circle, 0, 999), 'removing a nonexistent point reports false');
  const tiny = createPath('tiny');
  tiny.subpaths.push({ closed: false, points: [corner(0, 0), corner(10, 0)] });
  removePoint(tiny, 0, 0);
  t.eq(tiny.subpaths.length, 0, 'a subpath left with fewer than 2 points is dropped');

  // --- convertPoint
  const poly = createPath('poly');
  poly.subpaths.push({ closed: false, points: [corner(0, 0), corner(30, 30), corner(60, 0)] });
  const smooth = convertPoint(poly, 0, 1, true);
  t.ok(smooth.in && smooth.out, 'convertPoint(true) gives the point two handles');
  t.eq(smooth.corner, false, 'and marks it as a smooth point');
  // Handles derived from the neighbours are collinear through the anchor.
  const cross = (smooth.out.x - smooth.x) * (smooth.y - smooth.in.y)
    - (smooth.out.y - smooth.y) * (smooth.x - smooth.in.x);
  t.close(cross, 0, 1e-6, 'the two handles are collinear with the anchor');
  const back = convertPoint(poly, 0, 1, false);
  t.eq([back.in, back.out, back.corner], [null, null, true], 'convertPoint(false) restores a corner');

  // --- transformPath
  const tp = createPath('tp');
  tp.subpaths.push({
    closed: false,
    points: [{ x: 10, y: 20, in: null, out: { x: 14, y: 20 }, corner: false }],
  });
  transformPath(tp, new DOMMatrix().translateSelf(5, -5).scaleSelf(2, 2));
  const moved = tp.subpaths[0].points[0];
  t.eq([moved.x, moved.y], [25, 35], 'transformPath maps anchors through the matrix');
  t.eq([moved.out.x, moved.out.y], [33, 35], 'and maps the handles too');

  // --- pathToSelectionMask ground truth: a 40x30 rectangle covers 1200 pixels.
  const rect = createPath('rect');
  rect.subpaths = rectSubpaths(10, 10, 40, 30);
  const rm = pathToSelectionMask(rect, 80, 60);
  t.eq(rm.length, 80 * 60, 'the mask is one byte per pixel');
  t.close(maskArea(rm), 1200, 1, 'a 40x30 rectangle rasterises to 1200 covered pixels');
  t.eq(rm[25 * 80 + 30], 255, 'the interior is fully selected');
  t.eq(rm[5 * 80 + 5], 0, 'the outside is unselected');
});

suite('vector / custom shape library', async (t) => {
  t.eq(new Set(CUSTOM_SHAPES.map((s) => s.id)).size, CUSTOM_SHAPES.length, 'every custom shape id is unique');
  t.gt(CUSTOM_SHAPES.length, 20, 'the library is populated');

  const empty = [];
  const odd = [];
  for (const s of CUSTOM_SHAPES) {
    const subs = shapeToSubpaths(s.id, 10, 10, 64, 64);
    const area = maskArea(pathToSelectionMask(subs, 100, 100));
    if (!(area > 64)) empty.push(`${s.id} (area ${area.toFixed(1)})`);
    const b = subs.length ? pathBounds(subs) : null;
    if (!b || b.width < 12 || b.height < 12 || b.width > 96 || b.height > 96) {
      odd.push(`${s.id} (${b ? `${b.width.toFixed(1)}x${b.height.toFixed(1)}` : 'no bounds'})`);
    }
  }
  t.eq(empty, [], 'every custom shape rasterises to a non-empty area in its box');
  t.eq(odd, [], 'every custom shape has plausible bounds for a 64 px box');

  // Instantiating into a box twice as big must quadruple the covered area.
  for (const id of ['heart', 'gear', 'star-5']) {
    const small = maskArea(pathToSelectionMask(shapeToSubpaths(id, 0, 0, 50, 50), 60, 60));
    const big = maskArea(pathToSelectionMask(shapeToSubpaths(id, 0, 0, 100, 100), 110, 110));
    t.close(big / small, 4, 0.12, `"${id}" scales its area by 4 when the box doubles`);
  }

  // Ground truth for shapes whose area is knowable analytically, in a 100 box.
  const areaOf = (id) => maskArea(pathToSelectionMask(shapeToSubpaths(id, 0, 0, 100, 100), 100, 100));
  t.close(areaOf('circle'), Math.PI * 2500, 60, 'the circle covers pi*r^2');
  t.close(areaOf('triangle'), 5000, 60, 'the triangle covers half the box');
  t.close(areaOf('diamond'), 5000, 60, 'the diamond covers half the box');
  t.close(areaOf('plus'), 5100, 60, 'the plus covers 2*0.3*1 - 0.3^2 of the box');
  // The ring is a circle with a reverse-wound hole, so nonzero filling voids it.
  t.close(areaOf('ring'), Math.PI * (2500 - 784), 90, 'the ring is a circle minus a punched hole');
  t.lt(areaOf('ring'), areaOf('circle') - 2000, 'and is genuinely smaller than a solid circle');

  t.eq(shapeToSubpaths('no-such-shape', 0, 0, 50, 50), [], 'an unknown shape id returns no subpaths');
  t.eq(pathBounds(shapeToSubpaths('no-such-shape', 0, 0, 50, 50)), null, 'and its bounds are null');
  t.eq(getCustomShape('no-such-shape'), null, 'getCustomShape returns null for an unknown id');
  t.eq(getCustomShape('heart').id, 'heart', 'getCustomShape finds a known id');
});

suite('vector / rasterizeShapeLayer', async (t) => {
  const doc = t.doc(80, 60, '#ffffff', 'shape');
  const shapeLayer = (shape) => {
    const l = new Layer({ type: LayerType.SHAPE, name: 'S' });
    l.shape = shape;
    return rasterizeShapeLayer(l, doc);
  };
  const geom = rectSubpaths(10, 10, 60, 40);

  // --- solid fill
  const solid = shapeLayer({ kind: 'shape', subpaths: geom, fill: { type: 'solid', color: '#ff0000' }, stroke: { enabled: false } });
  t.eq([solid.width, solid.height], [80, 60], 'the shape canvas is document-sized');
  t.pixel(solid, 40, 30, '255,0,0,255', 'the interior is exactly the fill colour');
  t.pixel(solid, 4, 4, '0,0,0,0', 'outside the shape is transparent');
  t.close(t.inked(solid), 2400, 10, 'a 60x40 rectangle inks exactly 2400 pixels');

  const noFill = shapeLayer({ kind: 'shape', subpaths: geom, fill: 'none', stroke: { enabled: false } });
  t.eq(t.inked(noFill, 0), 0, 'fill "none" draws nothing');
  const noGeom = shapeLayer({ kind: 'shape', subpaths: [], fill: { type: 'solid', color: '#ff0000' } });
  t.eq(t.inked(noGeom, 0), 0, 'a shape with no subpaths draws nothing');

  // --- gradient fill: black at the left edge of the box, white at the right.
  const grad = shapeLayer({
    kind: 'shape',
    subpaths: geom,
    fill: { type: 'linear', angle: 0, stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }] },
    stroke: { enabled: false },
  });
  const at = (x) => Number(t.px(grad, x, 30).split(',')[0]);
  t.lt(at(12), 20, 'the gradient starts near black at the left of the shape');
  t.gt(at(68), 235, 'and reaches near white at the right');
  t.gt(at(68) - at(12), 200, 'so the gradient genuinely varies across the shape');
  t.close(at(40), 128, 8, 'the middle of the gradient is mid grey');
  t.gt(at(52), at(28), 'the ramp is monotonic left to right');
  t.pixel(grad, 4, 30, '0,0,0,0', 'the gradient is clipped to the shape');

  // --- stroke on / off
  const stroked = shapeLayer({
    kind: 'shape', subpaths: geom,
    fill: { type: 'solid', color: '#ff0000' },
    stroke: { enabled: true, color: '#0000ff', width: 6, align: 'center', cap: 'butt', join: 'miter', dash: 'solid' },
  });
  t.gt(t.inked(stroked), t.inked(solid), 'a centred stroke adds ink outside the fill');
  t.pixel(stroked, 8, 30, '0,0,255,255', 'the centred stroke straddles the outline');
  t.pixel(solid, 8, 30, '0,0,0,0', 'which the unstroked shape leaves empty (precondition)');

  const outside = shapeLayer({
    kind: 'shape', subpaths: geom,
    fill: { type: 'solid', color: '#ff0000' },
    stroke: { enabled: true, color: '#0000ff', width: 6, align: 'outside' },
  });
  const inside = shapeLayer({
    kind: 'shape', subpaths: geom,
    fill: { type: 'solid', color: '#ff0000' },
    stroke: { enabled: true, color: '#0000ff', width: 6, align: 'inside' },
  });
  t.gt(t.inked(outside), t.inked(inside), 'an outside stroke covers more area than an inside one');
  t.pixel(outside, 7, 30, '0,0,255,255', 'the outside stroke paints beyond the outline');
  t.pixel(inside, 7, 30, '0,0,0,0', 'the inside stroke does not');
  t.pixel(inside, 12, 30, '0,0,255,255', 'the inside stroke paints within the outline');
  t.gt(t.mad(read(outside), read(inside)), 0, 'stroke alignment genuinely changes the result');

  const noStroke = shapeLayer({
    kind: 'shape', subpaths: geom,
    fill: { type: 'solid', color: '#ff0000' },
    stroke: { enabled: true, color: '#0000ff', width: 0 },
  });
  t.eq(t.mad(read(noStroke), read(solid)), 0, 'a zero-width stroke is the same as no stroke at all');
});

/* ------------------------------------------------------------------ */
/* authored geometry follows the pixels                                */
/* ------------------------------------------------------------------ */

/**
 * Text and shape layers keep two descriptions of where they are: the rendered
 * canvas, and the parameters that produced it. Every operation that moves the
 * canvas has to move the parameters with it, or the layer silently jumps back to
 * where it was authored the next time anything re-renders — which is a colour
 * conversion, a font change, or just typing one more character.
 *
 * Each case below renders, transforms, then re-renders from the parameters and
 * requires the two to agree. Verified to fail without the fix: with
 * `mapLayerGeometry` removed from `offsetLayer`, the moved shape re-renders at
 * its authored origin and the first assertion reports 8,8 instead of 68,48.
 */
const GEO_RECT = [{
  closed: true,
  points: [{ x: 8, y: 8 }, { x: 50, y: 8 }, { x: 50, y: 32 }, { x: 8, y: 32 }],
}];

suite('vector / authored geometry survives document transforms', async (t) => {
  const { PikaDocument } = await import('/src/core/document.js');
  const { createShapeLayer } = await import('/src/vector/path.js');
  const { translateLayerGeometry, mapLayerGeometry } = await import('/src/core/layer.js');

  const withShape = () => {
    const doc = new PikaDocument({ width: 200, height: 150, name: 'geo' });
    const layer = createShapeLayer(doc, GEO_RECT, { fill: { type: 'solid', color: '#ff0000' } }, 'R');
    doc.layers.unshift(layer);
    return { doc, layer };
  };
  const box = (b) => (b ? `${b.minX},${b.minY},${b.width},${b.height}` : 'none');

  {
    const { doc, layer } = withShape();
    const drawn = inkBounds(layer.canvas);
    t.eq(`${drawn.minX},${drawn.minY}`, '8,8', 'the shape renders at its authored origin');
    translateLayerGeometry(layer, 60, 40);
    layer.canvas = rasterizeShapeLayer(layer, doc);
    const moved = inkBounds(layer.canvas);
    t.eq(`${moved.minX},${moved.minY}`, '68,48', 'translating the parameters moves the re-render with them');
    t.eq(`${moved.width},${moved.height}`, `${drawn.width},${drawn.height}`, 'and does not change its size');
  }

  for (const [name, op] of [
    ['canvas size', (doc) => doc.resizeCanvasTo(300, 250, 'center')],
    ['crop', (doc) => doc.crop({ x: 4, y: 4, width: 120, height: 100 })],
    ['rotate cw', (doc) => doc.transformImage('cw')],
    ['rotate ccw', (doc) => doc.transformImage('ccw')],
    ['rotate 180', (doc) => doc.transformImage('180')],
    ['flip horizontal', (doc) => doc.transformImage('flip-h')],
    ['flip vertical', (doc) => doc.transformImage('flip-v')],
  ]) {
    const { doc, layer } = withShape();
    op(doc);
    const live = doc.findLayer(layer.id);
    const drawn = inkBounds(live.canvas);
    live.canvas = rasterizeShapeLayer(live, doc);
    t.eq(box(inkBounds(live.canvas)), box(drawn),
      `${name}: re-rendering from the parameters reproduces the transformed pixels`);
  }

  // Resample scales the geometry. The bitmap is bilinear so its edge spreads by a
  // pixel either side; the parameters have to land on the exact doubling.
  {
    const { doc, layer } = withShape();
    doc.resample(400, 300);
    const live = doc.findLayer(layer.id);
    live.canvas = rasterizeShapeLayer(live, doc);
    t.eq(box(inkBounds(live.canvas)), '16,16,84,48', 'resampling doubles the authored geometry exactly');
  }

  // Text carries its anchor.
  {
    const doc = new PikaDocument({ width: 200, height: 150, name: 'txt' });
    const layer = new Layer({ type: LayerType.TEXT, name: 'T' });
    layer.text = { text: 'Hi', x: 10, y: 40, size: 28, color: '#ffffff', font: 'sans-serif' };
    layer.canvas = rasterizeTextLayer(layer, doc);
    const before = inkBounds(layer.canvas);
    translateLayerGeometry(layer, 60, 40);
    t.eq(`${layer.text.x},${layer.text.y}`, '70,80', 'the text anchor moves with the layer');
    layer.canvas = rasterizeTextLayer(layer, doc);
    const after = inkBounds(layer.canvas);
    t.eq(`${after.minX - before.minX},${after.minY - before.minY}`, '60,40',
      're-rendering the text keeps it where it was put');

    mapLayerGeometry(layer, (x, y) => ({ x: 200 - x, y }));
    t.eq(`${layer.text.x},${layer.text.y}`, '130,80', 'a flip maps the text anchor and leaves the other axis alone');
  }

  // A scale takes the glyph size and the wrap box with it.
  {
    const layer = new Layer({ type: LayerType.TEXT, name: 'T2' });
    layer.text = { text: 'Hi', x: 10, y: 40, size: 28, boxWidth: 100, boxHeight: 50, paragraph: true };
    mapLayerGeometry(layer, (x, y) => ({ x: x * 2, y: y * 2 }), 2);
    t.eq(`${layer.text.x},${layer.text.y}`, '20,80', 'the anchor scales');
    t.eq(layer.text.scale, 2, 'the glyph scale doubles');
    t.eq(`${layer.text.boxWidth},${layer.text.boxHeight}`, '200,100', 'and the wrap box scales with it');
  }
});
