/**
 * What the shipped `PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET` costs and buys.
 *
 * The behavioural half lives in `tests/workers/project-data-archive-sweep-throughput.test.ts`,
 * which drives the real sweep and proves the budget is a SELECTION ceiling: below it a larger
 * session is invisible, at it the session archives with its transcript intact. These cases
 * cover the half that behaviour test cannot see — what the ceiling does to the daily write
 * allowance, which is a different binding constraint and an operating-cost question.
 *
 * Measured in production on 2026-09-20 (root ProjectData object at ~99.85% of its configured
 * 10 GB limit):
 *
 * - `project_data_archive_write_budget` held 106,804 reserved writes for 23,427 published
 *   messages across 5 sessions: ~4.56 ESTIMATED writes per message including the fixed
 *   1000-unit per-session charge, so ~2.17 inventory units per message at the shipped factor
 *   of 2. These are reservation estimates, NOT billed rows; the estimator is deliberately
 *   conservative and the two are not interchangeable.
 * - Applying `selectCandidates`' own predicates (terminal status, `ended_at` past the 7-day
 *   `_SESSION_GRACE_MS` cutoff, location `root`, breaker closed, no live snapshot) the SAM
 *   project held 3344 sessions at <=5000 `message_count`, 266 at 5001-10000, 23 at
 *   10001-20000 and 13 above 20000. So a 10000 ceiling reaches 266 of the 289 sessions that
 *   5000 could not see. `message_count` is the selector's own ranking column, not a byte
 *   measurement.
 *
 * Environment overrides checked the same day (`.claude/rules/70`): of the four vars these
 * cases read, `PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET` IS pinned as a `production` GitHub
 * Environment variable — at 800000, identical to the checked-in value, so there is no
 * divergence today but a future edit to `wrangler.toml` alone would NOT ship. The other three
 * (`_SWEEP_MESSAGE_BUDGET`, `_WRITE_ESTIMATE_FACTOR`, `_SWEEP_UNIT_OVERHEAD_PERCENT`) are
 * absent from both the `production` and `staging` Environments, so for those the checked-in
 * value is the deployed value.
 *
 * The reservation runs against a real SQLite engine through `createSqliteD1`, not a stub,
 * because the thing under test is a conditional UPDATE predicate (`.claude/rules/28`).
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ARCHIVE_WRITE_FIXED_RESERVATION,
  archiveAffordableMessageCeiling,
  archiveWriteBudgetConfig,
  reserveArchiveWrites,
} from '../../../src/project-data-archive/write-budget';
import {
  PREVIOUS_SWEEP_MESSAGE_BUDGET,
  SHIPPED_SWEEP_MESSAGE_BUDGET,
  SHIPPED_SWEEP_SESSIONS,
} from '../../helpers/archive-sweep-ceiling';
import { readShippedVar, shippedBudgetEnv } from '../../helpers/shipped-archive-budget';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

/**
 * Marginal inventory units per message, from the production write-budget row above (4.56
 * estimated writes/message at factor 2 over a 4,685-message average session, less the fixed
 * charge). Deliberately NOT derived from `_SWEEP_UNIT_OVERHEAD_PERCENT`: deriving it would
 * make the affordability assertions restate their own inputs.
 */
const MEASURED_UNITS_PER_MESSAGE = 2.17;

/** Hourly cadence: `PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_INTERVAL_MS` is 3600000. */
const TICKS_PER_DAY = 24;
const WINDOW_START = Date.UTC(2026, 8, 20, 0, 0, 0);

const shippedOverheadPercent = () =>
  Number(readShippedVar('PROJECT_DATA_ARCHIVE_SWEEP_UNIT_OVERHEAD_PERCENT'));

