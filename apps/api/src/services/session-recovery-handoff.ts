/**
 * Returning a wake's chat binding to its original owner when the replacement
 * fails or never starts. Split out of `session-recovery-authority.ts`
 * (`.claude/rules/18-file-size-limits.md`), which re-exports these functions.
 */
import { log } from '../lib/logger';
import { taskStatusIsNonTerminalSql, TERMINAL_STATUS_VALUES } from './task-status';

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
            SET chat_session_id = ?,
                superseded_by_task_id = NULL,
                updated_at = ?
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
        `INSERT INTO task_status_events
           (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
         SELECT ?, task.id, task.status, 'failed', 'system', NULL, ?, ?
           FROM tasks task
          WHERE task.id = ?
            AND task.recovery_source_task_id IS NOT NULL
            AND ${taskStatusIsNonTerminalSql('task.status')}
            AND EXISTS (
              SELECT 1 FROM session_snapshots snapshot
               WHERE snapshot.chat_session_id = ?
                 AND snapshot.recovery_task_id = task.id
                 AND snapshot.recovery_status = 'waking'
            )`
      )
      .bind(
        input.statusEventId,
        input.error,
        now,
        input.recoveryTaskId,
        ...TERMINAL_STATUS_VALUES,
        input.chatSessionId
      ),
    database
      .prepare(
        `UPDATE tasks
            SET status = 'failed', execution_step = NULL, chat_session_id = NULL,
                error_message = ?, completed_at = ?, updated_at = ?
          WHERE id = ?
            AND recovery_source_task_id IS NOT NULL
            AND ${taskStatusIsNonTerminalSql()}
            AND EXISTS (
              SELECT 1 FROM task_status_events event
               WHERE event.id = ? AND event.task_id = tasks.id
                 AND event.to_status = 'failed'
            )
            AND EXISTS (
              SELECT 1 FROM session_snapshots snapshot
               WHERE snapshot.chat_session_id = ?
                 AND snapshot.recovery_task_id = ?
                 AND snapshot.recovery_status = 'waking'
            )`
      )
      .bind(
        input.error,
        now,
        now,
        input.recoveryTaskId,
        ...TERMINAL_STATUS_VALUES,
        input.statusEventId,
        input.chatSessionId,
        input.recoveryTaskId
      ),
    database
      .prepare(
        `UPDATE tasks
            SET chat_session_id = ?,
                superseded_by_task_id = NULL,
                updated_at = ?
          WHERE id = (SELECT recovery_source_task_id FROM tasks WHERE id = ?)
            AND chat_session_id IS NULL
            AND EXISTS (
              SELECT 1 FROM task_status_events event
               WHERE event.id = ? AND event.task_id = ?
                 AND event.to_status = 'failed'
            )
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
        input.statusEventId,
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
              SELECT 1 FROM task_status_events event
               WHERE event.id = ? AND event.task_id = ?
                 AND event.to_status = 'failed'
            )
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
        input.statusEventId,
        input.recoveryTaskId,
        input.recoveryTaskId,
        input.chatSessionId
      ),
    database
      .prepare(
        // `recovery_failed_at` is the anchor the wake attempt budget decays from
        // (`session-snapshot-recovery-budget.ts`). This is the SECOND writer of
        // `recovery_status = 'failed'`; omitting it here would leave the anchor
        // NULL, which the budget predicate deliberately fails closed on, and a
        // session that failed three kickoffs through this path would be stranded
        // exactly as the 2026-09-09 incident stranded four.
        `UPDATE session_snapshots
            SET recovery_status = 'failed', recovery_error = ?,
                recovery_claimed_at = NULL, recovery_failed_at = ?, updated_at = ?
          WHERE chat_session_id = ?
            AND recovery_task_id = ?
            AND EXISTS (
              SELECT 1 FROM task_status_events event
               WHERE event.id = ? AND event.task_id = recovery_task_id
                 AND event.to_status = 'failed'
            )
            AND recovery_status = 'waking'`
      )
      .bind(input.error, now, now, input.chatSessionId, input.recoveryTaskId, input.statusEventId),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0 || (results[1]?.meta.changes ?? 0) === 0) {
    throw new Error('Recovery start failure lost its authoritative snapshot claim');
  }
  log.warn('session_recovery.start_failure_restored', {
    recoveryTaskId: input.recoveryTaskId,
    chatSessionId: input.chatSessionId,
  });
}
