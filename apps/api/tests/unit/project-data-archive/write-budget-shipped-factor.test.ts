/**
 * The shipped `PROJECT_DATA_ARCHIVE_WRITE_ESTIMATE_FACTOR` must buy the throughput it was
 * lowered to buy.
 *
 * Measured in production on 2026-09-14 (Cloudflare `durableObjectsPeriodicGroups`, 5-minute
 * buckets isolating four archive ticks in DO namespace fb36fe21): a published migration bills
 * ~6,000-9,500 `rowsWritten` against an `estimateArchiveWrites` inventory of ~7,442 units, so
 * the true multiplier between units and billed rows is ~1.0 and `factor` is pure safety margin.
 * At factor 8 the daily allowance bought only 800000 / (1000 + 8 x 7442) = 13 migrations/day
 * while the hourly cadence allows 24, so ~11 ticks/day ran and reclaimed nothing.
 *
 * These cases read the value this repository actually ships rather than a number retyped into
 * the test, because a test that pins a hand-copied constant stays green when someone edits
 * `wrangler.toml` — the exact "the diff is not the deployed value" failure class in
 * `.claude/rules/70-flag-flips-must-verify-the-deployed-value.md`. The env-var name is also not
 * present in either GitHub Environment (verified 2026-09-14), so for this var the checked-in
 * value IS the deployed value; if that ever changes, the deploy now annotates the override.
 *
 * The reservation runs against a real SQLite engine through `createSqliteD1`, not a stub,
 * because the thing under test is a conditional UPDATE predicate: a mock that ignores its
 * arguments would return "reserved" no matter what the arithmetic produced
 * (`.claude/rules/28-credential-resolution-fallback-tests.md`).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ARCHIVE_WRITE_FIXED_RESERVATION,
  archiveWriteBudgetConfig,
  reserveArchiveWrites,
} from '../../../src/project-data-archive/write-budget';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

/** Row inventory of the largest candidate the production sweep was selecting on 2026-09-14. */
const MEASURED_UNITS_PER_MIGRATION = 7_442;
const WINDOW_START = Date.UTC(2026, 8, 14, 0, 0, 0);

function readShippedVar(name: string): string {
  const toml = readFileSync(
    resolve(import.meta.dirname, '../../../wrangler.toml'),
    'utf-8'
  );
  const match = new RegExp(`^${name}\\s*=\\s*"(.*)"\\s*$`, 'm').exec(toml);
  if (!match) throw new Error(`${name} is not set in apps/api/wrangler.toml`);
  return match[1]!;
}

/** The env shape `archiveWriteBudgetConfig` reads, populated from the shipped config. */
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

    expect(previous).toBe(13);
    expect(shipped).toBeGreaterThanOrEqual(24);
    expect(shipped).toBeGreaterThan(previous);
  });

  it('keeps a safety margin over the measured billed-rows ratio', async () => {
    const { factor } = archiveWriteBudgetConfig(shippedBudgetEnv());

    // The measurement says billed rows per estimate unit is ~1.0. A factor below that would
    // let the budget under-charge real work; a factor far above it is what wasted 11 ticks a
    // day. Bracket both directions so neither drifts back unnoticed without a fresh
    // measurement and a deliberate edit to this test.
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
