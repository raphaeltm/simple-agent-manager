import { request } from './client';

export type MessageCommentStatus = 'open' | 'sent' | 'resolved';
export type MessageCommentAction = 'note' | 'send_to_agent';

export interface MessageCommentAnchor {
  kind: 'message';
  messageId: string;
  quote?: string | null;
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
        replyId?: string;
      };
    };

type BackendAuthor = {
  id: string;
  kind: 'human' | 'agent';
  name?: string | null;
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
};

type BackendReply = {
  id: string;
  clientMutationId?: string | null;
  author: BackendAuthor;
  body: string;
  createdAt: number;
  updatedAt?: number | null;
  sentToAgent?: boolean;
};

type BackendThread = {
  id: string;
  clientMutationId?: string | null;
  projectId?: string;
  sessionId: string;
  anchor: {
    kind: 'message';
    messageId: string;
    quote?: string | null;
  };
  author: BackendAuthor;
  body: string;
  createdAt: number;
  updatedAt: number;
  status: MessageCommentStatus;
  replies: BackendReply[];
};

type BackendListResponse = {
  comments?: BackendThread[];
  threads?: BackendThread[];
};

type BackendThreadResponse = {
  comment?: BackendThread;
  thread?: BackendThread;
};

function sessionCommentsEndpoint(projectId: string, sessionId: string): string {
  return `/api/projects/${projectId}/sessions/${sessionId}/comments`;
}

function mapAuthor(author: BackendAuthor): MessageCommentAuthor {
  return {
    id: author.id,
    kind: author.kind,
    name: author.name ?? author.displayName ?? null,
    email: author.email ?? null,
    avatarUrl: author.avatarUrl ?? null,
  };
}

export function mapBackendMessageCommentThread(
  projectId: string,
  thread: BackendThread
): MessageCommentThread {
  return {
    id: thread.id,
    clientId: thread.clientMutationId ?? null,
    projectId: thread.projectId ?? projectId,
    sessionId: thread.sessionId,
    anchor: {
      kind: 'message',
      messageId: thread.anchor.messageId,
      quote: thread.anchor.quote ?? null,
    },
    author: mapAuthor(thread.author),
    body: thread.body,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: thread.status,
    replies: thread.replies.map((reply) => ({
      id: reply.id,
      clientId: reply.clientMutationId ?? null,
      author: mapAuthor(reply.author),
      body: reply.body,
      createdAt: reply.createdAt,
      updatedAt: reply.updatedAt ?? null,
      sentToAgent: reply.sentToAgent ?? false,
    })),
  };
}

function getBackendThread(
  projectId: string,
  response: BackendThreadResponse
): MessageCommentThread {
  const thread = response.comment ?? response.thread;
  if (!thread) {
    throw new Error('Comment response did not include a thread');
  }
  return mapBackendMessageCommentThread(projectId, thread);
}

export async function listMessageComments(
  projectId: string,
  sessionId: string,
  params: { signal?: AbortSignal } = {}
): Promise<ListMessageCommentsResponse> {
  const response = await request<BackendListResponse>(
    `${sessionCommentsEndpoint(projectId, sessionId)}?anchorKind=message`,
    params.signal ? { signal: params.signal } : {}
  );
  const threads = response.comments ?? response.threads ?? [];
  return {
    comments: threads.map((thread) => mapBackendMessageCommentThread(projectId, thread)),
  };
}

export async function createMessageCommentThread(
  projectId: string,
  sessionId: string,
  data: CreateMessageCommentThreadRequest
): Promise<MessageCommentThreadResponse> {
  const response = await request<BackendThreadResponse>(
    sessionCommentsEndpoint(projectId, sessionId),
    {
      method: 'POST',
      body: JSON.stringify({
        messageId: data.anchor.messageId,
        quote: data.anchor.quote ?? null,
        body: data.body,
        clientMutationId: data.clientId,
      }),
    }
  );
  const comment = getBackendThread(projectId, response);
  if (data.action !== 'send_to_agent') return { comment };
  return sendMessageCommentThreadToAgent(projectId, sessionId, comment.id, { body: data.body });
}

export async function createMessageCommentReply(
  projectId: string,
  sessionId: string,
  commentId: string,
  data: CreateMessageCommentReplyRequest
): Promise<MessageCommentThreadResponse> {
  const response = await request<BackendThreadResponse>(
    `${sessionCommentsEndpoint(projectId, sessionId)}/${commentId}/replies`,
    {
      method: 'POST',
      body: JSON.stringify({
        body: data.body,
        clientMutationId: data.clientId,
      }),
    }
  );
  const comment = getBackendThread(projectId, response);
  if (data.action !== 'send_to_agent') return { comment };
  return sendMessageCommentThreadToAgent(projectId, sessionId, comment.id, { body: data.body });
}

export async function resolveMessageCommentThread(
  projectId: string,
  sessionId: string,
  commentId: string
): Promise<MessageCommentThreadResponse> {
  const response = await request<BackendThreadResponse>(
    `${sessionCommentsEndpoint(projectId, sessionId)}/${commentId}/resolve`,
    { method: 'POST', body: JSON.stringify({}) }
  );
  return { comment: getBackendThread(projectId, response) };
}

export async function reopenMessageCommentThread(
  projectId: string,
  sessionId: string,
  commentId: string
): Promise<MessageCommentThreadResponse> {
  const response = await request<BackendThreadResponse>(
    `${sessionCommentsEndpoint(projectId, sessionId)}/${commentId}/reopen`,
    { method: 'POST', body: JSON.stringify({}) }
  );
  return { comment: getBackendThread(projectId, response) };
}

export async function sendMessageCommentThreadToAgent(
  projectId: string,
  sessionId: string,
  commentId: string,
  data: SendMessageCommentThreadRequest = {}
): Promise<MessageCommentThreadResponse> {
  const response = await request<BackendThreadResponse>(
    `${sessionCommentsEndpoint(projectId, sessionId)}/${commentId}/send`,
    {
      method: 'POST',
      body: JSON.stringify({ body: data.body }),
    }
  );
  return { comment: getBackendThread(projectId, response) };
}
