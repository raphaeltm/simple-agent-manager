import type { CommentMention, CommentMentionInput } from '@simple-agent-manager/shared';

import { request } from './client';
import { type BackendAuthor, type BackendReply, mapAuthor } from './comment-wire';
import {
  type BackendFileThread,
  type LibraryFileCommentThread,
  mapBackendFileThread,
} from './library-file-comments';

// Library-file comments live in their own module; re-exported so every importer of
// `lib/api/comments` keeps one entry point for both anchor kinds.
export type {
  CreateLibraryFileCommentReplyRequest,
  CreateLibraryFileCommentThreadRequest,
  LibraryFileCommentAnchor,
  LibraryFileCommentThread,
  LibraryFileCommentThreadResponse,
  ListLibraryFileCommentsResponse,
} from './library-file-comments';
export {
  createLibraryFileCommentThread,
  listLibraryFileComments,
  reopenLibraryFileComment,
  replyToLibraryFileComment,
  resolveLibraryFileComment,
} from './library-file-comments';

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
  /** Project members @mentioned in the body; display names are server snapshots. */
  mentions?: CommentMention[];
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
  /** Project members @mentioned in the root comment; display names are server snapshots. */
  mentions?: CommentMention[];
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
  /** Members picked from the @mention palette. Only the IDs are sent; the server keeps active members. */
  mentions?: readonly CommentMentionInput[];
}

export interface CreateMessageCommentReplyRequest {
  clientId: string;
  body: string;
  action: MessageCommentAction;
  /** Members picked from the @mention palette. Only the IDs are sent; the server keeps active members. */
  mentions?: readonly CommentMentionInput[];
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
  mentions?: unknown;
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

/**
 * Keeps only well-formed mention entries. A malformed entry is dropped rather than failing the
 * thread: a mention is decoration on a comment that must still render.
 */
function mapMentions(raw: unknown): CommentMention[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry: unknown): CommentMention[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { userId, displayName } = entry as Record<string, unknown>;
    if (typeof userId !== 'string' || !userId) return [];
    return [{ userId, displayName: typeof displayName === 'string' ? displayName : null }];
  });
}

/** Spread into a mapped thread or reply: absent rather than `[]` when nobody was mentioned. */
function mentionsField(raw: unknown): { mentions?: CommentMention[] } {
  const mentions = mapMentions(raw);
  return mentions.length > 0 ? { mentions } : {};
}

/** Request field for picked mentions: IDs only, and omitted when nobody was picked. */
function mentionsRequestField(mentions: readonly CommentMentionInput[] | undefined) {
  if (!mentions || mentions.length === 0) return {};
  return { mentions: mentions.map(({ userId }) => ({ userId })) };
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
    ...mentionsField(thread.mentions),
    replies: thread.replies.map((reply) => ({
      id: reply.id,
      clientId: reply.clientMutationId ?? null,
      author: mapAuthor(reply.author),
      body: reply.body,
      createdAt: reply.createdAt,
      updatedAt: reply.updatedAt ?? null,
      sentToAgent: reply.sentToAgent ?? false,
      ...mentionsField(reply.mentions),
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
        ...mentionsRequestField(data.mentions),
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
        ...mentionsRequestField(data.mentions),
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
// Project-wide comment inbox
// ---------------------------------------------------------------------------

type BackendProjectCommentsResponse = {
  messageThreads?: BackendThread[];
  fileThreads?: BackendFileThread[];
  sessions?: Array<{ id: string; topic?: string | null }>;
  files?: Array<{ id: string; filename: string }>;
  hasMore?: boolean;
  totalCount?: number;
};

export interface ProjectCommentsResponse {
  messageThreads: MessageCommentThread[];
  fileThreads: LibraryFileCommentThread[];
  /** Session id → topic, for labelling where a thread lives. */
  sessionTopics: Map<string, string | null>;
  /** File id → filename, same purpose. */
  fileNames: Map<string, string>;
  hasMore: boolean;
  /** Total threads in the project, so a capped list can disclose the cut. */
  totalCount: number;
}

/**
 * Every comment thread in a project — chat and library — in one request.
 *
 * Reuses the same per-kind mappers as the scoped endpoints, so the shapes the
 * inbox renders cannot drift from the shapes the session drawer and the file
 * panel render.
 */
export async function listProjectComments(
  projectId: string,
  params: { status?: MessageCommentStatus; limit?: number; signal?: AbortSignal } = {}
): Promise<ProjectCommentsResponse> {
  const searchParams = new URLSearchParams();
  if (params.status) searchParams.set('status', params.status);
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit));
  const qs = searchParams.toString();
  const querySuffix = qs ? `?${qs}` : '';
  const response = await request<BackendProjectCommentsResponse>(
    `/api/projects/${projectId}/comments${querySuffix}`,
    params.signal ? { signal: params.signal } : {}
  );

  const messageThreads = (response.messageThreads ?? []).map((thread) =>
    mapBackendMessageCommentThread(projectId, thread)
  );
  const fileThreads = (response.fileThreads ?? []).map((thread) =>
    mapBackendFileThread(projectId, thread)
  );

  return {
    messageThreads,
    fileThreads,
    sessionTopics: new Map(
      (response.sessions ?? []).map((session) => [session.id, session.topic ?? null])
    ),
    fileNames: new Map((response.files ?? []).map((file) => [file.id, file.filename])),
    hasMore: response.hasMore ?? false,
    totalCount: response.totalCount ?? messageThreads.length + fileThreads.length,
  };
}
