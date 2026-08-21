/**
 * Everything about *where* an upload is allowed to go.
 *
 * Patram's other outbound calls (Gotenberg, R2) target hosts the operator
 * configured. This is the first surface where a client picks the address, and
 * the worker sits on a network where Redis and Gotenberg listen without
 * authentication - so a URL arriving in a request body is untrusted input in
 * the strongest sense.
 */
import dns from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { config } from '../config/index.js';
import { AppError } from '../shared/errors.js';

/** What a caller sends. */
export interface UploadTarget {
  url: string;
  method?: 'PUT' | 'POST';
  headers?: Record<string, string>;
}

/** A validated target: the URL is parsed and every header has been vetted. */
export interface UploadDestination {
  url: URL;
  method: 'PUT' | 'POST';
  headers: Record<string, string>;
}

export type UploadOutcome =
  | 'uploaded'
  | 'rejected'
  | 'throttled'
  | 'redirected'
  | 'failed'
  | 'timeout'
  | 'corrupted'
  | 'blocked';

/** One try against the destination. Recorded whether it worked or not. */
export interface UploadAttempt {
  n: number;
  outcome: UploadOutcome;
  status?: number;
  ms: number;
  /** Short reason, for transport failures that never produced a status. */
  error?: string;
  /** Bounded slice of the destination's response body. */
  response?: string;
}

/** The upload story for one job, as reported back to the caller. */
export interface UploadReport {
  host: string;
  path: string;
  status?: number;
  /** true = ETag matched, false = mismatch, null = destination gave no MD5 ETag. */
  verified?: boolean | null;
  attempts: UploadAttempt[];
}

/** RFC 7230 token characters - anything else in a header name is smuggling. */
const HEADER_NAME_PATTERN = "^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$";

/** Printable ASCII only: no CR, LF or NUL to reframe the request with. */
const HEADER_VALUE_PATTERN = /^[\x20-\x7E]*$/;

/**
 * Headers Patram owns. `content-length` is computed from the buffer, and the
 * rest are hop-by-hop or would let a caller re-point the request.
 */
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'te',
  'upgrade',
  'keep-alive',
  'expect',
  'trailer',
  'proxy-authorization',
  'proxy-connection',
]);

/**
 * Well-known service ports. Blocking private IPs does nothing about aiming
 * Patram at one of these on a *public* host, and no storage provider needs them.
 */
const BLOCKED_PORTS = new Set([22, 23, 25, 110, 143, 445, 3306, 5432, 6379, 9200, 11211, 27017]);

export const UPLOAD_SCHEMA = {
  type: 'object',
  required: ['url'],
  additionalProperties: false,
  properties: {
    url: { type: 'string', minLength: 12, maxLength: 2048, pattern: '^https?://' },
    method: { type: 'string', enum: ['PUT', 'POST'] },
    headers: {
      type: 'object',
      maxProperties: 20,
      propertyNames: { pattern: HEADER_NAME_PATTERN },
      additionalProperties: { type: 'string', maxLength: 1024 },
    },
  },
} as const;

/**
 * Addresses no upload may reach: loopback, every private range, link-local
 * (which is where cloud instance metadata lives), CGNAT, multicast, reserved,
 * and the IPv6 equivalents.
 */
