# pdf-service

HTML → PDF as a small, boring service: a Fastify API, a Redis/BullMQ queue, a
worker, and Gotenberg (Chromium). One repository, one Docker image, two Node
processes.

```
        client
          │  Authorization: Bearer pdf_sk_…
          ▼
   ┌──────────────┐      ┌─────────┐      ┌──────────────┐      ┌────────────┐
   │  Fastify API │ ───▶ │  Redis  │ ───▶ │  PDF worker  │ ───▶ │  Gotenberg │
   │  :8080       │      │ BullMQ  │      │ concurrency 1│      │  Chromium  │
   └──────┬───────┘      └─────────┘      └──────┬───────┘      └────────────┘
          │                                       │
          │            object storage             │
          └───────────  local volume  ◀───────────┘
                          or R2
```

Only the API listens on a published port. Redis, the worker and Gotenberg have
no host ports at all — they are reachable only on the compose network.

## Why the queue is not optional

Gotenberg has its own internal queue, and this service still keeps BullMQ in
front of it. They solve different problems: Gotenberg's queue protects Chromium,
BullMQ gives *the application* durable job state, retries, job ids, backpressure
and a horizontal-scaling story. Nothing but the worker is allowed to talk to
Gotenberg, so render concurrency is controlled in exactly one place — including
for the synchronous endpoint, which queues like everything else and then waits.

## Quick start

```bash
cp .env.example .env
echo "PDF_API_KEY=pdf_sk_$(openssl rand -hex 24)" >> .env   # replace the placeholder
docker compose up --build
```

Then:

```bash
curl http://localhost:8080/health
curl http://localhost:8080/ready       # also checks Redis and Gotenberg

export PDF_API_KEY=pdf_sk_…            # the value from .env
./scripts/smoke.sh                     # renders scripts/sample-certificate.html
```

`scripts/smoke.sh` exercises health, auth rejection, the synchronous endpoint,
and the async enqueue → poll → download path, writing PDFs into `out/`.

### Running the Node processes outside Docker

Useful while iterating: keep Redis and Gotenberg in containers, run the API and
worker with `tsx`.

```bash
docker compose up -d redis gotenberg
# one-off: publish ports for local use
#   docker compose run --rm --service-ports gotenberg
pnpm install
REDIS_URL=redis://127.0.0.1:6379 GOTENBERG_URL=http://127.0.0.1:3000 \
  STORAGE_DRIVER=local STORAGE_LOCAL_DIR=./data/jobs \
  PDF_API_KEY=pdf_sk_dev pnpm dev:api
# in a second shell, same env:
… pnpm dev:worker
```

Note that `docker-compose.yml` deliberately does not publish Redis or Gotenberg
ports. For local development either add a temporary `ports:` entry or use
`docker compose run --service-ports`.

## API

All routes except `/health` and `/ready` require:

```
Authorization: Bearer pdf_sk_…
```

Keys are compared in constant time. `PDF_API_KEY` holds one key;
`PDF_API_KEYS=label:secret,other:secret` holds several, and the label appears in
logs and is what the rate limiter counts against. There is no key database yet —
that is a deliberate MVP choice.

### `POST /v1/pdf` — enqueue a render

```bash
curl -X POST http://localhost:8080/v1/pdf \
  -H "Authorization: Bearer $PDF_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: certificate-4871-v1' \
  -d '{
    "html": "<html><body><h1>Hello</h1></body></html>",
    "filename": "certificate-4871.pdf",
    "options": { "format": "A4", "printBackground": true,
                 "margin": { "top": "12mm", "bottom": "14mm" } }
  }'
```

`202 Accepted`:

```json
{
  "id": "pdf_01M0EZKPYVZFWG99WFS2741KG5",
  "status": "queued",
  "created_at": "2026-03-14T09:12:31.204Z",
  "started_at": null,
  "finished_at": null,
  "attempts": 0,
  "status_url": "/v1/jobs/pdf_01M0EZKPYVZFWG99WFS2741KG5",
  "pdf_url": null,
  "result": null,
  "error": null,
  "reused": false
}
```

