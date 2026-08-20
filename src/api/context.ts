import { QueueEvents } from 'bullmq';
import type { Redis } from 'ioredis';
import { config } from '../config/index.js';
import { createPdfQueue, type PdfQueue } from '../queue/pdf.queue.js';
import { createRedis } from '../queue/redis.js';
import { GotenbergClient } from '../renderer/gotenberg.js';
import { closeStorage, getStorage, type Storage } from '../storage/index.js';

/** Everything the routes need, created once per process. */
export interface Services {
  redis: Redis;
  queue: PdfQueue;
  /** Only created when the synchronous endpoint is enabled - it holds a blocking connection. */
  queueEvents: QueueEvents | null;
  storage: Storage;
  gotenberg: GotenbergClient;
}

export function createServices(): Services {
  const redis = createRedis('command');
  const queue = createPdfQueue(createRedis('blocking'));
  const queueEvents = config.sync.enabled
    ? new QueueEvents(config.queue.name, { connection: createRedis('blocking') })
    : null;

  return {
    redis,
    queue,
    queueEvents,
    storage: getStorage(),
    gotenberg: new GotenbergClient({
      baseUrl: config.gotenberg.url,
      timeoutMs: config.limits.renderTimeoutMs,
      maxPdfBytes: config.limits.maxPdfBytes,
    }),
  };
}

export async function closeServices(services: Services): Promise<void> {
  await services.queueEvents?.close();
  await services.queue.close();
  await closeStorage();
  await services.redis.quit();
}
