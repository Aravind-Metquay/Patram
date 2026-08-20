import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { assertRuntimeConfig, config } from '../config/index.js';
import { PDF_JOB_NAME, type PdfJobData, type PdfJobResult } from '../queue/pdf.queue.js';
import { createRedis } from '../queue/redis.js';
import { GotenbergClient } from '../renderer/gotenberg.js';
import { AppError, isAppError, serialiseFailure } from '../shared/errors.js';
import { createLogger } from '../shared/logger.js';
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

async function render(job: Job<PdfJobData, PdfJobResult, typeof PDF_JOB_NAME>): Promise<PdfJobResult> {
  const { jobId, inputKey, options, filename } = job.data;
  const jobLogger = logger.child({ jobId, attempt: job.attemptsMade + 1 });
  const startedAt = Date.now();
  jobLogger.info({ inputKey }, 'job received');

  const html = await storage.get(inputKey);
  if (html === null) {
    // The input expired or was never staged; no retry can bring it back.
    throw new AppError(410, 'INPUT_MISSING', `Input HTML is no longer available (${inputKey})`, {
      retryable: false,
    });
  }

  jobLogger.info({ htmlBytes: html.byteLength }, 'render started');
  const result = await gotenberg.renderHtml({
    jobId,
    html: html.toString('utf8'),
    options,
    filename,
  });
  jobLogger.info({ pdfBytes: result.bytes, gotenbergMs: result.durationMs }, 'render completed');

  const outputKey = objectKeys.output(jobId);
  await storage.put(outputKey, result.pdf, 'application/pdf');

  // The HTML has served its purpose - drop it immediately.
  await storage.delete(inputKey).catch((error: unknown) => {
    jobLogger.warn({ err: error, inputKey }, 'could not delete input html');
  });

  const completedAt = new Date();
  const totalMs = Date.now() - startedAt;
  jobLogger.info({ pdfBytes: result.bytes, totalMs, outputKey }, 'job completed');

  return {
    outputKey,
    bytes: result.bytes,
    renderMs: result.durationMs,
    totalMs,
    completedAt: completedAt.toISOString(),
    expiresAt: new Date(completedAt.getTime() + config.retention.pdfTtlSeconds * 1000).toISOString(),
  };
}

const worker = new Worker<PdfJobData, PdfJobResult, typeof PDF_JOB_NAME>(
  config.queue.name,
  async (job) => {
    try {
      return await render(job);
    } catch (error) {
      const failure = serialiseFailure(error);
      const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      logger.error(
        {
          jobId: job.data.jobId,
          attempt: job.attemptsMade + 1,
          code: isAppError(error) ? error.code : 'INTERNAL_ERROR',
          retryable: isAppError(error) ? error.retryable : true,
          err: error,
        },
        'job failed',
      );
      // Non-retryable failures must not burn the remaining attempts.
      if (isAppError(error) && !error.retryable && !isLastAttempt) {
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

logger.info(
  {
    queue: config.queue.name,
    concurrency: config.worker.concurrency,
    gotenberg: config.gotenberg.url,
    storage: config.storage.driver,
    renderTimeoutMs: config.limits.renderTimeoutMs,
  },
  'worker started',
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  stopJanitor();
  try {
    // Lets the in-flight render finish before the connection goes away.
    await worker.close();
    await closeStorage();
    await connection.quit();
  } catch (error) {
    logger.error({ err: error }, 'error during shutdown');
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled rejection'));
