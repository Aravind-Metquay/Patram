/**
 * The transfer itself.
 *
 * Uses node:http(s) rather than fetch, deliberately and against the grain of
 * the rest of this codebase, because three things this needs are only available
 * there: a connect-time `lookup` hook (global fetch takes none, and undici is
 * not importable as a built-in), no redirect following - the classic way to
 * walk a validated URL into an internal one - and an explicit Content-Length,
 * which a presigned S3 PUT requires because it rejects chunked encoding.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { config } from '../config/index.js';
import { AppError } from '../shared/errors.js';
import {
  guardedLookup,
  redactUrl,
  type UploadAttempt,
  type UploadDestination,
  type UploadOutcome,
  type UploadReport,
} from './destination.js';

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  ms: number;
}

interface TaggedError extends Error {
  code?: string;
  isUploadTimeout?: boolean;
  isDestinationBlocked?: boolean;
}

/** Digests of the object, computed in one pass and reused for verification. */
export interface PdfDigests {
  md5: string;
  sha256: string;
}

export function digest(body: Buffer): PdfDigests {
  return {
    md5: crypto.createHash('md5').update(body).digest('hex'),
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
  };
}

/**
 * S3, R2 and Azure return the MD5 as the ETag for a single-part PUT, so it can
 * be compared. GCS returns something opaque, and guessing would be worse than
 * admitting we cannot check.
 */
function md5FromEtag(etag: string | undefined): string | null {
  if (!etag) return null;
  const cleaned = etag.trim().replace(/^W\//i, '').replace(/^"|"$/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(cleaned) ? cleaned : null;
}

function retryAfterMs(headers: http.IncomingHttpHeaders): number | undefined {
  const header = headers['retry-after'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function send(destination: UploadDestination, body: Buffer, timeoutMs: number): Promise<RawResponse> {
  const transport = destination.url.protocol === 'https:' ? https : http;
  const startedAt = Date.now();
  const keep = config.upload.maxResponseBytes;

  return new Promise<RawResponse>((resolve, reject) => {
    const request = transport.request(
      destination.url,
      {
        method: destination.method,
        headers: { ...destination.headers, 'Content-Length': String(body.byteLength) },
        // Connect-time SSRF guard. TLS is untouched: no rejectUnauthorized
        // override and no servername override, so the certificate is still
        // validated against the hostname even though we chose the address.
        lookup: guardedLookup,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let kept = 0;
        response.on('data', (chunk: Buffer) => {
          // Keep a bounded prefix but keep draining, so the socket closes cleanly.
          if (kept >= keep) return;
          kept += chunk.byteLength;
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          clearTimeout(timer);
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).subarray(0, keep).toString('utf8'),
            ms: Date.now() - startedAt,
          });
        });
      },
    );

    // A hard deadline rather than an inactivity timeout: a destination that
    // dribbles bytes forever would otherwise hold a worker slot open.
    const timer = setTimeout(() => {
      const timeout: TaggedError = Object.assign(
        new Error(`upload timed out after ${timeoutMs}ms`),
        { isUploadTimeout: true as const },
      );
      request.destroy(timeout);
    }, timeoutMs);

    request.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end(body);
  });
}


function failure(
  code: string,
  status: number,
  message: string,
  retryable: boolean,
  details: Record<string, unknown>,
): AppError {
  return new AppError(status, code, message, { retryable, details });
}

interface AttemptResult {
  attempt: UploadAttempt;
  /** Set when the attempt failed; the caller decides whether to retry. */
  error?: AppError;
  verified?: boolean | null;
}

