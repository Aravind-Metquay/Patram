import { Worker, type Job } from "bullmq";
import { env } from "../config/env.js";
import { logger } from "../shared/logger.js";
import { renderHtmlToPdf } from "../renderer/gotenberg.js";
import { objectKeyForJob, uploadPdf } from "../storage/r2.js";
import { PDF_QUEUE_NAME, type PdfJobData, type PdfJobResult } from "../queue/pdf.queue.js";
import { createRedisConnection } from "../queue/connection.js";

const log = logger.child({ module: "worker" });
const connection = createRedisConnection();

async function processJob(job: Job<PdfJobData, PdfJobResult>): Promise<PdfJobResult> {
  const { jobId, html, options } = job.data;
  const jobLog = log.child({ jobId });
  const startedAt = Date.now();

  jobLog.info({ htmlBytes: Buffer.byteLength(html) }, "job received");

  jobLog.info("render started");
  jobLog.info("gotenberg request started");
  const pdf = await renderHtmlToPdf(html, options, { timeoutMs: env.RENDER_TIMEOUT_MS });
  jobLog.info({ pdfBytes: pdf.length }, "gotenberg request completed");

  if (pdf.length > env.MAX_PDF_BYTES) {
    throw new Error(`Rendered PDF (${pdf.length} bytes) exceeds MAX_PDF_BYTES (${env.MAX_PDF_BYTES})`);
  }

  const objectKey = objectKeyForJob(jobId);
  await uploadPdf(objectKey, pdf);

  const durationMs = Date.now() - startedAt;
  jobLog.info({ pdfBytes: pdf.length, durationMs }, "job completed");

  return { objectKey, size: pdf.length, durationMs };
}

const worker = new Worker<PdfJobData, PdfJobResult>(PDF_QUEUE_NAME, processJob, {
  connection,
  concurrency: env.WORKER_CONCURRENCY,
});

worker.on("failed", (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, "job failed");
});

worker.on("error", (err) => {
  log.error({ err: err.message }, "worker error");
});

log.info({ concurrency: env.WORKER_CONCURRENCY }, "pdf worker started");

async function shutdown(signal: string) {
  log.info({ signal }, "shutting down worker");
  await worker.close();
  connection.disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
