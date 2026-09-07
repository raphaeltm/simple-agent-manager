/**
 * Unit tests for `scheduled/trial-waitlist-cleanup.ts`.
 *
 * Verifies:
 *   - Only rows with notified_at IS NOT NULL AND notified_at < (now - purgeDays) are candidates
 *   - When there are candidates, a DELETE is issued
 *   - When there are no candidates, no DELETE is issued and `purged=0`
 *   - purgeDays falls back to the default when env is missing
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const { mockSelect, mockSelectFrom, mockDelete, mockLt } = vi.hoisted(() => {
  const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
  const mockDelete = vi.fn().mockReturnValue({ where: mockDeleteWhere });
  const mockSelectFrom = vi.fn();
  const mockSelect = vi.fn().mockReturnValue({ from: mockSelectFrom });
  const mockLt = vi.fn((_col: unknown, val: unknown) => ({ type: 'lt', val }));
  return {
    mockSelect,
    mockSelectFrom,
    mockDelete,
    mockLt,
  };
});

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn().mockReturnValue({
    select: mockSelect,
    delete: mockDelete,
  }),
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  isNotNull: vi.fn((col: unknown) => ({ type: 'isNotNull', col })),
  lt: mockLt,
}));

vi.mock('../../../src/db/schema', () => ({
  trialWaitlist: {
    id: 'id',
    notifiedAt: 'notified_at',
  },
}));

const { runTrialWaitlistCleanup } = await import(
  '../../../src/scheduled/trial-waitlist-cleanup'
);

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { DATABASE: {}, ...overrides } as unknown as Env;
}

function buildSelectChain(rows: unknown[]) {
  return {
    where: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(rows),
    }),
  };
}

describe('runTrialWaitlistCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes rows when candidates exist and returns the count', async () => {
    const candidates = [{ id: 'wl_a' }, { id: 'wl_b' }];
    mockSelectFrom.mockReturnValueOnce(buildSelectChain(candidates));

    const res = await runTrialWaitlistCleanup(makeEnv(), 1_700_000_000_000);
    expect(res).toEqual({ purged: 2 });
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it('returns purged=0 without issuing a DELETE when nothing matches', async () => {
    mockSelectFrom.mockReturnValueOnce(buildSelectChain([]));
    const res = await runTrialWaitlistCleanup(makeEnv(), 1_700_000_000_000);
    expect(res).toEqual({ purged: 0 });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('uses the env override TRIAL_WAITLIST_PURGE_DAYS when present', async () => {
    mockSelectFrom.mockReturnValueOnce(buildSelectChain([]));
    const env = makeEnv({ TRIAL_WAITLIST_PURGE_DAYS: '60' });
    const now = 2_000_000_000_000; // arbitrary
    await runTrialWaitlistCleanup(env, now);

    // The `lt` helper was called with the threshold — verify it was derived
    // from the env override (60 days) not the default (30 days).
    const expectedThreshold60 = now - 60 * 24 * 60 * 60 * 1000;
    expect(mockLt).toHaveBeenCalledWith(
      expect.anything(),
      expectedThreshold60
    );
  });

  it('falls back to default 30 days when env is missing', async () => {
    mockSelectFrom.mockReturnValueOnce(buildSelectChain([]));
    const env = makeEnv();
    const now = 2_000_000_000_000;
    await runTrialWaitlistCleanup(env, now);

    const expectedThreshold30 = now - 30 * 24 * 60 * 60 * 1000;
    expect(mockLt).toHaveBeenCalledWith(
      expect.anything(),
      expectedThreshold30
    );
  });
});
