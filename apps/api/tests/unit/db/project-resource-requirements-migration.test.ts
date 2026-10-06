import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

const migrationSql = readFileSync(
  join(process.cwd(), 'src/db/migrations/0149_project_resource_requirements.sql'),
  'utf8'
);

let sqlite: Database.Database | null = null;

function createProjectFixture(populated = false): Database.Database {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY
    );

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      repository TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  if (populated) {
    sqlite.exec(`
      INSERT INTO users (id) VALUES ('user-1');
      INSERT INTO projects
        (id, user_id, name, normalized_name, installation_id, repository, default_branch, created_by, created_at, updated_at)
      VALUES
        ('project-1', 'user-1', 'One', 'one', 'installation-1', 'org/one', 'main', 'user-1', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z');
      INSERT INTO tasks
        (id, project_id, user_id, title, status, created_by, created_at, updated_at)
      VALUES
        ('task-1', 'project-1', 'user-1', 'Task', 'queued', 'user-1', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z');
    `);
  }

  return sqlite;
}

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

describe('0149_project_resource_requirements migration', () => {
  it('adds the column to a fresh projects table', () => {
    const db = createProjectFixture(false);

    db.exec(migrationSql);

    const columns = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('resource_requirements_json');
    db.prepare(`INSERT INTO users (id) VALUES ('fresh-user')`).run();
    db.prepare(
      `INSERT INTO projects
           (id, user_id, name, normalized_name, installation_id, repository, default_branch, created_by, created_at, updated_at, resource_requirements_json)
         VALUES
           ('fresh-project', 'fresh-user', 'Fresh', 'fresh', 'installation-fresh', 'org/fresh', 'main', 'fresh-user', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z', ?)`
    ).run(JSON.stringify({ minVcpu: 2 }));
    expect(
      db.prepare(`SELECT resource_requirements_json FROM projects WHERE id = 'fresh-project'`).get()
    ).toEqual({ resource_requirements_json: JSON.stringify({ minVcpu: 2 }) });
  });

  it('preserves populated project rows and existing foreign keys', () => {
    const db = createProjectFixture(true);

    db.exec(migrationSql);

    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(
      db
        .prepare(
          `SELECT id, resource_requirements_json
           FROM projects
           WHERE id = 'project-1'`
        )
        .get()
    ).toEqual({ id: 'project-1', resource_requirements_json: null });
    expect(db.prepare(`SELECT project_id FROM tasks WHERE id = 'task-1'`).get()).toEqual({
      project_id: 'project-1',
    });
  });
});
