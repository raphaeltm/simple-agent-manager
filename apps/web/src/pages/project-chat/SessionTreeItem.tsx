import { memo, useMemo } from 'react';

import type { ChatSessionListItem, ChatSessionResponse } from '../../lib/api';
import { HierarchyIndicator } from './HierarchyIndicator';
import { SessionItem } from './SessionItem';
import type { TaskInfo } from './useTaskGroups';

/**
 * Flat session list item renderer.
 *
 * Wrapped in React.memo so unchanged sessions skip re-renders when the
 * sessions array updates from a WebSocket delta that only touches a
 * different session.
 *
 * The hierarchy indicator uses role-differentiated icons:
 * - GitBranch (blue) = parent ("Has subtasks")
 * - GitMerge (purple) = child ("Subtask")
 * - Network (amber) = both ("Has parent & subtasks")
 */
export const SessionTreeItem = memo(function SessionTreeItem({
  session,
  selectedSessionId,
  onSelect,
  taskInfoMap,
  onShowHierarchy,
  lineageText,
  showOwnership = true,
}: {
  session: ChatSessionListItem;
  selectedSessionId: string | null;
  onSelect: (id: string) => void;
  taskInfoMap: Map<string, TaskInfo>;
  onShowHierarchy?: (taskId: string) => void;
  lineageText?: string;
  showOwnership?: boolean;
}) {
  const taskInfo = session.taskId ? taskInfoMap.get(session.taskId) : undefined;

  // Enrich session with task status from D1 task data so that
  // getAttentionState() can distinguish completed/failed/cancelled tasks.
  const enrichedSession = useMemo((): ChatSessionResponse => {
    if (!taskInfo) return session;
    return {
      ...session,
      task: {
        id: taskInfo.id,
        status: taskInfo.status,
        taskMode: taskInfo.taskMode,
      },
    };
  }, [session, taskInfo]);

  const blockedByTitle = taskInfo?.blocked
    ? getBlockedByTitle(session, taskInfoMap)
    : undefined;

  const isSelected = selectedSessionId === session.id;

  const badge = onShowHierarchy && session.taskId ? (
    <HierarchyIndicator
      taskId={session.taskId}
      taskInfoMap={taskInfoMap}
      onShowHierarchy={onShowHierarchy}
    />
  ) : null;

  return (
    <div
      style={{
        background: isSelected
          ? 'var(--sam-color-bg-inset, #0d1816)'
          : 'transparent',
        borderBottom: '1px solid var(--sam-color-border-default, #29423b)',
      }}
      className={
        isSelected
          ? 'transition-colors'
          : 'transition-colors hover:bg-[var(--sam-color-bg-surface-hover)]'
      }
    >
      <SessionItem
        session={enrichedSession}
        isSelected={isSelected}
        onSelect={onSelect}
        variant="default"
        badge={badge}
        blockedBadge={taskInfo?.blocked}
        blockedByTitle={blockedByTitle}
        lineageText={lineageText}
        showOwnership={showOwnership}
      />
    </div>
  );
});

function getBlockedByTitle(
  session: ChatSessionListItem,
  taskInfoMap: Map<string, TaskInfo>,
): string | undefined {
  if (!session.taskId) return undefined;
  const info = taskInfoMap.get(session.taskId);
  if (!info?.parentTaskId) return undefined;
  const parentInfo = taskInfoMap.get(info.parentTaskId);
  return parentInfo?.title ?? 'parent task';
}