async function attemptOnce(
  destination: UploadDestination,
  body: Buffer,
  digests: PdfDigests,
  n: number,
): Promise<AttemptResult & { retryAfter?: number | undefined }> {
  const host = destination.url.host;
  const path = destination.url.pathname;
  const base = { host, path };

  const startedAt = Date.now();
  let response: RawResponse;
  try {
    response = await send(destination, body, config.upload.timeoutMs);
  } catch (error) {
    const err = error as TaggedError;
    const ms = Date.now() - startedAt;
    if (err.isDestinationBlocked) {
      return {
        attempt: { n, outcome: 'blocked', ms, error: err.message },
        error: failure(
          'UPLOAD_DESTINATION_BLOCKED',
          400,
          `Upload destination ${host} resolves to a blocked address`,
          false,
          base,
        ),
      };
    }
    if (err.isUploadTimeout) {
      return {
        attempt: { n, outcome: 'timeout', ms, error: err.message },
        error: failure(
          'UPLOAD_TIMEOUT',
          504,
          `Upload to ${host} timed out after ${config.upload.timeoutMs}ms`,
          true,
          base,
        ),
      };
    }
    // Never interpolate the URL: this message reaches the client through
    // failedReason and is retained in Redis with the failed job.
    const reason = err.code ?? err.name ?? 'transport error';
    return {
      attempt: { n, outcome: 'failed', ms, error: reason },
      error: failure('UPLOAD_FAILED', 502, `Could not reach ${host} (${reason})`, true, base),
    };
  }

  const { status, ms } = response;
  const details = { ...base, status, ...(response.body ? { response: response.body } : {}) };
  const attempt: UploadAttempt = {
    n,
    outcome: 'uploaded',
    status,
    ms,
    ...(response.body ? { response: response.body } : {}),
  };

  if (status >= 200 && status < 300) {
    const expected = md5FromEtag(
      Array.isArray(response.headers.etag) ? response.headers.etag[0] : response.headers.etag,
    );
    const verified = expected === null ? null : expected === digests.md5;
    if (verified === false) {
      return {
        attempt: { ...attempt, outcome: 'corrupted' },
        verified,
        error: failure(
          'UPLOAD_CORRUPTED',
          502,
          `${host} acknowledged the upload with an ETag that does not match the PDF`,
          true,
          details,
        ),
      };
    }
    return { attempt, verified };
  }

  if (status >= 300 && status < 400) {
    return {
      attempt: { ...attempt, outcome: 'redirected' },
      error: failure(
        'UPLOAD_REDIRECTED',
        502,
        `${host} answered ${status}; redirects are not followed for uploads`,
        false,
        details,
      ),
    };
  }

  // 429/408 are the 4xx worth retrying - a provider's request-rate ceiling, not
  // a broken request.
  if (status === 429 || status === 408) {
    return {
      attempt: { ...attempt, outcome: 'throttled' },
      error: failure('UPLOAD_THROTTLED', 502, `${host} throttled the upload (${status})`, true, details),
      retryAfter: retryAfterMs(response.headers),
    };
  }

  if (status < 500) {
    return {
      attempt: { ...attempt, outcome: 'rejected' },
      error: failure(
        'UPLOAD_REJECTED',
        502,
        `${host} rejected the upload with ${status}`,
        false,
        details,
      ),
    };
  }

  return {
    attempt: { ...attempt, outcome: 'failed' },
    error: failure('UPLOAD_FAILED', 502, `${host} returned ${status}`, true, details),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface DeliveryOutcome {
  report: UploadReport;
  /** Undefined when the object landed. */
  error?: AppError;
}

/**
 * Uploads the PDF, retrying in place only for throttling.
 *
 * Everything else is left to BullMQ's own attempts, so a retryable failure gets
 * the queue's backoff and a non-retryable one stops immediately. Throttling is
 * the exception because the destination told us how long to wait, and waiting
 * that long is usually shorter than losing the job.
 */
export async function deliverPdf(
  destination: UploadDestination,
  body: Buffer,
  digests: PdfDigests,
  previous: UploadAttempt[] = [],
): Promise<DeliveryOutcome> {
  const attempts: UploadAttempt[] = [...previous];
  const report: UploadReport = {
    host: destination.url.host,
    path: destination.url.pathname,
    attempts,
  };

  for (let extra = 0; ; extra += 1) {
    const result = await attemptOnce(destination, body, digests, attempts.length + 1);
    attempts.push(result.attempt);
    report.status = result.attempt.status;
    if (result.verified !== undefined) report.verified = result.verified;

    if (!result.error) return { report };

    const throttled = result.attempt.outcome === 'throttled';
    if (!throttled || extra >= config.upload.throttleRetries) {
      return { report, error: result.error };
    }
    // Honour Retry-After, clamped so a hostile or confused value cannot park a
    // worker slot for minutes.
    await sleep(Math.min(Math.max(result.retryAfter ?? 1000, 500), 10_000));
  }
}

export { redactUrl };
