'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveAppPath, mimeFor, isAppUrl } = require('../lib/protocol.cjs');

const ROOT = path.resolve('/opt/pikado/renderer');

test('app:// URLs map to files inside the renderer directory', () => {
  assert.equal(resolveAppPath(ROOT, 'app://pikado/'), path.join(ROOT, 'index.html'));
  assert.equal(resolveAppPath(ROOT, 'app://pikado/index.html?webgpu=off#x'), path.join(ROOT, 'index.html'));
  assert.equal(resolveAppPath(ROOT, 'app://pikado/assets/app-1a2b.js'), path.join(ROOT, 'assets', 'app-1a2b.js'));
  assert.equal(resolveAppPath(ROOT, 'app://pikado/assets/a%20b.js'), path.join(ROOT, 'assets', 'a b.js'));
});

test('nothing outside the renderer directory is served', () => {
  // Verified to fail with the containment check removed: the escaped slashes
  // survive URL parsing as one segment, decode to ../../, and reached /etc.
  for (const url of [
    'app://pikado/..%2f..%2f..%2fetc%2fpasswd',
    'app://pikado/assets/..%2F..%2F..%2F..%2Fetc%2Fhosts',
    'app://pikado/%2e%2e%2f%2e%2e%2fsecret',
  ]) {
    assert.equal(resolveAppPath(ROOT, url), null, url);
  }
  // Dot segments the URL parser removes stay inside, as /etc/passwd under the root.
  assert.equal(resolveAppPath(ROOT, 'app://pikado/../../etc/passwd'), path.join(ROOT, 'etc', 'passwd'));
});

test('other schemes, hosts and malformed paths are refused', () => {
  assert.equal(resolveAppPath(ROOT, 'file:///etc/passwd'), null);
  assert.equal(resolveAppPath(ROOT, 'https://pikado/index.html'), null);
  assert.equal(resolveAppPath(ROOT, 'app://elsewhere/index.html'), null);
  assert.equal(resolveAppPath(ROOT, 'app://pikado/%E0%A4%A'), null, 'a broken escape');
  assert.equal(resolveAppPath(ROOT, 'app://pikado/index.html%00.png'), null, 'a NUL');
  assert.equal(resolveAppPath(ROOT, 'not a url'), null);
});

test('module scripts are served as JavaScript', () => {
  assert.equal(mimeFor('/x/app.js'), 'text/javascript; charset=utf-8');
  assert.equal(mimeFor('/x/libheif.MJS'), 'text/javascript; charset=utf-8');
  assert.equal(mimeFor('/x/index.html'), 'text/html; charset=utf-8');
  assert.equal(mimeFor('/x/manifest.webmanifest'), 'application/manifest+json; charset=utf-8');
  assert.equal(mimeFor('/x/data.bin'), 'application/octet-stream');
});

test('the app origin, and the dev server only when given', () => {
  assert.ok(isAppUrl('app://pikado/index.html'));
  assert.ok(!isAppUrl('app://other/index.html'));
  assert.ok(!isAppUrl('http://localhost:5173/'));
  assert.ok(isAppUrl('http://localhost:5173/tests/', 'http://localhost:5173'));
  assert.ok(!isAppUrl('http://localhost:5174/', 'http://localhost:5173'));
  assert.ok(!isAppUrl('https://example.com/', 'http://localhost:5173'));
});
