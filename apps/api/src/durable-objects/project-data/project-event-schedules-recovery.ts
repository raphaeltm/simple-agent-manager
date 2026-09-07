import type {
  ProjectSchedule,
  ProjectScheduleExecution,
  ProjectScheduleMutationResult,
} from '@simple-agent-manager/shared';

import { requireScheduleAction } from './project-event-schedules-authority';
import { scheduleLimits } from './project-event-schedules-config';
import { getSchedule, ProjectScheduleNotFoundError } from './project-event-schedules-storage';
import { normalizeScheduleVersion } from './project-event-schedules-validation';
import { ProjectEventValidationError } from './project-events-contracts';
import { chunkIdsForBindBudget } from './project-events-storage-helpers';
import { isPlainObject } from './project-events-values';
import type { Env } from './types';

type TaskReceipt = {
  id: string;
  status: string;
  error_message: string | null;
  chat_session_id: string | null;
  source_execution_id: string | null;
  checkpoint_session_id: string | null;
  checkpoint_state: string | null;
  task_user_id: string;
  checkpoint_project_id: string | null;
  checkpoint_user_id: string | null;
  source_kind: string | null;
  source_id: string | null;
};

function hasRetryCapacity(sql: SqlStorage, env: Env, schedule: ProjectSchedule): boolean {
  const limits = scheduleLimits(env);
  const active = sql
    .exec(
      `SELECT id FROM project_schedules INDEXED BY idx_project_schedules_active_capacity
     WHERE project_id = ? AND execution_finished_at IS NULL
       AND state IN ('pending','processing','admitted') LIMIT ?`,
      schedule.projectId,
      limits.maxSchedules
    )
    .toArray();
  if (active.length >= limits.maxSchedules) return false;
  if (!schedule.watchId) return true;
  const watch = sql
    .exec(
      'SELECT max_concurrent FROM project_standing_watches WHERE project_id=? AND id=?',
      schedule.projectId,
      schedule.watchId
    )
    .toArray()[0];
  if (typeof watch?.max_concurrent !== 'number') return false;
  const live = sql
    .exec(
      `SELECT id FROM project_schedules WHERE watch_id = ? AND id <> ?
     AND execution_finished_at IS NULL AND state IN ('pending','processing','admitted','ambiguous') LIMIT ?`,
      schedule.watchId,
      schedule.id,
      watch.max_concurrent
    )
    .toArray();
  return live.length < watch.max_concurrent;
}

