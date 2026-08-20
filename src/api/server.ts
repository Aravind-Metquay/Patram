import { assertRuntimeConfig, config } from '../config/index.js';
import { initMetrics, registerQueueDepthGauge, startMetricsServer } from '../shared/metrics.js';
import { startVitals } from '../shared/vitals.js';
import { buildApp } from './app.js';
import { closeServices, createServices } from './context.js';

assertRuntimeConfig('api');

const services = createServices();
const app = await buildApp(services);

const QUEUE_STATES = ['waiting', 'active', 'delayed', 'prioritized', 'paused', 'failed'] as const;

async function queueCounts(): Promise<Record<string, number>> {
  const counts = await services.queue.getJobCounts(...QUEUE_STATES);
  return Object.fromEntries(
    Object.entries(counts).map(([state, count]) => [state, count ?? 0]),
  );
}

initMetrics('api');
registerQueueDepthGauge(queueCounts);

const metricsServer = config.observability.metricsEnabled
  ? startMetricsServer(config.observability.apiMetricsPort, '0.0.0.0', app.log)
  : null;

const stopVitals = startVitals(app.log, {
  intervalMs: config.observability.vitalsIntervalSeconds * 1000,
  collect: async () => {
    const counts = await queueCounts();
    return {
      role: 'api',
      queue_waiting: counts.waiting ?? 0,
      queue_active: counts.active ?? 0,
      queue_delayed: counts.delayed ?? 0,
      queue_failed: counts.failed ?? 0,
      queue_pending:
        (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0) +
        (counts.prioritized ?? 0) + (counts.paused ?? 0),
      queue_limit: config.queue.maxQueuedJobs,
    };
  },
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  stopVitals();
  metricsServer?.close();
  try {
    // Stops accepting connections, drains in-flight requests, then lets go of Redis.
    await app.close();
    await closeServices(services);
  } catch (error) {
    app.log.error({ err: error }, 'error during shutdown');
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => app.log.error({ err: reason }, 'unhandled rejection'));

try {
  await app.listen({ host: config.api.host, port: config.api.port });
  app.log.info(
    {
      queue: config.queue.name,
      storage: config.storage.driver,
      gotenberg: config.gotenberg.url,
      syncEnabled: config.sync.enabled,
      apiKeys: config.auth.keys.length,
      rateLimit: config.rateLimit.enabled
        ? { writes: config.rateLimit.max, reads: config.rateLimit.readMax }
        : 'disabled',
      metricsPort: config.observability.metricsEnabled
        ? config.observability.apiMetricsPort
        : null,
    },
    'api started',
  );
} catch (error) {
  app.log.error({ err: error }, 'failed to start api');
  process.exit(1);
}
