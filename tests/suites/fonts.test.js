import { suite } from '../harness.js';
import {
  normalizeFontId, googleFamilyOf, googleNameFor, css2Url, fontStack, fontFamilyOptions,
  postScriptFace, GOOGLE_PREFIX,
} from '/src/text/fonts.js';
import { isLatinRange, parseFontFaces } from '/src/text/font-manager.js';
import { loadCatalog, findFamily, searchFamilies, catalogSize } from '/src/text/font-catalog.js';

/**
 * Fonts.
 *
 * Nothing here touches the network. The css2 request shape is asserted against
 * the URL builder rather than against Google, and parsing is asserted against a
 * captured stylesheet — which is the only way to test the case that matters,
 * since the failure it guards is a 5 MB download nobody would run in a suite.
 */

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

suite('fonts / one id per family, whatever dialect wrote it', async (t) => {
  /*
   * Three dialects have historically ended up in `layer.text.font`: the ids the
   * Type tool writes, the display names and raw CSS families the Character
   * panel wrote, and `google:` names. They have to land on one value or a layer
   * renders through the fallback stack and exports to PSD with the wrong face.
   * Verified to fail by returning the input unchanged.
   */
  t.eq(normalizeFontId('arial'), 'arial', 'an id is already canonical');
  t.eq(normalizeFontId('Arial'), 'arial', 'a display name resolves to its id');
  t.eq(normalizeFontId('Playfair Display'), 'playfair', 'including a multi-word one');
  t.eq(normalizeFontId('sans-serif'), 'system', 'a generic CSS family is not a font');
  t.eq(normalizeFontId('serif'), 'times', 'nor is this one');
  t.eq(normalizeFontId('monospace'), 'mono', 'nor this');

  /*
   * A built-in beats a download. Without this the pickers list Roboto twice and
   * PSD export loses its real PostScript faces.
   * Verified to fail by dropping the google-name aliases from the table.
   */
  t.eq(normalizeFontId('google:Roboto'), 'roboto', 'a google id for a built-in collapses to the built-in');
  t.eq(normalizeFontId('google:Pacifico'), 'pacifico', 'and so does this one');

  t.eq(normalizeFontId('google:Zilla Slab'), 'google:Zilla Slab', 'a family we do not bundle keeps its google id');
  t.eq(normalizeFontId('Some Unknown Face'), 'Some Unknown Face',
    'and an unrecognised name is left alone rather than invented away');
  t.eq(normalizeFontId(''), 'system', 'nothing at all is the system stack');

  t.eq(googleFamilyOf('google:Zilla Slab'), 'Zilla Slab', 'the family name comes back out of the id');
  t.eq(googleFamilyOf('arial'), '', 'and a built-in id has none');

  /*
   * The awkward one: `normalizeFontId` collapses google:Pacifico to `pacifico`,
   * which loses the name the font is stored and registered under. Anything
   * asking "which downloaded family is this?" has to come through googleNameFor.
   * Verified to fail by having googleNameFor defer to googleFamilyOf alone —
   * every built-in Google family then reads as not installed.
   */
  t.eq(googleNameFor('pacifico'), 'Pacifico', 'a built-in still knows its Google name');
  t.eq(googleNameFor('google:Zilla Slab'), 'Zilla Slab', 'as does a downloaded family');
  t.eq(googleNameFor('arial'), '', 'and a system family has none');
});

suite('fonts / a stack always resolves, and substitutes in kind', async (t) => {
  t.ok(fontStack('playfair').includes('Playfair Display'), 'a built-in gets its own stack');
  t.ok(fontStack('Playfair Display').includes('Playfair Display'), 'reached by name too');

  const zilla = fontStack('google:Zilla Slab');
  t.ok(zilla.startsWith('"Zilla Slab"'), 'a downloaded family leads its own stack');

  /*
   * A missing download should fall back to something of the right shape — a
   * serif standing in for a serif — rather than to sans every time.
   * Verified to fail by ignoring the category argument.
   */
  t.ok(fontStack('google:Zilla Slab', 'serif').includes('serif'), 'a serif substitutes with a serif');
  t.ok(fontStack('google:Rock Salt', 'handwriting').includes('cursive'), 'and handwriting with a cursive');
  t.ok(fontStack('').length > 0, 'nothing at all still yields a usable stack');
});

