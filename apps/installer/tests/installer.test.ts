import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';
import { digest, sessionCookie } from '../src/security';
import { InstallerSession } from '../src/session';
import type { Env, Session } from '../src/types';

function fixture() {
  const values = new Map<string, unknown>();
  const ctx = {
    storage: {
      get: vi.fn(async (key: string) => values.get(key)),
      put: vi.fn(async (key: string, value: unknown) => {
        values.set(key, structuredClone(value));
      }),
      deleteAll: vi.fn(async () => values.clear()),
      setAlarm: vi.fn(),
    },
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
  } as unknown as DurableObjectState;
  const env = {
    APP_ORIGIN: 'https://install.example.com',
    OAUTH_CLIENT_ID: 'client',
    OAUTH_CLIENT_SECRET: 'SECRET',
    OAUTH_SCOPES: 'account-settings.read workers-scripts.edit',
    SESSION_TTL_SECONDS: '900',
    BUILD_SHA: 'test',
    SOURCE_URL: 'https://example.com/source',
    DOCS_URL: 'https://example.com/docs',
    ASSETS: { fetch: async () => new Response('assets') },
  } as unknown as Env;
  const session = new InstallerSession(ctx, env);
  env.SESSIONS = {
    idFromName: (id: string) => id,
    get: () => ({ fetch: (r: Request) => session.fetch(r) }),
  } as unknown as DurableObjectNamespace;
  const call = (path: string, body?: unknown) =>
    session.fetch(
      new Request(`https://session${path}`, {
        method: body ? 'POST' : 'GET',
        body: body ? JSON.stringify(body) : undefined,
      })
    );
  return { values, ctx, env, session, call };
}
const accountId = 'a'.repeat(32);
function authorized(values: Map<string, unknown>) {
  values.set('session', {
    expires: Date.now() + 900000,
    tokenExpires: Date.now() + 900000,
    token: 'TOKEN',
    state: '',
    verifier: '',
    accounts: [{ id: accountId, name: 'My account' }],
  } satisfies Session);
}
afterEach(() => vi.unstubAllGlobals());
describe('authorization and boundaries', () => {
  it('uses PKCE, consumes the callback before exchange and rejects replay', async () => {
    const { call } = fixture();
    const start = (await (await call('/start')).json()) as { url: string };
    const url = new URL(start.url);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const fetch = vi.fn(async () => Response.json({ access_token: 'TOKEN', expires_in: 3600 }));
    vi.stubGlobal('fetch', fetch);
    const callback = { state: url.searchParams.get('state'), code: 'code' };
    expect((await call('/callback', callback)).status).toBe(200);
    expect((await call('/callback', callback)).status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects callback state mismatch without sending a code upstream', async () => {
    const { call } = fixture();
    await call('/start');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect((await call('/callback', { state: 'wrong', code: 'code' })).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('expires before serving or modifying account data and deletes retained tokens', async () => {
    const { call, values } = fixture();
    authorized(values);
    (values.get('session') as Session).expires = Date.now() - 1;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 200 }))
    );
    expect((await call('/status')).status).toBe(401);
    expect(values.size).toBe(0);
  });
  it('rejects cross-origin writes and missing sessions at the public router', async () => {
    const { env } = fixture();
    const r = await worker.fetch(
      new Request(`${env.APP_ORIGIN}/oauth/start`, {
        method: 'POST',
        headers: { Origin: 'https://attacker.example' },
      }),
      env
    );
    expect(r.status).toBe(403);
    expect(
      (await worker.fetch(new Request(`${env.APP_ORIGIN}/api/session/status`), env)).status
    ).toBe(401);
    expect(sessionCookie(env.APP_ORIGIN, 'x', 900)).toContain('__Host-sam-installer=');
    expect(sessionCookie(env.APP_ORIGIN, 'x', 900)).toContain('HttpOnly');
  });
  it('refuses an arbitrary unapproved account even with a valid session', async () => {
    const { call, values } = fixture();
    authorized(values);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect((await call('/install', { accountId: 'b'.repeat(32), confirmed: true })).status).toBe(
      400
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
describe('provisioning and handoff', () => {
  it('creates one protected Worker, resumes without duplicates, never exposes the cloud token, and clears hosted access', async () => {
    const { call, values } = fixture();
    authorized(values);
    const requests: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return Response.json({
          success: true,
          result: url.endsWith('/workers/subdomain') ? { subdomain: 'my-account' } : {},
        });
      })
    );
    const body = { accountId, confirmed: true };
    expect((await call('/install', body)).status).toBe(200);
    expect((await call('/install', body)).status).toBe(200);
    const uploads = requests.filter((r) => r.init?.method === 'PUT');
    expect(uploads).toHaveLength(1);
    const upload = uploads[0]!.init!.body as FormData;
    const metadata = JSON.parse(await (upload.get('metadata') as Blob).text());
    const session = values.get('session') as Session;
    expect(metadata.bindings.find((b: { name: string }) => b.name === 'OWNER_KEY_HASH').text).toBe(
      await digest(session.job!.key)
    );
    expect(JSON.stringify(metadata)).not.toContain('TOKEN');
    const status = await (await call('/status')).text();
    expect(status).not.toContain('TOKEN');
    expect(status).not.toContain(session.job!.key);
    const handoff = await call('/handoff');
    expect(handoff.status).toBe(200);
    expect(await handoff.text()).not.toContain('TOKEN');
    expect(values.size).toBe(0);
    expect(requests.some((r) => r.url.endsWith('/oauth2/revoke'))).toBe(true);
    expect((await call('/handoff')).status).toBe(401);
  });
  it('preserves a stable job when deployment fails and redacts upstream errors', async () => {
    const { call, values } = fixture();
    authorized(values);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ success: false, errors: [{ message: 'SECRET TOKEN' }] }, { status: 403 })
      )
    );
    const response = await call('/install', { accountId, confirmed: true });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('SECRET TOKEN');
    const name = (values.get('session') as Session).job!.name;
    await call('/install', { accountId, confirmed: true });
    expect((values.get('session') as Session).job!.name).toBe(name);
  });
  it('deletes temporary credentials even if revocation fails and reports the limitation', async () => {
    const { call, values } = fixture();
    authorized(values);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 }))
    );
    expect(await (await call('/finish', {})).json()).toEqual({ ok: true, revoked: false });
    expect(values.size).toBe(0);
  });
});

describe('public router body limits', () => {
  it('rejects oversized POST without Content-Length before forwarding to a session', async () => {
    const { env } = fixture();
    const get = vi.spyOn(env.SESSIONS, 'get');
    const response = await worker.fetch(
      new Request(`${env.APP_ORIGIN}/api/session/install`, {
        method: 'POST',
        headers: { Origin: env.APP_ORIGIN, Cookie: `__Host-sam-installer=${'a'.repeat(64)}` },
        body: 'x'.repeat(4097),
      }),
      env
    );
    expect(response.status).toBe(413);
    expect(get).not.toHaveBeenCalled();
  });
});
