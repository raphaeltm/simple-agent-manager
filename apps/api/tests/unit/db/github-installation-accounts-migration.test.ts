import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

describe('github_installation_accounts migration', () => {
  const readMigration = (filename: string) =>
    readFileSync(join(process.cwd(), 'src/db/migrations', filename), 'utf8');

  it('creates canonical rows deduped by external installation id', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE github_installations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        account_type TEXT NOT NULL,
        account_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO github_installations
        (id, user_id, installation_id, account_type, account_name, created_at, updated_at)
      VALUES
        ('old-link', 'user-1', '120081765', 'organization', 'effprop-old', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'),
        ('new-link', 'user-2', '120081765', 'organization', 'EffProp', '2026-05-02T00:00:00.000Z', '2026-05-03T00:00:00.000Z'),
        ('personal-link', 'user-3', '42', 'User', 'octocat', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'),
        ('system_anonymous_trials_installation', 'system_anonymous_trials', '0', 'User', 'anonymous-trials', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z');
    `);

    db.exec(readMigration('0052_github_installation_accounts.sql'));

    const rows = db
      .prepare(`
        SELECT installation_id, account_type, account_name, normalized_account_name, uninstalled_at
        FROM github_installation_accounts
        ORDER BY installation_id
      `)
      .all();

    expect(rows).toEqual([
      {
        installation_id: '120081765',
        account_type: 'organization',
        account_name: 'EffProp',
        normalized_account_name: 'effprop',
        uninstalled_at: null,
      },
      {
        installation_id: '42',
        account_type: 'personal',
        account_name: 'octocat',
        normalized_account_name: 'octocat',
        uninstalled_at: null,
      },
    ]);
  });

  it('repairs duplicate canonical rows by preferring organization metadata', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE github_installations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        account_type TEXT NOT NULL,
        account_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO github_installations
        (id, user_id, installation_id, account_type, account_name, created_at, updated_at)
      VALUES
        ('older-org-link', 'user-1', '120081765', 'organization', 'EffProp', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'),
        ('newer-personal-link', 'user-2', '120081765', 'User', 'effprop-personal', '2026-05-02T00:00:00.000Z', '2026-05-04T00:00:00.000Z');
    `);

    db.exec(readMigration('0052_github_installation_accounts.sql'));

    const beforeRepair = db
      .prepare(`
        SELECT account_type, account_name, normalized_account_name
        FROM github_installation_accounts
        WHERE installation_id = '120081765'
      `)
      .get();

    expect(beforeRepair).toEqual({
      account_type: 'personal',
      account_name: 'effprop-personal',
      normalized_account_name: 'effprop-personal',
    });

    db.exec(readMigration('0053_github_installation_accounts_org_preference.sql'));

    const afterRepair = db
      .prepare(`
        SELECT account_type, account_name, normalized_account_name, uninstalled_at
        FROM github_installation_accounts
        WHERE installation_id = '120081765'
      `)
      .get();

    expect(afterRepair).toEqual({
      account_type: 'organization',
      account_name: 'EffProp',
      normalized_account_name: 'effprop',
      uninstalled_at: null,
    });
  });
});
