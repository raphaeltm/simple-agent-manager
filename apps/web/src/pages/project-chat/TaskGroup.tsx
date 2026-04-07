import { ChevronDown, ChevronRight } from 'lucide-react';
import { useId, useState } from 'react';

import type { ChatSessionResponse } from '../../lib/api';
import { SessionItem } from './SessionItem';
import { SubTaskProgressBar } from './SubTaskProgressBar';
import type { SessionGroup, TaskInfo } from './useTaskGroups';

/**
 * Grouped card container for a parent task + its sub-tasks.
 *
 * Renders the parent with a strong green accent strip, children with
 * a faded green strip + green wash background. Groups are collapsible
 * and default to collapsed.
 */
export function TaskGroup({
  group,
  selectedSessionId,
  onSelect,
  onFork,
  taskInfoMap,
  defaultExpanded = false,
}: {
  group: SessionGroup;
  selectedSessionId: string | null;
  onSelect: (id: string) => void;
  onFork?: (session: ChatSessionResponse) => void;
  taskInfoMap: Map<string, TaskInfo>;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const childrenId = useId();

  const parentTaskInfo = group.parent.taskId
    ? taskInfoMap.get(group.parent.taskId)
    : undefined;
  const parentTitle = parentTaskInfo?.title;

  return (
    <div
      className="transition-colors"
      style={{
        margin: '4px 6px',
        borderRadius: 10,
        overflow: 'hidden',
        border: '1px solid var(--sam-color-border-default, #29423b)',
      }}
    >
      {/* Parent session item */}
      <div
        style={{
          borderLeft: '3px solid var(--sam-color-accent-primary, #16a34a)',
          background: selectedSessionId === group.parent.id
            ? 'var(--sam-color-bg-inset, #0d1816)'
            : 'var(--sam-color-bg-surface, #13201d)',
        }}
        className="transition-colors hover:!bg-[var(--sam-color-bg-surface-hover)]"
      >
        <SessionItem
          session={group.parent}
          isSelected={selectedSessionId === group.parent.id}
          onSelect={onSelect}
          onFork={onFork}
          ideaTitle={parentTitle}
          variant="group-parent"
          badge={
            <span
              style={{
                background: 'rgba(59,130,246,0.15)',
                color: '#60a5fa',
                padding: '0 5px',
                borderRadius: 9999,
                fontSize: 10,
                fontWeight: 600,
                textTransform: 'uppercase',
                whiteSpace: 'nowrap',
              }}
            >
              {group.totalChildren} SUB
            </span>
          }
          progressBar={
            <SubTaskProgressBar
              completed={group.completedChildren}
              total={group.totalChildren}
            />
          }
        />
      </div>

      {/* Expand/collapse toggle bar */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setExpanded(!expanded);
        }}
        className="w-full flex items-center gap-1 cursor-pointer border-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--sam-color-focus-ring)]"
        style={{
          padding: '12px 10px',
          minHeight: 44,
          background: 'rgba(22,163,74,0.03)',
          borderTop: '1px solid var(--sam-color-border-default, #29423b)',
          borderLeft: '3px solid rgba(22,163,74,0.25)',
          fontSize: 10,
          color: 'var(--sam-color-fg-muted)',
        }}
        aria-expanded={expanded}
        aria-controls={childrenId}
        aria-label={expanded ? 'Hide sub-tasks' : `Show ${group.totalChildren} sub-tasks`}
      >
        {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <span>
          {expanded ? 'Hide sub-tasks' : `Show ${group.totalChildren} sub-task${group.totalChildren !== 1 ? 's' : ''}`}
        </span>
      </button>

      {/* Child sessions */}
      <div id={childrenId}>
        {expanded && group.children.map((child) => {
          const childTaskInfo = child.taskId
            ? taskInfoMap.get(child.taskId)
            : undefined;
          const blockedByTitle = childTaskInfo?.blocked
            ? getBlockedByTitle(child, taskInfoMap)
            : undefined;

          return (
            <div
              key={child.id}
              style={{
                borderTop: '1px solid var(--sam-color-border-default, #29423b)',
                borderLeft: '3px solid rgba(22,163,74,0.25)',
                background: selectedSessionId === child.id
                  ? 'rgba(22,163,74,0.1)'
                  : 'rgba(22,163,74,0.03)',
              }}
              className="transition-colors hover:!bg-[var(--sam-color-bg-surface-hover)]"
            >
              <SessionItem
                session={child}
                isSelected={selectedSessionId === child.id}
                onSelect={onSelect}
                onFork={onFork}
                ideaTitle={childTaskInfo?.title}
                variant="group-child"
                blockedBadge={childTaskInfo?.blocked}
                blockedByTitle={blockedByTitle}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Find the title of the task that a blocked child is waiting on.
 * Uses the parent task title as fallback since full dependency data
 * isn't available in the list response.
 */
function getBlockedByTitle(
  session: ChatSessionResponse,
  taskInfoMap: Map<string, TaskInfo>,
): string | undefined {
  if (!session.taskId) return undefined;
  const info = taskInfoMap.get(session.taskId);
  if (!info?.parentTaskId) return undefined;
  const parentInfo = taskInfoMap.get(info.parentTaskId);
  return parentInfo?.title ?? 'parent task';
}
