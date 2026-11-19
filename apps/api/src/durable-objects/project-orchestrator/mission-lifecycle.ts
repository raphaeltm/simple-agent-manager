import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { logDecision } from './decision-log';

export async function pauseTrackedMission(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  missionId: string,
  bindProject: () => void
): Promise<boolean> {
  return transitionMission(sql, env, projectId, missionId, 'active', 'paused', bindProject);
}

export async function resumeTrackedMission(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  missionId: string,
  bindProject: () => void,
  armAlarm: () => Promise<void>
): Promise<boolean> {
  const changed = await transitionMission(
    sql,
    env,
    projectId,
    missionId,
    'paused',
    'active',
    bindProject
  );
  if (changed) await armAlarm();
  return changed;
}

/** Called under cycleLock. Cancellation may still install its synchronous intent marker. */
async function transitionMission(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  missionId: string,
  from: 'active' | 'paused',
  to: 'active' | 'paused',
  bindProject: () => void
): Promise<boolean> {
  const mission = await env.DATABASE.prepare(
    `SELECT status,updated_at FROM missions
    WHERE id=? AND project_id=? AND workflow_plan_json IS NULL`
  )
    .bind(missionId, projectId)
    .first<{ status: string; updated_at: string }>();
  if (!mission || !['planning', 'active', 'paused'].includes(mission.status)) return false;
  bindProject();
  if (
    !sql
      .exec('SELECT 1 FROM orchestrator_missions WHERE mission_id=? AND status=?', missionId, from)
      .toArray().length
  )
    return false;
  const now = new Date(Math.max(Date.now(), Date.parse(mission.updated_at) + 1)).toISOString();
  const result = await env.DATABASE.prepare(
    `UPDATE missions SET status=?,updated_at=?
    WHERE id=? AND project_id=? AND status=? AND updated_at=? AND workflow_plan_json IS NULL`
  )
    .bind(to, now, missionId, projectId, mission.status, mission.updated_at)
    .run();
  if (!result.meta.changes) return false;
  // A cancellation marker installed during the D1 await wins local ownership.
  if (
    !sql.exec(
      'UPDATE orchestrator_missions SET status=? WHERE mission_id=? AND status=?',
      to,
      missionId,
      from
    ).rowsWritten
  )
    return false;
  const action = to === 'paused' ? 'pause' : 'resume';
  logDecision(
    sql,
    missionId,
    null,
    action,
    `Mission ${to === 'paused' ? 'paused' : 'resumed'} by user`,
    Date.now()
  );
  log.info(`orchestrator.mission_${to === 'paused' ? 'paused' : 'resumed'}`, {
    projectId,
    missionId,
  });
  return true;
}
