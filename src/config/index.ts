/**
 * Single source of truth for configuration.
 *
 * Everything comes from the environment so the same image can run as the API
 * process or the worker process with nothing but env differences.
 */

function raw(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function str(name: string, fallback: string): string {
  return raw(name) ?? fallback;
}

function required(name: string): string {
  const value = raw(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function int(name: string, fallback: number): number {
  const value = raw(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${value}"`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const value = raw(name)?.toLowerCase();
  if (value === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`Environment variable ${name} must be a boolean, got "${value}"`);
}

export interface ApiKey {
  /** Stable, non-secret identifier used in logs, rate limits and idempotency keys. */
  id: string;
  secret: string;
}

/**
 * API keys come from either:
 *   PDF_API_KEY=pdf_sk_xxx                     (single key, id "default")
 *   PDF_API_KEYS=label:pdf_sk_xxx,other:pdf_sk_yyy
 *
 * No database yet - deliberately.
 */
function parseApiKeys(): ApiKey[] {
  const keys: ApiKey[] = [];
  const single = raw('PDF_API_KEY');
  if (single) keys.push({ id: 'default', secret: single });

  const multi = raw('PDF_API_KEYS');
  if (multi) {
    for (const entry of multi.split(',')) {
      const item = entry.trim();
      if (!item) continue;
      const separator = item.indexOf(':');
      if (separator <= 0 || separator === item.length - 1) {
        throw new Error('PDF_API_KEYS entries must look like "label:secret"');
      }
      keys.push({
        id: item.slice(0, separator).trim(),
        secret: item.slice(separator + 1).trim(),
      });
    }
  }

  const ids = new Set<string>();
  for (const key of keys) {
    if (ids.has(key.id)) throw new Error(`Duplicate API key id: ${key.id}`);
    ids.add(key.id);
  }
  return keys;
}

export type StorageDriver = 'local' | 'r2';

function storageDriver(): StorageDriver {
  const value = str('STORAGE_DRIVER', 'local').toLowerCase();
  if (value !== 'local' && value !== 'r2') {
    throw new Error(`STORAGE_DRIVER must be "local" or "r2", got "${value}"`);
  }
  return value;
}

const driver = storageDriver();

export const config = {
  env: str('NODE_ENV', 'development'),
  logLevel: str('LOG_LEVEL', 'info'),

  api: {
    host: str('API_HOST', '0.0.0.0'),
    port: int('API_PORT', 8080),
    /** Hard cap on the HTTP body Fastify will read at all. */
    maxRequestBytes: int('MAX_REQUEST_BYTES', 6 * 1024 * 1024),
    trustProxy: bool('API_TRUST_PROXY', true),
    requestTimeoutMs: int('API_REQUEST_TIMEOUT_MS', 60_000),
  },

  auth: {
    keys: parseApiKeys(),
  },

  rateLimit: {
    enabled: bool('RATE_LIMIT_ENABLED', true),
    /** Applies to render requests - the ones that cost Chromium time. */
    max: int('RATE_LIMIT_MAX', 60),
    /**
     * Status polls and downloads are cheap and clients are expected to poll,
     * so reads get their own, much higher allowance.
     */
    readMax: int('RATE_LIMIT_READ_MAX', 600),
    windowMs: int('RATE_LIMIT_WINDOW_MS', 60_000),
  },

  redis: {
    url: str('REDIS_URL', 'redis://127.0.0.1:6379'),
  },

  queue: {
    name: str('QUEUE_NAME', 'pdf'),
    /** Reject new work once this many jobs are waiting/active/delayed. */
    maxQueuedJobs: int('MAX_QUEUED_JOBS', 1000),
    attempts: int('JOB_ATTEMPTS', 2),
    backoffMs: int('JOB_BACKOFF_MS', 2000),
  },

  worker: {
    concurrency: int('WORKER_CONCURRENCY', 1),
  },

  limits: {
    /** Max size of the `html` field itself (after JSON parsing). */
    maxHtmlBytes: int('MAX_HTML_BYTES', 5 * 1024 * 1024),
    maxPdfBytes: int('MAX_PDF_BYTES', 50 * 1024 * 1024),
    renderTimeoutMs: int('RENDER_TIMEOUT_MS', 30_000),
  },

  sync: {
    enabled: bool('SYNC_ENABLED', true),
    /** How long POST /v1/pdf/sync waits before handing back a job id instead. */
    timeoutMs: int('SYNC_TIMEOUT_MS', 25_000),
  },

  gotenberg: {
    url: str('GOTENBERG_URL', 'http://127.0.0.1:3000').replace(/\/+$/, ''),
  },

  retention: {
    /** Completed PDFs (and their BullMQ job records) live this long. */
    pdfTtlSeconds: int('PDF_TTL_SECONDS', 3600),
    /** Failed jobs are kept longer so failures can be inspected. */
    failedTtlSeconds: int('FAILED_JOB_TTL_SECONDS', 86_400),
    idempotencyTtlSeconds: int('IDEMPOTENCY_TTL_SECONDS', 86_400),
  },

  observability: {
    /** Prometheus endpoints, on ports that are never published to the host. */
    metricsEnabled: bool('METRICS_ENABLED', true),
    apiMetricsPort: int('API_METRICS_PORT', 9090),
    workerMetricsPort: int('WORKER_METRICS_PORT', 9091),
    /** How often each process logs a "vitals" line (CPU, steal, memory, queue). */
    vitalsIntervalSeconds: int('VITALS_INTERVAL_SECONDS', 30),
    /** Renders slower than this are logged at warn level. */
    slowRenderMs: int('SLOW_RENDER_LOG_MS', 10_000),
    /** Per-request access logs. Noisy under load testing, but often what you want. */
    logHttpRequests: bool('LOG_HTTP_REQUESTS', true),
  },

  janitor: {
    enabled: bool('JANITOR_ENABLED', true),
    intervalSeconds: int('JANITOR_INTERVAL_SECONDS', 600),
  },

  storage: {
    driver,
    local: {
      dir: str('STORAGE_LOCAL_DIR', './data/jobs'),
    },
    r2: {
      bucket: driver === 'r2' ? required('R2_BUCKET') : str('R2_BUCKET', ''),
      accountId: raw('R2_ACCOUNT_ID'),
      endpoint: raw('R2_ENDPOINT'),
      accessKeyId: driver === 'r2' ? required('R2_ACCESS_KEY_ID') : str('R2_ACCESS_KEY_ID', ''),
      secretAccessKey:
        driver === 'r2' ? required('R2_SECRET_ACCESS_KEY') : str('R2_SECRET_ACCESS_KEY', ''),
      region: str('R2_REGION', 'auto'),
      prefix: str('R2_PREFIX', 'jobs').replace(/^\/+|\/+$/g, ''),
      /** When true, job status responses include a presigned download URL. */
      presign: bool('R2_PRESIGN', true),
      presignTtlSeconds: int('R2_PRESIGN_TTL_SECONDS', 900),
    },
  },
} as const;

export type Config = typeof config;

/** Fails fast at boot instead of on the first request. */
export function assertRuntimeConfig(role: 'api' | 'worker'): void {
  if (role === 'api' && config.auth.keys.length === 0) {
    throw new Error(
      'No API keys configured. Set PDF_API_KEY (or PDF_API_KEYS) before starting the API.',
    );
  }
  if (config.storage.driver === 'r2' && !config.storage.r2.accountId && !config.storage.r2.endpoint) {
    throw new Error('STORAGE_DRIVER=r2 requires R2_ACCOUNT_ID or R2_ENDPOINT');
  }
  if (config.limits.maxHtmlBytes > config.api.maxRequestBytes) {
    throw new Error('MAX_HTML_BYTES cannot exceed MAX_REQUEST_BYTES');
  }
  if (config.sync.enabled && config.sync.timeoutMs > config.api.requestTimeoutMs) {
    throw new Error('SYNC_TIMEOUT_MS must be smaller than API_REQUEST_TIMEOUT_MS');
  }
}
