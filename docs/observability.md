# Observability and load testing

Everything here exists to answer two questions with numbers instead of
impressions:

1. **What concurrency should this machine run?**
2. **When is it time to buy more CPU?**

There are three layers, and they work independently — the logs alone are enough
to size the box.

| Layer | What it gives you | Cost |
| --- | --- | --- |
| Structured logs (always on) | Per-job timing breakdown, host CPU **including steal**, memory, queue depth | Nothing |
| `scripts/` analysis tools | Percentile tables, run-to-run comparison, CSV for charts | Nothing |
| Prometheus + Grafana (`--profile monitoring`) | Continuous history, per-container CPU/memory, dashboards | ~400–600 MB RAM |

---

## 1. The logs

Both processes log one JSON object per line (pino). Every line has `service`
(`pdf-api` / `pdf-worker`), `time`, `level`, and `msg`. Read them with:

```bash
docker compose logs -f worker                       # live
docker compose logs --no-color --since 30m worker   # for analysis
docker compose logs --no-color worker | node scripts/logreport.mjs
```

### `job completed` — the line that matters

One per successful render, from the worker. It is the whole timing breakdown:

```json
{
  "service": "pdf-worker", "jobId": "pdf_01M0F45K8N…", "attempt": 1,
  "apiKeyId": "default",
  "queue_wait_ms": 1616,     // enqueue → worker pickup: capacity pressure
  "input_fetch_ms": 3,       // reading the staged HTML (local disk or R2)
  "render_ms": 424,          // time inside Chromium
  "upload_ms": 5,            // writing the PDF to storage
  "delete_input_ms": 0,
  "total_ms": 434,           // worker time, excluding queue wait
  "html_bytes": 9017,
  "pdf_bytes": 130358,
  "worker_concurrency": 4,   // what the run was configured with
  "active_jobs": 4,          // renders in flight at that moment
  "storage": "local",
  "msg": "job completed"
}
```

`queue_wait_ms` and `render_ms` are the two numbers that decide sizing:

- **queue wait high, render flat** → not enough render capacity. Raise
  concurrency (both worker and Gotenberg) or add CPU.
- **render climbing as concurrency rises** → CPU contention. You have passed the
  useful limit; back off.

### `vitals` — the heartbeat

Every `VITALS_INTERVAL_SECONDS` (default 30; use 10–15 while load testing) each
process logs its own health *and* the host's. Host CPU is read from `/proc/stat`,
which a container sees unfiltered, so **CPU steal is visible without any extra
tooling** — the number that matters most on a shared-vCPU VPS.

```json
{
  "service": "pdf-worker", "msg": "vitals",
  "proc_cpu_pct": 182.4,               // % of ONE core; >100 spans cores
  "proc_cpu_pct_of_host": 45.6,
  "event_loop_utilization_pct": 12.1,  // Node starved of CPU if this climbs
  "rss_mb": 112.6, "heap_used_mb": 19.3,
  "container_mem_mb": 154, "container_mem_limit_mb": 1024,
  "host_cores": 4, "host_load1": 3.9,
  "host_cpu_busy_pct": 96.2, "host_cpu_user_pct": 88.1,
  "host_cpu_system_pct": 6.1, "host_cpu_iowait_pct": 0.2,
  "host_cpu_steal_pct": 0.4,           // <- watch this on Hostinger
  "host_mem_total_mb": 16075, "host_mem_free_mb": 9302,
  "active_jobs": 4, "jobs_completed": 812, "jobs_failed": 3,
  "last_render_ms": 402
}
```

The API's vitals line adds queue state: `queue_waiting`, `queue_active`,
`queue_delayed`, `queue_failed`, `queue_pending`, `queue_limit`.

### Other lines worth knowing

| `msg` | Where | Meaning |
| --- | --- | --- |
| `pdf job accepted` | api | Request queued. Has `jobId`, `mode` (async/sync), `html_bytes`, `reused` |
| `job received` | worker | Picked off the queue, with `queue_wait_ms` and `active_jobs` |
| `render started` | worker | HTML loaded, calling Gotenberg |
| `render completed` | worker | Includes `render_bytes_per_s` — falls as the box saturates |
| `slow render` | worker | `render_ms` over `SLOW_RENDER_LOG_MS` (default 10 s), at warn |
| `job failed` | worker | `code`, `retryable`, `will_retry`, `attempt` of `attempts` |
| `request completed` | api | Fastify access log with `responseTime` (off via `LOG_HTTP_REQUESTS=false`) |
| `janitor removed expired objects` | worker | Retention sweep |
| `vitals` | both | The heartbeat above |

