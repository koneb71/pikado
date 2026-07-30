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
