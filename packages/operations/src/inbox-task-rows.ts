/**
 * Human-task rows (inbox slice H1): who may read and change a task, its steps, and its lifecycle
 * rows in `ask_activity`. Shared by the person operations (`inbox-task-core.ts`) and the agent
 * operations (`inbox-agent-tasks.ts`); every statement binds `project_id` (rule 11).
 *
 * Who may read a task: the assignee, every active member for a team task, and the person whose
 * chat filed it (the owner of its source task). Missing, foreign and unreadable tasks read the
 * same not-found.
 *
 * Who may change it (`canWrite`): a member whose role may write tasks, and for a person's task the
 * assignee or the filer, for a team task anyone until a member takes it, then only that member.
 * Viewers read and comment only.
 */
import {
  ASK_ACTIVITY_KINDS,
  type AskActivityKind,
  type AskActorKind,
  type InboxTaskActivity,
  type InboxTaskStep,
} from '@simple-agent-manager/shared';
import { ulid } from '@simple-agent-manager/worker-core';
import * as v from 'valibot';

import { OperationError } from './errors';
import type { OperationContext } from './types';

export const TASK_NOT_FOUND = 'Task not found';

/** The source task's owner: the person the filing agent works for. */
export const TASK_FILER_SQL = `(SELECT t.user_id FROM tasks t
  WHERE t.id = a.source_task_id AND t.project_id = a.project_id)`;

/** Readable by the bound user (bind: userId, userId). */
export const TASK_READABLE_SQL = `(a.assignee_kind = 'team' OR a.assignee_user_id = ?
  OR ${TASK_FILER_SQL} = ?)`;

/**
 * Changeable by the bound user, apart from their role (bind: userId, userId, userId). The CAS
 * writes repeat it so a claim or reassignment that landed after the read wins.
 */
export const TASK_WRITABLE_SQL = `((a.assignee_kind = 'user'
    AND (a.assignee_user_id = ? OR ${TASK_FILER_SQL} = ?))
  OR (a.assignee_kind = 'team' AND (a.claimed_by_user_id IS NULL OR a.claimed_by_user_id = ?)))`;

const RowSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  project_id: v.pipe(v.string(), v.minLength(1)),
  status: v.string(),
  title: v.string(),
  body_md: v.nullable(v.string()),
  assignee_kind: v.picklist(['user', 'team']),
  assignee_user_id: v.nullable(v.string()),
  claimed_by_user_id: v.nullable(v.string()),
  steps_json: v.nullable(v.string()),
  steps_checked_json: v.nullable(v.string()),
  source_session_id: v.nullable(v.string()),
  source_task_id: v.nullable(v.string()),
  due_hint: v.nullable(v.string()),
  answer_json: v.nullable(v.string()),
  updated_at: v.number(),
  filer_user_id: v.nullable(v.string()),
  viewer_role: v.nullable(v.string()),
});

export interface TaskRow {
  id: string;
  projectId: string;
  status: string;
  title: string;
  body: string | null;
  assigneeKind: 'user' | 'team';
  assigneeUserId: string | null;
  claimedByUserId: string | null;
  steps: string[];
  checked: number[];
  stepsCheckedJson: string | null;
  sourceSessionId: string | null;
  sourceTaskId: string | null;
  dueHint: string | null;
  answerJson: string | null;
  updatedAt: number;
  filerUserId: string | null;
  viewerRole: string | null;
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  const value = v.safeParse(v.array(v.string()), JSON.parse(raw) as unknown);
  return value.success ? value.output : [];
}

function parseChecked(raw: string | null, stepCount: number): number[] {
  if (!raw) return [];
  try {
    const value = v.safeParse(v.array(v.number()), JSON.parse(raw) as unknown);
    if (!value.success) return [];
    return [...new Set(value.output)]
      .filter((index) => Number.isInteger(index) && index >= 0 && index < stepCount)
      .sort((left, right) => left - right);
  } catch {
    return [];
  }
}

