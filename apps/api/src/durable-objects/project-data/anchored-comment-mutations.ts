/**
 * Thread, reply and status writes for every anchor kind, implemented once.
 *
 * Every statement binds the caller's `CommentAnchorScope` (`anchor_kind` + `scope_key`),
 * including the `UPDATE`s, so a thread id from one session or file cannot be mutated
 * through another (.claude/rules/63). Anchor-specific preconditions (does the session and
 * message exist, is the file id well formed) run in the kind adapters before these are
 * called; kind-specific policy (which statuses are allowed, fingerprint tags, limit
 * wording) comes from `ANCHOR_KIND_RULES`.
 */
import type { CommentMention, CommentStatus } from '@simple-agent-manager/shared';
import { COMMENT_STATUSES } from '@simple-agent-manager/shared';

import {
  ANCHOR_KIND_RULES,
  ANCHOR_SCOPE_PREDICATE,
  anchorScopeParams,
  type CommentAnchorScope,
} from './anchored-comment-scope';
import {
  type CommentReplyRecord,
  type CommentThreadRecord,
  getThreadRecord,
  mentionFingerprint,
  serializeMentions,
} from './anchored-comment-store';
import {
  type CommentActor,
  CommentIdempotencyConflictError,
  CommentLimitExceededError,
  CommentNotFoundError,
  CommentValidationError,
} from './comment-contracts';
import {
  fingerprint,
  normalizeActor,
  normalizeBody,
  normalizeClientMutationId,
  normalizeQuote,
  resolveCommentLimits,
} from './comment-normalization';
import type { Env } from './types';
import { generateId } from './types';

export interface ThreadMutationRecord {
  thread: CommentThreadRecord;
  idempotent: boolean;
  changed: boolean;
}

export interface ReplyMutationRecord extends ThreadMutationRecord {
  reply: CommentReplyRecord;
}

function countOf(row: Record<string, unknown> | undefined): number {
  return typeof row?.count === 'number' ? row.count : 0;
}

function nextSequence(sql: SqlStorage, query: string, ...params: string[]): number {
  const row = sql.exec(query, ...params).toArray()[0];
  return (typeof row?.max_sequence === 'number' ? row.max_sequence : 0) + 1;
}

function requireThread(
  sql: SqlStorage,
  scope: CommentAnchorScope,
  threadId: string
): CommentThreadRecord {
  const thread = getThreadRecord(sql, scope, threadId);
  if (!thread) throw new CommentNotFoundError('Comment thread');
  return thread;
}

export interface CreateThreadRecordInput {
  scope: CommentAnchorScope;
  /** Message scopes only: the anchored message. */
  messageId?: string | null;
  /**
   * The anchor id the stored fingerprint was made with (the message id for message
   * threads, the file id for file threads). Kept separate so replays stay byte-identical.
   */
  fingerprintAnchor: string;
  body: string;
  quote?: string | null;
  clientMutationId?: string | null;
  actor: CommentActor;
  mentions?: CommentMention[];
}

