/**
 * Monthly AI cost cap enforcement, split out of ai-token-budget.ts (rule 18).
 * ai-token-budget.ts re-exports everything here, so callers keep their imports.
 */
import { AI_MONTHLY_COST_CACHE_KV_PREFIX } from '@simple-agent-manager/shared';
import { log } from '@simple-agent-manager/worker-core';

import { getUserBudgetSettings } from './ai-budget-settings';
import { hasLocalAiCostMetering, isMonthlyCostCapAvailable } from './ai-gateway-availability';
// Cycle with ai-token-budget.ts (it re-exports this module); both sides use the other's functions
// only inside function bodies, so evaluation order does not matter.
import { getProviderUsage } from './ai-token-budget';
import type { AiProxyEnv } from './env';
import type { AiProxyPorts } from './ports';

/** The part of the ports the cap reads: the installation-wide ceiling. */
export type MonthlyCostCeilingPort = Pick<AiProxyPorts, 'monthlyCostCeilingUsd'>;

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
  /** Present when the administrator ceiling is the binding limit (including ties). */
  limitSource?: 'administrator';
}

/** Recovery advice for the limit that actually denied admission. */
export function monthlyCostCapMessage(cap?: MonthlyCostCapCheck): string {
  return cap?.limitSource === 'administrator'
    ? 'Administrator monthly AI spending limit reached. Contact your administrator or wait until next month.'
    : 'Monthly cost cap exceeded. Adjust your cap in Settings > Usage.';
}

/**
 * The one monthly-cap predicate: the lower of the user's own cap and the installation ceiling,
 * or null when neither is a positive number. A user clearing their cap therefore leaves the
 * ceiling in force, and a cap above the ceiling is enforced at the ceiling.
 */
export function effectiveMonthlyCostCapUsd(
  userCapUsd: number | null | undefined,
  ceilingUsd: number | null
): number | null {
  const caps = [userCapUsd, ceilingUsd].filter(
    (cap): cap is number => typeof cap === 'number' && Number.isFinite(cap) && cap > 0
  );
  return caps.length > 0 ? Math.min(...caps) : null;
}

/**
 * The installation-wide ceiling where it applies, or null. It applies only where SAM meters spend
 * itself (no addressable AI Gateway): there it is the operator's only bound on what approved users
 * can spend of the platform key. With a gateway the spend record is the gateway's, and this is not
 * read at all, so the gateway path's I/O is unchanged.
 *
 * Never throws: the admin-settings resolver already falls back to the default (0, no ceiling) when
 * D1 is unreadable, and an unexpected failure here is logged and treated the same way, so a
 * settings fault cannot fail AI calls (daily token budgets still apply).
 */
export async function resolveMonthlyCostCeilingUsd(
  env: AiProxyEnv,
  ports: MonthlyCostCeilingPort
): Promise<number | null> {
  if (!hasLocalAiCostMetering(env)) return null;
  try {
    const ceiling = await ports.monthlyCostCeilingUsd();
    return Number.isFinite(ceiling) && ceiling > 0 ? ceiling : null;
  } catch (err) {
    log.error('ai_proxy.monthly_cost_ceiling_unreadable', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
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
  env: AiProxyEnv
): Promise<number> {
  // One DO RPC when available. Otherwise at most 31 independent daily KV reads in one
  // wave; the calendar month is the hard bound (no unbounded-history fan-out).
  const now = new Date();
  const entries = env.AI_TOKEN_BUDGET_COUNTER
    ? await getProviderUsage(kv, userId, currentUtcMonthStart(now), env)
    : (
        await Promise.all(
          Array.from({ length: now.getUTCDate() }, (_, day) => {
            const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day + 1));
            return getProviderUsage(kv, userId, date, env, date);
          })
        )
      ).flat();
  return entries.reduce((sum, entry) => sum + (entry.estimatedCostUsd || 0), 0);
}

/**
 * Check whether a user is within their monthly cost cap.
 *
 * With AI Gateway: reads the KV cache written by the hourly gateway-log cron. With no cache yet
 * the check passes (fail-open); the cron fills it within the hour, and the daily token budget
 * still applies. The installation ceiling is not read on this path.
 *
 * Without AI Gateway: the cap is `effectiveMonthlyCostCapUsd(user cap, installation ceiling)`,
 * compared with SAM's own priced total for the month (`getLocalMonthlyAiCostUsd`), which every
 * platform-billed proxy call and SAM agent call adds to after its response. A failed read refuses
 * the call (fail closed): there is no cron to correct it later.
 *
 * Spend is known only after a response, so this pre-call check is the last point before money is
 * spent; concurrent calls admitted together can each overshoot by at most their own cost.
 *
 * A gateway without the account API cannot be priced: not enforceable, no KV read.
 */
export async function checkMonthlyCostCap(
  kv: KVNamespace,
  userId: string,
  env: AiProxyEnv,
  ports: MonthlyCostCeilingPort
): Promise<MonthlyCostCapCheck> {
  const userSettings = await getUserBudgetSettings(kv, userId);
  const userCapUsd = userSettings?.monthlyCostCapUsd ?? null;

  if (hasLocalAiCostMetering(env)) {
    const ceilingUsd = await resolveMonthlyCostCeilingUsd(env, ports);
    const capUsd = effectiveMonthlyCostCapUsd(userCapUsd, ceilingUsd);
    const source =
      ceilingUsd !== null && capUsd === ceilingUsd ? { limitSource: 'administrator' as const } : {};
    if (capUsd === null) return { allowed: true, costUsd: 0, capUsd };
    let costUsd: number;
    try {
      costUsd = await getLocalMonthlyAiCostUsd(kv, userId, env);
    } catch {
      return { allowed: false, costUsd: 0, capUsd, ...source };
    }
    return { allowed: costUsd < capUsd, costUsd, capUsd, ...source };
  }

  const capUsd = effectiveMonthlyCostCapUsd(userCapUsd, null);
  // No cap set — always allowed
  if (capUsd === null) return { allowed: true, costUsd: 0, capUsd: userCapUsd };

  if (!isMonthlyCostCapAvailable(env)) {
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
