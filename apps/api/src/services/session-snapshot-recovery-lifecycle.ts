import { and, eq, gt, gte, isNotNull, isNull, lt, lte, not, or, sql } from 'drizzle-orm';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import type { SessionRecoverySourceTaskGuard } from './session-recovery-authority';
import { reconcileSessionRecoveryBindingFailure } from './session-recovery-binding-failure';
import {
  isRestorableSnapshot,
  type SessionSnapshotRecoveryClaim,
} from './session-snapshot-artifacts';
import {
  sessionRecoveryAttemptDecayMs,
  sessionRecoveryAttemptsAfterClaim,
  sessionRecoveryBudgetAvailable,
  sessionRecoveryBudgetAvailableSql,
  sessionRecoveryBudgetCondition,
  sessionRecoveryDecayCutoffIso,
  sessionRecoveryMaxAttempts,
} from './session-snapshot-recovery-budget';
import {
  archiveMigrationFenceCondition,
  type Db,
  isLiveWakeTaskStatus,
  restorableSnapshotCondition,
  sessionRecoveryClaimLeaseMs,
} from './session-snapshot-recovery-conditions';
import {
  sourceTaskGuardCondition,
  sourceTaskGuardIsValid,
} from './session-snapshot-recovery-source-guard';

async function archiveMigrationFenceIsClear(db: Db, chatSessionId: string): Promise<boolean> {
  const row = await db
    .select({ sessionId: schema.projectDataSessionLocations.sessionId })
    .from(schema.projectDataSessionLocations)
    .where(
      and(
        eq(schema.projectDataSessionLocations.sessionId, chatSessionId),
        not(eq(schema.projectDataSessionLocations.locationState, 'root'))
      )
    )
    .limit(1)
    .get();
  return !row;
}

/** The in-memory half, for diagnosing why a claim was refused. */
function budgetAvailable(
  snapshot: { recoveryAttempts: number; recoveryFailedAt: string | null },
  maxAttempts: number,
  decayMs: number,
  nowMs: number
): boolean {
  const failedAtMs = snapshot.recoveryFailedAt ? Date.parse(snapshot.recoveryFailedAt) : NaN;
  return sessionRecoveryBudgetAvailable({
    recoveryAttempts: snapshot.recoveryAttempts,
    recoveryFailedAtMs: Number.isFinite(failedAtMs) ? failedAtMs : null,
    maxAttempts,
    decayMs,
    nowMs,
  });
}

type SessionSnapshotRecoveryClaimInput = {
  chatSessionId: string;
  userId: string;
  taskId: string;
  recoveryAttemptId?: string;
  now?: Date;
  sourceTaskGuard?: SessionRecoverySourceTaskGuard;
  /** Automatic eviction callbacks and cron retries share one non-decaying budget. */
  automaticEvictionRecovery?: boolean;
};

export function claimSessionSnapshotRecovery(
  db: Db,
  env: Env,
  input: SessionSnapshotRecoveryClaimInput
): Promise<SessionSnapshotRecoveryClaim> {
  return claimOnce(db, env, input, true);
}

