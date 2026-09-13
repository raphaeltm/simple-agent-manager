/**
 * Can this conversation still be woken?
 *
 * One predicate, shared by every path that would otherwise destroy a sleeping
 * conversation: the stuck-task sweep's three terminal branches and the runtime
 * liveness classifier both ask this question, and `.claude/rules/58` requires
 * them to ask it of the same records the resumer reads.
 *
 * ## The resumer is three predicates, not one
 *
 * `.claude/rules/58` warns that "the one that reads most naturally as the
 * resumer is often not the one that actually authorizes the restore", and that
 * mirroring only part of the path leaves the destroyer either too loose or too
 * strict. `ensureSessionRecovery` (`session-recovery.ts:652`) has to clear all
 * three of these before a wake happens:
 *
 * 1. `loadRecoveryContext` (`:103`) — keyed on `chat_session_id`; requires
 *    `snapshot.workspace_id` to be non-null, the `workspaces` row it names to
 *    still EXIST, and that row's `user_id` to match the snapshot's. It does NOT
 *    look at `workspaces.status`, so a `deleted` workspace row is wakeable.
 * 2. the runtime gate (`:663`) — a `cf-container` snapshot returns
 *    `container_runtime_wakes_in_place`, but that path
 *    (`vm-prompt-delivery-adapter.ts:197`) also resolves its target from the
 *    workspace row, so requirement 1 binds every runtime alike.
 * 3. `claimSessionSnapshotRecovery`
 *    (`session-snapshot-recovery-lifecycle.ts:228`) — keyed on
 *    `chat_session_id` + `user_id` and **never mentions `workspace_id`**;
 *    requires `sleeping_at`, a restorable `status`/`degradation` pair, an
 *    unexpired `expires_at`, and an available wake-attempt budget.
 *
 * The chat-session keying in (1) and (3) is why the loader below is keyed by
 * chat session rather than by workspace. Production evidence from 2026-09-13
 * (`sam-prod`): 32 conversations were failed by the runaway-cost ceiling while
 * holding a `sleeping`, restorable, unexpired snapshot whose workspace row was
 * merely `deleted` — every one of them wakeable, and every one shown a red
 * "Task failed". A workspace-keyed read could not even find those rows once
 * `session_snapshots.workspace_id`'s `ON DELETE SET NULL` had fired
 * (`.claude/rules/63`).
 */
import type { SessionResumabilitySnapshot } from './task-runtime-liveness-types';

import { isRestorableSnapshot } from './session-snapshot-artifacts';
import { sessionRecoveryBudgetAvailable } from './session-snapshot-recovery-budget';

/** `session_snapshots.sleep_status` value meaning "asleep right now". */
export const SLEEPING_SLEEP_STATUS = 'sleeping';

/**
 * `session_snapshots.sleep_status` value meaning "awake, with a sleep due".
 *
 * The sleep lifecycle owns the session in this state and will move it to
 * `sleeping`, `failed`, or `terminal_failed`. Destroying it mid-flight both
 * mislabels a live conversation and races the snapshot capture, so it is
 * preserved — bounded, like every other preserve here, by `expires_at`.
 */
export const SCHEDULED_SLEEP_STATUS = 'scheduled';

/** Why the resumer would refuse this conversation, permanently. */
export type SessionUnwakeableReason =
  /** No snapshot row: a user delete destroys it, so this is genuine death. */
  | 'no_snapshot'
  /** The row belongs to another project or chat session. */
  | 'scope_mismatch'
  /** `loadRecoveryContext` requires the workspace row; it is gone. */
  | 'runtime_workspace_missing'
  /** The session already woke — every wake path clears `sleep_status`. */
  | 'already_awake'
  /** `restorableSnapshotCondition()` refuses this status/degradation pair. */
  | 'snapshot_not_restorable'
  /** Past `expires_at`, or the bound is absent/unparseable. */
  | 'snapshot_expired'
  /** Budget spent with no clean failure anchor, so it can never decay. */
  | 'wake_budget_cannot_decay';

/** Why the resumer would refuse right now, but not for much longer. */
export type SessionWakeRetryReason = 'wake_attempt_budget' | 'sleep_in_progress';

