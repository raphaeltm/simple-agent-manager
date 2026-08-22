import type { QueryClient } from '@tanstack/react-query';
import { queryOptions } from '@tanstack/react-query';

import {
  listMessageComments,
  type MessageCommentRealtimeEvent,
  type MessageCommentThread,
} from '../api/comments';

export const messageCommentQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'message-comments'] as const,
  session: (queryScope: string, projectId: string, sessionId: string) =>
    [...messageCommentQueryKeys.all(queryScope), 'session', projectId, sessionId] as const,
};

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

export function upsertMessageCommentThread(
  previous: readonly MessageCommentThread[] | undefined,
  incoming: MessageCommentThread
): MessageCommentThread[] {
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
  return next.sort(compareMessageCommentThreads);
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
