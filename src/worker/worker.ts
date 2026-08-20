import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { assertRuntimeConfig, config } from '../config/index.js';
import { PDF_JOB_NAME, type PdfJobData, type PdfJobResult } from '../queue/pdf.queue.js';
import { createRedis } from '../queue/redis.js';
import { GotenbergClient } from '../renderer/gotenberg.js';
import { AppError, isAppError, serialiseFailure } from '../shared/errors.js';
import { createLogger } from '../shared/logger.js';
import { initMetrics, metrics, startMetricsServer } from '../shared/metrics.js';
import { startVitals } from '../shared/vitals.js';
import { closeStorage, getStorage, objectKeys } from '../storage/index.js';
import { startJanitor } from './janitor.js';

assertRuntimeConfig('worker');

const logger = createLogger('pdf-worker');
const storage = getStorage();
const connection = createRedis('blocking');
const gotenberg = new GotenbergClient({
  baseUrl: config.gotenberg.url,
  timeoutMs: config.limits.renderTimeoutMs,
  maxPdfBytes: config.limits.maxPdfBytes,
});

/** Rolling counters, reported in the vitals heartbeat. */
const stats = {
  active: 0,
  completed: 0,
  failed: 0,
  lastRenderMs: 0,
  lastPdfBytes: 0,
};

async function timed<T>(operation: string, work: () => Promise<T>): Promise<[T, number]> {
  const startedAt = Date.now();
  const result = await work();
  const elapsedMs = Date.now() - startedAt;
  metrics.storageSeconds.observe({ operation }, elapsedMs / 1000);
  return [result, elapsedMs];
}

async function render(
  job: Job<PdfJobData, PdfJobResult, typeof PDF_JOB_NAME>,
): Promise<PdfJobResult> {
  const { jobId, inputKey, options, filename, apiKeyId } = job.data;
  const attempt = job.attemptsMade + 1;
  const jobLogger = logger.child({ jobId, attempt, apiKeyId });
  const startedAt = Date.now();

  // How long the job sat in Redis before this worker picked it up. This is the
  // number that grows first when the machine runs out of render capacity.
  const queueWaitMs =
    job.processedOn && job.timestamp ? Math.max(0, job.processedOn - job.timestamp) : null;
  if (queueWaitMs !== null && attempt === 1) {
    metrics.queueWaitSeconds.observe(queueWaitMs / 1000);
  }

  stats.active += 1;
  metrics.activeJobs.set(stats.active);
  jobLogger.info({ inputKey, queue_wait_ms: queueWaitMs, active_jobs: stats.active }, 'job received');

  try {
    const [html, inputFetchMs] = await timed('get_input', () => storage.get(inputKey));
    if (html === null) {
      // The input expired or was never staged; no retry can bring it back.
      throw new AppError(410, 'INPUT_MISSING', `Input HTML is no longer available (${inputKey})`, {
        retryable: false,
      });
    }
    metrics.inputBytes.observe(html.byteLength);
    jobLogger.info(
      { html_bytes: html.byteLength, input_fetch_ms: inputFetchMs },
      'render started',
    );

    const result = await gotenberg.renderHtml({
      jobId,
      html: html.toString('utf8'),
      options,
      filename,
    });
    metrics.renderSeconds.observe(result.durationMs / 1000);
    metrics.outputBytes.observe(result.bytes);
    stats.lastRenderMs = result.durationMs;
    stats.lastPdfBytes = result.bytes;

    const renderLog = {
      html_bytes: html.byteLength,
      pdf_bytes: result.bytes,
      render_ms: result.durationMs,
      // Bytes of PDF per second of Chromium time: falls as the box saturates.
      render_bytes_per_s: Math.round(result.bytes / Math.max(result.durationMs / 1000, 0.001)),
      active_jobs: stats.active,
    };
    if (result.durationMs >= config.observability.slowRenderMs) {
      jobLogger.warn(
        { ...renderLog, threshold_ms: config.observability.slowRenderMs },
        'slow render',
      );
    } else {
      jobLogger.info(renderLog, 'render completed');
    }

    const outputKey = objectKeys.output(jobId);
    const [, uploadMs] = await timed('put_output', () =>
      storage.put(outputKey, result.pdf, 'application/pdf'),
    );

    // The HTML has served its purpose - drop it immediately.
    const [, deleteMs] = await timed('delete_input', () =>
      storage.delete(inputKey).catch((error: unknown) => {
        jobLogger.warn({ err: error, inputKey }, 'could not delete input html');
      }),
    );

    const completedAt = new Date();
    const totalMs = Date.now() - startedAt;
    metrics.jobSeconds.observe(totalMs / 1000);
    metrics.jobsTotal.inc({ result: 'completed', code: 'ok' });
    stats.completed += 1;

    // One line with the full breakdown, so a load test can be analysed from
    // logs alone: scripts/logreport.mjs parses exactly this.
    jobLogger.info(
      {
        queue_wait_ms: queueWaitMs,
        input_fetch_ms: inputFetchMs,
        render_ms: result.durationMs,
        upload_ms: uploadMs,
        delete_input_ms: deleteMs,
        total_ms: totalMs,
        html_bytes: html.byteLength,
        pdf_bytes: result.bytes,
        outputKey,
        storage: config.storage.driver,
        worker_concurrency: config.worker.concurrency,
        active_jobs: stats.active,
      },
      'job completed',
    );

    return {
      outputKey,
      bytes: result.bytes,
      renderMs: result.durationMs,
      totalMs,
      completedAt: completedAt.toISOString(),
      expiresAt: new Date(
        completedAt.getTime() + config.retention.pdfTtlSeconds * 1000,
      ).toISOString(),
    };
  } finally {
    stats.active -= 1;
    metrics.activeJobs.set(stats.active);
  }
}

