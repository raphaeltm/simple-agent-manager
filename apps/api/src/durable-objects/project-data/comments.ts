import type { MessageCommentReply, MessageCommentThread } from '@simple-agent-manager/shared';
import {
  COMMENT_STATUSES,
  DEFAULT_COMMENT_BODY_MAX_LENGTH,
  DEFAULT_COMMENT_IDEMPOTENCY_KEY_MAX_LENGTH,
  DEFAULT_COMMENT_LIST_LIMIT_DEFAULT,
  DEFAULT_COMMENT_LIST_LIMIT_MAX,
  DEFAULT_COMMENT_QUOTE_MAX_LENGTH,
  DEFAULT_COMMENT_REPLIES_PER_THREAD_MAX,
  DEFAULT_COMMENT_THREADS_PER_SESSION_MAX,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { createModuleLogger } from '../../lib/logger';
import {
  COMMENT_IDEMPOTENCY_CONFLICT,
  COMMENT_LIMIT_EXCEEDED,
  COMMENT_NOT_FOUND,
  COMMENT_VALIDATION,
  type CommentActor,
  CommentIdempotencyConflictError,
  CommentLimitExceededError,
  CommentNotFoundError,
  type CommentReplyMutationResult,
  type CommentThreadMutationResult,
  CommentValidationError,
  type CreateCommentReplyInput,
  type CreateCommentThreadInput,
  type ListCommentThreadsInput,
  type ListCommentThreadsResult,
  type UpdateCommentStatusInput,
} from './comment-contracts';
import { parseRow } from './row-schemas';
import type { Env } from './types';
import { generateId } from './types';

const log = createModuleLogger('project_data.comments');

export {
  COMMENT_IDEMPOTENCY_CONFLICT,
  COMMENT_LIMIT_EXCEEDED,
  COMMENT_NOT_FOUND,
  COMMENT_VALIDATION,
  CommentIdempotencyConflictError,
  CommentLimitExceededError,
  CommentNotFoundError,
  CommentValidationError,
};
export type {
  CommentActor,
  CommentReplyMutationResult,
  CommentThreadMutationResult,
  CreateCommentReplyInput,
  CreateCommentThreadInput,
  ListCommentThreadsInput,
  ListCommentThreadsResult,
  UpdateCommentStatusInput,
};

type CommentLimits = {
  bodyMaxLength: number;
  quoteMaxLength: number;
  idempotencyKeyMaxLength: number;
  listDefaultLimit: number;
  listMaxLimit: number;
  threadsPerSessionMax: number;
  repliesPerThreadMax: number;
};

const ThreadRowSchema = v.object({
  id: v.string(),
  session_id: v.string(),
  message_id: v.string(),
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
  sent_by_type: v.nullable(v.picklist(['human', 'agent'])),
  sent_by_id: v.nullable(v.string()),
  sent_by_name: v.nullable(v.string()),
  resolved_at: v.nullable(v.number()),
  resolved_by_type: v.nullable(v.picklist(['human', 'agent'])),
  resolved_by_id: v.nullable(v.string()),
  resolved_by_name: v.nullable(v.string()),
  reopened_at: v.nullable(v.number()),
  reopened_by_type: v.nullable(v.picklist(['human', 'agent'])),
  reopened_by_id: v.nullable(v.string()),
  reopened_by_name: v.nullable(v.string()),
});

const ReplyRowSchema = v.object({
  id: v.string(),
  thread_id: v.string(),
  session_id: v.string(),
  body: v.string(),
  author_type: v.picklist(['human', 'agent']),
  author_id: v.string(),
  author_name: v.nullable(v.string()),
  created_at: v.number(),
  sequence: v.number(),
  client_mutation_id: v.nullable(v.string()),
});

type ThreadRow = v.InferOutput<typeof ThreadRowSchema>;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveCommentLimits(env: Env): CommentLimits {
  const listDefaultLimit = positiveInteger(
    env.COMMENT_LIST_LIMIT_DEFAULT,
    DEFAULT_COMMENT_LIST_LIMIT_DEFAULT
  );
  const listMaxLimit = positiveInteger(env.COMMENT_LIST_LIMIT_MAX, DEFAULT_COMMENT_LIST_LIMIT_MAX);
  return {
    bodyMaxLength: positiveInteger(env.COMMENT_BODY_MAX_LENGTH, DEFAULT_COMMENT_BODY_MAX_LENGTH),
    quoteMaxLength: positiveInteger(env.COMMENT_QUOTE_MAX_LENGTH, DEFAULT_COMMENT_QUOTE_MAX_LENGTH),
    idempotencyKeyMaxLength: positiveInteger(
      env.COMMENT_IDEMPOTENCY_KEY_MAX_LENGTH,
      DEFAULT_COMMENT_IDEMPOTENCY_KEY_MAX_LENGTH
    ),
    listDefaultLimit,
    listMaxLimit: Math.max(listDefaultLimit, listMaxLimit),
    threadsPerSessionMax: positiveInteger(
      env.COMMENT_THREADS_PER_SESSION_MAX,
      DEFAULT_COMMENT_THREADS_PER_SESSION_MAX
    ),
    repliesPerThreadMax: positiveInteger(
      env.COMMENT_REPLIES_PER_THREAD_MAX,
      DEFAULT_COMMENT_REPLIES_PER_THREAD_MAX
    ),
  };
}

export function resolveCommentListLimit(env: Env, requested?: number | null): number {
  const limits = resolveCommentLimits(env);
  const limit =
    typeof requested === 'number' && Number.isFinite(requested) && requested > 0
      ? Math.floor(requested)
      : limits.listDefaultLimit;
  return Math.min(limit, limits.listMaxLimit);
}

function normalizeBody(body: string, limits: CommentLimits): string {
  const normalized = body.trim();
  if (!normalized) throw new CommentValidationError('body is required');
  if (normalized.length > limits.bodyMaxLength) {
    throw new CommentValidationError(`body must be ${limits.bodyMaxLength} characters or fewer`);
  }
  return normalized;
}

function normalizeQuote(quote: string | null | undefined, limits: CommentLimits): string | null {
  if (quote === null || quote === undefined) return null;
  const normalized = quote.trim();
  if (!normalized) return null;
  if (normalized.length > limits.quoteMaxLength) {
    throw new CommentValidationError(`quote must be ${limits.quoteMaxLength} characters or fewer`);
  }
  return normalized;
}

function normalizeClientMutationId(
  clientMutationId: string | null | undefined,
  limits: CommentLimits
): string | null {
  if (clientMutationId === null || clientMutationId === undefined) return null;
  const normalized = clientMutationId.trim();
  if (!normalized) return null;
  if (normalized.length > limits.idempotencyKeyMaxLength) {
    throw new CommentValidationError(
      `clientMutationId must be ${limits.idempotencyKeyMaxLength} characters or fewer`
    );
  }
  return normalized;
}

function normalizeActor(actor: CommentActor): CommentActor {
  if (actor.kind !== 'human' && actor.kind !== 'agent') {
    throw new CommentValidationError('actor kind must be human or agent');
  }
  const id = actor.id.trim();
  if (!id) throw new CommentValidationError('actor id is required');
  const name = actor.name?.trim() || null;
  return { kind: actor.kind, id, name };
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value);
}

