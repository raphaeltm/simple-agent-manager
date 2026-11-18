/**
 * Admin-editable tunables for Operations telemetry (node decision log, black box node log
 * captures, snapshot step traces) and approved operations actions.
 *
 * Resolvers never throw: a settings outage falls back to the typed default, because these
 * values bound best-effort telemetry and must never fail a lifecycle path.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { resolveAdminSetting } from './admin-settings-resolution';
import {
  OPERATIONS_TELEMETRY_DEFAULTS,
  OPERATIONS_TELEMETRY_RANGES,
  type OperationsTelemetrySettingKey,
} from './operations-telemetry-defaults';

/** Resolve one tunable; any settings failure returns the typed default. */
export async function resolveOperationsTelemetrySetting(
  env: Env,
  key: OperationsTelemetrySettingKey
): Promise<number> {
  const fallback = OPERATIONS_TELEMETRY_DEFAULTS[key];
  try {
    const value = await resolveAdminSetting(env, `operations.${key}`);
    const range = OPERATIONS_TELEMETRY_RANGES[key];
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= range.min &&
      value <= range.max
      ? value
      : fallback;
  } catch (error) {
    log.warn('operations_telemetry.setting_unavailable', {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}
