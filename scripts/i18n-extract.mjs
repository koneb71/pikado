/**
 * Find the interface text in Pikado's source.
 *
 * Shared by `scripts/i18n.mjs` (the translator's tool, in Node) and the i18n
 * suite (in the browser, fed the same files through Vite's `?raw` import), so
 * the two can never disagree about what counts as a string.
 *
 * Interface text reaches the screen two ways, and both are found here:
 *
 * - **Translated where it is composed**: the first argument of `tr()` and
 *   `msg()`, a history label (`.commit()`, `.record()`, `.replaceTop()`,
 *   `.clear()` — English data the History panel translates when it draws
 *   it), and both forms given to `trn()`.
 * - **Declared as data and translated where it is drawn**: the text fields of
 *   registries and ParamDescriptors (`label`, `name`, `title`, `hint`,
 *   `header`, `menu`, `unit`, `placeholder`, `strokeLabel`, `tagline`) and the
 *   entries of a literal `options: [...]` array.
 *
 * The second kind is found by the shape of the code rather than by a marker
 * on every string, which is deliberate: a registry entry reads as plain
 * English and stays that way. It does mean a few identifiers in those
 * positions are found too; anything that looks like one (no spaces, nothing
 * capitalised) is left out, and the rest is harmless — an entry nobody
 * translates simply stays English.
 *
 * It is a tokenizer, not a parser: enough of JavaScript's lexical grammar to
 * never mistake a regex, a comment or a template's `${}` for a string, which
 * is the part a regular expression over the source gets wrong. String
 * literals joined with `+` count as the one string they make, since that is
 * what reaches `tr()` at runtime.
 */

/**
 * Source files that hold no interface text and are left out: generated data,
 * and the engine, whose only strings are language names (never translated).
 */
export const SKIP_FILES = new Set([
  'src/text/google-catalog.data.js',
  'src/core/i18n.js',
]);

const TEXT_KEYS = new Set([
  'label', 'name', 'title', 'hint', 'header', 'menu', 'unit', 'placeholder', 'tagline',
]);

/** A property whose value is interface text: one of the above, or a compound such as `strokeLabel`, `keyHint`. */
function isTextKey(name) {
  return TEXT_KEYS.has(name) || /(Label|Hint|Title|Header|Tagline|Placeholder)$/.test(name);
}

/** Calls whose first string argument is interface text. */
const CALLS = new Set(['tr', 'msg']);
/** Methods whose first string argument is a history label, shown later by the History panel. */
const HISTORY_METHODS = new Set(['commit', 'record', 'replaceTop', 'clear']);

/** Tokens after which a `/` begins a regular expression rather than dividing. */
const REGEX_AFTER_PUNCT = new Set(['${', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '=>', '&&', '||', '??', '==', '===', '!=', '!==', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '...']);
const OPENERS = new Set(['(', '[', '{', '${']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);

const PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];

/**
 * Split JavaScript source into tokens.
 *
 * A template literal is one token (`tpl`, with `exprs` counting its `${}`
 * holes and `cooked` its text when there are none); the tokens of its
 * expressions follow it in the same list, so a `t('…')` inside a `${}` is
 * still seen. Adjacent string literals joined by `+` are folded into one
 * `str` token, because that is the value the code produces.
 *
 * @returns {{type:'str'|'tpl'|'id'|'num'|'punct'|'regex', value:string, line:number, exprs?:number}[]}
 */
