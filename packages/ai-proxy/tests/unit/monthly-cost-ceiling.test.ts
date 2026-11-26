/**
 * F2: the installation-wide monthly ceiling (`aiProxy.perUserMonthlyCostCeilingUsd`), and the one cap
 * predicate shared by the gate, the budget page and validation (`effectiveMonthlyCostCapUsd`).
 */
import { PLATFORM_AI_MODELS } from '@simple-agent-manager/shared';
import { describe, expect, it, vi } from 'vitest';

import { getUserBudgetSettings } from '../../src/ai-budget-settings';
import {
  effectiveMonthlyCostCapUsd,
  getLocalMonthlyAiCostUsd,
  monthlyCostCapMessage,
  resolveMonthlyCostCeilingUsd,
} from '../../src/ai-monthly-cost-cap';
import {
  buildBudgetSettingsKey,
  buildMonthlyCostCacheKey,
  checkAiUsageGate,
  checkMonthlyCostCap,
  validateBudgetUpdate,
} from '../../src/ai-token-budget';
import { accountTokenUsageFromJson } from '../../src/ai-token-usage-accounting';
import type { AiProxyEnv } from '../../src/env';

const PRICED = PLATFORM_AI_MODELS.find(
  (m) => m.provider === 'openai' && m.costPer1kOutputTokens > 0
)!;

function fixture(env: Partial<AiProxyEnv> = {}) {
  const rows = new Map<string, string>();
  const kv = {
    get: vi.fn(async (key: string, type?: string) => {
      const value = rows.get(key);
      return value === undefined ? null : type === 'json' ? JSON.parse(value) : value;
    }),
    put: vi.fn(async (key: string, value: string) => {
      rows.set(key, value);
    }),
  } as unknown as KVNamespace & { get: ReturnType<typeof vi.fn> };
  // No addressable gateway: SAM meters spend itself (direct upstream).
  return { rows, kv, env: { KV: kv, ...env } as AiProxyEnv };
}

const GATEWAY = { AI_GATEWAY_ID: 'gw', CF_ACCOUNT_ID: 'acct', CF_API_TOKEN: 'tok' };

function ceiling(usd: number) {
  return { monthlyCostCeilingUsd: vi.fn(async () => usd) };
}

/** Spend `requests` priced calls through the real accounting path. */
async function spend(env: AiProxyEnv, userId: string, requests: number) {
  for (let i = 0; i < requests; i++) {
    await accountTokenUsageFromJson(
      { usage: { prompt_tokens: 100_000, completion_tokens: 100_000 } },
      { env, userId, format: 'openai', costModelId: PRICED.id }
    );
  }
  return getLocalMonthlyAiCostUsd(env.KV, userId, env);
}

describe('effectiveMonthlyCostCapUsd (the one cap predicate)', () => {
  it.each([
    [null, null, null],
    [0, null, null],
    [-5, null, null],
    [10, null, 10],
    [null, 50, 50],
    [10, 50, 10],
    [80, 50, 50],
    [Number.NaN, 50, 50],
  ])('user %s, ceiling %s -> %s', (user, ceil, expected) => {
    expect(effectiveMonthlyCostCapUsd(user, ceil)).toBe(expected);
  });
});

