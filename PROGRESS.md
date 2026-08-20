# PDF service — build progress and local test plan

Status of the build against the 18-phase plan, the decisions taken along the
way, an honest answer on what the monitoring stack costs, and the exact commands
to test everything on your machine.

- **Branch:** `claude/pdf-gotenberg-architecture-ezi3q9`
- **Commits:** `266da86` service · `0e67bb3` rate-limit split · `098dc2b` observability
- **Runtime:** Node 22, TypeScript (strict), Fastify 5, BullMQ 5, Gotenberg 8.36 Chromium
- **Shape:** one repo, one `package.json`, one Docker image, two processes

---

## 1. Where this stands

| Phase | What it was | Status |
| --- | --- | --- |
| 1 | Project, pnpm, TypeScript, structure | **Done** |
| 2 | Fastify API, `/health`, logging, graceful shutdown | **Done** |
| 3 | Dockerfile, docker-compose | **Done** (image unbuilt here — no Docker daemon in my environment) |
| 4 | Gotenberg in compose, private network only | **Done** — the temporary `/internal/test-render` was skipped; the real endpoints from phase 8 supersede it |
| 5 | Render a real certificate | **Yours** — needs your production HTML; a realistic sample is included |
| 6 | Redis + BullMQ | **Done** (with one deviation, see §3) |
| 7 | Worker with timeouts, retries, structured logs | **Done** |
| 8 | Async API: `POST /v1/pdf`, `GET /v1/jobs/:id` | **Done** |
| 9 | Bearer API-key auth, timing-safe compare | **Done** |
| 10 | Request/render/output limits, queue capacity | **Done** |
| 11 | `POST /v1/pdf/sync` (still through the queue) | **Done** |
| 12 | Cloudflare R2 object storage | **Done** — driver verified against a fake S3; needs one run with real credentials |
| 13 | Idempotency keys | **Done** |
| 14 | Local load testing | **Done** — C2 chosen and committed as the default; numbers in §6, procedure in §5.5 |
| 15 | Hostinger VPS | Not started |
| 16 | Manual first deploy | Not started |
| 17 | Cloudflare Tunnel | Not started |
| 18 | CI/CD | Not started |
| — | Observability (not in the original plan) | **Done** — added for the CPU-sizing work |

---

## 2. What is in the repo

```
src/
  api/
    server.ts          entrypoint: listen, metrics, vitals, graceful shutdown
    app.ts             Fastify wiring: auth order, rate limits, error handler
    context.ts         Redis / queue / storage / renderer, created once
    jobs.service.ts    stage HTML, enqueue, job views, sync wait, failure→HTTP mapping
    idempotency.ts     Idempotency-Key reservations in Redis
    pdf-reply.ts       streams a stored PDF back with the right headers
    plugins/auth.ts    bearer keys, constant-time comparison
    routes/            pdf.ts (render), jobs.ts (status/download), health.ts
  worker/
    worker.ts          BullMQ worker: timing breakdown, retry classification, metrics
    janitor.ts         retention sweep for expired PDFs and inputs
  queue/               Redis connections, queue definition, job contracts
  renderer/gotenberg.ts  Chromium client: timeout, output cap, error classification
  storage/             local disk + R2/S3 drivers behind one interface
  config/index.ts      every env var, validated at boot
  shared/              ids, errors, logger, PDF option contract, metrics, vitals
scripts/               smoke.sh, loadtest.mjs, logreport.mjs, compare-runs.mjs,
                       sample-host.sh, sample-certificate.html
observability/         prometheus.yml, Grafana provisioning + dashboard
docs/observability.md  every log field, the load-test procedure, sizing thresholds
```

### The API

| Route | Auth | Behaviour |
| --- | --- | --- |
| `POST /v1/pdf` | yes | Stages HTML, enqueues, returns `202` + job id (`200` on an idempotent replay) |
| `POST /v1/pdf/sync` | yes | Same, then waits; returns the PDF, or `202` + job id after `SYNC_TIMEOUT_MS` |
| `GET /v1/jobs/:id` | yes | `queued` / `active` / `completed` / `failed`, timings, error code |
| `GET /v1/jobs/:id/pdf` | yes | Streams the PDF |
| `GET /health` | no | Liveness — for Docker and the proxy |
| `GET /ready` | no | Pings Redis and Gotenberg |