export function tokenize(src) {
  const out = [];
  let i = 0;
  let line = 1;
  const n = src.length;

  const prevSignificant = () => out.length ? out[out.length - 1] : null;
  const regexAllowed = () => {
    const p = prevSignificant();
    if (!p) return true;
    if (p.type === 'punct') return REGEX_AFTER_PUNCT.has(p.value);
    if (p.type === 'id') return REGEX_AFTER_WORD.has(p.value);
    return false;
  };

  function readQuoted(q) {
    let s = '';
    i++;
    while (i < n && src[i] !== q) {
      if (src[i] === '\\') {
        const c = src[i + 1];
        i += 2;
        if (c === 'n') s += '\n';
        else if (c === 't') s += '\t';
        else if (c === 'r') s += '\r';
        else if (c === 'u') {
          if (src[i] === '{') {
            const end = src.indexOf('}', i);
            s += String.fromCodePoint(parseInt(src.slice(i + 1, end), 16));
            i = end + 1;
          } else {
            s += String.fromCharCode(parseInt(src.slice(i, i + 4), 16));
            i += 4;
          }
        } else if (c === 'x') {
          s += String.fromCharCode(parseInt(src.slice(i, i + 2), 16));
          i += 2;
        } else if (c === '\n') line++;
        else s += c;
        continue;
      }
      if (src[i] === '\n') line++;
      s += src[i++];
    }
    i++;
    return s;
  }

  /**
   * Scan code until the `}` that closes a template hole, emitting its tokens
   * bracketed by `${` and `}` so the hole nests like any other bracket.
   */
  function scanHole() {
    let depth = 0;
    out.push({ type: 'punct', value: '${', line });
    while (i < n) {
      const c = src[i];
      if (c === '}' && depth === 0) { out.push({ type: 'punct', value: '}', line }); i++; return; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      step();
    }
  }

  function readTemplate() {
    const startLine = line;
    const token = { type: 'tpl', value: '', line: startLine, exprs: 0 };
    out.push(token);
    let cooked = '';
    i++;
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') {
        const c = src[i + 1];
        cooked += c === 'n' ? '\n' : c === 't' ? '\t' : c;
        if (c === '\n') line++;
        i += 2;
        continue;
      }
      if (src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        token.exprs++;
        cooked += '${}';
        scanHole();
        continue;
      }
      if (src[i] === '\n') line++;
      cooked += src[i++];
    }
    i++;
    token.value = cooked;
  }

  function readRegex() {
    const startLine = line;
    let inClass = false;
    let body = '/';
    i++;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { body += c + src[i + 1]; i += 2; continue; }
      if (c === '\n') break;
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { body += c; i++; break; }
      body += c;
      i++;
    }
    while (i < n && /[a-z]/i.test(src[i])) body += src[i++];
    out.push({ type: 'regex', value: body, line: startLine });
  }

  function step() {
    const c = src[i];
    if (c === '\n') { line++; i++; return; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === ' ' || c === '﻿') { i++; return; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      return;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
      i = stop;
      return;
    }
    if (c === '\'' || c === '"') {
      const startLine = line;
      out.push({ type: 'str', value: readQuoted(c), line: startLine });
      return;
    }
    if (c === '`') { readTemplate(); return; }
    if (c === '/' && regexAllowed()) { readRegex(); return; }
    if (/[A-Za-z_$À-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$À-￿]/.test(src[j])) j++;
      out.push({ type: 'id', value: src.slice(i, j), line });
      i = j;
      return;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      out.push({ type: 'num', value: src.slice(i, j), line });
      i = j;
      return;
    }
    for (const p of PUNCT) {
      if (src.startsWith(p, i)) {
        out.push({ type: 'punct', value: p, line });
        i += p.length;
        return;
      }
    }
    out.push({ type: 'punct', value: c, line });
    i++;
  }

  while (i < n) step();
  return foldConcatenation(out);
}

/**
 * `'a ' + 'b'` → one string token `'a b'`, as the running code sees it —
 * unless the right-hand string binds to something tighter first (`'b'.length`).
 */
function foldConcatenation(toks) {
  const TIGHTER = new Set(['.', '?.', '[', '(', '*', '/', '%', '**']);
  const out = [];
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k];
    const plus = out[out.length - 1];
    const left = out[out.length - 2];
    const right = text(tok);
    const after = toks[k + 1];
    if (right != null && plus && plus.type === 'punct' && plus.value === '+' && left && left.type === 'str'
      && !(after && after.type === 'punct' && TIGHTER.has(after.value))) {
      out.pop();
      out[out.length - 1] = { ...left, value: left.value + right };
      continue;
    }
    out.push(tok);
  }
  return out;
}

/** A plain string a token stands for: a quoted string, or a template with no holes. */
function text(tok) {
  if (!tok) return null;
  if (tok.type === 'str') return tok.value;
  if (tok.type === 'tpl' && tok.exprs === 0) return tok.value;
  return null;
}

/** Interface text has a letter in it; an identifier has no space and no capital. */
function isText(s) {
  return typeof s === 'string' && /\p{L}/u.test(s);
}
function looksLikeIdentifier(s) {
  return !/\s/.test(s) && !/\p{Lu}/u.test(s) && !/[^\x00-\x7f]/.test(s);
}

