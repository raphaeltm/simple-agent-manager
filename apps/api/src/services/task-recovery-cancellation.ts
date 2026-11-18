import type { TaskTerminalStatus } from '@simple-agent-manager/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';

/**
 * Place immediately after the task CAS in the SAME batch. changes() proves that
 * write won, even if another terminal writer used the same timestamp and verdict.
 * Artifacts remain available for new intent.
 */
export function taskRecoveryCancellationQuery(
  db: ReturnType<typeof drizzle<typeof schema>>,
  task: Pick<schema.Task, 'id' | 'projectId'>,
  now: string,
  expectedStatus: TaskTerminalStatus = 'cancelled'
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
        sql`changes() = 1`,
        eq(schema.sessionSnapshots.projectId, task.projectId),
        eq(schema.sessionSnapshots.recoveryTaskId, task.id),
        eq(schema.sessionSnapshots.recoveryStatus, 'waking'),
        sql`EXISTS (SELECT 1 FROM tasks cancelled
      WHERE cancelled.id = ${task.id} AND cancelled.project_id = ${task.projectId}
        AND cancelled.status = ${expectedStatus}
        AND cancelled.updated_at = ${now})`
      )
    );
}

/** Raw D1 writers use the same terminal row-version fence inside their CAS batch. */
export function taskRecoveryCancellationStatement(
  database: D1Database,
  task: Pick<schema.Task, 'id' | 'projectId'>,
  now: string,
  expectedStatus: TaskTerminalStatus = 'cancelled'
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE session_snapshots
    SET recovery_status = 'failed', recovery_attempt_id = NULL, recovery_failed_at = ?
    WHERE changes() = 1 AND project_id = ? AND recovery_task_id = ? AND recovery_status = 'waking'
      AND EXISTS (SELECT 1 FROM tasks cancelled
        WHERE cancelled.id = ? AND cancelled.project_id = ?
          AND cancelled.status = ?
          AND cancelled.updated_at = ?)`
    )
    .bind(now, task.projectId, task.id, task.id, task.projectId, expectedStatus, now);
}
