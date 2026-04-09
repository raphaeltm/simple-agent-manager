import { Clock } from 'lucide-react';
import { useMemo } from 'react';

import type { ChatSessionResponse } from '../../lib/api';
import { SessionItem } from './SessionItem';
import { TaskGroup } from './TaskGroup';
import { groupHasMatchingChild, groupSessions, type TaskInfo } from './useTaskGroups';

/** Returns a small clock badge for triggered sessions, or undefined. */
function triggerBadge(session: ChatSessionResponse, taskInfoMap: Map<string, TaskInfo>) {
  if (!session.taskId) return undefined;
  const info = taskInfoMap.get(session.taskId);
  if (!info || info.triggeredBy === 'user') return undefined;
  return (
    <span
      className="inline-flex items-center gap-0.5 text-[9px] font-semibold px-1 py-0 rounded-full whitespace-nowrap"
      style={{
        color: 'var(--sam-color-info, #3b82f6)',
        background: 'color-mix(in srgb, var(--sam-color-info, #3b82f6) 12%, transparent)',
      }}
      title="Triggered by automation"
    >
      <Clock size={8} /> AUTO
    </span>
  );
}

/**
 * Renders a list of sessions with task-hierarchy grouping.
 *
 * Parent tasks with sub-tasks are rendered in grouped card containers.
 * Standalone sessions render as normal flat items.
 */
export function SessionList({
  sessions,
  selectedSessionId,
  onSelect,
  onFork,
  taskTitleMap,
  taskInfoMap,
  searchQuery = '',
}: {
  sessions: ChatSessionResponse[];
  selectedSessionId: string | null;
  onSelect: (id: string) => void;
  onFork?: (session: ChatSessionResponse) => void;
  taskTitleMap: Map<string, string>;
  taskInfoMap: Map<string, TaskInfo>;
  searchQuery?: string;
}) {
  const renderItems = useMemo(
    () => groupSessions(sessions, taskInfoMap),
    [sessions, taskInfoMap],
  );

  return (
    <>
      {renderItems.map((item) => {
        if (item.type === 'group') {
          const { group } = item;
          // When searching, auto-expand if a child matches
          const hasChildMatch = searchQuery
            ? groupHasMatchingChild(group, searchQuery, taskInfoMap)
            : false;

          return (
            <TaskGroup
              key={group.parent.id}
              group={group}
              selectedSessionId={selectedSessionId}
              onSelect={onSelect}
              onFork={onFork}
              taskInfoMap={taskInfoMap}
              defaultExpanded={hasChildMatch}
            />
          );
        }

        const session = item.session;
        return (
          <SessionItem
            key={session.id}
            session={session}
            isSelected={session.id === selectedSessionId}
            onSelect={onSelect}
            onFork={onFork}
            ideaTitle={session.taskId ? taskTitleMap.get(session.taskId) : undefined}
            badge={triggerBadge(session, taskInfoMap)}
          />
        );
      })}
    </>
  );
}
