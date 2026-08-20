import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { config } from '../config/index.js';

export type Reservation =
  | { kind: 'reserved' }
  | { kind: 'existing'; jobId: string }
  | { kind: 'conflict'; jobId: string };

/**
 * Identifies the request payload so a reused idempotency key carrying different
 * content is reported as a conflict instead of silently returning the old PDF.
 */
export function fingerprint(parts: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

function redisKey(apiKeyId: string, idempotencyKey: string): string {
  const digest = crypto.createHash('sha256').update(idempotencyKey).digest('hex');
  return `idem:${apiKeyId}:${digest}`;
}

function decode(value: string, expected: string): Reservation {
  const separator = value.indexOf('|');
  const storedFingerprint = separator === -1 ? '' : value.slice(0, separator);
  const jobId = separator === -1 ? value : value.slice(separator + 1);
  return storedFingerprint === expected
    ? { kind: 'existing', jobId }
    : { kind: 'conflict', jobId };
}

export async function lookup(
  redis: Redis,
  apiKeyId: string,
  idempotencyKey: string,
  expected: string,
): Promise<Reservation | null> {
  const value = await redis.get(redisKey(apiKeyId, idempotencyKey));
  return value === null ? null : decode(value, expected);
}

/** Claims the key for `jobId`, or reports who already owns it. */
export async function reserve(
  redis: Redis,
  apiKeyId: string,
  idempotencyKey: string,
  expected: string,
  jobId: string,
): Promise<Reservation> {
  const key = redisKey(apiKeyId, idempotencyKey);
  const stored = await redis.set(
    key,
    `${expected}|${jobId}`,
    'EX',
    config.retention.idempotencyTtlSeconds,
    'NX',
  );
  if (stored === 'OK') return { kind: 'reserved' };

  const existing = await redis.get(key);
  // The owner vanished between SET NX and GET; treat the key as ours.
  if (existing === null) return { kind: 'reserved' };
  return decode(existing, expected);
}

/** Frees a reservation when the job could not be enqueued after all. */
export async function release(
  redis: Redis,
  apiKeyId: string,
  idempotencyKey: string,
): Promise<void> {
  await redis.del(redisKey(apiKeyId, idempotencyKey));
}
