/**
 * Trial kill-switch.
 *
 * Trials can be disabled without deploying by setting KV key `trials:enabled`
 * (configurable via env.TRIALS_ENABLED_KV_KEY) to anything other than `"true"`.
 *
 * The value is cached in-memory for 30s (configurable via
 * env.TRIAL_KILL_SWITCH_CACHE_MS) because every POST /api/trial/create reads
 * it on the hot path.
 */
import type { Env } from '../../env';
import { log } from '../../lib/logger';

const DEFAULT_KILL_SWITCH_CACHE_MS = 30_000;
const DEFAULT_TRIALS_ENABLED_KV_KEY = 'trials:enabled';

interface CacheEntry {
  enabled: boolean;
  /** epoch ms when this entry becomes stale */
  expiresAt: number;
}

// Module-scoped cache — Workers re-use the isolate across requests within an
// instance, so this gives us the intended "last value for up to TTL" behavior.
let cache: CacheEntry | null = null;

/** Exported for tests only. */
export function __resetKillSwitchCacheForTest(): void {
  cache = null;
}

/**
 * Returns `true` when trials are enabled. Default is **disabled** — an
 * operator must explicitly set the KV flag to `"true"` to turn trials on.
 */
export async function isTrialsEnabled(
  env: Env,
  now: number = Date.now()
): Promise<boolean> {
  if (cache && now < cache.expiresAt) return cache.enabled;

  const key = env.TRIALS_ENABLED_KV_KEY ?? DEFAULT_TRIALS_ENABLED_KV_KEY;
  const ttl = Number(env.TRIAL_KILL_SWITCH_CACHE_MS ?? DEFAULT_KILL_SWITCH_CACHE_MS);

  let enabled = false;
  try {
    const value = await env.KV.get(key);
    enabled = value === 'true';
  } catch (err) {
    // KV outages MUST fail closed — the monthly cap is defended by the DO
    // counter, so preferring "disabled" over "enabled" during an outage is safe.
    log.error('trial.kill_switch.kv_read_failed', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    enabled = false;
  }

  cache = { enabled, expiresAt: now + ttl };
  return enabled;
}