describe('installation ceiling on the direct-upstream (local metering) path', () => {
  it('blocks a user with no cap once their priced spend reaches the ceiling', async () => {
    const { kv, env } = fixture();
    const cost = await spend(env, 'user', 2);
    const ports = ceiling(Math.floor(cost)); // ceiling at or below spend
    expect(Math.floor(cost)).toBeGreaterThan(0);
    const gate = await checkAiUsageGate(kv, 'user', env, ports);
    expect(gate).toMatchObject({ allowed: false, reason: 'monthly-cost-cap' });
    expect(ports.monthlyCostCeilingUsd).toHaveBeenCalledTimes(1);
  });

  it('allows the same user while spend is under the ceiling (control)', async () => {
    const { kv, env } = fixture();
    const cost = await spend(env, 'user', 1);
    const result = await checkMonthlyCostCap(kv, 'user', env, ceiling(Math.ceil(cost) + 100));
    expect(result).toMatchObject({ allowed: true, capUsd: Math.ceil(cost) + 100 });
  });

  it('enforces a user cap set above the ceiling at the ceiling (cannot raise past it)', async () => {
    const { rows, kv, env } = fixture();
    const cost = await spend(env, 'user', 2);
    rows.set(buildBudgetSettingsKey('user'), JSON.stringify({ monthlyCostCapUsd: 10_000 }));
    const result = await checkMonthlyCostCap(kv, 'user', env, ceiling(Math.floor(cost)));
    expect(result).toMatchObject({ allowed: false, capUsd: Math.floor(cost) });
  });

  it('keeps a lower user cap when it is below the ceiling', async () => {
    const { rows, kv, env } = fixture();
    rows.set(buildBudgetSettingsKey('user'), JSON.stringify({ monthlyCostCapUsd: 3 }));
    const result = await checkMonthlyCostCap(kv, 'user', env, ceiling(50));
    expect(result).toMatchObject({ allowed: true, capUsd: 3 });
  });

  it('treats 0 as no ceiling', async () => {
    const { kv, env } = fixture();
    await spend(env, 'user', 2);
    const result = await checkMonthlyCostCap(kv, 'user', env, ceiling(0));
    expect(result).toEqual({ allowed: true, costUsd: 0, capUsd: null });
  });

  it.each([null, 100])(
    'refuses admission while the ceiling is unknown (personal cap %s)',
    async (monthlyCostCapUsd) => {
      const { rows, kv, env } = fixture();
      rows.set(buildBudgetSettingsKey('user'), JSON.stringify({ monthlyCostCapUsd }));
      const ports = { monthlyCostCeilingUsd: vi.fn(async () => Promise.reject(new Error('d1'))) };
      await expect(resolveMonthlyCostCeilingUsd(env, ports)).rejects.toMatchObject({
        statusCode: 503,
        error: 'SERVICE_UNAVAILABLE',
      });
      await expect(checkAiUsageGate(kv, 'user', env, ports)).rejects.toMatchObject({
        statusCode: 503,
        error: 'SERVICE_UNAVAILABLE',
      });
    }
  );

  it.each(['durable-object', 'kv'])(
    'returns a retryable outage when monthly spend cannot be read (%s)',
    async (storage) => {
      const { kv, env } = fixture();
      if (storage === 'durable-object') {
        env.AI_TOKEN_BUDGET_COUNTER = {
          idFromName: () => 'user',
          get: () => ({
            get: async () => ({ inputTokens: 0, outputTokens: 0 }),
            getProviderUsage: async () => {
              throw new Error('storage unavailable');
            },
          }),
        } as unknown as DurableObjectNamespace;
      } else {
        kv.get.mockImplementation(async (key: string) => {
          if (key.startsWith('ai-provider-usage:')) throw new Error('storage unavailable');
          return null;
        });
      }
      await expect(checkAiUsageGate(kv, 'user', env, ceiling(50))).rejects.toMatchObject({
        statusCode: 503,
        error: 'SERVICE_UNAVAILABLE',
      });
    }
  );

  it('does not read the ceiling for locally own-funded calls during a settings outage', async () => {
    const { kv, env } = fixture();
    const ports = {
      monthlyCostCeilingUsd: vi.fn(async () => {
        throw new Error('settings unavailable');
      }),
    };
    await expect(
      checkAiUsageGate(kv, 'user', env, ports, { platformBilled: false })
    ).resolves.toEqual({ allowed: true });
    expect(ports.monthlyCostCeilingUsd).not.toHaveBeenCalled();
  });

  it('a malformed stored settings row does not fail the call, and the ceiling still applies', async () => {
    const { rows, kv, env } = fixture();
    const cost = await spend(env, 'user', 2);
    rows.set(buildBudgetSettingsKey('user'), '{not json');
    await expect(getUserBudgetSettings(kv, 'user')).resolves.toBeNull();
    const gate = await checkAiUsageGate(kv, 'user', env, ceiling(Math.floor(cost)));
    expect(gate).toMatchObject({ allowed: false, reason: 'monthly-cost-cap' });

    rows.set(buildBudgetSettingsKey('user'), JSON.stringify({ monthlyCostCapUsd: 'lots' }));
    await expect(getUserBudgetSettings(kv, 'user')).resolves.toBeNull();
  });

  it('parses a well-formed row unchanged (owner control for the tolerant parser)', async () => {
    const { rows, kv } = fixture();
    const stored = {
      dailyInputTokenLimit: 5_000,
      dailyOutputTokenLimit: null,
      monthlyCostCapUsd: 12.5,
      alertThresholdPercent: 70,
    };
    rows.set(buildBudgetSettingsKey('user'), JSON.stringify(stored));
    await expect(getUserBudgetSettings(kv, 'user')).resolves.toEqual(stored);
  });
});

