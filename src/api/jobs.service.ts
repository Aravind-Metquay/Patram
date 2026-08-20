import type { Job } from 'bullmq';
import { config } from '../config/index.js';
import {
  PDF_JOB_NAME,
  toPublicStatus,
  type PdfJobData,
  type PdfJobResult,
  type PublicJobStatus,
} from '../queue/pdf.queue.js';
import { AppError, parseFailure, payloadTooLarge } from '../shared/errors.js';
import { newJobId } from '../shared/ids.js';
import { withDefaults, type PdfOptions } from '../shared/pdf-options.js';
import { objectKeys } from '../storage/index.js';
import type { Services } from './context.js';
import * as idempotency from './idempotency.js';

export type PdfJob = Job<PdfJobData, PdfJobResult, typeof PDF_JOB_NAME>;

export interface CreatePdfInput {
  html: string;
  options?: PdfOptions | undefined;
  filename?: string | undefined;
  apiKeyId: string;
  idempotencyKey?: string | undefined;
}

export interface CreatePdfOutcome {
  jobId: string;
  /** True when an idempotency key matched an earlier request. */
  reused: boolean;
}

export interface JobView {
  id: string;
  status: PublicJobStatus;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  attempts: number;
  status_url: string;
  pdf_url: string | null;
  result: {
    bytes: number;
    render_ms: number;
    total_ms: number;
    expires_at: string;
    download_url: string | null;
  } | null;
  error: { code: string; message: string; retryable: boolean } | null;
}

/**
 * Stages the HTML in object storage and enqueues the render.
 *
 * Nothing here talks to Gotenberg: the queue is the only path to Chromium, so
 * concurrency stays controlled by exactly one system.
 */
export async function createPdfJob(
  services: Services,
  input: CreatePdfInput,
): Promise<CreatePdfOutcome> {
  const htmlBytes = Buffer.byteLength(input.html, 'utf8');
  if (htmlBytes > config.limits.maxHtmlBytes) {
    throw payloadTooLarge(
      'HTML_TOO_LARGE',
      `html is ${htmlBytes} bytes, limit is ${config.limits.maxHtmlBytes} bytes`,
    );
  }

  const options = withDefaults(input.options);
  const fingerprint = idempotency.fingerprint({
    html: input.html,
    options,
    filename: input.filename ?? null,
  });

  if (input.idempotencyKey) {
    const existing = await idempotency.lookup(
      services.redis,
      input.apiKeyId,
      input.idempotencyKey,
      fingerprint,
    );
    if (existing) return resolveReservation(existing);
  }

  await assertQueueHasRoom(services);

  const jobId = newJobId();
  if (input.idempotencyKey) {
    const reservation = await idempotency.reserve(
      services.redis,
      input.apiKeyId,
      input.idempotencyKey,
      fingerprint,
      jobId,
    );
    if (reservation.kind !== 'reserved') return resolveReservation(reservation);
  }

  const inputKey = objectKeys.input(jobId);
  try {
    await services.storage.put(inputKey, Buffer.from(input.html, 'utf8'), 'text/html; charset=utf-8');
    await services.queue.add(
      PDF_JOB_NAME,
      {
        jobId,
        inputKey,
        options,
        filename: input.filename,
        apiKeyId: input.apiKeyId,
        requestedAt: new Date().toISOString(),
        idempotencyKey: input.idempotencyKey,
      },
      { jobId },
    );
  } catch (error) {
    // Never leave a reservation or a staged file behind for a job that does not exist.
    if (input.idempotencyKey) {
      await idempotency
        .release(services.redis, input.apiKeyId, input.idempotencyKey)
        .catch(() => undefined);
    }
    await services.storage.delete(inputKey).catch(() => undefined);
    throw error;
  }

  return { jobId, reused: false };
}

function resolveReservation(reservation: idempotency.Reservation): CreatePdfOutcome {
  if (reservation.kind === 'conflict') {
    throw new AppError(
      409,
      'IDEMPOTENCY_CONFLICT',
      'This Idempotency-Key was already used with a different payload',
      { retryable: false, details: { jobId: reservation.jobId } },
    );
  }
  if (reservation.kind === 'existing') {
    return { jobId: reservation.jobId, reused: true };
  }
  throw new AppError(500, 'INTERNAL_ERROR', 'Unexpected idempotency state');
}

