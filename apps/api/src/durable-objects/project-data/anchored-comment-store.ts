/**
 * Reads for the anchored comment tables, shared by every anchor kind.
 *
 * Scoped reads take a `CommentAnchorScope` and always bind `anchor_kind` and `scope_key`
 * (`anchored-comment-scope.ts`). Rows parse through one schema; a malformed row is skipped
 * and logged rather than failing the read (.claude/rules/50). Mapping to the per-kind API
 * shapes (`MessageCommentThread`, `LibraryFileCommentThread`) lives in the kind adapters,
 * `comments.ts` and `library-file-comments.ts`.
 */
import type { CommentAnchorKind, CommentMention } from '@simple-agent-manager/shared';
import { COMMENT_ANCHOR_KINDS, COMMENT_STATUSES } from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { chunk, D1_MAX_BOUND_PARAMETERS } from '../../lib/d1-limits';
import { createModuleLogger } from '../../lib/logger';
import {
  ANCHOR_SCOPE_PREDICATE,
  anchorScopeParams,
  type CommentAnchorScope,
} from './anchored-comment-scope';
import type {
  CommentActor,
  ListProjectCommentThreadCandidatesPage,
  ProjectCommentThreadCandidate,
} from './comment-contracts';
import { actorFromColumns } from './comment-normalization';
import { parseProjectCommentThreadCandidates, restoreThreadOrder } from './comment-read-helpers';
import { parseRow } from './row-schemas';

const log = createModuleLogger('project_data.comments');

const actorKind = v.nullable(v.picklist(['human', 'agent']));

const ThreadRowSchema = v.object({
  id: v.string(),
  anchor_kind: v.picklist(COMMENT_ANCHOR_KINDS),
  scope_key: v.string(),
  session_id: v.nullable(v.string()),
  message_id: v.nullable(v.string()),
  file_id: v.nullable(v.string()),
  quote: v.nullable(v.string()),
  body: v.string(),
  author_type: v.picklist(['human', 'agent']),
  author_id: v.string(),
  author_name: v.nullable(v.string()),
  status: v.picklist(COMMENT_STATUSES),
  created_at: v.number(),
  updated_at: v.number(),
  sequence: v.number(),
  version: v.number(),
  client_mutation_id: v.nullable(v.string()),
  sent_at: v.nullable(v.number()),
  sent_by_type: actorKind,
  sent_by_id: v.nullable(v.string()),
  sent_by_name: v.nullable(v.string()),
  resolved_at: v.nullable(v.number()),
  resolved_by_type: actorKind,
  resolved_by_id: v.nullable(v.string()),
  resolved_by_name: v.nullable(v.string()),
  reopened_at: v.nullable(v.number()),
  reopened_by_type: actorKind,
  reopened_by_id: v.nullable(v.string()),
  reopened_by_name: v.nullable(v.string()),
  mentions_json: v.nullable(v.string()),
});

const ReplyRowSchema = v.object({
  id: v.string(),
  thread_id: v.string(),
  body: v.string(),
  author_type: v.picklist(['human', 'agent']),
  author_id: v.string(),
  author_name: v.nullable(v.string()),
  created_at: v.number(),
  sequence: v.number(),
  client_mutation_id: v.nullable(v.string()),
  mentions_json: v.nullable(v.string()),
});

const CandidateRowSchema = v.object({
  id: v.string(),
  updated_at: v.number(),
  estimated_bytes: v.number(),
});

const MentionSchema = v.object({
  userId: v.pipe(v.string(), v.minLength(1)),
  displayName: v.nullable(v.string()),
});

export interface CommentReplyRecord {
  id: string;
  threadId: string;
  author: CommentActor;
  body: string;
  createdAt: number;
  sequence: number;
  clientMutationId: string | null;
  mentions: CommentMention[];
}

