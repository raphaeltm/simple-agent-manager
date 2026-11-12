/**
 * The API Worker's side of sealed self-host secrets (src/selfhost/runtime-secrets.ts): one fetch
 * per isolate shared by concurrent callers, fail closed when the agent is unreachable or answers
 * wrongly, and Durable Objects held until their secrets arrive. The same module on the real
 * celld runtime: scripts/selfhost/live/key-agent-celld.live.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadRuntimeSecrets,
  resetRuntimeSecretsForTests,
  wrapDurableObject,
  wrapWorker,
} from '../../src/selfhost/runtime-secrets';

const BUNDLE = 'ab'.repeat(16);
const env = () => ({
  SAM_KEY_AGENT_URL: 'http://127.0.0.1:7190/v1/secrets',
  SAM_SECRET_BUNDLE_ID: BUNDLE,
  DATABASE: { binding: 'db' },
});
const ok = (secrets: Record<string, string>, bundleId = BUNDLE) =>
  new Response(JSON.stringify({ bundleId, secrets }), { status: 200 });
const ctx = {} as ExecutionContext;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetRuntimeSecretsForTests();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('wrapWorker fetch', () => {
  it('runs the handler with the secrets over the bindings, and asks the agent once per isolate', async () => {
    fetchMock.mockResolvedValue(ok({ ENCRYPTION_KEY: 'k1' }));
    const seen: Array<Record<string, unknown>> = [];
    const worker = wrapWorker<Record<string, unknown>>({
      fetch: async (_r, e) => {
        seen.push(e);
        return new Response('ok');
      },
    });
    const base = env();
    for (let i = 0; i < 3; i += 1)
      expect((await worker.fetch!(new Request('https://api/'), base, ctx)).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(base.SAM_KEY_AGENT_URL);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect((init.headers as Record<string, string>)['x-sam-key-agent']).toBe('1');
    expect(seen[0]).toMatchObject({ ENCRYPTION_KEY: 'k1', DATABASE: { binding: 'db' } });
    expect(base).not.toHaveProperty('ENCRYPTION_KEY'); // the runtime's env is never mutated
  });

  it('shares one in-flight request between concurrent first requests', async () => {
    let release: (r: Response) => void = () => undefined;
    fetchMock.mockReturnValue(new Promise<Response>((done) => (release = done)));
    const worker = wrapWorker({ fetch: async () => new Response('ok') });
    const pending = [1, 2, 3].map(() => worker.fetch!(new Request('https://api/'), env(), ctx));
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release(ok({ A_SECRET: 'v' }));
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual([200, 200, 200]);
  });

  it('fails closed with 503 when the agent is unreachable, never calling the handler, and retries next time', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('connection refused'));
    const inner = vi.fn(async () => new Response('ok'));
    const worker = wrapWorker({ fetch: inner });
    const down = await worker.fetch!(new Request('https://api/'), env(), ctx);
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({
      error: 'SECRETS_UNAVAILABLE',
      code: 'KEY_AGENT_UNREACHABLE',
    });
    expect(inner).not.toHaveBeenCalled();
    // The failure is not cached: the agent is back, the next request is served.
    fetchMock.mockResolvedValueOnce(ok({ A_SECRET: 'v' }));
    expect((await worker.fetch!(new Request('https://api/'), env(), ctx)).status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'a refusal',
      () => new Response(JSON.stringify({ error: 'peer_refused' }), { status: 403 }),
      'KEY_AGENT_REFUSED',
    ],
    ['another bundle', () => ok({ A: 'v' }, 'cd'.repeat(16)), 'KEY_AGENT_BAD_RESPONSE'],
    [
      'a non-string value',
      () => new Response(JSON.stringify({ bundleId: BUNDLE, secrets: { A: 1 } })),
      'KEY_AGENT_BAD_RESPONSE',
    ],
    [
      'a redirect',
      () => new Response(null, { status: 302, headers: { location: 'http://evil/' } }),
      'KEY_AGENT_REFUSED',
    ],
  ])('fails closed on %s', async (_label, response, code) => {
    fetchMock.mockResolvedValue(response());
    const inner = vi.fn(async () => new Response('ok'));
    const res = await wrapWorker({ fetch: inner }).fetch!(new Request('https://api/'), env(), ctx);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code });
    expect(inner).not.toHaveBeenCalled();
  });

  it('refuses an agent URL that is not loopback, before any request', async () => {
    const res = await wrapWorker({ fetch: async () => new Response('ok') }).fetch!(
      new Request('https://api/'),
      { ...env(), SAM_KEY_AGENT_URL: 'https://attacker.example/v1/secrets' },
      ctx
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'SECRETS_MISCONFIGURED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('scheduled: throws instead of running the cron without its secrets', async () => {
    fetchMock.mockRejectedValue(new TypeError('connection refused'));
    const inner = vi.fn(async () => undefined);
    await expect(
      wrapWorker({ scheduled: inner }).scheduled!({} as ScheduledController, env(), ctx)
    ).rejects.toThrow(/unreachable/);
    expect(inner).not.toHaveBeenCalled();
  });
});

describe('wrapDurableObject', () => {
  class Probe {
    env: Record<string, unknown>;
    constructor(_ctx: unknown, env: Record<string, unknown>) {
      this.env = env;
    }
  }

  function fakeState() {
    const held: Array<Promise<unknown>> = [];
    return {
      held,
      state: {
        blockConcurrencyWhile: (fn: () => Promise<unknown>) => {
          const p = fn();
          held.push(p);
          return p;
        },
      },
    };
  }

  it('holds events until the secrets arrive when the isolate has none yet', async () => {
    fetchMock.mockResolvedValue(ok({ ENCRYPTION_KEY: 'k2' }));
    const Wrapped = wrapDurableObject(Probe);
    const { state, held } = fakeState();
    const object = new Wrapped(state, env());
    expect(object.env.ENCRYPTION_KEY).toBeUndefined();
    expect(held).toHaveLength(1);
    await held[0];
    expect(object.env).toMatchObject({ ENCRYPTION_KEY: 'k2', DATABASE: { binding: 'db' } });
  });

  it('has them before the original constructor runs when the isolate already loaded them', async () => {
    fetchMock.mockResolvedValue(ok({ ENCRYPTION_KEY: 'k3' }));
    await loadRuntimeSecrets(env());
    const Wrapped = wrapDurableObject(Probe);
    const { state, held } = fakeState();
    const object = new Wrapped(state, env());
    expect(object.env.ENCRYPTION_KEY).toBe('k3');
    expect(held).toHaveLength(0);
  });

  it('fails the hold (and so every event) when the agent is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('connection refused'));
    const Wrapped = wrapDurableObject(Probe);
    const { state, held } = fakeState();
    const object = new Wrapped(state, env());
    await expect(held[0]).rejects.toThrow(/unreachable/);
    expect(object.env.ENCRYPTION_KEY).toBeUndefined();
  });
});
