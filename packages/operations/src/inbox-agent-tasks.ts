/**
 * What an agent does with human tasks (inbox slice H1, spec section 5): `assign` hands a person
 * (or the team) non-blocking work, `comment` replies in a task's discussion, `attach` watches a
 * task another chat assigned instead of filing a duplicate. `inbox_write` is a thin MCP adapter
 * over these (`apps/api/src/routes/mcp/inbox-tools.ts`).
 *
 * A task never blocks and never expires; the agent keeps working after assigning. The filing chat
 * is subscribed to the task's `sam.inbox` events, so it is woken when the person comments, takes
 * it, hands it on, finishes, reopens or archives it.
 */
import type { InboxAgentItem, InboxTaskDetail } from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { OperationError } from './errors';
import { AgentLinkInputSchema, checkedLinks } from './inbox-agent-core';
import { type AgentInboxSource, findSimilarAsks, getAgentAsk } from './inbox-agent-reads';
import { createAsk } from './inbox-ask-create-core';
import { getInboxLimits, type InboxLimits } from './inbox-settings';
import { buildTaskDetail } from './inbox-task-core';
import { activityStatement, loadTaskForAgent, type TaskRow } from './inbox-task-rows';
import { sanitizeUserInput } from './sanitize-user-input';
import type { OperationContext } from './types';

const IdempotencyKeySchema = v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(120)));

export const AgentAssignInputSchema = v.object({
  title: v.string(),
  why: v.optional(v.string()),
  steps: v.optional(v.array(v.pipe(v.string(), v.maxLength(500)))),
  assignee: v.union([
    v.object({ userId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)) }),
    v.object({ team: v.literal(true) }),
  ]),
  dueHint: v.optional(v.pipe(v.string(), v.maxLength(200))),
  links: v.optional(v.array(AgentLinkInputSchema), []),
  wakeOnSteps: v.optional(v.boolean(), false),
  groupKey: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  idempotencyKey: IdempotencyKeySchema,
});
export type AgentAssignInput = v.InferInput<typeof AgentAssignInputSchema>;

export interface AgentAssignResult {
  ref: string;
  id: string;
  sessionId: string;
  kind: 'task';
  blocking: false;
  created: boolean;
  /** The filing chat watches the task: false only when subscribing failed (see message). */
  watching: boolean;
  similar: Awaited<ReturnType<typeof findSimilarAsks>>;
}

function clean(value: string | undefined): string {
  return value === undefined ? '' : sanitizeUserInput(value).trim();
}

function checkedTitle(raw: string, limits: InboxLimits): string {
  const title = clean(raw);
  if (!title) throw new OperationError('invalid_input', 'title is required');
  if (/[\r\n]/.test(title))
    throw new OperationError('invalid_input', 'title must be one sentence on one line');
  if (title.length > limits.titleMaxChars)
    throw new OperationError('invalid_input', `title exceeds ${limits.titleMaxChars} characters`);
  return title;
}

