import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../../config/env.js";

function sha256(input: string): Buffer {
  return createHash("sha256").update(input).digest();
}

const expectedHash = sha256(env.PDF_API_KEY);

function isAuthorized(header: string | undefined): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return false;
  return timingSafeEqual(sha256(token), expectedHash);
}

/**
 * Plain onRequest hook (not a registered plugin) so callers can attach it
 * directly to a Fastify instance with `addHook`. A plugin registered via
 * `register()` gets its own encapsulated context in Fastify, so a hook
 * added inside one would NOT apply to sibling plugins registered next to
 * it — only to routes declared within that same plugin.
 */
export async function requireApiKey(request: FastifyRequest, reply: FastifyReply) {
  if (!isAuthorized(request.headers.authorization)) {
    reply.code(401).send({ error: "unauthorized" });
  }
}
