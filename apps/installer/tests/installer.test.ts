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
      delete: vi.fn(async (key: string) => values.delete(key)),
      deleteAlarm: vi.fn(async () => {}),
      setAlarm: vi.fn(),
    },
    id: { toString: () => 'e'.repeat(64) },
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
  it('never exposes fresh-grant cleanup internals through the public session router', async () => {
    const { env } = fixture();
    const response = await worker.fetch(
      new Request(`${env.APP_ORIGIN}/api/session/cleanup-with-grant`, {
        method: 'POST',
        headers: { Origin: env.APP_ORIGIN, Cookie: `__Host-sam-installer=${'d'.repeat(64)}` },
        body: '{}',
      }),
      env
    );
    expect(response.status).toBe(404);
    const page = await worker.fetch(new Request(env.APP_ORIGIN), env);
    expect(page.headers.get('Referrer-Policy')).toBe('strict-origin');
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
        if (url.endsWith('/settings')) return Response.json({ success: false }, { status: 404 });
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
    expect((values.get('session') as Session).token).toBeUndefined();
    expect(requests.some((r) => r.url.endsWith('/oauth2/revoke'))).toBe(true);
    expect((await call('/handoff')).status).toBe(200);
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

describe('durable approval and credential transfer journal', () => {
  it('cannot replace an approved plan once a job has started', async () => {
    const { call, values } = fixture();
    authorized(values);
    const session = values.get('session') as Session;
    session.job = {
      accountId,
      name: 'sam-maintenance-existing',
      key: 'private',
      status: 'pending',
      fingerprint: 'approved',
    };
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect((await call('/preview', { accountId })).status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('cleans unused child principals before revoking the parent and clearing the session', async () => {
    const { call, values } = fixture();
    authorized(values);
    const session = values.get('session') as Session;
    session.job = {
      accountId,
      name: 'sam-maintenance-existing',
      key: 'private',
      status: 'pending',
    };
    session.credentialTokenIds = ['b'.repeat(32), 'c'.repeat(32)];
    const calls: { url: string; method?: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method });
        return Response.json({ success: true, result: {} });
      })
    );
    expect((await call('/finish', {})).status).toBe(200);
    expect(
      calls.slice(0, 2).every((call) => call.method === 'DELETE' && call.url.includes('/tokens/'))
    ).toBe(true);
    expect(calls[2]?.url).toContain('/oauth2/revoke');
    expect(values.size).toBe(0);
  });
  it('retains its cleanup journal and grant when a child deletion cannot be confirmed', async () => {
    const { call, values } = fixture();
    authorized(values);
    const session = values.get('session') as Session;
    session.job = {
      accountId,
      name: 'sam-maintenance-existing',
      key: 'private',
      status: 'pending',
    };
    session.credentialTokenIds = ['b'.repeat(32)];
    const fetch = vi.fn(async () => Response.json({ success: false }, { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    expect((await call('/finish', {})).status).toBe(502);
    expect((values.get('session') as Session).credentialTokenIds).toEqual(['b'.repeat(32)]);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('reconciles an uploaded service before cleanup rather than revoking credentials it now owns', async () => {
    const { call, values } = fixture();
    authorized(values);
    const session = values.get('session') as Session;
    session.job = {
      accountId,
      name: 'sam-maintenance-existing',
      key: 'private',
      status: 'pending',
      authorityTransferStarted: true,
    };
    session.credentialTokenIds = ['b'.repeat(32)];
    const fetch = vi.fn(async (url: string) =>
      Response.json({
        success: true,
        result: url.endsWith('/settings')
          ? { bindings: [{ name: 'BOOTSTRAP_IDENTITY', text: await digest('private') }] }
          : {},
      })
    );
    vi.stubGlobal('fetch', fetch);
    expect((await call('/finish', {})).status).toBe(200);
    expect(fetch.mock.calls.some(([url]) => url.includes('/tokens/'))).toBe(false);
  });
});

describe('bounded bootstrap authority and fresh-grant cleanup', () => {
  it('reserves cleanup time before token expiry and rejects too-short OAuth grants', async () => {
    const f = fixture();
    const start = (await (await f.call('/start')).json()) as { url: string };
    const state = new URL(start.url).searchParams.get('state');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/token')
          ? Response.json({ access_token: 'short-secret', expires_in: 600 })
          : new Response('')
      )
    );
    expect((await f.call('/callback', { state, code: 'approved' })).status).toBe(200);
    const stored = f.values.get('session') as Session;
    expect(stored.tokenExpires! - stored.expires).toBeGreaterThanOrEqual(180000);
    expect(f.ctx.storage.setAlarm).toHaveBeenLastCalledWith(stored.expires);
    const g = fixture();
    const second = (await (await g.call('/start')).json()) as { url: string };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/token')
          ? Response.json({ access_token: 'short-secret', expires_in: 60 })
          : new Response('')
      )
    );
    expect(
      (
        await g.call('/callback', {
          state: new URL(second.url).searchParams.get('state'),
          code: 'approved',
        })
      ).status
    ).toBe(401);
    expect((g.values.get('session') as Session).token).toBeUndefined();
  });
  it('does not start provisioning when remaining authority cannot cover the work window', async () => {
    const f = fixture();
    authorized(f.values);
    const stored = f.values.get('session') as Session;
    stored.tokenExpires = Date.now() + 90000;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect((await f.call('/install', { accountId, confirmed: true })).status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('wipes expired secrets, retains only owned cleanup evidence, and accepts a fresh same-account cleanup grant', async () => {
    const f = fixture();
    authorized(f.values);
    const stored = f.values.get('session') as Session;
    stored.expires = Date.now() - 1;
    stored.tokenExpires = Date.now() - 1;
    stored.job = { accountId, name: 'sam-maintenance-old', key: 'claim-secret', status: 'pending' };
    stored.credentialTokenIds = ['b'.repeat(32)];
    const fetch = vi.fn(async () => Response.json({ success: true, result: {} }));
    vi.stubGlobal('fetch', fetch);
    const expired = await f.call('/status');
    expect(expired.status).toBe(401);
    expect(f.values.has('session')).toBe(false);
    const receipt = (await expired.json()) as { cleanupReceipt: string };
    expect(receipt.cleanupReceipt).toBe('e'.repeat(64));
    expect(JSON.stringify([...f.values])).not.toMatch(/TOKEN|claim-secret/);
    expect(fetch).not.toHaveBeenCalled();
    expect(
      (await f.call('/cleanup-with-grant', { accountId: 'c'.repeat(32), token: 'fresh-secret' }))
        .status
    ).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect((await f.call('/cleanup-with-grant', { accountId, token: 'fresh-secret' })).status).toBe(
      200
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toContain('/tokens/' + 'b'.repeat(32));
    expect(f.values.size).toBe(0);
  });
  it('fresh-grant reconciliation preserves credentials already transferred to the verified Worker', async () => {
    const f = fixture();
    authorized(f.values);
    const stored = f.values.get('session') as Session;
    stored.expires = Date.now() - 1;
    stored.tokenExpires = Date.now() - 1;
    stored.job = {
      accountId,
      name: 'sam-maintenance-old',
      key: 'claim-secret',
      status: 'pending',
      authorityTransferStarted: true,
    };
    stored.credentialTokenIds = ['b'.repeat(32)];
    await f.call('/status');
    const fetch = vi.fn(async () =>
      Response.json({
        success: true,
        result: { bindings: [{ name: 'BOOTSTRAP_IDENTITY', text: await digest('claim-secret') }] },
      })
    );
    vi.stubGlobal('fetch', fetch);
    const result = await f.call('/cleanup-with-grant', { accountId, token: 'fresh-secret' });
    expect(await result.json()).toEqual({ ok: true, authorityPreserved: true });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toContain('/settings');
  });
});
it('fresh-session cleanup requires account authorization before accessing another journal', async () => {
  const f = fixture();
  authorized(f.values);
  const get = vi.fn();
  f.env.SESSIONS = { idFromString: vi.fn((id) => id), get } as unknown as DurableObjectNamespace;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ success: true, result: [{ id: accountId, name: 'Owned account' }] })
    )
  );
  expect(
    (await f.call('/reconcile-cleanup', { receipt: 'd'.repeat(64), accountId: 'c'.repeat(32) }))
      .status
  ).toBe(403);
  expect(get).not.toHaveBeenCalled();
});
it.each([false, true])(
  'fresh-grant cleanup revokes a distinct old grant only (same=%s)',
  async (same) => {
    const f = fixture();
    authorized(f.values);
    f.values.set('cleanupJournal', {
      accountId,
      installationId: 'sam-maintenance-old',
      bootstrapIdentity: await digest('old-claim'),
      tokenIds: [],
      authorityTransferStarted: false,
      authorityTransferred: false,
    });
    const fetch = vi.fn(async () => new Response(''));
    vi.stubGlobal('fetch', fetch);
    expect(
      (await f.call('/cleanup-with-grant', { accountId, token: same ? 'TOKEN' : 'FRESH' })).status
    ).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(same ? 0 : 1);
    if (!same) {
      expect(fetch.mock.calls[0][0]).toContain('/oauth2/revoke');
      expect(String(fetch.mock.calls[0][1]?.body)).toBe('token=TOKEN');
    }
    expect(f.values.has('session')).toBe(false);
  }
);
