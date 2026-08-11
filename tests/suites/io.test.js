import { suite } from '../harness.js';
import { Layer, LayerType, createRasterLayer, createGroupLayer, createAdjustmentLayer } from '/src/core/layer.js';
import { Selection } from '/src/core/selection.js';
import { createCanvas, ctx2d, loadImage } from '/src/core/util.js';
import { compositeDocument } from '/src/render/compositor.js';
import { DEFAULT_STYLES } from '/src/effects/styles.js';
import { rasterizeTextLayer, defaultTextProps } from '/src/text/text-render.js';
import { rasterizeShapeLayer, createPath } from '/src/vector/path.js';
import { savePKD, loadPKD } from '/src/io/pkd.js';
import { writePSD, SELECTION_CHANNEL_NAME } from '/src/io/psd-write.js';
import { readPSD } from '/src/io/psd-read.js';
import { POSTSCRIPT_FACES, postScriptFace, familyFromPostScriptName } from '/src/text/fonts.js';
import { encodeGIF, buildPalette } from '/src/io/gif.js';
import { exportDocument } from '/src/io/save.js';
import { exportSVG } from '/src/io/svg.js';

/* ------------------------------------------------------------------ */
/* fixture                                                             */
/* ------------------------------------------------------------------ */

const corner = (x, y) => ({ x, y, in: null, out: null, corner: true });
const rectSubpaths = (x, y, w, h) => [{
  closed: true,
  points: [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)],
}];

/** Coordinates chosen so the PSD's 8.24 fixed point is exact for 80x60. */
const PATH_POINTS = [[10, 15], [40, 15], [40, 45], [10, 45]];

/**
 * One document exercising every layer type plus every piece of document-level
 * state the two lossless formats claim to keep. Opacities are exact multiples
 * of 1/255 so an 8-bit round trip cannot lose them.
 */
function buildFixture(t) {
  const doc = t.doc(80, 60, '#ffffff', 'Fixture');
  const bg = doc.layers[0];
  // A dark band under the screen-blended shape, so that layer's blend mode and
  // pixels genuinely affect the composite instead of vanishing into white.
  t.fill(bg, '#303030', 40, 0, 40, 34);

  // Raster: layer mask, layer styles, fill opacity, a non-normal blend mode.
  const masked = createRasterLayer(80, 60, 'Masked');
  t.fill(masked, '#c04020', 6, 6, 34, 24);
  masked.addMask(80, 60, '#ffffff');
  const mc = ctx2d(masked.mask);
  mc.fillStyle = '#000000';
  mc.fillRect(0, 0, 14, 60);
  masked.touchMask();
  masked.opacity = 0.8;
  masked.fillOpacity = 0.6;
  masked.blendMode = 'multiply';
  masked.styles = {
    dropShadow: {
      ...DEFAULT_STYLES.dropShadow,
      enabled: true, color: '#0000ff', opacity: 0.5, distance: 6, size: 4, angle: 120,
    },
  };

  // Group holding a clipped layer over its base.
  const group = createGroupLayer('Group');
  group.opacity = 0.6;
  group.blendMode = 'multiply';
  const base = createRasterLayer(80, 60, 'Base');
  t.fill(base, '#3050c0', 30, 26, 30, 22);
  const clip = createRasterLayer(80, 60, 'Clipped');
  t.fill(clip, '#ffd000', 20, 18, 50, 36);
  clip.clipped = true;
  group.children = [clip, base];
  clip.parent = group;
  base.parent = group;

  const adj = createAdjustmentLayer('posterize', { levels: 4 }, 80, 60, 'Posterize');

  const shape = new Layer({ type: LayerType.SHAPE, name: 'Badge', blendMode: 'screen' });
  shape.shape = {
    kind: 'shape',
    subpaths: rectSubpaths(46, 8, 26, 20),
    fill: { type: 'solid', color: '#22aa44' },
    stroke: { enabled: true, color: '#003311', width: 3, align: 'center', cap: 'butt', join: 'miter', dash: 'solid' },
  };
  shape.canvas = rasterizeShapeLayer(shape, doc);

  const text = new Layer({ type: LayerType.TEXT, name: 'Headline', opacity: 0.8 });
  text.text = defaultTextProps({
    content: 'Pika', font: 'system', size: 20, weight: 700, color: '#204080', x: 5, y: 24,
  });
  rasterizeTextLayer(text, doc);

  doc.layers = [text, adj, shape, group, masked, bg];
  doc.activeLayerId = text.id;
  doc.selectedLayerIds = [text.id];

  // Document-level state.
  doc.guides = [{ axis: 'v', pos: 20 }, { axis: 'h', pos: 12 }];

  const path = createPath('Outline');
  path.subpaths = [{ closed: true, points: PATH_POINTS.map(([x, y]) => corner(x, y)) }];
  doc.paths = [path];
  doc.activePathId = path.id;

  const chan = createCanvas(80, 60);
  const cc = ctx2d(chan);
  cc.fillStyle = '#000000';
  cc.fillRect(0, 0, 80, 60);
  cc.fillStyle = '#ffffff';
  cc.fillRect(30, 10, 24, 18);
  doc.alphaChannels = [{ id: 'chan_fixture', name: 'Cutout', canvas: chan }];

  doc.selection.set(Selection.rectMask(10, 12, 30, 20, 80, 60));

  doc.touch();
  return { doc, text, shape, masked, group, adj, path };
}

/**
 * Assert that a reloaded document is the fixture again.
 * @param {boolean} exact true for `.pkd`, where nothing at all may be lost
 */