describe('AI Gateway path applies the ceiling (hosted)', () => {
  it('refuses at the ceiling when it is below the user cap, with the administrator message', async () => {
    const { rows, kv, env } = fixture(GATEWAY);
    rows.set(buildBudgetSettingsKey('user'), JSON.stringify({ monthlyCostCapUsd: 10 }));
    rows.set(buildMonthlyCostCacheKey('user'), '2');
    const ports = ceiling(1);
    const gate = await checkAiUsageGate(kv, 'user', env, ports);
    expect(gate).toMatchObject({
      allowed: false,
      reason: 'monthly-cost-cap',
      monthlyCap: { capUsd: 1, costUsd: 2, limitSource: 'administrator' },
    });
    expect(ports.monthlyCostCeilingUsd).toHaveBeenCalledTimes(1);
  });

  it('refuses a gateway user with no cap of their own once gateway spend reaches the ceiling', async () => {
    const { rows, kv, env } = fixture(GATEWAY);
    rows.set(buildMonthlyCostCacheKey('user'), '500');
    await expect(checkAiUsageGate(kv, 'user', env, ceiling(1))).resolves.toMatchObject({
      allowed: false,
      monthlyCap: { capUsd: 1, limitSource: 'administrator' },
    });
  });

  it('admits below the ceiling (control)', async () => {
    const { rows, kv, env } = fixture(GATEWAY);
    rows.set(buildMonthlyCostCacheKey('user'), '0.5');
    await expect(checkAiUsageGate(kv, 'user', env, ceiling(1))).resolves.toEqual({
      allowed: true,
    });
  });

  it("does not hold a user-funded passthrough call to the ceiling; the user's own cap still applies", async () => {
    const { rows, kv, env } = fixture(GATEWAY);
    rows.set(buildMonthlyCostCacheKey('user'), '5');
    const ports = ceiling(1);
    await expect(
      checkAiUsageGate(kv, 'user', env, ports, { platformBilled: false })
    ).resolves.toEqual({ allowed: true });
    expect(ports.monthlyCostCeilingUsd).not.toHaveBeenCalled();
    rows.set(buildBudgetSettingsKey('user'), JSON.stringify({ monthlyCostCapUsd: 4 }));
    await expect(
      checkAiUsageGate(kv, 'user', env, ports, { platformBilled: false })
    ).resolves.toMatchObject({ allowed: false, monthlyCap: { capUsd: 4 } });
  });

  it('refuses with a 503 when the ceiling cannot be read', async () => {
    const { kv, env } = fixture(GATEWAY);
    const ports = { monthlyCostCeilingUsd: vi.fn(async () => Promise.reject(new Error('d1'))) };
    await expect(checkAiUsageGate(kv, 'user', env, ports)).rejects.toMatchObject({
      statusCode: 503,
    });
  });
});

