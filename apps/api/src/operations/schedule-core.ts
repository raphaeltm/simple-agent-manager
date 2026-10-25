/**
 * Projections and lookups behind the Connector's schedule operations. One surface covers two
 * stores: one-off schedules in the ProjectData DO (`project_schedules`) and recurring schedules,
 * which are cron triggers in D1. Lists and single reads are in `schedule-reads.ts`.
 *
 * Someone who scheduled work usually wants to know whether it happened, and four separate
 * questions sit behind that. The projection keeps them apart, because each can stall on its own
 * and merging them is how "scheduled" gets reported as "done":
 *
 * - accepted: SAM recorded the schedule.
 * - admitted: when it came due, SAM handed the action to message delivery or task submission.
 * - executionStarted: evidence the agent began (a delivery ack, or a task that left the queue).
 * - taskOutcome: the started task's own terminal status.
 *
 * Schedules do not record whether their owner was notified, so that is reported as not tracked.
 */
import type { ProjectSchedule } from '@simple-agent-manager/shared';
import { DEFAULT_CRON_TEMPLATE_MAX_LENGTH } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { scheduleLimits } from '../durable-objects/project-data/project-event-schedules-config';
import { parsePositiveInt } from '../lib/route-helpers';
import { rethrowScheduleError } from '../routes/project-schedules';
import { cronToHumanReadable } from '../services/cron-utils';
import * as projectData from '../services/project-data';
import { resolveTriggerExecutionUserId } from '../services/trigger-execution-principal';
import { operationLink } from './connector-read-core';
import { OperationError } from './errors';
import { getPlatformOperationLimits } from './limits';
import { diagnostic } from './operational-projections';
import { zonedTime } from './schedule-time';
import type { OperationContext } from './types';
import { untrustedTextBlock } from './untrusted-text';

/** Lists carry short text previews; a single read carries the whole stored text. */
type Detail = 'preview' | 'full';

export type ScheduleTarget =
  | { kind: 'one_off'; schedule: ProjectSchedule }
  | { kind: 'recurring'; trigger: schema.TriggerRow };

/** Maps a ProjectData schedule failure to the HTTP error `routes/project-schedules.ts` returns. */
export function scheduleFailure(error: unknown): unknown {
  try {
    rethrowScheduleError(error);
  } catch (mapped) {
    return mapped;
  }
}

export async function scheduleRead<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    throw scheduleFailure(error);
  }
}

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** Echoes only identifier-shaped codes: these are enums in code, and a stray value must not
 * become a channel for free text. */
export function code(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : 'unrecognized';
}

/** Lists cap text at the task snippet length. A full read caps it at the write limit, so a
 * stored text comes back whole unless the limit was lowered after it was written. */
function textCap(ctx: OperationContext, detail: Detail, kind: 'one_off' | 'recurring'): number {
  if (detail === 'preview') return getPlatformOperationLimits(ctx.env).taskDescriptionSnippetLength;
  return kind === 'one_off'
    ? scheduleLimits(ctx.env).promptBytes
    : parsePositiveInt(ctx.env.CRON_TEMPLATE_MAX_LENGTH, DEFAULT_CRON_TEMPLATE_MAX_LENGTH);
}

/** The schedule's page in SAM's Automation section (`apps/web/src/lib/automation-routes.ts`). */
function automationLink(
  ctx: OperationContext,
  projectId: string,
  kind: 'schedule' | 'trigger',
  id: string
): string {
  return `${operationLink(ctx, projectId)}/automation/${kind}/${encodeURIComponent(id)}`;
}

type TaskOutcome =
  'completed' | 'failed' | 'cancelled' | 'not_finished' | 'no_task' | 'not_applicable' | 'unknown';
const TASK_OUTCOMES = new Map<string, TaskOutcome>([
  ['completed', 'completed'],
  ['failed', 'failed'],
  ['cancelled', 'cancelled'],
]);
/** The task left the queue, so the agent began. A failed or cancelled task may have ended
 * before it started, so those stay unknown. */
