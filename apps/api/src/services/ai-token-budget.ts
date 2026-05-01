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

import type { UpdateAiBudgetRequest, UserAiBudgetSettings } from '@simple-agent-manager/shared';
import {
  AI_BUDGET_SETTINGS_KV_PREFIX,
  DEFAULT_AI_PROXY_DAILY_INPUT_TOKEN_LIMIT,
  DEFAULT_AI_PROXY_DAILY_OUTPUT_TOKEN_LIMIT,
  DEFAULT_AI_USAGE_ALERT_THRESHOLD_PERCENT,
  DEFAULT_AI_USAGE_BUDGET_TTL_SECONDS,
  DEFAULT_AI_USAGE_MAX_DAILY_TOKEN_LIMIT,
  DEFAULT_AI_USAGE_MAX_MONTHLY_COST_CAP_USD,
  DEFAULT_AI_USAGE_MIN_DAILY_TOKEN_LIMIT,
  DEFAULT_AI_USAGE_MIN_MONTHLY_COST_CAP_USD,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';

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

// =============================================================================
// User Budget Settings (KV-stored)
// =============================================================================

/** Build the KV key for a user's budget settings. */
export function buildBudgetSettingsKey(userId: string): string {
  return `${AI_BUDGET_SETTINGS_KV_PREFIX}:${userId}`;
}

/** Get a user's custom budget settings, or null if none set. */
export async function getUserBudgetSettings(
  kv: KVNamespace,
  userId: string,
): Promise<UserAiBudgetSettings | null> {
  const key = buildBudgetSettingsKey(userId);
  return kv.get<UserAiBudgetSettings>(key, 'json');
}

/** Save a user's budget settings. */
export async function saveUserBudgetSettings(
  kv: KVNamespace,
  userId: string,
  settings: UserAiBudgetSettings,
): Promise<void> {
  const key = buildBudgetSettingsKey(userId);
  await kv.put(key, JSON.stringify(settings));
}

/** Delete a user's custom budget settings (revert to platform defaults). */
export async function deleteUserBudgetSettings(
  kv: KVNamespace,
  userId: string,
): Promise<void> {
  const key = buildBudgetSettingsKey(userId);
  await kv.delete(key);
}

/** Validate and normalize budget update request. Returns validated settings or throws. */
export function validateBudgetUpdate(
  body: UpdateAiBudgetRequest,
  env: Env,
): UserAiBudgetSettings {
  const maxDailyTokens = parseInt(env.AI_USAGE_MAX_DAILY_TOKEN_LIMIT || '', 10)
    || DEFAULT_AI_USAGE_MAX_DAILY_TOKEN_LIMIT;
  const minDailyTokens = parseInt(env.AI_USAGE_MIN_DAILY_TOKEN_LIMIT || '', 10)
    || DEFAULT_AI_USAGE_MIN_DAILY_TOKEN_LIMIT;
  const maxMonthlyCap = parseFloat(env.AI_USAGE_MAX_MONTHLY_COST_CAP_USD || '')
    || DEFAULT_AI_USAGE_MAX_MONTHLY_COST_CAP_USD;
  const minMonthlyCap = parseFloat(env.AI_USAGE_MIN_MONTHLY_COST_CAP_USD || '')
    || DEFAULT_AI_USAGE_MIN_MONTHLY_COST_CAP_USD;

  const settings: UserAiBudgetSettings = {
    dailyInputTokenLimit: null,
    dailyOutputTokenLimit: null,
    monthlyCostCapUsd: null,
    alertThresholdPercent: DEFAULT_AI_USAGE_ALERT_THRESHOLD_PERCENT,
  };

  if (body.dailyInputTokenLimit !== undefined) {
    if (body.dailyInputTokenLimit !== null) {
      if (typeof body.dailyInputTokenLimit !== 'number' || body.dailyInputTokenLimit < minDailyTokens || body.dailyInputTokenLimit > maxDailyTokens) {
        throw new Error(`dailyInputTokenLimit must be between ${minDailyTokens} and ${maxDailyTokens}`);
      }
      settings.dailyInputTokenLimit = Math.floor(body.dailyInputTokenLimit);
    }
  }

  if (body.dailyOutputTokenLimit !== undefined) {
    if (body.dailyOutputTokenLimit !== null) {
      if (typeof body.dailyOutputTokenLimit !== 'number' || body.dailyOutputTokenLimit < minDailyTokens || body.dailyOutputTokenLimit > maxDailyTokens) {
        throw new Error(`dailyOutputTokenLimit must be between ${minDailyTokens} and ${maxDailyTokens}`);
      }
      settings.dailyOutputTokenLimit = Math.floor(body.dailyOutputTokenLimit);
    }
  }

  if (body.monthlyCostCapUsd !== undefined) {
    if (body.monthlyCostCapUsd !== null) {
      if (typeof body.monthlyCostCapUsd !== 'number' || body.monthlyCostCapUsd < minMonthlyCap || body.monthlyCostCapUsd > maxMonthlyCap) {
        throw new Error(`monthlyCostCapUsd must be between ${minMonthlyCap} and ${maxMonthlyCap}`);
      }
      settings.monthlyCostCapUsd = Math.round(body.monthlyCostCapUsd * 100) / 100;
    }
  }

  if (body.alertThresholdPercent !== undefined) {
    if (typeof body.alertThresholdPercent !== 'number' || body.alertThresholdPercent < 1 || body.alertThresholdPercent > 100) {
      throw new Error('alertThresholdPercent must be between 1 and 100');
    }
    settings.alertThresholdPercent = Math.floor(body.alertThresholdPercent);
  }

  return settings;
}

/**
 * Resolve effective daily token limits: user-set → platform env → shared constant.
 */
export function resolveEffectiveLimits(
  userSettings: UserAiBudgetSettings | null,
  env: Env,
): { dailyInputTokenLimit: number; dailyOutputTokenLimit: number } {
  const platformInputLimit = parseInt(env.AI_PROXY_DAILY_INPUT_TOKEN_LIMIT || '', 10)
    || DEFAULT_AI_PROXY_DAILY_INPUT_TOKEN_LIMIT;
  const platformOutputLimit = parseInt(env.AI_PROXY_DAILY_OUTPUT_TOKEN_LIMIT || '', 10)
    || DEFAULT_AI_PROXY_DAILY_OUTPUT_TOKEN_LIMIT;

  return {
    dailyInputTokenLimit: userSettings?.dailyInputTokenLimit ?? platformInputLimit,
    dailyOutputTokenLimit: userSettings?.dailyOutputTokenLimit ?? platformOutputLimit,
  };
}

/**
 * Check whether a user is within their daily token budget.
 * Respects user-configurable limits if set, falling back to platform defaults.
 */
export async function checkTokenBudget(
  kv: KVNamespace,
  userId: string,
  env: Env,
): Promise<{ allowed: boolean; usage: TokenBudget; inputLimit: number; outputLimit: number }> {
  // Load user budget settings (may be null)
  const userSettings = await getUserBudgetSettings(kv, userId);
  const { dailyInputTokenLimit: inputLimit, dailyOutputTokenLimit: outputLimit } =
    resolveEffectiveLimits(userSettings, env);

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
  env?: Env,
): Promise<TokenBudget> {
  const key = buildBudgetKey(userId);
  const existing = await getTokenUsage(kv, userId);

  const updated: TokenBudget = {
    inputTokens: existing.inputTokens + inputTokens,
    outputTokens: existing.outputTokens + outputTokens,
  };

  const ttl = parseInt(env?.AI_USAGE_BUDGET_TTL_SECONDS || '', 10)
    || DEFAULT_AI_USAGE_BUDGET_TTL_SECONDS;

  await kv.put(key, JSON.stringify(updated), {
    expirationTtl: ttl,
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