function assertFixture(t, src, out, tag, exact) {
  t.eq([out.width, out.height], [80, 60], `${tag}: document size survives`);
  t.eq(out.layers.length, 6, `${tag}: six top-level layers`);
  t.eq(out.layers.map((l) => l.name), ['Headline', 'Posterize', 'Badge', 'Group', 'Masked', 'Background'],
    `${tag}: layer names and order survive`);
  t.eq(out.layers.map((l) => l.type), ['text', 'adjustment', 'shape', 'group', 'raster', 'raster'],
    `${tag}: layer types survive`);
  t.eq(out.layers.map((l) => l.blendMode), ['normal', 'normal', 'screen', 'multiply', 'multiply', 'normal'],
    `${tag}: blend modes survive`);
  t.ok(out.layers[5].isBackground, `${tag}: the Background stays a background`);

  const [text, adj, shape, group, masked] = out.layers;
  t.close(text.opacity, 0.8, 0.002, `${tag}: layer opacity survives`);
  t.close(group.opacity, 0.6, 0.002, `${tag}: group opacity survives`);
  t.close(masked.fillOpacity, 0.6, 0.002, `${tag}: fill opacity survives`);

  // Group nesting + clipping.
  t.eq((group.children || []).map((l) => l.name), ['Clipped', 'Base'], `${tag}: group children survive in order`);
  t.eq(group.children[0].clipped, true, `${tag}: the clipped layer is still clipped`);
  t.eq(group.children[1].clipped, false, `${tag}: its base is not`);

  // Mask.
  t.ok(masked.mask, `${tag}: the layer mask came back`);
  t.eq(masked.maskEnabled, true, `${tag}: the mask is enabled`);
  t.eq(t.px(masked.mask, 4, 30), '0,0,0,255', `${tag}: the masked-out region is still black`);
  t.eq(t.px(masked.mask, 40, 30), '255,255,255,255', `${tag}: the visible region is still white`);

  // Live text.
  t.eq(text.text.content, 'Pika', `${tag}: text content survives`);
  t.eq([text.text.size, text.text.weight], [20, 700], `${tag}: text size and weight survive`);
  t.eq(text.text.color, '#204080', `${tag}: text colour survives`);
  t.eq([text.text.x, text.text.y], [5, 24], `${tag}: text anchor survives`);
  t.eq(text.text.font, 'system', `${tag}: text family survives`);

  // Live vector shape.
  t.eq(shape.shape.subpaths.length, 1, `${tag}: the shape kept its subpath`);
  t.eq(shape.shape.subpaths[0].closed, true, `${tag}: and it is still closed`);
  const got = shape.shape.subpaths[0].points.map((p) => [p.x, p.y]);
  const want = [[46, 8], [72, 8], [72, 28], [46, 28]];
  if (exact) t.eq(got, want, `${tag}: shape geometry is exact`);
  else {
    let err = 0;
    got.forEach((p, i) => { err = Math.max(err, Math.abs(p[0] - want[i][0]), Math.abs(p[1] - want[i][1])); });
    t.lt(err, 0.02, `${tag}: shape geometry survives to within 0.02 px`);
  }
  t.eq(shape.shape.fill.type, 'solid', `${tag}: the shape fill kind survives`);
  t.eq(shape.shape.fill.color, '#22aa44', `${tag}: the shape fill colour survives`);
  t.eq(shape.shape.stroke.width, 3, `${tag}: the shape stroke width survives`);

  // Adjustment layer.
  t.eq(adj.adjustment.kind, 'posterize', `${tag}: adjustment kind survives`);
  t.eq(adj.adjustment.params, { levels: 4 }, `${tag}: adjustment params survive`);
  t.eq(adj.canvas, null, `${tag}: an adjustment layer carries no pixels`);

  // Layer styles.
  t.ok(masked.styles && masked.styles.dropShadow, `${tag}: layer styles came back`);
  const ds = masked.styles.dropShadow;
  t.eq([ds.enabled, ds.color, ds.opacity, ds.distance, ds.size, ds.angle],
    [true, '#0000ff', 0.5, 6, 4, 120], `${tag}: the drop shadow configuration survives`);
  if (exact) t.eq(masked.styles, src.layers[4].styles, `${tag}: styles round trip byte for byte`);

  // Vector paths.
  t.eq(out.paths.length, 1, `${tag}: the saved path came back`);
  t.eq(out.paths[0].name, 'Outline', `${tag}: the path name survives`);
  const pp = out.paths[0].subpaths[0].points.map((p) => [p.x, p.y]);
  if (exact) t.eq(pp, PATH_POINTS, `${tag}: path anchors are exact`);
  else {
    let err = 0;
    pp.forEach((p, i) => { err = Math.max(err, Math.abs(p[0] - PATH_POINTS[i][0]), Math.abs(p[1] - PATH_POINTS[i][1])); });
    t.lt(err, 0.02, `${tag}: path anchors survive to within 0.02 px`);
  }
  t.eq(out.paths[0].subpaths[0].closed, true, `${tag}: the path is still closed`);

  // Alpha channels — the selection must NOT show up as one.
  t.eq(out.alphaChannels.map((c) => c.name), ['Cutout'], `${tag}: saved alpha channels survive by name`);
  t.eq(t.px(out.alphaChannels[0].canvas, 40, 20), '255,255,255,255', `${tag}: the alpha channel keeps its white area`);
  t.eq(t.px(out.alphaChannels[0].canvas, 4, 4), '0,0,0,255', `${tag}: and its black area`);

  // Guides.
  t.eq(out.guides, [{ axis: 'v', pos: 20 }, { axis: 'h', pos: 12 }], `${tag}: guides survive`);

  // Active selection.
  t.ok(out.selection.active, `${tag}: the active selection survives`);
  t.eq(out.selection.bounds(), { x: 10, y: 12, width: 30, height: 20 }, `${tag}: with the same bounds`);
  t.eq(out.selection.at(20, 20), 1, `${tag}: and the same coverage inside`);
  t.eq(out.selection.at(60, 50), 0, `${tag}: and outside`);

  // The whole point: the picture is identical.
  const a = compositeDocument(src);
  const b = compositeDocument(out);
  t.gt(t.inked(a), 2000, `${tag}: the fixture composite is not blank (precondition)`);
  t.eq(t.mad(t.bytes(a), t.bytes(b)), 0, `${tag}: the composite is bit-identical`);
}

