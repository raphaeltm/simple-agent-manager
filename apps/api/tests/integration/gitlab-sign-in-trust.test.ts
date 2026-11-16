/**
 * Which GitLab hosts may vouch for an email, end to end: the production `/api/auth` routes,
 * the real better-auth handler, and a real SQL engine. Only GitLab is faked, at the network
 * boundary.
 *
 * Why this exists: on 2026-11-12 a caller completed first-run setup with a self-managed GitLab
 * host it controlled, then signed in through it claiming the owner's email with
 * `email_verified: true`. better-auth links a sign-in to the existing user with that email when
 * the provider is trusted OR says the email is verified, so the fake host became the superadmin.
 * A self-managed host saved at runtime may now neither link nor rewrite a profile; gitlab.com
 * and a host the deployer pinned in the Worker environment keep doing both.
 */
import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { getBetterAuthAccessTokenForProvider } from '../../src/services/better-auth-access-token';
import { generateEncryptionKey } from '../../src/services/encryption';
import {
  __resetPlatformConfigCacheForTest,
  completeSetupWithConfig,
} from '../../src/services/platform-config';
import {
  buildAuthApp,
  type CookieJar,
  createCookieJar,
  startSocialSignIn,
} from '../helpers/oauth-sign-in';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../helpers/sqlite-d1';

const API_ORIGIN = 'https://api.example.com';
const APP_ORIGIN = 'https://app.example.com';
const CALLBACK_URL = `${APP_ORIGIN}/dashboard`;
const GITLAB_REDIRECT_URI = `${API_ORIGIN}/api/auth/callback/gitlab`;
const CLIENT_ID = 'gitlab-client-id';
const CLIENT_SECRET = 'gitlab-client-secret';
const SELF_MANAGED_HOST = 'https://gitlab.selfhosted.example';
const PUBLIC_HOST = 'https://gitlab.com';

const OWNER = {
  id: 'owner-1',
  email: 'owner@example.com',
  name: 'Real Owner',
  image: 'https://avatars.githubusercontent.com/u/1',
};

/**
 * A GitLab host that answers for whichever email the test chooses, the way a host its operator
 * controls can. It enforces the OAuth parts better-auth relies on.
 */
function createFakeGitLab(host: string, profile: Record<string, unknown>) {
  const issuedTokens = new Set<string>();
  const outboundRequests: string[] = [];

  async function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    outboundRequests.push(`${request.method} ${url.origin}${url.pathname}`);
    if (url.origin !== host) throw new Error(`Unexpected outbound request: ${request.url}`);

    if (request.method === 'POST' && url.pathname === '/oauth/token') {
      const form = new URLSearchParams(await request.text());
      const basic = request.headers.get('authorization')?.match(/^Basic (.+)$/i)?.[1];
      const [basicId, basicSecret] = basic ? atob(basic).split(':') : [];
      if ((form.get('client_id') ?? basicId) !== CLIENT_ID) {
        return Response.json({ error: 'invalid_client' }, { status: 401 });
      }
      if ((form.get('client_secret') ?? basicSecret) !== CLIENT_SECRET) {
        return Response.json({ error: 'invalid_client' }, { status: 401 });
      }
      if (form.get('redirect_uri') !== GITLAB_REDIRECT_URI) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      const accessToken = `glpat-test-${issuedTokens.size + 1}`;
      issuedTokens.add(accessToken);
      return Response.json({ access_token: accessToken, token_type: 'Bearer', scope: 'read_user' });
    }
    if (request.method === 'GET' && url.pathname === '/api/v4/user') {
      const token = request.headers.get('authorization')?.replace(/^Bearer /i, '') ?? '';
      if (!issuedTokens.has(token)) return Response.json({}, { status: 401 });
      return Response.json(profile);
    }
    throw new Error(`Unexpected outbound request: ${request.method} ${request.url}`);
  }

  return { fetch, outboundRequests };
}

/** The GitLab user profile the host returns: it claims the owner's email, verified. */
function profileClaiming(email: string) {
  return {
    id: 424242,
    username: 'claimant',
    name: 'Claimant',
    email,
    email_verified: true,
    avatar_url: 'https://gitlab.selfhosted.example/avatar.png',
    state: 'active',
    locked: false,
  };
}

