import type { FastifyReply } from 'fastify';
import { AppError } from '../shared/errors.js';
import type { StoredObject } from '../storage/index.js';

function pdfFilename(candidate: string | undefined, jobId: string): string {
  const base = candidate?.trim() || `${jobId}.pdf`;
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_');
  return safe.toLowerCase().endsWith('.pdf') ? safe : `${safe}.pdf`;
}

/** Streams a stored PDF back to the client without buffering it in the API. */
export function sendPdf(
  reply: FastifyReply,
  object: StoredObject | null,
  jobId: string,
  filename?: string | undefined,
): FastifyReply {
  if (!object) {
    throw new AppError(410, 'PDF_EXPIRED', 'The generated PDF is no longer available', {
      retryable: false,
    });
  }
  reply
    .header('content-type', 'application/pdf')
    .header('content-disposition', `attachment; filename="${pdfFilename(filename, jobId)}"`)
    .header('x-pdf-job-id', jobId)
    .header('cache-control', 'private, no-store');
  if (object.bytes !== undefined) reply.header('content-length', object.bytes);
  return reply.send(object.stream);
}
