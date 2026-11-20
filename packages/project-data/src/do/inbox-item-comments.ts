/**
 * Inbox-item comment threads (inbox slice H1): the discussion on a human task, as an adapter over
 * the shared comment core (anchor kind `inbox_item`, DO migration 081).
 *
 * Threads are scoped to their `asks` id (`{ kind: 'inbox_item', itemId }`), so nothing here reads
 * `chat_sessions` or files, and the per-kind CHECKs keep an inbox-item row unreachable from any
 * session or file lookup. The ask itself lives in D1, which this object cannot read: callers must
 * have checked that the item belongs to this project and that the reader may see it
 * (`packages/operations/src/inbox-task-core.ts`).
 */
import type { CommentMention, InboxItemCommentThread } from '@simple-agent-manager/shared';

import { createReplyRecord, createThreadRecord } from './anchored-comment-mutations';
import type { CommentAnchorScope } from './anchored-comment-scope';
import { type CommentThreadRecord, listThreadRecords } from './anchored-comment-store';
import {
  type CommentActor,
  CommentNotFoundError,
  CommentValidationError,
} from './comment-contracts';
import { resolveCommentListLimit } from './comment-normalization';
import type { Env } from './types';

export interface ListInboxItemCommentThreadsInput {
  itemId: string;
  limit?: number | null;
  afterSequence?: number | null;
}

export interface CreateInboxItemCommentInput {
  itemId: string;
  /** Reply in this thread; omitted starts a new thread. */
  threadId?: string | null;
  body: string;
  clientMutationId?: string | null;
  actor: CommentActor;
  mentions?: CommentMention[];
}

export interface InboxItemCommentMutationResult {
  thread: InboxItemCommentThread;
  /** The new thread's id or the new reply's id. */
  commentId: string;
  idempotent: boolean;
}

function itemScope(itemId: string): Extract<CommentAnchorScope, { kind: 'inbox_item' }> {
  const normalized = itemId.trim();
  if (!normalized) throw new CommentValidationError('itemId is required');
  return { kind: 'inbox_item', itemId: normalized };
}

export function toInboxItemCommentThread(
  record: CommentThreadRecord
): InboxItemCommentThread | null {
  if (record.anchorKind !== 'inbox_item' || !record.inboxItemId) return null;
  return {
    id: record.id,
    itemId: record.inboxItemId,
    author: record.author,
    body: record.body,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    sequence: record.sequence,
    replies: record.replies.map((reply) => ({
      id: reply.id,
      threadId: reply.threadId,
      author: reply.author,
      body: reply.body,
      createdAt: reply.createdAt,
      sequence: reply.sequence,
      clientMutationId: reply.clientMutationId,
      mentions: reply.mentions,
    })),
  };
}

function requireItemThread(record: CommentThreadRecord): InboxItemCommentThread {
  const thread = toInboxItemCommentThread(record);
  if (!thread) throw new CommentNotFoundError('Comment thread');
  return thread;
}

/** The item's threads, oldest first, at most the comment list limit. */
export function listInboxItemCommentThreads(
  sql: SqlStorage,
  env: Env,
  input: ListInboxItemCommentThreadsInput
): { threads: InboxItemCommentThread[]; hasMore: boolean; scanCursor: number | null } {
  const result = listThreadRecords(sql, itemScope(input.itemId), {
    status: null,
    afterSequence: input.afterSequence ?? null,
    limit: resolveCommentListLimit(env, input.limit),
  });
  return {
    threads: result.threads.flatMap((record) => toInboxItemCommentThread(record) ?? []),
    hasMore: result.hasMore,
    scanCursor: result.scanCursor,
  };
}

/** Start a thread on the item, or reply in one of its threads (never another item's). */
export function createInboxItemComment(
  sql: SqlStorage,
  env: Env,
  input: CreateInboxItemCommentInput
): InboxItemCommentMutationResult {
  const scope = itemScope(input.itemId);
  if (input.threadId) {
    const result = createReplyRecord(sql, env, {
      scope,
      threadId: input.threadId,
      body: input.body,
      clientMutationId: input.clientMutationId,
      actor: input.actor,
      mentions: input.mentions,
    });
    return {
      thread: requireItemThread(result.thread),
      commentId: result.reply.id,
      idempotent: result.idempotent,
    };
  }
  const result = createThreadRecord(sql, env, {
    scope,
    fingerprintAnchor: scope.itemId,
    body: input.body,
    clientMutationId: input.clientMutationId,
    actor: input.actor,
    mentions: input.mentions,
  });
  return {
    thread: requireItemThread(result.thread),
    commentId: result.thread.id,
    idempotent: result.idempotent,
  };
}
