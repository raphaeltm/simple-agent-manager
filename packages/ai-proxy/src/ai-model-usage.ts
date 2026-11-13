/**
 * Per-model, per-day AI spend that SAM priced itself (`hasLocalAiCostMetering`), so the usage page
 * can show model and day breakdowns on an installation without AI Gateway (where those come from
 * gateway logs). Rows live in the user's `AiTokenBudgetCounter` (`ai_model_usage`), with a KV
 * fallback when the Durable Object binding is absent, mirroring `incrementProviderUsage`.
 */
import { DEFAULT_AI_USAGE_BUDGET_TTL_SECONDS } from '@simple-agent-manager/shared';

import type { AiProxyEnv } from './env';
import type { UsageByDay, UsageByModel } from './ai-gateway-logs';

export interface AiModelUsageRow {
  date: string;
  modelId: string;
  providerId: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

interface AiModelUsageCounterStub {
  incrementModelUsage(
    dateKey: string,
    modelId: string,
    providerId: string,
    inputTokens: number,
    outputTokens: number,
    estimatedCostUsd: number
  ): Promise<void>;
  getModelUsage(startDateKey: string): Promise<AiModelUsageRow[]>;
}

function counter(env: AiProxyEnv, userId: string): AiModelUsageCounterStub | null {
  if (!env.AI_TOKEN_BUDGET_COUNTER) return null;
  return env.AI_TOKEN_BUDGET_COUNTER.get(
    env.AI_TOKEN_BUDGET_COUNTER.idFromName(userId)
  ) as unknown as AiModelUsageCounterStub;
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function kvKey(userId: string, date: string): string {
  return `ai-model-usage:${userId}:${date}`;
}

export async function incrementModelUsage(
  env: AiProxyEnv,
  userId: string,
  modelId: string,
  providerId: string,
  inputTokens: number,
  outputTokens: number,
  estimatedCostUsd: number
): Promise<void> {
  const today = dateKey(new Date());
  const stub = counter(env, userId);
  if (stub) {
    await stub.incrementModelUsage(
      today,
      modelId,
      providerId,
      inputTokens,
      outputTokens,
      estimatedCostUsd
    );
    return;
  }
  const key = kvKey(userId, today);
  const rows = (await env.KV.get<Record<string, AiModelUsageRow>>(key, 'json')) ?? {};
  const current = rows[modelId] ?? {
    date: today,
    modelId,
    providerId,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  };
  rows[modelId] = {
    ...current,
    requests: current.requests + 1,
    inputTokens: current.inputTokens + inputTokens,
    outputTokens: current.outputTokens + outputTokens,
    estimatedCostUsd: current.estimatedCostUsd + estimatedCostUsd,
  };
  const ttl =
    Number.parseInt(env.AI_USAGE_BUDGET_TTL_SECONDS || '', 10) ||
    DEFAULT_AI_USAGE_BUDGET_TTL_SECONDS;
  await env.KV.put(key, JSON.stringify(rows), { expirationTtl: ttl });
}

async function readRows(
  env: AiProxyEnv,
  userId: string,
  start: Date,
  end: Date
): Promise<AiModelUsageRow[]> {
  const stub = counter(env, userId);
  if (stub) return stub.getModelUsage(dateKey(start));
  const rows: AiModelUsageRow[] = [];
  const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  while (day <= end) {
    const stored = await env.KV.get<Record<string, AiModelUsageRow>>(
      kvKey(userId, dateKey(day)),
      'json'
    );
    if (stored) rows.push(...Object.values(stored));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return rows;
}

/** byModel and byDay for `/api/usage/ai` from SAM's own priced records. */
export async function getLocalUsageBreakdown(
  env: AiProxyEnv,
  userId: string,
  start: Date,
  end = new Date()
): Promise<{ byModel: UsageByModel[]; byDay: UsageByDay[] }> {
  const models = new Map<string, UsageByModel>();
  const days = new Map<string, UsageByDay>();
  for (const row of await readRows(env, userId, start, end)) {
    const model = models.get(row.modelId) ?? {
      model: row.modelId,
      provider: row.providerId,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      cachedRequests: 0,
      errorRequests: 0,
    };
    model.requests += row.requests;
    model.inputTokens += row.inputTokens;
    model.outputTokens += row.outputTokens;
    model.totalTokens += row.inputTokens + row.outputTokens;
    model.costUsd += row.estimatedCostUsd;
    models.set(row.modelId, model);

    const day = days.get(row.date) ?? {
      date: row.date,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    day.requests += row.requests;
    day.inputTokens += row.inputTokens;
    day.outputTokens += row.outputTokens;
    day.costUsd += row.estimatedCostUsd;
    days.set(row.date, day);
  }
  return {
    byModel: Array.from(models.values()).sort((a, b) => b.costUsd - a.costUsd),
    byDay: Array.from(days.values()).sort((a, b) => a.date.localeCompare(b.date)),
  };
}
