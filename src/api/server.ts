import { assertRuntimeConfig, config } from '../config/index.js';
import { buildApp } from './app.js';
import { closeServices, createServices } from './context.js';

assertRuntimeConfig('api');

const services = createServices();
const app = await buildApp(services);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
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
    },
    'api started',
  );
} catch (error) {
  app.log.error({ err: error }, 'failed to start api');
  process.exit(1);
}
