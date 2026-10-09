import { and, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as v from 'valibot';

import * as schema from '../db/schema';
import type { NotificationService } from '../durable-objects/notification';
import { parsePositiveInt } from '../lib/route-helpers';
import { getTrustedApiOrigin } from '../lib/trusted-origins';
import { connectorPendingInteractions } from '../services/connector-agent-answer';
import { authorizeProjectOperation } from './authorization';
import { OperationError } from './errors';
import { getPlatformOperationLimits } from './limits';
import type { OperationContext } from './types';

export function requireReadScope(ctx: OperationContext): void {
  if (!ctx.actor.scopes.has('sam.read'))
    throw new OperationError('forbidden', 'Missing sam.read scope');
}
export function operationLink(ctx: OperationContext, projectId?: string, sessionId?: string) {
  const origin = new URL(getTrustedApiOrigin(ctx.env));
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
      needsAttention: sql<number>`(select count(*) from session_summaries ss where ss.project_id = ${schema.projects.id} and ss.created_by_user_id = ${ctx.actor.userId} and ss.attention_json is not null)`,
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
  return {
    chats: page.map(({ attention, ...row }) => ({
      ...row,
      attention:
        row.createdByUserId === ctx.actor.userId && attention
          ? (JSON.parse(attention) as unknown)
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
      ideaCount: sql<number>`(select count(*) from tasks t where t.project_id = ${schema.projects.id} and t.status = 'draft')`,
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
  sessions: v.nullable(v.tuple([v.pipe(v.number(), v.safeInteger()), v.string()])),
  tasks: v.nullable(v.tuple([v.string(), v.string()])),
  notifications: v.nullable(v.string()),
});
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
  const rows = await db
    .select({
      id: schema.sessionSummaries.id,
      projectId: schema.sessionSummaries.projectId,
      topic: schema.sessionSummaries.topic,
      attention: schema.sessionSummaries.attentionJson,
      updatedAt: schema.sessionSummaries.updatedAt,
    })
    .from(schema.sessionSummaries)
    .where(
      and(
        membershipCondition(ctx, schema.sessionSummaries.projectId),
        cursor?.sessions === null
          ? sql`0=1`
          : cursor?.sessions
            ? sql`(${schema.sessionSummaries.updatedAt} < ${cursor.sessions[0]} OR (${schema.sessionSummaries.updatedAt} = ${cursor.sessions[0]} AND ${schema.sessionSummaries.id} < ${cursor.sessions[1]}))`
            : undefined,
        eq(schema.sessionSummaries.createdByUserId, ctx.actor.userId),
        ctx.actor.workspace
          ? eq(schema.sessionSummaries.projectId, ctx.actor.workspace.projectId)
          : undefined
      )
    )
    .orderBy(desc(schema.sessionSummaries.updatedAt), desc(schema.sessionSummaries.id))
    .limit(limit + 1);
  const pending = await Promise.all(
    rows.slice(0, limit).map(async (row) => {
      let attention: unknown = null;
      if (row.attention) {
        try {
          attention = JSON.parse(row.attention);
        } catch {
          /* Corrupt legacy row does not hide other requests. */
        }
      }
      return {
        projectId: row.projectId,
        sessionId: row.id,
        topic: row.topic,
        attention,
        interactions: await connectorPendingInteractions(ctx.env, row.projectId, row.id),
        link: operationLink(ctx, row.projectId, row.id),
      };
    })
  );
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
  const notificationStub = ctx.env.NOTIFICATION.get(
    ctx.env.NOTIFICATION.idFromName(ctx.actor.userId)
  ) as unknown as Pick<NotificationService, 'listNotifications'>;
  const notifications =
    cursor?.notifications === null
      ? { notifications: [], nextCursor: null }
      : await notificationStub.listNotifications(ctx.actor.userId, {
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
  const lastSession = rows.slice(0, limit).at(-1);
  const lastTask = tasks.slice(0, limit).at(-1);
  const next = {
    sessions: rows.length > limit && lastSession ? [lastSession.updatedAt, lastSession.id] : null,
    tasks: tasks.length > limit && lastTask ? [lastTask.updatedAt, lastTask.id] : null,
    notifications: notifications.nextCursor ?? null,
  };
  return {
    nextCursor: next.sessions || next.tasks || next.notifications ? JSON.stringify(next) : null,
    pending: pending.filter((row) => row.attention || row.interactions.length),
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
      .map((row) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        type: row.type,
        link: operationLink(ctx, row.projectId ?? undefined, row.sessionId ?? undefined),
      })),
  };
}