/* ------------------------------------------------------------------ */
/* .pkd                                                                */
/* ------------------------------------------------------------------ */

suite('io / .pkd lossless round trip', async (t) => {
  const { doc } = buildFixture(t);

  const blob = await savePKD(doc);
  t.eq(blob.type, 'application/x-pikado', 'savePKD writes a Pikado project blob');
  t.gt(blob.size, 1000, 'and it is not trivially small');
  const buf = await blob.arrayBuffer();
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 8));
  t.eq(magic, 'PIKADO01', 'the file starts with the PIKADO01 magic');

  const out = await loadPKD(buf);
  assertFixture(t, doc, out, 'pkd', true);

  t.eq(out.name, 'Fixture', 'pkd: the document name survives');
  t.eq(out.activePathId, doc.activePathId, 'pkd: the active path id survives');
  t.eq(out.activeLayerId, doc.activeLayerId, 'pkd: the active layer survives');
  t.notOk(out.dirty, 'pkd: a freshly loaded document is not dirty');
  t.eq(out.history.states.length, 1, 'pkd: history starts fresh');

  // The "bit-identical composite" assertion is only worth anything if every
  // layer in the fixture actually reaches the composite. Prove that it does.
  const ref = t.bytes(compositeDocument(doc));
  const weak = [];
  for (const l of doc.flatLayers()) {
    l.visible = false;
    doc.touch();
    const delta = t.mad(ref, t.bytes(compositeDocument(doc)));
    l.visible = true;
    doc.touch();
    if (!(delta > 0.02)) weak.push(`${l.name} (${delta.toFixed(4)})`);
  }
  t.eq(weak, [], 'pkd: every layer of the fixture measurably affects the composite');

  await t.throws(() => loadPKD(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).buffer),
    'pkd: a file without the magic is rejected');
  await t.throws(() => loadPKD(new Uint8Array(4).buffer), 'pkd: a truncated file is rejected');
});

/* ------------------------------------------------------------------ */
/* PSD                                                                 */
/* ------------------------------------------------------------------ */

suite('io / PSD round trip', async (t) => {
  const { doc } = buildFixture(t);

  const blob = await writePSD(doc);
  t.eq(blob.type, 'image/vnd.adobe.photoshop', 'writePSD writes a Photoshop blob');
  t.gt(blob.size, 2000, 'and it is not trivially small');
  const buf = await blob.arrayBuffer();
  t.eq(String.fromCharCode(...new Uint8Array(buf, 0, 4)), '8BPS', 'the file starts with the 8BPS signature');
  t.eq(new DataView(buf).getUint16(4), 1, 'and declares PSD version 1');
  // RGB + transparency + one alpha channel + the selection channel.
  t.eq(new DataView(buf).getUint16(12), 6, 'the header counts colour, transparency and both extra channels');
  t.eq(new DataView(buf).getUint32(14), 60, 'the header carries the document height');
  t.eq(new DataView(buf).getUint32(18), 80, 'and the width');

  const out = await readPSD(buf);
  assertFixture(t, doc, out, 'psd', false);

  t.eq(out.alphaChannels.some((c) => c.name === SELECTION_CHANNEL_NAME), false,
    'psd: the selection channel is turned back into a selection, not listed as a channel');
  t.notOk(out.dirty, 'psd: a freshly read document is not dirty');
});

/* ------------------------------------------------------------------ */
/* GIF                                                                 */
/* ------------------------------------------------------------------ */

/** Decode a blob (or data URL) through an <img> and return it on a fresh canvas. */
async function decodeToCanvas(blob) {
  const img = await loadImage(blob);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const cv = createCanvas(w, h);
  ctx2d(cv).drawImage(img, 0, 0);
  return cv;
}

