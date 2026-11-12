/**
 * A1 + A2 (overnight B3): the SAM AI proxy on an installation without Cloudflare AI Gateway.
 *
 * Through the real `/ai/anthropic/v1/messages` route, the real admin settings store (SQLite), the
 * real rate limiter, daily token budget, model allowlist, usage accounting and monthly cost cap
 * (KV fallback, no Durable Object), and the real budget route. Stubbed at the boundary only: the
 * workspace callback-token check, the platform credential row, and the provider (global fetch).
 *
 * - With no gateway the proxy is off until an admin turns on `aiProxy.directUpstreamEnabled`.
 * - On, it calls api.anthropic.com directly with the platform key and no gateway headers.
 * - SAM prices each call from PLATFORM_AI_MODELS; once the month's total reaches the user's cap
 *   the next call is refused with 429 (monthly-cost-cap) without reaching the provider.
 * - Allowlist and daily budget still refuse before the provider.
 * - Cloudflare control: with a gateway the proxy is on without the setting, calls go to the
 *   gateway, nothing is priced locally and the cap reads the gateway-cron cache.
 */
import { PLATFORM_AI_MODELS } from '@simple-agent-manager/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/ai-proxy-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/ai-proxy-shared')>();
  return {
    ...actual,
    // The workspace callback-token check (JWT + D1 workspace lifecycle) is out of scope here.
    verifyAIProxyAuth: async (token: string) => {
      if (token !== 'workspace-callback-token') throw new actual.AIProxyAuthError('bad token');
      return {
        userId: USER,
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        chatSessionId: 'chat-1',
      };
    },
    updateAIProxyAgentCredentialAttribution: async () => undefined,
  };
});
vi.mock('../../../src/services/platform-credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/platform-credentials')>()),
  getPlatformAgentCredential: async () => ({
    credential: PLATFORM_KEY,
    credentialId: 'platform-cred-1',
  }),
}));
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getUserId: () => USER,
}));

import type { Env } from '../../../src/env';
import { aiProxyAnthropicRoutes } from '../../../src/routes/ai-proxy-anthropic';
import { usageRoutes } from '../../../src/routes/usage';
import { updateAdminSettings } from '../../../src/services/admin-settings-mutations';
import { __resetAdminSettingsCacheForTest } from '../../../src/services/admin-settings-resolution';
import { priceModelUsageUsd } from '../../../src/services/ai-cost-pricing';
import {
  buildMonthlyCostCacheKey,
  getLocalMonthlyAiCostUsd,
} from '../../../src/services/ai-token-budget';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

const USER = 'selfhost-user-1';
const PLATFORM_KEY = 'sk-ant-platform-key-for-tests-0000';
const MODEL = PLATFORM_AI_MODELS.find(
  (m) => m.provider === 'anthropic' && m.id.startsWith('claude-')
)!;
const OTHER_MODEL = PLATFORM_AI_MODELS.find(
  (m) => m.provider === 'anthropic' && m.id.startsWith('claude-') && m.id !== MODEL.id
)!;
const USAGE = {
  input_tokens: 200_000,
  output_tokens: 50_000,
  cache_read_input_tokens: 100_000,
  cache_creation_input_tokens: 10_000,
};
const COST_PER_CALL = priceModelUsageUsd(MODEL, {
  inputTokens:
    USAGE.input_tokens + USAGE.cache_read_input_tokens + USAGE.cache_creation_input_tokens,
  outputTokens: USAGE.output_tokens,
  cachedInputTokens: USAGE.cache_read_input_tokens,
  cacheWriteInputTokens: USAGE.cache_creation_input_tokens,
});

const fetchMock = vi.fn();

function providerResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: MODEL.id,
      content: [{ type: 'text', text: 'hello' }],
      usage: USAGE,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

type Fixture = ReturnType<typeof createAdminSettingsEnv>;

function boxEnv(overrides: Partial<Env> = {}): Fixture {
  return createAdminSettingsEnv({
    // What the celld config generator ships (scripts/selfhost/celld-config.ts).
    AI_GATEWAY_ID: '',
    AI_PROXY_ENABLED: 'true',
    AI_PROXY_ALLOWED_MODELS: MODEL.id,
    BASE_DOMAIN: 'sam.example.com',
    ...overrides,
  });
}

function app(): Hono<{ Bindings: Env }> {
  const hono = new Hono<{ Bindings: Env }>();
  hono.route('/ai/anthropic/v1', aiProxyAnthropicRoutes);
  hono.route('/api/usage', usageRoutes);
  return hono;
}

function sendMessage(env: Env, model = MODEL.id): Promise<Response> {
  return app().request(
    '/ai/anthropic/v1/messages',
    {
      method: 'POST',
      headers: {
        'x-api-key': 'workspace-callback-token',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    },
    env
  );
}

async function enableDirectUpstream(env: Env, value = true): Promise<void> {
  await updateAdminSettings(env, {
    changes: [{ name: 'aiProxy.directUpstreamEnabled', value }],
    actorUserId: 'admin-1',
  });
}

async function setMonthlyCap(env: Env, capUsd: number): Promise<Response> {
  return app().request(
    '/api/usage/ai/budget',
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monthlyCostCapUsd: capUsd }),
    },
    env
  );
}