export interface CommentThreadRecord {
  id: string;
  anchorKind: CommentAnchorKind;
  scopeKey: string;
  sessionId: string | null;
  messageId: string | null;
  fileId: string | null;
  quote: string | null;
  author: CommentActor;
  body: string;
  status: (typeof COMMENT_STATUSES)[number];
  createdAt: number;
  updatedAt: number;
  sequence: number;
  version: number;
  clientMutationId: string | null;
  sentAt: number | null;
  sentBy: CommentActor | null;
  resolvedAt: number | null;
  resolvedBy: CommentActor | null;
  reopenedAt: number | null;
  reopenedBy: CommentActor | null;
  mentions: CommentMention[];
  replies: CommentReplyRecord[];
}

export const THREAD_SELECT_COLUMNS = `id, anchor_kind, scope_key, session_id, message_id, file_id,
  quote, body, author_type, author_id, author_name, status, created_at, updated_at, sequence,
  version, client_mutation_id, sent_at, sent_by_type, sent_by_id, sent_by_name,
  resolved_at, resolved_by_type, resolved_by_id, resolved_by_name,
  reopened_at, reopened_by_type, reopened_by_id, reopened_by_name, mentions_json`;

/**
 * Mentions are rendering data, never authority. A malformed stored list degrades to "no
 * mentions" rather than failing the thread read (.claude/rules/50).
 */
function parseMentions(raw: string | null, rowId: string): CommentMention[] {
  if (!raw) return [];
  try {
    const parsed = v.safeParse(v.array(MentionSchema), JSON.parse(raw));
    if (parsed.success) return parsed.output;
  } catch {
    /* logged below */
  }
  log.warn('comments.mentions_invalid', { rowId });
  return [];
}

export function serializeMentions(mentions: CommentMention[] | undefined): string | null {
  return mentions && mentions.length > 0 ? JSON.stringify(mentions) : null;
}

/**
 * Idempotency fingerprint suffix: empty when there are no mentions, so a replayed request
 * created before mentions existed keeps the fingerprint it was stored with.
 */
export function mentionFingerprint(mentions: CommentMention[] | undefined): string[] {
  if (!mentions || mentions.length === 0) return [];
  // Code-unit order, the default sort's order that stored fingerprints were made with. Not
  // localeCompare, which would reorder mixed-case ids and break replays of stored mutations.
  const userIds = mentions.map((mention) => mention.userId);
  return ['mentions', ...userIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))];
}

function rowId(row: unknown): string | null {
  const record = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
  return typeof record.id === 'string' ? record.id : null;
}

function mapReply(row: unknown): CommentReplyRecord {
  const r = parseRow(ReplyRowSchema, row, 'anchored_comment_reply');
  return {
    id: r.id,
    threadId: r.thread_id,
    author: { kind: r.author_type, id: r.author_id, name: r.author_name },
    body: r.body,
    createdAt: r.created_at,
    sequence: r.sequence,
    clientMutationId: r.client_mutation_id,
    mentions: parseMentions(r.mentions_json, r.id),
  };
}

function readReplies(sql: SqlStorage, threadIds: string[]): Map<string, CommentReplyRecord[]> {
  const byThread = new Map<string, CommentReplyRecord[]>();
  for (const threadId of threadIds) byThread.set(threadId, []);
  if (threadIds.length === 0) return byThread;

  // DO SQLite rejects more than D1_MAX_BOUND_PARAMETERS binds per statement, and list limits
  // go up to 500 threads, so the id list is read in batches.
  const rows = chunk(threadIds, D1_MAX_BOUND_PARAMETERS).flatMap((batch) => {
    const placeholders = batch.map(() => '?').join(', ');
    return sql
      .exec(
        `SELECT id, thread_id, body, author_type, author_id, author_name, created_at, sequence,
                client_mutation_id, mentions_json
         FROM anchored_comment_replies
         WHERE thread_id IN (${placeholders})
         ORDER BY thread_id ASC, sequence ASC`,
        ...batch
      )
      .toArray();
  });
  for (const row of rows) {
    try {
      const reply = mapReply(row);
      byThread.get(reply.threadId)?.push(reply);
    } catch (err) {
      log.warn('comments.reply_row_skipped', { rowId: rowId(row), error: String(err) });
    }
  }
  return byThread;
}