Renders never bypass the queue: the worker is the only thing that talks to
Gotenberg, so concurrency is controlled in exactly one place.

### What protects the box

- Body limit before auth (`MAX_REQUEST_BYTES`), HTML limit before enqueue
  (`MAX_HTML_BYTES`), output cap enforced while streaming (`MAX_PDF_BYTES`).
- Queue capacity guard: `503 QUEUE_FULL` at `MAX_QUEUED_JOBS` instead of an
  unbounded backlog.
- Per-key rate limits, split: `RATE_LIMIT_MAX` (60/min) for renders,
  `RATE_LIMIT_READ_MAX` (600/min) for status polls.
- Retry classification: `RENDER_REJECTED` (bad document) fails immediately;
  `RENDERER_ERROR` / `RENDER_TIMEOUT` retry with backoff.
- Gotenberg: private-IP blocking (SSRF), `downloadFrom` and webhooks disabled,
  Chromium recycled every 50 renders, no published port.
- Retention: PDFs 1 h, failed-job inputs 24 h, swept by the janitor.

---

## 3. Decisions that differ from the plan

1. **HTML is staged in object storage, not carried in the Redis job.** Phase 6
   allowed inline HTML for v1; the job now holds a key instead. Redis stays a
   small control plane and there is no migration to do later.
2. **Gotenberg is configured with CLI flags, not env vars.** The names in the
   plan (`CHROMIUM_DENY_PRIVATE_IPS`, `API_DISABLE_DOWNLOAD_FROM`, …) are
   Gotenberg 7 style. Version 8 takes `--chromium-deny-private-ips`,
   `--chromium-max-concurrency`, `--api-disable-download-from`,
   `--webhook-disable`, `--chromium-restart-after`. Flags taken from upstream's
   own compose file; image pinned to `gotenberg/gotenberg:8.36-chromium`.
3. **Reads have their own rate limit.** The first load test failed 22 of 25 jobs
   on 429s because status polling shared the render budget. Polling is what
   clients are told to do, so it now has its own allowance.
4. **Metrics live on private ports.** `api:9090/metrics` and
   `worker:9091/metrics` are not published to the host, so the public API surface
   gained nothing and no auth layer was needed for them.
5. **JavaScript stays enabled** in Chromium, as you asked, and storage defaults
   to `local` so the stack runs with no cloud credentials; `STORAGE_DRIVER=r2`
   is one env change.

---

## 4. "Won't Prometheus and Grafana slow the whole thing down?"

Short answer: **the in-process part is free; the containers are not, and one of
them can distort the very measurement you are taking.**

### In-process (always on, `METRICS_ENABLED=true`)

Measured on this codebase (`node --version` 22, one core):

| What | Cost | As a share of one core |
| --- | --- | --- |
| All metrics recorded per render (8 observations) | **1.8 µs** | 0.0004 % at 2 renders/s |
| A Prometheus scrape rendering the whole registry (16 KiB, 267 lines) | **1.05 ms** | 0.01 % at one scrape / 10 s |
| One `vitals` heartbeat (reads `/proc/stat`, cgroup files, `memoryUsage`) | **18 µs** | 0.00006 % at one / 30 s |

A render takes ~400–2000 ms of Chromium CPU. The instrumentation costs about two
millionths of that. Nothing is in the request path: no blocking I/O, no extra
Redis writes — the one Redis call is `getJobCounts`, made only when Prometheus
scrapes, and only by the API. Metrics are pull-based, so with nothing scraping,
the cost is the 1.8 µs per render and nothing else.

The larger cost of observability is actually **log volume**: roughly 1.5 KB per
render across five lines, so ~260 MB/day at 2 renders/s. Docker rotation caps it
at 100 MB per service (20 MB × 5). If disk churn ever matters, the knobs are
`LOG_HTTP_REQUESTS=false` and `VITALS_INTERVAL_SECONDS=60`.

### The monitoring containers (off by default)

Typical steady-state footprint — estimates, not measured here:

| Container | RAM | CPU | Verdict |
| --- | --- | --- | --- |
| Prometheus (15 d retention, this cardinality) | ~150–250 MB | low | Fine |
| Grafana (idle, dashboard open occasionally) | ~100–200 MB | low | Fine |
| node-exporter | ~15–30 MB | negligible | Keep — it is where CPU steal comes from |
| **cAdvisor** | ~100–200 MB | **2–10 % of a core, sometimes more** | The one to watch |

cAdvisor walks every cgroup on each scrape. On your KVM 4 (4 vCPU / 16 GB) that
is affordable, but during a **precision** load test it is an observer effect: it
takes CPU from Chromium and slightly worsens the numbers you are measuring.

### How I would run it

- **Always:** logs + in-process metrics. Free, and enough to size the machine.
- **During a load test where the numbers must be clean:** logs +
  `scripts/logreport.mjs` + `scripts/sample-host.sh` (a `docker stats` loop,
  nothing resident). Leave the monitoring profile down.
- **For trends over days/weeks:** `docker compose --profile monitoring up -d`,
  and drop cAdvisor from the profile if you want to be strict — the Gotenberg
  container memory it gives you is genuinely useful, though.
- **On a 2 GB box:** don't run the monitoring stack permanently; ~500 MB is real
  money there. Bring it up for an investigation, then `--profile monitoring down`.

Nothing in the service depends on any of it. `METRICS_ENABLED=false` removes even
the two metrics servers, and the service behaves identically.

---

## 5. What to test locally

Prerequisites: Docker Desktop running, Node 22 for the scripts. Commands are
written for Git Bash on Windows, which is what you are using.

### 5.0 First boot

```bash
cp .env.example .env

# generate a key, then paste it as the PDF_API_KEY value in .env
# (replace the pdf_sk_replace_me placeholder - do not add a second line)
echo "pdf_sk_$(openssl rand -hex 24)"

docker compose up -d --build
docker compose ps                      # api, worker, redis, gotenberg all Up
export PDF_API_KEY=pdf_sk_…            # the key you just pasted into .env
```

**Expect:** four containers up, `api` healthy within ~15 s.

```bash
curl http://localhost:8080/health      # {"status":"ok","uptime_seconds":…}
curl http://localhost:8080/ready       # {"status":"ok","checks":{"redis":true,"gotenberg":true},…}
```

If `ready` reports `gotenberg: false`, check `docker compose logs gotenberg` for
an unknown-flag error — that is the one thing in the compose file I could not
execute here.

### 5.1 The automated smoke test

```bash
./scripts/smoke.sh
```

**Expect:** health, ready, a `401` for the unauthenticated call, a PDF from
`/v1/pdf/sync`, then an async job polled to `completed` and downloaded. Two files
in `out/`, identical in size — the same certificate rendered through both paths.
That duplication is intentional, and matching bytes is the useful signal.

### 5.2 API behaviour

Run these one at a time; each prints the status code on the last line.

```bash
AUTH="authorization: Bearer $PDF_API_KEY"; CT='content-type: application/json'
API=http://localhost:8080

# 1. no key -> 401 UNAUTHORIZED
curl -sS -w '\n%{http_code}\n' -X POST $API/v1/pdf -H "$CT" -d '{"html":"<p>x</p>"}'

# 2. wrong key -> 401
curl -sS -w '\n%{http_code}\n' -X POST $API/v1/pdf -H 'authorization: Bearer nope' -H "$CT" -d '{"html":"<p>x</p>"}'

# 3. unknown option -> 400 VALIDATION_ERROR (names the bad property)
curl -sS -w '\n%{http_code}\n' -X POST $API/v1/pdf -H "$AUTH" -H "$CT" -d '{"html":"<p>x</p>","options":{"nope":1}}'

# 4. missing html -> 400 VALIDATION_ERROR
curl -sS -w '\n%{http_code}\n' -X POST $API/v1/pdf -H "$AUTH" -H "$CT" -d '{}'

# 5. bad job id -> 400 INVALID_JOB_ID ; unknown job -> 404 JOB_NOT_FOUND
curl -sS -w '\n%{http_code}\n' $API/v1/jobs/nonsense -H "$AUTH"
curl -sS -w '\n%{http_code}\n' $API/v1/jobs/pdf_01ZZZZZZZZZZZZZZZZZZZZZZZZ -H "$AUTH"

# 6. sync render straight to a file -> 200, application/pdf
curl -sS -X POST $API/v1/pdf/sync -H "$AUTH" -H "$CT" \
  -d '{"html":"<h1>Hello world</h1>","filename":"hello.pdf"}' --output hello.pdf
```

