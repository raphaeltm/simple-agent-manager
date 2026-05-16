import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

  it('uses an additive migration without destructive table operations', () => {
    expect(migrationSql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(migrationSql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migrationSql).not.toMatch(/\bALTER\s+TABLE\s+github_installations\b/i);
  });
});
