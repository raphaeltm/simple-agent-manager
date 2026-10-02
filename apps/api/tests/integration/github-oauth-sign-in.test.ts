/**
 * GitHub sign-in, end to end: the production `/api/auth` routes, the real better-auth
 * handler, and a real SQL engine. Only GitHub itself is faked, at the network boundary.
 *
 * Why this exists: the better-auth 1.6.11 -> 1.7.5 upgrade (PR #2130) changed where the
 * library reads a provider's account identity. Every GitHub sign-in in production then
 * failed with `unable_to_get_user_info` for eight days, while CI stayed green, because no
 * test ran a real OAuth callback. A dependency bump that breaks sign-in must fail here.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { authRoutes } from '../../src/routes/auth';
import { __resetPlatformConfigCacheForTest } from '../../src/services/platform-config';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const API_ORIGIN = 'https://api.example.com';
const APP_ORIGIN = 'https://app.example.com';
const CALLBACK_URL = `${APP_ORIGIN}/dashboard`;
const GITHUB_REDIRECT_URI = `${API_ORIGIN}/api/auth/callback/github`;
const CLIENT_ID = 'Iv1.sam-test-client';
const CLIENT_SECRET = 'sam-test-client-secret';

/** The /user payload as GitHub sends it: a numeric id, plus fields SAM does not read. */
const GITHUB_USER = {
  id: 4242,
  login: 'octocat',
  node_id: 'MDQ6VXNlcjQyNDI=',
  name: 'Mona Octocat',
  email: 'public@example.com',
  avatar_url: 'https://avatars.githubusercontent.com/u/4242',
};

/** SAM signs users in with their verified primary address, not the public profile one. */
const GITHUB_EMAILS = [
  { email: 'public@example.com', primary: false, verified: true },
  { email: 'mona@example.com', primary: true, verified: true },
];

/**
 * A stand-in for github.com that enforces the parts of the OAuth contract SAM depends on:
 * client credentials, the registered redirect URI, single-use codes, and bearer tokens.
 */
function createFakeGitHub() {
  const pendingCodes = new Set<string>();
  const issuedTokens = new Set<string>();
  const outboundRequests: string[] = [];

  /** The user approving the consent screen GitHub would show for this authorize URL. */
  function approve(authorizeUrl: URL): string {
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
      'https://github.com/login/oauth/authorize'
    );
    expect(authorizeUrl.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(GITHUB_REDIRECT_URI);
    expect(authorizeUrl.searchParams.get('scope')?.split(' ')).toEqual(
      expect.arrayContaining(['read:user', 'user:email', 'read:org'])
    );
    const code = `code-${pendingCodes.size + issuedTokens.size + 1}`;
    pendingCodes.add(code);
    return code;
  }

  function bearerIsValid(request: Request): boolean {
    const [scheme, token] = (request.headers.get('authorization') ?? '').split(' ');
    return /^(bearer|token)$/i.test(scheme ?? '') && issuedTokens.has(token ?? '');
  }

  async function exchangeCode(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    const basic = request.headers.get('authorization')?.match(/^Basic (.+)$/i)?.[1];
    const [basicId, basicSecret] = basic ? atob(basic).split(':') : [];
    const clientId = form.get('client_id') ?? basicId;
    const clientSecret = form.get('client_secret') ?? basicSecret;
    if (clientId !== CLIENT_ID || clientSecret !== CLIENT_SECRET) {
      return Response.json({ error: 'incorrect_client_credentials' });
    }
    if (form.get('redirect_uri') !== GITHUB_REDIRECT_URI) {
      return Response.json({ error: 'redirect_uri_mismatch' });
    }
    const code = form.get('code') ?? '';
    // GitHub answers a bad or reused code with HTTP 200 and an error body.
    if (!pendingCodes.delete(code)) {
      return Response.json({ error: 'bad_verification_code' });
    }
    const accessToken = `gho_test_token_${issuedTokens.size + 1}`;
    issuedTokens.add(accessToken);
    return Response.json({
      access_token: accessToken,
      token_type: 'bearer',
      scope: 'read:org,read:user,user:email',
    });
  }

  async function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    outboundRequests.push(`${request.method} ${url.origin}${url.pathname}`);

    if (request.method === 'POST' && url.href === 'https://github.com/login/oauth/access_token') {
      return exchangeCode(request);
    }
    if (request.method === 'GET' && url.origin === 'https://api.github.com') {
      if (!bearerIsValid(request)) {
        return Response.json({ message: 'Bad credentials' }, { status: 401 });
      }
      if (url.pathname === '/user') return Response.json(GITHUB_USER);
      if (url.pathname === '/user/emails') return Response.json(GITHUB_EMAILS);
    }
    throw new Error(`Unexpected outbound request: ${request.method} ${request.url}`);
  }

  return { approve, fetch, outboundRequests };
}

/** Carries cookies between requests the way the browser does across the OAuth redirects. */
function createCookieJar() {
  const cookies = new Map<string, string>();
  return {
    store(response: Response) {
      for (const setCookie of response.headers.getSetCookie()) {
        const pair = setCookie.split(';', 1)[0] ?? '';
        const separator = pair.indexOf('=');
        const name = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();
        if (value === '' || /max-age=0/i.test(setCookie)) cookies.delete(name);
        else cookies.set(name, value);
      }
    },
    header: () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
  };
}

