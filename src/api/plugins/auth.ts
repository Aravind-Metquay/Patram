import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config, type ApiKey } from '../../config/index.js';
import { AppError } from '../../shared/errors.js';

/** Routes that must answer without credentials (container health checks). */
const PUBLIC_PATHS = new Set(['/health', '/ready']);

/**
 * Compares digests rather than raw secrets: timingSafeEqual needs equal-length
 * inputs, and hashing normalises the length without leaking it.
 */
function matches(presented: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function resolveKey(header: string | undefined): ApiKey | null {
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null;
  const presented = rest.join(' ').trim();
  if (!presented) return null;

  let found: ApiKey | null = null;
  // Checks every key so the work does not depend on which key was presented.
  for (const key of config.auth.keys) {
    if (matches(presented, key.secret)) found = key;
  }
  return found;
}

/**
 * Rejects unauthenticated requests before any body is looked at, so a bad key
 * never costs us HTML parsing or a queue round-trip.
 */
export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('apiKey', null);

  app.addHook('onRequest', async (request: FastifyRequest) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (PUBLIC_PATHS.has(path)) return;

    const key = resolveKey(request.headers.authorization);
    if (!key) {
      throw new AppError(401, 'UNAUTHORIZED', 'A valid "Authorization: Bearer <key>" is required', {
        retryable: false,
      });
    }
    request.apiKey = key;
    request.log.debug({ apiKeyId: key.id }, 'request authenticated');
  });
}
