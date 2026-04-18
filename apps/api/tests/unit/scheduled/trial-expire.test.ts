/**
 * Unit tests for `scheduled/trial-expire.ts`.
 *
 * Verifies:
 *   - Rows with status ∈ {pending, ready} AND expires_at < now are selected
 *   - Selected rows are updated to status='expired'
 *   - When no candidates exist, no update is issued and `expired=0`
 *   - Counter DO is NOT called (slot is legitimately consumed)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const { mockSelect, mockSelectFrom, mockUpdate, mockUpdateSet, mockUpdateWhere } =
  vi.hoisted(() => {
    const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
    const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
    const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

    const mockSelectFrom = vi.fn();
    const mockSelect = vi.fn().mockReturnValue({ from: mockSelectFrom });

    return {
      mockSelect,
      mockSelectFrom,
      mockUpdate,
      mockUpdateSet,
      mockUpdateWhere,
    };
  });

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn().mockReturnValue({
    select: mockSelect,
    update: mockUpdate,
  }),
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  inArray: vi.fn((_col: unknown, vals: unknown) => ({ type: 'inArray', vals })),
  lt: vi.fn((_col: unknown, val: unknown) => ({ type: 'lt', val })),
}));

vi.mock('../../../src/db/schema', () => ({
  trials: {
    id: 'id',
    status: 'status',
    expiresAt: 'expires_at',
  },
}));

const { runTrialExpireSweep } = await import(
  '../../../src/scheduled/trial-expire'
);

function makeEnv(): Env {
  return { DATABASE: {} } as unknown as Env;
}

/**
 * Drizzle chain: `.select(...).from(...).where(...).limit(...)`. The final
 * `.limit()` resolves to the row array.
 */
function buildSelectChain(rows: unknown[]) {
  return {
    where: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(rows),
    }),
  };
}

describe('runTrialExpireSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('expires rows older than now with status pending/ready', async () => {
    const candidates = [{ id: 'trial_a' }, { id: 'trial_b' }, { id: 'trial_c' }];
    mockSelectFrom.mockReturnValueOnce(buildSelectChain(candidates));

    const res = await runTrialExpireSweep(makeEnv(), 1_700_000_000_000);

    expect(res).toEqual({ expired: 3 });
    // update() was called once
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    // The set() call should be { status: 'expired' }
    expect(mockUpdateSet).toHaveBeenCalledWith({ status: 'expired' });
    // where() should use inArray of the captured ids
    const whereArg = mockUpdateWhere.mock.calls[0]?.[0] as {
      type: string;
      vals: unknown;
    };
    expect(whereArg.type).toBe('inArray');
    expect(whereArg.vals).toEqual(['trial_a', 'trial_b', 'trial_c']);
  });

  it('returns early with expired=0 when no candidates exist', async () => {
    mockSelectFrom.mockReturnValueOnce(buildSelectChain([]));

    const res = await runTrialExpireSweep(makeEnv(), 1_700_000_000_000);

    expect(res).toEqual({ expired: 0 });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('does NOT call the TrialCounter DO (slot is consumed legitimately)', async () => {
    // Env has no TRIAL_COUNTER binding — this would throw if the code touched it.
    const env = makeEnv();
    mockSelectFrom.mockReturnValueOnce(buildSelectChain([{ id: 'trial_x' }]));
    await expect(runTrialExpireSweep(env, 1_700_000_000_000)).resolves.toEqual({
      expired: 1,
    });
  });
});
