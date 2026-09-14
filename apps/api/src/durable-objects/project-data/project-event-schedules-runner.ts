import type { ProjectSchedule } from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { ulid } from '../../lib/ulid';
import type { ReservedTaskSubmissionInput } from '../../services/reserved-task-submission';
import { submitReservedTask } from '../../services/reserved-task-submission';
import {
  type DurabilityFoundationHooks,
  finalizeAcceptedPromptDelivery,
} from './durability-foundation';
import { requireScheduleAction, requireScheduleTarget } from './project-event-schedules-authority';
import { boundedScheduleTaskLabel, scheduleLimits } from './project-event-schedules-config';
import { getSchedule } from './project-event-schedules-storage';
import { admitProjectEvent } from './project-events';
import { ProjectEventValidationError } from './project-events-contracts';
import { stableStringify } from './project-events-values';
import {
  type AcceptPromptDeliveryInput,
  acceptPromptDeliveryInTransaction,
} from './prompt-delivery';
import type { Env } from './types';

const reservationSchema = v.object({
  reserved_task_id: v.string(),
  reserved_session_id: v.string(),
  reserved_message_id: v.string(),
  reserved_status_id: v.string(),
  watch_id: v.nullable(v.string()),
});

/** Both pending intent and admitted task submission retries share the existing DO alarm. */
export function computeScheduleAlarmTime(sql: SqlStorage, projectId: string | null): number | null {
  if (!projectId) return null;
  let next: number | null = null;
  for (const state of ['pending', 'processing', 'admitted']) {
    const row = sql
      .exec(
        `SELECT next_attempt_at FROM project_schedules
      WHERE project_id = ? AND state = ? AND next_attempt_at IS NOT NULL
      ORDER BY next_attempt_at, id LIMIT 1`,
        projectId,
        state
      )
      .toArray()[0];
    if (typeof row?.next_attempt_at === 'number') {
      next = next === null ? row.next_attempt_at : Math.min(next, row.next_attempt_at);
    }
  }
  return next;
}

function dueIds(sql: SqlStorage, projectId: string, now: number, limit: number): string[] {
  const rows = ['pending', 'processing', 'admitted'].flatMap((state) =>
    sql
      .exec(
        `SELECT id, next_attempt_at FROM project_schedules
      WHERE project_id = ? AND state = ? AND next_attempt_at <= ?
      ORDER BY next_attempt_at, id LIMIT ?`,
        projectId,
        state,
        now,
        limit
      )
      .toArray()
  );
  return rows
    .flatMap((row) =>
      typeof row.id === 'string' && typeof row.next_attempt_at === 'number'
        ? [{ id: row.id, at: row.next_attempt_at }]
        : []
    )
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((row) => row.id);
}

async function fingerprint(schedule: ProjectSchedule): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      stableStringify({
        id: schedule.id,
        action: schedule.action,
        dueAt: schedule.dueAt,
        version: schedule.version,
      })
    )
  );
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function claimSchedule(sql: SqlStorage, env: Env, projectId: string, id: string, now: number) {
  const schedule = getSchedule(sql, projectId, id);
  if (!schedule || schedule.state === 'admitted') return null;
  if (schedule.expiresAt <= now) {
    sql.exec(
      `UPDATE project_schedules SET state = 'expired', next_attempt_at = NULL,
      claim_token = NULL, claim_until = NULL, updated_at = ?, last_error = 'Schedule late grace expired'
      WHERE project_id = ? AND id = ? AND state IN ('pending','processing')`,
      now,
      projectId,
      id
    );
    return null;
  }
  const leaseUntil = Math.min(schedule.expiresAt, now + scheduleLimits(env).claimLeaseMs);
  const token = ulid();
  const changed = sql.exec(
    `UPDATE project_schedules SET state = 'processing', claim_token = ?,
    claim_until = ?, next_attempt_at = ?, attempt_count = attempt_count + 1, updated_at = ?
    WHERE project_id = ? AND id = ? AND version = ? AND next_attempt_at <= ?
      AND (state = 'pending' OR (state = 'processing' AND claim_until <= ?))`,
    token,
    leaseUntil,
    leaseUntil,
    now,
    projectId,
    id,
    schedule.version,
    now,
    now
  ).rowsWritten;
  return changed ? { schedule, token } : null;
}

