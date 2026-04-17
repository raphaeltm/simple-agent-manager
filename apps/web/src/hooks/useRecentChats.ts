import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatSessionResponse } from '../lib/api';
import { listChatSessions, listProjects } from '../lib/api';
import {
  getLastActivity,
  isActiveSession,
  isStaleSession,
} from '../lib/chat-session-utils';

/** Default polling interval when dropdown is open (ms). Override via VITE_RECENT_CHATS_POLL_MS. */
const DEFAULT_POLL_MS = 30_000;
/** Max sessions to show in the dropdown. Override via VITE_RECENT_CHATS_LIMIT. */
const DEFAULT_DISPLAY_LIMIT = 8;
/** Max projects to query. Override via VITE_RECENT_CHATS_PROJECT_LIMIT. */
const DEFAULT_PROJECT_LIMIT = 50;
/** Max sessions per project to query. */
const SESSION_LIMIT = 10;

const POLL_MS = parseInt(
  import.meta.env.VITE_RECENT_CHATS_POLL_MS || String(DEFAULT_POLL_MS),
);
const DISPLAY_LIMIT = parseInt(
  import.meta.env.VITE_RECENT_CHATS_LIMIT || String(DEFAULT_DISPLAY_LIMIT),
);
const PROJECT_LIMIT = parseInt(
  import.meta.env.VITE_RECENT_CHATS_PROJECT_LIMIT || String(DEFAULT_PROJECT_LIMIT),
);

export interface RecentChat extends ChatSessionResponse {
  projectId: string;
  projectName: string;
}

interface UseRecentChatsResult {
  chats: RecentChat[];
  activeCount: number;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Fetches recent active chat sessions across all projects.
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
      const projectsRes = await listProjects(PROJECT_LIMIT);
      if (cancelledRef.current || id !== fetchIdRef.current) return;

      const projectList = 'projects' in projectsRes ? projectsRes.projects : [];

      const sessionResults = await Promise.all(
        projectList.map((project) =>
          listChatSessions(project.id, { limit: SESSION_LIMIT })
            .then((res) =>
              res.sessions.map((s) => ({
                ...s,
                projectId: project.id,
                projectName: project.name,
              })),
            )
            .catch(() => [] as RecentChat[]),
        ),
      );

      if (cancelledRef.current || id !== fetchIdRef.current) return;

      const allSessions = sessionResults.flat();
      const active = allSessions.filter((s) => !isStaleSession(s) && isActiveSession(s));
      active.sort((a, b) => getLastActivity(b) - getLastActivity(a));

      setActiveCount(active.length);
      setChats(active.slice(0, DISPLAY_LIMIT));
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
