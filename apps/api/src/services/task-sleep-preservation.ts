/**
 * Task-scoped "is this conversation still asleep or going to sleep?" guard.
 *
 * Every path that writes a terminal verdict about a task must consult this
 * before deciding the work is unrecoverable, because a slept conversation looks
 * exactly like a dead one from the workspace/node side: the workspace row is
 * `deleted` (or gone) and the node is destroyed *by design*.
 *
 * `.claude/rules/58` — the destroyer must read the record the resumer reads. The
 * resumer is `claimSessionSnapshotRecovery`
 * (`session-snapshot-recovery-lifecycle.ts`). This module reuses
 * `findRestorableOrInFlightSleepSnapshot` /
 * `restorableOrInFlightSleepSnapshotPredicateSql` rather than re-deriving a second
 * recoverability policy, so the sleep/status/expiry/attempt-budget rules cannot
 * drift from the wake path (`.claude/rules/74` — one authority per condition).
 *
 * KNOWN GAP, per rule 58 requirement 2 (any divergence from the resumer must be
 * written down here). That shared predicate is NOT the whole of the resumer's
 * authorizing `WHERE`: `claimSessionSnapshotRecovery` additionally applies
 * `archiveMigrationFenceCondition`, which refuses to wake a chat session whose
 * ProjectData ownership has migrated out of the root object
 * (`project_data_session_locations.location_state != 'root'`). So this guard is
 * slightly LOOSER than the resumer for an archived session: it will preserve a
 * task the wake path would refuse, and that task then waits out the snapshot's
 * `expires_at` instead of failing promptly. That is the bounded, non-destructive
 * direction of the rule-58 error, and it is pre-existing — three other finalizers
 * (`workspace-lifecycle-finalizer.ts`, `terminal-node-lifecycle-repair.ts`,
 * `project-data/terminal-session-reconciliation.ts`) already consume the same
 * predicate with the same gap, so adding the fence here alone would make four
 * consumers disagree. Tracked as idea `01M2G2YJ4W2N0RPSY9QKM3XQF1`; the fence
 * belongs in the shared predicate, for all consumers at once.
 *
 * Scoping differs from `loadSessionResumabilitySnapshot` in one deliberate way:
 * the lookup is keyed on the task's own `chat_session_id` and NOT filtered by
 * workspace. That is the fix for two production shapes the workspace-scoped
 * loader cannot see at all:
 *
 *   1. `tasks.workspace_id IS NULL` — there is no workspace row to key from, so
 *      the classifier returned a conclusive `workspace_missing` while the chat
 *      session held a `sleeping` snapshot (4 of 57 sweep verdicts in the
 *      2026-09-07..14 production window; their snapshot rows also carry a NULL
 *      `workspace_id`, so a workspace filter would drop them twice over).
 *   2. `workspaces.chat_session_id IS NULL` after a wake handoff nulls it
 *      (`session-recovery.ts:createRecoveryTask`), which makes
 *      `needsSessionResumabilityProbe` skip the probe entirely
 *      (`.claude/rules/63` — a nullable scoping column deletes the check that
 *      used it).
 *
 * `chat_session_id` is uniquely indexed (`idx_session_snapshots_chat_session_id`),
 * so each call is one point lookup, and callers only pay it for a candidate they
 * are otherwise about to terminalize (`.claude/rules/47`).
 *
 * Note it is NOT the only `session_snapshots` read on that path: the eager gate in
 * both liveness adapters runs after `loadSessionResumabilitySnapshot` has already
 * read the same row workspace-scoped, so a candidate past its timeout can pay two
 * point lookups on the same unique index. They genuinely need different columns —
 * the in-flight arm reads `sleep_claimed_at` / `sleep_stopping_since` /
 * `sleep_after`, which `SessionResumabilitySnapshot` does not carry — so merging
 * them means widening the shared predicate's SELECT for all its consumers. Tracked
 * as idea `01M2G2YJ4W2N0RPSY9QKM3XQF1`.
 */
import type { Env } from '../env';
import { createModuleLogger, log as rootLog } from '../lib/logger';
import {
  findRestorableOrInFlightSleepSnapshot,
  type SleepLifecyclePredicateResult,
} from './session-snapshot-sleep-predicate';
import type { TaskSessionSleepOutcome } from './task-runtime-liveness-types';

