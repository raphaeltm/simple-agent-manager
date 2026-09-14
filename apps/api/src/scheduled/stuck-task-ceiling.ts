/**
 * The absolute runaway-cost ceiling for an `in_progress` task.
 *
 * Lives outside `stuck-tasks.ts` because that file is already past the 800-line
 * mandatory-split threshold with a documented exception (`.claude/rules/18`).
 *
 * ## What the ceiling is for, and what it must therefore measure
 *
 * It is a **cost** backstop: it bounds a task that is burning compute even when
 * every liveness signal says the runtime is healthy. That makes "how long has
 * compute been allocated for this task?" the condition, and `tasks.started_at`
 * merely a signal that correlates with it (`.claude/rules/74`).
 *
 * The two diverge exactly where it matters. Measured on `sam-prod` over
 * 2026-09-07..14, **45 of 45** conversation tasks failed by this ceiling had
 * `workspaces.status='deleted'` at failure time, and all 45 had a `sleeping`
 * `session_snapshots` row. Their compute had been released hours earlier — in one
 * traced case the session slept 44 minutes after `started_at` and the ceiling
 * killed it 23 hours later. The ceiling bounded nothing and cost the user a red
 * "Task failed" banner on a conversation that was still wakeable.
 *
 * So this module enforces two things the bare `started_at` comparison could not:
 *
 *  1. **The ceiling only applies while a runtime generation is actually
 *     allocated.** No workspace row, or a workspace in a terminal status, means
 *     there is no compute to bound. Those tasks are the liveness branch's
 *     business, which terminalizes a genuinely dead runtime at 4h/8h — far
 *     earlier than 24h, and with an accurate reason.
 *  2. **Age comes from that generation**, i.e. `workspaces.created_at`, not from
 *     a conversation row that a wake may have created weeks ago.
 *
 * Bounded escape (`.claude/rules/47`): declining the ceiling never strands a
 * task. A dead runtime with no restorable snapshot is conclusively terminalized
 * by the liveness branch; a restorable one is preserved only until its snapshot
 * TTL lapses, after which the same branch terminalizes it.
 *
 * Fail-closed (`.claude/rules/74` requirement 5): if the workspace read fails we
 * fall back to `tasks.started_at` and apply the ceiling, keeping today's stricter
 * behaviour. A degraded read must never weaken a cost backstop.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import {
  loadRuntimeWorkspaceSnapshot,
  loadTaskSupersession,
  type RuntimeWorkspaceSnapshot,
  type TaskSupersession,
} from '../services/task-runtime-liveness';
import { loadTaskSleepPreservation } from '../services/task-sleep-preservation';

/**
 * Workspace statuses that mean no compute is allocated to this task any more.
 *
 * `sleeping` is included deliberately: a slept workspace has released its VM.
 * It is ALSO an inconclusive status for the liveness classifier
 * (`INCONCLUSIVE_WORKSPACE_STATUSES`), so declining the ceiling here hands the
 * task to a branch that will preserve it — which is the correct outcome for a
 * conversation the user can still wake.
 */
const RELEASED_WORKSPACE_STATUSES = new Set([
  'sleeping',
  'stopping',
  'stopped',
  'deleted',
  'destroyed',
  'error',
  'failed',
]);

export type RunawayCostCeilingVerdict =
  /** Below the ceiling, or no allocated runtime generation to bound. */
  | { kind: 'not_applicable'; reason: 'below_ceiling' | 'no_live_runtime_generation' }
  /** Recoverable or superseded: withhold the verdict, leave the task untouched. */
  | {
      kind: 'preserve';
      reason:
        | 'session_sleeping'
        | 'session_sleep_unknown'
        | 'superseded_live'
        | 'supersession_unknown';
    }
  /** Terminalize. `superseded` selects the benign lifecycle label over a failure. */
  | { kind: 'terminalize'; superseded: boolean; runtimeGenerationMs: number };

export interface RunawayCostCeilingInput {
  id: string;
  project_id: string;
  workspace_id: string | null;
  chat_session_id: string | null;
  /** Epoch ms of `tasks.started_at`, or the `updated_at` fallback. */
  startedAtMs: number;
}

/**
 * Resolve the start of the currently-allocated runtime generation.
 *
 * Returns `null` when no generation is allocated. `'unknown'` when the workspace
 * could not be read, which the caller must treat as "apply the ceiling from
 * `started_at`".
 */