function ensureSession(sql: SqlStorage, sessionId: string): void {
  const row = sql.exec('SELECT id FROM chat_sessions WHERE id = ? LIMIT 1', sessionId).toArray()[0];
  if (!row) throw new CommentNotFoundError('Chat session');
}

function ensureMessageAnchor(sql: SqlStorage, sessionId: string, messageId: string): void {
  const row = sql
    .exec(
      'SELECT id FROM chat_messages WHERE id = ? AND session_id = ? LIMIT 1',
      messageId,
      sessionId
    )
    .toArray()[0];
  if (!row) throw new CommentNotFoundError('Message');
}

function nextThreadSequence(sql: SqlStorage, sessionId: string): number {
  const row = sql
    .exec(
      'SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM comment_threads WHERE session_id = ?',
      sessionId
    )
    .toArray()[0];
  return (typeof row?.max_sequence === 'number' ? row.max_sequence : 0) + 1;
}

function nextReplySequence(sql: SqlStorage, threadId: string): number {
  const row = sql
    .exec(
      'SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM comment_replies WHERE thread_id = ?',
      threadId
    )
    .toArray()[0];
  return (typeof row?.max_sequence === 'number' ? row.max_sequence : 0) + 1;
}

function actorFromColumns(
  kind: 'human' | 'agent' | null,
  id: string | null,
  name: string | null
): CommentActor | null {
  if (!kind || !id) return null;
  return { kind, id, name };
}

function mapReply(row: unknown): MessageCommentReply {
  const r = parseRow(ReplyRowSchema, row, 'comment_reply');
  return {
    id: r.id,
    threadId: r.thread_id,
    sessionId: r.session_id,
    author: { kind: r.author_type, id: r.author_id, name: r.author_name },
    body: r.body,
    createdAt: r.created_at,
    sequence: r.sequence,
    clientMutationId: r.client_mutation_id,
  };
}

