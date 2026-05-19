/**
 * Per-user daily token budget tracking.
 *
 * Runtime accounting uses the `AI_TOKEN_BUDGET_COUNTER` Durable Object when
 * available. KV remains as a compatibility fallback for un-migrated local/test
 * environments, but it is no longer the primary counter because KV read-modify-
 * write updates are not atomic under concurrent requests.
 */

import type { UserAiBudgetSettings } from '@simple-agent-manager/shared';
import {
  AI_BUDGET_SETTINGS_KV_PREFIX,
  AI_MONTHLY_COST_CACHE_KV_PREFIX,
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
import { expectJsonRecord } from '../lib/runtime-validation';

export interface TokenBudget {
  inputTokens: number;
  outputTokens: number;
}

interface AiTokenBudgetCounterStub extends DurableObjectStub {
  get(dateKey: string): Promise<TokenBudget>;
  increment(dateKey: string, inputTokens: number, outputTokens: number): Promise<TokenBudget>;
}

function buildBudgetDateKey(date?: Date): string {
  const d = date ?? new Date();
  return d.toISOString().slice(0, 10);
}

/**
 * Build the KV key for a user's daily budget.
 * Format: `ai-budget:{userId}:{YYYY-MM-DD}`
 */
export function buildBudgetKey(userId: string, date?: Date): string {
  return `ai-budget:${userId}:${buildBudgetDateKey(date)}`;
}

function getBudgetCounter(env: Env | undefined, userId: string) {
  if (!env?.AI_TOKEN_BUDGET_COUNTER) return null;
  return env.AI_TOKEN_BUDGET_COUNTER.get(
    env.AI_TOKEN_BUDGET_COUNTER.idFromName(userId),
  ) as AiTokenBudgetCounterStub;
}

/**
 * Get the current daily token usage for a user.
 * Returns zero counts if no entry exists (new day or first request).
 */
export async function getTokenUsage(
  kv: KVNamespace,
  userId: string,
  env?: Env,
): Promise<TokenBudget> {
  const counter = getBudgetCounter(env, userId);
  if (counter) {
    return counter.get(buildBudgetDateKey());
  }

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
  body: unknown,
  env: Env,
): UserAiBudgetSettings {
  const request = expectJsonRecord(body, 'usage.ai.budget');
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

  if (request.dailyInputTokenLimit !== undefined) {
    if (request.dailyInputTokenLimit !== null) {
      if (typeof request.dailyInputTokenLimit !== 'number' || request.dailyInputTokenLimit < minDailyTokens || request.dailyInputTokenLimit > maxDailyTokens) {
        throw new Error(`dailyInputTokenLimit must be between ${minDailyTokens} and ${maxDailyTokens}`);
      }
      settings.dailyInputTokenLimit = Math.floor(request.dailyInputTokenLimit);
    }
  }

  if (request.dailyOutputTokenLimit !== undefined) {
    if (request.dailyOutputTokenLimit !== null) {
      if (typeof request.dailyOutputTokenLimit !== 'number' || request.dailyOutputTokenLimit < minDailyTokens || request.dailyOutputTokenLimit > maxDailyTokens) {
        throw new Error(`dailyOutputTokenLimit must be between ${minDailyTokens} and ${maxDailyTokens}`);
      }
      settings.dailyOutputTokenLimit = Math.floor(request.dailyOutputTokenLimit);
    }
  }

  if (request.monthlyCostCapUsd !== undefined) {
    if (request.monthlyCostCapUsd !== null) {
      if (typeof request.monthlyCostCapUsd !== 'number' || request.monthlyCostCapUsd < minMonthlyCap || request.monthlyCostCapUsd > maxMonthlyCap) {
        throw new Error(`monthlyCostCapUsd must be between ${minMonthlyCap} and ${maxMonthlyCap}`);
      }
      settings.monthlyCostCapUsd = Math.round(request.monthlyCostCapUsd * 100) / 100;
    }
  }

  if (request.alertThresholdPercent !== undefined) {
    if (typeof request.alertThresholdPercent !== 'number' || request.alertThresholdPercent < 1 || request.alertThresholdPercent > 100) {
      throw new Error('alertThresholdPercent must be between 1 and 100');
    }
    settings.alertThresholdPercent = Math.floor(request.alertThresholdPercent);
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

  const usage = await getTokenUsage(kv, userId, env);
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
  const counter = getBudgetCounter(env, userId);
  if (counter) {
    const updated = await counter.increment(
      buildBudgetDateKey(),
      inputTokens,
      outputTokens,
    );

    log.info('ai_proxy.token_usage_updated', {
      userId,
      inputTokensAdded: inputTokens,
      outputTokensAdded: outputTokens,
      totalInput: updated.inputTokens,
      totalOutput: updated.outputTokens,
      counter: 'durable_object',
    });

    return updated;
  }

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
    counter: 'kv_compatibility_fallback',
  });

  return updated;
}

// =============================================================================
// Monthly Cost Cap Enforcement (KV-cached, written by cron)
// =============================================================================

/** Build the KV key for a user's cached monthly AI cost. */
export function buildMonthlyCostCacheKey(userId: string): string {
  const now = new Date();
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return `${AI_MONTHLY_COST_CACHE_KV_PREFIX}:${userId}:${monthKey}`;
}

/** Read a user's cached monthly AI cost from KV. Returns null if not cached yet. */
export async function getCachedMonthlyCost(
  kv: KVNamespace,
  userId: string,
): Promise<number | null> {
  const key = buildMonthlyCostCacheKey(userId);
  const raw = await kv.get(key);
  if (raw === null) return null;
  const parsed = parseFloat(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Check whether a user is within their monthly cost cap.
 *
 * Reads from KV cache (written by hourly cron). If no cache exists,
 * the check passes (fail-open) — the cron will populate it next run.
 *
 * Returns { allowed, costUsd, capUsd } where capUsd is null if no cap is set.
 */
export async function checkMonthlyCostCap(
  kv: KVNamespace,
  userId: string,
): Promise<{ allowed: boolean; costUsd: number; capUsd: number | null }> {
  const userSettings = await getUserBudgetSettings(kv, userId);
  const capUsd = userSettings?.monthlyCostCapUsd ?? null;

  // No cap set — always allowed
  if (capUsd === null || capUsd <= 0) {
    return { allowed: true, costUsd: 0, capUsd };
  }

  const costUsd = await getCachedMonthlyCost(kv, userId);

  // No cache yet — fail-open (cron hasn't run yet for this user)
  if (costUsd === null) {
    return { allowed: true, costUsd: 0, capUsd };
  }

  return { allowed: costUsd < capUsd, costUsd, capUsd };
}

export type AiUsageGateResult =
  | { allowed: true }
  | {
    allowed: false;
    reason: 'daily-token-budget';
    budget: Awaited<ReturnType<typeof checkTokenBudget>>;
  }
  | {
    allowed: false;
    reason: 'monthly-cost-cap';
    monthlyCap: Awaited<ReturnType<typeof checkMonthlyCostCap>>;
  };

/** Check all pre-request AI usage limits shared by proxy routes. */
export async function checkAiUsageGate(
  kv: KVNamespace,
  userId: string,
  env: Env,
): Promise<AiUsageGateResult> {
  const budget = await checkTokenBudget(kv, userId, env);
  if (!budget.allowed) {
    return { allowed: false, reason: 'daily-token-budget', budget };
  }

  const monthlyCap = await checkMonthlyCostCap(kv, userId);
  if (!monthlyCap.allowed) {
    return { allowed: false, reason: 'monthly-cost-cap', monthlyCap };
  }

  return { allowed: true };
}