const TASK_STARTED = new Set(['delegated', 'in_progress', 'sleeping', 'awaiting_followup']);
const TASK_WAITING = new Set(['draft', 'ready', 'queued']);
/** The message has not reached the agent, or never will (`DELIVERY_STATE_TRANSITIONS`: a
 * failed delivery was never delivered; an expired one may have been). */
const DELIVERY_NOT_STARTED = new Set(['queued', 'delivering', 'retry_wait', 'failed']);

/** The phases of one one-off schedule, read from its row and its execution receipt only. */
export function oneOffPhases(schedule: ProjectSchedule) {
  // The same evidence the DO's mutation result calls `actionAlreadyAdmitted`.
  const admitted =
    schedule.state === 'admitted' ||
    schedule.eventId !== null ||
    schedule.deliveryId !== null ||
    schedule.resultTaskId !== null;
  const status = schedule.execution?.status ?? '';
  let executionStarted: boolean | 'unknown' = false;
  let taskOutcome: TaskOutcome =
    schedule.action.kind === 'message_session' ? 'not_applicable' : 'no_task';
  if (admitted && schedule.action.kind === 'message_session') {
    executionStarted =
      status === 'acked' ? true : DELIVERY_NOT_STARTED.has(status) ? false : 'unknown';
  } else if (admitted) {
    const finished = TASK_OUTCOMES.get(status);
    executionStarted =
      status === 'completed' || TASK_STARTED.has(status)
        ? true
        : TASK_WAITING.has(status)
          ? false
          : 'unknown';
    taskOutcome =
      finished ??
      (TASK_STARTED.has(status) || TASK_WAITING.has(status) ? 'not_finished' : 'unknown');
  }
  return {
    accepted: true,
    admitted,
    executionStarted,
    taskOutcome,
    ownerNotification: 'not_tracked' as const,
  };
}

export function oneOffProjection(ctx: OperationContext, schedule: ProjectSchedule, detail: Detail) {
  const action = schedule.action;
  const execution = schedule.execution;
  const shown = zonedTime(schedule.dueAt, schedule.displayTimezone);
  const maxLength = textCap(ctx, detail, 'one_off');
  const resultSessionId =
    action.kind === 'message_session'
      ? action.sessionId
      : (execution?.sessionId ?? schedule.resultSessionId);
  return {
    kind: 'one_off' as const,
    scheduleId: schedule.id,
    state: schedule.state,
    version: schedule.version,
    action:
      action.kind === 'message_session'
        ? { kind: action.kind, targetSessionId: action.sessionId }
        : {
            kind: action.kind,
            agentProfileId: action.agentProfileId,
            skillId: action.skillId,
            // The DO's runner always submits scheduled work as a conversation.
            taskMode: 'conversation' as const,
          },
    prompt: untrustedTextBlock({
      kind: 'scheduled prompt',
      text: action.prompt,
      maxLength,
      moreWith: 'sam_schedule_get',
    }),
    reason:
      schedule.reason === null
        ? null
        : untrustedTextBlock({
            kind: 'schedule reason',
            text: schedule.reason,
            maxLength,
            moreWith: 'sam_schedule_get',
          }),
    dueAt: iso(schedule.dueAt),
    localDueAt: shown.localTime,
    timezone: schedule.displayTimezone,
    utcOffsetMinutes: shown.utcOffsetMinutes,
    expiresAt: iso(schedule.expiresAt),
    nextAttemptAt: schedule.nextAttemptAt === null ? null : iso(schedule.nextAttemptAt),
    attemptCount: schedule.attemptCount,
    // A cancellation stores the canceller's reason in the same column; it is not an error.
    lastError:
      schedule.state === 'cancelled' ? null : diagnostic(schedule.lastError, 'SCHEDULE_ERROR'),
    creator: {
      userId: schedule.creatorUserId,
      isYou: schedule.creatorUserId === ctx.actor.userId,
      chatSessionId: schedule.creatorChatSessionId,
    },
    origin: schedule.watchId ? ('standing_watch' as const) : ('schedule' as const),
    createdAt: iso(schedule.createdAt),
    updatedAt: iso(schedule.updatedAt),
    execution: execution
      ? {
          source: execution.kind === 'start_session' ? 'task' : 'message_delivery',
          status: code(execution.status),
          receiptState: code(execution.receiptState),
          taskId: execution.taskId,
          sessionId: execution.sessionId,
          deliveryId: execution.deliveryId,
          checkedAt: iso(execution.checkedAt),
          retrySubmissionAllowed: execution.retrySubmissionAllowed,
          submissionDeadline:
            execution.submissionDeadline === null ? null : iso(execution.submissionDeadline),
          error: diagnostic(execution.error, 'EXECUTION_ERROR'),
        }
      : null,
    phases: oneOffPhases(schedule),
    link: automationLink(ctx, schedule.projectId, 'schedule', schedule.id),
    resultLink: resultSessionId ? operationLink(ctx, schedule.projectId, resultSessionId) : null,
  };
}

