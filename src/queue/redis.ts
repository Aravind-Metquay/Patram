import { Redis, type RedisOptions } from 'ioredis';
import { config } from '../config/index.js';

/**
 * BullMQ's blocking connections must not give up on commands, so anything that
 * backs a Queue/Worker/QueueEvents gets maxRetriesPerRequest: null.
 * Plain command connections (rate limiting, idempotency) keep the defaults.
 */
export function createRedis(kind: 'command' | 'blocking' = 'command'): Redis {
  const options: RedisOptions =
    kind === 'blocking'
      ? { maxRetriesPerRequest: null, enableReadyCheck: false }
      : { maxRetriesPerRequest: 3 };
  return new Redis(config.redis.url, { lazyConnect: false, ...options });
}
