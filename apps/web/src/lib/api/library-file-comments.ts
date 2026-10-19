import { request } from './client';
import { type BackendAuthor, type BackendReply, mapAuthor } from './comment-wire';
import type { MessageCommentAuthor, MessageCommentReply, MessageCommentStatus } from './comments';

/**
 * Library-file comments: threads anchored to a file in the project library. Same lifecycle as
 * message comments, but no @mentions and no agent delivery. Re-exported by `./comments`.
 */

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

export type BackendFileThread = {
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

export function mapBackendFileThread(
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