function toTaskRow(raw: unknown): TaskRow {
  const row = v.parse(RowSchema, raw);
  let steps: string[] = [];
  try {
    steps = parseStringArray(row.steps_json);
  } catch {
    steps = [];
  }
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    title: row.title,
    body: row.body_md,
    assigneeKind: row.assignee_kind,
    assigneeUserId: row.assignee_user_id,
    claimedByUserId: row.claimed_by_user_id,
    steps,
    checked: parseChecked(row.steps_checked_json, steps.length),
    stepsCheckedJson: row.steps_checked_json,
    sourceSessionId: row.source_session_id,
    sourceTaskId: row.source_task_id,
    dueHint: row.due_hint,
    answerJson: row.answer_json,
    updatedAt: row.updated_at,
    filerUserId: row.filer_user_id,
    viewerRole: row.viewer_role,
  };
}

const TASK_COLUMNS = `a.id, a.project_id, a.status, a.title, a.body_md, a.assignee_kind,
  a.assignee_user_id, a.claimed_by_user_id, a.steps_json, a.steps_checked_json,
  a.source_session_id, a.source_task_id, a.due_hint, a.answer_json, a.updated_at,
  ${TASK_FILER_SQL} AS filer_user_id`;

function notFound(): never {
  throw new OperationError('not_found', TASK_NOT_FOUND);
}

/**
 * A task the person may read, with their project role. One statement. Not-found for a missing
 * task, another project's, another kind, a task they may not read, and a malformed row (rule 50).
 */
export async function loadTaskForPerson(
  ctx: Pick<OperationContext, 'env'>,
  projectId: string,
  askId: string,
  userId: string
): Promise<TaskRow> {
  const raw = await ctx.env.DATABASE.prepare(
    `SELECT ${TASK_COLUMNS}, pm.role AS viewer_role
       FROM asks a
       JOIN project_members pm ON pm.project_id = a.project_id AND pm.user_id = ?
        AND pm.status = 'active'
      WHERE a.id = ? AND a.project_id = ? AND a.kind = 'task' AND ${TASK_READABLE_SQL}`
  )
    .bind(userId, askId, projectId, userId, userId)
    .first<Record<string, unknown>>();
  if (!raw) notFound();
  try {
    return toTaskRow(raw);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'inbox.task_row_unreadable',
        projectId,
        askId,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return notFound();
  }
}

/**
 * A task as an agent reads it: filed from this chat or another chat of the same person, or
 * addressed to the agent's person or the team. Not-found otherwise.
 */
export async function loadTaskForAgent(
  ctx: Pick<OperationContext, 'env'>,
  source: { projectId: string; sessionId: string; userId: string },
  askId: string
): Promise<TaskRow> {
  const raw = await ctx.env.DATABASE.prepare(
    `SELECT ${TASK_COLUMNS}, NULL AS viewer_role
       FROM asks a
      WHERE a.id = ? AND a.project_id = ? AND a.kind = 'task'
        AND (a.source_session_id = ? OR a.assignee_kind = 'team' OR a.assignee_user_id = ?
          OR ${TASK_FILER_SQL} = ?)`
  )
    .bind(askId, source.projectId, source.sessionId, source.userId, source.userId)
    .first<Record<string, unknown>>();
  if (!raw) notFound();
  try {
    return toTaskRow(raw);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'inbox.task_row_unreadable',
        projectId: source.projectId,
        askId,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return notFound();
  }
}

/** Whether the person's role and position let them change the task (see the header). */
export function canWriteTask(
  row: TaskRow,
  userId: string,
  writerRoles: readonly string[]
): boolean {
  if (!row.viewerRole || !writerRoles.includes(row.viewerRole)) return false;
  if (row.assigneeKind === 'user')
    return row.assigneeUserId === userId || row.filerUserId === userId;
  return row.claimedByUserId === null || row.claimedByUserId === userId;
}

export function taskSteps(row: TaskRow): InboxTaskStep[] {
  const done = new Set(row.checked);
  return row.steps.map((text, index) => ({ index, text, done: done.has(index) }));
}

export interface ActivityInput {
  projectId: string;
  askId: string;
  kind: AskActivityKind;
  actorKind: AskActorKind;
  actorId: string | null;
  detail?: Record<string, string | number | boolean | null>;
  at?: number;
}

