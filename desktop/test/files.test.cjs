'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FileTokens, writeAtomic, isOpenable } = require('../lib/files.cjs');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pikado-files-'));

test('a token stands for one path, and only tokens this process minted resolve', () => {
  const t = new FileTokens();
  const a = t.mint('/Users/x/art.pkd');
  assert.equal(t.mint('/Users/x/art.pkd'), a, 'the same path gets the same token');
  assert.equal(t.mint('/Users/x/../x/art.pkd'), a, 'however it is spelled');
  assert.notEqual(t.mint('/Users/x/other.pkd'), a);
  assert.equal(t.path(a), path.resolve('/Users/x/art.pkd'));
  assert.equal(t.path('/Users/x/art.pkd'), null, 'a path is not a token');
  assert.equal(t.path('00000000-0000-0000-0000-000000000000'), null);
  assert.equal(t.path(undefined), null);
  assert.equal(t.path({ toString: () => a }), null, 'only a string');
});

test('a write replaces the file whole and leaves nothing behind', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'doc.pkd');
  fs.writeFileSync(file, 'old');
  await writeAtomic(file, Buffer.from('new contents'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'new contents');
  assert.deepEqual(fs.readdirSync(dir), ['doc.pkd'], 'no temporary file left');
});

test('a write that cannot land leaves the original and no temporary file', async () => {
  // Verified to fail with the clean-up removed: the .tmp file stayed behind.
  const dir = tmpDir();
  const target = path.join(dir, 'busy');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep'), 'x');
  await assert.rejects(writeAtomic(target, Buffer.from('data')));
  assert.deepEqual(fs.readdirSync(dir), ['busy']);
  assert.deepEqual(fs.readdirSync(target), ['keep']);
});

test('the OS may hand over the files Pikado opens', () => {
  for (const f of ['a.pkd', 'B.PSD', 'c.psb', 'd.png', 'e.heic', 'f.svg', 'g.jpeg']) assert.ok(isOpenable(f), f);
  for (const f of ['a.exe', 'b', 'c.pkd.bak', 'd.txt']) assert.ok(!isOpenable(f), f);
});
