import { maybeJsonRecord, parsePositiveInt, preferAttention, readOpenQuestionAttention } from '@simple-agent-manager/worker-core';
import * as schema from '@simple-agent-manager/worker-core/schema';
import { and, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as v from 'valibot';

import { questionMetadata } from './attention-core';
import { authorizeProjectOperation } from './authorization';
import { chatTaskStates } from './chat-operational';
import { OperationError } from './errors';
import { ideaTaskPredicateSql } from './idea-identity';
import { listInbox } from './inbox-list-core';
import { getPlatformOperationLimits } from './limits';
import type { OperationContext } from './types';

export function requireReadScope(ctx: OperationContext): void {
  if (!ctx.actor.scopes.has('sam.read'))
    throw new OperationError('forbidden', 'Missing sam.read scope');
}
export function operationLink(ctx: OperationContext, projectId?: string, sessionId?: string) {
  const origin = new URL(ctx.ports.config.apiOrigin());
  if (origin.hostname.startsWith('api.')) origin.hostname = `app.${origin.hostname.slice(4)}`;
  const base = origin.origin;
  return projectId
    ? `${base}/projects/${encodeURIComponent(projectId)}${sessionId ? `/chat/${encodeURIComponent(sessionId)}` : ''}`
    : base;
}
export function operationPageLimit(ctx: OperationContext, requested?: number) {
  const limits = getPlatformOperationLimits(ctx.env);
  return Math.min(limits.taskListMax, Math.max(1, Math.floor(requested ?? limits.taskListLimit)));
}
/** Current membership, not stale ownership or index attribution, defines visibility. */
export function membershipCondition(
  ctx: OperationContext,
  projectId:
    | typeof schema.projects.id
    | typeof schema.tasks.projectId
    | typeof schema.sessionSummaries.projectId
) {
  return sql`exists (select 1 from ${schema.projectMembers} where ${schema.projectMembers.projectId} = ${projectId} and ${schema.projectMembers.userId} = ${ctx.actor.userId} and ${schema.projectMembers.status} = 'active')`;
}
export async function projectsList(
  ctx: OperationContext,
  input: { limit?: number; cursor?: string }
) {
  requireReadScope(ctx);
  const db = drizzle(ctx.env.DATABASE, { schema });
  const limit = operationPageLimit(ctx, input.limit);
  const rows = await db
    .select({
      id: schema.projects.id,
      name: schema.projects.name,
      repository: schema.projects.repository,
      status: schema.projects.status,
      role: schema.projectMembers.role,
      runningWork: sql<number>`(select count(*) from tasks t where t.project_id = ${schema.projects.id} and t.status in ('queued','delegated','in_progress'))`,
      // Chats waiting on the viewer: an attention marker, or an open question in `asks` (slice G).
      needsAttention: sql<number>`(select count(*) from session_summaries ss where ss.project_id = ${schema.projects.id} and ss.created_by_user_id = ${ctx.actor.userId} and (ss.attention_json is not null or exists (select 1 from asks a where a.source_session_id = ss.id and a.project_id = ss.project_id and a.kind = 'question' and a.status = 'open' and (a.expires_at is null or a.expires_at > ${Date.now()}))))`,
    })
    .from(schema.projects)
    .innerJoin(
      schema.projectMembers,
      and(
        eq(schema.projectMembers.projectId, schema.projects.id),
        eq(schema.projectMembers.userId, ctx.actor.userId),
        eq(schema.projectMembers.status, 'active')
      )
    )
    .where(
      and(
        input.cursor ? sql`${schema.projects.id} < ${input.cursor}` : undefined,
        ctx.actor.workspace ? eq(schema.projects.id, ctx.actor.workspace.projectId) : undefined
      )
    )
    .orderBy(desc(schema.projects.id))
    .limit(limit + 1);
  return {
    projects: rows.slice(0, limit).map((row) => ({ ...row, link: operationLink(ctx, row.id) })),
    nextCursor: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null,
  };
}
export async function chatsList(
  ctx: OperationContext,
  input: { projectId?: string; status?: string; limit?: number; cursor?: string }
) {
  requireReadScope(ctx);
  if (input.projectId) await authorizeProjectOperation(ctx, input.projectId);
  const db = drizzle(ctx.env.DATABASE, { schema });
  let cursor: { updatedAt: number; id: string } | undefined;
  if (input.cursor) {
    try {
      const parsed = JSON.parse(input.cursor) as unknown;
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 2 ||
        typeof parsed[0] !== 'number' ||
        !Number.isSafeInteger(parsed[0]) ||
        typeof parsed[1] !== 'string'
      )
        throw new Error('invalid');
      cursor = { updatedAt: parsed[0], id: parsed[1] };
    } catch {
      throw new OperationError('invalid_input', 'Invalid chat cursor');
    }
  }
  const limit = operationPageLimit(ctx, input.limit);
  const rows = await db
    .select({
      id: schema.sessionSummaries.id,
      projectId: schema.sessionSummaries.projectId,
      topic: schema.sessionSummaries.topic,
      status: schema.sessionSummaries.status,
      taskId: schema.sessionSummaries.taskId,
      updatedAt: schema.sessionSummaries.updatedAt,
      lastMessageAt: schema.sessionSummaries.lastMessageAt,
      agentCompletedAt: schema.sessionSummaries.agentCompletedAt,
      createdByUserId: schema.sessionSummaries.createdByUserId,
      attention: schema.sessionSummaries.attentionJson,
    })
    .from(schema.sessionSummaries)
    .where(
      and(
        membershipCondition(ctx, schema.sessionSummaries.projectId),
        input.projectId ? eq(schema.sessionSummaries.projectId, input.projectId) : undefined,
        ctx.actor.workspace
          ? eq(schema.sessionSummaries.projectId, ctx.actor.workspace.projectId)
          : undefined,
        input.status ? eq(schema.sessionSummaries.status, input.status) : undefined,
        cursor
          ? sql`(${schema.sessionSummaries.updatedAt} < ${cursor.updatedAt} OR (${schema.sessionSummaries.updatedAt} = ${cursor.updatedAt} AND ${schema.sessionSummaries.id} < ${cursor.id}))`
          : undefined
      )
    )
    .orderBy(desc(schema.sessionSummaries.updatedAt), desc(schema.sessionSummaries.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const [taskStates, questions] = await Promise.all([
    chatTaskStates(db, page),
    // Open questions live in D1 `asks` (inbox slice G); only the chat's creator sees attention.
    readOpenQuestionAttention(ctx.env.DATABASE, {
      chats: page
        .filter((row) => row.createdByUserId === ctx.actor.userId)
        .map((row) => ({ projectId: row.projectId, sessionId: row.id })),
      assigneeUserId: ctx.actor.userId,
      now: Date.now(),
    }),
  ]);
  return {
    chats: page.map(({ attention, ...row }) => ({
      ...row,
      operational: taskStates.get(row.id) ?? null,
      attention:
        row.createdByUserId === ctx.actor.userId
          ? preferAttention(
              attention ? (JSON.parse(attention) as unknown) : null,
              questions.get(row.id)
            )
          : null,
      link: operationLink(ctx, row.projectId, row.id),
    })),
    nextCursor: rows.length > limit && last ? JSON.stringify([last.updatedAt, last.id]) : null,
  };
}
export async function projectGet(
  ctx: OperationContext,
  input: { projectId: string; limit?: number }
) {
  await authorizeProjectOperation(ctx, input.projectId);
  const db = drizzle(ctx.env.DATABASE, { schema });
  const [project] = await db
    .select({
      id: schema.projects.id,
      name: schema.projects.name,
      repository: schema.projects.repository,
      defaultBranch: schema.projects.defaultBranch,
      status: schema.projects.status,
      // Through the one shared predicate: before the flag existed this counted every `draft`
      // row, which includes every undispatched ordinary task (`operations/idea-identity.ts`).
      ideaCount: sql<number>`(select count(*) from tasks t where t.project_id = ${schema.projects.id} and ${sql.raw(ideaTaskPredicateSql('t'))})`,
      triggerCount: sql<number>`(select count(*) from triggers t where t.project_id = ${schema.projects.id})`,
    })
    .from(schema.projects)
    .where(eq(schema.projects.id, input.projectId));
  if (!project) throw new OperationError('not_found', 'Project not found');
  const tasks = await db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      status: schema.tasks.status,
      outputPrUrl: schema.tasks.outputPrUrl,
      chatSessionId: schema.tasks.chatSessionId,
    })
    .from(schema.tasks)
    .where(eq(schema.tasks.projectId, input.projectId))
    .orderBy(desc(schema.tasks.updatedAt))
    .limit(operationPageLimit(ctx, input.limit));
  return {
    ...project,
    link: operationLink(ctx, input.projectId),
    tasks: tasks.map((task) => ({
      ...task,
      link: operationLink(ctx, input.projectId, task.chatSessionId ?? undefined),
    })),
    ...(await chatsList(ctx, input)),
  };
}
const InboxCursorSchema = v.object({
  // The shared inbox list's own cursor (`inbox-list-core.ts`). Cursors issued before the list
  // moved there carried `sessions`/`attention` positions instead; those restart the list.
  items: v.optional(v.nullable(v.string())),
  sessions: v.optional(v.unknown()),
  attention: v.optional(v.unknown()),
  tasks: v.nullable(v.tuple([v.string(), v.string()])),
  notifications: v.nullable(v.string()),
});

