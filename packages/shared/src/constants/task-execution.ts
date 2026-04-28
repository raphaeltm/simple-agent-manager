// =============================================================================
// Task Run Defaults (Autonomous Execution)
// =============================================================================

/** Default max workspaces per node. Hard ceiling regardless of CPU/memory metrics.
 * Override via MAX_WORKSPACES_PER_NODE env var. */
export const DEFAULT_MAX_WORKSPACES_PER_NODE = 3;

/** Default CPU usage threshold (%) above which a node is considered full. Override via TASK_RUN_NODE_CPU_THRESHOLD_PERCENT env var. */
export const DEFAULT_TASK_RUN_NODE_CPU_THRESHOLD_PERCENT = 50;

/** Default memory usage threshold (%) above which a node is considered full. Override via TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT env var. */
export const DEFAULT_TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT = 50;

/** Default delay (ms) after task completion before cleanup. Override via TASK_RUN_CLEANUP_DELAY_MS env var. */
export const DEFAULT_TASK_RUN_CLEANUP_DELAY_MS = 5000;

// =============================================================================
// Task Execution Timeout (Stuck Task Recovery)
// =============================================================================

/** Soft timeout (ms): tasks past this threshold are checked against the VM agent heartbeat.
 * If the heartbeat is recent, recovery is deferred up to the hard timeout (TASK_RUN_HARD_TIMEOUT_MS).
 * Override via TASK_RUN_MAX_EXECUTION_MS env var. */
export const DEFAULT_TASK_RUN_MAX_EXECUTION_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Absolute hard timeout (ms) — tasks are killed regardless of node heartbeat status.
 * The soft timeout (TASK_RUN_MAX_EXECUTION_MS) allows heartbeat-based grace for the
 * window between soft and hard timeout. Past the hard timeout, no grace is given.
 * Override via TASK_RUN_HARD_TIMEOUT_MS env var. */
export const DEFAULT_TASK_RUN_HARD_TIMEOUT_MS = 8 * 60 * 60 * 1000; // 8 hours

/** Default threshold (ms) for a task stuck in 'queued' status. Override via TASK_STUCK_QUEUED_TIMEOUT_MS env var.
 * Must be > TASK_RUNNER_AGENT_READY_TIMEOUT_MS (15 min) to avoid the stuck-task cron killing tasks
 * that are legitimately waiting for cloud-init to finish. Cloud-init takes 8-12 min on Hetzner.
 * Set to 20 minutes (5 min buffer above agent ready timeout). */
export const DEFAULT_TASK_STUCK_QUEUED_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

/** Default threshold (ms) for a task stuck in 'delegated' status. Override via TASK_STUCK_DELEGATED_TIMEOUT_MS env var.
 * Must be > TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS (30 min) to avoid stuck-task recovery killing legitimate workspace startups.
 * Set to 31 minutes (1 min buffer above workspace ready timeout). */
export const DEFAULT_TASK_STUCK_DELEGATED_TIMEOUT_MS = 31 * 60 * 1000; // 31 minutes

// =============================================================================
// TaskRunner DO Defaults (Alarm-Driven Orchestration — TDF-2)
// =============================================================================

/** Default max retries per step before failing the task. Override via TASK_RUNNER_STEP_MAX_RETRIES env var. */
export const DEFAULT_TASK_RUNNER_STEP_MAX_RETRIES = 3;

/** Default base delay (ms) for retry backoff. Override via TASK_RUNNER_RETRY_BASE_DELAY_MS env var. */
export const DEFAULT_TASK_RUNNER_RETRY_BASE_DELAY_MS = 5_000;

/** Default max delay (ms) for retry backoff. Override via TASK_RUNNER_RETRY_MAX_DELAY_MS env var. */
export const DEFAULT_TASK_RUNNER_RETRY_MAX_DELAY_MS = 60_000;

/** Default health check poll interval (ms) for agent readiness. Override via TASK_RUNNER_AGENT_POLL_INTERVAL_MS env var. */
export const DEFAULT_TASK_RUNNER_AGENT_POLL_INTERVAL_MS = 5_000;

/**
 * Default timeout (ms) for VM agent to become healthy after node provisioning.
 * Fresh VMs need cloud-init to complete: install packages, start Docker, set up
 * firewall, install Node.js + devcontainer CLI, restart Docker, pre-pull base
 * image, download + start vm-agent. This typically takes 8-12 minutes on Hetzner.
 * Override via TASK_RUNNER_AGENT_READY_TIMEOUT_MS env var.
 */
export const DEFAULT_TASK_RUNNER_AGENT_READY_TIMEOUT_MS = 900_000; // 15 minutes

/** Default timeout (ms) for workspace-ready callback. Override via TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS env var. */
export const DEFAULT_TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Default poll interval (ms) for checking workspace status in D1 during the
 * workspace_ready step. The primary advancement mechanism is the VM agent
 * callback, but periodic polling catches cases where the callback succeeds
 * (updating D1) but the DO notification fails, or where the VM agent retries
 * the callback via heartbeat after initial failures. Override via
 * TASK_RUNNER_WORKSPACE_READY_POLL_INTERVAL_MS env var.
 */
export const DEFAULT_TASK_RUNNER_WORKSPACE_READY_POLL_INTERVAL_MS = 30_000; // 30 seconds

/** Default poll interval (ms) for provisioning status checks. Override via TASK_RUNNER_PROVISION_POLL_INTERVAL_MS env var. */
export const DEFAULT_TASK_RUNNER_PROVISION_POLL_INTERVAL_MS = 10_000;
