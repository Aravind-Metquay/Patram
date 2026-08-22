# Patram PDF Service — Future Scope

## 1. Purpose

This document defines the future architectural scope for Patram's PDF service as usage grows from the current single-host deployment into a horizontally scalable, production-grade rendering platform.

The current service already has a strong base:

- Fastify API
- Redis + BullMQ
- Dedicated PDF worker
- Gotenberg + Chromium
- Synchronous and asynchronous render APIs
- Idempotency
- Retry handling
- Backpressure
- Object storage support
- Presigned upload URLs
- Structured logs
- Prometheus metrics
- Load testing
- Chromium recycling

The goal is **not** to rebuild the current system. The goal is to evolve it incrementally when traffic and workload characteristics justify additional complexity.

---

# 2. Current Architecture

```text
        Client
          │
          ▼
    ┌──────────────┐
    │ Fastify API  │
    └──────┬───────┘
           │
           ▼
      ┌─────────┐
      │  Redis  │
      │ BullMQ  │
      └────┬────┘
           │
           ▼
    ┌──────────────┐
    │ PDF Worker   │
    │ concurrency  │
    └──────┬───────┘
           │
           ▼
    ┌──────────────┐
    │  Gotenberg   │
    │  Chromium    │
    └──────┬───────┘
           │
           ▼
     R2 / S3 / local
```

The queue is already the correct architectural boundary. Gotenberg's internal queue protects Chromium, while BullMQ provides application-level durable job state, retries, job IDs, backpressure, and a future horizontal-scaling path.

The current service also already supports synchronous requests by queueing them normally and waiting only up to a configured timeout.

---

# 3. Architectural Principles Going Forward

Future changes should preserve the following principles.

## 3.1 PDF rendering must remain isolated from the main application

Chromium is a CPU- and memory-heavy workload.

A renderer crash, memory leak, OOM event, or unusually large PDF must never be able to take down Patram's main API server.

The PDF service should therefore remain independently deployable.

---

## 3.2 The queue remains the source of scheduling truth

Applications should never call Gotenberg directly.

All rendering must continue through the job queue so that concurrency, retries, prioritization, rate limiting, and scaling are handled in one place.

---

## 3.3 Workers must be disposable

A rendering worker should contain no durable business state.

Everything durable should exist in:

- Redis
- object storage
- application database

This allows workers to be restarted, replaced, horizontally scaled, or migrated between infrastructure providers.

---

## 3.4 Scale based on measured workload

Do not prematurely introduce complex scheduling or multiple worker pools.

Use existing metrics such as:

- `queue_wait_ms`
- `render_ms`
- `upload_ms`
- `total_ms`
- HTML size
- PDF size
- queue depth
- CPU
- memory
- active jobs

to determine when each future stage is necessary.

---

# 4. Phase 1 — Strengthen the Current Single-Instance Architecture

This is the immediate future scope.

No infrastructure migration is required yet.

## 4.1 Add richer job classification metadata

Every queued job should contain enough information to estimate its rendering cost.

Recommended metadata:

```json
{
  "htmlBytes": 243147,
  "imageCount": 11,
  "embeddedImageBytes": 1800000,
  "remoteAssetCount": 4,
  "templateId": "certificate-v3",
  "jobClass": "normal",
  "priority": "interactive"
}
```

These fields should also be included in structured render logs.

---

## 4.2 Track image and asset characteristics

HTML size alone is not a reliable measure of render complexity.

A small HTML document may reference many large images or remote resources.

Track at minimum:

- HTML bytes
- embedded/base64 image bytes
- image count
- remote image count
- font count where practical
- remote asset count
- output PDF bytes
- render duration

These measurements will later feed the job classifier.

---

## 4.3 Introduce job weight

Do not treat every render as identical.

Start with a simple classification:

```text
NORMAL
HEAVY
```

Possible initial heuristic:

```text
NORMAL
- ordinary certificate HTML
- small or moderate images
- historically fast template

HEAVY
- very large HTML
- large embedded images
- many images
- historically slow template
```

