/**
 * "Connect GitHub" for an account that signed in by email, end to end: the production
 * `/api/auth` routes, the real better-auth `/link-social` flow and OAuth callback, and a real
 * SQL engine. Only GitHub is faked, at the network boundary.
 *
 * The account must afterwards pass the workspace git-token user check, which reads the user's
 * own GitHub token through `getGitHubUserAccessTokenForOwner` (unchanged by this feature).
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { authRoutes } from '../../src/routes/auth';
import { githubUserTokenUnavailableError } from '../../src/services/github-token-errors';
import { getGitHubUserAccessTokenForOwner } from '../../src/services/github-user-access-token';
import { __resetPlatformConfigCacheForTest } from '../../src/services/platform-config';
import { createSessionCookieForUser } from '../../src/services/session-factory';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const API_ORIGIN = 'https://api.example.com';
const APP_ORIGIN = 'https://app.example.com';
const RETURN_TO = `${APP_ORIGIN}/settings/github`;
const GITHUB_REDIRECT_URI = `${API_ORIGIN}/api/auth/callback/github`;
const CLIENT_ID = 'Iv1.sam-link-client';
const CLIENT_SECRET = 'sam-link-client-secret';
const SAM_EMAIL = 'raphael@vmtest.example.com';

/** A GitHub account whose primary email differs from the SAM account's. */
const GITHUB_USER = { id: 777, login: 'octo', name: 'Octo', email: null, avatar_url: null };
const GITHUB_EMAILS = [{ email: 'octo@users.example.org', primary: true, verified: true }];

function createFakeGitHub() {
  const pendingCodes = new Set<string>();
  const issuedTokens = new Set<string>();
  let counter = 0;

  function approve(authorizeUrl: URL): string {
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
      'https://github.com/login/oauth/authorize'
    );
    expect(authorizeUrl.searchParams.get('client_id')).toBe(CLIENT_ID);
    // Linking reuses the one registered callback URL; no new URL to register on GitHub.
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(GITHUB_REDIRECT_URI);
    const code = `code-${++counter}`;
    pendingCodes.add(code);
    return code;
  }

  async function fetchImpl(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method === 'POST' && url.href === 'https://github.com/login/oauth/access_token') {
      const form = new URLSearchParams(await request.text());
      if (!pendingCodes.delete(form.get('code') ?? '')) {
        return Response.json({ error: 'bad_verification_code' });
      }
      const token = `gho_link_token_${++counter}`;
      issuedTokens.add(token);
      return Response.json({ access_token: token, token_type: 'bearer', scope: 'read:user' });
    }
    if (request.method === 'GET' && url.origin === 'https://api.github.com') {
      const token = (request.headers.get('authorization') ?? '').split(' ')[1] ?? '';
      if (!issuedTokens.has(token)) return Response.json({}, { status: 401 });
      if (url.pathname === '/user') return Response.json(GITHUB_USER);
      if (url.pathname === '/user/emails') return Response.json(GITHUB_EMAILS);
    }
    throw new Error(`Unexpected outbound request: ${request.method} ${request.url}`);
  }

  return { approve, fetch: fetchImpl, issuedTokens };
}

/**
 * D1 accepts numbered parameters (`?1`); the better-sqlite3 test adapter binds positionally only.
 * `getBetterAuthAccountIdForProvider` (the owner-token lookup) uses `?1`/`?2`, so rewrite them to
 * positional parameters for this test. Kept local: changing the shared adapter would also turn
 * on the login self-heal (`?1`) in every other test that currently runs without it.
 */
function withNumberedParameters(db: D1Database): D1Database {
  const prepare = (sql: string) => {
    const order = [...sql.matchAll(/\?(\d+)/g)].map((match) => Number(match[1]));
    if (order.length === 0) return db.prepare(sql);
    const statement = db.prepare(sql.replace(/\?\d+/g, '?'));
    return Object.assign(Object.create(Object.getPrototypeOf(statement)), statement, {
      bind: (...params: unknown[]) => statement.bind(...order.map((n) => params[n - 1])),
    }) as D1PreparedStatement;
  };
  return new Proxy(db, {
    get: (target, key) => (key === 'prepare' ? prepare : Reflect.get(target, key)),
  });
}