beforeEach(() => {
  __resetAdminSettingsCacheForTest();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => providerResponse());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AI proxy without AI Gateway: admin switch (A1)', () => {
  it('is off by default and says which admin setting turns it on', async () => {
    const { env } = boxEnv();
    const res = await sendMessage(env);

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('aiProxy.directUpstreamEnabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('when an admin turns it on, calls Anthropic directly with the platform key', async () => {
    const { env } = boxEnv();
    await enableDirectUpstream(env);

    const res = await sendMessage(env);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = new Headers(init.headers);
    expect(headers.get('x-api-key')).toBe(PLATFORM_KEY);
    // No gateway, so no Cloudflare billing token and no SAM ids leave for a third party.
    expect(headers.get('cf-aig-authorization')).toBeNull();
    expect(headers.get('cf-aig-metadata')).toBeNull();
  });

  it('turning the setting back off refuses again', async () => {
    const { env } = boxEnv();
    await enableDirectUpstream(env, true);
    expect((await sendMessage(env)).status).toBe(200);
    await enableDirectUpstream(env, false);
    __resetAdminSettingsCacheForTest();

    expect((await sendMessage(env)).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the AI_PROXY_ENABLED kill switch still wins over the setting', async () => {
    const { env } = boxEnv({ AI_PROXY_ENABLED: 'false' });
    await enableDirectUpstream(env);

    const res = await sendMessage(env);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      'AI proxy is disabled'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still enforces the model allowlist before reaching the provider', async () => {
    const { env } = boxEnv();
    await enableDirectUpstream(env);

    const res = await sendMessage(env, OTHER_MODEL.id);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still enforces the daily token budget before reaching the provider', async () => {
    const { env } = boxEnv({ AI_PROXY_DAILY_INPUT_TOKEN_LIMIT: '250000' });
    await enableDirectUpstream(env);

    expect((await sendMessage(env)).status).toBe(200); // 200k input tokens recorded
    expect((await sendMessage(env)).status).toBe(200); // 400k now, over the 250k limit
    const refused = await sendMessage(env);

    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain(
      'Daily token budget'
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still enforces the per-user request rate limit', async () => {
    const { env } = boxEnv({ AI_PROXY_RATE_LIMIT_RPM: '1' });
    await enableDirectUpstream(env);

    expect((await sendMessage(env)).status).toBe(200);
    expect((await sendMessage(env)).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('AI cost without AI Gateway: SAM meters spend and enforces the monthly cap (A2)', () => {
  it('prices every call from the catalog and refuses with 429 once the month reaches the cap', async () => {
    const { env } = boxEnv();
    await enableDirectUpstream(env);
    // Two calls fit under the cap, the third would not.
    const cap = COST_PER_CALL * 2 - 0.0001;
    const capRes = await setMonthlyCap(env, cap);
    expect(capRes.status).toBe(200);

    expect((await sendMessage(env)).status).toBe(200);
    expect(await getLocalMonthlyAiCostUsd(env.KV, USER, env)).toBeCloseTo(COST_PER_CALL, 6);
    expect((await sendMessage(env)).status).toBe(200);
    expect(await getLocalMonthlyAiCostUsd(env.KV, USER, env)).toBeCloseTo(COST_PER_CALL * 2, 6);

    const refused = await sendMessage(env);
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain(
      'Monthly cost cap exceeded'
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports the month total and the cap utilization on the budget page', async () => {
    const { env } = boxEnv();
    await enableDirectUpstream(env);
    await setMonthlyCap(env, COST_PER_CALL * 4);
    await sendMessage(env);

    const res = await app().request('/api/usage/ai/budget', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      monthCostUsd: number;
      monthlyCostCapAvailable: boolean;
      utilization: { monthlyCostPercent: number | null };
    };
    expect(body.monthlyCostCapAvailable).toBe(true);
    expect(body.monthCostUsd).toBeCloseTo(COST_PER_CALL, 6);
    expect(body.utilization.monthlyCostPercent).toBeCloseTo(25, 0);
  });

  it('shows the priced spend per provider on the usage page', async () => {
    const { env } = boxEnv();
    await enableDirectUpstream(env);
    await sendMessage(env);

    const res = await app().request('/api/usage/ai?period=current-month', {}, env);
    const body = (await res.json()) as { totalCostUsd: number; totalRequests: number };
    expect(body.totalRequests).toBe(1);
    expect(body.totalCostUsd).toBeCloseTo(COST_PER_CALL, 6);
  });
});

describe('Cloudflare control: an addressable AI Gateway behaves as before', () => {
  function cloudflareEnv(): Fixture {
    return boxEnv({
      AI_GATEWAY_ID: 'sam',
      CF_ACCOUNT_ID: 'account-1',
      CF_API_TOKEN: 'cf-token',
      // Platform-key billing, so the call does not need Unified Billing.
      AI_PROXY_BILLING_MODE: 'platform-key',
    });
  }

  it('proxies through the gateway with no admin setting and prices nothing locally', async () => {
    const { env } = cloudflareEnv();

    const res = await sendMessage(env);

    expect(res.status).toBe(200);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://gateway.ai.cloudflare.com/v1/account-1/sam/anthropic/v1/messages');
    expect(await getLocalMonthlyAiCostUsd(env.KV, USER, env)).toBe(0);
  });

  it('enforces the cap from the gateway cron cache, not from local metering', async () => {
    const { env } = cloudflareEnv();
    await setMonthlyCap(env, 1);
    await env.KV.put(buildMonthlyCostCacheKey(USER), '1.5');

    const res = await sendMessage(env);
    expect(res.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
