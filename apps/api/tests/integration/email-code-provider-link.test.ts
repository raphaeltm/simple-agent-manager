/**
 * An email code must not silently disconnect a GitHub-created account from GitHub.
 *
 * SAM stores a GitHub user's email as unverified when GitHub's `/user/emails` call fails
 * (`getUserInfo` in `src/auth.ts`). Redeeming an email code for such an account makes
 * better-auth's emailOTP route call `revokeUnprovenAccountAccess`, which deletes every account
 * link and session. Found on the self-hosted test box on 2026-11-11
 * (`tasks/backlog/2026-11-11-email-code-sign-in-strips-github-link.md`).
 *
 * Runs the production `/api/auth` routes, the real better-auth emailOTP plugin and a real SQL
 * engine; only the mail binding is faked.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { authRoutes } from '../../src/routes/auth';
import { __resetPlatformConfigCacheForTest } from '../../src/services/platform-config';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../helpers/sqlite-d1';

const API_ORIGIN = 'https://api.example.com';
const APP_ORIGIN = 'https://app.example.com';
const ADDRESS = 'mona@example.com';

interface SentEmail {
  to: string;
  subject: string;
  text: string;
}

function codeFrom(email: SentEmail | undefined): string | null {
  return /\b(\d{6})\b/.exec(email?.text ?? '')?.[1] ?? null;
}

describe('email code for an account created by GitHub sign-in', () => {
  let sqlite: Database.Database;
  let env: Env;
  let sent: SentEmail[];
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.route('/api/auth', authRoutes);

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sent = [];
    env = {
      DATABASE: createSqliteD1(sqlite),
      KV: createMemoryKv(),
      BASE_DOMAIN: 'example.com',
      ENCRYPTION_KEY: 'test-encryption-key',
      AGENT_EMAIL: {
        async send(message: SentEmail) {
          sent.push(message);
          return { messageId: `m-${sent.length}` };
        },
      } as unknown as SendEmail,
    } as Env;
    __resetPlatformConfigCacheForTest();
  });

  afterEach(() => sqlite.close());

  /** A user as SAM's GitHub sign-in stores it, in the production row shape. */
  function seedUser(emailVerified: 0 | 1, withGitHubLink: boolean) {
    sqlite
      .prepare(
        `INSERT INTO users (id, email, email_verified, name, role, status, created_at, updated_at)
         VALUES ('gh-user', ?, ?, 'Mona', 'user', 'active', 1, 1)`
      )
      .run(ADDRESS, emailVerified);
    if (withGitHubLink) {
      sqlite
        .prepare(
          `INSERT INTO accounts (id, account_id, provider_id, user_id, access_token, scope, created_at, updated_at)
           VALUES ('gh-account', '4242', 'github', 'gh-user', 'encrypted-token', 'read:user', 1, 1)`
        )
        .run();
    }
    sqlite
      .prepare(
        `INSERT INTO sessions (id, expires_at, token, user_id, created_at, updated_at)
         VALUES ('gh-session', ?, 'gh-session-token', 'gh-user', 1, 1)`
      )
      .run(Date.now() + 3_600_000);
  }

  function linkCount(): number {
    return (
      sqlite.prepare(`SELECT count(*) AS n FROM accounts WHERE user_id = 'gh-user'`).get() as {
        n: number;
      }
    ).n;
  }

  function sessionCount(): number {
    return (
      sqlite.prepare(`SELECT count(*) AS n FROM sessions WHERE user_id = 'gh-user'`).get() as {
        n: number;
      }
    ).n;
  }

  async function requestCode(): Promise<Response> {
    return app.request(
      `${API_ORIGIN}/api/auth/email-otp/send-verification-otp`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP_ORIGIN },
        body: JSON.stringify({ email: ADDRESS, type: 'sign-in' }),
      },
      env
    );
  }

  async function redeem(otp: string): Promise<Response> {
    return app.request(
      `${API_ORIGIN}/api/auth/sign-in/email-otp`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP_ORIGIN },
        body: JSON.stringify({ email: ADDRESS, otp }),
      },
      env
    );
  }

  it('mails a "sign in with GitHub" note instead of a code, and the response looks the same', async () => {
    seedUser(0, true);
    const response = await requestCode();
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(ADDRESS);
    expect(sent[0]?.subject).toBe('Sign in to SAM with GitHub');
    expect(sent[0]?.text).toContain('Sign in with GitHub');
    expect(codeFrom(sent[0])).toBeNull();
  });

  it('refuses a real code for such an account, keeping its GitHub link and sessions', async () => {
    // A code issued while the account still looked eligible, then redeemed after: the only way
    // to hold a valid code for this account, and the case the redemption check must stop.
    seedUser(1, false);
    await requestCode();
    const code = codeFrom(sent[0]);
    expect(code).not.toBeNull();
    sqlite.prepare(`UPDATE users SET email_verified = 0 WHERE id = 'gh-user'`).run();
    sqlite
      .prepare(
        `INSERT INTO accounts (id, account_id, provider_id, user_id, access_token, scope, created_at, updated_at)
         VALUES ('gh-account', '4242', 'github', 'gh-user', 'encrypted-token', 'read:user', 1, 1)`
      )
      .run();

    const response = await redeem(code ?? '');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_OTP' });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(linkCount()).toBe(1);
    expect(sessionCount()).toBe(1);
    expect(
      (
        sqlite.prepare(`SELECT email_verified AS v FROM users WHERE id = 'gh-user'`).get() as {
          v: number;
        }
      ).v
    ).toBe(0);
  });

  it('control: a verified account with a GitHub link still signs in by code and keeps the link', async () => {
    seedUser(1, true);
    await requestCode();
    const code = codeFrom(sent[0]);
    expect(code).not.toBeNull();
    const response = await redeem(code ?? '');
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().length).toBeGreaterThan(0);
    expect(linkCount()).toBe(1);
  });

  it('control: an unverified account with no provider link still gets and redeems a code', async () => {
    seedUser(0, false);
    await requestCode();
    const code = codeFrom(sent[0]);
    expect(code).not.toBeNull();
    expect((await redeem(code ?? '')).status).toBe(200);
  });
});