function buildApp() {
  // Mounted, and its errors handled, exactly as `src/index.ts` does.
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.route('/api/auth', authRoutes);
  return app;
}

describe('GitHub sign-in through better-auth (vertical slice)', () => {
  let sqlite: Database.Database;
  let env: Env;
  let github: ReturnType<typeof createFakeGitHub>;
  let jar: ReturnType<typeof createCookieJar>;
  const app = buildApp();

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    env = {
      DATABASE: createSqliteD1(sqlite),
      BASE_DOMAIN: 'example.com',
      ENCRYPTION_KEY: 'test-encryption-key',
      GITHUB_CLIENT_ID: CLIENT_ID,
      GITHUB_CLIENT_SECRET: CLIENT_SECRET,
    } as Env;
    __resetPlatformConfigCacheForTest();
    github = createFakeGitHub();
    vi.stubGlobal('fetch', github.fetch);
    jar = createCookieJar();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sqlite.close();
  });

  /** Browser: click "Sign in with GitHub", approve on GitHub, land back on the callback. */
  async function signInWithGitHub(code?: string): Promise<Response> {
    const start = await app.request(
      `${API_ORIGIN}/api/auth/sign-in/social`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP_ORIGIN, cookie: jar.header() },
        body: JSON.stringify({ provider: 'github', callbackURL: CALLBACK_URL }),
      },
      env
    );
    expect(start.status).toBe(200);
    jar.store(start);
    const { url } = (await start.json()) as { url: string };
    const authorizeUrl = new URL(url);
    const approvedCode = github.approve(authorizeUrl);

    const callback = new URL(GITHUB_REDIRECT_URI);
    callback.searchParams.set('code', code ?? approvedCode);
    callback.searchParams.set('state', authorizeUrl.searchParams.get('state') ?? '');
    // GitHub's RFC 9207 issuer parameter, present on every production callback.
    callback.searchParams.set('iss', 'https://github.com/login/oauth');
    const response = await app.request(
      callback.toString(),
      { headers: { cookie: jar.header() } },
      env
    );
    jar.store(response);
    return response;
  }

  async function currentUser(): Promise<Response> {
    return app.request(`${API_ORIGIN}/api/auth/me`, { headers: { cookie: jar.header() } }, env);
  }

  function githubAccounts() {
    return sqlite
      .prepare(
        `SELECT account_id, user_id, access_token FROM accounts WHERE provider_id = 'github'`
      )
      .all() as Array<{ account_id: string; user_id: string; access_token: string | null }>;
  }

  function realUserIds(): string[] {
    const rows = sqlite.prepare(`SELECT id FROM users WHERE status != 'system'`).all() as Array<{
      id: string;
    }>;
    return rows.map((row) => row.id);
  }

  it('signs a first-time GitHub user in and starts a session', async () => {
    const callback = await signInWithGitHub();

    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(CALLBACK_URL);

    const me = await currentUser();
    expect(me.status).toBe(200);
    const user = (await me.json()) as { id: string; email: string; name: string };
    expect(user).toMatchObject({ email: 'mona@example.com', name: 'Mona Octocat' });

    // The account is keyed on GitHub's numeric user id, the shape every production row has.
    const accounts = githubAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ account_id: String(GITHUB_USER.id), user_id: user.id });
    expect(accounts[0]?.access_token).toBeTruthy();
    expect(accounts[0]?.access_token).not.toContain('gho_test_token');
    expect(github.outboundRequests).toEqual([
      'POST https://github.com/login/oauth/access_token',
      'GET https://api.github.com/user',
      'GET https://api.github.com/user/emails',
    ]);
  });

  it('signs an existing GitHub user back into the account production already stores', async () => {
    // A user created before the upgrade, whose GitHub email has since changed: only the
    // account identity can match them, so a drifted identity would create a second user.
    const createdAt = Date.parse('2026-06-26T10:13:40Z');
    sqlite
      .prepare(
        `INSERT INTO users (id, email, email_verified, name, image, role, status, created_at, updated_at)
         VALUES ('existing-user', 'old-address@example.com', 1, 'Mona', NULL, 'superadmin', 'active', ?, ?)`
      )
      .run(createdAt, createdAt);
    sqlite
      .prepare(
        `INSERT INTO accounts (id, account_id, provider_id, user_id, scope, created_at, updated_at)
         VALUES ('existing-account', '4242', 'github', 'existing-user', 'read:user,user:email,read:org', ?, ?)`
      )
      .run(createdAt, createdAt);

    const callback = await signInWithGitHub();

    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(CALLBACK_URL);
    const me = await currentUser();
    expect(me.status).toBe(200);
    expect(((await me.json()) as { id: string }).id).toBe('existing-user');
    expect(realUserIds()).toEqual(['existing-user']);
    const accounts = githubAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ account_id: '4242', user_id: 'existing-user' });
    expect(accounts[0]?.access_token).toBeTruthy();
  });

  it('turns a code GitHub refuses into an auth error and no session', async () => {
    const callback = await signInWithGitHub('code-github-never-issued');

    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(
      `${API_ORIGIN}/api/auth/error?error=invalid_code`
    );
    expect((await currentUser()).status).toBe(401);
    expect(realUserIds()).toEqual([]);
    expect(githubAccounts()).toEqual([]);
  });
});
