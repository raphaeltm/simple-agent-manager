import type { Task, TaskExecutionStep, TaskMode, TaskStatus } from '@simple-agent-manager/shared';

import type { ChatSessionListItem, ChatSessionResponse } from '../../lib/api';

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
  terminalReason?: string | null;
  errorMessage?: string | null;
  executionStep?: TaskExecutionStep | null;
  blocked: boolean;
  /** What created this task (user, cron, webhook, mcp). */
  triggeredBy: string;
  connectorClientName?: string | null;
  /** Dispatch generation (0 = user-created, >0 = agent-dispatched). */
  dispatchDepth: number;
  /** Task execution mode: 'task' (autonomous) or 'conversation' (interactive). */
  taskMode: TaskMode;
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
      terminalReason: t.terminalReason,
      errorMessage: t.errorMessage,
      executionStep: t.executionStep,
      blocked: t.blocked ?? false,
      triggeredBy: t.triggeredBy ?? 'user',
      connectorClientName: t.connectorClientName,
      dispatchDepth: t.dispatchDepth ?? 0,
      taskMode: t.taskMode,
    });
  }
  return map;
}

/**
 * Merge a session's task metadata from the task list into the session, so state helpers
 * such as `getAttentionState()` can tell completed, failed and cancelled tasks apart. A
 * task outcome the list API already embedded wins over the separately fetched task page.
 */
export function enrichSessionWithTaskInfo(
  session: ChatSessionListItem,
  taskInfo: TaskInfo | undefined
): ChatSessionResponse {
  if (!taskInfo) return session;
  return {
    ...session,
    task: {
      id: taskInfo.id,
      triggeredBy: taskInfo.triggeredBy,
      connectorClientName: taskInfo.connectorClientName,
      status: taskInfo.status,
      terminalReason: taskInfo.terminalReason,
      errorMessage: taskInfo.errorMessage,
      executionStep: taskInfo.executionStep,
      taskMode: taskInfo.taskMode,
      ...(session as ChatSessionResponse).task,
    },
  };
}
