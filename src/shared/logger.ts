import { pino, type Logger } from 'pino';
import { config } from '../config/index.js';

export function createLogger(name: string): Logger {
  return pino({
    name,
    level: config.logLevel,
    base: { service: name },
    redact: {
      paths: ['req.headers.authorization', 'headers.authorization', 'apiKey', 'secret'],
      censor: '[redacted]',
    },
  });
}

/**
 * The subset of the logger that helpers need. Both pino's Logger and Fastify's
 * FastifyBaseLogger satisfy it, so shared code works with either.
 */
export interface LogSink {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export type { Logger };