function resolveRuntimeGenerationStart(
  workspace: RuntimeWorkspaceSnapshot | null,
  task: RunawayCostCeilingInput
): number | null {
  // No workspace ever allocated, or the row is gone: nothing holds compute.
  if (!task.workspace_id || !workspace) return null;
  if (RELEASED_WORKSPACE_STATUSES.has(workspace.status)) return null;
  // `createdAtMs` is null only when the column is absent or unparseable; fall
  // back to the stricter existing signal rather than treating the generation as
  // brand new, which would disable the ceiling.
  return workspace.createdAtMs ?? task.startedAtMs;
}

/**
 * Decide whether the runaway-cost ceiling terminalizes this task.
 *
 * Deliberately pays no ProjectData DO / container / ACP round-trips — a property
 * pinned by `stuck-tasks.test.ts` "without probing liveness". Every lookup here
 * is a single indexed D1 read, and they are reached only by tasks already past
 * the soft execution timeout (`.claude/rules/47`).
 *
 * `preloadWorkspace` receives the workspace snapshot this function read so the
 * caller's liveness probe can reuse it instead of issuing a second identical
 * point lookup.
 */
/**
 * Load the workspace snapshot the ceiling ages from, handing it to the caller's
 * liveness probe so the fall-through path does not repeat the same point lookup.
 *
 * A read failure is reported, not swallowed: the caller falls back to
 * `tasks.started_at` and still applies the ceiling, because a degraded input must
 * not weaken a cost backstop (`.claude/rules/74` requirement 5).
 */