A replayed `Idempotency-Key` returns `200` with `"reused": true` and the original
job. The same key with a different payload is a `409 IDEMPOTENCY_CONFLICT`.

### `GET /v1/jobs/:id` — job status

`status` is one of `queued`, `active`, `completed`, `failed`. When completed:

```json
{
  "id": "pdf_01M0EZKPYVZFWG99WFS2741KG5",
  "status": "completed",
  "attempts": 1,
  "pdf_url": "/v1/jobs/pdf_01M0EZKPYVZFWG99WFS2741KG5/pdf",
  "result": {
    "bytes": 184223,
    "render_ms": 812,
    "total_ms": 921,
    "expires_at": "2026-03-14T10:12:33.007Z",
    "download_url": null
  },
  "error": null
}
```

`download_url` is a presigned URL when `STORAGE_DRIVER=r2` and `R2_PRESIGN=true`,
letting clients skip the API for the download. Otherwise it is `null` and
`pdf_url` is the way to fetch the file.

### `GET /v1/jobs/:id/pdf` — download

Streams `application/pdf`. `409 JOB_NOT_READY` while queued or active,
`410 PDF_EXPIRED` after the TTL, and the render failure (e.g. `422
RENDER_REJECTED`) if the job failed.

### `POST /v1/pdf/sync` — enqueue and wait

Same body as `POST /v1/pdf`. Returns the PDF directly on success:

```bash
curl -X POST http://localhost:8080/v1/pdf/sync \
  -H "Authorization: Bearer $PDF_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"html":"<h1>Hello world</h1>"}' \
  --output hello.pdf
```

If the render outlives `SYNC_TIMEOUT_MS` (default 25 s) the request returns
`202` with the job id instead of holding the connection open — the job keeps
going and can be polled. Set `SYNC_ENABLED=false` to remove the route.

### PDF options

| Option | Type | Notes |
| --- | --- | --- |
| `format` | `A3` `A4` `A5` `Letter` `Legal` `Tabloid` `Ledger` | Default `A4` |
| `paperWidth` / `paperHeight` | number \| string | Overrides `format`. Number = inches, string carries a unit (`"210mm"`) |
| `margin.{top,right,bottom,left}` | number \| string | Same unit rules |
| `landscape` | boolean | |
| `printBackground` | boolean | Default `true` |
| `omitBackground` | boolean | Transparent background |
| `preferCssPageSize` | boolean | Honour `@page` size from the document |
| `singlePage` | boolean | One tall page, no pagination |
| `scale` | number | 0.1 – 2 |
| `pageRanges` | string | e.g. `"1-3"` |
| `emulatedMediaType` | `print` \| `screen` | Default `print` |
| `waitDelayMs` | integer | Extra settle time before printing, ≤ 15000 |
| `waitForExpression` | string | JS expression Chromium waits to become true |
| `skipNetworkIdleEvent` | boolean | |
| `failOnConsoleExceptions` | boolean | Fail the render on a JS error |
| `failOnHttpStatusCodes` | number[] | Fail when a resource returns these |
| `generateDocumentOutline` | boolean | PDF bookmarks from headings |
| `generateTaggedPdf` | boolean | Accessibility tags |
| `headerHtml` / `footerHtml` | string | Full HTML documents; Gotenberg's page-number classes work |
| `metadata` | object | Written into the PDF metadata |

JavaScript is **enabled** — charts and client-rendered templates work. Remote
resources (`<img>`, `<link>`, `<script>` pointing at a CDN) are fetched by
Chromium itself, so there is no need to inline them.

### Errors

Every error has the same shape:

```json
{ "error": { "code": "RENDER_REJECTED", "message": "…", "details": { } } }
```

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Body failed schema validation |
| 400 | `INVALID_JOB_ID` | Not a `pdf_…` id |
| 401 | `UNAUTHORIZED` | Missing or wrong API key |
| 404 | `JOB_NOT_FOUND` | Unknown or expired job |
| 409 | `JOB_NOT_READY` | PDF requested while still rendering |
| 409 | `IDEMPOTENCY_CONFLICT` | Key reused with a different payload |
| 410 | `PDF_EXPIRED` / `INPUT_MISSING` | Artefact passed its TTL |
| 413 | `REQUEST_TOO_LARGE` / `HTML_TOO_LARGE` / `PDF_TOO_LARGE` | Size limits |
| 422 | `RENDER_REJECTED` | Chromium could not render the document (not retried) |
| 429 | `RATE_LIMITED` | Per-key rate limit; see `Retry-After` |
| 502 | `RENDERER_ERROR` / `RENDERER_UNAVAILABLE` | Gotenberg failed or is down (retried) |
| 503 | `QUEUE_FULL` | `MAX_QUEUED_JOBS` reached — backpressure, retry later |
| 504 | `RENDER_TIMEOUT` | Render exceeded `RENDER_TIMEOUT_MS` (retried) |

Retryable failures (`RENDERER_*`, `RENDER_TIMEOUT`) use up the job's attempts
with exponential backoff. Non-retryable ones (`RENDER_REJECTED`,
`PDF_TOO_LARGE`, `INPUT_MISSING`) fail immediately without burning attempts.

## Configuration

Everything is environment driven; see `.env.example` for the annotated list. The
values worth knowing:

| Variable | Default | Notes |
| --- | --- | --- |
| `WORKER_CONCURRENCY` | `1` | Renders in flight per worker process |
| `RENDER_TIMEOUT_MS` | `30000` | Client-side timeout on the Gotenberg call |
| `MAX_HTML_BYTES` | `5242880` | Rejected before anything is queued |
| `MAX_REQUEST_BYTES` | `6291456` | Fastify body limit, checked before auth |
| `MAX_PDF_BYTES` | `52428800` | Enforced while streaming Gotenberg's output |
| `MAX_QUEUED_JOBS` | `1000` | Above this, new requests get `QUEUE_FULL` |
| `JOB_ATTEMPTS` | `2` | Retries for retryable failures only |
| `RATE_LIMIT_MAX` | `60` per minute | Render requests per API key, backed by Redis |
| `RATE_LIMIT_READ_MAX` | `600` per minute | Status polls and downloads, which clients are expected to do often |
| `PDF_TTL_SECONDS` | `3600` | PDFs and job records expire together |
| `FAILED_JOB_TTL_SECONDS` | `86400` | Failed jobs keep their input HTML |
| `SYNC_TIMEOUT_MS` | `25000` | When `/v1/pdf/sync` gives up waiting |
| `STORAGE_DRIVER` | `local` | `local` or `r2` |
| `VITALS_INTERVAL_SECONDS` | `30` | Heartbeat log interval; 10–15 while load testing |
| `METRICS_ENABLED` | `true` | Prometheus endpoints on private ports 9090/9091 |
| `SLOW_RENDER_LOG_MS` | `10000` | Renders slower than this are logged at warn |

Gotenberg itself is configured in `docker-compose.yml`: one render at a time
(`--chromium-max-concurrency=1`), private-IP blocking on
(`--chromium-deny-private-ips=true`, the SSRF guard), `downloadFrom` and
webhooks disabled, and Chromium recycled every 50 conversions.

### Object storage (R2)

```env
STORAGE_DRIVER=r2
R2_BUCKET=pdf-service
R2_ACCOUNT_ID=…
R2_ACCESS_KEY_ID=…
R2_SECRET_ACCESS_KEY=…
R2_PRESIGN=true
```