/**
 * Whether a wake can still be authorized for this conversation.
 *
 *  - `resumable`     — every predicate the resumer enforces holds right now.
 *  - `retry_pending` — the resumer refuses right now, but only on a refusal that
 *                      releases itself within a bounded window. Inconclusive.
 *  - `unwakeable`    — the resumer's refusal is permanent for this snapshot.
 *
 * The `retry_pending` case is the correction this type exists for. The previous
 * predicate mirrored the resumer *at one instant*, justified by "a snapshot the
 * resumer would refuse must terminalize, or the task waits out the full snapshot
 * TTL for a wake that can never happen". That argument holds for a permanent
 * refusal. It does not hold for the wake-attempt budget, whose refusal is
 * released by `SESSION_SNAPSHOT_RECOVERY_ATTEMPT_DECAY_MS` (default 15 minutes),
 * not by the TTL. Production on 2026-09-13 shows three tasks terminalized 0, 1
 * and 3 minutes after `recovery_failed_at` — inside a window the resumer would
 * have reopened minutes later, after which `sourceTaskGuardCondition` refused
 * every guarded wake for those conversations forever. A destroyer is
 * irreversible; a resumer retries. When they disagree only about *timing*, the
 * destroyer waits.
 */
export type SessionWakeability =
  | { kind: 'resumable' }
  | { kind: 'retry_pending'; reason: SessionWakeRetryReason }
  | { kind: 'unwakeable'; reason: SessionUnwakeableReason };

export interface SessionWakeabilityBudget {
  maxRecoveryAttempts: number;
  recoveryAttemptDecayMs: number;
  nowMs: number;
}

/**
 * Classify one snapshot row against the resumer's full predicate set.
 *
 * Ordered so the most specific permanent refusal wins, and so a refusal that is
 * merely temporal is never mistaken for one that is permanent.
 */
export function classifySessionWakeability(
  snapshot: SessionResumabilitySnapshot | null,
  scope: { projectId: string; chatSessionId: string },
  budget: SessionWakeabilityBudget
): SessionWakeability {
  // A user-initiated delete destroys the row entirely
  // (`session-snapshot-persistence.ts:deleteSessionSnapshotState`), so absence is
  // the discriminator between "slept" and "destroyed" (`.claude/rules/58` req 5).
  if (!snapshot) return { kind: 'unwakeable', reason: 'no_snapshot' };
  // Defence in depth: the loader is already scoped in SQL, so these are the
  // in-memory half of the pair `.claude/rules/28` wants. Deliberately NOT scoped
  // to a workspace id — see the file header; the resumer is not, and the column
  // is nulled by the very deletion this guard must survive.
  if (snapshot.projectId !== scope.projectId) {
    return { kind: 'unwakeable', reason: 'scope_mismatch' };
  }
  if (snapshot.chatSessionId !== scope.chatSessionId) {
    return { kind: 'unwakeable', reason: 'scope_mismatch' };
  }

  // `loadRecoveryContext` requirement. Mirrored because being LOOSER than the
  // resumer is its own failure (`.claude/rules/58` req 2): preserving a session
  // the wake path will never accept only hangs the task until `expires_at`
  // instead of retiring it. 36 of 278 sleeping VM snapshots in production are in
  // this state; that is tracked as a wake-path defect in SAM idea
  // 01M2CQD1FK7YA96VD6Q74302K0, and this predicate must report today's truth,
  // not the truth we would prefer. If that fix removes the workspace-row
  // requirement from `loadRecoveryContext`, this mirror must be relaxed in the
  // same PR or the sweep will keep retiring sessions the resumer could wake.
  if (!snapshot.recoveryWorkspacePresent) {
    return { kind: 'unwakeable', reason: 'runtime_workspace_missing' };
  }

  // An absent or unparseable expiry is treated as NOT wakeable so a corrupt row
  // can never make a task immortal (`.claude/rules/47` bounded escape).
  if (snapshot.expiresAtMs === null || snapshot.expiresAtMs <= budget.nowMs) {
    return { kind: 'unwakeable', reason: 'snapshot_expired' };
  }

  // Mirrors `restorableSnapshotCondition()` in the claim's WHERE clause.
  if (!isRestorableSnapshot(snapshot.status, snapshot.degradation)) {
    return { kind: 'unwakeable', reason: 'snapshot_not_restorable' };
  }

  // A session scheduled to sleep has not been captured yet, so it has no
  // `sleeping_at` and the claim would refuse it — but the sleep lifecycle is
  // actively moving it to a state that IS claimable. Bounded by `expires_at`
  // above and by the sleep lifecycle's own terminal statuses (`failed`,
  // `terminal_failed`), which fall through to `already_awake` below.
  if (snapshot.sleepStatus === SCHEDULED_SLEEP_STATUS) {
    return { kind: 'retry_pending', reason: 'sleep_in_progress' };
  }

  // `sleeping_at` is the claim's own predicate. A session that already woke
  // clears both it and `sleep_status` (`markSessionSnapshotAwakeInPlace`,
  // `completeSessionSnapshotRecovery`), so this is the belt-and-braces pair.
  if (snapshot.sleepingAt === null || snapshot.sleepStatus !== SLEEPING_SLEEP_STATUS) {
    return { kind: 'unwakeable', reason: 'already_awake' };
  }

  if (
    !sessionRecoveryBudgetAvailable({
      recoveryAttempts: snapshot.recoveryAttempts,
      recoveryFailedAtMs: snapshot.recoveryFailedAtMs,
      maxAttempts: budget.maxRecoveryAttempts,
      decayMs: budget.recoveryAttemptDecayMs,
      nowMs: budget.nowMs,
    })
  ) {
    // A spent budget is released only by a CLEAN failure report older than the
    // decay window. With a finite anchor the release is scheduled, so this is a
    // timing disagreement and the destroyer waits. Without one — a wake that
    // crashed or is still leased — the budget never decays on its own, so the
    // refusal is permanent as far as this predicate can tell and the bounded
    // escape must fire (`.claude/rules/47`).
    return snapshot.recoveryFailedAtMs === null
      ? { kind: 'unwakeable', reason: 'wake_budget_cannot_decay' }
      : { kind: 'retry_pending', reason: 'wake_attempt_budget' };
  }

  return { kind: 'resumable' };
}

