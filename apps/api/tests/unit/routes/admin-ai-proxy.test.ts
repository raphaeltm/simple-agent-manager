import type { Context } from 'hono';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { createMemoryKv } from '../../helpers/sqlite-d1';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => (_c: unknown, next: () => Promise<void>) => next(),
  requireSuperadmin: () => (_c: unknown, next: () => Promise<void>) => next(),
}));

// Not mocking ../../../src/lib/logger: the real logger is side-effect-free
// (structured console output only), and handleAppError below also imports
// serializeError from that same module — a partial mock would strand it.
const { adminAIProxyRoutes } = await import('../../../src/routes/admin-ai-proxy');

// Workers AI models require no platform credential or Unified Billing token,
// so PUT /config can succeed against a minimal Env (no DATABASE binding).
const WORKERS_AI_MODEL_ID = '@cf/meta/llama-4-scout-17b-16e-instruct';

function bindings(overrides: Partial<Env> = {}): Env {
  return { KV: createMemoryKv(), ...overrides } as Env;
}

function app(): Hono<{ Bindings: Env }> {
  const hono = new Hono<{ Bindings: Env }>();
  hono.onError((err, c: Context) => handleAppError(err as Error, c));
  hono.route('/api/admin/ai-proxy', adminAIProxyRoutes);
  return hono;
}

describe('admin AI proxy config routes — PUT /config (defaultModel)', () => {
  let honoApp: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    honoApp = app();
  });

  it('accepts a valid workers-ai model and persists it to KV', async () => {
    const env = bindings();
    const res = await honoApp.request(
      '/api/admin/ai-proxy/config',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultModel: WORKERS_AI_MODEL_ID }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { defaultModel: string; source: string };
    expect(body.defaultModel).toBe(WORKERS_AI_MODEL_ID);
    expect(body.source).toBe('admin');
  });

  it('rejects a malformed JSON body with the standard jsonValidator 400 shape', async () => {
    const res = await honoApp.request(
      '/api/admin/ai-proxy/config',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '{not valid json',
      },
      bindings()
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('BAD_REQUEST');
  });

  it('preserves the handler-produced message when defaultModel is missing', async () => {
    const res = await honoApp.request(
      '/api/admin/ai-proxy/config',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      bindings()
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe('defaultModel is required');
  });

  it('preserves the handler-produced message when defaultModel is the wrong type', async () => {
    const res = await honoApp.request(
      '/api/admin/ai-proxy/config',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultModel: 123 }),
      },
      bindings()
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe('defaultModel is required');
  });

  it('preserves the unknown-model message unchanged (edge case)', async () => {
    const res = await honoApp.request(
      '/api/admin/ai-proxy/config',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultModel: 'does-not-exist' }),
      },
      bindings()
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain('Unknown model: does-not-exist');
  });
});

describe('admin AI proxy config routes — PATCH /config (billingMode)', () => {
  let honoApp: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    honoApp = app();
  });

  it('accepts a valid billing mode and persists it to KV', async () => {
    const res = await honoApp.request(
      '/api/admin/ai-proxy/config',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ billingMode: 'auto' }),
      },
      bindings()
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { billingMode: string };
    expect(body.billingMode).toBe('auto');
  });

  it('rejects a malformed JSON body with the standard jsonValidator 400 shape', async () => {
    const res = await honoApp.request(
      '/api/admin/ai-proxy/config',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: '{not valid json',
      },
      bindings()
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('BAD_REQUEST');
  });

  it('preserves the handler-produced message when billingMode is missing', async () => {
    const res = await honoApp.request(
      '/api/admin/ai-proxy/config',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      bindings()
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe('billingMode is required');
  });

  it('preserves the handler-produced message when billingMode is the wrong type', async () => {
    const res = await honoApp.request(
      '/api/admin/ai-proxy/config',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ billingMode: true }),
      },
      bindings()
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe('billingMode is required');
  });

  it('rejects an invalid enum value with the original message', async () => {
    const res = await honoApp.request(
      '/api/admin/ai-proxy/config',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ billingMode: 'bogus' }),
      },
      bindings()
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain('Invalid billing mode: bogus');
  });

  it('preserves the unified-without-token guard (unchanged business edge case)', async () => {
    const res = await honoApp.request(
      '/api/admin/ai-proxy/config',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ billingMode: 'unified' }),
      },
      bindings({ CF_AIG_TOKEN: undefined })
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain('Cannot set billing mode to "unified"');
  });
});
