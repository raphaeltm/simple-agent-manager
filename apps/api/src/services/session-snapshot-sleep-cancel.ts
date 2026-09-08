import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export async function cancelScheduledSessionSleep(
  db: Db,
  chatSessionId: string,
  options: { preserveCompletedTaskIntent?: boolean } = {}
): Promise<void> {
  // Activity re-reports must fence an in-flight preparing claim without erasing
  // the completion intent that protects the final response from ledger cleanup.
  // Explicit user wake keeps the unconditional cancellation behavior.
  const completing = sql`EXISTS (
    SELECT 1 FROM tasks completed_task
    WHERE completed_task.project_id = ${schema.sessionSnapshots.projectId}
      AND completed_task.status = 'completed'
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
