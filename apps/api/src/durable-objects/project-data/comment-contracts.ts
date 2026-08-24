import type {
  CommentAuthor,
  CommentReply,
  CommentStatus,
  LibraryFileCommentThread,
  MessageCommentReply,
  MessageCommentThread,
} from '@simple-agent-manager/shared';

export type CommentActor = CommentAuthor;

export type CreateCommentThreadInput = {
  sessionId: string;
  messageId: string;
  body: string;
  quote?: string | null;
  clientMutationId?: string | null;
  actor: CommentActor;
};

export type CreateCommentReplyInput = {
  sessionId: string;
  threadId: string;
  body: string;
  clientMutationId?: string | null;
  actor: CommentActor;
};

export type ListCommentThreadsInput = {
  sessionId: string;
  messageId?: string | null;
  status?: CommentStatus | null;
  afterSequence?: number | null;
  limit?: number | null;
};

export type UpdateCommentStatusInput = {
  sessionId: string;
  threadId: string;
  status: CommentStatus;
  clientMutationId?: string | null;
  actor: CommentActor;
};

export type CommentThreadMutationResult = {
  thread: MessageCommentThread;
  idempotent: boolean;
  changed: boolean;
};

export type CommentReplyMutationResult = CommentThreadMutationResult & {
  reply: MessageCommentReply;
};

export type ListCommentThreadsResult = {
  threads: MessageCommentThread[];
  hasMore: boolean;
};

// ---------------------------------------------------------------------------
// Library-file-anchored comments
//
// File comments are stored in their own tables (DO migration 033) and are
// project+file scoped rather than session scoped. Keeping the inputs separate
// from the message-comment inputs above means no message-comment code path ever
// has to treat `sessionId` as optional — which is what removed session isolation
// in the first cut of this feature.
// ---------------------------------------------------------------------------

export type CreateFileCommentThreadInput = {
  fileId: string;
  body: string;
  quote?: string | null;
  clientMutationId?: string | null;
  actor: CommentActor;
};

export type CreateFileCommentReplyInput = {
  fileId: string;
  threadId: string;
  body: string;
  clientMutationId?: string | null;
  actor: CommentActor;
};

export type ListFileCommentThreadsInput = {
  fileId: string;
  status?: CommentStatus | null;
  afterSequence?: number | null;
  limit?: number | null;
};

export type UpdateFileCommentStatusInput = {
  fileId: string;
  threadId: string;
  status: CommentStatus;
  clientMutationId?: string | null;
  actor: CommentActor;
};

export type FileCommentThreadMutationResult = {
  thread: LibraryFileCommentThread;
  idempotent: boolean;
  changed: boolean;
};

export type FileCommentReplyMutationResult = FileCommentThreadMutationResult & {
  reply: CommentReply;
};

export type ListFileCommentThreadsResult = {
  threads: LibraryFileCommentThread[];
  hasMore: boolean;
};

// ---------------------------------------------------------------------------
// Project-wide comment inbox
//
// Deliberately a separate input type rather than making `sessionId` / `fileId`
// optional on the two scoped inputs above. Those columns are authorization
// predicates, and .claude/rules/63 exists because relaxing exactly this kind of
// parameter is how an `AND session_id = ?` becomes "unnecessary" and then
// absent. The project-wide read needs no such predicate — the Durable Object is
// keyed by project, so every row it holds already belongs to this project.
// ---------------------------------------------------------------------------

export type ListProjectCommentThreadsInput = {
  status?: CommentStatus | null;
  limit?: number | null;
};

/** One cheap, `updated_at DESC`-ranked candidate row from a project-wide read. */
export type ProjectCommentThreadCandidate = {
  id: string;
  updatedAt: number;
  /** Estimated content bytes: root body + quote + reply bodies. */
  estimatedBytes: number;
};

/** One capped, `updated_at DESC`-ranked candidate page of a single anchor kind. */
export type ListProjectCommentThreadCandidatesPage = {
  candidates: ProjectCommentThreadCandidate[];
  /** Total rows matching the filter, ignoring the cap. */
  totalCount: number;
};

export type ProjectCommentSessionTopic = {
  id: string;
  topic: string | null;
};

export type ProjectCommentInboxResult = {
  messageThreads: MessageCommentThread[];
  fileThreads: LibraryFileCommentThread[];
  /** Topics for the sessions referenced by `messageThreads`, joined in-DO. */
  sessions: ProjectCommentSessionTopic[];
  hasMore: boolean;
  totalCount: number;
};

export const COMMENT_NOT_FOUND = 'COMMENT_NOT_FOUND';
export const COMMENT_VALIDATION = 'COMMENT_VALIDATION';
export const COMMENT_IDEMPOTENCY_CONFLICT = 'COMMENT_IDEMPOTENCY_CONFLICT';
export const COMMENT_LIMIT_EXCEEDED = 'COMMENT_LIMIT_EXCEEDED';

export class CommentNotFoundError extends Error {
  readonly code = COMMENT_NOT_FOUND;

  constructor(readonly resource: 'Chat session' | 'Message' | 'Comment thread' | 'Library file') {
    super(`${resource} not found`);
    this.name = 'CommentNotFoundError';
  }
}

export class CommentValidationError extends Error {
  readonly code = COMMENT_VALIDATION;

  constructor(message: string) {
    super(message);
    this.name = 'CommentValidationError';
  }
}

export class CommentIdempotencyConflictError extends Error {
  readonly code = COMMENT_IDEMPOTENCY_CONFLICT;

  constructor() {
    super('clientMutationId already belongs to a different comment mutation');
    this.name = 'CommentIdempotencyConflictError';
  }
}

export class CommentLimitExceededError extends Error {
  readonly code = COMMENT_LIMIT_EXCEEDED;

  constructor(message: string) {
    super(message);
    this.name = 'CommentLimitExceededError';
  }
}
