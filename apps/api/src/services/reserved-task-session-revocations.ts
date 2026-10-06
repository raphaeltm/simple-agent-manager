import type { Env } from '../env';

export type ReservedTaskSessionRevocationReason = 'session_stopped' | 'session_failed';

export interface ReservedTaskSessionRevocationInput {
  projectId: string;
  chatSessionId: string;
  taskId?: string | null;
  reason: ReservedTaskSessionRevocationReason;
  source: string;
  now?: string;
}

/**
 * Record a D1-visible revocation for reserved task-backed sessions before the
 * ProjectData session is terminalized. The INSERT is scoped by the checkpoint
 * table, so ordinary chat sessions are unaffected.
 */
export async function recordReservedTaskSessionRevocation(
  env: Pick<Env, 'DATABASE'>,
  input: ReservedTaskSessionRevocationInput
): Promise<void> {
  const now = input.now ?? new Date().toISOString();
  await env.DATABASE.prepare(
    `INSERT INTO reserved_task_session_revocations
       (project_id, chat_session_id, task_id, reason, source, revoked_at, created_at, updated_at)
     SELECT t.project_id, t.chat_session_id, t.id, ?, ?, ?, ?, ?
       FROM tasks t
       INNER JOIN task_submission_checkpoints c ON c.task_id = t.id
      WHERE t.project_id = ?
        AND t.chat_session_id = ?
        AND t.chat_session_id IS NOT NULL
        AND (? IS NULL OR t.id = ?)
     ON CONFLICT(project_id, chat_session_id) DO UPDATE SET
       task_id = excluded.task_id,
       reason = excluded.reason,
       source = excluded.source,
       revoked_at = excluded.revoked_at,
       updated_at = excluded.updated_at`
  )
    .bind(
      input.reason,
      input.source,
      now,
      now,
      now,
      input.projectId,
      input.chatSessionId,
      input.taskId ?? null,
      input.taskId ?? null
    )
    .run();
}
