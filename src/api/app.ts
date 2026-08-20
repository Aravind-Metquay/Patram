import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { config } from '../config/index.js';
import { AppError, isAppError } from '../shared/errors.js';
import type { Services } from './context.js';
import { registerAuth } from './plugins/auth.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerPdfRoutes } from './routes/pdf.js';
import './types.js';

export async function buildApp(services: Services): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      name: 'pdf-api',
      level: config.logLevel,
      redact: {
        paths: ['req.headers.authorization', 'req.headers["idempotency-key"]'],
        censor: '[redacted]',
      },
    },
    // Rejects oversized uploads before a single byte reaches our handlers.
    bodyLimit: config.api.maxRequestBytes,
    requestTimeout: config.api.requestTimeoutMs,
    trustProxy: config.api.trustProxy,
    requestIdHeader: 'x-request-id',
    ajv: { customOptions: { allErrors: false, coerceTypes: false, removeAdditional: false } },
  });

  app.decorate('services', services);

  // Order matters: authentication runs first so the rate limiter can key on the
  // API key rather than an easily-spoofed client address.
  registerAuth(app);

  if (config.rateLimit.enabled) {
    await app.register(rateLimit, {
      global: true,
      max: config.rateLimit.max,
      timeWindow: config.rateLimit.windowMs,
      redis: services.redis,
      // Shared Redis: keep our keys out of BullMQ's namespace.
      nameSpace: 'ratelimit:',
      keyGenerator: (request) => request.apiKey?.id ?? request.ip,
      allowList: (request) => request.url === '/health' || request.url === '/ready',
      // Returning an AppError lets the shared error handler render it, so a 429
      // looks exactly like every other error from this API.
      errorResponseBuilder: (_request, context) =>
        new AppError(
          429,
          'RATE_LIMITED',
          `Rate limit exceeded: ${context.max} requests per ${context.after}`,
          { retryable: true, details: { retry_after_ms: context.ttl } },
        ),
    });
  }

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (isAppError(error)) {
      const level = error.statusCode >= 500 ? 'error' : 'warn';
      request.log[level]({ err: error, code: error.code }, 'request failed');
      return reply.code(error.statusCode).send(error.toJSON());
    }

    if (error.validation) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: error.message,
          details: error.validation,
        },
      });
    }

    const status = error.statusCode ?? 500;
    if (status === 413) {
      return reply.code(413).send({
        error: {
          code: 'REQUEST_TOO_LARGE',
          message: `Request body exceeds the ${config.api.maxRequestBytes} byte limit`,
        },
      });
    }
    if (status < 500) {
      return reply.code(status).send({
        error: { code: error.code ?? 'BAD_REQUEST', message: error.message },
      });
    }

    request.log.error({ err: error }, 'unhandled request error');
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong generating the PDF' },
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}` },
    }),
  );

  registerHealthRoutes(app);
  registerPdfRoutes(app);
  registerJobRoutes(app);

  return app;
}
