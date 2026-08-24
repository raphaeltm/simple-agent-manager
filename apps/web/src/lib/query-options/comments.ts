import type { QueryClient } from '@tanstack/react-query';
import { queryOptions } from '@tanstack/react-query';

import {
  type LibraryFileCommentThread,
  listLibraryFileComments,
  listMessageComments,
  listProjectComments,
  type MessageCommentRealtimeEvent,
  type MessageCommentThread,
  type ProjectCommentsResponse,
} from '../api/comments';

export const messageCommentQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'message-comments'] as const,
  session: (queryScope: string, projectId: string, sessionId: string) =>
    [...messageCommentQueryKeys.all(queryScope), 'session', projectId, sessionId] as const,
};

export const projectCommentQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'project-comments'] as const,
  project: (queryScope: string, projectId: string) =>
    [...projectCommentQueryKeys.all(queryScope), projectId] as const,
};

/**
 * The whole project comment inbox in one request.
 *
 * Replaces a per-session + per-file fan-out; see `useProjectCommentInbox`.
 */
export function projectCommentsQueryOptions(queryScope: string, projectId: string) {
  return queryOptions({
    queryKey: projectCommentQueryKeys.project(queryScope, projectId),
    queryFn: async ({ signal }): Promise<ProjectCommentsResponse> =>
      listProjectComments(projectId, { signal }),
  });
}

export function messageCommentsQueryOptions(
  queryScope: string,
  projectId: string,
  sessionId: string
) {
  return queryOptions({
    queryKey: messageCommentQueryKeys.session(queryScope, projectId, sessionId),
    queryFn: async ({ signal }): Promise<MessageCommentThread[]> =>
      (await listMessageComments(projectId, sessionId, { signal })).comments,
  });
}

function compareMessageCommentThreads(a: MessageCommentThread, b: MessageCommentThread): number {
  if (a.anchor.messageId !== b.anchor.messageId) {
    return a.anchor.messageId.localeCompare(b.anchor.messageId);
  }
  return a.createdAt - b.createdAt;
}

/**
 * Replaces a thread in the cache, matching on server id OR clientId.
 *
 * The clientId arm is what retires the optimistic row: it was inserted under a
 * locally generated id, so an id-only match would leave it in place alongside
 * the server's copy and the user would see their own comment twice.
 */
function upsertThreadBy<T extends { id: string; clientId?: string | null }>(
  previous: readonly T[] | undefined,
  incoming: T,
  compare: (a: T, b: T) => number
): T[] {
  const current = previous ?? [];
  const index = current.findIndex((candidate) => {
    if (candidate.id === incoming.id) return true;
    return Boolean(
      candidate.clientId && incoming.clientId && candidate.clientId === incoming.clientId
    );
  });
  const next =
    index === -1
      ? [...current, incoming]
      : [...current.slice(0, index), incoming, ...current.slice(index + 1)];
  return next.sort(compare);
}

export function upsertMessageCommentThread(
  previous: readonly MessageCommentThread[] | undefined,
  incoming: MessageCommentThread
): MessageCommentThread[] {
  return upsertThreadBy(previous, incoming, compareMessageCommentThreads);
}

export function applyMessageCommentRealtimeEventToQueryCache(
  queryClient: QueryClient,
  queryScope: string,
  event: MessageCommentRealtimeEvent
): void {
  const { projectId, sessionId, comment } = event.payload;
  queryClient.setQueryData<MessageCommentThread[] | undefined>(
    messageCommentQueryKeys.session(queryScope, projectId, sessionId),
    (previous) => upsertMessageCommentThread(previous, comment)
  );
}

// ---------------------------------------------------------------------------
// Library file comments
// ---------------------------------------------------------------------------

export const libraryFileCommentQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'library-file-comments'] as const,
  file: (queryScope: string, projectId: string, fileId: string) =>
    [...libraryFileCommentQueryKeys.all(queryScope), projectId, fileId] as const,
};

export function libraryFileCommentsQueryOptions(
  queryScope: string,
  projectId: string,
  fileId: string
) {
  return queryOptions({
    queryKey: libraryFileCommentQueryKeys.file(queryScope, projectId, fileId),
    queryFn: async ({ signal }): Promise<LibraryFileCommentThread[]> =>
      (await listLibraryFileComments(projectId, fileId, { signal })).threads,
  });
}

export function upsertLibraryFileCommentThread(
  previous: readonly LibraryFileCommentThread[] | undefined,
  incoming: LibraryFileCommentThread
): LibraryFileCommentThread[] {
  return upsertThreadBy(previous, incoming, (a, b) => a.createdAt - b.createdAt);
}
