import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  buildFeatureBudgetKey,
  consumeFeatureTokenBudget,
  getFeatureTokenBudget,
  releaseFeatureTokenBudget,
} from '../../../src/services/ai-token-budget';

function createKv() {
  const values = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
  } as unknown as KVNamespace;
}

describe('feature token budget', () => {
  it('uses an isolated deployment feature key in the KV fallback', async () => {
    const kv = createKv();
    expect(buildFeatureBudgetKey('deployment-debug-agent', new Date('2026-07-29T12:00:00Z')))
      .toBe('ai-feature-budget:deployment-debug-agent:2026-07-29');

    expect(await consumeFeatureTokenBudget(kv, 'deployment-debug-agent', 40, 100)).toMatchObject({
      allowed: true,
      usedTokens: 40,
    });
    expect(await consumeFeatureTokenBudget(kv, 'deployment-debug-agent', 60, 100)).toMatchObject({
      allowed: true,
      usedTokens: 100,
    });
    expect(await consumeFeatureTokenBudget(kv, 'deployment-debug-agent', 1, 100)).toMatchObject({
      allowed: false,
      usedTokens: 100,
    });
  });

  it('releases unused reservations without crossing below zero', async () => {
    const kv = createKv();
    await consumeFeatureTokenBudget(kv, 'deployment-debug-agent', 80, 100);
    expect(await releaseFeatureTokenBudget(kv, 'deployment-debug-agent', 30, 100))
      .toMatchObject({ allowed: true, usedTokens: 50 });
    expect(await releaseFeatureTokenBudget(kv, 'deployment-debug-agent', 100, 100))
      .toMatchObject({ allowed: true, usedTokens: 0 });
  });

  it('delegates concurrent enforcement to one feature-scoped Durable Object', async () => {
    const kv = createKv();
    let usedTokens = 0;
    let queue = Promise.resolve();
    const stub = {
      get: vi.fn(async () => ({ inputTokens: usedTokens, outputTokens: 0 })),
      consumeTotal: vi.fn(async (_date: string, limit: number, tokens: number) => {
        let result = { allowed: false, usedTokens };
        queue = queue.then(async () => {
          if (usedTokens + tokens <= limit) {
            usedTokens += tokens;
            result = { allowed: true, usedTokens };
          }
        });
        await queue;
        return result;
      }),
    };
    const env = {
      AI_TOKEN_BUDGET_COUNTER: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => stub),
      },
    } as unknown as Env;

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        consumeFeatureTokenBudget(kv, 'deployment-debug-agent', 10, 100, env)
      )
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(10);
    expect((await getFeatureTokenBudget(kv, 'deployment-debug-agent', 100, env)).usedTokens)
      .toBe(100);
    expect(env.AI_TOKEN_BUDGET_COUNTER?.idFromName).toHaveBeenCalledWith(
      'feature:deployment-debug-agent'
    );
  });
});