/** The statement that records one lifecycle row (for a batch, or run on its own). */
export function activityStatement(ctx: Pick<OperationContext, 'env'>, input: ActivityInput) {
  return ctx.env.DATABASE.prepare(
    `INSERT INTO ask_activity (id, ask_id, project_id, actor_kind, actor_id, kind, detail_json,
       created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    ulid(),
    input.askId,
    input.projectId,
    input.actorKind,
    input.actorId,
    input.kind,
    input.detail ? JSON.stringify(input.detail) : null,
    input.at ?? Date.now()
  );
}

/**
 * Record a lifecycle row after the change it describes has committed. A failed write is logged
 * and swallowed: the change stands and the activity is a history, not an authority.
 */
export async function recordActivity(
  ctx: Pick<OperationContext, 'env'>,
  input: ActivityInput
): Promise<void> {
  try {
    await activityStatement(ctx, input).run();
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'inbox.task_activity_write_failed',
        projectId: input.projectId,
        askId: input.askId,
        kind: input.kind,
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }
}

const ActivityRowSchema = v.object({
  id: v.string(),
  kind: v.picklist(ASK_ACTIVITY_KINDS),
  actor_kind: v.picklist(['user', 'agent', 'system']),
  actor_id: v.nullable(v.string()),
  actor_name: v.nullable(v.string()),
  detail_json: v.nullable(v.string()),
  created_at: v.number(),
});

function parseDetail(raw: string | null): InboxTaskActivity['detail'] {
  if (!raw) return null;
  const parsed = v.safeParse(
    v.record(v.string(), v.nullable(v.union([v.string(), v.number(), v.boolean()]))),
    JSON.parse(raw) as unknown
  );
  return parsed.success ? parsed.output : null;
}

/**
 * The newest `max` lifecycle rows, returned oldest first, with whether older ones exist
 * (rule 65). A malformed row is skipped and logged (rule 50).
 */
export async function readActivity(
  ctx: Pick<OperationContext, 'env'>,
  projectId: string,
  askId: string,
  max: number
): Promise<{ activity: InboxTaskActivity[]; hasMore: boolean }> {
  const result = await ctx.env.DATABASE.prepare(
    `SELECT act.id, act.kind, act.actor_kind, act.actor_id, act.detail_json, act.created_at,
            CASE WHEN act.actor_kind = 'user' THEN u.name END AS actor_name
       FROM ask_activity act
       LEFT JOIN users u ON u.id = act.actor_id
      WHERE act.ask_id = ? AND act.project_id = ?
      ORDER BY act.created_at DESC, act.id DESC LIMIT ?`
  )
    .bind(askId, projectId, max + 1)
    .all<Record<string, unknown>>();
  const rows = result.results ?? [];
  const activity: InboxTaskActivity[] = [];
  for (const raw of rows.slice(0, max)) {
    try {
      const row = v.parse(ActivityRowSchema, raw);
      activity.push({
        id: row.id,
        kind: row.kind,
        actorKind: row.actor_kind,
        actorId: row.actor_id,
        actorName: row.actor_name,
        detail: parseDetail(row.detail_json),
        createdAt: new Date(row.created_at).toISOString(),
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'inbox.task_activity_row_skipped',
          projectId,
          askId,
          activityId: typeof raw.id === 'string' ? raw.id : null,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }
  return { activity: activity.reverse(), hasMore: rows.length > max };
}

/** Display names for the assignee and claimer of a task. */
export async function userNames(
  ctx: Pick<OperationContext, 'env'>,
  userIds: Array<string | null>
): Promise<Map<string, string | null>> {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string | null>();
  if (ids.length === 0) return names;
  const result = await ctx.env.DATABASE.prepare(
    `SELECT id, name, email FROM users WHERE id IN (${ids.map(() => '?').join(', ')})`
  )
    .bind(...ids)
    .all<{ id: string; name: string | null; email: string | null }>();
  for (const row of result.results ?? []) {
    names.set(row.id, row.name?.trim() || row.email?.split('@')[0] || null);
  }
  return names;
}
