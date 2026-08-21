#!/usr/bin/env node
/**
 * Turns the service's JSON logs into a load-test report: latency percentiles
 * broken down by worker concurrency, failure codes, and the host vitals
 * (CPU, steal, memory) recorded during the same window.
 *
 * Usage:
 *   docker compose logs --no-color --since 30m worker api | node scripts/logreport.mjs
 *   node scripts/logreport.mjs worker.log api.log
 *   docker compose logs --no-color worker | node scripts/logreport.mjs --csv jobs.csv
 *
 * It reads the "job completed", "job failed" and "vitals" lines, so it works on
 * production traffic too - not just on synthetic load tests.
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const files = [];
let csvOut = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--csv') {
    csvOut = args[i + 1];
    i += 1;
  } else {
    files.push(args[i]);
  }
}

function readInput() {
  if (files.length > 0) return files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  return fs.readFileSync(0, 'utf8');
}

/** Docker prefixes each line with "service-1  | "; JSON starts at the first brace. */
function parseLine(line) {
  const start = line.indexOf('{');
  if (start === -1) return null;
  try {
    return JSON.parse(line.slice(start));
  } catch {
    return null;
  }
}

const completed = [];
const failed = [];
const vitals = [];
const accepted = [];

for (const line of readInput().split('\n')) {
  const entry = parseLine(line);
  if (!entry?.msg) continue;
  switch (entry.msg) {
    case 'job completed':
      completed.push(entry);
      break;
    case 'job failed':
      failed.push(entry);
      break;
    case 'vitals':
      vitals.push(entry);
      break;
    case 'pdf job accepted':
      accepted.push(entry);
      break;
    default:
      break;
  }
}

if (completed.length === 0 && failed.length === 0 && vitals.length === 0) {
  console.error('No recognisable log lines found. Pipe JSON logs in, e.g.:');
  console.error('  docker compose logs --no-color worker | node scripts/logreport.mjs');
  process.exit(1);
}

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function stats(values) {
  const clean = values.filter((value) => value !== null);
  if (clean.length === 0) return null;
  return {
    n: clean.length,
    p50: percentile(clean, 50),
    p95: percentile(clean, 95),
    max: Math.max(...clean),
    mean: clean.reduce((sum, value) => sum + value, 0) / clean.length,
  };
}

const ms = (value) => (value === null || value === undefined ? '     -' : `${(value / 1000).toFixed(2)}s`);
const pad = (value, width) => String(value).padStart(width);

// --- Jobs, grouped by the worker concurrency that produced them --------------
const byConcurrency = new Map();
for (const entry of completed) {
  const key = entry.worker_concurrency ?? 'unknown';
  if (!byConcurrency.has(key)) byConcurrency.set(key, []);
  byConcurrency.get(key).push(entry);
}

console.log('');
console.log('=== Renders ================================================================');
console.log(`completed ${completed.length}   failed ${failed.length}   accepted ${accepted.length}`);

const header = ['conc', 'jobs', 'span', 'pdf/s', 'e2e p50', 'e2e p95', 'render p50', 'render p95', 'queue p50', 'queue p95'];
console.log('');
console.log(
  `${pad(header[0], 5)} ${pad(header[1], 5)} ${pad(header[2], 8)} ${pad(header[3], 6)} ` +
    `${pad(header[4], 10)} ${pad(header[5], 10)} ${pad(header[6], 11)} ${pad(header[7], 11)} ` +
    `${pad(header[8], 10)} ${pad(header[9], 10)}`,
);

