import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { upsertCanonicalInstallationAccount } from '../../../src/services/github-installation-accounts';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

describe('canonical GitHub installation no-op writes against real SQLite', () => {
  it('skips unchanged accounts and repairs changed names or stale normalized names', async () => {
    const sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.githubInstallationAccounts]);
    const db = drizzle(createSqliteD1(sqlite), { schema });
    const account = {
      installationId: '123',
      accountType: 'organization' as const,
      accountName: 'ExampleOrg',
    };
    const before = '2026-10-29T00:00:00.000Z';
    const after = '2026-10-30T00:00:00.000Z';
    try {
      await upsertCanonicalInstallationAccount(db, account, before);
      await upsertCanonicalInstallationAccount(db, account, after);
      expect(sqlite.prepare('SELECT updated_at FROM github_installation_accounts').get()).toEqual({
        updated_at: before,
      });
      sqlite.exec("UPDATE github_installation_accounts SET normalized_account_name='stale'");
      await upsertCanonicalInstallationAccount(db, account, after);
      expect(
        sqlite
          .prepare('SELECT normalized_account_name,updated_at FROM github_installation_accounts')
          .get()
      ).toEqual({ normalized_account_name: 'exampleorg', updated_at: after });
      await upsertCanonicalInstallationAccount(db, { ...account, accountName: 'Renamed' }, after);
      expect(
        sqlite
          .prepare('SELECT account_name,normalized_account_name FROM github_installation_accounts')
          .get()
      ).toEqual({ account_name: 'Renamed', normalized_account_name: 'renamed' });
    } finally {
      sqlite.close();
    }
  });
});
