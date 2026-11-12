/**
 * Mission creation shared by the workspace `sam-mcp` `create_mission` tool and the /sam
 * `create_mission` tool. Each surface keeps its own authorization, input sanitizing, mission id
 * format and output shape; this owns the text limits, the per-project quota, the insert and the
 * orchestrator registration.
 */
import { DEFAULT_MISSION_MAX_PER_PROJECT } from '@simple-agent-manager/shared';

import { log } from '../lib/logger';
import type { OperationsEnv } from './env';
import type { OperationDeps } from './types';

const DEFAULT_MISSION_TITLE_MAX_LENGTH = 200;
const DEFAULT_MISSION_DESCRIPTION_MAX_LENGTH = 5000;

/** Title and description length caps for new missions. */
export function missionTextLimits(env: OperationsEnv): {
  titleMaxLength: number;
  descriptionMaxLength: number;
} {
  return {
    titleMaxLength: Number(env.MISSION_TITLE_MAX_LENGTH) || DEFAULT_MISSION_TITLE_MAX_LENGTH,
    descriptionMaxLength:
      Number(env.MISSION_DESCRIPTION_MAX_LENGTH) || DEFAULT_MISSION_DESCRIPTION_MAX_LENGTH,
  };
}

export interface MissionCreate {
  /** Caller-chosen id; the two surfaces historically use different id formats. */
  id: string;
  projectId: string;
  userId: string;
  title: string;
  description: string | null;
  budgetConfig: string | null;
  /** Prefix for log events, so each surface's existing log names are kept. */
  surface: 'mcp' | 'sam';
}

/**
 * Creates a mission in an already-authorized project, then registers it with the project's
 * orchestrator. Registration is best effort: a failure is logged and the mission still exists.
 */
export async function createMissionRecord(
  deps: OperationDeps,
  input: MissionCreate
): Promise<{ ok: true } | { ok: false; reason: 'quota_reached'; maxPerProject: number }> {
  const maxPerProject = Number(deps.env.MISSION_MAX_PER_PROJECT) || DEFAULT_MISSION_MAX_PER_PROJECT;
  const countRow = await deps.env.DATABASE.prepare(
    'SELECT COUNT(*) as cnt FROM missions WHERE project_id = ?'
  )
    .bind(input.projectId)
    .first<{ cnt: number }>();
  if (countRow && countRow.cnt >= maxPerProject) {
    return { ok: false, reason: 'quota_reached', maxPerProject };
  }

  const now = new Date().toISOString();
  await deps.env.DATABASE.prepare(
    `INSERT INTO missions (id, project_id, user_id, title, description, status, budget_config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'planning', ?, ?, ?)`
  )
    .bind(
      input.id,
      input.projectId,
      input.userId,
      input.title,
      input.description,
      input.budgetConfig,
      now,
      now
    )
    .run();

  try {
    await deps.ports.missions.startOrchestration(input.projectId, input.id);
  } catch (err) {
    log.warn(`${input.surface}.create_mission.orchestrator_start_failed`, {
      missionId: input.id,
      projectId: input.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { ok: true };
}
