import { useQuery } from '@tanstack/react-query';

import { ALL_CHATS_LIMIT } from '../lib/chat-query-config';
import { allChatsQueryOptions, type ChatSessionSummary } from '../lib/query-options';

/** @deprecated Use `ChatSessionSummary` from `lib/query-options`. Kept for consumers. */
export type EnrichedChatSession = ChatSessionSummary;

interface UseAllChatSessionsResult {
  sessions: ChatSessionSummary[];
  loading: boolean;
  isRefreshing: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Every chat session across all projects, for the `/chats` page.
 *
 * Replaces a hand-rolled loader that carried three refs (`cancelledRef`,
 * `fetchIdRef`, `hasLoadedRef`) reimplementing request cancellation, stale-response
 * discarding, and a first-load flag — all of which `QueryObserver` already provides.
 *
 * `loading` is true only when nothing is cached. The previous implementation's
 * consumer (`pages/Chats.tsx`) rendered its list under `{!loading && …}`, so every
 * refresh blanked the page; keeping `loading` false whenever `data` exists is what
 * makes that consumer stale-while-revalidate correct
 * (`.claude/rules/48-stale-while-revalidate-ui.md`).
 */
export function useAllChatSessions(queryScope: string): UseAllChatSessionsResult {
  const query = useQuery({
    ...allChatsQueryOptions(queryScope, ALL_CHATS_LIMIT),
    enabled: Boolean(queryScope),
  });

  return {
    sessions: query.data?.chats ?? [],
    loading: Boolean(queryScope) && query.isPending && query.data === undefined,
    isRefreshing: query.isFetching && query.data !== undefined,
    error:
      query.data === undefined && query.error
        ? query.error instanceof Error
          ? query.error.message
          : 'Failed to load chat sessions'
        : null,
    refresh: () => {
      void query.refetch();
    },
  };
}
