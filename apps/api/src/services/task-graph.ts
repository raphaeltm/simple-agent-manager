import type { TaskStatus } from '@simple-agent-manager/shared';

export interface TaskDependencyEdge {
  taskId: string;
  dependsOnTaskId: string;
}

export function wouldCreateTaskDependencyCycle(
  taskId: string,
  dependsOnTaskId: string,
  edges: TaskDependencyEdge[]
): boolean {
  if (taskId === dependsOnTaskId) {
    return true;
  }

  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const current = adjacency.get(edge.taskId) ?? [];
    current.push(edge.dependsOnTaskId);
    adjacency.set(edge.taskId, current);
  }

  const nextEdges = adjacency.get(taskId) ?? [];
  nextEdges.push(dependsOnTaskId);
  adjacency.set(taskId, nextEdges);

  const visited = new Set<string>();
  const stack = [dependsOnTaskId];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    if (current === taskId) {
      return true;
    }

    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    const neighbors = adjacency.get(current) ?? [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        stack.push(neighbor);
      }
    }
  }

  return false;
}

export function isTaskBlocked(
  taskId: string,
  edges: TaskDependencyEdge[],
  statusesByTaskId: Record<string, TaskStatus>
): boolean {
  for (const edge of edges) {
    if (edge.taskId !== taskId) {
      continue;
    }

    if (statusesByTaskId[edge.dependsOnTaskId] !== 'completed') {
      return true;
    }
  }

  return false;
}

export function getBlockedTaskIds(
  taskIds: string[],
  edges: TaskDependencyEdge[],
  statusesByTaskId: Record<string, TaskStatus>
): Set<string> {
  const blocked = new Set<string>();

  for (const taskId of taskIds) {
    if (isTaskBlocked(taskId, edges, statusesByTaskId)) {
      blocked.add(taskId);
    }
  }

  return blocked;
}
