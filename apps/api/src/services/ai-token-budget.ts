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
  DEFAULT_AI_PROXY_DAILY_INPUT_TOKEN_LIMIT,
  DEFAULT_AI_PROXY_DAILY_OUTPUT_TOKEN_LIMIT,
  DEFAULT_AI_USAGE_BUDGET_TTL_SECONDS,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { getUserBudgetSettings } from './ai-budget-settings';
import { checkMonthlyCostCap } from './ai-monthly-cost-cap';

export {
  type AiBudgetLimits,
  buildBudgetSettingsKey,
  deleteUserBudgetSettings,
  getAdminAiAllowance,
  getAiBudgetLimits,
  getUserBudgetSettings,
  saveUserBudgetSettings,
  validateBudgetUpdate,
} from './ai-budget-settings';
export {
  buildMonthlyCostCacheKey,
  checkMonthlyCostCap,
  getCachedMonthlyCost,
} from './ai-monthly-cost-cap';

export interface TokenBudget {
  inputTokens: number;
  outputTokens: number;
}

export interface AiProviderUsageAttribution {
  providerId: string;
  providerName: string;
  dialect: string;
}

export interface AiProviderUsageEntry extends AiProviderUsageAttribution {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

interface AiTokenBudgetCounterStub extends DurableObjectStub {
  get(dateKey: string): Promise<TokenBudget>;
  consumeTotal(
    dateKey: string,
    tokenLimit: number,
    tokens: number
  ): Promise<{ allowed: boolean; usedTokens: number }>;
  releaseTotal(dateKey: string, tokens: number): Promise<number>;
  increment(dateKey: string, inputTokens: number, outputTokens: number): Promise<TokenBudget>;
  incrementProviderUsage(
    dateKey: string,
    attribution: AiProviderUsageAttribution,
    inputTokens: number,
    outputTokens: number,
    estimatedCostUsd: number
  ): Promise<void>;
  getProviderUsage(startDateKey: string): Promise<AiProviderUsageEntry[]>;
}

export interface PlatformDailyTokenLimits {
  dailyInputTokenLimit: number;
  dailyOutputTokenLimit: number;
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
    env.AI_TOKEN_BUDGET_COUNTER.idFromName(userId)
  ) as AiTokenBudgetCounterStub;
}

