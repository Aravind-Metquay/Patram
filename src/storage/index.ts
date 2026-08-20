import { config } from '../config/index.js';
import { LocalStorage } from './local.js';
import { R2Storage } from './r2.js';
import type { Storage } from './types.js';

let instance: Storage | undefined;

/** One storage client per process, created on first use. */
export function getStorage(): Storage {
  if (!instance) {
    instance =
      config.storage.driver === 'r2'
        ? new R2Storage({
            bucket: config.storage.r2.bucket,
            accountId: config.storage.r2.accountId,
            endpoint: config.storage.r2.endpoint,
            region: config.storage.r2.region,
            accessKeyId: config.storage.r2.accessKeyId,
            secretAccessKey: config.storage.r2.secretAccessKey,
            prefix: config.storage.r2.prefix,
            presign: config.storage.r2.presign,
            presignTtlSeconds: config.storage.r2.presignTtlSeconds,
          })
        : new LocalStorage(config.storage.local.dir);
  }
  return instance;
}

export async function closeStorage(): Promise<void> {
  if (instance) {
    await instance.close();
    instance = undefined;
  }
}

export { objectKeys } from './types.js';
export type { PruneRule, Storage, StoredObject } from './types.js';