suite('fonts / the picker list covers what the layer actually uses', async (t) => {
  const plain = fontFamilyOptions();
  t.ok(plain.length >= 30, 'the built-ins are all there');

  const withDownload = fontFamilyOptions('', [{ id: 'google:Zilla Slab', name: 'Zilla Slab' }]);
  t.eq(withDownload.length, plain.length + 1, 'a downloaded family is appended');

  /*
   * A layer can carry a family the list has never had — one not yet downloaded,
   * or named by a PSD. A `select` cannot display a value it has no option for,
   * so it silently showed the wrong family instead.
   * Verified to fail by dropping the `current` shim.
   */
  const unknown = fontFamilyOptions('google:Never Heard Of It');
  t.eq(unknown[0].value, 'google:Never Heard Of It', "the layer's own family leads the list");
  t.eq(unknown[0].label, 'Never Heard Of It', 'labelled by name, not by its id');

  const known = fontFamilyOptions('arial');
  t.eq(known.length, plain.length, 'and a family already in the list is not doubled');
});

/* ------------------------------------------------------------------ */
/* The request shape — the ten broken families                         */
/* ------------------------------------------------------------------ */

suite('fonts / a css2 request asks only for weights the family has', async (t) => {
  // `+` is the space in a css2 family name, and decodeURIComponent leaves it
  // alone — so undo it here rather than writing `+` into every expectation.
  const spec = (u) => decodeURIComponent(u.slice(u.indexOf('family=') + 7, u.indexOf('&display'))).replace(/\+/g, ' ');

  /*
   * The bug this whole feature grew out of. The old code posted
   * `wght@0,100..900;1,100..900` for every family, and a weight range a family
   * does not offer is a hard failure — ten of the fourteen bundled Google
   * families never loaded, silently.
   * Verified to fail by restoring that hardcoded range: Pacifico, Lato and
   * Open Sans all stop matching.
   */
  t.eq(spec(css2Url([{ family: 'Pacifico', weights: [400], italic: false, variable: false }])),
    'Pacifico', 'a single-weight static family asks for no axis at all');

  t.eq(spec(css2Url([{ family: 'Lato', weights: [100, 300, 400, 700, 900], italic: true, variable: false }])),
    'Lato:ital,wght@0,100;0,300;0,400;0,700;0,900;1,100;1,300;1,400;1,700;1,900',
    'a static family lists every weight it has, and no others');

  t.eq(spec(css2Url([{ family: 'Open Sans', weights: [300, 400, 500, 600, 700, 800], italic: true, variable: true }])),
    'Open Sans:ital,wght@0,300..800;1,300..800',
    'a variable family gets its own range — not 100..900');

  t.eq(spec(css2Url([{ family: 'Oswald', weights: [200, 300, 400, 500, 600, 700], italic: false, variable: true }])),
    'Oswald:wght@200..700', 'and one with no italics does not ask for any');

  const many = css2Url([
    { family: 'Roboto', weights: [400], italic: false, variable: false },
    { family: 'Lato', weights: [400], italic: false, variable: false },
  ]);
  t.eq((many.match(/family=/g) || []).length, 2, 'several families ride in one request');
  t.ok(css2Url([{ family: 'Inter', weights: [400] }], { text: 'Ag' }).includes('&text=Ag'),
    'and a preview can ask for just the glyphs it shows');
  t.eq(css2Url([]), '', 'nothing asked for is no request');
});

/* ------------------------------------------------------------------ */
/* Parsing and subsetting                                              */
/* ------------------------------------------------------------------ */

/** A captured css2 response, trimmed to the shapes that matter. */
const CSS_FIXTURE = `
/* cyrillic-ext */
@font-face {
  font-family: 'Test Family';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/x/cyrillic-ext.woff2) format('woff2');
  unicode-range: U+0460-052F, U+1C80-1C88, U+20B4, U+2DE0-2DFF, U+A640-A69F;
}
/* greek */
@font-face {
  font-family: 'Test Family';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/x/greek.woff2) format('woff2');
  unicode-range: U+0370-03FF;
}
/* latin-ext */
@font-face {
  font-family: 'Test Family';
  font-style: italic;
  font-weight: 700;
  src: url(https://fonts.gstatic.com/s/x/latin-ext.woff2) format('woff2');
  unicode-range: U+0100-02AF, U+0304, U+0308, U+0329, U+1E00-1E9F, U+2020, U+20A0-20AB;
}
/* latin */
@font-face {
  font-family: 'Test Family';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/x/latin.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+2000-206F, U+2074;
}
`;

