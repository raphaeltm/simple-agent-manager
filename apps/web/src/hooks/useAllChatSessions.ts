import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatSessionResponse } from '../lib/api';
import { listChatSessions,listProjects } from '../lib/api';
import { getLastActivity } from '../lib/chat-session-utils';

/** Default max projects to fetch. Override via VITE_ALL_CHATS_PROJECT_LIMIT. */
const DEFAULT_PROJECT_LIMIT = 50;
/** Default max sessions per project. Override via VITE_ALL_CHATS_SESSION_LIMIT. */
const DEFAULT_SESSION_LIMIT = 20;

const PROJECT_LIMIT = parseInt(
  import.meta.env.VITE_ALL_CHATS_PROJECT_LIMIT || String(DEFAULT_PROJECT_LIMIT),
);
const SESSION_LIMIT = parseInt(
  import.meta.env.VITE_ALL_CHATS_SESSION_LIMIT || String(DEFAULT_SESSION_LIMIT),
);

export interface EnrichedChatSession extends ChatSessionResponse {
  projectId: string;
  projectName: string;
}

interface UseAllChatSessionsResult {
  sessions: EnrichedChatSession[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Fetches chat sessions from all projects via fan-out (list projects → listChatSessions per project).
 * Returns sessions enriched with projectId/projectName, sorted by lastMessageAt DESC.
 */
export function useAllChatSessions(): UseAllChatSessionsResult {
  const [sessions, setSessions] = useState<EnrichedChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const fetchIdRef = useRef(0);

  const fetchAll = useCallback(async () => {
    const id = ++fetchIdRef.current;
    cancelledRef.current = false;
    setLoading(true);
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
            .catch(() => [] as EnrichedChatSession[]),
        ),
      );

      if (cancelledRef.current || id !== fetchIdRef.current) return;

      const allSessions = sessionResults.flat();
      allSessions.sort((a, b) => getLastActivity(b) - getLastActivity(a));

      setSessions(allSessions);
      setLoading(false);
    } catch {
      if (!cancelledRef.current && id === fetchIdRef.current) {
        setError('Failed to load chat sessions');
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchAll();
    return () => {
      cancelledRef.current = true;
    };
  }, [fetchAll]);

  return { sessions, loading, error, refresh: fetchAll };
}
