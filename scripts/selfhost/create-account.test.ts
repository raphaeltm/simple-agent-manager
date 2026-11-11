import { describe, expect, it } from 'vitest';

import { createAccountSql } from './account-sql.js';
import { mainDatabaseName } from './create-account.js';

describe('mainDatabaseName', () => {
  it('finds the database bound as DATABASE in the deployed celld config', () => {
    const config = {
      d1_databases: [
        { binding: 'OBSERVABILITY_DATABASE', database_name: 'observability-dev' },
        { binding: 'DATABASE', database_name: 'workspaces-dev' },
      ],
    };
    expect(mainDatabaseName(JSON.stringify(config))).toBe('workspaces-dev');
  });

  it('refuses a config without it (not deployed yet)', () => {
    expect(() => mainDatabaseName('{"d1_databases":[]}')).toThrow('run pnpm selfhost:deploy first');
    expect(() => mainDatabaseName('{}')).toThrow('run pnpm selfhost:deploy first');
  });
});

describe('createAccountSql', () => {
  const plan = { email: 'teammate@example.com', id: 'A'.repeat(32), nowMs: 1_700_000_000_000 };

  it('promotes only with --superadmin', () => {
    expect(createAccountSql({ ...plan, superadmin: false })).not.toContain('UPDATE users');
    expect(createAccountSql({ ...plan, superadmin: true })).toContain(
      "UPDATE users SET role = 'superadmin', status = 'active'"
    );
  });

  it('refuses values it did not generate or check', () => {
    expect(() =>
      createAccountSql({ ...plan, superadmin: false, email: "x'@example.com" })
    ).toThrow();
    expect(() =>
      createAccountSql({ ...plan, superadmin: false, id: "x'); DROP TABLE users;--" })
    ).toThrow('bad account id');
    expect(() => createAccountSql({ ...plan, superadmin: false, nowMs: Number.NaN })).toThrow(
      'bad timestamp'
    );
  });
});