suite('fonts / only the Latin faces are downloaded', async (t) => {
  const faces = parseFontFaces(CSS_FIXTURE);
  t.eq(faces.length, 4, 'every face block is read');
  t.eq(faces[2].style, 'italic', 'the style comes off the block');
  t.eq(faces[2].weight, 700, 'and so does the weight');
  t.ok(faces[3].url.endsWith('latin.woff2'), 'with the woff2 url');

  /*
   * Noto Sans JP is 124 blocks and about 5 MB for one weight, of which exactly
   * one block is Latin. Without this filter, downloading a CJK family from the
   * browser would pull the lot.
   * Verified to fail by having isLatinRange return true unconditionally: the
   * Cyrillic and Greek faces come back too.
   */
  const latin = faces.filter((f) => isLatinRange(f.unicodeRange));
  t.eq(latin.length, 2, 'the Cyrillic and Greek subsets are left behind');
  t.ok(latin.every((f) => /latin/.test(f.url)), 'and what is kept is the Latin pair');

  t.notOk(isLatinRange('U+0460-052F'), 'Cyrillic alone is not Latin');
  t.notOk(isLatinRange('U+0370-03FF'), 'nor is Greek');
  t.ok(isLatinRange('U+0000-00FF'), 'basic Latin is');
  t.ok(isLatinRange(''), 'and a face with no range covers everything, so it stays');

  t.eq(parseFontFaces('').length, 0, 'an empty stylesheet yields nothing rather than throwing');
  t.eq(parseFontFaces('@font-face { font-family: x; }').length, 0, 'as does one with no src');
});

/* ------------------------------------------------------------------ */
/* The catalogue                                                       */
/* ------------------------------------------------------------------ */

suite('fonts / the bundled catalogue answers without a network', async (t) => {
  await loadCatalog();
  t.ok(catalogSize() > 1500, `the catalogue has ${catalogSize()} families`);

  const roboto = findFamily('Roboto');
  t.ok(roboto, 'a family is found by name');
  t.eq(roboto.category, 'sans-serif', 'with its category');
  t.ok(roboto.variable, 'and whether it is variable, which decides the request shape');
  t.ok(findFamily('roboto'), 'lookup is case-insensitive');
  t.eq(findFamily('No Such Family Here'), null, 'and an unknown name is null, not a guess');

  const pac = findFamily('Pacifico');
  t.eq(pac.weights.join(','), '400', 'a static single-weight family reports exactly that');
  t.notOk(pac.variable, 'and is not variable');

  /*
   * Prefix matches sort ahead of mid-word ones — the only ranking that earns
   * its keep, since typing "rob" should reach Roboto before Rock Salt.
   * Verified to fail by concatenating the two buckets the other way round.
   */
  /*
   * "sla" is chosen because both buckets are non-empty — Slabo 27px starts with
   * it, Roboto Slab merely contains it. A query with only prefix matches cannot
   * tell the two orderings apart, which is the whole point of the assertion.
   */
  const hits = searchFamilies({ q: 'sla' });
  t.ok(hits.length > 4, 'search finds something');
  t.ok(hits[0].family.toLowerCase().startsWith('sla'), `a prefix match leads (${hits[0].family})`);
  const mid = hits.findIndex((e) => !e.family.toLowerCase().startsWith('sla'));
  t.ok(mid > 0, 'a mid-word match is still found');
  t.ok(hits.slice(mid).every((e) => !e.family.toLowerCase().startsWith('sla')),
    'and once the mid-word matches start, no prefix match follows');

  const serifs = searchFamilies({ q: '', category: 'serif', limit: 10 });
  t.ok(serifs.length > 0 && serifs.every((e) => e.category === 'serif'), 'category filtering holds');
});

/* ------------------------------------------------------------------ */
/* PSD faces                                                           */
/* ------------------------------------------------------------------ */

suite('fonts / a PSD face is only claimed when the family has it', async (t) => {
  const builtin = postScriptFace('playfair', 700, 'normal');
  t.ok(builtin.name && !builtin.name.startsWith('google'), 'a built-in keeps its own face table');

  /*
   * `google:Playfair Display` used to strip to `googlePlayfairDisplay`, which
   * is not a PostScript name anything could resolve. Photoshop answers an
   * unresolvable name by substituting a different family outright, so claiming
   * a face we cannot back is worse than faux styling.
   * Verified to fail by claiming `-Bold` unconditionally.
   */
  const noCaps = postScriptFace('google:Zilla Slab', 700, 'italic');
  t.eq(noCaps.name, 'ZillaSlab-Regular', 'with no capabilities known, only Regular is claimed');
  t.ok(noCaps.fauxBold && noCaps.fauxItalic, 'and the rest is reported as faux');
  t.notOk(noCaps.real, 'which is not a real face');

  const caps = { weights: [400, 700], italics: [400, 700] };
  const bold = postScriptFace('google:Zilla Slab', 700, 'normal', caps);
  t.eq(bold.name, 'ZillaSlab-Bold', 'a confirmed bold is claimed');
  t.notOk(bold.fauxBold, 'and is not faux');

  const bi = postScriptFace('google:Zilla Slab', 700, 'italic', caps);
  t.eq(bi.name, 'ZillaSlab-BoldItalic', 'as is bold italic');

  const noItalic = postScriptFace('google:Zilla Slab', 400, 'italic', { weights: [400], italics: [] });
  t.eq(noItalic.name, 'ZillaSlab-Regular', 'a family with no italic file is not given one');
  t.ok(noItalic.fauxItalic, 'it is slanted instead');
});

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