/**
 * Load the records the resumer reads, in one query.
 *
 * `idx_session_snapshots_chat_session_id` is UNIQUE, so the snapshot half is a
 * point lookup; the join is on `workspaces.id`, its primary key. Project-scoped
 * per `.claude/rules/11` — production evidence confirms
 * `session_snapshots.project_id` survives the workspace deletion that nulls the
 * workspace column, so the scope check costs nothing here.
 *
 * The join exists because `loadRecoveryContext` requires the workspace ROW, and
 * a destroyer that skipped it would preserve conversations the wake path will
 * never accept (`.claude/rules/58` req 2).
 */
export async function loadSessionWakeabilitySnapshot(
  db: D1Database,
  projectId: string,
  chatSessionId: string
): Promise<SessionResumabilitySnapshot | null> {
  const row = await db
    .prepare(
      `SELECT s.chat_session_id, s.project_id, s.workspace_id, s.sleeping_at, s.sleep_status,
            s.expires_at, s.status, s.degradation, s.recovery_attempts, s.recovery_failed_at,
            w.id AS runtime_workspace_id, w.user_id AS runtime_workspace_user_id, s.user_id
     FROM session_snapshots s
     LEFT JOIN workspaces w ON w.id = s.workspace_id
     WHERE s.chat_session_id = ? AND s.project_id = ?
     LIMIT 1`
    )
    .bind(chatSessionId, projectId)
    .first<{
      chat_session_id: string;
      project_id: string | null;
      workspace_id: string | null;
      sleeping_at: string | null;
      sleep_status: string | null;
      expires_at: string | null;
      status: string | null;
      degradation: string | null;
      recovery_attempts: number | null;
      recovery_failed_at: string | null;
      runtime_workspace_id: string | null;
      runtime_workspace_user_id: string | null;
      user_id: string | null;
    }>();
  if (!row) return null;

  return {
    chatSessionId: row.chat_session_id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    // `loadRecoveryContext` requires all three: a non-null snapshot workspace,
    // the row it names, and matching ownership.
    recoveryWorkspacePresent:
      row.workspace_id !== null &&
      row.runtime_workspace_id !== null &&
      row.runtime_workspace_user_id === row.user_id,
    sleepingAt: parseTimestamp(row.sleeping_at),
    sleepStatus: row.sleep_status,
    expiresAtMs: parseTimestamp(row.expires_at),
    status: row.status,
    degradation: row.degradation,
    // NOT NULL DEFAULT 0 in schema; coalesce defensively so a null can never
    // read as "attempts remaining" via NaN comparison.
    recoveryAttempts: row.recovery_attempts ?? 0,
    recoveryFailedAtMs: parseTimestamp(row.recovery_failed_at),
  };
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
