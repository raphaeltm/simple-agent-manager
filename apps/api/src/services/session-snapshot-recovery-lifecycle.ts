import { and, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import {
  DEFAULT_SESSION_SNAPSHOT_RECOVERY_CLAIM_LEASE_MS,
  DEFAULT_SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS,
  isRestorableSnapshot,
  sessionLifecycleError,
  type SessionSnapshotRecoveryClaim,
} from './session-snapshot-artifacts';

type Db = ReturnType<typeof drizzle<typeof schema>>;

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
  input: { chatSessionId: string; userId: string; taskId: string; now?: Date }
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
        )
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
            lt(schema.sessionSnapshots.recoveryAttempts, maxAttempts)
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
  workspaceId: string
): Promise<boolean> {
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
        inArray(schema.sessionSnapshots.recoveryStatus, ['waking', 'restored'])
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
        eq(schema.sessionSnapshots.recoveryStatus, 'waking')
      )
    );
}
