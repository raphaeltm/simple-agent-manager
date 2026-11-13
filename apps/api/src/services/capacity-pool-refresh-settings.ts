import type { Env } from '../env';
import { resolveAdminSetting } from './admin-settings';
import {
  DEFAULT_CAPACITY_POOL_REFRESH_DEADLINE_MS,
  DEFAULT_CAPACITY_POOL_REFRESH_LEASE_MS,
  DEFAULT_CAPACITY_POOL_REFRESH_PASS_BUDGET_MS,
  DEFAULT_CAPACITY_POOL_REFRESH_RETRY_BASE_MS,
  DEFAULT_CAPACITY_POOL_REFRESH_RETRY_MAX_MS,
} from './capacity-pool-refresh-defaults';

export interface CapacityPoolRefreshSettings {
  passBudgetMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  deadlineMs: number;
  leaseMs: number;
}

export async function capacityPoolRefreshSettings(env?: Env): Promise<CapacityPoolRefreshSettings> {
  const setting = async (key: Parameters<typeof resolveAdminSetting>[1], fallback: number) => {
    if (!env) return fallback;
    try {
      const value = await resolveAdminSetting(env, key);
      return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? value
        : fallback;
    } catch {
      return fallback;
    }
  };
  const [passBudgetMs, retryBaseMs, retryMaxMs, deadlineMs, leaseMs] = await Promise.all([
    setting(
      'operations.capacityPoolRefreshPassBudgetMs',
      DEFAULT_CAPACITY_POOL_REFRESH_PASS_BUDGET_MS
    ),
    setting(
      'operations.capacityPoolRefreshRetryBaseMs',
      DEFAULT_CAPACITY_POOL_REFRESH_RETRY_BASE_MS
    ),
    setting('operations.capacityPoolRefreshRetryMaxMs', DEFAULT_CAPACITY_POOL_REFRESH_RETRY_MAX_MS),
    setting('operations.capacityPoolRefreshDeadlineMs', DEFAULT_CAPACITY_POOL_REFRESH_DEADLINE_MS),
    setting('operations.capacityPoolRefreshLeaseMs', DEFAULT_CAPACITY_POOL_REFRESH_LEASE_MS),
  ]);
  return {
    passBudgetMs,
    retryBaseMs,
    retryMaxMs: Math.max(retryBaseMs, retryMaxMs),
    deadlineMs,
    leaseMs: Math.max(leaseMs, passBudgetMs),
  };
}
