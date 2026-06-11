import { useMemo } from 'react';

import type { ChatSessionListItem, ChatSessionResponse } from '../../lib/api';
import { getLineageText } from './lineageUtils';
import { SessionTreeItem } from './SessionTreeItem';
import type { TaskInfo } from './useTaskGroups';

/**
 * Renders a flat list of sessions.
 *
 * All tree nesting (expand/collapse, indentation, child rendering) has been
 * removed. The hierarchy button + modal is now the only way to explore
 * parent/child relationships.
 *
 * Retries and forks get lineage subtitle text via `getLineageText`.
 */
export function SessionList({
  sessions,
  selectedSessionId,
  onSelect,
  onFork,
  taskInfoMap,
  onShowHierarchy,
}: {
  /** Sessions to display (already filtered to the visible bucket). */
  sessions: ChatSessionListItem[];
  selectedSessionId: string | null;
  onSelect: (id: string) => void;
  onFork?: (session: ChatSessionResponse) => void;
  taskInfoMap: Map<string, TaskInfo>;
  onShowHierarchy: (taskId: string) => void;
}) {
  // Pre-compute lineage text for retries/forks
  const lineageMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sessions) {
      if (s.taskId) {
        const text = getLineageText(s.taskId, taskInfoMap, sessions);
        if (text) map.set(s.id, text);
      }
    }
    return map;
  }, [sessions, taskInfoMap]);

  return (
    <>
      {sessions.map((session) => (
        <SessionTreeItem
          key={session.id}
          session={session}
          selectedSessionId={selectedSessionId}
          onSelect={onSelect}
          onFork={onFork}
          taskInfoMap={taskInfoMap}
          onShowHierarchy={onShowHierarchy}
          lineageText={lineageMap.get(session.id)}
        />
      ))}
    </>
  );
}
