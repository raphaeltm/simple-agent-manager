import type { Env } from '../../env';
import { log } from '../../lib/logger';
import * as projectDataService from '../../services/project-data';

export type MissionGenerationFence = (
  missionId: string,
  generation: number,
  dispatch: () => Promise<boolean>
) => Promise<boolean>;

export function isMissionDispatchCurrent(
  sql: SqlStorage,
  missionId: string,
  generation: number
): boolean {
  return (
    sql
      .exec(
        `SELECT 1 FROM orchestrator_missions
         WHERE mission_id = ? AND status = 'active' AND dispatch_generation = ?`,
        missionId,
        generation
      )
      .toArray().length > 0
  );
}

export async function stopOrphanedDispatchSession(
  env: Env,
  projectId: string,
  missionId: string,
  taskId: string,
  sessionId: string
): Promise<void> {
  try {
    await projectDataService.stopSession(env, projectId, sessionId);
  } catch (error) {
    log.error('orchestrator.orphaned_dispatch_session_cleanup_failed', {
      projectId,
      missionId,
      taskId,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
