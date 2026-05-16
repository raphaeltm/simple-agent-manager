import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

describe('github installation accounts migration', () => {
  const migrationSql = readFileSync(
    resolve(process.cwd(), 'src/db/migrations/0051_github_installation_accounts.sql'),
    'utf8'
  );

  it('creates canonical account state and backfills one row per external installation', () => {
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS github_installation_accounts');
    expect(migrationSql).toContain('installation_id TEXT PRIMARY KEY');
    expect(migrationSql).toContain('normalized_account_name TEXT NOT NULL');
    expect(migrationSql).toContain('uninstalled_at TEXT');
    expect(migrationSql).toContain('FROM github_installations');
    expect(migrationSql).toContain('GROUP BY installation_id');
    expect(migrationSql).toContain("WHERE installation_id <> '0'");
    expect(migrationSql).toContain('ON CONFLICT(installation_id) DO UPDATE SET');
    expect(migrationSql).toContain('uninstalled_at = NULL');
  });

  it('executes the backfill with dedupe, sentinel filtering, normalization, and tombstone reset', () => {
    const db = new Database(':memory:');
    try {
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

        CREATE TABLE github_installation_accounts (
          installation_id TEXT PRIMARY KEY,
          account_type TEXT NOT NULL,
          account_name TEXT NOT NULL,
          normalized_account_name TEXT NOT NULL,
          uninstalled_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);

      const insertInstallation = db.prepare(`
        INSERT INTO github_installations (
          id, user_id, installation_id, account_type, account_name, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      insertInstallation.run('row-1', 'user-1', '123', 'organization', 'Acme', '2026-01-01', '2026-01-03');
      insertInstallation.run('row-2', 'user-2', '123', 'organization', 'acme', '2026-01-02', '2026-01-04');
      insertInstallation.run('row-3', 'user-3', '456', 'personal', 'SoloUser', '2026-02-01', '2026-02-02');
      insertInstallation.run('row-4', 'user-4', '0', 'personal', 'sentinel', '2026-03-01', '2026-03-02');
      insertInstallation.run('row-5', 'user-5', '900', 'organization', 'ReinstalledOrg', '2026-04-01', '2026-04-02');

      db.prepare(`
        INSERT INTO github_installation_accounts (
          installation_id, account_type, account_name, normalized_account_name, uninstalled_at, created_at, updated_at
        ) VALUES ('900', 'organization', 'OldOrg', 'oldorg', '2026-03-01', '2026-03-01', '2026-03-01')
      `).run();

      db.exec(migrationSql);

      const rows = db
        .prepare(
          `SELECT installation_id, account_type, account_name, normalized_account_name, uninstalled_at, created_at, updated_at
           FROM github_installation_accounts
           ORDER BY installation_id`
        )
        .all();

      expect(rows).toEqual([
        {
          installation_id: '123',
          account_type: 'organization',
          account_name: 'acme',
          normalized_account_name: 'acme',
          uninstalled_at: null,
          created_at: '2026-01-01',
          updated_at: '2026-01-04',
        },
        {
          installation_id: '456',
          account_type: 'personal',
          account_name: 'SoloUser',
          normalized_account_name: 'solouser',
          uninstalled_at: null,
          created_at: '2026-02-01',
          updated_at: '2026-02-02',
        },
        {
          installation_id: '900',
          account_type: 'organization',
          account_name: 'ReinstalledOrg',
          normalized_account_name: 'reinstalledorg',
          uninstalled_at: null,
          created_at: '2026-03-01',
          updated_at: '2026-04-02',
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('uses an additive migration without destructive table operations', () => {
    expect(migrationSql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(migrationSql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migrationSql).not.toMatch(/\bALTER\s+TABLE\s+github_installations\b/i);
  });
});
