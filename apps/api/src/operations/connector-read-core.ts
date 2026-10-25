import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as v from 'valibot';

import * as schema from '../db/schema';
import type { NotificationService } from '../durable-objects/notification';
import { parsePositiveInt } from '../lib/route-helpers';
import { getTrustedApiOrigin } from '../lib/trusted-origins';
import { connectorPendingInteractions } from '../services/connector-agent-answer';
import { authorizeProjectOperation } from './authorization';
import { OperationError } from './errors';
import { ideaTaskPredicateSql } from './idea-identity';
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
function isoFromEpochMs(value: number): string | null {
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
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
const SessionCursorSchema = v.tuple([v.pipe(v.number(), v.safeInteger()), v.string()]);
const InboxCursorSchema = v.object({
  sessions: v.nullable(SessionCursorSchema),
  // Absent in cursors issued before questions were selected separately; such a cursor has
  // already returned its questions with the recency page, so it continues without them.
  attention: v.optional(v.nullable(SessionCursorSchema), null),
  tasks: v.nullable(v.tuple([v.string(), v.string()])),
  notifications: v.nullable(v.string()),
});

type InboxSessionCursor = v.InferOutput<typeof SessionCursorSchema> | null | undefined;

/** Fields of a `needs_input` notification an app needs to answer the question it announces. */
function notificationQuestion(metadata: unknown) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const record = metadata as Record<string, unknown>;
  if (typeof record.attentionMarkerId !== 'string') return undefined;
  return {
    markerId: record.attentionMarkerId,
    category: typeof record.category === 'string' ? record.category : null,
    options: Array.isArray(record.options)
      ? record.options.filter((option): option is string => typeof option === 'string')
      : [],
  };
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
  // Two disjoint lists, each with its own cursor, so no chat repeats across pages: chats with an
  // open question, and the rest by recency (checked for permission/form requests, which live
  // outside the D1 index).
  const sessionPage = (page: InboxSessionCursor, withAttention: boolean) =>
    page === null
      ? Promise.resolve([])
      : db
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
              page
                ? sql`(${schema.sessionSummaries.updatedAt} < ${page[0]} OR (${schema.sessionSummaries.updatedAt} = ${page[0]} AND ${schema.sessionSummaries.id} < ${page[1]}))`
                : undefined,
              eq(schema.sessionSummaries.createdByUserId, ctx.actor.userId),
              withAttention
                ? isNotNull(schema.sessionSummaries.attentionJson)
                : isNull(schema.sessionSummaries.attentionJson),
              ctx.actor.workspace
                ? eq(schema.sessionSummaries.projectId, ctx.actor.workspace.projectId)
                : undefined
            )
          )
          .orderBy(desc(schema.sessionSummaries.updatedAt), desc(schema.sessionSummaries.id))
          .limit(limit + 1);
  // A question in a chat that is not among the most recently updated ones is not pushed out.
  const [attentionRows, rows] = await Promise.all([
    sessionPage(cursor ? cursor.attention : undefined, true),
    sessionPage(cursor?.sessions, false),
  ]);
  const candidates = new Map<string, (typeof rows)[number]>();
  for (const row of [...attentionRows.slice(0, limit), ...rows.slice(0, limit)]) {
    if (!candidates.has(row.id)) candidates.set(row.id, row);
  }
  const pending = await Promise.all(
    [...candidates.values()].map(async (row) => {
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
        // Readers (including the SAM assistant) judge recency from this; an undated
        // item is indistinguishable from one that is months old.
        updatedAt: isoFromEpochMs(row.updatedAt),
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
  const lastAttention = attentionRows.slice(0, limit).at(-1);
  const lastTask = tasks.slice(0, limit).at(-1);
  const next = {
    sessions: rows.length > limit && lastSession ? [lastSession.updatedAt, lastSession.id] : null,
    attention:
      attentionRows.length > limit && lastAttention
        ? [lastAttention.updatedAt, lastAttention.id]
        : null,
    tasks: tasks.length > limit && lastTask ? [lastTask.updatedAt, lastTask.id] : null,
    notifications: notifications.nextCursor ?? null,
  };
  return {
    nextCursor:
      next.sessions || next.attention || next.tasks || next.notifications
        ? JSON.stringify(next)
        : null,
    pending: pending.filter((row) => row.attention || row.interactions.length),
    coverage:
      'Chats you created. A shared chat you can answer shows its questions in sam_chat_read and sam_chat_interactions. attention is the newest open question per chat; sam_chat_interactions lists all of them.',
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
