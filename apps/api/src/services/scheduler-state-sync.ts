/**
 * Scheduler State Sync — recomputes scheduler states for all tasks in a mission
 * and persists the results to D1.
 *
 * Called after task status transitions (complete, fail) to update sibling tasks'
 * scheduler classifications. Best-effort — failures are logged but do not block
 * the status transition.
 */
import type { DependencyEdge, TaskForScheduling } from './scheduler-state';
import { computeSchedulerStates } from './scheduler-state';

/**
 * Recompute scheduler states for all tasks in a mission and persist to D1.
 * Reads current task statuses and dependency edges, runs the pure computation,
 * then batch-updates any tasks whose scheduler_state changed.
 */
export async function recomputeMissionSchedulerStates(
  db: D1Database,
  missionId: string,
): Promise<void> {
  // Fetch all tasks in this mission
  const tasksResult = await db.prepare(
    'SELECT id, status, mission_id FROM tasks WHERE mission_id = ?',
  ).bind(missionId).all<{ id: string; status: string; mission_id: string | null }>();

  const tasks: TaskForScheduling[] = (tasksResult.results ?? []).map((r) => ({
    id: r.id,
    status: r.status,
    missionId: r.mission_id,
  }));

  if (tasks.length === 0) return;

  // Fetch dependency edges for these tasks
  const taskIds = tasks.map((t) => t.id);
  const placeholders = taskIds.map(() => '?').join(',');
  const depsResult = await db.prepare(
    `SELECT task_id, depends_on_task_id FROM task_dependencies WHERE task_id IN (${placeholders})`,
  ).bind(...taskIds).all<{ task_id: string; depends_on_task_id: string }>();

  const dependencies: DependencyEdge[] = (depsResult.results ?? []).map((r) => ({
    taskId: r.task_id,
    dependsOnTaskId: r.depends_on_task_id,
  }));

  // Compute new states
  const newStates = computeSchedulerStates(tasks, dependencies);

  // Batch update tasks whose scheduler_state changed
  const now = new Date().toISOString();
  const updates: Promise<D1Result>[] = [];

  for (const task of tasks) {
    const newState = newStates.get(task.id);
    if (newState) {
      updates.push(
        db.prepare(
          'UPDATE tasks SET scheduler_state = ?, updated_at = ? WHERE id = ? AND (scheduler_state IS NULL OR scheduler_state != ?)',
        ).bind(newState, now, task.id, newState).run(),
      );
    }
  }

  if (updates.length > 0) {
    await Promise.all(updates);
  }
}
