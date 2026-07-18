import { useCallback, useEffect, useRef, useState } from 'react';

import type { SessionSummaryItem } from '../lib/api';
import { getAllChats } from '../lib/api';

export interface EnrichedChatSession extends SessionSummaryItem {
  /** Compat: maps to startedAt for ChatSessionListItem consumers. */
  createdAt: number;
}

interface UseAllChatSessionsResult {
  sessions: EnrichedChatSession[];
  loading: boolean;
  isRefreshing: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Fetches all chat sessions across all projects via a single D1 query.
 * Returns sessions enriched with projectId/projectName, sorted by recency.
 */
export function useAllChatSessions(): UseAllChatSessionsResult {
  const [sessions, setSessions] = useState<EnrichedChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const fetchIdRef = useRef(0);
  const hasLoadedRef = useRef(false);

  const fetchAll = useCallback(async () => {
    const id = ++fetchIdRef.current;
    cancelledRef.current = false;
    if (hasLoadedRef.current) {
      setIsRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      const res = await getAllChats({ limit: 100 });
      if (cancelledRef.current || id !== fetchIdRef.current) return;

      setSessions(
        res.sessions.map((s) => ({
          ...s,
          createdAt: s.startedAt,
        })),
      );
      hasLoadedRef.current = true;
      setLoading(false);
    } catch {
      if (!cancelledRef.current && id === fetchIdRef.current) {
        setError('Failed to load chat sessions');
        setLoading(false);
      }
    } finally {
      if (!cancelledRef.current && id === fetchIdRef.current) {
        setIsRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchAll();
    return () => {
      cancelledRef.current = true;
    };
  }, [fetchAll]);

  return { sessions, loading, isRefreshing, error, refresh: fetchAll };
}
