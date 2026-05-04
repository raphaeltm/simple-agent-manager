import type { ChatSessionResponse } from '../../lib/api';
import type { TaskInfo } from './useTaskGroups';

/**
 * User-triggered tasks with a parentTaskId are retries/forks. Agent-dispatched
 * tasks stay nested as subtasks.
 *
 * Uses both `triggeredBy` and `dispatchDepth` to classify: tasks with
 * `triggeredBy === 'mcp'` OR `dispatchDepth > 0` are subtasks (not retries).
 * The `dispatchDepth` fallback handles existing tasks in the DB that were
 * inserted before the `triggered_by = 'mcp'` fix.
 */
export function isRetryOrFork(taskInfo: TaskInfo): boolean {
  if (taskInfo.triggeredBy === 'mcp') return false;
  if (taskInfo.dispatchDepth > 0) return false;
  return true;
}

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

  if (!isRetryOrFork(info)) return undefined;

  const taskToSession = new Map<string, ChatSessionResponse>();
  for (const s of sessions) {
    if (s.taskId) taskToSession.set(s.taskId, s);
  }

  return buildLineageText(info, taskInfoMap, taskToSession);
}

export function buildLineageText(
  taskInfo: TaskInfo,
  taskInfoMap: Map<string, TaskInfo>,
  sessionsByTaskId: Map<string, ChatSessionResponse>,
): string {
  if (!taskInfo.parentTaskId) return '';

  const parentInfo = taskInfoMap.get(taskInfo.parentTaskId);
  const parentSession = parentInfo ? sessionsByTaskId.get(taskInfo.parentTaskId) : undefined;
  const parentLabel = parentSession?.topic
    ? parentSession.topic.slice(0, 30) + (parentSession.topic.length > 30 ? '…' : '')
    : parentInfo?.title
      ? parentInfo.title.slice(0, 30) + (parentInfo.title.length > 30 ? '…' : '')
      : 'earlier attempt';

  const siblings: { taskId: string; startedAt: number }[] = [];
  for (const [, ti] of taskInfoMap) {
    if (ti.parentTaskId === taskInfo.parentTaskId && isRetryOrFork(ti)) {
      const sess = sessionsByTaskId.get(ti.id);
      siblings.push({ taskId: ti.id, startedAt: sess?.startedAt ?? 0 });
    }
  }

  if (siblings.length <= 1) {
    return `⑂ from ${parentLabel}`;
  }

  siblings.sort((a, b) => a.startedAt - b.startedAt);
  const attemptIndex = siblings.findIndex((s) => s.taskId === taskInfo.id);
  return `↩ attempt ${attemptIndex + 2}`;
}
