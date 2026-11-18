'use strict';

/**
 * File access for the page, by token.
 *
 * The page never names a path. A token stands for one file and is minted only
 * by the main process, for a path that came from the user:
 *   - the OS (a file double-clicked in Finder or Explorer, dropped on the Dock
 *     icon, or passed on the command line),
 *   - the main process's own Save dialog,
 *   - the preload's `webUtils.getPathForFile` on a real File the user picked in
 *     the Open dialog or dropped on the window (the page cannot forge one).
 * So a compromised page can read and write exactly the files the user handed it
 * this session, and nothing else.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

class FileTokens {
  constructor() {
    /** @type {Map<string, string>} */
    this.paths = new Map();
    /** @type {Map<string, string>} */
    this.tokens = new Map();
  }

  /** The token for an absolute path, the same one each time. */
  mint(file) {
    const abs = path.resolve(file);
    let token = this.tokens.get(abs);
    if (!token) {
      token = crypto.randomUUID();
      this.tokens.set(abs, token);
      this.paths.set(token, abs);
    }
    return token;
  }

  /** The path a token stands for, or null for a token this process never minted. */
  path(token) {
    return (typeof token === 'string' && this.paths.get(token)) || null;
  }
}

/**
 * Write `bytes` to `target` without ever leaving a half-written file: into a
 * temporary file beside it, then renamed over it. A failure part way leaves the
 * original untouched.
 */
async function writeAtomic(target, bytes) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`);
  await fs.writeFile(tmp, bytes);
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/** The extensions Pikado opens from the OS (see src/io/open.js). */
const OPENABLE = new Set([
  'pkd', 'psd', 'psb', 'svg', 'heic', 'heif', 'hif', 'icns',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'tif', 'tiff', 'ico',
]);

function isOpenable(file) {
  return OPENABLE.has(path.extname(file).slice(1).toLowerCase());
}

module.exports = { FileTokens, writeAtomic, isOpenable };
