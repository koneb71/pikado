'use strict';

/**
 * The `app://pikado/` protocol: how the packaged app serves the web build.
 *
 * The page is the same Vite build the web deploys (`dist/`, packaged as
 * `renderer/`). Its module scripts load with `crossorigin` and resolve chunks
 * through `import.meta.url`, so they need a real, standard, secure origin —
 * `file://` has none. main.cjs registers `app` as privileged and answers every
 * request through `resolveAppPath`, which only ever returns a file inside the
 * renderer directory.
 */

const path = require('node:path');

const APP_SCHEME = 'app';
const APP_HOST = 'pikado';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/** The Content-Type for a file, by extension. Module scripts need text/javascript. */
function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * The file an `app://pikado/...` URL names, or null when it names nothing the
 * app may serve: another scheme or host, a malformed escape, a NUL, or a path
 * that leaves `root` — `..` in any spelling, an absolute path, a backslash
 * segment on Windows. `/` is the index page; the query and hash are ignored.
 * @param {string} root the renderer directory
 * @param {string} url
 * @returns {string|null}
 */
function resolveAppPath(root, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${APP_SCHEME}:` || u.host !== APP_HOST) return null;
  let rel;
  try {
    rel = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  if (rel.includes('\0')) return null;
  if (rel === '' || rel === '/') rel = '/index.html';
  const base = path.resolve(root);
  const abs = path.resolve(base, `.${rel.startsWith('/') ? rel : `/${rel}`}`);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

/** True for a URL on the app's own origin (or `devOrigin`, when running against Vite). */
function isAppUrl(url, devOrigin = null) {
  try {
    const { origin, protocol, host } = new URL(url);
    if (protocol === `${APP_SCHEME}:` && host === APP_HOST) return true;
    return !!devOrigin && origin === devOrigin;
  } catch {
    return false;
  }
}

module.exports = { APP_SCHEME, APP_HOST, APP_ORIGIN, mimeFor, resolveAppPath, isAppUrl };
