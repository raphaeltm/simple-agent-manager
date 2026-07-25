// =============================================================================
// Cloudflare Container Runtime Defaults
// =============================================================================

/** Default sleep-after duration for CF containers. Override via CF_CONTAINER_SLEEP_AFTER env var. */
export const DEFAULT_CF_CONTAINER_SLEEP_AFTER = '1h';

/** Maximum active-work keepalive duration (ms) before defensive expiry. Override via CF_CONTAINER_ACTIVE_WORK_MAX_MS env var. */
export const DEFAULT_CF_CONTAINER_ACTIVE_WORK_MAX_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Active-work renewActivityTimeout interval (ms). Override via CF_CONTAINER_KEEPALIVE_RENEW_INTERVAL_MS env var. */
export const DEFAULT_CF_CONTAINER_KEEPALIVE_RENEW_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
