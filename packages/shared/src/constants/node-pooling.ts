// =============================================================================
// Warm Node Pooling
// =============================================================================

/** Default warm timeout (ms) before an idle node is destroyed. Override via NODE_WARM_TIMEOUT_MS env var. */
export const DEFAULT_NODE_WARM_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/** Default maximum lifetime (ms) for an auto-provisioned node. Override via MAX_AUTO_NODE_LIFETIME_MS env var. */
export const DEFAULT_MAX_AUTO_NODE_LIFETIME_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Default grace period (ms) for cron sweep stale detection. Override via NODE_WARM_GRACE_PERIOD_MS env var. */
export const DEFAULT_NODE_WARM_GRACE_PERIOD_MS = 35 * 60 * 1000; // 35 minutes (warm timeout + 5 min buffer)

/** Default grace period (ms) before stopping orphaned task workspaces. Override via ORPHANED_WORKSPACE_GRACE_PERIOD_MS env var. */
export const DEFAULT_ORPHANED_WORKSPACE_GRACE_PERIOD_MS = 10 * 60 * 1000; // 10 minutes

/** Default alarm retry delay (ms) when node destruction fails. */
export const DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS = 60 * 1000; // 1 minute

// =============================================================================
// Workspace Idle Timeout (Compute Lifecycle Management)
// =============================================================================

/** Default workspace idle timeout (ms). Workspaces with no messages AND no terminal activity
 * for this duration are auto-deleted. Override per-project via project settings or via
 * WORKSPACE_IDLE_TIMEOUT_MS env var. */
export const DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Minimum workspace idle timeout (ms). */
export const MIN_WORKSPACE_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/** Maximum workspace idle timeout (ms). */
export const MAX_WORKSPACE_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Minimum node idle timeout (ms). */
export const MIN_NODE_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Maximum node idle timeout (ms). */
export const MAX_NODE_IDLE_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Interval (ms) at which the ProjectData DO checks workspace idle state. */
export const WORKSPACE_IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Minimum interval (ms) between terminal activity updates to the DO to avoid write amplification.
 * Intended for frontend heartbeat interval — not yet enforced server-side. */
export const TERMINAL_ACTIVITY_THROTTLE_MS = 60 * 1000; // 1 minute
