import { useQuery } from '@tanstack/react-query';

import { RECENT_CHATS_LIMIT, RECENT_CHATS_POLL_INTERVAL_MS } from '../lib/chat-query-config';
import { STALE_SESSION_THRESHOLD_MS } from '../lib/chat-session-utils';
import { type ChatSessionSummary, recentChatsQueryOptions } from '../lib/query-options';

/** @deprecated Use `ChatSessionSummary` from `lib/query-options`. Kept for consumers. */
export type RecentChat = ChatSessionSummary;

interface UseRecentChatsResult {
  chats: ChatSessionSummary[];
  activeCount: number;
  loading: boolean;
  isRefreshing: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Recent active chat sessions across all projects, for the header dropdown.
 *
 * Only fetches while `enabled` (the dropdown is open). Replaces ~50 lines of
 * hand-rolled bookkeeping: two `useEffect`s, a `visibilitychange` listener pair, a
 * `cancelledRef`/`fetchIdRef` stale-response guard, and a `hasFetchedRef`
 * first-load flag. TanStack's observer already discards superseded responses and
 * pauses `refetchInterval` on a hidden tab.
 */
export function useRecentChats(enabled: boolean, queryScope: string): UseRecentChatsResult {
  const query = useQuery({
    ...recentChatsQueryOptions(queryScope, RECENT_CHATS_LIMIT, STALE_SESSION_THRESHOLD_MS),
    enabled: enabled && Boolean(queryScope),
    refetchInterval: RECENT_CHATS_POLL_INTERVAL_MS > 0 ? RECENT_CHATS_POLL_INTERVAL_MS : false,
  });

  return {
    chats: query.data?.chats ?? [],
    activeCount: query.data?.activeCount ?? 0,
    loading: enabled && Boolean(queryScope) && query.isPending && query.data === undefined,
    isRefreshing: query.isFetching && query.data !== undefined,
    error:
      query.data === undefined && query.error
        ? query.error instanceof Error
          ? query.error.message
          : 'Failed to load chats'
        : null,
    refresh: () => {
      void query.refetch();
    },
  };
}
