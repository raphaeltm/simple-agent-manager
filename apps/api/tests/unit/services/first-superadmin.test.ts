import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import {
  establishFirstSuperadmin,
  FIRST_SUPERADMIN_SETTING,
} from '../../../src/services/first-superadmin';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

const databases: Database.Database[] = [];

function fixture() {
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  sqlite.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE platform_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT,
      updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
    );
    INSERT INTO users VALUES ('system_anonymous_trials', 'user', 'system', 1);`);
  const env = { DATABASE: createSqliteD1(sqlite) } as Env;
  const user = (id: string, role = 'user', status = 'pending', createdAt = 2) =>
    sqlite.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(id, role, status, createdAt);
  return { env, sqlite, user };
}

function electionOwner(sqlite: Database.Database): string | undefined {
  const row = sqlite
    .prepare('SELECT value FROM platform_settings WHERE key=?')
    .get(FIRST_SUPERADMIN_SETTING) as { value: string } | undefined;
  return row ? (JSON.parse(row.value).ownerId as string) : undefined;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('ordinary first-superadmin election', () => {
  it('promotes the first session user and permanently records its identity', async () => {
    const f = fixture();
    f.user('first-user');

    await establishFirstSuperadmin(f.env, 'first-user');

    expect(f.sqlite.prepare("SELECT role, status FROM users WHERE id='first-user'").get()).toEqual({
      role: 'superadmin',
      status: 'active',
    });
    expect(electionOwner(f.sqlite)).toBe('first-user');
  });

  it('elects exactly one winner across concurrent first sessions and leaves the loser pending', async () => {
    const f = fixture();
    f.user('oauth-user-a');
    f.user('oauth-user-b');

    await Promise.all([
      establishFirstSuperadmin(f.env, 'oauth-user-a'),
      establishFirstSuperadmin(f.env, 'oauth-user-b'),
    ]);

    const users = f.sqlite
      .prepare("SELECT id, role, status FROM users WHERE status != 'system' ORDER BY id")
      .all() as Array<{ id: string; role: string; status: string }>;
    expect(users.filter((user) => user.role === 'superadmin')).toHaveLength(1);
    expect(users.filter((user) => user.status === 'pending')).toHaveLength(1);
    expect(electionOwner(f.sqlite)).toBe(users.find((user) => user.role === 'superadmin')?.id);
  });

  it('does not reopen first-user administration after the elected user is deleted', async () => {
    const f = fixture();
    f.user('first-user');
    await establishFirstSuperadmin(f.env, 'first-user');
    f.sqlite.prepare("DELETE FROM users WHERE id='first-user'").run();
    f.user('later-user');

    await establishFirstSuperadmin(f.env, 'later-user');

    expect(f.sqlite.prepare("SELECT role, status FROM users WHERE id='later-user'").get()).toEqual({
      role: 'user',
      status: 'pending',
    });
    expect(electionOwner(f.sqlite)).toBe('first-user');
  });

  it('marks upgraded installations while leaving eligible single-operator installations open', async () => {
    const migration = readFileSync(
      new URL('../../../src/db/migrations/0242_first_superadmin_election.sql', import.meta.url),
      'utf8'
    );
    expect(migration).toContain(FIRST_SUPERADMIN_SETTING);
    const fresh = fixture();
    fresh.sqlite.exec(migration);
    expect(electionOwner(fresh.sqlite)).toBeUndefined();

    const upgraded = fixture();
    upgraded.user('existing-user', 'user', 'active', 3);
    upgraded.user('existing-admin', 'superadmin', 'active', 4);
    upgraded.sqlite.exec(migration);
    expect(electionOwner(upgraded.sqlite)).toBe('existing-admin');

    const racedUpgrade = fixture();
    racedUpgrade.user('first-admin', 'superadmin', 'active', 3);
    racedUpgrade.user('racing-admin', 'superadmin', 'active', 4);
    racedUpgrade.sqlite.exec(migration);
    expect(
      racedUpgrade.sqlite
        .prepare("SELECT id, role, status FROM users WHERE status != 'system' ORDER BY id")
        .all()
    ).toEqual([
      { id: 'first-admin', role: 'superadmin', status: 'active' },
      { id: 'racing-admin', role: 'user', status: 'pending' },
    ]);
    expect(electionOwner(racedUpgrade.sqlite)).toBe('first-admin');

    const orphanedSingleOperator = fixture();
    orphanedSingleOperator.user('sole-user', 'user', 'active', 3);
    orphanedSingleOperator.sqlite.exec(migration);
    expect(electionOwner(orphanedSingleOperator.sqlite)).toBeUndefined();

    const establishedWithoutAdmin = fixture();
    establishedWithoutAdmin.user('existing-user-a', 'user', 'active', 3);
    establishedWithoutAdmin.user('existing-user-b', 'user', 'pending', 4);
    establishedWithoutAdmin.sqlite.exec(migration);
    await establishFirstSuperadmin(establishedWithoutAdmin.env, 'existing-user-b');
    expect(
      establishedWithoutAdmin.sqlite
        .prepare("SELECT COUNT(*) AS count FROM users WHERE role='superadmin'")
        .get()
    ).toEqual({ count: 0 });
  });
});
