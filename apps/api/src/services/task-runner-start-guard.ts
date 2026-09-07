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
  expiresAt?: number;
}

export type TaskRunnerStartGuard = TaskRunnerReservedSubmissionGuard;

export interface AssertTaskRunnerStartGuardOptions {
  requireQueuedTask?: boolean;
  expectedRunner?: {
    taskId: string;
    projectId: string;
    userId: string;
    chatSessionId: string | null;
  };
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
  guard: unknown,
  options: AssertTaskRunnerStartGuardOptions = {}
): Promise<void> {
  if (!guard) return;

  const parsedGuard = parseTaskRunnerStartGuard(guard);
  assertGuardMatchesRunner(parsedGuard, options.expectedRunner);

  switch (parsedGuard.kind) {
    case 'reserved_submission':
      await assertReservedSubmissionGuard(env, parsedGuard, options);
      return;
  }
}

function parseTaskRunnerStartGuard(guard: unknown): TaskRunnerStartGuard {
  if (!guard || typeof guard !== 'object' || Array.isArray(guard)) {
    revoked('Invalid TaskRunner start guard: expected an object');
  }
  const record = guard as Record<string, unknown>;
  switch (record.kind) {
    case 'reserved_submission':
      return {
        kind: 'reserved_submission',
        taskId: nonEmptyString(record.taskId, 'taskId'),
        projectId: nonEmptyString(record.projectId, 'projectId'),
        userId: nonEmptyString(record.userId, 'userId'),
        chatSessionId: nonEmptyString(record.chatSessionId, 'chatSessionId'),
        intentFingerprint: nonEmptyString(record.intentFingerprint, 'intentFingerprint'),
        ...(record.expiresAt === undefined
          ? {}
          : { expiresAt: positiveDeadline(record.expiresAt) }),
      };
    default:
      revoked(
        `Unsupported TaskRunner start guard kind: ${
          typeof record.kind === 'string' ? record.kind : 'missing'
        }`
      );
  }
}

function positiveDeadline(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    revoked('Invalid task start deadline');
  return value;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value === 'string' && value.trim() !== '') return value;
  revoked(`Invalid TaskRunner start guard: ${field} is required`);
}

function assertGuardMatchesRunner(
  guard: TaskRunnerStartGuard,
  expected: AssertTaskRunnerStartGuardOptions['expectedRunner']
): void {
  if (!expected) return;
  if (
    guard.taskId === expected.taskId &&
    guard.projectId === expected.projectId &&
    guard.userId === expected.userId &&
    guard.chatSessionId === expected.chatSessionId
  ) {
    return;
  }
  revoked(`Reserved task submission guard identity does not match TaskRunner ${expected.taskId}`);
}

interface ReservedSubmissionAuthorityRow {
  status: string;
  project_id: string;
  user_id: string;
  chat_session_id: string | null;
  intent_fingerprint: string;
  checkpoint_chat_session_id: string;
  revocation_reason: string | null;
}

async function assertReservedSubmissionGuard(
  env: Env,
  guard: TaskRunnerReservedSubmissionGuard,
  options: AssertTaskRunnerStartGuardOptions
): Promise<void> {
  const task = await readReservedSubmissionAuthority(env, guard);
  assertReservedSubmissionAuthorityRow(guard, task, options);

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
  const sessionCreatedByUserId =
    typeof session.createdByUserId === 'string' ? session.createdByUserId : null;
  if (sessionTaskId !== guard.taskId) {
    revoked(
      `Reserved task submission authority revoked: session ${guard.chatSessionId} identity changed`
    );
  }
  if (sessionCreatedByUserId !== guard.userId) {
    revoked(
      `Reserved task submission authority revoked: session ${guard.chatSessionId} owner changed`
    );
  }
  if (sessionStatus && TERMINAL_SESSION_STATUSES.has(sessionStatus)) {
    revoked(
      `Reserved task submission authority revoked: session ${guard.chatSessionId} is ${sessionStatus}`
    );
  }

  const refreshedTask = await readReservedSubmissionAuthority(env, guard);
  assertReservedSubmissionAuthorityRow(guard, refreshedTask, options);
}

async function readReservedSubmissionAuthority(
  env: Env,
  guard: TaskRunnerReservedSubmissionGuard
): Promise<ReservedSubmissionAuthorityRow | null> {
  return env.DATABASE.prepare(
    `SELECT t.status, t.project_id, t.user_id, t.chat_session_id,
            c.intent_fingerprint, c.chat_session_id AS checkpoint_chat_session_id,
            r.reason AS revocation_reason
       FROM tasks t
       INNER JOIN task_submission_checkpoints c ON c.task_id = t.id
       LEFT JOIN reserved_task_session_revocations r
         ON r.project_id = t.project_id
        AND r.chat_session_id = t.chat_session_id
      WHERE t.id = ?
        AND t.project_id = ?
        AND t.user_id = ?
      LIMIT 1`
  )
    .bind(guard.taskId, guard.projectId, guard.userId)
    .first<ReservedSubmissionAuthorityRow>();
}

function assertReservedSubmissionAuthorityRow(
  guard: TaskRunnerReservedSubmissionGuard,
  task: ReservedSubmissionAuthorityRow | null,
  options: AssertTaskRunnerStartGuardOptions
): void {
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
  if (
    guard.expiresAt !== undefined &&
    task.status !== 'in_progress' &&
    guard.expiresAt <= Date.now()
  ) {
    revoked(`Reserved task submission start deadline expired for ${guard.taskId}`);
  }
  if (task.revocation_reason) {
    revoked(
      `Reserved task submission authority revoked: session ${guard.chatSessionId} was revoked (${task.revocation_reason})`
    );
  }
  if (options.requireQueuedTask && task.status !== 'queued') {
    revoked(
      `Reserved task submission authority revoked: task ${guard.taskId} is ${task.status}, not queued`
    );
  }
  if (!TASK_EXECUTION_STATUSES.has(task.status)) {
    revoked(`Reserved task submission authority revoked: task ${guard.taskId} is not executable`);
  }
}