The exact thresholds should be determined from production/load-test data.

---

## 4.4 Add weighted concurrency

A fixed value such as:

```text
WORKER_CONCURRENCY=5
```

assumes every render consumes the same amount of resources.

Future workers should support a capacity-unit model.

Example:

```text
Worker capacity = 6 units

Normal job = 1 unit
Medium job = 2 units
Heavy job = 6 units
```

Valid combinations might therefore include:

```text
6 normal jobs
3 medium jobs
1 heavy job
2 normal + 2 medium jobs
```

This allows large documents to reserve more capacity and prevents a worker from becoming memory saturated.

---

## 4.5 Preserve hard rendering limits

Continue enforcing hard limits such as:

- maximum HTML bytes
- maximum PDF bytes
- render timeout
- queue length
- worker concurrency
- request body size

Large workload support should not mean accepting unlimited inputs.

---

# 5. Phase 2 — Priority Scheduling

Workload size and business priority should be independent concepts.

A small background job should not necessarily run before an interactive user request.

Introduce priorities such as:

```text
INTERACTIVE
BACKGROUND
```

Examples:

### Interactive

A user clicks:

```text
Generate Certificate
```

The user is actively waiting for the result.

### Background

Examples:

```text
Generate 500 historical certificates
Nightly exports
Bulk regeneration
Scheduled reports
```

The scheduler should generally prefer:

```text
interactive + normal
```

over:

```text
background + heavy
```

while still ensuring background jobs eventually make progress.

---

# 6. Phase 3 — Split Queue Lanes

Once metrics show clear differences between workload classes, move away from one undifferentiated FIFO queue.

Recommended first split:

```text
NORMAL QUEUE
HEAVY QUEUE
```

Future architecture:

```text
                   Render API
                       │
                       ▼
                 Job Classifier
                       │
             ┌─────────┴─────────┐
             ▼                   ▼
        Normal Queue         Heavy Queue
             │                   │
             └─────────┬─────────┘
                       ▼
                    Workers
```

This prevents head-of-line blocking.

Example without queue separation:

```text
20-second job
18-second job
1-second job
1-second job
1-second job
```

The small jobs unnecessarily wait behind heavy jobs.

With separate lanes:

```text
NORMAL
1 sec
1 sec
1 sec

HEAVY
20 sec
18 sec
```

Normal certificate generation remains responsive even while expensive jobs are running.

---

# 7. Phase 4 — Multi-Dimensional Queueing

Eventually the scheduling model should represent both:

```text
Priority
+
Workload weight
```

For example:

```text
interactive-normal
interactive-heavy

background-normal
background-heavy
```

This does not necessarily require four physical BullMQ queues.

The implementation may instead use:

- BullMQ priority
- separate queues
- weighted scheduling
- custom dispatcher logic

Choose the simplest implementation that provides predictable scheduling.

---

# 8. Per-Tenant Fairness

When Patram serves multiple organizations, one customer must not be able to consume all PDF capacity.

Future scheduling should introduce per-tenant controls.

Possible controls:

```text
max queued jobs per tenant
max active renders per tenant
max heavy renders per tenant
per-tenant rate limits
```

The scheduler should eventually support fair scheduling such as:

```text
Tenant A
Tenant B
Tenant C
Tenant A
Tenant B
Tenant C
```

rather than processing thousands of Tenant A jobs before serving Tenant B.

This becomes especially important for bulk generation.

---

# 9. Admission Control

The queue protects workers from bursts, but it must not become an unlimited buffer.

Admission control should consider:

- global queue depth
- queue depth by class
- tenant queue depth
- oldest queued job age
- available rendering capacity

Possible responses when capacity is exhausted:

```text
429 RATE_LIMITED
503 QUEUE_FULL
202 ACCEPTED with delayed processing
```

The exact response depends on whether the request is interactive or asynchronous.

---

# 10. Interactive vs Asynchronous Rendering

The service already supports both synchronous and asynchronous rendering.

Future routing should make the choice workload-aware.

