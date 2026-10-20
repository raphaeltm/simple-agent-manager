import type { Env } from '../env';
import { errors } from '../middleware/error';
import * as projectData from './project-data';
import { getTaskRunnerStatus } from './task-runner-do';

/** Server-only identities committed by SamSession before invoking a project operation.
 * Recovery is observation only: it must never replay provisioning or initial messages.
 */
export interface SamDispatchReservation {
  taskId: string;
  sessionId: string;
  initialMessageId: string;
  statusEventId: string;
  reconcileOnly?: boolean;
}

export interface ReconciledSamDispatch {
  taskId: string;
  sessionId: string;
  branchName: string;
  status: string;
  executionStep: string | null;
  recovered: true;
  dispatchState: 'confirmed' | 'uncertain';
}

export function validateSamDispatchReservation(
  reservation: SamDispatchReservation,
  via: string
): void {
  if (
    via !== 'sam' ||
    ![
      reservation.taskId,
      reservation.sessionId,
      reservation.initialMessageId,
      reservation.statusEventId,
    ].every((value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)) ||
    (reservation.reconcileOnly !== undefined && typeof reservation.reconcileOnly !== 'boolean')
  ) {
    throw errors.badRequest('Invalid SAM dispatch reservation');
  }
}

/** Called only after current project and repository authorization. */
export async function reconcileSamDispatch(
  env: Env,
  userId: string,
  projectId: string,
  reservation: SamDispatchReservation
): Promise<ReconciledSamDispatch | null> {
  const task = await env.DATABASE.prepare(
    `SELECT project_id, user_id, chat_session_id, output_branch, status, execution_step
       FROM tasks WHERE id = ?`
  )
    .bind(reservation.taskId)
    .first<{
      project_id: string;
      user_id: string;
      chat_session_id: string | null;
      output_branch: string | null;
      status: string;
      execution_step: string | null;
    }>();
  if (!task) {
    if (reservation.reconcileOnly) {
      throw errors.conflict(
        'SAM dispatch outcome is uncertain; the reserved task is not observable. No work was replayed.'
      );
    }
    return null;
  }
  if (
    task.project_id !== projectId ||
    task.user_id !== userId ||
    task.chat_session_id !== reservation.sessionId
  ) {
    throw errors.conflict('SAM dispatch reservation does not match the existing task.');
  }
  const session = await projectData.getSession(env, projectId, reservation.sessionId);
  if (!session || session.taskId !== reservation.taskId || session.createdByUserId !== userId) {
    throw errors.conflict(
      'SAM dispatch outcome is uncertain; its reserved session is unavailable or does not match. No work was replayed.'
    );
  }
  const statusEvent = await env.DATABASE.prepare(
    'SELECT task_id, actor_id FROM task_status_events WHERE id = ?'
  )
    .bind(reservation.statusEventId)
    .first<{ task_id: string; actor_id: string | null }>();
  if (
    !statusEvent ||
    statusEvent.task_id !== reservation.taskId ||
    statusEvent.actor_id !== userId
  ) {
    throw errors.conflict(
      'SAM dispatch outcome is uncertain; its admission receipt does not match. No work was replayed.'
    );
  }
  // Terminal outcomes are definitive observations, not a claim that startup succeeded.
  let confirmed = ['in_progress', 'delegated', 'completed', 'failed', 'cancelled'].includes(
    task.status
  );
  if (!confirmed && task.execution_step !== 'instant_persistence') {
    try {
      const state = await getTaskRunnerStatus(env, reservation.taskId);
      if (state && typeof state === 'object') {
        const observed = state as Record<string, unknown>;
        const config = observed.config;
        confirmed =
          observed.taskId === reservation.taskId &&
          observed.projectId === projectId &&
          observed.userId === userId &&
          !!config &&
          typeof config === 'object' &&
          (config as Record<string, unknown>).chatSessionId === reservation.sessionId;
      }
    } catch {
      // A failed read is uncertainty, never permission to repeat a start.
    }
  }
  return {
    taskId: reservation.taskId,
    sessionId: reservation.sessionId,
    branchName: task.output_branch ?? '',
    status: task.status,
    executionStep: task.execution_step,
    recovered: true,
    dispatchState: confirmed ? 'confirmed' : 'uncertain',
  };
}
