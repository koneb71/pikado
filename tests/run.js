/**
 * Test entry point.
 *
 * The app itself must boot first: tools, filters, adjustments, effect renderers,
 * commands and panels all self-register on import, and the suites assert against
 * those live registries.
 */
import '/src/main.js';

import { runAll } from './harness.js';

// Suites — import for the side effect of registering themselves.
import './suites/core.test.js';
import './suites/compositor.test.js';
import './suites/paint.test.js';
import './suites/filters.test.js';
import './suites/adjustments.test.js';
import './suites/layers.test.js';
import './suites/effects.test.js';
import './suites/text-vector.test.js';
import './suites/io.test.js';
import './suites/smart.test.js';
import './suites/liquify.test.js';
import './suites/channels.test.js';
import './suites/select.test.js';
import './suites/perf.test.js';

const out = document.getElementById('out');
const summary = document.getElementById('summary');

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function renderSuite(entry) {
  const bad = entry.error || entry.results.some((r) => !r.pass);
  const det = el('details', `suite ${bad ? 'bad' : 'ok'}`);
  if (bad) det.open = true;
  const sum = el('summary');
  sum.append(el('span', 'name', entry.name));
  const passed = entry.results.filter((r) => r.pass).length;
  const failed = entry.results.length - passed;
  sum.append(el('span', 'tag pass', `${passed} passed`));
  if (failed) sum.append(el('span', 'tag fail', `${failed} failed`));
  if (entry.error) sum.append(el('span', 'tag err', 'threw'));
  sum.append(el('span', 'dim', `${entry.ms} ms`));
  det.append(sum);

  const rows = el('div', 'rows');
  for (const r of entry.results) {
    rows.append(el('div', `row ${r.pass ? 'p' : 'f'}`, r.message));
    if (!r.pass && r.detail) rows.append(el('div', 'detail', r.detail));
  }
  if (entry.error) {
    const pre = el('pre', 'stack', entry.error);
    rows.append(pre);
  }
  det.append(rows);
  return det;
}

function renderSummary(report, done) {
  summary.replaceChildren();
  summary.append(el('span', 'tag pass', `${report.passed} passed`));
  summary.append(el('span', `tag ${report.failed ? 'fail' : 'dim'}`, `${report.failed} failed`));
  if (report.errors) summary.append(el('span', 'tag err', `${report.errors} suites threw`));
  summary.append(el('span', 'dim', `${report.suites.length} suites`));
  if (done) {
    summary.append(el('span', report.ok ? 'tag pass' : 'tag fail', report.ok ? 'ALL PASS' : 'FAILURES'));
    summary.append(el('span', 'dim', `${report.ms} ms`));
    const btn = el('button', null, 'Run again');
    btn.onclick = () => location.reload();
    summary.append(btn);
  } else {
    summary.append(el('span', 'dim', 'running…'));
  }
}

// Boot the app, then run.
(async () => {
  // main.js boots on DOMContentLoaded; give it a frame to finish registering.
  await new Promise((r) => setTimeout(r, 60));

  const report = await runAll({
    onProgress: (entry, rep) => {
      out.append(renderSuite(entry));
      renderSummary(rep, false);
    },
  });

  renderSummary(report, true);
  window.__pikadoTests = report;
  window.__pikadoTestsDone = true;

  const line = `${report.passed} passed, ${report.failed} failed, ${report.errors} suites threw — ${report.ms} ms`;
  if (report.ok) console.log(`[pikado tests] ALL PASS — ${line}`);
  else console.error(`[pikado tests] FAILURES — ${line}`);
})();
