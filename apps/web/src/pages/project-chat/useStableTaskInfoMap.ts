import { useCallback, useRef, useState } from 'react';

import type { Task } from '@simple-agent-manager/shared';

import { buildTaskInfoMap, type TaskInfo } from './useTaskGroups';

/**
 * Maintains a stable `taskInfoMap` reference — only updates the Map when
 * the underlying data actually changes.
 *
 * Also supports incremental single-task updates so that a new session.created
 * event with a taskId doesn't force a full task list refetch.
 */
export function useStableTaskInfoMap() {
  const [taskInfoMap, setTaskInfoMap] = useState<Map<string, TaskInfo>>(new Map());
  const prevMapRef = useRef(taskInfoMap);

  const replaceAll = useCallback((tasks: Task[]) => {
    const next = buildTaskInfoMap(tasks);
    const prev = prevMapRef.current;
    if (mapsEqual(prev, next)) return;
    prevMapRef.current = next;
    setTaskInfoMap(next);
  }, []);

  const upsertTask = useCallback((task: Task) => {
    setTaskInfoMap((prev) => {
      const existing = prev.get(task.id);
      const info: TaskInfo = {
        id: task.id,
        title: task.title,
        parentTaskId: task.parentTaskId,
        status: task.status,
        blocked: task.blocked ?? false,
        triggeredBy: task.triggeredBy ?? 'user',
        dispatchDepth: task.dispatchDepth ?? 0,
        taskMode: task.taskMode,
      };
      if (existing && taskInfoEqual(existing, info)) return prev;
      const next = new Map(prev);
      next.set(task.id, info);
      prevMapRef.current = next;
      return next;
    });
  }, []);

  return { taskInfoMap, replaceAll, upsertTask };
}

function taskInfoEqual(a: TaskInfo, b: TaskInfo): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.parentTaskId === b.parentTaskId &&
    a.status === b.status &&
    a.blocked === b.blocked &&
    a.triggeredBy === b.triggeredBy &&
    a.dispatchDepth === b.dispatchDepth &&
    a.taskMode === b.taskMode
  );
}

function mapsEqual(a: Map<string, TaskInfo>, b: Map<string, TaskInfo>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, aVal] of a) {
    const bVal = b.get(key);
    if (!bVal || !taskInfoEqual(aVal, bVal)) return false;
  }
  return true;
}
