export const COMMENT_STATUSES = ['open', 'sent', 'resolved'] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

export const COMMENT_AUTHOR_KINDS = ['human', 'agent'] as const;
export type CommentAuthorKind = (typeof COMMENT_AUTHOR_KINDS)[number];

export type MessageCommentAnchor = {
  kind: 'message';
  messageId: string;
  quote: string | null;
};

export type CommentAuthor = {
  kind: CommentAuthorKind;
  id: string;
  name: string | null;
};

export type MessageCommentReply = {
  id: string;
  threadId: string;
  sessionId: string;
  author: CommentAuthor;
  body: string;
  createdAt: number;
  sequence: number;
  clientMutationId: string | null;
};

export type MessageCommentThread = {
  id: string;
  sessionId: string;
  anchor: MessageCommentAnchor;
  author: CommentAuthor;
  body: string;
  status: CommentStatus;
  createdAt: number;
  updatedAt: number;
  sequence: number;
  version: number;
  clientMutationId: string | null;
  sentAt: number | null;
  sentBy: CommentAuthor | null;
  resolvedAt: number | null;
  resolvedBy: CommentAuthor | null;
  reopenedAt: number | null;
  reopenedBy: CommentAuthor | null;
  replies: MessageCommentReply[];
};

export type MessageCommentListResponse = {
  threads: MessageCommentThread[];
  hasMore: boolean;
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
