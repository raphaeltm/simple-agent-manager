/**
 * The monthly AI dollar cap is priced only from Cloudflare AI Gateway logs (the hourly
 * `runMonthlyCostAggregation` cron fills the KV cost cache the gate reads). Without an
 * addressable gateway that cache is never written, so a cap used to be accepted and then
 * silently never enforced. Now the cap is explicitly unavailable there: the budget API refuses
 * to set one and reports `monthlyCostCapAvailable: false`, the gate reports `enforced: false`
 * without reading the cost cache, and the admin AI proxy config and the public capabilities say
 * so. A Cloudflare deployment with the gateway is unchanged (the control in every block).
 *
 * Configurations: `cloudflare` (gateway id + account), `selfHosted` (the wrangler.toml default
 * gateway id, no account), `partialCloudflare` (account and token present, AI_GATEWAY_ID unset).
 */
import type { Context } from 'hono';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => (_c: unknown, next: () => Promise<void>) => next(),
  requireSuperadmin: () => (_c: unknown, next: () => Promise<void>) => next(),
  getUserId: () => 'cap-user',
}));

import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { adminAIProxyRoutes } from '../../../src/routes/admin-ai-proxy';
import { usageRoutes } from '../../../src/routes/usage';
import {
  buildBudgetSettingsKey,
  buildMonthlyCostCacheKey,
  checkAiUsageGate,
  checkMonthlyCostCap,
} from '../../../src/services/ai-token-budget';
import {
  publicPlatformCapabilities,
  resolvePlatformCapabilities,
} from '../../../src/services/platform-capabilities';
import { createMemoryKv } from '../../helpers/sqlite-d1';

const USER = 'cap-user';

type Config = 'cloudflare' | 'selfHosted' | 'partialCloudflare' | 'gatewayWithoutToken';
const CONFIG_VARS: Record<Config, Partial<Env>> = {
  cloudflare: { AI_GATEWAY_ID: 'sam', CF_ACCOUNT_ID: 'account-1', CF_API_TOKEN: 'token-1' },
  selfHosted: { AI_GATEWAY_ID: 'sam' },
  partialCloudflare: { AI_GATEWAY_ID: '', CF_ACCOUNT_ID: 'account-1', CF_API_TOKEN: 'token-1' },
  // The gateway is addressable but its logs cannot be read (the cost cron needs the token).
  gatewayWithoutToken: { AI_GATEWAY_ID: 'sam', CF_ACCOUNT_ID: 'account-1' },
};
const WITHOUT_GATEWAY: Config[] = ['selfHosted', 'partialCloudflare', 'gatewayWithoutToken'];

let fetchMock: ReturnType<typeof vi.fn>;

function makeEnv(config: Config): Env {
  return { KV: createMemoryKv(), ...CONFIG_VARS[config] } as Env;
}

function app(): Hono<{ Bindings: Env }> {
  const hono = new Hono<{ Bindings: Env }>();
  hono.onError((err, c: Context) => handleAppError(err as Error, c));
  hono.route('/api/usage', usageRoutes);
  hono.route('/api/admin/ai-proxy', adminAIProxyRoutes);
  return hono;
}

function putBudget(env: Env, body: Record<string, unknown>) {
  return app().request(
    '/api/usage/ai/budget',
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env
  );
}

/** A cap saved while the installation still had a gateway, and a month's cost over it. */
async function seedCapOverspent(env: Env) {
  await env.KV.put(
    buildBudgetSettingsKey(USER),
    JSON.stringify({
      dailyInputTokenLimit: null,
      dailyOutputTokenLimit: null,
      monthlyCostCapUsd: 5,
      alertThresholdPercent: 80,
    })
  );
  await env.KV.put(buildMonthlyCostCacheKey(USER), '9.000000');
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Gateway log reads (GET budget with a gateway): one empty page.
  fetchMock = vi.fn(async () =>
    Response.json({ success: true, result: [], result_info: { page: 1, total_pages: 1 } })
  );
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('PUT /api/usage/ai/budget monthly cap', () => {
  it('saves a monthly cap with AI Gateway (Cloudflare behaviour)', async () => {
    const env = makeEnv('cloudflare');
    const res = await putBudget(env, { monthlyCostCapUsd: 10 });
    expect(res.status).toBe(200);
    expect(await env.KV.get(buildBudgetSettingsKey(USER), 'json')).toMatchObject({
      monthlyCostCapUsd: 10,
    });
  });

  it.each(WITHOUT_GATEWAY)(
    'refuses a monthly cap in the %s configuration and stores nothing',
    async (config) => {
      const env = makeEnv(config);
      const res = await putBudget(env, { monthlyCostCapUsd: 10, dailyInputTokenLimit: 50_000 });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: 'VALIDATION_ERROR',
        message: expect.stringContaining('Monthly cost caps are not available'),
      });
      expect(await env.KV.get(buildBudgetSettingsKey(USER))).toBeNull();
    }
  );

  it.each(WITHOUT_GATEWAY)(
    'still saves daily limits with no monthly cap in the %s configuration (liveness)',
    async (config) => {
      const env = makeEnv(config);
      const res = await putBudget(env, { monthlyCostCapUsd: null, dailyInputTokenLimit: 50_000 });
      expect(res.status).toBe(200);
      expect(await env.KV.get(buildBudgetSettingsKey(USER), 'json')).toMatchObject({
        dailyInputTokenLimit: 50_000,
        monthlyCostCapUsd: null,
      });
    }
  );
});

