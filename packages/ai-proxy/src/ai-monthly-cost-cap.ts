/**
 * Monthly AI cost cap enforcement, split out of ai-token-budget.ts (rule 18).
 * ai-token-budget.ts re-exports everything here, so callers keep their imports.
 */
import {
  AI_MONTHLY_COST_CACHE_KV_PREFIX,
  type UserAiBudgetSettings,
} from '@simple-agent-manager/shared';
import { errors, log } from '@simple-agent-manager/worker-core';

import { getUserBudgetSettings } from './ai-budget-settings';
import {
  estimateWindowRetained,
  estimateWindowStartMs,
  type GatewayMonthlyCost,
  gatewayMonthlySpendUsd,
  parseGatewayMonthlyCost,
  resolveCostEstimateLagSeconds,
  utcMonthKey,
} from './ai-cost-estimate';
import { hasLocalAiCostMetering, isMonthlyCostCapAvailable } from './ai-gateway-availability';
import { resolveMonthlyCostCacheTtlSeconds } from './ai-monthly-cost-cron';
// Cycle with ai-token-budget.ts (it re-exports this module); both sides use the other's functions
// only inside function bodies, so evaluation order does not matter.
import { getProviderUsage, type TokenBudget } from './ai-token-budget';
import { buildBudgetDateKey, getBudgetCounter } from './ai-token-budget-counter-client';
import type { AiProxyEnv } from './env';
import type { AiProxyPorts } from './ports';

/**
 * The part of the ports the cap reads: the installation-wide ceiling, and on gateway installs the
 * estimate lag margin (absent means the default, `DEFAULT_COST_ESTIMATE_GATEWAY_LAG_SECONDS`).
 */
export type MonthlyCostCeilingPort = Pick<AiProxyPorts, 'monthlyCostCeilingUsd'> &
  Partial<Pick<AiProxyPorts, 'costEstimateGatewayLagSeconds'>>;

// =============================================================================
// Monthly Cost Cap Enforcement (KV-cached, written by cron)
// =============================================================================

/** Build the KV key for a user's cached monthly AI cost. */
export function buildMonthlyCostCacheKey(userId: string): string {
  const now = new Date();
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return `${AI_MONTHLY_COST_CACHE_KV_PREFIX}:${userId}:${monthKey}`;
}

/**
 * Read the gateway month total the hourly cron wrote, with when it was read. Null when there is
 * none yet, or the value is unreadable.
 */
export async function getCachedGatewayMonthlyCost(
  kv: KVNamespace,
  userId: string
): Promise<GatewayMonthlyCost | null> {
  return parseGatewayMonthlyCost(await kv.get(buildMonthlyCostCacheKey(userId)));
}