function mapThread(row: unknown, replies: MessageCommentReply[]): MessageCommentThread {
  const r = parseRow(ThreadRowSchema, row, 'comment_thread');
  return {
    id: r.id,
    sessionId: r.session_id,
    anchor: {
      kind: 'message',
      messageId: r.message_id,
      quote: r.quote,
    },
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
    replies,
  };
}

function readReplies(sql: SqlStorage, threadIds: string[]): Map<string, MessageCommentReply[]> {
  const byThread = new Map<string, MessageCommentReply[]>();
  for (const threadId of threadIds) byThread.set(threadId, []);
  if (threadIds.length === 0) return byThread;

  const placeholders = threadIds.map(() => '?').join(', ');
  const rows = sql
    .exec(
      `SELECT id, thread_id, session_id, body, author_type, author_id, author_name,
              created_at, sequence, client_mutation_id
       FROM comment_replies
       WHERE thread_id IN (${placeholders})
       ORDER BY thread_id ASC, sequence ASC`,
      ...threadIds
    )
    .toArray();

  for (const row of rows) {
    try {
      const reply = mapReply(row);
      if (reply.threadId) byThread.get(reply.threadId)?.push(reply);
    } catch (err) {
      log.warn('comments.reply_row_skipped', {
        rowId: typeof row.id === 'string' ? row.id : null,
        threadId: typeof row.thread_id === 'string' ? row.thread_id : null,
        error: String(err),
      });
    }
  }
  return byThread;
}

function readThreadRows(sql: SqlStorage, sessionId: string, threadIds: string[]): ThreadRow[] {
  if (threadIds.length === 0) return [];
  const placeholders = threadIds.map(() => '?').join(', ');
  const rows = sql
    .exec(
      `SELECT id, session_id, message_id, quote, body, author_type, author_id, author_name,
              status, created_at, updated_at, sequence, version, client_mutation_id,
              sent_at, sent_by_type, sent_by_id, sent_by_name,
              resolved_at, resolved_by_type, resolved_by_id, resolved_by_name,
              reopened_at, reopened_by_type, reopened_by_id, reopened_by_name
       FROM comment_threads
       WHERE session_id = ? AND id IN (${placeholders})`,
      sessionId,
      ...threadIds
    )
    .toArray();

  const parsed: ThreadRow[] = [];
  for (const row of rows) {
    try {
      parsed.push(parseRow(ThreadRowSchema, row, 'comment_thread'));
    } catch (err) {
      log.warn('comments.thread_row_skipped', {
        rowId: typeof row.id === 'string' ? row.id : null,
        sessionId,
        error: String(err),
      });
    }
  }
  return parsed;
}

function hydrateThreads(
  sql: SqlStorage,
  sessionId: string,
  rows: unknown[]
): MessageCommentThread[] {
  const parsedRows: ThreadRow[] = [];
  for (const row of rows) {
    try {
      parsedRows.push(parseRow(ThreadRowSchema, row, 'comment_thread'));
    } catch (err) {
      const record = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
      log.warn('comments.thread_row_skipped', {
        rowId: typeof record.id === 'string' ? record.id : null,
        sessionId,
        error: String(err),
      });
    }
  }

  const replies = readReplies(
    sql,
    parsedRows.map((row) => row.id)
  );
  return parsedRows.map((row) => mapThread(row, replies.get(row.id) ?? []));
}

export function getCommentThread(
  sql: SqlStorage,
  sessionId: string,
  threadId: string
): MessageCommentThread | null {
  const rows = readThreadRows(sql, sessionId, [threadId]);
  if (rows.length === 0) return null;
  const replies = readReplies(sql, [threadId]);
  return mapThread(rows[0], replies.get(threadId) ?? []);
}

