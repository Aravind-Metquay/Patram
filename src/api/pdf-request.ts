import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Job } from "bullmq";
import { pdfOptionsSchema } from "../renderer/gotenberg.js";
import {
  enqueuePdfJob,
  getPdfJob,
  type PdfJobData,
  type PdfJobResult,
} from "../queue/pdf.queue.js";
import { claimIdempotencyKey, reclaimIdempotencyKey } from "../queue/idempotency.js";

export const pdfRequestSchema = z.object({
  html: z.string().min(1, "html must not be empty"),
  options: pdfOptionsSchema.optional().default({}),
});

export interface EnqueueResult {
  job: Job<PdfJobData, PdfJobResult>;
  isNew: boolean;
}

/**
 * Validates the request body and enqueues a render job, honoring an
 * Idempotency-Key by returning the already-queued/rendered job instead of
 * creating a duplicate when the same (apiKey, idempotencyKey) pair is reused.
 */
export async function enqueueOrReuse(
  apiKey: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<EnqueueResult> {
  const parsed = pdfRequestSchema.parse(body);
  const candidateJobId = `pdf_${randomUUID()}`;

  if (idempotencyKey) {
    const claim = await claimIdempotencyKey(apiKey, idempotencyKey, candidateJobId);
    if (!claim.isNew) {
      const existing = await getPdfJob(claim.jobId);
      if (existing) {
        return { job: existing, isNew: false };
      }
      // The claimed job was swept from the queue already; reclaim the key
      // for a fresh job below instead of returning a dangling reference.
      await reclaimIdempotencyKey(apiKey, idempotencyKey, candidateJobId);
    }
  }

  const job = await enqueuePdfJob({
    jobId: candidateJobId,
    html: parsed.html,
    options: parsed.options,
    idempotencyKey,
  });
  return { job, isNew: true };
}
