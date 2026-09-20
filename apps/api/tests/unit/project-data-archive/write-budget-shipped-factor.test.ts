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
 * At factor 8 the daily allowance bought only 800000 / (1000 + 8 x 8000) = 12 migrations/day
 * while the hourly cadence allows 24, so half the ticks ran and reclaimed nothing. Confirmed
 * forward: at 12:15Z only 19,984 units remained, and the 13:00Z tick was refused.
 *
 * These cases read the value this repository actually ships rather than a number retyped into
 * the test, because a test that pins a hand-copied constant stays green when someone edits
 * `wrangler.toml` — the exact "the diff is not the deployed value" failure class in
 * `.claude/rules/70-flag-flips-must-verify-the-deployed-value.md`. BOTH vars these cases read —
 * `PROJECT_DATA_ARCHIVE_WRITE_ESTIMATE_FACTOR` and `PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET` —
 * were verified absent from the `production` and `staging` Environments on 2026-09-14, so for
 * both the checked-in value IS the deployed value. The assertions below depend on the allowance
 * as much as on the factor, so that second check is load-bearing, not incidental. If either ever
 * gains an Environment override, the deploy now annotates it as unexpected.
 *
 * The reservation runs against a real SQLite engine through `createSqliteD1`, not a stub,
 * because the thing under test is a conditional UPDATE predicate: a mock that ignores its
 * arguments would return "reserved" no matter what the arithmetic produced
 * (`.claude/rules/28-credential-resolution-fallback-tests.md`).
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ARCHIVE_WRITE_FIXED_RESERVATION,
  archiveWriteBudgetConfig,
  reserveArchiveWrites,
} from '../../../src/project-data-archive/write-budget';
import { shippedBudgetEnv } from '../../helpers/shipped-archive-budget';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

/**
 * Row inventory per migration the production sweep was reserving on 2026-09-14, derived from the
 * two budget samples above rather than from a single reading. An earlier draft of this test used
 * 7,442, which came from dividing the 11:29Z reservation total by 12 publishes when only 11 had
 * occurred — a 9% error that made the margin look better than it is.
 */
const MEASURED_UNITS_PER_MIGRATION = 8_000;
const WINDOW_START = Date.UTC(2026, 8, 14, 0, 0, 0);

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

  async function reserveUntilRefused(allowance: number, factor: number): Promise<number> {
    const estimate = ARCHIVE_WRITE_FIXED_RESERVATION + factor * MEASURED_UNITS_PER_MIGRATION;
    let admitted = 0;
    // Bounded well above any plausible ceiling so a runaway loop fails the test rather than
    // hanging the suite.
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const outcome = await reserveArchiveWrites(db, estimate, allowance, WINDOW_START);
      if (!outcome.reserved) return admitted;
      admitted += 1;
    }
    throw new Error('reservation never refused');
  }

  it('admits roughly twice the migrations per UTC window that factor 8 did', async () => {
    const { allowance, factor } = archiveWriteBudgetConfig(shippedBudgetEnv());

    const shipped = await reserveUntilRefused(allowance, factor);

    // Divergence case: the same allowance and the same measured session under the PREVIOUS
    // factor. This must fail against pre-change config, which is what makes the assertion
    // above mean something (`.claude/rules/74`).
    sqlite.exec('DELETE FROM project_data_archive_write_budget');
    const previous = await reserveUntilRefused(allowance, 8);

    expect(previous).toBe(12);
    // 24 is the real ceiling: the hourly cadence admits one ~26.6s migration per tick, so the
    // budget must clear that bar with room, not merely beat 12.
    expect(shipped).toBeGreaterThanOrEqual(24);
    expect(shipped).toBeGreaterThan(previous);
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
