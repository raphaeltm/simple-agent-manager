/**
 * The shipped `PROJECT_DATA_ARCHIVE_WRITE_ESTIMATE_FACTOR` must buy the throughput it was
 * lowered to buy.
 *
 * Measured in production on 2026-09-14 by sampling `project_data_archive_write_budget` twice,
 * an hour apart: 726,408 reserved across 11 publishes at 11:29Z, 780,016 across 12 at 12:15Z.
 * That gives ~65,001 estimated writes per migration and therefore ~8,000 inventory units at the
 * then-shipped factor of 8. Cloudflare `durableObjectsPeriodicGroups` 5-minute buckets isolating
 * four archive ticks in DO namespace fb36fe21 billed 5,950 / 6,436 / 7,942 / 9,823 `rowsWritten`,
 * so billed rows per inventory unit spans 0.74-1.23. `factor` is pure safety margin over that.
 *
 * At factor 8 the then-shipped 800000 allowance bought only 800000 / (1000 + 8 x 8000) = 12
 * migrations/day while the then-hourly cadence allowed 24, so half the ticks ran and reclaimed
 * nothing. Confirmed forward: at 12:15Z only 19,984 units remained, and the 13:00Z tick was
 * refused.
 *
 * Since 2026-09-27 the cadence claims every 20 minutes (72 ticks/day) and the allowance was
 * tripled with it. Since 2026-11-12 a tick keeps working for `_WALL_TIME_MS` (60 s) instead of
 * stopping after one session, so the allowance must pay for a full tick of messages on every
 * tick, not just one migration. `shippedSweepTicksPerDay` and the shipped wall time are read
 * from `wrangler.toml`, so raising either without the allowance turns those cases red.
 *
 * These cases read the value this repository actually ships rather than a number retyped into
 * the test, because a test that pins a hand-copied constant stays green when someone edits
 * `wrangler.toml` — the exact "the diff is not the deployed value" failure class in
 * `.claude/rules/70-flag-flips-must-verify-the-deployed-value.md`.
 * `PROJECT_DATA_ARCHIVE_WRITE_ESTIMATE_FACTOR` is absent from the `production` and `staging`
 * Environments, so its checked-in value IS the deployed value.
 * `PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET` IS pinned in the `production` Environment and is
 * changed in lockstep with `wrangler.toml` (2400000 since 2026-09-27); the deploy log names any
 * divergence between the two.
 *
 * The reservation runs against a real SQLite engine through `createSqliteD1`, not a stub,
 * because the thing under test is a conditional UPDATE predicate: a mock that ignores its
 * arguments would return "reserved" no matter what the arithmetic produced
 * (`.claude/rules/28-credential-resolution-fallback-tests.md`).
 */
import {
  ARCHIVE_WRITE_FIXED_RESERVATION,
  archiveWriteBudgetConfig,
  reserveArchiveWrites,
} from '@simple-agent-manager/project-data/internal/archive/write-budget';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readShippedVar,
  shippedBudgetEnv,
  shippedSweepTicksPerDay,
} from '../../helpers/shipped-archive-budget';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

/**
 * Row inventory per migration the production sweep was reserving on 2026-09-14, derived from the
 * two budget samples above rather than from a single reading. An earlier draft of this test used
 * 7,442, which came from dividing the 11:29Z reservation total by 12 publishes when only 11 had
 * occurred — a 9% error that made the margin look better than it is.
 */
const MEASURED_UNITS_PER_MIGRATION = 8_000;
/** The allowance production ran when that factor-8 standstill was measured. */
const ALLOWANCE_WHEN_MEASURED = 800_000;
/**
 * Row inventory per migration in six production reservations sampled 2026-09-25/26 (17,784-27,106
 * estimated writes, mean ~21,500, at factor 2): (21,500 - 1000) / 2. Larger than the 2026-09-14
 * figure because the 10000-message ceiling shipped in #2109 admits ~8k-message sessions.
 */
const CURRENT_UNITS_PER_MIGRATION = 10_250;
const WINDOW_START = Date.UTC(2026, 8, 14, 0, 0, 0);
/**
 * Coordinator wall time per archived message, from production `project_data_archive_candidate_migrated`
 * events on 2026-11-12: 441-860-message sessions took 7.8-13.7 s in total, ~8 s of it fixed per
 * session, and the design review measured ~11.8 ms/message across larger ones. 10 ms is the
 * optimistic end, which makes the allowance check below conservative (more messages per tick).
 */
const MEASURED_MS_PER_MESSAGE = 10;
/** Inventory units per message, from the 2026-09-20 budget row (see sweep-message-budget-shipped). */
const MEASURED_UNITS_PER_MESSAGE = 2.17;
/** Fixed coordinator wall time per session (prepare, seal, manifest, finalize), measured 2026-11-12. */
const MEASURED_FIXED_MS_PER_SESSION = 3_000;

