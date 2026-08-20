import Fastify from "fastify";
import { env } from "../config/env.js";
import { loggerOptions } from "../shared/logger.js";
import { healthRoutes } from "./routes/health.js";
import { pdfRoutes } from "./routes/pdf.js";
import { requireApiKey } from "./plugins/auth.js";

const app = Fastify({
  logger: loggerOptions,
  bodyLimit: env.MAX_HTML_BYTES,
});

await app.register(healthRoutes);

// Encapsulated context: the auth hook is added directly on `instance` (not
// inside a nested plugin, which would get its own encapsulation and never
// apply to its siblings) so it covers every route registered within, while
// leaving /health public.
await app.register(async (instance) => {
  instance.addHook("onRequest", requireApiKey);
  await instance.register(pdfRoutes);
});

async function shutdown(signal: string) {
  app.log.info({ signal }, "shutting down api");
  await app.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err, "failed to start api");
  process.exit(1);
}
