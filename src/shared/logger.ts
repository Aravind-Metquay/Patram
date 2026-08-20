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

export type { Logger };