describe('shipped archive write-estimate factor', () => {
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

  async function reserveUntilRefused(
    allowance: number,
    factor: number,
    unitsPerMigration: number
  ): Promise<number> {
    const estimate = ARCHIVE_WRITE_FIXED_RESERVATION + factor * unitsPerMigration;
    let admitted = 0;
    // Bounded well above any plausible ceiling so a runaway loop fails the test rather than
    // hanging the suite.
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      const outcome = await reserveArchiveWrites(db, estimate, allowance, WINDOW_START);
      if (!outcome.reserved) return admitted;
      admitted += 1;
    }
    throw new Error('reservation never refused');
  }

  it('reproduces the factor-8 standstill measured on 2026-09-14', async () => {
    // Calibration of MEASURED_UNITS_PER_MIGRATION, not a claim about shipped config: the
    // measured session at that day's allowance reproduces the 12 migrations/day production
    // actually managed.
    expect(
      await reserveUntilRefused(ALLOWANCE_WHEN_MEASURED, 8, MEASURED_UNITS_PER_MIGRATION)
    ).toBe(12);
  });

  it('admits more migrations per UTC window than factor 8 does at the same allowance', async () => {
    const { allowance, factor } = archiveWriteBudgetConfig(shippedBudgetEnv());

    const shipped = await reserveUntilRefused(allowance, factor, MEASURED_UNITS_PER_MIGRATION);

    // Divergence case: the same allowance and the same measured session under the PREVIOUS
    // factor. This must fail against pre-change config, which is what makes the assertion
    // mean something (`.claude/rules/74`).
    sqlite.exec('DELETE FROM project_data_archive_write_budget');
    const previous = await reserveUntilRefused(allowance, 8, MEASURED_UNITS_PER_MIGRATION);

    expect(shipped).toBeGreaterThan(previous);
  });

  it('pays for a current-size migration on every tick the shipped cadence claims', async () => {
    const { allowance, factor } = archiveWriteBudgetConfig(shippedBudgetEnv());

    const admitted = await reserveUntilRefused(allowance, factor, CURRENT_UNITS_PER_MIGRATION);

    // The floor: every tick copies at least one session. Proven discriminating on 2026-09-27:
    // the previous 800000 allowance admits 37 against the 72 ticks an 18-minute interval
    // claims, and this goes red.
    expect(admitted).toBeGreaterThanOrEqual(shippedSweepTicksPerDay());
  });

  it('pays for a full wall-time tick of messages on every tick the shipped cadence claims', async () => {
    const { allowance, factor } = archiveWriteBudgetConfig(shippedBudgetEnv());
    const wallTimeMs = Number(readShippedVar('PROJECT_DATA_ARCHIVE_WALL_TIME_MS'));
    const ticksPerDay = shippedSweepTicksPerDay();

    // Worst case for the allowance: many sessions, so the fixed 1000-write charge repeats. A
    // tick runs `wallTimeMs` plus one candidate, and small sessions cost the fixed time plus
    // per-message time. 400-message sessions are the shape production drains most of today.
    const messagesPerSession = 400;
    const sessionMs = MEASURED_FIXED_MS_PER_SESSION + messagesPerSession * MEASURED_MS_PER_MESSAGE;
    const sessionsPerTick = Math.ceil(wallTimeMs / sessionMs) + 1;
    const unitsPerSession = Math.ceil(messagesPerSession * MEASURED_UNITS_PER_MESSAGE);

    const admitted = await reserveUntilRefused(allowance, factor, unitsPerSession);

    // If the allowance ran out before the day's ticks did, raising the wall time would buy
    // nothing past the point the window is exhausted. At 60 s this needs 10 sessions x 72 ticks
    // = 720 reservations of 2,736 writes (~1.97M). Proven discriminating on 2026-11-12: with the
    // allowance set to 1900000 it admits 694 and goes red.
    expect(admitted).toBeGreaterThanOrEqual(sessionsPerTick * ticksPerDay);
  });

  it('keeps a safety margin over the measured billed-rows ratio', async () => {
    const { factor } = archiveWriteBudgetConfig(shippedBudgetEnv());

    // Billed rows per estimate unit spans 0.74-1.23 across the four measured ticks, so the
    // worst observed case leaves factor 2 with ~63% headroom — real, but NOT the "100% margin"
    // an earlier draft claimed off a miscounted sample. A factor below the worst observed ratio
    // would let the budget under-charge real work; a factor far above it is what wasted half
    // the ticks each day. Bracket both directions so neither drifts back without a fresh
    // measurement and a deliberate edit here. n is small (2 budget samples, 4 telemetry
    // buckets); widen the sample before treating 2 as durably validated.
    expect(factor).toBeGreaterThanOrEqual(2);
    expect(factor).toBeLessThanOrEqual(4);
  });

  it('still refuses a session that costs more than the entire allowance', async () => {
    const { allowance, factor } = archiveWriteBudgetConfig(shippedBudgetEnv());

    // Control for the loosened factor: `exceeds_allowance` is a different recovery action from
    // `window_exhausted` (`.claude/rules/72`), and the sweep depends on that distinction to
    // descend to a smaller candidate instead of ending the tick. Lowering the factor must not
    // make the hard refusal unreachable.
    const oversized = ARCHIVE_WRITE_FIXED_RESERVATION + factor * (allowance / factor + 1);
    const outcome = await reserveArchiveWrites(db, Math.ceil(oversized), allowance, WINDOW_START);

    expect(outcome).toEqual({ reserved: false, reason: 'exceeds_allowance' });
    // A hard refusal must not charge the window — that is what lets the tick descend.
    const row = sqlite
      .prepare('SELECT reserved_writes FROM project_data_archive_write_budget')
      .get() as { reserved_writes: number } | undefined;
    expect(row).toBeUndefined();
  });
});