/** A short stable digest of a title, so a retried assign without a key finds its first call. */
async function titleKey(title: string): Promise<string> {
  const bytes = new TextEncoder().encode(title.toLowerCase().replace(/\s+/g, ' '));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function countOpenTasks(ctx: OperationContext, source: AgentInboxSource): Promise<number> {
  const row = await ctx.env.DATABASE.prepare(
    `SELECT COUNT(*) AS count FROM asks INDEXED BY idx_asks_session_status
      WHERE source_session_id = ? AND status = 'open' AND project_id = ? AND kind = 'task'`
  )
    .bind(source.sessionId, source.projectId)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

/**
 * Assign a human task. The assignee must be an active member (checked server-side by
 * `createAsk`; a non-member is refused). A retried call returns the task already filed: the
 * dedupe key is the chat plus the agent's `idempotencyKey`, else the chat plus the title.
 */
export async function assignAgentTask(
  ctx: OperationContext,
  source: AgentInboxSource,
  rawInput: AgentAssignInput
): Promise<AgentAssignResult> {
  const input = v.parse(AgentAssignInputSchema, rawInput);
  const limits = await getInboxLimits(ctx);
  const title = checkedTitle(input.title, limits);
  const why = clean(input.why);
  const steps = (input.steps ?? []).map((step) => clean(step)).filter(Boolean);
  if (steps.some((step) => /[\r\n]/.test(step)))
    throw new OperationError('invalid_input', 'each step must be one line');
  if (steps.length > limits.taskStepsMax)
    throw new OperationError('invalid_input', `at most ${limits.taskStepsMax} steps`);
  const links = await checkedLinks(ctx, source.projectId, input.links ?? [], limits);
  const dedupeKey = `agent:${source.sessionId}:${
    input.idempotencyKey ? input.idempotencyKey : `task:${await titleKey(title)}`
  }`;
  const team = 'team' in input.assignee;
  if ((await countOpenTasks(ctx, source)) >= limits.openTasksPerChat) {
    // A retry of a task already filed still answers with that task.
    const existing = await ctx.env.DATABASE.prepare(
      'SELECT id FROM asks WHERE project_id = ? AND dedupe_key = ?'
    )
      .bind(source.projectId, dedupeKey)
      .first<{ id: string }>();
    if (!existing)
      throw new OperationError(
        'rate_limited',
        `This chat already has ${limits.openTasksPerChat} open tasks for people`
      );
  }
  const now = Date.now();
  const created = await createAsk(
    ctx,
    {
      projectId: source.projectId,
      assigneeKind: team ? 'team' : 'user',
      assigneeUserId: 'userId' in input.assignee ? input.assignee.userId : undefined,
      kind: 'task',
      blocking: false,
      title,
      body: why || undefined,
      steps,
      links,
      dueHint: clean(input.dueHint) || undefined,
      sourceSessionId: source.sessionId,
      sourceTaskId: source.taskId,
      sourceWorkspaceId: source.workspaceId ?? undefined,
      groupKey: input.groupKey,
      dedupeKey,
    },
    now
  );
  let watching = true;
  if (created.created) {
    await activityStatement(ctx, {
      projectId: source.projectId,
      askId: created.id,
      kind: 'created',
      actorKind: 'agent',
      actorId: source.sessionId,
      detail: { assigneeKind: team ? 'team' : 'user', steps: steps.length },
      at: now,
    })
      .run()
      .catch((error: unknown) => {
        console.warn(
          JSON.stringify({
            event: 'inbox.task_activity_write_failed',
            projectId: source.projectId,
            askId: created.id,
            error: error instanceof Error ? error.message : String(error),
          })
        );
      });
    if (!team && 'userId' in input.assignee) {
      await ctx.ports.inboxTasks.notifyAssigned({
        projectId: source.projectId,
        askId: created.id,
        title,
        userIds: [input.assignee.userId],
      });
    }
  }
  // Subscribe on every call, so a retry repairs a subscription the first call failed to make.
  try {
    await ctx.ports.inboxTasks.watch({
      projectId: source.projectId,
      askId: created.id,
      sessionId: source.sessionId,
      taskId: source.taskId,
      userId: source.userId,
      agentSessionId: ctx.actor.workspace?.agentSessionId ?? null,
      includeSteps: input.wakeOnSteps,
      includeComments: true,
    });
  } catch (error) {
    watching = false;
    console.error(
      JSON.stringify({
        event: 'inbox.task_watch_failed',
        projectId: source.projectId,
        askId: created.id,
        sessionId: source.sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }
  const similar = await findSimilarAsks(ctx, limits, {
    projectId: source.projectId,
    sessionId: source.sessionId,
    userId: source.userId,
    title,
    groupKey: input.groupKey,
    excludeId: created.id,
  });
  return {
    ref: created.ref,
    id: created.id,
    sessionId: source.sessionId,
    kind: 'task',
    blocking: false,
    created: created.created,
    watching,
    similar,
  };
}

function askIdOf(ref: string): string {
  const match = /^ask:([A-Za-z0-9_-]{1,128})$/.exec(ref);
  if (!match?.[1]) throw new OperationError('not_found', 'Task not found');
  return match[1];
}

export const AgentCommentInputSchema = v.object({
  ref: v.string(),
  body: v.string(),
  threadId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
});

/**
 * Reply in a task's discussion. The agent's own comment wakes no one; the people on the task
 * are notified as for any comment.
 */
export async function commentAgentTask(
  ctx: OperationContext,
  source: AgentInboxSource,
  rawInput: v.InferInput<typeof AgentCommentInputSchema>
): Promise<{ ref: string; threadId: string; commentId: string }> {
  const input = v.parse(AgentCommentInputSchema, rawInput);
  const row = await loadTaskForAgent(ctx, source, askIdOf(input.ref));
  const limits = await getInboxLimits(ctx);
  const body = clean(input.body);
  if (!body) throw new OperationError('invalid_input', 'body is required');
  if (body.length > limits.answerMaxChars)
    throw new OperationError('invalid_input', `body exceeds ${limits.answerMaxChars} characters`);
  const created = await ctx.ports.inboxTasks.createComment(row.projectId, {
    askId: row.id,
    threadId: input.threadId,
    body,
    actor: { kind: 'agent', id: source.sessionId, name: null },
  });
  await activityStatement(ctx, {
    projectId: row.projectId,
    askId: row.id,
    kind: 'commented',
    actorKind: 'agent',
    actorId: source.sessionId,
    detail: { threadId: created.thread.id, commentId: created.commentId },
  })
    .run()
    .catch(() => undefined);
  await ctx.ports.inboxTasks.notifyComment({
    projectId: row.projectId,
    askId: row.id,
    title: row.title,
    commentId: created.commentId,
    threadId: created.thread.id,
    body,
    mentions: [],
    // Written by the agent, so never attributed to its person by name.
    actor: { userId: source.userId, name: 'Agent' },
    participants: [row.assigneeUserId, row.claimedByUserId].filter(
      (id): id is string => Boolean(id) && id !== source.userId
    ),
    readers:
      row.assigneeKind === 'team'
        ? 'project'
        : [row.assigneeUserId, row.filerUserId].filter((id): id is string => Boolean(id)),
  });
  return { ref: input.ref, threadId: created.thread.id, commentId: created.commentId };
}

export const AgentAttachInputSchema = v.object({
  ref: v.string(),
  wakeOnSteps: v.optional(v.boolean(), false),
});

/**
 * Watch an open task another chat of the same person assigned: this chat is woken when the task
 * is taken, handed on, finished, reopened or archived (comments wake the assigning chat only). An
 * event subscription on the item, so there is no watcher table; at most
 * `inbox.watchersPerItemMax` chats watch one task.
 */
export async function attachAgentTask(
  ctx: OperationContext,
  source: AgentInboxSource,
  rawInput: v.InferInput<typeof AgentAttachInputSchema>
): Promise<{ ref: string; watching: true; alreadyWatching: boolean }> {
  const input = v.parse(AgentAttachInputSchema, rawInput);
  const row = await loadTaskForAgent(ctx, source, askIdOf(input.ref));
  // Only a task one of this person's chats assigned: the comment wake rule and the "teammate
  // input" label are decided against the assigning chat's owner, so a chat of anyone else would
  // be woken by people who have no rights on it.
  if (row.filerUserId !== source.userId)
    throw new OperationError(
      'forbidden',
      'You can only watch a task that one of your own chats assigned'
    );
  if (row.status !== 'open')
    throw new OperationError('conflict', `This task is already ${row.status}`);
  const limits = await getInboxLimits(ctx);
  if (
    (await ctx.ports.inboxTasks.countWatchers(row.projectId, row.id)) >= limits.watchersPerItemMax
  )
    throw new OperationError(
      'rate_limited',
      `This task already has ${limits.watchersPerItemMax} watching chats`
    );
  const watched = await ctx.ports.inboxTasks.watch({
    projectId: row.projectId,
    askId: row.id,
    sessionId: source.sessionId,
    taskId: source.taskId,
    userId: source.userId,
    agentSessionId: ctx.actor.workspace?.agentSessionId ?? null,
    includeSteps: input.wakeOnSteps,
    // Lifecycle changes only: comments wake the assigning chat, whose rule they were checked by.
    includeComments: false,
  });
  return { ref: input.ref, watching: true, alreadyWatching: !watched.created };
}

/** The task view for the agent's `inbox_read get` (never the chat transcript). */
export async function agentTaskDetail(
  ctx: OperationContext,
  source: AgentInboxSource,
  askId: string
): Promise<InboxTaskDetail> {
  const row: TaskRow = await loadTaskForAgent(ctx, source, askId);
  return buildTaskDetail(ctx, row, { userId: null, canWrite: false });
}

/** `inbox_read get`: the item, and for a task its steps, assignee, claim, activity and discussion. */
export async function getAgentItem(
  ctx: OperationContext,
  source: AgentInboxSource,
  input: { ref: string }
): Promise<InboxAgentItem> {
  const item = await getAgentAsk(ctx, source, input);
  if (item.kind !== 'task') return item;
  return { ...item, task: await agentTaskDetail(ctx, source, askIdOf(input.ref)) };
}
