/**
 * The per-project monthly budget's atomic reservation and settle, against a real SQLite engine
 * (rule 28). `reserveAgentModelBudget` is the final atomic write (rule 69): this file proves two
 * contenders racing the same cap resolve to exactly one winner, not just that the happy path and
 * the over-cap path work in isolation.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../../src/db/schema';
import {
  microUsdToUsd,
  monthResetsAt,
  readAgentModelUsage,
  reserveAgentModelBudget,
  settleAgentModelBudget,
  usageMonth,
} from '../../../../src/services/agent-models/budget';
import { createSchemaTables, createSqliteD1 } from '../../../helpers/sqlite-d1';

const PROJECT = 'proj-1';
const OTHER_PROJECT = 'proj-2';
const MONTH = '2026-10';

function createDb(): D1Database {
  const sqlite = new Database(':memory:');
  // FK/NOT NULL/DEFAULT constraints are intentionally omitted by createSchemaTables, so the
  // referenced `projects` row is not needed here (rule 28's real-engine helper, narrow fixture).
  createSchemaTables(sqlite, [schema.agentModelMonthlyUsage, schema.agentModelUsageByModel]);
  return createSqliteD1(sqlite);
}

describe('usageMonth / monthResetsAt / microUsdToUsd', () => {
  it('formats the UTC month as YYYY-MM', () => {
    expect(usageMonth(new Date('2026-03-05T23:59:59.000Z'))).toBe('2026-03');
  });

  it('computes the ISO start of the following UTC month', () => {
    expect(monthResetsAt('2026-03')).toBe('2026-04-01T00:00:00.000Z');
  });

  it('rolls over at a UTC year boundary', () => {
    expect(monthResetsAt('2026-12')).toBe('2027-01-01T00:00:00.000Z');
  });

  it('rounds to the nearest micro-USD before converting to USD', () => {
    expect(microUsdToUsd(1_500_000)).toBe(1.5);
    expect(microUsdToUsd(38.4)).toBe(38 / 1_000_000);
  });
});

describe('reserveAgentModelBudget', () => {
  let db: D1Database;

  beforeEach(() => {
    db = createDb();
  });

  it('creates the month row and succeeds for a reservation under the limit', async () => {
    const ok = await reserveAgentModelBudget(db, {
      projectId: PROJECT,
      month: MONTH,
      amountMicroUsd: 4_000,
      limitMicroUsd: 10_000,
      now: 1_000,
    });
    expect(ok).toBe(true);
    const usage = await readAgentModelUsage(db, PROJECT, MONTH);
    expect(usage.reservedUsd).toBe(4_000 / 1_000_000);
    expect(usage.spentUsd).toBe(0);
  });

  it('succeeds at the exact boundary (spent + reserved + amount === limit)', async () => {
    const ok = await reserveAgentModelBudget(db, {
      projectId: PROJECT,
      month: MONTH,
      amountMicroUsd: 10_000,
      limitMicroUsd: 10_000,
      now: 1_000,
    });
    expect(ok).toBe(true);
  });

  it('refuses a reservation that would exceed the limit, and does not mutate reserved', async () => {
    await reserveAgentModelBudget(db, {
      projectId: PROJECT,
      month: MONTH,
      amountMicroUsd: 6_000,
      limitMicroUsd: 10_000,
      now: 1_000,
    });
    const ok = await reserveAgentModelBudget(db, {
      projectId: PROJECT,
      month: MONTH,
      amountMicroUsd: 5_000,
      limitMicroUsd: 10_000,
      now: 2_000,
    });
    expect(ok).toBe(false);
    const usage = await readAgentModelUsage(db, PROJECT, MONTH);
    // Only the first reservation is held; the refused one left no trace.
    expect(usage.reservedUsd).toBe(6_000 / 1_000_000);
  });

  it('floors a sub-1-micro-USD amount up to 1, never reserving zero for a priced call', async () => {
    const ok = await reserveAgentModelBudget(db, {
      projectId: PROJECT,
      month: MONTH,
      amountMicroUsd: 0.2,
      limitMicroUsd: 10_000,
      now: 1_000,
    });
    expect(ok).toBe(true);
    const usage = await readAgentModelUsage(db, PROJECT, MONTH);
    expect(usage.reservedUsd).toBe(1 / 1_000_000);
  });

  it('scopes reservations per project: one project exhausting its cap does not affect another', async () => {
    await reserveAgentModelBudget(db, {
      projectId: PROJECT,
      month: MONTH,
      amountMicroUsd: 10_000,
      limitMicroUsd: 10_000,
      now: 1_000,
    });
    const otherOk = await reserveAgentModelBudget(db, {
      projectId: OTHER_PROJECT,
      month: MONTH,
      amountMicroUsd: 10_000,
      limitMicroUsd: 10_000,
      now: 1_000,
    });
    expect(otherOk).toBe(true);
  });

  it('scopes reservations per month: the same project in a later month gets a fresh cap', async () => {
    await reserveAgentModelBudget(db, {
      projectId: PROJECT,
      month: '2026-09',
      amountMicroUsd: 10_000,
      limitMicroUsd: 10_000,
      now: 1_000,
    });
    const nextMonthOk = await reserveAgentModelBudget(db, {
      projectId: PROJECT,
      month: '2026-10',
      amountMicroUsd: 10_000,
      limitMicroUsd: 10_000,
      now: 2_000,
    });
    expect(nextMonthOk).toBe(true);
  });

  /**
   * Rule 69: the final atomic write must enforce the cap even when two contenders race it, not
   * only when a test deliberately sequences them. Each of these two reservations fits alone
   * (6,000 <= 10,000) but together they exceed the 10,000 cap, so at most one may win.
   */
  it('a real race: two concurrent reservations that individually fit but together overspend — exactly one wins', async () => {
    const [first, second] = await Promise.all([
      reserveAgentModelBudget(db, {
        projectId: PROJECT,
        month: MONTH,
        amountMicroUsd: 6_000,
        limitMicroUsd: 10_000,
        now: 1_000,
      }),
      reserveAgentModelBudget(db, {
        projectId: PROJECT,
        month: MONTH,
        amountMicroUsd: 6_000,
        limitMicroUsd: 10_000,
        now: 1_000,
      }),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    const usage = await readAgentModelUsage(db, PROJECT, MONTH);
    // The cap was never exceeded: only the winner's amount is held.
    expect(usage.reservedUsd).toBe(6_000 / 1_000_000);
  });

  it('a real race with three contenders over a two-winner cap — exactly two win', async () => {
    const attempt = () =>
      reserveAgentModelBudget(db, {
        projectId: PROJECT,
        month: MONTH,
        amountMicroUsd: 4_000,
        limitMicroUsd: 10_000,
        now: 1_000,
      });

    const results = await Promise.all([attempt(), attempt(), attempt()]);

    expect(results.filter(Boolean)).toHaveLength(2);
    const usage = await readAgentModelUsage(db, PROJECT, MONTH);
    expect(usage.reservedUsd).toBe(8_000 / 1_000_000);
  });
});

