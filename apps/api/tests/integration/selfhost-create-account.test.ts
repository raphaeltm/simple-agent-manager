/**
 * `pnpm selfhost:create-account` (scripts/selfhost/account-sql.ts), end to end: its SQL runs on a
 * real SQL engine with the full schema and the migration-seeded sentinel user, then the account
 * signs in through the production `/api/auth` routes with a code delivered over SMTP. Proves the
 * command writes the rows BetterAuth's email sign-in reads, and the sentinel rules.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createAccountSql,
  generateAccountId,
  normalizeAccountEmail,
} from '../../../../scripts/selfhost/account-sql';
import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { authRoutes } from '../../src/routes/auth';
import { __resetPlatformConfigCacheForTest } from '../../src/services/platform-config';
import { type FakeSmtpServer, startFakeSmtpServer } from '../helpers/fake-smtp-server';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../helpers/sqlite-d1';

const API_ORIGIN = 'https://api.example.com';
const APP_ORIGIN = 'https://app.example.com';

interface Row {
  id: string;
  email: string;
  role: string;
  status: string;
  emailVerified: number;
  activeSuperadmins: number;
}

describe('selfhost create-account SQL', () => {
  let sqlite: Database.Database;
  let smtp: FakeSmtpServer;
  let env: Env;
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.route('/api/auth', authRoutes);

  /** Runs the command's batch the way `celld d1 execute` does; returns the report rows. */
  function runCommand(email: string, superadmin = false): Row[] {
    const sql = createAccountSql({
      email: normalizeAccountEmail(email),
      superadmin,
      id: generateAccountId(),
      nowMs: Date.now(),
    });
    let rows: Row[] = [];
    for (const statement of sql.split(';\n')) {
      const prepared = sqlite.prepare(statement.replace(/;$/, ''));
      if (prepared.reader) rows = prepared.all() as Row[];
      else prepared.run();
    }
    return rows;
  }

  function realUsers() {
    return sqlite
      .prepare(`SELECT email, role, status FROM users WHERE status != 'system' ORDER BY email`)
      .all();
  }

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite
      .prepare(
        `INSERT INTO users (id, email, email_verified, name, role, status, created_at, updated_at)
         VALUES ('system_anonymous_trials', 'system@internal', 0, 'System', 'superadmin', 'system', 0, 0)`
      )
      .run();
    smtp = await startFakeSmtpServer({ mode: 'plain' });
    env = {
      DATABASE: createSqliteD1(sqlite),
      KV: createMemoryKv(),
      BASE_DOMAIN: 'example.com',
      ENCRYPTION_KEY: 'test-encryption-key',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(smtp.port),
      SMTP_TLS: 'none',
      SMTP_FROM: 'sign-in@example.com',
    } as Env;
    __resetPlatformConfigCacheForTest();
  });

  afterEach(async () => {
    sqlite.close();
    await smtp.close();
  });

  async function signInByEmail(email: string): Promise<Record<string, unknown> | null> {
    const background: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext;
    await app.request(
      `${API_ORIGIN}/api/auth/email-otp/send-verification-otp`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP_ORIGIN },
        body: JSON.stringify({ email, type: 'sign-in' }),
      },
      env,
      executionCtx
    );
    await Promise.all(background);
    const message = smtp.messages.findLast((sent) => sent.to.includes(email));
    if (!message) return null;
    const body = message.data.split('\r\n\r\n').slice(1).join('\n');
    const otp = /\b(\d{6})\b/.exec(body)?.[1] ?? '';
    const signIn = await app.request(
      `${API_ORIGIN}/api/auth/sign-in/email-otp`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP_ORIGIN },
        body: JSON.stringify({ email, otp }),
      },
      env
    );
    const cookie = signIn.headers
      .getSetCookie()
      .map((value) => value.split(';', 1)[0])
      .join('; ');
    const me = await app.request(`${API_ORIGIN}/api/auth/me`, { headers: { cookie } }, env);
    return me.ok ? ((await me.json()) as Record<string, unknown>) : null;
  }

  it('creates an account that signs in with an emailed code, with no accounts row', async () => {
    // Control: without the account, no code is sent and nothing is created.
    expect(await signInByEmail('teammate@example.com')).toBeNull();
    expect(realUsers()).toEqual([]);

    const [row] = runCommand('Teammate@Example.com');
    expect(row).toMatchObject({ email: 'teammate@example.com', role: 'user', status: 'active' });
    expect(row?.id).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(await signInByEmail('teammate@example.com')).toMatchObject({
      id: row?.id,
      email: 'teammate@example.com',
      role: 'user',
      status: 'active',
    });
  });

  it('is idempotent and promotes only when asked', () => {
    const [first] = runCommand('teammate@example.com');
    const [again] = runCommand('teammate@example.com');
    expect(again?.id).toBe(first?.id);
    expect(again?.role).toBe('user');
    const [promoted] = runCommand('teammate@example.com', true);
    expect(promoted).toMatchObject({ id: first?.id, role: 'superadmin', status: 'active' });
    expect(realUsers()).toHaveLength(1);
  });

  it('keeps an existing account as it is unless asked to promote it', () => {
    sqlite
      .prepare(
        `INSERT INTO users (id, email, email_verified, name, role, status, created_at, updated_at)
         VALUES ('github-user', 'dev@example.com', 1, 'Dev', 'user', 'suspended', 1, 1)`
      )
      .run();
    expect(runCommand('dev@example.com')[0]).toMatchObject({
      id: 'github-user',
      status: 'suspended',
    });
    expect(runCommand('dev@example.com', true)[0]).toMatchObject({
      id: 'github-user',
      role: 'superadmin',
      // Promotion never lifts a suspension.
      status: 'suspended',
    });
  });

  it('approves a pending account when promoting it', () => {
    sqlite
      .prepare(
        `INSERT INTO users (id, email, email_verified, name, role, status, created_at, updated_at)
         VALUES ('waiting', 'waiting@example.com', 1, 'Waiting', 'user', 'pending', 1, 1)`
      )
      .run();
    expect(runCommand('waiting@example.com')[0]).toMatchObject({ status: 'pending' });
    expect(runCommand('waiting@example.com', true)[0]).toMatchObject({
      role: 'superadmin',
      status: 'active',
    });
  });

  describe('with an installer owner (BOOTSTRAP_OWNER_EMAIL)', () => {
    const OWNER = 'owner@example.com';
    beforeEach(() => {
      env = { ...env, BOOTSTRAP_OWNER_EMAIL: OWNER } as Env;
    });

    it('admits a created teammate only once the owner exists, as the command warns', async () => {
      runCommand('teammate@example.com');
      // The owner has not signed in: SAM admits no one else yet.
      expect(await signInByEmail('teammate@example.com')).toBeNull();

      // Owner path: creating the owner as superadmin establishes them...
      runCommand(OWNER, true);
      expect(await signInByEmail(OWNER)).toMatchObject({ email: OWNER, role: 'superadmin' });
      // ...and the teammate is admitted from then on.
      expect(await signInByEmail('teammate@example.com')).toMatchObject({
        email: 'teammate@example.com',
        role: 'user',
      });
    });

    it('lets the owner, created as a plain account, sign in and become the administrator', async () => {
      runCommand(OWNER);
      expect(await signInByEmail(OWNER)).toMatchObject({
        email: OWNER,
        role: 'superadmin',
        status: 'active',
      });
    });
  });

  it('never counts or touches the sentinel user', () => {
    // The sentinel is seeded as a 'superadmin' here on purpose: only status excludes it.
    expect(runCommand('first@example.com')[0]?.activeSuperadmins).toBe(0);
    expect(runCommand('first@example.com', true)[0]?.activeSuperadmins).toBe(1);
    expect(
      sqlite.prepare(`SELECT status, role FROM users WHERE id = 'system_anonymous_trials'`).get()
    ).toEqual({ status: 'system', role: 'superadmin' });
  });

  it("reports no row for the real sentinel's address and writes nothing", () => {
    sqlite
      .prepare(
        `INSERT INTO users (id, email, email_verified, name, role, status, created_at, updated_at)
         VALUES ('sentinel-2', 'anonymous-trials@simple-agent-manager.internal', 0, 'S', 'user', 'system', 0, 0)`
      )
      .run();
    // The address passes the pattern (migration 0043's sentinel), so only the SQL protects it.
    expect(runCommand('anonymous-trials@simple-agent-manager.internal', true)).toEqual([]);
    expect(
      sqlite
        .prepare(`SELECT id, role, status FROM users WHERE email LIKE 'anonymous-trials@%'`)
        .all()
    ).toEqual([{ id: 'sentinel-2', role: 'user', status: 'system' }]);
  });

  it.each(["x'@example.com", 'a@b', 'a b@example.com', 'system@internal', 'é@example.com'])(
    'refuses %s before building any SQL',
    (email) => {
      expect(() => normalizeAccountEmail(email)).toThrow('not an email address');
    }
  );
});
