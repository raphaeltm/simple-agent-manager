/**
 * Admin model-tier restrictions, enforced through the real AI proxy routes.
 *
 * Every platform-credential route (`/ai/v1/chat/completions`, `/ai/v1/responses`,
 * `/ai/anthropic/v1/messages`, `/ai/anthropic/v1/messages/count_tokens`) runs for real: request
 * admission, the model catalog, the tier gate, billing resolution and upstream forwarding. Only
 * workspace-token auth (JWT + D1 lookups) and the network are stubbed, and the upstream stub
 * records what would have been spent. The vertical case writes the restriction through the real
 * admin route, so the admin write format and the proxy read are tested together.
 */
import { getPlatformAIModelTier } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { createMemoryKv, createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/services/ai-proxy-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/ai-proxy-shared')>()),
  verifyAIProxyAuth: vi.fn(async () => ({
    userId: 'user-1',
    workspaceId: 'ws-1',
    projectId: 'project-1',
    chatSessionId: null,
    agentType: null,
    agentSessionId: null,
    agentCredentialGeneration: 0,
  })),
}));
vi.mock('../../../src/middleware/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/middleware/auth')>()),
  requireAuth: () => async (c: Context, next: Next) => {
    c.set('auth', {
      user: {
        id: 'admin-1',
        email: 'admin@example.com',
        name: 'Admin',
        avatarUrl: null,
        role: 'superadmin',
        status: 'active',
      },
      session: { id: 'session-1', expiresAt: new Date('2099-01-01T00:00:00.000Z') },
    });
    await next();
  },
  requireApproved: () => async (_c: Context, next: Next) => next(),
  requireSuperadmin: () => async (_c: Context, next: Next) => next(),
}));

const { aiProxyRoutes } = await import('../../../src/routes/ai-proxy');
const { aiProxyAnthropicRoutes } = await import('../../../src/routes/ai-proxy-anthropic');
const { adminAiAllowanceRoutes } = await import('../../../src/routes/admin-ai-allowance');

const ALLOWANCE_KEY = 'ai-admin-allowance:user-1';

type ProxyRoute = 'chat/completions' | 'responses' | 'messages' | 'count_tokens';

const ROUTES: Array<{ route: ProxyRoute; standard: string; premium: string }> = [
  { route: 'chat/completions', standard: 'claude-sonnet-5', premium: 'claude-opus-5-5' },
  { route: 'responses', standard: 'gpt-6-luna', premium: 'gpt-6-sol' },
  { route: 'messages', standard: 'claude-sonnet-5', premium: 'claude-opus-5-5' },
  { route: 'count_tokens', standard: 'claude-sonnet-5', premium: 'claude-opus-5-5' },
];

const LOW_COST_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';

/** Upstream requests the proxy actually sent, i.e. what a request spent. */
let upstreamCalls: Array<{ url: string; model: unknown }> = [];

function upstreamResponse(url: string): Response {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  if (url.endsWith('/anthropic/v1/messages/count_tokens')) return json({ input_tokens: 12 });
  if (url.endsWith('/anthropic/v1/messages')) {
    return json({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 2 },
    });
  }
  if (url.endsWith('/openai/v1/responses')) {
    return json({
      id: 'resp_1',
      object: 'response',
      output: [],
      usage: { input_tokens: 3, output_tokens: 2 },
    });
  }
  if (url.endsWith('/chat/completions')) {
    return json({
      id: 'chatcmpl_1',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
  }
  return new Response('unexpected upstream', { status: 404 });
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.users]);
  sqlite.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('user-1', 'user1@example.com');
  return {
    DATABASE: createSqliteD1(sqlite),
    KV: createMemoryKv(),
    AI_PROXY_ENABLED: 'true',
    CF_ACCOUNT_ID: 'account-1',
    CF_API_TOKEN: 'cf-token',
    AI_GATEWAY_ID: 'gateway-1',
    ...overrides,
  } as Env;
}

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.route('/api/admin/ai-allowance', adminAiAllowanceRoutes);
  app.route('/ai/v1', aiProxyRoutes);
  app.route('/ai/anthropic/v1', aiProxyAnthropicRoutes);
  return app;
}

