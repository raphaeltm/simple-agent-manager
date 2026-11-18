/**
 * Per-model, per-day AI spend that SAM priced itself (`hasLocalAiCostMetering`), so the usage page
 * can show model and day breakdowns on an installation without AI Gateway (where those come from
 * gateway logs). Rows live in the user's `AiTokenBudgetCounter` (`ai_model_usage`), written in the
 * same transaction as the provider row (`incrementProviderUsage(..., modelId)`), so recording a
 * model costs no extra round trip. Without the Durable Object binding there is no breakdown.
 */
import { log } from '@simple-agent-manager/worker-core';

import type { UsageByDay, UsageByModel } from './ai-gateway-logs';
import type { AiProxyEnv } from './env';

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
  getModelUsage(startDateKey: string): Promise<AiModelUsageRow[]>;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * One stored `ai_model_usage` row, or null (logged) when a column has the wrong type: a single
 * bad row is left out of the breakdown rather than failing the usage page (rule 50).
 */
export function parseModelUsageRow(row: Record<string, unknown>): AiModelUsageRow | null {
  const parsed = {
    date: typeof row.budget_date === 'string' ? row.budget_date : null,
    modelId: typeof row.model_id === 'string' ? row.model_id : null,
    providerId: typeof row.provider_id === 'string' ? row.provider_id : null,
    requests: finite(row.requests),
    inputTokens: finite(row.input_tokens),
    outputTokens: finite(row.output_tokens),
    estimatedCostUsd: finite(row.estimated_cost_usd),
  };
  const bad = Object.entries(parsed).find(([, value]) => value === null);
  if (!bad) return parsed as AiModelUsageRow;
  log.warn('ai_proxy.model_usage_row_skipped', {
    budgetDate: parsed.date,
    modelId: parsed.modelId,
    field: bad[0],
    action: 'skipped',
  });
  return null;
}

/** byModel and byDay for `/api/usage/ai` from SAM's own priced records. One DO RPC. */
export async function getLocalUsageBreakdown(
  env: AiProxyEnv,
  userId: string,
  start: Date
): Promise<{ byModel: UsageByModel[]; byDay: UsageByDay[] }> {
  if (!env.AI_TOKEN_BUDGET_COUNTER) return { byModel: [], byDay: [] };
  const stub = env.AI_TOKEN_BUDGET_COUNTER.get(
    env.AI_TOKEN_BUDGET_COUNTER.idFromName(userId)
  ) as unknown as AiModelUsageCounterStub;
  const rows = await stub.getModelUsage(start.toISOString().slice(0, 10));

  const models = new Map<string, UsageByModel>();
  const days = new Map<string, UsageByDay>();
  for (const row of rows) {
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
    byModel: Array.from(models.values()).sort(
      (a, b) => b.costUsd - a.costUsd || a.model.localeCompare(b.model)
    ),
    byDay: Array.from(days.values()).sort((a, b) => a.date.localeCompare(b.date)),
  };
}
