import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

let sqlite: Database.Database | null = null;

function openDb(): Database.Database {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY
    );

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL
    );

    CREATE TABLE agent_profiles (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE triggers (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      prompt_template TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return sqlite;
}

function migrationSql(): string {
  return readFileSync(
    join(process.cwd(), 'src/db/migrations/0147_profile_trigger_resource_requirements.sql'),
    'utf8'
  );
}

function columns(table: string): string[] {
  return (
    sqlite
      ?.prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => (row as { name: string }).name) ?? []
  );
}

function foreignKeyViolations(): unknown[] {
  return sqlite?.prepare('PRAGMA foreign_key_check').all() ?? [];
}

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

describe('0147_profile_trigger_resource_requirements migration', () => {
  it('adds nullable resource columns on a fresh pre-migration schema', () => {
    const db = openDb();

    db.exec(migrationSql());

    expect(columns('agent_profiles')).toContain('resource_requirements_json');
    expect(columns('triggers')).toContain('resource_requirements_json');
    expect(foreignKeyViolations()).toEqual([]);
  });

  it('preserves populated rows and existing foreign keys', () => {
    const db = openDb();
    db.exec(`
      INSERT INTO users (id) VALUES ('user-1');
      INSERT INTO projects (id, user_id, name) VALUES ('project-1', 'user-1', 'Project 1');
      INSERT INTO agent_profiles (id, project_id, user_id, name)
      VALUES ('profile-1', 'project-1', 'user-1', 'Implementer');
      INSERT INTO triggers (id, project_id, user_id, agent_profile_id, name, prompt_template)
      VALUES ('trigger-1', 'project-1', 'user-1', 'profile-1', 'Nightly', 'Run tests');
    `);

    db.exec(migrationSql());

    expect(
      db.prepare('SELECT COUNT(*) AS count FROM agent_profiles').get() as { count: number }
    ).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM triggers').get() as { count: number })
      .toEqual({ count: 1 });
    expect(
      db
        .prepare(
          `
          SELECT
            t.agent_profile_id AS agentProfileId,
            p.name AS profileName,
            t.resource_requirements_json AS triggerResourceRequirementsJson,
            p.resource_requirements_json AS profileResourceRequirementsJson
          FROM triggers t
          JOIN agent_profiles p ON p.id = t.agent_profile_id
          WHERE t.id = 'trigger-1'
        `
        )
        .get()
    ).toEqual({
      agentProfileId: 'profile-1',
      profileName: 'Implementer',
      triggerResourceRequirementsJson: null,
      profileResourceRequirementsJson: null,
    });
    expect(foreignKeyViolations()).toEqual([]);

    db.prepare('UPDATE agent_profiles SET resource_requirements_json = ? WHERE id = ?').run(
      '{"minVcpu":2}',
      'profile-1'
    );
    db.prepare('UPDATE triggers SET resource_requirements_json = ? WHERE id = ?').run(
      '{"minMemoryGb":4}',
      'trigger-1'
    );

    expect(
      db
        .prepare(
          `
          SELECT
            t.resource_requirements_json AS triggerResourceRequirementsJson,
            p.resource_requirements_json AS profileResourceRequirementsJson
          FROM triggers t
          JOIN agent_profiles p ON p.id = t.agent_profile_id
          WHERE t.id = 'trigger-1'
        `
        )
        .get()
    ).toEqual({
      triggerResourceRequirementsJson: '{"minMemoryGb":4}',
      profileResourceRequirementsJson: '{"minVcpu":2}',
    });
    expect(foreignKeyViolations()).toEqual([]);
  });
});