Gotenberg's own logs carry our job id, because the worker sends it as
`Gotenberg-Trace` and Gotenberg is configured to use that header as its
correlation id:

```bash
docker compose logs gotenberg | grep pdf_01M0F45K8N
```

Container logs are capped at 20 MB × 5 files per service, so a long load test
cannot fill the disk.

---

## 2. Analysis tools

### `scripts/logreport.mjs` — percentiles from logs

Works on load tests *and* on production traffic, and groups by
`worker_concurrency`, so a single log file covering several settings produces the
comparison directly:

```bash
docker compose logs --no-color --since 1h worker api | node scripts/logreport.mjs
docker compose logs --no-color worker | node scripts/logreport.mjs --csv jobs.csv
```

```
 conc  jobs     span  pdf/s  e2e p50  e2e p95  render p50  render p95  queue p50  queue p95
    1    20       8s   2.59    1.68s    1.98s       0.40s       0.41s      1.27s      1.57s
    2    20       4s   5.34    0.74s    1.14s       0.40s       0.41s      0.33s      0.73s
    4    20       2s   9.87    0.41s    0.73s       0.40s       0.41s      0.00s      0.32s

=== Stage breakdown ===
queue wait         n=60  p50 0.33s  p95 1.54s  max 1.66s
gotenberg render   n=60  p50 0.40s  p95 0.41s  max 0.43s
storage upload     n=60  p50 0.00s  p95 0.00s  max 0.01s

=== Host and process vitals ===
host cpu busy      mean 2.8%  peak 6.2%
host cpu STEAL     mean 0.0%  peak 0.1%
worker rss peak    112.6 MB   proc cpu peak 5.0%   event loop peak 2.9%
queue pending peak 4
```

### `scripts/loadtest.mjs` — drive load, save the run

```bash
node scripts/loadtest.mjs --count 50 --concurrency 10 \
  --tag c2 --out metrics/run-c2.json \
  --url http://localhost:8080 --key "$PDF_API_KEY" --html real-certificate.html
```

`--concurrency` is how many requests the *client* keeps in flight; the server's
render concurrency is `WORKER_CONCURRENCY`. Keep client concurrency well above
the server's so the queue always has work — that is what makes throughput the
measurement rather than the client the bottleneck.

### `scripts/compare-runs.mjs` — the verdict

```bash
node scripts/compare-runs.mjs metrics/run-c1.json metrics/run-c2.json metrics/run-c3.json
```

