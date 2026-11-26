/**
 * Hosted SAM (AI Gateway installs): the monthly spending limit is enforced against the gateway's
 * hourly month total plus SAM's catalog-priced estimate of calls since that total was read
 * (packages/ai-proxy/src/ai-cost-estimate.ts). Exercised through the real worker gate, the real
 * response accounting and the real `AiTokenBudgetCounter` over SQLite; only the admin settings
 * snapshot is stubbed.
 */
import { parseGatewayMonthlyCost } from '@simple-agent-manager/ai-proxy';
import { PLATFORM_AI_MODELS } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveAdminSetting: vi.fn(),
  resolveAdminSettingDetails: vi.fn(),
}));
vi.mock('../../../src/services/admin-settings-resolution', () => ({
  resolveAdminSetting: mocks.resolveAdminSetting,
  resolveAdminSettingDetails: mocks.resolveAdminSettingDetails,
}));

import { AiTokenBudgetCounter } from '../../../src/durable-objects/ai-token-budget-counter';
import { recordOperatorStepUsage } from '../../../src/durable-objects/sam-session/operator/model';
import type { Env } from '../../../src/env';
import { checkAiUsageGate, getProviderUsage } from '../../../src/services/ai-token-budget';
import { attachTokenUsageAccounting } from '../../../src/services/ai-token-usage-accounting';
import { createSqlStorage } from './sql-storage-test-utils';

const PRICED = PLATFORM_AI_MODELS.find(
  (m) => m.provider === 'openai' && m.costPer1kOutputTokens > 0
)!;
/** Catalog price of one `pricedResponse`: 1,000 input and 1,000 output tokens. */
const CALL_USD = PRICED.costPer1kInputTokens + PRICED.costPer1kOutputTokens;
const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);
const MINUTE = 60_000;
const USER = 'user-1';
const COST_KEY = `ai-monthly-cost:${USER}:2026-11`;
const SETTINGS_KEY = `ai-budget-settings:${USER}`;

let db: Database.Database;
let counter: AiTokenBudgetCounter;
let rows: Map<string, string>;
let env: Env;

function makeKv(): KVNamespace {
  return {
    get: vi.fn(async (key: string, type?: string) => {
      const value = rows.get(key);
      return value === undefined ? null : type === 'json' ? JSON.parse(value) : value;
    }),
    put: vi.fn(async (key: string, value: string) => void rows.set(key, value)),
  } as unknown as KVNamespace;
}

function setUserCap(usd: number | null) {
  rows.set(SETTINGS_KEY, JSON.stringify({ monthlyCostCapUsd: usd }));
}

function setCeiling(usd: number) {
  mocks.resolveAdminSettingDetails.mockResolvedValue({ value: usd });
}

/** What the hourly cron writes: the gateway total and when it was read. */
function setGatewayTotal(costUsd: number, asOfMs: number) {
  rows.set(COST_KEY, JSON.stringify({ costUsd, asOfMs }));
}

async function pricedResponse(model = PRICED.id) {
  const response = new Response(
    JSON.stringify({ usage: { prompt_tokens: 1_000, completion_tokens: 1_000 } }),
    { headers: { 'content-type': 'application/json' } }
  );
  await attachTokenUsageAccounting(response, {
    env,
    userId: USER,
    format: 'openai',
    costModelId: model,
  });
}

async function spendAt(ms: number, calls: number) {
  vi.setSystemTime(ms);
  for (let i = 0; i < calls; i++) await pricedResponse();
  vi.setSystemTime(NOW);
}

