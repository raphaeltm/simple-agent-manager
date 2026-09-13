import type { ProjectScheduledAction } from '@simple-agent-manager/shared';

import { ProjectEventValidationError } from './project-events-contracts';
import type { Env } from './types';

/** Stored creator identity is authority to recheck, never a saved bearer token. */
export async function requireScheduleMember(
  env: Env,
  projectId: string,
  userId: string,
  readOnly = false
): Promise<void> {
  const member = await env.DATABASE.prepare(
    `SELECT m.user_id FROM project_members m
    JOIN users u ON u.id = m.user_id
    JOIN projects p ON p.id = m.project_id
    WHERE m.project_id = ? AND m.user_id = ? AND m.status = 'active'
      AND u.status = 'active' AND (? = 1 OR m.role IN ('owner', 'admin', 'maintainer')) LIMIT 1`
  )
    .bind(projectId, userId, readOnly ? 1 : 0)
    .first();
  if (!member)
    throw new ProjectEventValidationError('Schedule creator no longer has project access');
}

export function requireScheduleTarget(sql: SqlStorage, sessionId: string): string {
  const target = sql
    .exec(`SELECT task_id, status FROM chat_sessions WHERE id = ? LIMIT 1`, sessionId)
    .toArray()[0];
  if (
    !target ||
    typeof target.task_id !== 'string' ||
    (target.status !== 'active' && target.status !== 'sleeping')
  ) {
    throw new ProjectEventValidationError(
      'Scheduled target session is no longer active or recoverable'
    );
  }
  return target.task_id;
}

export async function requireScheduleAction(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  userId: string,
  action: ProjectScheduledAction
): Promise<string | null> {
  if (action.kind === 'start_session') {
    // The reserved submission adapter resolves current shared profile, skill,
    // credentials and placement at admission. Creator chat liveness is irrelevant.
    await requireScheduleMember(env, projectId, userId);
    return null;
  }
  const targetTaskId = requireScheduleTarget(sql, action.sessionId);
  const task = await env.DATABASE.prepare(
    `SELECT t.id FROM tasks t
    JOIN project_members m ON m.project_id = t.project_id AND m.user_id = ?
    JOIN users u ON u.id = m.user_id
    WHERE t.id = ? AND t.project_id = ? AND t.chat_session_id = ?
      AND t.status IN ('queued','delegated','in_progress','awaiting_followup')
      AND m.status = 'active' AND u.status = 'active'
      AND m.role IN ('owner','admin','maintainer') LIMIT 1`
  )
    .bind(userId, targetTaskId, projectId, action.sessionId)
    .first();
  if (!task)
    throw new ProjectEventValidationError(
      'Scheduled target or creator authority is no longer active'
    );
  // A cancellation or archive may land during either distributed read.
  if (requireScheduleTarget(sql, action.sessionId) !== targetTaskId) {
    throw new ProjectEventValidationError('Scheduled target task changed during admission');
  }
  return targetTaskId;
}