Idempotency — the same key twice, then a different payload:

```bash
curl -sS -X POST $API/v1/pdf -H "$AUTH" -H "$CT" -H 'Idempotency-Key: cert-1-v1' \
  -d '{"html":"<p>one</p>"}'                     # 202, "reused": false
curl -sS -X POST $API/v1/pdf -H "$AUTH" -H "$CT" -H 'Idempotency-Key: cert-1-v1' \
  -d '{"html":"<p>one</p>"}'                     # 200, "reused": true, same id
curl -sS -X POST $API/v1/pdf -H "$AUTH" -H "$CT" -H 'Idempotency-Key: cert-1-v1' \
  -d '{"html":"<p>two</p>"}'                     # 409 IDEMPOTENCY_CONFLICT
```

Size limits (note which limit fires where):

```bash
# ~5.5 MB of HTML: over MAX_HTML_BYTES but under the body limit -> 400 VALIDATION_ERROR
node -e 'console.log(JSON.stringify({html:"<p>"+"x".repeat(5.5e6)+"</p>"}))' > big.json
curl -sS -w '\n%{http_code}\n' -X POST $API/v1/pdf -H "$AUTH" -H "$CT" --data-binary @big.json | tail -3

# ~7 MB body: over MAX_REQUEST_BYTES -> 413 REQUEST_TOO_LARGE, rejected before auth
node -e 'console.log(JSON.stringify({html:"<p>"+"x".repeat(7e6)+"</p>"}))' > huge.json
curl -sS -w '\n%{http_code}\n' -X POST $API/v1/pdf -H "$AUTH" -H "$CT" --data-binary @huge.json | tail -3
rm big.json huge.json
```

Rate limit (61 renders in a minute):

```bash
for i in $(seq 1 61); do
  curl -sS -o /dev/null -w "$i:%{http_code} " -X POST $API/v1/pdf -H "$AUTH" -H "$CT" -d '{"html":"<p>rl</p>"}'
done; echo
```

**Expect:** `202` up to 60, then `429` with a `Retry-After` header. Status polls
are on a separate 600/min budget, so polling never causes this.

### 5.3 The real certificate (phase 5 — the important one)

```bash
# your production HTML, saved locally as certificate.html
node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({filename:"cert.pdf",html:fs.readFileSync("certificate.html","utf8"),options:{format:"A4",printBackground:true,margin:{top:"12mm",bottom:"14mm",left:"12mm",right:"12mm"}}}))' > cert.json
curl -sS -X POST $API/v1/pdf/sync -H "$AUTH" -H "$CT" --data-binary @cert.json --output cert.pdf
```

Then open `cert.pdf` and check, against what your current renderer produces:
fonts (including web fonts), logos and images, table borders and shading, page
size, margins, background colours, page breaks (no rows split across pages),
headers/footers, and total page count.

Timing and size come from the logs:

```bash
docker compose logs --no-color worker | grep '"msg":"job completed"' | tail -1
```

If a web font or a CDN image is missing, the cause is almost always the
`--chromium-deny-private-ips` guard blocking a private host, or the resource
needing more settle time — try `"options":{"waitDelayMs":500}` or
`"waitForExpression":"window.renderReady === true"`.

### 5.4 Observability

```bash
# live logs
docker compose logs -f worker

# the timing breakdown of one render, pretty-printed
docker compose logs --no-color worker | grep '"msg":"job completed"' | tail -1 \
  | node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync(0,'utf8').replace(/^[^{]*/,'')),null,2))"

# the heartbeat: process CPU/RSS/event loop + host CPU incl. steal + queue depth
docker compose logs --no-color worker api | grep '"msg":"vitals"' | tail -2

# percentile report, grouped by worker concurrency, from the logs alone
docker compose logs --no-color --since 30m worker api | node scripts/logreport.mjs

# metrics endpoints (private ports, so ask from inside the network)
docker compose exec api wget -qO- http://127.0.0.1:9090/metrics | grep '^pdf_' | head
docker compose exec worker wget -qO- http://127.0.0.1:9091/metrics | grep '^pdf_jobs_total'
```

