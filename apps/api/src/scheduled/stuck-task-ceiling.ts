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
 *     business, which terminalizes a genuinely dead runtime from the 4h recovery
 *     check onward — far earlier than 24h, and with an accurate reason.
 *  2. **Age comes from that generation**, i.e. `workspaces.created_at`, not from
 *     a conversation row that a wake may have created weeks ago.
 *
 * Bounded escape (`.claude/rules/47`): declining the ceiling never strands a
 * task. A dead runtime with no restorable snapshot is conclusively terminalized
 * by the liveness branch; a restorable one is preserved only until its snapshot
 * TTL lapses, after which the same branch terminalizes it.
 *
 * The sleep gate's deferral is bounded on this module's own clock. On 2026-10-04
 * task `01M3Z4CCZH5N22754V7CVVN9WR` reached a 35.3-hour runtime generation, 11
 * hours past the 24-hour ceiling, because every sweep found its sleep "in
 * flight". The sleep was failing every few minutes, and each retry claim
 * re-stamped the timestamp the shared in-flight predicate ages from, so its
 * 30-minute bound never lapsed (`.claude/rules/53` §5b). A sleep that is merely
 * in flight therefore holds the ceiling off for at most
 * `TASK_RUN_ABSOLUTE_CEILING_SLEEP_GRACE_MS`, measured on runtime-generation age,
 * which no sleep writer can touch. A restorable (asleep) record still always
 * defers.
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

/** A sleep that was still only in flight when the ceiling's sleep grace ran out. */
export interface InFlightSleepGraceExpiry {
  /** `session_snapshots.sleep_status` of the in-flight record. */
  sleepStatus: string | null;
  /** How far the runtime generation is past the ceiling. */
  overrunMs: number;
  graceMs: number;
}

export type RunawayCostCeilingVerdict =
  /** Below the ceiling: the generation's age is reported for diagnostics. */
  | { kind: 'not_applicable'; reason: 'below_ceiling'; runtimeGenerationMs: number }
  /** No allocated runtime generation to bound. */
  | { kind: 'not_applicable'; reason: 'no_live_runtime_generation' }
  /** Recoverable or superseded: withhold the verdict, leave the task untouched. */
  | {
      kind: 'preserve';
      reason:
        'session_sleeping' | 'session_sleep_unknown' | 'superseded_live' | 'supersession_unknown';
    }
  /**
   * Terminalize. `superseded` selects the benign lifecycle label over a failure.
   * `inFlightSleepGraceExpired` is set when an in-flight sleep was outlasted, and
   * tells the caller's terminal gate not to re-defer to that same sleep.
   */
  | {
      kind: 'terminalize';
      superseded: boolean;
      runtimeGenerationMs: number;
      inFlightSleepGraceExpired: InFlightSleepGraceExpiry | null;
    };

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
 *
 * The record is read through the shared predicate (`loadTaskSleepPreservation`).
 * Only its arm decides how long the ceiling defers: a restorable record, the
 * conversation fallback and an unknown lookup always defer; an in-flight sleep
 * defers until the generation is `sleepGraceMs` past the ceiling.
 *
 * Returns the preserve verdict, or null when sleep cannot explain the state, plus
 * the grace expiry when an in-flight sleep was outlasted.
 */
async function ceilingSleepGate(
  env: Env,
  task: RunawayCostCeilingInput,
  workspace: RuntimeWorkspaceSnapshot | null,
  runtimeGenerationMs: number,
  bounds: { absoluteCeilingMs: number; sleepGraceMs: number }
): Promise<{
  verdict: RunawayCostCeilingVerdict | null;
  graceExpired: InFlightSleepGraceExpiry | null;
}> {
  const preservation = await loadTaskSleepPreservation(env.DATABASE, env, {
    id: task.id,
    projectId: task.project_id,
    chatSessionId: task.chat_session_id,
  });
  if (preservation.outcome !== 'preserve' && preservation.outcome !== 'unknown') {
    return { verdict: null, graceExpired: null };
  }

  const overrunMs = runtimeGenerationMs - bounds.absoluteCeilingMs;
  const logFields = {
    taskId: task.id,
    projectId: task.project_id,
    chatSessionId: task.chat_session_id,
    workspaceId: task.workspace_id,
    workspaceStatus: workspace?.status ?? null,
    sleepStatus: preservation.sleepStatus,
    arm: preservation.arm,
    expiresAt: preservation.expiresAt,
    runtimeGenerationMs,
    absoluteCeilingMs: bounds.absoluteCeilingMs,
    overrunMs,
    sleepGraceMs: bounds.sleepGraceMs,
    source: 'ceiling',
    outcome: preservation.outcome,
  };
  if (preservation.arm === 'in_flight' && overrunMs > bounds.sleepGraceMs) {
    log.warn('stuck_task.ceiling_sleep_grace_expired', { ...logFields, action: 'terminalize' });
    return {
      verdict: null,
      graceExpired: {
        sleepStatus: preservation.sleepStatus,
        overrunMs,
        graceMs: bounds.sleepGraceMs,
      },
    };
  }

  log.info('stuck_task.preserved_sleeping', { ...logFields, action: 'preserved' });
  return {
    verdict: {
      kind: 'preserve',
      reason: preservation.outcome === 'preserve' ? 'session_sleeping' : 'session_sleep_unknown',
    },
    graceExpired: null,
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

/** The terminal reason for a ceiling verdict that is not a supersession. */
export function runawayCostCeilingReason(
  verdict: Extract<RunawayCostCeilingVerdict, { kind: 'terminalize' }>,
  absoluteCeilingMs: number,
  stepInfo: string
): string {
  const ceilingMinutes = Math.round(absoluteCeilingMs / 60_000);
  const expired = verdict.inFlightSleepGraceExpired;
  if (!expired) {
    return `Task exceeded the absolute runaway-cost ceiling of ${ceilingMinutes} minutes; live-runtime tasks are bounded to prevent unbounded compute.${stepInfo}`;
  }
  return (
    `Task exceeded the absolute runaway-cost ceiling of ${ceilingMinutes} minutes: its runtime ` +
    `generation is ${Math.round(verdict.runtimeGenerationMs / 60_000)} minutes old, and its automatic ` +
    `sleep was still in flight (sleep status: ${expired.sleepStatus ?? 'unknown'}) ` +
    `${Math.round(expired.overrunMs / 60_000)} minutes past the ceiling, beyond the ` +
    `${Math.round(expired.graceMs / 60_000)}-minute sleep grace.${stepInfo}`
  );
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
    /** `TASK_RUN_ABSOLUTE_CEILING_SLEEP_GRACE_MS`, resolved by the caller. */
    sleepGraceMs: number;
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
    return { kind: 'not_applicable', reason: 'below_ceiling', runtimeGenerationMs };
  }

  const sleep = await ceilingSleepGate(env, task, workspace, runtimeGenerationMs, {
    absoluteCeilingMs: opts.absoluteCeilingMs,
    sleepGraceMs: opts.sleepGraceMs,
  });
  if (sleep.verdict) return sleep.verdict;

  const { verdict, superseded } = await ceilingSupersessionGate(env, task, runtimeGenerationMs);
  if (verdict) return verdict;

  return {
    kind: 'terminalize',
    superseded,
    runtimeGenerationMs,
    inFlightSleepGraceExpired: sleep.graceExpired,
  };
}
