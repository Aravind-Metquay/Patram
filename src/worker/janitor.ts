import { config } from '../config/index.js';
import type { Storage } from '../storage/index.js';
import type { Logger } from '../shared/logger.js';

/**
 * Deletes expired artefacts on an interval.
 *
 * Completed PDFs expire quickly; inputs belonging to failed jobs are kept
 * longer so a failure can still be reproduced. On R2 a bucket lifecycle rule
 * does this more cheaply - this loop is the safety net.
 */
export function startJanitor(storage: Storage, logger: Logger): () => void {
  const rules = [
    { endsWith: 'output.pdf', maxAgeMs: config.retention.pdfTtlSeconds * 1000 },
    { endsWith: 'input.html', maxAgeMs: config.retention.failedTtlSeconds * 1000 },
  ];

  let running = false;
  const sweep = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const deleted = await storage.prune(rules);
      if (deleted > 0) logger.info({ deleted }, 'janitor removed expired objects');
    } catch (error) {
      logger.warn({ err: error }, 'janitor sweep failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void sweep(), config.janitor.intervalSeconds * 1000);
  timer.unref();
  void sweep();

  return () => clearInterval(timer);
}