The driver speaks plain S3, so MinIO, Spaces or S3 work by setting `R2_ENDPOINT`
instead of `R2_ACCOUNT_ID`. Input HTML is staged in the same bucket under
`<prefix>/<jobId>/input.html` and deleted as soon as the PDF exists, which is why
Redis only ever carries small control messages.

A bucket lifecycle rule is the cheapest way to enforce retention; the worker also
runs a janitor sweep every `JANITOR_INTERVAL_SECONDS` as a safety net.

## Observability

Detailed structured logs are always on, and are enough on their own to size the
machine — see **[docs/observability.md](docs/observability.md)** for the field
reference and the load-testing procedure.

```bash
docker compose logs -f worker                                  # live
docker compose logs --no-color --since 30m worker api | node scripts/logreport.mjs
```

Every render logs its full timing breakdown (`queue_wait_ms`, `render_ms`,
`upload_ms`, `total_ms`, byte sizes, `worker_concurrency`, `active_jobs`), and
each process logs a `vitals` heartbeat every `VITALS_INTERVAL_SECONDS` carrying
process CPU/RSS/event-loop plus **host CPU including steal**, load, memory and
queue depth. Container logs are capped at 20 MB × 5 files per service.

Prometheus metrics are exposed by both processes on ports that are *not*
published to the host (`api:9090/metrics`, `worker:9091/metrics`), and an
optional monitoring stack turns them into dashboards:

```bash
docker compose --profile monitoring up -d       # prometheus, grafana, node-exporter, cadvisor
ssh -L 3001:localhost:3001 user@your-vps        # grafana is bound to localhost
```

The provisioned dashboard covers throughput, render/queue percentiles, queue
depth, host CPU with a dedicated steal panel, memory and swap, per-container CPU
and memory (Chromium's real footprint), event loop lag, and failures by code.

## Load testing

```bash
node scripts/loadtest.mjs --count 50 --concurrency 10 \
  --tag c2 --out metrics/run-c2.json \
  --url http://localhost:8080 --key "$PDF_API_KEY" \
  --html scripts/sample-certificate.html

node scripts/compare-runs.mjs metrics/run-c1.json metrics/run-c2.json
INTERVAL=5 OUT_DIR=metrics TAG=c2 ./scripts/sample-host.sh   # host CPU/steal CSV
```

`compare-runs.mjs` prints the runs side by side with a verdict per step
("throughput +4.2%, render p95 +54% — not worth it"), which is what tells you
whether raising `WORKER_CONCURRENCY` and `--chromium-max-concurrency` is
justified. **Raise both together** — a worker allowed 3 renders against a
Gotenberg capped at 1 just queues inside Gotenberg, where the wait hides inside
`render_ms`.

A run larger than `RATE_LIMIT_MAX` (60 renders/minute by default) will hit the
rate limit. The script waits out `429`s and excludes that waiting from the
reported latencies, but for a clean measurement raise the limit for the run:

```env
RATE_LIMIT_MAX=10000
RATE_LIMIT_READ_MAX=100000
```

## Layout

```
src/
  api/        Fastify app, routes, auth, idempotency, job service
  worker/     BullMQ worker and the retention janitor
  queue/      Redis connections, queue definition, job contracts
  renderer/   Gotenberg client
  storage/    local disk and R2/S3 drivers
  config/     environment parsing and boot-time validation
  shared/     ids, errors, logger, PDF option contract
scripts/      smoke test, load test, log report, host sampler, sample certificate
observability/ prometheus config, grafana provisioning and dashboard
docs/         observability and load-testing runbook
```

`src/api/server.ts` and `src/worker/worker.ts` are the two entrypoints; the same
image runs either one depending on the command. `observability/` holds the
Prometheus config and the provisioned Grafana dashboard; `docs/` holds the
load-testing runbook.

## Not included yet

Deliberately out of scope for this stage: the VPS provisioning, Cloudflare
Tunnel, and CI/CD. The service is stateless apart from Redis and the object
store, so it moves between hosts by copying `docker-compose.yml` and `.env`.
