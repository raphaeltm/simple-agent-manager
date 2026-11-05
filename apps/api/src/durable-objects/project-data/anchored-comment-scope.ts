/**
 * The anchor scope every comment-thread query is built from.
 *
 * Message threads and library-file threads share one set of tables (DO migration 072,
 * `anchored-comments-migration.ts`). What keeps a session's threads away from another
 * session, or a file's threads away from a message lookup, is that every read and every
 * mutate carries BOTH `anchor_kind = ?` and `scope_key = ?`, and both columns are NOT NULL.
 * `scope_key` is the session id for a message thread and the file id for a library-file
 * thread; per-kind CHECK constraints tie it to the typed column (`session_id`, `file_id`).
 *
 * Callers cannot build a lookup without a scope: the store and mutation functions take a
 * `CommentAnchorScope`, never a bare thread id (.claude/rules/63). The only scope-free reads
 * are the project-wide inbox ranking and its by-id hydration, which are project-wide by
 * design because this Durable Object is the project.
 *
 * Adding an anchor kind (human_task, later): add a member to `CommentAnchorScope`, an entry
 * to `ANCHOR_KIND_RULES`, and one additive migration
 * `ALTER TABLE anchored_comment_threads ADD COLUMN human_task_id TEXT CHECK (...)` whose
 * column CHECK ties `scope_key` to the new column. No table is recreated, and no existing
 * predicate changes.
 */
import type { CommentAnchorKind } from '@simple-agent-manager/shared';

export type CommentAnchorScope =
  | { kind: 'message'; sessionId: string }
  | { kind: 'library_file'; fileId: string };

export interface AnchorScopeParams {
  anchorKind: CommentAnchorKind;
  scopeKey: string;
}

/** The `[anchor_kind, scope_key]` bind values for `ANCHOR_SCOPE_PREDICATE`. */
export function anchorScopeParams(scope: CommentAnchorScope): AnchorScopeParams {
  switch (scope.kind) {
    case 'message':
      return { anchorKind: 'message', scopeKey: scope.sessionId };
    case 'library_file':
      return { anchorKind: 'library_file', scopeKey: scope.fileId };
  }
}

/** Binds `anchor_kind` then `scope_key`. Every scoped statement includes it. */
export const ANCHOR_SCOPE_PREDICATE = 'anchor_kind = ? AND scope_key = ?';

export interface AnchorKindRules {
  /** Whether threads of this kind can be marked `sent` (Send to agent). */
  supportsSent: boolean;
  /** Fingerprint tags. Stored fingerprints were made with these, so they never change. */
  threadFingerprintTag: string;
  replyFingerprintTag: string;
  /** Wording for the per-scope thread limit error. */
  threadLimitLabel: string;
}

export const ANCHOR_KIND_RULES: Record<CommentAnchorKind, AnchorKindRules> = {
  message: {
    supportsSent: true,
    threadFingerprintTag: 'thread',
    replyFingerprintTag: 'reply',
    threadLimitLabel: 'session comment thread limit',
  },
  library_file: {
    supportsSent: false,
    threadFingerprintTag: 'file_thread',
    replyFingerprintTag: 'file_reply',
    threadLimitLabel: 'file comment thread limit',
  },
};

/**
 * Message-comment counts for one session, for the archive fence and version digest
 * (`archive-sharding.ts`): message comments cascade-delete with their transcript rows.
 */
export const MESSAGE_COMMENT_THREAD_COUNT_SQL =
  "SELECT COUNT(*) AS count FROM anchored_comment_threads WHERE anchor_kind = 'message' AND scope_key = ?";
export const MESSAGE_COMMENT_REPLY_COUNT_SQL =
  "SELECT COUNT(*) AS count FROM anchored_comment_replies WHERE anchor_kind = 'message' AND scope_key = ?";
