import type { FastifyInstance } from 'fastify';
import { config } from '../../config/index.js';

/** Unauthenticated: these are what Docker and the reverse proxy poll. */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health', async () => ({
    status: 'ok',
    uptime_seconds: Math.round(process.uptime()),
  }));

  app.get('/ready', async (_request, reply) => {
    const [redis, gotenberg] = await Promise.all([
      app.services.redis
        .ping()
        .then((response) => response === 'PONG')
        .catch(() => false),
      app.services.gotenberg.health(),
    ]);

    const ready = redis && gotenberg;
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ok' : 'degraded',
      checks: { redis, gotenberg },
      storage: config.storage.driver,
    });
  });
}
