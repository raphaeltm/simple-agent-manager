/**
 * The inbox list and count (idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9, spec section 3.2): one D1 statement
 * over every store that holds an ask today, filtered to the viewer and to active project
 * membership, merged and sorted. Nothing is copied: `asks` rows (questions since slice G,
 * reviews, tasks, errors), permission requests and questions asked before slice G from the
 * `session_summaries.attention_json` index the ProjectData DO already writes
 * (`packages/project-data/src/do/session-summary-sync.ts`), secret requests and approvals. The
 * list never calls a Durable Object per chat.
 *
 * Sort: tier 0 items with a live deadline (permissions, asks with a due time), tier 1 blocking,
 * tier 2 the rest; inside a tier the items of one chat (or group) stay together as a stack,
 * stacks ordered by their oldest item, items oldest first.
 *
 * `attention_json` holds one marker per chat, so a chat lists one permission (or one question
 * asked before slice G) at a time until slice J moves permissions into `asks`.
 */
import type {
  InboxCountResponse,
  InboxFilter,
  InboxItem,
  InboxListResponse,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { OperationError } from './errors';
import { inboxItemFromRow, InboxRowSchema } from './inbox-rows';
import { getInboxLimits } from './inbox-settings';
import type { OperationContext } from './types';

const CursorSchema = v.tuple([
  v.pipe(v.number(), v.integer()),
  v.pipe(v.number(), v.safeInteger()),
  v.string(),
  v.pipe(v.number(), v.safeInteger()),
  v.string(),
]);

export interface InboxListInput {
  projectId?: string;
  filter?: InboxFilter;
  limit?: number;
  cursor?: string;
}

interface Bound {
  sql: string;
  params: unknown[];
}

/**
 * Who sees a pending secret request (`r` joined to the viewer's membership `pm`): the person whose
 * agent asked, or, when that person cannot supply secrets, every member who can. The same people
 * are notified (`secretRequestRecipients`, `runtime-secret-request-delivery.ts`). Binds: viewer,
 * then the secret-writer roles twice.
 */
export const SECRET_VISIBLE = (writerRoles: string) =>
  `(r.requester_user_id = ? OR (pm.role IN (${writerRoles}) AND NOT EXISTS (
    SELECT 1 FROM project_members rq WHERE rq.project_id = r.project_id
      AND rq.user_id = r.requester_user_id AND rq.status = 'active' AND rq.role IN (${writerRoles}))))`;

/** Roles that may act, by store; supplied by the worker so the role table has one home. */
function roleList(roles: readonly string[]): Bound {
  if (roles.length === 0) return { sql: 'NULL', params: [] };
  return { sql: roles.map(() => '?').join(', '), params: [...roles] };
}

/**
 * The `items` CTE body: one SELECT per store, each already filtered to this viewer and to
 * projects where the viewer is an active member. Every SELECT yields the same columns.
 */
export function inboxItemsSql(
  ctx: OperationContext,
  input: { projectId?: string; filter: InboxFilter; now: number; forCount: boolean }
): Bound {
  const me = ctx.actor.userId;
  const projectId = input.projectId ?? ctx.actor.workspace?.projectId;
  const projectScope = (column: string): Bound =>
    projectId ? { sql: ` AND ${column} = ?`, params: [projectId] } : { sql: '', params: [] };
  const taskWriters = roleList(ctx.ports.inbox.rolesWithCapability('task:write'));
  const secretWriters = roleList(ctx.ports.inbox.rolesWithCapability('secret:write'));
  const nowIso = new Date(input.now).toISOString();
  const parts: Bound[] = [];
  const member = (column: string) =>
    `JOIN project_members pm ON pm.project_id = ${column} AND pm.user_id = ? AND pm.status = 'active'`;

  // asks: assigned to me, or a team item. A team task another member took stays listed for
  // everyone (slice H1) but is not actionable, so it leaves "needs you" and the count.
  {
    const scope = projectScope('a.project_id');
    const status =
      input.filter === 'archived'
        ? `(a.status IN ('archived', 'answered') OR (a.status = 'open' AND (a.expires_at IS NULL OR a.expires_at > ?)))`
        : `a.status = 'open' AND (a.expires_at IS NULL OR a.expires_at > ?)`;
    const statusParams = [input.now];
    const kind =
      input.filter === 'tasks'
        ? ` AND a.kind = 'task'`
        : input.filter === 'reviews'
          ? ` AND a.kind = 'review'`
          : input.filter === 'blocking'
            ? ` AND a.blocking = 1`
            : '';
    parts.push({
      sql: `SELECT 'ask' AS store, a.id AS item_id, NULL AS marker_id, a.project_id AS project_id,
          a.source_session_id AS session_id, a.source_task_id AS task_id, a.kind AS kind,
          a.blocking AS blocking, a.title AS title, a.body_md AS body, a.status AS status,
          a.created_at AS created_at, a.expires_at AS expires_at, a.due_at AS due_at,
          a.updated_at AS updated_at, a.failure_count AS failure_count,
          a.answer_spec_json AS extra_json, a.links_json AS links_json,
          CASE WHEN a.status = 'open' AND pm.role IN (${taskWriters.sql})
            AND (a.assignee_kind = 'user' OR a.claimed_by_user_id IS NULL OR a.claimed_by_user_id = ?)
            THEN 1 ELSE 0 END AS can_act,
          CASE WHEN a.due_at IS NOT NULL THEN 0 WHEN a.blocking = 1 THEN 1 ELSE 2 END AS tier,
          COALESCE(a.project_id || ':' || a.group_key, a.source_session_id, 'ask:' || a.id) AS stack_key
        FROM asks a ${member('a.project_id')}
        WHERE ${status}${kind}${scope.sql}
          AND ((a.assignee_kind = 'user' AND a.assignee_user_id = ?) OR a.assignee_kind = 'team')`,
      params: [...taskWriters.params, me, me, ...statusParams, ...scope.params, me],
    });
  }

  const openStoresIncluded =
    input.filter === 'needs_you' || input.filter === 'blocking' || input.filter === 'archived';
  if (openStoresIncluded) {
    // Questions and permissions, from the chat index. A row whose JSON cannot be read is still
    // selected for a list page so the reader logs and skips it (rule 50); a count leaves it out.
    const scope = projectScope('ss.project_id');
    const valid = `json_valid(ss.attention_json)`;
    const field = (path: string) => `json_extract(ss.attention_json, '$.${path}')`;
    const isInteraction = `(${field('source')} = 'acp_interaction' OR ${field('reason')} = 'acp_interaction_pending')`;
    parts.push({
      sql: `SELECT 'attention' AS store, ss.id AS item_id,
          CASE WHEN ${valid} THEN ${field('markerId')} END AS marker_id, ss.project_id AS project_id,
          ss.id AS session_id, ss.task_id AS task_id, NULL AS kind, 1 AS blocking,
          NULL AS title, NULL AS body, 'open' AS status,
          COALESCE(CASE WHEN ${valid} THEN ${field('createdAt')} END, ss.updated_at) AS created_at,
          CASE WHEN ${valid} THEN ${field('expiresAt')} END AS expires_at, NULL AS due_at, NULL AS updated_at, NULL AS failure_count,
          ss.attention_json AS extra_json, NULL AS links_json,
          CASE WHEN pm.role IN (${taskWriters.sql}) THEN 1 ELSE 0 END AS can_act,
          CASE WHEN ${valid} AND ${isInteraction} THEN 0 ELSE 1 END AS tier,
          ss.id AS stack_key
        FROM session_summaries ss ${member('ss.project_id')}
        WHERE ss.created_by_user_id = ? AND ss.attention_json IS NOT NULL${scope.sql}
          AND (${input.forCount ? '' : `NOT ${valid} OR `}(${valid}
            AND ${field('kind')} = 'needs_input'
            AND (${field('expiresAt')} IS NULL OR ${field('expiresAt')} > ?)))`,
      params: [...taskWriters.params, me, me, ...scope.params, input.now],
    });

    // A rejected permission's live attention summary is gone. Derive its stable reference
    // from the reply ledger and chat index; its body/detail still lives only in ProjectData.
    const historyScope = projectScope('ir.project_id');
    const historyMarker = "substr(history.item_ref, 11 + instr(substr(history.item_ref, 11), ':'))";
    parts.push({
      sql: `SELECT 'attention' AS store, ss.id AS item_id, ${historyMarker} AS marker_id,
        ss.project_id, ss.id AS session_id, ss.task_id, NULL AS kind, 0 AS blocking,
        NULL AS title, NULL AS body, 'done' AS status, history.asked_at AS created_at,
        NULL AS expires_at, NULL AS due_at, NULL AS updated_at, NULL AS failure_count,
        json_object('markerId', ${historyMarker}, 'kind', 'needs_input', 'createdAt', history.asked_at,
          'expiresAt', NULL, 'reason', 'acp_interaction_pending', 'source', 'acp_interaction',
          'interactionKind', 'permission') AS extra_json, NULL AS links_json,
        CASE WHEN pm.role IN (${taskWriters.sql}) THEN 1 ELSE 0 END AS can_act,
        2 AS tier, ss.id AS stack_key
      FROM (SELECT ir.project_id, ir.item_ref, MIN(ir.replied_at) AS asked_at FROM inbox_replies ir
        WHERE ir.permission_rejected = 1${historyScope.sql}
          AND ir.project_id IN (SELECT project_id FROM project_members
            WHERE user_id = ? AND status = 'active')
        GROUP BY ir.project_id, ir.item_ref) history
      JOIN session_summaries ss ON ss.project_id = history.project_id
        AND ss.id = substr(history.item_ref, 11, instr(substr(history.item_ref, 11), ':') - 1)
      ${member('ss.project_id')}
      WHERE ss.created_by_user_id = ?${input.filter === 'blocking' ? ' AND 0' : ''}
        AND (ss.attention_json IS NULL OR NOT json_valid(ss.attention_json)
          OR json_extract(ss.attention_json, '$.markerId') IS NOT ${historyMarker})`,
      params: [...taskWriters.params, ...historyScope.params, me, me, me],
    });

    const secretScope = projectScope('r.project_id');
    parts.push({
      sql: `SELECT 'secret' AS store, r.id AS item_id, NULL AS marker_id, r.project_id AS project_id,
          r.requesting_chat_session_id AS session_id, r.requesting_task_id AS task_id,
          'secret' AS kind, 1 AS blocking, r.env_key AS title, r.reason AS body, 'open' AS status,
          r.created_at AS created_at, r.expires_at AS expires_at, NULL AS due_at, NULL AS updated_at, NULL AS failure_count,
          NULL AS extra_json, NULL AS links_json,
          CASE WHEN pm.role IN (${secretWriters.sql}) THEN 1 ELSE 0 END AS can_act,
          1 AS tier, r.requesting_chat_session_id AS stack_key
        FROM runtime_secret_requests r ${member('r.project_id')}
        WHERE r.status = 'pending' AND r.expires_at > ?${secretScope.sql}
          AND ${SECRET_VISIBLE(secretWriters.sql)}`,
      params: [
        ...secretWriters.params,
        me,
        input.now,
        ...secretScope.params,
        me,
        ...secretWriters.params,
        ...secretWriters.params,
      ],
    });

    // Operations approvals are decided by superadmins; only a superadmin who is a member of the
    // requesting project sees them.
    const approvalScope = projectScope('ap.requesting_project_id');
    parts.push({
      sql: `SELECT 'approval' AS store, ap.id AS item_id, NULL AS marker_id,
          ap.requesting_project_id AS project_id, ap.requesting_session_id AS session_id,
          ap.requesting_task_id AS task_id, 'approval' AS kind, 1 AS blocking,
          ap.action AS title, ap.reason AS body, 'open' AS status,
          COALESCE(CAST(ROUND((julianday(ap.created_at) - 2440587.5) * 86400000) AS INTEGER), 0) AS created_at,
          CAST(ROUND((julianday(ap.expires_at) - 2440587.5) * 86400000) AS INTEGER) AS expires_at,
          NULL AS due_at, NULL AS updated_at, NULL AS failure_count,
          json_object('targetType', ap.target_type, 'targetId', ap.target_id) AS extra_json,
          NULL AS links_json,
          CASE WHEN pm.role IN (${taskWriters.sql}) THEN 1 ELSE 0 END AS can_act, 1 AS tier,
          COALESCE(ap.requesting_session_id, 'approval:' || ap.id) AS stack_key
        FROM operations_action_approvals ap ${member('ap.requesting_project_id')}
        WHERE ap.status = 'pending' AND ap.expires_at > ?${approvalScope.sql}
          AND EXISTS (SELECT 1 FROM users u WHERE u.id = ? AND u.role = 'superadmin' AND u.status = 'active')`,
      params: [...taskWriters.params, me, nowIso, ...approvalScope.params, me],
    });
  }

  return {
    sql: `SELECT base.*, lr.user_id AS reply_user_id, u.name AS reply_name,
      lr.message_id AS reply_message_id, lr.replied_at AS replied_at,
      COALESCE(lr.permission_rejected, 0) AS permission_rejected, lr.agent_acted_at AS agent_acted_at,
      CASE WHEN EXISTS (SELECT 1 FROM inbox_replies pending
        WHERE pending.project_id = base.project_id AND pending.item_ref = ${replyRefSql('base')}
          AND pending.agent_acted_at IS NULL) THEN 1 ELSE 0 END AS with_agent
      FROM (${parts.map((part) => part.sql).join('\nUNION ALL\n')}) base
      LEFT JOIN inbox_replies lr ON lr.project_id = base.project_id
        AND lr.item_ref = ${replyRefSql('base')}
        AND lr.message_id = (SELECT latest.message_id FROM inbox_replies latest
          WHERE latest.project_id = base.project_id AND latest.item_ref = ${replyRefSql('base')}
          ORDER BY latest.id DESC LIMIT 1)
      LEFT JOIN users u ON u.id = lr.user_id
      WHERE ${
        input.filter === 'archived'
          ? "(base.status IN ('archived', 'answered') OR EXISTS (SELECT 1 FROM inbox_replies hidden WHERE hidden.project_id = base.project_id AND hidden.item_ref = " +
            replyRefSql('base') +
            ' AND hidden.agent_acted_at IS NULL))'
          : 'NOT EXISTS (SELECT 1 FROM inbox_replies hidden WHERE hidden.project_id = base.project_id AND hidden.item_ref = ' +
            replyRefSql('base') +
            ' AND hidden.agent_acted_at IS NULL)'
      }`,
    params: parts.flatMap((part) => part.params),
  };
}

/** Must match formatInboxRef; the same predicate wraps list and badge count. */
function replyRefSql(alias: string): string {
  return `CASE WHEN ${alias}.store = 'attention'
    THEN 'attention:' || ${alias}.item_id || ':' || ${alias}.marker_id
    ELSE ${alias}.store || ':' || ${alias}.item_id END`;
}

function parseCursor(cursor: string | undefined) {
  if (!cursor) return null;
  try {
    return v.parse(CursorSchema, JSON.parse(cursor));
  } catch {
    throw new OperationError('invalid_input', 'Invalid inbox cursor');
  }
}

export async function listInbox(
  ctx: OperationContext,
  input: InboxListInput
): Promise<InboxListResponse> {
  const limits = await getInboxLimits(ctx);
  const limit = Math.min(
    limits.listPageMax,
    Math.max(1, Math.floor(input.limit ?? limits.listPageSize))
  );
  const cursor = parseCursor(input.cursor);
  const now = Date.now();
  const filter = input.filter ?? 'needs_you';
  const items = inboxItemsSql(ctx, { projectId: input.projectId, filter, now, forCount: false });
  // `needs_you` lists what this viewer can act on; the other filters list everything assigned.
  const actable = filter === 'needs_you' ? 'WHERE can_act = 1' : '';
  const sql = `WITH items AS (${items.sql}),
    ranked AS (
      SELECT items.*, MIN(created_at) OVER (PARTITION BY tier, stack_key) AS stack_anchor,
        store || ':' || item_id || ':' || COALESCE(marker_id, '') AS sort_ref
      FROM items ${actable}
    )
    SELECT ranked.*, p.name AS project_name, ss.topic AS topic,
      t.status AS task_status, t.execution_step AS task_step
    FROM ranked
    LEFT JOIN projects p ON p.id = ranked.project_id
    LEFT JOIN session_summaries ss ON ss.id = ranked.session_id AND ss.project_id = ranked.project_id
    LEFT JOIN tasks t ON t.id = ranked.task_id AND t.project_id = ranked.project_id
    ${
      cursor
        ? 'WHERE (ranked.tier, ranked.stack_anchor, ranked.stack_key, ranked.created_at, ranked.sort_ref) > (?, ?, ?, ?, ?)'
        : ''
    }
    ORDER BY ranked.tier, ranked.stack_anchor, ranked.stack_key, ranked.created_at, ranked.sort_ref
    LIMIT ?`;
  const result = await ctx.env.DATABASE.prepare(sql)
    .bind(...items.params, ...(cursor ?? []), limit + 1)
    .all<Record<string, unknown>>();
  const rows = result.results ?? [];
  const page = rows.slice(0, limit);
  const mapped: InboxItem[] = [];
  let skipped = 0;
  for (const raw of page) {
    try {
      mapped.push(inboxItemFromRow(v.parse(InboxRowSchema, raw), now));
    } catch (error) {
      // One malformed row must not hide the others (rule 50).
      skipped += 1;
      console.warn(
        JSON.stringify({
          event: 'inbox.list_row_skipped',
          store: typeof raw.store === 'string' ? raw.store : null,
          itemId: typeof raw.item_id === 'string' ? raw.item_id : null,
          projectId: typeof raw.project_id === 'string' ? raw.project_id : null,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }
  const last = page.at(-1);
  return {
    items: mapped,
    skipped,
    nextCursor:
      rows.length > limit && last
        ? JSON.stringify([
            last.tier,
            last.stack_anchor,
            last.stack_key,
            last.created_at,
            last.sort_ref,
          ])
        : null,
  };
}

/** The badge: open items this viewer can act on, and how many of them block an agent. */
export async function countInbox(
  ctx: OperationContext,
  input: { projectId?: string }
): Promise<InboxCountResponse> {
  const items = inboxItemsSql(ctx, {
    projectId: input.projectId,
    filter: 'needs_you',
    now: Date.now(),
    forCount: true,
  });
  const row = await ctx.env.DATABASE.prepare(
    `WITH items AS (${items.sql})
     SELECT COUNT(*) AS needs_you, COALESCE(SUM(blocking), 0) AS blocking
     FROM items WHERE can_act = 1`
  )
    .bind(...items.params)
    .first<{ needs_you: number; blocking: number }>();
  return { needsYou: Number(row?.needs_you ?? 0), blocking: Number(row?.blocking ?? 0) };
}
