import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = join(process.cwd(), 'src/db/migrations');
const orderedMigrations = readdirSync(migrationsDirectory)
  .filter((filename) => filename.endsWith('.sql'))
  .sort();

function applyMigrationsThrough(db: DatabaseSync, lastMigration: string): void {
  const lastIndex = orderedMigrations.indexOf(lastMigration);
  if (lastIndex < 0) throw new Error(`Migration ${lastMigration} is missing from the real chain`);
  for (const filename of orderedMigrations.slice(0, lastIndex + 1)) {
    db.exec(readFileSync(join(migrationsDirectory, filename), 'utf8'));
  }
}

describe('debug diagnosis canonical status migration', () => {
  it('upgrades the real migration chain, preserves children, and persists cancellation', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    applyMigrationsThrough(db, '0104_durable_debug_diagnosis_runs.sql');
    db.exec(`
      INSERT INTO users (id, github_id, email)
      VALUES ('migration-user','migration-github','migration@example.com');
      INSERT INTO debug_diagnosis_runs
        (id,status,start_time,end_time,deadline_at,created_by)
      VALUES
        ('parent-run','running','2026-08-05T00:00:00.000Z','2026-08-05T01:00:00.000Z','2026-08-05T02:00:00.000Z','migration-user');
      INSERT INTO debug_diagnosis_run_events
        (id,run_id,sequence,step_key,event_type,status)
      VALUES
        ('child-event','parent-run',1,'started','lifecycle','running');
    `);

    db.exec(
      readFileSync(join(migrationsDirectory, '0105_debug_diagnosis_canonical_status.sql'), 'utf8')
    );
    db.exec(readFileSync(join(migrationsDirectory, '0106_diagnostic_incidents.sql'), 'utf8'));
    db.exec(`
      UPDATE debug_diagnosis_runs
      SET status='failed',run_status='cancelled'
      WHERE id='parent-run';
    `);

    expect(
      db.prepare('SELECT status,run_status FROM debug_diagnosis_runs WHERE id=?').get('parent-run')
    ).toEqual({ status: 'failed', run_status: 'cancelled' });
    expect(
      db
        .prepare('SELECT run_id,step_key FROM debug_diagnosis_run_events WHERE id=?')
        .get('child-event')
    ).toEqual({ run_id: 'parent-run', step_key: 'started' });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='diagnostic_incidents'"
        )
        .get()
    ).toEqual({ name: 'diagnostic_incidents' });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
