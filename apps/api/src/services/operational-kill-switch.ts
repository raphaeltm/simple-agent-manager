/** Costly control-loop brakes resolved through the shared audited settings service.
 * Missing overrides preserve legacy KV and enabled defaults. Once disabled is
 * observed, a settings outage keeps the brake applied until a valid enabled read.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import {
  __resetAdminSettingsCacheForTest,
  resolveAdminSetting,
  updateAdminSettings,
} from './admin-settings';

export const DEFAULT_CRON_SWEEPS_ENABLED_KV_KEY = 'control-loops:cron-enabled';
export const DEFAULT_DO_ALARMS_ENABLED_KV_KEY = 'control-loops:alarms-enabled';
export const DEFAULT_CONTROL_LOOP_KILL_SWITCH_CACHE_MS = 30_000;
export const MAX_CONTROL_LOOP_KILL_SWITCH_CACHE_MS = 30_000;
export const DEFAULT_CONTROL_LOOP_DISABLED_ALARM_RETRY_MS = 5 * 60_000;
export const MIN_CONTROL_LOOP_DISABLED_ALARM_RETRY_MS = 60_000;

export type OperationalLoop = 'cron' | 'alarms';

export interface OperationalKillSwitchEnv {
  DATABASE: D1Database;
  KV: KVNamespace;
  CRON_SWEEPS_ENABLED_KV_KEY?: string;
  DO_ALARMS_ENABLED_KV_KEY?: string;
  CONTROL_LOOP_KILL_SWITCH_CACHE_MS?: string;
  CONTROL_LOOP_DISABLED_ALARM_RETRY_MS?: string;
}

/** Compatibility reset; the authoritative cache is owned by admin-settings. */
export function __resetOperationalKillSwitchCacheForTest(): void {
  __resetAdminSettingsCacheForTest();
}

export function resolveOperationalLoopKvKey(
  env: OperationalKillSwitchEnv,
  loop: OperationalLoop
): string {
  return loop === 'cron'
    ? (env.CRON_SWEEPS_ENABLED_KV_KEY ?? DEFAULT_CRON_SWEEPS_ENABLED_KV_KEY)
    : (env.DO_ALARMS_ENABLED_KV_KEY ?? DEFAULT_DO_ALARMS_ENABLED_KV_KEY);
}

export function resolveOperationalKillSwitchCacheMs(env: OperationalKillSwitchEnv): number {
  const parsed = Number.parseInt(env.CONTROL_LOOP_KILL_SWITCH_CACHE_MS ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CONTROL_LOOP_KILL_SWITCH_CACHE_MS;
  return Math.min(parsed, MAX_CONTROL_LOOP_KILL_SWITCH_CACHE_MS);
}

export function resolveDisabledAlarmRetryMs(env: OperationalKillSwitchEnv): number {
  const parsed = Number.parseInt(env.CONTROL_LOOP_DISABLED_ALARM_RETRY_MS ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_CONTROL_LOOP_DISABLED_ALARM_RETRY_MS;
  }
  return Math.max(parsed, MIN_CONTROL_LOOP_DISABLED_ALARM_RETRY_MS);
}

export async function isOperationalLoopEnabled(
  env: OperationalKillSwitchEnv,
  loop: OperationalLoop,
  _now: number = Date.now()
): Promise<boolean> {
  return Boolean(
    await resolveAdminSetting(
      env as Env,
      loop === 'cron' ? 'operations.cronSweepsEnabled' : 'operations.doAlarmsEnabled'
    )
  );
}

export async function setOperationalLoopEnabled(
  env: OperationalKillSwitchEnv,
  loop: OperationalLoop,
  enabled: boolean,
  _now: number = Date.now(),
  actorUserId: string = 'system'
): Promise<{ enabled: boolean; kvKey: string; cacheTtlMs: number }> {
  await updateAdminSettings(env as Env, {
    changes: [
      {
        name: loop === 'cron' ? 'operations.cronSweepsEnabled' : 'operations.doAlarmsEnabled',
        value: enabled,
      },
    ],
    actorUserId,
  });
  return {
    enabled,
    kvKey: resolveOperationalLoopKvKey(env, loop),
    cacheTtlMs: resolveOperationalKillSwitchCacheMs(env),
  };
}

/** Return true when alarm work was skipped and safely re-armed. */
export async function deferAlarmWhenDisabled(
  env: OperationalKillSwitchEnv,
  storage: DurableObjectStorage,
  durableObject: string,
  now: number = Date.now()
): Promise<boolean> {
  if (await isOperationalLoopEnabled(env, 'alarms', now)) return false;

  const retryMs = resolveDisabledAlarmRetryMs(env);
  const nextAlarmAt = now + retryMs;
  await storage.setAlarm(nextAlarmAt);
  log.info('durable_object.alarm_skipped_disabled', {
    durableObject,
    retryMs,
    nextAlarmAt: new Date(nextAlarmAt).toISOString(),
  });
  return true;
}