/** What `estimateArchiveWrites` would produce for `messages` rows at the measured rate. */
function measuredEstimate(messages: number, factor: number): number {
  return (
    ARCHIVE_WRITE_FIXED_RESERVATION + factor * Math.ceil(messages * MEASURED_UNITS_PER_MESSAGE)
  );
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

  it('is the value the Worker tests exercise', () => {
    // `node:fs` does not exist inside workerd, so the Worker test imports the constant rather
    // than reading the TOML. This is the one place the constant is tied back to what ships —
    // without it, editing `wrangler.toml` alone would leave a green suite testing the old
    // ceiling (`.claude/rules/70`).
    expect(Number(readShippedVar('PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET'))).toBe(
      SHIPPED_SWEEP_MESSAGE_BUDGET
    );
  });

  it('pins the session slot count the Worker tests reproduce', () => {
    // `sweepEnv` in the Worker test has to stand in for the deployed configuration, and every
    // value in it that is hardcoded rather than derived is a value a later `wrangler.toml` edit
    // can silently desynchronise. The message budget already had this guard; the slot count did
    // not, which is the gap CodeRabbit caught on 2026-09-20.
    expect(Number(readShippedVar('PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS'))).toBe(
      SHIPPED_SWEEP_SESSIONS
    );
  });

  it('is the smaller of the two ceilings, so it is what actually selects', () => {
    const { allowance, factor } = archiveWriteBudgetConfig(shippedBudgetEnv());

    // `resolveSweepAffordability` takes min(sweepMessageBudget, derived). If the derived
    // ceiling were the smaller one, editing the sweep budget would change nothing — the
    // 2026-09-08 deadlock was this pair drifting apart in the other direction.
    expect(SHIPPED_SWEEP_MESSAGE_BUDGET).toBeLessThan(
      archiveAffordableMessageCeiling(allowance, factor, shippedOverheadPercent())
    );
    expect(SHIPPED_SWEEP_MESSAGE_BUDGET).toBeGreaterThan(PREVIOUS_SWEEP_MESSAGE_BUDGET);
  });

  it('admits a candidate at the ceiling, at the measured per-message cost', async () => {
    const { allowance, factor } = archiveWriteBudgetConfig(shippedBudgetEnv());

    const outcome = await reserveArchiveWrites(
      db,
      measuredEstimate(SHIPPED_SWEEP_MESSAGE_BUDGET, factor),
      allowance,
      WINDOW_START
    );

    // A ceiling the allowance can never pay for is the deadlock shape: largest-first selection
    // would re-pick the same refused session every tick (`.claude/rules/72` — `exceeds_allowance`
    // is not a deferral). This is a real constraint, not a restatement of its inputs: the
    // measured rate is independent of `_SWEEP_UNIT_OVERHEAD_PERCENT`, so a ceiling raised far
    // enough (or a factor raised) makes it fail.
    expect(outcome).toEqual({ reserved: true });
  });

  it('raises the daily message ceiling, and moves which constraint binds', async () => {
    const { allowance, factor } = archiveWriteBudgetConfig(shippedBudgetEnv());

    const shippedSessions = await reserveUntilRefused(
      measuredEstimate(SHIPPED_SWEEP_MESSAGE_BUDGET, factor),
      allowance
    );
    sqlite.exec('DELETE FROM project_data_archive_write_budget');
    const previousSessions = await reserveUntilRefused(
      measuredEstimate(PREVIOUS_SWEEP_MESSAGE_BUDGET, factor),
      allowance
    );

    // A tick can only fence one budget's worth of messages, and a candidate at the ceiling
    // consumes nearly all of it, so the daily CEILING is
    // min(affordable sessions, hourly ticks) x budget. This is an upper bound on what the
    // sweep could move, not a forecast: selection is global and largest-first, so how much of
    // it any one project receives depends on the other projects competing for the same ticks
    // and the same allowance.
    const shippedPerDay = Math.min(shippedSessions, TICKS_PER_DAY) * SHIPPED_SWEEP_MESSAGE_BUDGET;
    const previousPerDay =
      Math.min(previousSessions, TICKS_PER_DAY) * PREVIOUS_SWEEP_MESSAGE_BUDGET;

    // The reason to raise the budget at all. Proven discriminating on 2026-09-20 by setting
    // `SHIPPED_SWEEP_MESSAGE_BUDGET` back to 5000: this goes red with
    // `expected 120000 to be greater than 120000`, alongside the ceiling case. Editing
    // `wrangler.toml` alone instead reddens the drift guard above, which names both values.
    expect(shippedPerDay).toBeGreaterThan(previousPerDay);

    // The honest cost of that gain, asserted rather than left in a comment: the binding
    // constraint MOVES. At the previous ceiling the hourly cadence bound throughput and the
    // allowance was never exhausted; at the shipped ceiling the allowance runs out first, so
    // later ticks report `window_exhausted` — normal backpressure, not an alert
    // (`.claude/rules/72`). Bigger candidates are still the better buy per write, because the
    // fixed per-session charge amortises over more messages.
    expect(previousSessions).toBeGreaterThan(TICKS_PER_DAY);
    expect(shippedSessions).toBeLessThan(TICKS_PER_DAY);
    // Loose lower bound: enough affordable sessions that a single bad candidate consuming
    // three attempts cannot spend the whole day's allowance.
    expect(shippedSessions).toBeGreaterThanOrEqual(12);
  });
});