async function claimOnce(
  db: Db,
  env: Env,
  input: SessionSnapshotRecoveryClaimInput,
  mayRetry: boolean
): Promise<SessionSnapshotRecoveryClaim> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const maxAttempts = sessionRecoveryMaxAttempts(env);
  const decayMs = sessionRecoveryAttemptDecayMs(env);
  const decayCutoff = sessionRecoveryDecayCutoffIso(env, now.getTime());
  const nonDecaying =
    input.automaticEvictionRecovery || Boolean(input.sourceTaskGuard?.evictionRecoveryRetry);
  const claimBudgetCondition = nonDecaying
    ? lt(schema.sessionSnapshots.recoveryAttempts, maxAttempts)
    : sessionRecoveryBudgetCondition(maxAttempts, decayCutoff);
  const claimBudgetAvailable = (snapshot: {
    recoveryAttempts: number;
    recoveryFailedAt: string | null;
  }) =>
    nonDecaying
      ? snapshot.recoveryAttempts < maxAttempts
      : budgetAvailable(snapshot, maxAttempts, decayMs, now.getTime());
  // Read before the claim clears the anchor, so the warn below can describe the
  // burst that just decayed. Scoped to the same session+user as the claim.
  const priorBurstSpent = await db
    .select({
      recoveryAttempts: schema.sessionSnapshots.recoveryAttempts,
      recoveryFailedAt: schema.sessionSnapshots.recoveryFailedAt,
    })
    .from(schema.sessionSnapshots)
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId),
        eq(schema.sessionSnapshots.userId, input.userId),
        gte(schema.sessionSnapshots.recoveryAttempts, maxAttempts),
        isNotNull(schema.sessionSnapshots.recoveryFailedAt),
        lte(schema.sessionSnapshots.recoveryFailedAt, decayCutoff)
      )
    )
    .get();
  const result = await db
    .update(schema.sessionSnapshots)
    .set({
      recoveryStatus: 'waking',
      recoveryTaskId: input.taskId,
      recoveryAttemptId: input.recoveryAttemptId ?? null,
      // A claim taken under the decayed budget starts a NEW burst rather than
      // continuing the spent one, so the cap still bounds `maxAttempts` failures
      // per window. `recovery_failed_at` is cleared in the same statement: leaving
      // it would make every later claim look decayed and remove the cap entirely.
      recoveryAttempts: nonDecaying
        ? sql`${schema.sessionSnapshots.recoveryAttempts} + 1`
        : sessionRecoveryAttemptsAfterClaim(decayCutoff),
      recoveryError: null,
      recoveryFailedAt: null,
      recoveryClaimedAt: nowIso,
      updatedAt: nowIso,
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId),
        eq(schema.sessionSnapshots.userId, input.userId),
        restorableSnapshotCondition(),
        isNotNull(schema.sessionSnapshots.sleepingAt),
        gt(schema.sessionSnapshots.expiresAt, now.toISOString()),
        claimBudgetCondition,
        or(
          isNull(schema.sessionSnapshots.recoveryStatus),
          eq(schema.sessionSnapshots.recoveryStatus, 'failed')
        ),
        archiveMigrationFenceCondition(db, input.chatSessionId),
        sourceTaskGuardCondition(db, input.sourceTaskGuard)
      )
    );
  if ((result.meta.changes ?? 0) > 0) {
    // A restarted burst means this session has already failed `maxAttempts`
    // wakes and is being given a fresh window. That is the intended behaviour,
    // but a session doing it repeatedly is burning real provisioning attempts
    // on something that may never restore, and nothing else surfaces it
    // (`.claude/rules/47` operator visibility).
    if (priorBurstSpent && !nonDecaying) {
      log.warn('session_recovery.attempt_budget_burst_restarted', {
        chatSessionId: input.chatSessionId,
        taskId: input.taskId,
        priorAttempts: priorBurstSpent.recoveryAttempts,
        lastFailedAt: priorBurstSpent.recoveryFailedAt,
        maxAttempts,
        decayMs,
      });
    }
    return { status: 'claimed', taskId: input.taskId };
  }

  const [snapshot] = await db
    .select({
      status: schema.sessionSnapshots.status,
      degradation: schema.sessionSnapshots.degradation,
      expiresAt: schema.sessionSnapshots.expiresAt,
      recoveryStatus: schema.sessionSnapshots.recoveryStatus,
      recoveryTaskId: schema.sessionSnapshots.recoveryTaskId,
      recoveryAttemptId: schema.sessionSnapshots.recoveryAttemptId,
      recoveryAttempts: schema.sessionSnapshots.recoveryAttempts,
      recoveryFailedAt: schema.sessionSnapshots.recoveryFailedAt,
      recoveryClaimedAt: schema.sessionSnapshots.recoveryClaimedAt,
    })
    .from(schema.sessionSnapshots)
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId),
        eq(schema.sessionSnapshots.userId, input.userId)
      )
    )
    .limit(1);
  if (snapshot?.recoveryStatus === 'waking' && snapshot.recoveryTaskId) {
    if (!(await sourceTaskGuardIsValid(db, input.sourceTaskGuard))) {
      return { status: 'unavailable', reason: 'source_task_not_wakeable' };
    }
    const staleBefore = new Date(now.getTime() - sessionRecoveryClaimLeaseMs(env)).toISOString();
    const claimIsStale = !snapshot.recoveryClaimedAt || snapshot.recoveryClaimedAt <= staleBefore;
    if (!claimIsStale) return { status: 'waking', taskId: snapshot.recoveryTaskId };

    const recoveryTask = await db
      .select({ status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, snapshot.recoveryTaskId))
      .get();
    if (recoveryTask && isLiveWakeTaskStatus(recoveryTask.status)) {
      await db
        .update(schema.sessionSnapshots)
        .set({ recoveryClaimedAt: nowIso, updatedAt: nowIso })
        .where(
          and(
            eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId),
            eq(schema.sessionSnapshots.recoveryStatus, 'waking'),
            eq(schema.sessionSnapshots.recoveryTaskId, snapshot.recoveryTaskId)
          )
        );
      return { status: 'waking', taskId: snapshot.recoveryTaskId };
    }
    // Reconstruct only for ordinary continuation. Automated source-guarded wakes
    // retain their existing authority path and never mutate this missing anchor.
    if (
      !input.sourceTaskGuard &&
      recoveryTask?.status === 'sleeping' &&
      snapshot.recoveryAttemptId &&
      !snapshot.recoveryFailedAt
    ) {
      snapshot.recoveryFailedAt = await reconcileSessionRecoveryBindingFailure(env.DATABASE, {
        chatSessionId: input.chatSessionId,
        userId: input.userId,
        taskId: snapshot.recoveryTaskId,
        recoveryAttemptId: snapshot.recoveryAttemptId,
        staleBefore,
        now: nowIso,
      });
    }
    if (claimBudgetAvailable(snapshot)) {
      const reclaimed = await db
        .update(schema.sessionSnapshots)
        .set({
          recoveryTaskId: input.taskId,
          recoveryAttemptId: input.recoveryAttemptId ?? null,
          recoveryAttempts: nonDecaying
            ? sql`${schema.sessionSnapshots.recoveryAttempts} + 1`
            : sessionRecoveryAttemptsAfterClaim(decayCutoff),
          recoveryClaimedAt: nowIso,
          recoveryError: null,
          recoveryFailedAt: null,
          updatedAt: nowIso,
        })
        .where(
          and(
            eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId),
            eq(schema.sessionSnapshots.recoveryStatus, 'waking'),
            eq(schema.sessionSnapshots.recoveryTaskId, snapshot.recoveryTaskId),
            or(
              isNull(schema.sessionSnapshots.recoveryClaimedAt),
              lte(schema.sessionSnapshots.recoveryClaimedAt, staleBefore)
            ),
            claimBudgetCondition,
            archiveMigrationFenceCondition(db, input.chatSessionId),
            sourceTaskGuardCondition(db, input.sourceTaskGuard)
          )
        );
      if ((reclaimed.meta.changes ?? 0) > 0) {
        return { status: 'claimed', taskId: input.taskId };
      }
      const winner = await db
        .select({
          taskId: schema.sessionSnapshots.recoveryTaskId,
          recoveryStatus: schema.sessionSnapshots.recoveryStatus,
        })
        .from(schema.sessionSnapshots)
        .where(eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId))
        .get();
      if (winner?.recoveryStatus === 'waking' && winner.taskId) {
        return { status: 'waking', taskId: winner.taskId };
      }
      // The dead-wake sweep (`scheduled/session-wake-claim-reconciliation.ts`) ended the
      // stale claim between our read and our re-claim. The row is claimable again, so
      // reporting `waking` would point the caller at a dead task. Claim once more.
      if (mayRetry) return claimOnce(db, env, input, false);
    }
  }
  if (!snapshot) return { status: 'unavailable', reason: 'snapshot_missing' };
  if (Date.parse(snapshot.expiresAt) <= now.getTime()) {
    return { status: 'unavailable', reason: 'snapshot_expired' };
  }
  if (!isRestorableSnapshot(snapshot.status, snapshot.degradation)) {
    return { status: 'unavailable', reason: 'snapshot_not_complete' };
  }
  if (!claimBudgetAvailable(snapshot)) {
    return { status: 'unavailable', reason: 'recovery_attempts_exhausted' };
  }
  if (!(await archiveMigrationFenceIsClear(db, input.chatSessionId))) {
    return { status: 'unavailable', reason: 'archive_migration_fenced' };
  }
  if (!(await sourceTaskGuardIsValid(db, input.sourceTaskGuard))) {
    return { status: 'unavailable', reason: 'source_task_not_wakeable' };
  }
  return { status: 'unavailable', reason: 'snapshot_not_wakeable' };
}

