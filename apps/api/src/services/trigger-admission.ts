import {
  DEFAULT_TRIGGER_AUTO_PAUSE_AFTER_FAILURES,
  type TriggeredBy,
  type TriggerSkipReason,
} from '@simple-agent-manager/shared';

import type * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { ulid } from '../lib/ulid';
import {
  type SubmittedTriggerTask,
  TriggerTaskSubmissionPendingError,
} from './trigger-submission';
import { submitTriggeredTask } from './trigger-submit';

export type TriggerTaskSubmitter = typeof submitTriggeredTask;

type AdmissionSkipReason = Extract<TriggerSkipReason, 'still_running' | 'concurrent_limit'>;

export type TriggerAdmissionResult =
  | {
      outcome: 'submitted';
      executionId: string;
      taskId: string;
      sessionId: string;
      branchName: string;
    }
  | {
      outcome: 'pending';
      executionId: string;
      taskId: string;
      sessionId: string;
      branchName: string;
    }
  | { outcome: 'skipped'; executionId: string; reason: AdmissionSkipReason }
  | { outcome: 'inactive'; reason: 'paused' | 'disabled' }
  | { outcome: 'failed'; executionId: string; error: string };

export interface TriggerAdmissionInput {
  trigger: schema.TriggerRow;
  eventType: string;
  triggeredBy: Exclude<TriggeredBy, 'mcp'>;
  scheduledAt?: string;
  allowPaused?: boolean;
  renderPrompt: (executionId: string, sequenceNumber: number) => string;
  /** Durable hook used to link source admission state before external submission begins. */
  beforeSubmit?: (executionId: string) => Promise<void>;
}

async function consecutiveFailureCount(
  env: Env,
  triggerId: string,
  threshold: number
): Promise<number> {
  const rows = await env.DATABASE.prepare(
    `SELECT status FROM trigger_executions
     WHERE trigger_id = ? ORDER BY created_at DESC LIMIT ?`
  )
    .bind(triggerId, threshold)
    .all<{ status: string }>();
  let count = 0;
  for (const row of rows.results) {
    if (row.status !== 'failed') break;
    count += 1;
  }
  return count;
}

async function recordSkippedExecution(
  env: Env,
  trigger: schema.TriggerRow,
  eventType: string,
  scheduledAt: string,
  reason: AdmissionSkipReason
): Promise<string> {
  const executionId = ulid();
  const now = new Date().toISOString();
  const insert = env.DATABASE.prepare(
    `INSERT INTO trigger_executions
      (id, trigger_id, project_id, status, skip_reason, event_type, scheduled_at,
       completed_at, sequence_number, created_at)
     SELECT ?, id, project_id, 'skipped', ?, ?, ?, ?, next_execution_sequence, ?
       FROM triggers WHERE id = ? AND project_id = ?`
  ).bind(executionId, reason, eventType, scheduledAt, now, now, trigger.id, trigger.projectId);
  const increment = env.DATABASE.prepare(
    `UPDATE triggers SET next_execution_sequence = next_execution_sequence + 1, updated_at = ?
     WHERE id = ? AND project_id = ?
       AND EXISTS (SELECT 1 FROM trigger_executions WHERE id = ?)`
  ).bind(now, trigger.id, trigger.projectId, executionId);
  const [insertResult] = await env.DATABASE.batch([insert, increment]);
  if (!insertResult?.meta.changes) throw new Error('Failed to record skipped trigger execution');
  return executionId;
}

