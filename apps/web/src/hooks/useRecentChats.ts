import { useCallback, useEffect, useRef, useState } from 'react';

import type { SessionSummaryItem } from '../lib/api';
import { getRecentChats } from '../lib/api';
import { STALE_SESSION_THRESHOLD_MS } from '../lib/chat-session-utils';

/** Default polling interval when dropdown is open (ms). Override via VITE_RECENT_CHATS_POLL_MS. */
const DEFAULT_POLL_MS = 30_000;
/** Max sessions to show in the dropdown. Override via VITE_RECENT_CHATS_LIMIT. */
const DEFAULT_DISPLAY_LIMIT = 8;

const POLL_MS = parseInt(
  import.meta.env.VITE_RECENT_CHATS_POLL_MS || String(DEFAULT_POLL_MS),
);
const DISPLAY_LIMIT = parseInt(
  import.meta.env.VITE_RECENT_CHATS_LIMIT || String(DEFAULT_DISPLAY_LIMIT),
);

export interface RecentChat extends SessionSummaryItem {
  /** Compat: maps to startedAt for ChatSessionListItem consumers. */
  createdAt: number;
}

interface UseRecentChatsResult {
  chats: RecentChat[];
  activeCount: number;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Fetches recent active chat sessions across all projects via a single D1 query.
 * Polls at a configurable interval when `enabled` is true and the tab is visible.
 */
export function useRecentChats(enabled: boolean): UseRecentChatsResult {
  const [chats, setChats] = useState<RecentChat[]>([]);
  const [activeCount, setActiveCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchIdRef = useRef(0);
  const cancelledRef = useRef(false);
  const hasFetchedRef = useRef(false);

  const fetchAll = useCallback(async () => {
    const id = ++fetchIdRef.current;
    cancelledRef.current = false;

    // Only show loading spinner on first fetch
    if (!hasFetchedRef.current) {
      setLoading(true);
    }
    setError(null);

    try {
      const res = await getRecentChats({
        limit: DISPLAY_LIMIT,
        staleThreshold: STALE_SESSION_THRESHOLD_MS,
      });
      if (cancelledRef.current || id !== fetchIdRef.current) return;

      setActiveCount(res.totalActive);
      setChats(
        res.sessions.map((s) => ({
          ...s,
          createdAt: s.startedAt,
        })),
      );
      setLoading(false);
      hasFetchedRef.current = true;
    } catch {
      if (!cancelledRef.current && id === fetchIdRef.current) {
        setError('Failed to load chats');
        setLoading(false);
      }
    }
  }, []);

  // Fetch on mount and when enabled changes to true
  useEffect(() => {
    if (!enabled) return;

    fetchAll();

    return () => {
      cancelledRef.current = true;
    };
  }, [enabled, fetchAll]);

  // Visibility-aware polling: poll only when enabled, tab visible, and interval > 0
  useEffect(() => {
    if (!enabled || POLL_MS <= 0) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      if (intervalId) return;
      intervalId = setInterval(fetchAll, POLL_MS);
    };

    const stopPolling = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        // Refresh immediately when tab becomes visible, then resume polling
        fetchAll();
        startPolling();
      } else {
        stopPolling();
      }
    };

    // Start polling if tab is currently visible
    if (document.visibilityState === 'visible') {
      startPolling();
    }

    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [enabled, fetchAll]);

  return { chats, activeCount, loading, error, refresh: fetchAll };
}