Prints the side-by-side table plus the step-by-step reading ("throughput +4.2%,
render p95 +54% — not worth it").

### `scripts/sample-host.sh` — CSV of host and container resources

For when you want raw numbers, or to chart CPU steal over a long run. Run it in
a second SSH session for the duration of the test:

```bash
INTERVAL=5 OUT_DIR=metrics TAG=c2 ./scripts/sample-host.sh
# metrics/host-c2.csv        cpu busy/user/system/iowait/steal, load, memory, swap
# metrics/containers-c2.csv  per-container cpu %, memory, pids
```

---

## 3. Prometheus + Grafana (optional)

```bash
docker compose --profile monitoring up -d
ssh -L 3001:localhost:3001 user@your-vps     # Grafana is bound to localhost
# http://localhost:3001 — login from GRAFANA_USER / GRAFANA_PASSWORD
```

The **PDF service** dashboard is provisioned automatically: throughput, render
duration percentiles, queue wait, queue depth, host CPU by mode, a dedicated CPU
steal panel with thresholds, memory and swap, load per core, per-container CPU
and memory (Chromium's real footprint), Node event loop lag, API status codes,
and failures by code.

Metrics come from four scrape targets, all on the private compose network:

| Target | What |
| --- | --- |
| `api:9090/metrics` | Request counts/durations, queue depth, accepted jobs |
| `worker:9091/metrics` | Render/queue-wait/job histograms, active renders, failures by code |
| `node-exporter:9100` | Host CPU (incl. steal), memory, swap, disk, network |
| `cadvisor:8080` | Per-container CPU and memory |

Neither metrics port is published to the host, so nothing is added to the public
surface. Scaling workers (`docker compose up -d --scale worker=3`) is picked up
automatically — Prometheus uses DNS discovery, not static addresses.

To turn the whole thing off: `docker compose --profile monitoring down`, or set
`METRICS_ENABLED=false` to drop the in-process endpoints too.

---

## 4. The procedure

The measurement that matters is your **real certificate HTML**, not the sample.

```bash
# 0. Baseline the machine before deploying anything.
lscpu | head -20 && free -h && df -h
top -bn1 | head -5          # note the "st" column: existing CPU steal

# 1. Set the pair. These two must move together.
#    .env:                WORKER_CONCURRENCY=2
#    docker-compose.yml:  --chromium-max-concurrency=2
docker compose up -d --build api worker gotenberg

# 2. Tighten the heartbeat and lift the limits for the test window.
#    .env: VITALS_INTERVAL_SECONDS=10, RATE_LIMIT_MAX=10000, RATE_LIMIT_READ_MAX=100000

# 3. Sample the host in a second session.
INTERVAL=5 OUT_DIR=metrics TAG=c2 ./scripts/sample-host.sh

# 4. Run it. 50-100 jobs, client concurrency 5-10.
node scripts/loadtest.mjs --count 100 --concurrency 10 \
  --tag c2 --out metrics/run-c2.json \
  --url http://localhost:8080 --key "$PDF_API_KEY" --html real-certificate.html

# 5. Read the run.
docker compose logs --no-color --since 15m worker api | node scripts/logreport.mjs

# 6. Repeat for the next setting, then compare.
node scripts/compare-runs.mjs metrics/run-c2.json metrics/run-c3.json
```

**Gotenberg's concurrency must match the worker's.** If `WORKER_CONCURRENCY=3`
while Gotenberg still runs `--chromium-max-concurrency=1`, the extra jobs queue
*inside* Gotenberg — the wait shows up inside `render_ms` and looks like a slow
renderer rather than a misconfiguration.

Restore `VITALS_INTERVAL_SECONDS` and the rate limits when you are done.

Measure **A-B-A**, not A-B: run the baseline config again at the end. Laptops
throttle and shared vCPUs drift, and the repeat is the only thing that tells you
whether a regression belongs to the config or to the machine. Recorded results
live in `PROGRESS.md` §6.

## 5. Reading the numbers

Stop raising concurrency when any of these appear:

| Signal | Threshold | Meaning |
| --- | --- | --- |
| Throughput gain per step | < 10% | You are at the useful limit |
| Throughput *falling* as concurrency rises | Any | Not contention — contention divides CPU, it does not destroy it. Something added cost: memory pressure and swapping, or the machine drifting (thermal throttling, a noisy neighbour). Check free memory and swap first, then re-run the earlier config to confirm the machine is still comparable |
| `render_ms` p95 | Rising step over step | CPU contention between renders |
| `host_cpu_busy_pct` | > 85% sustained | CPU-bound; more vCPU would help |
| `host_load1` / cores | > 1.0 | Processes queuing for CPU |
| `host_cpu_steal_pct` | 0–3% fine, 3–7% acceptable, 7–15% watch, >15% act | Noisy neighbour — move the VM, do not optimise code |
| `host_cpu_iowait_pct` | > 10% | Disk-bound: storage, not CPU |
| Swap used | Anything sustained | Not enough RAM for this concurrency |
| `event_loop_utilization_pct` (worker) | > 70% | The Node process itself is starved |
| Gotenberg container memory | Approaching the box | Each concurrent Chromium wants a few hundred MB |
| `RENDER_TIMEOUT` failures | Any under load | Renders no longer fit in `RENDER_TIMEOUT_MS` |

**Sizing rules of thumb.** A Chromium render is CPU-bound, so useful concurrency
tracks vCPU count — roughly one render per vCPU, minus one core for the API,
worker, Redis and the OS. Budget 300–500 MB of RAM per concurrent render on top
of ~600 MB for the rest of the stack. If throughput is flat while CPU sits at
100% and steal is low, more vCPU is the fix; if steal is high, a different host
is the fix.

**Keep the evidence.** Commit nothing from `metrics/` (it is gitignored), but
keep the run JSON files somewhere — the next sizing decision is much easier when
you can compare against the numbers from the last one.
