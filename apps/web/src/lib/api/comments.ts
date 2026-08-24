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

// ---------------------------------------------------------------------------
// Library file comments
// ---------------------------------------------------------------------------

export interface LibraryFileCommentAnchor {
  kind: 'library_file';
  fileId: string;
  quote?: string | null;
}

export interface LibraryFileCommentThread {
  id: string;
  clientId?: string | null;
  projectId: string;
  fileId: string;
  anchor: LibraryFileCommentAnchor;
  author: MessageCommentAuthor;
  body: string;
  createdAt: number;
  updatedAt: number;
  status: MessageCommentStatus;
  replies: MessageCommentReply[];
}

export interface ListLibraryFileCommentsResponse {
  threads: LibraryFileCommentThread[];
  hasMore: boolean;
}

export interface LibraryFileCommentThreadResponse {
  thread: LibraryFileCommentThread;
  idempotent: boolean;
}

export interface CreateLibraryFileCommentThreadRequest {
  body: string;
  quote?: string | null;
  clientMutationId?: string | null;
}

export interface CreateLibraryFileCommentReplyRequest {
  body: string;
  clientMutationId?: string | null;
}

type BackendFileThread = {
  id: string;
  clientMutationId?: string | null;
  projectId?: string;
  fileId: string;
  anchor: {
    kind: 'library_file';
    fileId: string;
    quote?: string | null;
  };
  author: BackendAuthor;
  body: string;
  createdAt: number;
  updatedAt: number;
  status: MessageCommentStatus;
  replies: BackendReply[];
};

type BackendFileListResponse = {
  threads?: BackendFileThread[];
};

type BackendFileThreadResponse = {
  thread?: BackendFileThread;
  idempotent?: boolean;
};

function libraryFileCommentsEndpoint(projectId: string, fileId: string): string {
  return `/api/projects/${projectId}/library/${fileId}/comments`;
}

function mapBackendFileThread(
  projectId: string,
  thread: BackendFileThread
): LibraryFileCommentThread {
  return {
    id: thread.id,
    clientId: thread.clientMutationId ?? null,
    projectId: thread.projectId ?? projectId,
    fileId: thread.fileId,
    anchor: {
      kind: 'library_file',
      fileId: thread.anchor.fileId,
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

export async function listLibraryFileComments(
  projectId: string,
  fileId: string,
  params: { status?: MessageCommentStatus; signal?: AbortSignal } = {}
): Promise<ListLibraryFileCommentsResponse> {
  const searchParams = new URLSearchParams();
  if (params.status) searchParams.set('status', params.status);
  const qs = searchParams.toString();
  const url = `${libraryFileCommentsEndpoint(projectId, fileId)}${qs ? `?${qs}` : ''}`;
  const response = await request<BackendFileListResponse>(
    url,
    params.signal ? { signal: params.signal } : {}
  );
  const threads = response.threads ?? [];
  return {
    threads: threads.map((t) => mapBackendFileThread(projectId, t)),
    hasMore: false,
  };
}

export async function createLibraryFileCommentThread(
  projectId: string,
  fileId: string,
  data: CreateLibraryFileCommentThreadRequest
): Promise<LibraryFileCommentThreadResponse> {
  const response = await request<BackendFileThreadResponse>(
    libraryFileCommentsEndpoint(projectId, fileId),
    {
      method: 'POST',
      body: JSON.stringify({
        body: data.body,
        quote: data.quote ?? null,
        clientMutationId: data.clientMutationId ?? null,
      }),
    }
  );
  if (!response.thread) throw new Error('Comment response did not include a thread');
  return {
    thread: mapBackendFileThread(projectId, response.thread),
    idempotent: response.idempotent ?? false,
  };
}

export async function replyToLibraryFileComment(
  projectId: string,
  fileId: string,
  threadId: string,
  data: CreateLibraryFileCommentReplyRequest
): Promise<LibraryFileCommentThreadResponse> {
  const response = await request<BackendFileThreadResponse>(
    `${libraryFileCommentsEndpoint(projectId, fileId)}/${threadId}/replies`,
    {
      method: 'POST',
      body: JSON.stringify({
        body: data.body,
        clientMutationId: data.clientMutationId ?? null,
      }),
    }
  );
  if (!response.thread) throw new Error('Comment response did not include a thread');
  return {
    thread: mapBackendFileThread(projectId, response.thread),
    idempotent: response.idempotent ?? false,
  };
}

export async function resolveLibraryFileComment(
  projectId: string,
  fileId: string,
  threadId: string
): Promise<LibraryFileCommentThreadResponse> {
  const response = await request<BackendFileThreadResponse>(
    `${libraryFileCommentsEndpoint(projectId, fileId)}/${threadId}/resolve`,
    { method: 'POST', body: JSON.stringify({}) }
  );
  if (!response.thread) throw new Error('Comment response did not include a thread');
  return {
    thread: mapBackendFileThread(projectId, response.thread),
    idempotent: response.idempotent ?? false,
  };
}

export async function reopenLibraryFileComment(
  projectId: string,
  fileId: string,
  threadId: string
): Promise<LibraryFileCommentThreadResponse> {
  const response = await request<BackendFileThreadResponse>(
    `${libraryFileCommentsEndpoint(projectId, fileId)}/${threadId}/reopen`,
    { method: 'POST', body: JSON.stringify({}) }
  );
  if (!response.thread) throw new Error('Comment response did not include a thread');
  return {
    thread: mapBackendFileThread(projectId, response.thread),
    idempotent: response.idempotent ?? false,
  };
}