export function recurringProjection(
  ctx: OperationContext,
  trigger: schema.TriggerRow,
  detail: Detail
) {
  const timezone = trigger.cronTimezone ?? 'UTC';
  const nextRun = trigger.nextFireAt === null ? null : Date.parse(trigger.nextFireAt);
  const shown = nextRun === null ? null : zonedTime(nextRun, timezone);
  const maxLength = textCap(ctx, detail, 'recurring');
  return {
    kind: 'recurring' as const,
    scheduleId: trigger.id,
    name: trigger.name,
    status: code(trigger.status),
    disabledReason: trigger.status === 'disabled' ? code(trigger.credentialBlockedReason) : null,
    cron: trigger.cronExpression,
    timezone,
    humanReadable: trigger.cronExpression
      ? cronToHumanReadable(trigger.cronExpression, timezone)
      : null,
    nextRunAt: nextRun === null ? null : iso(nextRun),
    localNextRunAt: shown?.localTime ?? null,
    utcOffsetMinutes: shown?.utcOffsetMinutes ?? null,
    // `trigger-admission.ts` stamps both when a run submits its task; skipped runs do not count.
    lastRunAt: trigger.lastTriggeredAt,
    runCount: trigger.triggerCount,
    action: {
      kind: 'start_session' as const,
      agentProfileId: trigger.agentProfileId,
      skillId: trigger.skillId,
      taskMode: trigger.taskMode ?? 'task',
    },
    prompt: untrustedTextBlock({
      kind: 'scheduled prompt template',
      text: trigger.promptTemplate,
      maxLength,
      moreWith: 'sam_schedule_get',
    }),
    description: trigger.description
      ? untrustedTextBlock({
          kind: 'schedule description',
          text: trigger.description,
          maxLength,
          moreWith: 'sam_schedule_get',
        })
      : null,
    creator: { userId: trigger.userId, isYou: trigger.userId === ctx.actor.userId },
    runsAsUserId: resolveTriggerExecutionUserId(trigger),
    expiresAt: null,
    createdAt: trigger.createdAt,
    updatedAt: trigger.updatedAt,
    link: automationLink(ctx, trigger.projectId, 'trigger', trigger.id),
  };
}

/** The cron trigger `id` in `projectId`. The project predicate is the isolation, so it is in
 * the query, and a row from another project is refused again after it. */
export async function findRecurringTrigger(
  ctx: OperationContext,
  projectId: string,
  id: string
): Promise<schema.TriggerRow | null> {
  const row = await drizzle(ctx.env.DATABASE, { schema })
    .select()
    .from(schema.triggers)
    .where(
      and(
        eq(schema.triggers.id, id),
        eq(schema.triggers.projectId, projectId),
        eq(schema.triggers.sourceType, 'cron')
      )
    )
    .get();
  return row && row.projectId === projectId ? row : null;
}

/** One-off first (the DO is keyed by project), then a cron trigger in the same project. */
export async function findSchedule(
  ctx: OperationContext,
  projectId: string,
  scheduleId: string
): Promise<ScheduleTarget> {
  const schedule = await scheduleRead(
    projectData.getProjectSchedule(ctx.env, projectId, {
      userId: ctx.actor.userId,
      id: scheduleId,
    })
  );
  if (schedule) return { kind: 'one_off', schedule };
  const trigger = await findRecurringTrigger(ctx, projectId, scheduleId);
  if (trigger) return { kind: 'recurring', trigger };
  throw new OperationError('not_found', 'Schedule not found in this project');
}