/** Backpressure: a full queue is answered immediately instead of growing without bound. */
async function assertQueueHasRoom(services: Services): Promise<void> {
  const counts = await services.queue.getJobCounts(
    'waiting',
    'active',
    'delayed',
    'prioritized',
    'paused',
  );
  const pending = Object.values(counts).reduce((total, count) => total + (count ?? 0), 0);
  if (pending >= config.queue.maxQueuedJobs) {
    throw new AppError(503, 'QUEUE_FULL', `Queue is at capacity (${pending} jobs pending)`, {
      retryable: true,
      details: { pending, limit: config.queue.maxQueuedJobs },
    });
  }
}

export async function loadJob(services: Services, jobId: string): Promise<PdfJob | null> {
  const job = await services.queue.getJob(jobId);
  return (job as PdfJob | undefined) ?? null;
}

export async function toJobView(services: Services, job: PdfJob): Promise<JobView> {
  const status = toPublicStatus(await job.getState());
  const jobId = job.data.jobId ?? String(job.id);
  const result = status === 'completed' ? (job.returnvalue as PdfJobResult | undefined) : undefined;

  let downloadUrl: string | null = null;
  if (result) {
    downloadUrl = await services.storage
      .presign(
        result.outputKey,
        config.storage.r2.presignTtlSeconds,
        job.data.filename ?? `${jobId}.pdf`,
      )
      .catch(() => null);
  }

  return {
    id: jobId,
    status,
    created_at: job.timestamp ? new Date(job.timestamp).toISOString() : null,
    started_at: job.processedOn ? new Date(job.processedOn).toISOString() : null,
    finished_at: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    attempts: job.attemptsMade,
    status_url: `/v1/jobs/${jobId}`,
    pdf_url: status === 'completed' ? `/v1/jobs/${jobId}/pdf` : null,
    result: result
      ? {
          bytes: result.bytes,
          render_ms: result.renderMs,
          total_ms: result.totalMs,
          expires_at: result.expiresAt,
          download_url: downloadUrl,
        }
      : null,
    error: status === 'failed' ? parseFailure(job.failedReason) : null,
  };
}

export async function getJobView(services: Services, jobId: string): Promise<JobView | null> {
  const job = await loadJob(services, jobId);
  return job ? toJobView(services, job) : null;
}

export type WaitOutcome = { kind: 'completed'; job: PdfJob } | { kind: 'timeout'; job: PdfJob };

/**
 * Waits for a queued job to finish, for the synchronous endpoint.
 * A failed job throws; a slow job comes back as a timeout so the caller can
 * hand the client a job id instead of holding the connection open.
 */
export async function waitForJob(
  services: Services,
  jobId: string,
  timeoutMs: number,
): Promise<WaitOutcome> {
  const { queueEvents } = services;
  if (!queueEvents) {
    throw new AppError(501, 'SYNC_DISABLED', 'Synchronous rendering is disabled on this instance');
  }

  const job = await loadJob(services, jobId);
  if (!job) throw new AppError(404, 'JOB_NOT_FOUND', `Unknown job ${jobId}`, { retryable: false });

  try {
    await job.waitUntilFinished(queueEvents, timeoutMs);
  } catch (error) {
    const refreshed = await loadJob(services, jobId);
    // The job outlived our patience rather than failing.
    if (!refreshed || toPublicStatus(await refreshed.getState()) !== 'failed') {
      return { kind: 'timeout', job: refreshed ?? job };
    }
    const failure = parseFailure(refreshed.failedReason);
    throw new AppError(failureToStatus(failure.code), failure.code, failure.message, {
      retryable: failure.retryable,
      cause: error,
    });
  }

  const finished = (await loadJob(services, jobId)) ?? job;
  return { kind: 'completed', job: finished };
}

/** Maps a worker failure code onto the HTTP status the client should see. */
export function failureToStatus(code: string): number {
  switch (code) {
    case 'RENDER_REJECTED':
      return 422;
    case 'RENDER_TIMEOUT':
      return 504;
    case 'PDF_TOO_LARGE':
      return 413;
    case 'INPUT_MISSING':
      return 410;
    case 'RENDERER_UNAVAILABLE':
    case 'RENDERER_ERROR':
      return 502;
    default:
      return 500;
  }
}
