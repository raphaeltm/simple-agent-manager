/**
 * Monthly AI cost cap enforcement, split out of ai-token-budget.ts (rule 18).
 * ai-token-budget.ts re-exports everything here, so callers keep their imports.
 */
import { AI_MONTHLY_COST_CACHE_KV_PREFIX } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { getUserBudgetSettings } from './ai-budget-settings';
// Cycle with ai-token-budget.ts (it re-exports this module); both sides use the other's functions
// only inside function bodies, so evaluation order does not matter.
import { getProviderUsage } from './ai-token-budget';
import { hasLocalAiCostMetering, isMonthlyCostCapAvailable } from './platform-capabilities';

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
  userId: string
): Promise<number | null> {
  const key = buildMonthlyCostCacheKey(userId);
  const raw = await kv.get(key);
  if (raw === null) return null;
  const parsed = parseFloat(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

export interface MonthlyCostCapCheck {
  allowed: boolean;
  costUsd: number;
  capUsd: number | null;
  /** True only when a cap is set and this installation can enforce it. */
  enforced: boolean;
}

/** First instant of the current UTC month. */
function currentUtcMonthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * This UTC month's AI spend that SAM priced itself (`hasLocalAiCostMetering`): the sum of the
 * per-day `estimated_cost_usd` rows in the user's `AiTokenBudgetCounter` (KV fallback without the
 * Durable Object). Only meaningful on an installation without AI Gateway.
 */
export async function getLocalMonthlyAiCostUsd(
  kv: KVNamespace,
  userId: string,
  env: Env
): Promise<number> {
  const entries = await getProviderUsage(kv, userId, currentUtcMonthStart(), env);
  return entries.reduce((sum, entry) => sum + (entry.estimatedCostUsd || 0), 0);
}

/**
 * Check whether a user is within their monthly cost cap.
 *
 * With AI Gateway: reads the KV cache written by the hourly gateway-log cron. With no cache yet
 * the check passes (fail-open); the cron fills it within the hour, and the daily token budget
 * still applies.
 *
 * Without AI Gateway: reads SAM's own priced total for the month (`getLocalMonthlyAiCostUsd`),
 * which every platform-billed proxy call and SAM agent call adds to after its response. A failed
 * read refuses the call (fail closed): there is no cron to correct it later.
 *
 * A gateway without the account API cannot be priced: `enforced: false`, no KV read.
 */
export async function checkMonthlyCostCap(
  kv: KVNamespace,
  userId: string,
  env: Env
): Promise<MonthlyCostCapCheck> {
  const userSettings = await getUserBudgetSettings(kv, userId);
  const capUsd = userSettings?.monthlyCostCapUsd ?? null;

  // No cap set — always allowed
  if (capUsd === null || capUsd <= 0) {
    return { allowed: true, costUsd: 0, capUsd, enforced: false };
  }

  if (!isMonthlyCostCapAvailable(env)) {
    return { allowed: true, costUsd: 0, capUsd, enforced: false };
  }

  if (hasLocalAiCostMetering(env)) {
    let costUsd: number;
    try {
      costUsd = await getLocalMonthlyAiCostUsd(kv, userId, env);
    } catch {
      return { allowed: false, costUsd: 0, capUsd, enforced: true };
    }
    return { allowed: costUsd < capUsd, costUsd, capUsd, enforced: true };
  }

  const costUsd = await getCachedMonthlyCost(kv, userId);

  // No cache yet — fail-open until the hourly cron populates usage data.
  // Window is at most 60 minutes after SAM mode activation or cap change.
  // Acceptable risk: daily token budget (checked separately) still applies.
  if (costUsd === null) {
    return { allowed: true, costUsd: 0, capUsd, enforced: true };
  }

  return { allowed: costUsd < capUsd, costUsd, capUsd, enforced: true };
}
