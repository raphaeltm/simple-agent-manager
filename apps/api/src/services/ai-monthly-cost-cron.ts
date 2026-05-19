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

import type { Env } from '../env';
import { log } from '../lib/logger';
import {
  getGatewayPeriodBounds,
  iterateGatewayLogs,
} from './ai-gateway-logs';

const DEFAULT_MONTHLY_COST_AGGREGATION_MAX_PAGES = 200;
const MONTHLY_COST_AGGREGATION_MAX_PAGES_HARD_CAP = 500;

export interface MonthlyCostCronResult {
  enabled: boolean;
  usersUpdated: number;
  totalEntries: number;
  errors: number;
}

/**
 * Aggregate current-month AI Gateway costs per user and write to KV.
 *
 * KV key: `ai-monthly-cost:{userId}:{YYYY-MM}` → cost as string
 * TTL: 2 hours (cron runs hourly, so stale data expires if cron stops).
 */
export async function runMonthlyCostAggregation(env: Env): Promise<MonthlyCostCronResult> {
  const gatewayId = env.AI_GATEWAY_ID;
  if (!gatewayId) {
    return { enabled: false, usersUpdated: 0, totalEntries: 0, errors: 0 };
  }

  const now = new Date();
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const { startDate } = getGatewayPeriodBounds('current-month');
  const ttl = parseInt(env.AI_MONTHLY_COST_CACHE_TTL_SECONDS || '', 10)
    || DEFAULT_AI_MONTHLY_COST_CACHE_TTL_SECONDS;

  // Aggregate cost per userId from Gateway logs
  const costByUser = new Map<string, number>();
  let totalEntries = 0;

  try {
    await iterateGatewayLogs(
      env,
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
      },
    );
  } catch (err) {
    log.error('cron.monthly_cost.gateway_error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { enabled: true, usersUpdated: 0, totalEntries, errors: 1 };
  }

  // Write each user's cost to KV
  let usersUpdated = 0;
  let errors = 0;

  for (const [userId, cost] of costByUser.entries()) {
    const key = `${AI_MONTHLY_COST_CACHE_KV_PREFIX}:${userId}:${monthKey}`;
    try {
      await env.KV.put(key, cost.toFixed(6), { expirationTtl: ttl });
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
