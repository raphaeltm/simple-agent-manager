/**
 * Scheduler State Computation — deterministic classification of mission tasks.
 *
 * Computes the scheduler_state for each task in a mission based on:
 * - Task status (completed, failed, running, queued, etc.)
 * - Dependency graph (blocked if any dependency is incomplete)
 *
 * This is a pure function that takes task and dependency data and returns
 * the computed scheduler state for each task.
 */
import type { SchedulerState } from '@simple-agent-manager/shared';

export interface TaskForScheduling {
  id: string;
  status: string;
  missionId: string | null;
}

export interface DependencyEdge {
  taskId: string;
  dependsOnTaskId: string;
}

const TERMINAL_STATUSES = new Set(['completed', 'cancelled']);
const FAILED_STATUSES = new Set(['failed']);
const RUNNING_STATUSES = new Set(['running', 'delegated']);
const ACTIVE_STATUSES = new Set(['queued', 'provisioning']);

/**
 * Compute scheduler state for all tasks in a mission.
 * Returns a map of taskId -> SchedulerState.
 */
export function computeSchedulerStates(
  tasks: TaskForScheduling[],
  dependencies: DependencyEdge[],
): Map<string, SchedulerState> {
  const result = new Map<string, SchedulerState>();

  // Build dependency lookup: taskId -> set of dependsOnTaskIds
  const depsOf = new Map<string, Set<string>>();
  for (const dep of dependencies) {
    if (!depsOf.has(dep.taskId)) depsOf.set(dep.taskId, new Set());
    depsOf.get(dep.taskId)!.add(dep.dependsOnTaskId);
  }

  // Build task status lookup
  const taskStatus = new Map<string, string>();
  for (const task of tasks) {
    taskStatus.set(task.id, task.status);
  }

  for (const task of tasks) {
    result.set(task.id, computeSingleState(task, depsOf.get(task.id), taskStatus));
  }

  return result;
}

function computeSingleState(
  task: TaskForScheduling,
  deps: Set<string> | undefined,
  taskStatus: Map<string, string>,
): SchedulerState {
  // Terminal states map directly
  if (TERMINAL_STATUSES.has(task.status)) return task.status === 'completed' ? 'completed' : 'cancelled';
  if (FAILED_STATUSES.has(task.status)) return 'failed';
  if (RUNNING_STATUSES.has(task.status)) return 'running';

  // Check dependencies for queued/active tasks
  if (deps && deps.size > 0) {
    let hasIncomplete = false;
    let hasFailed = false;

    for (const depId of deps) {
      const depStatus = taskStatus.get(depId);
      if (!depStatus || !TERMINAL_STATUSES.has(depStatus)) {
        hasIncomplete = true;
      }
      if (depStatus && FAILED_STATUSES.has(depStatus)) {
        hasFailed = true;
      }
    }

    if (hasFailed) return 'blocked_dependency';
    if (hasIncomplete) return 'blocked_dependency';
  }

  // No blocking dependencies — task is schedulable
  if (ACTIVE_STATUSES.has(task.status) || task.status === 'draft') {
    return 'schedulable';
  }

  // Fallback
  return 'schedulable';
}
