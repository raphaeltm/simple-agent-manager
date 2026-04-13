/**
 * Per-user daily token budget tracking via KV.
 *
 * Stores input/output token counts keyed by userId + date.
 * Auto-expires via KV TTL (86400s) so no cleanup is needed.
 *
 * NOTE: The read-increment-write pattern is not atomic. Under concurrent requests
 * from the same user, the true count may slightly exceed the limit. For strict
 * enforcement, use a Durable Object counter. KV is sufficient here because
 * small overages on a daily budget are acceptable.
 */

import {
  DEFAULT_AI_PROXY_DAILY_INPUT_TOKEN_LIMIT,
  DEFAULT_AI_PROXY_DAILY_OUTPUT_TOKEN_LIMIT,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';

/** KV TTL for budget entries — 24 hours with 1 hour buffer for timezone edge cases. */
const BUDGET_TTL_SECONDS = 86400 + 3600;

export interface TokenBudget {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Build the KV key for a user's daily budget.
 * Format: `ai-budget:{userId}:{YYYY-MM-DD}`
 */
export function buildBudgetKey(userId: string, date?: Date): string {
  const d = date ?? new Date();
  const dateStr = d.toISOString().slice(0, 10); // YYYY-MM-DD
  return `ai-budget:${userId}:${dateStr}`;
}

/**
 * Get the current daily token usage for a user.
 * Returns zero counts if no entry exists (new day or first request).
 */
export async function getTokenUsage(kv: KVNamespace, userId: string): Promise<TokenBudget> {
  const key = buildBudgetKey(userId);
  const existing = await kv.get<TokenBudget>(key, 'json');
  return existing ?? { inputTokens: 0, outputTokens: 0 };
}

/**
 * Check whether a user is within their daily token budget.
 */
export async function checkTokenBudget(
  kv: KVNamespace,
  userId: string,
  env: Env,
): Promise<{ allowed: boolean; usage: TokenBudget; inputLimit: number; outputLimit: number }> {
  const inputLimit = parseInt(env.AI_PROXY_DAILY_INPUT_TOKEN_LIMIT || '', 10)
    || DEFAULT_AI_PROXY_DAILY_INPUT_TOKEN_LIMIT;
  const outputLimit = parseInt(env.AI_PROXY_DAILY_OUTPUT_TOKEN_LIMIT || '', 10)
    || DEFAULT_AI_PROXY_DAILY_OUTPUT_TOKEN_LIMIT;

  const usage = await getTokenUsage(kv, userId);
  const allowed = usage.inputTokens <= inputLimit && usage.outputTokens <= outputLimit;

  return { allowed, usage, inputLimit, outputLimit };
}

/**
 * Increment the daily token usage for a user after a successful inference.
 */
export async function incrementTokenUsage(
  kv: KVNamespace,
  userId: string,
  inputTokens: number,
  outputTokens: number,
): Promise<TokenBudget> {
  const key = buildBudgetKey(userId);
  const existing = await getTokenUsage(kv, userId);

  const updated: TokenBudget = {
    inputTokens: existing.inputTokens + inputTokens,
    outputTokens: existing.outputTokens + outputTokens,
  };

  await kv.put(key, JSON.stringify(updated), {
    expirationTtl: BUDGET_TTL_SECONDS,
  });

  log.info('ai_proxy.token_usage_updated', {
    userId,
    inputTokensAdded: inputTokens,
    outputTokensAdded: outputTokens,
    totalInput: updated.inputTokens,
    totalOutput: updated.outputTokens,
  });

  return updated;
}
