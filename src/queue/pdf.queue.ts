import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { config } from '../config/index.js';
import type { PdfOptions } from '../shared/pdf-options.js';

export const PDF_JOB_NAME = 'render';

/**
 * What travels through Redis. Deliberately small: the HTML itself is staged in
 * object storage and referenced by key, so Redis stays a control plane.
 */
export interface PdfJobData {
  jobId: string;
  inputKey: string;
  options: PdfOptions;
  filename?: string | undefined;
  apiKeyId: string;
  requestedAt: string;
  idempotencyKey?: string | undefined;
}

export interface PdfJobResult {
  outputKey: string;
  bytes: number;
  /** Time spent inside Gotenberg. */
  renderMs: number;
  /** Time spent in the worker, including storage reads and writes. */
  totalMs: number;
  completedAt: string;
  expiresAt: string;
}

export type PdfQueue = Queue<PdfJobData, PdfJobResult, typeof PDF_JOB_NAME>;

export function createPdfQueue(connection: Redis): PdfQueue {
  return new Queue<PdfJobData, PdfJobResult, typeof PDF_JOB_NAME>(config.queue.name, {
    connection,
    defaultJobOptions: defaultJobOptions(),
  });
}

export function defaultJobOptions(): JobsOptions {
  return {
    attempts: config.queue.attempts,
    backoff: { type: 'exponential', delay: config.queue.backoffMs },
    // Job records outlive the PDF by a minute so a status poll that races the
    // janitor still gets a useful answer.
    removeOnComplete: { age: config.retention.pdfTtlSeconds + 60 },
    removeOnFail: { age: config.retention.failedTtlSeconds },
  };
}

export type PublicJobStatus = 'queued' | 'active' | 'completed' | 'failed' | 'unknown';

/** Collapses BullMQ's internal states into the four the API promises. */
export function toPublicStatus(state: string): PublicJobStatus {
  switch (state) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'active':
      return 'active';
    case 'waiting':
    case 'waiting-children':
    case 'prioritized':
    case 'delayed':
    case 'paused':
      return 'queued';
    default:
      return 'unknown';
  }
}
