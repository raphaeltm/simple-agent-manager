import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import type { ChatMessageResponse, ChatSessionDetailResponse } from '../../lib/api';
import { getChatSession } from '../../lib/api';
import { mergeMessages } from '../../lib/merge-messages';
import {
  fetchHistoryUntil,
  historyReaches,
  type HistoryTarget,
  mergeRecentWindowOrRefresh,
  oldestPersistedCursor,
} from '../../lib/message-paging';
import {
  chatQueryKeys,
  chatSessionMessagesQueryOptions,
  evictStaleTranscripts,
} from '../../lib/query-options';
import { countDisplayRows } from './tool-call-groups';
import { VIRTUAL_START } from './types';

/** One shared empty transcript, so an unloaded session hands every memo the same array. */
const NO_MESSAGES: ChatMessageResponse[] = [];

export type SessionTranscript = ReturnType<typeof useSessionTranscript>;

/**
 * The transcript of one chat session.
 *
 * Its query-cache entry is the only copy. Messages and `hasMore` are read straight
 * from it, and every writer goes through it: the load and mount refresh, live
 * socket rows, optimistic sends, the fallback poll and reconnect catch-up, and
 * paging into older history. So a view that mounts on a cached chat renders the
 * transcript on its first render, and the persisted cache holds what the reader
 * last saw.
 */
export function useSessionTranscript(projectId: string, sessionId: string) {
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => chatQueryKeys.sessionMessages(queryScope, projectId, sessionId),
    [projectId, queryScope, sessionId]
  );

  const query = useQuery({
    ...chatSessionMessagesQueryOptions(queryScope, projectId, sessionId),
    enabled: Boolean(queryScope && projectId && sessionId),
    // Opening a chat always reconciles its cached copy with the server, however
    // fresh the cache is: a message persisted while it was closed must appear.
    refetchOnMount: 'always',
  });
  const detail = query.data;
  const messages = detail?.messages ?? NO_MESSAGES;
  const firstItemIndex = usePrependAnchor(messages);

  // Opening a chat trims the cache to the most recently used transcripts.
  useEffect(() => {
    evictStaleTranscripts(queryClient, queryScope, queryKey);
  }, [queryClient, queryScope, queryKey]);

  const readDetail = useCallback(
    () => queryClient.getQueryData<ChatSessionDetailResponse>(queryKey),
    [queryClient, queryKey]
  );

  /** Adds live rows (socket deliveries, optimistic sends) in transcript order. */
  const appendMessages = useCallback(
    (incoming: ChatMessageResponse[]) => {
      queryClient.setQueryData<ChatSessionDetailResponse>(
        queryKey,
        (current) =>
          current && { ...current, messages: mergeMessages(current.messages, incoming, 'append') }
      );
    },
    [queryClient, queryKey]
  );

  /**
   * Merges a newest-window response (fallback poll, reconnect catch-up). A window
   * that no longer reaches back to the loaded tail drains the gap forward first,
   * so the transcript never keeps a hole.
   */
  const mergeRecentWindow = useCallback(
    async (recent: ChatSessionDetailResponse, signal?: AbortSignal) => {
      const current = readDetail() ?? { ...recent, messages: NO_MESSAGES };
      const merged = await mergeRecentWindowOrRefresh(
        projectId,
        sessionId,
        current,
        recent,
        signal
      );
      queryClient.setQueryData<ChatSessionDetailResponse>(queryKey, (latest) => ({
        ...(latest ?? merged),
        ...merged,
        // A window that carries no state snapshot must not erase the last known one.
        state: merged.state ?? latest?.state ?? null,
      }));
    },
    [projectId, queryClient, queryKey, readDetail, sessionId]
  );

  // Older history loads concurrently from two places (scroll-up paging and
  // jumps); `loadingMore` holds until the last of them settles, because a jump
  // resolves to the nearest message only once loading has stopped.
  const [olderLoadsInFlight, setOlderLoadsInFlight] = useState(0);
  const pageInFlightRef = useRef(false);

  const loadOlder = useCallback(
    async (read: (loaded: ChatMessageResponse[]) => Promise<OlderHistory>) => {
      const loaded = readDetail();
      if (!loaded) return;
      setOlderLoadsInFlight((count) => count + 1);
      try {
        const older = await read(loaded.messages);
        queryClient.setQueryData<ChatSessionDetailResponse>(
          queryKey,
          (current) =>
            current && {
              ...current,
              messages: mergeMessages(current.messages, older.messages, 'prepend'),
              hasMore: older.hasMore,
            }
        );
      } finally {
        setOlderLoadsInFlight((count) => count - 1);
      }
    },
    [queryClient, queryKey, readDetail]
  );

  /** Loads the next page of older history (the reader scrolled to the top). */
  const loadMore = useCallback(async () => {
    const loaded = readDetail();
    const before = loaded?.hasMore ? oldestPersistedCursor(loaded.messages) : undefined;
    if (!before || pageInFlightRef.current) return;
    pageInFlightRef.current = true;
    try {
      await loadOlder(() => getChatSession(projectId, sessionId, { before }));
    } catch (err) {
      // Best effort: the reader can scroll up again or use "Load earlier messages".
      console.warn('Failed to load earlier messages', err);
    } finally {
      pageInFlightRef.current = false;
    }
  }, [loadOlder, projectId, readDetail, sessionId]);

  /**
   * Loads older pages until `target` is loaded — the message itself when the
   * target names one — or history runs out. Jumps use it so a target older than
   * the loaded window never dead-clicks.
   */
  const loadUntil = useCallback(
    async (target: HistoryTarget) => {
      const loaded = readDetail();
      if (!loaded?.hasMore || historyReaches(loaded.messages, target)) return;
      try {
        await loadOlder((messagesLoaded) =>
          fetchHistoryUntil(projectId, sessionId, messagesLoaded, target)
        );
      } catch (err) {
        // The jump then settles on the nearest loaded message instead.
        console.warn('Failed to load history for a jump', err);
      }
    },
    [loadOlder, projectId, readDetail, sessionId]
  );

  return {
    /** The latest session detail, including the server's session and state snapshots. */
    detail,
    messages,
    hasMore: detail?.hasMore ?? false,
    /** Nothing loaded yet and a load is outstanding. */
    loading: query.isPending,
    /** Why the first load failed; a failed background refresh keeps the transcript. */
    error: !detail && query.error ? errorMessage(query.error) : null,
    loadingMore: olderLoadsInFlight > 0,
    firstItemIndex,
    appendMessages,
    mergeRecentWindow,
    loadMore,
    loadUntil,
  };
}

