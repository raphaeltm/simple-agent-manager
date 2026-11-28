/**
 * L13 local metering, through the real `AiTokenBudgetCounter` over SQLite: priced calls recorded by
 * the real accounting path land in provider and per-model rows in one transaction, the usage page
 * breakdown reads them, and the worker's usage gate blocks at the installation ceiling.
 */
import { getLocalMonthlyAiCostUsd, getLocalUsageBreakdown } from '@simple-agent-manager/ai-proxy';
import { PLATFORM_AI_MODELS } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolveAdminSettingDetails: vi.fn() }));
vi.mock('../../../src/services/admin-settings-resolution', () => ({
  resolveAdminSetting: vi.fn(),
  resolveAdminSettingDetails: mocks.resolveAdminSettingDetails,
}));

import { AiTokenBudgetCounter } from '../../../src/durable-objects/ai-token-budget-counter';
import type { Env } from '../../../src/env';
import { checkAiUsageGate, incrementProviderUsage } from '../../../src/services/ai-token-budget';
import { attachTokenUsageAccounting } from '../../../src/services/ai-token-usage-accounting';
import { createSqlStorage } from './sql-storage-test-utils';

const PRICED = PLATFORM_AI_MODELS.find(
  (m) => m.provider === 'openai' && m.costPer1kOutputTokens > 0
)!;
const OPENAI = { providerId: 'openai', providerName: 'OpenAI', dialect: 'openai' };

let db: Database.Database;
let counter: AiTokenBudgetCounter;
let env: Env;

function makeKv(): KVNamespace {
  const rows = new Map<string, string>();
  return {
    get: vi.fn(async (key: string, type?: string) => {
      const value = rows.get(key);
      return value === undefined ? null : type === 'json' ? JSON.parse(value) : value;
    }),
    put: vi.fn(async (key: string, value: string) => void rows.set(key, value)),
  } as unknown as KVNamespace;
}

beforeEach(() => {
  db = new Database(':memory:');
  const ctx = {
    storage: {
      sql: createSqlStorage(db),
      transactionSync: <T>(fn: () => T) => db.transaction(fn)(),
    },
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
  };
  counter = new AiTokenBudgetCounter(ctx as never, {} as never);
  // No AI_GATEWAY_ID / CF_ACCOUNT_ID: an installation without an addressable gateway.
  env = {
    KV: makeKv(),
    DATABASE: {},
    AI_TOKEN_BUDGET_COUNTER: { idFromName: (name: string) => name, get: () => counter },
  } as unknown as Env;
  mocks.resolveAdminSettingDetails.mockReset();
});
afterEach(() => db.close());

async function pricedResponse(userId: string) {
  const response = new Response(
    JSON.stringify({ usage: { prompt_tokens: 100_000, completion_tokens: 100_000 } }),
    { headers: { 'content-type': 'application/json' } }
  );
  await attachTokenUsageAccounting(response, {
    env,
    userId,
    format: 'openai',
    costModelId: PRICED.id,
  });
}

describe('AiTokenBudgetCounter per-model rows', () => {
  it('counts every concurrent priced call once, in provider and model rows alike', async () => {
    await Promise.all(Array.from({ length: 25 }, () => pricedResponse('user')));

    const monthCost = await getLocalMonthlyAiCostUsd(env.KV, 'user', env);
    const { byModel, byDay } = await getLocalUsageBreakdown(env, 'user', new Date(0));
    expect(byModel).toHaveLength(1);
    expect(byModel[0]).toMatchObject({ model: PRICED.id, provider: 'openai', requests: 25 });
    expect(byModel[0]!.inputTokens).toBe(25 * 100_000);
    expect(byModel[0]!.costUsd).toBeCloseTo(monthCost, 9);
    expect(monthCost).toBeGreaterThan(0);
    expect(byDay).toHaveLength(1);
    expect(byDay[0]!.requests).toBe(25);
  });

  it('records no model row for an unpriced (BYO or custom endpoint) call', async () => {
    await incrementProviderUsage(env.KV, 'user', OPENAI, 10, 10, env);
    const { byModel } = await getLocalUsageBreakdown(env, 'user', new Date(0));
    expect(byModel).toEqual([]);
    const provider = await counter.getProviderUsage('1970-01-01');
    expect(provider).toHaveLength(1);
  });

  it('skips a malformed model row and keeps the good ones', async () => {
    await pricedResponse('user');
    db.prepare(
      `INSERT INTO ai_model_usage (budget_date, model_id, provider_id, requests, input_tokens,
         output_tokens, estimated_cost_usd, updated_at) VALUES ('2026-01-01', 'bad', 'x', 1, 1, 1, 'NaN?', 0)`
    ).run();
    const rows = await counter.getModelUsage('1970-01-01');
    expect(rows.map((row) => row.modelId)).toEqual([PRICED.id]);
  });

  it('returns no breakdown, without throwing, where the counter binding is absent', async () => {
    const bare = { ...env, AI_TOKEN_BUDGET_COUNTER: undefined } as Env;
    await expect(getLocalUsageBreakdown(bare, 'user', new Date(0))).resolves.toEqual({
      byModel: [],
      byDay: [],
    });
  });
});

