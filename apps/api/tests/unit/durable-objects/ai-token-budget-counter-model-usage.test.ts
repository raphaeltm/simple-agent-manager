/**
 * The per-model usage table in `AiTokenBudgetCounter` (overnight B3 A2), against real SQLite:
 * increments accumulate per (day, model), the date filter applies, and the provider rows the
 * monthly cap reads are unaffected. Then `getLocalUsageBreakdown` through the Durable Object path.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { AiTokenBudgetCounter } from '../../../src/durable-objects/ai-token-budget-counter';
import type { Env } from '../../../src/env';
import { getLocalUsageBreakdown, incrementModelUsage } from '../../../src/services/ai-model-usage';
import { createSqlStorage } from './sql-storage-test-utils';

function counter(): AiTokenBudgetCounter {
  const sql = createSqlStorage(new Database(':memory:'));
  const ctx = {
    storage: { sql, transactionSync: <T>(fn: () => T): T => fn() },
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
  };
  return new AiTokenBudgetCounter(ctx as never, {} as Env);
}

describe('AiTokenBudgetCounter per-model usage', () => {
  it('accumulates per day and model and filters by start date', async () => {
    const stub = counter();
    await stub.incrementModelUsage('2026-11-01', 'claude-a', 'anthropic', 100, 10, 0.5);
    await stub.incrementModelUsage('2026-11-12', 'claude-a', 'anthropic', 200, 20, 1);
    await stub.incrementModelUsage('2026-11-12', 'claude-a', 'anthropic', 300, 30, 2);
    await stub.incrementModelUsage('2026-11-12', 'gpt-b', 'openai', 50, 5, 0.25);

    const rows = await stub.getModelUsage('2026-11-10');
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.modelId === 'claude-a')).toEqual({
      date: '2026-11-12',
      modelId: 'claude-a',
      providerId: 'anthropic',
      requests: 2,
      inputTokens: 500,
      outputTokens: 50,
      estimatedCostUsd: 3,
    });
    // Provider rows (the monthly cap's source) are a separate table.
    expect(await stub.getProviderUsage('2026-11-01')).toEqual([]);
  });

  it('serves the usage page breakdown through the Durable Object binding', async () => {
    const stub = counter();
    const env = {
      AI_TOKEN_BUDGET_COUNTER: { idFromName: (name: string) => name, get: () => stub },
    } as unknown as Env;

    await incrementModelUsage(env, 'user-1', 'claude-a', 'anthropic', 100, 10, 0.5);
    await incrementModelUsage(env, 'user-1', 'gpt-b', 'openai', 100, 10, 1.5);

    const today = new Date().toISOString().slice(0, 10);
    const { byModel, byDay } = await getLocalUsageBreakdown(env, 'user-1', new Date(today));
    expect(byModel.map((model) => [model.model, model.costUsd])).toEqual([
      ['gpt-b', 1.5],
      ['claude-a', 0.5],
    ]);
    expect(byDay).toEqual([
      { date: today, requests: 2, inputTokens: 200, outputTokens: 20, costUsd: 2 },
    ]);
  });
});
