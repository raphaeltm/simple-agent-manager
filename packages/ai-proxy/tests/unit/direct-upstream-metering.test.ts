import { PLATFORM_AI_MODELS } from '@simple-agent-manager/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  hasLocalAiCostMetering,
  isMonthlyCostCapAvailable,
  resolveAiGatewayId,
} from '../../src/ai-gateway-availability';
import { getLocalMonthlyAiCostUsd } from '../../src/ai-monthly-cost-cap';
import {
  buildBudgetSettingsKey,
  checkMonthlyCostCap,
  incrementProviderUsage,
} from '../../src/ai-token-budget';
import {
  accountTokenUsageFromJson,
  accountTokenUsageFromStream,
} from '../../src/ai-token-usage-accounting';
import type { AiProxyEnv } from '../../src/env';

function fixture() {
  const rows = new Map<string, string>();
  const expires = new Map<string, number>();
  const kv = {
    get: vi.fn(async (key: string, type?: string) => {
      if ((expires.get(key) ?? Infinity) <= Date.now()) rows.delete(key);
      const value = rows.get(key);
      return value === undefined ? null : type === 'json' ? JSON.parse(value) : value;
    }),
    put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
      rows.set(key, value);
      if (options?.expirationTtl) expires.set(key, Date.now() + options.expirationTtl * 1000);
    }),
  } as unknown as KVNamespace;
  const env = { KV: kv } as AiProxyEnv;
  return { rows, kv, env };
}
const NO_CEILING = { monthlyCostCeilingUsd: async () => 0 };
afterEach(() => vi.useRealTimers());

describe('direct-upstream metering, without forced include_usage', () => {
  it('retains day-one spend through month-end on TTL-expiring KV, including later unpriced writes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    const { rows, kv, env } = fixture();
    rows.set(buildBudgetSettingsKey('user'), JSON.stringify({ monthlyCostCapUsd: 0.000001 }));
    const model = PLATFORM_AI_MODELS.find(
      (m) => m.provider === 'openai' && m.costPer1kOutputTokens > 0
    )!;
    await accountTokenUsageFromJson(
      { usage: { prompt_tokens: 100, completion_tokens: 100 } },
      { env, userId: 'user', format: 'openai', costModelId: model.id }
    );
    const firstCost = await getLocalMonthlyAiCostUsd(kv, 'user', env);
    expect(firstCost).toBeGreaterThan(0);
    await incrementProviderUsage(
      kv,
      'user',
      { providerId: 'openai', providerName: 'OpenAI', dialect: 'openai' },
      1,
      1,
      env
    );
    vi.setSystemTime(new Date('2026-10-31T23:59:00Z'));
    expect(await getLocalMonthlyAiCostUsd(kv, 'user', env)).toBe(firstCost);
    expect(await checkMonthlyCostCap(kv, 'user', env, NO_CEILING)).toMatchObject({
      allowed: false,
    });
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    expect(await checkMonthlyCostCap(kv, 'user', env, NO_CEILING)).toMatchObject({
      allowed: true,
      costUsd: 0,
    });
  });

  it('meters a platform response into the same local store that the monthly cap reads', async () => {
    const { rows, kv, env } = fixture();
    rows.set(buildBudgetSettingsKey('user'), JSON.stringify({ monthlyCostCapUsd: 0.000001 }));
    const model = PLATFORM_AI_MODELS.find(
      (m) => m.provider === 'openai' && m.costPer1kOutputTokens > 0
    )!;
    const measured = vi.fn(async () => {});
    await accountTokenUsageFromJson(
      { usage: { prompt_tokens: 100, completion_tokens: 100 } },
      { env, userId: 'user', format: 'openai', costModelId: model.id, onMeasuredUsage: measured }
    );
    expect(await checkMonthlyCostCap(kv, 'user', env, NO_CEILING)).toMatchObject({
      allowed: false,
      capUsd: 0.000001,
    });
    expect(measured).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 100, outputTokens: 100 })
    );
  });

  it('estimates missing stream usage for the budget without inventing measured run usage', async () => {
    const { kv, env } = fixture();
    const pending: Promise<unknown>[] = [];
    const measured = vi.fn(async () => {});
    const text = 'data: {"choices":[{"delta":{"content":"twelve bytes"}}]}\n\ndata: [DONE]\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    });
    accountTokenUsageFromStream(stream, {
      env,
      userId: 'user',
      format: 'openai',
      fallbackInputTokens: 10,
      estimateMissingUsage: true,
      onMeasuredUsage: measured,
      executionCtx: {
        waitUntil(p) {
          pending.push(p);
        },
      },
    });
    await Promise.all(pending);
    expect(kv.put).toHaveBeenCalledWith(
      expect.stringContaining('ai-budget:user:'),
      expect.stringContaining('"outputTokens":4'),
      expect.anything()
    );
    expect(measured).not.toHaveBeenCalled();
  });

  it('reads a day-31 KV month in parallel, with a bounded 31-read fallback', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
    let active = 0,
      maxActive = 0;
    const kv = {
      get: vi.fn(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active--;
        return null;
      }),
    } as unknown as KVNamespace;
    expect(await getLocalMonthlyAiCostUsd(kv, 'user', {} as AiProxyEnv)).toBe(0);
    expect(kv.get).toHaveBeenCalledTimes(31);
    expect(maxActive).toBe(31);
  });

  it('does not mistake the ambient gateway ID for an addressable gateway, and uses one cap predicate', () => {
    const env = { AI_GATEWAY_ID: 'sam' } as AiProxyEnv;
    expect(resolveAiGatewayId(env)).toBeNull();
    expect(hasLocalAiCostMetering(env)).toBe(true);
    expect(isMonthlyCostCapAvailable(env)).toBe(true);
    expect(isMonthlyCostCapAvailable({ ...env, CF_ACCOUNT_ID: 'account' })).toBe(false);
    expect(
      isMonthlyCostCapAvailable({ ...env, CF_ACCOUNT_ID: 'account', CF_API_TOKEN: 'token' })
    ).toBe(true);
  });
});

