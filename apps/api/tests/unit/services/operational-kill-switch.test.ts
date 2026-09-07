import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  __resetOperationalKillSwitchCacheForTest,
  deferAlarmWhenDisabled,
  isOperationalLoopEnabled,
  resolveDisabledAlarmRetryMs,
  resolveOperationalKillSwitchCacheMs,
  setOperationalLoopEnabled,
} from '../../../src/services/operational-kill-switch';

function makeEnv(
  get: (key: string) => Promise<string | null>,
  put: (key: string, value: string) => Promise<void> = vi.fn(),
  overrides: Partial<Env> = {},
): Env {
  return { KV: { get, put } as unknown as KVNamespace, ...overrides } as unknown as Env;
}

describe('operational control-loop kill switches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetOperationalKillSwitchCacheForTest();
  });

  it('defaults to enabled when the key is absent and when KV reads fail', async () => {
    expect(await isOperationalLoopEnabled(makeEnv(vi.fn().mockResolvedValue(null)), 'cron', 0))
      .toBe(true);
    expect(await isOperationalLoopEnabled(makeEnv(vi.fn().mockRejectedValue(new Error('KV down'))), 'alarms', 0))
      .toBe(true);
  });

  it('disabling stops alarm work and re-enabling resumes it immediately', async () => {
    const values = new Map<string, string>();
    const env = makeEnv(
      vi.fn(async (key) => values.get(key) ?? null),
      vi.fn(async (key, value) => { values.set(key, value); }),
      { CONTROL_LOOP_DISABLED_ALARM_RETRY_MS: '300000' },
    );
    const setAlarm = vi.fn();
    const storage = { setAlarm } as unknown as DurableObjectStorage;
    let workCount = 0;

    await setOperationalLoopEnabled(env, 'alarms', false, 1_000);
    if (!(await deferAlarmWhenDisabled(env, storage, 'TestDO', 1_001))) workCount++;
    expect(workCount).toBe(0);
    expect(setAlarm).toHaveBeenCalledWith(301_001);

    await setOperationalLoopEnabled(env, 'alarms', true, 2_000);
    if (!(await deferAlarmWhenDisabled(env, storage, 'TestDO', 2_001))) workCount++;
    expect(workCount).toBe(1);
  });

  it('disabling and re-enabling cron work updates the cached decision', async () => {
    const put = vi.fn();
    const env = makeEnv(vi.fn().mockResolvedValue(null), put);

    await setOperationalLoopEnabled(env, 'cron', false, 0);
    expect(await isOperationalLoopEnabled(env, 'cron', 1)).toBe(false);
    await setOperationalLoopEnabled(env, 'cron', true, 2);
    expect(await isOperationalLoopEnabled(env, 'cron', 3)).toBe(true);
    expect(put).toHaveBeenNthCalledWith(1, 'control-loops:cron-enabled', 'false');
    expect(put).toHaveBeenNthCalledWith(2, 'control-loops:cron-enabled', 'true');
  });

  it('caps in-memory cache configuration at 30 seconds', () => {
    expect(resolveOperationalKillSwitchCacheMs(makeEnv(vi.fn(), vi.fn(), {
      CONTROL_LOOP_KILL_SWITCH_CACHE_MS: '60000',
    }))).toBe(30_000);
  });

  it('clamps a dangerously short disabled-alarm retry to the safety floor', () => {
    expect(
      resolveDisabledAlarmRetryMs(
        makeEnv(vi.fn(), vi.fn(), { CONTROL_LOOP_DISABLED_ALARM_RETRY_MS: '1' })
      )
    ).toBe(60_000);
  });
});