**Note for Windows:** the `host_cpu_*` fields in `vitals` describe the Docker
Desktop Linux VM, not Windows itself — useful for relative comparisons locally,
authoritative only on the VPS. `scripts/sample-host.sh` reads `/proc/stat` and so
is a Linux/VPS tool; use `docker stats` locally instead.

Optional dashboards:

```bash
docker compose --profile monitoring up -d
docker compose exec api wget -qO- http://prometheus:9090/api/v1/targets | grep -o '"health":"[a-z]*"' | sort | uniq -c
# open http://localhost:3001  (login from GRAFANA_USER / GRAFANA_PASSWORD in .env)
docker compose --profile monitoring down          # when finished
```

**Expect:** four scrape targets healthy (`pdf-api`, `pdf-worker`, `node`,
`cadvisor`) and the "PDF service" dashboard already present in Grafana.

### 5.5 Concurrency and load

The pair must move together — worker concurrency and Chromium concurrency:

```bash
# .env:                WORKER_CONCURRENCY=2
# docker-compose.yml:  --chromium-max-concurrency=2
# .env (test window):  VITALS_INTERVAL_SECONDS=10, RATE_LIMIT_MAX=10000, RATE_LIMIT_READ_MAX=100000
docker compose up -d --build api worker gotenberg

node scripts/loadtest.mjs --count 100 --concurrency 10 \
  --tag c2 --out metrics/run-c2.json \
  --url http://localhost:8080 --key "$PDF_API_KEY" --html certificate.html

docker compose logs --no-color --since 15m worker api | node scripts/logreport.mjs
```

Repeat for C=3, then:

```bash
node scripts/compare-runs.mjs metrics/run-c2.json metrics/run-c3.json
```

The committed defaults are already 2/2, from the 100-job runs recorded in §6.
When you re-measure — on the VPS, or after changing the certificate template —
run **A-B-A** (C2, C3, then C2 again) rather than A-B. A laptop or a noisy VPS
neighbour can drift between runs, and the repeat is what tells you whether a
regression is the config or the machine.

Stop raising concurrency when throughput gains drop below ~10 %, `render_ms` p95
starts rising step over step, host CPU sits above 85 %, load per core passes 1.0,
or swap moves. Full threshold table in `docs/observability.md`.

### 5.6 R2 (needs your credentials)

```bash
# .env
# STORAGE_DRIVER=r2
# R2_BUCKET=…  R2_ACCOUNT_ID=…  R2_ACCESS_KEY_ID=…  R2_SECRET_ACCESS_KEY=…  R2_PRESIGN=true
docker compose up -d api worker
./scripts/smoke.sh
curl -sS $API/v1/jobs/<job-id> -H "$AUTH"      # result.download_url should be a presigned URL
```

**Expect:** `jobs/<jobId>/output.pdf` in the bucket, no `input.html` left behind
(deleted after conversion), and the presigned URL downloading the PDF directly
without touching the API.

### 5.7 Failure drills

These are worth doing once — they are the behaviours you will rely on in
production.

```bash
# Renderer down mid-flight: retryable failure, retried once, then reported
docker compose stop gotenberg
curl -sS -X POST $API/v1/pdf -H "$AUTH" -H "$CT" -d '{"html":"<p>fail</p>"}'
sleep 8 && curl -sS $API/v1/jobs/<job-id> -H "$AUTH"     # failed, RENDERER_UNAVAILABLE, attempts 2
docker compose start gotenberg

# Queue capacity: set MAX_QUEUED_JOBS=2 in .env, restart the api, stop the worker
docker compose up -d api && docker compose stop worker
for i in 1 2 3; do curl -sS -o /dev/null -w "$i:%{http_code} " -X POST $API/v1/pdf -H "$AUTH" -H "$CT" -d '{"html":"<p>q</p>"}'; done; echo
docker compose start worker                              # backlog drains

# Redis restart: appendonly is on, so queued jobs survive
docker compose restart redis
curl -sS $API/ready                                      # back to ok

# Graceful drain: give in-flight renders time to finish
docker compose stop -t 60 worker                         # log: "shutting down" then "worker stopped"

# Retention: set PDF_TTL_SECONDS=60 and JANITOR_INTERVAL_SECONDS=30 in .env,
# then `docker compose up -d api worker`, render one PDF and wait

# 60-120 s after completion  -> 410 PDF_EXPIRED
# beyond ~120 s              -> 404 JOB_NOT_FOUND (the job record expires too)
```

