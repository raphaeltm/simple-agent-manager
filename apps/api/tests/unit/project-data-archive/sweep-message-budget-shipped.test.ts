/**
 * What the shipped `PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET` costs and buys.
 *
 * The behavioural half of this change lives in
 * `tests/workers/project-data-archive-sweep-throughput.test.ts`, which drives the real sweep
 * and proves the budget is a SELECTION ceiling: at 5000 a 5k-20k session is invisible, at the
 * shipped value it migrates. These cases cover the half that behaviour test cannot see — what
 * the raised ceiling does to the daily write allowance, which is a different binding constraint
 * and an operating-cost question.
 *
 * Production measurements, 2026-09-20 (root ProjectData object at 9.98 GB / 10 GB configured):
 *
 * - `project_data_archive_write_budget` held 106,804 reserved writes for 23,427 published
 *   messages across 5 sessions, i.e. ~4.56 estimated writes per message including the fixed
 *   1000-unit per-session charge. Net of that charge the marginal rate is ~2.17 inventory units
 *   per message — right at the 100% overhead `_SWEEP_UNIT_OVERHEAD_PERCENT` assumes.
 * - `session_summaries` held 306 eligible SAM sessions in the 5k-20k band carrying 2,341,731
 *   messages — 40% of that project's eligible backlog, none of it selectable at 5000.
 *
 * Every value these cases reason about is read from the checked-in `[vars]` rather than
 * retyped, because a test that pins a hand-copied constant stays green when someone edits
 * `wrangler.toml` (`.claude/rules/70`). All four vars read here were verified absent from the
 * `production` and `staging` GitHub Environments on 2026-09-20, so the checked-in value IS the
 * deployed value. The reservation runs against a real SQLite engine through `createSqliteD1`,
 * not a stub, because the thing under test is a conditional UPDATE predicate
 * (`.claude/rules/28`).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as TOML from '@iarna/toml';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ARCHIVE_WRITE_FIXED_RESERVATION,
  archiveAffordableMessageCeiling,
  archiveWriteBudgetConfig,
  reserveArchiveWrites,
} from '../../../src/project-data-archive/write-budget';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

/** The budget production ran until 2026-09-20, and the ceiling that hid the 5k-20k band. */
const PREVIOUS_SWEEP_MESSAGE_BUDGET = 5_000;

/**
 * Marginal inventory units per message, measured from the production write-budget row above
 * (4.56 writes/message at factor 2 over a 4,685-message average session, less the fixed
 * charge). Not derived from `_SWEEP_UNIT_OVERHEAD_PERCENT` — deriving it would make the
 * headroom assertion below a tautology.
 */
const MEASURED_UNITS_PER_MESSAGE = 2.17;

/** Hourly cadence: `PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_INTERVAL_MS` is 3600000. */
const TICKS_PER_DAY = 24;
const WINDOW_START = Date.UTC(2026, 8, 20, 0, 0, 0);

function readShippedVar(name: string): string {
  const parsed = TOML.parse(
    readFileSync(resolve(import.meta.dirname, '../../../wrangler.toml'), 'utf-8')
  ) as { vars?: Record<string, unknown> };
  const value = parsed.vars?.[name];
  if (typeof value !== 'string') {
    throw new Error(`${name} is not a string in the [vars] table of apps/api/wrangler.toml`);
  }
  return value;
}

function shippedBudgetEnv() {
  return {
    PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET: readShippedVar(
      'PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET'
    ),
    PROJECT_DATA_ARCHIVE_WRITE_ESTIMATE_FACTOR: readShippedVar(
      'PROJECT_DATA_ARCHIVE_WRITE_ESTIMATE_FACTOR'
    ),
  };
}

const shippedSweepMessageBudget = () =>
  Number(readShippedVar('PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET'));
const shippedOverheadPercent = () =>
  Number(readShippedVar('PROJECT_DATA_ARCHIVE_SWEEP_UNIT_OVERHEAD_PERCENT'));

/** The estimate `estimateArchiveWrites` produces for a session of `messages` at the measured rate. */
function measuredEstimate(messages: number, factor: number): number {
  return ARCHIVE_WRITE_FIXED_RESERVATION +
    factor * Math.ceil(messages * MEASURED_UNITS_PER_MESSAGE);
}

