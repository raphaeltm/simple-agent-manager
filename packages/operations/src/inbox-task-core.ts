/**
 * What a person does with a human task (inbox slice H1): read it, tick steps, comment, take a
 * team task, hand it on, mark it done, reopen it, archive it. One implementation behind REST
 * (`apps/api/src/routes/inbox-tasks.ts`) and the inbox's generic answer/archive paths.
 *
 * Each change is a compare-and-set on the row with `project_id` and the writer predicate in the
 * statement (rule 11), then one `ask_activity` row, then one `sam.inbox` event through the
 * durable outbox, which wakes the chats watching the task (`ports.inboxTasks.admitEvent`). A
 * comment admits its event only when its author may wake the filing chat (`decideCommentWake`);
 * otherwise it is recorded and the agent reads it at its next wake.
 */
import type {
  InboxTaskActionResponse,
  InboxTaskCommentResponse,
  InboxTaskDetail,
  InboxTaskEventType,
} from '@simple-agent-manager/shared';
import { maybeJsonRecord } from '@simple-agent-manager/worker-core';

import { authorizeProjectOperation } from './authorization';
import { OperationError } from './errors';
import { getInboxLimits } from './inbox-settings';
import {
  canWriteTask,
  loadTaskForPerson,
  readActivity,
  recordActivity,
  TASK_NOT_FOUND,
  TASK_WRITABLE_SQL,
  type TaskRow,
  taskSteps,
  userNames,
} from './inbox-task-rows';
import { sanitizeUserInput } from './sanitize-user-input';
import type { OperationContext } from './types';

export interface TaskTarget {
  projectId: string;
  askId: string;
}

function writerRoles(ctx: OperationContext): readonly string[] {
  return ctx.ports.inbox.rolesWithCapability('task:write');
}

/** Load a task the actor may change; a read-only member gets 403, a stranger not-found. */
async function loadWritable(ctx: OperationContext, target: TaskTarget): Promise<TaskRow> {
  // A write needs the write scope and capability (a read-only token or a viewer is refused).
  await authorizeProjectOperation(ctx, target.projectId, 'task:write');
  const row = await loadTaskForPerson(ctx, target.projectId, target.askId, ctx.actor.userId);
  if (!canWriteTask(row, ctx.actor.userId, writerRoles(ctx)))
    throw new OperationError('forbidden', 'You cannot change this task');
  return row;
}

function cancelReasonOf(row: TaskRow): string | null {
  if (!row.answerJson) return null;
  try {
    const record = maybeJsonRecord(JSON.parse(row.answerJson) as unknown);
    return typeof record?.cancelReason === 'string' ? record.cancelReason : null;
  } catch {
    return null;
  }
}

/** Steps, assignee, claim, activity and discussion, for a row the caller may read. */
export async function buildTaskDetail(
  ctx: OperationContext,
  row: TaskRow,
  viewer: { userId: string | null; canWrite: boolean }
): Promise<InboxTaskDetail> {
  const limits = await getInboxLimits(ctx);
  const [names, activity, discussion] = await Promise.all([
    userNames(ctx, [row.assigneeUserId, row.claimedByUserId]),
    readActivity(ctx, row.projectId, row.id, limits.taskActivityMax),
    ctx.ports.inboxTasks.listComments(row.projectId, row.id),
  ]);
  const open = row.status === 'open';
  return {
    steps: taskSteps(row),
    assignee: {
      kind: row.assigneeKind,
      userId: row.assigneeUserId,
      name: row.assigneeUserId ? (names.get(row.assigneeUserId) ?? null) : null,
    },
    claimedBy: row.claimedByUserId
      ? { userId: row.claimedByUserId, name: names.get(row.claimedByUserId) ?? null }
      : null,
    dueHint: row.dueHint,
    activity: activity.activity,
    activityHasMore: activity.hasMore,
    discussion: discussion.threads,
    discussionHasMore: discussion.hasMore,
    cancelReason: cancelReasonOf(row),
    canWrite: viewer.canWrite,
    canClaim:
      viewer.canWrite && open && row.assigneeKind === 'team' && row.claimedByUserId === null,
  };
}

