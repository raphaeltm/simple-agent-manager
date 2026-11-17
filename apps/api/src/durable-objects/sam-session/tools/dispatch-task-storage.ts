/** Task persistence for the SAM dispatch tool; runtime startup stays with the caller. */
import type { Env } from '../../../env';
import {
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_COLUMNS,
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_PLACEHOLDERS,
} from '../../../services/capacity-placement-snapshot';

export function insertSamDispatchedTask(env: Env, values: unknown[]): Promise<D1Result> {
  return env.DATABASE.prepare(
    `INSERT INTO tasks (id, project_id, user_id, parent_task_id, chat_session_id, title, description,
     status, execution_step, priority, dispatch_depth, output_branch, created_by,
     task_mode, agent_profile_hint, skill_id, skill_hint, mission_id, triggered_by,
     requested_vm_size, requested_vm_size_source, resource_requirements_json, resource_requirement_plan_json, resource_requirements_source, resolved_reservation_json,
     credential_attribution_user_id, credential_attribution_project_id, credential_attribution_source,
     ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_COLUMNS},
     created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'node_selection', ?, ?, ?, ?,
     ?, ?, ?, ?, ?, 'mcp',
     ?, ?, ?, ?, ?, ?,
     ?, ?, ?,
     ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_PLACEHOLDERS},
     ?, ?)`
  )
    .bind(...values)
    .run();
}
