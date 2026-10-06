/**
 * Shared comment contracts for message-anchored and library-file-anchored
 * commenting.
 *
 * Anchor types form a discriminated union on `kind`. Phase 1 supports
 * 'message' and 'library_file'. Block anchors, fuzzy re-anchoring,
 * reactions, and mentions are outside this slice.
 */

export const COMMENT_STATUSES = ['open', 'sent', 'resolved'] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

export const MESSAGE_COMMENT_THREAD_STATUSES = COMMENT_STATUSES;
export type MessageCommentThreadStatus = CommentStatus;

export const COMMENT_AUTHOR_KINDS = ['human', 'agent'] as const;
export type CommentAuthorKind = (typeof COMMENT_AUTHOR_KINDS)[number];

export const MESSAGE_COMMENT_AUTHOR_KINDS = COMMENT_AUTHOR_KINDS;
export type MessageCommentAuthorKind = CommentAuthorKind;

export type CommentAuthor = {
  kind: CommentAuthorKind;
  id: string;
  /**
   * Human-readable display name used by the REST/UI storage contract.
   */
  name?: string | null;
  /**
   * Human-readable display name used by the MCP agent-facing contract.
   *
   * Both names are kept during integration because the backend and MCP
   * constituents used different field names for the same concept.
   */
  displayName?: string | null;
};

export type MessageCommentAuthor = CommentAuthor;

export type MessageCommentAnchor = {
  kind: 'message';
  messageId: string;
  quote: string | null;
};

export type LibraryFileCommentAnchor = {
  kind: 'library_file';
  fileId: string;
  quote: string | null;
};

export type CommentAnchor = MessageCommentAnchor | LibraryFileCommentAnchor;

export const COMMENT_ANCHOR_KINDS = ['message', 'library_file'] as const;
export type CommentAnchorKind = (typeof COMMENT_ANCHOR_KINDS)[number];

export type MessageCommentSourceMessageContext = {
  id: string;
  role: string | null;
  quote: string | null;
  createdAt: number | null;
};

export type MessageCommentDirectiveState = {
  deliveryId: string;
  deliveryState: string;
  promptMessageId: string | null;
  acceptedAt: number | null;
  ackedAt: number | null;
};

/**
 * A reply is anchor-agnostic: the same shape serves message threads and
 * library-file threads. `sessionId` is only populated for message replies.
 */
export type CommentReply = {
  id: string;
  threadId?: string;
  sessionId?: string;
  author: CommentAuthor;
  body: string;
  createdAt: number;
  updatedAt?: number | null;
  sequence?: number;
  clientMutationId?: string | null;
  sentToAgent?: boolean;
};

export type MessageCommentReply = CommentReply;

export type MessageCommentThread = {
  id: string;
  projectId?: string;
  sessionId: string;
  taskId?: string | null;
  anchor: MessageCommentAnchor;
  author: MessageCommentAuthor;
  body: string;
  status: MessageCommentThreadStatus;
  createdAt: number;
  updatedAt: number;
  sequence?: number;
  version?: number;
  clientMutationId?: string | null;
  sentAt?: number | null;
  sentBy?: MessageCommentAuthor | null;
  resolvedAt?: number | null;
  resolvedBy?: MessageCommentAuthor | null;
  reopenedAt?: number | null;
  reopenedBy?: MessageCommentAuthor | null;
  replyCount?: number;
  lastReplyAt?: number | null;
  sourceMessage?: MessageCommentSourceMessageContext | null;
  directive?: MessageCommentDirectiveState | null;
  replies: MessageCommentReply[];
};

export type MessageCommentThreadSummary = Omit<MessageCommentThread, 'replies'> & {
  replies?: MessageCommentReply[];
};

export type MessageCommentListResponse = {
  threads: MessageCommentThread[];
  hasMore: boolean;
  nextCursor?: string | null;
};

export type MessageCommentMutationResponse = {
  thread: MessageCommentThread;
  idempotent: boolean;
};

export type MessageCommentReplyMutationResponse = {
  thread: MessageCommentThread;
  reply: MessageCommentReply;
  idempotent: boolean;
};

export type MessageCommentThreadEventReason =
  | 'thread_created'
  | 'reply_created'
  | 'marked_sent'
  | 'resolved'
  | 'reopened';

export type MessageCommentThreadEvent = {
  type: 'comment.thread.changed';
  payload: {
    sessionId: string;
    thread: MessageCommentThread;
    reason: MessageCommentThreadEventReason;
  };
};