/** The task view for a person (`GET …/inbox/items/ask:<id>` adds it as `task`). */
export async function getTaskDetailForPerson(
  ctx: OperationContext,
  target: TaskTarget
): Promise<InboxTaskDetail> {
  await authorizeProjectOperation(ctx, target.projectId);
  const row = await loadTaskForPerson(ctx, target.projectId, target.askId, ctx.actor.userId);
  return buildTaskDetail(ctx, row, {
    userId: ctx.actor.userId,
    canWrite: canWriteTask(row, ctx.actor.userId, writerRoles(ctx)),
  });
}

/** The request's `waitUntil`, so event admission runs after the response (rule 60). */
export function waitUntilOf(
  ctx: OperationContext
): ((promise: Promise<unknown>) => void) | undefined {
  const execCtx = ctx.execCtx;
  return execCtx ? (promise) => execCtx.waitUntil(promise) : undefined;
}

async function admit(
  ctx: OperationContext,
  row: TaskRow,
  eventType: InboxTaskEventType,
  detail?: Record<string, string | number | boolean | null>,
  actorName: string | null = null
): Promise<boolean> {
  const limits = await getInboxLimits(ctx);
  return ctx.ports.inboxTasks.admitEvent({
    projectId: row.projectId,
    askId: row.id,
    eventType,
    actor: { kind: 'user', id: ctx.actor.userId, name: actorName },
    teammateInput: ctx.actor.userId !== row.filerUserId,
    detail,
    taskOpen: eventType !== 'inbox.task.done' && eventType !== 'inbox.task.archived',
    closedWatchHours: limits.closedTaskWatchHours,
    waitUntil: waitUntilOf(ctx),
  });
}

function requireOpen(row: TaskRow): void {
  if (row.status !== 'open')
    throw new OperationError('conflict', `This task is already ${row.status}`);
}

function lost(): never {
  throw new OperationError('conflict', 'This task changed meanwhile; reload it and try again');
}

/** Tick or untick one step. Ticks are recorded and wake a chat only if it asked for them. */
export async function setTaskStep(
  ctx: OperationContext,
  target: TaskTarget & { index: number; done: boolean }
): Promise<InboxTaskActionResponse> {
  const row = await loadWritable(ctx, target);
  requireOpen(row);
  if (!Number.isInteger(target.index) || target.index < 0 || target.index >= row.steps.length)
    throw new OperationError('invalid_input', 'No such step');
  const checked = new Set(row.checked);
  if (checked.has(target.index) === target.done)
    return { ref: `ask:${row.id}`, status: row.status, agentNotified: false };
  if (target.done) checked.add(target.index);
  else checked.delete(target.index);
  const next = JSON.stringify([...checked].sort((left, right) => left - right));
  const me = ctx.actor.userId;
  const result = await ctx.env.DATABASE.prepare(
    `UPDATE asks AS a SET steps_checked_json = ?, updated_at = ?
      WHERE a.id = ? AND a.project_id = ? AND a.kind = 'task' AND a.status = 'open'
        AND a.steps_checked_json IS ? AND ${TASK_WRITABLE_SQL}`
  )
    .bind(next, Date.now(), row.id, row.projectId, row.stepsCheckedJson, me, me, me)
    .run();
  if ((result.meta?.changes ?? 0) !== 1) lost();
  const kind = target.done ? 'step_checked' : 'step_unchecked';
  await recordActivity(ctx, {
    projectId: row.projectId,
    askId: row.id,
    kind,
    actorKind: 'user',
    actorId: me,
    detail: { step: target.index },
  });
  const agentNotified = await admit(ctx, row, `inbox.task.${kind}`, { step: target.index });
  return { ref: `ask:${row.id}`, status: 'open', agentNotified };
}

/**
 * Comment on a task (or reply in one of its threads). Any member who may read the task may
 * comment, viewers included. The comment wakes the filing agent only when its author is the
 * assignee, the member who took it, or a writer of the filing chat.
 */