const log = createModuleLogger('task_sleep_preservation');

export type { TaskSessionSleepOutcome };

/**
 * Which part of the record preserved the session.
 *
 * - `restorable`: asleep with a snapshot the resumer would wake (the predicate's
 *   `sleeping` arm). Bounded by the snapshot's own `expires_at`.
 * - `in_flight`: a sleep the sweep is still scheduling, capturing, stopping or
 *   retrying (every other matched row). Its 30-minute bound is measured from the
 *   latest claim or retry stamp, so a retry loop keeps renewing it.
 * - `conversation_fallback`: a sleeping conversation kept resumable for its human
 *   after the snapshot TTL.
 *
 * Derived from the row the shared predicate returned, never from a second read,
 * so it cannot disagree with the outcome (`.claude/rules/58`).
 */
export type SleepPreservationArm = 'restorable' | 'in_flight' | 'conversation_fallback';

export interface TaskSleepPreservation {
  outcome: TaskSessionSleepOutcome;
  /** `session_snapshots.sleep_status` of the preserving row, for logs only. */
  sleepStatus: string | null;
  /** `session_snapshots.expires_at` of the preserving row, for logs only. */
  expiresAt: string | null;
  /** Human-resumable conversation fallback after the runtime snapshot TTL expires. */
  conversationFallback: boolean;
  /** Set only when `outcome` is `preserve`. */
  arm: SleepPreservationArm | null;
}

const NOT_RUN: TaskSleepPreservation = {
  outcome: 'not_run',
  sleepStatus: null,
  expiresAt: null,
  conversationFallback: false,
  arm: null,
};
const NONE: TaskSleepPreservation = {
  outcome: 'none',
  sleepStatus: null,
  expiresAt: null,
  conversationFallback: false,
  arm: null,
};

function preserved(row: SleepLifecyclePredicateResult): TaskSleepPreservation {
  return {
    outcome: 'preserve',
    sleepStatus: row.sleep_status,
    expiresAt: row.expires_at,
    conversationFallback: false,
    // The predicate's restorable arm is the only one that admits `sleeping`.
    arm: row.sleep_status === 'sleeping' ? 'restorable' : 'in_flight',
  };
}

/** True when the verdict must be withheld — both `preserve` and `unknown`. */
export function withholdsTerminalVerdict(preservation: TaskSleepPreservation): boolean {
  return preservation.outcome === 'preserve' || preservation.outcome === 'unknown';
}

type SleepPreservationEnv = Pick<
  Env,
  | 'SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS'
  | 'SESSION_SNAPSHOT_RECOVERY_ATTEMPT_DECAY_MS'
  | 'SESSION_SLEEP_IN_FLIGHT_MAX_AGE_MS'
>;

interface HumanResumableConversationTask {
  id: string;
  projectId: string;
  chatSessionId: string | null;
  taskMode?: string | null;
}

/**
 * Read the chat session's sleep state for one task about to receive a terminal
 * verdict.
 *
 * Every `preserve` is bounded, so this can never create an immortal task
 * (`.claude/rules/47`, `.claude/rules/58` requirement 3). Both arms of the shared
 * predicate carry their own bound: the restorable arm requires
 * `expires_at > now` (snapshot TTL), and the in-flight arm requires the claim /
 * update stamp to be newer than `now - SESSION_SLEEP_IN_FLIGHT_MAX_AGE_MS`
 * (`DEFAULT_SESSION_SLEEP_IN_FLIGHT_MAX_AGE_MS`, 30 min, capped at 24 h). A
 * snapshot with an absent or unparseable `expires_at` fails the `>` comparison
 * and therefore does NOT preserve.
 */
