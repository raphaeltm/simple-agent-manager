/**
 * `.claude/rules/31`: the stall counter is added with `ALTER TABLE ADD COLUMN`, never a table
 * recreation, and existing cadence rows must survive the change with a usable starting value.
 *
 * The production row has run 226 times and carries a lease history; losing it would reset the
 * sweep's cadence gate and let the next deploy run an unscheduled sweep.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = join(process.cwd(), 'src/db/migrations');
const orderedMigrations = readdirSync(migrationsDirectory)
  .filter((filename) => filename.endsWith('.sql'))
  .sort();
const MIGRATION = '0156_archive_sweep_consecutive_budget_stalls.sql';

function applyMigrationsBefore(db: DatabaseSync, migration: string): void {
  const index = orderedMigrations.indexOf(migration);
  if (index < 0) throw new Error(`Migration ${migration} is missing from the real chain`);
  for (const filename of orderedMigrations.slice(0, index)) {
    db.exec(readFileSync(join(migrationsDirectory, filename), 'utf8'));
  }
}

describe('archive sweep consecutive_budget_stalls migration', () => {
  it('adds the counter to the existing row without disturbing its cadence state', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    applyMigrationsBefore(db, MIGRATION);

    // The production row as it stood on 2026-09-12: succeeded, no error, 226 runs — the
    // state that looked healthy for four days while nothing was being reclaimed.
    db.exec(`
      INSERT INTO project_data_archive_global_sweep_cadence
        (sweep_name, last_started_at, last_completed_at, next_eligible_at, last_status,
         last_skip_reason, last_error, lease_owner, lease_expires_at, run_count, updated_at)
      VALUES
        ('archive_sharding_global_sweep', 1789107423000, 1789107425000, 1789111023000,
         'succeeded', NULL, NULL, NULL, NULL, 226, 1789107425000);
    `);

    db.exec(readFileSync(join(migrationsDirectory, MIGRATION), 'utf8'));

    expect(
      db
        .prepare(
          `SELECT sweep_name, last_status, run_count, next_eligible_at, consecutive_budget_stalls
           FROM project_data_archive_global_sweep_cadence`
        )
        .all()
    ).toEqual([
      {
        sweep_name: 'archive_sharding_global_sweep',
        last_status: 'succeeded',
        run_count: 226,
        next_eligible_at: 1789111023000,
        // 0 is the correct start: the counter measures consecutive stalls observed under the
        // new logic, which cannot be reconstructed from history.
        consecutive_budget_stalls: 0,
      },
    ]);
  });

  it('is an additive column change, so the table is never dropped', () => {
    // `.claude/rules/31` bans DROP TABLE on this path outright. Asserting on the migration
    // text keeps a future "just recreate it to add a CHECK" edit from slipping through.
    const sql = readFileSync(join(migrationsDirectory, MIGRATION), 'utf8');
    expect(sql).toMatch(/ALTER TABLE project_data_archive_global_sweep_cadence\s+ADD COLUMN/);
    expect(sql.toUpperCase()).not.toContain('DROP TABLE');
    expect(sql.toUpperCase()).not.toContain('DELETE FROM');
  });
});
