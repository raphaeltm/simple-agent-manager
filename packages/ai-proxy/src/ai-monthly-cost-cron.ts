/**
 * Hourly cron job: aggregate per-user monthly AI cost from Gateway logs → KV cache.
 *
 * The proxy reads the cached value at request time via `checkMonthlyCostCap()`.
 * This avoids expensive per-request Gateway iteration while giving ~1h staleness.
 */
import {
  AI_MONTHLY_COST_CACHE_KV_PREFIX,
  DEFAULT_AI_MONTHLY_COST_CACHE_TTL_SECONDS,
} from '@simple-agent-manager/shared';
import { log } from '@simple-agent-manager/worker-core';

import {
  MAX_MONTHLY_COST_CACHE_TTL_SECONDS,
  parseGatewayMonthlyCost,
  serializeGatewayMonthlyCost,
} from './ai-cost-estimate';
import { resolveAiGatewayId } from './ai-gateway-availability';
import {
  type GatewayLogsPorts,
  getGatewayPeriodBounds,
  iterateGatewayLogs,
} from './ai-gateway-logs';
import type { AiProxyEnv } from './env';

const DEFAULT_MONTHLY_COST_AGGREGATION_MAX_PAGES = 200;
const MONTHLY_COST_AGGREGATION_MAX_PAGES_HARD_CAP = 500;
const MIN_MONTHLY_COST_CACHE_TTL_SECONDS = 60;

export { MAX_MONTHLY_COST_CACHE_TTL_SECONDS };

export interface MonthlyCostCronResult {
  enabled: boolean;
  usersUpdated: number;
  totalEntries: number;
  errors: number;
}

export function resolveMonthlyCostCacheTtlSeconds(raw: string | undefined): number {
  const fallback = DEFAULT_AI_MONTHLY_COST_CACHE_TTL_SECONDS;
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_MONTHLY_COST_CACHE_TTL_SECONDS) {
    return fallback;
  }

  return Math.min(Math.floor(parsed), MAX_MONTHLY_COST_CACHE_TTL_SECONDS);
}

/**
 * Aggregate current-month AI Gateway costs per user and write to KV.
 *
 * KV key: `ai-monthly-cost:{userId}:{YYYY-MM}` → `{costUsd, asOfMs}` JSON (`asOfMs` is when the
 * log read started; `parseGatewayMonthlyCost` also reads the older plain-number form).
 * TTL: 2 hours (cron runs hourly, so stale data expires if cron stops).
 */
export async function runMonthlyCostAggregation(
  env: AiProxyEnv,
  ports: GatewayLogsPorts
): Promise<MonthlyCostCronResult> {
  const gatewayId = resolveAiGatewayId(env);
  if (!gatewayId) {
    return { enabled: false, usersUpdated: 0, totalEntries: 0, errors: 0 };
  }

  const now = new Date();
  // The gateway total covers calls up to roughly this instant; the cap adds the local estimate
  // only for calls after it (minus the lag margin), see ai-cost-estimate.ts.
  const asOfMs = now.getTime();
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const { startDate } = getGatewayPeriodBounds('current-month');
  const ttl = resolveMonthlyCostCacheTtlSeconds(env.AI_MONTHLY_COST_CACHE_TTL_SECONDS);

  // Aggregate cost per userId from Gateway logs
  const costByUser = new Map<string, number>();
  let totalEntries = 0;
  let truncated = false;

  try {
    ({ truncated } = await iterateGatewayLogs(
      env,
      ports,
      gatewayId,
      startDate,
      (entry) => {
        totalEntries++;
        const userId = entry.metadata?.userId;
        if (!userId) return;

        const cost = entry.cost || 0;
        costByUser.set(userId, (costByUser.get(userId) || 0) + cost);
      },
      {
        defaultMaxPages: DEFAULT_MONTHLY_COST_AGGREGATION_MAX_PAGES,
        maxPagesHardCap: MONTHLY_COST_AGGREGATION_MAX_PAGES_HARD_CAP,
        maxPagesEnvValue: env.AI_MONTHLY_COST_AGGREGATION_MAX_PAGES,
      }
    ));
  } catch (err) {
    log.error('cron.monthly_cost.gateway_error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { enabled: true, usersUpdated: 0, totalEntries, errors: 1 };
  }

  // A truncated read is missing the month's oldest logs: a user whose spend is all in them is absent
  // from costByUser, and a present user's total covers only the newest window. Keep the previous
  // total as a lower bound so neither falls back to an estimate that starts at this deploy.
  if (truncated) await mergePreviousTotals(env.KV, monthKey, costByUser);

  // Write each user's cost to KV
  let usersUpdated = 0;
  let errors = 0;

  for (const [userId, cost] of costByUser.entries()) {
    const key = `${AI_MONTHLY_COST_CACHE_KV_PREFIX}:${userId}:${monthKey}`;
    try {
      await env.KV.put(key, serializeGatewayMonthlyCost(cost, asOfMs, truncated), {
        expirationTtl: ttl,
      });
      usersUpdated++;
    } catch (err) {
      errors++;
      log.error('cron.monthly_cost.kv_write_error', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('cron.monthly_cost.completed', {
    monthKey,
    usersUpdated,
    totalEntries,
    errors,
  });

  return { enabled: true, usersUpdated, totalEntries, errors };
}

/**
 * After a truncated log read, raise each user's total to at least the previously stored one (both
 * are lower bounds on the month: the earlier read saw older logs, this one newer). Users with a
 * stored total and no entry in this read are carried forward. One KV list walk over this month's
 * totals (one key per user with gateway spend), only on truncated runs. A failure is logged and
 * leaves the scanned totals as they are.
 */
async function mergePreviousTotals(
  kv: KVNamespace,
  monthKey: string,
  costByUser: Map<string, number>
): Promise<void> {
  const prefix = `${AI_MONTHLY_COST_CACHE_KV_PREFIX}:`;
  const suffix = `:${monthKey}`;
  try {
    let cursor: string | undefined;
    do {
      const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
      for (const { name } of page.keys) {
        if (!name.endsWith(suffix)) continue;
        const userId = name.slice(prefix.length, -suffix.length);
        const previous = parseGatewayMonthlyCost(await kv.get(name));
        if (!userId || !previous) continue;
        costByUser.set(userId, Math.max(costByUser.get(userId) ?? 0, previous.costUsd));
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  } catch (err) {
    log.error('cron.monthly_cost.truncated_merge_error', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