async function recordTaskBoundary(
  env: Env,
  trigger: schema.TriggerRow,
  executionId: string,
  submitted: SubmittedTriggerTask,
  now: string
): Promise<void> {
  try {
    await env.DATABASE.batch([
      env.DATABASE.prepare(
        `UPDATE trigger_executions SET task_id = ?, status = 'running'
         WHERE id = ? AND trigger_id = ? AND project_id = ?`
      ).bind(submitted.taskId, executionId, trigger.id, trigger.projectId),
      env.DATABASE.prepare(
        `UPDATE triggers SET last_triggered_at = ?, trigger_count = trigger_count + 1, updated_at = ?
         WHERE id = ? AND project_id = ?`
      ).bind(now, now, trigger.id, trigger.projectId),
    ]);
  } catch (error) {
    // The task boundary already succeeded. Preserve that fact so callers do not
    // retry and double-submit; task lifecycle sync can reconcile the execution.
    log.error('trigger_admission.submitted_state_sync_failed', {
      triggerId: trigger.id,
      executionId,
      taskId: submitted.taskId,
      projectId: trigger.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function classifyReservationFailure(
  env: Env,
  trigger: schema.TriggerRow
): Promise<'paused' | 'disabled' | AdmissionSkipReason> {
  const state = await env.DATABASE.prepare(
    `SELECT status, skip_if_running AS skipIfRunning, max_concurrent AS maxConcurrent,
       (SELECT COUNT(*) FROM trigger_executions e
        WHERE e.trigger_id = triggers.id AND e.status IN ('queued', 'running')) AS activeCount
     FROM triggers WHERE id = ? AND project_id = ?`
  )
    .bind(trigger.id, trigger.projectId)
    .first<{
      status: string;
      skipIfRunning: number;
      maxConcurrent: number;
      activeCount: number;
    }>();
  if (!state || state.status === 'disabled') return 'disabled';
  if (state.status === 'paused') return 'paused';
  return state.skipIfRunning && state.activeCount > 0 ? 'still_running' : 'concurrent_limit';
}

export async function admitAndSubmitTriggerExecution(
  env: Env,
  input: TriggerAdmissionInput,
  submitter: TriggerTaskSubmitter = submitTriggeredTask
): Promise<TriggerAdmissionResult> {
  const { trigger } = input;
  if (trigger.status === 'disabled' || (trigger.status === 'paused' && !input.allowPaused)) {
    return { outcome: 'inactive', reason: trigger.status };
  }

  const autoPauseThreshold = parsePositiveInt(
    env.TRIGGER_AUTO_PAUSE_AFTER_FAILURES,
    DEFAULT_TRIGGER_AUTO_PAUSE_AFTER_FAILURES
  );
  if (
    !input.allowPaused &&
    (await consecutiveFailureCount(env, trigger.id, autoPauseThreshold)) >= autoPauseThreshold
  ) {
    const now = new Date().toISOString();
    await env.DATABASE.prepare(
      `UPDATE triggers SET status = 'paused', next_fire_at = NULL, updated_at = ?
       WHERE id = ? AND project_id = ? AND status = 'active'`
    )
      .bind(now, trigger.id, trigger.projectId)
      .run();
    return { outcome: 'inactive', reason: 'paused' };
  }

  const executionId = ulid();
  const now = new Date().toISOString();
  const scheduledAt = input.scheduledAt ?? now;
  const allowPaused = input.allowPaused ? 1 : 0;
  const reserve = env.DATABASE.prepare(
    `INSERT INTO trigger_executions
      (id, trigger_id, project_id, status, event_type, scheduled_at, started_at,
       sequence_number, created_at)
     SELECT ?, id, project_id, 'queued', ?, ?, ?, next_execution_sequence, ?
       FROM triggers
      WHERE id = ? AND project_id = ?
        AND (status = 'active' OR (? = 1 AND status = 'paused'))
        AND (SELECT COUNT(*) FROM trigger_executions e
             WHERE e.trigger_id = triggers.id AND e.status IN ('queued', 'running'))
            < CASE WHEN skip_if_running = 1 THEN 1 ELSE max_concurrent END`
  ).bind(
    executionId,
    input.eventType,
    scheduledAt,
    now,
    now,
    trigger.id,
    trigger.projectId,
    allowPaused
  );
  const increment = env.DATABASE.prepare(
    `UPDATE triggers SET next_execution_sequence = next_execution_sequence + 1, updated_at = ?
     WHERE id = ? AND project_id = ?
       AND EXISTS (SELECT 1 FROM trigger_executions WHERE id = ?)`
  ).bind(now, trigger.id, trigger.projectId, executionId);
  const [reserveResult] = await env.DATABASE.batch([reserve, increment]);

  if (!reserveResult?.meta.changes) {
    const reason = await classifyReservationFailure(env, trigger);
    if (reason === 'paused' || reason === 'disabled') return { outcome: 'inactive', reason };
    const skippedId = await recordSkippedExecution(
      env,
      trigger,
      input.eventType,
      scheduledAt,
      reason
    );
    return { outcome: 'skipped', executionId: skippedId, reason };
  }

  const sequence = await env.DATABASE.prepare(
    'SELECT sequence_number AS sequenceNumber FROM trigger_executions WHERE id = ?'
  )
    .bind(executionId)
    .first<{ sequenceNumber: number }>();
  if (!sequence) throw new Error('Reserved trigger execution not found');

  try {
    const renderedPrompt = input.renderPrompt(executionId, sequence.sequenceNumber);
    await env.DATABASE.prepare(
      'UPDATE trigger_executions SET rendered_prompt = ? WHERE id = ? AND trigger_id = ?'
    )
      .bind(renderedPrompt, executionId, trigger.id)
      .run();

    await input.beforeSubmit?.(executionId);

    const submitted = await submitter(env, {
      triggerId: trigger.id,
      triggerExecutionId: executionId,
      projectId: trigger.projectId,
      userId: trigger.userId,
      renderedPrompt,
      triggeredBy: input.triggeredBy,
      agentProfileId: trigger.agentProfileId,
      skillId: trigger.skillId,
      taskMode: (trigger.taskMode ?? 'task') as 'task' | 'conversation',
      vmSizeOverride: trigger.vmSizeOverride,
      triggerName: trigger.name,
    });

    await recordTaskBoundary(env, trigger, executionId, submitted, now);
    return { outcome: 'submitted', executionId, ...submitted };
  } catch (error) {
    if (error instanceof TriggerTaskSubmissionPendingError) {
      await recordTaskBoundary(env, trigger, executionId, error.submission, now);
      log.warn('trigger_admission.submission_pending', {
        triggerId: trigger.id,
        executionId,
        taskId: error.submission.taskId,
        projectId: trigger.projectId,
        eventType: input.eventType,
      });
      return { outcome: 'pending', executionId, ...error.submission };
    }
    const message = error instanceof Error ? error.message : String(error);
    await env.DATABASE.prepare(
      `UPDATE trigger_executions SET status = 'failed', error_message = ?, completed_at = ?
       WHERE id = ? AND trigger_id = ? AND project_id = ?`
    )
      .bind(message, new Date().toISOString(), executionId, trigger.id, trigger.projectId)
      .run();
    log.error('trigger_admission.submission_failed', {
      triggerId: trigger.id,
      executionId,
      projectId: trigger.projectId,
      eventType: input.eventType,
      error: message,
    });
    return { outcome: 'failed', executionId, error: message };
  }
}
