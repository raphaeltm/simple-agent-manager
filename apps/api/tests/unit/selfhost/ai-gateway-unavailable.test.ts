/**
 * AI Gateway consumers on an installation with no reachable gateway.
 *
 * `wrangler.toml` ships AI_GATEWAY_ID="sam" as a default var, so the realistic "absent"
 * configuration is the gateway id SET with no CF_ACCOUNT_ID (every gateway URL needs the
 * account). Covers the monthly cost cron, its hourly cron.completed log, and
 * GET /api/usage/ai/budget. Gateway calls go through the real `iterateGatewayLogs` and a
 * stubbed `fetch`, so "no gateway call" means no HTTP request and the pre-guard behaviour
 * (throw, then log at error level) is observable.
 */
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { runMonthlyCostAggregation } from '../../../src/services/ai-monthly-cost-cron';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getUserId: () => 'user-budget-1',
}));

const { usageRoutes } = await import('../../../src/routes/usage');
const { scheduleHourlyPlatformMaintenance } = await import(
  '../../../src/scheduled/platform-feedback-hourly'
);

const monthKey = () => {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
};

function gatewayEntry(userId: string, cost: number, id: string) {
  return {
    id,
    model: 'claude-sonnet-4-5',
    provider: 'anthropic',
    tokens_in: 1200,
    tokens_out: 300,
    cost,
    success: true,
    cached: false,
    created_at: new Date().toISOString(),
    duration: 900,
    metadata: { userId },
  };
}

/** A gateway logs page the way Cloudflare returns it: two users, one page. */
function gatewayLogsResponse() {
  const result = [
    gatewayEntry('user-budget-1', 1.25, 'log-1'),
    gatewayEntry('user-budget-1', 0.5, 'log-2'),
    gatewayEntry('user-other', 9, 'log-3'),
  ];
  return new Response(
    JSON.stringify({
      success: true,
      result,
      result_info: { page: 1, per_page: 50, count: result.length, total_count: result.length, total_pages: 1 },
    }),
    { status: 200 }
  );
}

let sqlite: Database.Database;
let baseEnv: Env;
let fetchMock: ReturnType<typeof vi.fn>;
let errorLog: ReturnType<typeof vi.spyOn>;
let infoLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  ({ sqlite, env: baseEnv } = createAdminSettingsEnv());
  fetchMock = vi.fn(async () => gatewayLogsResponse());
  vi.stubGlobal('fetch', fetchMock);
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  infoLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sqlite.close();
});

const parsed = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

/** Cloudflare: gateway id from wrangler.toml plus the account credentials. */
const cloudflare = (): Env =>
  ({ ...baseEnv, AI_GATEWAY_ID: 'sam', CF_ACCOUNT_ID: 'account-1', CF_API_TOKEN: 'token-1' }) as Env;
/** Self-hosted: the default gateway id var is still there, the account is not. */
const selfHosted = (): Env => ({ ...baseEnv, AI_GATEWAY_ID: 'sam' }) as Env;

