/** Real migration chain: archive 0237 remains applied when recovery scan 0238 is installed. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const directory = join(process.cwd(), 'src/db/migrations');
const archiveMigration = '0237_archive_reclaim_pending.sql';
const recoveryMigration = '0238_provider_limit_recovery_scan_index.sql';
const migrations = readdirSync(directory)
  .filter((file) => file.endsWith('.sql'))
  .sort();

function applyThrough(db: Database.Database, filename: string) {
  const index = migrations.indexOf(filename);
  if (index < 0) throw new Error(`Migration ${filename} is missing from the real chain`);
  for (const migration of migrations.slice(0, index + 1))
    db.exec(readFileSync(join(directory, migration), 'utf8'));
}

function definition(db: Database.Database, name: string) {
  return db.prepare('SELECT type,sql FROM sqlite_master WHERE name=?').get(name);
}

function expectArchiveAndRecoverySchema(db: Database.Database) {
  expect(db.prepare('PRAGMA table_info(project_data_archive_migrations)').all()).toContainEqual(
    expect.objectContaining({
      name: 'reclaim_pending',
      type: 'INTEGER',
      notnull: 1,
      dflt_value: '1',
    })
  );
  expect(definition(db, 'idx_archive_migrations_reclaim_pending')).toMatchObject({
    type: 'index',
    sql: expect.stringMatching(/WHERE reclaim_pending = 1/),
  });
  expect(db.prepare('PRAGMA index_info(idx_tasks_recovery_scan_updated_id)').all()).toEqual([
    expect.objectContaining({ seqno: 0, name: 'updated_at' }),
    expect.objectContaining({ seqno: 1, name: 'id' }),
  ]);
  expect(definition(db, 'idx_tasks_active_updated_id')).toMatchObject({ type: 'index' });
}

describe('provider recovery scan migration after applied archive reclaim migration', () => {
  it('supports a clean installation with both archive schema and the additive recovery scan index', () => {
    const db = new Database(':memory:');
    try {
      applyThrough(db, recoveryMigration);
      expectArchiveAndRecoverySchema(db);
    } finally {
      db.close();
    }
  });

  it('upgrades applied 0237 without altering archive rows or its schema, and indexes exactly the wakeable cohort', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      applyThrough(db, archiveMigration);
      db.exec(`INSERT INTO users(id,email,github_id) VALUES ('owner','owner@example.test','github-owner');
        INSERT INTO github_installations(id,user_id,installation_id,account_type,account_name)
          VALUES ('installation','owner','installation','User','owner');
        INSERT INTO projects(id,user_id,name,normalized_name,installation_id,repository,created_by)
          VALUES ('project','owner','Project','project','installation','owner/repo','owner');
        INSERT INTO project_data_archive_migrations
          (migration_id,project_id,session_id,state,source_owner_name,target_owner_name,target_generation,created_at,updated_at,reclaim_pending)
          VALUES ('reclaimed','project','session-reclaimed','published','root','archive',1,1,2,0);
        INSERT INTO project_data_archive_migrations
          (migration_id,project_id,session_id,state,source_owner_name,target_owner_name,target_generation,created_at,updated_at)
          VALUES ('pending','project','session-pending','published','root','archive',1,1,2);`);
      const archiveTable = definition(db, 'project_data_archive_migrations');
      const archiveIndex = definition(db, 'idx_archive_migrations_reclaim_pending');
      const activeTaskIndex = definition(db, 'idx_tasks_active_updated_id');
      const archiveRows = db
        .prepare('SELECT * FROM project_data_archive_migrations ORDER BY migration_id')
        .all();
      expect(archiveRows).toEqual([
        expect.objectContaining({ migration_id: 'pending', reclaim_pending: 1 }),
        expect.objectContaining({ migration_id: 'reclaimed', reclaim_pending: 0 }),
      ]);
      expect(definition(db, 'idx_tasks_recovery_scan_updated_id')).toBeUndefined();
      db.exec(readFileSync(join(directory, recoveryMigration), 'utf8'));
      expectArchiveAndRecoverySchema(db);
      expect(definition(db, 'project_data_archive_migrations')).toEqual(archiveTable);
      expect(definition(db, 'idx_archive_migrations_reclaim_pending')).toEqual(archiveIndex);
      expect(definition(db, 'idx_tasks_active_updated_id')).toEqual(activeTaskIndex);
      expect(
        db.prepare('SELECT * FROM project_data_archive_migrations ORDER BY migration_id').all()
      ).toEqual(archiveRows);

      const insertTask =
        db.prepare(`INSERT INTO tasks(id,project_id,user_id,title,status,created_by,admission_state,updated_at)
        VALUES (?,'project','owner','Retained task',?,'owner',?,'2026-11-13T00:00:00Z')`);
      for (const [id, status, admission] of [
        ['active-queued', 'queued', null],
        ['active-delegated', 'delegated', null],
        ['active-progress', 'in_progress', null],
        ['sleeping-pending', 'sleeping', 'provider_limit_recovery_pending'],
        ['sleeping-waiting', 'sleeping', 'provider_limit_waiting'],
        ['sleeping-idle', 'sleeping', null],
        ['completed-pending', 'completed', 'provider_limit_recovery_pending'],
      ])
        insertTask.run(id, status, admission);
      const query = `SELECT id FROM tasks INDEXED BY idx_tasks_recovery_scan_updated_id
        WHERE status IN ('queued','delegated','in_progress')
          OR (status='sleeping' AND admission_state='provider_limit_recovery_pending')
        ORDER BY updated_at,id`;
      expect(db.prepare(query).all()).toEqual([
        { id: 'active-delegated' },
        { id: 'active-progress' },
        { id: 'active-queued' },
        { id: 'sleeping-pending' },
      ]);
      expect(db.prepare(`EXPLAIN QUERY PLAN ${query}`).all()).toContainEqual(
        expect.objectContaining({
          detail: expect.stringContaining('idx_tasks_recovery_scan_updated_id'),
        })
      );
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });
});