/** Parse rows and attach their replies; malformed rows are skipped and logged. */
export function hydrateThreadRows(sql: SqlStorage, rows: unknown[]): CommentThreadRecord[] {
  const parsed: Array<v.InferOutput<typeof ThreadRowSchema>> = [];
  for (const row of rows) {
    try {
      parsed.push(parseRow(ThreadRowSchema, row, 'anchored_comment_thread'));
    } catch (err) {
      log.warn('comments.thread_row_skipped', { rowId: rowId(row), error: String(err) });
    }
  }
  const replies = readReplies(
    sql,
    parsed.map((row) => row.id)
  );
  return parsed.map((r) => ({
    id: r.id,
    anchorKind: r.anchor_kind,
    scopeKey: r.scope_key,
    sessionId: r.session_id,
    messageId: r.message_id,
    fileId: r.file_id,
    quote: r.quote,
    author: { kind: r.author_type, id: r.author_id, name: r.author_name },
    body: r.body,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sequence: r.sequence,
    version: r.version,
    clientMutationId: r.client_mutation_id,
    sentAt: r.sent_at,
    sentBy: actorFromColumns(r.sent_by_type, r.sent_by_id, r.sent_by_name),
    resolvedAt: r.resolved_at,
    resolvedBy: actorFromColumns(r.resolved_by_type, r.resolved_by_id, r.resolved_by_name),
    reopenedAt: r.reopened_at,
    reopenedBy: actorFromColumns(r.reopened_by_type, r.reopened_by_id, r.reopened_by_name),
    mentions: parseMentions(r.mentions_json, r.id),
    replies: replies.get(r.id) ?? [],
  }));
}

/** One thread, only if it belongs to `scope`. A thread id alone never reaches a row. */
export function getThreadRecord(
  sql: SqlStorage,
  scope: CommentAnchorScope,
  threadId: string
): CommentThreadRecord | null {
  const { anchorKind, scopeKey } = anchorScopeParams(scope);
  const rows = sql
    .exec(
      `SELECT ${THREAD_SELECT_COLUMNS}
       FROM anchored_comment_threads
       WHERE id = ? AND ${ANCHOR_SCOPE_PREDICATE}
       LIMIT 1`,
      threadId,
      anchorKind,
      scopeKey
    )
    .toArray();
  return hydrateThreadRows(sql, rows)[0] ?? null;
}

export interface ListThreadRecordsFilter {
  status?: string | null;
  afterSequence?: number | null;
  /** Message scopes only: threads anchored to this message. */
  messageId?: string | null;
  limit: number;
}

export function listThreadRecords(
  sql: SqlStorage,
  scope: CommentAnchorScope,
  filter: ListThreadRecordsFilter
): { threads: CommentThreadRecord[]; hasMore: boolean } {
  const { anchorKind, scopeKey } = anchorScopeParams(scope);
  const conditions = [ANCHOR_SCOPE_PREDICATE];
  const params: Array<string | number> = [anchorKind, scopeKey];
  if (filter.messageId) {
    conditions.push('message_id = ?');
    params.push(filter.messageId);
  }
  if (filter.status) {
    conditions.push('status = ?');
    params.push(filter.status);
  }
  if (filter.afterSequence !== null && filter.afterSequence !== undefined) {
    conditions.push('sequence > ?');
    params.push(filter.afterSequence);
  }
  // Named `whereClause` deliberately: every fragment in `conditions` is a literal with `?`
  // placeholders, and that identifier is what the sql-injection scanner recognises as a
  // parameterized clause builder (scripts/quality/ast-checks.ts).
  const whereClause = conditions.join(' AND ');
  const rows = sql
    .exec(
      `SELECT ${THREAD_SELECT_COLUMNS}
       FROM anchored_comment_threads
       WHERE ${whereClause}
       ORDER BY sequence ASC
       LIMIT ?`,
      ...params,
      filter.limit + 1
    )
    .toArray();
  const hasMore = rows.length > filter.limit;
  return { threads: hydrateThreadRows(sql, hasMore ? rows.slice(0, filter.limit) : rows), hasMore };
}

