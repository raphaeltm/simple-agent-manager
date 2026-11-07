import { useMemo } from 'react';

import type { ChatSessionListItem } from '../../lib/api';
import {
  getLastActivity,
  getSessionSection,
  SESSION_SECTION_ORDER,
  type SessionSection,
} from '../../lib/chat-session-utils';
import { stripMarkdown } from '../../lib/text-utils';
import { enrichSessionWithTaskInfo, type TaskInfo } from './useTaskGroups';

export type SessionSections = Record<SessionSection, ChatSessionListItem[]>;

function matchesSessionQuery(session: ChatSessionListItem, query: string): boolean {
  return (
    Boolean(session.topic && stripMarkdown(session.topic).toLowerCase().includes(query)) ||
    session.id.includes(query) ||
    (session.createdBy?.name?.toLowerCase().includes(query) ?? false) ||
    (session.createdBy?.email?.toLowerCase().includes(query) ?? false)
  );
}

/** Most recent conversation first; the id breaks ties so the order is stable. */
function byRecency(a: ChatSessionListItem, b: ChatSessionListItem): number {
  return getLastActivity(b) - getLastActivity(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/** Group sessions into the list's sections, each in conversation-recency order. */
export function groupSessionsBySection(
  sessions: ChatSessionListItem[],
  taskInfoMap: Map<string, TaskInfo>
): SessionSections {
  const sections: SessionSections = { attention: [], awake: [], sleeping: [], history: [] };
  for (const s of sessions) {
    const taskInfo = s.taskId ? taskInfoMap.get(s.taskId) : undefined;
    sections[getSessionSection(enrichSessionWithTaskInfo(s, taskInfo))].push(s);
  }
  for (const section of SESSION_SECTION_ORDER) sections[section].sort(byRecency);
  return sections;
}

/**
 * The session list's sections (Needs attention, Awake, Sleeping, History), filtered by the
 * search box. Shared by the desktop sidebar and the mobile drawer. `attentionCount` ignores
 * the search so a badge never hides a blocked session behind an unrelated query.
 */
export function useSessionSections(
  sessions: ChatSessionListItem[],
  taskInfoMap: Map<string, TaskInfo>,
  searchQuery: string
) {
  const sections = useMemo(
    () => groupSessionsBySection(sessions, taskInfoMap),
    [sessions, taskInfoMap]
  );

  const query = searchQuery.trim().toLowerCase();
  const filteredSections = useMemo((): SessionSections => {
    if (!query) return sections;
    const filter = (list: ChatSessionListItem[]) =>
      list.filter((s) => matchesSessionQuery(s, query));
    return {
      attention: filter(sections.attention),
      awake: filter(sections.awake),
      sleeping: filter(sections.sleeping),
      history: filter(sections.history),
    };
  }, [sections, query]);

  return {
    sections: filteredSections,
    attentionCount: sections.attention.length,
    isSearching: query.length > 0,
  };
}