describe('runMonthlyCostAggregation', () => {
  it('with a gateway id and an account aggregates gateway logs per user into KV (Cloudflare behaviour)', async () => {
    const env = cloudflare();

    const result = await runMonthlyCostAggregation(env);

    expect(result).toEqual({ enabled: true, usersUpdated: 2, totalEntries: 3, errors: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/accounts/account-1/ai-gateway/gateways/sam/logs');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-1');
    expect(await env.KV.get(`ai-monthly-cost:user-budget-1:${monthKey()}`)).toBe('1.750000');
    expect(await env.KV.get(`ai-monthly-cost:user-other:${monthKey()}`)).toBe('9.000000');
  });

  it('with the default gateway id but no account skips by design: no fetch, no KV write, no error log', async () => {
    const env = selfHosted();

    const result = await runMonthlyCostAggregation(env);

    expect(result).toEqual({
      enabled: false,
      skipReason: 'ai_gateway_unavailable',
      usersUpdated: 0,
      totalEntries: 0,
      errors: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await env.KV.get(`ai-monthly-cost:user-budget-1:${monthKey()}`)).toBeNull();
    expect(parsed(errorLog)).toEqual([]);
  });

  it('with no gateway id at all reports the same skip reason', async () => {
    const result = await runMonthlyCostAggregation(baseEnv);

    expect(result).toMatchObject({ enabled: false, skipReason: 'ai_gateway_unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a blank account id like a missing one', async () => {
    const result = await runMonthlyCostAggregation({ ...selfHosted(), CF_ACCOUNT_ID: '  ' } as Env);

    expect(result).toMatchObject({ enabled: false, skipReason: 'ai_gateway_unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('hourly platform maintenance cron.completed', () => {
  async function runHourly(env: Env) {
    let pending: Promise<unknown> = Promise.resolve();
    const handled = scheduleHourlyPlatformMaintenance(
      '30 * * * *',
      env,
      (promise) => {
        pending = promise;
      },
      {
        // Feedback triage is a separate job with its own tests; the cost aggregation is real.
        feedbackTriage: async () => ({
          enabled: false,
          groupsFound: 0,
          ideasCreated: 0,
          ideasUpdated: 0,
          groupsSkipped: 0,
          groupsFailed: 0,
          groupsBudgetDeferred: 0,
          failureReasons: [],
        }),
      } as never
    );
    expect(handled).toBe(true);
    await pending;
    return parsed(infoLog).find((entry) => entry.event === 'cron.completed');
  }

  it('records monthlyCostSkipReason ai_gateway_unavailable without a failure when the gateway is unreachable', async () => {
    const entry = await runHourly(selfHosted());

    expect(entry).toMatchObject({
      type: 'monthly-cost-aggregation',
      monthlyCostEnabled: false,
      monthlyCostSkipReason: 'ai_gateway_unavailable',
      monthlyCostFailed: false,
      monthlyCostErrors: 0,
    });
    expect(parsed(errorLog)).toEqual([]);
  });

  it('records no skip reason and the aggregated users when the gateway is reachable', async () => {
    const entry = await runHourly(cloudflare());

    expect(entry).toMatchObject({
      monthlyCostEnabled: true,
      monthlyCostSkipReason: null,
      monthlyCostFailed: false,
      monthlyCostUsersUpdated: 2,
      monthlyCostTotalEntries: 3,
    });
  });
});

describe('GET /api/usage/ai/budget', () => {
  function app() {
    const testApp = new Hono<{ Bindings: Env }>();
    testApp.route('/api/usage', usageRoutes);
    return testApp;
  }

  it('with a gateway id and an account adds this user\'s month-to-date gateway cost (Cloudflare behaviour)', async () => {
    const res = await app().request('/api/usage/ai/budget', {}, cloudflare());
    const body = (await res.json()) as { monthCostUsd: number };

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as [string])[0])).toContain(
      '/accounts/account-1/ai-gateway/gateways/sam/logs'
    );
    // 1.25 + 0.5 for user-budget-1; the other user's 9 must not leak in.
    expect(body.monthCostUsd).toBe(1.75);
  });

  it('with the default gateway id but no account answers 200 with zero cost, no gateway call and no error log', async () => {
    const res = await app().request('/api/usage/ai/budget', {}, selfHosted());
    const body = (await res.json()) as {
      monthCostUsd: number;
      exceeded: boolean;
      effectiveLimits: unknown;
    };

    expect(res.status).toBe(200);
    expect(body.monthCostUsd).toBe(0);
    expect(body.exceeded).toBe(false);
    // Liveness: the rest of the budget response is still built.
    expect(body.effectiveLimits).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
    const errors = parsed(errorLog);
    expect(errors.filter((entry) => entry.event === 'usage.budget_gateway_error')).toEqual([]);
    expect(errors).toEqual([]);
  });
});
