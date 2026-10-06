import { and, eq, exists, notInArray, or } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';
import { alias } from 'drizzle-orm/sqlite-core';

import * as schema from '../db/schema';
import { type SessionRecoverySourceTaskGuard } from './session-snapshots';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export class SourceTaskNotWakeableError extends Error {
  constructor() {
    super('source task is no longer wakeable');
    this.name = 'SourceTaskNotWakeableError';
  }
}

export async function sourceTaskGuardIsWakeable(
  db: Db,
  guard: SessionRecoverySourceTaskGuard | undefined
): Promise<boolean> {
  if (!guard) return true;
  const recoveryOwner = alias(schema.tasks, 'recovery_owner');
  const markedSuccessor = alias(schema.tasks, 'recovery_marked_successor');
  const terminalStatuses = ['completed', 'failed', 'cancelled'];
  const sourceIsWakeable = or(
    notInArray(schema.tasks.status, terminalStatuses),
    and(
      eq(schema.tasks.status, 'cancelled'),
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
              notInArray(markedSuccessor.status, terminalStatuses)
            )
          )
      )
    )
  );
  const task = await db
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
                  notInArray(recoveryOwner.status, ['completed', 'failed', 'cancelled'])
                )
              )
          )
        )
      )
    )
    .get();
  return Boolean(task);
}
