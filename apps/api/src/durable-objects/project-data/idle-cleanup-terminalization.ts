import { createModuleLogger, serializeError } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import type { TaskRuntimeLiveness } from '../../services/task-runtime-liveness';
import { syncTriggerExecutionStatus } from '../../services/trigger-execution-sync';
import { getLocalTaskRuntimeLiveness } from './task-runtime-liveness';
import type { Env } from './types';

const log = createModuleLogger('idle_cleanup_terminalization');
const ACTIVE_TASK_STATUSES = ['in_progress', 'delegated', 'awaiting_followup'] as const;

interface IdleTaskRow {
  id: string;
  project_id: string;
  workspace_id: string | null;
  chat_session_id: string | null;
  status: string;
}

export interface IdleTaskReporter {
  sweep: 'session_idle_cleanup' | 'workspace_idle_timeout';
  projectId: string;
  taskId: string;
  workspaceId: string;
  sessionId: string;
  idleDurationMs: number;
  timeoutMs: number;
}

export interface IdleTaskTerminalizationResult {
  outcome: 'failed' | 'preserved' | 'rejected' | 'not_active' | 'not_found' | 'superseded';
  taskId: string;
  liveness: TaskRuntimeLiveness | null;
  errorMessage: string | null;
}

export interface ReporterScopedTaskCandidates {
  tasks: Array<{ id: string }>;
  overflow: boolean;
}

export async function listReporterScopedTaskCandidates(
  db: D1Database,
  reporter: Pick<IdleTaskReporter, 'projectId' | 'workspaceId' | 'sessionId'>,
  limit: number
): Promise<ReporterScopedTaskCandidates> {
  const result = await db
    .prepare(
      `SELECT t.id
     FROM tasks t
     LEFT JOIN workspaces w
       ON w.id = t.workspace_id AND w.project_id = t.project_id
     WHERE t.project_id = ? AND t.workspace_id = ?
       AND t.status IN ('in_progress', 'delegated', 'awaiting_followup')
       AND (
         t.chat_session_id = ?
         OR (
           t.chat_session_id IS NULL
           AND w.chat_session_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM tasks same_workspace
             WHERE same_workspace.id != t.id
               AND same_workspace.project_id = t.project_id
               AND same_workspace.workspace_id = t.workspace_id
               AND same_workspace.chat_session_id IS NULL
               AND same_workspace.status IN ('in_progress', 'delegated', 'awaiting_followup')
           )
           AND NOT EXISTS (
             SELECT 1 FROM tasks existing_session_owner
             WHERE existing_session_owner.id != t.id
               AND existing_session_owner.chat_session_id = ?
           )
         )
       )
     ORDER BY t.created_at ASC, t.id ASC
     LIMIT ?`
    )
    .bind(
      reporter.projectId,
      reporter.workspaceId,
      reporter.sessionId,
      reporter.sessionId,
      reporter.sessionId,
      limit + 1
    )
    .all<{ id: string }>();
  const rows = result.results ?? [];
  return { tasks: rows.slice(0, limit), overflow: rows.length > limit };
}

async function scopeMismatch(
  env: Env,
  task: IdleTaskRow,
  reporter: IdleTaskReporter
): Promise<string | null> {
  if (task.project_id !== reporter.projectId) return 'project_id';
  if (task.workspace_id !== reporter.workspaceId) return 'workspace_id';
  if (task.chat_session_id === reporter.sessionId) return null;
  if (task.chat_session_id !== null) return 'chat_session_id';

  const workspace = await env.DATABASE.prepare(
    `SELECT chat_session_id
     FROM workspaces
     WHERE id = ? AND project_id = ?
     LIMIT 1`
  )
    .bind(reporter.workspaceId, reporter.projectId)
    .first<{ chat_session_id: string | null }>();
  if (workspace?.chat_session_id !== reporter.sessionId) return 'chat_session_id';

  try {
    const updated = await env.DATABASE.prepare(
      `UPDATE tasks
       SET chat_session_id = ?, updated_at = ?
       WHERE id = ? AND project_id = ? AND workspace_id = ? AND chat_session_id IS NULL`
    )
      .bind(
        reporter.sessionId,
        new Date().toISOString(),
        task.id,
        reporter.projectId,
        reporter.workspaceId
      )
      .run();

    if (!updated.meta.changes) {
      const reread = await env.DATABASE.prepare(
        `SELECT chat_session_id FROM tasks WHERE id = ? LIMIT 1`
      )
        .bind(task.id)
        .first<{ chat_session_id: string | null }>();
      if (reread?.chat_session_id !== reporter.sessionId) return 'chat_session_id';
    }
    task.chat_session_id = reporter.sessionId;
    log.info('legacy_task_session_link_backfilled', {
      taskId: task.id,
      projectId: reporter.projectId,
      workspaceId: reporter.workspaceId,
      sessionId: reporter.sessionId,
      sweep: reporter.sweep,
    });
  } catch (err) {
    log.warn('legacy_task_session_link_backfill_failed', {
      taskId: task.id,
      projectId: reporter.projectId,
      workspaceId: reporter.workspaceId,
      sessionId: reporter.sessionId,
      action: 'rejected',
      ...serializeError(err),
    });
    return 'chat_session_id';
  }
  return null;
}

