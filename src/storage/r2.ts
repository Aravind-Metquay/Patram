import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { buffer as readAll } from 'node:stream/consumers';
import type { PruneRule, Storage, StoredObject } from './types.js';

export interface R2Options {
  bucket: string;
  accountId?: string | undefined;
  endpoint?: string | undefined;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  presign: boolean;
  presignTtlSeconds: number;
}

/**
 * Cloudflare R2 via the S3 API. Nothing here is R2-specific beyond the default
 * endpoint, so the same driver works against S3, MinIO or Spaces.
 */
export class R2Storage implements Storage {
  readonly driver = 'r2' as const;
  private readonly client: S3Client;
  private readonly options: R2Options;

  constructor(options: R2Options) {
    this.options = options;
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint ?? `https://${options.accountId}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  private fullKey(key: string): string {
    return this.options.prefix ? `${this.options.prefix}/${key}` : key;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: this.fullKey(key),
        Body: body,
        ContentType: contentType,
        ContentLength: body.byteLength,
      }),
    );
  }

  async get(key: string): Promise<Buffer | null> {
    const object = await this.getStream(key);
    if (!object) return null;
    return readAll(object.stream);
  }

  async getStream(key: string): Promise<StoredObject | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: this.fullKey(key) }),
      );
      if (!response.Body) return null;
      return {
        stream: response.Body as Readable,
        bytes: response.ContentLength,
        contentType: response.ContentType,
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectsCommand({
        Bucket: this.options.bucket,
        Delete: { Objects: [{ Key: this.fullKey(key) }], Quiet: true },
      }),
    );
  }

  async presign(key: string, ttlSeconds: number, filename?: string): Promise<string | null> {
    if (!this.options.presign) return null;
    const command = new GetObjectCommand({
      Bucket: this.options.bucket,
      Key: this.fullKey(key),
      ResponseContentType: 'application/pdf',
      ...(filename
        ? { ResponseContentDisposition: `attachment; filename="${sanitiseFilename(filename)}"` }
        : {}),
    });
    return getSignedUrl(this.client, command, { expiresIn: ttlSeconds });
  }

  /**
   * A bucket lifecycle rule is the cheaper way to expire objects; this exists so
   * retention still holds on buckets without one.
   */
  async prune(rules: PruneRule[]): Promise<number> {
    const now = Date.now();
    const fallbackMaxAgeMs = Math.max(...rules.map((rule) => rule.maxAgeMs));
    let deleted = 0;
    let continuationToken: string | undefined;

    do {
      const listing = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.options.bucket,
          Prefix: this.options.prefix ? `${this.options.prefix}/` : undefined,
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        }),
      );

      const expired = (listing.Contents ?? [])
        .filter((object) => {
          if (!object.Key || !object.LastModified) return false;
          const rule = rules.find((candidate) => object.Key!.endsWith(candidate.endsWith));
          const maxAgeMs = rule?.maxAgeMs ?? fallbackMaxAgeMs;
          return now - object.LastModified.getTime() > maxAgeMs;
        })
        .map((object) => ({ Key: object.Key! }));

      if (expired.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.options.bucket,
            Delete: { Objects: expired, Quiet: true },
          }),
        );
        deleted += expired.length;
      }

      continuationToken = listing.IsTruncated ? listing.NextContinuationToken : undefined;
    } while (continuationToken);

    return deleted;
  }

  async close(): Promise<void> {
    this.client.destroy();
  }
}

function isMissing(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return candidate?.name === 'NoSuchKey' || candidate?.$metadata?.httpStatusCode === 404;
}

function sanitiseFilename(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'document.pdf';
}
