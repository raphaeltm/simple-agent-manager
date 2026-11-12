export const DEFAULT_CAPACITY_POOL_REFRESH_PASS_BUDGET_MS = 20_000;
export const DEFAULT_CAPACITY_POOL_REFRESH_RETRY_BASE_MS = 15_000;
export const DEFAULT_CAPACITY_POOL_REFRESH_RETRY_MAX_MS = 60_000;
export const DEFAULT_CAPACITY_POOL_REFRESH_DEADLINE_MS = 2 * 60 * 60_000;
export const DEFAULT_CAPACITY_POOL_REFRESH_LEASE_MS = 180_000;

/** Dedicated lightweight catalog continuation tick; the operational sweep remains every five minutes. */
export const CAPACITY_POOL_CONTINUATION_CRON = '* * * * *';
