#!/usr/bin/env node
/**
 * The translator's tool.
 *
 *   node scripts/i18n.mjs                      coverage of every language
 *   node scripts/i18n.mjs missing <tag>        what is still English, and where it is used
 *   node scripts/i18n.mjs missing <tag> --json the same, as a JSON object to fill in
 *   node scripts/i18n.mjs sync <tag>|--all     tidy a catalogue: source order, stale keys dropped
 *   node scripts/i18n.mjs sync <tag> --fill    …and add every missing key with an empty value
 *   node scripts/i18n.mjs check                fail on stale keys, placeholder or plural mistakes
 *   node scripts/i18n.mjs strings [--json]     every source string, for starting a new language
 *
 * Catalogues live in src/locales/<tag>.json. An empty value means "not yet
 * translated" and falls back to English, so a half-done file is safe to ship.
 * See CONTRIBUTING.md, "Translating Pikado".
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract, audit, hasTranslation, isLive } from './i18n-extract.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const LOCALES = join(SRC, 'locales');
/** Generated data, not interface text: the Google Fonts catalogue is 60 KB of family names. */
const SKIP = new Set([
  'src/text/google-catalog.data.js',
  // The engine: its only strings are language names, which are never translated.
  'src/core/i18n.js',
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

export function sourceFiles() {
  return walk(SRC)
    .map((p) => relative(ROOT, p).split('\\').join('/'))
    .filter((p) => !SKIP.has(p) && !p.startsWith('src/locales/'))
    .map((path) => ({ path, source: readFileSync(join(ROOT, path), 'utf8') }));
}

function catalogueTags() {
  if (!existsSync(LOCALES)) return [];
  return readdirSync(LOCALES).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
}

function readCatalogue(tag) {
  const p = join(LOCALES, `${tag}.json`);
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, 'utf8'));
}

function writeCatalogue(tag, obj) {
  writeFileSync(join(LOCALES, `${tag}.json`), `${JSON.stringify(obj, null, 2)}\n`);
}

function emptyEntry(entry, tag) {
  if (!entry.plural) return '';
  const cats = new Intl.PluralRules(tag).resolvedOptions().pluralCategories;
  return Object.fromEntries(cats.map((c) => [c, '']));
}

const [cmd = 'status', ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const args = rest.filter((a) => !a.startsWith('--'));
const source = extract(sourceFiles());

if (source.problems.length && (cmd === 'status' || cmd === 'check')) {
  console.log('Source problems:');
  for (const p of source.problems) console.log(`  ${p.location}  ${p.message}`);
  console.log('');
}

switch (cmd) {
  case 'status': {
    console.log(`${source.strings.size} interface strings in src/\n`);
    for (const tag of catalogueTags()) {
      const a = audit(readCatalogue(tag), source, tag);
      const pct = ((100 * (a.total - a.missing.length)) / a.total).toFixed(1);
      const issues = [a.stale.length && `${a.stale.length} stale`, a.badPlaceholders.length && `${a.badPlaceholders.length} placeholder`, a.badPlurals.length && `${a.badPlurals.length} plural`].filter(Boolean);
      console.log(`  ${tag.padEnd(8)} ${pct.padStart(5)}%  ${String(a.missing.length).padStart(5)} missing${issues.length ? `  — ${issues.join(', ')} problems (run check)` : ''}`);
    }
    break;
  }

  case 'missing': {
    const tag = args[0];
    if (!tag) { console.error('usage: missing <tag> [--json]'); process.exit(2); }
    const cat = readCatalogue(tag);
    const todo = [...source.strings].filter(([s]) => !hasTranslation(cat, s));
    if (flags.has('--json')) {
      console.log(JSON.stringify(Object.fromEntries(todo.map(([s, e]) => [s, emptyEntry(e, tag)])), null, 2));
    } else {
      for (const [s, e] of todo) {
        console.log(JSON.stringify(s) + (e.plural ? `  (plural: ${JSON.stringify(e.plural)})` : ''));
        console.log(`    ${e.locations.join('  ')}`);
      }
      console.log(`\n${todo.length} of ${source.strings.size} strings are not translated in ${tag}.`);
    }
    break;
  }

  case 'sync': {
    const tags = flags.has('--all') ? catalogueTags() : args;
    if (!tags.length) { console.error('usage: sync <tag>|--all [--fill]'); process.exit(2); }
    for (const tag of tags) {
      const cat = readCatalogue(tag);
      const next = {};
      // Source order first, so related strings sit together for the translator…
      for (const [s, e] of source.strings) {
        if (Object.prototype.hasOwnProperty.call(cat, s)) next[s] = cat[s];
        else if (flags.has('--fill') && !hasTranslation(cat, s)) next[s] = emptyEntry(e, tag);
      }
      // …then anything still used that extraction does not see on its own (a
      // folded ellipsis, a string only ever built from parts).
      const dropped = [];
      for (const [k, v] of Object.entries(cat)) {
        if (k in next) continue;
        if (isLive(k, source.literals)) next[k] = v;
        else dropped.push(k);
      }
      if (!flags.has('--fill')) {
        for (const [k, v] of Object.entries(next)) {
          if (v === '' || (v && typeof v === 'object' && !Object.values(v).some(Boolean))) delete next[k];
        }
      }
      writeCatalogue(tag, next);
      console.log(`${tag}: ${Object.keys(next).length} entries written${dropped.length ? `, ${dropped.length} stale dropped:` : ''}`);
      for (const k of dropped) console.log(`    - ${JSON.stringify(k)}`);
    }
    break;
  }

  case 'check': {
    let bad = source.problems.length;
    for (const tag of catalogueTags()) {
      const a = audit(readCatalogue(tag), source, tag);
      for (const k of a.stale) { bad++; console.log(`${tag}: stale — no longer in the source: ${JSON.stringify(k)}`); }
      for (const p of a.badPlaceholders) {
        bad++;
        console.log(`${tag}: placeholders — ${JSON.stringify(p.key)} → ${JSON.stringify(p.form)}${p.unknown.length ? ` (unknown ${p.unknown.join(' ')})` : ''}${p.lost.length ? ` (missing ${p.lost.join(' ')})` : ''}`);
      }
      for (const p of a.badPlurals) { bad++; console.log(`${tag}: plural — ${JSON.stringify(p.key)}: ${p.problem}`); }
    }
    if (bad) { console.log(`\n${bad} problem${bad === 1 ? '' : 's'}.`); process.exit(1); }
    console.log('All catalogues are consistent with the source.');
    break;
  }

  case 'strings': {
    if (flags.has('--json')) {
      console.log(JSON.stringify(Object.fromEntries([...source.strings].map(([s, e]) => [s, { at: e.locations, ...(e.plural ? { plural: e.plural } : {}) }])), null, 2));
    } else {
      for (const [s, e] of source.strings) console.log(`${JSON.stringify(s)}    ${e.locations[0]}`);
      console.log(`\n${source.strings.size} strings.`);
    }
    break;
  }

  default:
    console.error(`unknown command "${cmd}" — see the top of scripts/i18n.mjs`);
    process.exit(2);
}