export async function commentOnTask(
  ctx: OperationContext,
  target: TaskTarget & { body: string; threadId?: string; mentionUserIds?: string[] }
): Promise<InboxTaskCommentResponse> {
  await authorizeProjectOperation(ctx, target.projectId);
  const me = ctx.actor.userId;
  const row = await loadTaskForPerson(ctx, target.projectId, target.askId, me);
  const limits = await getInboxLimits(ctx);
  const body = sanitizeUserInput(target.body).trim();
  if (!body) throw new OperationError('invalid_input', 'body is required');
  if (body.length > limits.answerMaxChars)
    throw new OperationError('invalid_input', `body exceeds ${limits.answerMaxChars} characters`);
  const [mentions, names] = await Promise.all([
    target.mentionUserIds?.length
      ? ctx.ports.inboxTasks.resolveMentions(row.projectId, target.mentionUserIds)
      : Promise.resolve([]),
    // The author's name, read once for the comment, the event and the notifications.
    userNames(ctx, [me]),
  ]);
  const myName = names.get(me) ?? null;
  const [decision, created] = await Promise.all([
    ctx.ports.inboxTasks.decideCommentWake({
      projectId: row.projectId,
      sessionId: row.sourceSessionId,
      actorUserId: me,
      assigneeUserId: row.assigneeKind === 'user' ? row.assigneeUserId : null,
      claimedByUserId: row.claimedByUserId,
    }),
    ctx.ports.inboxTasks.createComment(row.projectId, {
      askId: row.id,
      threadId: target.threadId,
      body,
      actor: { kind: 'human', id: me, name: myName },
      mentions,
    }),
  ]);
  if (created.idempotent) {
    // A replayed write: the comment, its event and its notifications already happened.
    return {
      ref: `ask:${row.id}`,
      status: row.status,
      agentNotified: false,
      threadId: created.thread.id,
      commentId: created.commentId,
    };
  }
  await recordActivity(ctx, {
    projectId: row.projectId,
    askId: row.id,
    kind: 'commented',
    actorKind: 'user',
    actorId: me,
    detail: { threadId: created.thread.id, commentId: created.commentId, woke: decision.wake },
  });
  // A comment on a closed task is recorded, but wakes nobody: the agent was already told.
  const agentNotified =
    decision.wake && row.status === 'open'
      ? await ctx.ports.inboxTasks.admitEvent({
          projectId: row.projectId,
          askId: row.id,
          eventType: 'inbox.task.commented',
          actor: { kind: 'user', id: me, name: myName },
          teammateInput: decision.teammateInput,
          detail: { threadId: created.thread.id, commentId: created.commentId },
          taskOpen: true,
          closedWatchHours: limits.closedTaskWatchHours,
          waitUntil: waitUntilOf(ctx),
        })
      : false;
  const participants = [
    row.assigneeUserId,
    row.claimedByUserId,
    row.filerUserId,
    created.thread.author.kind === 'human' ? created.thread.author.id : null,
    ...created.thread.replies.flatMap((reply) =>
      reply.author.kind === 'human' ? [reply.author.id] : []
    ),
  ].filter((id): id is string => Boolean(id));
  await ctx.ports.inboxTasks.notifyComment({
    projectId: row.projectId,
    askId: row.id,
    title: row.title,
    commentId: created.commentId,
    threadId: created.thread.id,
    body,
    mentions,
    actor: { userId: me, name: myName },
    participants,
    readers:
      row.assigneeKind === 'team'
        ? 'project'
        : [row.assigneeUserId, row.filerUserId].filter((id): id is string => Boolean(id)),
  });
  return {
    ref: `ask:${row.id}`,
    status: row.status,
    agentNotified,
    threadId: created.thread.id,
    commentId: created.commentId,
  };
}

/** "I'll take it": a member who may write tasks takes a team task nobody has taken. */
export async function claimTask(
  ctx: OperationContext,
  target: TaskTarget
): Promise<InboxTaskActionResponse> {
  const row = await loadWritable(ctx, target);
  requireOpen(row);
  if (row.assigneeKind !== 'team')
    throw new OperationError('conflict', 'Only a team task can be taken');
  const me = ctx.actor.userId;
  if (row.claimedByUserId === me)
    return { ref: `ask:${row.id}`, status: 'open', agentNotified: false };
  const result = await ctx.env.DATABASE.prepare(
    `UPDATE asks SET claimed_by_user_id = ?, updated_at = ?
      WHERE id = ? AND project_id = ? AND kind = 'task' AND status = 'open'
        AND assignee_kind = 'team' AND claimed_by_user_id IS NULL
        AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = asks.project_id
          AND pm.user_id = ? AND pm.status = 'active')`
  )
    .bind(me, Date.now(), row.id, row.projectId, me)
    .run();
  if ((result.meta?.changes ?? 0) !== 1)
    throw new OperationError('conflict', 'Someone else took this task first');
  await recordActivity(ctx, {
    projectId: row.projectId,
    askId: row.id,
    kind: 'claimed',
    actorKind: 'user',
    actorId: me,
  });
  const agentNotified = await admit(ctx, row, 'inbox.task.claimed');
  return { ref: `ask:${row.id}`, status: 'open', agentNotified };
}

