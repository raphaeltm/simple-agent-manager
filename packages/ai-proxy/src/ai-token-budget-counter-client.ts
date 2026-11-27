/**
 * Worker-side handle on the per-user `AiTokenBudgetCounter` Durable Object: the RPC surface the
 * budget, accounting and cap modules call. Split out of ai-token-budget.ts (rule 18).
 */
import type { CostEstimateWrite, GatewayAdmissionSnapshot } from './ai-cost-estimate';
import type {
  AiProviderUsageAttribution,
  AiProviderUsageEntry,
  TokenBudget,
} from './ai-token-budget';
import type { AiProxyEnv } from './env';

export interface AiTokenBudgetCounterStub extends DurableObjectStub {
  get(dateKey: string): Promise<TokenBudget>;
  consumeTotal(
    dateKey: string,
    tokenLimit: number,
    tokens: number
  ): Promise<{ allowed: boolean; usedTokens: number }>;
  releaseTotal(dateKey: string, tokens: number): Promise<number>;
  increment(
    dateKey: string,
    inputTokens: number,
    outputTokens: number,
    costEstimate?: CostEstimateWrite
  ): Promise<TokenBudget>;
  incrementProviderUsage(
    dateKey: string,
    attribution: AiProviderUsageAttribution,
    inputTokens: number,
    outputTokens: number,
    estimatedCostUsd: number,
    modelId?: string
  ): Promise<void>;
  getProviderUsage(startDateKey: string): Promise<AiProviderUsageEntry[]>;
  getGatewayAdmissionSnapshot(
    dateKey: string,
    monthKey: string,
    estimateSinceMs: number | null
  ): Promise<GatewayAdmissionSnapshot>;
}

/** UTC day key (`YYYY-MM-DD`) the daily rows are stored under. */
export function buildBudgetDateKey(date?: Date): string {
  const d = date ?? new Date();
  return d.toISOString().slice(0, 10);
}

/** The user's counter object, or null where the binding is absent (KV compatibility fallback). */
export function getBudgetCounter(
  env: AiProxyEnv | undefined,
  userId: string
): AiTokenBudgetCounterStub | null {
  if (!env?.AI_TOKEN_BUDGET_COUNTER) return null;
  return env.AI_TOKEN_BUDGET_COUNTER.get(
    env.AI_TOKEN_BUDGET_COUNTER.idFromName(userId)
  ) as AiTokenBudgetCounterStub;
}
