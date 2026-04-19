/**
 * TrialOrchestrator DO — default timing, retry, and knowledge-probe limits.
 *
 * Every value is exposed via an optional env var override (see
 * `apps/api/src/env.ts`) so operators can tune them per deployment without
 * a code change (Constitution Principle XI).
 */

// ----- Orchestrator state machine -----

/** Hard cap on total trial provisioning time before emitting `trial.error`. */
export const DEFAULT_TRIAL_ORCHESTRATOR_OVERALL_TIMEOUT_MS = 300_000; // 5 min

/** Max retries per individual step before marking the orchestrator failed. */
export const DEFAULT_TRIAL_ORCHESTRATOR_STEP_MAX_RETRIES = 5;

/** Base delay for exponential-backoff retries (doubled per retry). */
export const DEFAULT_TRIAL_ORCHESTRATOR_RETRY_BASE_DELAY_MS = 1_000;

/** Cap on exponential-backoff retry delay. */
export const DEFAULT_TRIAL_ORCHESTRATOR_RETRY_MAX_DELAY_MS = 60_000;

/** Max time to wait for workspace to transition from creating→running. */
export const DEFAULT_TRIAL_ORCHESTRATOR_WORKSPACE_READY_TIMEOUT_MS = 180_000;

/** Poll interval while waiting for workspace ready. */
export const DEFAULT_TRIAL_ORCHESTRATOR_WORKSPACE_READY_POLL_INTERVAL_MS = 5_000;

/** Max time to wait for the discovery agent to emit its first assistant turn. */
export const DEFAULT_TRIAL_ORCHESTRATOR_AGENT_READY_TIMEOUT_MS = 60_000;

/** Max time to wait for a freshly provisioned node to come online. */
export const DEFAULT_TRIAL_ORCHESTRATOR_NODE_READY_TIMEOUT_MS = 180_000;

// ----- GitHub knowledge probes (fast-path, fired from create.ts) -----

/** Per-request timeout for unauthenticated GitHub API probes during trial start. */
export const DEFAULT_TRIAL_KNOWLEDGE_GITHUB_TIMEOUT_MS = 5_000;

/** Upper bound on `trial.knowledge` events emitted by the GitHub probe path. */
export const DEFAULT_TRIAL_KNOWLEDGE_MAX_EVENTS = 10;
