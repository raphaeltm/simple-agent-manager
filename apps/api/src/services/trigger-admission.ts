import {
  DEFAULT_TRIGGER_AUTO_PAUSE_AFTER_FAILURES,
  TASK_TERMINAL_STATUSES,
  type TriggeredBy,
} from '@simple-agent-manager/shared';

import type * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { ulid } from '../lib/ulid';
import { TERMINAL_STATUS_VALUES } from './task-status';
import { readTriggerAdmissionSnapshot } from './trigger-admission-snapshot';
import { resolveTriggerExecutionUserId } from './trigger-execution-principal';
import {
  type AdmissionSkipReason,
  classifyReservationFailure,
  EXECUTION_HOLDS_RUN_SLOT_BINDINGS,
  EXECUTION_HOLDS_RUN_SLOT_SQL,
} from './trigger-run-slots';
import { type SubmittedTriggerTask, TriggerTaskSubmissionPendingError } from './trigger-submission';
import { submitTriggeredTask } from './trigger-submit';

export type TriggerTaskSubmitter = typeof submitTriggeredTask;

const TERMINAL_TASK_STATUSES = new Set<string>(TASK_TERMINAL_STATUSES);

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
  githubDeliveryId?: string;
  githubProcessingToken?: string;
  renderPrompt: (
    executionId: string,
    sequenceNumber: number,
    reservedTrigger?: schema.TriggerRow
  ) => string;
  /** Durable hook used to link source admission state before external submission begins. */
  beforeSubmit?: (executionId: string) => Promise<void>;
  /**
   * An execution id the caller stored durably before calling (email intake). A later call with
   * the same id resumes that execution, including its rendered prompt, instead of reserving
   * another, the way a GitHub delivery id does. Submission is idempotent per execution id.
   */
  executionId?: string;
  /**
   * The stored agent email this attempt holds. Admission's writes to the execution (taking a
   * failed one back, recording a failure) apply only while the attempt still holds this lease,
   * so an attempt that lost the email cannot change the execution of the attempt that took over.
   */
  emailLease?: { rowId: string; leaseToken: string };
}

/** True when the caller holds no agent email, or still holds the email lease it passed. */
const HOLDS_EMAIL_LEASE_SQL = `(? IS NULL OR EXISTS (SELECT 1 FROM trigger_email_messages m
  WHERE m.id = ? AND m.status = 'processing' AND m.lease_token = ?))`;

function emailLeaseBindings(lease: TriggerAdmissionInput['emailLease']): (string | null)[] {
  return [lease?.rowId ?? null, lease?.rowId ?? null, lease?.leaseToken ?? null];
}

async function consecutiveFailureCount(
  env: Env,
  triggerId: string,
  threshold: number
): Promise<{ count: number; resetSequence: number | null }> {
  const rows = await env.DATABASE.prepare(
    `SELECT e.status, t.status AS taskStatus, tr.auto_pause_reset_sequence AS resetSequence
       FROM trigger_executions e
       LEFT JOIN tasks t ON t.id = e.task_id
      JOIN triggers tr ON tr.id = e.trigger_id
      WHERE e.trigger_id = ? AND e.status != 'skipped'
        AND (tr.auto_pause_reset_sequence IS NULL OR e.sequence_number >= tr.auto_pause_reset_sequence)
      ORDER BY e.sequence_number DESC, e.created_at DESC LIMIT ?`
  )
    .bind(triggerId, threshold)
    .all<{ status: string; taskStatus: string | null; resetSequence: number | null }>();
  let count = 0;
  for (const row of rows.results) {
    const linkedTaskStillLive =
      row.taskStatus !== null && !TERMINAL_TASK_STATUSES.has(row.taskStatus);
    if (row.status !== 'failed' || linkedTaskStillLive) break;
    count += 1;
  }
  return { count, resetSequence: rows.results[0]?.resetSequence ?? null };
}