describe('shipped archive sweep message budget', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(
      `CREATE TABLE project_data_archive_write_budget (
         id TEXT PRIMARY KEY,
         window_started_at INTEGER NOT NULL,
         reserved_writes INTEGER NOT NULL
       )`
    );
    db = createSqliteD1(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  async function reserveUntilRefused(estimate: number, allowance: number): Promise<number> {
    let admitted = 0;
    // Bounded well above any plausible ceiling so a runaway loop fails rather than hangs.
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const outcome = await reserveArchiveWrites(db, estimate, allowance, WINDOW_START);
      if (!outcome.reserved) return admitted;
      admitted += 1;
    }
    throw new Error('reservation never refused');
  }

  it('is the smaller of the two ceilings, so it is what actually selects', async () => {
    const { allowance, factor } = archiveWriteBudgetConfig(shippedBudgetEnv());

    // `resolveSweepAffordability` takes min(sweepMessageBudget, derived). If the derived
    // ceiling were the smaller one, editing the sweep budget would change nothing — the
    // 2026-09-08 deadlock was exactly this pair drifting apart in the other direction.
    const derived = archiveAffordableMessageCeiling(allowance, factor, shippedOverheadPercent());

    expect(shippedSweepMessageBudget()).toBeLessThan(derived);
    // The band the raised ceiling exists to reach. Divergence case for the behavioural test:
    // at the previous value the same 306 sessions were excluded by the selector's SQL.
    expect(shippedSweepMessageBudget()).toBeGreaterThan(PREVIOUS_SWEEP_MESSAGE_BUDGET);
  });

  it('admits a candidate at the ceiling, at the measured per-message cost', async () => {
    const { allowance, factor } = archiveWriteBudgetConfig(shippedBudgetEnv());

    const outcome = await reserveArchiveWrites(
      db,
      measuredEstimate(shippedSweepMessageBudget(), factor),
      allowance,
      WINDOW_START
    );

    // A ceiling the allowance can never pay for is the deadlock shape: largest-first selection
    // would re-pick the same refused session every tick (`.claude/rules/72` — `exceeds_allowance`
    // is not a deferral).
    expect(outcome).toEqual({ reserved: true });
  });

  it('moves more messages per day than the previous budget, and the allowance is now what binds', async () => {
    const { allowance, factor } = archiveWriteBudgetConfig(shippedBudgetEnv());
    const shipped = shippedSweepMessageBudget();

    const shippedSessions = await reserveUntilRefused(measuredEstimate(shipped, factor), allowance);
    sqlite.exec('DELETE FROM project_data_archive_write_budget');
    const previousSessions = await reserveUntilRefused(
      measuredEstimate(PREVIOUS_SWEEP_MESSAGE_BUDGET, factor),
      allowance
    );

    // The tick can only fence one budget's worth of messages, and a single candidate at the
    // ceiling consumes nearly all of it, so daily throughput is
    // min(affordable sessions, hourly ticks) x budget.
    const shippedPerDay = Math.min(shippedSessions, TICKS_PER_DAY) * shipped;
    const previousPerDay =
      Math.min(previousSessions, TICKS_PER_DAY) * PREVIOUS_SWEEP_MESSAGE_BUDGET;

    // The reason to raise the budget at all. Verified discriminating on 2026-09-20 by
    // reverting the shipped var to "5000": this assertion is what goes red.
    expect(shippedPerDay).toBeGreaterThan(previousPerDay);

    // The honest cost of that gain, asserted rather than left in a comment: the binding
    // constraint MOVES. At 5000 the hourly cadence bound throughput and the allowance was
    // never exhausted; at the shipped ceiling the allowance runs out first, so the back half
    // of the day reports `window_exhausted` — normal backpressure, not an alert
    // (`.claude/rules/72`). Bigger sessions are still the better buy per write: the fixed
    // 1000-unit per-session charge is amortised over 4x more messages.
    expect(previousSessions).toBeGreaterThan(TICKS_PER_DAY);
    expect(shippedSessions).toBeLessThan(TICKS_PER_DAY);
    expect(shippedSessions).toBeGreaterThanOrEqual(8);
  });
});
