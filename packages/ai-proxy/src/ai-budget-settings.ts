/**
 * AI budget limits and per-user budget settings (KV-stored), split out of ai-token-budget.ts
 * (rule 18). ai-token-budget.ts re-exports everything here, so callers keep their imports.
 */
import type { AdminAiAllowance, UserAiBudgetSettings } from '@simple-agent-manager/shared';
import {
  AI_ADMIN_ALLOWANCE_KV_PREFIX,
  AI_BUDGET_SETTINGS_KV_PREFIX,
  DEFAULT_AI_USAGE_ALERT_THRESHOLD_PERCENT,
  DEFAULT_AI_USAGE_MAX_DAILY_TOKEN_LIMIT,
  DEFAULT_AI_USAGE_MAX_MONTHLY_COST_CAP_USD,
  DEFAULT_AI_USAGE_MIN_DAILY_TOKEN_LIMIT,
  DEFAULT_AI_USAGE_MIN_MONTHLY_COST_CAP_USD,
} from '@simple-agent-manager/shared';
import { expectJsonRecord, log, parseJsonRecord } from '@simple-agent-manager/worker-core';

import { isMonthlyCostCapAvailable } from './ai-gateway-availability';
import type { AiProxyEnv } from './env';

export interface AiBudgetLimits {
  maxDailyTokens: number;
  minDailyTokens: number;
  maxMonthlyCostCapUsd: number;
  minMonthlyCostCapUsd: number;
}

export function getAiBudgetLimits(env: AiProxyEnv): AiBudgetLimits {
  return {
    maxDailyTokens:
      Number.parseInt(env.AI_USAGE_MAX_DAILY_TOKEN_LIMIT || '', 10) ||
      DEFAULT_AI_USAGE_MAX_DAILY_TOKEN_LIMIT,
    minDailyTokens:
      Number.parseInt(env.AI_USAGE_MIN_DAILY_TOKEN_LIMIT || '', 10) ||
      DEFAULT_AI_USAGE_MIN_DAILY_TOKEN_LIMIT,
    maxMonthlyCostCapUsd:
      Number(env.AI_USAGE_MAX_MONTHLY_COST_CAP_USD) || DEFAULT_AI_USAGE_MAX_MONTHLY_COST_CAP_USD,
    minMonthlyCostCapUsd:
      Number(env.AI_USAGE_MIN_MONTHLY_COST_CAP_USD) || DEFAULT_AI_USAGE_MIN_MONTHLY_COST_CAP_USD,
  };
}

// =============================================================================
// User Budget Settings (KV-stored)
// =============================================================================

/** Build the KV key for a user's budget settings. */
export function buildBudgetSettingsKey(userId: string): string {
  return `${AI_BUDGET_SETTINGS_KV_PREFIX}:${userId}`;
}