describe('settleAgentModelBudget', () => {
  let db: D1Database;

  beforeEach(() => {
    db = createDb();
  });

  async function reserve(amountMicroUsd: number) {
    await reserveAgentModelBudget(db, {
      projectId: PROJECT,
      month: MONTH,
      amountMicroUsd,
      limitMicroUsd: 1_000_000,
      now: 1_000,
    });
  }

  it('moves the reservation into spent and counts the call', async () => {
    await reserve(5_000);
    const totals = await settleAgentModelBudget(db, {
      projectId: PROJECT,
      month: MONTH,
      modelId: '@cf/cloudflare/clef-flash',
      reservedMicroUsd: 5_000,
      costMicroUsd: 3_000,
      failed: false,
      now: 2_000,
    });
    expect(totals).toEqual({ spentMicroUsd: 3_000, reservedMicroUsd: 0 });
    const usage = await readAgentModelUsage(db, PROJECT, MONTH);
    expect(usage.callCount).toBe(1);
  });

  it('when the reported cost exceeds the reservation, charges the full cost and clamps reserved at 0 (never negative)', async () => {
    await reserve(2_000);
    const totals = await settleAgentModelBudget(db, {
      projectId: PROJECT,
      month: MONTH,
      modelId: '@cf/cloudflare/clef-flash',
      reservedMicroUsd: 2_000,
      // The call turned out to cost more than the estimate held for it.
      costMicroUsd: 9_000,
      failed: false,
      now: 2_000,
    });
    expect(totals.reservedMicroUsd).toBe(0);
    expect(totals.spentMicroUsd).toBe(9_000);
  });

  it('a failed call still releases the reservation and still counts the call, with zero cost', async () => {
    await reserve(5_000);
    const totals = await settleAgentModelBudget(db, {
      projectId: PROJECT,
      month: MONTH,
      modelId: '@cf/cloudflare/clef-flash',
      reservedMicroUsd: 5_000,
      costMicroUsd: 0,
      failed: true,
      now: 2_000,
    });
    expect(totals).toEqual({ spentMicroUsd: 0, reservedMicroUsd: 0 });
    const usage = await readAgentModelUsage(db, PROJECT, MONTH);
    expect(usage.callCount).toBe(1);
    expect(usage.byModel[0]).toMatchObject({ callCount: 1, errorCount: 1, spentUsd: 0 });
  });

  it('accumulates call_count, error_count and spent across two settles of the same model in the same month', async () => {
    await reserve(5_000);
    await settleAgentModelBudget(db, {
      projectId: PROJECT,
      month: MONTH,
      modelId: '@cf/cloudflare/clef-flash',
      reservedMicroUsd: 5_000,
      costMicroUsd: 2_000,
      failed: false,
      now: 1_000,
    });
    await reserve(5_000);
    await settleAgentModelBudget(db, {
      projectId: PROJECT,
      month: MONTH,
      modelId: '@cf/cloudflare/clef-flash',
      reservedMicroUsd: 5_000,
      costMicroUsd: 0,
      failed: true,
      now: 9_000,
    });

    const usage = await readAgentModelUsage(db, PROJECT, MONTH);
    expect(usage.callCount).toBe(2);
    expect(usage.byModel).toHaveLength(1);
    expect(usage.byModel[0]).toMatchObject({
      modelId: '@cf/cloudflare/clef-flash',
      callCount: 2,
      errorCount: 1,
      spentUsd: 2_000 / 1_000_000,
      lastCalledAt: new Date(9_000).toISOString(),
    });
  });

  it('floors a sub-1-micro-USD cost up to 1, and allows an exact-zero cost to stay zero', async () => {
    await reserve(1_000);
    const totals = await settleAgentModelBudget(db, {
      projectId: PROJECT,
      month: MONTH,
      modelId: 'm',
      reservedMicroUsd: 1_000,
      costMicroUsd: 0.4,
      failed: false,
      now: 1_000,
    });
    expect(totals.spentMicroUsd).toBe(1);
  });
});

