import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';

import { projectMembers } from '../../../src/db/schema';

const projectMembersMigrationUrl = new URL(
  '../../../src/db/migrations/0081_project_members.sql',
  import.meta.url
);

function createProjectFixtureDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;

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

    INSERT INTO users (id) VALUES ('user-1'), ('user-2');

    INSERT INTO projects
      (id, user_id, name, normalized_name, installation_id, repository, default_branch, created_by, created_at, updated_at)
    VALUES
      ('project-1', 'user-1', 'One', 'one', 'installation-1', 'org/one', 'main', 'user-1', '2026-06-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z'),
      ('project-2', 'user-2', 'Two', 'two', 'installation-2', 'org/two', 'main', 'user-2', '2026-06-03T00:00:00.000Z', '2026-06-04T00:00:00.000Z');
  `);
  return db;
}

describe('project_members migration', () => {
  it('creates owner memberships for existing projects and is idempotent', () => {
    const db = createProjectFixtureDb();
    const migration = readFileSync(projectMembersMigrationUrl, 'utf8');

    db.exec(migration);
    db.exec(migration);

    const rows = db
      .prepare(`
        SELECT project_id, user_id, role, status, invited_by, created_at, updated_at
        FROM project_members
        ORDER BY project_id
      `)
      .all();

    expect(rows).toEqual([
      {
        project_id: 'project-1',
        user_id: 'user-1',
        role: 'owner',
        status: 'active',
        invited_by: 'user-1',
        created_at: '2026-06-01T00:00:00.000Z',
        updated_at: '2026-06-02T00:00:00.000Z',
      },
      {
        project_id: 'project-2',
        user_id: 'user-2',
        role: 'owner',
        status: 'active',
        invited_by: 'user-2',
        created_at: '2026-06-03T00:00:00.000Z',
        updated_at: '2026-06-04T00:00:00.000Z',
      },
    ]);
  });

  it('defines schema indexes matching the migration', () => {
    const config = getTableConfig(projectMembers);
    expect(config.primaryKeys).toHaveLength(1);
    expect(config.indexes.map((idx) => idx.config.name).sort()).toEqual([
      'idx_project_members_project_status',
      'idx_project_members_user_status',
    ]);
  });
});
