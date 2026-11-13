import type { ProjectEventChannelActor } from '@simple-agent-manager/shared';

import { ProjectEventValidationError } from './project-events-contracts';
import type { Env } from './types';

/** Last distributed authority read, after asynchronous payload preparation. */
export async function requireChannelActorAuthority(
  env: Env,
  projectId: string,
  actor: ProjectEventChannelActor
): Promise<void> {
  const row = await env.DATABASE.prepare(
    `SELECT t.id FROM tasks t
    JOIN workspaces w ON w.id = ? AND w.project_id = t.project_id AND w.user_id = t.user_id
    JOIN project_members m ON m.project_id = t.project_id AND m.user_id = t.user_id
    JOIN users u ON u.id = t.user_id
    WHERE t.id = ? AND t.project_id = ? AND t.user_id = ?
      AND t.status IN ('queued', 'delegated', 'in_progress', 'awaiting_followup')
      AND (t.workspace_id IS NULL OR t.workspace_id = w.id)
      AND (t.chat_session_id IS NULL OR t.chat_session_id = ?)
      AND (w.chat_session_id IS NULL OR w.chat_session_id = ?)
      AND w.status IN ('running', 'recovery') AND u.status = 'active'
      AND m.status = 'active' AND m.role IN ('owner', 'admin', 'maintainer')
      AND (? IS NULL OR EXISTS (SELECT 1 FROM agent_sessions a WHERE a.id = ?
        AND a.workspace_id = w.id AND a.user_id = t.user_id AND a.status = 'running'))
    LIMIT 1`
  )
    .bind(
      actor.workspaceId,
      actor.taskId,
      projectId,
      actor.userId,
      actor.chatSessionId,
      actor.chatSessionId,
      actor.agentSessionId ?? null,
      actor.agentSessionId ?? null
    )
    .first();
  if (!row) throw new ProjectEventValidationError('Channel caller authority was revoked');
}

/** Runs synchronously with the canonical mutation after the final D1 await. */
export function requireChannelActorChat(sql: SqlStorage, actor: ProjectEventChannelActor): void {
  const row = sql
    .exec(
      `SELECT id FROM chat_sessions WHERE id = ? AND task_id = ?
    AND workspace_id = ? AND status = 'active'
    AND (created_by_user_id IS NULL OR created_by_user_id = ?) LIMIT 1`,
      actor.chatSessionId,
      actor.taskId,
      actor.workspaceId,
      actor.userId
    )
    .toArray()[0];
  if (!row)
    throw new ProjectEventValidationError('The calling chat is no longer active for this task');
}
