/**
 * GET /api/config/platform-capabilities through the real Worker app (src/index.ts).
 *
 * Self-hosting guard: a Cloudflare deployment with every binding and credential present must
 * report every capability, and a runtime without Cloudflare-only services must report them
 * absent. Both configurations are exercised so neither can be satisfied by a constant.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

// The Worker entry imports Cloudflare runtime modules that cannot load in Node. Stub only those.
vi.mock('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }), {
  virtual: true,
});
vi.mock('@cloudflare/sandbox', () => ({ Sandbox: class {} }));
vi.mock('@cloudflare/containers', () => ({
  Container: class {},
  switchPort: vi.fn((request: Request) => request),
}));

let worker: (typeof import('../../../src/index'))['default'];

beforeAll(async () => {
  worker = (await import('../../../src/index')).default;
}, 120_000);

const stubBinding = (extra: Record<string, unknown> = {}) => ({ ...extra });

/** Every binding and credential a Cloudflare deployment has for the capability resolver. */
function cloudflareEnv(): Env {
  return {
    AI: { run: vi.fn() },
    AI_GATEWAY_ID: 'sam',
    CF_ACCOUNT_ID: 'account-1',
    CF_API_TOKEN: 'token-1',
    CF_ZONE_ID: 'zone-1',
    ANALYTICS: stubBinding({ writeDataPoint: vi.fn() }),
    ARTIFACTS: stubBinding(),
    ARTIFACTS_ENABLED: 'true',
    SANDBOX: stubBinding(),
    CREDENTIAL_SETUP_SESSION: stubBinding(),
    SETUP_SESSION_POOL: stubBinding(),
  } as unknown as Env;
}

/**
 * What wrangler.toml ships by default with no Cloudflare account behind it: AI_GATEWAY_ID="sam"
 * is a default var, so the gateway id is present, but there is no account, token, AI binding or
 * analytics binding, and the container runtime is declared absent.
 */
function selfHostedEnv(): Env {
  return {
    AI_GATEWAY_ID: 'sam',
    CONTAINER_RUNTIME_AVAILABLE: 'false',
    // Plain Durable Object bindings still exist on celld; the container runtime behind them does not.
    SANDBOX: stubBinding(),
    CREDENTIAL_SETUP_SESSION: stubBinding(),
    SETUP_SESSION_POOL: stubBinding(),
  } as unknown as Env;
}

async function getCapabilities(env: Env) {
  const res = await worker.fetch(
    new Request('https://api.fixture.example/api/config/platform-capabilities'),
    env,
    { waitUntil: () => undefined, passThroughOnException: () => undefined } as never
  );
  return { res, body: (await res.json()) as Record<string, boolean> };
}

describe('GET /api/config/platform-capabilities', () => {
  it('reports every capability when the Cloudflare bindings and credentials are present', async () => {
    const { res, body } = await getCapabilities(cloudflareEnv());

    expect(res.status).toBe(200);
    // Booleans the UI reads, and nothing else (no configuration fingerprint beyond them).
    expect(body).toEqual({ speechToText: true, textToSpeech: true });
  });

  it('reports the Cloudflare-only capabilities absent on a runtime without them', async () => {
    const { res, body } = await getCapabilities(selfHostedEnv());

    expect(res.status).toBe(200);
    expect(body).toEqual({ speechToText: false, textToSpeech: false });
  });

  it('turns text-to-speech off with TTS_ENABLED=false while speech-to-text stays on', async () => {
    const { body } = await getCapabilities({ ...cloudflareEnv(), TTS_ENABLED: 'false' } as Env);

    expect(body.speechToText).toBe(true);
    expect(body.textToSpeech).toBe(false);
  });

  it('exposes only booleans (no secrets) in the public payload', async () => {
    const { body } = await getCapabilities(cloudflareEnv());

    for (const value of Object.values(body)) expect(typeof value).toBe('boolean');
    expect(JSON.stringify(body)).not.toContain('token-1');
    expect(JSON.stringify(body)).not.toContain('account-1');
  });
});

describe('GET /api/config/instant-runtime', () => {
  const instantEnv = (overrides: Record<string, unknown> = {}) =>
    ({
      CF_CONTAINER_ENABLED: 'true',
      VM_AGENT_CONTAINER: stubBinding(),
      ...overrides,
    }) as unknown as Env;

  async function getInstant(env: Env) {
    const res = await worker.fetch(
      new Request('https://api.fixture.example/api/config/instant-runtime'),
      env,
      { waitUntil: () => undefined, passThroughOnException: () => undefined } as never
    );
    return { res, body: (await res.json()) as { enabled: boolean } };
  }

  it('is enabled when the container runtime is on and CONTAINER_RUNTIME_AVAILABLE is unset (Cloudflare behaviour)', async () => {
    const { res, body } = await getInstant(instantEnv());

    expect(res.status).toBe(200);
    expect(body.enabled).toBe(true);
  });

  it('is disabled when CONTAINER_RUNTIME_AVAILABLE=false even with the flag and binding present', async () => {
    const { res, body } = await getInstant(instantEnv({ CONTAINER_RUNTIME_AVAILABLE: 'false' }));

    expect(res.status).toBe(200);
    expect(body.enabled).toBe(false);
  });
});

