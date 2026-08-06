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
// Idle / Orphan Node Reaping (cron sweep)
// =============================================================================

/**
 * Default idle window (ms) after which a running workspace node holding no active
 * workspaces is destroyed. Override via NODE_ORPHAN_IDLE_TIMEOUT_MS env var.
 *
 * Idleness is measured from the node's last WORKSPACE ACTIVITY, never from
 * `nodes.updated_at` — every heartbeat bumps `updated_at`, so it tracks liveness,
 * not idleness, and a predicate built on it can never match a healthy node.
 * Set above DEFAULT_NODE_WARM_TIMEOUT_MS so a node legitimately waiting in the
 * warm pool for reuse is reclaimed by the warm path first.
 */
export const DEFAULT_NODE_ORPHAN_IDLE_TIMEOUT_MS = 45 * 60 * 1000; // 45 minutes

/**
 * Default absolute ceiling (ms) on the age of an auto-provisioned workspace node.
 * Override via NODE_ABSOLUTE_MAX_LIFETIME_MS env var.
 *
 * This is the true backstop. DEFAULT_MAX_AUTO_NODE_LIFETIME_MS only applies to nodes
 * whose workspaces are all inactive, so a node with a workspace row wedged in
 * `running` escapes it forever — two production nodes survived 1932h and 2135h that
 * way. This ceiling additionally requires that no workspace has *reported activity*
 * within DEFAULT_NODE_ORPHAN_IDLE_TIMEOUT_MS, which distinguishes a genuinely busy
 * node from one holding a stuck workspace row.
 */
export const DEFAULT_NODE_ABSOLUTE_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Default maximum node candidates processed per cleanup phase per sweep (rule 47).
 * Bounds worst-case wall time: limit x per-candidate provider/VM-agent cost.
 * Override via NODE_CLEANUP_SWEEP_LIMIT env var.
 */
export const DEFAULT_NODE_CLEANUP_SWEEP_LIMIT = 25;

/**
 * Default maximum workspace candidates processed per cleanup phase per sweep (rule 47).
 * Override via WORKSPACE_CLEANUP_SWEEP_LIMIT env var.
 */
export const DEFAULT_WORKSPACE_CLEANUP_SWEEP_LIMIT = 50;

// =============================================================================
// Provider-Side Orphan Reconciliation
// =============================================================================

/**
 * Default minimum age (ms) a provider server must reach before it can be considered
 * an orphan. Override via PROVIDER_ORPHAN_MIN_AGE_MS env var.
 *
 * `nodes.provider_instance_id` is written only AFTER the provider returns the created
 * server, so there is a window in which a live server has no claiming D1 value. This
 * age floor must comfortably exceed that window.
 */
export const DEFAULT_PROVIDER_ORPHAN_MIN_AGE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Default maximum provider servers destroyed per reconciliation run (rule 47).
 * Override via PROVIDER_ORPHAN_DESTROY_LIMIT env var.
 */
export const DEFAULT_PROVIDER_ORPHAN_DESTROY_LIMIT = 5;

/**
 * Default interval (ms) between provider-side reconciliation runs. The 5-minute cron
 * is far more frequent than this sweep needs, and each run costs a provider list call.
 * Override via PROVIDER_ORPHAN_RECONCILE_INTERVAL_MS env var.
 */
export const DEFAULT_PROVIDER_ORPHAN_RECONCILE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// =============================================================================
// Workspace Stopped Auto-Delete
// =============================================================================

/** Default TTL (ms) before a stopped workspace is automatically deleted. Override via WORKSPACE_STOPPED_TTL_MS env var. */
export const DEFAULT_WORKSPACE_STOPPED_TTL_MS = 5 * 60 * 1000; // 5 minutes

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
