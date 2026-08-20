import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../../config/index.js';
import { AppError, badRequest } from '../../shared/errors.js';
import { metrics } from '../../shared/metrics.js';
import { PDF_OPTIONS_SCHEMA, type PdfOptions } from '../../shared/pdf-options.js';
import { createPdfJob, getJobView, toJobView, waitForJob } from '../jobs.service.js';
import { sendPdf } from '../pdf-reply.js';

interface CreatePdfBody {
  html: string;
  filename?: string;
  options?: PdfOptions;
}

const bodySchema = {
  type: 'object',
  required: ['html'],
  additionalProperties: false,
  properties: {
    html: { type: 'string', minLength: 1, maxLength: config.limits.maxHtmlBytes },
    filename: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9._-]+$' },
    options: PDF_OPTIONS_SCHEMA,
  },
} as const;

/** Idempotency keys are client-supplied, so they are length-checked here. */
function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > 255) {
    throw badRequest('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be at most 255 characters');
  }
  return trimmed;
}

export function registerPdfRoutes(app: FastifyInstance): void {
  /**
   * Asynchronous render. Returns as soon as the job is durable, which keeps
   * load spikes in the queue instead of in Chromium.
   */
  app.post<{ Body: CreatePdfBody }>(
    '/v1/pdf',
    { schema: { body: bodySchema } },
    async (request, reply) => {
      const apiKeyId = request.apiKey?.id ?? 'unknown';
      const outcome = await createPdfJob(app.services, {
        html: request.body.html,
        options: request.body.options,
        filename: request.body.filename,
        apiKeyId,
        idempotencyKey: idempotencyKey(request),
      });

      const view = await getJobView(app.services, outcome.jobId);
      if (!view) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Job disappeared immediately after enqueue');
      }

      metrics.jobsAccepted.inc({ mode: 'async', reused: String(outcome.reused) });
      request.log.info(
        {
          jobId: outcome.jobId,
          apiKeyId,
          reused: outcome.reused,
          html_bytes: Buffer.byteLength(request.body.html, 'utf8'),
          mode: 'async',
        },
        'pdf job accepted',
      );
      // A replayed idempotent request is not a new job, so it is not a 202.
      return reply.code(outcome.reused ? 200 : 202).send({ ...view, reused: outcome.reused });
    },
  );

  if (!config.sync.enabled) return;

  /**
   * Synchronous convenience wrapper. It still goes through the queue - the
   * worker remains the only thing that talks to Gotenberg - and gives up after
   * SYNC_TIMEOUT_MS, handing back a job id to poll instead.
   */
  app.post<{ Body: CreatePdfBody }>(
    '/v1/pdf/sync',
    { schema: { body: bodySchema } },
    async (request, reply) => {
      const apiKeyId = request.apiKey?.id ?? 'unknown';
      const outcome = await createPdfJob(app.services, {
        html: request.body.html,
        options: request.body.options,
        filename: request.body.filename,
        apiKeyId,
        idempotencyKey: idempotencyKey(request),
      });

      metrics.jobsAccepted.inc({ mode: 'sync', reused: String(outcome.reused) });
      request.log.info(
        {
          jobId: outcome.jobId,
          apiKeyId,
          reused: outcome.reused,
          html_bytes: Buffer.byteLength(request.body.html, 'utf8'),
          mode: 'sync',
        },
        'pdf job accepted',
      );

      const waited = await waitForJob(app.services, outcome.jobId, config.sync.timeoutMs);
      if (waited.kind === 'timeout') {
        const view = await toJobView(app.services, waited.job);
        request.log.warn(
          { jobId: outcome.jobId, waitedMs: config.sync.timeoutMs },
          'sync render timed out, returning job id',
        );
        return reply.code(202).send({
          ...view,
          message: 'Still rendering. Poll status_url for the result.',
        });
      }

      const result = waited.job.returnvalue;
      if (!result) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Completed job has no result');
      }
      const object = await app.services.storage.getStream(result.outputKey);
      request.log.info(
        {
          jobId: outcome.jobId,
          pdf_bytes: result.bytes,
          render_ms: result.renderMs,
          total_ms: result.totalMs,
        },
        'sync render completed',
      );
      return sendPdf(reply, object, outcome.jobId, request.body.filename);
    },
  );
}
