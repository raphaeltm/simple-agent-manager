/**
 * Shared message-comment contracts for the message-anchored commenting MVP.
 *
 * This file intentionally models message anchors only. File anchors, re-anchoring,
 * reactions, and mentions are outside the MVP.
 */

export const MESSAGE_COMMENT_THREAD_STATUSES = ['open', 'sent', 'resolved'] as const;
export type MessageCommentThreadStatus = (typeof MESSAGE_COMMENT_THREAD_STATUSES)[number];

export const MESSAGE_COMMENT_AUTHOR_KINDS = ['human', 'agent'] as const;
export type MessageCommentAuthorKind = (typeof MESSAGE_COMMENT_AUTHOR_KINDS)[number];

export interface MessageCommentAuthor {
  id: string;
  kind: MessageCommentAuthorKind;
  displayName: string | null;
}

export interface MessageCommentAnchor {
  kind: 'message';
  messageId: string;
  quote: string | null;
}

export interface MessageCommentSourceMessageContext {
  id: string;
  role: string | null;
  quote: string | null;
  createdAt: number | null;
}

export interface MessageCommentReply {
  id: string;
  body: string;
  author: MessageCommentAuthor;
  createdAt: number;
}

export interface MessageCommentDirectiveState {
  deliveryId: string;
  deliveryState: string;
  promptMessageId: string | null;
  acceptedAt: number | null;
  ackedAt: number | null;
}

export interface MessageCommentThreadSummary {
  id: string;
  sessionId: string;
  taskId: string | null;
  status: MessageCommentThreadStatus;
  anchor: MessageCommentAnchor;
  body: string;
  author: MessageCommentAuthor;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  replyCount: number;
  lastReplyAt: number | null;
  sourceMessage: MessageCommentSourceMessageContext | null;
  directive: MessageCommentDirectiveState | null;
}

export interface MessageCommentThread extends MessageCommentThreadSummary {
  replies: MessageCommentReply[];
}

export interface MessageCommentListRequest {
  sessionId: string;
  status?: MessageCommentThreadStatus | 'all';
  messageId?: string | null;
  cursor?: string | null;
  limit: number;
}

export interface MessageCommentListResponse {
  threads: MessageCommentThreadSummary[];
  nextCursor: string | null;
  hasMore: boolean;
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