describe("the worker's usage gate reads the installation ceiling (F2)", () => {
  it('refuses platform-funded admission while the strict ceiling snapshot is unreadable', async () => {
    mocks.resolveAdminSettingDetails.mockRejectedValue(new Error('settings unavailable'));
    await expect(checkAiUsageGate(env.KV, 'user', env)).rejects.toMatchObject({
      statusCode: 503,
      error: 'SERVICE_UNAVAILABLE',
    });
    // No accounted call or model row is produced while admission is unknown.
    expect(await getLocalMonthlyAiCostUsd(env.KV, 'user', env)).toBe(0);
  });

  it('blocks a user who never set a cap once spend reaches the ceiling', async () => {
    await pricedResponse('user');
    const spent = await getLocalMonthlyAiCostUsd(env.KV, 'user', env);
    mocks.resolveAdminSettingDetails.mockResolvedValue({ value: Math.max(1, Math.floor(spent)) });
    expect(spent).toBeGreaterThanOrEqual(1);

    await expect(checkAiUsageGate(env.KV, 'user', env)).resolves.toMatchObject({
      allowed: false,
      reason: 'monthly-cost-cap',
    });
    expect(mocks.resolveAdminSettingDetails).toHaveBeenCalledWith(
      env,
      'aiProxy.perUserMonthlyCostCeilingUsd'
    );
  });

  it('lets the same user through with no ceiling set (control)', async () => {
    await pricedResponse('user');
    mocks.resolveAdminSettingDetails.mockResolvedValue({ value: 0 });
    await expect(checkAiUsageGate(env.KV, 'user', env)).resolves.toEqual({ allowed: true });
  });
});

describe('gateway install: the worker gate reads the ceiling and still makes one counter RPC (rule 60)', () => {
  it('reads the ceiling, no gateway total without a cap, and only the daily counter read', async () => {
    const gatewayEnv = {
      ...env,
      AI_GATEWAY_ID: 'gw',
      CF_ACCOUNT_ID: 'acct',
      CF_API_TOKEN: 'tok',
    } as unknown as Env;
    mocks.resolveAdminSettingDetails.mockResolvedValue({ value: 0 });
    const getProviderUsage = vi.spyOn(counter, 'getProviderUsage');
    const get = vi.spyOn(counter, 'get');
    const snapshot = vi.spyOn(counter, 'getGatewayAdmissionSnapshot');
    await expect(checkAiUsageGate(gatewayEnv.KV, 'user', gatewayEnv)).resolves.toEqual({
      allowed: true,
    });
    expect(mocks.resolveAdminSettingDetails).toHaveBeenCalledWith(
      gatewayEnv,
      'aiProxy.perUserMonthlyCostCeilingUsd'
    );
    expect(getProviderUsage).not.toHaveBeenCalled();
    expect(get.mock.calls.length + snapshot.mock.calls.length).toBe(1);
    // One settings read, shared by the monthly cap and the token budget; no cap so no gateway
    // total read.
    expect(
      vi.mocked(gatewayEnv.KV.get).mock.calls.map(([key]) => String(key).split(':')[0])
    ).toEqual(['ai-budget-settings']);
  });
});