/**
 * The string tokens that make up a property's value, stopping at the `,` or
 * closing bracket that ends it. Only strings at the value's own level count —
 * `label: on ? 'Hide' : 'Show'` gives both, `label: fmt('x')` gives neither.
 */
function valueStrings(toks, start) {
  const found = [];
  let depth = 0;
  for (let k = start; k < toks.length; k++) {
    const tok = toks[k];
    if (tok.type === 'punct') {
      if (OPENERS.has(tok.value)) depth++;
      else if (tok.value === ')' || tok.value === ']' || tok.value === '}') {
        if (depth === 0) break;
        depth--;
      } else if ((tok.value === ',' || tok.value === ';') && depth === 0) break;
      continue;
    }
    if (depth === 0) {
      const s = text(tok);
      if (s != null) found.push(tok);
    }
  }
  return found;
}

/** The index of the bracket that closes the one at `open`. */
function closing(toks, open) {
  let depth = 0;
  for (let k = open; k < toks.length; k++) {
    const v = toks[k].type === 'punct' ? toks[k].value : null;
    if (v && OPENERS.has(v)) depth++;
    else if (v === ')' || v === ']' || v === '}') {
      depth--;
      if (depth === 0) return k;
    }
  }
  return toks.length - 1;
}

/** The top-level arguments of the call whose `(` is at `open`, as [start, end) token ranges. */
function argRanges(toks, open) {
  const end = closing(toks, open);
  const out = [];
  let start = open + 1;
  let depth = 0;
  for (let k = open + 1; k < end; k++) {
    const v = toks[k].type === 'punct' ? toks[k].value : null;
    if (v && OPENERS.has(v)) depth++;
    else if (v === ')' || v === ']' || v === '}') depth--;
    else if (v === ',' && depth === 0) { out.push([start, k]); start = k + 1; }
  }
  if (start < end) out.push([start, end]);
  return { args: out, end };
}

const NOT_FUNCTIONS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'typeof', 'function']);

/** Where an expression starting at `start` ends: the first `,` `;` or unmatched closer at its own level. */
function expressionEnd(toks, start) {
  let depth = 0;
  for (let k = start; k < toks.length; k++) {
    const v = toks[k].type === 'punct' ? toks[k].value : null;
    if (v && OPENERS.has(v)) depth++;
    else if (v === ')' || v === ']' || v === '}') {
      if (depth === 0) return k;
      depth--;
    } else if ((v === ',' || v === ';') && depth === 0) return k;
  }
  return toks.length;
}

/**
 * Functions that take interface text as an argument, with the argument's
 * position.
 *
 * `.commit('Brush Stroke')` and `{ label: 'Radius' }` are easy to find, but
 * plenty of text travels through a helper first — a history label through
 * `transformLayersOrSession('cw', 'Rotate Layer 90° CW')`, a slider's label
 * through Camera Raw's `slider('tint', 'Tint', …)` — and a string the extractor
 * never sees is one no translator is ever asked for. So a parameter is text
 * when it reaches `.commit()`, `tr()` or `msg()`, a text property such as
 * `label` (shorthand `{ key, label }` included), or the text position of
 * another such function; found to a fixed point, since helpers call helpers.
 *
 * A helper counts in its own file, and in others only if it is exported —
 * otherwise one file's little `push(label)` would make every `push('…')`
 * everywhere look like interface text, which is exactly what it did to the
 * PSD writer's EngineData lines.
 *
 * @returns {{positions(name: string, file: number): Set<number>}}
 */
