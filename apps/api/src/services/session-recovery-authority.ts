import { log } from '../lib/logger';

const TERMINAL_TASK_STATUSES_SQL = "'completed', 'failed', 'cancelled'";

export interface SessionRecoverySourceTaskGuard {
  taskId: string;
  projectId: string;
  chatSessionId: string;
}

export class SessionRecoveryAuthorityRevokedError extends Error {
  readonly permanent = true;

  constructor() {
    super('Session recovery authority was revoked');
    this.name = 'SessionRecoveryAuthorityRevokedError';
  }
}

/**
 * Validate the parent authority used by durable prompt delivery immediately at
 * a runtime wake boundary. A live linked recovery task may temporarily own the
 * chat while the original parent remains the source of authority.
 */
export async function isSessionRecoverySourceTaskGuardValid(
  database: D1Database,
  guard: SessionRecoverySourceTaskGuard
): Promise<boolean> {
  const row = await database
    .prepare(
      `SELECT source.id
         FROM tasks source
        WHERE source.id = ?
          AND source.project_id = ?
          AND source.status NOT IN (${TERMINAL_TASK_STATUSES_SQL})
          AND (
            source.chat_session_id = ?
            OR EXISTS (
              SELECT 1
                FROM tasks owner
               WHERE owner.recovery_source_task_id = source.id
                 AND owner.project_id = source.project_id
                 AND owner.chat_session_id = ?
                 AND owner.triggered_by = 'session-recovery'
                 AND owner.status NOT IN (${TERMINAL_TASK_STATUSES_SQL})
            )
          )
        LIMIT 1`
    )
    .bind(guard.taskId, guard.projectId, guard.chatSessionId, guard.chatSessionId)
    .first<{ id: string }>();
  return Boolean(row);
}

/**
 * Validate a replacement TaskRunner against the exact snapshot claim and live
 * parent that authorized it. This check is repeated at start and before every
 * alarm-driven step so a stale runner cannot create resources after a retry or
 * parent terminal transition revoked its authority.
 */
export async function isSessionRecoveryTaskAuthorized(
  database: D1Database,
  input: {
    recoveryTaskId: string;
    sourceTaskId: string;
    projectId: string;
    chatSessionId: string;
  }
): Promise<boolean> {
  const row = await database
    .prepare(
      `SELECT recovery.id
         FROM tasks recovery
         JOIN tasks source
           ON source.id = recovery.recovery_source_task_id
          AND source.project_id = recovery.project_id
         JOIN session_snapshots snapshot
           ON snapshot.chat_session_id = recovery.chat_session_id
          AND snapshot.project_id = recovery.project_id
          AND snapshot.recovery_task_id = recovery.id
        WHERE recovery.id = ?
          AND recovery.recovery_source_task_id = ?
          AND recovery.project_id = ?
          AND recovery.chat_session_id = ?
          AND recovery.triggered_by = 'session-recovery'
          AND recovery.status NOT IN (${TERMINAL_TASK_STATUSES_SQL})
          AND (
            (recovery.status = 'in_progress' AND snapshot.recovery_status = 'restored')
            OR (
              source.status NOT IN (${TERMINAL_TASK_STATUSES_SQL})
              AND snapshot.recovery_status IN ('waking', 'restored')
            )
          )
        LIMIT 1`
    )
    .bind(input.recoveryTaskId, input.sourceTaskId, input.projectId, input.chatSessionId)
    .first<{ id: string }>();
  return Boolean(row);
}

/**
 * Return a failed/cancelled replacement's chat binding to its original task
 * and snapshot workspace. The snapshot claim predicate prevents a late failed
 * runner from stealing ownership back from a newer recovery attempt.
 */
export async function restoreSessionRecoveryHandoff(
  database: D1Database,
  recoveryTaskId: string,
  chatSessionId: string
): Promise<void> {
  const now = new Date().toISOString();
  const claimStillOwned = `EXISTS (
    SELECT 1 FROM session_snapshots snapshot
     WHERE snapshot.chat_session_id = ?
       AND snapshot.recovery_task_id = ?
       AND snapshot.recovery_status IN ('waking', 'failed', 'restored')
  )`;
  const results = await database.batch([
    database
      .prepare(
        `UPDATE tasks
            SET chat_session_id = NULL, updated_at = ?
          WHERE id = ?
            AND chat_session_id = ?
            AND recovery_source_task_id IS NOT NULL
            AND ${claimStillOwned}`
      )
      .bind(now, recoveryTaskId, chatSessionId, chatSessionId, recoveryTaskId),
    database
      .prepare(
        `UPDATE tasks
            SET chat_session_id = ?, updated_at = ?
          WHERE id = (SELECT recovery_source_task_id FROM tasks WHERE id = ?)
            AND chat_session_id IS NULL
            AND ${claimStillOwned}
            AND NOT EXISTS (
              SELECT 1 FROM tasks owner WHERE owner.chat_session_id = ?
            )`
      )
      .bind(chatSessionId, now, recoveryTaskId, chatSessionId, recoveryTaskId, chatSessionId),
    database
      .prepare(
        `UPDATE workspaces
            SET chat_session_id = ?, updated_at = ?
          WHERE id = (
            SELECT snapshot.workspace_id
              FROM session_snapshots snapshot
             WHERE snapshot.chat_session_id = ?
               AND snapshot.recovery_task_id = ?
          )
            AND chat_session_id IS NULL
            AND ${claimStillOwned}
            AND NOT EXISTS (
              SELECT 1 FROM workspaces owner WHERE owner.chat_session_id = ?
            )`
      )
      .bind(
        chatSessionId,
        now,
        chatSessionId,
        recoveryTaskId,
        chatSessionId,
        recoveryTaskId,
        chatSessionId
      ),
  ]);
  if (results.some((result) => (result.meta.changes ?? 0) > 0)) {
    log.info('session_recovery.handoff_restored', { recoveryTaskId, chatSessionId });
  }
}

