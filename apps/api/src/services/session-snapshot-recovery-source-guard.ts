/**
 * The source-task guard of an automated wake (`SessionRecoverySourceTaskGuard`): the
 * SQL condition the snapshot claim's compare-and-set carries, and the read that names
 * why a guarded claim was refused. Split from `session-snapshot-recovery-lifecycle.ts`.
 */
import { and, eq, exists, isNotNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';

import * as schema from '../db/schema';
import type { SessionRecoverySourceTaskGuard } from './session-recovery-authority';
import { type Db, TERMINAL_TASK_STATUSES } from './session-snapshot-recovery-conditions';

export function sourceTaskGuardCondition(
  db: Db,
  guard: SessionRecoverySourceTaskGuard | undefined
) {
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

export async function sourceTaskGuardIsValid(
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