suite('io / GIF export', async (t) => {
  // Four flat blocks: median cut must reproduce them exactly.
  const cv = createCanvas(48, 48);
  const c = ctx2d(cv);
  const blocks = [['#ff0000', 0, 0], ['#00ff00', 24, 0], ['#0000ff', 0, 24], ['#ffffff', 24, 24]];
  for (const [color, x, y] of blocks) {
    c.fillStyle = color;
    c.fillRect(x, y, 24, 24);
  }

  const blob = encodeGIF(cv, true);
  t.eq(blob.type, 'image/gif', 'encodeGIF returns an image/gif blob');
  const head = new Uint8Array(await blob.slice(0, 6).arrayBuffer());
  t.eq(String.fromCharCode(...head), 'GIF89a', 'the file starts with GIF89a');
  const tail = new Uint8Array(await blob.slice(blob.size - 1).arrayBuffer());
  t.eq(tail[0], 0x3b, 'and ends with the GIF trailer');

  const back = await decodeToCanvas(blob);
  t.eq([back.width, back.height], [48, 48], 'the decoded GIF has the source size');
  t.pixel(back, 12, 12, '255,0,0,255', 'the red block decodes exactly');
  t.pixel(back, 36, 12, '0,255,0,255', 'the green block decodes exactly');
  t.pixel(back, 12, 36, '0,0,255,255', 'the blue block decodes exactly');
  t.pixel(back, 36, 36, '255,255,255,255', 'the white block decodes exactly');
  t.eq(t.mad(t.bytes(cv), t.bytes(back)), 0, 'every pixel of the decoded GIF matches the source');

  // A bigger, busier image so the LZW code width has to grow several times.
  const palette8 = [
    [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0],
    [0, 255, 255], [255, 0, 255], [170, 85, 0], [85, 170, 255],
  ];
  const big = createCanvas(128, 128);
  const bc = ctx2d(big);
  for (let by = 0; by < 8; by++) {
    for (let bx = 0; bx < 8; bx++) {
      const p = palette8[(bx + by * 3) % 8];
      bc.fillStyle = `rgb(${p[0]},${p[1]},${p[2]})`;
      bc.fillRect(bx * 16, by * 16, 16, 16);
    }
  }
  const bigBack = await decodeToCanvas(encodeGIF(big, false));
  t.eq([bigBack.width, bigBack.height], [128, 128], 'the larger GIF decodes at the right size');
  t.gt(t.inked(bigBack), 16000, 'and is fully painted (precondition)');
  t.eq(t.mad(t.bytes(big), t.bytes(bigBack)), 0,
    'an eight-colour 128x128 image survives LZW compression exactly');

  // Binary transparency.
  const alpha = createCanvas(32, 32);
  const ac = ctx2d(alpha);
  ac.fillStyle = '#ff0000';
  ac.fillRect(0, 0, 16, 32);
  const alphaBack = await decodeToCanvas(encodeGIF(alpha, true));
  t.pixel(alphaBack, 8, 16, '255,0,0,255', 'the opaque half of a transparent GIF keeps its colour');
  t.pixel(alphaBack, 24, 16, '0,0,0,0', 'and the empty half decodes as transparent');

  // buildPalette ground truth: two flat colours make a two-entry palette.
  const twoTone = createCanvas(8, 8);
  const tc = ctx2d(twoTone);
  tc.fillStyle = '#ff0000';
  tc.fillRect(0, 0, 4, 8);
  tc.fillStyle = '#00ff00';
  tc.fillRect(4, 0, 4, 8);
  const pal = buildPalette(t.bytes(twoTone), 256);
  t.eq(pal.length, 2, 'buildPalette finds exactly two colours in a two-tone image');
  t.eq(pal.map((p) => p.join(',')).sort(), ['0,255,0', '255,0,0'],
    'and reproduces both of them exactly');
});

/* ------------------------------------------------------------------ */
/* PNG / JPEG / WebP / SVG                                             */
/* ------------------------------------------------------------------ */

suite('io / raster + SVG export', async (t) => {
  const doc = t.doc(40, 30, '#ffffff', 'Export');
  const layer = doc.activeLayer();
  t.fill(layer, '#ff0000', 0, 0, 20, 30);
  doc.touch();
  const source = compositeDocument(doc);

  const png = await exportDocument(doc, { format: 'png', save: false });
  t.ok(png, 'PNG export produced a blob');
  t.eq(png.type, 'image/png', 'with the PNG MIME type');
  t.gt(png.size, 80, 'and a non-trivial size');
  const pngBack = await decodeToCanvas(png);
  t.eq([pngBack.width, pngBack.height], [40, 30], 'the PNG has the document size');
  t.eq(t.mad(t.bytes(source), t.bytes(pngBack)), 0, 'a re-imported PNG matches the composite exactly');
  t.eq(t.px(pngBack, 5, 15), '255,0,0,255', 'and the red half really is red (precondition)');

  const jpeg = await exportDocument(doc, { format: 'jpeg', quality: 0.9, save: false });
  t.eq(jpeg.type, 'image/jpeg', 'JPEG export has the JPEG MIME type');
  t.gt(jpeg.size, 200, 'and a non-trivial size');
  const jpegBack = await decodeToCanvas(jpeg);
  t.eq([jpegBack.width, jpegBack.height], [40, 30], 'the JPEG decodes at the document size');
  t.lt(t.mad(t.bytes(source), t.bytes(jpegBack)), 12, 'and is a close (lossy) match of the composite');

  const webp = await exportDocument(doc, { format: 'webp', save: false });
  t.eq(webp.type, 'image/webp', 'WebP export has the WebP MIME type');
  t.gt(webp.size, 60, 'and a non-trivial size');

  t.eq(await exportDocument(doc, { format: 'tiff', save: false }), null,
    'an unsupported format fails cleanly instead of writing a file');

  // Scale.
  const half = await decodeToCanvas(await exportDocument(doc, { format: 'png', scale: 0.5, save: false }));
  t.eq([half.width, half.height], [20, 15], 'scale 0.5 produces half-size output');
  const double = await decodeToCanvas(await exportDocument(doc, { format: 'png', scale: 2, save: false }));
  t.eq([double.width, double.height], [80, 60], 'scale 2 produces double-size output');

  // Transparency.
  const clearDoc = t.doc(40, 30, 'transparent', 'Alpha');
  t.fill(clearDoc.activeLayer(), '#00a0ff', 0, 0, 20, 30);
  clearDoc.touch();
  const kept = await decodeToCanvas(await exportDocument(clearDoc, { format: 'png', transparent: true, save: false }));
  t.eq(t.px(kept, 30, 15), '0,0,0,0', 'transparent:true keeps the empty half empty (precondition)');
  const flat = await decodeToCanvas(await exportDocument(clearDoc, { format: 'png', transparent: false, save: false }));
  const bytes = t.bytes(flat);
  let translucent = 0;
  for (let i = 3; i < bytes.length; i += 4) if (bytes[i] !== 255) translucent++;
  t.eq(translucent, 0, 'transparent:false produces a fully opaque image');
  t.eq(t.px(flat, 30, 15), '255,255,255,255', 'with the empty area flattened onto white');
  t.eq(t.px(flat, 5, 15), '0,160,255,255', 'and the painted area untouched');

  // SVG.
  const svg = await exportSVG(doc).text();
  t.ok(svg.includes('<svg '), 'the SVG has an <svg> root');
  t.ok(/width="40"\s+height="30"/.test(svg), 'sized to the document');
  t.ok(svg.includes('viewBox="0 0 40 30"'), 'with a matching viewBox');
  t.ok(svg.includes('data:image/png;base64,'), 'and embeds the raster content as a PNG data URI');
  const href = /href="(data:image\/png;base64,[^"]+)"/.exec(svg);
  t.ok(href, 'the embedded image href is parseable');
  const embedded = await decodeToCanvas(href[1]);
  t.eq(t.mad(t.bytes(layer.canvas), t.bytes(embedded)), 0, 'the embedded PNG is the layer, pixel for pixel');

  const svgBlob = await exportDocument(doc, { format: 'svg', save: false });
  t.ok(svgBlob && svgBlob.type.startsWith('image/svg+xml'), 'exportDocument("svg") returns an SVG blob');
});

