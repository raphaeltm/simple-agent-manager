import { log } from '../lib/logger';

// Protocol vocabulary, not caller-defined labels: never log paths, commands or errors.
export const LIFECYCLE_PHASES = [
  'packages',
  'docker',
  'docker-model-runner',
  'firewall',
  'tls-permissions',
  'nodejs-install',
  'devcontainer-cli',
  'image-prepull',
  'journald-config',
  'docker-restart',
  'metadata-block',
  'system_wait',
  'git_token',
  'runtime_assets',
  'workspace_prepare',
  'prepare',
  'wip_capture',
  'wip_upload',
  'home_capture',
  'home_upload',
  'complete',
  'metadata',
  'workspace',
  'home_restore',
  'git_restore',
  'agent_restore',
  'verify',
  'volume_create',
  'git_clone',
  'devcontainer_cache',
  'devcontainer_up',
  'gh_cli',
  'git_creds',
  'git_identity',
  'sam_env',
] as const;
const phases = new Set<string>(LIFECYCLE_PHASES);
export const LIFECYCLE_TIMINGS_MAX_BYTES = 8192;

export interface LifecycleTiming {
  phase: string;
  durationMs: number;
}

/** Drop unknown fields and labels even from authenticated agents. */
export function boundedLifecycleTimings(value: unknown): LifecycleTiming[] {
  if (!Array.isArray(value)) return [];
  const result = new Map<string, LifecycleTiming>();
  for (const item of value.slice(0, LIFECYCLE_PHASES.length)) {
    if (!item || typeof item !== 'object') continue;
    const { phase, durationMs } = item;
    if (
      typeof phase !== 'string' ||
      !phases.has(phase) ||
      typeof durationMs !== 'number' ||
      !Number.isSafeInteger(durationMs) ||
      durationMs < 0
    )
      continue;
    result.set(phase, { phase, durationMs });
  }
  return [...result.values()];
}

/** Every operation a stored phase timing can name. Runner rows never share a name with VM rows. */
export type LifecyclePhaseOperation =
  'provision' | 'workspace' | 'sleep' | 'wake' | 'runner_start' | 'runner_wake';

/** Ids the caller already holds. Task, skill and profile are resolved inside the INSERT. */
export interface LifecyclePhaseIdentity {
  projectId?: string | null;
  workspaceId?: string | null;
  nodeId?: string | null;
  chatSessionId?: string | null;
  taskId?: string | null;
}

/**
 * One row per phase. The task is the caller's (TaskRunner) or the newest task bound to this
 * workspace in this project; skill and profile come from that task. A profile hint is stored only
 * when it names a profile of the task's project or the task creator's own global profile, because
 * the REST create path may store a profile name there. All lookups run inside the statement, so
 * attribution costs no round trip. Each value is bound once, in `params` column order.
 */
const INSERT_PHASE_TIMING_SQL = `WITH params AS (
    SELECT ? AS operation, ? AS phase, ? AS outcome, ? AS duration_ms, ? AS project_id,
           ? AS workspace_id, ? AS node_id, ? AS chat_session_id, ? AS task_id, ? AS created_at
  )
  INSERT INTO lifecycle_phase_timings
    (operation, phase, outcome, duration_ms, project_id, workspace_id, node_id, chat_session_id,
     task_id, skill_id, agent_profile_id, created_at)
  SELECT params.operation, params.phase, params.outcome, params.duration_ms, params.project_id,
         params.workspace_id, params.node_id, params.chat_session_id,
         COALESCE(params.task_id, task.id),
         task.skill_id,
         (SELECT profile.id FROM agent_profiles profile
           WHERE profile.id = task.agent_profile_hint
             AND (profile.project_id = task.project_id
                  OR (profile.project_id IS NULL AND profile.user_id = task.user_id))),
         params.created_at
    FROM params
    LEFT JOIN tasks task ON task.id = (
      SELECT candidate.id FROM tasks candidate
       WHERE params.project_id IS NOT NULL
         AND candidate.project_id = params.project_id
         AND ((params.task_id IS NOT NULL AND candidate.id = params.task_id)
              OR (params.task_id IS NULL AND params.workspace_id IS NOT NULL
                  AND candidate.workspace_id = params.workspace_id))
       ORDER BY candidate.created_at DESC, candidate.id DESC
       LIMIT 1)`;

/**
 * Store already-bounded phases in one D1 batch (one round trip; at most
 * `LIFECYCLE_PHASES.length` rows from a VM callback, one from the runner). Never throws: a
 * failed telemetry write is logged and must not fail the callback or runner step it rides on.
 */
export async function storeLifecyclePhaseTimings(
  db: D1Database,
  input: {
    operation: LifecyclePhaseOperation;
    outcome: 'success' | 'error';
    phases: readonly LifecycleTiming[];
    identity: LifecyclePhaseIdentity;
    now?: number;
  }
): Promise<number> {
  if (input.phases.length === 0) return 0;
  const { identity } = input;
  const createdAt = input.now ?? Date.now();
  try {
    await db.batch(
      input.phases.map((timing) =>
        db
          .prepare(INSERT_PHASE_TIMING_SQL)
          .bind(
            input.operation,
            timing.phase,
            input.outcome,
            timing.durationMs,
            identity.projectId ?? null,
            identity.workspaceId ?? null,
            identity.nodeId ?? null,
            identity.chatSessionId ?? null,
            identity.taskId ?? null,
            createdAt
          )
      )
    );
    return input.phases.length;
  } catch (error) {
    log.warn('session_lifecycle.timings_store_failed', {
      operation: input.operation,
      outcome: input.outcome,
      phaseCount: input.phases.length,
      ...identity,
      error: error instanceof Error ? error.message : String(error),
      action: 'dropped',
    });
    return 0;
  }
}

/** Log and store a VM agent timing summary. One D1 round trip; never throws. */
export async function recordLifecycleTimings(
  db: D1Database,
  operation: 'provision' | 'workspace' | 'sleep' | 'wake',
  timings: unknown,
  identity: LifecyclePhaseIdentity,
  outcome: 'success' | 'error' = 'success'
): Promise<void> {
  // Keep the wire vocabulary compatible while avoiding the logger's sam_* token
  // redaction. Never relax credential redaction for a telemetry label. Stored rows use the
  // same names as the log line.
  const phases = boundedLifecycleTimings(timings).map((timing) => ({
    ...timing,
    phase: timing.phase === 'sam_env' ? 'platform_environment' : timing.phase,
  }));
  if (!phases.length) return;
  log.info('session_lifecycle.timings', { operation, outcome, ...identity, phases });
  await storeLifecyclePhaseTimings(db, { operation, outcome, phases, identity });
}
