#!/usr/bin/env node
/**
 * Compares saved load-test runs side by side, so a concurrency decision is a
 * reading rather than an impression.
 *
 *   node scripts/compare-runs.mjs metrics/run-c1.json metrics/run-c2.json metrics/run-c3.json
 *
 * Runs come from: node scripts/loadtest.mjs … --tag c2 --out metrics/run-c2.json
 */
import fs from 'node:fs';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: node scripts/compare-runs.mjs <run.json> [run.json …]');
  process.exit(1);
}

const runs = files.map((file) => {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const summary = parsed.summary ?? parsed;
  return { file, ...summary, tag: summary.tag ?? file.replace(/^.*\//, '').replace(/\.json$/, '') };
});

const seconds = (value) =>
  value === null || value === undefined ? '-' : `${(value / 1000).toFixed(2)}s`;

const rows = [
  ['jobs completed', (run) => `${run.completed}/${run.requested}`],
  ['failed', (run) => String(run.failed)],
  ['wall clock', (run) => seconds(run.wall_ms)],
  ['throughput (pdf/s)', (run) => run.throughput_per_s?.toFixed(2) ?? '-'],
  ['end-to-end p50', (run) => seconds(run.e2e_p50_ms)],
  ['end-to-end p95', (run) => seconds(run.e2e_p95_ms)],
  ['render p50', (run) => seconds(run.render_p50_ms)],
  ['render p95', (run) => seconds(run.render_p95_ms)],
  ['queue wait p50', (run) => seconds(run.queue_p50_ms)],
  ['queue wait p95', (run) => seconds(run.queue_p95_ms)],
  ['client concurrency', (run) => String(run.client_concurrency)],
  ['rate limited', (run) => String(run.rate_limited_requests ?? 0)],
];

const labelWidth = Math.max(...rows.map(([label]) => label.length)) + 2;
const columnWidth = Math.max(12, ...runs.map((run) => run.tag.length + 2));
const cell = (value) => String(value).padStart(columnWidth);

console.log('');
console.log('Metric'.padEnd(labelWidth) + runs.map((run) => cell(run.tag)).join(''));
console.log('-'.repeat(labelWidth + columnWidth * runs.length));
for (const [label, get] of rows) {
  console.log(label.padEnd(labelWidth) + runs.map((run) => cell(get(run))).join(''));
}

// --- The reading ------------------------------------------------------------
const best = runs.reduce((a, b) => ((b.throughput_per_s ?? 0) > (a.throughput_per_s ?? 0) ? b : a));
console.log('');
console.log(`Highest throughput: ${best.tag} at ${best.throughput_per_s?.toFixed(2)} pdf/s`);

for (let i = 1; i < runs.length; i += 1) {
  const previous = runs[i - 1];
  const current = runs[i];
  const throughputGain =
    previous.throughput_per_s > 0
      ? ((current.throughput_per_s - previous.throughput_per_s) / previous.throughput_per_s) * 100
      : 0;
  const renderCost =
    previous.render_p95_ms > 0
      ? ((current.render_p95_ms - previous.render_p95_ms) / previous.render_p95_ms) * 100
      : 0;
  const verdict =
    throughputGain < 10 && renderCost > 20
      ? 'not worth it - throughput flat, render tail worse'
      : throughputGain < 10
        ? 'marginal - throughput barely moved'
        : 'worthwhile';
  console.log(
    `${previous.tag} -> ${current.tag}: throughput ${throughputGain >= 0 ? '+' : ''}${throughputGain.toFixed(1)}%, ` +
      `render p95 ${renderCost >= 0 ? '+' : ''}${renderCost.toFixed(1)}%  (${verdict})`,
  );
}
console.log('');
console.log('Rule of thumb: keep raising concurrency while throughput gains >10% and');
console.log('render p95 stays flat. Stop at the step where the tail starts paying for it.');
console.log('');
