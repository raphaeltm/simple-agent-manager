import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { logDecision } from './decision-log';

/** Cancel a tracked mission without changing its existing lifecycle behavior. */
export async function cancelTrackedMission(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  missionId: string,
  bindProject: () => void
): Promise<boolean> {
  // Workflow steering is not exposed in Phase 0; do not let legacy mission
  // controls bypass workflow ownership or alter durable step state.
  if (
    await env.DATABASE.prepare(
      'SELECT 1 FROM missions WHERE id = ? AND workflow_plan_json IS NOT NULL'
    )
      .bind(missionId)
      .first()
  )
    return false;
  bindProject();

  // Verify mission is tracked before proceeding
  const tracked = sql
    .exec(`SELECT 1 FROM orchestrator_missions WHERE mission_id = ?`, missionId)
    .toArray();
  if (tracked.length === 0) return false;

  // Update D1 first (source of truth) — cancel tasks and mission
  const now = new Date().toISOString();
  await env.DATABASE.prepare(
    `UPDATE tasks SET status = 'cancelled', scheduler_state = 'cancelled', updated_at = ?
     WHERE mission_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`
  )
    .bind(now, missionId)
    .run();

  await env.DATABASE.prepare('UPDATE missions SET status = ?, updated_at = ? WHERE id = ?')
    .bind('cancelled', now, missionId)
    .run();

  // Then remove from DO tracking
  sql.exec(`DELETE FROM orchestrator_missions WHERE mission_id = ?`, missionId);
  sql.exec('DELETE FROM scheduling_queue WHERE mission_id = ?', missionId);

  logDecision(sql, missionId, null, 'cancel', 'Mission cancelled by user', Date.now());
  log.info('orchestrator.mission_cancelled', { projectId, missionId });

  return true;
}