interface OlderHistory {
  messages: ChatMessageResponse[];
  hasMore: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Failed to load session';
}

/**
 * Virtuoso's `firstItemIndex` for a transcript that grows at both ends.
 *
 * Prepending older history must lower the index by exactly the rows it adds at
 * the front, in the same render as those rows, or every row's absolute index
 * shifts and the reader's scroll position jumps. The transcript reaches React
 * through the query cache, a macrotask after the write, so setting the index
 * beside the write cannot be made atomic; deriving it from the transcript is.
 *
 * Rows, not messages: a run of tool calls folds into one row, and a page whose
 * trailing call merges into the existing first group adds none (see
 * `countDisplayRows`). The count runs only when the first message changes, never
 * on the streaming append path.
 */
function usePrependAnchor(messages: readonly ChatMessageResponse[]): number {
  const firstId = messages[0]?.id ?? null;
  const [anchor, setAnchor] = useState({ firstId, index: VIRTUAL_START });
  if (anchor.firstId === firstId) return anchor.index;

  const previousFirst =
    anchor.firstId === null ? -1 : messages.findIndex((m) => m.id === anchor.firstId);
  const rowsAdded =
    previousFirst > 0
      ? countDisplayRows(messages) - countDisplayRows(messages.slice(previousFirst))
      : 0;
  const next = { firstId, index: anchor.index - Math.max(rowsAdded, 0) };
  // Adjusting state while rendering: React re-renders before committing, so the
  // new rows and the new index always land together.
  setAnchor(next);
  return next.index;
}
