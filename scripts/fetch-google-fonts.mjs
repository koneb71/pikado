#!/usr/bin/env node
/**
 * Regenerate the bundled Google Fonts catalogue.
 *
 *     node scripts/fetch-google-fonts.mjs
 *
 * Run by hand; the output is committed. That keeps the build hermetic and
 * offline, and makes a catalogue change a reviewable diff rather than something
 * that silently differs between two people's builds.
 *
 * **Why a build step at all.** There is no way to enumerate Google Fonts from
 * the browser: `fonts.google.com/metadata/fonts` sends no CORS headers, and
 * `googleapis.com/webfonts/v1` answers 403 without an API key — and a key in a
 * client-side bundle is not a key, it is a published credential. The metadata
 * endpoint has no such objection from Node, where CORS does not apply, so the
 * list is fetched here and shipped as data.
 *
 * The response is ~2.7 MB and carries far more than Pikado needs (designers,
 * dates, popularity ranks, per-axis detail). It distils to about 67 KB, which
 * gzips to 15 KB — small enough to lazy-load as its own chunk.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SOURCE = 'https://fonts.google.com/metadata/fonts';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'text', 'google-catalog.data.js');

/** Kept in the order the data file's `catIdx` refers to. */
const CATEGORIES = ['sans-serif', 'serif', 'display', 'handwriting', 'monospace'];
const CATEGORY_OF = {
  'Sans Serif': 0, Serif: 1, Display: 2, Handwriting: 3, Monospace: 4,
};

async function main() {
  process.stdout.write(`fetching ${SOURCE}\n`);
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`${SOURCE} answered ${res.status}`);
  // Google prefixes the body with an XSSI guard that is not valid JSON.
  const raw = (await res.text()).replace(/^\)\]\}'?\n?/, '');
  const list = JSON.parse(raw).familyMetadataList;
  if (!Array.isArray(list) || !list.length) throw new Error('no familyMetadataList in the response');

  // Popularity order, because it is what makes a 1,900-row list usable: the
  // families anyone is looking for are in the first screenful.
  const ordered = [...list].sort((a, b) => (a.popularity || 1e9) - (b.popularity || 1e9));

  const rows = [];
  const warnings = [];
  for (const f of ordered) {
    const cat = CATEGORY_OF[f.category];
    if (cat === undefined) { warnings.push(`unknown category ${f.category} on ${f.family}`); continue; }
    if (f.family.includes('|')) { warnings.push(`skipped ${f.family}: name contains the field separator`); continue; }

    const keys = Object.keys(f.fonts || {});
    const upright = [...new Set(keys.filter((k) => !k.endsWith('i')).map(Number))].sort((a, b) => a - b);
    if (!upright.length) { warnings.push(`skipped ${f.family}: no upright weights`); continue; }
    const italic = keys.some((k) => k.endsWith('i')) ? 1 : 0;

    /*
     * A `wght` axis means css2 accepts a `min..max` range; without one, every
     * weight has to be listed exactly or the request fails outright. The two
     * are recorded separately because that distinction is the whole of the bug
     * this catalogue exists to fix.
     */
    const wght = (f.axes || []).find((a) => a.tag === 'wght');
    const variable = wght ? 1 : 0;
    if (wght && (wght.min !== upright[0] || wght.max !== upright[upright.length - 1])) {
      // The URL builder derives the range from the weight list, so flag any
      // family where that assumption does not hold rather than shipping a
      // request that 400s.
      warnings.push(`${f.family}: axis ${wght.min}..${wght.max} but weights ${upright[0]}..${upright[upright.length - 1]}`);
    }
    rows.push(`${f.family}|${cat}|${upright.join(',')}|${italic}|${variable}`);
  }

  const body = `/**
 * Google Fonts catalogue — GENERATED, do not edit.
 *
 * Regenerate with \`node scripts/fetch-google-fonts.mjs\`. One family per line
 * so a refresh reads as a per-family diff:
 *
 *     family | categoryIndex | upright weights | hasItalic | isVariable
 *
 * Popularity-ordered. \`isVariable\` decides whether a css2 request may use a
 * \`wght@min..max\` range or must list every weight — asking a static family for
 * a weight it does not have is a hard failure, not a fallback.
 */

export const GENERATED = '${new Date().toISOString().slice(0, 10)}';
export const CATEGORIES = ${JSON.stringify(CATEGORIES)};

export default \`${rows.join('\n')}\`;
`;

  writeFileSync(OUT, body);
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  process.stdout.write(`wrote ${rows.length} families to ${OUT} (${kb(body.length)})\n`);
  if (warnings.length) {
    process.stdout.write(`\n${warnings.length} warning(s):\n${warnings.map((w) => `  ${w}`).join('\n')}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