describe('readAgentModelUsage', () => {
  let db: D1Database;

  beforeEach(() => {
    db = createDb();
  });

  it('returns zeroed totals and an empty per-model list before any call is made', async () => {
    const usage = await readAgentModelUsage(db, PROJECT, MONTH);
    expect(usage).toMatchObject({
      month: MONTH,
      spentUsd: 0,
      reservedUsd: 0,
      callCount: 0,
      byModel: [],
    });
    expect(usage.resetsAt).toBe(monthResetsAt(MONTH));
  });

  it('orders per-model usage by spend desc, then call count desc, then model id asc (rule 65 tie-break)', async () => {
    const settle = (modelId: string, costMicroUsd: number, callCount: number) =>
      Promise.all(
        Array.from({ length: callCount }, async (_, index) => {
          await reserveAgentModelBudget(db, {
            projectId: PROJECT,
            month: MONTH,
            amountMicroUsd: costMicroUsd,
            limitMicroUsd: 1_000_000,
            now: index,
          });
          return settleAgentModelBudget(db, {
            projectId: PROJECT,
            month: MONTH,
            modelId,
            reservedMicroUsd: costMicroUsd,
            costMicroUsd,
            failed: false,
            now: index,
          });
        })
      );

    // Highest spend first; the next two tie on both spend (1,000) and call count (1), so the
    // model id itself must break the tie alphabetically.
    await settle('@cf/cloudflare/clef-flash', 5_000, 1);
    await settle('@cf/zzz/tie-b', 1_000, 1);
    await settle('@cf/aaa/tie-a', 1_000, 1);

    const usage = await readAgentModelUsage(db, PROJECT, MONTH);
    expect(usage.byModel.map((model) => model.modelId)).toEqual([
      '@cf/cloudflare/clef-flash',
      '@cf/aaa/tie-a',
      '@cf/zzz/tie-b',
    ]);
  });
});
