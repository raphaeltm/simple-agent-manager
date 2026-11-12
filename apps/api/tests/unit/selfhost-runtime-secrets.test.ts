/**
 * The API Worker's side of sealed self-host secrets (src/selfhost/runtime-secrets.ts): one fetch
 * per isolate shared by concurrent callers, fail closed when the agent is unreachable or answers
 * wrongly, and Durable Objects held until their secrets arrive. The same module on the real
 * celld runtime: scripts/selfhost/live/key-agent-celld.live.test.ts.
 */
import { generateKeyPairSync, sign } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadRuntimeSecrets,
  resetRuntimeSecretsForTests,
  wrapDurableObject,
  wrapWorker,
} from '../../src/selfhost/runtime-secrets';

const BUNDLE = 'ab'.repeat(16);
const agentKey = generateKeyPairSync('ed25519');
const VERIFY_KEY = Buffer.from(
  String(agentKey.publicKey.export({ format: 'jwk' }).x),
  'base64url'
).toString('base64');
const env = () => ({
  SAM_KEY_AGENT_URL: 'http://127.0.0.1:7190/v1/secrets',
  SAM_SECRET_BUNDLE_ID: BUNDLE,
  SAM_KEY_AGENT_VERIFY_KEY: VERIFY_KEY,
  SAM_INSTALLATION_ID: 'c'.repeat(32),
  BASE_DOMAIN: 'sam.example.com',
  DATABASE: { binding: 'db' },
});

/** The agent's answer to this request: signed over the body that echoes its nonce. */
function answer(
  secrets: Record<string, unknown>,
  overrides: {
    bundleId?: string;
    nonce?: string;
    signWith?: typeof agentKey.privateKey;
    unsigned?: boolean;
  } = {}
) {
  return async (_url: string, init: RequestInit): Promise<Response> => {
    const request = JSON.parse(String(init.body)) as { nonce: string };
    const text = JSON.stringify({
      bundleId: overrides.bundleId ?? BUNDLE,
      nonce: overrides.nonce ?? request.nonce,
      secrets,
    });
    const signature = sign(null, Buffer.from(text), overrides.signWith ?? agentKey.privateKey);
    return new Response(text, {
      status: 200,
      headers: overrides.unsigned
        ? {}
        : { 'x-sam-key-agent-signature': signature.toString('base64') },
    });
  };
}
const ok = (secrets: Record<string, string>) => answer(secrets);
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
    fetchMock.mockImplementation(ok({ ENCRYPTION_KEY: 'k1' }));
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
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => (release = done));
    const respond = ok({ A_SECRET: 'v' });
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      await gate;
      return await respond(url, init);
    });
    const worker = wrapWorker({ fetch: async () => new Response('ok') });
    const pending = [1, 2, 3].map(() => worker.fetch!(new Request('https://api/'), env(), ctx));
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release();
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
    fetchMock.mockImplementationOnce(ok({ A_SECRET: 'v' }));
    expect((await worker.fetch!(new Request('https://api/'), env(), ctx)).status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  const impostor = generateKeyPairSync('ed25519');
  it.each([
    [
      'a refusal',
      async () => new Response(JSON.stringify({ error: 'peer_refused' }), { status: 403 }),
      'KEY_AGENT_REFUSED',
    ],
    [
      'an unsigned answer (an impostor on the port)',
      answer({ A: 'v' }, { unsigned: true }),
      'KEY_AGENT_UNVERIFIED',
    ],
    [
      'an answer signed by another key',
      answer({ A: 'v' }, { signWith: impostor.privateKey }),
      'KEY_AGENT_UNVERIFIED',
    ],
    [
      'a replayed answer (another nonce)',
      answer({ A: 'v' }, { nonce: '9'.repeat(32) }),
      'KEY_AGENT_BAD_RESPONSE',
    ],
    ['another bundle', answer({ A: 'v' }, { bundleId: 'cd'.repeat(16) }), 'KEY_AGENT_BAD_RESPONSE'],
    ['a non-string value', answer({ A: 1 }), 'KEY_AGENT_BAD_RESPONSE'],
    [
      'a channel setting',
      answer({ SAM_KEY_AGENT_URL: 'http://127.0.0.1:1/v1/secrets' }),
      'KEY_AGENT_BAD_RESPONSE',
    ],
    [
      'a redirect',
      async () => new Response(null, { status: 302, headers: { location: 'http://evil/' } }),
      'KEY_AGENT_REFUSED',
    ],
  ])('fails closed on %s', async (_label, respond, code) => {
    fetchMock.mockImplementation(respond);
    const inner = vi.fn(async () => new Response('ok'));
    const res = await wrapWorker({ fetch: inner }).fetch!(new Request('https://api/'), env(), ctx);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code });
    expect(inner).not.toHaveBeenCalled();
  });

  it('lets a secret replace a string var but never a binding', async () => {
    fetchMock.mockImplementation(
      ok({ BASE_DOMAIN: 'override.example.com', DATABASE: 'not-a-binding' })
    );
    let seen: Record<string, unknown> = {};
    await wrapWorker<Record<string, unknown>>({
      fetch: async (_r, e) => {
        seen = e;
        return new Response('ok');
      },
    }).fetch!(new Request('https://api/'), env(), ctx);
    expect(seen.BASE_DOMAIN).toBe('override.example.com');
    expect(seen.DATABASE).toEqual({ binding: 'db' });
  });

  it('sends a fresh nonce and the installation id with every request', async () => {
    fetchMock.mockImplementation(ok({ A: 'v' }));
    await loadRuntimeSecrets(env());
    resetRuntimeSecretsForTests();
    await loadRuntimeSecrets(env());
    const bodies = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, string>
    );
    expect(bodies[0]).toMatchObject({ bundleId: BUNDLE, installationId: 'c'.repeat(32) });
    expect(bodies[0]?.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(bodies[0]?.nonce).not.toBe(bodies[1]?.nonce);
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
    fetchMock.mockImplementation(ok({ ENCRYPTION_KEY: 'k2' }));
    const Wrapped = wrapDurableObject(Probe);
    const { state, held } = fakeState();
    const object = new Wrapped(state, env());
    expect(object.env.ENCRYPTION_KEY).toBeUndefined();
    expect(held).toHaveLength(1);
    await held[0];
    expect(object.env).toMatchObject({ ENCRYPTION_KEY: 'k2', DATABASE: { binding: 'db' } });
  });

  it('has them before the original constructor runs when the isolate already loaded them', async () => {
    fetchMock.mockImplementation(ok({ ENCRYPTION_KEY: 'k3' }));
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