function nullableFiniteNumber(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Parse a stored settings row. A row that is not JSON, or whose fields have the wrong types, is
 * treated as absent (platform defaults) and logged, never thrown: every AI call reads this row, so
 * one malformed value must not fail them (rules 41 and 50). The installation ceiling still applies
 * to such a user, because it does not come from this row.
 */
export function parseStoredBudgetSettings(
  raw: string,
  userId: string
): UserAiBudgetSettings | null {
  try {
    const record = parseJsonRecord(raw, 'ai-budget-settings');
    const dailyInputTokenLimit = nullableFiniteNumber(record.dailyInputTokenLimit);
    const dailyOutputTokenLimit = nullableFiniteNumber(record.dailyOutputTokenLimit);
    const monthlyCostCapUsd = nullableFiniteNumber(record.monthlyCostCapUsd);
    const alertThresholdPercent = nullableFiniteNumber(record.alertThresholdPercent);
    const bad = Object.entries({
      dailyInputTokenLimit,
      dailyOutputTokenLimit,
      monthlyCostCapUsd,
    }).find(([, value]) => value === undefined);
    if (bad) throw new Error(`invalid ${bad[0]}`);
    return {
      dailyInputTokenLimit: dailyInputTokenLimit ?? null,
      dailyOutputTokenLimit: dailyOutputTokenLimit ?? null,
      monthlyCostCapUsd: monthlyCostCapUsd ?? null,
      alertThresholdPercent: alertThresholdPercent ?? DEFAULT_AI_USAGE_ALERT_THRESHOLD_PERCENT,
    };
  } catch (err) {
    log.warn('ai_proxy.budget_settings_row_skipped', {
      userId,
      error: err instanceof Error ? err.message : String(err),
      action: 'using_platform_defaults',
    });
    return null;
  }
}

/** Get a user's custom budget settings, or null if none set (or the stored row is malformed). */
export async function getUserBudgetSettings(
  kv: KVNamespace,
  userId: string
): Promise<UserAiBudgetSettings | null> {
  const raw = await kv.get(buildBudgetSettingsKey(userId));
  return raw === null ? null : parseStoredBudgetSettings(raw, userId);
}

/** Save a user's budget settings. */
export async function saveUserBudgetSettings(
  kv: KVNamespace,
  userId: string,
  settings: UserAiBudgetSettings
): Promise<void> {
  const key = buildBudgetSettingsKey(userId);
  await kv.put(key, JSON.stringify(settings));
}

/** Delete a user's custom budget settings (revert to platform defaults). */
export async function deleteUserBudgetSettings(kv: KVNamespace, userId: string): Promise<void> {
  const key = buildBudgetSettingsKey(userId);
  await kv.delete(key);
}

/** Get a user's admin-managed AI allowance ceiling from KV. */
export async function getAdminAiAllowance(
  kv: KVNamespace,
  userId: string
): Promise<AdminAiAllowance | null> {
  return kv.get<AdminAiAllowance>(`${AI_ADMIN_ALLOWANCE_KV_PREFIX}:${userId}`, 'json');
}

/** Why a monthly cap cannot be set: this installation has a gateway it cannot price. */
export const MONTHLY_COST_CAP_UNAVAILABLE_MESSAGE =
  'Monthly cost caps are not available on this installation: they are priced from Cloudflare AI Gateway logs (AI_GATEWAY_ID, CF_ACCOUNT_ID and CF_API_TOKEN). Daily token limits still apply.';

/**
 * Validate and normalize budget update request. Returns validated settings or throws.
 *
 * When `adminAllowance` is provided, the user's limits are capped at the
 * admin-set ceiling instead of the platform maximum. `monthlyCostCeilingUsd` is the
 * installation-wide ceiling where it applies (`resolveMonthlyCostCeilingUsd`): a cap above it is
 * refused. Clearing the cap is allowed; the ceiling still applies (`effectiveMonthlyCostCapUsd`).
 */
export function validateBudgetUpdate(
  body: unknown,
  env: AiProxyEnv,
  adminAllowance: AdminAiAllowance | null,
  monthlyCostCeilingUsd: number | null
): UserAiBudgetSettings {
  const request = expectJsonRecord(body, 'usage.ai.budget');
  const {
    maxDailyTokens: platformMaxDailyTokens,
    minDailyTokens,
    maxMonthlyCostCapUsd: platformMaxMonthlyCap,
    minMonthlyCostCapUsd: minMonthlyCap,
  } = getAiBudgetLimits(env);

  // Admin ceilings take precedence over platform maximums when set
  const maxDailyInputTokens = adminAllowance?.maxDailyInputTokens ?? platformMaxDailyTokens;
  const maxDailyOutputTokens = adminAllowance?.maxDailyOutputTokens ?? platformMaxDailyTokens;
  const maxMonthlyCap = Math.min(
    adminAllowance?.maxMonthlyCostCapUsd ?? platformMaxMonthlyCap,
    monthlyCostCeilingUsd ?? Number.POSITIVE_INFINITY
  );

  const settings: UserAiBudgetSettings = {
    dailyInputTokenLimit: null,
    dailyOutputTokenLimit: null,
    monthlyCostCapUsd: null,
    alertThresholdPercent: DEFAULT_AI_USAGE_ALERT_THRESHOLD_PERCENT,
  };

  if (request.dailyInputTokenLimit !== undefined) {
    if (request.dailyInputTokenLimit !== null) {
      if (
        typeof request.dailyInputTokenLimit !== 'number' ||
        request.dailyInputTokenLimit < minDailyTokens ||
        request.dailyInputTokenLimit > maxDailyInputTokens
      ) {
        throw new Error(
          `dailyInputTokenLimit must be between ${minDailyTokens} and ${maxDailyInputTokens}`
        );
      }
      settings.dailyInputTokenLimit = Math.floor(request.dailyInputTokenLimit);
    }
  }

  if (request.dailyOutputTokenLimit !== undefined) {
    if (request.dailyOutputTokenLimit !== null) {
      if (
        typeof request.dailyOutputTokenLimit !== 'number' ||
        request.dailyOutputTokenLimit < minDailyTokens ||
        request.dailyOutputTokenLimit > maxDailyOutputTokens
      ) {
        throw new Error(
          `dailyOutputTokenLimit must be between ${minDailyTokens} and ${maxDailyOutputTokens}`
        );
      }
      settings.dailyOutputTokenLimit = Math.floor(request.dailyOutputTokenLimit);
    }
  }

  if (request.monthlyCostCapUsd !== undefined) {
    if (request.monthlyCostCapUsd !== null) {
      if (!isMonthlyCostCapAvailable(env)) throw new Error(MONTHLY_COST_CAP_UNAVAILABLE_MESSAGE);
      if (
        typeof request.monthlyCostCapUsd !== 'number' ||
        request.monthlyCostCapUsd < minMonthlyCap ||
        request.monthlyCostCapUsd > maxMonthlyCap
      ) {
        throw new Error(`monthlyCostCapUsd must be between ${minMonthlyCap} and ${maxMonthlyCap}`);
      }
      settings.monthlyCostCapUsd = Math.round(request.monthlyCostCapUsd * 100) / 100;
    }
  }

  if (request.alertThresholdPercent !== undefined) {
    if (
      typeof request.alertThresholdPercent !== 'number' ||
      request.alertThresholdPercent < 1 ||
      request.alertThresholdPercent > 100
    ) {
      throw new Error('alertThresholdPercent must be between 1 and 100');
    }
    settings.alertThresholdPercent = Math.floor(request.alertThresholdPercent);
  }

  return settings;
}
