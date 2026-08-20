/**
 * Errors that are safe to render to a client verbatim.
 *
 * `retryable` tells the worker whether re-running the job could plausibly
 * succeed: a malformed template never will, a Gotenberg restart might.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  readonly retryable: boolean;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options: { details?: unknown; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? statusCode >= 500;
  }

  toJSON(): { error: { code: string; message: string; details?: unknown } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export function badRequest(code: string, message: string, details?: unknown): AppError {
  return new AppError(400, code, message, { details, retryable: false });
}

export function payloadTooLarge(code: string, message: string): AppError {
  return new AppError(413, code, message, { retryable: false });
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * BullMQ only round-trips a failure *message* between worker and API, so the
 * worker serialises the useful parts into it and the API parses them back.
 */
const SERIALISED = /^([A-Z_]+)\|(0|1)\|([\s\S]*)$/;

export function serialiseFailure(error: unknown): string {
  if (isAppError(error)) {
    return `${error.code}|${error.retryable ? 1 : 0}|${error.message}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `INTERNAL_ERROR|1|${message}`;
}

export function parseFailure(reason: string | undefined | null): {
  code: string;
  retryable: boolean;
  message: string;
} {
  if (!reason) {
    return { code: 'UNKNOWN_ERROR', retryable: false, message: 'Job failed' };
  }
  const match = SERIALISED.exec(reason);
  if (!match) return { code: 'INTERNAL_ERROR', retryable: true, message: reason };
  return { code: match[1]!, retryable: match[2] === '1', message: match[3]! };
}