/**
 * Atomically terminalize a replacement that definitely never started, release
 * its chat ownership, restore the original bindings, and reopen the snapshot
 * for a bounded later recovery attempt.
 */
export async function failAndRestoreSessionRecoveryHandoff(
  database: D1Database,
  input: {
    recoveryTaskId: string;
    chatSessionId: string;
    error: string;
    statusEventId: string;
  }
): Promise<void> {
  const now = new Date().toISOString();
  const results = await database.batch([
    database
      .prepare(
        `UPDATE tasks
            SET status = 'failed', execution_step = NULL, chat_session_id = NULL,
                error_message = ?, completed_at = ?, updated_at = ?
          WHERE id = ?
            AND recovery_source_task_id IS NOT NULL
            AND status NOT IN ('completed', 'cancelled')
            AND EXISTS (
              SELECT 1 FROM session_snapshots snapshot
               WHERE snapshot.chat_session_id = ?
                 AND snapshot.recovery_task_id = ?
                 AND snapshot.recovery_status = 'waking'
            )`
      )
      .bind(input.error, now, now, input.recoveryTaskId, input.chatSessionId, input.recoveryTaskId),
    database
      .prepare(
        `UPDATE tasks
            SET chat_session_id = ?, updated_at = ?
          WHERE id = (SELECT recovery_source_task_id FROM tasks WHERE id = ?)
            AND chat_session_id IS NULL
            AND EXISTS (
              SELECT 1 FROM tasks recovery
               WHERE recovery.id = ?
                 AND recovery.status = 'failed'
                 AND recovery.chat_session_id IS NULL
            )
            AND NOT EXISTS (
              SELECT 1 FROM tasks owner WHERE owner.chat_session_id = ?
            )`
      )
      .bind(
        input.chatSessionId,
        now,
        input.recoveryTaskId,
        input.recoveryTaskId,
        input.chatSessionId
      ),
    database
      .prepare(
        `UPDATE workspaces
            SET chat_session_id = ?, updated_at = ?
          WHERE id = (
            SELECT snapshot.workspace_id
              FROM session_snapshots snapshot
             WHERE snapshot.chat_session_id = ?
               AND snapshot.recovery_task_id = ?
          )
            AND chat_session_id IS NULL
            AND EXISTS (
              SELECT 1 FROM tasks recovery
               WHERE recovery.id = ?
                 AND recovery.status = 'failed'
                 AND recovery.chat_session_id IS NULL
            )
            AND NOT EXISTS (
              SELECT 1 FROM workspaces owner WHERE owner.chat_session_id = ?
            )`
      )
      .bind(
        input.chatSessionId,
        now,
        input.chatSessionId,
        input.recoveryTaskId,
        input.recoveryTaskId,
        input.chatSessionId
      ),
    database
      .prepare(
        `UPDATE session_snapshots
            SET recovery_status = 'failed', recovery_error = ?,
                recovery_claimed_at = NULL, updated_at = ?
          WHERE chat_session_id = ?
            AND recovery_task_id = ?
            AND recovery_status = 'waking'`
      )
      .bind(input.error, now, input.chatSessionId, input.recoveryTaskId),
    database
      .prepare(
        `INSERT INTO task_status_events
           (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
         SELECT ?, task.id, 'queued', 'failed', 'system', NULL, ?, ?
           FROM tasks task
          WHERE task.id = ?
            AND task.status = 'failed'
            AND NOT EXISTS (
              SELECT 1 FROM task_status_events event
               WHERE event.task_id = task.id
                 AND event.to_status = 'failed'
                 AND event.reason = ?
            )`
      )
      .bind(input.statusEventId, input.error, now, input.recoveryTaskId, input.error),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0) {
    throw new Error('Recovery start failure lost its authoritative snapshot claim');
  }
  log.warn('session_recovery.start_failure_restored', {
    recoveryTaskId: input.recoveryTaskId,
    chatSessionId: input.chatSessionId,
  });
}
