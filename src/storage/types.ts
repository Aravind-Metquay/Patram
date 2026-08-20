import type { Readable } from 'node:stream';

export interface StoredObject {
  stream: Readable;
  bytes?: number;
  contentType?: string;
}

export interface PruneRule {
  /** Matches the end of an object key, e.g. "output.pdf". */
  endsWith: string;
  maxAgeMs: number;
}

export interface Storage {
  readonly driver: 'local' | 'r2';
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  getStream(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  /** Returns null when the driver cannot hand out direct URLs (local disk). */
  presign(key: string, ttlSeconds: number, filename?: string): Promise<string | null>;
  prune(rules: PruneRule[]): Promise<number>;
  close(): Promise<void>;
}

/** Object keys are derived from the job id - never from client input. */
export const objectKeys = {
  input: (jobId: string): string => `${jobId}/input.html`,
  output: (jobId: string): string => `${jobId}/output.pdf`,
} as const;