describe('GET /api/usage/ai/budget monthly cap availability', () => {
  it('reports the cap available and its utilization with AI Gateway', async () => {
    const env = makeEnv('cloudflare');
    await seedCapOverspent(env);
    const res = await app().request('/api/usage/ai/budget', {}, env);
    const body = (await res.json()) as {
      monthlyCostCapAvailable: boolean;
      utilization: { monthlyCostPercent: number | null };
    };
    expect(res.status).toBe(200);
    expect(body.monthlyCostCapAvailable).toBe(true);
    expect(body.utilization.monthlyCostPercent).toBe(0);
  });

  it.each(WITHOUT_GATEWAY)(
    'reports the cap unavailable in the %s configuration, with the saved cap and no utilization',
    async (config) => {
      const env = makeEnv(config);
      await seedCapOverspent(env);
      const res = await app().request('/api/usage/ai/budget', {}, env);
      const body = (await res.json()) as {
        monthlyCostCapAvailable: boolean;
        settings: { monthlyCostCapUsd: number | null };
        utilization: { monthlyCostPercent: number | null };
        exceeded: boolean;
      };
      expect(res.status).toBe(200);
      expect(body.monthlyCostCapAvailable).toBe(false);
      expect(body.settings.monthlyCostCapUsd).toBe(5);
      expect(body.utilization.monthlyCostPercent).toBeNull();
      expect(body.exceeded).toBe(false);
      // Only an addressable gateway is read for the month's cost (it fails without a token).
      if (config !== 'gatewayWithoutToken') expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});

describe('AI usage gate monthly cap', () => {
  it('denies an overspent cap with AI Gateway (Cloudflare behaviour)', async () => {
    const env = makeEnv('cloudflare');
    await seedCapOverspent(env);
    expect(await checkAiUsageGate(env.KV, USER, env)).toMatchObject({
      allowed: false,
      reason: 'monthly-cost-cap',
      monthlyCap: { costUsd: 9, capUsd: 5, enforced: true },
    });
  });

  it.each(WITHOUT_GATEWAY)(
    'reports the saved cap not enforced in the %s configuration, without reading the cost cache',
    async (config) => {
      const env = makeEnv(config);
      await seedCapOverspent(env);
      const kvGet = vi.spyOn(env.KV, 'get');
      expect(await checkMonthlyCostCap(env.KV, USER, env)).toEqual({
        allowed: true,
        costUsd: 0,
        capUsd: 5,
        enforced: false,
      });
      expect(kvGet.mock.calls.map(([key]) => key)).not.toContain(buildMonthlyCostCacheKey(USER));
      // The daily token budget is still checked and passes.
      expect(await checkAiUsageGate(env.KV, USER, env)).toEqual({ allowed: true });
    }
  );
});

describe('where an admin and the web client learn it', () => {
  it.each([
    ['cloudflare', true],
    ['selfHosted', false],
    ['partialCloudflare', false],
    ['gatewayWithoutToken', false],
  ] as const)(
    '%s: capabilities and admin AI proxy config say monthlyCostCap=%s',
    async (config, available) => {
      const env = makeEnv(config);
      expect(resolvePlatformCapabilities(env).monthlyCostCap).toBe(available);
      expect(publicPlatformCapabilities(env).monthlyCostCap).toBe(available);
      const res = await app().request('/api/admin/ai-proxy/config', {}, env);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ monthlyCostCapAvailable: available });
    }
  );
});
