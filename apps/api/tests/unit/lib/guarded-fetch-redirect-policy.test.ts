/**
 * Redirect policy of the guarded fetch (self-host T5 follow-up, item 9):
 * - a hop that leaves the origin keeps only an explicit safe list of headers, so a credential
 *   under a name nobody listed (GitLab's PRIVATE-TOKEN) cannot follow the redirect;
 * - one deadline bounds the whole operation (every hop), and never cuts the final body;
 * - the hop limit is the admin setting `outbound.maxRedirects`.
 *
 * Deadline cases use a real HTTP server and the real fetch, so the abort travels through undici,
 * with the server holding each hop until the test answers it (no wall-clock margins).
 */
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
import { type HeldHttpServer, settled, startHeldHttpServer } from '../../helpers/held-http-server';

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
    await guardedFetch('https://a.example.com/', { method: 'GET', headers: sent }, { fetchFn });
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

describe('a cross-origin 307/308 never carries the request body to the new origin', () => {
  let origin: HeldHttpServer;
  let other: HeldHttpServer;
  beforeEach(async () => {
    origin = await startHeldHttpServer();
    other = await startHeldHttpServer();
  });
  afterEach(async () => {
    await origin.close();
    await other.close();
  });

  /** Real fetch to the real servers, addressed by public names so only the body rule decides. */
  const viaPublicNames = (url: string, init: RequestInit): Promise<Response> =>
    fetch(
      url
        .replace('https://a.example.com', origin.base)
        .replace('https://b.example.com', other.base),
      init
    );

  it.each([307, 308])(
    '%i to another origin with a body is refused before it is sent',
    async (status) => {
      const call = guardedFetch(
        'https://a.example.com/v1',
        { method: 'POST', body: '{"prompt":"other users content"}' },
        { fetchFn: viaPublicNames }
      ).catch((err: unknown) => err);
      (await origin.nextRequest()).respond(status, { location: 'https://b.example.com/steal' });
      const error = await call;
      expect(error).toBeInstanceOf(OutboundRequestRefusedError);
      expect((error as OutboundRequestRefusedError).reason).toBe('redirect_cross_origin_body');
      expect(other.count()).toBe(0);
    }
  );

  it('control: a bodiless cross-origin 307 is followed', async () => {
    const call = guardedFetch('https://a.example.com/v1', {}, { fetchFn: viaPublicNames });
    (await origin.nextRequest()).respond(307, { location: 'https://b.example.com/v2' });
    (await other.nextRequest()).respond(200, {}, 'ok');
    expect(await (await call).text()).toBe('ok');
  });

  it('control: a same-origin 307 replays the body', async () => {
    const call = guardedFetch(
      'https://a.example.com/v1',
      { method: 'POST', body: 'payload' },
      { fetchFn: viaPublicNames }
    );
    (await origin.nextRequest()).respond(307, { location: '/v2' });
    const replay = await origin.nextRequest();
    expect(replay.url).toBe('/v2');
    replay.respond(200, {}, 'ok');
    expect(await (await call).text()).toBe('ok');
  });

  it.each([301, 302, 303])(
    'control: a cross-origin %i turns a POST into a bodiless GET and is followed',
    async (status) => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(redirect(status, 'https://b.example.com/v2'))
        .mockImplementationOnce((_url: string, init: RequestInit) =>
          Promise.resolve(new Response(`${String(init.method)} ${String(init.body ?? '')}`))
        );
      const res = await guardedFetch(
        'https://a.example.com/v1',
        { method: 'POST', body: 'payload', headers: { 'content-type': 'text/plain' } },
        { fetchFn }
      );
      expect(await res.text()).toBe('GET ');
    }
  );
});

describe('one deadline bounds the whole operation', () => {
  // The server holds every hop until the test answers it, and only setTimeout/clearTimeout are
  // faked, so the deadline fires exactly where the test moves the clock, whatever the load.
  let server: HeldHttpServer;
  beforeEach(async () => {
    server = await startHeldHttpServer();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await server.close();
  });

  it('refuses with reason deadline once the hops together outlast it', async () => {
    // Each hop takes 400 ms of a 1000 ms deadline: no single hop outlasts it, the chain does.
    const call = guardedFetch(
      `${server.base}/hop0`,
      {},
      { allowPrivateNetwork: true, deadlineMs: 1_000 }
    ).catch((err: unknown) => err);
    const first = await server.nextRequest();
    vi.advanceTimersByTime(400);
    first.respond(302, { location: '/hop1' });
    const second = await server.nextRequest();
    vi.advanceTimersByTime(400);
    second.respond(302, { location: '/hop2' });
    await server.nextRequest();
    expect(await settled(call)).toBe(false);
    vi.advanceTimersByTime(400); // 1200 ms in all; the third hop alone has taken 400 ms
    expect(await settled(call)).toBe(true);
    const error = await call;
    expect(error).toBeInstanceOf(OutboundRequestRefusedError);
    expect((error as OutboundRequestRefusedError).reason).toBe('deadline');
    expect(server.count()).toBe(3);
  });

  it('control: with a deadline the hops fit in, the final body is read in full', async () => {
    const call = guardedFetch(
      `${server.base}/hop0`,
      {},
      { allowPrivateNetwork: true, deadlineMs: 400 }
    );
    (await server.nextRequest()).respond(302, { location: '/final' });
    const end = (await server.nextRequest()).respondHoldingBody(200, 'head-');
    const res = await call;
    // Far past the deadline while the body is still open: the deadline stopped with the headers.
    vi.advanceTimersByTime(5_000);
    end('tail');
    expect(await res.text()).toBe('head-tail');
  });

  it("the caller's own signal still aborts", async () => {
    const controller = new AbortController();
    const call = guardedFetch(
      `${server.base}/hop0`,
      { signal: controller.signal },
      { allowPrivateNetwork: true, deadlineMs: 5_000 }
    );
    await server.nextRequest();
    controller.abort(new Error('caller gave up'));
    await expect(call).rejects.toThrow('caller gave up');
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