Recommended behavior:

```text
Small / normal interactive request
        ↓
enqueue
        ↓
wait up to sync timeout
        ↓
return PDF if completed

Heavy request
        ↓
enqueue
        ↓
return 202 quickly
        ↓
client polls / receives completion event
```

Heavy jobs should increasingly prefer the asynchronous path.

A slow PDF should not require keeping an HTTP connection open for a long period.

---

# 11. Template Complexity Profiling

Over time, the service should learn from previous renders.

Store historical metrics by `templateId`.

Example:

```text
Template: calibration-certificate-v3

p50 render: 900 ms
p95 render: 1.8 sec
average HTML: 80 KB
average memory footprint: low
```

Another template:

```text
Template: large-report-v2

p50 render: 8 sec
p95 render: 16 sec
average HTML: 1.4 MB
image-heavy
```

The scheduler can therefore classify a job using both:

```text
current request characteristics
+
historical template performance
```

This is significantly more accurate than HTML size alone.

---

# 12. Content-Based Job Scoring

Once enough metrics exist, replace hard thresholds with a simple rendering cost score.

Example conceptual formula:

```text
score =
    htmlBytes
  + embeddedImageBytes × imageWeight
  + imageCount × imageCountWeight
  + remoteAssetCount × networkWeight
  + historicalTemplateRenderTime × historyWeight
```

Map the score to a class:

```text
0 ───────────── normal
                 │
                 ▼
              medium
                 │
                 ▼
               heavy
```

This can remain deterministic and does not require machine learning.

---

# 13. Worker Resource Isolation

Heavy jobs should not be allowed to destabilize normal workers.

Future options include:

```text
Normal workers
2–4 concurrent jobs

Heavy workers
1 concurrent job
```

When horizontally scaled, worker types can use different machine sizes.

Example:

```text
Normal worker
t3.medium
2 vCPU
4 GB

Heavy worker
larger memory instance
1 render at a time
```

or equivalent ECS/Fargate/Cloudflare Container sizes.

This allows expensive infrastructure to exist only where required.

---

# 14. Chromium Lifecycle Management

The current system already recycles Chromium periodically.

Future improvements should make worker recycling more defensive.

Possible triggers:

```text
N completed conversions
process RSS above threshold
container memory above threshold
repeated Chromium errors
renderer health failure
worker age threshold
```

A worker should enter draining mode before recycling:

```text
stop accepting new jobs
        ↓
finish active render
        ↓
restart renderer / worker
        ↓
mark ready
```

Never terminate workers in the middle of a render during normal deployments or recycling.

---

# 15. Graceful Deployment

Deployments should eventually support draining.

Before terminating a worker:

```text
1. mark worker unavailable
2. stop pulling new queue jobs
3. complete current jobs
4. close Chromium/Gotenberg cleanly
5. terminate instance/container
```

This will be important once more than one worker exists.

---

# 16. Separate Render and Upload Failure Domains

Rendering and delivery should continue to be considered separate stages.

Conceptually:

```text
QUEUED
   ↓
RENDERING
   ↓
RENDERED
   ↓
UPLOADING
   ↓
COMPLETED
```

If rendering succeeds but upload fails:

```text
retry upload
```

instead of:

```text
render PDF again
```

The current architecture already retains the generated PDF temporarily, enabling this behavior.

Future job state can make this separation more explicit.

---

# 17. Idempotency and Deduplication

Idempotency already prevents duplicate requests from creating duplicate jobs.

Future scope can extend this into content deduplication.

Generate a content hash from values such as:

```text
template version
+
render data
+
PDF options
+
asset versions
```

For example:

```text
SHA256(template + data + options + assetVersions)
```

If an identical immutable PDF already exists:

```text
reuse existing object
```

instead of rendering it again.

This is particularly useful for repeated downloads or retries.

Do not use caching when the generated document contains time-dependent or non-deterministic content unless the cache key includes that state.

---

# 18. Object Storage Architecture

Generated PDFs should remain outside the rendering host.