const rows = [...byConcurrency.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
for (const [concurrency, entries] of rows) {
  const times = entries.map((entry) => entry.time).filter(Boolean);
  const spanMs = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0;
  // End to end from the queue's point of view: waiting plus working.
  const total = stats(
    entries.map((entry) => {
      const worker = number(entry.total_ms);
      if (worker === null) return null;
      return worker + (number(entry.queue_wait_ms) ?? 0);
    }),
  );
  const render = stats(entries.map((entry) => number(entry.render_ms)));
  const queue = stats(entries.map((entry) => number(entry.queue_wait_ms)));
  // Approximate: jobs divided by the span of their completion timestamps.
  const throughput = spanMs > 0 ? (entries.length / (spanMs / 1000)).toFixed(2) : '-';

  console.log(
    `${pad(concurrency, 5)} ${pad(entries.length, 5)} ${pad(`${Math.round(spanMs / 1000)}s`, 8)} ${pad(throughput, 6)} ` +
      `${pad(ms(total?.p50), 10)} ${pad(ms(total?.p95), 10)} ${pad(ms(render?.p50), 11)} ${pad(ms(render?.p95), 11)} ` +
      `${pad(ms(queue?.p50), 10)} ${pad(ms(queue?.p95), 10)}`,
  );
}

// --- Where the time actually went -------------------------------------------
const stages = [
  ['queue wait', 'queue_wait_ms'],
  ['input fetch', 'input_fetch_ms'],
  ['gotenberg render', 'render_ms'],
  ['storage upload', 'upload_ms'],
  // Only present on jobs that carried an `upload` object.
  ['destination upload', 'dest_upload_ms'],
  ['worker total', 'total_ms'],
];
console.log('');
console.log('=== Stage breakdown (all completed jobs) ===================================');
for (const [label, field] of stages) {
  const summary = stats(completed.map((entry) => number(entry[field])));
  if (!summary) continue;
  console.log(
    `${label.padEnd(18)} n=${pad(summary.n, 5)}  p50 ${ms(summary.p50)}  p95 ${ms(summary.p95)}  max ${ms(summary.max)}  mean ${ms(summary.mean)}`,
  );
}

const sizes = stats(completed.map((entry) => number(entry.pdf_bytes)));
const inputs = stats(completed.map((entry) => number(entry.html_bytes)));
if (sizes) {
  console.log('');
  console.log(
    `pdf bytes          p50 ${Math.round(sizes.p50).toLocaleString()}  p95 ${Math.round(sizes.p95).toLocaleString()}  max ${Math.round(sizes.max).toLocaleString()}`,
  );
}
if (inputs) {
  console.log(
    `html bytes         p50 ${Math.round(inputs.p50).toLocaleString()}  p95 ${Math.round(inputs.p95).toLocaleString()}  max ${Math.round(inputs.max).toLocaleString()}`,
  );
}

// --- Failures ---------------------------------------------------------------
if (failed.length > 0) {
  const byCode = new Map();
  for (const entry of failed) {
    const code = entry.code ?? 'UNKNOWN';
    byCode.set(code, (byCode.get(code) ?? 0) + 1);
  }
  console.log('');
  console.log('=== Failures ===============================================================');
  for (const [code, count] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(count).padStart(5)}  ${code}`);
  }
  const retried = failed.filter((entry) => entry.will_retry).length;
  console.log(`${String(retried).padStart(5)}  of those were retried`);
}

// --- Host vitals during the same window -------------------------------------
if (vitals.length > 0) {
  const peak = (field) => {
    const values = vitals.map((entry) => number(entry[field])).filter((value) => value !== null);
    return values.length > 0 ? Math.max(...values) : null;
  };
  const mean = (field) => {
    const values = vitals.map((entry) => number(entry[field])).filter((value) => value !== null);
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  const show = (value, unit = '%') => (value === null ? '-' : `${value.toFixed(1)}${unit}`);

  console.log('');
  console.log('=== Host and process vitals (from "vitals" log lines) ======================');
  console.log(`samples            ${vitals.length}   cores ${vitals[vitals.length - 1]?.host_cores ?? '-'}`);
  console.log(`host cpu busy      mean ${show(mean('host_cpu_busy_pct'))}  peak ${show(peak('host_cpu_busy_pct'))}`);
  console.log(`host cpu iowait    mean ${show(mean('host_cpu_iowait_pct'))}  peak ${show(peak('host_cpu_iowait_pct'))}`);
  console.log(`host cpu STEAL     mean ${show(mean('host_cpu_steal_pct'))}  peak ${show(peak('host_cpu_steal_pct'))}`);
  console.log(`load1              mean ${show(mean('host_load1'), '')}  peak ${show(peak('host_load1'), '')}`);
  console.log(`host mem free      min  ${show(Math.min(...vitals.map((entry) => number(entry.host_mem_free_mb) ?? Infinity)), ' MB')}`);

  for (const role of ['api', 'worker']) {
    const roleVitals = vitals.filter((entry) => entry.role === role || entry.service === `pdf-${role}`);
    if (roleVitals.length === 0) continue;
    const rolePeak = (field) => {
      const values = roleVitals.map((entry) => number(entry[field])).filter((value) => value !== null);
      return values.length > 0 ? Math.max(...values) : null;
    };
    console.log(
      `${role.padEnd(6)} rss peak    ${show(rolePeak('rss_mb'), ' MB')}   container mem peak ${show(rolePeak('container_mem_mb'), ' MB')}   ` +
        `proc cpu peak ${show(rolePeak('proc_cpu_pct'))}   event loop peak ${show(rolePeak('event_loop_utilization_pct'))}`,
    );
  }

  const queuePeak = Math.max(
    ...vitals.map((entry) => number(entry.queue_pending) ?? 0),
    0,
  );
  if (queuePeak > 0) console.log(`queue pending peak ${queuePeak}`);
}

// --- Optional CSV for spreadsheets/charts ------------------------------------
if (csvOut) {
  const columns = [
    'time',
    'jobId',
    'worker_concurrency',
    'queue_wait_ms',
    'input_fetch_ms',
    'render_ms',
    'upload_ms',
    'dest_upload_ms',
    'total_ms',
    'html_bytes',
    'pdf_bytes',
    'attempt',
  ];
  const lines = [columns.join(',')];
  for (const entry of completed) {
    lines.push(columns.map((column) => entry[column] ?? '').join(','));
  }
  fs.writeFileSync(csvOut, `${lines.join('\n')}\n`);
  console.log('');
  console.log(`wrote ${completed.length} rows to ${csvOut}`);
}
console.log('');
