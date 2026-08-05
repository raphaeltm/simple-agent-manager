import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import migration0103 from '../../../src/db/migrations/0103_debug_diagnosis_runs.sql?raw';
import migration0104 from '../../../src/db/migrations/0104_durable_debug_diagnosis_runs.sql?raw';
import migration0105 from '../../../src/db/migrations/0105_debug_diagnosis_canonical_status.sql?raw';

describe('debug diagnosis canonical status migration', () => {
  it('applies after the shipped run migrations and persists canonical cancellation', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE debug_diagnoses (id TEXT PRIMARY KEY);
      INSERT INTO users (id) VALUES ('migration-user');
    `);
    db.exec(migration0103);
    db.exec(migration0104);
    db.exec(`
      INSERT INTO debug_diagnosis_runs
        (id,status,start_time,end_time,deadline_at,created_by)
      VALUES
        ('existing-running','running','2026-08-05T00:00:00.000Z','2026-08-05T01:00:00.000Z','2026-08-05T02:00:00.000Z','migration-user');
    `);

    db.exec(migration0105);
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

  it('preserves existing child rows and foreign-key integrity while backfilling status', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE debug_diagnoses (id TEXT PRIMARY KEY);
      INSERT INTO users (id) VALUES ('migration-user');
    `);
    db.exec(migration0103);
    db.exec(migration0104);
    db.exec(`
      INSERT INTO debug_diagnosis_runs
        (id,status,start_time,end_time,deadline_at,created_by)
      VALUES
        ('parent-run','running','2026-08-05T00:00:00.000Z','2026-08-05T01:00:00.000Z','2026-08-05T02:00:00.000Z','migration-user');
      INSERT INTO debug_diagnosis_run_events
        (id,run_id,sequence,step_key,event_type,status)
      VALUES
        ('child-event','parent-run',1,'started','lifecycle','running');
    `);

    db.exec(migration0105);

    expect(
      db.prepare('SELECT run_status FROM debug_diagnosis_runs WHERE id=?').get('parent-run')
    ).toEqual({ run_status: 'running' });
    expect(
      db
        .prepare('SELECT run_id,step_key FROM debug_diagnosis_run_events WHERE id=?')
        .get('child-event')
    ).toEqual({ run_id: 'parent-run', step_key: 'started' });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