function labelTakers(fileToks) {
  const fns = [];
  fileToks.forEach((toks, file) => {
    const exportedNames = new Set();
    for (let k = 0; k < toks.length; k++) {
      // export { a, b as c }
      if (toks[k].value === 'export' && toks[k + 1] && toks[k + 1].value === '{') {
        for (let m = k + 2; m < toks.length && toks[m].value !== '}'; m++) if (toks[m].type === 'id' && toks[m - 1].value !== 'as') exportedNames.add(toks[m].value);
      }
    }
    for (let k = 0; k < toks.length; k++) {
      const tok = toks[k];
      if (tok.type !== 'id' || NOT_FUNCTIONS.has(tok.value)) continue;
      const prev = toks[k - 1];
      let open = -1;
      let exported = exportedNames.has(tok.value);
      if (prev && prev.type === 'id' && prev.value === 'function' && toks[k + 1] && toks[k + 1].value === '(') {
        open = k + 1;
        const before = toks[k - 2] && toks[k - 2].value === 'async' ? toks[k - 3] : toks[k - 2];
        exported = exported || !!(before && before.value === 'export');
      } else if (toks[k + 1] && (toks[k + 1].value === '=' || toks[k + 1].value === ':')) {
        // name = (…) =>   name = async (…) =>   name: (…) =>
        let m = k + 2;
        if (toks[m] && toks[m].value === 'async') m++;
        if (toks[m] && toks[m].value === '(' && toks[closing(toks, m) + 1] && toks[closing(toks, m) + 1].value === '=>') open = m;
        exported = exported || !!(toks[k - 2] && toks[k - 2].value === 'export');
      } else if (toks[k + 1] && toks[k + 1].value === '(' && prev && prev.type === 'punct' && ['{', '}', ';', ','].includes(prev.value)) {
        // method shorthand: name(…) { … }
        if (toks[closing(toks, k + 1) + 1] && toks[closing(toks, k + 1) + 1].value === '{') open = k + 1;
      }
      if (open < 0) continue;
      const { args, end } = argRanges(toks, open);
      const params = args.map(([s]) => (toks[s].value === '...' ? toks[s + 1] : toks[s])).map((p) => (p && p.type === 'id' ? p.value : null));
      let bodyStart = end + 1;
      if (toks[bodyStart] && toks[bodyStart].value === '=>') bodyStart++;
      const opener = toks[bodyStart] && toks[bodyStart].value;
      const bodyEnd = opener === '{' || opener === '(' ? closing(toks, bodyStart) : expressionEnd(toks, bodyStart);
      if (params.some(Boolean)) fns.push({ name: tok.value, params, toks, file, exported, bodyStart, bodyEnd });
    }
  });

  const SINKS = new Map(['commit', 'record', 'replaceTop', 'tr', 'msg'].map((n) => [n, new Set([0])]));
  const global = new Map();
  const local = new Map(); // `${file}:${name}` → positions
  const EMPTY = new Set();
  const positions = (name, file) => {
    const a = SINKS.get(name) || global.get(name);
    const b = local.get(`${file}:${name}`);
    if (!b) return a || EMPTY;
    return a ? new Set([...a, ...b]) : b;
  };
  const mark = (f, p) => {
    const store = f.exported ? global : local;
    const key = f.exported ? f.name : `${f.file}:${f.name}`;
    if (!store.has(key)) store.set(key, new Set());
    if (store.get(key).has(p)) return false;
    store.get(key).add(p);
    return true;
  };
  for (let round = 0, changed = true; changed && round < 8; round++) {
    changed = false;
    for (const f of fns) {
      for (let k = f.bodyStart; k < f.bodyEnd; k++) {
        const tok = f.toks[k];
        if (tok.type !== 'id') continue;
        const next = f.toks[k + 1];
        const prev = f.toks[k - 1];
        // { label } — a parameter named for a text property, used as shorthand.
        const p0 = f.params.indexOf(tok.value);
        if (p0 >= 0 && isTextKey(tok.value) && prev && (prev.value === '{' || prev.value === ',') && next && (next.value === ',' || next.value === '}')) {
          changed = mark(f, p0) || changed;
          continue;
        }
        // { label: param } — anywhere at the value's own level.
        if (isTextKey(tok.value) && next && next.value === ':' && prev && (prev.value === '{' || prev.value === ',')) {
          const stop = expressionEnd(f.toks, k + 2);
          for (let m = k + 2; m < stop; m++) {
            const p = f.params.indexOf(f.toks[m].value);
            if (f.toks[m].type === 'id' && p >= 0) changed = mark(f, p) || changed;
          }
          continue;
        }
        // commit(param), tr(param), helper(…, param, …)
        if (!next || next.value !== '(') continue;
        const takes = positions(tok.value, f.file);
        if (!takes.size) continue;
        const { args } = argRanges(f.toks, k + 1);
        for (const i of takes) {
          const range = args[i];
          if (!range) continue;
          for (let m = range[0]; m < range[1]; m++) {
            const p = f.params.indexOf(f.toks[m].value);
            if (f.toks[m].type === 'id' && p >= 0) changed = mark(f, p) || changed;
          }
        }
      }
    }
  }
  // The sinks themselves are found directly, as calls and methods.
  return { positions: (name, file) => (SINKS.has(name) ? EMPTY : positions(name, file)) };
}

export { labelTakers as _labelTakers };