export interface MessageCommentListRequest {
  sessionId: string;
  status?: MessageCommentThreadStatus | 'all';
  messageId?: string | null;
  cursor?: string | null;
  limit: number;
}

export interface MessageCommentActorProvenance {
  projectId: string;
  userId: string;
  taskId: string | null;
  workspaceId: string | null;
  agentSessionId: string | null;
}

export interface CreateMessageCommentThreadRequest {
  sessionId: string;
  messageId: string;
  quote?: string | null;
  body: string;
  author: MessageCommentAuthor;
  provenance: MessageCommentActorProvenance;
}

export interface ReplyToMessageCommentThreadRequest {
  sessionId: string;
  threadId: string;
  body: string;
  author: MessageCommentAuthor;
  provenance: MessageCommentActorProvenance;
}

export interface UpdateMessageCommentThreadStatusRequest {
  sessionId: string;
  threadId: string;
  status: Extract<MessageCommentThreadStatus, 'open' | 'resolved'>;
  actor: MessageCommentAuthor;
  provenance: MessageCommentActorProvenance;
}

// ---------------------------------------------------------------------------
// Library-file-anchored comments
// ---------------------------------------------------------------------------

export type LibraryFileCommentThread = {
  id: string;
  projectId?: string;
  fileId: string;
  anchor: LibraryFileCommentAnchor;
  author: CommentAuthor;
  body: string;
  status: CommentStatus;
  createdAt: number;
  updatedAt: number;
  sequence?: number;
  version?: number;
  clientMutationId?: string | null;
  resolvedAt?: number | null;
  resolvedBy?: CommentAuthor | null;
  reopenedAt?: number | null;
  reopenedBy?: CommentAuthor | null;
  replyCount?: number;
  lastReplyAt?: number | null;
  replies: CommentReply[];
};

export type LibraryFileCommentListResponse = {
  threads: LibraryFileCommentThread[];
  hasMore: boolean;
  nextCursor?: string | null;
};

export type LibraryFileCommentMutationResponse = {
  thread: LibraryFileCommentThread;
  idempotent: boolean;
};

export interface CreateLibraryFileCommentThreadRequest {
  fileId: string;
  quote?: string | null;
  body: string;
  author: CommentAuthor;
  provenance: MessageCommentActorProvenance;
}

export interface ReplyToLibraryFileCommentThreadRequest {
  fileId: string;
  threadId: string;
  body: string;
  author: CommentAuthor;
  provenance: MessageCommentActorProvenance;
}

export interface UpdateLibraryFileCommentThreadStatusRequest {
  fileId: string;
  threadId: string;
  status: Extract<CommentStatus, 'open' | 'resolved'>;
  actor: CommentAuthor;
  provenance: MessageCommentActorProvenance;
}

// ---------------------------------------------------------------------------
// Project-wide comment inbox
//
// A comment thread renders beside the one message or file it annotates, so the
// only way to *discover* an unresolved comment used to be scrolling the thing
// that contains it. `GET /api/projects/:projectId/comments` is the index that
// fixes that: every thread in a project, from chat and from the library, in one
// request.
//
// The two anchor kinds stay separate in the response rather than being merged
// into a union. They are genuinely different shapes (message threads carry
// `sessionId` + `sent*` directive state; file threads carry neither), they live
// in physically separate tables, and keeping them apart means the existing
// per-kind client mappers are reused unchanged.
// ---------------------------------------------------------------------------

/** A chat session that owns at least one thread in the response. */
export interface ProjectCommentSessionRef {
  id: string;
  topic: string | null;
}

/** A library file that owns at least one thread in the response. */
export interface ProjectCommentFileRef {
  id: string;
  filename: string;
}

export interface ProjectCommentListResponse {
  messageThreads: MessageCommentThread[];
  fileThreads: LibraryFileCommentThread[];
  /**
   * Topics for every session referenced by `messageThreads`, so the client can
   * label "where does this live" without a second round trip.
   */
  sessions: ProjectCommentSessionRef[];
  /** Filenames for every file referenced by `fileThreads`. Same reasoning. */
  files: ProjectCommentFileRef[];
  /** True when the row or byte budget kept the response from covering every thread. */
  hasMore: boolean;
  /**
   * Total threads in the project across both anchor kinds, matching the same
   * status filter. Present so a truncated list can never be read as a complete
   * one (.claude/rules/65-capped-selection-must-rank-and-disclose.md).
   */
  totalCount: number;
}
