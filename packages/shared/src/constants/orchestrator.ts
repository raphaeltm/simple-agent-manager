/**
 * Project Orchestrator constants (Phase 3: Orchestration).
 *
 * All values are configurable via env vars (Constitution Principle XI).
 */

// ── Scheduling Loop ───────────────────────────────────────────────────────────

/** How often the orchestrator alarm fires to check missions (ms). */
export const DEFAULT_ORCHESTRATOR_SCHEDULING_INTERVAL_MS = 30_000; // 30 seconds

/** How long a running task can go without a status event before stall detection (ms). */
export const DEFAULT_ORCHESTRATOR_STALL_TIMEOUT_MS = 1_200_000; // 20 minutes

/** Max tasks the orchestrator will dispatch in a single scheduling cycle. */
export const DEFAULT_ORCHESTRATOR_MAX_DISPATCHES_PER_CYCLE = 5;

/** Default max active (running/provisioning) tasks per mission if budget_config.maxActiveTasks unset. */
export const DEFAULT_ORCHESTRATOR_MAX_ACTIVE_TASKS_PER_MISSION = 5;

// ── Decision Log ──────────────────────────────────────────────────────────────

/** Maximum decision log entries kept per project (oldest pruned). */
export const DEFAULT_ORCHESTRATOR_DECISION_LOG_MAX_ENTRIES = 500;

/** Maximum recent decisions returned by getStatus(). */
export const DEFAULT_ORCHESTRATOR_RECENT_DECISIONS_LIMIT = 20;

// ── Scheduling Queue ──────────────────────────────────────────────────────────

/** Maximum pending entries in the scheduling queue. */
export const DEFAULT_ORCHESTRATOR_QUEUE_MAX_ENTRIES = 100;

// ── Resolver ──────────────────────────────────────────────────────────────────

export interface OrchestratorConfig {
  schedulingIntervalMs: number;
  stallTimeoutMs: number;
  maxDispatchesPerCycle: number;
  maxActiveTasksPerMission: number;
  decisionLogMaxEntries: number;
  recentDecisionsLimit: number;
  queueMaxEntries: number;
}

/**
 * Resolve orchestrator config from env vars with defaults.
 * Accepts a partial Env-like object so callers don't need the full Env type.
 */
export function resolveOrchestratorConfig(env: Record<string, unknown>): OrchestratorConfig {
  return {
    schedulingIntervalMs: parsePositiveInt(env.ORCHESTRATOR_SCHEDULING_INTERVAL_MS, DEFAULT_ORCHESTRATOR_SCHEDULING_INTERVAL_MS),
    stallTimeoutMs: parsePositiveInt(env.ORCHESTRATOR_STALL_TIMEOUT_MS, DEFAULT_ORCHESTRATOR_STALL_TIMEOUT_MS),
    maxDispatchesPerCycle: parsePositiveInt(env.ORCHESTRATOR_MAX_DISPATCHES_PER_CYCLE, DEFAULT_ORCHESTRATOR_MAX_DISPATCHES_PER_CYCLE),
    maxActiveTasksPerMission: parsePositiveInt(env.ORCHESTRATOR_MAX_ACTIVE_TASKS_PER_MISSION, DEFAULT_ORCHESTRATOR_MAX_ACTIVE_TASKS_PER_MISSION),
    decisionLogMaxEntries: parsePositiveInt(env.ORCHESTRATOR_DECISION_LOG_MAX_ENTRIES, DEFAULT_ORCHESTRATOR_DECISION_LOG_MAX_ENTRIES),
    recentDecisionsLimit: parsePositiveInt(env.ORCHESTRATOR_RECENT_DECISIONS_LIMIT, DEFAULT_ORCHESTRATOR_RECENT_DECISIONS_LIMIT),
    queueMaxEntries: parsePositiveInt(env.ORCHESTRATOR_QUEUE_MAX_ENTRIES, DEFAULT_ORCHESTRATOR_QUEUE_MAX_ENTRIES),
  };
}

function parsePositiveInt(value: unknown, defaultValue: number): number {
  if (value === undefined || value === null) return defaultValue;
  const parsed = typeof value === 'number' ? value : parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}
