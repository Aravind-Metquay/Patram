import { QueueEvents } from "bullmq";
import { PDF_QUEUE_NAME } from "./pdf.queue.js";
import { createRedisConnection } from "./connection.js";

export const pdfQueueEvents = new QueueEvents(PDF_QUEUE_NAME, {
  connection: createRedisConnection(),
});