async function recordSkippedExecution(
  env: Env,
  trigger: schema.TriggerRow,
  eventType: string,
  scheduledAt: string,
  reason: AdmissionSkipReason,
  githubDeliveryId?: string
): Promise<string> {
  const executionId = ulid();
  const now = new Date().toISOString();
  const insert = env.DATABASE.prepare(
    `INSERT OR IGNORE INTO trigger_executions
      (id, trigger_id, project_id, status, skip_reason, event_type, scheduled_at,
       completed_at, sequence_number, created_at, github_delivery_id)
     SELECT ?, id, project_id, 'skipped', ?, ?, ?, ?, next_execution_sequence, ?, ?
       FROM triggers WHERE id = ? AND project_id = ?`
  ).bind(
    executionId,
    reason,
    eventType,
    scheduledAt,
    now,
    now,
    githubDeliveryId ?? null,
    trigger.id,
    trigger.projectId
  );
  const increment = env.DATABASE.prepare(
    `UPDATE triggers SET next_execution_sequence = next_execution_sequence + 1, updated_at = ?
     WHERE id = ? AND project_id = ?
       AND EXISTS (SELECT 1 FROM trigger_executions WHERE id = ?)`
  ).bind(now, trigger.id, trigger.projectId, executionId);
  const [insertResult] = await env.DATABASE.batch([insert, increment]);
  if (!insertResult?.meta.changes) {
    if (githubDeliveryId) {
      const winner = await env.DATABASE.prepare(
        'SELECT id FROM trigger_executions WHERE github_delivery_id = ? AND trigger_id = ?'
      )
        .bind(githubDeliveryId, trigger.id)
        .first<{ id: string }>();
      if (winner) return winner.id;
    }
    throw new Error('Failed to record skipped trigger execution');
  }
  return executionId;
}

async function recordTaskBoundary(
  env: Env,
  trigger: schema.TriggerRow,
  executionId: string,
  submitted: SubmittedTriggerTask,
  now: string
): Promise<boolean> {
  try {
    await env.DATABASE.batch([
      env.DATABASE.prepare(
        `UPDATE triggers SET last_triggered_at = ?, trigger_count = trigger_count + 1, updated_at = ?
         WHERE id = ? AND project_id = ? AND EXISTS
           (SELECT 1 FROM trigger_executions WHERE id = ? AND submission_recorded_at IS NULL)`
      ).bind(now, now, trigger.id, trigger.projectId, executionId),
      env.DATABASE.prepare(
        `UPDATE trigger_executions SET task_id = COALESCE(task_id, ?),
            status = CASE WHEN status IN ('queued', 'failed') AND NOT EXISTS
              (SELECT 1 FROM tasks WHERE id = ? AND status IN (${TERMINAL_STATUS_VALUES.map(() => '?').join(', ')}))
              THEN 'running' ELSE status END, submission_recorded_at = ?
         WHERE id = ? AND trigger_id = ? AND project_id = ? AND submission_recorded_at IS NULL`
      ).bind(
        submitted.taskId,
        submitted.taskId,
        ...TERMINAL_STATUS_VALUES,
        now,
        executionId,
        trigger.id,
        trigger.projectId
      ),
    ]);
    return true;
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
    return false;
  }
}

