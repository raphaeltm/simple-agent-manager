import type { Task, TaskStatus } from '@simple-agent-manager/shared';

/**
 * Per-task metadata needed for rendering the session tree.
 *
 * This module used to own the legacy single-level `groupSessions()` grouping
 * helpers. Hierarchy rendering now lives in `sessionTree.ts` + `SessionTreeItem.tsx`,
 * which supports arbitrary depth. Only the task metadata shape remains here
 * because it's consumed by both the tree and (e.g.) session-state inference.
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