const worker = new Worker<PdfJobData, PdfJobResult, typeof PDF_JOB_NAME>(
  config.queue.name,
  async (job) => {
    try {
      return await render(job);
    } catch (error) {
      const failure = serialiseFailure(error);
      const code = isAppError(error) ? error.code : 'INTERNAL_ERROR';
      const retryable = isAppError(error) ? error.retryable : true;
      const attempts = job.opts.attempts ?? 1;
      const isLastAttempt = job.attemptsMade + 1 >= attempts;

      stats.failed += 1;
      metrics.jobsTotal.inc({ result: 'failed', code });
      logger.error(
        {
          jobId: job.data.jobId,
          apiKeyId: job.data.apiKeyId,
          attempt: job.attemptsMade + 1,
          attempts,
          code,
          retryable,
          will_retry: retryable && !isLastAttempt,
          err: error,
        },
        'job failed',
      );
      // Non-retryable failures must not burn the remaining attempts.
      if (!retryable && !isLastAttempt) {
        throw new UnrecoverableError(failure);
      }
      throw new Error(failure);
    }
  },
  {
    connection,
    concurrency: config.worker.concurrency,
    // The lock has to outlive the slowest possible render.
    lockDuration: config.limits.renderTimeoutMs + 30_000,
  },
);

worker.on('error', (error) => logger.error({ err: error }, 'worker error'));
worker.on('stalled', (jobId) => logger.warn({ bullJobId: jobId }, 'job stalled'));

const stopJanitor = config.janitor.enabled ? startJanitor(storage, logger) : () => {};

initMetrics('worker', config.worker.concurrency);
const metricsServer = config.observability.metricsEnabled
  ? startMetricsServer(config.observability.workerMetricsPort, '0.0.0.0', logger)
  : null;

const stopVitals = startVitals(logger, {
  intervalMs: config.observability.vitalsIntervalSeconds * 1000,
  collect: () => ({
    role: 'worker',
    worker_concurrency: config.worker.concurrency,
    active_jobs: stats.active,
    jobs_completed: stats.completed,
    jobs_failed: stats.failed,
    last_render_ms: stats.lastRenderMs,
    last_pdf_bytes: stats.lastPdfBytes,
  }),
});

logger.info(
  {
    queue: config.queue.name,
    concurrency: config.worker.concurrency,
    gotenberg: config.gotenberg.url,
    storage: config.storage.driver,
    renderTimeoutMs: config.limits.renderTimeoutMs,
    metricsPort: config.observability.metricsEnabled
      ? config.observability.workerMetricsPort
      : null,
    vitalsIntervalSeconds: config.observability.vitalsIntervalSeconds,
  },
  'worker started',
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, active_jobs: stats.active }, 'shutting down');
  stopJanitor();
  stopVitals();
  metricsServer?.close();
  try {
    // Lets the in-flight render finish before the connection goes away.
    await worker.close();
    await closeStorage();
    await connection.quit();
  } catch (error) {
    logger.error({ err: error }, 'error during shutdown');
  }
  logger.info(
    { jobs_completed: stats.completed, jobs_failed: stats.failed },
    'worker stopped',
  );
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled rejection'));
