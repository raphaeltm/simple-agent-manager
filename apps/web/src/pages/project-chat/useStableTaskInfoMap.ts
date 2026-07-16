import type { Task } from '@simple-agent-manager/shared';
import { useCallback, useRef, useState } from 'react';

import { buildTaskInfoMap, type TaskInfo } from './useTaskGroups';

/**
 * Maintains a stable `taskInfoMap` reference — only updates the Map when
 * the underlying data actually changes. Prevents downstream memo
 * invalidation when the task list is refetched with identical data.
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

  return { taskInfoMap, replaceAll };
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
