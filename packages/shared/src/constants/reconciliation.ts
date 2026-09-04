/**
 * Task reconciliation constants — configurable via env vars with defaults.
 *
 * When a task-mode agent goes silent (no messages, tool calls, status updates,
 * or mailbox progress), SAM sends a visible check-in prompt. If the agent
 * does not respond within the deadline, the task is failed and cleaned up.
 */

/** How long a task-mode session must be idle before SAM sends a check-in (ms). */
export const DEFAULT_TASK_RECONCILIATION_IDLE_MS = 5 * 60 * 1000; // 5 minutes

/** How long the agent has to respond after the SAM check-in before the task is failed (ms). */
export const DEFAULT_TASK_RECONCILIATION_RESPONSE_DEADLINE_MS = 60 * 1000; // 1 minute

/**
 * How long a task-mode session may remain in an in-flight prompt before SAM
 * records an observation but still avoids interrupting active work.
 */
export const DEFAULT_TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * How long a task-mode session may remain in an in-flight prompt before SAM
 * treats the prompt as hard-stalled and requests cancellation.
 */
export const DEFAULT_TASK_RECONCILIATION_PROMPT_HARD_STALL_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Hard ceiling for active work used to defer an already-sent reconciliation
 * check-in expiry. This keeps an in-flight prompt/tool call from making a
 * check-in marker immortal while still giving long foreground commands a
 * generous window.
 */
export const DEFAULT_TASK_RECONCILIATION_ACTIVE_WORK_HARD_STALL_MS =
  DEFAULT_TASK_RECONCILIATION_PROMPT_HARD_STALL_MS;

/** Minimum delay before the next reconciliation alarm is allowed to fire. */
export const DEFAULT_TASK_RECONCILIATION_MIN_ALARM_DELAY_MS = 10 * 1000; // 10 seconds

/** Maximum number of reconciliation candidates to process in one alarm pass. */
export const DEFAULT_TASK_RECONCILIATION_MAX_CANDIDATES_PER_SWEEP = 5;

/** Short timeout for reconciliation-originated cancel requests that remain on the alarm path. */
export const DEFAULT_TASK_RECONCILIATION_NODE_CALL_TIMEOUT_MS = 5 * 1000; // 5 seconds

/** Durable claim window preventing overlapping alarms from repeating remote reconciliation I/O. */
export const DEFAULT_TASK_RECONCILIATION_CANDIDATE_LEASE_MS = 30 * 1000; // 30 seconds

/** Consecutive inconclusive task reconciliation attempts before quarantine. */
export const DEFAULT_TASK_RECONCILIATION_PROBE_MAX_ATTEMPTS = 3;

/** Cooldown after the inconclusive-attempt budget is exhausted. */
export const DEFAULT_TASK_RECONCILIATION_QUARANTINE_MS = 5 * 60 * 1000; // 5 minutes

// --- Session activity reconciliation (probe-backed staleness bound) ---

/**
 * Timeout for the vm-agent session-activity probe.
 *
 * This probe runs from a background control loop, never an interactive request,
 * so it deliberately uses a short deadline rather than the interactive
 * NODE_AGENT_REQUEST_TIMEOUT_MS (see .claude/rules/47). A healthy agent answers
 * `GET /workspaces/{id}/agent-sessions` in milliseconds; silence past this
 * window is treated as "did not answer", not "still thinking".
 */
export const DEFAULT_SESSION_ACTIVITY_PROBE_TIMEOUT_MS = 5 * 1000; // 5 seconds

/**
 * Consecutive unreachable probes after which a stale working-state session is
 * quarantined outside the hot candidate set. Silence cannot prove a turn ended;
 * a later authoritative activity report resets this counter.
 */
export const DEFAULT_SESSION_ACTIVITY_PROBE_MAX_ATTEMPTS = 3;

/** Maximum stale-activity candidates probed in a single alarm pass. */
export const DEFAULT_SESSION_ACTIVITY_PROBE_MAX_CANDIDATES = 10;

// --- ACP activity callback admission/coalescing (ProjectData load protection) ---

/** Enables Worker-side admission control for high-frequency ACP activity callbacks. */
export const DEFAULT_ACP_ACTIVITY_ADMISSION_ENABLED = true;

/**
 * Minimum interval between redundant intermediate ACP activity writes to
 * ProjectData. New prompt epochs, activity transitions, and terminal/error
 * reports bypass this window.
 */
export const DEFAULT_ACP_ACTIVITY_COALESCE_WINDOW_MS = 2 * 1000; // 2 seconds

/**
 * Maximum lifetime for a coalesced intermediate activity report before it is
 * abandoned to the probe-backed reconciliation path.
 */
export const DEFAULT_ACP_ACTIVITY_COALESCE_TTL_MS = 60 * 1000; // 1 minute

/** Maximum in-memory pending coalesced activity reports per Worker isolate. */
export const DEFAULT_ACP_ACTIVITY_COALESCE_MAX_PENDING = 512;

/**
 * Short-lived per-isolate cache of already-authorized ProjectData ACP session
 * bindings. This avoids re-reading ProjectData for every redundant callback in
 * a storm while D1 resource checks still gate liveness/sleep side effects.
 */
export const DEFAULT_ACP_ACTIVITY_BINDING_CACHE_TTL_MS = 30 * 1000; // 30 seconds

/** Maximum cached ACP activity bindings per Worker isolate. */
export const DEFAULT_ACP_ACTIVITY_BINDING_CACHE_MAX_ENTRIES = 2048;
