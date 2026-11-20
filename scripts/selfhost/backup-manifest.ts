/** Validate decrypted backup metadata without reflecting arbitrary payloads into logs. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type BackupManifest, MANIFEST_NAME, parseBucketUrl } from './backup-lib';
export function readManifest(dir: string): BackupManifest {
  const path = join(dir, MANIFEST_NAME);
  if (!existsSync(path)) throw new Error(`${dir} has no ${MANIFEST_NAME}; not a backup`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('Invalid backup manifest');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('Invalid backup manifest');
  const item = parsed as Record<string, unknown>;
  if (
    item.version !== 1 ||
    typeof item.createdAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.createdAt) ||
    !Number.isFinite(Date.parse(item.createdAt)) ||
    !(
      item.samCommit === null ||
      (typeof item.samCommit === 'string' && /^[0-9a-f]{40}$/.test(item.samCommit))
    ) ||
    typeof item.bucket !== 'string' ||
    ['precopyMs', 'downtimeMs', 'deltaCopyMs', 'objectCount'].some(
      (name) =>
        typeof item[name] !== 'number' || !Number.isFinite(item[name]) || (item[name] as number) < 0
    )
  ) {
    throw new Error('Invalid backup manifest');
  }
  parseBucketUrl(item.bucket);
  return parsed as BackupManifest;
}