describe('GitLab sign-in trust by identity host (vertical slice)', () => {
  let sqlite: Database.Database;
  let jar: CookieJar;
  const app = buildAuthApp();

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(
      readFileSync(
        new URL('../../src/db/migrations/0196_admin_settings.sql', import.meta.url),
        'utf8'
      )
    );
    // The owner as production stores them: a verified email and a linked GitHub account.
    const createdAt = Date.parse('2026-02-15T12:12:03Z');
    sqlite
      .prepare(
        `INSERT INTO users (id, email, email_verified, name, image, role, status, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, 'superadmin', 'active', ?, ?)`
      )
      .run(OWNER.id, OWNER.email, OWNER.name, OWNER.image, createdAt, createdAt);
    sqlite
      .prepare(
        `INSERT INTO accounts (id, account_id, provider_id, user_id, scope, created_at, updated_at)
         VALUES ('owner-github', '910895', 'github', ?, 'read:user,user:email,read:org', ?, ?)`
      )
      .run(OWNER.id, createdAt, createdAt);
    __resetPlatformConfigCacheForTest();
    jar = createCookieJar();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sqlite.close();
  });

  function baseEnv(overrides: Partial<Env> = {}): Env {
    return {
      DATABASE: createSqliteD1(sqlite),
      KV: createMemoryKv(),
      BASE_DOMAIN: 'example.com',
      ENCRYPTION_KEY: generateEncryptionKey(),
      ...overrides,
    } as Env;
  }

  /** The provider stored the way first-run setup and Admin → Integrations store it. */
  async function runtimeGitLabEnv(host: string, overrides: Partial<Env> = {}): Promise<Env> {
    const env = baseEnv(overrides);
    await completeSetupWithConfig(env, {
      gitlab: { host, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    });
    __resetPlatformConfigCacheForTest();
    return env;
  }

  /** Browser: click "Sign in with GitLab", approve on the host, land back on the callback. */
  async function signInWithGitLab(env: Env, host: string): Promise<Response> {
    const authorizeUrl = await startSocialSignIn(app, env, jar, {
      apiOrigin: API_ORIGIN,
      appOrigin: APP_ORIGIN,
      provider: 'gitlab',
      callbackURL: CALLBACK_URL,
    });
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(`${host}/oauth/authorize`);

    const callback = new URL(GITLAB_REDIRECT_URI);
    callback.searchParams.set('code', 'approved-code');
    callback.searchParams.set('state', authorizeUrl.searchParams.get('state') ?? '');
    const response = await app.request(
      callback.toString(),
      { headers: { cookie: jar.header() } },
      env
    );
    jar.store(response);
    return response;
  }

  async function currentUserId(env: Env): Promise<string | null> {
    const me = await app.request(
      `${API_ORIGIN}/api/auth/me`,
      { headers: { cookie: jar.header() } },
      env
    );
    return me.status === 200 ? ((await me.json()) as { id: string }).id : null;
  }

  const gitlabAccounts = () =>
    sqlite
      .prepare(`SELECT account_id, user_id FROM accounts WHERE provider_id = 'gitlab'`)
      .all() as Array<{ account_id: string; user_id: string }>;
  const ownerSessions = () =>
    (
      sqlite.prepare(`SELECT count(*) AS n FROM sessions WHERE user_id = ?`).get(OWNER.id) as {
        n: number;
      }
    ).n;
  const ownerProfile = () =>
    sqlite.prepare(`SELECT name, image FROM users WHERE id = ?`).get(OWNER.id) as {
      name: string;
      image: string;
    };

  it.each(['https://127.0.0.1', 'https://10.0.0.2', 'https://metadata.google.internal'])(
    'refuses private GitLab %s before browser authorization',
    async (host) => {
      const env = baseEnv({
        GITLAB_HOST: host,
        GITLAB_CLIENT_ID: CLIENT_ID,
        GITLAB_CLIENT_SECRET: CLIENT_SECRET,
      } as Partial<Env>);
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const response = await app.request(
        `${API_ORIGIN}/api/auth/sign-in/social`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: APP_ORIGIN },
          body: JSON.stringify({ provider: 'gitlab', callbackURL: CALLBACK_URL }),
        },
        env
      );
      expect(response.status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('uses outbound.maxRedirects default through the real resolver for profile hops', async () => {
    const env = await runtimeGitLabEnv(PUBLIC_HOST);
    const gitlab = createFakeGitLab(PUBLIC_HOST, profileClaiming(OWNER.email));
    let profileCalls = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/oauth/token') return gitlab.fetch(input, init);
      profileCalls++;
      return new Response(null, { status: 307, headers: { location: `${PUBLIC_HOST}/loop` } });
    });
    const callback = await signInWithGitLab(env, PUBLIC_HOST);
    expect(callback.headers.get('location')).toContain('error=');
    expect(profileCalls).toBe(4); // original + default three allowed hops
    expect(gitlabAccounts()).toEqual([]);
  });

  it('profile redirects drop Authorization before the cross-origin hop', async () => {
    const env = await runtimeGitLabEnv(PUBLIC_HOST);
    const gitlab = createFakeGitLab(PUBLIC_HOST, profileClaiming(OWNER.email));
    const requests: Request[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url === `${PUBLIC_HOST}/api/v4/user`)
        return new Response(null, {
          status: 302,
          headers: { location: 'https://profile.example/user' },
        });
      if (request.url === 'https://profile.example/user') {
        expect(request.headers.get('authorization')).toBeNull();
        expect(request.redirect).toBe('manual');
        return Response.json(profileClaiming(OWNER.email));
      }
      return gitlab.fetch(input, init);
    });
    const callback = await signInWithGitLab(env, PUBLIC_HOST);
    expect(callback.headers.get('location')).toBe(CALLBACK_URL);
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
      '/oauth/token',
      '/api/v4/user',
      '/user',
    ]);
    expect(gitlabAccounts()).toEqual([{ account_id: '424242', user_id: OWNER.id }]);
  });

  it('BetterAuth code exchange refuses 307 without replaying the client secret', async () => {
    const env = await runtimeGitLabEnv(PUBLIC_HOST);
    const requests: Request[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      expect(request.redirect).toBe('manual');
      return new Response(null, {
        status: 307,
        headers: { location: 'https://unvetted.example/token' },
      });
    });
    const callback = await signInWithGitLab(env, PUBLIC_HOST);
    expect(callback.headers.get('location')).toContain('error=');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${PUBLIC_HOST}/oauth/token`);
    expect(gitlabAccounts()).toEqual([]);
    expect(ownerSessions()).toBe(0);
  });

  it.each([200, 307])('BetterAuth refresh handles %s using manual token fetch', async (status) => {
    const env = await runtimeGitLabEnv(PUBLIC_HOST);
    vi.stubGlobal('fetch', createFakeGitLab(PUBLIC_HOST, profileClaiming(OWNER.email)).fetch);
    await signInWithGitLab(env, PUBLIC_HOST);
    const now = Date.now();
    sqlite
      .prepare(
        "UPDATE accounts SET access_token = 'expired', refresh_token = 'refresh-secret', access_token_expires_at = ? WHERE provider_id = 'gitlab'"
      )
      .run(now - 60_000);
    const requests: Request[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      expect(request.redirect).toBe('manual');
      if (status === 307)
        return new Response(null, {
          status: 307,
          headers: { location: 'https://unvetted.example/token' },
        });
      return Response.json({
        access_token: 'refreshed',
        refresh_token: 'rotated',
        expires_in: 3600,
        token_type: 'Bearer',
      });
    });
    const refresh = getBetterAuthAccessTokenForProvider(
      env,
      new Headers({ cookie: jar.header() }),
      OWNER.id,
      'gitlab'
    );
    if (status === 200) await expect(refresh).resolves.toMatchObject({ accessToken: 'refreshed' });
    else await expect(refresh).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${PUBLIC_HOST}/oauth/token`);
  });

  it('refuses a runtime self-managed host that claims the owner’s verified email (2026-11-12)', async () => {
    const env = await runtimeGitLabEnv(SELF_MANAGED_HOST);
    const gitlab = createFakeGitLab(SELF_MANAGED_HOST, profileClaiming(OWNER.email));
    vi.stubGlobal('fetch', gitlab.fetch);

    const callback = await signInWithGitLab(env, SELF_MANAGED_HOST);

    // The host was really asked: the refusal is SAM's, not a broken exchange.
    expect(gitlab.outboundRequests).toEqual([
      `POST ${SELF_MANAGED_HOST}/oauth/token`,
      `GET ${SELF_MANAGED_HOST}/api/v4/user`,
    ]);
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toMatch(/[?&]error=account_not_linked\b/);
    expect(await currentUserId(env)).toBeNull();
    expect(gitlabAccounts()).toEqual([]);
    expect(ownerSessions()).toBe(0);
    expect(ownerProfile()).toEqual({ name: OWNER.name, image: OWNER.image });
  });

  it('gives a new user from a runtime self-managed host an unverified email', async () => {
    const env = await runtimeGitLabEnv(SELF_MANAGED_HOST);
    vi.stubGlobal(
      'fetch',
      createFakeGitLab(SELF_MANAGED_HOST, profileClaiming('new@example.com')).fetch
    );

    await signInWithGitLab(env, SELF_MANAGED_HOST);

    const created = sqlite
      .prepare(`SELECT email_verified FROM users WHERE email = 'new@example.com'`)
      .get() as { email_verified: number } | undefined;
    expect(created).toEqual({ email_verified: 0 });
    // Stored under a host-scoped key, so the raw id stays free for the gitlab.com user who owns it.
    expect(gitlabAccounts()).toEqual([
      { account_id: `${SELF_MANAGED_HOST}/users/424242`, user_id: expect.any(String) },
    ]);
  });

  it('refuses an untrusted host that claims the GitLab user id the owner linked from gitlab.com', async () => {
    // The owner linked gitlab.com account 424242. GitLab ids are public and better-auth signs an
    // existing account in by provider + id before any email check.
    const createdAt = Date.parse('2026-10-01T00:00:00Z');
    sqlite
      .prepare(
        `INSERT INTO accounts (id, account_id, provider_id, user_id, scope, created_at, updated_at)
         VALUES ('owner-gitlab', '424242', 'gitlab', ?, 'read_user', ?, ?)`
      )
      .run(OWNER.id, createdAt, createdAt);
    const env = await runtimeGitLabEnv(SELF_MANAGED_HOST);
    vi.stubGlobal(
      'fetch',
      createFakeGitLab(SELF_MANAGED_HOST, profileClaiming('attacker@example.com')).fetch
    );

    await signInWithGitLab(env, SELF_MANAGED_HOST);

    expect(await currentUserId(env)).not.toBe(OWNER.id);
    expect(ownerSessions()).toBe(0);
    // The owner's real link is untouched and the host's user lives under its own key.
    expect(gitlabAccounts()).toEqual(
      expect.arrayContaining([
        { account_id: '424242', user_id: OWNER.id },
        { account_id: `${SELF_MANAGED_HOST}/users/424242`, user_id: expect.any(String) },
      ])
    );
    const attacker = sqlite
      .prepare(`SELECT id FROM users WHERE email = 'attacker@example.com'`)
      .get() as { id: string } | undefined;
    expect(attacker?.id).toBeDefined();
    expect(attacker?.id).not.toBe(OWNER.id);
  });

  it('closes better-auth provider-token endpoints over HTTP, even for a signed-in owner', async () => {
    // A signed-in user could otherwise refresh any of their accounts against, or send its token
    // to, whatever GitLab host is configured now. SAM reads tokens only server-side, scoped to
    // the configured host (getBetterAuthAccessTokenForProvider).
    const env = await runtimeGitLabEnv(PUBLIC_HOST);
    vi.stubGlobal('fetch', createFakeGitLab(PUBLIC_HOST, profileClaiming(OWNER.email)).fetch);
    await signInWithGitLab(env, PUBLIC_HOST);
    expect(await currentUserId(env)).toBe(OWNER.id);

    for (const [method, path] of [
      ['POST', '/api/auth/get-access-token'],
      ['POST', '/api/auth/refresh-token'],
      ['GET', '/api/auth/account-info'],
      ['POST', '/api/auth/Get-Access-Token/'],
    ] as const) {
      const res = await app.request(
        `${API_ORIGIN}${path}`,
        {
          method,
          headers: { 'content-type': 'application/json', origin: APP_ORIGIN, cookie: jar.header() },
          ...(method === 'POST' ? { body: JSON.stringify({ providerId: 'gitlab' }) } : {}),
        },
        env
      );
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    // The session itself still works: the refusal is the route, not a broken sign-in.
    expect(await currentUserId(env)).toBe(OWNER.id);
  });

  it('trusts a runtime-saved host that equals the GITLAB_HOST the deployer pinned', async () => {
    const env = await runtimeGitLabEnv(SELF_MANAGED_HOST, {
      GITLAB_HOST: `${SELF_MANAGED_HOST}/`,
    } as Partial<Env>);
    vi.stubGlobal('fetch', createFakeGitLab(SELF_MANAGED_HOST, profileClaiming(OWNER.email)).fetch);

    const callback = await signInWithGitLab(env, SELF_MANAGED_HOST);

    expect(callback.headers.get('location')).toBe(CALLBACK_URL);
    expect(await currentUserId(env)).toBe(OWNER.id);
    expect(gitlabAccounts()).toEqual([{ account_id: '424242', user_id: OWNER.id }]);
  });

  it('still refuses a runtime-saved host that differs from the pinned GITLAB_HOST', async () => {
    const env = await runtimeGitLabEnv(SELF_MANAGED_HOST, {
      GITLAB_HOST: 'https://gitlab.pinned.example',
    } as Partial<Env>);
    vi.stubGlobal('fetch', createFakeGitLab(SELF_MANAGED_HOST, profileClaiming(OWNER.email)).fetch);

    const callback = await signInWithGitLab(env, SELF_MANAGED_HOST);

    expect(callback.headers.get('location')).toMatch(/[?&]error=account_not_linked\b/);
    expect(await currentUserId(env)).toBeNull();
    expect(gitlabAccounts()).toEqual([]);
  });

  it('links gitlab.com to the owner even when it was configured at runtime', async () => {
    const env = await runtimeGitLabEnv(PUBLIC_HOST);
    vi.stubGlobal('fetch', createFakeGitLab(PUBLIC_HOST, profileClaiming(OWNER.email)).fetch);

    const callback = await signInWithGitLab(env, PUBLIC_HOST);

    expect(callback.headers.get('location')).toBe(CALLBACK_URL);
    expect(await currentUserId(env)).toBe(OWNER.id);
    expect(gitlabAccounts()).toEqual([{ account_id: '424242', user_id: OWNER.id }]);
  });

  it('links a self-managed host the deployer pinned in the Worker environment', async () => {
    const env = baseEnv({
      GITLAB_HOST: SELF_MANAGED_HOST,
      GITLAB_CLIENT_ID: CLIENT_ID,
      GITLAB_CLIENT_SECRET: CLIENT_SECRET,
    } as Partial<Env>);
    vi.stubGlobal('fetch', createFakeGitLab(SELF_MANAGED_HOST, profileClaiming(OWNER.email)).fetch);

    const callback = await signInWithGitLab(env, SELF_MANAGED_HOST);

    expect(callback.headers.get('location')).toBe(CALLBACK_URL);
    expect(await currentUserId(env)).toBe(OWNER.id);
    expect(gitlabAccounts()).toEqual([{ account_id: '424242', user_id: OWNER.id }]);
  });

  it('still signs a user linked through that same untrusted host back in', async () => {
    const env = await runtimeGitLabEnv(SELF_MANAGED_HOST);
    const createdAt = Date.parse('2026-10-01T00:00:00Z');
    sqlite
      .prepare(
        `INSERT INTO accounts (id, account_id, provider_id, user_id, scope, created_at, updated_at)
         VALUES ('owner-gitlab', ?, 'gitlab', ?, 'read_user', ?, ?)`
      )
      .run(`${SELF_MANAGED_HOST}/users/424242`, OWNER.id, createdAt, createdAt);
    vi.stubGlobal('fetch', createFakeGitLab(SELF_MANAGED_HOST, profileClaiming(OWNER.email)).fetch);

    const callback = await signInWithGitLab(env, SELF_MANAGED_HOST);

    expect(callback.headers.get('location')).toBe(CALLBACK_URL);
    expect(await currentUserId(env)).toBe(OWNER.id);
    // An untrusted host does not rewrite the profile on sign-in.
    expect(ownerProfile()).toEqual({ name: OWNER.name, image: OWNER.image });
  });
});
