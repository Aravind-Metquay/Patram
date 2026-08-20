import type { FastifyInstance } from 'fastify';
import { toPublicStatus } from '../../queue/pdf.queue.js';
import { AppError, badRequest, parseFailure } from '../../shared/errors.js';
import { isJobId } from '../../shared/ids.js';
import { failureToStatus, loadJob, toJobView } from '../jobs.service.js';
import { sendPdf } from '../pdf-reply.js';

interface JobParams {
  id: string;
}

const paramsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

export function registerJobRoutes(app: FastifyInstance): void {
  app.get<{ Params: JobParams }>(
    '/v1/jobs/:id',
    { schema: { params: paramsSchema } },
    async (request) => {
      const job = await requireJob(app, request.params.id);
      return toJobView(app.services, job);
    },
  );

  app.get<{ Params: JobParams }>(
    '/v1/jobs/:id/pdf',
    { schema: { params: paramsSchema } },
    async (request, reply) => {
      const job = await requireJob(app, request.params.id);
      const status = toPublicStatus(await job.getState());

      if (status === 'failed') {
        const failure = parseFailure(job.failedReason);
        throw new AppError(failureToStatus(failure.code), failure.code, failure.message, {
          retryable: failure.retryable,
        });
      }
      if (status !== 'completed') {
        throw new AppError(409, 'JOB_NOT_READY', `Job is ${status}, no PDF yet`, {
          retryable: true,
          details: { status },
        });
      }

      const result = job.returnvalue;
      if (!result) throw new AppError(500, 'INTERNAL_ERROR', 'Completed job has no result');

      const object = await app.services.storage.getStream(result.outputKey);
      return sendPdf(reply, object, request.params.id, job.data.filename);
    },
  );
}

async function requireJob(app: FastifyInstance, id: string) {
  if (!isJobId(id)) {
    throw badRequest('INVALID_JOB_ID', 'Job ids look like "pdf_01J..."');
  }
  const job = await loadJob(app.services, id);
  if (!job) {
    // Also what an expired job looks like: records are pruned on a TTL.
    throw new AppError(404, 'JOB_NOT_FOUND', `Unknown or expired job ${id}`, { retryable: false });
  }
  return job;
}