export function listCommentThreads(
  sql: SqlStorage,
  env: Env,
  input: ListCommentThreadsInput
): ListCommentThreadsResult {
  ensureSession(sql, input.sessionId);
  const limit = resolveCommentListLimit(env, input.limit);
  const conditions = ['session_id = ?'];
  const params: Array<string | number> = [input.sessionId];

  if (input.messageId) {
    ensureMessageAnchor(sql, input.sessionId, input.messageId);
    conditions.push('message_id = ?');
    params.push(input.messageId);
  }
  if (input.status) {
    conditions.push('status = ?');
    params.push(input.status);
  }
  if (input.afterSequence !== null && input.afterSequence !== undefined) {
    conditions.push('sequence > ?');
    params.push(input.afterSequence);
  }

  const whereClause = conditions.join(' AND ');
  const rows = sql
    .exec(
      `SELECT id, session_id, message_id, quote, body, author_type, author_id, author_name,
              status, created_at, updated_at, sequence, version, client_mutation_id,
              sent_at, sent_by_type, sent_by_id, sent_by_name,
              resolved_at, resolved_by_type, resolved_by_id, resolved_by_name,
              reopened_at, reopened_by_type, reopened_by_id, reopened_by_name
       FROM comment_threads
       WHERE ${whereClause}
       ORDER BY sequence ASC
       LIMIT ?`,
      ...params,
      limit + 1
    )
    .toArray();

  const hasMore = rows.length > limit;
  return {
    threads: hydrateThreads(sql, input.sessionId, hasMore ? rows.slice(0, limit) : rows),
    hasMore,
  };
}

export function createCommentThread(
  sql: SqlStorage,
  env: Env,
  input: CreateCommentThreadInput
): CommentThreadMutationResult {
  const limits = resolveCommentLimits(env);
  const actor = normalizeActor(input.actor);
  const body = normalizeBody(input.body, limits);
  const quote = normalizeQuote(input.quote, limits);
  const clientMutationId = normalizeClientMutationId(input.clientMutationId, limits);
  const requestFingerprint = fingerprint([
    'thread',
    input.messageId,
    body,
    quote,
    actor.kind,
    actor.id,
  ]);

  ensureSession(sql, input.sessionId);
  ensureMessageAnchor(sql, input.sessionId, input.messageId);

  if (clientMutationId) {
    const existing = sql
      .exec(
        `SELECT id, client_mutation_fingerprint
         FROM comment_threads
         WHERE session_id = ? AND client_mutation_id = ?
         LIMIT 1`,
        input.sessionId,
        clientMutationId
      )
      .toArray()[0];
    if (existing) {
      if (existing.client_mutation_fingerprint !== requestFingerprint) {
        throw new CommentIdempotencyConflictError();
      }
      const thread = getCommentThread(sql, input.sessionId, String(existing.id));
      if (!thread) throw new CommentNotFoundError('Comment thread');
      return { thread, idempotent: true, changed: false };
    }
  }

  const countRow = sql
    .exec('SELECT COUNT(*) AS count FROM comment_threads WHERE session_id = ?', input.sessionId)
    .toArray()[0];
  if ((typeof countRow?.count === 'number' ? countRow.count : 0) >= limits.threadsPerSessionMax) {
    throw new CommentLimitExceededError(
      `session comment thread limit of ${limits.threadsPerSessionMax} reached`
    );
  }

  const id = generateId();
  const now = Date.now();
  const sequence = nextThreadSequence(sql, input.sessionId);
  sql.exec(
    `INSERT INTO comment_threads
       (id, session_id, anchor_kind, message_id, quote, body, author_type, author_id, author_name,
        status, created_at, updated_at, sequence, version, client_mutation_id,
        client_mutation_fingerprint)
     VALUES (?, ?, 'message', ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, 1, ?, ?)`,
    id,
    input.sessionId,
    input.messageId,
    quote,
    body,
    actor.kind,
    actor.id,
    actor.name,
    now,
    now,
    sequence,
    clientMutationId,
    clientMutationId ? requestFingerprint : null
  );

  const thread = getCommentThread(sql, input.sessionId, id);
  if (!thread) throw new CommentNotFoundError('Comment thread');
  return { thread, idempotent: false, changed: true };
}