export async function hasRestorableSleepingSessionSnapshot(
  database: D1Database,
  env: Pick<
    Env,
    'SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS' | 'SESSION_SNAPSHOT_RECOVERY_ATTEMPT_DECAY_MS'
  >,
  input: {
    projectId: string;
    workspaceId: string;
    chatSessionId: string;
    now?: Date;
  }
): Promise<boolean> {
  const now = input.now ?? new Date();
  const maxAttempts = sessionRecoveryMaxAttempts(env);
  const row = await database
    .prepare(
      `SELECT 1 AS found
         FROM session_snapshots
        WHERE chat_session_id = ?
          AND project_id = ?
          AND workspace_id = ?
          AND sleeping_at IS NOT NULL
          AND sleep_status = 'sleeping'
          AND expires_at > ?
          AND ${sessionRecoveryBudgetAvailableSql('session_snapshots')}
          AND (
            (status = 'available' AND degradation = 'none')
            OR (status = 'degraded' AND degradation IS NOT NULL AND degradation != 'none')
          )
        LIMIT 1`
    )
    .bind(
      input.chatSessionId,
      input.projectId,
      input.workspaceId,
      now.toISOString(),
      maxAttempts,
      sessionRecoveryDecayCutoffIso(env, now.getTime())
    )
    .first<{ found: number }>();
  return Boolean(row);
}

