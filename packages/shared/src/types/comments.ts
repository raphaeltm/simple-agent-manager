/**
 * Shared message-comment contracts for the message-anchored commenting MVP.
 *
 * This contract intentionally models message anchors only. File anchors,
 * markdown block anchors, fuzzy re-anchoring, reactions, and mentions are
 * outside this MVP slice.
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

export type MessageCommentReply = {
  id: string;
  threadId?: string;
  sessionId?: string;
  author: MessageCommentAuthor;
  body: string;
  createdAt: number;
  updatedAt?: number | null;
  sequence?: number;
  clientMutationId?: string | null;
  sentToAgent?: boolean;
};

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