export async function admitAndSubmitTriggerExecution(
  env: Env,
  input: TriggerAdmissionInput,
  submitter: TriggerTaskSubmitter = submitTriggeredTask
): Promise<TriggerAdmissionResult> {
  let { trigger } = input;
  type PreviousExecution = {
    id: string;
    status: string;
    skip_reason: AdmissionSkipReason | null;
    sequence_number: number;
    rendered_prompt: string | null;
    admission_snapshot_json: string | null;
  };
  let previous: PreviousExecution | null = null;
  if (input.githubDeliveryId) {
    previous = await env.DATABASE.prepare(
      'SELECT * FROM trigger_executions WHERE github_delivery_id = ? AND trigger_id = ?'
    )
      .bind(input.githubDeliveryId, trigger.id)
      .first<PreviousExecution>();
  } else if (input.executionId) {
    previous = await env.DATABASE.prepare(
      'SELECT * FROM trigger_executions WHERE id = ? AND trigger_id = ?'
    )
      .bind(input.executionId, trigger.id)
      .first<PreviousExecution>();
  }
  if (previous?.status === 'skipped') {
    if (!previous.skip_reason) throw new Error('Skipped execution lacks a reason');
    return { outcome: 'skipped', executionId: previous.id, reason: previous.skip_reason };
  }
  if (
    input.trigger.status === 'disabled' ||
    (input.trigger.status === 'paused' && !input.allowPaused)
  )
    return { outcome: 'inactive', reason: input.trigger.status };
  if (previous?.admission_snapshot_json)
    trigger = readTriggerAdmissionSnapshot(previous.admission_snapshot_json, trigger);

  if (trigger.status === 'disabled' || (trigger.status === 'paused' && !input.allowPaused)) {
    return { outcome: 'inactive', reason: trigger.status };
  }

  const autoPauseThreshold = parsePositiveInt(
    env.TRIGGER_AUTO_PAUSE_AFTER_FAILURES,
    DEFAULT_TRIGGER_AUTO_PAUSE_AFTER_FAILURES
  );
  while (!input.allowPaused && !previous) {
    const failures = await consecutiveFailureCount(env, trigger.id, autoPauseThreshold);
    if (failures.count < autoPauseThreshold) break;
    const paused = await env.DATABASE.prepare(
      `UPDATE triggers SET status = 'paused', next_fire_at = NULL, updated_at = ?
       WHERE id = ? AND project_id = ? AND status = 'active'
         AND auto_pause_reset_sequence IS ?`
    )
      .bind(new Date().toISOString(), trigger.id, trigger.projectId, failures.resetSequence)
      .run();
    if (paused.meta.changes) return { outcome: 'inactive', reason: 'paused' };
    // Resume may have replaced the failure window while it was being counted.
    // Recount that window; reservation below independently checks current status.
    const state = await env.DATABASE.prepare(
      'SELECT status FROM triggers WHERE id = ? AND project_id = ?'
    )
      .bind(trigger.id, trigger.projectId)
      .first<{ status: string }>();
    if (state?.status !== 'active') break;
  }

  const executionId = previous?.id ?? input.executionId ?? ulid();
  const now = new Date().toISOString();
  const scheduledAt = input.scheduledAt ?? now;
  const allowPaused = input.allowPaused ? 1 : 0;
  const reserve = env.DATABASE.prepare(
    `INSERT OR IGNORE INTO trigger_executions
      (id, trigger_id, project_id, status, event_type, scheduled_at, started_at,
       sequence_number, created_at, github_delivery_id, admission_snapshot_json)
     SELECT ?, id, project_id, 'queued', ?, ?, ?, next_execution_sequence, ?, ?, ?
       FROM triggers
      WHERE id = ? AND project_id = ?
        AND (status = 'active' OR (? = 1 AND status = 'paused'))
        AND (SELECT COUNT(*) FROM trigger_executions e
             LEFT JOIN tasks t ON t.id = e.task_id
             WHERE e.trigger_id = triggers.id
               AND ${EXECUTION_HOLDS_RUN_SLOT_SQL})
            < CASE WHEN skip_if_running = 1 THEN 1 ELSE max_concurrent END`
  ).bind(
    executionId,
    input.eventType,
    scheduledAt,
    now,
    now,
    input.githubDeliveryId ?? null,
    input.githubDeliveryId ? JSON.stringify(trigger) : null,
    trigger.id,
    trigger.projectId,
    allowPaused,
    ...EXECUTION_HOLDS_RUN_SLOT_BINDINGS
  );
  const increment = env.DATABASE.prepare(
    `UPDATE triggers SET next_execution_sequence = next_execution_sequence + 1, updated_at = ?
     WHERE id = ? AND project_id = ?
       AND EXISTS (SELECT 1 FROM trigger_executions WHERE id = ?)`
  ).bind(now, trigger.id, trigger.projectId, executionId);
  const [reserveResult] = previous ? [] : await env.DATABASE.batch([reserve, increment]);

  if (!previous && !reserveResult?.meta.changes) {
    if (input.githubDeliveryId) {
      const winner = await env.DATABASE.prepare(
        'SELECT id FROM trigger_executions WHERE github_delivery_id = ? AND trigger_id = ?'
      )
        .bind(input.githubDeliveryId, trigger.id)
        .first<{ id: string }>();
      if (winner) return admitAndSubmitTriggerExecution(env, input, submitter);
    }
    const reason = await classifyReservationFailure(env, trigger);
    if (reason === 'paused' || reason === 'disabled') return { outcome: 'inactive', reason };
    const skippedId = await recordSkippedExecution(
      env,
      trigger,
      input.eventType,
      scheduledAt,
      reason,
      input.githubDeliveryId
    );
    if (input.githubDeliveryId) return admitAndSubmitTriggerExecution(env, input, submitter);
    return { outcome: 'skipped', executionId: skippedId, reason };
  }

  const sequence = await env.DATABASE.prepare(
    'SELECT sequence_number AS sequenceNumber FROM trigger_executions WHERE id = ?'
  )
    .bind(executionId)
    .first<{ sequenceNumber: number }>();
  if (!sequence) throw new Error('Reserved trigger execution not found');

  try {
    let renderedPrompt =
      previous?.rendered_prompt ??
      input.renderPrompt(executionId, sequence.sequenceNumber, trigger);
    await env.DATABASE.prepare(
      'UPDATE trigger_executions SET rendered_prompt = COALESCE(rendered_prompt, ?) WHERE id = ? AND trigger_id = ?'
    )
      .bind(renderedPrompt, executionId, trigger.id)
      .run();

    if (input.githubDeliveryId) {
      const stored = await env.DATABASE.prepare(
        'SELECT rendered_prompt FROM trigger_executions WHERE id = ?'
      )
        .bind(executionId)
        .first<{ rendered_prompt: string }>();
      if (!stored) throw new Error('Reserved execution was removed');
      renderedPrompt = stored.rendered_prompt;
    }
    if (previous) {
      const task = await env.DATABASE.prepare(
        'SELECT id, chat_session_id, output_branch, status FROM tasks WHERE trigger_execution_id = ?'
      )
        .bind(executionId)
        .first<{
          id: string;
          chat_session_id: string | null;
          output_branch: string | null;
          status: string;
        }>();
      if (task && task.status !== 'queued' && task.status !== 'pending') {
        const reconciled = await recordTaskBoundary(
          env,
          trigger,
          executionId,
          {
            taskId: task.id,
            sessionId: task.chat_session_id ?? '',
            branchName: task.output_branch ?? '',
          },
          now
        );
        if (!reconciled && input.githubDeliveryId)
          throw new Error('Task boundary reconciliation pending');
        return {
          outcome: 'submitted',
          executionId,
          taskId: task.id,
          sessionId: task.chat_session_id ?? '',
          branchName: task.output_branch ?? '',
        };
      }
    }
    if (previous && input.githubDeliveryId) {
      await env.DATABASE.prepare(
        `UPDATE trigger_executions SET status = 'queued', completed_at = NULL
         WHERE id = ? AND status = 'failed' AND task_id IS NULL
           AND EXISTS (SELECT 1 FROM github_trigger_inbox g WHERE g.id = ? AND g.state IN ('pending','processing'))`
      )
        .bind(executionId, input.githubDeliveryId)
        .run();
    } else if (previous && input.executionId) {
      // A caller-owned retry takes the failed attempt's execution back rather than reserving
      // another, while it still holds its email.
      await env.DATABASE.prepare(
        `UPDATE trigger_executions SET status = 'queued', completed_at = NULL
         WHERE id = ? AND status = 'failed' AND task_id IS NULL AND ${HOLDS_EMAIL_LEASE_SQL}`
      )
        .bind(executionId, ...emailLeaseBindings(input.emailLease))
        .run();
    }
    await input.beforeSubmit?.(executionId);

    const executionUserId = resolveTriggerExecutionUserId(trigger);
    const submitted = await submitter(env, {
      triggerId: trigger.id,
      triggerExecutionId: executionId,
      projectId: trigger.projectId,
      userId: executionUserId,
      renderedPrompt,
      triggeredBy: input.triggeredBy,
      agentProfileId: trigger.agentProfileId,
      skillId: trigger.skillId,
      taskMode: (trigger.taskMode ?? 'task') as 'task' | 'conversation',
      vmSizeOverride: trigger.vmSizeOverride,
      resourceRequirementsJson: trigger.resourceRequirementsJson,
      triggerName: trigger.name,
    });

    const reconciled = await recordTaskBoundary(env, trigger, executionId, submitted, now);
    if (!reconciled && input.githubDeliveryId)
      throw new Error('Task boundary reconciliation pending');
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
       WHERE id = ? AND trigger_id = ? AND project_id = ? AND task_id IS NULL
         AND (? IS NULL OR EXISTS (SELECT 1 FROM github_trigger_inbox g
           WHERE g.id = ? AND g.state = 'processing' AND g.lease_token = ?))
         AND ${HOLDS_EMAIL_LEASE_SQL}`
    )
      .bind(
        message,
        new Date().toISOString(),
        executionId,
        trigger.id,
        trigger.projectId,
        input.githubProcessingToken ?? null,
        input.githubDeliveryId ?? null,
        input.githubProcessingToken ?? null,
        ...emailLeaseBindings(input.emailLease)
      )
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
