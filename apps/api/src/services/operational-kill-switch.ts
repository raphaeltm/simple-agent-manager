/**
 * Availability-oriented brakes for costly recurring control loops.
 *
 * Unlike the trials security/cost gate, these switches deliberately fail open:
 * an absent key or KV read error leaves work enabled. A transient KV outage must
 * not silently stop task recovery and cleanup across the platform.
 */
import { log } from '../lib/logger';

export const DEFAULT_CRON_SWEEPS_ENABLED_KV_KEY = 'control-loops:cron-enabled';
export const DEFAULT_DO_ALARMS_ENABLED_KV_KEY = 'control-loops:alarms-enabled';
export const DEFAULT_CONTROL_LOOP_KILL_SWITCH_CACHE_MS = 30_000;
export const MAX_CONTROL_LOOP_KILL_SWITCH_CACHE_MS = 30_000;
export const DEFAULT_CONTROL_LOOP_DISABLED_ALARM_RETRY_MS = 5 * 60_000;
export const MIN_CONTROL_LOOP_DISABLED_ALARM_RETRY_MS = 60_000;

export type OperationalLoop = 'cron' | 'alarms';

export interface OperationalKillSwitchEnv {
  KV: KVNamespace;
  CRON_SWEEPS_ENABLED_KV_KEY?: string;
  DO_ALARMS_ENABLED_KV_KEY?: string;
  CONTROL_LOOP_KILL_SWITCH_CACHE_MS?: string;
  CONTROL_LOOP_DISABLED_ALARM_RETRY_MS?: string;
}

interface CacheEntry {
  enabled: boolean;
  expiresAt: number;
}

const cache: Partial<Record<OperationalLoop, CacheEntry>> = {};

export function __resetOperationalKillSwitchCacheForTest(): void {
  delete cache.cron;
  delete cache.alarms;
}

export function resolveOperationalLoopKvKey(env: OperationalKillSwitchEnv, loop: OperationalLoop): string {
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
  now: number = Date.now(),
): Promise<boolean> {
  const cached = cache[loop];
  if (cached && now < cached.expiresAt) return cached.enabled;

  const key = resolveOperationalLoopKvKey(env, loop);
  let enabled = true;
  try {
    const value = await env.KV.get(key);
    enabled = value !== 'false' && value !== 'disabled';
  } catch (err) {
    log.error('control_loop.kill_switch.kv_read_failed', {
      loop,
      key,
      semantics: 'fail_open',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  cache[loop] = {
    enabled,
    expiresAt: now + resolveOperationalKillSwitchCacheMs(env),
  };
  return enabled;
}

export async function setOperationalLoopEnabled(
  env: OperationalKillSwitchEnv,
  loop: OperationalLoop,
  enabled: boolean,
  now: number = Date.now(),
): Promise<{ enabled: boolean; kvKey: string; cacheTtlMs: number }> {
  const kvKey = resolveOperationalLoopKvKey(env, loop);
  const cacheTtlMs = resolveOperationalKillSwitchCacheMs(env);
  await env.KV.put(kvKey, enabled ? 'true' : 'false');
  cache[loop] = { enabled, expiresAt: now + cacheTtlMs };
  return { enabled, kvKey, cacheTtlMs };
}

/** Return true when alarm work was skipped and safely re-armed. */
export async function deferAlarmWhenDisabled(
  env: OperationalKillSwitchEnv,
  storage: DurableObjectStorage,
  durableObject: string,
  now: number = Date.now(),
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
