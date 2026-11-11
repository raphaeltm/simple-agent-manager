/**
 * Redirect policy of the guarded fetch (self-host T5 follow-up, item 9):
 * - a hop that leaves the origin keeps only an explicit safe list of headers, so a credential
 *   under a name nobody listed (GitLab's PRIVATE-TOKEN) cannot follow the redirect;
 * - one deadline bounds the whole operation (every hop), and never cuts the final body;
 * - the hop limit is the admin setting `outbound.maxRedirects`.
 *
 * Deadline cases use real HTTP servers and the real fetch, so the abort travels through undici.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  DEFAULT_OUTBOUND_MAX_REDIRECTS,
  guardedFetch,
  OutboundRequestRefusedError,
} from '../../../src/lib/network-hosts';
import {
  __resetAdminSettingsCacheForTest,
  updateAdminSettings,
} from '../../../src/services/admin-settings';
import { findAdminSetting } from '../../../src/services/admin-settings-registry';
import { resolveOutboundMaxRedirects } from '../../../src/services/outbound-fetch-settings';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

function redirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}

describe('cross-origin hops keep only the safe header list', () => {
  const sent = {
    Authorization: 'Bearer k',
    'PRIVATE-TOKEN': 'glpat-secret',
    'X-Custom-Secret': 's',
    'anthropic-version': '2023-06-01',
    Cookie: 'a=b',
    Accept: 'application/json',
    'Accept-Language': 'en',
    'User-Agent': 'sam',
    'Content-Type': 'application/json',
  };

  it('drops PRIVATE-TOKEN and every other unlisted header when the origin changes', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(redirect(307, 'https://b.example.com/x'))
      .mockResolvedValueOnce(new Response('ok'));
    await guardedFetch(
      'https://a.example.com/',
      { method: 'POST', body: '{}', headers: sent },
      { fetchFn }
    );
    const headers = new Headers((fetchFn.mock.calls[1]?.[1] as RequestInit).headers);
    expect([...headers.keys()].sort()).toEqual([
      'accept',
      'accept-language',
      'content-type',
      'user-agent',
    ]);
    expect(headers.get('private-token')).toBeNull();
  });

  it('control: a same-origin hop keeps every header, PRIVATE-TOKEN included', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(redirect(308, 'https://a.example.com/v2'))
      .mockResolvedValueOnce(new Response('ok'));
    await guardedFetch(
      'https://a.example.com/v1',
      { method: 'POST', body: '{}', headers: sent },
      { fetchFn }
    );
    const headers = new Headers((fetchFn.mock.calls[1]?.[1] as RequestInit).headers);
    expect(headers.get('private-token')).toBe('glpat-secret');
    expect(headers.get('x-custom-secret')).toBe('s');
  });
});

describe('one deadline bounds the whole operation', () => {
  let server: Server;
  let base: string;
  // Each hop answers after `hopDelayMs`; /final answers headers at once and its body later.
  const hopDelayMs = 300;

  beforeEach(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/final') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('head-');
        setTimeout(() => res.end('tail'), 400);
        return;
      }
      const hop = Number(url.searchParams.get('hop') ?? '0');
      setTimeout(() => {
        res.writeHead(302, { location: hop >= 2 ? '/final' : `/hop?hop=${hop + 1}` });
        res.end();
      }, hopDelayMs);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('refuses with reason deadline once the hops together outlast it', async () => {
    // Three hops of 300 ms each: every single hop fits in 700 ms, the chain does not.
    const started = Date.now();
    const error = await guardedFetch(
      `${base}/hop?hop=0`,
      {},
      { allowPrivateNetwork: true, deadlineMs: 700 }
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(OutboundRequestRefusedError);
    expect((error as OutboundRequestRefusedError).reason).toBe('deadline');
    expect(Date.now() - started).toBeLessThan(900);
  });

  it('control: with a deadline the chain fits in, the final body is read in full', async () => {
    // Headers of /final arrive at ~900 ms; its body ends ~400 ms after the deadline would
    // have cut a per-request signal. The deadline stops once the final response is in hand.
    const res = await guardedFetch(
      `${base}/hop?hop=0`,
      {},
      { allowPrivateNetwork: true, deadlineMs: 1_000 }
    );
    expect(await res.text()).toBe('head-tail');
  });

  it("the caller's own signal still aborts", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('caller gave up')), 100);
    await expect(
      guardedFetch(
        `${base}/hop?hop=0`,
        { signal: controller.signal },
        { allowPrivateNetwork: true, deadlineMs: 5_000 }
      )
    ).rejects.toThrow('caller gave up');
  });
});

describe('outbound.maxRedirects admin setting', () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(() => {
    __resetAdminSettingsCacheForTest();
    ({ sqlite, env } = createAdminSettingsEnv());
  });
  afterEach(() => {
    sqlite.close();
    vi.restoreAllMocks();
  });

  it('is registered with the guard default and a bounded range', () => {
    const definition = findAdminSetting('outbound.maxRedirects');
    expect(definition).toMatchObject({
      type: 'integer',
      defaultValue: DEFAULT_OUTBOUND_MAX_REDIRECTS,
      range: { min: 0, max: 10 },
    });
    expect(definition?.validate(11)).toBe(false);
    expect(definition?.validate(0)).toBe(true);
  });

  it('resolves the default, then the stored value', async () => {
    await expect(resolveOutboundMaxRedirects(env)).resolves.toBe(DEFAULT_OUTBOUND_MAX_REDIRECTS);
    await updateAdminSettings(env, {
      changes: [{ name: 'outbound.maxRedirects', value: 1 }],
      actorUserId: 'admin',
    });
    await expect(resolveOutboundMaxRedirects(env)).resolves.toBe(1);
  });

  it('falls back to the default when settings cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(resolveOutboundMaxRedirects({} as Env)).resolves.toBe(
      DEFAULT_OUTBOUND_MAX_REDIRECTS
    );
  });
});