/* ------------------------------------------------------------------ */
/* PSD interop — faces, live shapes, dashes, byte stability            */
/* ------------------------------------------------------------------ */

/**
 * The parts of the PSD format that carry *parameters* rather than pixels.
 *
 * A PSD names a type layer's font by its PostScript name, which identifies one
 * face — one file — so bold and italic belong in that name whenever the family
 * ships them separately, and only fall back to `/FauxBold` and `/FauxItalic`
 * when it does not. Live shapes work the same way: the path is authoritative for
 * geometry, and `vogk` carries the handful of parameters a path cannot express
 * (a polygon's side count, a line's weight, a rectangle's corner radii).
 *
 * The face names could not be checked against a Photoshop install — see the note
 * in `src/io/psd-write.js`. What is checked here is the property that is ours to
 * guarantee: every name we write maps back to the same family, weight and slant.
 *
 * Byte stability gets its own suite because two bugs hid behind "the pixels are
 * fine": the reader attached an inert text warp that the writer then persisted,
 * and the private JSON blocks inherited JavaScript's insertion order, so the
 * same document saved from memory and saved after a reopen differed in bytes
 * while being identical as data.
 */

const psdRoundTrip = async (doc) => readPSD(await (await writePSD(doc)).arrayBuffer());
const psdBytes = async (doc) => new Uint8Array(await (await writePSD(doc)).arrayBuffer());

/** The first differing byte of two files, or null when they are identical. */
function firstByteDiff(a, b) {
  if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `byte ${i}: ${a[i]} vs ${b[i]}`;
  return null;
}

/** A document with one shape layer, rasterised the way the shape tools do it. */
function shapeDoc(t, name, shape, w = 220, h = 180) {
  const doc = t.doc(w, h, null, name);
  doc.layers.length = 0;
  const layer = new Layer({ name, type: LayerType.SHAPE, shape });
  layer.canvas = rasterizeShapeLayer(layer, doc);
  doc.layers.push(layer);
  doc.invalidate();
  return { doc, layer };
}

const openSubpath = (pts) => [{ closed: false, points: pts.map(([x, y]) => corner(x, y)) }];
const closedSubpath = (pts) => [{ closed: true, points: pts.map(([x, y]) => corner(x, y)) }];
const ringSubpath = (cx, cy, r, n) => closedSubpath(Array.from({ length: n }, (_, i) => {
  const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
  return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
}));

suite('io / PSD font faces name a real file where one exists', async (t) => {
  const problems = [];
  let realFaces = 0;
  for (const id of Object.keys(POSTSCRIPT_FACES)) {
    for (const [weight, style] of [[400, 'normal'], [700, 'normal'], [400, 'italic'], [700, 'italic']]) {
      const face = postScriptFace(id, weight, style);
      const back = familyFromPostScriptName(face.name);
      // `system` is written as Helvetica, so it is deliberately excluded from the
      // reverse table: a Helvetica document was not necessarily authored here.
      if (id === 'system') {
        if (back) problems.push(`system leaked into the reverse table as ${back.font}`);
        continue;
      }
      if (!back) { problems.push(`${id} ${weight}/${style} -> "${face.name}" does not map back`); continue; }
      if (back.font !== id) problems.push(`${id} ${weight}/${style} -> "${face.name}" maps back to ${back.font}`);
      if (face.real) {
        realFaces++;
        if (back.weight !== weight || back.style !== style) {
          problems.push(`${id} ${weight}/${style} -> "${face.name}" maps back to ${back.weight}/${back.style}`);
        }
      }
    }
  }
  t.eq(problems, [], 'every face name we write maps back to its own family, weight and slant');
  t.gt(realFaces, 80, `and most slots resolve to a real face rather than faux styling (${realFaces} of 128)`);

  const bi = postScriptFace('arial', 700, 'italic');
  t.eq(bi.name, 'Arial-BoldItalicMT', 'a family with a real bold-italic file is named, not faked');
  t.eq([bi.fauxBold, bi.fauxItalic], [false, false], 'so neither faux flag is set');

  const noItalic = postScriptFace('tahoma', 400, 'italic');
  t.eq(noItalic.name, 'Tahoma', 'a family with no italic file falls back to its regular');
  t.eq([noItalic.fauxBold, noItalic.fauxItalic], [false, true], 'and asks Photoshop to slant it');

  const threeFace = postScriptFace('tahoma', 700, 'italic');
  t.eq(threeFace.name, 'Tahoma-Bold', 'bold-italic on a three-face family keeps the real bold file');
  t.eq([threeFace.fauxBold, threeFace.fauxItalic], [false, true], 'and fakes only the slant');

  const single = postScriptFace('impact', 700, 'italic');
  t.eq(single.name, 'Impact', 'a single-file family can only offer its one face');
  t.eq([single.fauxBold, single.fauxItalic], [true, true], 'so both axes are faux');

  t.eq(familyFromPostScriptName('Nobody-Ships-This'), null,
    'an unknown face name returns null, leaving the reader its own heuristics');
});

