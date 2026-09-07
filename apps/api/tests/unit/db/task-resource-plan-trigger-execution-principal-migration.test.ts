import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

const migrationSql = readFileSync(
  join(
    process.cwd(),
    'src/db/migrations/0151_task_resource_plan_and_trigger_execution_principal.sql'
  ),
  'utf8'
);

let sqlite: Database.Database | null = null;

function createFixture(populated = false): Database.Database {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY
    );

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL
    );

    CREATE TABLE triggers (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL
    );
  `);

  if (populated) {
    sqlite.exec(`
      INSERT INTO users (id) VALUES ('owner-1'), ('executor-1');
      INSERT INTO projects (id, user_id) VALUES ('project-1', 'owner-1');
      INSERT INTO tasks (id, project_id, user_id, title)
        VALUES ('task-1', 'project-1', 'owner-1', 'Task');
      INSERT INTO triggers (id, project_id, user_id, name)
        VALUES ('trigger-1', 'project-1', 'owner-1', 'Trigger');
    `);
  }

  return sqlite;
}

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

describe('0151 task resource plan and trigger execution principal migration', () => {
  it('adds nullable columns and index to clean existing tables', () => {
    const db = createFixture(false);

    db.exec(migrationSql);

    const taskColumns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
    const triggerColumns = db.prepare('PRAGMA table_info(triggers)').all() as Array<{
      name: string;
    }>;
    expect(taskColumns.map((column) => column.name)).toContain('resource_requirement_plan_json');
    expect(triggerColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'execution_user_id',
        'execution_user_authorized_at',
        'execution_user_authorized_by',
      ])
    );
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE name = 'idx_triggers_execution_user_id'")
        .get()
    ).toEqual({ name: 'idx_triggers_execution_user_id' });
  });

  it('preserves existing rows and enforces new trigger principal foreign keys', () => {
    const db = createFixture(true);

    db.exec(migrationSql);

    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(
      db
        .prepare(
          `SELECT id, resource_requirement_plan_json
           FROM tasks
           WHERE id = 'task-1'`
        )
        .get()
    ).toEqual({ id: 'task-1', resource_requirement_plan_json: null });
    expect(
      db
        .prepare(
          `SELECT id, execution_user_id, execution_user_authorized_by
           FROM triggers
           WHERE id = 'trigger-1'`
        )
        .get()
    ).toEqual({
      id: 'trigger-1',
      execution_user_id: null,
      execution_user_authorized_by: null,
    });

    db.prepare(
      `UPDATE triggers
       SET execution_user_id = 'executor-1',
           execution_user_authorized_by = 'owner-1',
           execution_user_authorized_at = '2026-09-07T00:00:00.000Z'
       WHERE id = 'trigger-1'`
    ).run();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    expect(() =>
      db
        .prepare("UPDATE triggers SET execution_user_id = 'missing-user' WHERE id = 'trigger-1'")
        .run()
    ).toThrow(/FOREIGN KEY/);
  });
});
