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

function seed(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO users (id, github_id, email) VALUES ('u1','gh1','u1@example.com');
    INSERT INTO github_installations (id, user_id, installation_id, account_type, account_name)
      VALUES ('inst','u1','123','user','u1');
    INSERT INTO projects (id, user_id, name, normalized_name, repository, installation_id, created_by)
      VALUES ('p1','u1','P','p','o/r','inst','u1');
    INSERT INTO agent_profiles (id, project_id, user_id, name) VALUES ('prof1','p1','u1','Opus');
    INSERT INTO cc_credentials (id, owner_id, name, kind, encrypted_token, iv)
      VALUES ('cred1','u1','Max','oauth-token','x','y');
    INSERT INTO cc_configurations (id, owner_id, name, consumer_kind, consumer_target, credential_id)
      VALUES ('cfg1','u1','Max','agent','claude-code','cred1');
    INSERT INTO cc_attachments (id, configuration_id, consumer_kind, consumer_target, user_id, project_id)
      VALUES ('att-project','cfg1','agent','claude-code','u1','p1');
    INSERT INTO cc_profile_attachments
      (id, configuration_id, user_id, agent_profile_id, consumer_kind, consumer_target)
      VALUES ('pin1','cfg1','u1','prof1','agent','claude-code');
  `);
}

describe('0215 cc_profile_attachments migration', () => {
  it('adds the table beside cc_attachments without touching existing pins', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    applyMigrationsThrough(db, '0215_cc_profile_attachments.sql');
    seed(db);

    expect(db.prepare('SELECT COUNT(*) AS n FROM cc_attachments').get()).toEqual({ n: 1 });
    expect(
      db.prepare('SELECT is_active, agent_profile_id FROM cc_profile_attachments').get()
    ).toEqual({ is_active: 1, agent_profile_id: 'prof1' });
  });

  it('keeps one pin per user, profile and agent', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    applyMigrationsThrough(db, '0215_cc_profile_attachments.sql');
    seed(db);

    expect(() =>
      db.exec(`INSERT INTO cc_profile_attachments
        (id, configuration_id, user_id, agent_profile_id, consumer_kind, consumer_target)
        VALUES ('pin2','cfg1','u1','prof1','agent','claude-code')`)
    ).toThrow(/UNIQUE/);
  });

  it.each([
    ['the profile', 'DELETE FROM agent_profiles WHERE id = ?', 'prof1'],
    ['the configuration', 'DELETE FROM cc_configurations WHERE id = ?', 'cfg1'],
    ['the project (cascading to its profiles)', 'DELETE FROM projects WHERE id = ?', 'p1'],
  ])('deleting %s removes the pin', (_label, statement, id) => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    applyMigrationsThrough(db, '0215_cc_profile_attachments.sql');
    seed(db);

    db.prepare(statement).run(id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM cc_profile_attachments').get()).toEqual({ n: 0 });
  });

  it('records every credential scope on agent_sessions while source keeps its CHECK', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    applyMigrationsThrough(db, '0215_cc_profile_attachments.sql');
    seed(db);
    db.exec(`
      INSERT INTO nodes (id, user_id, name, status) VALUES ('n1','u1','node','running');
      INSERT INTO workspaces (id, user_id, node_id, project_id, name, repository, vm_size, vm_location, status)
        VALUES ('w1','u1','n1','p1','ws','o/r','small','fsn1','running');
    `);
    for (const scope of ['profile', 'project', 'user', 'platform']) {
      db.prepare(
        `INSERT INTO agent_sessions (id, workspace_id, user_id, status, agent_credential_source, agent_credential_scope)
         VALUES (?, 'w1', 'u1', 'running', 'user', ?)`
      ).run(`s-${scope}`, scope);
    }
    expect(
      db.prepare('SELECT agent_credential_scope AS scope FROM agent_sessions ORDER BY id').all()
    ).toEqual([
      { scope: 'platform' },
      { scope: 'profile' },
      { scope: 'project' },
      { scope: 'user' },
    ]);
    // Why the tier lives in its own column: the 0158 CHECK rejects a new source value.
    expect(() =>
      db.exec(`INSERT INTO agent_sessions (id, workspace_id, user_id, status, agent_credential_source)
        VALUES ('s-bad','w1','u1','running','profile')`)
    ).toThrow(/CHECK/);
  });
});
