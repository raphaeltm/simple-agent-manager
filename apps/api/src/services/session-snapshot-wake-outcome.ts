/**
 * Recording a snapshot wake's outcome: the replacement workspace, a completed or
 * in-place restore, or a failed one. Split out of
 * `session-snapshot-recovery-lifecycle.ts`, which keeps the recovery claim
 * (`.claude/rules/18-file-size-limits.md`).
 */
import { and, eq, exists, inArray, notInArray, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { alias } from 'drizzle-orm/sqlite-core';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { sessionLifecycleError } from './session-snapshot-artifacts';
import {
  archiveMigrationFenceCondition,
  type Db,
  restorableSnapshotCondition,
  TERMINAL_TASK_STATUSES,
} from './session-snapshot-recovery-conditions';

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
              or(
                notInArray(recoverySourceTask.status, TERMINAL_TASK_STATUSES),
                and(
                  eq(recoverySourceTask.status, 'cancelled'),
                  eq(recoverySourceTask.supersededByTaskId, recoveryTask.id)
                )
              ),
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
      sleepStoppingSince: null,
      sleepingAt: null,
      recoveryAttempts: 0,
      recoveryFailedAt: null,
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
      sleepStoppingSince: null,
      recoveryAttempts: 0,
      recoveryFailedAt: null,
      restoredAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, chatSessionId),
        restorableSnapshotCondition(),
        archiveMigrationFenceCondition(db, chatSessionId)
      )
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
      // The clean-failure timestamp the attempt budget decays from. Only a
      // reported failure sets it; an attempt that never returns leaves it NULL
      // and keeps its slot spent (`session-snapshot-recovery-budget.ts`).
      // `failAndRestoreSessionRecoveryHandoff` is the OTHER writer of this
      // status and stamps the same anchor; the pair is pinned by
      // `session-snapshot-failed-writer-coverage.test.ts`.
      recoveryFailedAt: new Date().toISOString(),
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
