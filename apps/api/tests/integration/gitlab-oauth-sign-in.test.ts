/**
 * GitLab sign-in, end to end (self-host T5 follow-up, item 8): the production `/api/auth`
 * routes, the real better-auth handler and a real SQL engine. Only the network is faked, and
 * the fake follows redirects the way a runtime does unless a request asks for `manual`, so a
 * redirect-following fetch is caught reaching an internal address.
 */
import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { authRoutes } from '../../src/routes/auth';
import {
  __resetAdminSettingsCacheForTest,
  updateAdminSettings,
} from '../../src/services/admin-settings';
import { generateEncryptionKey } from '../../src/services/encryption';
import { __resetPlatformConfigCacheForTest } from '../../src/services/platform-config';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../helpers/sqlite-d1';

const API_ORIGIN = 'https://api.example.com';
const APP_ORIGIN = 'https://app.example.com';
const CALLBACK_URL = `${APP_ORIGIN}/dashboard`;
const REDIRECT_URI = `${API_ORIGIN}/api/auth/callback/gitlab`;
const PUBLIC_HOST = 'https://gitlab.example.com';
const PRIVATE_HOST = 'http://127.0.0.1:8929';
const INTERNAL_URL = 'http://127.0.0.1:7001/v1/state';
const CLIENT_ID = 'gitlab-sam-client';
const CLIENT_SECRET = 'gitlab-sam-client-secret';

const GITLAB_USER = {
  id: 77,
  username: 'dana',
  name: 'Dana Reyes',
  email: 'dana@example.com',
  state: 'active',
  locked: false,
  avatar_url: 'https://gitlab.example.com/uploads/dana.png',
  email_verified: true,
};

interface FakeOptions {
  /** What /api/v4/user answers with. */
  userResponse?: () => Response;
}