/**
 * Hand the task to one active member, or back to the team. The new assignee is checked
 * server-side; a non-member is refused, never silently dropped.
 */
export async function reassignTask(
  ctx: OperationContext,
  target: TaskTarget & { assigneeUserId?: string; team?: boolean }
): Promise<InboxTaskActionResponse> {
  const toTeam = target.team === true;
  if (toTeam === Boolean(target.assigneeUserId))
    throw new OperationError('invalid_input', 'Give assigneeUserId or team: true');
  const row = await loadWritable(ctx, target);
  requireOpen(row);
  const me = ctx.actor.userId;
  if (!toTeam) {
    const member = await ctx.env.DATABASE.prepare(
      `SELECT 1 AS ok FROM project_members WHERE project_id = ? AND user_id = ? AND status = 'active'`
    )
      .bind(row.projectId, target.assigneeUserId)
      .first();
    if (!member)
      throw new OperationError('invalid_input', 'The assignee is not an active project member');
  }
  const result = await ctx.env.DATABASE.prepare(
    `UPDATE asks AS a SET assignee_kind = ?, assignee_user_id = ?, claimed_by_user_id = NULL,
            updated_at = ?
      WHERE a.id = ? AND a.project_id = ? AND a.kind = 'task' AND a.status = 'open'
        AND a.assignee_kind = ? AND a.assignee_user_id IS ? AND a.claimed_by_user_id IS ?
        AND ${TASK_WRITABLE_SQL}
        AND (? IS NULL OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = a.project_id
          AND pm.user_id = ? AND pm.status = 'active'))`
  )
    .bind(
      toTeam ? 'team' : 'user',
      toTeam ? null : target.assigneeUserId,
      Date.now(),
      row.id,
      row.projectId,
      row.assigneeKind,
      row.assigneeUserId,
      row.claimedByUserId,
      me,
      me,
      me,
      // The new assignee is checked again in the write, so a member removed after the read above
      // cannot be assigned (the departed-member handoff would not see this task).
      toTeam ? null : (target.assigneeUserId ?? null),
      toTeam ? null : (target.assigneeUserId ?? null)
    )
    .run();
  if ((result.meta?.changes ?? 0) !== 1) lost();
  const detail = {
    fromKind: row.assigneeKind,
    fromUserId: row.assigneeUserId,
    toKind: toTeam ? 'team' : 'user',
    toUserId: toTeam ? null : (target.assigneeUserId ?? null),
  };
  await recordActivity(ctx, {
    projectId: row.projectId,
    askId: row.id,
    kind: 'reassigned',
    actorKind: 'user',
    actorId: me,
    detail,
  });
  if (!toTeam && target.assigneeUserId && target.assigneeUserId !== me) {
    await ctx.ports.inboxTasks.notifyAssigned({
      projectId: row.projectId,
      askId: row.id,
      title: row.title,
      userIds: [target.assigneeUserId],
    });
  }
  const agentNotified = await admit(ctx, row, 'inbox.task.reassigned', {
    toKind: detail.toKind,
  });
  return { ref: `ask:${row.id}`, status: 'open', agentNotified };
}

/**
 * Close an open task as done or archived. Done: the `sam.inbox` event is the agent's notice, and
 * `notified_at` is stamped after it is committed so the ask-notice sweep sends one only when the
 * event could not be. Archived: no event, and `notified_at` is set in the closing write, so no
 * watcher is told (every inbox archive is silent; Raphaël, 2026-11-17).
 */