/** Only storage reads: inspecting a receipt must never wake a runtime or replay a prompt. */
export async function withScheduleExecution(
  sql: SqlStorage,
  env: Env,
  schedules: ProjectSchedule[],
  now = Date.now()
): Promise<ProjectSchedule[]> {
  const firstSchedule = schedules[0];
  if (!firstSchedule) return [];
  const reservations = new Map(
    schedules.map((schedule) => [
      schedule.id,
      sql
        .exec(
          `SELECT reserved_task_id, reserved_session_id, submission_completed_at
     FROM project_schedules WHERE project_id = ? AND id = ?`,
          schedule.projectId,
          schedule.id
        )
        .toArray()[0],
    ])
  );
  const taskIds = [
    ...new Set(
      schedules.flatMap((schedule) => {
        const id = reservations.get(schedule.id)?.reserved_task_id ?? schedule.resultTaskId;
        return schedule.action.kind === 'start_session' && typeof id === 'string' ? [id] : [];
      })
    ),
  ];
  const tasks = new Map<string, TaskReceipt>();
  let unavailable = false;
  // The list's existing page cap bounds total work. Each D1 query stays within its bind budget.
  for (const ids of chunkIdsForBindBudget(taskIds, 1)) {
    try {
      const result = await env.DATABASE.prepare(
        `SELECT t.id, t.status, t.error_message, t.chat_session_id, t.user_id AS task_user_id,
                c.source_execution_id, c.chat_session_id AS checkpoint_session_id, c.checkpoint_state,
                c.project_id AS checkpoint_project_id, c.user_id AS checkpoint_user_id, c.source_kind, c.source_id
         FROM tasks t LEFT JOIN task_submission_checkpoints c ON c.task_id = t.id
         WHERE t.project_id = ? AND t.id IN (${ids.map(() => '?').join(',')})`
      )
        .bind(firstSchedule.projectId, ...ids)
        .all<TaskReceipt>();
      for (const task of result.results) tasks.set(task.id, task);
    } catch {
      unavailable = true;
    }
  }
  return schedules.map((schedule) => {
    const reservation = reservations.get(schedule.id);
    const taskId =
      typeof reservation?.reserved_task_id === 'string'
        ? reservation.reserved_task_id
        : schedule.resultTaskId;
    const sessionId =
      typeof reservation?.reserved_session_id === 'string'
        ? reservation.reserved_session_id
        : schedule.resultSessionId;
    const execution: ProjectScheduleExecution = {
      kind: schedule.action.kind,
      status: schedule.eventId ? 'unavailable' : 'not_started',
      checkedAt: now,
      deliveryId: schedule.deliveryId,
      taskId,
      sessionId,
      receiptState: null,
      error: null,
      retrySubmissionAllowed: false,
      submissionDeadline:
        schedule.action.kind === 'start_session'
          ? Math.min(schedule.expiresAt, schedule.dueAt + scheduleLimits(env).maxDeferralMs)
          : null,
    };
    if (schedule.action.kind === 'message_session' && schedule.deliveryId) {
      const receipt = sql
        .exec(
          `SELECT delivery_state, last_error FROM session_inbox WHERE id = ? AND target_session_id = ?`,
          schedule.deliveryId,
          schedule.action.sessionId
        )
        .toArray()[0];
      if (typeof receipt?.delivery_state === 'string') {
        execution.status = receipt.delivery_state;
        execution.receiptState = receipt.delivery_state;
        execution.error = typeof receipt.last_error === 'string' ? receipt.last_error : null;
      }
    } else if (schedule.action.kind === 'start_session' && taskId) {
      const task = tasks.get(taskId);
      const matches =
        task &&
        task.source_execution_id === schedule.id &&
        task.checkpoint_session_id === sessionId &&
        task.chat_session_id === sessionId &&
        task.task_user_id === schedule.creatorUserId &&
        task.checkpoint_user_id === schedule.creatorUserId &&
        task.checkpoint_project_id === schedule.projectId &&
        task.source_kind === (schedule.watchId ? 'standing_watch' : 'schedule') &&
        task.source_id === (schedule.watchId ?? schedule.id);
      if (matches) {
        execution.status = task.status;
        execution.receiptState = task.checkpoint_state;
        execution.error = task.error_message;
      }
      // An existing queued checkpoint goes through the reserved adapter's receipt-first
      // reconciliation. Absence cannot prove the task never started: retain uncertainty.
      execution.retrySubmissionAllowed =
        !unavailable &&
        Boolean(schedule.eventId) &&
        ['failed', 'ambiguous'].includes(schedule.state) &&
        schedule.nextAttemptAt === null &&
        reservation?.submission_completed_at === null &&
        execution.submissionDeadline !== null &&
        execution.submissionDeadline > now &&
        Boolean(matches && task.status === 'queued') &&
        hasRetryCapacity(sql, env, schedule);
    }
    return { ...schedule, execution };
  });
}

export async function withSingleScheduleExecution(
  sql: SqlStorage,
  env: Env,
  schedule: ProjectSchedule,
  now = Date.now()
): Promise<ProjectSchedule & { execution: ProjectScheduleExecution }> {
  const observed = (await withScheduleExecution(sql, env, [schedule], now))[0];
  if (!observed?.execution) throw new Error('Schedule execution observation is missing');
  return { ...observed, execution: observed.execution };
}