function proxy(app: Hono<{ Bindings: Env }>, env: Env, route: ProxyRoute, model: string) {
  const messages = [{ role: 'user', content: 'hello' }];
  const request = (path: string, headers: Record<string, string>, body: unknown) =>
    app.request(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      },
      env
    );
  switch (route) {
    case 'chat/completions':
      return request(
        '/ai/v1/chat/completions',
        { Authorization: 'Bearer ws-token' },
        { model, messages }
      );
    case 'responses':
      return request(
        '/ai/v1/responses',
        { Authorization: 'Bearer ws-token' },
        { model, input: 'hello' }
      );
    case 'messages':
      return request(
        '/ai/anthropic/v1/messages',
        { 'x-api-key': 'ws-token' },
        { model, max_tokens: 16, messages }
      );
    case 'count_tokens':
      return request(
        '/ai/anthropic/v1/messages/count_tokens',
        { 'x-api-key': 'ws-token' },
        { model, messages }
      );
  }
}

async function restrict(env: Env, allowedModelTiers: unknown): Promise<void> {
  await env.KV.put(ALLOWANCE_KEY, JSON.stringify({ allowedModelTiers }));
}

async function denial(res: Response): Promise<{ type: string; message: string }> {
  expect(res.status).toBe(403);
  const body = (await res.json()) as { error: { type: string; message: string } };
  return body.error;
}

let warnLines: string[] = [];

