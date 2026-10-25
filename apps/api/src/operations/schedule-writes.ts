/**
 * The write half of the Connector's schedule operations. Every check that can refuse a request
 * runs in `executeConnectorWrite`'s preflight, before a receipt reserves the requestKey; the
 * returned closure is the only part that runs under the receipt.
 *
 * Results carry the prompt preview, not the whole prompt: the caller has just sent that text, and
 * a receipt only replays if its saved response fits `CLI_RECEIPT_RESPONSE_MAX_BYTES`.
 */
import {
  type ProjectScheduledAction,
  TRIGGER_STATUSES,
  type TriggerStatus,
} from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type * as v from 'valibot';

import * as schema from '../db/schema';
import type { ScheduleCreator } from '../durable-objects/project-data/project-event-schedules-authority';
import { scheduleLimits } from '../durable-objects/project-data/project-event-schedules-config';
import { markRejectedBeforeEffects } from '../lib/operation-effect-boundary';
import { sanitizeUserInput } from '../lib/sanitize-user-input';
import { AppError } from '../middleware/error';
import type { CreateTriggerSchema } from '../schemas/triggers';
import { executeConnectorWrite } from '../services/connector-execution';
import * as projectData from '../services/project-data';
import { clearTriggerPageCaches } from '../services/trigger-cache';
import { createTrigger, validateCron } from '../services/trigger-create';
import { triggerStatusUpdates } from '../services/trigger-status';
import { authorizeProjectOperation } from './authorization';
import { OperationError } from './errors';
import {
  findRecurringTrigger,
  findSchedule,
  oneOffProjection,
  recurringProjection,
  scheduleFailure,
} from './schedule-core';
import type { ScheduleCancel, ScheduleCreate, ScheduleUpdate } from './schedule-inputs';
import { canonicalTimezone, type ResolvedScheduleTime, resolveScheduleTime } from './schedule-time';
import type { OperationContext } from './types';

type OneOffView = ReturnType<typeof oneOffProjection>;
type RecurringView = ReturnType<typeof recurringProjection>;
type TimeResolution = Pick<ResolvedScheduleTime, 'ambiguousLocalTime' | 'resolvedAs'>;
export interface CreateReceipt {
  accepted: true;
  idempotentReplay: boolean;
  meaning: 'scheduled_not_started';
}
type Created =
  | (OneOffView & { timeResolution: TimeResolution; receipt: CreateReceipt })
  | (RecurringView & { receipt: CreateReceipt });
type Updated =
  | (OneOffView & { timeResolution: TimeResolution; receipt: { changed: boolean } })
  | (RecurringView & { receipt: { changed: boolean } });

function invalid(message: string): OperationError {
  return new OperationError('invalid_input', message);
}

/** The adapter's requestKey wins; other surfaces may pass it in the input. */
function keyed(ctx: OperationContext, input: { requestKey?: string }): OperationContext {
  return { ...ctx, idempotencyKey: ctx.idempotencyKey ?? input.requestKey };
}

/** Only a person may schedule into a chat under a shared-access grant (`ScheduleCreator`). */
function scheduleCreator(ctx: OperationContext): ScheduleCreator {
  if (ctx.actor.via === 'workspace-agent') return 'agent';
  return ctx.actor.via === 'sam' ? 'system' : 'person';
}

/**
 * Runs a schedule write under the receipt. Every 4xx the DO or `createTrigger` raises
 * (validation, authority, version, idempotency, name or capacity) is thrown before anything is
 * written: the DO raises inside the transaction that would write, which rolls back, and
 * `createTrigger` validates before it inserts. Marking those frees the requestKey for a
 * corrected retry; any other failure may follow a write and stays uncertain.
 */
async function settleWrite<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    const mapped = scheduleFailure(error);
    if (mapped instanceof AppError && mapped.statusCode < 500) markRejectedBeforeEffects(mapped);
    throw mapped;
  }
}

/**
 * A time SAM can hold and has not passed. The DO tolerates a late grace for clock skew and
 * replays; a new request for a past time is almost always a wrong date or zone, and would run
 * at once.
 */
