import type { ChatSessionResponse } from '../../lib/api';
import type { TaskInfo } from './useTaskGroups';

/**
 * Compute lineage text for a task that has a parentTaskId and is user-triggered
 * (retry or fork). Returns undefined if the task is not a retry/fork.
 */
export function getLineageText(
  taskId: string,
  taskInfoMap: Map<string, TaskInfo>,
  sessions: ChatSessionResponse[],
): string | undefined {
  const info = taskInfoMap.get(taskId);
  if (!info?.parentTaskId) return undefined;

  // Only user-triggered tasks are retries/forks (not agent-dispatched subtasks)
  if (info.triggeredBy === 'mcp') return undefined;

  // Build a taskId -> session map for label resolution
  const taskToSession = new Map<string, ChatSessionResponse>();
  for (const s of sessions) {
    if (s.taskId) taskToSession.set(s.taskId, s);
  }

  const parentInfo = taskInfoMap.get(info.parentTaskId);
  const parentSession = parentInfo ? taskToSession.get(info.parentTaskId) : undefined;
  const parentLabel = parentSession?.topic
    ? parentSession.topic.slice(0, 30) + (parentSession.topic.length > 30 ? '…' : '')
    : parentInfo?.title
      ? parentInfo.title.slice(0, 30) + (parentInfo.title.length > 30 ? '…' : '')
      : 'earlier attempt';

  // Count siblings sharing the same parent that are also retries/forks
  const siblings: { taskId: string; startedAt: number }[] = [];
  for (const [, ti] of taskInfoMap) {
    if (ti.parentTaskId === info.parentTaskId && ti.triggeredBy !== 'mcp') {
      const sess = taskToSession.get(ti.id);
      siblings.push({ taskId: ti.id, startedAt: sess?.startedAt ?? 0 });
    }
  }

  if (siblings.length <= 1) {
    return `⑂ from ${parentLabel}`;
  }

  siblings.sort((a, b) => a.startedAt - b.startedAt);
  const attemptIndex = siblings.findIndex((s) => s.taskId === taskId);
  return `↩ attempt ${attemptIndex + 2}`;
}
