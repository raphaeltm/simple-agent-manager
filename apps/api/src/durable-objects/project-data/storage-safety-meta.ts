import { isJsonRecord } from '@simple-agent-manager/shared';

import { createModuleLogger, serializeError } from '../../lib/logger';
import { isDurableObjectStorageFullError } from '../../services/durable-object-retry';

const log = createModuleLogger('project_data.storage_safety_meta');

export const META_LAST_MEASURED_AT = 'storageSafetyLastMeasuredAt';
export const META_LAST_STATUS = 'storageSafetyLastStatus';
export const META_LAST_ERROR = 'storageSafetyLastError';

export function readStorageSafetyMeta(sql: SqlStorage, key: string): string | null {
  const row = sql.exec('SELECT value FROM do_meta WHERE key = ?', key).toArray()[0];
  if (!isJsonRecord(row)) return null;
  const value = (row as Record<string, unknown>).value;
  return typeof value === 'string' ? value : null;
}

export function readStorageSafetyMetaNumber(sql: SqlStorage, key: string): number | null {
  const raw = readStorageSafetyMeta(sql, key);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function writeStorageSafetyMeta(sql: SqlStorage, key: string, value: string): void {
  sql.exec(
    `INSERT INTO do_meta (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    value
  );
}

export function deleteStorageSafetyMeta(sql: SqlStorage, key: string): void {
  sql.exec('DELETE FROM do_meta WHERE key = ?', key);
}

/**
 * Local bookkeeping must never stop the measurement, the D1 telemetry export or the alert that
 * follow it: at the 10 GiB cap every write to this object fails, which is exactly when those
 * exports matter. Callers that need the value durably keep a D1 copy (telemetry, alert stamps).
 */
function bestEffort(key: string, write: () => void): boolean {
  try {
    write();
    return true;
  } catch (error) {
    log.warn('storage_safety_meta_write_failed', {
      key,
      storageFull: isDurableObjectStorageFullError(error),
      ...serializeError(error),
    });
    return false;
  }
}

export function writeStorageSafetyMetaBestEffort(
  sql: SqlStorage,
  key: string,
  value: string
): boolean {
  return bestEffort(key, () => writeStorageSafetyMeta(sql, key, value));
}

export function deleteStorageSafetyMetaBestEffort(sql: SqlStorage, key: string): boolean {
  return bestEffort(key, () => deleteStorageSafetyMeta(sql, key));
}

export function truncateStorageSafetyMetaValue(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}
