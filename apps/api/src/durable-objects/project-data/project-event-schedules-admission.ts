/**
 * Admitting a due schedule (split out of `project-event-schedules-runner.ts`,
 * `.claude/rules/18-file-size-limits.md`): one transaction records the due event and either
 * queues the scheduled message or reserves the task submission.
 */
import type { ProjectSchedule } from '@simple-agent-manager/shared';

import { ulid } from '../../lib/ulid';
import {
  buildSharedSessionSpeakerLine,
  type SharedSessionNames,
} from '../../services/shared-session-names';
import {
  assertScheduleWriterStillActive,
  requireScheduleTarget,
  type ScheduleActionAuthority,
  type ScheduleSessionWriter,
} from './project-event-schedules-authority';
import { scheduleLimits } from './project-event-schedules-config';
import { admitProjectEvent } from './project-events';
import { ProjectEventValidationError } from './project-events-contracts';
import {
  type AcceptPromptDeliveryInput,
  acceptPromptDeliveryInTransaction,
} from './prompt-delivery';
import type { Env } from './types';

/** A teammate's scheduled message: who sent it, as the runner resolved it before admission. */
export interface SharedScheduleSender {
  writer: ScheduleSessionWriter;
  names: SharedSessionNames;
}

export function admitScheduleClaim(
  sql: SqlStorage,
  env: Env,
  schedule: ProjectSchedule,
  token: string,
  payloadFingerprint: string,
  authority: ScheduleActionAuthority | null,
  shared: SharedScheduleSender | null,
  now: number
) {
  const targetTaskId = authority?.targetTaskId ?? null;
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
  if (schedule.action.kind === 'message_session') {
    if (requireScheduleTarget(sql, schedule.action.sessionId) !== targetTaskId) {
      throw new ProjectEventValidationError('Scheduled target changed before admission');
    }
    // A revoke or expiry may have landed during the async authority read.
    if (authority) {
      assertScheduleWriterStillActive(
        sql,
        schedule.action.sessionId,
        schedule.creatorUserId,
        authority.writer,
        now
      );
    }
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
      // A teammate's message names them to the agent, as their typed messages do.
      ...(shared
        ? {
            deliveryContent: `${buildSharedSessionSpeakerLine(shared.names)}\n\n${schedule.action.prompt}`,
          }
        : {}),
      sourceKind: 'scheduled_action',
      senderType: 'system',
      senderId: schedule.creatorUserId,
      sourceTaskId: targetTaskId,
      ttlMs: Math.min(schedule.expiresAt - now, scheduleLimits(env).deliveryTtlMs),
      metadata: {
        scheduleId: schedule.id,
        creatorUserId: schedule.creatorUserId,
        eventId: event.event.id,
        ...(shared
          ? {
              userId: schedule.creatorUserId,
              senderName: shared.names.senderName,
              onBehalfOfUserId: shared.writer.ownerUserId,
              grantId: shared.writer.grantId,
            }
          : {}),
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
