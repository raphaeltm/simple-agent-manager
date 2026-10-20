import type { Env } from '../env';
import { resolveAdminSetting } from './admin-settings';
import { OPERATOR_DEFAULTS } from './admin-settings-registry';

export interface OperatorSettings {
  disabled: boolean;
  watchLifetimeMs: number;
  eventPageSize: number;
  workRefreshMs: number;
  watchRetryLimit: number;
}

/** Typed runtime controls; personal opt-in remains private SamSession state. */
export async function getOperatorSettings(env: Env): Promise<OperatorSettings> {
  const [disabled, watchLifetimeMs, eventPageSize, workRefreshMs, watchRetryLimit] =
    await Promise.all([
      resolveAdminSetting(env, 'operations.samOperatorDisabled'),
      resolveAdminSetting(env, 'operations.samOperatorWatchLifetimeMs'),
      resolveAdminSetting(env, 'operations.samOperatorEventPageSize'),
      resolveAdminSetting(env, 'operations.samOperatorWorkRefreshMs'),
      resolveAdminSetting(env, 'operations.samOperatorWatchRetryLimit'),
    ]);
  return {
    // An installation environment brake cannot be undone by a database edit.
    disabled: env.SAM_OPERATOR_DISABLED === 'true' || disabled !== false,
    watchLifetimeMs:
      typeof watchLifetimeMs === 'number' ? watchLifetimeMs : OPERATOR_DEFAULTS.watchLifetimeMs,
    eventPageSize:
      typeof eventPageSize === 'number' ? eventPageSize : OPERATOR_DEFAULTS.eventPageSize,
    workRefreshMs:
      typeof workRefreshMs === 'number' ? workRefreshMs : OPERATOR_DEFAULTS.workRefreshMs,
    watchRetryLimit:
      typeof watchRetryLimit === 'number' ? watchRetryLimit : OPERATOR_DEFAULTS.watchRetryLimit,
  };
}