function schedulableTime(
  ctx: OperationContext,
  input: { runAt: string; timezone?: string; disambiguation?: 'earlier' | 'later' }
): ResolvedScheduleTime {
  const time = resolveScheduleTime({
    field: 'runAt',
    value: input.runAt,
    timezone: input.timezone,
    disambiguation: input.disambiguation,
  });
  const now = Date.now();
  const latest = now + scheduleLimits(ctx.env).maxHorizonMs;
  if (time.dueAt <= now) {
    throw invalid(
      `runAt resolves to ${time.dueAtIso}, which is not in the future. Use sam_chat_start to start work now.`
    );
  }
  if (time.dueAt > latest) {
    throw invalid(
      `runAt resolves to ${time.dueAtIso}, beyond the scheduling horizon (latest ${new Date(latest).toISOString()})`
    );
  }
  return time;
}

/** A local expiresAt is read in the schedule's own zone. */
function expiry(input: { expiresAt?: string; disambiguation?: 'earlier' | 'later' }, zone: string) {
  if (input.expiresAt === undefined) return {};
  const { dueAt } = resolveScheduleTime({
    field: 'expiresAt',
    value: input.expiresAt,
    timezone: zone,
    disambiguation: input.disambiguation,
  });
  return { expiresAt: dueAt };
}

function oneOffAction(action: ScheduleCreate['action']): ProjectScheduledAction {
  if (action.kind === 'message_session') {
    return { kind: 'message_session', sessionId: action.sessionId, prompt: action.message };
  }
  if (action.taskMode === 'task') {
    throw invalid(
      'A one-off schedule starts its work as a conversation; taskMode "task" is available for recurring schedules'
    );
  }
  return {
    kind: 'start_session',
    prompt: action.prompt,
    agentProfileId: action.agentProfileId ?? null,
    skillId: action.skillId ?? null,
  };
}

