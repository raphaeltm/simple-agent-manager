import { useMemo } from 'react';

import type { ChatSessionListItem } from '../../lib/api';
import { isStaleSession } from '../../lib/chat-session-utils';
import { stripMarkdown } from '../../lib/text-utils';
import { isRetryOrFork } from './lineageUtils';
import type { TaskInfo } from './useTaskGroups';

function matchesQuery(session: ChatSessionListItem, query: string): boolean {
  return (
    Boolean(session.topic && stripMarkdown(session.topic).toLowerCase().includes(query)) ||
    session.id.includes(query) ||
    (session.createdBy?.name?.toLowerCase().includes(query) ?? false) ||
    (session.createdBy?.email?.toLowerCase().includes(query) ?? false)
  );
}

/**
 * The session list's Recent and Older buckets, filtered by the sidebar search. Searching
 * always shows Older, so a match there is never hidden behind its collapsed group.
 */
export function useSessionFilters(
  sessions: ChatSessionListItem[],
  taskInfoMap: Map<string, TaskInfo>,
  searchQuery: string,
  showStale: boolean
) {
  const { recentSessions, staleSessions } = useMemo(() => {
    const recent: ChatSessionListItem[] = [];
    const stale: ChatSessionListItem[] = [];
    for (const s of sessions) {
      // Stopped retries/forks auto-collapse into the Older bucket.
      // A stopped retry/fork is a terminated session whose task has a
      // parentTaskId and was user-triggered (not agent-dispatched).
      const isStoppedRetryOrFork = (() => {
        if (s.status !== 'stopped' || !s.taskId) return false;
        const info = taskInfoMap.get(s.taskId);
        if (!info?.parentTaskId) return false;
        return isRetryOrFork(info);
      })();

      if (isStaleSession(s) || isStoppedRetryOrFork) stale.push(s);
      else recent.push(s);
    }
    return { recentSessions: recent, staleSessions: stale };
  }, [sessions, taskInfoMap]);

  const filteredRecent = useMemo(() => {
    if (!searchQuery.trim()) return recentSessions;
    const q = searchQuery.toLowerCase();
    return recentSessions.filter((s) => matchesQuery(s, q));
  }, [recentSessions, searchQuery]);

  const filteredStale = useMemo(() => {
    if (!searchQuery.trim()) return staleSessions;
    const q = searchQuery.toLowerCase();
    return staleSessions.filter((s) => matchesQuery(s, q));
  }, [staleSessions, searchQuery]);

  return {
    filteredRecent,
    filteredStale,
    effectiveShowStale: showStale || !!searchQuery.trim(),
  };
}
