import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

describe('github_installation_accounts migration', () => {
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

    const migration = readFileSync(
      join(process.cwd(), 'src/db/migrations/0052_github_installation_accounts.sql'),
      'utf8'
    );
    db.exec(migration);

    const rows = db
      .prepare(`
        SELECT installation_id, account_type, account_name, account_name_normalized, uninstalled_at
        FROM github_installation_accounts
        ORDER BY installation_id
      `)
      .all();

    expect(rows).toEqual([
      {
        installation_id: '120081765',
        account_type: 'organization',
        account_name: 'EffProp',
        account_name_normalized: 'effprop',
        uninstalled_at: null,
      },
      {
        installation_id: '42',
        account_type: 'personal',
        account_name: 'octocat',
        account_name_normalized: 'octocat',
        uninstalled_at: null,
      },
    ]);
  });
});
