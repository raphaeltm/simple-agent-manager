/**
 * One inbox item, bound to its project (spec section 3.5): missing and foreign items answer the
 * same not-found, and the transcript context is returned only to a reader who can read the
 * source chat. Each store is read where it lives; nothing is copied.
 */
import {
  type InboxItem,
  type InboxItemResponse,
  type ParsedInboxRef,
  parseInboxRef,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { authorizeProjectOperation } from './authorization';
import { OperationError } from './errors';
import { SECRET_VISIBLE } from './inbox-list-core';
import { inboxItemFromRow, InboxRowSchema } from './inbox-rows';
import { getTaskDetailForPerson } from './inbox-task-core';
import { TASK_FILER_SQL } from './inbox-task-rows';
import type { OperationContext } from './types';

export const INBOX_NOT_FOUND = 'Inbox item not found';

export function parseRefOrNotFound(ref: string): ParsedInboxRef {
  const parsed = parseInboxRef(ref);
  // An unknown shape is indistinguishable from a missing item.
  if (!parsed) throw new OperationError('not_found', INBOX_NOT_FOUND);
  return parsed;
}

function roles(ctx: OperationContext, capability: 'task:write' | 'secret:read' | 'secret:write') {
  const list = ctx.ports.inbox.rolesWithCapability(capability);
  return { sql: list.length ? list.map(() => '?').join(', ') : 'NULL', params: [...list] };
}

const ENRICH = `LEFT JOIN projects p ON p.id = x.project_id
  LEFT JOIN session_summaries ss ON ss.id = x.session_id AND ss.project_id = x.project_id
  LEFT JOIN tasks t ON t.id = x.task_id AND t.project_id = x.project_id`;
const ENRICH_COLUMNS = `p.name AS project_name, ss.topic AS topic, t.status AS task_status,
  t.execution_step AS task_step`;

async function readStoreRow(
  ctx: OperationContext,
  projectId: string,
  ref: Exclude<ParsedInboxRef, { store: 'attention' }>
): Promise<Record<string, unknown> | null> {
  const me = ctx.actor.userId;
  const db = ctx.env.DATABASE;
  if (ref.store === 'ask') {
    const writers = roles(ctx, 'task:write');
    return db
      .prepare(
        `SELECT x.*, ${ENRICH_COLUMNS} FROM (
          SELECT 'ask' AS store, a.id AS item_id, NULL AS marker_id, a.project_id,
            a.source_session_id AS session_id, a.source_task_id AS task_id, a.kind, a.blocking,
            a.title, a.body_md AS body, a.status, a.created_at, a.expires_at, a.due_at,
            a.updated_at, a.failure_count,
            a.answer_spec_json AS extra_json, a.links_json,
            CASE WHEN a.status = 'open' AND pm.role IN (${writers.sql})
              AND ((a.assignee_kind = 'user' AND a.assignee_user_id = ?)
                OR (a.assignee_kind = 'team' AND (a.claimed_by_user_id IS NULL OR a.claimed_by_user_id = ?)))
              THEN 1 ELSE 0 END AS can_act,
            COALESCE(a.project_id || ':' || a.group_key, a.source_session_id, 'ask:' || a.id) AS stack_key
          FROM asks a
          JOIN project_members pm ON pm.project_id = a.project_id AND pm.user_id = ? AND pm.status = 'active'
          WHERE a.id = ? AND a.project_id = ?
            AND ((a.assignee_kind = 'user' AND a.assignee_user_id = ?)
              OR a.assignee_kind = 'team'
              OR (a.kind = 'task' AND ${TASK_FILER_SQL} = ?))
        ) x ${ENRICH}`
      )
      .bind(...writers.params, me, me, me, ref.id, projectId, me, me)
      .first<Record<string, unknown>>();
  }
  if (ref.store === 'secret') {
    const readers = roles(ctx, 'secret:read');
    const writers = roles(ctx, 'secret:write');
    return db
      .prepare(
        `SELECT x.*, ${ENRICH_COLUMNS} FROM (
          SELECT 'secret' AS store, r.id AS item_id, NULL AS marker_id, r.project_id,
            r.requesting_chat_session_id AS session_id, r.requesting_task_id AS task_id,
            'secret' AS kind, 1 AS blocking, r.env_key AS title, r.reason AS body,
            CASE r.status WHEN 'pending' THEN CASE WHEN r.expires_at > ? THEN 'open' ELSE 'expired' END
              WHEN 'fulfilled' THEN 'answered' WHEN 'declined' THEN 'archived' ELSE 'expired' END AS status,
            r.created_at, r.expires_at, NULL AS due_at, NULL AS extra_json, NULL AS links_json,
            CASE WHEN pm.role IN (${writers.sql}) THEN 1 ELSE 0 END AS can_act,
            r.requesting_chat_session_id AS stack_key
          FROM runtime_secret_requests r
          JOIN project_members pm ON pm.project_id = r.project_id AND pm.user_id = ? AND pm.status = 'active'
            AND pm.role IN (${readers.sql})
          WHERE r.id = ? AND r.project_id = ? AND ${SECRET_VISIBLE(writers.sql)}
        ) x ${ENRICH}`
      )
      .bind(
        Date.now(),
        ...writers.params,
        me,
        ...readers.params,
        ref.id,
        projectId,
        me,
        ...writers.params,
        ...writers.params
      )
      .first<Record<string, unknown>>();
  }
  const writers = roles(ctx, 'task:write');
  return db
    .prepare(
      `SELECT x.*, ${ENRICH_COLUMNS} FROM (
        SELECT 'approval' AS store, ap.id AS item_id, NULL AS marker_id,
          ap.requesting_project_id AS project_id, ap.requesting_session_id AS session_id,
          ap.requesting_task_id AS task_id, 'approval' AS kind, 1 AS blocking,
          ap.action AS title, ap.reason AS body,
          CASE WHEN ap.status = 'pending' AND ap.expires_at > ? THEN 'open'
            WHEN ap.status = 'pending' THEN 'expired'
            WHEN ap.status IN ('approved', 'executed') THEN 'answered'
            WHEN ap.status = 'denied' THEN 'archived' ELSE 'expired' END AS status,
          COALESCE(CAST(ROUND((julianday(ap.created_at) - 2440587.5) * 86400000) AS INTEGER), 0) AS created_at,
          CAST(ROUND((julianday(ap.expires_at) - 2440587.5) * 86400000) AS INTEGER) AS expires_at,
          NULL AS due_at,
          json_object('targetType', ap.target_type, 'targetId', ap.target_id) AS extra_json,
          NULL AS links_json,
          CASE WHEN pm.role IN (${writers.sql}) THEN 1 ELSE 0 END AS can_act,
          COALESCE(ap.requesting_session_id, 'approval:' || ap.id) AS stack_key
        FROM operations_action_approvals ap
        JOIN project_members pm ON pm.project_id = ap.requesting_project_id AND pm.user_id = ?
          AND pm.status = 'active'
        WHERE ap.id = ? AND ap.requesting_project_id = ?
          AND EXISTS (SELECT 1 FROM users u WHERE u.id = ? AND u.role = 'superadmin' AND u.status = 'active')
      ) x ${ENRICH}`
    )
    .bind(new Date().toISOString(), ...writers.params, me, ref.id, projectId, me)
    .first<Record<string, unknown>>();
}

async function readAttentionItem(
  ctx: OperationContext,
  projectId: string,
  ref: Extract<ParsedInboxRef, { store: 'attention' }>
): Promise<InboxItem | null> {
  const marker = await ctx.ports.inbox.attentionMarker(
    projectId,
    ref.sessionId,
    ref.markerId,
    ctx.actor.userId
  );
  // Same people the list shows it to: the chat's creator, plus anyone it is shared with to write.
  if (!marker || !marker.canWrite || marker.sessionId !== ref.sessionId) return null;
  const extra = await ctx.env.DATABASE.prepare(
    `SELECT p.name AS project_name, t.status AS task_status, t.execution_step AS task_step
       FROM projects p LEFT JOIN tasks t ON t.id = ? AND t.project_id = p.id
      WHERE p.id = ?`
  )
    .bind(marker.taskId, projectId)
    .first<Record<string, unknown>>();
  const row = v.parse(InboxRowSchema, {
    store: 'attention',
    item_id: ref.sessionId,
    marker_id: marker.id,
    project_id: projectId,
    session_id: ref.sessionId,
    task_id: marker.taskId,
    kind: null,
    blocking: 1,
    title: null,
    body: null,
    status: marker.resolvedAt === null ? 'open' : 'done',
    created_at: marker.createdAt,
    expires_at: marker.expiresAt,
    due_at: null,
    extra_json: JSON.stringify({
      markerId: marker.id,
      kind: 'needs_input',
      createdAt: marker.createdAt,
      expiresAt: marker.expiresAt,
      reason: marker.reason,
      options: marker.options,
      source: marker.source,
      category: marker.category,
      interactionId: marker.interactionId,
      interactionKind: marker.interactionKind,
    }),
    links_json: null,
    can_act: marker.canWrite ? 1 : 0,
    stack_key: ref.sessionId,
    project_name: extra?.project_name ?? null,
    topic: marker.topic,
    task_status: extra?.task_status ?? null,
    task_step: extra?.task_step ?? null,
  });
  return inboxItemFromRow(row, Date.now());
}

/** Resolve one item the caller may see, or throw the shared not-found. */
export async function resolveInboxItem(
  ctx: OperationContext,
  input: { projectId: string; ref: string },
  /** The caller already authorized the project (a write checks `task:write` first). */
  projectAuthorized = false
): Promise<{ item: InboxItem; ref: ParsedInboxRef }> {
  if (!projectAuthorized) await authorizeProjectOperation(ctx, input.projectId);
  const ref = parseRefOrNotFound(input.ref);
  let item: InboxItem | null = null;
  if (ref.store === 'attention') {
    item = await readAttentionItem(ctx, input.projectId, ref);
  } else {
    const raw = await readStoreRow(ctx, input.projectId, ref);
    if (raw) {
      try {
        item = inboxItemFromRow(v.parse(InboxRowSchema, raw), Date.now());
      } catch (error) {
        // A malformed row is a clean not-found, never an opaque 500 (rule 50).
        console.warn(
          JSON.stringify({
            event: 'inbox.get_row_skipped',
            store: ref.store,
            itemId: ref.id,
            projectId: input.projectId,
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }
    }
  }
  // Defence in depth: the item must belong to the project the caller was authorized for.
  if (!item || item.projectId !== input.projectId) {
    throw new OperationError('not_found', INBOX_NOT_FOUND);
  }
  return { item, ref };
}

export async function getInboxItem(
  ctx: OperationContext,
  input: { projectId: string; ref: string; context?: boolean }
): Promise<InboxItemResponse> {
  const { item, ref } = await resolveInboxItem(ctx, input);
  // A human task's steps, assignee, claim, activity and discussion (slice H1). The transcript
  // (`context`) still needs read access to the chat; the task view never does.
  const task =
    item.kind === 'task' && ref.store === 'ask'
      ? await getTaskDetailForPerson(ctx, { projectId: item.projectId, askId: ref.id })
      : null;
  const context =
    input.context && item.sessionId
      ? await ctx.ports.inbox.context({
          projectId: item.projectId,
          sessionId: item.sessionId,
          askedAt: Date.parse(item.createdAt),
          userId: ctx.actor.userId,
        })
      : null;
  return { item, context, task };
}