function parsePositiveIntegerEnv(
  value: string | undefined,
  name: string,
  defaultValue: number
): number {
  if (value === undefined) {
    return defaultValue;
  }

  const normalized = value.trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`${name} must be a positive integer when configured`);
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe positive integer when configured`);
  }

  return parsed;
}

export function resolvePlatformDailyTokenLimits(env: Env): PlatformDailyTokenLimits {
  return {
    dailyInputTokenLimit: parsePositiveIntegerEnv(
      env.AI_PROXY_DAILY_INPUT_TOKEN_LIMIT,
      'AI_PROXY_DAILY_INPUT_TOKEN_LIMIT',
      DEFAULT_AI_PROXY_DAILY_INPUT_TOKEN_LIMIT
    ),
    dailyOutputTokenLimit: parsePositiveIntegerEnv(
      env.AI_PROXY_DAILY_OUTPUT_TOKEN_LIMIT,
      'AI_PROXY_DAILY_OUTPUT_TOKEN_LIMIT',
      DEFAULT_AI_PROXY_DAILY_OUTPUT_TOKEN_LIMIT
    ),
  };
}

/**
 * Get the current daily token usage for a user.
 * Returns zero counts if no entry exists (new day or first request).
 */
export async function getTokenUsage(
  kv: KVNamespace,
  userId: string,
  env?: Env
): Promise<TokenBudget> {
  const counter = getBudgetCounter(env, userId);
  if (counter) {
    return counter.get(buildBudgetDateKey());
  }

  const key = buildBudgetKey(userId);
  const existing = await kv.get<TokenBudget>(key, 'json');
  return existing ?? { inputTokens: 0, outputTokens: 0 };
}

export interface FeatureTokenBudgetResult {
  allowed: boolean;
  usedTokens: number;
  tokenLimit: number;
}

/** Build an isolated per-deployment feature budget key. */
export function buildFeatureBudgetKey(feature: string, date?: Date): string {
  return `ai-feature-budget:${feature}:${buildBudgetDateKey(date)}`;
}

/** Atomically consume a feature-scoped daily token allowance when the DO is available. */
export async function consumeFeatureTokenBudget(
  kv: KVNamespace,
  feature: string,
  tokens: number,
  tokenLimit: number,
  env?: Env
): Promise<FeatureTokenBudgetResult> {
  const normalizedTokens = Math.max(0, Math.floor(tokens));
  const counter = getBudgetCounter(env, `feature:${feature}`);
  if (counter) {
    const result = await counter.consumeTotal(buildBudgetDateKey(), tokenLimit, normalizedTokens);
    return { ...result, tokenLimit };
  }

  const key = buildFeatureBudgetKey(feature);
  const existing = Number(await kv.get(key)) || 0;
  if (existing + normalizedTokens > tokenLimit) {
    return { allowed: false, usedTokens: existing, tokenLimit };
  }
  const usedTokens = existing + normalizedTokens;
  const ttl =
    parseInt(env?.AI_USAGE_BUDGET_TTL_SECONDS || '', 10) || DEFAULT_AI_USAGE_BUDGET_TTL_SECONDS;
  await kv.put(key, String(usedTokens), { expirationTtl: ttl });
  return { allowed: true, usedTokens, tokenLimit };
}

/** Release an unused feature budget reservation. */
export async function releaseFeatureTokenBudget(
  kv: KVNamespace,
  feature: string,
  tokens: number,
  tokenLimit: number,
  env?: Env
): Promise<FeatureTokenBudgetResult> {
  const normalizedTokens = Math.max(0, Math.floor(tokens));
  const counter = getBudgetCounter(env, `feature:${feature}`);
  if (counter) {
    const usedTokens = await counter.releaseTotal(buildBudgetDateKey(), normalizedTokens);
    return { allowed: usedTokens < tokenLimit, usedTokens, tokenLimit };
  }

  const key = buildFeatureBudgetKey(feature);
  const existing = Number(await kv.get(key)) || 0;
  const usedTokens = Math.max(0, existing - normalizedTokens);
  const ttl =
    parseInt(env?.AI_USAGE_BUDGET_TTL_SECONDS || '', 10) || DEFAULT_AI_USAGE_BUDGET_TTL_SECONDS;
  await kv.put(key, String(usedTokens), { expirationTtl: ttl });
  return { allowed: usedTokens < tokenLimit, usedTokens, tokenLimit };
}

export async function getFeatureTokenBudget(
  kv: KVNamespace,
  feature: string,
  tokenLimit: number,
  env?: Env
): Promise<FeatureTokenBudgetResult> {
  const counter = getBudgetCounter(env, `feature:${feature}`);
  const usedTokens = counter
    ? (await counter.get(buildBudgetDateKey())).inputTokens
    : Number(await kv.get(buildFeatureBudgetKey(feature))) || 0;
  return { allowed: usedTokens < tokenLimit, usedTokens, tokenLimit };
}

/**
 * Resolve effective daily token limits: user-set → platform env → shared constant.
 */
export function resolveEffectiveLimits(
  userSettings: UserAiBudgetSettings | null,
  env: Env
): { dailyInputTokenLimit: number; dailyOutputTokenLimit: number } {
  const { dailyInputTokenLimit: platformInputLimit, dailyOutputTokenLimit: platformOutputLimit } =
    resolvePlatformDailyTokenLimits(env);

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
  env: Env
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
  env?: Env
): Promise<TokenBudget> {
  const counter = getBudgetCounter(env, userId);
  if (counter) {
    const updated = await counter.increment(buildBudgetDateKey(), inputTokens, outputTokens);

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

  const ttl =
    parseInt(env?.AI_USAGE_BUDGET_TTL_SECONDS || '', 10) || DEFAULT_AI_USAGE_BUDGET_TTL_SECONDS;

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

/** Build the KV key for a user's provider-scoped AI usage on one UTC day. */
export function buildProviderUsageKey(userId: string, date?: Date): string {
  return `ai-provider-usage:${userId}:${buildBudgetDateKey(date)}`;
}

export async function incrementProviderUsage(
  kv: KVNamespace,
  userId: string,
  attribution: AiProviderUsageAttribution,
  inputTokens: number,
  outputTokens: number,
  env?: Env,
  estimatedCostUsd = 0
): Promise<void> {
  const counter = getBudgetCounter(env, userId);
  if (counter) {
    await counter.incrementProviderUsage(
      buildBudgetDateKey(),
      attribution,
      inputTokens,
      outputTokens,
      estimatedCostUsd
    );
    return;
  }

  const key = buildProviderUsageKey(userId);
  const existing = (await kv.get<Record<string, AiProviderUsageEntry>>(key, 'json')) ?? {};
  const usageKey = providerUsageKey(attribution.providerId, attribution.dialect);
  const current = existing[usageKey] ?? {
    ...attribution,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  };

  existing[usageKey] = {
    ...current,
    providerName: attribution.providerName,
    requests: current.requests + 1,
    inputTokens: current.inputTokens + inputTokens,
    outputTokens: current.outputTokens + outputTokens,
    estimatedCostUsd: current.estimatedCostUsd + estimatedCostUsd,
  };

  const ttl =
    parseInt(env?.AI_USAGE_BUDGET_TTL_SECONDS || '', 10) || DEFAULT_AI_USAGE_BUDGET_TTL_SECONDS;
  await kv.put(key, JSON.stringify(existing), { expirationTtl: ttl });
}

export async function getProviderUsage(
  kv: KVNamespace,
  userId: string,
  startDate: Date,
  env?: Env,
  endDate = new Date()
): Promise<AiProviderUsageEntry[]> {
  const counter = getBudgetCounter(env, userId);
  const startDateKey = buildBudgetDateKey(startDate);
  if (counter) {
    return counter.getProviderUsage(startDateKey);
  }

  const combined = new Map<string, AiProviderUsageEntry>();
  for (const date of eachUtcDate(startDate, endDate)) {
    const entries = await kv.get<Record<string, AiProviderUsageEntry>>(
      buildProviderUsageKey(userId, date),
      'json'
    );
    if (!entries) continue;
    for (const entry of Object.values(entries)) {
      mergeProviderUsageEntry(combined, entry);
    }
  }
  return Array.from(combined.values());
}

function providerUsageKey(providerId: string, dialect: string): string {
  return `${providerId}:${dialect}`;
}

function mergeProviderUsageEntry(
  map: Map<string, AiProviderUsageEntry>,
  entry: AiProviderUsageEntry
): void {
  const key = providerUsageKey(entry.providerId, entry.dialect);
  const existing = map.get(key);
  if (existing) {
    existing.requests += entry.requests;
    existing.inputTokens += entry.inputTokens;
    existing.outputTokens += entry.outputTokens;
    existing.estimatedCostUsd += entry.estimatedCostUsd;
  } else {
    map.set(key, { ...entry });
  }
}

function* eachUtcDate(startDate: Date, endDate: Date): Generator<Date> {
  const current = new Date(
    Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate())
  );
  const end = new Date(
    Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate())
  );

  while (current <= end) {
    yield new Date(current);
    current.setUTCDate(current.getUTCDate() + 1);
  }
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
  env: Env
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