suite('io / PSD type layers survive their font, weight and slant', async (t) => {
  const cases = [
    ['arial', 700, true, 'a real bold-italic face'],
    ['tahoma', 400, true, 'faux italic'],
    ['impact', 700, false, 'faux bold on a single-file family'],
    ['futura', 700, true, 'a three-face family with no bold-italic'],
    ['jetbrains', 400, false, 'a Google family'],
  ];
  const doc = t.doc(240, 170, null, 'faces');
  doc.layers.length = 0;
  cases.forEach(([font, weight, italic], i) => {
    const l = new Layer({
      name: `T${i}`, type: LayerType.TEXT,
      text: { content: 'Ag', font, weight, italic, size: 20, color: '#112233', x: 8, y: 24 + i * 22 },
    });
    l.ensureCanvas(doc.width, doc.height);
    doc.layers.push(l);
    rasterizeTextLayer(l, doc);
  });

  const back = await psdRoundTrip(doc);
  cases.forEach(([font, weight, italic, label], i) => {
    const text = (back.layers.find((l) => l.name === `T${i}`) || {}).text;
    t.ok(text, `layer T${i} came back`);
    if (!text) return;
    t.eq(text.font, font, `${label}: the family survives as ${font}`);
    t.eq(text.weight >= 600, weight >= 600, `${label}: the weight survives`);
    t.eq(!!text.italic, !!italic, `${label}: the slant survives`);
  });
});

suite('io / PSD live shapes keep the parameters a path cannot carry', async (t) => {
  const poly = shapeDoc(t, 'poly', {
    kind: 'shape', subpaths: ringSubpath(45, 45, 32, 7), sides: 7, star: false, innerRadius: 0.5,
    fill: { kind: 'solid', color: '#ff0000' },
    stroke: { enabled: true, color: '#00ff00', width: 4, align: 'center', cap: 'butt', join: 'miter', dash: 'dash-dot' },
  });
  const backPoly = (await psdRoundTrip(poly.doc)).layers[0];
  t.eq(backPoly.shape.sides, 7, 'a seven-sided polygon reopens knowing its side count');
  t.eq(backPoly.shape.star, false, 'and that it is not a star');
  t.eq(backPoly.shape.stroke.dash, 'dash-dot',
    'a named dash preset reopens as the same preset, so it stays editable as one');

  const star = shapeDoc(t, 'star', {
    kind: 'shape', subpaths: ringSubpath(140, 45, 32, 10), sides: 5, star: true, innerRadius: 0.38,
    fill: { kind: 'gradient', stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }], angle: 35, style: 'linear', scale: 1 },
    stroke: { enabled: false, color: '#000000', width: 1, dash: 'solid' },
  });
  const backStar = (await psdRoundTrip(star.doc)).layers[0];
  t.eq(backStar.shape.sides, 5, 'a five-point star reopens with its point count');
  t.eq(backStar.shape.star, true, 'and knows it is a star');
  t.close(backStar.shape.innerRadius, 0.38, 0.01, 'and keeps its indent');
  // Photoshop measures gradient angles the other way round from the renderer
  // behind a shape fill, so the sign is flipped in both directions.
  t.close(backStar.shape.fill.angle, 35, 1e-9, 'a shape gradient angle round trips exactly');

  const line = shapeDoc(t, 'line', {
    kind: 'shape', subpaths: openSubpath([[10, 160], [200, 168]]),
    weight: 6, arrowStart: false, arrowEnd: true, arrowWidth: 500, arrowLength: 1000, concavity: 0,
    fill: { kind: 'solid', color: '#0000ff' },
    stroke: { enabled: true, color: '#0000ff', width: 6, align: 'center', cap: 'round', join: 'round', dash: [9, 4.5] },
  });
  const backLine = (await psdRoundTrip(line.doc)).layers[0];
  t.close(backLine.shape.weight, 6, 1e-9, 'a line reopens with its weight');
  t.eq([backLine.shape.arrowStart, backLine.shape.arrowEnd], [false, true],
    'and with exactly the arrowhead it had — a plain end must not grow one');
  t.ok(Array.isArray(backLine.shape.stroke.dash), 'an explicit dash array stays an array');
  t.close(backLine.shape.stroke.dash[0], 9, 1e-3, 'with its dash length in document units');
  t.close(backLine.shape.stroke.dash[1], 4.5, 1e-3, 'and its gap');

  // A plain rectangle must not acquire any of the above.
  const rect = shapeDoc(t, 'rect', {
    kind: 'shape', subpaths: closedSubpath([[20, 20], [80, 20], [80, 60], [20, 60]]),
    fill: { kind: 'solid', color: '#888888' },
    stroke: { enabled: false, color: '#000000', width: 1, dash: 'solid' },
  });
  const backRect = (await psdRoundTrip(rect.doc)).layers[0];
  t.eq(backRect.shape.sides, undefined, 'a plain rectangle gains no side count');
  t.eq(backRect.shape.weight, undefined, 'no line weight');
  t.eq(backRect.shape.arrowEnd, undefined, 'no arrowheads');
  t.eq(backRect.shape.stroke.dash, 'solid', 'and a solid stroke stays solid');

  // Rounded-rectangle radii are the one origination field that predates all of
  // the above; it must still work.
  const rrect = shapeDoc(t, 'rrect', {
    kind: 'shape', subpaths: closedSubpath([[20, 20], [80, 20], [80, 60], [20, 60]]),
    corners: [8, 8, 8, 8], radius: 8,
    fill: { kind: 'solid', color: '#22cc99' },
    stroke: { enabled: false, color: '#000000', width: 1, dash: 'solid' },
  });
  const backRR = (await psdRoundTrip(rrect.doc)).layers[0];
  t.eq(backRR.shape.corners, [8, 8, 8, 8], 'four equal corner radii come back');
  t.eq(backRR.shape.radius, 8, 'and collapse to the single value the tool edits');
});

