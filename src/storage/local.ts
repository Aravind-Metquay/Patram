import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PruneRule, Storage, StoredObject } from './types.js';

/**
 * Disk-backed storage. Used for local development and as the fallback when no
 * object store is configured.
 */
export class LocalStorage implements Storage {
  readonly driver = 'local' as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolve(key: string): string {
    const target = path.resolve(this.root, key);
    // Defence in depth: keys are built from job ids, but never trust a join.
    if (target !== this.root && !target.startsWith(this.root + path.sep)) {
      throw new Error(`Refusing to access key outside storage root: ${key}`);
    }
    return target;
  }

  async put(key: string, body: Buffer, _contentType: string): Promise<void> {
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Write-then-rename so a reader never sees a half-written PDF.
    const temp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temp, body);
    await fs.rename(temp, target);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.resolve(key));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async getStream(key: string): Promise<StoredObject | null> {
    const target = this.resolve(key);
    try {
      const stat = await fs.stat(target);
      if (!stat.isFile()) return null;
      return {
        stream: createReadStream(target),
        bytes: stat.size,
        contentType: target.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolve(key));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  async presign(): Promise<string | null> {
    return null;
  }

  async prune(rules: PruneRule[]): Promise<number> {
    let deleted = 0;
    const now = Date.now();
    let jobDirs: string[];
    try {
      jobDirs = await fs.readdir(this.root);
    } catch (error) {
      if (isMissing(error)) return 0;
      throw error;
    }

    for (const jobDir of jobDirs) {
      const dirPath = path.join(this.root, jobDir);
      let entries: string[];
      try {
        entries = await fs.readdir(dirPath);
      } catch {
        continue;
      }

      for (const entry of entries) {
        const rule = rules.find((candidate) => entry.endsWith(candidate.endsWith));
        const filePath = path.join(dirPath, entry);
        try {
          const stat = await fs.stat(filePath);
          const maxAgeMs = rule?.maxAgeMs ?? Math.max(...rules.map((r) => r.maxAgeMs));
          if (now - stat.mtimeMs > maxAgeMs) {
            await fs.unlink(filePath);
            deleted += 1;
          }
        } catch {
          // Raced with another prune or a delete; nothing to do.
        }
      }

      try {
        const remaining = await fs.readdir(dirPath);
        if (remaining.length === 0) await fs.rmdir(dirPath);
      } catch {
        // Directory already gone.
      }
    }
    return deleted;
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}

function isMissing(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'ENOENT';
}