function gate(options?: { platformBilled?: boolean }) {
  return checkAiUsageGate(env.KV, USER, env, options);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db = new Database(':memory:');
  const ctx = {
    storage: {
      sql: createSqlStorage(db),
      transactionSync: <T>(fn: () => T) => db.transaction(fn)(),
    },
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
  };
  counter = new AiTokenBudgetCounter(ctx as never, {} as never);
  rows = new Map();
  env = {
    KV: makeKv(),
    DATABASE: {},
    AI_GATEWAY_ID: 'sam',
    CF_ACCOUNT_ID: 'acct',
    CF_API_TOKEN: 'tok',
    AI_TOKEN_BUDGET_COUNTER: { idFromName: (name: string) => name, get: () => counter },
  } as unknown as Env;
  mocks.resolveAdminSettingDetails.mockReset();
  mocks.resolveAdminSetting.mockReset();
  mocks.resolveAdminSetting.mockResolvedValue(600);
  setCeiling(0);
});
afterEach(() => {
  db.close();
  vi.useRealTimers();
});

describe('administrator ceiling on a gateway install', () => {
  it('refuses at the ceiling when it is below the user cap', async () => {
    setUserCap(50);
    setCeiling(1);
    setGatewayTotal(1.2, NOW - 10 * MINUTE);
    await expect(gate()).resolves.toMatchObject({
      allowed: false,
      reason: 'monthly-cost-cap',
      monthlyCap: { capUsd: 1, limitSource: 'administrator' },
    });
  });

  it('applies to a user who never set a cap, and admits below it (control)', async () => {
    setCeiling(1);
    setGatewayTotal(0.4, NOW - 10 * MINUTE);
    await expect(gate()).resolves.toEqual({ allowed: true });
    setGatewayTotal(1, NOW - 10 * MINUTE);
    await expect(gate()).resolves.toMatchObject({ allowed: false });
  });
});