describe('validateBudgetUpdate against the ceiling', () => {
  const env = {} as AiProxyEnv;

  it('refuses a cap above the ceiling and names the bound', () => {
    expect(() => validateBudgetUpdate({ monthlyCostCapUsd: 60 }, env, null, 50)).toThrow(
      /between 0\.01 and 50/
    );
  });

  it('accepts a cap at or below the ceiling, and clearing the cap', () => {
    expect(validateBudgetUpdate({ monthlyCostCapUsd: 50 }, env, null, 50).monthlyCostCapUsd).toBe(
      50
    );
    expect(
      validateBudgetUpdate({ monthlyCostCapUsd: null }, env, null, 50).monthlyCostCapUsd
    ).toBeNull();
  });

  it('applies the lower of the admin allowance and the ceiling', () => {
    const allowance = {
      maxDailyInputTokens: null,
      maxDailyOutputTokens: null,
      maxMonthlyCostCapUsd: 20,
      allowedModelTiers: null,
      updatedAt: '',
      updatedBy: '',
    };
    expect(() => validateBudgetUpdate({ monthlyCostCapUsd: 30 }, env, allowance, 50)).toThrow(
      /between 0\.01 and 20/
    );
  });

  it('refuses any cap where spend cannot be priced (gateway without the account API)', () => {
    const unpriced = { AI_GATEWAY_ID: 'gw', CF_ACCOUNT_ID: 'acct' } as AiProxyEnv;
    expect(() => validateBudgetUpdate({ monthlyCostCapUsd: 5 }, unpriced, null, null)).toThrow(
      /not available on this installation/
    );
    expect(
      validateBudgetUpdate({ monthlyCostCapUsd: null }, unpriced, null, null).monthlyCostCapUsd
    ).toBeNull();
  });
});

describe('billing ownership and denial recovery', () => {
  it('keeps locally funded platform spend blocked and permits own funding', async () => {
    const { kv, env } = fixture();
    const cost = await spend(env, 'user', 2);
    const ports = ceiling(Math.floor(cost));
    expect(await checkAiUsageGate(kv, 'user', env, ports)).toMatchObject({ allowed: false });
    expect(await checkAiUsageGate(kv, 'user', env, ports, { platformBilled: false })).toEqual({
      allowed: true,
    });
  });

  it('still enforces daily budgets for own funding', async () => {
    const { rows, kv, env } = fixture();
    await spend(env, 'user', 1);
    rows.set(buildBudgetSettingsKey('user'), JSON.stringify({ dailyInputTokenLimit: 1 }));
    expect(
      await checkAiUsageGate(kv, 'user', env, ceiling(50), { platformBilled: false })
    ).toMatchObject({ allowed: false, reason: 'daily-token-budget' });
  });

  it('does not bypass gateway monthly caps for own funding', async () => {
    const { rows, kv, env } = fixture(GATEWAY);
    rows.set(buildBudgetSettingsKey('user'), JSON.stringify({ monthlyCostCapUsd: 1 }));
    rows.set(buildMonthlyCostCacheKey('user'), '2');
    expect(
      await checkAiUsageGate(kv, 'user', env, ceiling(50), { platformBilled: false })
    ).toMatchObject({ allowed: false, reason: 'monthly-cost-cap' });
  });

  it('names the administrator when the ceiling binds, retaining user cap recovery otherwise', async () => {
    const { rows, kv, env } = fixture();
    await spend(env, 'user', 2);
    const result = await checkMonthlyCostCap(kv, 'user', env, ceiling(1));
    expect(result).toMatchObject({ allowed: false, limitSource: 'administrator' });
    expect(monthlyCostCapMessage(result)).toContain('Contact your administrator');
    rows.set(buildBudgetSettingsKey('user'), JSON.stringify({ monthlyCostCapUsd: 0.01 }));
    const personal = await checkMonthlyCostCap(kv, 'user', env, ceiling(50));
    expect(personal).toMatchObject({ allowed: false });
    expect(personal.limitSource).toBeUndefined();
    expect(monthlyCostCapMessage(personal)).toContain('Settings > Usage');
  });
});
