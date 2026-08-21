import { request } from './client';

export type MessageCommentStatus = 'open' | 'sent' | 'resolved';
export type MessageCommentAction = 'note' | 'send_to_agent';

export interface MessageCommentAnchor {
  kind: 'message';
  messageId: string;
  quote?: string;
}

export interface MessageCommentAuthor {
  id: string;
  name: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  kind: 'human' | 'agent';
}

export interface MessageCommentReply {
  id: string;
  clientId?: string | null;
  author: MessageCommentAuthor;
  body: string;
  createdAt: number;
  updatedAt?: number | null;
  sentToAgent?: boolean;
}

export interface MessageCommentThread {
  id: string;
  clientId?: string | null;
  projectId: string;
  sessionId: string;
  anchor: MessageCommentAnchor;
  author: MessageCommentAuthor;
  body: string;
  createdAt: number;
  updatedAt: number;
  status: MessageCommentStatus;
  replies: MessageCommentReply[];
}

export interface ListMessageCommentsResponse {
  comments: MessageCommentThread[];
}

export interface MessageCommentThreadResponse {
  comment: MessageCommentThread;
}

export interface CreateMessageCommentThreadRequest {
  clientId: string;
  anchor: MessageCommentAnchor;
  body: string;
  action: MessageCommentAction;
}

export interface CreateMessageCommentReplyRequest {
  clientId: string;
  body: string;
  action: MessageCommentAction;
}

export interface SendMessageCommentThreadRequest {
  body?: string;
}

export type MessageCommentRealtimeEvent =
  | {
      type: 'comment.thread.created' | 'comment.thread.updated';
      payload: {
        projectId: string;
        sessionId: string;
        comment: MessageCommentThread;
      };
    }
  | {
      type: 'comment.reply.created';
      payload: {
        projectId: string;
        sessionId: string;
        comment: MessageCommentThread;
        replyId: string;
      };
    };

function sessionCommentsEndpoint(projectId: string, sessionId: string): string {
  return `/api/projects/${projectId}/sessions/${sessionId}/comments`;
}

export async function listMessageComments(
  projectId: string,
  sessionId: string,
  params: { signal?: AbortSignal } = {}
): Promise<ListMessageCommentsResponse> {
  return request<ListMessageCommentsResponse>(
    `${sessionCommentsEndpoint(projectId, sessionId)}?anchorKind=message`,
    params.signal ? { signal: params.signal } : {}
  );
}

export async function createMessageCommentThread(
  projectId: string,
  sessionId: string,
  data: CreateMessageCommentThreadRequest
): Promise<MessageCommentThreadResponse> {
  return request<MessageCommentThreadResponse>(sessionCommentsEndpoint(projectId, sessionId), {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function createMessageCommentReply(
  projectId: string,
  sessionId: string,
  commentId: string,
  data: CreateMessageCommentReplyRequest
): Promise<MessageCommentThreadResponse> {
  return request<MessageCommentThreadResponse>(
    `${sessionCommentsEndpoint(projectId, sessionId)}/${commentId}/replies`,
    {
      method: 'POST',
      body: JSON.stringify(data),
    }
  );
}

export async function resolveMessageCommentThread(
  projectId: string,
  sessionId: string,
  commentId: string
): Promise<MessageCommentThreadResponse> {
  return request<MessageCommentThreadResponse>(
    `${sessionCommentsEndpoint(projectId, sessionId)}/${commentId}/resolve`,
    { method: 'POST' }
  );
}

export async function reopenMessageCommentThread(
  projectId: string,
  sessionId: string,
  commentId: string
): Promise<MessageCommentThreadResponse> {
  return request<MessageCommentThreadResponse>(
    `${sessionCommentsEndpoint(projectId, sessionId)}/${commentId}/reopen`,
    { method: 'POST' }
  );
}

export async function sendMessageCommentThreadToAgent(
  projectId: string,
  sessionId: string,
  commentId: string,
  data: SendMessageCommentThreadRequest = {}
): Promise<MessageCommentThreadResponse> {
  return request<MessageCommentThreadResponse>(
    `${sessionCommentsEndpoint(projectId, sessionId)}/${commentId}/send`,
    {
      method: 'POST',
      body: JSON.stringify(data),
    }
  );
}
