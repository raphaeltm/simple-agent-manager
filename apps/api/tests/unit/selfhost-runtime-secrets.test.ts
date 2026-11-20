/**
 * The API Worker's side of sealed self-host secrets (src/selfhost/runtime-secrets.ts): cached per
 * isolate after the first success, each cold caller making its own request (never joining
 * another request's load), fail closed when the agent is unreachable or answers wrongly, and
 * Durable Objects held until their secrets arrive. The agent is reached over a socket speaking the
 * framed protocol (never HTTP, finding F9); here an in-memory socket decodes the real request frame
 * and answers like the agent. The same module against the real agent and celld:
 * selfhost-sealed-secrets-contract.test.ts and scripts/selfhost/live/key-agent-celld.live.test.ts.
 */
import { generateKeyPairSync, sign } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  KEY_AGENT_PREAMBLE,
  type KeyAgentSocket,
  loadRuntimeSecrets,
  resetRuntimeSecretsForTests,
  wrapDurableObject,
  wrapWorker,
} from '../../src/selfhost/runtime-secrets';

type Envelope = Record<string, unknown>;
type Agent = (request: Record<string, unknown>) => Promise<Envelope>;

/**
 * A socket that reads one request frame (checking the preamble and length), hands its JSON to
 * the agent mock, and returns the agent's envelope framed the way server.ts frames it.
 */
function fakeConnect(agent: Agent) {
  return vi.fn((_address: { hostname: string; port: number }): KeyAgentSocket => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
    const written: number[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        written.push(...chunk);
        const bytes = Buffer.from(written);
        const head = Buffer.byteLength(KEY_AGENT_PREAMBLE);
        if (bytes.length < head + 4) return;
        expect(bytes.subarray(0, head).toString('utf8')).toBe(KEY_AGENT_PREAMBLE);
        const length = bytes.readUInt32BE(head);
        if (bytes.length < head + 4 + length) return;
        const request = JSON.parse(bytes.subarray(head + 4).toString('utf8')) as Record<
          string,
          unknown
        >;
        void agent(request).then(
          (envelope) => {
            const json = Buffer.from(JSON.stringify(envelope));
            const out = Buffer.alloc(4 + json.length);
            out.writeUInt32BE(json.length);
            json.copy(out, 4);
            controller.enqueue(new Uint8Array(out));
            controller.close();
          },
          (error: unknown) => controller.error(error)
        );
      },
    });
    return { readable, writable, close: async () => undefined };
  });
}

