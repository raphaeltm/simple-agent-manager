/**
 * Library-file-anchored comment threads: the file adapter over the shared comment core.
 *
 * File threads are scoped to their file (`{ kind: 'library_file', fileId }`), not to a
 * session, so nothing here reads `chat_sessions`, and the per-kind CHECKs on the shared
 * tables keep a file row unreachable from any session-scoped lookup.
 *
 * File existence is NOT verified here — `project_files` lives in D1 and the DO has no D1
 * access. Callers must verify the file belongs to the project before calling in (see
 * `assertLibraryFileInProject` in services/library-file-comments.ts).
 */
import type { CommentReply, LibraryFileCommentThread } from '@simple-agent-manager/shared';

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
  CommentNotFoundError,
  CommentValidationError,
  type CreateFileCommentReplyInput,
  type CreateFileCommentThreadInput,
  type FileCommentReplyMutationResult,
  type FileCommentThreadMutationResult,
  type ListFileCommentThreadsInput,
  type ListFileCommentThreadsResult,
  type UpdateFileCommentStatusInput,
} from './comment-contracts';
import { resolveCommentListLimit } from './comment-normalization';
import type { Env } from './types';

export type {
  CreateFileCommentReplyInput,
  CreateFileCommentThreadInput,
  FileCommentReplyMutationResult,
  FileCommentThreadMutationResult,
  ListFileCommentThreadsInput,
  ListFileCommentThreadsResult,
  UpdateFileCommentStatusInput,
};

function fileScope(fileId: string): Extract<CommentAnchorScope, { kind: 'library_file' }> {
  const normalized = fileId.trim();
  if (!normalized) throw new CommentValidationError('fileId is required');
  return { kind: 'library_file', fileId: normalized };
}

/** File threads carry no mentions or session ids; their API shape omits both. */
export function toLibraryFileCommentThread(
  record: CommentThreadRecord
): LibraryFileCommentThread | null {
  if (record.anchorKind !== 'library_file' || !record.fileId) return null;
  const replies: CommentReply[] = record.replies.map((reply) => ({
    id: reply.id,
    threadId: reply.threadId,
    author: reply.author,
    body: reply.body,
    createdAt: reply.createdAt,
    sequence: reply.sequence,
    clientMutationId: reply.clientMutationId,
  }));
  return {
    id: record.id,
    fileId: record.fileId,
    anchor: { kind: 'library_file', fileId: record.fileId, quote: record.quote },
    author: record.author,
    body: record.body,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    sequence: record.sequence,
    version: record.version,
    clientMutationId: record.clientMutationId,
    resolvedAt: record.resolvedAt,
    resolvedBy: record.resolvedBy,
    reopenedAt: record.reopenedAt,
    reopenedBy: record.reopenedBy,
    replies,
  };
}

function requireFileThread(record: CommentThreadRecord): LibraryFileCommentThread {
  const thread = toLibraryFileCommentThread(record);
  if (!thread) throw new CommentNotFoundError('Comment thread');
  return thread;
}

/**
 * Reads a thread scoped to its file. A thread id alone is never enough to read or mutate a
 * thread belonging to a different file.
 */
export function getFileCommentThread(
  sql: SqlStorage,
  fileId: string,
  threadId: string
): LibraryFileCommentThread | null {
  const record = getThreadRecord(sql, fileScope(fileId), threadId);
  return record ? toLibraryFileCommentThread(record) : null;
}

export function listFileCommentThreads(
  sql: SqlStorage,
  env: Env,
  input: ListFileCommentThreadsInput
): ListFileCommentThreadsResult {
  const result = listThreadRecords(sql, fileScope(input.fileId), {
    status: input.status ?? null,
    afterSequence: input.afterSequence ?? null,
    limit: resolveCommentListLimit(env, input.limit),
  });
  return {
    threads: result.threads.flatMap((record) => toLibraryFileCommentThread(record) ?? []),
    hasMore: result.hasMore,
  };
}

export function createFileCommentThread(
  sql: SqlStorage,
  env: Env,
  input: CreateFileCommentThreadInput
): FileCommentThreadMutationResult {
  const scope = fileScope(input.fileId);
  const result = createThreadRecord(sql, env, {
    scope,
    fingerprintAnchor: scope.fileId,
    body: input.body,
    quote: input.quote,
    clientMutationId: input.clientMutationId,
    actor: input.actor,
  });
  return { ...result, thread: requireFileThread(result.thread) };
}

export function createFileCommentReply(
  sql: SqlStorage,
  env: Env,
  input: CreateFileCommentReplyInput
): FileCommentReplyMutationResult {
  const result = createReplyRecord(sql, env, {
    scope: fileScope(input.fileId),
    threadId: input.threadId,
    body: input.body,
    clientMutationId: input.clientMutationId,
    actor: input.actor,
  });
  const thread = requireFileThread(result.thread);
  const reply = thread.replies.find((candidate) => candidate.id === result.reply.id);
  if (!reply) throw new CommentNotFoundError('Comment thread');
  return { thread, reply, idempotent: result.idempotent, changed: result.changed };
}

export function updateFileCommentThreadStatus(
  sql: SqlStorage,
  env: Env,
  input: UpdateFileCommentStatusInput
): FileCommentThreadMutationResult {
  const result = updateThreadStatusRecord(sql, env, {
    scope: fileScope(input.fileId),
    threadId: input.threadId,
    status: input.status,
    clientMutationId: input.clientMutationId,
    actor: input.actor,
  });
  return { ...result, thread: requireFileThread(result.thread) };
}