function admitClaim(
  sql: SqlStorage,
  env: Env,
  schedule: ProjectSchedule,
  token: string,
  payloadFingerprint: string,
  targetTaskId: string | null,
  now: number
) {
  const current = sql
    .exec(
      `SELECT id FROM project_schedules
    WHERE project_id = ? AND id = ? AND version = ? AND state = 'processing'
      AND claim_token = ? AND claim_until > ? AND expires_at > ?`,
      schedule.projectId,
      schedule.id,
      schedule.version,
      token,
      now,
      now
    )
    .toArray()[0];
  if (!current) return null;
  if (
    schedule.action.kind === 'message_session' &&
    requireScheduleTarget(sql, schedule.action.sessionId) !== targetTaskId
  ) {
    throw new ProjectEventValidationError('Scheduled target changed before admission');
  }
  const event = admitProjectEvent(sql, env, schedule.projectId, {
    projectId: schedule.projectId,
    source: 'sam.schedule',
    eventType: 'schedule.due',
    subject: { type: 'schedule', id: schedule.id },
    severity: 'info',
    deliveryKey: `${schedule.id}:${schedule.version}`,
    payloadFingerprint,
    metadata: {
      scheduleId: schedule.id,
      creatorUserId: schedule.creatorUserId,
      dueAt: schedule.dueAt,
      admittedAt: now,
      dueToAdmissionMs: Math.max(0, now - schedule.dueAt),
    },
    display: {
      title: 'Scheduled action admitted',
      summary: schedule.reason ?? 'One-off scheduled action',
    },
    occurredAt: schedule.dueAt,
    receivedAt: now,
  });
  if (event.outcome === 'conflict')
    throw new ProjectEventValidationError('Schedule event identity conflict');
  if (schedule.action.kind === 'message_session') {
    const input: AcceptPromptDeliveryInput = {
      deliveryId: ulid(),
      targetSessionId: schedule.action.sessionId,
      displayContent: schedule.action.prompt,
      sourceKind: 'scheduled_action',
      senderType: 'system',
      senderId: schedule.creatorUserId,
      sourceTaskId: targetTaskId,
      ttlMs: Math.min(schedule.expiresAt - now, scheduleLimits(env).deliveryTtlMs),
      metadata: {
        scheduleId: schedule.id,
        creatorUserId: schedule.creatorUserId,
        eventId: event.event.id,
      },
    };
    const accepted = acceptPromptDeliveryInTransaction(sql, env, input, now);
    sql.exec(
      `UPDATE project_schedules SET state = 'admitted', event_id = ?, delivery_id = ?,
      result_session_id = ?, next_attempt_at = ?, claim_token = NULL, claim_until = NULL,
      updated_at = ?, last_error = NULL WHERE project_id = ? AND id = ? AND claim_token = ?`,
      event.event.id,
      accepted.message.id,
      schedule.action.sessionId,
      now + scheduleLimits(env).retryBaseMs,
      now,
      schedule.projectId,
      schedule.id,
      token
    );
    return { input, accepted };
  }
  // Committing this intent is the cancellation boundary. All four identities
  // survive a crash before/after D1 submission and are reused on every retry.
  sql.exec(
    `UPDATE project_schedules SET state = 'admitted', event_id = ?,
    reserved_task_id = ?, reserved_session_id = ?, reserved_message_id = ?, reserved_status_id = ?,
    next_attempt_at = ?, attempt_count = 0, claim_token = NULL, claim_until = NULL,
    updated_at = ?, last_error = NULL WHERE project_id = ? AND id = ? AND claim_token = ?`,
    event.event.id,
    ulid(),
    ulid(),
    ulid(),
    ulid(),
    now,
    now,
    schedule.projectId,
    schedule.id,
    token
  );
  return null;
}

