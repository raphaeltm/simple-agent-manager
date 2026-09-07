import { TASK_TERMINAL_STATUSES } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import * as projectDataService from './project-data';

const TASK_EXECUTION_STATUSES = new Set(['queued', 'delegated', 'in_progress']);
const TERMINAL_TASK_STATUSES = new Set<string>(TASK_TERMINAL_STATUSES);
const TERMINAL_SESSION_STATUSES = new Set(['stopped', 'failed']);

export interface TaskRunnerReservedSubmissionGuard {
  kind: 'reserved_submission';
  taskId: string;
  projectId: string;
  userId: string;
  chatSessionId: string;
  intentFingerprint: string;
}

export type TaskRunnerStartGuard = TaskRunnerReservedSubmissionGuard;

export interface AssertTaskRunnerStartGuardOptions {
  requireQueuedTask?: boolean;
}

export class TaskRunnerStartGuardRevokedError extends Error {
  readonly permanent = true;

  constructor(message: string) {
    super(message);
    this.name = 'TaskRunnerStartGuardRevokedError';
  }
}

function revoked(message: string): never {
  throw new TaskRunnerStartGuardRevokedError(message);
}

export async function assertTaskRunnerStartGuard(
  env: Env,
  guard: TaskRunnerStartGuard | null | undefined,
  options: AssertTaskRunnerStartGuardOptions = {}
): Promise<void> {
  if (!guard) return;

  switch (guard.kind) {
    case 'reserved_submission':
      await assertReservedSubmissionGuard(env, guard, options);
      return;
  }
}

async function assertReservedSubmissionGuard(
  env: Env,
  guard: TaskRunnerReservedSubmissionGuard,
  options: AssertTaskRunnerStartGuardOptions
): Promise<void> {
  const task = await env.DATABASE.prepare(
    `SELECT t.status, t.project_id, t.user_id, t.chat_session_id,
            c.intent_fingerprint, c.chat_session_id AS checkpoint_chat_session_id
       FROM tasks t
       INNER JOIN task_submission_checkpoints c ON c.task_id = t.id
      WHERE t.id = ?
        AND t.project_id = ?
        AND t.user_id = ?
      LIMIT 1`
  )
    .bind(guard.taskId, guard.projectId, guard.userId)
    .first<{
      status: string;
      project_id: string;
      user_id: string;
      chat_session_id: string | null;
      intent_fingerprint: string;
      checkpoint_chat_session_id: string;
    }>();

  if (!task) {
    revoked(`Reserved task submission authority revoked: task ${guard.taskId} is missing`);
  }
  if (
    task.intent_fingerprint !== guard.intentFingerprint ||
    task.checkpoint_chat_session_id !== guard.chatSessionId ||
    task.chat_session_id !== guard.chatSessionId
  ) {
    revoked(`Reserved task submission authority revoked: task ${guard.taskId} identity changed`);
  }
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    revoked(`Reserved task submission authority revoked: task ${guard.taskId} is ${task.status}`);
  }
  if (options.requireQueuedTask && task.status !== 'queued') {
    revoked(
      `Reserved task submission authority revoked: task ${guard.taskId} is ${task.status}, not queued`
    );
  }
  if (!TASK_EXECUTION_STATUSES.has(task.status)) {
    revoked(`Reserved task submission authority revoked: task ${guard.taskId} is not executable`);
  }

  let session: Record<string, unknown> | null;
  try {
    session = await projectDataService.getSession(env, guard.projectId, guard.chatSessionId);
  } catch (error) {
    throw new Error(
      `Reserved task submission session state unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!session) {
    revoked(
      `Reserved task submission authority revoked: session ${guard.chatSessionId} is missing`
    );
  }
  const sessionStatus = typeof session.status === 'string' ? session.status : null;
  const sessionTaskId = typeof session.taskId === 'string' ? session.taskId : null;
  if (sessionTaskId !== guard.taskId) {
    revoked(
      `Reserved task submission authority revoked: session ${guard.chatSessionId} identity changed`
    );
  }
  if (sessionStatus && TERMINAL_SESSION_STATUSES.has(sessionStatus)) {
    revoked(
      `Reserved task submission authority revoked: session ${guard.chatSessionId} is ${sessionStatus}`
    );
  }
}