### 5.8 Cleanup

```bash
docker compose down                  # keeps volumes
docker compose down -v               # also wipes PDFs and Redis
rm -rf out metrics *.pdf cert.json
```

Remember to restore `.env` after the test window: `VITALS_INTERVAL_SECONDS=30`,
`RATE_LIMIT_MAX=60`, `RATE_LIMIT_READ_MAX=600`, `PDF_TTL_SECONDS=3600`.

---

## 6. Benchmark log

Baseline numbers to compare future runs against — especially the first runs on
the VPS. Environment matters as much as the config, so it is recorded per run.

### Run A — sample certificate, 25 jobs, client concurrency 5

Docker Desktop (Windows), `scripts/sample-certificate.html`. **Caveat:** it is
not confirmed that `--chromium-max-concurrency` was raised in step with
`WORKER_CONCURRENCY` for the C3/C4 rows, so those two may reflect surplus jobs
queuing inside Gotenberg rather than true parallel rendering.

| Metric | C1 | C2 | C3 | C4 |
| --- | --: | --: | --: | --: |
| Throughput (pdf/s) | 0.93 | 1.48 | **1.56** | 1.56 |
| Wall clock | 26.98s | 16.84s | **16.02s** | 16.04s |
| E2E p50 | 4.90s | 3.21s | 3.02s | **2.70s** |
| E2E p95 | 6.87s | **3.90s** | 4.99s | 5.38s |
| Render p50 | **0.94s** | 1.42s | 1.71s | 2.11s |
| Render p95 | 1.80s | **1.67s** | 2.64s | 4.04s |
| Queue p50 | 4.13s | 1.92s | 1.16s | **0.51s** |
| Queue p95 | 5.57s | 2.87s | 3.24s | **2.43s** |
| Failures | 0 | 0 | 0 | 0 |

Reading: throughput flattens from C3 onwards while the render tail keeps
growing. C4 buys nothing.

### Run B — real certificate, 100 jobs, client concurrency 10

Docker Desktop (Windows), production certificate HTML, both knobs confirmed set
together.

| Metric | C2 | C3 | C3 vs C2 |
| --- | --: | --: | --: |
| Jobs / failures | 100 / 0 | 100 / 0 | same |
| Wall clock | **57.28s** | 78.48s | +37% |
| Throughput (pdf/s) | **1.746** | 1.274 | **−27%** |
| E2E p50 | **5.21s** | 7.53s | +45% |
| E2E p95 | **7.93s** | 14.76s | +86% |
| E2E max | **10.83s** | 16.57s | +53% |
| Render p50 | **0.97s** | 2.03s | +110% |
| Render p95 | **2.54s** | 4.08s | +61% |
| Render max | **3.56s** | 8.33s | +134% |
| Queue p50 | **4.17s** | 4.93s | +18% |
| Queue p95 | **6.40s** | 11.78s | +84% |

**Decision: C2 on this machine**, and that is now the committed default
(`WORKER_CONCURRENCY=2`, `--chromium-max-concurrency=2`).

**Reading, and why it is not simply saturation.** Contention divides CPU; it
does not destroy it. Had the VM merely been CPU-bound at C2, a third render
would have split the same CPU three ways — each render slower, total throughput
flat:

```
C2   2 in flight / 0.97s = 2.06/s ideal  →  1.746/s measured (85%: queue + storage overhead)
C3   fair sharing predicts render ≈ 1.46s and throughput ≈ 2.06/s (flat)
     measured: render 2.03s, throughput 1.274/s
```

Roughly 39% more cost per render appeared than fair sharing accounts for, so
something *added* work rather than dividing it. Candidates, untested:

1. **Memory pressure in the Docker Desktop VM** — three Chromiums plus the stack
   against a VM memory cap. Throughput going backwards is the classic signature.
