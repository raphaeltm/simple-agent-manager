import type {
  InboxActionResponse,
  InboxAnswerRequest,
  InboxCountResponse,
  InboxFilter,
  InboxItemResponse,
  InboxListResponse,
  InboxReplyRequest,
  InboxReplyResponse,
  InboxTaskActionResponse,
} from '@simple-agent-manager/shared';

import { request } from './client';

/**
 * Inbox REST client (slice A routes, `apps/api/src/routes/inbox.ts`). Item references are opaque
 * strings (`ask:…`, `attention:…:…`, `secret:…`, `approval:…`): the client never parses them, it
 * only encodes them into the path.
 */

function inboxBase(projectId: string | null): string {
  return projectId ? `/api/projects/${encodeURIComponent(projectId)}/inbox` : '/api/inbox';
}

function itemPath(projectId: string, ref: string): string {
  return `${inboxBase(projectId)}/items/${encodeURIComponent(ref)}`;
}

export function listInbox(
  params: { projectId: string | null; filter: InboxFilter; cursor?: string | null; limit?: number },
  signal?: AbortSignal
): Promise<InboxListResponse> {
  const query = new URLSearchParams({ filter: params.filter });
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));
  return request<InboxListResponse>(`${inboxBase(params.projectId)}?${query.toString()}`, {
    signal,
  });
}

export function getInboxCount(
  projectId: string | null,
  signal?: AbortSignal
): Promise<InboxCountResponse> {
  return request<InboxCountResponse>(`${inboxBase(projectId)}/count`, { signal });
}

/** Where a conversation read continues. Only the streams with a cursor advance. */
export interface InboxConversationCursor {
  replyCursor?: string;
  responseCursor?: number;
}

/**
 * One item. Without `cursor` it is the first read (transcript context included); with one it is a
 * continuation of the item's conversation only.
 */
export function getInboxItem(
  projectId: string,
  ref: string,
  signal?: AbortSignal,
  cursor?: InboxConversationCursor
): Promise<InboxItemResponse> {
  const query = new URLSearchParams();
  if (cursor) {
    if (cursor.replyCursor) query.set('replyCursor', cursor.replyCursor);
    if (cursor.responseCursor !== undefined)
      query.set('responseCursor', String(cursor.responseCursor));
  } else {
    query.set('context', 'true');
  }
  return request<InboxItemResponse>(`${itemPath(projectId, ref)}?${query.toString()}`, { signal });
}

/**
 * Reply to an item: the message goes to the agent's chat through its own delivery path, and the
 * item leaves the inbox until the agent responds on it (`POST …/inbox/items/:ref/reply`, 202).
 */
export function replyToInboxItem(
  projectId: string,
  ref: string,
  body: InboxReplyRequest
): Promise<InboxReplyResponse> {
  return request<InboxReplyResponse>(`${itemPath(projectId, ref)}/reply`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function answerInboxItem(
  projectId: string,
  ref: string,
  body: InboxAnswerRequest
): Promise<InboxActionResponse> {
  return request<InboxActionResponse>(`${itemPath(projectId, ref)}/answer`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Archive one item. `keepalive` lets a pending archive finish when it is sent from a closing tab
 * or while the page unmounts (the Undo window in the inbox delays the request).
 */
export function archiveInboxItem(
  projectId: string,
  ref: string,
  options: { keepalive?: boolean } = {}
): Promise<InboxActionResponse> {
  return request<InboxActionResponse>(`${itemPath(projectId, ref)}/archive`, {
    method: 'POST',
    body: '{}',
    keepalive: options.keepalive,
  });
}

/**
 * Hand a human task to one active member, or back to the team (inbox slice H1,
 * `POST …/inbox/items/:ref/reassign`). The server checks who may do this and that the new
 * assignee is an active member; Insights · People reuses this path rather than its own.
 */
export function reassignInboxTask(
  projectId: string,
  ref: string,
  body: { assigneeUserId: string } | { team: true }
): Promise<InboxTaskActionResponse> {
  return request<InboxTaskActionResponse>(`${itemPath(projectId, ref)}/reassign`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