beforeEach(() => {
  upstreamCalls = [];
  warnLines = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as { model?: unknown }) : {};
    upstreamCalls.push({ url, model: body.model });
    return upstreamResponse(url);
  });
  vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
    warnLines.push(String(line));
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(ROUTES)('model-tier gate on $route', ({ route, standard, premium }) => {
  it('uses models whose catalog tiers the scenarios below depend on', () => {
    expect(getPlatformAIModelTier(standard)).toBe('standard');
    expect(getPlatformAIModelTier(premium)).toBe('premium');
  });

  it('serves an allowed tier and forwards exactly that model upstream', async () => {
    const env = makeEnv();
    await restrict(env, ['standard']);

    const res = await proxy(makeApp(), env, route, standard);

    expect(res.status).toBe(200);
    expect(upstreamCalls).toEqual([expect.objectContaining({ model: standard })]);
  });

  it('refuses a disallowed tier with 403 before anything is sent upstream', async () => {
    const env = makeEnv();
    await restrict(env, ['standard']);

    const error = await denial(await proxy(makeApp(), env, route, premium));

    expect(error.type).toBe('permission_error');
    expect(error.message).toBe(
      `Model '${premium}' is in the premium tier, which your account is not allowed to use. Allowed tiers: standard.`
    );
    expect(upstreamCalls).toEqual([]);
    expect(warnLines.some((line) => line.includes('model_tier_denied'))).toBe(true);
  });

  it('serves every tier when allowedModelTiers is null', async () => {
    const env = makeEnv();
    await restrict(env, null);

    expect((await proxy(makeApp(), env, route, premium)).status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
  });

  it('serves every tier when the user has no allowance at all', async () => {
    const env = makeEnv();

    expect((await proxy(makeApp(), env, route, premium)).status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
  });

  it('refuses every model when the allowance lists no tier', async () => {
    const env = makeEnv();
    await restrict(env, []);

    const error = await denial(await proxy(makeApp(), env, route, standard));

    expect(error.message).toContain('Allowed tiers: none.');
    expect(upstreamCalls).toEqual([]);
  });

  it('fails closed on a stored allowance it cannot read', async () => {
    const env = makeEnv();
    await restrict(env, 'standard');

    const error = await denial(await proxy(makeApp(), env, route, standard));

    expect(error.message).toContain('could not be read');
    expect(upstreamCalls).toEqual([]);
  });

  it('refuses without spending when the allowance read itself fails', async () => {
    const env = makeEnv();
    const kv = env.KV;
    env.KV = {
      ...kv,
      get: async (key: string, type?: string) => {
        if (key === ALLOWANCE_KEY) throw new Error('KV unavailable');
        return (kv.get as (k: string, t?: string) => Promise<unknown>)(key, type);
      },
    } as KVNamespace;

    const res = await proxy(makeApp(), env, route, standard);

    expect(res.status).toBe(500);
    expect(upstreamCalls).toEqual([]);
  });
});

describe('models the catalog does not tier', () => {
  it('native Anthropic route: refuses an untiered claude-* ID under a restriction, serves it without one', async () => {
    const untiered = 'claude-sonnet-4-5';
    expect(getPlatformAIModelTier(untiered)).toBeNull();

    const restricted = makeEnv();
    await restrict(restricted, ['standard', 'premium']);
    const error = await denial(await proxy(makeApp(), restricted, 'messages', untiered));
    expect(error.message).toBe(
      `Model '${untiered}' has no tier in the platform model catalog, and your account is limited to these tiers: standard, premium.`
    );
    expect(upstreamCalls).toEqual([]);

    expect((await proxy(makeApp(), makeEnv(), 'messages', untiered)).status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
  });

  it('chat completions: refuses an operator-allowlisted model that has no catalog tier', async () => {
    const operatorModel = '@cf/operator/extra-model';
    const allowlist = { AI_PROXY_ALLOWED_MODELS: `${operatorModel},${LOW_COST_MODEL}` };

    const restricted = makeEnv(allowlist);
    await restrict(restricted, ['low-cost', 'standard', 'premium']);
    const error = await denial(
      await proxy(makeApp(), restricted, 'chat/completions', operatorModel)
    );
    expect(error.message).toContain('has no tier in the platform model catalog');
    expect(upstreamCalls).toEqual([]);

    expect(
      (await proxy(makeApp(), makeEnv(allowlist), 'chat/completions', operatorModel)).status
    ).toBe(200);
  });
});

describe('the default model is gated like a requested one', () => {
  it('chat completions without a model resolves the default first, then applies the restriction', async () => {
    // Omitting `model` must not be a way around the restriction: the proxy resolves the default
    // (`resolveModelId`) before the gate, and the default Workers AI model is low-cost.
    expect(getPlatformAIModelTier(LOW_COST_MODEL)).toBe('low-cost');
    const withoutModel = (env: Env) =>
      makeApp().request(
        '/ai/v1/chat/completions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ws-token' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
        },
        env
      );

    const restricted = makeEnv();
    await restrict(restricted, ['standard']);
    const error = await denial(await withoutModel(restricted));
    expect(error.message).toContain(`Model '${LOW_COST_MODEL}' is in the low-cost tier`);
    expect(upstreamCalls).toEqual([]);

    const allowed = makeEnv();
    await restrict(allowed, ['low-cost']);
    expect((await withoutModel(allowed)).status).toBe(200);
    expect(upstreamCalls).toEqual([expect.objectContaining({ model: LOW_COST_MODEL })]);
  });
});

describe('restriction written through the real admin route', () => {
  it('is enforced by the proxy and lifted again by setting it to null', async () => {
    const app = makeApp();
    const env = makeEnv();
    const setTiers = (allowedModelTiers: unknown) =>
      app.request(
        '/api/admin/ai-allowance/user-1',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ allowedModelTiers }),
        },
        env
      );

    expect((await setTiers(['low-cost'])).status).toBe(200);
    await denial(await proxy(app, env, 'chat/completions', 'claude-sonnet-5'));
    expect((await proxy(app, env, 'chat/completions', LOW_COST_MODEL)).status).toBe(200);
    expect(upstreamCalls.map((call) => call.model)).toEqual([LOW_COST_MODEL]);

    expect((await setTiers(null)).status).toBe(200);
    expect((await proxy(app, env, 'chat/completions', 'claude-sonnet-5')).status).toBe(200);
    expect(upstreamCalls.map((call) => call.model)).toEqual([LOW_COST_MODEL, 'claude-sonnet-5']);
  });
});