describe('the estimate closes the gap before and between gateway refreshes', () => {
  it('refuses on the month estimate when the cron has written no total yet', async () => {
    setUserCap(CALL_USD * 2.5);
    await spendAt(NOW - 5 * MINUTE, 2);
    await expect(gate()).resolves.toEqual({ allowed: true });
    await pricedResponse();
    const result = await gate();
    expect(result).toMatchObject({ allowed: false, reason: 'monthly-cost-cap' });
    expect(
      result.allowed === false && result.reason === 'monthly-cost-cap' && result.monthlyCap.costUsd
    ).toBeCloseTo(CALL_USD * 3, 9);
  });

  it('refuses when a stale total is below the cap but the total plus calls since it is not', async () => {
    const asOf = NOW - 50 * MINUTE;
    setUserCap(1);
    setGatewayTotal(1 - CALL_USD * 1.5, asOf);
    await expect(gate()).resolves.toEqual({ allowed: true });
    await spendAt(NOW - 20 * MINUTE, 2);
    await expect(gate()).resolves.toMatchObject({
      allowed: false,
      monthlyCap: { capUsd: 1 },
    });
  });

  it('refuses when the gateway total alone is over the cap and the estimate is far below it', async () => {
    setUserCap(1);
    await spendAt(NOW - 120 * MINUTE, 1);
    setGatewayTotal(1.5, NOW - 30 * MINUTE);
    await expect(gate()).resolves.toMatchObject({ allowed: false, monthlyCap: { costUsd: 1.5 } });
  });

  it('does not count calls the gateway total already includes, however the catalog priced them', async () => {
    // Rule 74 divergence case: the catalog prices these calls far above what the gateway charged.
    // A whole-month max(gateway, estimate) or a sum would refuse here; the windowed backstop must not.
    setUserCap(CALL_USD * 3);
    await spendAt(NOW - 180 * MINUTE, 10);
    setGatewayTotal(CALL_USD, NOW - 30 * MINUTE);
    await expect(gate()).resolves.toEqual({ allowed: true });
  });

  it('keeps counting calls inside the lag margin before the gateway read time', async () => {
    setUserCap(CALL_USD * 1.5);
    setGatewayTotal(CALL_USD, NOW - 10 * MINUTE);
    await spendAt(NOW - 15 * MINUTE, 1);
    await expect(gate()).resolves.toMatchObject({ allowed: false });
    // With no lag margin the same call is treated as already in the gateway total.
    mocks.resolveAdminSetting.mockResolvedValue(0);
    await expect(gate()).resolves.toEqual({ allowed: true });
  });

  it('reads a legacy plain-number total as old as its KV TTL allows (2 hours by default)', async () => {
    setUserCap(1);
    rows.set(COST_KEY, String(1 - CALL_USD * 1.5));
    await spendAt(NOW - 100 * MINUTE, 2);
    await expect(gate()).resolves.toMatchObject({ allowed: false });
  });

  it('uses the month estimate as a floor when the cron read was truncated', async () => {
    // Truncated reads miss the month's oldest logs, so the gateway total is known to be low.
    setUserCap(CALL_USD * 5);
    await spendAt(NOW - 180 * MINUTE, 6);
    rows.set(
      COST_KEY,
      JSON.stringify({ costUsd: CALL_USD, asOfMs: NOW - 30 * MINUTE, truncated: true })
    );
    await expect(gate()).resolves.toMatchObject({ allowed: false });
    // Control: the same total from a complete read is trusted (the windowed rule).
    setGatewayTotal(CALL_USD, NOW - 30 * MINUTE);
    await expect(gate()).resolves.toEqual({ allowed: true });
  });

  it('answers a total older than bucket retention from month figures, without scanning buckets', async () => {
    setUserCap(CALL_USD * 1.5);
    await spendAt(NOW - 5 * MINUTE, 2);
    const snapshot = vi.spyOn(counter, 'getGatewayAdmissionSnapshot');
    setGatewayTotal(0.0001, NOW - 30 * 60 * MINUTE);
    await expect(gate()).resolves.toMatchObject({ allowed: false });
    expect(snapshot).toHaveBeenCalledWith(expect.any(String), '2026-11', null);
  });

  it('reads the user settings row once per admission', async () => {
    setUserCap(1);
    setGatewayTotal(0.1, NOW - 10 * MINUTE);
    await gate();
    const reads = vi.mocked(env.KV.get).mock.calls.filter(([key]) => key === SETTINGS_KEY);
    expect(reads).toHaveLength(1);
  });

  it('records every concurrent priced response once (rule 45)', async () => {
    setUserCap(CALL_USD * 25.5);
    await Promise.all(Array.from({ length: 25 }, () => pricedResponse()));
    await expect(gate()).resolves.toEqual({ allowed: true });
    await pricedResponse();
    await expect(gate()).resolves.toMatchObject({ allowed: false });
    const month = await counter.getGatewayAdmissionSnapshot('2026-11-26', '2026-11', null);
    expect(month.estimateMonthUsd).toBeCloseTo(CALL_USD * 26, 9);
    expect(month.budget.inputTokens).toBe(26_000);
  });
});

describe('concurrent admission (rules 45/69): bounded in-flight overshoot, no reservation', () => {
  it('admits every call that arrives below the cap, then refuses once their spend is recorded', async () => {
    setUserCap(CALL_USD * 2.5);
    await spendAt(NOW - 5 * MINUTE, 2);
    // Five calls arrive together while recorded spend (2 calls) is below the cap: all pass the gate.
    const gates = await Promise.all(Array.from({ length: 5 }, () => gate()));
    expect(gates).toEqual(Array.from({ length: 5 }, () => ({ allowed: true })));
    // Their responses all complete: overshoot is the sum of the in-flight calls' costs, as documented.
    await Promise.all(Array.from({ length: 5 }, () => pricedResponse()));
    const refused = await gate();
    expect(refused).toMatchObject({ allowed: false, reason: 'monthly-cost-cap' });
    expect(
      refused.allowed === false &&
        refused.reason === 'monthly-cost-cap' &&
        refused.monthlyCap.costUsd
    ).toBeCloseTo(CALL_USD * 7, 9);
  });
});