suite('io / PSD write -> read -> write is byte-identical', async (t) => {
  const doc = t.doc(220, 180, null, 'stability');
  doc.layers.length = 0;
  const addShape = (name, shape) => {
    const l = new Layer({ name, type: LayerType.SHAPE, shape });
    l.canvas = rasterizeShapeLayer(l, doc);
    doc.layers.push(l);
  };
  const addText = (name, text) => {
    const l = new Layer({ name, type: LayerType.TEXT, text });
    l.ensureCanvas(doc.width, doc.height);
    doc.layers.push(l);
    rasterizeTextLayer(l, doc);
  };

  addShape('poly', {
    kind: 'shape', subpaths: ringSubpath(45, 45, 32, 7), sides: 7, star: false, innerRadius: 0.5,
    fill: { kind: 'solid', color: '#ff0000' },
    stroke: { enabled: true, color: '#00ff00', width: 4, align: 'center', cap: 'butt', join: 'miter', dash: 'dash-dot' },
  });
  addShape('star', {
    kind: 'shape', subpaths: ringSubpath(150, 45, 32, 10), sides: 5, star: true, innerRadius: 0.38,
    fill: { kind: 'gradient', stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }], angle: 35, style: 'linear', scale: 1 },
    stroke: { enabled: false, color: '#000000', width: 1, dash: 'solid' },
  });
  addShape('line', {
    kind: 'shape', subpaths: openSubpath([[10, 160], [200, 168]]),
    weight: 6, arrowStart: false, arrowEnd: true, arrowWidth: 500, arrowLength: 1000, concavity: 0,
    fill: { kind: 'solid', color: '#0000ff' },
    stroke: { enabled: true, color: '#0000ff', width: 6, align: 'center', cap: 'round', join: 'round', dash: [9, 4.5] },
  });
  addText('plain', { content: 'Ag', font: 'arial', weight: 700, italic: true, size: 22, color: '#112233', x: 10, y: 110 });
  addText('bent', {
    content: 'Wavy', font: 'georgia', weight: 400, size: 20, color: '#8844aa', x: 60, y: 130,
    warp: { style: 'wave', bend: 0.55, h: -0.2, v: 0.1 },
  });
  doc.layers.push(createAdjustmentLayer('curves', {
    channel: 'rgb', points: [{ x: 0, y: 0 }, { x: 0.4, y: 0.62 }, { x: 1, y: 1 }],
  }, doc.width, doc.height, 'curves'));
  doc.invalidate();

  // Precondition: every layer with pixels actually has some, or the comparisons
  // below would be comparing empty buffers and passing for the wrong reason.
  for (const l of doc.layers) {
    if (l.canvas) t.gt(t.inked(l.canvas), 50, `layer "${l.name}" has real pixels before the round trip`);
  }

  const first = await psdBytes(doc);
  const reopened = await readPSD(first.buffer.slice(0));
  const second = await psdBytes(reopened);
  t.eq(firstByteDiff(first, second), null,
    `saving, reopening and saving again produces the same ${first.length} bytes`);

  const twice = await psdBytes(await readPSD(second.buffer.slice(0)));
  t.eq(firstByteDiff(second, twice), null, 'and it stays identical on a second round trip');

  t.eq(reopened.layers.length, doc.layers.length, 'the layer count survives');
  for (const l of doc.layers) {
    if (!l.canvas) continue;
    const other = reopened.layers.find((x) => x.name === l.name);
    t.ok(other && other.canvas, `layer "${l.name}" came back with a canvas`);
    if (other && other.canvas) {
      t.eq(t.mad(t.bytes(l.canvas), t.bytes(other.canvas)), 0,
        `layer "${l.name}" reopens pixel-for-pixel identical`);
    }
  }

  // The two bugs this suite exists to catch.
  t.eq(reopened.layers.find((l) => l.name === 'plain').text.warp, undefined,
    'a plain type layer does not come back carrying an inert warp');
  const warp = reopened.layers.find((l) => l.name === 'bent').text.warp;
  t.eq(warp.style, 'wave', 'while a real warp keeps its style');
  t.close(warp.bend, 0.55, 1e-9, 'its bend');
  t.close(warp.h, -0.2, 1e-9, 'its horizontal distortion');
  t.close(warp.v, 0.1, 1e-9, 'and its vertical distortion');
});

/* ------------------------------------------------------------------ */
/* PSD import cost                                                     */
/* ------------------------------------------------------------------ */

/**
 * What a PSD costs to open.
 *
 * Pikado keeps every layer buffer at document size, so a file's memory cost has
 * almost nothing to do with its size on disk and everything to do with layer
 * count times canvas area. Measured before this was addressed: a 0.3 MB file
 * with 24 small layers on a 1600x1200 canvas allocated 176 MB, and 40 layers
 * with no pixels at all — 8 bytes each in the file — allocated 165 MB of
 * provably transparent canvas.
 */