async function closeTask(
  ctx: OperationContext,
  target: TaskTarget,
  status: 'done' | 'archived',
  note: string | null
): Promise<InboxTaskActionResponse> {
  const row = await loadWritable(ctx, target);
  requireOpen(row);
  const me = ctx.actor.userId;
  const now = Date.now();
  const silent = status === 'archived';
  const result = await ctx.env.DATABASE.prepare(
    `UPDATE asks AS a SET status = ?, answer_json = ?, resolved_by_user_id = ?, resolved_at = ?,
            updated_at = ?, notified_at = CASE WHEN ? THEN ? ELSE a.notified_at END
      WHERE a.id = ? AND a.project_id = ? AND a.kind = 'task' AND a.status = 'open'
        AND ${TASK_WRITABLE_SQL}`
  )
    .bind(
      status,
      note ? JSON.stringify({ text: note }) : null,
      me,
      now,
      now,
      silent ? 1 : 0,
      now,
      row.id,
      row.projectId,
      me,
      me,
      me
    )
    .run();
  if ((result.meta?.changes ?? 0) !== 1) lost();
  await recordActivity(ctx, {
    projectId: row.projectId,
    askId: row.id,
    kind: status,
    actorKind: 'user',
    actorId: me,
    at: now,
  });
  if (silent) {
    // No event, so the watches wind down here, as a moot task's do (`inbox-agent-core.ts`).
    await ctx.ports.inboxTasks.closeWatches(
      row.projectId,
      row.id,
      (await getInboxLimits(ctx)).closedTaskWatchHours
    );
    return { ref: `ask:${row.id}`, status, agentNotified: false };
  }
  const agentNotified = await admit(ctx, row, `inbox.task.${status}`);
  if (agentNotified) {
    // The event is the agent's notice. Marked only once it is committed to the outbox: if that
    // failed, `notified_at` stays NULL and the ask-notice sweep tells the agent instead.
    await ctx.env.DATABASE.prepare(
      'UPDATE asks SET notified_at = ? WHERE id = ? AND project_id = ? AND notified_at IS NULL'
    )
      .bind(Date.now(), row.id, row.projectId)
      .run()
      .catch(() => undefined);
  }
  return { ref: `ask:${row.id}`, status, agentNotified };
}

export async function completeTask(
  ctx: OperationContext,
  target: TaskTarget & { note?: string }
): Promise<InboxTaskActionResponse> {
  const limits = await getInboxLimits(ctx);
  const note = target.note === undefined ? null : sanitizeUserInput(target.note).trim() || null;
  if (note && note.length > limits.answerMaxChars)
    throw new OperationError('invalid_input', `note exceeds ${limits.answerMaxChars} characters`);
  return closeTask(ctx, target, 'done', note);
}

/** Archive means closed: the task leaves the inbox and no watching agent is told. */
export async function archiveTask(
  ctx: OperationContext,
  target: TaskTarget
): Promise<InboxTaskActionResponse> {
  return closeTask(ctx, target, 'archived', null);
}

/** Reopen a done or archived task; the watching agents are woken again. */
export async function reopenTask(
  ctx: OperationContext,
  target: TaskTarget
): Promise<InboxTaskActionResponse> {
  const row = await loadWritable(ctx, target);
  if (row.status !== 'done' && row.status !== 'archived')
    throw new OperationError('conflict', `A ${row.status} task cannot be reopened`);
  const me = ctx.actor.userId;
  const result = await ctx.env.DATABASE.prepare(
    `UPDATE asks AS a SET status = 'open', answer_json = NULL, resolved_by_user_id = NULL,
            resolved_at = NULL, notified_at = NULL, updated_at = ?
      WHERE a.id = ? AND a.project_id = ? AND a.kind = 'task' AND a.status = ?
        AND ${TASK_WRITABLE_SQL}`
  )
    .bind(Date.now(), row.id, row.projectId, row.status, me, me, me)
    .run();
  if ((result.meta?.changes ?? 0) !== 1) lost();
  await recordActivity(ctx, {
    projectId: row.projectId,
    askId: row.id,
    kind: 'reopened',
    actorKind: 'user',
    actorId: me,
    detail: { from: row.status },
  });
  const agentNotified = await admit(ctx, row, 'inbox.task.reopened');
  return { ref: `ask:${row.id}`, status: 'open', agentNotified };
}

export { TASK_NOT_FOUND };
