/**
 * Monthly AI cost cap enforcement, split out of ai-token-budget.ts (rule 18).
 * ai-token-budget.ts re-exports everything here, so callers keep their imports.
 */
import { AI_MONTHLY_COST_CACHE_KV_PREFIX } from '@simple-agent-manager/shared';

import { getUserBudgetSettings } from './ai-budget-settings';

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
  userId: string
): Promise<{ allowed: boolean; costUsd: number; capUsd: number | null }> {
  const userSettings = await getUserBudgetSettings(kv, userId);
  const capUsd = userSettings?.monthlyCostCapUsd ?? null;

  // No cap set — always allowed
  if (capUsd === null || capUsd <= 0) {
    return { allowed: true, costUsd: 0, capUsd };
  }

  const costUsd = await getCachedMonthlyCost(kv, userId);

  // No cache yet — fail-open until the hourly cron populates usage data.
  // Window is at most 60 minutes after SAM mode activation or cap change.
  // Acceptable risk: daily token budget (checked separately) still applies.
  if (costUsd === null) {
    return { allowed: true, costUsd: 0, capUsd };
  }

  return { allowed: costUsd < capUsd, costUsd, capUsd };
}
