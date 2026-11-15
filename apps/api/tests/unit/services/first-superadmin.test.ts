/**
 * The ordinary first-superadmin election and its migration, on a real SQLite engine.
 *
 * Every guard here is a SQL predicate, so each scenario runs the shipped statements against
 * tables built from the drizzle schema (`.claude/rules/28`): a `.where()`-ignoring mock could not
 * tell a guarded UPDATE from an unguarded one.
 */
import { SYSTEM_USER_ID } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  establishFirstSuperadmin,
  FIRST_SUPERADMIN_SETTING,
} from '../../../src/services/first-superadmin';
import { applySqliteMigration, createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const MIGRATION = new URL(
  '../../../src/db/migrations/0243_first_superadmin_election.sql',
  import.meta.url
);

const databases: Database.Database[] = [];

interface UserRow {
  id: string;
  role: string;
  status: string;
}

function fixture() {
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  createSchemaTables(sqlite, [schema.users, schema.platformSettings]);
  const insert = sqlite.prepare(
    `INSERT INTO users (id, email, email_verified, role, status, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, ?)`
  );
  insert.run(SYSTEM_USER_ID, 'system@example.com', 'user', 'system', 1, 1);
  const env = { DATABASE: createSqliteD1(sqlite) } as Env;
  const user = (id: string, role = 'user', status = 'pending', createdAt = 2) =>
    insert.run(id, `${id}@example.com`, role, status, createdAt, createdAt);
  const get = (id: string) =>
    sqlite.prepare('SELECT id, role, status FROM users WHERE id = ?').get(id) as UserRow;
  const superadmins = () =>
    (
      sqlite
        .prepare("SELECT id FROM users WHERE role = 'superadmin' AND status != 'system'")
        .all() as Array<{ id: string }>
    ).map((row) => row.id);
  const electionOwner = () => {
    const row = sqlite
      .prepare('SELECT value FROM platform_settings WHERE key = ?')
      .get(FIRST_SUPERADMIN_SETTING) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as { ownerId: string }).ownerId : undefined;
  };
  const allUsers = () => sqlite.prepare('SELECT * FROM users ORDER BY id').all();
  return { env, sqlite, user, get, superadmins, electionOwner, allUsers };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

describe('establishFirstSuperadmin — the election', () => {
  it('promotes the first real user and records it as the election winner', async () => {
    const f = fixture();
    f.user('first-user');

    await establishFirstSuperadmin(f.env, 'first-user');

    expect(f.get('first-user')).toMatchObject({ role: 'superadmin', status: 'active' });
    expect(f.electionOwner()).toBe('first-user');
    expect(f.get(SYSTEM_USER_ID)).toMatchObject({ role: 'user', status: 'system' });
  });

  it('is idempotent: a second sign-in of the winner changes nothing', async () => {
    const f = fixture();
    f.user('first-user');
    await establishFirstSuperadmin(f.env, 'first-user');
    const before = f.allUsers();

    await establishFirstSuperadmin(f.env, 'first-user');

    expect(f.allUsers()).toEqual(before);
    expect(f.electionOwner()).toBe('first-user');
  });

  describe('a later sign-up never wins against an existing account', () => {
    it('(a) does not promote a new sign-up while the sole existing user is suspended', async () => {
      const f = fixture();
      f.user('suspended-owner', 'user', 'suspended', 2);
      f.user('stranger', 'user', 'pending', 3);

      await establishFirstSuperadmin(f.env, 'stranger');

      expect(f.superadmins()).toEqual([]);
      expect(f.get('stranger')).toMatchObject({ role: 'user', status: 'pending' });
      expect(f.electionOwner()).toBeUndefined();
    });

    it('(a) control: the same sign-up is promoted when no other account exists', async () => {
      const f = fixture();
      f.user('stranger', 'user', 'pending', 3);

      await establishFirstSuperadmin(f.env, 'stranger');

      expect(f.superadmins()).toEqual(['stranger']);
    });

    it('(b) does not promote a new sign-up while the sole existing user is a non-admin', async () => {
      const f = fixture();
      f.user('existing-user', 'user', 'active', 2);
      f.user('stranger', 'user', 'pending', 3);

      await establishFirstSuperadmin(f.env, 'stranger');

      expect(f.superadmins()).toEqual([]);
      expect(f.get('stranger')).toMatchObject({ role: 'user', status: 'pending' });
      expect(f.electionOwner()).toBeUndefined();
    });

    it('(b) control: the sole existing user is still elected on their own sign-in', async () => {
      const f = fixture();
      f.user('existing-user', 'user', 'active', 2);

      await establishFirstSuperadmin(f.env, 'existing-user');

      expect(f.superadmins()).toEqual(['existing-user']);
      expect(f.electionOwner()).toBe('existing-user');
    });
  });

  describe('concurrent first sign-ups', () => {
    it('never produce two superadmins when both accounts exist before either election', async () => {
      const f = fixture();
      f.user('oauth-user-a', 'user', 'pending', 2);
      f.user('oauth-user-b', 'user', 'pending', 2);

      await Promise.all([
        establishFirstSuperadmin(f.env, 'oauth-user-a'),
        establishFirstSuperadmin(f.env, 'oauth-user-b'),
      ]);

      // Neither is the only real user, so both stay unprivileged (fail closed). Recovery:
      // BOOTSTRAP_OWNER_EMAIL, documented in the self-hosting guide.
      expect(f.superadmins()).toEqual([]);
      expect(f.electionOwner()).toBeUndefined();
      expect(f.get('oauth-user-a')).toMatchObject({ role: 'user', status: 'pending' });
      expect(f.get('oauth-user-b')).toMatchObject({ role: 'user', status: 'pending' });
    });

    it('elect exactly one when the first election lands before the second account exists', async () => {
      const f = fixture();
      f.user('oauth-user-a', 'user', 'pending', 2);
      await establishFirstSuperadmin(f.env, 'oauth-user-a');
      f.user('oauth-user-b', 'user', 'pending', 3);

      await establishFirstSuperadmin(f.env, 'oauth-user-b');

      expect(f.superadmins()).toEqual(['oauth-user-a']);
      expect(f.get('oauth-user-b')).toMatchObject({ role: 'user', status: 'pending' });
      expect(f.electionOwner()).toBe('oauth-user-a');
    });
  });

  it('does not reopen the election after the elected user is deleted', async () => {
    const f = fixture();
    f.user('first-user');
    await establishFirstSuperadmin(f.env, 'first-user');
    f.sqlite.prepare("DELETE FROM users WHERE id = 'first-user'").run();
    f.user('later-user');

    await establishFirstSuperadmin(f.env, 'later-user');

    expect(f.get('later-user')).toMatchObject({ role: 'user', status: 'pending' });
    expect(f.electionOwner()).toBe('first-user');
  });

  it('keeps the election closed even when the initial read was stale', async () => {
    // The marker can commit between the cheap initial read and the write batch. Feed the read a
    // stale "not established" answer so only the guard inside the UPDATE stands in the way.
    const f = fixture();
    f.sqlite
      .prepare(
        `INSERT INTO platform_settings (key, value, updated_at, updated_by)
         VALUES (?, json_object('version', 1, 'ownerId', 'deleted-owner'), CURRENT_TIMESTAMP, NULL)`
      )
      .run(FIRST_SUPERADMIN_SETTING);
    f.user('sole-survivor', 'user', 'active', 3);
    const real = f.env.DATABASE;
    const staleRead = {
      ...real,
      prepare: (sql: string) => {
        const statement = real.prepare(sql);
        if (!sql.includes('AS established')) return statement;
        return {
          ...statement,
          bind: () => ({ first: async () => ({ established: 0, superadmins: 0 }) }),
        };
      },
      batch: real.batch.bind(real),
    } as unknown as D1Database;

    await establishFirstSuperadmin({ DATABASE: staleRead }, 'sole-survivor');

    expect(f.get('sole-survivor')).toMatchObject({ role: 'user', status: 'active' });
    expect(f.electionOwner()).toBe('deleted-owner');
  });

  it('never promotes a suspended sole user', async () => {
    const f = fixture();
    f.user('suspended-user', 'user', 'suspended', 2);

    await establishFirstSuperadmin(f.env, 'suspended-user');

    expect(f.get('suspended-user')).toMatchObject({ role: 'user', status: 'suspended' });
    expect(f.electionOwner()).toBeUndefined();
  });

  it('never promotes the system user, even on a sentinel-only install', async () => {
    const f = fixture();

    await establishFirstSuperadmin(f.env, SYSTEM_USER_ID);

    expect(f.get(SYSTEM_USER_ID)).toMatchObject({ role: 'user', status: 'system' });
    expect(f.electionOwner()).toBeUndefined();
  });

  it('records an existing superadmin as the winner instead of promoting anyone', async () => {
    const f = fixture();
    f.user('existing-admin', 'superadmin', 'active', 2);

    await establishFirstSuperadmin(f.env, 'existing-admin');

    expect(f.superadmins()).toEqual(['existing-admin']);
    expect(f.electionOwner()).toBe('existing-admin');
  });

  it('reports more than one superadmin for review without changing any user', async () => {
    const f = fixture();
    f.user('first-admin', 'superadmin', 'active', 2);
    f.user('racing-admin', 'superadmin', 'active', 3);
    applySqliteMigration(f.sqlite, MIGRATION);
    const before = f.allUsers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await establishFirstSuperadmin(f.env, 'racing-admin');

    expect(f.allUsers()).toEqual(before);
    const warning = warn.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .find((entry) => entry.event === 'first-superadmin.multiple_superadmins');
    expect(warning).toMatchObject({ level: 'warn', superadminCount: 2 });
  });

  it('does not report a single superadmin', async () => {
    const f = fixture();
    f.user('only-admin', 'superadmin', 'active', 2);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await establishFirstSuperadmin(f.env, 'only-admin');

    expect(warn).not.toHaveBeenCalled();
    expect(f.electionOwner()).toBe('only-admin');
  });
});

describe('migration 0243 — marks installs that already have a superadmin', () => {
  it('keeps two existing superadmins untouched and records the oldest as the winner', () => {
    const f = fixture();
    f.user('first-admin', 'superadmin', 'active', 3);
    f.user('racing-admin', 'superadmin', 'active', 4);
    f.user('member', 'user', 'active', 5);
    const before = f.allUsers();

    applySqliteMigration(f.sqlite, MIGRATION);

    expect(f.allUsers()).toEqual(before);
    expect(f.superadmins().sort()).toEqual(['first-admin', 'racing-admin']);
    expect(f.electionOwner()).toBe('first-admin');
  });

  it('writes no marker without a superadmin, so the sole user can still win at sign-in', async () => {
    const f = fixture();
    f.user('sole-user', 'user', 'active', 3);

    applySqliteMigration(f.sqlite, MIGRATION);
    expect(f.electionOwner()).toBeUndefined();

    await establishFirstSuperadmin(f.env, 'sole-user');
    expect(f.superadmins()).toEqual(['sole-user']);
  });

  it('writes no marker on a fresh install, so the first sign-up wins the election', async () => {
    const f = fixture();

    applySqliteMigration(f.sqlite, MIGRATION);
    expect(f.electionOwner()).toBeUndefined();

    f.user('first-user', 'user', 'pending', 3);
    await establishFirstSuperadmin(f.env, 'first-user');
    expect(f.superadmins()).toEqual(['first-user']);
  });

  it('promotes nobody on an install with several users and no superadmin', async () => {
    const f = fixture();
    f.user('existing-user-a', 'user', 'active', 3);
    f.user('existing-user-b', 'user', 'pending', 4);
    const before = f.allUsers();

    applySqliteMigration(f.sqlite, MIGRATION);
    await establishFirstSuperadmin(f.env, 'existing-user-a');
    await establishFirstSuperadmin(f.env, 'existing-user-b');

    expect(f.electionOwner()).toBeUndefined();
    expect(f.allUsers()).toEqual(before);
  });

  it('never marks an install whose only superadmin-role row is the system user', () => {
    const f = fixture();
    f.sqlite.prepare("UPDATE users SET role = 'superadmin' WHERE id = ?").run(SYSTEM_USER_ID);

    applySqliteMigration(f.sqlite, MIGRATION);

    expect(f.electionOwner()).toBeUndefined();
  });
});
