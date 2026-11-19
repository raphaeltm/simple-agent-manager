import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type AccountPlan,
  createAccountSql,
  OWNER_ESTABLISHED_SETTING,
  parseAccountReport,
} from './account-sql.js';
import { mainDatabaseName, ownerLockoutRefusal, resolveBootstrapOwner } from './create-account.js';
import { CHILD_TEST_TIMEOUT_MS, runTsx, writeBox } from './deploy-harness.js';

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

describe('--superadmin before the bootstrap owner is established', () => {
  // A real SQL engine: the guard is a predicate in the statements create-account runs.
  async function database() {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0, name TEXT, role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'active', created_at INTEGER, updated_at INTEGER);
      CREATE TABLE platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL,
      updated_at TEXT, updated_by TEXT);
      INSERT INTO users (id, email, email_verified, name, role, status)
        VALUES ('system_anonymous_trials', 'system@internal', 0, 'System', 'user', 'system');`);
    return db;
  }
  const OWNER = 'owner@example.com';
  const plan = (email: string, extra: Partial<AccountPlan> = {}): AccountPlan => ({
    email,
    superadmin: true,
    id: 'B'.repeat(32),
    nowMs: 1_700_000_000_000,
    bootstrapOwnerEmail: OWNER,
    ...extra,
  });
  type Row = { email: string; role: string };
  const rows = (db: Awaited<ReturnType<typeof database>>) =>
    db
      .prepare(`SELECT email, role FROM users WHERE status != 'system' ORDER BY email`)
      .all() as unknown as Row[];

  it('writes no superadmin for another address and explains why', async () => {
    const db = await database();
    const teammate = plan('teammate@example.com');
    db.exec(createAccountSql(teammate));
    expect(rows(db)).toEqual([]);
    expect(ownerLockoutRefusal(teammate, null)).toContain(
      'owner@example.com (BOOTSTRAP_OWNER_EMAIL) has not signed in yet'
    );
  });

  it('does not promote an existing account for another address either', async () => {
    const db = await database();
    db.exec(createAccountSql(plan('teammate@example.com', { superadmin: false })));
    const teammate = plan('teammate@example.com');
    db.exec(createAccountSql(teammate));
    expect(rows(db)).toEqual([{ email: 'teammate@example.com', role: 'user' }]);
    expect(ownerLockoutRefusal(teammate, { id: 'x', role: 'user', status: 'active' })).not.toBe(
      null
    );
  });

  it('control: the owner themselves may be made superadmin', async () => {
    const db = await database();
    const owner = plan(OWNER);
    db.exec(createAccountSql(owner));
    expect(rows(db)).toEqual([{ email: OWNER, role: 'superadmin' }]);
    expect(ownerLockoutRefusal(owner, { id: 'x', role: 'superadmin', status: 'active' })).toBe(
      null
    );
  });

  it('control: a plain account for another address is still created', async () => {
    const db = await database();
    const teammate = plan('teammate@example.com', { superadmin: false });
    db.exec(createAccountSql(teammate));
    expect(rows(db)).toEqual([{ email: 'teammate@example.com', role: 'user' }]);
    expect(ownerLockoutRefusal(teammate, { id: 'x', role: 'user', status: 'active' })).toBe(null);
  });

  it.each([
    [
      'the owner-established marker',
      `INSERT INTO platform_settings (key, value) VALUES ('${OWNER_ESTABLISHED_SETTING}', '{"version":1,"ownerId":"o"}')`,
    ],
    [
      'the owner as a verified active superadmin',
      `INSERT INTO users (id, email, email_verified, name, role, status)
         VALUES ('o', '${OWNER}', 1, 'Owner', 'superadmin', 'active')`,
    ],
  ])('allows another superadmin once the owner is established (%s)', async (_name, seed) => {
    const db = await database();
    db.exec(seed);
    db.exec(createAccountSql(plan('teammate@example.com')));
    expect(rows(db).find((row) => row.email === 'teammate@example.com')?.role).toBe('superadmin');
  });

  it('control: an unverified or suspended owner row does not count as established', async () => {
    const db = await database();
    db.exec(`INSERT INTO users (id, email, email_verified, name, role, status)
      VALUES ('o', '${OWNER}', 0, 'Owner', 'superadmin', 'active')`);
    db.exec(createAccountSql(plan('teammate@example.com')));
    expect(rows(db).map((row) => row.email)).toEqual([OWNER]);
  });

  it('unchanged without an owner email: any address may be made superadmin', async () => {
    const db = await database();
    const teammate = plan('teammate@example.com', { bootstrapOwnerEmail: undefined });
    db.exec(createAccountSql(teammate));
    expect(rows(db)).toEqual([{ email: 'teammate@example.com', role: 'superadmin' }]);
    expect(ownerLockoutRefusal(teammate, { id: 'x', role: 'superadmin', status: 'active' })).toBe(
      null
    );
  });

  it('refuses an owner email it cannot safely put in SQL', () => {
    expect(() =>
      createAccountSql(plan('teammate@example.com', { bootstrapOwnerEmail: "o'@example.com" }))
    ).toThrow();
  });
});

/**
 * Where `--superadmin` learns the bootstrap owner. Run as child processes on a throwaway box, as
 * an operator does; `--dry-run` prints the SQL it would run without needing celld.
 */
describe('create-account reads the bootstrap owner from the deploy secrets file', () => {
  const CREATE_ACCOUNT = resolve(import.meta.dirname, 'create-account.ts');
  const TEAMMATE = 'teammate@example.com';
  let dir: string;
  let envFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sam-create-account-'));
    envFile = writeBox(dir);
    mkdirSync(join(dir, '.state'), { mode: 0o700 });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const writeSecrets = (path: string, lines: string[]) =>
    writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 });
  const createAccount = (args: string[]) =>
    runTsx(CREATE_ACCOUNT, ['--env-file', envFile, '--email', TEAMMATE, '--dry-run', ...args]);

  it(
    "with the deploy's custom --secrets path, --superadmin waits for that owner",
    async () => {
      const custom = join(dir, 'elsewhere.env');
      writeSecrets(custom, ['BOOTSTRAP_OWNER_EMAIL=Owner@Example.com']);
      const result = await createAccount(['--superadmin', '--secrets', custom]);
      expect(result.status, result.out).toBe(0);
      // The owner guard is in the SQL: nothing is written until the owner is established.
      expect(result.out).toContain(OWNER_ESTABLISHED_SETTING);
      expect(result.out).toContain("lower(trim(email)) = 'owner@example.com'");
    },
    CHILD_TEST_TIMEOUT_MS
  );

  it(
    'refuses --superadmin when the secrets file is missing (it may be at another path)',
    async () => {
      const result = await createAccount(['--superadmin']);
      expect(result.status).toBe(1);
      expect(result.out).toContain('--superadmin needs the secrets file the deploy read');
      expect(result.out).not.toContain('INSERT INTO users');
    },
    CHILD_TEST_TIMEOUT_MS
  );

  it(
    'control: a plain account needs no secrets file',
    async () => {
      const result = await createAccount([]);
      expect(result.status, result.out).toBe(0);
      expect(result.out).toContain('INSERT INTO users');
      expect(result.out).not.toContain(OWNER_ESTABLISHED_SETTING);
    },
    CHILD_TEST_TIMEOUT_MS
  );

  it(
    'control: an install whose secrets file has no owner may add a superadmin',
    async () => {
      writeSecrets(join(dir, '.state', 'secrets.env'), ['GITHUB_CLIENT_ID=abc']);
      const result = await createAccount(['--superadmin']);
      expect(result.status, result.out).toBe(0);
      expect(result.out).toContain("UPDATE users SET role = 'superadmin'");
      expect(result.out).not.toContain(OWNER_ESTABLISHED_SETTING);
    },
    CHILD_TEST_TIMEOUT_MS
  );
});

describe('resolveBootstrapOwner', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sam-owner-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('normalizes the owner, and refuses an empty one', () => {
    const path = join(dir, 'secrets.env');
    writeFileSync(path, 'BOOTSTRAP_OWNER_EMAIL= Owner@Example.com \n', { mode: 0o600 });
    expect(resolveBootstrapOwner(path, true)).toBe('owner@example.com');
    writeFileSync(path, 'BOOTSTRAP_OWNER_EMAIL=\n', { mode: 0o600 });
    expect(() => resolveBootstrapOwner(path, false)).toThrow(/set but empty/);
  });

  it('fails closed on a secrets file others can read, with or without --superadmin', () => {
    const path = join(dir, 'secrets.env');
    writeFileSync(path, 'BOOTSTRAP_OWNER_EMAIL=owner@example.com\n', { mode: 0o644 });
    expect(() => resolveBootstrapOwner(path, true)).toThrow(/readable by group or others/);
    expect(() => resolveBootstrapOwner(path, false)).toThrow(/readable by group or others/);
  });

  it('a missing file means no owner only without --superadmin', () => {
    const path = join(dir, 'missing.env');
    expect(resolveBootstrapOwner(path, false)).toBeUndefined();
    expect(() => resolveBootstrapOwner(path, true)).toThrow(/does not exist/);
  });
});
