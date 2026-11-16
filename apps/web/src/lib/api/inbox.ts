import type {
  InboxActionResponse,
  InboxAnswerRequest,
  InboxCountResponse,
  InboxFilter,
  InboxItemResponse,
  InboxListResponse,
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

export function getInboxItem(
  projectId: string,
  ref: string,
  signal?: AbortSignal
): Promise<InboxItemResponse> {
  return request<InboxItemResponse>(`${itemPath(projectId, ref)}?context=true`, { signal });
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