async function submitAdmittedSchedule(sql: SqlStorage, env: Env, projectId: string, id: string) {
  const schedule = getSchedule(sql, projectId, id);
  if (
    !schedule ||
    schedule.state !== 'admitted' ||
    schedule.action.kind !== 'start_session' ||
    schedule.nextAttemptAt === null ||
    schedule.nextAttemptAt > Date.now()
  )
    return;
  const now = Date.now();
  const limits = scheduleLimits(env);
  const reservation = v.parse(
    reservationSchema,
    sql
      .exec(
        `SELECT reserved_task_id, reserved_session_id,
    reserved_message_id, reserved_status_id, watch_id FROM project_schedules
    WHERE project_id = ? AND id = ?`,
        projectId,
        id
      )
      .toArray()[0]
  );
  const submitToken = ulid();
  const claimed = sql.exec(
    `UPDATE project_schedules SET claim_token = ?, next_attempt_at = ?,
    attempt_count = attempt_count + 1, updated_at = ? WHERE project_id = ? AND id = ?
    AND state = 'admitted' AND next_attempt_at <= ?`,
    submitToken,
    now + limits.claimLeaseMs,
    now,
    projectId,
    id,
    now
  ).rowsWritten;
  if (!claimed) return;
  if (now >= Math.min(schedule.expiresAt, schedule.dueAt + limits.maxDeferralMs)) {
    sql.exec(
      `UPDATE project_schedules SET state = 'ambiguous', next_attempt_at = NULL,
      last_error = 'Task admission deadline expired; inspect the reserved task before retrying',
      result_task_id = ?, result_session_id = ?, claim_token = NULL, updated_at = ?
      WHERE project_id = ? AND id = ? AND state = 'admitted' AND claim_token = ?`,
      reservation.reserved_task_id,
      reservation.reserved_session_id,
      now,
      projectId,
      id,
      submitToken
    );
    return;
  }
  const input: ReservedTaskSubmissionInput = {
    identities: {
      taskId: reservation.reserved_task_id,
      chatSessionId: reservation.reserved_session_id,
      initialMessageId: reservation.reserved_message_id,
      initialStatusEventId: reservation.reserved_status_id,
    },
    projectId,
    userId: schedule.creatorUserId,
    prompt: schedule.action.prompt,
    agentProfileId: schedule.action.agentProfileId,
    skillId: schedule.action.skillId,
    branchNameSeed: boundedScheduleTaskLabel(env, schedule.reason ?? 'Scheduled task'),
    taskMode: 'conversation',
    vmSizeOverride: null,
    source: {
      kind: reservation.watch_id ? 'standing_watch' : 'schedule',
      sourceId: reservation.watch_id ?? id,
      sourceExecutionId: id,
      triggeredBy: 'cron',
      expiresAt: Math.min(schedule.expiresAt, schedule.dueAt + limits.maxDeferralMs),
      displayName: boundedScheduleTaskLabel(env, schedule.reason ?? 'Scheduled action'),
      repositoryAccessFlow: 'scheduled-action',
      initialStatusReason: schedule.sourceEventId
        ? `Standing watch ${schedule.watchId} matched event ${schedule.sourceEventId}`
        : 'Scheduled action admitted',
      initialStatusActorType: 'system',
      initialStatusActorId: schedule.creatorUserId,
    },
  };
  const settle = (state: string, next: number | null, error: string | null, started = false) =>
    sql.exec(
      `UPDATE project_schedules SET state = ?, next_attempt_at = ?, last_error = ?, updated_at = ?,
       result_task_id = ?, result_session_id = ?, submission_completed_at = COALESCE(?, submission_completed_at),
       claim_token = NULL WHERE project_id = ? AND id = ? AND state = 'admitted' AND claim_token = ?`,
      state,
      next,
      error,
      Date.now(),
      reservation.reserved_task_id,
      reservation.reserved_session_id,
      started ? Date.now() : null,
      projectId,
      id,
      submitToken
    );
  try {
    const result = await submitReservedTask(env as unknown as import('../../env').Env, input);
    if (result.outcome === 'admitted')
      settle('admitted', Date.now() + limits.retryBaseMs, null, true);
    else if (result.outcome === 'terminal')
      settle('failed', null, result.reason ?? 'Task is terminal');
    else if (result.outcome === 'conflict') {
      const canDefer =
        result.reason === 'placement_unavailable' &&
        schedule.attemptCount + 1 < limits.maxAttempts &&
        Date.now() < Math.min(schedule.expiresAt, schedule.dueAt + limits.maxDeferralMs);
      settle(
        canDefer ? 'admitted' : 'failed',
        canDefer ? Date.now() + limits.retryBaseMs : null,
        result.message
      );
    } else if (
      schedule.attemptCount + 1 >= limits.maxAttempts ||
      Date.now() >= Math.min(schedule.expiresAt, schedule.dueAt + limits.maxDeferralMs)
    ) {
      settle('ambiguous', null, result.reason);
    } else settle('admitted', Date.now() + limits.retryBaseMs, result.reason);
  } catch (error) {
    const expired =
      Date.now() >= Math.min(schedule.expiresAt, schedule.dueAt + limits.maxDeferralMs);
    settle(
      expired || schedule.attemptCount + 1 >= limits.maxAttempts ? 'ambiguous' : 'admitted',
      expired || schedule.attemptCount + 1 >= limits.maxAttempts
        ? null
        : Date.now() + limits.retryBaseMs,
      error instanceof Error ? error.message.slice(0, limits.promptBytes) : 'Task submission failed'
    );
  }
}

