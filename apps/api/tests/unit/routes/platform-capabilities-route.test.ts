/**
 * GET /api/config/platform-capabilities through the real Worker app (src/index.ts), so the
 * mount, the absence of auth and the cache headers are what production serves.
 *
 * A Cloudflare deployment with the Workers AI binding must report every capability, and a
 * runtime without it must report the Workers AI services absent. Both configurations are
 * exercised so neither can be satisfied by a constant.
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

function cloudflareEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    AI: { run: vi.fn(), models: vi.fn() },
    AI_GATEWAY_ID: 'sam',
    CF_ACCOUNT_ID: 'account-1',
    CF_API_TOKEN: 'token-1',
    CF_ZONE_ID: 'zone-1',
    ...overrides,
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
  it('reports every capability, unauthenticated, when the Workers AI binding is present', async () => {
    const { res, body } = await getCapabilities(cloudflareEnv());

    expect(res.status).toBe(200);
    expect(body).toEqual({ speechToText: true, textToSpeech: true, agentModelCalls: true });
    // Public config: cacheable by the browser like the other /api/config answers.
    expect(res.headers.get('Cache-Control')).toMatch(/max-age=\d+/);
  });

  it('reports the Workers AI services absent on a runtime without the binding', async () => {
    const { res, body } = await getCapabilities(cloudflareEnv({ AI: undefined }));

    expect(res.status).toBe(200);
    expect(body).toEqual({ speechToText: false, textToSpeech: false, agentModelCalls: false });
    expect(res.headers.get('Cache-Control')).toContain('no-store');
  });

  it('turns text-to-speech off with TTS_ENABLED=false while speech-to-text stays on', async () => {
    const { body } = await getCapabilities(cloudflareEnv({ TTS_ENABLED: 'false' }));

    expect(body.speechToText).toBe(true);
    expect(body.textToSpeech).toBe(false);
  });

  it('does no D1 or KV I/O', async () => {
    const prepare = vi.fn();
    const kvGet = vi.fn();
    const { res } = await getCapabilities(
      cloudflareEnv({ DATABASE: { prepare }, KV: { get: kvGet } })
    );

    expect(res.status).toBe(200);
    expect(prepare).not.toHaveBeenCalled();
    expect(kvGet).not.toHaveBeenCalled();
  });

  it('exposes only booleans (no secrets) in the public payload', async () => {
    const { body } = await getCapabilities(cloudflareEnv());

    for (const value of Object.values(body)) expect(typeof value).toBe('boolean');
    expect(JSON.stringify(body)).not.toContain('token-1');
    expect(JSON.stringify(body)).not.toContain('account-1');
  });
});
