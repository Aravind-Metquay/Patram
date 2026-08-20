import { Job, Queue } from "bullmq";
import { env } from "../config/env.js";
import type { PdfRenderOptions } from "../renderer/gotenberg.js";
import { createRedisConnection } from "./connection.js";

export const PDF_QUEUE_NAME = "pdf-render";

export interface PdfJobData {
  jobId: string;
  html: string;
  options: PdfRenderOptions;
  idempotencyKey?: string;
}

export interface PdfJobResult {
  objectKey: string;
  size: number;
  durationMs: number;
}

const connection = createRedisConnection();

export const pdfQueue = new Queue<PdfJobData, PdfJobResult>(PDF_QUEUE_NAME, { connection });

export class QueueFullError extends Error {
  constructor() {
    super("Queue is at capacity, try again later");
    this.name = "QueueFullError";
  }
}

export async function enqueuePdfJob(data: PdfJobData) {
  const counts = await pdfQueue.getJobCounts("waiting", "active", "delayed");
  const inFlight = (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
  if (inFlight >= env.MAX_QUEUE_SIZE) {
    throw new QueueFullError();
  }

  return pdfQueue.add(data.jobId, data, {
    jobId: data.jobId,
    attempts: env.JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { age: 60 * 60 },
    removeOnFail: { age: 24 * 60 * 60 },
  });
}

export function getPdfJob(jobId: string) {
  return Job.fromId<PdfJobData, PdfJobResult>(pdfQueue, jobId);
}

export type PdfJobStatus = "queued" | "active" | "completed" | "failed";

export function toPublicStatus(bullState: string): PdfJobStatus {
  switch (bullState) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "active":
      return "active";
    default:
      // waiting, waiting-children, delayed, paused, unknown
      return "queued";
  }
}