const BLOCKED: BlockList = (() => {
  const blocked = new BlockList();
  blocked.addSubnet('0.0.0.0', 8, 'ipv4');
  blocked.addSubnet('10.0.0.0', 8, 'ipv4');
  blocked.addSubnet('100.64.0.0', 10, 'ipv4');
  blocked.addSubnet('127.0.0.0', 8, 'ipv4');
  blocked.addSubnet('169.254.0.0', 16, 'ipv4');
  blocked.addSubnet('172.16.0.0', 12, 'ipv4');
  blocked.addSubnet('192.0.0.0', 24, 'ipv4');
  blocked.addSubnet('192.0.2.0', 24, 'ipv4');
  blocked.addSubnet('192.168.0.0', 16, 'ipv4');
  blocked.addSubnet('198.18.0.0', 15, 'ipv4');
  blocked.addSubnet('198.51.100.0', 24, 'ipv4');
  blocked.addSubnet('203.0.113.0', 24, 'ipv4');
  blocked.addSubnet('224.0.0.0', 4, 'ipv4');
  blocked.addSubnet('240.0.0.0', 4, 'ipv4');
  blocked.addAddress('::', 'ipv6');
  blocked.addAddress('::1', 'ipv6');
  blocked.addSubnet('fc00::', 7, 'ipv6');
  blocked.addSubnet('fe80::', 10, 'ipv6');
  blocked.addSubnet('ff00::', 8, 'ipv6');
  blocked.addSubnet('2001:db8::', 32, 'ipv6');
  blocked.addSubnet('64:ff9b::', 96, 'ipv6');
  return blocked;
})();

/**
 * `BlockList.check` needs the family the address actually is, and returns false
 * for an IPv4-mapped string checked as ipv4 - so unwrap `::ffff:` ourselves
 * rather than relying on its normalisation.
 */
export function isBlockedAddress(address: string): boolean {
  if (config.upload.allowPrivateIps) return false;
  const unmapped = address.replace(/^::ffff:/i, '');
  if (isIP(unmapped) === 4) return BLOCKED.check(unmapped, 'ipv4');
  if (isIP(address) === 6) return BLOCKED.check(address, 'ipv6');
  // Not an address we can reason about: refuse rather than guess.
  return true;
}

function invalidUrl(reason: string): AppError {
  return new AppError(400, 'INVALID_UPLOAD_URL', `upload.url ${reason}`, { retryable: false });
}

function invalidHeader(reason: string): AppError {
  return new AppError(400, 'INVALID_UPLOAD_HEADER', reason, { retryable: false });
}

export function destinationBlocked(host: string, address?: string): AppError {
  return new AppError(
    400,
    'UPLOAD_DESTINATION_BLOCKED',
    address
      ? `upload.url host ${host} resolves to a blocked address (${address})`
      : `upload.url host ${host} is a blocked address`,
    { retryable: false },
  );
}

/** Strips the query string, which is where the signature lives. */
export function redactUrl(url: URL | string): string {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '[unparseable url]';
  }
}

/**
 * Best-effort: a SigV4 URL carries its own validity window, so an already-dead
 * one can be refused before it takes a queue slot. Advisory only - a URL
 * without these parameters is never judged on them.
 */
function signatureExpired(url: URL): boolean {
  const signedAt = url.searchParams.get('X-Amz-Date');
  const ttlSeconds = Number(url.searchParams.get('X-Amz-Expires'));
  if (!signedAt || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return false;
  const parts = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(signedAt);
  if (!parts) return false;
  const [, y, mo, d, h, mi, sec] = parts;
  const issued = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec));
  return issued + ttlSeconds * 1000 < Date.now();
}