suite('fonts / a project file names its fonts and carries none of them', async (t) => {
  const { Layer, LayerType } = await import('/src/core/layer.js');
  const { savePKD, loadPKD } = await import('/src/io/pkd.js');
  const { fontTableFor, fontsUsedBy } = await import('/src/text/font-table.js');
  await import('/src/text/font-manager.js');   // registers the capability provider
  await loadCatalog();

  const doc = t.doc(300, 160, '#ffffff', 'fonttable');
  const add = (name, font) => {
    const l = new Layer({ type: LayerType.TEXT, name });
    l.text = { content: 'Hg', font, size: 30, weight: 400, x: 10, y: 40 };
    doc.addLayer(l, { above: doc.layers[0] });
    return l;
  };
  add('serif-head', 'google:Zilla Slab');
  add('plain', 'arial');

  const used = [...fontsUsedBy(doc)];
  t.ok(used.includes('google:Zilla Slab') && used.includes('arial'), 'both families are found');

  const table = fontTableFor(doc);
  t.eq(table.length, 1, 'only the family that has to travel is listed');
  t.eq(table[0].family, 'Zilla Slab', 'named by its Google name');
  /*
   * The category is what lets a missing serif substitute with a serif rather
   * than with whatever sans is nearest — so it has to be in the file, since
   * offline there is nothing else that knows.
   * Verified to fail by dropping the catalogue fallback from the capability
   * provider: the category comes back empty.
   */
  t.eq(table[0].category, 'serif', 'and remembered as a serif');
  t.ok(table[0].weights.length > 0, 'with the weights it offers, so a PSD export stays honest');

  const bytes = await (await savePKD(doc)).arrayBuffer();
  const whole = new TextDecoder('latin1').decode(new Uint8Array(bytes));
  /*
   * A reference, never the font. Bytes in a .pkd would make a project file a
   * redistribution vector for something the author may have no right to pass
   * on. Verified to fail by writing the faces into the manifest.
   */
  t.notOk(/wOFF|wOF2|fonts\.gstatic\.com/.test(whole), 'no font file rides along');

  const reopened = await loadPKD(bytes);
  t.eq(reopened.fontTable.length, 1, 'the table survives the round trip');
  t.eq(reopened.fontTable[0].category, 'serif', 'category and all');
  t.eq(reopened.flatLayers().find((l) => l.name === 'serif-head').text.font, 'google:Zilla Slab',
    "and the layer's own font is untouched");
});

suite('fonts / a font that cannot be had substitutes rather than rewriting the layer', async (t) => {
  const { Layer, LayerType } = await import('/src/core/layer.js');
  const fm = await import('/src/text/font-manager.js');
  const { fontStack } = await import('/src/text/fonts.js');

  const doc = t.doc(300, 160, '#ffffff', 'missingfont');
  const l = new Layer({ type: LayerType.TEXT, name: 'h' });
  l.text = { content: 'Hg', font: 'google:Definitely Not A Real Family', size: 30, weight: 400, x: 10, y: 40 };
  doc.addLayer(l, { above: doc.layers[0] });
  doc.fontTable = [{ id: 'google:Definitely Not A Real Family', family: 'Definitely Not A Real Family', category: 'serif', weights: [400], italics: [] }];

  const missing = await fm.ensureDocumentFonts(doc);
  t.eq(missing.length, 1, 'the family is reported missing');
  t.eq(missing[0].family, 'Definitely Not A Real Family', 'by name, so the warning can say which');
  t.eq(doc.missingFonts.length, 1, 'and recorded on the document rather than only toasted');

  /*
   * The layer is left alone on purpose. Rewriting `layer.text.font` to the
   * substitute would make the document permanently wrong — a save would bake
   * the substitution in, and the file would not heal when the font arrived.
   * Verified to fail by assigning the fallback id onto the layer.
   */
  t.eq(l.text.font, 'google:Definitely Not A Real Family', 'the layer still names what it wants');

  // And the file's own table is what makes the substitute the right shape.
  const cat = fm.documentFontCategory(doc, 'google:Definitely Not A Real Family');
  t.eq(cat, 'serif', 'the category comes from the file when the font cannot be had');
  t.ok(fontStack('google:Definitely Not A Real Family', cat).includes('serif'),
    'so a missing serif is replaced by a serif');
});