async function loadCeilingWorkspace(
  env: Env,
  task: RunawayCostCeilingInput,
  preloadWorkspace?: (snapshot: RuntimeWorkspaceSnapshot | null, outcome: 'ok' | 'error') => void
): Promise<{ workspace: RuntimeWorkspaceSnapshot | null; readFailed: boolean }> {
  let workspace: RuntimeWorkspaceSnapshot | null = null;
  let readFailed = false;
  if (task.workspace_id) {
    try {
      workspace = await loadRuntimeWorkspaceSnapshot(
        env.DATABASE,
        task.project_id,
        task.workspace_id
      );
    } catch (err) {
      readFailed = true;
      log.warn('stuck_task.ceiling_workspace_query_failed', {
        taskId: task.id,
        projectId: task.project_id,
        workspaceId: task.workspace_id,
        action: 'applied_ceiling_from_started_at',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  preloadWorkspace?.(workspace, readFailed ? 'error' : 'ok');
  return { workspace, readFailed };
}

/**
 * A live runtime generation past the ceiling still must not destroy a session the
 * wake path would accept — a sleep capture in flight keeps the workspace alive
 * while `session_snapshots` already owns the conversation (`.claude/rules/58`).
 * Bounded by the in-flight sleep age ceiling.
 *
 * Returns the preserve verdict, or null when sleep cannot explain the state.
 */
async function ceilingSleepGate(
  env: Env,
  task: RunawayCostCeilingInput,
  workspace: RuntimeWorkspaceSnapshot | null,
  runtimeGenerationMs: number
): Promise<RunawayCostCeilingVerdict | null> {
  const preservation = await loadTaskSleepPreservation(env.DATABASE, env, {
    id: task.id,
    projectId: task.project_id,
    chatSessionId: task.chat_session_id,
  });
  if (preservation.outcome !== 'preserve' && preservation.outcome !== 'unknown') return null;

  log.info('stuck_task.preserved_sleeping', {
    taskId: task.id,
    projectId: task.project_id,
    chatSessionId: task.chat_session_id,
    workspaceId: task.workspace_id,
    workspaceStatus: workspace?.status ?? null,
    sleepStatus: preservation.sleepStatus,
    expiresAt: preservation.expiresAt,
    runtimeGenerationMs,
    source: 'ceiling',
    outcome: preservation.outcome,
    action: 'preserved',
  });
  return {
    kind: 'preserve',
    reason: preservation.outcome === 'preserve' ? 'session_sleeping' : 'session_sleep_unknown',
  };
}

/**
 * A superseded predecessor holds no compute at all, so it must not be recorded as
 * a runaway failure (`.claude/rules/66`).
 *
 * Returns the preserve verdict, the benign-cancellation flag, or null when
 * supersession cannot explain the state.
 */
async function ceilingSupersessionGate(
  env: Env,
  task: RunawayCostCeilingInput,
  runtimeGenerationMs: number
): Promise<{ verdict: RunawayCostCeilingVerdict | null; superseded: boolean }> {
  let supersession: TaskSupersession | 'unknown' = 'none';
  try {
    supersession = await loadTaskSupersession(env.DATABASE, task.project_id, task.id);
  } catch (err) {
    log.warn('stuck_task.ceiling_supersession_query_failed', {
      taskId: task.id,
      projectId: task.project_id,
      action: 'withheld_terminal_verdict',
      error: err instanceof Error ? err.message : String(err),
    });
    supersession = 'unknown';
  }

  if (supersession === 'unknown') {
    log.info('stuck_task.ceiling_preserved_supersession_unknown', {
      taskId: task.id,
      projectId: task.project_id,
      runtimeGenerationMs,
      action: 'preserved',
    });
    return { verdict: { kind: 'preserve', reason: 'supersession_unknown' }, superseded: false };
  }

  if (supersession === 'live') {
    // Preserve, do NOT terminalize. `cancelled` is a member of
    // TERMINAL_TASK_STATUSES, so terminalizing would revoke the recovery guard
    // its LIVE successor still depends on, and `abortRevokedSourceTaskWake`
    // turns that into stopping a running container. `'live'` is inconclusive
    // everywhere else in the system and must be inconclusive here too.
    // Bounded escape (`.claude/rules/47`): once the successor ends this reads
    // `'terminal'` on the next tick and the task is cancelled.
    log.info('stuck_task.ceiling_preserved_superseded', {
      taskId: task.id,
      projectId: task.project_id,
      runtimeGenerationMs,
      action: 'preserved',
    });
    return { verdict: { kind: 'preserve', reason: 'superseded_live' }, superseded: false };
  }

  return { verdict: null, superseded: supersession === 'terminal' };
}

/**
 * Decide whether the runaway-cost ceiling terminalizes this task.
 *
 * Sequences four stages and nothing else: resolve the allocated runtime
 * generation, compare it against the ceiling, then the sleep and supersession
 * gates. Each stage lives in its own helper above.
 *
 * Deliberately pays no ProjectData DO / container / ACP round-trips — a property
 * pinned by `stuck-tasks.test.ts` "without probing liveness". Every lookup here is
 * a single indexed D1 read, reached only by tasks already past the soft execution
 * timeout (`.claude/rules/47`).
 */
export async function evaluateRunawayCostCeiling(
  env: Env,
  task: RunawayCostCeilingInput,
  opts: {
    nowMs: number;
    absoluteCeilingMs: number;
    preloadWorkspace?: (snapshot: RuntimeWorkspaceSnapshot | null, outcome: 'ok' | 'error') => void;
  }
): Promise<RunawayCostCeilingVerdict> {
  const { workspace, readFailed } = await loadCeilingWorkspace(env, task, opts.preloadWorkspace);

  const generationStartMs = readFailed
    ? task.startedAtMs
    : resolveRuntimeGenerationStart(workspace, task);

  if (generationStartMs === null) {
    log.info('stuck_task.ceiling_no_live_runtime_generation', {
      taskId: task.id,
      projectId: task.project_id,
      workspaceId: task.workspace_id,
      workspaceStatus: workspace?.status ?? null,
      conversationAgeMs: opts.nowMs - task.startedAtMs,
      action: 'deferred_to_liveness',
    });
    return { kind: 'not_applicable', reason: 'no_live_runtime_generation' };
  }

  const runtimeGenerationMs = opts.nowMs - generationStartMs;
  if (runtimeGenerationMs <= opts.absoluteCeilingMs) {
    return { kind: 'not_applicable', reason: 'below_ceiling' };
  }

  const sleepVerdict = await ceilingSleepGate(env, task, workspace, runtimeGenerationMs);
  if (sleepVerdict) return sleepVerdict;

  const { verdict, superseded } = await ceilingSupersessionGate(env, task, runtimeGenerationMs);
  if (verdict) return verdict;

  return { kind: 'terminalize', superseded, runtimeGenerationMs };
}