describe('failure behaviour', () => {
  it('refuses with a retryable 503 when the counter read fails, rather than admitting it', async () => {
    setUserCap(1);
    vi.spyOn(counter, 'getGatewayAdmissionSnapshot').mockRejectedValue(new Error('DO reset'));
    await expect(gate()).rejects.toMatchObject({ statusCode: 503 });
  });

  it('uses the month estimate when the gateway total cannot be read', async () => {
    setUserCap(CALL_USD * 1.5);
    await spendAt(NOW - 5 * MINUTE, 2);
    const kvGet = vi.mocked(env.KV.get);
    const real = kvGet.getMockImplementation()!;
    kvGet.mockImplementation(async (key: string, type?: never) => {
      if (key === COST_KEY) throw new Error('KV unavailable');
      return real(key, type);
    });
    await expect(gate()).resolves.toMatchObject({ allowed: false });
  });

  it('treats a malformed total as missing', async () => {
    setUserCap(CALL_USD * 1.5);
    rows.set(COST_KEY, '{"costUsd":"lots"}');
    await expect(gate()).resolves.toEqual({ allowed: true });
    await spendAt(NOW - 5 * MINUTE, 2);
    await expect(gate()).resolves.toMatchObject({ allowed: false });
  });
});

describe('the estimate is a backstop, never displayed spend', () => {
  it('leaves provider rows unpriced on a gateway install (usage page adds them to gateway totals)', async () => {
    await pricedResponse();
    const entries = await getProviderUsage(env.KV, USER, new Date(Date.UTC(2026, 10, 1)), env);
    expect(entries.every((entry) => entry.estimatedCostUsd === 0)).toBe(true);
    const month = await counter.getGatewayAdmissionSnapshot('2026-11-26', '2026-11', null);
    expect(month.estimateMonthUsd).toBeCloseTo(CALL_USD, 9);
  });

  it('routes the SAM operator price to the backstop, not the display rows', async () => {
    const model = PLATFORM_AI_MODELS.find(
      (m) => m.provider === 'workers-ai' && m.costPer1kInputTokens > 0
    )!;
    await recordOperatorStepUsage(env, USER, { model: model.id } as never, model, {
      usage: { inputTokens: 1_000, outputTokens: 1_000 },
      request: {},
      text: '',
      reasoningText: undefined,
      toolCalls: [],
    });
    const entries = await getProviderUsage(env.KV, USER, new Date(Date.UTC(2026, 10, 1)), env);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.estimatedCostUsd).toBe(0);
    const month = await counter.getGatewayAdmissionSnapshot('2026-11-26', '2026-11', null);
    expect(month.estimateMonthUsd).toBeCloseTo(
      model.costPer1kInputTokens + model.costPer1kOutputTokens,
      9
    );
  });

  it('prunes buckets past retention and previous months', async () => {
    await spendAt(Date.UTC(2026, 9, 31, 23, 0), 1);
    await spendAt(NOW - 30 * 60 * MINUTE, 1);
    await pricedResponse();
    const buckets = db.prepare('SELECT bucket_start FROM ai_cost_estimate_bucket').all() as {
      bucket_start: number;
    }[];
    expect(buckets.map((row) => row.bucket_start)).toEqual([
      Math.floor(NOW / (5 * MINUTE)) * 5 * MINUTE,
    ]);
    const months = db.prepare('SELECT budget_month FROM ai_cost_estimate_month').all();
    expect(months).toEqual([{ budget_month: '2026-11' }]);
  });
});

describe('the cron total format', () => {
  it('parses both the new and the legacy value', () => {
    expect(parseGatewayMonthlyCost('{"costUsd":1.5,"asOfMs":5}')).toEqual({
      costUsd: 1.5,
      asOfMs: 5,
      truncated: false,
    });
    expect(parseGatewayMonthlyCost('{"costUsd":1.5,"asOfMs":5,"truncated":true}')).toMatchObject({
      truncated: true,
    });
    expect(parseGatewayMonthlyCost('0.350000')).toEqual({
      costUsd: 0.35,
      asOfMs: null,
      truncated: false,
    });
    expect(parseGatewayMonthlyCost('nope')).toBeNull();
  });
});