/** Fields of a `needs_input` notification an app needs to answer the question it announces. */
function notificationQuestion(metadata: unknown) {
  const record = maybeJsonRecord(metadata);
  if (typeof record?.attentionMarkerId !== 'string') return undefined;
  const { category, options } = questionMetadata(record);
  return { markerId: record.attentionMarkerId, category, options };
}
export async function inboxGet(ctx: OperationContext, input: { limit?: number; cursor?: string }) {
  let cursor: v.InferOutput<typeof InboxCursorSchema> | undefined;
  if (input.cursor) {
    try {
      cursor = v.parse(InboxCursorSchema, JSON.parse(input.cursor));
    } catch {
      throw new OperationError('invalid_input', 'Invalid inbox cursor');
    }
  }
  requireReadScope(ctx);
  const db = drizzle(ctx.env.DATABASE, { schema });
  const limit = Math.min(
    operationPageLimit(ctx, input.limit),
    parsePositiveInt(ctx.env.CONNECTOR_INBOX_SESSION_LIMIT, 5)
  );
  // What needs the person comes from the one shared inbox list (rule 24): questions,
  // permissions, secret requests, approvals and asks, with no Durable Object call per chat.
  const inbox =
    cursor?.items === null
      ? { items: [], nextCursor: null, skipped: 0 }
      : await listInbox(ctx, { filter: 'needs_you', limit, cursor: cursor?.items ?? undefined });
  const tasks = await db
    .select({
      id: schema.tasks.id,
      projectId: schema.tasks.projectId,
      title: schema.tasks.title,
      status: schema.tasks.status,
      outputPrUrl: schema.tasks.outputPrUrl,
      chatSessionId: schema.tasks.chatSessionId,
      updatedAt: schema.tasks.updatedAt,
    })
    .from(schema.tasks)
    .where(
      and(
        membershipCondition(ctx, schema.tasks.projectId),
        cursor?.tasks === null
          ? sql`0=1`
          : cursor?.tasks
            ? sql`(${schema.tasks.updatedAt} < ${cursor.tasks[0]} OR (${schema.tasks.updatedAt} = ${cursor.tasks[0]} AND ${schema.tasks.id} < ${cursor.tasks[1]}))`
            : undefined,
        eq(schema.tasks.userId, ctx.actor.userId),
        sql`(${schema.tasks.status} in ('failed','completed') OR (${schema.tasks.status} in ('in_progress','sleeping') AND ${schema.tasks.executionStep} = 'awaiting_followup'))`,
        ctx.actor.workspace ? eq(schema.tasks.projectId, ctx.actor.workspace.projectId) : undefined
      )
    )
    .orderBy(desc(schema.tasks.updatedAt), desc(schema.tasks.id))
    .limit(limit + 1);
  const notifications =
    cursor?.notifications === null
      ? { notifications: [], nextCursor: null }
      : await ctx.ports.account.listNotifications(ctx.actor.userId, {
          filter: 'unread',
          cursor: cursor?.notifications ?? undefined,
          limit,
        });
  const accessible = await db
    .select({ projectId: schema.projectMembers.projectId })
    .from(schema.projectMembers)
    .where(
      and(
        eq(schema.projectMembers.userId, ctx.actor.userId),
        eq(schema.projectMembers.status, 'active')
      )
    );
  const projectIds = new Set(accessible.map((row) => row.projectId));
  const lastTask = tasks.slice(0, limit).at(-1);
  const next = {
    items: inbox.nextCursor,
    tasks: tasks.length > limit && lastTask ? [lastTask.updatedAt, lastTask.id] : null,
    notifications: notifications.nextCursor ?? null,
  };
  return {
    nextCursor: next.items || next.tasks || next.notifications ? JSON.stringify(next) : null,
    items: inbox.items.map((item) => ({
      ...item,
      link: operationLink(ctx, item.projectId, item.sessionId ?? undefined),
    })),
    coverage:
      'items: open inbox items you can act on across your projects (sam_inbox_list has filters), blocking ones first. Answer with sam_inbox_answer or sam_agent_answer. tasks: your finished or follow-up work. notifications: unread.',
    tasks: tasks.slice(0, limit).map((row) => ({
      ...row,
      link: operationLink(ctx, row.projectId, row.chatSessionId ?? undefined),
    })),
    notifications: notifications.notifications
      .filter(
        (row) =>
          (!row.projectId || projectIds.has(row.projectId)) &&
          (!ctx.actor.workspace || row.projectId === ctx.actor.workspace.projectId)
      )
      .map((row) => {
        const question =
          row.type === 'needs_input' ? notificationQuestion(row.metadata) : undefined;
        return {
          id: row.id,
          title: row.title,
          body: row.body,
          type: row.type,
          // Unread notifications can be months old; the date is what says so.
          createdAt: row.createdAt,
          projectId: row.projectId,
          sessionId: row.sessionId,
          // Answer with sam_agent_answer (projectId, sessionId, markerId, answer) after asking.
          ...(question ? { question } : {}),
          link: operationLink(ctx, row.projectId ?? undefined, row.sessionId ?? undefined),
        };
      }),
  };
}
