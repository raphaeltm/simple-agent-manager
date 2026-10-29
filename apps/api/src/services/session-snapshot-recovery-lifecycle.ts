import {
  and,
  eq,
  exists,
  gt,
  gte,
  isNotNull,
  isNull,
  lt,
  lte,
  not,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import type { SessionRecoverySourceTaskGuard } from './session-recovery-authority';
import { reconcileSessionRecoveryBindingFailure } from './session-recovery-binding-failure';
import {
  DEFAULT_SESSION_SNAPSHOT_RECOVERY_CLAIM_LEASE_MS,
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
  restorableSnapshotCondition,
  TERMINAL_TASK_STATUSES,
} from './session-snapshot-recovery-conditions';

function sourceTaskGuardCondition(db: Db, guard: SessionRecoverySourceTaskGuard | undefined) {
  if (!guard) return undefined;
  const sourceTask = alias(schema.tasks, 'recovery_source_task');
  const recoveryOwner = alias(schema.tasks, 'recovery_session_owner');
  const markedSuccessor = alias(schema.tasks, 'recovery_marked_successor');
  const sourceIsWakeable = or(
    notInArray(sourceTask.status, TERMINAL_TASK_STATUSES),
    and(
      eq(sourceTask.status, 'cancelled'),
      isNotNull(sourceTask.supersededByTaskId),
      exists(
        db
          .select({ id: markedSuccessor.id })
          .from(markedSuccessor)
          .where(
            and(
              eq(markedSuccessor.id, sourceTask.supersededByTaskId),
              eq(markedSuccessor.projectId, guard.projectId),
              eq(markedSuccessor.chatSessionId, guard.chatSessionId),
              eq(markedSuccessor.triggeredBy, 'session-recovery'),
              notInArray(markedSuccessor.status, TERMINAL_TASK_STATUSES)
            )
          )
      )
    )
  );
  return exists(
    db
      .select({ id: sourceTask.id })
      .from(sourceTask)
      .where(
        and(
          eq(sourceTask.id, guard.taskId),
          eq(sourceTask.projectId, guard.projectId),
          ...(guard.evictionRecoveryRetry
            ? [
                eq(sourceTask.status, 'sleeping'),
                eq(sourceTask.userId, schema.sessionSnapshots.userId),
                eq(sourceTask.chatSessionId, guard.chatSessionId),
                eq(schema.sessionSnapshots.projectId, guard.projectId),
                eq(schema.sessionSnapshots.recoveryStatus, 'failed'),
                eq(schema.sessionSnapshots.recoveryTaskId, guard.taskId),
                eq(
                  schema.sessionSnapshots.recoveryAttemptId,
                  guard.evictionRecoveryRetry.recoveryAttemptId
                ),
                eq(schema.sessionSnapshots.workspaceId, guard.evictionRecoveryRetry.workspaceId),
                eq(
                  schema.sessionSnapshots.evictionRecoveryWorkspaceId,
                  guard.evictionRecoveryRetry.workspaceId
                ),
                eq(
                  schema.sessionSnapshots.evictionRecoveryNodeId,
                  guard.evictionRecoveryRetry.nodeId
                ),
                sql`${schema.sessionSnapshots.evictionRecoveryGeneration} IS ${guard.evictionRecoveryRetry.generation}`,
                lt(
                  schema.sessionSnapshots.recoveryAttempts,
                  guard.evictionRecoveryRetry.maxAttempts
                ),
                sql`EXISTS (SELECT 1 FROM workspaces eviction_source
                  WHERE eviction_source.id = ${guard.evictionRecoveryRetry.workspaceId}
                    AND eviction_source.node_id = ${guard.evictionRecoveryRetry.nodeId}
                    AND eviction_source.eviction_generation IS ${guard.evictionRecoveryRetry.generation}
                    AND eviction_source.status = 'evicted'
                    AND eviction_source.user_id = ${schema.sessionSnapshots.userId}
                    AND eviction_source.project_id = ${schema.sessionSnapshots.projectId}
                    AND (eviction_source.chat_session_id IS NULL OR eviction_source.chat_session_id = ${schema.sessionSnapshots.chatSessionId}))`,
              ]
            : []),
          sourceIsWakeable,
          or(
            eq(sourceTask.chatSessionId, guard.chatSessionId),
            exists(
              db
                .select({ id: recoveryOwner.id })
                .from(recoveryOwner)
                .where(
                  and(
                    eq(recoveryOwner.recoverySourceTaskId, sourceTask.id),
                    eq(recoveryOwner.projectId, guard.projectId),
                    eq(recoveryOwner.chatSessionId, guard.chatSessionId),
                    eq(recoveryOwner.triggeredBy, 'session-recovery'),
                    notInArray(recoveryOwner.status, TERMINAL_TASK_STATUSES)
                  )
                )
            )
          )
        )
      )
  );
}

async function sourceTaskGuardIsValid(
  db: Db,
  guard: SessionRecoverySourceTaskGuard | undefined
): Promise<boolean> {
  if (!guard) return true;
  const recoveryOwner = alias(schema.tasks, 'recovery_session_owner');
  const markedSuccessor = alias(schema.tasks, 'recovery_marked_successor');
  const sourceIsWakeable = or(
    notInArray(schema.tasks.status, TERMINAL_TASK_STATUSES),
    and(
      eq(schema.tasks.status, 'cancelled'),
      isNotNull(schema.tasks.supersededByTaskId),
      exists(
        db
          .select({ id: markedSuccessor.id })
          .from(markedSuccessor)
          .where(
            and(
              eq(markedSuccessor.id, schema.tasks.supersededByTaskId),
              eq(markedSuccessor.projectId, guard.projectId),
              eq(markedSuccessor.chatSessionId, guard.chatSessionId),
              eq(markedSuccessor.triggeredBy, 'session-recovery'),
              notInArray(markedSuccessor.status, TERMINAL_TASK_STATUSES)
            )
          )
      )
    )
  );
  const row = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.id, guard.taskId),
        eq(schema.tasks.projectId, guard.projectId),
        sourceIsWakeable,
        or(
          eq(schema.tasks.chatSessionId, guard.chatSessionId),
          exists(
            db
              .select({ id: recoveryOwner.id })
              .from(recoveryOwner)
              .where(
                and(
                  eq(recoveryOwner.recoverySourceTaskId, guard.taskId),
                  eq(recoveryOwner.projectId, guard.projectId),
                  eq(recoveryOwner.chatSessionId, guard.chatSessionId),
                  eq(recoveryOwner.triggeredBy, 'session-recovery'),
                  notInArray(recoveryOwner.status, TERMINAL_TASK_STATUSES)
                )
              )
          )
        )
      )
    )
    .get();
  return Boolean(row);
}

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

function sessionRecoveryClaimLeaseMs(env: Env): number {
  return parsePositiveInt(
    env.SESSION_SNAPSHOT_RECOVERY_CLAIM_LEASE_MS,
    DEFAULT_SESSION_SNAPSHOT_RECOVERY_CLAIM_LEASE_MS
  );
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

export async function claimSessionSnapshotRecovery(
  db: Db,
  env: Env,
  input: {
    chatSessionId: string;
    userId: string;
    taskId: string;
    recoveryAttemptId?: string;
    now?: Date;
    sourceTaskGuard?: SessionRecoverySourceTaskGuard;
    /** Automatic eviction callbacks and cron retries share one non-decaying budget. */
    automaticEvictionRecovery?: boolean;
  }
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
    if (
      recoveryTask &&
      ['queued', 'delegated', 'in_progress', 'awaiting_followup'].includes(recoveryTask.status)
    ) {
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
        .select({ taskId: schema.sessionSnapshots.recoveryTaskId })
        .from(schema.sessionSnapshots)
        .where(eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId))
        .get();
      if (winner?.taskId) return { status: 'waking', taskId: winner.taskId };
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