/** Versioned operator recovery; no new identities, changed intent, or extended deadline. */
export async function reconcileSchedule(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  id: string,
  request: unknown,
  now = Date.now()
): Promise<ProjectScheduleMutationResult> {
  if (
    !isPlainObject(request) ||
    Object.keys(request).some((key) => !['expectedVersion', 'retrySubmission'].includes(key))
  ) {
    throw new ProjectEventValidationError('Invalid schedule reconciliation request');
  }
  const version = normalizeScheduleVersion(request.expectedVersion);
  if (request.retrySubmission !== undefined && typeof request.retrySubmission !== 'boolean') {
    throw new ProjectEventValidationError('retrySubmission must be a boolean');
  }
  const schedule = getSchedule(sql, projectId, id);
  if (!schedule) throw new ProjectScheduleNotFoundError();
  if (schedule.version !== version)
    throw new ProjectEventValidationError('Schedule version conflict');
  const observed = await withSingleScheduleExecution(sql, env, schedule, now);
  const execution = observed.execution;
  let retry = false;
  if (request.retrySubmission === true) {
    if (!execution.retrySubmissionAllowed || execution.submissionDeadline === null) {
      throw new ProjectEventValidationError(
        'Task submission retry is unavailable; inspect the receipt and original deadline'
      );
    }
    await requireScheduleAction(sql, env, projectId, schedule.creatorUserId, schedule.action);
    if (Date.now() >= execution.submissionDeadline) {
      throw new ProjectEventValidationError('Original task submission deadline expired');
    }
    retry = true;
  }
  // External reads may interleave with a cancellation/reschedule or another operator.
  const current = getSchedule(sql, projectId, id);
  if (
    !current ||
    current.version !== version ||
    current.state !== schedule.state ||
    current.nextAttemptAt !== schedule.nextAttemptAt
  ) {
    throw new ProjectEventValidationError('Schedule version conflict');
  }
  if (retry && !hasRetryCapacity(sql, env, current)) {
    throw new ProjectEventValidationError('Task submission retry capacity is unavailable');
  }
  const terminal =
    schedule.action.kind === 'message_session'
      ? ['acked', 'expired', 'failed'].includes(execution.status)
      : ['completed', 'failed', 'cancelled'].includes(execution.status);
  const started =
    schedule.action.kind === 'start_session' &&
    ['delegated', 'in_progress', 'awaiting_followup', 'completed', 'failed', 'cancelled'].includes(
      execution.status
    );
  const known = !['unavailable', 'not_started', 'ambiguous'].includes(execution.status);
  const outcome = retry
    ? 'retry_scheduled'
    : !schedule.eventId
      ? 'not_admitted'
      : known
        ? 'observed'
        : 'unresolved';
  let changed = false;
  const monitor = !terminal && known && (schedule.action.kind === 'message_session' || started);
  if (
    schedule.eventId &&
    ['failed', 'ambiguous'].includes(schedule.state) &&
    schedule.nextAttemptAt === null &&
    (retry || terminal || monitor)
  ) {
    // Receipt-only recovery can restore monitoring, but never invokes submission or delivery.
    changed =
      sql.exec(
        `UPDATE project_schedules SET version = version + 1, updated_at = ?,
       state = CASE WHEN ? = 1 OR ? = 1 THEN 'admitted' ELSE state END,
       next_attempt_at = ?, attempt_count = CASE WHEN ? = 1 THEN 0 ELSE attempt_count END,
       execution_finished_at = CASE WHEN ? = 1 THEN COALESCE(execution_finished_at, ?) ELSE execution_finished_at END,
       submission_completed_at = CASE WHEN ? = 1 THEN COALESCE(submission_completed_at, ?) ELSE submission_completed_at END,
       result_task_id = COALESCE(result_task_id, ?), result_session_id = COALESCE(result_session_id, ?),
       last_error = ?, claim_token = NULL, claim_until = NULL
       WHERE project_id = ? AND id = ? AND version = ?`,
        now,
        retry ? 1 : 0,
        monitor ? 1 : 0,
        retry ? now : monitor ? now + scheduleLimits(env).retryBaseMs : null,
        retry ? 1 : 0,
        terminal ? 1 : 0,
        now,
        started ? 1 : 0,
        now,
        execution.taskId,
        execution.sessionId,
        execution.error,
        projectId,
        id,
        version
      ).rowsWritten > 0;
  }
  const result = getSchedule(sql, projectId, id);
  if (!result) throw new ProjectScheduleNotFoundError();
  return {
    schedule: {
      ...result,
      execution: {
        ...execution,
        retrySubmissionAllowed: changed ? false : execution.retrySubmissionAllowed,
      },
    },
    changed,
    idempotent: !changed,
    actionAlreadyAdmitted: Boolean(schedule.eventId),
    recovery: {
      outcome,
      message: retry
        ? 'Bounded task submission retry scheduled with the original identities and deadline'
        : known
          ? 'Canonical execution receipt observed'
          : !schedule.eventId
            ? 'Schedule has not admitted an action'
            : 'Execution receipt remains uncertain; no action replayed and watch concurrency remains held',
    },
  };
}
