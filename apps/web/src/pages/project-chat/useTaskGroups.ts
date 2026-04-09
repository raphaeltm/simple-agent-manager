import type { Task, TaskStatus } from '@simple-agent-manager/shared';
import { useMemo } from 'react';

import type { ChatSessionResponse } from '../../lib/api';

/**
 * Per-task metadata needed for grouping and display.
 */
export interface TaskInfo {
  id: string;
  title: string;
  parentTaskId: string | null;
  status: TaskStatus;
  blocked: boolean;
  /** What created this task (user, cron, webhook, mcp). */
  triggeredBy: string;
}

/**
 * A group of sessions: a parent session plus its child sessions.
 */
export interface SessionGroup {
  /** The parent session (has children). */
  parent: ChatSessionResponse;
  /** Child sessions ordered by creation time. */
  children: ChatSessionResponse[];
  /** Number of completed child tasks. */
  completedChildren: number;
  /** Total number of child tasks. */
  totalChildren: number;
}

/**
 * A render item: either a standalone session or a grouped parent+children.
 */
export type SessionRenderItem =
  | { type: 'standalone'; session: ChatSessionResponse }
  | { type: 'group'; group: SessionGroup };

/**
 * Build a map from taskId to TaskInfo from a tasks array.
 */
export function buildTaskInfoMap(tasks: Task[]): Map<string, TaskInfo> {
  const map = new Map<string, TaskInfo>();
  for (const t of tasks) {
    map.set(t.id, {
      id: t.id,
      title: t.title,
      parentTaskId: t.parentTaskId,
      status: t.status,
      blocked: t.blocked ?? false,
      triggeredBy: t.triggeredBy ?? 'user',
    });
  }
  return map;
}

/** Terminal task statuses that count as "completed" for progress. */
const COMPLETED_STATUSES = new Set<TaskStatus>(['completed']);

/**
 * Group a flat session list into SessionRenderItems using task hierarchy.
 *
 * Sessions whose task has a parentTaskId are children. Sessions whose task
 * has children in the list are parents. Sessions with no task or no
 * parent-child relationship are standalone.
 */
export function groupSessions(
  sessions: ChatSessionResponse[],
  taskInfoMap: Map<string, TaskInfo>,
): SessionRenderItem[] {
  // Build taskId -> session mapping
  const taskToSession = new Map<string, ChatSessionResponse>();
  for (const s of sessions) {
    if (s.taskId) {
      taskToSession.set(s.taskId, s);
    }
  }

  // Find which tasks are parents (have children in the current session list)
  const parentTaskIds = new Set<string>();
  const childTaskIds = new Set<string>();

  for (const s of sessions) {
    if (!s.taskId) continue;
    const info = taskInfoMap.get(s.taskId);
    if (!info?.parentTaskId) continue;
    // Only group if the parent session is also in the list
    if (taskToSession.has(info.parentTaskId)) {
      parentTaskIds.add(info.parentTaskId);
      childTaskIds.add(s.taskId);
    }
  }

  // Build groups
  const groups = new Map<string, SessionGroup>();
  for (const parentTaskId of parentTaskIds) {
    const parentSession = taskToSession.get(parentTaskId)!;
    groups.set(parentTaskId, {
      parent: parentSession,
      children: [],
      completedChildren: 0,
      totalChildren: 0,
    });
  }

  // Assign children to groups
  for (const s of sessions) {
    if (!s.taskId) continue;
    const info = taskInfoMap.get(s.taskId);
    if (!info?.parentTaskId) continue;
    const group = groups.get(info.parentTaskId);
    if (!group) continue;
    group.children.push(s);
    group.totalChildren++;
    if (COMPLETED_STATUSES.has(info.status)) {
      group.completedChildren++;
    }
  }

  // Build render items preserving original order (parent position)
  const processedSessionIds = new Set<string>();
  const result: SessionRenderItem[] = [];

  for (const s of sessions) {
    if (processedSessionIds.has(s.id)) continue;

    if (s.taskId && childTaskIds.has(s.taskId)) {
      // Skip — this session will be rendered as part of its parent group
      continue;
    }

    if (s.taskId && parentTaskIds.has(s.taskId)) {
      const group = groups.get(s.taskId)!;
      result.push({ type: 'group', group });
      processedSessionIds.add(s.id);
      for (const child of group.children) {
        processedSessionIds.add(child.id);
      }
    } else {
      result.push({ type: 'standalone', session: s });
      processedSessionIds.add(s.id);
    }
  }

  return result;
}

/**
 * Check if a search query matches any child in a group.
 */
export function groupHasMatchingChild(
  group: SessionGroup,
  query: string,
  taskInfoMap: Map<string, TaskInfo>,
): boolean {
  const q = query.toLowerCase();
  return group.children.some((child) => {
    const topic = child.topic?.toLowerCase() ?? '';
    const taskTitle = child.taskId
      ? (taskInfoMap.get(child.taskId)?.title?.toLowerCase() ?? '')
      : '';
    return topic.includes(q) || child.id.includes(q) || taskTitle.includes(q);
  });
}

/**
 * Hook that provides grouped session render items and task info.
 */
export function useTaskGroups(
  sessions: ChatSessionResponse[],
  taskInfoMap: Map<string, TaskInfo>,
) {
  const renderItems = useMemo(
    () => groupSessions(sessions, taskInfoMap),
    [sessions, taskInfoMap],
  );

  return { renderItems };
}