suite('io / a PSD full of empty layers does not allocate a canvas for each', async (t) => {
  const { writePSD } = await import('/src/io/psd-write.js');
  const { readPSD, projectedLayerBytes } = await import('/src/io/psd-read.js');
  const { createRasterLayer } = await import('/src/core/layer.js');

  const W = 400, H = 300, N = 16;
  const src = t.doc(W, H, '#ffffff', 'empties');
  for (let i = 0; i < N; i += 1) src.layers.unshift(createRasterLayer(W, H, `empty ${i}`));

  const buf = await (await writePSD(src)).arrayBuffer();
  const doc = await readPSD(buf);

  const layers = doc.flatLayers();
  const distinct = new Set(layers.map((l) => l.canvas).filter(Boolean));
  t.gt(layers.length, N, 'every layer came back');
  /*
   * The pixel-less layers share one blank canvas. Safe because Layer.beginEdit()
   * clones unconditionally before any write, so a layer stops sharing the moment
   * it is painted on. Verified to fail by restoring
   * `canvas || createCanvas(doc.width, doc.height)`: distinct rises to 17.
   */
  t.lt(distinct.size, 4, `pixel-less layers share a blank (${distinct.size} distinct canvases for ${layers.length} layers)`);
  t.lt(doc.memoryUse(), projectedLayerBytes(N, W, H) / 3,
    'so the document costs a fraction of the naive per-layer figure');
});

suite('io / sharing a blank canvas cannot leak one layer\'s paint into another', async (t) => {
  const { writePSD } = await import('/src/io/psd-write.js');
  const { readPSD } = await import('/src/io/psd-read.js');
  const { createRasterLayer } = await import('/src/core/layer.js');

  const W = 200, H = 150;
  const src = t.doc(W, H, '#ffffff', 'share');
  for (let i = 0; i < 3; i += 1) src.layers.unshift(createRasterLayer(W, H, `empty ${i}`));
  const doc = await readPSD(await (await writePSD(src)).arrayBuffer());

  const empties = doc.flatLayers().filter((l) => /^empty/.test(l.name));
  t.gt(empties.length, 1, 'there are several empty layers to share between');
  const before = empties[0].canvas;
  t.is(empties[1].canvas, before, 'they do start out sharing one buffer');

  // Painting on one must not touch the others — this is the whole safety
  // argument for sharing. Verified to fail by removing the cloneCanvas from
  // Layer.beginEdit(): the fill shows up on every empty layer at once.
  doc.beginEdit(empties[0]);
  const c = empties[0].canvas.getContext('2d');
  c.fillStyle = '#ff0000';
  c.fillRect(0, 0, W, H);
  doc.commit('paint one');

  t.ok(empties[0].canvas !== empties[1].canvas, 'editing one gives it a private buffer');
  t.pixel(empties[1].canvas, 10, 10, '0,0,0,0', 'and leaves its neighbour untouched');
});

suite('io / an oversized PSD is offered flattened rather than opened blindly', async (t) => {
  const { writePSD } = await import('/src/io/psd-write.js');
  const { readPSD, projectedLayerBytes } = await import('/src/io/psd-read.js');
  const { createRasterLayer } = await import('/src/core/layer.js');

  const W = 300, H = 200, N = 8;
  const src = t.doc(W, H, '#ffffff', 'big');
  for (let i = 0; i < N; i += 1) {
    const l = createRasterLayer(W, H, `l${i}`);
    const c = l.canvas.getContext('2d');
    c.fillStyle = `hsl(${i * 40} 70% 50%)`;
    c.fillRect(i * 20, i * 12, 60, 60);
    src.layers.unshift(l);
  }
  const buf = await (await writePSD(src)).arrayBuffer();

  t.gt(projectedLayerBytes(N, W, H), N * W * H * 4, 'the projection includes a mask allowance');

  // With no handler the import proceeds exactly as it always did, which is what
  // keeps every existing caller and every other test in this file honest.
  const asBefore = await readPSD(buf);
  t.gt(asBefore.flatLayers().length, N, 'no handler means no change in behaviour');

  // A handler that says "flatten" gets one layer and the picture intact.
  let asked = null;
  const flat = await readPSD(buf, {
    budgetBytes: 1,
    onOversize: (info) => { asked = info; return 'flatten'; },
  });
  t.ok(asked, 'the handler was consulted');
  t.gt(asked.layers, N - 1, `and told how many layers there are (${asked.layers})`);
  t.gt(asked.projectedBytes, asked.budgetBytes, 'and by how much the budget is blown');
  t.eq(flat.flatLayers().length, 1, 'flattening gives exactly one layer');
  t.gt(t.inked(flat.layers[0].canvas), 0, 'and it is not blank — the picture survived');

  // Cancelling must not half-open anything.
  let threw = false;
  try { await readPSD(buf, { budgetBytes: 1, onOversize: () => 'cancel' }); } catch { threw = true; }
  t.ok(threw, 'cancelling refuses rather than returning a broken document');
});

suite('io / memoryUse counts what is really held', async (t) => {
  /*
   * Counted per distinct buffer, not per layer. Sharing means the per-layer sum
   * overstates: a 41-layer import reported 300 MB when 161 MB was held.
   * Verified to fail by summing per layer again.
   */
  const { createRasterLayer } = await import('/src/core/layer.js');
  const doc = t.doc(100, 100, '#ffffff', 'mem');
  const base = doc.memoryUse();

  const a = createRasterLayer(100, 100, 'a');
  const b = createRasterLayer(100, 100, 'b');
  b.canvas = a.canvas;                      // deliberately sharing
  doc.layers.unshift(a);
  doc.layers.unshift(b);

  t.eq(doc.memoryUse(), base + 100 * 100 * 4, 'a shared buffer is counted once, not twice');
});
