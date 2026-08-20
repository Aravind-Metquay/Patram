import type { ApiKey } from '../config/index.js';
import type { Services } from './context.js';

declare module 'fastify' {
  interface FastifyInstance {
    services: Services;
  }
  interface FastifyRequest {
    /** Set by the auth hook; null on public routes. */
    apiKey: ApiKey | null;
  }
}

export {};
