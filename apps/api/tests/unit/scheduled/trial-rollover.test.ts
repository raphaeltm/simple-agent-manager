/**
 * Unit tests for `scheduled/trial-rollover.ts`.
 *
 * Verifies:
 *   - prune() is called with the month key `keepMonths - 1` earlier than current
 *   - Returned result carries monthKey + pruned
 *   - DO failure is swallowed (logged) and returns pruned=0 so the cron continues
 *   - monthKey drift is logged but does not throw
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const { mockLogWarn, mockLogError } = vi.hoisted(() => ({
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: {
    info: vi.fn(),
    warn: mockLogWarn,
    error: mockLogError,
  },
}));

import { runTrialRolloverAudit } from '../../../src/scheduled/trial-rollover';

function makeEnv(options: {
  pruneFn: (keep: string) => Promise<number>;
  getFn?: (key: string) => Promise<{ monthKey: string; count: number }>;
  keepMonths?: string;
}): Env {
  return {
    TRIAL_COUNTER_KEEP_MONTHS: options.keepMonths,
    TRIAL_COUNTER: {
      idFromName: vi.fn(() => 'do-id'),
      get: vi.fn(() => ({
        prune: options.pruneFn,
        get:
          options.getFn ??
          vi.fn(async (key: string) => ({ monthKey: key, count: 0 })),
      })),
    },
  } as unknown as Env;
}

describe('runTrialRolloverAudit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prunes rows older than keepMonths and returns pruned count', async () => {
    const pruneFn = vi.fn().mockResolvedValue(7);
    // now = 2026-04-18 → monthKey 2026-04 → keep 3 months → oldestKept 2026-02
    const now = Date.UTC(2026, 3, 18);
    const env = makeEnv({ pruneFn, keepMonths: '3' });

    const res = await runTrialRolloverAudit(env, now);
    expect(res).toEqual({ monthKey: '2026-04', pruned: 7 });
    expect(pruneFn).toHaveBeenCalledWith('2026-02');
  });

  it('falls back to DEFAULT_TRIAL_COUNTER_KEEP_MONTHS (3) when env is missing', async () => {
    const pruneFn = vi.fn().mockResolvedValue(0);
    const now = Date.UTC(2026, 5, 1); // 2026-06
    const env = makeEnv({ pruneFn });

    await runTrialRolloverAudit(env, now);
    expect(pruneFn).toHaveBeenCalledWith('2026-04');
  });

  it('logs a warning on monthKey drift but returns normally', async () => {
    const pruneFn = vi.fn().mockResolvedValue(0);
    const getFn = vi.fn().mockResolvedValue({ monthKey: '2026-03', count: 1 });
    const now = Date.UTC(2026, 3, 18); // 2026-04
    const env = makeEnv({ pruneFn, getFn });

    const res = await runTrialRolloverAudit(env, now);
    expect(res).toEqual({ monthKey: '2026-04', pruned: 0 });
    expect(mockLogWarn).toHaveBeenCalledWith(
      'trial.rollover.monthKey_drift',
      expect.objectContaining({ expected: '2026-04', actual: '2026-03' })
    );
  });

  it('swallows DO errors and returns pruned=0', async () => {
    const pruneFn = vi.fn().mockRejectedValue(new Error('do unavailable'));
    const now = Date.UTC(2026, 3, 18);
    const env = makeEnv({ pruneFn });

    const res = await runTrialRolloverAudit(env, now);
    expect(res).toEqual({ monthKey: '2026-04', pruned: 0 });
    expect(mockLogError).toHaveBeenCalledWith(
      'trial.rollover.failed',
      expect.any(Object)
    );
  });
});
