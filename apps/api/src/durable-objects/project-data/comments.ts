/**
 * Message-anchored comment threads: the message adapter over the shared comment core.
 *
 * Storage, idempotency, versions and limits live in `anchored-comment-store.ts` and
 * `anchored-comment-mutations.ts`. This module adds what is specific to a message anchor:
 * the session and message must exist in this Durable Object, the scope is the session
 * (`{ kind: 'message', sessionId }`), and rows map to `MessageCommentThread`.
 */
import type { MessageCommentReply, MessageCommentThread } from '@simple-agent-manager/shared';

import { chunk, D1_MAX_BOUND_PARAMETERS } from '../../lib/d1-limits';
import {
  createReplyRecord,
  createThreadRecord,
  updateThreadStatusRecord,
} from './anchored-comment-mutations';
import type { CommentAnchorScope } from './anchored-comment-scope';
import {
  type CommentThreadRecord,
  getThreadRecord,
  listThreadRecords,
} from './anchored-comment-store';
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
  type ProjectCommentSessionTopic,
  type UpdateCommentStatusInput,
} from './comment-contracts';
import { resolveCommentLimits, resolveCommentListLimit } from './comment-normalization';
import type { Env } from './types';

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
export { resolveCommentLimits, resolveCommentListLimit };
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

function sessionScope(sessionId: string): CommentAnchorScope {
  return { kind: 'message', sessionId };
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
  if (row) return;

  const archiveRow = sql
    .exec(
      `SELECT state
       FROM project_data_archive_source_intents
       WHERE session_id = ? AND state = 'source_deleted'
       LIMIT 1`,
      sessionId
    )
    .toArray()[0];
  if (archiveRow) {
    throw new CommentValidationError(
      'Cannot create message comments on a session whose transcript has been moved to a ProjectData archive shard'
    );
  }
  throw new CommentNotFoundError('Message');
}

/**
 * The per-kind CHECKs guarantee a message row has its session and message ids. A row that
 * somehow lacks them cannot be shown as a message thread, so it is dropped (rule 50).
 */
export function toMessageCommentThread(record: CommentThreadRecord): MessageCommentThread | null {
  if (record.anchorKind !== 'message' || !record.sessionId || !record.messageId) return null;
  const sessionId = record.sessionId;
  const replies: MessageCommentReply[] = record.replies.map((reply) => ({
    id: reply.id,
    threadId: reply.threadId,
    sessionId,
    author: reply.author,
    body: reply.body,
    createdAt: reply.createdAt,
    sequence: reply.sequence,
    clientMutationId: reply.clientMutationId,
    mentions: reply.mentions,
  }));
  return {
    id: record.id,
    sessionId,
    anchor: { kind: 'message', messageId: record.messageId, quote: record.quote },
    author: record.author,
    body: record.body,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    sequence: record.sequence,
    version: record.version,
    clientMutationId: record.clientMutationId,
    sentAt: record.sentAt,
    sentBy: record.sentBy,
    resolvedAt: record.resolvedAt,
    resolvedBy: record.resolvedBy,
    reopenedAt: record.reopenedAt,
    reopenedBy: record.reopenedBy,
    mentions: record.mentions,
    replies,
  };
}

function requireMessageThread(record: CommentThreadRecord): MessageCommentThread {
  const thread = toMessageCommentThread(record);
  if (!thread) throw new CommentNotFoundError('Comment thread');
  return thread;
}

export function getCommentThread(
  sql: SqlStorage,
  sessionId: string,
  threadId: string
): MessageCommentThread | null {
  const record = getThreadRecord(sql, sessionScope(sessionId), threadId);
  return record ? toMessageCommentThread(record) : null;
}

export function listCommentThreads(
  sql: SqlStorage,
  env: Env,
  input: ListCommentThreadsInput
): ListCommentThreadsResult {
  ensureSession(sql, input.sessionId);
  if (input.messageId) ensureMessageAnchor(sql, input.sessionId, input.messageId);
  const result = listThreadRecords(sql, sessionScope(input.sessionId), {
    messageId: input.messageId ?? null,
    status: input.status ?? null,
    afterSequence: input.afterSequence ?? null,
    limit: resolveCommentListLimit(env, input.limit),
  });
  return {
    threads: result.threads.flatMap((record) => toMessageCommentThread(record) ?? []),
    hasMore: result.hasMore,
  };
}

/**
 * Topics for the given session ids, for labelling "where does this thread live".
 *
 * Free to do here — `chat_sessions` is in this same Durable Object — which is
 * why the response can carry it without a second round trip.
 */
export function readSessionTopics(
  sql: SqlStorage,
  sessionIds: string[]
): ProjectCommentSessionTopic[] {
  // Batched under the bind-parameter ceiling: an inbox page can name up to 300 sessions.
  const rows = chunk(sessionIds, D1_MAX_BOUND_PARAMETERS).flatMap((batch) => {
    const placeholders = batch.map(() => '?').join(', ');
    return sql
      .exec(`SELECT id, topic FROM chat_sessions WHERE id IN (${placeholders})`, ...batch)
      .toArray();
  });

  const topics: ProjectCommentSessionTopic[] = [];
  for (const row of rows) {
    if (typeof row.id !== 'string') continue;
    topics.push({ id: row.id, topic: typeof row.topic === 'string' ? row.topic : null });
  }
  return topics;
}

export function createCommentThread(
  sql: SqlStorage,
  env: Env,
  input: CreateCommentThreadInput
): CommentThreadMutationResult {
  ensureSession(sql, input.sessionId);
  ensureMessageAnchor(sql, input.sessionId, input.messageId);
  const result = createThreadRecord(sql, env, {
    scope: sessionScope(input.sessionId),
    messageId: input.messageId,
    fingerprintAnchor: input.messageId,
    body: input.body,
    quote: input.quote,
    clientMutationId: input.clientMutationId,
    actor: input.actor,
    mentions: input.mentions,
  });
  return { ...result, thread: requireMessageThread(result.thread) };
}

export function createCommentReply(
  sql: SqlStorage,
  env: Env,
  input: CreateCommentReplyInput
): CommentReplyMutationResult {
  const result = createReplyRecord(sql, env, {
    scope: sessionScope(input.sessionId),
    threadId: input.threadId,
    body: input.body,
    clientMutationId: input.clientMutationId,
    actor: input.actor,
    mentions: input.mentions,
  });
  const thread = requireMessageThread(result.thread);
  const reply = thread.replies.find((candidate) => candidate.id === result.reply.id);
  if (!reply) throw new CommentNotFoundError('Comment thread');
  return { thread, reply, idempotent: result.idempotent, changed: result.changed };
}

export function updateCommentThreadStatus(
  sql: SqlStorage,
  env: Env,
  input: UpdateCommentStatusInput
): CommentThreadMutationResult {
  const result = updateThreadStatusRecord(sql, env, {
    scope: sessionScope(input.sessionId),
    threadId: input.threadId,
    status: input.status,
    clientMutationId: input.clientMutationId,
    actor: input.actor,
  });
  return { ...result, thread: requireMessageThread(result.thread) };
}
