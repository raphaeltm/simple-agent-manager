import { log } from '../lib/logger';
import type { AdminSettingDefinition, AdminSettingValue } from './admin-settings-registry';
import type { OverrideRows } from './admin-settings-resolution';

/** Distinguish a bad override from a storage or dependency outage. */
export class InvalidStoredAdminSettingError extends Error {}

// Bounded by registry keys per database binding. Never serialize stored values into logs.
const warnedRows = new WeakMap<D1Database, Map<string, string>>();

/** Admin presentation only: runtime keeps its safety-specific outage fallback. */
export function invalidStoredSettingDetails(
  db: D1Database,
  def: AdminSettingDefinition,
  rows: OverrideRows,
  fallbackValue: AdminSettingValue
) {
  const row = rows.find((row) => row.key === def.name);
  if (!row) throw new InvalidStoredAdminSettingError('Stored override row missing');
  let warned = warnedRows.get(db);
  if (!warned) {
    warned = new Map();
    warnedRows.set(db, warned);
  }
  const version = JSON.stringify([row.updatedAt, row.value]);
  if (warned.get(def.name) !== version) {
    warned.set(def.name, version);
    log.warn('admin_settings.invalid_stored_value', {
      key: def.name,
      context: 'platform_settings',
      reason: 'Stored override fails current definition validation',
      action: 'show_fallback',
    });
  }
  return {
    value: def.secret ? null : fallbackValue,
    storedValueFallback:
      JSON.stringify(fallbackValue) === JSON.stringify(def.defaultValue)
        ? ('default' as const)
        : ('safe' as const),
    configured: false,
    source: 'default' as const,
    storedValueInvalid: true as const,
    ...(def.secret ? {} : { storedValue: row.value }),
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}
