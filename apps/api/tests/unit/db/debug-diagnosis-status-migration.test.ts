import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

function migration(name: string): string {
  return readFileSync(join(process.cwd(), 'src/db/migrations', name), 'utf8');
}

describe('debug diagnosis canonical status migration', () => {
  it('applies after the shipped run migrations and persists canonical cancellation', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE debug_diagnoses (id TEXT PRIMARY KEY);
      INSERT INTO users (id) VALUES ('migration-user');
    `);
    db.exec(migration('0103_debug_diagnosis_runs.sql'));
    db.exec(migration('0104_durable_debug_diagnosis_runs.sql'));
    db.exec(`
      INSERT INTO debug_diagnosis_runs
        (id,status,start_time,end_time,deadline_at,created_by)
      VALUES
        ('existing-running','running','2026-08-05T00:00:00.000Z','2026-08-05T01:00:00.000Z','2026-08-05T02:00:00.000Z','migration-user');
    `);

    db.exec(migration('0105_debug_diagnosis_canonical_status.sql'));
    db.exec(`
      UPDATE debug_diagnosis_runs
      SET status='failed',run_status='cancelled'
      WHERE id='existing-running';
    `);

    expect(
      db
        .prepare('SELECT status,run_status FROM debug_diagnosis_runs WHERE id=?')
        .get('existing-running')
    ).toEqual({ status: 'failed', run_status: 'cancelled' });
  });

  it('is additive and never recreates the FK-parent run table', () => {
    const sql = migration('0105_debug_diagnosis_canonical_status.sql').toUpperCase();
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('RENAME TO');
    expect(sql).toContain('ADD COLUMN RUN_STATUS');
  });
});
