/** Atomic dispatch task persistence, separated from profile/runtime orchestration. */
import type { Env } from '../../env';
import {
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_COLUMNS,
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_PLACEHOLDERS,
} from '../../services/capacity-placement-snapshot';
import { ACTIVE_STATUSES } from './_helpers';

export function insertDispatchedTask(
  env: Env,
  values: unknown[],
  limits: { parentTaskId: string; projectId: string; maxPerTask: number; maxActive: number }
): Promise<D1Result> {
  const statusPlaceholders = ACTIVE_STATUSES.map(() => '?').join(', ');
  return env.DATABASE.prepare(
    `INSERT INTO tasks (id, project_id, user_id, parent_task_id, chat_session_id, title, description,
     status, execution_step, priority, dispatch_depth, output_branch, created_by,
     task_mode, agent_profile_hint, skill_id, skill_hint, mission_id, coordination_channel, triggered_by,
     requested_vm_size, requested_vm_size_source, resource_requirements_json, resource_requirement_plan_json, resource_requirements_source, resolved_reservation_json,
     credential_attribution_user_id, credential_attribution_project_id, credential_attribution_source,
     ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_COLUMNS},
     created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, 'queued', 'node_selection', ?, ?, ?, ?,
     ?, ?, ?, ?, ?, ?, 'mcp',
     ?, ?, ?, ?, ?, ?,
     ?, ?, ?,
     ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_PLACEHOLDERS},
     ?, ?
     WHERE (
       SELECT count(*) FROM tasks
       WHERE parent_task_id = ? AND project_id = ?
       AND status IN (${statusPlaceholders})
     ) < ?
     AND (
       SELECT count(*) FROM tasks
       WHERE project_id = ? AND status IN (${statusPlaceholders})
       AND dispatch_depth > 0
     ) < ?`
  )
    .bind(
      ...values,
      limits.parentTaskId,
      limits.projectId,
      ...ACTIVE_STATUSES,
      limits.maxPerTask,
      limits.projectId,
      ...ACTIVE_STATUSES,
      limits.maxActive
    )
    .run();
}
