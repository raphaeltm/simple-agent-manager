import { DEFAULT_CHAT_SESSION_MESSAGE_MAX } from '@simple-agent-manager/shared';
import { queryOptions } from '@tanstack/react-query';

import { getAllChats, getChatSession, getRecentChats, type SessionSummaryItem } from '../api';

/**
 * Cross-project chat session summaries, served by a single D1 query each.
 *
 * `recent` backs the header dropdown (polled while open); `all` backs the
 * `/chats` page. Both return `SessionSummaryItem`, whose `topic` field is the first
 * ~97 characters of the user's opening chat message — so neither is persistable, for
 * exactly the reason `query-persist-config.ts` documents for `projects/detail`.
 *
 * Both callers previously hand-rolled request cancellation and stale-response
 * discarding with `cancelledRef` / `fetchIdRef` pairs; TanStack's own
 * last-write-wins observer makes that unnecessary.
 */
export const chatQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'chats'] as const,
  recent: (queryScope: string, limit: number, staleThreshold: number) =>
    [...chatQueryKeys.all(queryScope), 'recent', { limit, staleThreshold }] as const,
  list: (queryScope: string, limit: number) =>
    [...chatQueryKeys.all(queryScope), 'list', { limit }] as const,
  sessionMessages: (queryScope: string, projectId: string, sessionId: string) =>
    ['auth', queryScope, 'sessions', 'messages', projectId, sessionId] as const,
};

/** Compat shape: consumers of `ChatSessionListItem` expect `createdAt`. */
export interface ChatSessionSummary extends SessionSummaryItem {
  createdAt: number;
}

function withCreatedAt(sessions: SessionSummaryItem[]): ChatSessionSummary[] {
  return sessions.map((session) => ({ ...session, createdAt: session.startedAt }));
}

export function recentChatsQueryOptions(
  queryScope: string,
  limit: number,
  staleThreshold: number
) {
  return queryOptions({
    queryKey: chatQueryKeys.recent(queryScope, limit, staleThreshold),
    queryFn: async () => {
      const response = await getRecentChats({ limit, staleThreshold });
      return {
        chats: withCreatedAt(response.sessions),
        activeCount: response.totalActive,
      };
    },
  });
}

export function allChatsQueryOptions(queryScope: string, limit: number) {
  return queryOptions({
    queryKey: chatQueryKeys.list(queryScope, limit),
    queryFn: async () => {
      const response = await getAllChats({ limit });
      return {
        chats: withCreatedAt(response.sessions),
        total: response.total,
      };
    },
  });
}

export function chatSessionMessagesQueryOptions(
  queryScope: string,
  projectId: string,
  sessionId: string
) {
  return queryOptions({
    queryKey: chatQueryKeys.sessionMessages(queryScope, projectId, sessionId),
    queryFn: ({ signal }) =>
      getChatSession(projectId, sessionId, {
        signal,
        limit: DEFAULT_CHAT_SESSION_MESSAGE_MAX,
      }),
  });
}
