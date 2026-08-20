import { DEFAULT_CHAT_SESSION_MESSAGE_MAX } from '@simple-agent-manager/shared';
import { queryOptions } from '@tanstack/react-query';

import {
  type ActivityEventResponse,
  type ChatMessageResponse,
  type ChatSessionListItem,
  getAllChats,
  getChatSession,
  getRecentChats,
  listActivityEvents,
  listChatMessages,
  listChatSessions,
  type SessionSummaryItem,
} from '../api';

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
  projectSessions: (queryScope: string, projectId: string, limit: number) =>
    [...chatQueryKeys.all(queryScope), 'project-sessions', projectId, { limit }] as const,
  sessionMessages: (queryScope: string, projectId: string, sessionId: string) =>
    ['auth', queryScope, 'sessions', 'messages', projectId, sessionId] as const,
  timelineMessages: (queryScope: string, projectId: string, sessionId: string, maxPages: number) =>
    [...chatQueryKeys.all(queryScope), 'timeline-messages', projectId, sessionId, { maxPages }] as const,
  timelineActivity: (queryScope: string, projectId: string, sessionId: string, limit: number) =>
    [...chatQueryKeys.all(queryScope), 'timeline-activity', projectId, sessionId, { limit }] as const,
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

export function projectChatSessionsQueryOptions(
  queryScope: string,
  projectId: string,
  limit: number
) {
  return queryOptions({
    queryKey: chatQueryKeys.projectSessions(queryScope, projectId, limit),
    queryFn: async (): Promise<ChatSessionListItem[]> =>
      (await listChatSessions(projectId, { limit })).sessions,
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

export async function fetchTimelineUserMessages(
  projectId: string,
  sessionId: string,
  maxPages: number
): Promise<ChatMessageResponse[]> {
  const messagePages: ChatMessageResponse[][] = [];
  let before: number | undefined;
  let pages = 0;

  while (pages++ < maxPages) {
    const result = await listChatMessages(projectId, sessionId, {
      before,
      roles: ['user'],
      compact: true,
    });

    if (result.messages.length === 0) break;

    messagePages.unshift(result.messages);
    const nextBefore = result.messages[0]?.createdAt;
    if (nextBefore === undefined || nextBefore === before) break;
    before = nextBefore;

    if (!result.hasMore) break;
  }

  return messagePages.flat();
}

export function timelineUserMessagesQueryOptions(
  queryScope: string,
  projectId: string,
  sessionId: string,
  maxPages: number
) {
  return queryOptions({
    queryKey: chatQueryKeys.timelineMessages(queryScope, projectId, sessionId, maxPages),
    queryFn: () => fetchTimelineUserMessages(projectId, sessionId, maxPages),
  });
}

export function timelineActivityEventsQueryOptions(
  queryScope: string,
  projectId: string,
  sessionId: string,
  limit: number
) {
  return queryOptions({
    queryKey: chatQueryKeys.timelineActivity(queryScope, projectId, sessionId, limit),
    queryFn: async (): Promise<ActivityEventResponse[]> =>
      (await listActivityEvents(projectId, { sessionId, limit })).events,
  });
}