/** GitLab and the box's internal services, behind one fetch that follows like a runtime. */
function createFakeNetwork(host: string, options: FakeOptions = {}) {
  const requests: string[] = [];
  const issued = new Set<string>();
  const pending = new Set<string>();

  function approve(authorizeUrl: URL): string {
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(`${host}/oauth/authorize`);
    const code = `code-${pending.size + issued.size + 1}`;
    pending.add(code);
    return code;
  }

  async function answer(request: Request): Promise<Response> {
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.origin}${url.pathname}`);
    if (request.method === 'POST' && url.href === `${host}/oauth/token`) {
      const form = new URLSearchParams(await request.text());
      if (form.get('client_secret') !== CLIENT_SECRET || !pending.delete(form.get('code') ?? '')) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      const token = `glpat-${issued.size + 1}`;
      issued.add(token);
      return Response.json({ access_token: token, token_type: 'bearer', expires_in: 7200 });
    }
    if (request.method === 'GET' && `${url.origin}${url.pathname}` === `${host}/api/v4/user`) {
      const bearer = request.headers.get('authorization')?.replace(/^Bearer /i, '') ?? '';
      if (!issued.has(bearer)) return Response.json({ message: '401' }, { status: 401 });
      return options.userResponse?.() ?? Response.json(GITLAB_USER);
    }
    if (url.origin === 'http://127.0.0.1:7001') return Response.json({ internal: true });
    throw new Error(`Unexpected outbound request: ${request.method} ${request.url}`);
  }

  async function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let request = new Request(input, init);
    for (let hop = 0; hop < 5; hop += 1) {
      const response = await answer(request);
      const location = response.headers.get('location');
      if (request.redirect === 'manual' || !location || response.status < 300) return response;
      request = new Request(new URL(location, request.url), { headers: request.headers });
    }
    throw new Error('redirect loop');
  }

  return { approve, fetch, requests };
}

function createCookieJar() {
  const cookies = new Map<string, string>();
  return {
    store(response: Response) {
      for (const setCookie of response.headers.getSetCookie()) {
        const pair = setCookie.split(';', 1)[0] ?? '';
        const separator = pair.indexOf('=');
        const value = pair.slice(separator + 1).trim();
        if (value === '' || /max-age=0/i.test(setCookie)) cookies.delete(pair.slice(0, separator));
        else cookies.set(pair.slice(0, separator).trim(), value);
      }
    },
    header: () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
  };
}

const app = new Hono<{ Bindings: Env }>();
app.onError(handleAppError);
app.route('/api/auth', authRoutes);

describe('GitLab sign-in through better-auth (vertical slice)', () => {
  let sqlite: Database.Database;
  let jar: ReturnType<typeof createCookieJar>;

  function envFor(host: string): Env {
    return {
      DATABASE: createSqliteD1(sqlite),
      BASE_DOMAIN: 'example.com',
      KV: createMemoryKv(),
      ENCRYPTION_KEY: generateEncryptionKey(),
      GITLAB_HOST: host,
      GITLAB_CLIENT_ID: CLIENT_ID,
      GITLAB_CLIENT_SECRET: CLIENT_SECRET,
    } as Env;
  }

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(
      readFileSync(
        new URL('../../src/db/migrations/0196_admin_settings.sql', import.meta.url),
        'utf8'
      )
    );
    __resetPlatformConfigCacheForTest();
    __resetAdminSettingsCacheForTest();
    jar = createCookieJar();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sqlite.close();
  });

  async function startSignIn(env: Env): Promise<Response> {
    const start = await app.request(
      `${API_ORIGIN}/api/auth/sign-in/social`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP_ORIGIN },
        body: JSON.stringify({ provider: 'gitlab', callbackURL: CALLBACK_URL }),
      },
      env
    );
    jar.store(start);
    return start;
  }

  async function signIn(env: Env, network: ReturnType<typeof createFakeNetwork>) {
    const start = await startSignIn(env);
    expect(start.status).toBe(200);
    const authorizeUrl = new URL(((await start.json()) as { url: string }).url);
    const callback = new URL(REDIRECT_URI);
    callback.searchParams.set('code', network.approve(authorizeUrl));
    callback.searchParams.set('state', authorizeUrl.searchParams.get('state') ?? '');
    const response = await app.request(
      callback.toString(),
      { headers: { cookie: jar.header() } },
      env
    );
    jar.store(response);
    return response;
  }

  const sessionCount = () =>
    (sqlite.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n;

  it('signs a GitLab user in through the guarded profile fetch, keyed on the GitLab id', async () => {
    const network = createFakeNetwork(PUBLIC_HOST);
    vi.stubGlobal('fetch', network.fetch);
    const callback = await signIn(envFor(PUBLIC_HOST), network);
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(CALLBACK_URL);
    expect(sessionCount()).toBe(1);
    const accounts = sqlite
      .prepare(`SELECT account_id FROM accounts WHERE provider_id = 'gitlab'`)
      .all();
    expect(accounts).toEqual([{ account_id: String(GITLAB_USER.id) }]);
    expect(network.requests).toEqual([
      `POST ${PUBLIC_HOST}/oauth/token`,
      `GET ${PUBLIC_HOST}/api/v4/user`,
    ]);
  });

  it('a profile redirect to an internal address is never followed, and no session starts', async () => {
    const network = createFakeNetwork(PUBLIC_HOST, {
      userResponse: () => new Response(null, { status: 302, headers: { location: INTERNAL_URL } }),
    });
    vi.stubGlobal('fetch', network.fetch);
    const callback = await signIn(envFor(PUBLIC_HOST), network);
    expect(callback.headers.get('location')).toContain('error=');
    expect(sessionCount()).toBe(0);
    expect(network.requests).not.toContain('GET http://127.0.0.1:7001/v1/state');
    // Liveness: the flow did reach GitLab's profile endpoint.
    expect(network.requests).toContain(`GET ${PUBLIC_HOST}/api/v4/user`);
  });

  it('a profile redirect chain longer than the hop limit ends the sign-in without a session', async () => {
    let hop = 0;
    const network = createFakeNetwork(PUBLIC_HOST, {
      userResponse: () =>
        new Response(null, {
          status: 302,
          headers: { location: `${PUBLIC_HOST}/api/v4/user?hop=${(hop += 1)}` },
        }),
    });
    vi.stubGlobal('fetch', network.fetch);
    const callback = await signIn(envFor(PUBLIC_HOST), network);
    expect(callback.headers.get('location')).toContain('error=');
    expect(sessionCount()).toBe(0);
    // Token exchange, then the profile request plus outbound.maxRedirects (3) hops.
    expect(network.requests.filter((r) => r === `GET ${PUBLIC_HOST}/api/v4/user`)).toHaveLength(4);
  });

  it('the profile fetch cuts a redirect chain at outbound.maxRedirects as the admin set it', async () => {
    const env = envFor(PUBLIC_HOST);
    // The admin's real settings writer, on the same database; 1 is not the default (3).
    await updateAdminSettings(
      {
        ...env,
        GITLAB_HOST: undefined,
        GITLAB_CLIENT_ID: undefined,
        GITLAB_CLIENT_SECRET: undefined,
      } as Env,
      { changes: [{ name: 'outbound.maxRedirects', value: 1 }], actorUserId: 'admin' }
    );
    __resetAdminSettingsCacheForTest();
    let hop = 0;
    const network = createFakeNetwork(PUBLIC_HOST, {
      userResponse: () =>
        new Response(null, {
          status: 302,
          headers: { location: `${PUBLIC_HOST}/api/v4/user?hop=${(hop += 1)}` },
        }),
    });
    vi.stubGlobal('fetch', network.fetch);
    const callback = await signIn(env, network);
    expect(callback.headers.get('location')).toContain('error=');
    expect(sessionCount()).toBe(0);
    // The profile request plus one hop.
    expect(network.requests.filter((r) => r === `GET ${PUBLIC_HOST}/api/v4/user`)).toHaveLength(2);
  });

  it('a private GitLab host without the admin opt-in is not offered for sign-in', async () => {
    const network = createFakeNetwork(PRIVATE_HOST);
    vi.stubGlobal('fetch', network.fetch);
    const start = await startSignIn(envFor(PRIVATE_HOST));
    expect(start.status).toBeGreaterThanOrEqual(400);
    expect(network.requests).toEqual([]);
  });

  it('control: with integration.gitlab.allowPrivateNetwork on, the private host signs in', async () => {
    const env = envFor(PRIVATE_HOST);
    // The admin's real settings writer, on the same database.
    const adminEnv = { ...env, GITLAB_HOST: undefined, GITLAB_CLIENT_ID: undefined };
    await updateAdminSettings({ ...adminEnv, GITLAB_CLIENT_SECRET: undefined } as Env, {
      changes: [{ name: 'integration.gitlab.allowPrivateNetwork', value: true }],
      actorUserId: 'admin',
    });
    __resetAdminSettingsCacheForTest();
    const network = createFakeNetwork(PRIVATE_HOST);
    vi.stubGlobal('fetch', network.fetch);
    const callback = await signIn(env, network);
    expect(callback.headers.get('location')).toBe(CALLBACK_URL);
    expect(sessionCount()).toBe(1);
  });
});
