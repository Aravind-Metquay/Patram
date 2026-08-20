import { createHash } from "node:crypto";
import { createRedisConnection } from "./connection.js";

const TTL_SECONDS = 24 * 60 * 60;

const redis = createRedisConnection();

function keyFor(apiKey: string, idempotencyKey: string): string {
  const apiKeyHash = createHash("sha256").update(apiKey).digest("hex");
  return `idempotency:${apiKeyHash}:${idempotencyKey}`;
}

/**
 * Atomically claims (apiKey, idempotencyKey) for jobId.
 * Returns the jobId that owns the claim: `jobId` itself if this call won the
 * claim, or a pre-existing jobId if another request already claimed it.
 */
export async function claimIdempotencyKey(
  apiKey: string,
  idempotencyKey: string,
  jobId: string,
): Promise<{ jobId: string; isNew: boolean }> {
  const redisKey = keyFor(apiKey, idempotencyKey);
  const result = await redis.set(redisKey, jobId, "EX", TTL_SECONDS, "NX");
  if (result === "OK") {
    return { jobId, isNew: true };
  }
  const existingJobId = await redis.get(redisKey);
  return { jobId: existingJobId ?? jobId, isNew: existingJobId === null };
}

/** Overwrites the claim to point at a fresh jobId, e.g. when the previously
 * claimed job has since been swept from the queue. */
export async function reclaimIdempotencyKey(
  apiKey: string,
  idempotencyKey: string,
  jobId: string,
): Promise<void> {
  await redis.set(keyFor(apiKey, idempotencyKey), jobId, "EX", TTL_SECONDS);
}