export function createThreadRecord(
  sql: SqlStorage,
  env: Env,
  input: CreateThreadRecordInput
): ThreadMutationRecord {
  const limits = resolveCommentLimits(env);
  const rules = ANCHOR_KIND_RULES[input.scope.kind];
  const { anchorKind, scopeKey } = anchorScopeParams(input.scope);
  const actor = normalizeActor(input.actor);
  const body = normalizeBody(input.body, limits);
  const quote = normalizeQuote(input.quote, limits);
  const clientMutationId = normalizeClientMutationId(input.clientMutationId, limits);
  const requestFingerprint = fingerprint([
    rules.threadFingerprintTag,
    input.fingerprintAnchor,
    body,
    quote,
    actor.kind,
    actor.id,
    ...mentionFingerprint(input.mentions),
  ]);

  if (clientMutationId) {
    const existing = sql
      .exec(
        `SELECT id, client_mutation_fingerprint FROM anchored_comment_threads
         WHERE ${ANCHOR_SCOPE_PREDICATE} AND client_mutation_id = ? LIMIT 1`,
        anchorKind,
        scopeKey,
        clientMutationId
      )
      .toArray()[0];
    if (existing) {
      if (existing.client_mutation_fingerprint !== requestFingerprint) {
        throw new CommentIdempotencyConflictError();
      }
      return {
        thread: requireThread(sql, input.scope, String(existing.id)),
        idempotent: true,
        changed: false,
      };
    }
  }

  const threadCount = countOf(
    sql
      .exec(
        `SELECT COUNT(*) AS count FROM anchored_comment_threads WHERE ${ANCHOR_SCOPE_PREDICATE}`,
        anchorKind,
        scopeKey
      )
      .toArray()[0]
  );
  if (threadCount >= limits.threadsPerSessionMax) {
    throw new CommentLimitExceededError(
      `${rules.threadLimitLabel} of ${limits.threadsPerSessionMax} reached`
    );
  }

  const id = generateId();
  const now = Date.now();
  const sequence = nextSequence(
    sql,
    `SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM anchored_comment_threads
     WHERE ${ANCHOR_SCOPE_PREDICATE}`,
    anchorKind,
    scopeKey
  );
  const isMessage = input.scope.kind === 'message';
  sql.exec(
    `INSERT INTO anchored_comment_threads
       (id, anchor_kind, scope_key, session_id, message_id, file_id, quote, body,
        author_type, author_id, author_name, status, created_at, updated_at, sequence, version,
        client_mutation_id, client_mutation_fingerprint, mentions_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, 1, ?, ?, ?)`,
    id,
    anchorKind,
    scopeKey,
    isMessage ? scopeKey : null,
    isMessage ? (input.messageId ?? null) : null,
    input.scope.kind === 'library_file' ? scopeKey : null,
    quote,
    body,
    actor.kind,
    actor.id,
    actor.name,
    now,
    now,
    sequence,
    clientMutationId,
    clientMutationId ? requestFingerprint : null,
    serializeMentions(input.mentions)
  );
  return { thread: requireThread(sql, input.scope, id), idempotent: false, changed: true };
}

export interface CreateReplyRecordInput {
  scope: CommentAnchorScope;
  threadId: string;
  body: string;
  clientMutationId?: string | null;
  actor: CommentActor;
  mentions?: CommentMention[];
}

