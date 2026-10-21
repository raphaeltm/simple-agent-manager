import type { Env } from '../env';
import { getMcpLimits } from '../routes/mcp/_helpers';

export class WorkflowCapacityDeferredError extends Error {}
/** Live policy, not part of the immutable execution snapshot. */
export async function workflowCapacityBlocked(
  env: Env,
  projectId: string,
  parentTaskId: string
): Promise<boolean> {
  const defaults = getMcpLimits(env);
  const row = await env.DATABASE.prepare(
    `SELECT
    COALESCE(p.max_sub_tasks_per_task,?) AS child_limit,COALESCE(p.max_concurrent_tasks,?) AS project_limit,
    (SELECT COUNT(*) FROM tasks WHERE project_id=p.id AND parent_task_id=? AND status IN ('queued','in_progress','delegated','awaiting_followup')) AS children,
    (SELECT COUNT(*) FROM tasks WHERE project_id=p.id AND dispatch_depth>0 AND status IN ('queued','in_progress','delegated','awaiting_followup')) AS active
    FROM projects p WHERE p.id=?`
  )
    .bind(
      defaults.dispatchMaxPerTask,
      defaults.dispatchMaxActivePerProject,
      parentTaskId,
      projectId
    )
    .first<{ child_limit: number; project_limit: number; children: number; active: number }>();
  return !!row && (row.children >= row.child_limit || row.active >= row.project_limit);
}
