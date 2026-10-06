/**
 * Unit tests for the trial kill-switch.
 *
 * Covers:
 *   - Default (no KV value) → disabled
 *   - KV returns "true" → enabled
 *   - KV returns anything else → disabled
 *   - Cache short-circuits subsequent reads within TTL
 *   - Cache entry expires after TTL and KV is re-read
 *   - KV read errors → fails CLOSED (disabled)
 *   - Custom KV key via env.TRIALS_ENABLED_KV_KEY
 *   - Custom TTL via env.TRIAL_KILL_SWITCH_CACHE_MS
 *   - Admin writes update KV and the in-memory cache
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Silence the structured logger so KV-failure tests don't pollute output.
// `vi.hoisted` runs before `vi.mock` calls are hoisted so we can safely reference
// the spy inside the mock factory AND the test bodies.
const { mockLogError } = vi.hoisted(() => ({ mockLogError: vi.fn() }));
vi.mock('../../../src/lib/logger', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLogError,
  },
}));

import type { Env } from '../../../src/env';
import {
  __resetKillSwitchCacheForTest,
  isTrialsEnabled,
  resolveTrialKillSwitchCacheMs,
  setTrialsEnabled,
} from '../../../src/services/trial/kill-switch';

function makeEnv(
  kv: {
    get: (key: string) => Promise<string | null>;
    put?: (key: string, value: string) => Promise<void>;
  },
  overrides: Partial<Env> = {}
): Env {
  return {
    KV: kv as unknown as KVNamespace,
    ...overrides,
  } as unknown as Env;
}

describe('trial kill-switch', () => {
  beforeEach(() => {
    __resetKillSwitchCacheForTest();
  });

  it('defaults to disabled when the KV key is unset (null)', async () => {
    const get = vi.fn().mockResolvedValue(null);
    const env = makeEnv({ get });
    expect(await isTrialsEnabled(env, 0)).toBe(false);
    expect(get).toHaveBeenCalledWith('trials:enabled');
  });

  it('returns enabled when KV returns the exact string "true"', async () => {
    const get = vi.fn().mockResolvedValue('true');
    expect(await isTrialsEnabled(makeEnv({ get }), 0)).toBe(true);
  });

  it('returns disabled when KV returns any other string', async () => {
    for (const value of ['false', '1', 'TRUE', 'enabled', '']) {
      __resetKillSwitchCacheForTest();
      const get = vi.fn().mockResolvedValue(value);
      expect(await isTrialsEnabled(makeEnv({ get }), 0)).toBe(false);
    }
  });

  it('caches the value within TTL and skips subsequent KV reads', async () => {
    const get = vi.fn().mockResolvedValue('true');
    const env = makeEnv({ get });

    expect(await isTrialsEnabled(env, 0)).toBe(true);
    // Well inside the default 30s TTL.
    expect(await isTrialsEnabled(env, 10_000)).toBe(true);
    expect(await isTrialsEnabled(env, 29_999)).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('re-reads KV when the cache entry has expired', async () => {
    const get = vi.fn().mockResolvedValueOnce('true').mockResolvedValueOnce('false');
    const env = makeEnv({ get });

    expect(await isTrialsEnabled(env, 0)).toBe(true);
    // Past the default 30s TTL.
    expect(await isTrialsEnabled(env, 31_000)).toBe(false);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('fails closed (disabled) when KV.get throws', async () => {
    mockLogError.mockClear();
    const get = vi.fn().mockRejectedValue(new Error('kv-outage'));
    expect(await isTrialsEnabled(makeEnv({ get }), 0)).toBe(false);
    expect(mockLogError).toHaveBeenCalledWith(
      'trial.kill_switch.kv_read_failed',
      expect.objectContaining({ error: 'kv-outage' })
    );
  });

  it('caches the fail-closed value so a KV outage does not DoS the hot path', async () => {
    const get = vi.fn().mockRejectedValue(new Error('kv-outage'));
    const env = makeEnv({ get });
    expect(await isTrialsEnabled(env, 0)).toBe(false);
    expect(await isTrialsEnabled(env, 1_000)).toBe(false);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('honours a custom KV key from env.TRIALS_ENABLED_KV_KEY', async () => {
    const get = vi.fn().mockResolvedValue('true');
    const env = makeEnv({ get }, {
      TRIALS_ENABLED_KV_KEY: 'custom:trials:flag',
    } as unknown as Partial<Env>);

    expect(await isTrialsEnabled(env, 0)).toBe(true);
    expect(get).toHaveBeenCalledWith('custom:trials:flag');
  });

  it('honours a custom TTL from env.TRIAL_KILL_SWITCH_CACHE_MS', async () => {
    const get = vi.fn().mockResolvedValueOnce('true').mockResolvedValueOnce('false');
    const env = makeEnv({ get }, {
      TRIAL_KILL_SWITCH_CACHE_MS: '1000',
    } as unknown as Partial<Env>);

    expect(await isTrialsEnabled(env, 0)).toBe(true);
    // Within 1s TTL → cached
    expect(await isTrialsEnabled(env, 500)).toBe(true);
    // Past 1s TTL → re-read
    expect(await isTrialsEnabled(env, 1_500)).toBe(false);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('falls back to the default TTL when env.TRIAL_KILL_SWITCH_CACHE_MS is invalid', () => {
    const env = makeEnv({ get: vi.fn() }, {
      TRIAL_KILL_SWITCH_CACHE_MS: 'not-a-number',
    } as unknown as Partial<Env>);

    expect(resolveTrialKillSwitchCacheMs(env)).toBe(30_000);
  });

  it('writes the admin-selected state and updates the read cache immediately', async () => {
    const get = vi.fn().mockResolvedValue('false');
    const put = vi.fn().mockResolvedValue(undefined);
    const env = makeEnv({ get, put });

    const updated = await setTrialsEnabled(env, true, 0);

    expect(updated).toEqual({
      enabled: true,
      kvKey: 'trials:enabled',
      cacheTtlMs: 30_000,
    });
    expect(put).toHaveBeenCalledWith('trials:enabled', 'true');

    expect(await isTrialsEnabled(env, 1_000)).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it('writes false for disabled and honours a custom admin KV key', async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const env = makeEnv({ get: vi.fn(), put }, {
      TRIALS_ENABLED_KV_KEY: 'custom:trial-flag',
    } as unknown as Partial<Env>);

    await setTrialsEnabled(env, false, 0);

    expect(put).toHaveBeenCalledWith('custom:trial-flag', 'false');
    expect(await isTrialsEnabled(env, 1_000)).toBe(false);
  });
});
