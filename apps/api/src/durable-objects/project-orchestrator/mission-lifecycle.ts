import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { logDecision } from './decision-log';

export async function pauseTrackedMission(sql: SqlStorage, env: Env, projectId: string, missionId: string, bindProject: () => void): Promise<boolean> {
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
  const result = sql.exec(
    `UPDATE orchestrator_missions SET status = 'paused' WHERE mission_id = ? AND status = 'active'`,
    missionId
  );
  if (result.rowsWritten === 0) return false;

  logDecision(sql, missionId, null, 'pause', 'Mission paused by user', Date.now());

  // Update D1 mission status
  await env.DATABASE.prepare('UPDATE missions SET status = ?, updated_at = ? WHERE id = ?')
    .bind('paused', new Date().toISOString(), missionId)
    .run();

  log.info('orchestrator.mission_paused', { projectId, missionId });
  return true;
}

export async function resumeTrackedMission(sql: SqlStorage, env: Env, projectId: string, missionId: string, bindProject: () => void, armAlarm: () => Promise<void>): Promise<boolean> {
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
  const result = sql.exec(
    `UPDATE orchestrator_missions SET status = 'active' WHERE mission_id = ? AND status = 'paused'`,
    missionId
  );
  if (result.rowsWritten === 0) return false;

  logDecision(sql, missionId, null, 'resume', 'Mission resumed by user', Date.now());

  // Update D1 mission status
  await env.DATABASE.prepare('UPDATE missions SET status = ?, updated_at = ? WHERE id = ?')
    .bind('active', new Date().toISOString(), missionId)
    .run();

  log.info('orchestrator.mission_resumed', { projectId, missionId });
  await armAlarm();
  return true;
}
