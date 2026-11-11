import { describe, expect, it } from 'vitest';

import { createAccountSql, parseAccountReport } from './account-sql.js';
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
      "UPDATE users SET role = 'superadmin', status = CASE WHEN status = 'pending'"
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

describe('parseAccountReport', () => {
  // `celld d1 execute` output, as observed on celld 0.6.3.
  const table = [
    'id                                email                 role  status  emailVerified  activeSuperadmins',
    '--------------------------------  --------------------  ----  ------  -------------  -----------------',
    'UNX8rGfGHBFjvlB7HLFS4ZRF6XTp3BBI  teammate@example.com  user  active  1              1',
    'Executed 2 statement(s) in 3ms',
  ].join('\n');

  it('reads the account row', () => {
    expect(parseAccountReport(table, 'teammate@example.com')).toEqual({
      id: 'UNX8rGfGHBFjvlB7HLFS4ZRF6XTp3BBI',
      role: 'user',
      status: 'active',
    });
  });

  it('finds nothing when the report has no row, even if the address appears elsewhere', () => {
    const empty = [
      "INSERT INTO users ... '01234567890123456789012345678901', 'teammate@example.com' ...;",
      'id  email  role  status  emailVerified  activeSuperadmins',
      'Executed 2 statement(s) in 1ms',
    ].join('\n');
    expect(parseAccountReport(empty, 'teammate@example.com')).toBeNull();
    expect(parseAccountReport(table, 'other@example.com')).toBeNull();
  });
});