/**
 * Extract every piece of interface text from a set of files.
 *
 * @param {{path:string, source:string}[]} files
 * @returns {{
 *   strings: Map<string, {locations:string[], plural?:string}>,
 *   literals: Set<string>,
 *   problems: {location:string, message:string}[],
 * }}
 *   `strings` in first-seen order (files in the order given). `plural` is the
 *   English plural form when the string is the singular of a `tn()`.
 *   `literals` is every plain string literal in the source, whatever its
 *   position — the test for whether a catalogue key is still used.
 */
export function extract(files) {
  const strings = new Map();
  const literals = new Set();
  const problems = [];

  const add = (s, location, extra) => {
    if (!isText(s)) return;
    let entry = strings.get(s);
    if (!entry) { entry = { locations: [] }; strings.set(s, entry); }
    if (entry.locations.length < 6 && !entry.locations.includes(location)) entry.locations.push(location);
    if (extra) Object.assign(entry, extra);
  };

  const tokenized = files.map(({ path, source }) => ({ path, toks: tokenize(source) }));
  const takers = labelTakers(tokenized.map((f) => f.toks));

  tokenized.forEach(({ path, toks }, file) => {
    const at = (tok) => `${path}:${tok.line}`;

    for (let k = 0; k < toks.length; k++) {
      const tok = toks[k];
      const s = text(tok);
      if (s != null) literals.add(s);

      // { 'Blue Filter': {…} } — a preset table keyed by its display name. Not
      // a four-character format code ('Rd  ') or a header ('Content-Type').
      if (tok.type === 'str' && toks[k + 1] && toks[k + 1].value === ':' && toks[k - 1]
        && (toks[k - 1].value === '{' || toks[k - 1].value === ',')
        && !/^\s|\s$/.test(tok.value) && /\s|^\p{Lu}\p{Ll}+$/u.test(tok.value)) {
        add(tok.value, at(tok));
      }

      if (tok.type !== 'id') continue;
      const prev = toks[k - 1];
      const next = toks[k + 1];
      const isMethod = prev && prev.type === 'punct' && (prev.value === '.' || prev.value === '?.');
      // The engine's own `function tr(…)` declares the call; it is not one.
      if (prev && prev.type === 'id' && prev.value === 'function') continue;

      // tr('…'), msg('…'), and history labels: doc.commit('…'), history.record('…') …
      if (next && next.value === '(' && ((CALLS.has(tok.value) && !isMethod) || (HISTORY_METHODS.has(tok.value) && isMethod))) {
        const arg = toks[k + 2];
        // Every string at the first argument's own level: `commit(handle ? 'Edit Handle' : 'Move Anchor Points')`.
        for (const v of valueStrings(toks, k + 2)) add(text(v), at(v));
        if (arg && arg.type === 'tpl' && arg.exprs && CALLS.has(tok.value)) {
          problems.push({ location: at(arg), message: `${tok.value}() given a template literal — use {placeholders} so the whole sentence can be translated` });
        }
        continue;
      }

      // A history label on its way to .commit() through a helper.
      const takes = next && next.value === '(' && !(prev && prev.type === 'id' && prev.value === 'function') ? takers.positions(tok.value, file) : null;
      if (takes && takes.size) {
        const { args } = argRanges(toks, k + 1);
        for (const i of takes) {
          if (!args[i]) continue;
          for (const v of valueStrings(toks, args[i][0])) {
            const vs = text(v);
            if (!looksLikeIdentifier(vs)) add(vs, at(v));
          }
        }
      }

      // trn('{count} layer', '{count} layers', n)
      if (tok.value === 'trn' && !isMethod && next && next.value === '(') {
        const one = text(toks[k + 2]);
        const other = toks[k + 3] && toks[k + 3].value === ',' ? text(toks[k + 4]) : null;
        if (one != null && other != null) add(one, at(toks[k + 2]), { plural: other });
        else problems.push({ location: at(tok), message: 'trn() needs two string literals: the singular and the plural' });
        continue;
      }

      // { label: 'Gaussian Blur...' } — a key in an object literal, not a ternary branch.
      const keyName = tok.value;
      if (isTextKey(keyName) && next && next.value === ':' && prev && (prev.value === '{' || prev.value === ',')) {
        for (const v of valueStrings(toks, k + 2)) {
          const vs = text(v);
          if (keyName !== 'unit' && looksLikeIdentifier(vs)) continue;
          add(vs, at(v));
        }
        continue;
      }

      // this.label = 'Rectangular Marquee' — a label kept on an object, committed later.
      if (isTextKey(keyName) && keyName !== 'name' && keyName !== 'title' && isMethod && next && next.value === '=' ) {
        for (const v of valueStrings(toks, k + 2)) {
          const vs = text(v);
          if (!looksLikeIdentifier(vs)) add(vs, at(v));
        }
        continue;
      }

      // options: ['Normal', 'Multiply']
      if (keyName === 'options' && next && next.value === ':' && toks[k + 2] && toks[k + 2].value === '[') {
        let depth = 0;
        for (let m = k + 2; m < toks.length; m++) {
          const o = toks[m];
          if (o.type === 'punct' && OPENERS.has(o.value)) depth++;
          else if (o.type === 'punct' && (o.value === ']' || o.value === '}' || o.value === ')')) {
            depth--;
            if (depth === 0) break;
          } else if (depth === 1) {
            const os = text(o);
            const before = toks[m - 1];
            const after = toks[m + 1];
            if (os != null && (before.value === '[' || before.value === ',') && (after.value === ',' || after.value === ']') && !looksLikeIdentifier(os)) add(os, at(o));
          }
        }
      }
    }
  });
  return { strings, literals, problems };
}