function hostAllowed(hostname: string): boolean {
  const allowlist = config.upload.hostAllowlist;
  if (allowlist.length === 0) return true;
  return allowlist.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

/**
 * Parse-time validation. Runs at enqueue so a bad destination is a 400 instead
 * of a queued job that cannot succeed, and again in the worker because the
 * parsed URL cannot travel through Redis.
 *
 * @param checkExpiry only at enqueue: in the worker an expired signature is the
 *   destination's 403 to report, not a validation error.
 */
export function validateDestination(
  target: UploadTarget,
  { checkExpiry = false }: { checkExpiry?: boolean } = {},
): UploadDestination {
  if (!config.upload.enabled) {
    throw new AppError(501, 'UPLOAD_DISABLED', 'Uploading to a presigned URL is disabled', {
      retryable: false,
    });
  }

  let url: URL;
  try {
    url = new URL(target.url);
  } catch {
    throw invalidUrl('is not a valid absolute URL');
  }

  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && config.upload.allowHttp)) {
    throw invalidUrl(`must be https (got ${url.protocol.replace(':', '')})`);
  }
  // Credentials in the URL would be forwarded verbatim, and a fragment is a
  // sign the caller pasted something other than a signed URL.
  if (url.username || url.password) throw invalidUrl('must not carry credentials');
  if (url.hash) throw invalidUrl('must not carry a fragment');

  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (BLOCKED_PORTS.has(port)) throw invalidUrl(`must not target port ${port}`);

  // URL.hostname keeps the brackets on an IPv6 literal.
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostAllowed(hostname)) {
    throw invalidUrl(`host ${hostname} is not in UPLOAD_HOST_ALLOWLIST`);
  }
  // An IP literal never reaches the lookup hook, because net.connect skips DNS
  // for one. This is the only place it gets checked.
  if (isIP(hostname) !== 0 && isBlockedAddress(hostname)) {
    throw destinationBlocked(hostname);
  }

  if (checkExpiry && signatureExpired(url)) {
    throw invalidUrl('signature has already expired');
  }

  const headers: Record<string, string> = {};
  let hasContentType = false;
  for (const [name, value] of Object.entries(target.headers ?? {})) {
    const lower = name.toLowerCase();
    if (RESERVED_HEADERS.has(lower)) {
      throw invalidHeader(`upload.headers must not set "${name}" - the service sets it`);
    }
    if (!HEADER_VALUE_PATTERN.test(value)) {
      throw invalidHeader(`upload.headers["${name}"] contains a disallowed character`);
    }
    if (lower === 'content-type') hasContentType = true;
    headers[name] = value;
  }
  // Only defaulted, never overridden: S3 refuses the request when a signed
  // header's value differs by even one character.
  if (!hasContentType) headers['Content-Type'] = 'application/pdf';

  return { url, method: target.method ?? 'PUT', headers };
}

/**
 * What the idempotency fingerprint sees.
 *
 * Deliberately not the signed URL: its signature and expiry differ on every
 * mint, so hashing the whole thing would make a replayed key conflict with
 * itself every time. Hashing nothing is the opposite bug - a replay would
 * return the first job and silently never write to the new destination.
 */
export function destinationIdentity(target: UploadTarget | undefined): unknown {
  if (!target) return null;
  let origin = '';
  let pathname = '';
  try {
    const url = new URL(target.url);
    origin = url.origin;
    pathname = url.pathname;
  } catch {
    // Unparseable URLs are rejected by validation; fall through to the raw
    // string so the fingerprint stays a pure function either way.
    origin = target.url;
  }
  return {
    method: target.method ?? 'PUT',
    origin,
    pathname,
    headers: Object.keys(target.headers ?? {})
      .map((name) => name.toLowerCase())
      .sort(),
  };
}

/**
 * Connect-time address validation.
 *
 * The parse-time check above can be defeated by DNS rebinding: a hostname that
 * resolves public during validation can resolve private a moment later. This
 * hook runs for the connection actually being made, which is the only place the
 * check cannot be raced.
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, '', 0);
      return;
    }
    const resolved = addresses as dns.LookupAddress[];
    const offender = resolved.find((entry) => isBlockedAddress(entry.address));
    if (offender) {
      // Tagged so the uploader can tell this apart from a DNS failure.
      const blocked = Object.assign(destinationBlocked(hostname, offender.address), {
        isDestinationBlocked: true as const,
      });
      callback(blocked, '', 0);
      return;
    }
    if (options.all) {
      callback(null, resolved as never, undefined as never);
      return;
    }
    const first = resolved[0];
    if (!first) {
      callback(new Error(`no address found for ${hostname}`), '', 0);
      return;
    }
    callback(null, first.address as never, first.family);
  });
};
