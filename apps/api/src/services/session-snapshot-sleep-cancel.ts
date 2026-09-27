import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { SLEEP_PRESERVED_TERMINAL_TASK_STATUS_SQL } from './sleep-preserved-task-status';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export async function cancelScheduledSessionSleep(
  db: Db,
  chatSessionId: string,
  options: { preserveCompletedTaskIntent?: boolean } = {}
): Promise<void> {
  // Activity re-reports must fence an in-flight preparing claim without erasing
  // the terminal sleep intent: a completion intent protects the final response
  // from ledger cleanup, and a failed task's intent is its work-preservation
  // snapshot (`failed-task-preservation.ts`). Erasing either would let the
  // terminal reconcilers archive the session before it sleeps.
  // Explicit user wake keeps the unconditional cancellation behavior.
  const completing = sql`EXISTS (
    SELECT 1 FROM tasks completed_task
    WHERE completed_task.project_id = ${schema.sessionSnapshots.projectId}
      AND completed_task.status IN ${sql.raw(SLEEP_PRESERVED_TERMINAL_TASK_STATUS_SQL)}
      AND (
        completed_task.chat_session_id = ${chatSessionId}
        OR completed_task.id = (
          SELECT summary.task_id FROM session_summaries summary
          WHERE summary.id = ${chatSessionId}
            AND summary.project_id = ${schema.sessionSnapshots.projectId}
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM tasks live_task
        WHERE live_task.project_id = completed_task.project_id
          AND live_task.chat_session_id = ${chatSessionId}
          AND live_task.status NOT IN ('completed', 'failed', 'cancelled')
      )
  )`;
  const nowIso = new Date().toISOString();
  await db
    .update(schema.sessionSnapshots)
    .set({
      sleepStatus: options.preserveCompletedTaskIntent
        ? sql`CASE WHEN ${completing} THEN 'scheduled' ELSE NULL END`
        : null,
      // Once present, keep the same intent clock across heartbeat re-reports.
      sleepAfter: options.preserveCompletedTaskIntent
        ? sql`CASE WHEN ${completing} THEN COALESCE(${schema.sessionSnapshots.sleepAfter}, ${nowIso}) ELSE NULL END`
        : null,
      sleepError: null,
      sleepClaimId: null,
      sleepClaimedAt: null,
      sleepStoppingSince: null,
      updatedAt: nowIso,
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, chatSessionId),
        isNull(schema.sessionSnapshots.sleepingAt),
        or(
          isNull(schema.sessionSnapshots.sleepStatus),
          inArray(schema.sessionSnapshots.sleepStatus, ['scheduled', 'failed', 'preparing'])
        )
      )
    );
}
