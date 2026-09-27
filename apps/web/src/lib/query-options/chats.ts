import { type QueryClient, type QueryKey, queryOptions } from '@tanstack/react-query';

import {
  type ActivityEventResponse,
  type ChatMessageResponse,
  type ChatSessionDetailResponse,
  type ChatSessionListItem,
  getAllChats,
  getRecentChats,
  listActivityEvents,
  listChatMessages,
  listChatSessions,
  type SessionSummaryItem,
} from '../api';
import { mergeMessages } from '../merge-messages';
import { fetchNewestPage, oldestPersistedCursor, refreshCachedTranscript } from '../message-paging';
import {
  CHAT_TRANSCRIPT_CACHE_MAX_SESSIONS,
  CHAT_TRANSCRIPT_CACHE_TTL_MS,
} from '../query-persist-config';

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
  /** Every chat transcript cached for this scope, across projects. */
  transcripts: (queryScope: string) => ['auth', queryScope, 'sessions', 'messages'] as const,
  sessionMessages: (queryScope: string, projectId: string, sessionId: string) =>
    [...chatQueryKeys.transcripts(queryScope), projectId, sessionId] as const,
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

/**
 * One chat session's transcript, loaded newest first.
 *
 * A transcript the cache already holds is brought up to date by reading only what
 * was persisted after its newest row. Otherwise only the newest page is read, and
 * older history pages in as the reader scrolls up. `gcTime` keeps a transcript
 * nobody is viewing for the retention window: in memory, and therefore on disk,
 * because the persisted cache mirrors memory.
 */
export function chatSessionMessagesQueryOptions(
  queryScope: string,
  projectId: string,
  sessionId: string
) {
  return queryOptions({
    queryKey: chatQueryKeys.sessionMessages(queryScope, projectId, sessionId),
    queryFn: ({ client, queryKey, signal }) =>
      loadTranscript(client, queryKey, projectId, sessionId, signal),
    gcTime: CHAT_TRANSCRIPT_CACHE_TTL_MS,
  });
}

async function loadTranscript(
  client: QueryClient,
  queryKey: QueryKey,
  projectId: string,
  sessionId: string,
  signal: AbortSignal
): Promise<ChatSessionDetailResponse> {
  const cached = client.getQueryData<ChatSessionDetailResponse>(queryKey);
  const refreshed = cached && (await refreshCachedTranscript(projectId, sessionId, cached, signal));
  if (!refreshed) return fetchNewestPage(projectId, sessionId, signal);

  // Rows the socket or an optimistic send appended while the refresh was in
  // flight are in the latest cache entry, not in the snapshot it started from.
  const latest = client.getQueryData<ChatSessionDetailResponse>(queryKey) ?? cached;
  return {
    ...refreshed,
    messages: mergeMessages(latest.messages, refreshed.messages, 'append'),
    hasMore: latest.hasMore,
  };
}

/**
 * Keeps only the most recently updated transcripts cached: every transcript
 * beyond `maxEntries`, least recently updated first, is evicted — from memory,
 * and so from the next persisted write. A transcript on screen is never evicted,
 * nor is `opening`, whose observer may not have subscribed yet.
 */
export function evictStaleTranscripts(
  client: QueryClient,
  queryScope: string,
  opening: QueryKey,
  maxEntries: number = CHAT_TRANSCRIPT_CACHE_MAX_SESSIONS
): void {
  const cache = client.getQueryCache();
  const openingQuery = cache.find({ queryKey: opening, exact: true });
  const byRecency = cache
    .findAll({ queryKey: chatQueryKeys.transcripts(queryScope) })
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);

  let retained = 0;
  for (const query of byRecency) {
    const onScreen = query === openingQuery || query.getObserversCount() > 0;
    if (onScreen || retained < maxEntries) {
      retained += 1;
    } else {
      cache.remove(query);
    }
  }
}

export async function fetchTimelineUserMessages(
  projectId: string,
  sessionId: string,
  maxPages: number
): Promise<ChatMessageResponse[]> {
  const messagePages: ChatMessageResponse[][] = [];
  let before: string | undefined;
  let pages = 0;

  while (pages++ < maxPages) {
    const result = await listChatMessages(projectId, sessionId, {
      before,
      roles: ['user'],
      compact: true,
    });

    if (result.messages.length === 0) break;

    messagePages.unshift(result.messages);
    const nextBefore = oldestPersistedCursor(result.messages);
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