Preferred flow:

```text
Renderer
   │
   ▼
Presigned PUT
   │
   ▼
R2 / S3
```

The application database should store:

```text
bucket
object key
metadata
```

rather than storing temporary presigned GET URLs.

Permanent sharing should be implemented using either:

```text
stable application download endpoint
```

or:

```text
short-lived presigned GET URL generated on demand
```

depending on document access requirements.

---

# 19. Asset Delivery Optimization

Large images and fonts can dominate rendering time.

Future optimization should examine:

- avoiding unnecessary base64 embedding
- image compression
- image resizing before rendering
- WebP/JPEG where appropriate
- shared font caching
- locally available fonts inside the renderer
- R2/S3-hosted assets
- avoiding slow third-party URLs
- reducing unnecessary JavaScript
- reducing unnecessary network idle waits

Asset performance should be measured separately from Chromium print time.

---

# 20. Renderer Network Security

Chromium is effectively a browser running on the server.

If HTML references remote resources, the renderer must be treated as a security boundary.

Future security controls should include:

```text
deny private IP ranges
deny cloud metadata endpoints
deny loopback
restrict internal network access
restrict unsupported protocols
optionally restrict outbound hostnames
```

The existing Gotenberg private-IP protection should remain enabled.

If users ever gain control over arbitrary HTML, additional sandboxing and outbound restrictions become mandatory.

---

# 21. Retry Classification

Retries should remain failure-aware.

Retryable examples:

```text
renderer unavailable
Chromium crash
temporary network failure
storage 5xx
upload timeout
```

Non-retryable examples:

```text
invalid document
unsupported request
HTML rejected
invalid upload signature
permanent storage 4xx
```

Do not blindly retry every failed render.

Retries for heavy jobs should also avoid immediately returning to the front of the queue and starving normal requests.

---

# 22. Dead-Letter Queue

Once production volume increases, jobs that exhaust retries should move to a dead-letter path.

Example:

```text
normal queue
    ↓
retry
    ↓
retry
    ↓
DLQ
```

The DLQ should retain:

```text
job ID
tenant
template
failure code
failure message
attempt history
render metadata
timestamps
```

This allows operational investigation without repeatedly retrying broken jobs.

---

# 23. Queue Age as a Scaling Signal

Raw queue depth is not enough.

Example:

```text
100 jobs × 500 ms
```

may be acceptable.

But:

```text
10 jobs waiting 45 seconds
```

may indicate a serious capacity problem.

Important future scaling metrics:

```text
queue depth
oldest job age
queue_wait_ms p95
render_ms p95
active workers
active rendering capacity
CPU
memory
error rate
```

Oldest-job age and queue-wait latency should become primary autoscaling signals.

---

# 24. Horizontal Worker Scaling

The service is already architecturally compatible with horizontal workers because BullMQ owns job distribution.

Future deployment:

```text
                  Redis / BullMQ
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
      Worker 1      Worker 2      Worker 3
          │            │            │
          ▼            ▼            ▼
      Gotenberg     Gotenberg     Gotenberg
```

Each worker should ideally have its own local Gotenberg/Chromium renderer.

Avoid multiple workers competing unpredictably for one shared Chromium instance unless that topology is intentionally benchmarked.

---

# 25. Autoscaling

Once horizontal scaling is introduced, scaling should not depend only on CPU.

Recommended scaling signals:

```text
oldest queue age
queue_wait_ms p95
queue depth
active jobs
available capacity units
CPU
memory
render latency
```

Example conceptual policy:

```text
Normal queue

queue age < 2 sec
    → current capacity

queue age > 5 sec
    → add worker

queue age > 15 sec
    → aggressively add workers

queue empty for sustained period
    → scale down
```

Heavy jobs may require a separate scaling policy.

---

# 26. Infrastructure Evolution

The application architecture should remain infrastructure-neutral.

Possible progression:

## Stage A — Current

```text
Elastic Beanstalk / EC2
single t3.medium
Docker Compose
```

This remains cost-effective while load is modest.