export function createReplyRecord(
  sql: SqlStorage,
  env: Env,
  input: CreateReplyRecordInput
): ReplyMutationRecord {
  const limits = resolveCommentLimits(env);
  const rules = ANCHOR_KIND_RULES[input.scope.kind];
  const { anchorKind, scopeKey } = anchorScopeParams(input.scope);
  const actor = normalizeActor(input.actor);
  const body = normalizeBody(input.body, limits);
  const clientMutationId = normalizeClientMutationId(input.clientMutationId, limits);
  const requestFingerprint = fingerprint([
    rules.replyFingerprintTag,
    input.threadId,
    body,
    actor.kind,
    actor.id,
    ...mentionFingerprint(input.mentions),
  ]);

  // The scoped lookup is the authorization: a thread from another scope is "not found".
  requireThread(sql, input.scope, input.threadId);

  if (clientMutationId) {
    const existing = sql
      .exec(
        `SELECT id, client_mutation_fingerprint FROM anchored_comment_replies
         WHERE thread_id = ? AND ${ANCHOR_SCOPE_PREDICATE} AND client_mutation_id = ? LIMIT 1`,
        input.threadId,
        anchorKind,
        scopeKey,
        clientMutationId
      )
      .toArray()[0];
    if (existing) {
      if (existing.client_mutation_fingerprint !== requestFingerprint) {
        throw new CommentIdempotencyConflictError();
      }
      const thread = requireThread(sql, input.scope, input.threadId);
      const reply = thread.replies.find((candidate) => candidate.id === existing.id);
      if (!reply) throw new CommentNotFoundError('Comment thread');
      return { thread, reply, idempotent: true, changed: false };
    }
  }

  const replyCount = countOf(
    sql
      .exec(
        `SELECT COUNT(*) AS count FROM anchored_comment_replies
         WHERE thread_id = ? AND ${ANCHOR_SCOPE_PREDICATE}`,
        input.threadId,
        anchorKind,
        scopeKey
      )
      .toArray()[0]
  );
  if (replyCount >= limits.repliesPerThreadMax) {
    throw new CommentLimitExceededError(
      `comment reply limit of ${limits.repliesPerThreadMax} reached`
    );
  }

  const id = generateId();
  const now = Date.now();
  const sequence = nextSequence(
    sql,
    `SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM anchored_comment_replies
     WHERE thread_id = ? AND ${ANCHOR_SCOPE_PREDICATE}`,
    input.threadId,
    anchorKind,
    scopeKey
  );
  sql.exec(
    `INSERT INTO anchored_comment_replies
       (id, thread_id, anchor_kind, scope_key, body, author_type, author_id, author_name,
        created_at, sequence, client_mutation_id, client_mutation_fingerprint, mentions_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.threadId,
    anchorKind,
    scopeKey,
    body,
    actor.kind,
    actor.id,
    actor.name,
    now,
    sequence,
    clientMutationId,
    clientMutationId ? requestFingerprint : null,
    serializeMentions(input.mentions)
  );
  sql.exec(
    `UPDATE anchored_comment_threads SET updated_at = ?, version = version + 1
     WHERE id = ? AND ${ANCHOR_SCOPE_PREDICATE}`,
    now,
    input.threadId,
    anchorKind,
    scopeKey
  );

  const thread = requireThread(sql, input.scope, input.threadId);
  const reply = thread.replies.find((candidate) => candidate.id === id);
  if (!reply) throw new CommentNotFoundError('Comment thread');
  return { thread, reply, idempotent: false, changed: true };
}

export interface UpdateThreadStatusRecordInput {
  scope: CommentAnchorScope;
  threadId: string;
  status: CommentStatus;
  clientMutationId?: string | null;
  actor: CommentActor;
}

/** The column prefix each status transition stamps with who did it and when. */
const STATUS_ACTOR_COLUMNS: Record<CommentStatus, 'sent' | 'resolved' | 'reopened'> = {
  sent: 'sent',
  resolved: 'resolved',
  open: 'reopened',
};

export function updateThreadStatusRecord(
  sql: SqlStorage,
  env: Env,
  input: UpdateThreadStatusRecordInput
): ThreadMutationRecord {
  const limits = resolveCommentLimits(env);
  const rules = ANCHOR_KIND_RULES[input.scope.kind];
  const { anchorKind, scopeKey } = anchorScopeParams(input.scope);
  const actor = normalizeActor(input.actor);
  const clientMutationId = normalizeClientMutationId(input.clientMutationId, limits);
  if (!COMMENT_STATUSES.includes(input.status)) {
    throw new CommentValidationError('status must be open, sent, or resolved');
  }

  const current = requireThread(sql, input.scope, input.threadId);

  if (clientMutationId) {
    const existing = sql
      .exec(
        `SELECT target_status FROM anchored_comment_status_mutations
         WHERE thread_id = ? AND ${ANCHOR_SCOPE_PREDICATE} AND client_mutation_id = ? LIMIT 1`,
        input.threadId,
        anchorKind,
        scopeKey,
        clientMutationId
      )
      .toArray()[0];
    if (existing) {
      if (existing.target_status !== input.status) throw new CommentIdempotencyConflictError();
      return { thread: current, idempotent: true, changed: false };
    }
  }

  const now = Date.now();
  const changed = current.status !== input.status;
  if (changed) {
    if (input.status === 'sent' && !rules.supportsSent) {
      // 'sent' is the Send-to-agent transition; anchors without it reject rather than no-op.
      throw new CommentValidationError('library file comments support open or resolved only');
    }
    const prefix = STATUS_ACTOR_COLUMNS[input.status];
    sql.exec(
      `UPDATE anchored_comment_threads
       SET status = ?, ${prefix}_at = ?, ${prefix}_by_type = ?, ${prefix}_by_id = ?,
           ${prefix}_by_name = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND ${ANCHOR_SCOPE_PREDICATE}`,
      input.status,
      now,
      actor.kind,
      actor.id,
      actor.name,
      now,
      input.threadId,
      anchorKind,
      scopeKey
    );
  }

  const thread = requireThread(sql, input.scope, input.threadId);
  if (clientMutationId) {
    sql.exec(
      `INSERT INTO anchored_comment_status_mutations
         (thread_id, anchor_kind, scope_key, client_mutation_id, target_status, thread_version,
          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.threadId,
      anchorKind,
      scopeKey,
      clientMutationId,
      input.status,
      thread.version,
      now
    );
  }
  return { thread, idempotent: false, changed };
}
