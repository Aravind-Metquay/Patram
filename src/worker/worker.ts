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
import {
  redactUrl,
  validateDestination,
  type UploadAttempt,
  type UploadReport,
} from '../upload/destination.js';
import { deliverPdf, digest } from '../upload/uploader.js';
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

/** Attempts recorded by earlier tries of this same job. */
function uploadAttempts(job: Job<PdfJobData, PdfJobResult, typeof PDF_JOB_NAME>): UploadAttempt[] {
  const progress = job.progress;
  if (!progress || typeof progress !== 'object') return [];
  const report = (progress as { upload?: UploadReport }).upload;
  return Array.isArray(report?.attempts) ? report.attempts : [];
}

/**
 * BullMQ carries a failure between worker and API as one string, so structured
 * upload diagnostics ride on the job's progress instead - it survives retries
 * and is still readable on a failed job. Never allowed to fail the job itself.
 */
async function recordUpload(
  job: Job<PdfJobData, PdfJobResult, typeof PDF_JOB_NAME>,
  report: UploadReport,
): Promise<void> {
  await job.updateProgress({ upload: report }).catch((error: unknown) => {
    logger.warn({ err: error, jobId: job.data.jobId }, 'could not record upload progress');
  });
}

async function render(
  job: Job<PdfJobData, PdfJobResult, typeof PDF_JOB_NAME>,
): Promise<PdfJobResult> {
  const { jobId, inputKey, options, filename, apiKeyId, upload } = job.data;
  const attempt = job.attemptsMade + 1;
  const jobLogger = logger.child({ jobId, attempt, apiKeyId });
  const startedAt = Date.now();
  const outputKey = objectKeys.output(jobId);

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
    // A retry that only failed to upload already has its PDF in storage. Reusing
    // it makes an upload retry cost no Chromium time, and keeps the retry off the
    // input HTML, which the success path below deletes.
    const [reusable, reuseFetchMs] =
      upload && attempt > 1
        ? await timed('get_output', () => storage.get(outputKey))
        : [null, 0];

    let pdf: Buffer;
    let renderMs = 0;
    let htmlBytes: number | null = null;
    let inputFetchMs: number | null = null;
    let putMs = 0;

    if (reusable) {
      pdf = reusable;
      jobLogger.info(
        { pdf_bytes: pdf.byteLength, outputKey },
        'reusing the rendered pdf for an upload retry',
      );
    } else {
      const [html, fetchMs] = await timed('get_input', () => storage.get(inputKey));
      if (html === null) {
        // The input expired or was never staged; no retry can bring it back.
        throw new AppError(410, 'INPUT_MISSING', `Input HTML is no longer available (${inputKey})`, {
          retryable: false,
        });
      }
      htmlBytes = html.byteLength;
      inputFetchMs = fetchMs;
      metrics.inputBytes.observe(html.byteLength);
      jobLogger.info({ html_bytes: html.byteLength, input_fetch_ms: fetchMs }, 'render started');

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
      pdf = result.pdf;
      renderMs = result.durationMs;

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

      [, putMs] = await timed('put_output', () =>
        storage.put(outputKey, pdf, 'application/pdf'),
      );
    }

    const digests = digest(pdf);
    let report: UploadReport | null = null;

    if (upload) {
      // Re-validated here, not just at enqueue: the parsed URL cannot travel
      // through Redis, and a second pass is free defence in depth.
      const destination = validateDestination(upload);

      // This PDF is about to become a permanent record in someone else's bucket.
      // Gotenberg should never hand back a non-PDF with a 200, but writing one
      // there is unrecoverable in a way that failing the job is not.
      if (pdf.byteLength === 0 || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
        throw new AppError(502, 'RENDERER_ERROR', 'Rendered bytes are not a PDF', {
          retryable: true,
        });
      }

      const previous = uploadAttempts(job);
      const outcome = await deliverPdf(destination, pdf, digests, previous);
      report = outcome.report;
      // Recorded before any throw, so a failed job still explains itself.
      await recordUpload(job, report);

      const last = report.attempts[report.attempts.length - 1];
      metrics.uploadTotal.inc({ outcome: last?.outcome ?? 'failed' });
      if (last) metrics.uploadSeconds.observe(last.ms / 1000);

      if (outcome.error) {
        jobLogger.error(
          {
            dest_host: report.host,
            dest_status: last?.status,
            dest_upload_ms: last?.ms,
            dest_attempt: last?.n,
            code: outcome.error.code,
            url: redactUrl(destination.url),
          },
          'upload to destination failed',
        );
        throw outcome.error;
      }

      jobLogger.info(
        {
          dest_host: report.host,
          dest_status: last?.status,
          dest_upload_ms: last?.ms,
          dest_attempt: last?.n,
          dest_verified: report.verified ?? null,
          url: redactUrl(destination.url),
        },
        'upload to destination completed',
      );
    }

    // The HTML has served its purpose - drop it immediately. This has to stay
    // after the upload: a retry re-reads inputKey, so deleting first would turn
    // every upload retry into INPUT_MISSING.
    const [, deleteMs] = await timed('delete_input', () =>
      storage.delete(inputKey).catch((error: unknown) => {
        jobLogger.warn({ err: error, inputKey }, 'could not delete input html');
      }),
    );

    const completedAt = new Date();
    const totalMs = Date.now() - startedAt;
    const destUploadMs = report?.attempts.reduce((sum, entry) => sum + entry.ms, 0);
    metrics.jobSeconds.observe(totalMs / 1000);
    metrics.jobsTotal.inc({ result: 'completed', code: 'ok' });
    stats.completed += 1;

    // One line with the full breakdown, so a load test can be analysed from
    // logs alone: scripts/logreport.mjs parses exactly this. `upload_ms` is the
    // write into *our* storage and predates this feature - the destination
    // upload is dest_upload_ms. Add keys here, never rename them.
    jobLogger.info(
      {
        queue_wait_ms: queueWaitMs,
        input_fetch_ms: inputFetchMs,
        // Set only on an upload retry, where the PDF came back out of storage
        // instead of Chromium - which is also why render_ms is 0 on those.
        output_fetch_ms: reusable ? reuseFetchMs : undefined,
        render_ms: renderMs,
        upload_ms: putMs,
        dest_upload_ms: destUploadMs,
        dest_host: report?.host,
        dest_status: report?.status,
        delete_input_ms: deleteMs,
        total_ms: totalMs,
        html_bytes: htmlBytes,
        pdf_bytes: pdf.byteLength,
        outputKey,
        storage: config.storage.driver,
        worker_concurrency: config.worker.concurrency,
        active_jobs: stats.active,
      },
      'job completed',
    );

    return {
      outputKey,
      bytes: pdf.byteLength,
      renderMs,
      totalMs,
      completedAt: completedAt.toISOString(),
      expiresAt: new Date(
        completedAt.getTime() + config.retention.pdfTtlSeconds * 1000,
      ).toISOString(),
      sha256: digests.sha256,
      ...(destUploadMs === undefined ? {} : { uploadMs: destUploadMs }),
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
    // The lock has to outlive the slowest possible render *and* upload: if it
    // expires mid-upload the job is redelivered and the object is written twice.
    lockDuration: config.limits.renderTimeoutMs + config.upload.timeoutMs + 30_000,
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
