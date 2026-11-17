import { and, eq, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';

/** Include in the task's cancellation batch; artifacts remain available for new intent. */
export function taskRecoveryCancellationQuery(
  db: ReturnType<typeof drizzle<typeof schema>>,
  task: Pick<schema.Task, 'id' | 'projectId'>,
  now: string
) {
  return db
    .update(schema.sessionSnapshots)
    .set({
      recoveryStatus: 'failed',
      recoveryAttemptId: null,
      recoveryFailedAt: now,
    })
    .where(
      and(
        eq(schema.sessionSnapshots.projectId, task.projectId),
        eq(schema.sessionSnapshots.recoveryTaskId, task.id),
        eq(schema.sessionSnapshots.recoveryStatus, 'waking'),
        sql`EXISTS (SELECT 1 FROM tasks cancelled
      WHERE cancelled.id = ${task.id} AND cancelled.project_id = ${task.projectId}
        AND cancelled.status IN ('completed', 'failed', 'cancelled')
        AND cancelled.completed_at = ${now})`
      )
    );
}