const BUNDLE = 'ab'.repeat(16);
const agentKey = generateKeyPairSync('ed25519');
const VERIFY_KEY = Buffer.from(
  String(agentKey.publicKey.export({ format: 'jwk' }).x),
  'base64url'
).toString('base64');
const env = () => ({
  SAM_KEY_AGENT_ADDRESS: '127.0.0.1:7190',
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
  return async (request: Record<string, unknown>): Promise<Envelope> => {
    const text = JSON.stringify({
      bundleId: overrides.bundleId ?? BUNDLE,
      nonce: overrides.nonce ?? request.nonce,
      secrets,
    });
    const signature = sign(null, Buffer.from(text), overrides.signWith ?? agentKey.privateKey);
    return overrides.unsigned
      ? { status: 200, body: text }
      : { status: 200, body: text, signature: signature.toString('base64') };
  };
}
const ok = (secrets: Record<string, string>) => answer(secrets);
const ctx = {} as ExecutionContext;

let fetchMock: ReturnType<typeof vi.fn<Agent>>;
let connect: ReturnType<typeof fakeConnect>;
beforeEach(() => {
  fetchMock = vi.fn<Agent>();
  connect = fakeConnect((request) => fetchMock(request));
  resetRuntimeSecretsForTests(connect);
  // The loader never uses fetch: any call fails the test.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('fetch must not be used')))
  );
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
    expect(connect).toHaveBeenCalledWith({ hostname: '127.0.0.1', port: 7190 });
    expect(fetchMock.mock.calls[0]?.[0]).toMatchObject({ op: 'secrets', bundleId: BUNDLE });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(seen[0]).toMatchObject({ ENCRYPTION_KEY: 'k1', DATABASE: { binding: 'db' } });
    expect(base).not.toHaveProperty('ENCRYPTION_KEY'); // the runtime's env is never mutated
  });

  it('never makes a cold request wait on another request’s load', async () => {
    // celld drops a load whose request's client disconnected: that fetch never settles. Model it
    // as a fetch that never resolves, then prove the next request does not wait on it.
    const respond = ok({ A_SECRET: 'v' });
    fetchMock
      .mockImplementationOnce(() => new Promise<Envelope>(() => undefined))
      .mockImplementation(respond);
    const worker = wrapWorker({ fetch: async () => new Response('ok') });
    const stuck = worker.fetch!(new Request('https://api/'), env(), ctx);
    let stuckSettled = false;
    void stuck.then(() => (stuckSettled = true));
    const next = await worker.fetch!(new Request('https://api/'), env(), ctx);
    expect(next.status).toBe(200);
    expect(stuckSettled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The success is cached: a third request asks nobody.
    expect((await worker.fetch!(new Request('https://api/'), env(), ctx)).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('lets concurrent cold requests each ask the agent once', async () => {
    fetchMock.mockImplementation(ok({ A_SECRET: 'v' }));
    const worker = wrapWorker({ fetch: async () => new Response('ok') });
    const statuses = await Promise.all(
      [1, 2, 3].map(
        async () => (await worker.fetch!(new Request('https://api/'), env(), ctx)).status
      )
    );
    expect(statuses).toEqual([200, 200, 200]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
    ['a refusal', async () => ({ status: 403, error: 'peer_refused' }), 'KEY_AGENT_REFUSED'],
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
      answer({ SAM_KEY_AGENT_ADDRESS: '127.0.0.1:1' }),
      'KEY_AGENT_BAD_RESPONSE',
    ],
    ['an answer with no body', async () => ({ status: 200 }), 'KEY_AGENT_REFUSED'],
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
    resetRuntimeSecretsForTests(connect);
    await loadRuntimeSecrets(env());
    resetRuntimeSecretsForTests(connect);
    const bodies = fetchMock.mock.calls.map(([request]) => request as Record<string, string>);
    expect(bodies[0]).toMatchObject({ bundleId: BUNDLE, installationId: 'c'.repeat(32) });
    expect(bodies[0]?.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(bodies[0]?.nonce).not.toBe(bodies[1]?.nonce);
  });

  it.each(['attacker.example:7190', 'http://127.0.0.1:7190/v1/secrets', '127.0.0.1:0', ''])(
    'refuses an agent address that is not a loopback socket (%s), before connecting',
    async (address) => {
      const res = await wrapWorker({ fetch: async () => new Response('ok') }).fetch!(
        new Request('https://api/'),
        { ...env(), SAM_KEY_AGENT_ADDRESS: address },
        ctx
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: 'SECRETS_MISCONFIGURED' });
      expect(connect).not.toHaveBeenCalled();
    }
  );

  it('gives up on an agent that never answers, after SAM_KEY_AGENT_TIMEOUT_MS', async () => {
    fetchMock.mockImplementation(() => new Promise<Envelope>(() => undefined));
    const res = await wrapWorker({ fetch: async () => new Response('ok') }).fetch!(
      new Request('https://api/'),
      { ...env(), SAM_KEY_AGENT_TIMEOUT_MS: '50' },
      ctx
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'KEY_AGENT_UNREACHABLE' });
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

describe('refresh after SAM_RUNTIME_SECRETS_TTL_MS (security review M-2)', () => {
  const ttlEnv = () => ({ ...env(), SAM_RUNTIME_SECRETS_TTL_MS: '1000' });
  let now = 1_000_000;
  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });

  it('asks again once due, and takes the new answer', async () => {
    fetchMock.mockImplementationOnce(ok({ K: 'v1' })).mockImplementationOnce(ok({ K: 'v2' }));
    expect((await loadRuntimeSecrets(ttlEnv())).K).toBe('v1');
    now += 999;
    expect((await loadRuntimeSecrets(ttlEnv())).K).toBe('v1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += 2;
    expect((await loadRuntimeSecrets(ttlEnv())).K).toBe('v2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a refusal once due ends the copy (revocation reaches a long-lived isolate)', async () => {
    fetchMock
      .mockImplementationOnce(ok({ K: 'v1' }))
      .mockImplementation(async () => ({ status: 503, error: 'key_service_denied' }));
    await loadRuntimeSecrets(ttlEnv());
    now += 1001;
    await expect(loadRuntimeSecrets(ttlEnv())).rejects.toThrow(/answered 503/);
    // And it stays ended: the next request asks again rather than reviving the old copy.
    await expect(loadRuntimeSecrets(ttlEnv())).rejects.toThrow(/answered 503/);
  });

  it('control: an unreachable agent once due keeps the copy (an agent restart is not an outage)', async () => {
    fetchMock
      .mockImplementationOnce(ok({ K: 'v1' }))
      .mockRejectedValue(new TypeError('connection refused'));
    await loadRuntimeSecrets(ttlEnv());
    now += 1001;
    expect((await loadRuntimeSecrets(ttlEnv())).K).toBe('v1');
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
