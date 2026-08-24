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

export const COMMENT_NOT_FOUND = 'COMMENT_NOT_FOUND';
export const COMMENT_VALIDATION = 'COMMENT_VALIDATION';
export const COMMENT_IDEMPOTENCY_CONFLICT = 'COMMENT_IDEMPOTENCY_CONFLICT';
export const COMMENT_LIMIT_EXCEEDED = 'COMMENT_LIMIT_EXCEEDED';

export class CommentNotFoundError extends Error {
  readonly code = COMMENT_NOT_FOUND;

  constructor(
    readonly resource: 'Chat session' | 'Message' | 'Comment thread' | 'Library file'
  ) {
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
