// Existing compact do_meta diagnostic budget; shared by storage alarm substeps.
export const STORAGE_SAFETY_ERROR_MAX_LENGTH = 500;

import { isJsonRecord } from '@simple-agent-manager/shared';

/**
 * When the last FULL storage measurement ran. It schedules the next one
 * (`shouldMeasureProjectDataStorage`, `computeStorageSafetyAlarmTime`), so only
 * `measureAndPersistProjectDataStorage` writes it: that is the step that appends the hourly
 * history row and evaluates the threshold alerts.
 *
 * Cleanup passes publish the latest size too, but they must not stamp this key. A cleanup that
 * runs more often than the measure interval would then postpone the measurement forever. That is
 * how the SAM root object went silent on 2026-10-08: grouped FTS cleanup returned a result every
 * five minutes and every pass re-stamped this clock (`.claude/rules/74`).
 */
export const META_LAST_MEASURED_AT = 'storageSafetyLastMeasuredAt';
export const META_LAST_STATUS = 'storageSafetyLastStatus';
export const META_LAST_ERROR = 'storageSafetyLastError';
/**
 * When `META_LAST_ERROR` was recorded. An error-recency check reads this, never one of the
 * activity clocks. Written and cleared only together with the error, by the helpers below.
 */
export const META_LAST_ERROR_AT = 'storageSafetyLastErrorAt';

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

export function truncateStorageSafetyMetaValue(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

/** Record the storage-safety diagnostic error and when it happened, in one statement. */
export function recordStorageSafetyError(
  sql: SqlStorage,
  message: string,
  at: number = Date.now()
): void {
  sql.exec(
    `INSERT INTO do_meta (key, value)
     VALUES (?, ?), (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    META_LAST_ERROR,
    truncateStorageSafetyMetaValue(message, STORAGE_SAFETY_ERROR_MAX_LENGTH),
    META_LAST_ERROR_AT,
    String(at)
  );
}

export function clearStorageSafetyError(sql: SqlStorage): void {
  sql.exec('DELETE FROM do_meta WHERE key IN (?, ?)', META_LAST_ERROR, META_LAST_ERROR_AT);
}