function diagnosticMessage(reporter: IdleTaskReporter, liveness: TaskRuntimeLiveness): string {
  return (
    `Idle cleanup ${reporter.sweep} failed the task after ${reporter.idleDurationMs}ms idle ` +
    `(configured timeout ${reporter.timeoutMs}ms): runtime conclusively dead (${liveness.reason}).`
  );
}

/** Fail exactly the task attested by the idle reporter, and only after conclusive death. */
export async function terminalizeIdleTaskInD1(
  sql: SqlStorage,
  env: Env,
  reporter: IdleTaskReporter
): Promise<IdleTaskTerminalizationResult> {
  const task = await env.DATABASE.prepare(
    `SELECT id, project_id, workspace_id, chat_session_id, status
     FROM tasks WHERE id = ? LIMIT 1`
  )
    .bind(reporter.taskId)
    .first<IdleTaskRow>();
  if (!task) {
    return { outcome: 'not_found', taskId: reporter.taskId, liveness: null, errorMessage: null };
  }

  const mismatch = await scopeMismatch(env, task, reporter);
  if (mismatch) {
    log.warn('scope_rejected', {
      taskId: task.id,
      mismatch,
      expectedProjectId: reporter.projectId,
      receivedProjectId: task.project_id,
      expectedWorkspaceId: reporter.workspaceId,
      receivedWorkspaceId: task.workspace_id,
      expectedSessionId: reporter.sessionId,
      receivedSessionId: task.chat_session_id,
      action: 'rejected',
    });
    return { outcome: 'rejected', taskId: task.id, liveness: null, errorMessage: null };
  }
  if (!ACTIVE_TASK_STATUSES.includes(task.status as (typeof ACTIVE_TASK_STATUSES)[number])) {
    return { outcome: 'not_active', taskId: task.id, liveness: null, errorMessage: null };
  }

  const liveness = await getLocalTaskRuntimeLiveness(sql, env, {
    projectId: reporter.projectId,
    workspaceId: reporter.workspaceId,
  });
  if (liveness.live || !liveness.conclusive) {
    log.info('runtime_preserved', {
      taskId: task.id,
      projectId: reporter.projectId,
      workspaceId: reporter.workspaceId,
      sessionId: reporter.sessionId,
      sweep: reporter.sweep,
      live: liveness.live,
      conclusive: liveness.conclusive,
      reason: liveness.reason,
      action: 'preserved',
    });
    return { outcome: 'preserved', taskId: task.id, liveness, errorMessage: null };
  }

  const errorMessage = diagnosticMessage(reporter, liveness);
  const now = new Date().toISOString();
  const update = env.DATABASE.prepare(
    `UPDATE tasks
     SET status = 'failed', execution_step = NULL, error_message = ?, completed_at = ?, updated_at = ?
     WHERE id = ? AND project_id = ? AND workspace_id = ? AND chat_session_id = ? AND status = ?`
  ).bind(
    errorMessage,
    now,
    now,
    task.id,
    reporter.projectId,
    reporter.workspaceId,
    reporter.sessionId,
    task.status
  );
  const event = env.DATABASE.prepare(
    `INSERT INTO task_status_events
       (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
     SELECT ?, id, ?, 'failed', 'system', NULL, ?, ?
     FROM tasks
     WHERE id = ? AND project_id = ? AND workspace_id = ? AND chat_session_id = ?
       AND status = 'failed' AND completed_at = ? AND error_message = ?`
  ).bind(
    ulid(),
    task.status,
    errorMessage,
    now,
    task.id,
    reporter.projectId,
    reporter.workspaceId,
    reporter.sessionId,
    now,
    errorMessage
  );

  try {
    const [updateResult, eventResult] = await env.DATABASE.batch([update, event]);
    if (!updateResult?.meta.changes) {
      return { outcome: 'superseded', taskId: task.id, liveness, errorMessage: null };
    }
    if (!eventResult?.meta.changes) {
      throw new Error('Idle cleanup task transition did not append its status event');
    }
  } catch (err) {
    log.error('d1_failure_transition_failed', {
      taskId: task.id,
      projectId: reporter.projectId,
      workspaceId: reporter.workspaceId,
      sessionId: reporter.sessionId,
      action: 'preserved_for_retry',
      ...serializeError(err),
    });
    throw err;
  }

  await syncTriggerExecutionStatus(env.DATABASE, task.id, 'failed', errorMessage);
  return { outcome: 'failed', taskId: task.id, liveness, errorMessage };
}