export function createCommentReply(
  sql: SqlStorage,
  env: Env,
  input: CreateCommentReplyInput
): CommentReplyMutationResult {
  const limits = resolveCommentLimits(env);
  const actor = normalizeActor(input.actor);
  const body = normalizeBody(input.body, limits);
  const clientMutationId = normalizeClientMutationId(input.clientMutationId, limits);
  const requestFingerprint = fingerprint(['reply', input.threadId, body, actor.kind, actor.id]);

  const thread = getCommentThread(sql, input.sessionId, input.threadId);
  if (!thread) throw new CommentNotFoundError('Comment thread');

  if (clientMutationId) {
    const existing = sql
      .exec(
        `SELECT id, client_mutation_fingerprint
         FROM comment_replies
         WHERE thread_id = ? AND client_mutation_id = ?
         LIMIT 1`,
        input.threadId,
        clientMutationId
      )
      .toArray()[0];
    if (existing) {
      if (existing.client_mutation_fingerprint !== requestFingerprint) {
        throw new CommentIdempotencyConflictError();
      }
      const authoritative = getCommentThread(sql, input.sessionId, input.threadId);
      const reply = authoritative?.replies.find((candidate) => candidate.id === existing.id);
      if (!authoritative || !reply) throw new CommentNotFoundError('Comment thread');
      return { thread: authoritative, reply, idempotent: true, changed: false };
    }
  }

  const countRow = sql
    .exec('SELECT COUNT(*) AS count FROM comment_replies WHERE thread_id = ?', input.threadId)
    .toArray()[0];
  if ((typeof countRow?.count === 'number' ? countRow.count : 0) >= limits.repliesPerThreadMax) {
    throw new CommentLimitExceededError(
      `comment reply limit of ${limits.repliesPerThreadMax} reached`
    );
  }

  const id = generateId();
  const now = Date.now();
  const sequence = nextReplySequence(sql, input.threadId);
  sql.exec(
    `INSERT INTO comment_replies
       (id, thread_id, session_id, body, author_type, author_id, author_name,
        created_at, sequence, client_mutation_id, client_mutation_fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.threadId,
    input.sessionId,
    body,
    actor.kind,
    actor.id,
    actor.name,
    now,
    sequence,
    clientMutationId,
    clientMutationId ? requestFingerprint : null
  );
  sql.exec(
    `UPDATE comment_threads
     SET updated_at = ?, version = version + 1
     WHERE id = ? AND session_id = ?`,
    now,
    input.threadId,
    input.sessionId
  );

  const authoritative = getCommentThread(sql, input.sessionId, input.threadId);
  const reply = authoritative?.replies.find((candidate) => candidate.id === id);
  if (!authoritative || !reply) throw new CommentNotFoundError('Comment thread');
  return { thread: authoritative, reply, idempotent: false, changed: true };
}

export function updateCommentThreadStatus(
  sql: SqlStorage,
  env: Env,
  input: UpdateCommentStatusInput
): CommentThreadMutationResult {
  const limits = resolveCommentLimits(env);
  const actor = normalizeActor(input.actor);
  const clientMutationId = normalizeClientMutationId(input.clientMutationId, limits);
  if (!COMMENT_STATUSES.includes(input.status)) {
    throw new CommentValidationError('status must be open, sent, or resolved');
  }

  const current = getCommentThread(sql, input.sessionId, input.threadId);
  if (!current) throw new CommentNotFoundError('Comment thread');

  if (clientMutationId) {
    const existing = sql
      .exec(
        `SELECT target_status
         FROM comment_status_mutations
         WHERE thread_id = ? AND client_mutation_id = ?
         LIMIT 1`,
        input.threadId,
        clientMutationId
      )
      .toArray()[0];
    if (existing) {
      if (existing.target_status !== input.status) throw new CommentIdempotencyConflictError();
      return { thread: current, idempotent: true, changed: false };
    }
  }

  const now = Date.now();
  let changed = false;
  if (current.status !== input.status) {
    changed = true;
    if (input.status === 'sent') {
      sql.exec(
        `UPDATE comment_threads
         SET status = 'sent', sent_at = ?, sent_by_type = ?, sent_by_id = ?, sent_by_name = ?,
             updated_at = ?, version = version + 1
         WHERE id = ? AND session_id = ?`,
        now,
        actor.kind,
        actor.id,
        actor.name,
        now,
        input.threadId,
        input.sessionId
      );
    } else if (input.status === 'resolved') {
      sql.exec(
        `UPDATE comment_threads
         SET status = 'resolved', resolved_at = ?, resolved_by_type = ?, resolved_by_id = ?,
             resolved_by_name = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND session_id = ?`,
        now,
        actor.kind,
        actor.id,
        actor.name,
        now,
        input.threadId,
        input.sessionId
      );
    } else {
      sql.exec(
        `UPDATE comment_threads
         SET status = 'open', reopened_at = ?, reopened_by_type = ?, reopened_by_id = ?,
             reopened_by_name = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND session_id = ?`,
        now,
        actor.kind,
        actor.id,
        actor.name,
        now,
        input.threadId,
        input.sessionId
      );
    }
  }

  const authoritative = getCommentThread(sql, input.sessionId, input.threadId);
  if (!authoritative) throw new CommentNotFoundError('Comment thread');

  if (clientMutationId) {
    sql.exec(
      `INSERT INTO comment_status_mutations
         (thread_id, session_id, client_mutation_id, target_status, thread_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.threadId,
      input.sessionId,
      clientMutationId,
      input.status,
      authoritative.version,
      now
    );
  }

  return { thread: authoritative, idempotent: false, changed };
}