2. **Thermal throttling / order effect** — C3 ran after C2 on a warm laptop. An
   A-B-A re-run (`--tag c2-repeat`) settles this; if the repeat lands near
   1.75/s the regression is real, if near 1.4/s the comparison is partly an
   artifact of the machine heating up.
3. **Mid-run Chromium restarts** — `--chromium-restart-after=50` fires once or
   twice during a 100-job run, which explains the 8.33s outliers but not the
   doubled median.

### Open questions for the VPS runs

- Cores or memory? The `vitals` host section (`host_cores`,
  `host_cpu_busy_pct`, `host_mem_free_mb`, swap) answers it directly; on
  4 vCPU / 16 GB the memory ceiling that likely bit locally should disappear.
- `--chromium-auto-start=true` — Gotenberg starts a browser per conversion by
  default; keeping one warm may return a slice of the 0.97s p50 at every
  concurrency. Worth one A/B, magnitude unknown.
- `--chromium-restart-after=200` (or `0`) for a clean tail measurement.
- Watch `host_cpu_steal_pct` from the first run: on shared-vCPU hosting it can
  make a good config look bad for reasons no code change will fix.

Expect the VPS to start at 2 and be re-tested at 3 and 4 with the same 100-job
workload — per-render cost is roughly one core-second, so a 4-vCPU box should
manage about three concurrent renders once a core is left for the API, worker,
Redis and the OS.

### Adding a row

```bash
node scripts/loadtest.mjs --count 100 --concurrency 10 \
  --tag <host>-c<N> --out metrics/run-<host>-c<N>.json \
  --url http://localhost:8080 --key "$PDF_API_KEY" --html certificate.html
docker compose logs --no-color --since 15m worker api | node scripts/logreport.mjs
node scripts/compare-runs.mjs metrics/run-*.json
```

Record the machine, the workload, both concurrency knobs, and the host section
of the report — a throughput number without its environment is not comparable.

## 7. Verification status

Verified by running it (Linux dev container, real Redis, a stub Gotenberg, a stub
S3, and the compiled `dist/` output — not `tsx`):

- async enqueue → poll → download; sync render; sync timeout returning `202`
- auth rejection, schema validation, both size limits, invalid/unknown job ids
- idempotent replay, payload conflict, replay of an already-completed job
- retryable failure retried twice; `RENDER_REJECTED` failing without burning an
  attempt; failure codes surfacing in status, download and metrics
- `QUEUE_FULL` backpressure; separate read/write rate limits; `429` shape and
  `Retry-After`
- input HTML deleted after success, kept on failure; janitor TTL pruning
- R2 driver: put, get, stream, presign with content-disposition, delete,
  per-suffix TTL prune; plus a full render end-to-end with `STORAGE_DRIVER=r2`
- graceful shutdown on SIGTERM for both processes
- metrics on both ports, the vitals heartbeat, `logreport.mjs`,
  `compare-runs.mjs` across three tagged runs, `sample-host.sh`
- `docker compose config` valid for the default and `monitoring` profiles;
  all YAML and the dashboard JSON parse

Not provable without a Docker daemon — this is what your local run adds:

- the image actually building (`pnpm install --frozen-lockfile`, `tsc`, Alpine)
- Gotenberg accepting the exact flag set, and real Chromium output fidelity
- the monitoring containers starting and the dashboard populating
- real render timings and memory under real certificates

---

## 8. Next steps, in order

1. **Phase 5 properly** — real certificates through `/v1/pdf/sync`, compared
   against the current renderer.
2. **Settle concurrency** — C=2 vs C=3 with both knobs aligned, using
   `logreport` and `compare-runs`.
3. **Phase 15–16** — Hostinger KVM 4, Ubuntu 24.04, Docker, firewall, first
   manual deploy; record CPU steal from day one.
4. **Phase 17** — Cloudflare Tunnel, then close the public port.
5. **Phase 18** — GitHub Actions building to GHCR, deploy by SHA.

Candidates after that, none of them urgent: an API-key table with per-key limits
once there is more than one consumer, `POST /v1/pdf/url` for rendering a page by
URL, a webhook callback on completion, and PDF/A output if certificates ever need
archival format.
