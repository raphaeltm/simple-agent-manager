import type { Env } from '../env';
import { resolveAdminSetting } from './admin-settings';
import { OPERATOR_DEFAULTS } from './admin-settings-registry';

export interface OperatorSettings {
  disabled: boolean;
  watchLifetimeMs: number;
  eventPageSize: number;
  workRefreshMs: number;
  watchRetryLimit: number;
  streamFlushMs: number;
  streamHeartbeatMs: number;
  streamMaxSubscribers: number;
}

const integer = (value: unknown, fallback: number) =>
  typeof value === 'number' ? value : fallback;

/** Typed runtime controls; personal opt-in remains private SamSession state. */
export async function getOperatorSettings(env: Env): Promise<OperatorSettings> {
  const [
    disabled,
    watchLifetimeMs,
    eventPageSize,
    workRefreshMs,
    watchRetryLimit,
    streamFlushMs,
    streamHeartbeatMs,
    streamMaxSubscribers,
  ] = await Promise.all([
    resolveAdminSetting(env, 'operations.samOperatorDisabled'),
    resolveAdminSetting(env, 'operations.samOperatorWatchLifetimeMs'),
    resolveAdminSetting(env, 'operations.samOperatorEventPageSize'),
    resolveAdminSetting(env, 'operations.samOperatorWorkRefreshMs'),
    resolveAdminSetting(env, 'operations.samOperatorWatchRetryLimit'),
    resolveAdminSetting(env, 'operations.samOperatorStreamFlushMs'),
    resolveAdminSetting(env, 'operations.samOperatorStreamHeartbeatMs'),
    resolveAdminSetting(env, 'operations.samOperatorStreamMaxSubscribers'),
  ]);
  return {
    // The registry resolves the uncached installation switch fail-closed.
    disabled: disabled !== false,
    watchLifetimeMs: integer(watchLifetimeMs, OPERATOR_DEFAULTS.watchLifetimeMs),
    eventPageSize: integer(eventPageSize, OPERATOR_DEFAULTS.eventPageSize),
    workRefreshMs: integer(workRefreshMs, OPERATOR_DEFAULTS.workRefreshMs),
    watchRetryLimit: integer(watchRetryLimit, OPERATOR_DEFAULTS.watchRetryLimit),
    streamFlushMs: integer(streamFlushMs, OPERATOR_DEFAULTS.streamFlushMs),
    streamHeartbeatMs: integer(streamHeartbeatMs, OPERATOR_DEFAULTS.streamHeartbeatMs),
    streamMaxSubscribers: integer(streamMaxSubscribers, OPERATOR_DEFAULTS.streamMaxSubscribers),
  };
}
