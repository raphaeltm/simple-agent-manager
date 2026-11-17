/**
 * "Connect GitHub" for an account that signed in by email, end to end: the production
 * `/api/auth` routes, the real better-auth `/link-social` flow and OAuth callback, and a real
 * SQL engine. Only GitHub is faked, at the network boundary.
 *
 * The account must afterwards pass the workspace git-token user check, which reads the user's
 * own GitHub token through `getGitHubUserAccessTokenForOwner` (unchanged by this feature).
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { githubUserTokenUnavailableError } from '../../src/services/github-token-errors';
import { getGitHubUserAccessTokenForOwner } from '../../src/services/github-user-access-token';
import { __resetPlatformConfigCacheForTest } from '../../src/services/platform-config';
import { createSessionCookieForUser } from '../../src/services/session-factory';
import { buildAuthApp } from '../helpers/oauth-sign-in';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../helpers/sqlite-d1';

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
      if (url.pathname === '/user')
        return Response.json({
          ...GITHUB_USER,
          email: state.sameEmail ? SAM_EMAIL : GITHUB_USER.email,
        });
      if (url.pathname === '/user/emails') {
        // An App without "Email addresses: read" gets 403 here (seen on the self-hosted box).
        return state.emailsForbidden
          ? Response.json({ message: 'Resource not accessible by integration' }, { status: 403 })
          : Response.json(
              state.sameEmail
                ? [{ email: SAM_EMAIL, primary: true, verified: true }]
                : GITHUB_EMAILS
            );
      }
    }
    throw new Error(`Unexpected outbound request: ${request.method} ${request.url}`);
  }

  const state = { emailsForbidden: false, sameEmail: false };
  return { approve, fetch: fetchImpl, issuedTokens, state };
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
  const app = buildAuthApp();
  let sent: Array<{ to: string; subject: string; text: string }>;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sent = [];
    env = {
      KV: createMemoryKv(),
      AGENT_EMAIL: {
        async send(message: { to: string; subject: string; text: string }) {
          sent.push(message);
          return { messageId: 'test-message' };
        },
      },
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
      VALUES ('installation-owner', 'owner@example.com', 1, 'Owner', 'superadmin', 'active', 1, 1)`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO users (id, email, email_verified, name, role, status, created_at, updated_at)
         VALUES ('email-user', ?, 1, 'raphael', 'user', 'active', 1, 1)`
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

  async function proof(cookie: string, provider = 'github'): Promise<string> {
    const response = await app.request(
      `${API_ORIGIN}/api/auth/account-link/request`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP_ORIGIN, cookie },
        body: JSON.stringify({ provider }),
      },
      env
    );
    expect(response.status, response.status === 200 ? '' : await response.clone().text()).toBe(200);
    const message = sent.at(-1);
    expect(message?.to).toBe(SAM_EMAIL);
    const url = new URL(/https:\/\/[^\s]+/.exec(message?.text ?? '')?.[0] ?? '');
    const token = new URLSearchParams(url.hash.slice(1)).get('linkToken');
    expect(token).toBeTruthy();
    return token!;
  }

  async function startLink(
    cookie: string,
    token?: string,
    additionalData: Record<string, unknown> = {}
  ): Promise<Response> {
    return app.request(
      `${API_ORIGIN}/api/auth/link-social`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP_ORIGIN, cookie },
        body: JSON.stringify({
          provider: 'github',
          callbackURL: RETURN_TO,
          additionalData: { ...additionalData, samLinkToken: token },
        }),
      },
      env
    );
  }

  async function completeLink(cookie: string): Promise<Response> {
    const start = await startLink(cookie, await proof(cookie));
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
    await vi.waitFor(() =>
      expect(
        sent.some((mail) => mail.subject.includes('connected') || mail.subject.includes('linked'))
      ).toBe(true)
    );
    expect(sent.every((mail) => mail.to === SAM_EMAIL)).toBe(true);
    expect(githubLinks()).toEqual([{ account_id: '777', user_id: 'email-user' }]);
    const user = sqlite
      .prepare(`SELECT email, email_verified AS verified FROM users WHERE id = 'email-user'`)
      .get() as { email: string; verified: number };
    expect(user).toEqual({ email: SAM_EMAIL, verified: 1 });
    // No second user was created for the GitHub identity.
    expect((sqlite.prepare(`SELECT count(*) AS n FROM users`).get() as { n: number }).n).toBe(2);

    // After: the owner-token lookup the git-token check uses returns the linked token.
    const token = await getGitHubUserAccessTokenForOwner(env, 'email-user', 'git-token-test');
    expect(token).not.toBeNull();
    expect(github.issuedTokens.has(token ?? '')).toBe(true);
  });

  async function signInWithGitHub(): Promise<Response> {
    const start = await app.request(
      `${API_ORIGIN}/api/auth/sign-in/social`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP_ORIGIN },
        body: JSON.stringify({ provider: 'github', callbackURL: RETURN_TO }),
      },
      env
    );
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    const authorizeUrl = new URL(url);
    const callback = new URL(GITHUB_REDIRECT_URI);
    callback.searchParams.set('code', github.approve(authorizeUrl));
    callback.searchParams.set('state', authorizeUrl.searchParams.get('state') ?? '');
    return app.request(callback.toString(), { headers: { cookie: cookieHeader(start) } }, env);
  }

  function emailUser() {
    return sqlite
      .prepare(`SELECT email, email_verified AS verified FROM users WHERE id = 'email-user'`)
      .get() as { email: string; verified: number };
  }

  it.each([
    ['GitHub reports a verified primary email', false],
    ["GitHub's emails call is refused (App without Email addresses: read)", true],
  ])(
    'a later GitHub sign-in keeps the SAM email and its verification: %s',
    async (_label, emailsForbidden) => {
      const { sessionCookie } = await createSessionCookieForUser(env, 'email-user');
      expect((await completeLink(sessionCookie)).status).toBe(302);

      github.state.emailsForbidden = emailsForbidden;
      const callback = await signInWithGitHub();
      expect(callback.status).toBe(302);
      expect(callback.headers.get('location')).toBe(RETURN_TO);
      // The same account, still with its own verified address, so email codes keep working.
      const sessionUsers = sqlite.prepare(`SELECT DISTINCT user_id FROM sessions`).all();
      expect(sessionUsers).toEqual([{ user_id: 'email-user' }]);
      expect(emailUser()).toEqual({ email: SAM_EMAIL, verified: 1 });
      expect((sqlite.prepare(`SELECT count(*) AS n FROM users`).get() as { n: number }).n).toBe(2);
    }
  );

  it.each(['google', 'gitlab-typo', ''])('refuses to link provider %j', async (provider) => {
    const { sessionCookie } = await createSessionCookieForUser(env, 'email-user');
    const response = await app.request(
      `${API_ORIGIN}/api/auth/link-social`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP_ORIGIN, cookie: sessionCookie },
        body: JSON.stringify({ provider, callbackURL: RETURN_TO }),
      },
      env
    );
    expect(response.status).toBe(400);
  });

  it('refuses to link from an agent sign-in session (it may only read its session or sign out)', async () => {
    const { sessionCookie } = await createSessionCookieForUser(env, 'email-user');
    sqlite.prepare('UPDATE sessions SET hard_expires_at = ?').run(Date.now() + 3_600_000);
    const response = await startLink(sessionCookie);
    expect(response.status).toBe(403);
    expect(githubLinks()).toEqual([]);

    // Control: the same session without the cap may start the link.
    sqlite.prepare('UPDATE sessions SET hard_expires_at = NULL').run();
    expect((await startLink(sessionCookie, await proof(sessionCookie))).status).toBe(200);
  });

  it('refuses the GitHub callback when it arrives with an agent sign-in session', async () => {
    const { sessionCookie } = await createSessionCookieForUser(env, 'email-user');
    const start = await startLink(sessionCookie, await proof(sessionCookie));
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    const authorizeUrl = new URL(url);
    const callback = new URL(GITHUB_REDIRECT_URI);
    callback.searchParams.set('code', github.approve(authorizeUrl));
    callback.searchParams.set('state', authorizeUrl.searchParams.get('state') ?? '');
    // The session becomes an agent session between the start and the callback.
    sqlite.prepare('UPDATE sessions SET hard_expires_at = ?').run(Date.now() + 3_600_000);
    const response = await app.request(
      callback.toString(),
      { headers: { cookie: [sessionCookie, cookieHeader(start)].join('; ') } },
      env
    );
    expect(response.status).toBe(403);
    expect(githubLinks()).toEqual([]);
  });

  it('refuses to start a link without a signed-in session', async () => {
    const response = await startLink('');
    expect(response.status).toBe(403);
    expect(githubLinks()).toEqual([]);
  });

  it('refuses a freshly stolen session and forged server context without email proof', async () => {
    const { sessionCookie } = await createSessionCookieForUser(env, 'email-user');
    const response = await startLink(sessionCookie, undefined, {
      samAccountLink: { userId: 'email-user', provider: 'github', expiresAt: Date.now() + 300000 },
      serverContext: { samAccountLink: { userId: 'email-user' } },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'LINK_STEP_UP_REQUIRED' });
    expect(githubLinks()).toEqual([]);
    expect(github.issuedTokens.size).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('consumes email proof once and refuses a replay', async () => {
    const { sessionCookie } = await createSessionCookieForUser(env, 'email-user');
    const token = await proof(sessionCookie);
    expect((await startLink(sessionCookie, token)).status).toBe(200);
    expect((await startLink(sessionCookie, token)).status).toBe(403);
  });

  it('uses the admin TTL override for persisted proof expiry and actual redemption', async () => {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS admin_settings_revision (singleton INTEGER PRIMARY KEY, revision INTEGER NOT NULL, mutation_id TEXT NOT NULL);
      INSERT OR IGNORE INTO admin_settings_revision VALUES (1, 1, '');
      CREATE TABLE IF NOT EXISTS admin_settings_audit (id TEXT PRIMARY KEY, name TEXT, action TEXT, actor_user_id TEXT, created_at TEXT, revision INTEGER);`);
    sqlite
      .prepare(
        'INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, NULL)'
      )
      .run('security.accountLinkProofTtlSeconds', '60', new Date().toISOString());
    const { sessionCookie } = await createSessionCookieForUser(env, 'email-user');
    const before = Date.now();
    const token = await proof(sessionCookie);
    const row = sqlite
      .prepare("SELECT expires_at FROM verifications WHERE identifier LIKE 'account-link:%'")
      .get() as { expires_at: number };
    expect(row.expires_at - before).toBeGreaterThanOrEqual(60000);
    expect(row.expires_at - before).toBeLessThan(62000);
    expect(sent.at(-1)?.text).toContain('expires in 1 minutes');
    vi.spyOn(Date, 'now').mockReturnValue(row.expires_at + 1);
    try {
      expect((await startLink(sessionCookie, token)).status).toBe(403);
      expect(githubLinks()).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('refuses expired email proof before starting OAuth', async () => {
    const { sessionCookie } = await createSessionCookieForUser(env, 'email-user');
    const token = await proof(sessionCookie);
    sqlite
      .prepare("UPDATE verifications SET expires_at = ? WHERE identifier LIKE 'account-link:%'")
      .run(Date.now() - 1);
    expect((await startLink(sessionCookie, token)).status).toBe(403);
    expect(githubLinks()).toEqual([]);
  });

  it('binds proof to its requesting session without burning it for another session', async () => {
    const first = await createSessionCookieForUser(env, 'email-user');
    const second = await createSessionCookieForUser(env, 'email-user');
    const token = await proof(first.sessionCookie);
    expect((await startLink(second.sessionCookie, token)).status).toBe(403);
    expect((await startLink(first.sessionCookie, token)).status).toBe(200);
  });

  it.each(['revoked', 'changed', 'expired-proof'] as const)(
    'refuses callback with %s session or proof and leaves accounts unchanged',
    async (mode) => {
      const { sessionCookie } = await createSessionCookieForUser(env, 'email-user');
      const start = await startLink(sessionCookie, await proof(sessionCookie));
      expect(start.status).toBe(200);
      const authorize = new URL(((await start.json()) as { url: string }).url);
      const callback = new URL(GITHUB_REDIRECT_URI);
      callback.searchParams.set('code', github.approve(authorize));
      callback.searchParams.set('state', authorize.searchParams.get('state')!);
      let callbackCookie = sessionCookie;
      if (mode === 'revoked')
        sqlite.prepare("DELETE FROM sessions WHERE user_id = 'email-user'").run();
      if (mode === 'changed')
        callbackCookie = (await createSessionCookieForUser(env, 'email-user')).sessionCookie;
      if (mode === 'expired-proof') {
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 301000);
      }
      try {
        const response = await app.request(
          callback.toString(),
          {
            headers: { cookie: [callbackCookie, cookieHeader(start)].join('; ') },
          },
          env
        );
        expect(response.headers.get('location')).not.toBe(RETURN_TO);
        expect(githubLinks()).toEqual([]);
      } finally {
        vi.restoreAllMocks();
      }
    }
  );

  it('disconnects the last GitHub link when verified email sign-in remains', async () => {
    const { sessionCookie } = await createSessionCookieForUser(env, 'email-user');
    expect((await completeLink(sessionCookie)).headers.get('location')).toBe(RETURN_TO);
    const account = sqlite
      .prepare("SELECT id FROM accounts WHERE user_id = 'email-user'")
      .get() as { id: string };
    const response = await app.request(
      `${API_ORIGIN}/api/auth/unlink-account`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP_ORIGIN, cookie: sessionCookie },
        body: JSON.stringify({ providerId: 'github', accountId: account.id }),
      },
      env
    );
    expect(response.status).toBe(200);
    expect(githubLinks()).toEqual([]);
    expect(emailUser()).toEqual({ email: SAM_EMAIL, verified: 1 });
  });

  it('refuses disconnecting the last provider when the account email is unverified', async () => {
    const { sessionCookie } = await createSessionCookieForUser(env, 'email-user');
    expect((await completeLink(sessionCookie)).headers.get('location')).toBe(RETURN_TO);
    const account = sqlite
      .prepare("SELECT id FROM accounts WHERE user_id = 'email-user'")
      .get() as { id: string };
    sqlite.prepare("UPDATE users SET email_verified = 0 WHERE id = 'email-user'").run();
    const response = await app.request(
      `${API_ORIGIN}/api/auth/unlink-account`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP_ORIGIN, cookie: sessionCookie },
        body: JSON.stringify({ providerId: 'github', accountId: account.id }),
      },
      env
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'LAST_SIGN_IN_METHOD' });
    expect(githubLinks()).toHaveLength(1);
  });

  it.each([false, true])(
    'concurrent disconnects require a usable email sign-in (verified=%s)',
    async (verified) => {
      const { sessionCookie } = await createSessionCookieForUser(env, 'email-user');
      sqlite
        .prepare(
          `INSERT INTO accounts (id, account_id, provider_id, user_id, created_at, updated_at)
      VALUES ('github-concurrent', '777', 'github', 'email-user', 1, 1),
             ('gitlab-concurrent', '888', 'gitlab', 'email-user', 1, 1)`
        )
        .run();
      sqlite
        .prepare("UPDATE users SET email_verified = ? WHERE id = 'email-user'")
        .run(verified ? 1 : 0);
      const responses = await Promise.all(
        ['github', 'gitlab'].map((provider) =>
          app.request(
            `${API_ORIGIN}/api/auth/unlink-account`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                origin: APP_ORIGIN,
                cookie: sessionCookie,
              },
              body: JSON.stringify({ providerId: provider, accountId: `${provider}-concurrent` }),
            },
            env
          )
        )
      );
      expect(responses.map((response) => response.status)).toEqual(
        verified ? [200, 200] : [400, 400]
      );
      expect(
        (
          sqlite
            .prepare("SELECT count(*) AS n FROM accounts WHERE user_id = 'email-user'")
            .get() as { n: number }
        ).n
      ).toBe(verified ? 0 : 2);
    }
  );

  it('refuses confirmation requests from another origin without sending email', async () => {
    const { sessionCookie } = await createSessionCookieForUser(env, 'email-user');
    const response = await app.request(
      `${API_ORIGIN}/api/auth/account-link/request`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://attacker.example.org',
          cookie: sessionCookie,
        },
        body: JSON.stringify({ provider: 'github' }),
      },
      env
    );
    expect(response.status).toBe(403);
    expect(sent).toHaveLength(0);
    expect(
      (sqlite.prepare('SELECT count(*) AS n FROM verifications').get() as { n: number }).n
    ).toBe(0);
    expect(await proof(sessionCookie)).toBeTruthy();
  });

  it('updates an existing link only after another email confirmation', async () => {
    const { sessionCookie } = await createSessionCookieForUser(env, 'email-user');
    expect((await completeLink(sessionCookie)).headers.get('location')).toBe(RETURN_TO);
    const before = await getGitHubUserAccessTokenForOwner(env, 'email-user');
    expect((await startLink(sessionCookie)).status).toBe(403);
    expect(await getGitHubUserAccessTokenForOwner(env, 'email-user')).toBe(before);
    expect((await completeLink(sessionCookie)).headers.get('location')).toBe(RETURN_TO);
    expect(await getGitHubUserAccessTokenForOwner(env, 'email-user')).not.toBe(before);
    expect(githubLinks()).toHaveLength(1);
  });

  it.each(['unauthenticated', 'suspended', 'agent'] as const)(
    'proof issuance refuses %s with designed403',
    async (kind) => {
      let cookie = '';
      if (kind !== 'unauthenticated')
        cookie = (await createSessionCookieForUser(env, 'email-user')).sessionCookie;
      if (kind === 'suspended')
        sqlite.prepare("UPDATE users SET status = 'suspended' WHERE id = 'email-user'").run();
      if (kind === 'agent')
        sqlite
          .prepare("UPDATE sessions SET hard_expires_at = ? WHERE user_id = 'email-user'")
          .run(Date.now() + 60000);
      const response = await app.request(
        `${API_ORIGIN}/api/auth/account-link/request`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: APP_ORIGIN, cookie },
          body: JSON.stringify({ provider: 'github' }),
        },
        env
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: expect.any(String) });
      expect(sent).toHaveLength(0);
    }
  );

  it('returning same-email GitHub profile with forbidden email verification preserves verified owner identity', async () => {
    const { sessionCookie } = await createSessionCookieForUser(env, 'email-user');
    expect((await completeLink(sessionCookie)).headers.get('location')).toBe(RETURN_TO);
    github.state.sameEmail = true;
    github.state.emailsForbidden = true;
    expect((await signInWithGitHub()).headers.get('location')).toBe(RETURN_TO);
    expect(emailUser()).toEqual({ email: SAM_EMAIL, verified: 1 });
    expect(githubLinks()).toEqual([{ account_id: '777', user_id: 'email-user' }]);
  });

  it('refuses implicit same-email GitHub linking during ordinary social sign-in', async () => {
    github.state.sameEmail = true;
    const response = await signInWithGitHub();
    expect(response.headers.get('location')).not.toBe(RETURN_TO);
    expect(githubLinks()).toEqual([]);
    expect(emailUser()).toEqual({ email: SAM_EMAIL, verified: 1 });
    expect(
      (
        sqlite.prepare("SELECT count(*) AS n FROM sessions WHERE user_id = 'email-user'").get() as {
          n: number;
        }
      ).n
    ).toBe(0);
  });

  it('refuses implicit same-email Google linking during ordinary social sign-in', async () => {
    env.GOOGLE_LOGIN_CLIENT_ID = 'google-test-client';
    env.GOOGLE_LOGIN_CLIENT_SECRET = 'google-test-secret';
    __resetPlatformConfigCacheForTest();
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe('https://oauth2.googleapis.com/token');
      // Token endpoint is the trusted external boundary; Google user info is decoded from its returned id_token.
      const jwt = [
        Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
        Buffer.from(
          JSON.stringify({
            sub: 'google-777',
            email: SAM_EMAIL,
            email_verified: true,
            name: 'Google claimant',
          })
        ).toString('base64url'),
        'fixture',
      ].join('.');
      return Response.json({ access_token: 'google-fixture', token_type: 'Bearer', id_token: jwt });
    });
    vi.stubGlobal('fetch', fetch);
    const start = await app.request(
      `${API_ORIGIN}/api/auth/sign-in/social`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP_ORIGIN },
        body: JSON.stringify({ provider: 'google', callbackURL: RETURN_TO }),
      },
      env
    );
    expect(start.status).toBe(200);
    const authorize = new URL(((await start.json()) as { url: string }).url);
    const callback = new URL(`${API_ORIGIN}/api/auth/callback/google`);
    callback.searchParams.set('state', authorize.searchParams.get('state')!);
    callback.searchParams.set('code', 'google-approved');
    const response = await app.request(
      callback.toString(),
      { headers: { cookie: cookieHeader(start) } },
      env
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(response.headers.get('location')).not.toBe(RETURN_TO);
    expect(sqlite.prepare("SELECT id FROM accounts WHERE user_id = 'email-user'").all()).toEqual(
      []
    );
    expect(emailUser()).toEqual({ email: SAM_EMAIL, verified: 1 });
  });

  function enableGitLab() {
    env.GITLAB_HOST = 'https://gitlab.com';
    env.GITLAB_CLIENT_ID = CLIENT_ID;
    env.GITLAB_CLIENT_SECRET = CLIENT_SECRET;
    __resetPlatformConfigCacheForTest();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.origin !== 'https://gitlab.com') return github.fetch(input, init);
      if (url.pathname === '/oauth/token') {
        const form = new URLSearchParams(await req.text());
        expect(form.get('redirect_uri')).toBe(`${API_ORIGIN}/api/auth/callback/gitlab`);
        return Response.json({
          access_token: 'gitlab-test-token',
          token_type: 'Bearer',
          scope: 'read_user',
        });
      }
      if (url.pathname === '/api/v4/user') {
        expect(req.headers.get('authorization')).toBe('Bearer gitlab-test-token');
        return Response.json({
          id: 888,
          username: 'octolab',
          name: 'Octolab',
          email: 'different@example.org',
          email_verified: true,
          avatar_url: null,
          state: 'active',
          locked: false,
        });
      }
      throw new Error('Unexpected GitLab request');
    });
  }

  it('links GitLab with a different email through static callback and preserves owner email', async () => {
    enableGitLab();
    const { sessionCookie } = await createSessionCookieForUser(env, 'email-user');
    const token = await proof(sessionCookie, 'gitlab');
    const start = await app.request(
      `${API_ORIGIN}/api/auth/link-social`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP_ORIGIN, cookie: sessionCookie },
        body: JSON.stringify({
          provider: 'gitlab',
          callbackURL: RETURN_TO,
          additionalData: { samLinkToken: token },
        }),
      },
      env
    );
    expect(start.status).toBe(200);
    const authorize = new URL(((await start.json()) as { url: string }).url);
    expect(authorize.origin + authorize.pathname).toBe('https://gitlab.com/oauth/authorize');
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      `${API_ORIGIN}/api/auth/callback/gitlab`
    );
    const callback = new URL(`${API_ORIGIN}/api/auth/callback/gitlab`);
    callback.searchParams.set('state', authorize.searchParams.get('state')!);
    callback.searchParams.set('code', 'approved-code');
    const response = await app.request(
      callback.toString(),
      { headers: { cookie: [sessionCookie, cookieHeader(start)].join('; ') } },
      env
    );
    expect(response.headers.get('location')).toBe(RETURN_TO);
    expect(
      sqlite.prepare("SELECT user_id FROM accounts WHERE provider_id = 'gitlab'").all()
    ).toEqual([{ user_id: 'email-user' }]);
    expect(emailUser()).toEqual({ email: SAM_EMAIL, verified: 1 });
  });

  it('rejects swapping the callback provider after confirming GitHub', async () => {
    enableGitLab();
    const { sessionCookie } = await createSessionCookieForUser(env, 'email-user');
    const start = await startLink(sessionCookie, await proof(sessionCookie));
    const authorize = new URL(((await start.json()) as { url: string }).url);
    const callback = new URL(`${API_ORIGIN}/api/auth/callback/gitlab`);
    callback.searchParams.set('state', authorize.searchParams.get('state')!);
    callback.searchParams.set('code', 'approved-code');
    const response = await app.request(
      callback.toString(),
      { headers: { cookie: [sessionCookie, cookieHeader(start)].join('; ') } },
      env
    );
    expect(response.headers.get('location')).not.toBe(RETURN_TO);
    expect(sqlite.prepare("SELECT id FROM accounts WHERE user_id = 'email-user'").all()).toEqual(
      []
    );
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
