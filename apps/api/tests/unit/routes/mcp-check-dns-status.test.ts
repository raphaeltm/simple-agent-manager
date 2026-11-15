/**
 * check_dns_status asks the user's own workspace for a response (self-host T5). The workspace
 * answers, so it must not be able to point the control plane anywhere else:
 * - redirects that stay on the workspace's own origin are followed through the guarded fetch and
 *   httpStatus is the final status (its meaning before T5);
 * - a redirect to any other origin is reported with its 3xx status and never requested;
 * - a private-domain install (BASE_DOMAIN `sam.lan`) still checks its own private host;
 * - errors are fixed categories, never raw error text.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { handleCheckDnsStatus } from '../../../src/routes/mcp/check-dns-status';
import {
  __resetAdminSettingsCacheForTest,
  updateAdminSettings,
} from '../../../src/services/admin-settings';
import type { McpTokenData } from '../../../src/services/mcp-token';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';
import { type HeldHttpServer, startHeldHttpServer } from '../../helpers/held-http-server';

const TOKEN = { taskId: '', projectId: 'p1', userId: 'u1', workspaceId: 'ws1' } as McpTokenData;
const ENV = { BASE_DOMAIN: 'sam.example.com' } as Env;
const WORKSPACE = 'https://ws-ws1.sam.example.com';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function resultOf(res: unknown): Record<string, unknown> {
  const text = (res as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
  return JSON.parse(text) as Record<string, unknown>;
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { Location: location } });
}

/** The global fetch, re-addressed so the workspace and a third party are real local servers. */
function routeTo(servers: Record<string, HeldHttpServer>): typeof fetch {
  const realFetch = globalThis.fetch;
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const server = servers[url.origin];
    if (!server) throw new Error(`unexpected request to ${url.origin}`);
    return realFetch(`${server.base}${url.pathname}${url.search}`, init);
  }) as typeof fetch;
}

describe('check_dns_status', () => {
  let workspace: HeldHttpServer;
  let thirdParty: HeldHttpServer;
  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    workspace = await startHeldHttpServer();
    thirdParty = await startHeldHttpServer();
    vi.stubGlobal(
      'fetch',
      routeTo({ [WORKSPACE]: workspace, 'https://attacker.example.net:20123': thirdParty })
    );
  });
  afterEach(async () => {
    await workspace.close();
    await thirdParty.close();
  });

  it('follows a same-origin redirect and reports the final status', async () => {
    const call = handleCheckDnsStatus(1, TOKEN, ENV);
    const first = await workspace.nextRequest();
    expect(first).toMatchObject({ url: '/', headers: expect.any(Object) });
    first.respond(302, { location: '/login' });
    const second = await workspace.nextRequest();
    expect(second.url).toBe('/login');
    second.respond(200);
    expect(resultOf(await call)).toMatchObject({
      httpStatus: 200,
      dnsResolved: true,
      tlsValid: true,
    });
  });

  it('a cross-origin redirect is reported with its 3xx status and never requested', async () => {
    const call = handleCheckDnsStatus(1, TOKEN, ENV);
    (await workspace.nextRequest()).respond(307, {
      location: 'https://attacker.example.net:20123/probe',
    });
    expect(resultOf(await call)).toMatchObject({
      status: 'redirect_cross_origin',
      httpStatus: 307,
      dnsResolved: true,
      tlsValid: true,
    });
    expect(thirdParty.count()).toBe(0);
  });
});

describe('check_dns_status with mocked transport', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('sends HEAD with redirect manual to the workspace URL', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await handleCheckDnsStatus(1, TOKEN, ENV);
    expect(fetchMock.mock.calls[0]).toEqual([
      `${WORKSPACE}/`,
      expect.objectContaining({ method: 'HEAD', redirect: 'manual' }),
    ]);
  });

  it('a private-domain install checks its own private workspace host', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await handleCheckDnsStatus(1, TOKEN, { BASE_DOMAIN: 'sam.lan' } as Env);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://ws-ws1.sam.lan/');
    expect(resultOf(res)).toMatchObject({ httpStatus: 200, dnsResolved: true });
  });

  it('control: on a private-domain install a redirect to a loopback service is not followed', async () => {
    const fetchMock = vi.fn(async () => redirect('http://127.0.0.1:7001/'));
    vi.stubGlobal('fetch', fetchMock);
    const res = await handleCheckDnsStatus(1, TOKEN, { BASE_DOMAIN: 'sam.lan' } as Env);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(resultOf(res)).toMatchObject({ status: 'redirect_refused', refusal: 'host' });
  });

  it('a redirect to a loopback service is reported, never requested', async () => {
    const fetchMock = vi.fn(async () => redirect('http://127.0.0.1:7001/'));
    vi.stubGlobal('fetch', fetchMock);
    const res = await handleCheckDnsStatus(1, TOKEN, ENV);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(resultOf(res)).toMatchObject({ dnsResolved: true, status: 'redirect_refused' });
  });

  it('a same-origin redirect chain longer than the hop limit is reported after limit + 1 requests', async () => {
    let hop = 0;
    const fetchMock = vi.fn(async () => redirect(`${WORKSPACE}/loop/${(hop += 1)}`));
    vi.stubGlobal('fetch', fetchMock);
    const res = await handleCheckDnsStatus(1, TOKEN, ENV);
    // outbound.maxRedirects defaults to 3 (no settings database here, so the default applies).
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(resultOf(res)).toMatchObject({ status: 'redirect_refused', refusal: 'redirect_limit' });
  });

  it('reports a fixed error category, never the error text', async () => {
    const leak = new TypeError('fetch failed', {
      cause: new Error('connect ECONNREFUSED 10.0.0.7:20123 (secret-host.internal)'),
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(leak));
    const result = resultOf(await handleCheckDnsStatus(1, TOKEN, ENV));
    expect(result).toMatchObject({ status: 'dns_not_resolved', error: 'network' });
    expect(JSON.stringify(result)).not.toMatch(/ECONNREFUSED|10\.0\.0\.7|20123|secret-host/);
  });

  it('a TLS failure keeps its category without its text', async () => {
    const tls = new TypeError('fetch failed', {
      cause: new Error('unable to verify the first certificate CN=internal-ca'),
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(tls));
    const result = resultOf(await handleCheckDnsStatus(1, TOKEN, ENV));
    expect(result).toMatchObject({ status: 'tls_error', error: 'tls', dnsResolved: true });
    expect(JSON.stringify(result)).not.toContain('internal-ca');
  });
});

describe('check_dns_status reads outbound.maxRedirects', () => {
  let sqlite: Database.Database;
  let env: Env;
  beforeEach(() => {
    __resetAdminSettingsCacheForTest();
    ({ sqlite, env } = createAdminSettingsEnv());
    env = { ...env, BASE_DOMAIN: 'sam.example.com' } as Env;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => sqlite.close());

  it('cuts a same-origin chain at the configured limit, not the default', async () => {
    await updateAdminSettings(env, {
      changes: [{ name: 'outbound.maxRedirects', value: 1 }],
      actorUserId: 'admin',
    });
    let hop = 0;
    const fetchMock = vi.fn(async () => redirect(`${WORKSPACE}/loop/${(hop += 1)}`));
    vi.stubGlobal('fetch', fetchMock);
    const res = await handleCheckDnsStatus(1, TOKEN, env);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resultOf(res)).toMatchObject({ status: 'redirect_refused', refusal: 'redirect_limit' });
  });
});
