/**
 * Library-file-anchored comment threads.
 *
 * Storage is entirely separate from message comments (DO migration 033):
 * `library_file_comment_threads` / `_replies` / `_status_mutations`. File
 * comments are project+file scoped, not session scoped, so nothing here reads or
 * writes `chat_sessions`, and no message-comment query can reach a file thread.
 *
 * Validation, limits, and actor mapping are shared with the message
 * implementation via `comment-normalization.ts` so the two cannot drift.
 *
 * File existence is NOT verified here — `project_files` lives in D1 and the DO
 * has no D1 access. Callers must verify the file belongs to the project before
 * calling in (see `assertLibraryFileInProject` in services/library-file-comments.ts).
 */

import type { CommentReply, LibraryFileCommentThread } from '@simple-agent-manager/shared';
import { COMMENT_STATUSES } from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { createModuleLogger } from '../../lib/logger';
import {
  CommentIdempotencyConflictError,
  CommentLimitExceededError,
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
import {
  actorFromColumns,
  fingerprint,
  normalizeActor,
  normalizeBody,
  normalizeClientMutationId,
  normalizeQuote,
  resolveCommentLimits,
  resolveCommentListLimit,
} from './comment-normalization';
import { parseRow } from './row-schemas';
import type { Env } from './types';
import { generateId } from './types';

export type {
  CreateFileCommentReplyInput,
  CreateFileCommentThreadInput,
  FileCommentReplyMutationResult,
  FileCommentThreadMutationResult,
  ListFileCommentThreadsInput,
  ListFileCommentThreadsResult,
  UpdateFileCommentStatusInput,
};

const log = createModuleLogger('project_data.library_file_comments');

const FileThreadRowSchema = v.object({
  id: v.string(),
  file_id: v.string(),
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
  resolved_at: v.nullable(v.number()),
  resolved_by_type: v.nullable(v.picklist(['human', 'agent'])),
  resolved_by_id: v.nullable(v.string()),
  resolved_by_name: v.nullable(v.string()),
  reopened_at: v.nullable(v.number()),
  reopened_by_type: v.nullable(v.picklist(['human', 'agent'])),
  reopened_by_id: v.nullable(v.string()),
  reopened_by_name: v.nullable(v.string()),
});

const FileReplyRowSchema = v.object({
  id: v.string(),
  thread_id: v.string(),
  file_id: v.string(),
  body: v.string(),
  author_type: v.picklist(['human', 'agent']),
  author_id: v.string(),
  author_name: v.nullable(v.string()),
  created_at: v.number(),
  sequence: v.number(),
  client_mutation_id: v.nullable(v.string()),
});

type FileThreadRow = v.InferOutput<typeof FileThreadRowSchema>;

function normalizeFileId(fileId: string): string {
  const normalized = fileId.trim();
  if (!normalized) throw new CommentValidationError('fileId is required');
  return normalized;
}

function nextThreadSequence(sql: SqlStorage, fileId: string): number {
  const row = sql
    .exec(
      'SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM library_file_comment_threads WHERE file_id = ?',
      fileId
    )
    .toArray()[0];
  return (typeof row?.max_sequence === 'number' ? row.max_sequence : 0) + 1;
}

function nextReplySequence(sql: SqlStorage, threadId: string): number {
  const row = sql
    .exec(
      'SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM library_file_comment_replies WHERE thread_id = ?',
      threadId
    )
    .toArray()[0];
  return (typeof row?.max_sequence === 'number' ? row.max_sequence : 0) + 1;
}

function mapReply(row: unknown): CommentReply {
  const r = parseRow(FileReplyRowSchema, row, 'library_file_comment_reply');
  return {
    id: r.id,
    threadId: r.thread_id,
    author: { kind: r.author_type, id: r.author_id, name: r.author_name },
    body: r.body,
    createdAt: r.created_at,
    sequence: r.sequence,
    clientMutationId: r.client_mutation_id,
  };
}

function mapThread(r: FileThreadRow, replies: CommentReply[]): LibraryFileCommentThread {
  return {
    id: r.id,
    fileId: r.file_id,
    anchor: { kind: 'library_file', fileId: r.file_id, quote: r.quote },
    author: { kind: r.author_type, id: r.author_id, name: r.author_name },
    body: r.body,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sequence: r.sequence,
    version: r.version,
    clientMutationId: r.client_mutation_id,
    resolvedAt: r.resolved_at,
    resolvedBy: actorFromColumns(r.resolved_by_type, r.resolved_by_id, r.resolved_by_name),
    reopenedAt: r.reopened_at,
    reopenedBy: actorFromColumns(r.reopened_by_type, r.reopened_by_id, r.reopened_by_name),
    replies,
  };
}

/**
 * Per-row fault isolation: one malformed legacy row must not fail the whole
 * list read. See .claude/rules/50-list-read-row-fault-isolation.md.
 */
function readReplies(sql: SqlStorage, threadIds: string[]): Map<string, CommentReply[]> {
  const byThread = new Map<string, CommentReply[]>();
  for (const threadId of threadIds) byThread.set(threadId, []);
  if (threadIds.length === 0) return byThread;

  const placeholders = threadIds.map(() => '?').join(', ');
  const rows = sql
    .exec(
      `SELECT id, thread_id, file_id, body, author_type, author_id, author_name,
              created_at, sequence, client_mutation_id
       FROM library_file_comment_replies
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
      log.warn('library_file_comments.reply_row_skipped', {
        rowId: typeof row.id === 'string' ? row.id : null,
        threadId: typeof row.thread_id === 'string' ? row.thread_id : null,
        error: String(err),
      });
    }
  }
  return byThread;
}

function parseThreadRows(rows: unknown[]): FileThreadRow[] {
  const parsed: FileThreadRow[] = [];
  for (const row of rows) {
    try {
      parsed.push(parseRow(FileThreadRowSchema, row, 'library_file_comment_thread'));
    } catch (err) {
      const record = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
      log.warn('library_file_comments.thread_row_skipped', {
        rowId: typeof record.id === 'string' ? record.id : null,
        error: String(err),
      });
    }
  }
  return parsed;
}

function hydrateThreads(sql: SqlStorage, rows: unknown[]): LibraryFileCommentThread[] {
  const parsedRows = parseThreadRows(rows);
  const replies = readReplies(
    sql,
    parsedRows.map((row) => row.id)
  );
  return parsedRows.map((row) => mapThread(row, replies.get(row.id) ?? []));
}

/**
 * Reads a thread scoped to its file. The `file_id = ?` predicate is the
 * ownership guard: a thread id alone must never be enough to read or mutate a
 * thread belonging to a different file.
 */
export function getFileCommentThread(
  sql: SqlStorage,
  fileId: string,
  threadId: string
): LibraryFileCommentThread | null {
  const rows = sql
    .exec(
      `SELECT id, file_id, quote, body, author_type, author_id, author_name,
              status, created_at, updated_at, sequence, version, client_mutation_id,
              resolved_at, resolved_by_type, resolved_by_id, resolved_by_name,
              reopened_at, reopened_by_type, reopened_by_id, reopened_by_name
       FROM library_file_comment_threads
       WHERE id = ? AND file_id = ?
       LIMIT 1`,
      threadId,
      fileId
    )
    .toArray();
  const row = parseThreadRows(rows)[0];
  if (!row) return null;
  const replies = readReplies(sql, [threadId]);
  return mapThread(row, replies.get(threadId) ?? []);
}

export function listFileCommentThreads(
  sql: SqlStorage,
  env: Env,
  input: ListFileCommentThreadsInput
): ListFileCommentThreadsResult {
  const fileId = normalizeFileId(input.fileId);
  const limit = resolveCommentListLimit(env, input.limit);
  const conditions = ['file_id = ?'];
  const params: Array<string | number> = [fileId];

  if (input.status) {
    conditions.push('status = ?');
    params.push(input.status);
  }
  if (input.afterSequence !== null && input.afterSequence !== undefined) {
    conditions.push('sequence > ?');
    params.push(input.afterSequence);
  }

  // Named `whereClause` deliberately: every fragment in `conditions` is a literal
  // with `?` placeholders, and that identifier is what the sql-injection scanner
  // recognises as a parameterized clause builder (scripts/quality/ast-checks.ts).
  const whereClause = conditions.join(' AND ');
  const rows = sql
    .exec(
      `SELECT id, file_id, quote, body, author_type, author_id, author_name,
              status, created_at, updated_at, sequence, version, client_mutation_id,
              resolved_at, resolved_by_type, resolved_by_id, resolved_by_name,
              reopened_at, reopened_by_type, reopened_by_id, reopened_by_name
       FROM library_file_comment_threads
       WHERE ${whereClause}
       ORDER BY sequence ASC
       LIMIT ?`,
      ...params,
      limit + 1
    )
    .toArray();

  const hasMore = rows.length > limit;
  return {
    threads: hydrateThreads(sql, hasMore ? rows.slice(0, limit) : rows),
    hasMore,
  };
}

export function createFileCommentThread(
  sql: SqlStorage,
  env: Env,
  input: CreateFileCommentThreadInput
): FileCommentThreadMutationResult {
  const limits = resolveCommentLimits(env);
  const fileId = normalizeFileId(input.fileId);
  const actor = normalizeActor(input.actor);
  const body = normalizeBody(input.body, limits);
  const quote = normalizeQuote(input.quote, limits);
  const clientMutationId = normalizeClientMutationId(input.clientMutationId, limits);
  const requestFingerprint = fingerprint([
    'file_thread',
    fileId,
    body,
    quote,
    actor.kind,
    actor.id,
  ]);

  if (clientMutationId) {
    const existing = sql
      .exec(
        `SELECT id, client_mutation_fingerprint
         FROM library_file_comment_threads
         WHERE file_id = ? AND client_mutation_id = ?
         LIMIT 1`,
        fileId,
        clientMutationId
      )
      .toArray()[0];
    if (existing) {
      if (existing.client_mutation_fingerprint !== requestFingerprint) {
        throw new CommentIdempotencyConflictError();
      }
      const thread = getFileCommentThread(sql, fileId, String(existing.id));
      if (!thread) throw new CommentNotFoundError('Comment thread');
      return { thread, idempotent: true, changed: false };
    }
  }

  const countRow = sql
    .exec('SELECT COUNT(*) AS count FROM library_file_comment_threads WHERE file_id = ?', fileId)
    .toArray()[0];
  if ((typeof countRow?.count === 'number' ? countRow.count : 0) >= limits.threadsPerSessionMax) {
    throw new CommentLimitExceededError(
      `file comment thread limit of ${limits.threadsPerSessionMax} reached`
    );
  }

  const id = generateId();
  const now = Date.now();
  const sequence = nextThreadSequence(sql, fileId);
  sql.exec(
    `INSERT INTO library_file_comment_threads
       (id, file_id, anchor_kind, quote, body, author_type, author_id, author_name,
        status, created_at, updated_at, sequence, version, client_mutation_id,
        client_mutation_fingerprint)
     VALUES (?, ?, 'library_file', ?, ?, ?, ?, ?, 'open', ?, ?, ?, 1, ?, ?)`,
    id,
    fileId,
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

  const thread = getFileCommentThread(sql, fileId, id);
  if (!thread) throw new CommentNotFoundError('Comment thread');
  return { thread, idempotent: false, changed: true };
}

export function createFileCommentReply(
  sql: SqlStorage,
  env: Env,
  input: CreateFileCommentReplyInput
): FileCommentReplyMutationResult {
  const limits = resolveCommentLimits(env);
  const fileId = normalizeFileId(input.fileId);
  const actor = normalizeActor(input.actor);
  const body = normalizeBody(input.body, limits);
  const clientMutationId = normalizeClientMutationId(input.clientMutationId, limits);
  const requestFingerprint = fingerprint([
    'file_reply',
    input.threadId,
    body,
    actor.kind,
    actor.id,
  ]);

  const thread = getFileCommentThread(sql, fileId, input.threadId);
  if (!thread) throw new CommentNotFoundError('Comment thread');

  if (clientMutationId) {
    const existing = sql
      .exec(
        `SELECT id, client_mutation_fingerprint
         FROM library_file_comment_replies
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
      const authoritative = getFileCommentThread(sql, fileId, input.threadId);
      const reply = authoritative?.replies.find((candidate) => candidate.id === existing.id);
      if (!authoritative || !reply) throw new CommentNotFoundError('Comment thread');
      return { thread: authoritative, reply, idempotent: true, changed: false };
    }
  }

  const countRow = sql
    .exec(
      'SELECT COUNT(*) AS count FROM library_file_comment_replies WHERE thread_id = ?',
      input.threadId
    )
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
    `INSERT INTO library_file_comment_replies
       (id, thread_id, file_id, body, author_type, author_id, author_name,
        created_at, sequence, client_mutation_id, client_mutation_fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.threadId,
    fileId,
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
    `UPDATE library_file_comment_threads
     SET updated_at = ?, version = version + 1
     WHERE id = ? AND file_id = ?`,
    now,
    input.threadId,
    fileId
  );

  const authoritative = getFileCommentThread(sql, fileId, input.threadId);
  const reply = authoritative?.replies.find((candidate) => candidate.id === id);
  if (!authoritative || !reply) throw new CommentNotFoundError('Comment thread');
  return { thread: authoritative, reply, idempotent: false, changed: true };
}

export function updateFileCommentThreadStatus(
  sql: SqlStorage,
  env: Env,
  input: UpdateFileCommentStatusInput
): FileCommentThreadMutationResult {
  const limits = resolveCommentLimits(env);
  const fileId = normalizeFileId(input.fileId);
  const actor = normalizeActor(input.actor);
  const clientMutationId = normalizeClientMutationId(input.clientMutationId, limits);
  if (!COMMENT_STATUSES.includes(input.status)) {
    throw new CommentValidationError('status must be open, sent, or resolved');
  }

  const current = getFileCommentThread(sql, fileId, input.threadId);
  if (!current) throw new CommentNotFoundError('Comment thread');

  if (clientMutationId) {
    const existing = sql
      .exec(
        `SELECT target_status
         FROM library_file_comment_status_mutations
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
    if (input.status === 'resolved') {
      sql.exec(
        `UPDATE library_file_comment_threads
         SET status = 'resolved', resolved_at = ?, resolved_by_type = ?, resolved_by_id = ?,
             resolved_by_name = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND file_id = ?`,
        now,
        actor.kind,
        actor.id,
        actor.name,
        now,
        input.threadId,
        fileId
      );
    } else if (input.status === 'open') {
      sql.exec(
        `UPDATE library_file_comment_threads
         SET status = 'open', reopened_at = ?, reopened_by_type = ?, reopened_by_id = ?,
             reopened_by_name = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND file_id = ?`,
        now,
        actor.kind,
        actor.id,
        actor.name,
        now,
        input.threadId,
        fileId
      );
    } else {
      // 'sent' is a message-comment concept (send-to-agent). File comments have
      // no send-to-agent path in Phase 1; reject rather than silently no-op.
      throw new CommentValidationError('library file comments support open or resolved only');
    }
  }

  const authoritative = getFileCommentThread(sql, fileId, input.threadId);
  if (!authoritative) throw new CommentNotFoundError('Comment thread');

  if (clientMutationId) {
    sql.exec(
      `INSERT INTO library_file_comment_status_mutations
         (thread_id, file_id, client_mutation_id, target_status, thread_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.threadId,
      fileId,
      clientMutationId,
      input.status,
      authoritative.version,
      now
    );
  }

  return { thread: authoritative, idempotent: false, changed };
}
