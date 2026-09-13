/**
 * The two cheap lookups the stuck-task sweep makes before it terminalizes a
 * conversation.
 *
 * Both exist because the sweep's terminal branches key on signals that merely
 * *correlate* with the condition they are testing (`.claude/rules/74`):
 *
 * | Branch  | Condition it means to test        | Signal it used            |
 * | ------- | --------------------------------- | ------------------------- |
 * | ceiling | "unbounded compute is still burning" | age of the `tasks` row |
 * | all     | "nothing recoverable is lost"     | `workspaces.status`       |
 *
 * The divergence is a sleeping conversation: its compute is released by design,
 * its workspace row is deleted (then removed outright), and its `tasks` row goes
 * on aging. In `sam-prod` over 2026-09-06..13 that divergence produced 41 of the
 * week's 94 task failures; 79 of the last 80 ceiling firings were on a workspace
 * that was already `deleted`, so the "runaway-cost ceiling" bounded nothing.
 */
import { log } from '../lib/logger';
import {
  sessionRecoveryAttemptDecayMs,
  sessionRecoveryMaxAttempts,
} from './session-snapshot-recovery-budget';
import {
  classifySessionWakeability,
  loadSessionWakeabilitySnapshot,
  type SessionWakeability,
} from './session-wakeability';

type SleepGuardEnv = {
  DATABASE: D1Database;
  SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS?: string;
  SESSION_SNAPSHOT_RECOVERY_ATTEMPT_DECAY_MS?: string;
};

export interface SleepGuardTask {
  id: string;
  project_id: string;
  status: string;
  task_mode?: string | null;
  execution_step: string | null;
  workspace_id: string | null;
  chat_session_id: string | null;
}

/**
 * What the sweep should do with a candidate it has already decided is stuck.
 *
 *  - `none`      — no sleeping-session record explains this state; terminalize
 *                  exactly as before. This is the discriminating control: a
 *                  user-deleted workspace destroys the snapshot row entirely
 *                  (`session-snapshot-persistence.ts:deleteSessionSnapshotState`),
 *                  so genuine runtime death still reports a failure.
 *  - `preserve`  — the conversation is asleep and the resumer can still wake it.
 *                  No status change at all.
 *  - `lifecycle` — it was asleep, but the sleep can no longer be restored. It
 *                  still leaves the candidate set (`.claude/rules/47` bounded
 *                  escape), recorded as a lifecycle outcome rather than an agent
 *                  failure (policies `a974b04f`, `486d1dd1`).
 *  - `unknown`   — the lookup failed. The destructive action is the irreversible
 *                  one, so an unknown answer withholds the verdict
 *                  (`.claude/rules/58` req 4).
 */
export type SleepGuardVerdict =
  | { kind: 'none' }
  | { kind: 'preserve'; wakeability: 'resumable' | 'retry_pending' }
  | { kind: 'lifecycle'; reason: string }
  | { kind: 'unknown' };

/**
 * Recorded instead of a runtime-death message when a conversation leaves the
 * candidate set because its sleep expired rather than because an agent failed.
 */
export const SLEEP_EXPIRED_TERMINATION_MESSAGE =
  'This conversation went to sleep and its saved session expired before it was ' +
  'resumed, so it can no longer be restored.';

/**
 * Recorded when the conversation slept normally but the workspace row the
 * restore path needs is gone, so no wake can be authorized.
 */
export const SLEEP_UNRESTORABLE_TERMINATION_MESSAGE =
  'This conversation went to sleep, but the workspace its saved session restores ' +
  'into no longer exists, so it can no longer be woken.';

/**
 * Does the sleeping-session guard apply to this candidate at all?
 *
 * A conversation-mode task stays `in_progress` between turns by design, and a
 * task-mode task parked at `awaiting_followup` is in the same position, so both
 * can legitimately be asleep. A compaction loop is deliberately excluded: it is
 * a real malfunction burning real tokens, and it must still terminalize even
 * when the session happens to be sleeping.
 */
export function sleepGuardApplies(
  task: SleepGuardTask,
  options: { compactionLoop: boolean }
): boolean {
  if (options.compactionLoop) return false;
  if (task.status !== 'in_progress') return false;
  if (!task.chat_session_id) return false;
  return task.task_mode === 'conversation' || task.execution_step === 'awaiting_followup';
}

/**
 * Ask the resumer's own record whether this conversation can still be woken.
 *
 * One point lookup on the UNIQUE `idx_session_snapshots_chat_session_id`, paid
 * only by a candidate the sweep is already about to terminalize — the same
 * hot-path discipline `loadTaskSupersession` follows (`.claude/rules/47`,
 * `.claude/rules/58` req 6).
 *
 * Deliberately re-read here rather than threaded out of `getTaskRuntimeLiveness`:
 * the ceiling branch never runs a liveness probe at all, and this guard has to
 * cover that branch too. One read on the terminal path is the price of a single
 * choke point that a future branch cannot forget (`.claude/rules/66` req 3 —
 * the lesson already recorded in `stuck-tasks.ts` for supersession).
 */
