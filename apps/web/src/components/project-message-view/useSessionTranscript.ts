import { DEFAULT_CHAT_SESSION_MESSAGE_MAX } from '@simple-agent-manager/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import type { ChatMessageResponse, ChatSessionDetailResponse } from '../../lib/api';
import { getChatSession } from '../../lib/api';
import { mergeMessages } from '../../lib/merge-messages';
import {
  fetchHistoryUntil,
  oldestPersistedCursor,
  refreshCachedTranscript,
} from '../../lib/message-paging';
import { chatQueryKeys, chatSessionMessagesQueryOptions } from '../../lib/query-options';
import { mergeSessionDetailMessages } from './session-lifecycle-helpers';
import { countDisplayRows } from './tool-call-groups';
import { VIRTUAL_START } from './types';

export type SessionTranscript = ReturnType<typeof useSessionTranscript>;

/**
 * The loaded transcript of one chat session: its query-cache entry, the render
 * state mirrored from it, and paging into older history.
 */
export function useSessionTranscript(projectId: string, sessionId: string) {
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => chatQueryKeys.sessionMessages(queryScope, projectId, sessionId),
    [projectId, queryScope, sessionId]
  );
  const [messages, setMessages] = useState<ChatMessageResponse[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [firstItemIndex, setFirstItemIndex] = useState(VIRTUAL_START);

  const query = useQuery({
    ...chatSessionMessagesQueryOptions(queryScope, projectId, sessionId),
    enabled: Boolean(queryScope && projectId && sessionId),
    refetchOnMount: 'always',
    queryFn: async ({ signal }) => {
      const cached = queryClient.getQueryData<ChatSessionDetailResponse>(queryKey);
      const refreshed =
        cached && (await refreshCachedTranscript(projectId, sessionId, cached, signal));
      if (refreshed) {
        const latest = queryClient.getQueryData<ChatSessionDetailResponse>(queryKey) ?? cached;
        return {
          ...refreshed,
          messages: mergeMessages(latest.messages, refreshed.messages, 'append'),
          hasMore: latest.hasMore,
        };
      }
      return getChatSession(projectId, sessionId, {
        signal,
        limit: DEFAULT_CHAT_SESSION_MESSAGE_MAX,
      });
    },
  });

  // Refs mirror the latest messages/hasMore so imperative loaders (loadUntil)
  // can read current state without stale closures.
  const messagesRef = useRef<ChatMessageResponse[]>([]);
  const hasMoreRef = useRef(false);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);

  const updateCachedMessages = useCallback(
    (incoming: ChatMessageResponse[], strategy: 'replace' | 'append' | 'prepend') => {
      if (!queryScope) return;
      // TODO: Add size-based cache eviction — no cap for now, optimize later
      queryClient.setQueryData<ChatSessionDetailResponse | undefined>(queryKey, (old) =>
        mergeSessionDetailMessages(old, incoming, strategy)
      );
    },
    [queryClient, queryScope, queryKey]
  );

  // Reset virtual scroll on session change
  useEffect(() => {
    setFirstItemIndex(VIRTUAL_START);
  }, [sessionId]);

  useEffect(() => {
    setLoading(query.isPending && query.data === undefined);
    if (query.error && query.data === undefined) {
      setError(query.error instanceof Error ? query.error.message : 'Failed to load session');
    }
    if (!query.data) return;

    setError(null);
    setMessages(query.data.messages);
    setHasMore(query.data.hasMore);
  }, [query.data, query.error, query.isPending]);

  // Load more (pagination)
  const loadMore = async () => {
    if (!hasMore || loadingMore) return;
    const before = oldestPersistedCursor(messages);
    if (!before) return;

    setLoadingMore(true);
    try {
      const data = await getChatSession(projectId, sessionId, { before });
      setMessages((prev) => {
        const merged = mergeMessages(prev, data.messages, 'prepend');
        // Virtuoso's anchor moves by RENDERED ROWS, not messages: a page of tool
        // calls folds into one group row, and a page whose trailing call merges
        // into the existing first group adds none. See `countDisplayRows`. The
        // guard covers the boundary-dedup case where `prepend` can drop a row.
        const displayRowsAdded = countDisplayRows(merged) - countDisplayRows(prev);
        if (displayRowsAdded > 0) {
          setFirstItemIndex((fi) => fi - displayRowsAdded);
        }
        return merged;
      });
      updateCachedMessages(data.messages, 'prepend');
      setHasMore(data.hasMore);
    } finally {
      setLoadingMore(false);
    }
  };

  // Load older pages until a target timestamp is covered (or no more history).
  // Used by timeline jump-to-message for the rare oversized/guard-trimmed session
  // where the target predates the loaded window, so a jump never dead-clicks.
  const loadUntil = useCallback(
    async (targetTimestamp: number) => {
      const oldest = messagesRef.current[0]?.createdAt ?? Infinity;
      if (oldest <= targetTimestamp || !hasMoreRef.current) return;

      setLoadingMore(true);
      try {
        const history = await fetchHistoryUntil(
          projectId,
          sessionId,
          messagesRef.current,
          targetTimestamp
        );
        if (history.messages.length > 0) {
          setMessages((prev) => {
            const merged = mergeMessages(prev, history.messages, 'prepend');
            // Same rendered-row accounting as `loadMore` above.
            const displayRowsAdded = countDisplayRows(merged) - countDisplayRows(prev);
            if (displayRowsAdded > 0) {
              setFirstItemIndex((fi) => fi - displayRowsAdded);
            }
            return merged;
          });
          updateCachedMessages(history.messages, 'prepend');
        }
        setHasMore(history.hasMore);
      } finally {
        setLoadingMore(false);
      }
    },
    [projectId, sessionId, updateCachedMessages]
  );

  return {
    queryClient,
    queryKey,
    query,
    messages,
    setMessages,
    messagesRef,
    hasMore,
    setHasMore,
    hasMoreRef,
    loading,
    loadingMore,
    error,
    setError,
    firstItemIndex,
    updateCachedMessages,
    loadMore,
    loadUntil,
  };
}