/**
 * Every thread of a known anchor kind in the project, newest activity first.
 *
 * No scope predicate, by design: this Durable Object *is* the project, so every row belongs
 * to it. `updated_at` is bumped by every reply and status change, so `updated_at DESC`
 * means "most recently active", the order a reader triaging an inbox needs
 * (.claude/rules/65). Returns up to `limit + 1` candidates and the true total.
 */
export function listProjectThreadCandidates(
  sql: SqlStorage,
  input: {
    status?: string | null;
    limit: number;
    /** Keyset cursor: continue after this candidate in `updated_at DESC, id ASC` order. */
    after?: ProjectCommentThreadCandidate | null;
  }
): ListProjectCommentThreadCandidatesPage {
  const kindPlaceholders = COMMENT_ANCHOR_KINDS.map(() => '?').join(', ');
  const conditions = [`t.anchor_kind IN (${kindPlaceholders})`];
  const params: Array<string | number> = [...COMMENT_ANCHOR_KINDS];
  if (input.status) {
    conditions.push('t.status = ?');
    params.push(input.status);
  }
  if (input.after) {
    // Keyset cursor. The count below only runs on the first window, before any cursor.
    conditions.push('(t.updated_at < ? OR (t.updated_at = ? AND t.id > ?))');
    params.push(input.after.updatedAt, input.after.updatedAt, input.after.id);
  }
  // Named `whereClause` deliberately — see `listThreadRecords`.
  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  const rows = sql
    .exec(
      `SELECT t.id,
              t.updated_at,
              length(CAST(COALESCE(t.body, '') AS BLOB)) +
                COALESCE(length(CAST(t.quote AS BLOB)), 0) +
                COALESCE((
                  SELECT SUM(length(CAST(COALESCE(r.body, '') AS BLOB)))
                  FROM anchored_comment_replies r
                  WHERE r.thread_id = t.id
                ), 0) AS estimated_bytes
       FROM anchored_comment_threads t
       ${whereClause}
       ORDER BY t.updated_at DESC, t.id ASC
       LIMIT ?`,
      ...params,
      input.limit + 1
    )
    .toArray();
  // The total is the same for every window, so only the first one counts it.
  const countRow = input.after
    ? null
    : sql
        .exec(`SELECT COUNT(*) AS count FROM anchored_comment_threads t ${whereClause}`, ...params)
        .toArray()[0];

  return {
    candidates: parseProjectCommentThreadCandidates(
      rows,
      CandidateRowSchema,
      'project_comment_candidate',
      log,
      'comments.project_candidate_row_skipped'
    ),
    totalCount: typeof countRow?.count === 'number' ? countRow.count : 0,
    windowFull: rows.length > input.limit,
  };
}

/** Hydrate the ids the project-wide ranking already selected, in the given order. */
export function hydrateThreadRecordsByIds(
  sql: SqlStorage,
  threadIds: string[]
): CommentThreadRecord[] {
  if (threadIds.length === 0) return [];
  // Batched under the bind-parameter ceiling, like `readReplies`.
  const rows = chunk(threadIds, D1_MAX_BOUND_PARAMETERS).flatMap((batch) => {
    const placeholders = batch.map(() => '?').join(', ');
    return sql
      .exec(
        `SELECT ${THREAD_SELECT_COLUMNS}
         FROM anchored_comment_threads
         WHERE id IN (${placeholders})`,
        ...batch
      )
      .toArray();
  });
  return restoreThreadOrder(threadIds, hydrateThreadRows(sql, rows));
}