async function reconcileAdmittedExecution(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  id: string
): Promise<boolean> {
  const row = sql
    .exec(
      `SELECT state, delivery_id, result_task_id, submission_completed_at
    FROM project_schedules WHERE project_id = ? AND id = ?`,
      projectId,
      id
    )
    .toArray()[0];
  if (row?.state !== 'admitted') return false;
  if (typeof row.delivery_id !== 'string' && typeof row.submission_completed_at !== 'number')
    return false;
  // Persist a finite retry before crossing D1. Failure or runtime loss must not
  // leave an overdue item at the head of every shared alarm pass.
  sql.exec(
    `UPDATE project_schedules SET next_attempt_at = ?
    WHERE project_id = ? AND id = ? AND state = 'admitted'`,
    Date.now() + scheduleLimits(env).retryBaseMs,
    projectId,
    id
  );
  let terminal = false;
  let error: string | null = null;
  if (typeof row.delivery_id === 'string') {
    const delivery = sql
      .exec(`SELECT delivery_state, last_error FROM session_inbox WHERE id = ?`, row.delivery_id)
      .toArray()[0];
    if (!delivery || delivery.delivery_state === 'ambiguous') {
      // Uncertain transport is not proof of completion. Retain the watch's
      // concurrency slot and stop automatic retries to avoid duplicate work.
      sql.exec(
        `UPDATE project_schedules SET state = 'ambiguous', next_attempt_at = NULL,
        last_error = ?, updated_at = ? WHERE project_id = ? AND id = ? AND state = 'admitted'`,
        !delivery ? 'Scheduled delivery receipt is unavailable' : 'Scheduled delivery is ambiguous',
        Date.now(),
        projectId,
        id
      );
      return true;
    } else {
      terminal = ['acked', 'expired', 'failed'].includes(String(delivery.delivery_state));
      if (terminal && delivery.delivery_state !== 'acked')
        error =
          typeof delivery.last_error === 'string'
            ? delivery.last_error
            : `Scheduled delivery ${delivery.delivery_state}`;
    }
  } else if (
    typeof row.submission_completed_at === 'number' &&
    typeof row.result_task_id === 'string'
  ) {
    const task = await env.DATABASE.prepare(
      `SELECT status, error_message FROM tasks
      WHERE project_id = ? AND id = ?`
    )
      .bind(projectId, row.result_task_id)
      .first<{ status: string; error_message: string | null }>();
    terminal = Boolean(task && ['completed', 'failed', 'cancelled'].includes(task.status));
    if (terminal && task?.status !== 'completed')
      error = task?.error_message ?? `Scheduled task ${task?.status}`;
  } else return false;
  sql.exec(
    `UPDATE project_schedules SET next_attempt_at = ?, execution_finished_at = ?,
    last_error = ?, updated_at = ? WHERE project_id = ? AND id = ? AND state = 'admitted'`,
    terminal ? null : Date.now() + scheduleLimits(env).retryBaseMs,
    terminal ? Date.now() : null,
    error,
    Date.now(),
    projectId,
    id
  );
  return true;
}

export async function runScheduleAlarm(
  sql: SqlStorage,
  env: Env,
  hooks: DurabilityFoundationHooks
) {
  const projectId = hooks.getProjectId();
  if (!projectId) return;
  const limits = scheduleLimits(env);
  for (const id of dueIds(sql, projectId, Date.now(), limits.sweepBatchSize)) {
    try {
      if (await reconcileAdmittedExecution(sql, env, projectId, id)) continue;
    } catch {
      // This item's retry was persisted before external I/O. Continue the
      // bounded sweep so a missing task receipt cannot starve later schedules.
      continue;
    }
    const claim = hooks.transactionSync(() => claimSchedule(sql, env, projectId, id, Date.now()));
    if (claim) {
      try {
        const digest = await fingerprint(claim.schedule);
        const targetTaskId = await requireScheduleAction(
          sql,
          env,
          projectId,
          claim.schedule.creatorUserId,
          claim.schedule.action
        );
        const delivery = hooks.transactionSync(() =>
          admitClaim(sql, env, claim.schedule, claim.token, digest, targetTaskId, Date.now())
        );
        if (delivery)
          await finalizeAcceptedPromptDelivery(sql, env, hooks, delivery.input, delivery.accepted);
      } catch (error) {
        const permanent = error instanceof ProjectEventValidationError;
        sql.exec(
          `UPDATE project_schedules SET state = ?, next_attempt_at = ?, last_error = ?,
          claim_token = NULL, claim_until = NULL, updated_at = ?
          WHERE project_id = ? AND id = ? AND state = 'processing' AND claim_token = ?`,
          permanent ? 'failed' : 'pending',
          permanent ? null : Date.now() + limits.retryBaseMs,
          error instanceof Error
            ? error.message.slice(0, limits.promptBytes)
            : 'Schedule admission failed',
          Date.now(),
          projectId,
          id,
          claim.token
        );
      }
    }
    await submitAdmittedSchedule(sql, env, projectId, id);
  }
}