export async function loadTaskSleepPreservation(
  db: D1Database,
  env: SleepPreservationEnv,
  task: HumanResumableConversationTask,
  now?: Date
): Promise<TaskSleepPreservation> {
  // A task with no chat session has no sleep record to protect, and skipping the
  // query here is what keeps the added cost at zero for superseded predecessors —
  // the wake handoff nulls `tasks.chat_session_id` for exactly those rows.
  if (!task.chatSessionId) return NOT_RUN;

  try {
    const row = await findRestorableOrInFlightSleepSnapshot(db, env, {
      projectId: task.projectId,
      chatSessionId: task.chatSessionId,
      now,
    });
    if (row) return preserved(row);
    if (await isHumanResumableConversationTask(db, task)) {
      return {
        outcome: 'preserve',
        sleepStatus: null,
        expiresAt: null,
        conversationFallback: true,
        arm: 'conversation_fallback',
      };
    }
    return NONE;
  } catch (err) {
    log.warn('lookup_failed', {
      taskId: task.id,
      projectId: task.projectId,
      chatSessionId: task.chatSessionId,
      action: 'withheld_terminal_verdict',
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      outcome: 'unknown',
      sleepStatus: null,
      expiresAt: null,
      conversationFallback: false,
      arm: null,
    };
  }
}

async function isHumanResumableConversationTask(
  db: D1Database,
  task: HumanResumableConversationTask
): Promise<boolean> {
  if (task.taskMode !== 'conversation' || !task.chatSessionId) return false;
  const row = await db
    .prepare(
      `SELECT 1
         FROM tasks task
         INNER JOIN session_snapshots snapshot
            ON snapshot.project_id = task.project_id
           AND snapshot.chat_session_id = task.chat_session_id
        WHERE task.id = ?
          AND task.project_id = ?
          AND task.task_mode = 'conversation'
          AND task.chat_session_id = ?
          AND task.status = 'in_progress'
          AND snapshot.sleeping_at IS NOT NULL
          AND snapshot.sleep_status = 'sleeping'
          AND (
            (snapshot.status = 'available' AND snapshot.degradation = 'none')
            OR (
              snapshot.status = 'degraded'
              AND snapshot.degradation IS NOT NULL
              AND snapshot.degradation != 'none'
            )
          )
        LIMIT 1`
    )
    .bind(task.id, task.projectId, task.chatSessionId)
    .first<{ 1: number }>();
  return Boolean(row);
}

/**
 * Terminal-verdict gate: read the sleep state and log the withheld verdict.
 *
 * Callers use this at the single mutation site so a new terminal branch cannot
 * reintroduce the bug by forgetting to ask. Returns true when the caller must
 * leave the task untouched.
 *
 * Emits `stuck_task.preserved_sleeping` — the same event the ceiling gate and
 * both liveness adapters use, so one query finds every preserve regardless of
 * which guard fired. `source` discriminates them.
 */
export async function withholdTerminalVerdictForSleepingSession(
  db: D1Database,
  env: SleepPreservationEnv,
  task: {
    id: string;
    projectId: string;
    chatSessionId: string | null;
    workspaceId: string | null;
    executionStep: string | null;
    taskMode?: string | null;
  },
  context: {
    source: string;
    withheldReason: string;
    /**
     * False only when the caller has already outlasted a sleep that never
     * finished: the runaway-cost ceiling after its sleep grace. A sleeping
     * (`restorable`) or conversation-fallback session, and an `unknown` lookup,
     * still withhold the verdict. Absent means true.
     */
    honorInFlightSleep?: boolean;
  }
): Promise<boolean> {
  const preservation = await loadTaskSleepPreservation(db, env, task);
  if (!withholdsTerminalVerdict(preservation)) return false;
  if (context.honorInFlightSleep === false && preservation.arm === 'in_flight') {
    rootLog.warn('stuck_task.in_flight_sleep_not_honored', {
      taskId: task.id,
      projectId: task.projectId,
      chatSessionId: task.chatSessionId,
      workspaceId: task.workspaceId,
      sleepStatus: preservation.sleepStatus,
      source: context.source,
      reason: context.withheldReason,
      action: 'terminalize',
    });
    return false;
  }
  rootLog.info('stuck_task.preserved_sleeping', {
    taskId: task.id,
    projectId: task.projectId,
    chatSessionId: task.chatSessionId,
    workspaceId: task.workspaceId,
    executionStep: task.executionStep,
    sleepStatus: preservation.sleepStatus,
    expiresAt: preservation.expiresAt,
    conversationFallback: preservation.conversationFallback,
    arm: preservation.arm,
    outcome: preservation.outcome,
    source: context.source,
    withheldReason: context.withheldReason,
    action: 'preserved',
  });
  return true;
}
