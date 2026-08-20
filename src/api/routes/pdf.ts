import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { Job } from "bullmq";
import { env } from "../../config/env.js";
import { enqueueOrReuse } from "../pdf-request.js";
import {
  getPdfJob,
  QueueFullError,
  toPublicStatus,
  type PdfJobData,
  type PdfJobResult,
} from "../../queue/pdf.queue.js";
import { pdfQueueEvents } from "../../queue/events.js";
import { downloadPdf, getPdfUrl } from "../../storage/r2.js";

function apiKeyFromRequest(request: FastifyRequest): string {
  const header = request.headers.authorization ?? "";
  return header.slice("Bearer ".length).trim();
}

function idempotencyKeyFromRequest(request: FastifyRequest): string | undefined {
  const header = request.headers["idempotency-key"];
  return typeof header === "string" && header.length > 0 ? header : undefined;
}

async function buildStatusPayload(job: Job<PdfJobData, PdfJobResult>) {
  const state = await job.getState();
  const status = toPublicStatus(state);

  if (status === "completed") {
    return {
      id: job.id,
      status,
      result: {
        resultUrl: `/v1/jobs/${job.id}/pdf`,
        size: job.returnvalue?.size,
        durationMs: job.returnvalue?.durationMs,
      },
    };
  }

  if (status === "failed") {
    return { id: job.id, status, error: job.failedReason };
  }

  return { id: job.id, status, statusUrl: `/v1/jobs/${job.id}` };
}

function handleEnqueueError(err: unknown, reply: FastifyReply) {
  if (err instanceof ZodError) {
    reply.code(400).send({ error: "invalid request", details: err.issues });
    return;
  }
  if (err instanceof QueueFullError) {
    reply.code(503).send({ error: err.message });
    return;
  }
  throw err;
}

export async function pdfRoutes(fastify: FastifyInstance) {
  fastify.post("/v1/pdf", async (request, reply) => {
    let result;
    try {
      result = await enqueueOrReuse(
        apiKeyFromRequest(request),
        request.body,
        idempotencyKeyFromRequest(request),
      );
    } catch (err) {
      return handleEnqueueError(err, reply);
    }

    const payload = await buildStatusPayload(result.job);
    reply.code(result.isNew ? 202 : 200).send(payload);
  });

  fastify.get("/v1/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await getPdfJob(id);
    if (!job) {
      reply.code(404).send({ error: "job not found" });
      return;
    }
    reply.send(await buildStatusPayload(job));
  });

  fastify.get("/v1/jobs/:id/pdf", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await getPdfJob(id);
    if (!job) {
      reply.code(404).send({ error: "job not found" });
      return;
    }

    const state = await job.getState();
    if (toPublicStatus(state) !== "completed" || !job.returnvalue) {
      reply.code(409).send({ error: "job not completed", status: toPublicStatus(state) });
      return;
    }

    const url = await getPdfUrl(job.returnvalue.objectKey);
    reply.redirect(url, 302);
  });

  fastify.post("/v1/pdf/sync", async (request, reply) => {
    let result;
    try {
      result = await enqueueOrReuse(
        apiKeyFromRequest(request),
        request.body,
        idempotencyKeyFromRequest(request),
      );
    } catch (err) {
      return handleEnqueueError(err, reply);
    }

    const { job } = result;

    try {
      const returnValue = await job.waitUntilFinished(pdfQueueEvents, env.SYNC_TIMEOUT_MS);
      const pdf = await downloadPdf(returnValue.objectKey);
      reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `attachment; filename="${job.id}.pdf"`)
        .send(pdf);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("timed out")) {
        reply.code(202).send(await buildStatusPayload(job));
        return;
      }
      reply.code(500).send({ error: message });
    }
  });
}
