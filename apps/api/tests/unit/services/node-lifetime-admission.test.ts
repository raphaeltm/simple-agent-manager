/**
 * Policy a3780107 (2026-11-03): a node takes no new placements in the last 10% of its absolute
 * lifetime. These pin how the cutoff age resolves; the SQL is exercised against real SQLite in
 * `workspace-placement.test.ts` and `task-runner-reuse-scoping.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolveAdminSetting: vi.fn() }));

vi.mock('../../../src/services/admin-settings-resolution', () => ({
  resolveAdminSetting: (...args: unknown[]) => mocks.resolveAdminSetting(...args),
}));

const { lifetimeAdmissionCutoffSql, resolveLifetimeAdmissionCutoffAgeMs } =
  await import('../../../src/services/node-lifetime-admission');

const HOUR = 60 * 60 * 1000;

describe('resolveLifetimeAdmissionCutoffAgeMs', () => {
  beforeEach(() => mocks.resolveAdminSetting.mockReset());

  it('stops placements at 90% of the 24h lifetime by default', async () => {
    mocks.resolveAdminSetting.mockResolvedValue(10);
    await expect(resolveLifetimeAdmissionCutoffAgeMs({} as never)).resolves.toBe(0.9 * 24 * HOUR);
    expect(mocks.resolveAdminSetting).toHaveBeenCalledWith(
      {},
      'operations.nodeLifetimeAdmissionCutoffPercent'
    );
  });

  it('scales with an overridden absolute lifetime', async () => {
    mocks.resolveAdminSetting.mockResolvedValue(25);
    await expect(
      resolveLifetimeAdmissionCutoffAgeMs({
        NODE_ABSOLUTE_MAX_LIFETIME_MS: String(8 * HOUR),
      } as never)
    ).resolves.toBe(6 * HOUR);
  });

  it('is disabled at 0 percent', async () => {
    mocks.resolveAdminSetting.mockResolvedValue(0);
    await expect(resolveLifetimeAdmissionCutoffAgeMs({} as never)).resolves.toBeNull();
  });

  it.each([Number.NaN, -1, 100, 2.5])('falls back to the default for %s', async (value) => {
    mocks.resolveAdminSetting.mockResolvedValue(value);
    await expect(resolveLifetimeAdmissionCutoffAgeMs({} as never)).resolves.toBe(0.9 * 24 * HOUR);
  });
});

describe('lifetimeAdmissionCutoffSql', () => {
  it('adds nothing when the cutoff is disabled', () => {
    expect(lifetimeAdmissionCutoffSql('n', null, new Date())).toEqual({ sql: '', binds: [] });
  });

  it('binds the creation-time threshold the lifetime sweep compares against', () => {
    const now = new Date('2026-11-03T12:00:00.000Z');
    const cutoff = lifetimeAdmissionCutoffSql('n', 2 * HOUR, now);
    expect(cutoff.binds).toEqual(['2026-11-03T10:00:00.000Z']);
    expect(cutoff.sql).toContain('n.created_at < ?');
    expect(cutoff.sql).toContain("n.node_class != 'user-owned'");
  });
});
