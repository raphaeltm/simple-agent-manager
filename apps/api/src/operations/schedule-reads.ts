/**
 * Schedule lists and single reads for the Connector. Both only read stored state: nothing here
 * wakes a runtime or replays an action. The projections are in `schedule-core.ts`.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as v from 'valibot';

import * as schema from '../db/schema';
import { log } from '../lib/logger';
import * as projectData from '../services/project-data';
import { operationPageLimit } from './connector-read-core';
import { OperationError } from './errors';
import { getPlatformOperationLimits } from './limits';
import { diagnostic } from './operational-projections';
import {
  code,
  findSchedule,
  oneOffProjection,
  recurringProjection,
  scheduleRead,
} from './schedule-core';
import type { OperationContext } from './types';

export const SCHEDULE_KINDS = ['all', 'one_off', 'recurring'] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

/** The latest runs of a recurring schedule, newest first, saying whether older ones exist. */
async function recentRuns(ctx: OperationContext, trigger: schema.TriggerRow) {
  const limit = getPlatformOperationLimits(ctx.env).taskDetailRecentMessageLimit;
  const runs = schema.triggerExecutions;
  const rows = await drizzle(ctx.env.DATABASE, { schema })
    .select({
      id: runs.id,
      status: runs.status,
      skipReason: runs.skipReason,
      taskId: runs.taskId,
      scheduledAt: runs.scheduledAt,
      startedAt: runs.startedAt,
      completedAt: runs.completedAt,
      createdAt: runs.createdAt,
      errorMessage: runs.errorMessage,
    })
    .from(runs)
    .where(and(eq(runs.triggerId, trigger.id), eq(runs.projectId, trigger.projectId)))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(limit + 1);
  return {
    recentRuns: rows.slice(0, limit).map((run) => ({
      runId: run.id,
      status: code(run.status),
      skipReason: code(run.skipReason),
      taskId: run.taskId,
      scheduledAt: run.scheduledAt ?? run.createdAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      error: diagnostic(run.errorMessage, 'RUN_ERROR'),
    })),
    moreRuns: rows.length > limit,
  };
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Rule 50: one unreadable row costs that row, logged with its id, never the whole page. */
function projectRows<T, P>(
  rows: readonly T[],
  identify: (row: T) => Record<string, unknown>,
  project: (row: T) => P
): { items: P[]; unreadable: number } {
  const items: P[] = [];
  let unreadable = 0;
  for (const row of rows) {
    try {
      items.push(project(row));
    } catch (error) {
      unreadable += 1;
      log.warn('connector.schedule_row_skipped', {
        ...identify(row),
        error: describeFailure(error),
      });
    }
  }
  return { items, unreadable };
}

export async function getSchedule(ctx: OperationContext, projectId: string, scheduleId: string) {
  const target = await findSchedule(ctx, projectId, scheduleId);
  const runs = target.kind === 'recurring' ? await recentRuns(ctx, target.trigger) : null;
  try {
    return target.kind === 'one_off'
      ? oneOffProjection(ctx, target.schedule, 'full')
      : { ...recurringProjection(ctx, target.trigger, 'full'), ...runs };
  } catch (error) {
    log.warn('connector.schedule_row_skipped', {
      projectId,
      kind: target.kind,
      scheduleId,
      error: describeFailure(error),
    });
    throw new OperationError(
      'unavailable',
      'The stored schedule could not be read',
      "Open it in SAM's Automation page."
    );
  }
}

/** Each source pages independently; null means that source is finished for this listing. */
const ScheduleCursorSchema = v.strictObject({
  v: v.literal(1),
  projectId: v.string(),
  kind: v.picklist(SCHEDULE_KINDS),
  sessionId: v.nullable(v.string()),
  oneOff: v.nullable(v.string()),
  recurring: v.nullable(v.tuple([v.string(), v.string()])),
});
type ScheduleCursor = v.InferOutput<typeof ScheduleCursorSchema>;

function readCursor(
  value: string,
  scope: Pick<ScheduleCursor, 'projectId' | 'kind' | 'sessionId'>
): ScheduleCursor {
  try {
    const cursor = v.parse(ScheduleCursorSchema, JSON.parse(value));
    if (
      cursor.projectId === scope.projectId &&
      cursor.kind === scope.kind &&
      cursor.sessionId === scope.sessionId
    )
      return cursor;
  } catch {
    // Reported below with the scope mismatch.
  }
  throw new OperationError(
    'invalid_input',
    'Invalid schedule cursor; it belongs to a different project or filter'
  );
}

async function recurringPage(
  ctx: OperationContext,
  projectId: string,
  after: readonly [string, string] | null,
  limit: number
) {
  const triggers = schema.triggers;
  const rows = await drizzle(ctx.env.DATABASE, { schema })
    .select()
    .from(triggers)
    .where(
      and(
        eq(triggers.projectId, projectId),
        eq(triggers.sourceType, 'cron'),
        after
          ? sql`(${triggers.createdAt} < ${after[0]} OR (${triggers.createdAt} = ${after[0]} AND ${triggers.id} < ${after[1]}))`
          : undefined
      )
    )
    .orderBy(desc(triggers.createdAt), desc(triggers.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page,
    next: rows.length > limit && last ? ([last.createdAt, last.id] as [string, string]) : null,
  };
}

export interface ScheduleListInput {
  projectId: string;
  kind?: ScheduleKind;
  sessionId?: string;
  cursor?: string;
  limit?: number;
}

export async function listSchedules(ctx: OperationContext, input: ScheduleListInput) {
  const kind = input.kind ?? 'all';
  const sessionId = input.sessionId ?? null;
  const cursor = input.cursor
    ? readCursor(input.cursor, { projectId: input.projectId, kind, sessionId })
    : null;
  const limit = operationPageLimit(ctx, input.limit);
  const listOneOff = kind !== 'recurring';
  // A recurring schedule belongs to no chat, so a chat filter lists one-off schedules only.
  const listRecurring = kind !== 'one_off' && sessionId === null;
  const [oneOffPage, recurring] = await Promise.all([
    listOneOff && cursor?.oneOff !== null
      ? scheduleRead(
          projectData.listProjectSchedules(ctx.env, input.projectId, {
            userId: ctx.actor.userId,
            limit,
            ...(cursor?.oneOff ? { cursor: cursor.oneOff } : {}),
            ...(sessionId ? { sessionId } : {}),
          })
        )
      : null,
    listRecurring && cursor?.recurring !== null
      ? recurringPage(ctx, input.projectId, cursor?.recurring ?? null, limit)
      : null,
  ]);
  const oneOff = projectRows(
    oneOffPage?.schedules ?? [],
    (row) => ({ projectId: input.projectId, kind: 'one_off', scheduleId: row.id }),
    (row) => oneOffProjection(ctx, row, 'preview')
  );
  const recurringItems = projectRows(
    recurring?.rows ?? [],
    (row) => ({ projectId: input.projectId, kind: 'recurring', scheduleId: row.id }),
    (row) => recurringProjection(ctx, row, 'preview')
  );
  const next: ScheduleCursor = {
    v: 1,
    projectId: input.projectId,
    kind,
    sessionId,
    oneOff: oneOffPage?.nextCursor ?? null,
    recurring: recurring?.next ?? null,
  };
  return {
    oneOff: listOneOff ? oneOff.items : null,
    recurring: listRecurring ? recurringItems.items : null,
    nextCursor: next.oneOff !== null || next.recurring !== null ? JSON.stringify(next) : null,
    unreadableRows: oneOff.unreadable + recurringItems.unreadable,
  };
}
