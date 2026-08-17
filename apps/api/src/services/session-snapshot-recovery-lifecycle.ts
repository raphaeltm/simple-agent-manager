import {
  and,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { alias } from 'drizzle-orm/sqlite-core';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import type { SessionRecoverySourceTaskGuard } from './session-recovery-authority';
import {
  DEFAULT_SESSION_SNAPSHOT_RECOVERY_CLAIM_LEASE_MS,
  DEFAULT_SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS,
  isRestorableSnapshot,
  sessionLifecycleError,
  type SessionSnapshotRecoveryClaim,
} from './session-snapshot-artifacts';

type Db = ReturnType<typeof drizzle<typeof schema>>;

const TERMINAL_TASK_STATUSES = ['completed', 'failed', 'cancelled'];

function sourceTaskGuardCondition(db: Db, guard: SessionRecoverySourceTaskGuard | undefined) {
  if (!guard) return undefined;
  const sourceTask = alias(schema.tasks, 'recovery_source_task');
  const recoveryOwner = alias(schema.tasks, 'recovery_session_owner');
  return exists(
    db
      .select({ id: sourceTask.id })
      .from(sourceTask)
      .where(
        and(
          eq(sourceTask.id, guard.taskId),
          eq(sourceTask.projectId, guard.projectId),
          notInArray(sourceTask.status, TERMINAL_TASK_STATUSES),
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
  const row = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.id, guard.taskId),
        eq(schema.tasks.projectId, guard.projectId),
        notInArray(schema.tasks.status, TERMINAL_TASK_STATUSES),
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

function restorableSnapshotCondition() {
  return or(
    and(
      eq(schema.sessionSnapshots.status, 'available'),
      eq(schema.sessionSnapshots.degradation, 'none')
    ),
    and(
      eq(schema.sessionSnapshots.status, 'degraded'),
      isNotNull(schema.sessionSnapshots.degradation),
      sql`${schema.sessionSnapshots.degradation} != 'none'`
    )
  );
}

function sessionRecoveryClaimLeaseMs(env: Env): number {
  return parsePositiveInt(
    env.SESSION_SNAPSHOT_RECOVERY_CLAIM_LEASE_MS,
    DEFAULT_SESSION_SNAPSHOT_RECOVERY_CLAIM_LEASE_MS
  );
}

export async function claimSessionSnapshotRecovery(
  db: Db,
  env: Env,
  input: {
    chatSessionId: string;
    userId: string;
    taskId: string;
    now?: Date;
    sourceTaskGuard?: SessionRecoverySourceTaskGuard;
  }
): Promise<SessionSnapshotRecoveryClaim> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const maxAttempts = parsePositiveInt(
    env.SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS,
    DEFAULT_SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS
  );
  const result = await db
    .update(schema.sessionSnapshots)
    .set({
      recoveryStatus: 'waking',
      recoveryTaskId: input.taskId,
      recoveryAttempts: sql`${schema.sessionSnapshots.recoveryAttempts} + 1`,
      recoveryError: null,
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
        lt(schema.sessionSnapshots.recoveryAttempts, maxAttempts),
        or(
          isNull(schema.sessionSnapshots.recoveryStatus),
          eq(schema.sessionSnapshots.recoveryStatus, 'failed')
        ),
        sourceTaskGuardCondition(db, input.sourceTaskGuard)
      )
    );
  if ((result.meta.changes ?? 0) > 0) {
    return { status: 'claimed', taskId: input.taskId };
  }

  const [snapshot] = await db
    .select({
      status: schema.sessionSnapshots.status,
      degradation: schema.sessionSnapshots.degradation,
      expiresAt: schema.sessionSnapshots.expiresAt,
      recoveryStatus: schema.sessionSnapshots.recoveryStatus,
      recoveryTaskId: schema.sessionSnapshots.recoveryTaskId,
      recoveryAttempts: schema.sessionSnapshots.recoveryAttempts,
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
    if (snapshot.recoveryAttempts < maxAttempts) {
      const reclaimed = await db
        .update(schema.sessionSnapshots)
        .set({
          recoveryTaskId: input.taskId,
          recoveryAttempts: sql`${schema.sessionSnapshots.recoveryAttempts} + 1`,
          recoveryClaimedAt: nowIso,
          recoveryError: null,
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
            lt(schema.sessionSnapshots.recoveryAttempts, maxAttempts),
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
  const reason = !snapshot
    ? 'snapshot_missing'
    : Date.parse(snapshot.expiresAt) <= now.getTime()
      ? 'snapshot_expired'
      : !isRestorableSnapshot(snapshot.status, snapshot.degradation)
        ? 'snapshot_not_complete'
        : snapshot.recoveryAttempts >= maxAttempts
          ? 'recovery_attempts_exhausted'
          : !(await sourceTaskGuardIsValid(db, input.sourceTaskGuard))
            ? 'source_task_not_wakeable'
            : 'snapshot_not_wakeable';
  return { status: 'unavailable', reason };
}

export async function recordSessionSnapshotRecoveryWorkspace(
  db: Db,
  chatSessionId: string,
  taskId: string,
  workspaceId: string
): Promise<void> {
  await db
    .update(schema.sessionSnapshots)
    .set({ recoveryWorkspaceId: workspaceId, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, chatSessionId),
        eq(schema.sessionSnapshots.recoveryTaskId, taskId),
        inArray(schema.sessionSnapshots.recoveryStatus, ['waking', 'restored'])
      )
    );
}

export async function completeSessionSnapshotRecovery(
  db: Db,
  chatSessionId: string,
  taskId: string,
  workspaceId: string,
  recoverySourceTaskId?: string | null
): Promise<boolean> {
  const recoveryTask = alias(schema.tasks, 'snapshot_recovery_task');
  const recoverySourceTask = alias(schema.tasks, 'snapshot_recovery_source_task');
  const liveSourceCondition = recoverySourceTaskId
    ? exists(
        db
          .select({ id: recoveryTask.id })
          .from(recoveryTask)
          .innerJoin(
            recoverySourceTask,
            and(
              eq(recoverySourceTask.id, recoveryTask.recoverySourceTaskId),
              eq(recoverySourceTask.projectId, recoveryTask.projectId)
            )
          )
          .where(
            and(
              eq(recoveryTask.id, taskId),
              eq(recoveryTask.recoverySourceTaskId, recoverySourceTaskId),
              eq(recoveryTask.chatSessionId, chatSessionId),
              eq(recoveryTask.triggeredBy, 'session-recovery'),
              notInArray(recoveryTask.status, TERMINAL_TASK_STATUSES),
              notInArray(recoverySourceTask.status, TERMINAL_TASK_STATUSES),
              eq(recoveryTask.projectId, schema.sessionSnapshots.projectId)
            )
          )
      )
    : undefined;
  const result = await db
    .update(schema.sessionSnapshots)
    .set({
      recoveryStatus: 'restored',
      recoveryWorkspaceId: workspaceId,
      recoveryError: null,
      recoveryClaimedAt: null,
      sleepStatus: null,
      sleepAfter: null,
      sleepAttempts: 0,
      sleepError: null,
      sleepingAt: null,
      restoredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, chatSessionId),
        eq(schema.sessionSnapshots.recoveryTaskId, taskId),
        inArray(schema.sessionSnapshots.recoveryStatus, ['waking', 'restored']),
        liveSourceCondition
      )
    );
  return (result.meta.changes ?? 0) > 0;
}

/** Record the in-place Cloudflare Container wake after its DO restored the runtime. */
export async function markSessionSnapshotAwakeInPlace(
  env: Env,
  chatSessionId: string,
  taskId: string,
  workspaceId: string
): Promise<void> {
  const db = drizzle(env.DATABASE, { schema });
  const now = new Date().toISOString();
  await db
    .update(schema.sessionSnapshots)
    .set({
      sleepingAt: null,
      recoveryStatus: 'restored',
      recoveryTaskId: taskId,
      recoveryWorkspaceId: workspaceId,
      recoveryError: null,
      recoveryClaimedAt: null,
      sleepStatus: null,
      sleepAfter: null,
      sleepAttempts: 0,
      sleepError: null,
      restoredAt: now,
      updatedAt: now,
    })
    .where(
      and(eq(schema.sessionSnapshots.chatSessionId, chatSessionId), restorableSnapshotCondition())
    );
}

export async function failSessionSnapshotRecovery(
  db: Db,
  env: Env,
  chatSessionId: string,
  taskId: string,
  error: string
): Promise<void> {
  await db
    .update(schema.sessionSnapshots)
    .set({
      recoveryStatus: 'failed',
      recoveryError: sessionLifecycleError(env, error),
      recoveryClaimedAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, chatSessionId),
        eq(schema.sessionSnapshots.recoveryTaskId, taskId),
        inArray(schema.sessionSnapshots.recoveryStatus, ['waking', 'restored'])
      )
    );
}