export async function hasAuthorizedRestorableSnapshotWakeClaim(
  database: D1Database,
  input: {
    projectId: string;
    chatSessionId: string;
    workspaceId: string;
    taskId: string;
    recoveryAttemptId?: string | null;
    now?: Date;
  }
): Promise<boolean> {
  const now = input.now ?? new Date();
  const row = await database
    .prepare(
      `SELECT 1 AS found
         FROM session_snapshots snapshot
         JOIN tasks recovery
           ON recovery.id = ?
          AND recovery.project_id = snapshot.project_id
          AND recovery.user_id = snapshot.user_id
          AND recovery.workspace_id = ?
          AND recovery.status NOT IN ('completed', 'failed', 'cancelled')
         JOIN workspaces replacement
           ON replacement.id = ?
          AND replacement.id = recovery.workspace_id
          AND replacement.id = snapshot.recovery_workspace_id
          AND replacement.project_id = snapshot.project_id
          AND replacement.user_id = snapshot.user_id
          AND replacement.status IN ('creating', 'running', 'recovery', 'error')
        WHERE snapshot.chat_session_id = ?
          AND snapshot.project_id = ?
          AND snapshot.recovery_task_id = ?
          AND (? IS NULL OR snapshot.recovery_attempt_id = ?)
          AND recovery.chat_session_id = snapshot.chat_session_id
          AND replacement.chat_session_id = snapshot.chat_session_id
          AND snapshot.recovery_status IN ('waking', 'restored')
          AND snapshot.sleeping_at IS NOT NULL
          AND snapshot.sleep_status = 'sleeping'
          AND snapshot.expires_at > ? AND julianday(snapshot.expires_at) IS NOT NULL
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
    .bind(
      input.taskId,
      input.workspaceId,
      input.workspaceId,
      input.chatSessionId,
      input.projectId,
      input.taskId,
      input.recoveryAttemptId ?? null,
      input.recoveryAttemptId ?? null,
      now.toISOString()
    )
    .first<{ found: number }>();
  return Boolean(row);
}