function prepareOneOffCreate(
  ctx: OperationContext,
  input: ScheduleCreate,
  runAt: string
): () => Promise<Created> {
  if (input.name !== undefined) {
    throw invalid('name labels a recurring schedule; use reason to describe a one-off schedule');
  }
  const action = oneOffAction(input.action);
  const time = schedulableTime(ctx, {
    runAt,
    timezone: input.timezone,
    disambiguation: input.disambiguation,
  });
  const request = {
    action,
    dueAt: time.dueAt,
    displayTimezone: time.timezone,
    ...expiry(input, time.timezone),
    // Namespaced, so a Connector key never collides with a web key or the DO's reserved
    // `provider-limit:` keys. Without a requestKey a retry is a new schedule.
    idempotencyKey: ctx.idempotencyKey
      ? `connector:${ctx.idempotencyKey}`
      : `connector:auto:${crypto.randomUUID()}`,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
  return async () => {
    const result = await settleWrite(
      projectData.createProjectSchedule(ctx.env, input.projectId, {
        userId: ctx.actor.userId,
        creatorChatSessionId: null,
        creator: scheduleCreator(ctx),
        request,
      })
    );
    return {
      ...oneOffProjection(ctx, result.schedule, 'preview'),
      timeResolution: { ambiguousLocalTime: time.ambiguousLocalTime, resolvedAs: time.resolvedAs },
      receipt: {
        accepted: true,
        idempotentReplay: result.idempotent,
        meaning: 'scheduled_not_started',
      },
    };
  };
}

async function prepareRecurringCreate(
  ctx: OperationContext,
  input: ScheduleCreate,
  cron: string
): Promise<() => Promise<Created>> {
  const action = input.action;
  if (action.kind !== 'start_session') {
    throw invalid(
      'A recurring schedule starts new work each time; to message a chat later, schedule it once with runAt'
    );
  }
  if (input.expiresAt !== undefined) {
    throw invalid('A recurring schedule does not expire; pause it with sam_schedule_update');
  }
  if (input.disambiguation !== undefined) {
    throw invalid(
      'disambiguation applies to a local runAt; cron runs on the clock of its timezone'
    );
  }
  const name = sanitizeUserInput(input.name?.trim() ?? '');
  if (!name) throw invalid('A recurring schedule needs a name that is unique in the project');
  const cronTimezone = canonicalTimezone(input.timezone ?? 'UTC');
  const cronExpression = cron.trim();
  validateCron(ctx.env, cronExpression, cronTimezone);
  const db = drizzle(ctx.env.DATABASE, { schema });
  const project = await db
    .select({ id: schema.projects.id, maxTriggers: schema.projects.maxTriggers })
    .from(schema.projects)
    .where(eq(schema.projects.id, input.projectId))
    .get();
  if (!project) throw new OperationError('not_found', 'Project not found');
  const body: v.InferOutput<typeof CreateTriggerSchema> = {
    name,
    sourceType: 'cron',
    cronExpression,
    cronTimezone,
    promptTemplate: action.prompt,
    ...(input.reason === undefined ? {} : { description: input.reason }),
    ...(action.agentProfileId === undefined ? {} : { agentProfileId: action.agentProfileId }),
    ...(action.skillId === undefined ? {} : { skillId: action.skillId }),
    ...(action.taskMode === undefined ? {} : { taskMode: action.taskMode }),
  };
  return async () => {
    const { created } = await settleWrite(
      createTrigger(db, ctx.env, project, ctx.actor.userId, body)
    );
    return {
      ...recurringProjection(ctx, created, 'preview'),
      receipt: { accepted: true, idempotentReplay: false, meaning: 'scheduled_not_started' },
    };
  };
}

export async function createSchedule(ctx: OperationContext, input: ScheduleCreate) {
  await authorizeProjectOperation(ctx, input.projectId, 'task:write');
  const writeCtx = keyed(ctx, input);
  let apply!: () => Promise<Created>;
  return executeConnectorWrite(
    writeCtx,
    'sam_schedule_create',
    input,
    () => apply(),
    async () => {
      if ((input.runAt === undefined) === (input.cron === undefined)) {
        throw invalid('Supply exactly one of runAt (a one-off schedule) or cron (a recurring one)');
      }
      apply =
        input.runAt !== undefined
          ? prepareOneOffCreate(writeCtx, input, input.runAt)
          : await prepareRecurringCreate(writeCtx, input, input.cron ?? '');
    }
  );
}

function prepareReschedule(
  ctx: OperationContext,
  input: ScheduleUpdate,
  current: { id: string; displayTimezone: string }
): () => Promise<Updated> {
  if (input.paused !== undefined) {
    throw invalid(
      'A one-off schedule cannot be paused; move it with runAt or cancel it with sam_schedule_cancel'
    );
  }
  if (input.cron !== undefined) {
    throw invalid(
      'A one-off schedule cannot become recurring; create a recurring schedule instead'
    );
  }
  if (input.expectedVersion === undefined) {
    throw invalid('expectedVersion is required to reschedule; read it from sam_schedule_get');
  }
  if (input.runAt === undefined)
    throw invalid('runAt is required to reschedule a one-off schedule');
  // A local runAt without a zone keeps the schedule's own zone.
  const time = schedulableTime(ctx, {
    runAt: input.runAt,
    timezone: input.timezone ?? current.displayTimezone,
    disambiguation: input.disambiguation,
  });
  const request = {
    expectedVersion: input.expectedVersion,
    dueAt: time.dueAt,
    displayTimezone: time.timezone,
    ...expiry(input, time.timezone),
  };
  return async () => {
    const result = await settleWrite(
      projectData.mutateProjectSchedule(ctx.env, input.projectId, {
        userId: ctx.actor.userId,
        id: current.id,
        operation: 'reschedule',
        request,
      })
    );
    return {
      ...oneOffProjection(ctx, result.schedule, 'preview'),
      timeResolution: { ambiguousLocalTime: time.ambiguousLocalTime, resolvedAs: time.resolvedAs },
      receipt: { changed: result.changed },
    };
  };
}

function prepareRecurringUpdate(
  ctx: OperationContext,
  input: ScheduleUpdate,
  trigger: schema.TriggerRow
): () => Promise<Updated> {
  const oneOffFields = (
    ['expectedVersion', 'runAt', 'expiresAt', 'disambiguation'] as const
  ).filter((field) => input[field] !== undefined);
  if (oneOffFields.length > 0) {
    throw invalid(
      `${oneOffFields.join(', ')} apply to one-off schedules; a recurring schedule changes with paused, cron and timezone`
    );
  }
  const current = TRIGGER_STATUSES.find((status) => status === trigger.status);
  // Offboarding disables a schedule whose runner lost access; resuming it is a decision for SAM.
  if (current === undefined || current === 'disabled') {
    throw new OperationError(
      'conflict',
      'SAM disabled this recurring schedule; review it in SAM before changing it'
    );
  }
  const scheduleChange = input.cron !== undefined || input.timezone !== undefined;
  const cronExpression = input.cron?.trim() ?? trigger.cronExpression ?? '';
  const cronTimezone =
    input.timezone === undefined
      ? (trigger.cronTimezone ?? 'UTC')
      : canonicalTimezone(input.timezone);
  if (scheduleChange) validateCron(ctx.env, cronExpression, cronTimezone);
  const status: TriggerStatus =
    input.paused === undefined ? current : input.paused ? 'paused' : 'active';
  const changed =
    status !== current ||
    (scheduleChange &&
      (cronExpression !== trigger.cronExpression ||
        cronTimezone !== (trigger.cronTimezone ?? 'UTC')));
  return async () => {
    // Resuming an active schedule must not recompute its next fire: a run due now would be skipped.
    if (!changed)
      return { ...recurringProjection(ctx, trigger, 'preview'), receipt: { changed: false } };
    const now = new Date();
    const [updated] = await drizzle(ctx.env.DATABASE, { schema })
      .update(schema.triggers)
      .set({
        updatedAt: now.toISOString(),
        ...(scheduleChange ? { cronExpression, cronTimezone } : {}),
        ...triggerStatusUpdates({ ...trigger, cronExpression, cronTimezone }, status, now),
      })
      .where(
        and(
          eq(schema.triggers.id, trigger.id),
          eq(schema.triggers.projectId, input.projectId),
          eq(schema.triggers.sourceType, 'cron'),
          // Read-then-write guard: an offboarding disable in between must win.
          eq(schema.triggers.status, current)
        )
      )
      .returning();
    if (!updated) {
      throw markRejectedBeforeEffects(
        new OperationError(
          'conflict',
          'The schedule changed while it was being updated; read it again with sam_schedule_get'
        )
      );
    }
    clearTriggerPageCaches(input.projectId);
    return { ...recurringProjection(ctx, updated, 'preview'), receipt: { changed: true } };
  };
}

export async function updateSchedule(ctx: OperationContext, input: ScheduleUpdate) {
  await authorizeProjectOperation(ctx, input.projectId, 'task:write');
  const writeCtx = keyed(ctx, input);
  let apply!: () => Promise<Updated>;
  return executeConnectorWrite(
    writeCtx,
    'sam_schedule_update',
    input,
    () => apply(),
    async () => {
      const target = await findSchedule(writeCtx, input.projectId, input.scheduleId);
      apply =
        target.kind === 'one_off'
          ? prepareReschedule(writeCtx, input, target.schedule)
          : prepareRecurringUpdate(writeCtx, input, target.trigger);
    }
  );
}

export async function cancelSchedule(ctx: OperationContext, input: ScheduleCancel) {
  await authorizeProjectOperation(ctx, input.projectId, 'task:write');
  const writeCtx = keyed(ctx, input);
  return executeConnectorWrite(writeCtx, 'sam_schedule_cancel', input, async () => {
    let result: Awaited<ReturnType<typeof projectData.mutateProjectSchedule>>;
    try {
      result = await settleWrite(
        projectData.mutateProjectSchedule(writeCtx.env, input.projectId, {
          userId: writeCtx.actor.userId,
          id: input.scheduleId,
          operation: 'cancel',
          request: {
            expectedVersion: input.expectedVersion,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          },
        })
      );
    } catch (error) {
      const notFound = error instanceof AppError && error.statusCode === 404;
      if (notFound && (await findRecurringTrigger(writeCtx, input.projectId, input.scheduleId))) {
        // Deleting recurring automation stays in SAM's Automation page.
        throw markRejectedBeforeEffects(
          invalid(
            'This is a recurring schedule: pause it with sam_schedule_update (paused: true), or delete it in SAM'
          )
        );
      }
      throw error;
    }
    const cancelled = result.schedule.state === 'cancelled';
    return {
      ...oneOffProjection(writeCtx, result.schedule, 'preview'),
      receipt: {
        cancelled,
        changed: result.changed,
        actionAlreadyAdmitted: result.actionAlreadyAdmitted,
        meaning: cancelled
          ? ('cancelled_will_not_run' as const)
          : ('already_admitted_not_retracted' as const),
      },
    };
  });
}