describe('Connect GitHub for an email-signed account (vertical slice)', () => {
  let sqlite: Database.Database;
  let env: Env;
  let github: ReturnType<typeof createFakeGitHub>;
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.route('/api/auth', authRoutes);

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    env = {
      DATABASE: withNumberedParameters(createSqliteD1(sqlite)),
      BASE_DOMAIN: 'example.com',
      ENCRYPTION_KEY: 'test-encryption-key',
      GITHUB_CLIENT_ID: CLIENT_ID,
      GITHUB_CLIENT_SECRET: CLIENT_SECRET,
    } as Env;
    __resetPlatformConfigCacheForTest();
    github = createFakeGitHub();
    vi.stubGlobal('fetch', github.fetch);
    // An account made by email sign-in (or `pnpm selfhost:create-account`): verified, no links.
    sqlite
      .prepare(
        `INSERT INTO users (id, email, email_verified, name, role, status, created_at, updated_at)
         VALUES ('email-user', ?, 1, 'raphael', 'superadmin', 'active', 1, 1)`
      )
      .run(SAM_EMAIL);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sqlite.close();
  });

  function cookieHeader(...responses: Response[]): string {
    return responses
      .flatMap((response) => response.headers.getSetCookie())
      .map((value) => value.split(';', 1)[0])
      .join('; ');
  }

  async function startLink(cookie: string): Promise<Response> {
    return app.request(
      `${API_ORIGIN}/api/auth/link-social`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP_ORIGIN, cookie },
        body: JSON.stringify({ provider: 'github', callbackURL: RETURN_TO }),
      },
      env
    );
  }

  async function completeLink(cookie: string): Promise<Response> {
    const start = await startLink(cookie);
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    const authorizeUrl = new URL(url);
    const callback = new URL(GITHUB_REDIRECT_URI);
    callback.searchParams.set('code', github.approve(authorizeUrl));
    callback.searchParams.set('state', authorizeUrl.searchParams.get('state') ?? '');
    const stateCookies = cookieHeader(start);
    return app.request(
      callback.toString(),
      { headers: { cookie: [cookie, stateCookies].filter(Boolean).join('; ') } },
      env
    );
  }

  function githubLinks() {
    return sqlite
      .prepare(`SELECT account_id, user_id FROM accounts WHERE provider_id = 'github'`)
      .all() as Array<{ account_id: string; user_id: string }>;
  }

  it('links GitHub with a different email, keeps the SAM email, and passes the git-token user check', async () => {
    // Before: the git-token user check has no token, and the error says "connect", not "expired".
    expect(await getGitHubUserAccessTokenForOwner(env, 'email-user')).toBeNull();
    const before = await githubUserTokenUnavailableError(env, 'email-user');
    expect(before).toMatchObject({ statusCode: 403, error: 'GITHUB_NOT_CONNECTED' });

    const { sessionCookie } = await createSessionCookieForUser(env, 'email-user');
    const callback = await completeLink(sessionCookie);

    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(RETURN_TO);
    expect(githubLinks()).toEqual([{ account_id: '777', user_id: 'email-user' }]);
    const user = sqlite
      .prepare(`SELECT email, email_verified AS verified FROM users WHERE id = 'email-user'`)
      .get() as { email: string; verified: number };
    expect(user).toEqual({ email: SAM_EMAIL, verified: 1 });
    // No second user was created for the GitHub identity.
    expect((sqlite.prepare(`SELECT count(*) AS n FROM users`).get() as { n: number }).n).toBe(1);

    // After: the owner-token lookup the git-token check uses returns the linked token.
    const token = await getGitHubUserAccessTokenForOwner(env, 'email-user', 'git-token-test');
    expect(token).not.toBeNull();
    expect(github.issuedTokens.has(token ?? '')).toBe(true);
  });

  it('refuses to start a link without a signed-in session', async () => {
    const response = await startLink('');
    expect(response.status).toBe(401);
    expect(githubLinks()).toEqual([]);
  });

  it('refuses to link a GitHub account that already belongs to another SAM user', async () => {
    sqlite
      .prepare(
        `INSERT INTO users (id, email, email_verified, name, role, status, created_at, updated_at)
         VALUES ('other-user', 'other@example.com', 1, 'other', 'user', 'active', 1, 1)`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO accounts (id, account_id, provider_id, user_id, created_at, updated_at)
         VALUES ('other-link', '777', 'github', 'other-user', 1, 1)`
      )
      .run();
    const { sessionCookie } = await createSessionCookieForUser(env, 'email-user');
    const callback = await completeLink(sessionCookie);
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toContain('error=');
    expect(githubLinks()).toEqual([{ account_id: '777', user_id: 'other-user' }]);
  });
});