/** The `{placeholders}` a string uses, sorted. */
export function placeholders(s) {
  return [...new Set(String(s).match(/\{\w+\}/g) || [])].sort();
}

/**
 * Whether a catalogue key is still used anywhere: as a literal, or as the
 * other spelling of an ellipsis the engine folds (see `lookup` in i18n.js).
 */
export function isLive(key, literals) {
  if (literals.has(key)) return true;
  const dots = /^([\s\S]*?)(\.\.\.|…)$/.exec(key);
  if (dots) return literals.has(dots[1]);
  return literals.has(`${key}...`) || literals.has(`${key}…`);
}

/**
 * Check one catalogue against the source.
 *
 * @param {object} catalogue the parsed JSON
 * @param {ReturnType<typeof extract>} source
 * @param {string} tag
 */
export function audit(catalogue, source, tag) {
  const stale = [];
  const badPlaceholders = [];
  const badPlurals = [];
  let translated = 0;
  const categories = new Intl.PluralRules(tag).resolvedOptions().pluralCategories;

  for (const [key, value] of Object.entries(catalogue)) {
    if (!isLive(key, source.literals)) { stale.push(key); continue; }
    const entry = source.strings.get(key);
    const allowed = new Set(placeholders(key).concat(entry && entry.plural ? placeholders(entry.plural) : []));
    const forms = typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value) : [];
    if (value && typeof value === 'object') {
      const extra = Object.keys(value).filter((c) => !categories.includes(c));
      if (extra.length || typeof value.other !== 'string') badPlurals.push({ key, problem: extra.length ? `categories ${extra.join(', ')} do not exist in ${tag}` : 'no "other" form' });
    }
    let ok = true;
    for (const form of forms) {
      if (typeof form !== 'string') { ok = false; continue; }
      const used = placeholders(form);
      const unknown = used.filter((p) => !allowed.has(p));
      // A plural form may leave {count} out ("one layer" written as a word), but no
      // placeholder may appear that the code does not supply.
      const lost = typeof value === 'string' ? placeholders(key).filter((p) => !used.includes(p)) : [];
      if (unknown.length || lost.length) {
        badPlaceholders.push({ key, form, unknown, lost });
        ok = false;
      }
    }
    if (ok && forms.some((f) => typeof f === 'string' && f)) translated++;
  }

  const missing = [];
  for (const [s] of source.strings) {
    if (!hasTranslation(catalogue, s)) missing.push(s);
  }
  return { translated, stale, badPlaceholders, badPlurals, missing, total: source.strings.size };
}

/** Whether a catalogue translates `s`, allowing for ellipsis folding. */
export function hasTranslation(catalogue, s) {
  const usable = (v) => (typeof v === 'string' ? !!v : !!(v && typeof v === 'object' && v.other));
  const own = (k) => Object.prototype.hasOwnProperty.call(catalogue, k) && usable(catalogue[k]);
  if (own(s)) return true;
  const dots = /^([\s\S]*?)(\.\.\.|…)$/.exec(s);
  if (dots) return own(dots[1]);
  return own(`${s}...`) || own(`${s}…`);
}