/** A user's cached gateway month total in USD (either KV format), or null when not cached yet. */
export async function getCachedMonthlyCost(
  kv: KVNamespace,
  userId: string
): Promise<number | null> {
  return (await getCachedGatewayMonthlyCost(kv, userId))?.costUsd ?? null;
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
 * The installation-wide per-user ceiling, or null when none is set. It applies on every install:
 * without a gateway it bounds SAM's own priced total, with one the gateway total plus the recent
 * estimate (`checkGatewayCostAdmission`). It bounds platform-funded calls only.
 *
 * An unreadable ceiling is unknown, not disabled. Refuse platform-funded calls until the
 * settings snapshot can be read again.
 */
export async function resolveMonthlyCostCeilingUsd(
  env: AiProxyEnv,
  ports: MonthlyCostCeilingPort
): Promise<number | null> {
  // Where no monthly cap can be enforced (a gateway without the account API), the ceiling has no
  // effect, so a settings outage must not fail the budget page or a daily-limit update there.
  if (!isMonthlyCostCapAvailable(env)) return null;
  try {
    const ceiling = await ports.monthlyCostCeilingUsd();
    return Number.isFinite(ceiling) && ceiling > 0 ? ceiling : null;
  } catch {
    log.error('ai_proxy.monthly_cost_ceiling_unreadable');
    throw errors.serviceUnavailable('AI spending limits are unavailable. Please try again later.');
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

export interface MonthlyCostCapOptions {
  /** False only for a resolved passthrough credential the user owns; the ceiling then does not apply. */
  platformBilled?: boolean;
}

/**
 * Gateway installs: this month's priced spend on calls that bypassed the gateway (passthrough),
 * which no gateway log contains. Display only (`GET /api/usage/ai/budget` adds it to the live
 * gateway-log total, as the gate does); an unreadable counter shows 0 rather than failing the page.
 */
export async function getGatewayDirectMonthlySpendUsd(
  env: AiProxyEnv,
  userId: string
): Promise<number> {
  const counter = getBudgetCounter(env, userId);
  if (!counter || hasLocalAiCostMetering(env)) return 0;
  const now = new Date();
  try {
    const snapshot = await counter.getGatewayAdmissionSnapshot(
      buildBudgetDateKey(now),
      utcMonthKey(now),
      null
    );
    return snapshot.directMonthUsd;
  } catch (err) {
    log.warn('usage.direct_spend_unreadable', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * Check whether a user is within their monthly cost cap.
 *
 * The cap is `effectiveMonthlyCostCapUsd(user cap, installation ceiling)` on every install; the
 * ceiling is left out only for a user-funded passthrough call (`platformBilled === false`).
 *
 * With AI Gateway: see `checkGatewayCostAdmission`.
 *
 * Without AI Gateway: compared with SAM's own priced total for the month
 * (`getLocalMonthlyAiCostUsd`), which every platform-billed proxy call and SAM agent call adds to
 * after its response. A failed read refuses the call (fail closed): there is no cron to correct
 * it later.
 *
 * Spend is known only after a response, so this pre-call check is the last point before money is
 * spent. There is no reservation: every call admitted while spend is still below the cap runs to
 * completion, so N calls in flight when the cap is crossed can together overshoot it by up to the
 * sum of their costs (bounded by the user's concurrency and the proxy rate limit).
 */
export async function checkMonthlyCostCap(
  kv: KVNamespace,
  userId: string,
  env: AiProxyEnv,
  ports: MonthlyCostCeilingPort,
  options?: MonthlyCostCapOptions
): Promise<MonthlyCostCapCheck> {
  if (!hasLocalAiCostMetering(env)) {
    return (await checkGatewayCostAdmission(kv, userId, env, ports, options)).monthlyCap;
  }

  const userSettings = await getUserBudgetSettings(kv, userId);
  const userCapUsd = userSettings?.monthlyCostCapUsd ?? null;
  const ceilingUsd = await resolveMonthlyCostCeilingUsd(env, ports);
  const capUsd = effectiveMonthlyCostCapUsd(userCapUsd, ceilingUsd);
  const source =
    ceilingUsd !== null && capUsd === ceilingUsd ? { limitSource: 'administrator' as const } : {};
  if (capUsd === null) return { allowed: true, costUsd: 0, capUsd };
  let costUsd: number;
  try {
    costUsd = await getLocalMonthlyAiCostUsd(kv, userId, env);
  } catch {
    log.error('ai_proxy.monthly_spend_unreadable');
    throw errors.serviceUnavailable('AI spending limits are unavailable. Please try again later.');
  }
  return { allowed: costUsd < capUsd, costUsd, capUsd, ...source };
}

export interface GatewayCostAdmission {
  /** The day's tokens, read in the same counter RPC; null when the counter was not read. */
  usage: TokenBudget | null;
  /** The user's budget settings row as read for the cap, reused for the daily budget. */
  userSettings: UserAiBudgetSettings | null;
  monthlyCap: MonthlyCostCapCheck;
}

/**
 * The monthly cap on an AI Gateway install, plus the day's token usage from the same counter read
 * so the gate makes one Durable Object round-trip, as before.
 *
 * Spend = the gateway total the hourly cron wrote, plus SAM's catalog-priced estimate for calls
 * since it (minus the lag margin), or the month estimate when the cron has not written a total
 * yet, plus SAM's priced total for calls that bypassed the gateway (passthrough), which no
 * gateway total includes (`gatewayMonthlySpendUsd`, ai-cost-estimate.ts). The gateway is the
 * authority for what it routes: the estimate only covers what its total cannot have seen.
 *
 * Failure behaviour:
 * - Unreadable gateway total (KV error or malformed value): treated as missing, so the month
 *   estimate applies. Logged.
 * - Unreadable lag setting: the default margin.
 * - Counter read failure: refuses with a retryable 503, logged, as the daily-budget read on this
 *   path always refused. The blast radius is the one user whose counter object is unreachable,
 *   for as long as it is.
 * - No counter binding (KV-only local runtimes): the gateway total alone, allowed when absent.
 * - A gateway without the account API cannot be priced: not enforceable, no reads.
 */
export async function checkGatewayCostAdmission(
  kv: KVNamespace,
  userId: string,
  env: AiProxyEnv,
  ports: MonthlyCostCeilingPort,
  options?: MonthlyCostCapOptions
): Promise<GatewayCostAdmission> {
  // A gateway without the account API cannot price spend: no cap applies, so the ceiling is not
  // read (a settings outage must not refuse calls the ceiling could not bound anyway).
  const capAvailable = isMonthlyCostCapAvailable(env);
  const [userSettings, ceilingUsd] = await Promise.all([
    getUserBudgetSettings(kv, userId),
    options?.platformBilled === false || !capAvailable
      ? null
      : resolveMonthlyCostCeilingUsd(env, ports),
  ]);
  const userCapUsd = userSettings?.monthlyCostCapUsd ?? null;
  const capUsd = effectiveMonthlyCostCapUsd(userCapUsd, ceilingUsd);
  const source =
    ceilingUsd !== null && capUsd === ceilingUsd ? { limitSource: 'administrator' as const } : {};
  if (capUsd === null || !capAvailable) {
    return { usage: null, userSettings, monthlyCap: { allowed: true, costUsd: 0, capUsd } };
  }

  const [gateway, lagSeconds] = await Promise.all([
    getCachedGatewayMonthlyCost(kv, userId).catch((err: unknown) => {
      log.error('ai_proxy.gateway_monthly_cost_unreadable', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }),
    readCostEstimateLagSeconds(ports),
  ]);

  const counter = getBudgetCounter(env, userId);
  if (!counter) {
    const costUsd = gateway?.costUsd ?? 0;
    return {
      usage: null,
      userSettings,
      monthlyCap: { allowed: gateway === null || costUsd < capUsd, costUsd, capUsd, ...source },
    };
  }

  const now = new Date();
  const windowStartMs = estimateWindowStartMs(
    gateway,
    lagSeconds,
    now,
    resolveMonthlyCostCacheTtlSeconds(env.AI_MONTHLY_COST_CACHE_TTL_SECONDS)
  );
  let snapshot;
  try {
    snapshot = await counter.getGatewayAdmissionSnapshot(
      buildBudgetDateKey(now),
      utcMonthKey(now),
      // A window older than the retained buckets is answered from month figures; skip the scan.
      estimateWindowRetained(windowStartMs, now) ? windowStartMs : null
    );
  } catch (err) {
    log.error('ai_proxy.monthly_spend_unreadable', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw errors.serviceUnavailable('AI spending limits are unavailable. Please try again later.');
  }
  const costUsd = gatewayMonthlySpendUsd(gateway, snapshot, windowStartMs, now);
  return {
    usage: snapshot.budget,
    userSettings,
    monthlyCap: { allowed: costUsd < capUsd, costUsd, capUsd, ...source },
  };
}

async function readCostEstimateLagSeconds(ports: MonthlyCostCeilingPort): Promise<number> {
  if (!ports.costEstimateGatewayLagSeconds) return resolveCostEstimateLagSeconds(undefined);
  try {
    return resolveCostEstimateLagSeconds(await ports.costEstimateGatewayLagSeconds());
  } catch {
    log.warn('ai_proxy.cost_estimate_lag_unreadable');
    return resolveCostEstimateLagSeconds(undefined);
  }
}
