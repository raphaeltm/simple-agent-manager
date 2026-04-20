import { useMemo } from 'react';

import type { ChatSessionResponse } from '../../lib/api';
import { buildSessionTree } from './sessionTree';
import { SessionTreeItem } from './SessionTreeItem';
import type { TaskInfo } from './useTaskGroups';

/**
 * Renders a list of sessions as a hierarchical tree derived from
 * `task.parentTaskId`. Supports arbitrary nesting depth.
 *
 * When `allSessions` is provided, ancestors that exist in the full session
 * list but NOT in `sessions` (e.g. a stopped/stale parent of a currently
 * active nested session) are lifted in as dimmed "context anchor" rows so
 * the descendant remains visible with its lineage intact.
 */
export function SessionList({
  sessions,
  allSessions,
  selectedSessionId,
  onSelect,
  onFork,
  taskInfoMap,
  searchQuery = '',
}: {
  /** Sessions to display (already filtered to the visible bucket, e.g. recent or stale). */
  sessions: ChatSessionResponse[];
  /** Full session list for resolving lineage across buckets (optional). */
  allSessions?: ChatSessionResponse[];
  selectedSessionId: string | null;
  onSelect: (id: string) => void;
  onFork?: (session: ChatSessionResponse) => void;
  /** Retained for API compatibility but no longer used directly — titles come from taskInfoMap. */
  taskTitleMap?: Map<string, string>;
  taskInfoMap: Map<string, TaskInfo>;
  searchQuery?: string;
}) {
  const roots = useMemo(
    () => buildSessionTree(sessions, taskInfoMap, { allSessions }),
    [sessions, allSessions, taskInfoMap],
  );

  return (
    <>
      {roots.map((root) => (
        <SessionTreeItem
          key={root.session.id}
          node={root}
          selectedSessionId={selectedSessionId}
          onSelect={onSelect}
          onFork={onFork}
          taskInfoMap={taskInfoMap}
          searchQuery={searchQuery}
        />
      ))}
    </>
  );
}