## Stage B — Multiple EC2 workers

When one machine is no longer enough:

```text
API / Redis
     │
     ├── PDF host 1
     ├── PDF host 2
     └── PDF host N
```

This may be the simplest first horizontal scaling step.

## Stage C — ECS/Fargate

Move when the benefits justify the cost:

- managed task lifecycle
- autoscaling
- rolling deployments
- service health management
- easier horizontal worker pools

Fargate should be adopted for operational/scaling reasons rather than purely for cost savings.

## Stage D — Cloudflare Containers

Cloudflare Containers remain worth evaluating for bursty rendering because they can sleep when idle and bill active CPU separately.

Before adopting them, benchmark:

- container cold start
- Gotenberg startup
- Chromium readiness
- sustained render concurrency
- container memory usage
- autoscaling limitations
- queue integration
- cost at actual Patram volume

The rendering application itself should not need major architectural changes whichever platform is selected.

---

# 27. Warm Capacity and Cold Starts

For synchronous certificate generation, completely scaling to zero may produce unacceptable first-request latency.

Future infrastructure should support a minimum warm capacity during active periods.

Example:

```text
minimum renderer capacity = 1
```

Additional capacity can scale based on demand.

Possible future policy:

```text
business hours
    → minimum 1 warm worker

long idle periods
    → allow scale to zero
```

This is especially relevant for Cloudflare Containers and Fargate.

---

# 28. Health and Readiness

Continue separating:

```text
liveness
```

from:

```text
readiness
```

A worker process can be alive while Chromium is unusable.

Readiness should consider:

- Redis connectivity
- renderer connectivity
- Chromium/Gotenberg health
- ability to accept new jobs
- worker draining state
- memory safety threshold

An unhealthy worker must stop receiving new jobs before it is terminated.

---

# 29. Observability Expansion

The existing observability foundation is strong.

Future metrics should include dimensions such as:

```text
tenant
templateId
jobClass
priority
workerId
host/container ID
attempt
```

Important dashboards:

### Queue

```text
queue depth
queue depth by class
oldest job
queue wait p50 / p95 / p99
```

### Rendering

```text
renders/sec
render p50 / p95 / p99
render duration by template
render duration by class
failure rate
```

### Resources

```text
host CPU
container CPU
memory
Chromium memory
worker slots
weighted capacity usage
```

### Storage

```text
upload latency
upload failure rate
upload retries
PDF bytes generated
```

---

# 30. Cost Attribution

As usage grows, record approximate rendering cost by:

```text
tenant
template
job type
```

Useful inputs:

```text
render time
CPU time where available
memory class
PDF size
storage bytes
network bytes
```

This will answer questions such as:

```text
Which customer consumes the most rendering resources?
Which template is expensive?
What is the infrastructure cost per certificate?
Should bulk generation have separate pricing?
```

---

# 31. Batch Generation

Bulk PDF generation should eventually become a first-class workflow.

Do not enqueue thousands of interactive-priority jobs simultaneously.

Future batch architecture:

```text
Create Batch
    │
    ▼
Batch Coordinator
    │
    ▼
enqueue jobs gradually
    │
    ▼
background queue
```

The coordinator should support:

```text
batch progress
successful count
failed count
cancel
retry failed
rate limiting
tenant fairness
```

---

# 32. Cancellation

Future async jobs should support cancellation when practical.

Possible state:

```text
QUEUED
ACTIVE
CANCEL_REQUESTED
CANCELLED
COMPLETED
FAILED
```

Queued jobs can be removed immediately.

Active Chromium jobs may require terminating the page/render request or allowing the current render to finish depending on renderer capabilities.

---

# 33. Job Expiration

Separate job retention from PDF retention.

Possible future policies:

```text
input HTML
short retention

generated PDF
application-defined retention

job metadata
longer operational retention

failed job diagnostics
temporary retention
```

Avoid keeping large HTML payloads in Redis longer than required.

---

# 34. Event-Based Completion

Polling is acceptable initially.

Future async workflows may benefit from completion events.

