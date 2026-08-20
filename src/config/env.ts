import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.string().default("info"),

  REDIS_URL: z.string().min(1).default("redis://redis:6379"),

  GOTENBERG_URL: z.string().min(1).default("http://gotenberg:3000"),

  PDF_API_KEY: z.string().min(16, "PDF_API_KEY must be set to a strong secret"),

  MAX_HTML_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  MAX_PDF_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),
  RENDER_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  SYNC_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(1),
  JOB_ATTEMPTS: z.coerce.number().int().positive().default(2),
  MAX_QUEUE_SIZE: z.coerce.number().int().positive().default(1000),

  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1).default("pdf-service"),
  R2_PUBLIC_BASE_URL: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