export async function evaluateSleepGuard(
  env: SleepGuardEnv,
  task: SleepGuardTask,
  nowMs: number
): Promise<SleepGuardVerdict> {
  const chatSessionId = task.chat_session_id;
  if (!chatSessionId) return { kind: 'none' };

  let wakeability: SessionWakeability;
  try {
    const snapshot = await loadSessionWakeabilitySnapshot(
      env.DATABASE,
      task.project_id,
      chatSessionId
    );
    if (!snapshot) return { kind: 'none' };
    wakeability = classifySessionWakeability(
      snapshot,
      { projectId: task.project_id, chatSessionId },
      {
        maxRecoveryAttempts: sessionRecoveryMaxAttempts(env),
        recoveryAttemptDecayMs: sessionRecoveryAttemptDecayMs(env),
        nowMs,
      }
    );
  } catch (err) {
    log.warn('stuck_task.sleep_guard_query_failed', {
      taskId: task.id,
      projectId: task.project_id,
      chatSessionId,
      action: 'withheld_terminal_verdict',
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'unknown' };
  }

  if (wakeability.kind === 'unwakeable') {
    if (wakeability.reason === 'no_snapshot' || wakeability.reason === 'scope_mismatch') {
      // No sleeping-session record explains this state, so the pre-existing
      // verdict stands unchanged. This is the discriminating control: a
      // user-deleted workspace destroys the snapshot row, so genuine runtime
      // death still reports a failure.
      return { kind: 'none' };
    }
    if (wakeability.reason === 'runtime_workspace_missing') {
      // The conversation slept normally but its runtime row is gone, so no wake
      // path can accept it. Visible to operators as a fleet-level defect —
      // tracked by SAM idea 01M2CQD1FK7YA96VD6Q74302K0 — while the task itself
      // still retires as a lifecycle outcome rather than an agent failure.
      log.warn('stuck_task.sleeping_session_runtime_row_missing', {
        taskId: task.id,
        projectId: task.project_id,
        chatSessionId,
        action: 'cancelled',
      });
      return { kind: 'lifecycle', reason: SLEEP_UNRESTORABLE_TERMINATION_MESSAGE };
    }
    return { kind: 'lifecycle', reason: SLEEP_EXPIRED_TERMINATION_MESSAGE };
  }
  return { kind: 'preserve', wakeability: wakeability.kind };
}

/**
 * How long the *allocated runtime generation* has been running, for the
 * runaway-cost ceiling.
 *
 *  - `{ kind: 'aged' }`    — a workspace row exists; `ageMs` is its lifetime.
 *  - `{ kind: 'no_runtime' }` — no workspace row, so no allocation exists for a
 *                            cost ceiling to bound. The liveness branch, which
 *                            understands sleep and supersession, decides instead.
 *  - `{ kind: 'unknown' }` — the lookup failed. Fails closed rather than
 *                            reverting to the ambient `tasks.started_at` proxy
 *                            (`.claude/rules/74` req 5); `TASK_RUN_HARD_TIMEOUT_MS`
 *                            plus the liveness probe still bound a live runtime,
 *                            and the next sweep retries.
 *
 * Deliberately the **workspace**, not the agent session. One workspace is one VM
 * allocation, so agent-session churn inside a live workspace cannot reset the
 * cost bound, while a wake — which always provisions a new workspace — correctly
 * starts a new generation. That is the "age the allocated live runtime
 * generation, not the conversation" acceptance criterion of idea
 * `01M0SHQDH3FQQG7NMFKMFPSXWM`.
 */
export type RuntimeGenerationAge =
  | { kind: 'aged'; ageMs: number; createdAtMs: number }
  | { kind: 'no_runtime' }
  | { kind: 'unknown' };

export async function resolveRuntimeGenerationAge(
  env: Pick<SleepGuardEnv, 'DATABASE'>,
  task: Pick<SleepGuardTask, 'id' | 'project_id' | 'workspace_id'>,
  nowMs: number
): Promise<RuntimeGenerationAge> {
  if (!task.workspace_id) return { kind: 'no_runtime' };
  try {
    const row = await env.DATABASE.prepare(
      `SELECT created_at FROM workspaces WHERE id = ? AND project_id = ? LIMIT 1`
    )
      .bind(task.workspace_id, task.project_id)
      .first<{ created_at: string | null }>();
    if (!row) return { kind: 'no_runtime' };
    const createdAtMs = row.created_at ? Date.parse(row.created_at) : Number.NaN;
    // An unparseable timestamp is a degraded input, not a licence to fall back to
    // the proxy that caused the bug (`.claude/rules/74` req 5).
    if (!Number.isFinite(createdAtMs)) {
      log.warn('stuck_task.runtime_generation_unparseable', {
        taskId: task.id,
        workspaceId: task.workspace_id,
        createdAt: row.created_at,
        action: 'withheld_ceiling_verdict',
      });
      return { kind: 'unknown' };
    }
    return { kind: 'aged', ageMs: nowMs - createdAtMs, createdAtMs };
  } catch (err) {
    log.warn('stuck_task.runtime_generation_query_failed', {
      taskId: task.id,
      projectId: task.project_id,
      workspaceId: task.workspace_id,
      action: 'withheld_ceiling_verdict',
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'unknown' };
  }
}