Possible mechanisms:

```text
webhook
WebSocket / Socket.io event
internal event bus
application notification
```

Example:

```text
pdf.completed
pdf.failed
```

This is particularly useful for background and batch generation.

---

# 35. Multi-Region Strategy — Long-Term Only

Do not implement this early.

If Patram eventually serves large geographically distributed workloads, rendering could run closer to the requesting region.

Challenges include:

```text
queue placement
Redis topology
object storage location
template availability
tenant routing
duplicate processing
regional failover
```

Only consider multi-region rendering once there is a measured requirement.

---

# 36. Recommended Implementation Order

## Immediate

1. Continue load testing the current `t3.medium`.
2. Capture richer workload metadata.
3. Record HTML, image and asset characteristics.
4. Add `templateId`, `priority`, and `jobClass` to jobs.
5. Introduce `normal` and `heavy` classification.
6. Add weighted concurrency or equivalent worker-capacity protection.
7. Keep strict timeouts and memory/size limits.
8. Preserve Chromium recycling.
9. Keep PDF infrastructure isolated from the main application.
10. Continue using object storage instead of renderer-local persistence.

## Next

11. Separate normal and heavy queue lanes.
12. Add interactive vs background scheduling.
13. Add per-tenant concurrency and queue limits.
14. Add queue-age monitoring.
15. Add dead-letter handling.
16. Improve render/upload state separation.
17. Add historical template performance tracking.
18. Build a deterministic render-cost score.
19. Add graceful worker draining.
20. Add batch generation as a background workload.

## When One Host Is No Longer Enough

21. Run multiple PDF workers.
22. Ensure each worker has isolated renderer capacity.
23. Add distributed worker readiness.
24. Scale using queue wait / oldest-job age rather than CPU alone.
25. Introduce separate normal/heavy worker pools if necessary.

## Infrastructure Evaluation

26. Benchmark additional EC2 capacity.
27. Benchmark ECS/Fargate.
28. Benchmark Cloudflare Containers.
29. Compare:
    - warm latency
    - cold latency
    - throughput
    - concurrency
    - memory
    - failure behavior
    - operational complexity
    - monthly cost
30. Migrate only when measured benefits justify the additional complexity.

---

# 37. Target Long-Term Architecture

```text
                           Patram Application
                                   │
                                   ▼
                           PDF Render API
                     auth / rate limit / validation
                                   │
                                   ▼
                             Job Classifier
                 size / assets / template history / priority
                                   │
                    ┌──────────────┴──────────────┐
                    │                             │
                    ▼                             ▼
             Interactive Work               Background Work
                    │                             │
              ┌─────┴─────┐                 ┌─────┴─────┐
              ▼           ▼                 ▼           ▼
           Normal       Heavy            Normal       Heavy
              │           │                 │           │
              └───────────┴─────────┬───────┴───────────┘
                                    │
                                    ▼
                                Scheduler
                   tenant fairness / weighted capacity
                                    │
                         ┌──────────┼──────────┐
                         ▼          ▼          ▼
                      Worker 1   Worker 2   Worker N
                         │          │          │
                    Gotenberg  Gotenberg  Gotenberg
                    Chromium   Chromium   Chromium
                         │          │          │
                         └──────────┼──────────┘
                                    │
                                    ▼
                                  R2/S3
                                    │
                                    ▼
                          Application database
                       stores object key + metadata
                                    │
                                    ▼
                    status / event / download access
```

---

# 38. What Not to Build Yet

Do not prematurely introduce:

- Kubernetes
- complex custom schedulers
- machine-learning job classification
- multiple regions
- many physical queue types
- separate infrastructure for every template
- large always-on worker fleets
- sophisticated distributed coordination

The current Fastify + BullMQ + worker + Gotenberg architecture is already a good base.

The correct strategy is:

```text
measure
    ↓
identify bottleneck
    ↓
introduce the smallest architectural change
    ↓
measure again
```

This keeps Patram simple while still leaving a clear path toward much larger PDF workloads.
