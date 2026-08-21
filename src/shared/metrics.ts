import http from 'node:http';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { LogSink } from './logger.js';

/**
 * One registry per process. Both the API and the worker expose it on a private
 * port that is never published to the host, so there is nothing to authenticate
 * and nothing extra on the public surface.
 */
export const registry = new Registry();

/** Seconds. Sized for renders that take a fraction of a second up to a timeout. */
const DURATION_BUCKETS = [0.1, 0.25, 0.5, 1, 1.5, 2, 3, 5, 8, 13, 21, 34];
/** Seconds. Queue wait is the metric that grows first under load. */
const WAIT_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120];
const BYTE_BUCKETS = [10_000, 50_000, 100_000, 250_000, 500_000, 1e6, 5e6, 20e6, 50e6];

export const metrics = {
  /** Terminal job outcomes. `code` is the failure code, or "ok". */
  jobsTotal: new Counter({
    name: 'pdf_jobs_total',
    help: 'Jobs that reached a terminal state',
    labelNames: ['result', 'code'],
    registers: [registry],
  }),
  jobsAccepted: new Counter({
    name: 'pdf_jobs_accepted_total',
    help: 'Render requests accepted by the API',
    labelNames: ['mode', 'reused'],
    registers: [registry],
  }),
  renderSeconds: new Histogram({
    name: 'pdf_render_duration_seconds',
    help: 'Time spent inside the Gotenberg call',
    buckets: DURATION_BUCKETS,
    registers: [registry],
  }),
  jobSeconds: new Histogram({
    name: 'pdf_job_duration_seconds',
    help: 'Time spent in the worker, including storage reads and writes',
    buckets: DURATION_BUCKETS,
    registers: [registry],
  }),
  queueWaitSeconds: new Histogram({
    name: 'pdf_queue_wait_seconds',
    help: 'Time between enqueue and the worker picking the job up',
    buckets: WAIT_BUCKETS,
    registers: [registry],
  }),
  storageSeconds: new Histogram({
    name: 'pdf_storage_duration_seconds',
    help: 'Time spent in object storage operations',
    labelNames: ['operation'],
    buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [registry],
  }),
  outputBytes: new Histogram({
    name: 'pdf_output_bytes',
    help: 'Size of generated PDFs',
    buckets: BYTE_BUCKETS,
    registers: [registry],
  }),
  inputBytes: new Histogram({
    name: 'pdf_input_bytes',
    help: 'Size of submitted HTML',
    buckets: BYTE_BUCKETS,
    registers: [registry],
  }),
  /**
   * Uploads to a caller-supplied destination. Deliberately not labelled by host:
   * that is client-controlled and would be unbounded cardinality. The host goes
   * in the logs, where it belongs.
   */
  uploadTotal: new Counter({
    name: 'pdf_upload_total',
    help: 'Upload attempts against a caller-supplied destination',
    labelNames: ['outcome'],
    registers: [registry],
  }),
  uploadSeconds: new Histogram({
    name: 'pdf_upload_duration_seconds',
    help: 'Time spent uploading to a caller-supplied destination',
    buckets: DURATION_BUCKETS,
    registers: [registry],
  }),
  activeJobs: new Gauge({
    name: 'pdf_active_jobs',
    help: 'Renders in flight in this worker process',
    registers: [registry],
  }),
  httpRequests: new Counter({
    name: 'pdf_http_requests_total',
    help: 'HTTP requests handled by the API',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  }),
  httpSeconds: new Histogram({
    name: 'pdf_http_request_duration_seconds',
    help: 'API request duration',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.025, 0.1, 0.5, 1, 2, 5, 10, 30, 60],
    registers: [registry],
  }),
} as const;

/**
 * Queue depth is owned by whoever holds the queue (the API), and is read at
 * scrape time so an unobserved service makes no Redis calls for it.
 */
export function registerQueueDepthGauge(
  provider: () => Promise<Record<string, number>>,
): Gauge<'state'> {
  return new Gauge({
    name: 'pdf_queue_depth',
    help: 'Jobs in the queue by BullMQ state',
    labelNames: ['state'],
    registers: [registry],
    async collect() {
      const counts = await provider();
      for (const [state, count] of Object.entries(counts)) {
        this.set({ state }, count);
      }
    },
  });
}

/**
 * Adds the Node runtime metrics — event loop lag, heap, GC, process CPU — which
 * are what tell you whether the box is out of CPU rather than out of patience.
 */
export function initMetrics(role: 'api' | 'worker', concurrency?: number): void {
  registry.setDefaultLabels({
    role,
    ...(concurrency === undefined ? {} : { concurrency: String(concurrency) }),
  });
  collectDefaultMetrics({ register: registry });
}

/** Serves /metrics on a port that stays inside the Docker network. */
export function startMetricsServer(port: number, host: string, logger: LogSink): http.Server {
  const server = http.createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    if (path === '/metrics') {
      registry
        .metrics()
        .then((body) => {
          response.writeHead(200, { 'content-type': registry.contentType });
          response.end(body);
        })
        .catch((error: unknown) => {
          logger.error({ err: error }, 'failed to render metrics');
          response.writeHead(500);
          response.end();
        });
      return;
    }
    if (path === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"status":"ok"}');
      return;
    }
    response.writeHead(404);
    response.end();
  });

  server.listen(port, host, () => logger.info({ port }, 'metrics endpoint listening'));
  server.on('error', (error) => logger.error({ err: error }, 'metrics server error'));
  return server;
}
