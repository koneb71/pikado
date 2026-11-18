#!/usr/bin/env node
/**
 * Run the desktop app against the Vite dev server, or run the test suite in it.
 *
 *   node desktop/scripts/dev.mjs                 the app, with hot reload
 *   node desktop/scripts/dev.mjs --tests         the whole browser suite, then exit
 *   node desktop/scripts/dev.mjs --tests "grep=gpu|camera&webgpu=off"
 *                                                with the query string /tests/
 *                                                takes (| between grep terms)
 *   node desktop/scripts/dev.mjs --smoke         start, check the app booted, exit
 *   node desktop/scripts/dev.mjs --built         the production build on app://
 *                                                (run `npm run build` first)
 *
 * Vite is started through its API so the port it really bound is known: it
 * moves on when 5173 is taken. Electron comes from desktop/node_modules
 * (`npm run desktop:install`).
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '..');
const rootDir = path.resolve(desktopDir, '..');

const argv = process.argv.slice(2);
const testsAt = argv.indexOf('--tests');
const tests = testsAt >= 0 ? (argv[testsAt + 1] && !argv[testsAt + 1].startsWith('--') ? argv[testsAt + 1] : '') : null;
const built = argv.includes('--built');
const devtools = argv.includes('--devtools');
const smoke = argv.includes('--smoke');

let electron;
try {
  electron = createRequire(path.join(desktopDir, 'package.json'))('electron');
} catch {
  console.error('Electron is not installed. Run `npm run desktop:install` first.');
  process.exit(1);
}

let server = null;
const extra = [];
if (!built) {
  const { createServer } = await import('vite');
  server = await createServer({ root: rootDir, configFile: path.join(rootDir, 'vite.config.js'), server: { open: false } });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  console.log(`[desktop] Vite at ${url}`);
  extra.push(`--pikado-url=${url}`);
  if (tests !== null) extra.push(`--pikado-tests=${tests}`);
}
if (devtools) extra.push('--pikado-devtools');
if (smoke) extra.push('--pikado-smoke');

const child = spawn(electron, [desktopDir, ...extra], { stdio: 'inherit', cwd: rootDir });
const stop = async (code) => {
  if (server) await server.close();
  process.exit(code ?? 0);
};
child.on('exit', (code) => stop(code));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