describe('legacy OpenAI function call estimation', () => {
  it.each([false, true])('counts function_call output without usage, streaming=%s', async (streaming) => {
    const { kv, env } = fixture();
    const model = PLATFORM_AI_MODELS.find(
      (m) => m.provider === 'openai' && m.costPer1kOutputTokens > 0
    )!;
    const measured = vi.fn();
    const functionCall = { name: 'lookup', arguments: '{"query":"twelve bytes"}' };
    const options = {
      env,
      userId: 'user',
      format: 'openai' as const,
      costModelId: model.id,
      estimateMissingUsage: true,
      onMeasuredUsage: measured,
    };
    if (streaming) {
      const pending: Promise<unknown>[] = [];
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          for (const chunk of [{ name: functionCall.name }, { arguments: functionCall.arguments }]) {
            c.enqueue(new TextEncoder().encode(
              `data: ${JSON.stringify({ choices: [{ delta: { function_call: chunk } }] })}\n\n`
            ));
          }
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      accountTokenUsageFromStream(stream, {
        ...options,
        executionCtx: { waitUntil(p) { pending.push(p); } },
      });
      await Promise.all(pending);
    } else {
      await accountTokenUsageFromJson(
        { choices: [{ message: { content: null, function_call: functionCall } }] }, options
      );
    }
    expect(await getLocalMonthlyAiCostUsd(kv, 'user', env)).toBeGreaterThan(0);
    expect(measured).not.toHaveBeenCalled();
  });
});

describe('Anthropic missing usage estimation', () => {
  const text = 'twelve bytes';
  it.each([
    { type: 'text', text },
    { type: 'thinking', thinking: text },
    { type: 'tool_use', input: { key: text } },
  ])('prices JSON $type output without measured usage', async (block) => {
    const { kv, env } = fixture();
    const model = PLATFORM_AI_MODELS.find((m) => m.provider === 'anthropic')!;
    const measured = vi.fn();
    await accountTokenUsageFromJson(
      { content: [block] },
      {
        env,
        userId: 'user',
        format: 'anthropic',
        costModelId: model.id,
        estimateMissingUsage: true,
        onMeasuredUsage: measured,
      }
    );
    expect(await getLocalMonthlyAiCostUsd(kv, 'user', env)).toBeGreaterThan(0);
    expect(measured).not.toHaveBeenCalled();
  });
  it.each([
    { type: 'text_delta', text },
    { type: 'thinking_delta', thinking: text },
    { type: 'input_json_delta', partial_json: text },
  ])('prices streaming $type output without measured usage', async (delta) => {
    const { kv, env } = fixture();
    const pending: Promise<unknown>[] = [];
    const measured = vi.fn();
    const model = PLATFORM_AI_MODELS.find((m) => m.provider === 'anthropic')!;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ type: 'content_block_delta', delta })}\n\n`
          )
        );
        c.close();
      },
    });
    accountTokenUsageFromStream(stream, {
      env,
      userId: 'user',
      format: 'anthropic',
      costModelId: model.id,
      estimateMissingUsage: true,
      onMeasuredUsage: measured,
      executionCtx: {
        waitUntil(p) {
          pending.push(p);
        },
      },
    });
    await Promise.all(pending);
    expect(await getLocalMonthlyAiCostUsd(kv, 'user', env)).toBeGreaterThan(0);
    expect(measured).not.toHaveBeenCalled();
  });
});
