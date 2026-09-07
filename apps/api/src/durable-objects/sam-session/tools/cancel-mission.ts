/**
 * SAM cancel_mission tool — cancel a running mission and all its tasks.
 *
 * Verifies mission ownership via projects join, then delegates to the
 * ProjectOrchestrator DO.
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { Env } from '../../../env';
import { log } from '../../../lib/logger';
import * as orchestratorService from '../../../services/project-orchestrator';
import type { AnthropicToolDef, ToolContext } from '../types';

export const cancelMissionDef: AnthropicToolDef = {
  name: 'cancel_mission',
  description:
    'Cancel a running mission and mark all its pending tasks as cancelled. ' +
    'Running tasks are NOT automatically stopped — use stop_subtask for those individually.',
  input_schema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: 'The ID of the mission to cancel.',
      },
    },
    required: ['missionId'],
  },
};

export async function cancelMission(
  input: { missionId: string },
  ctx: ToolContext,
): Promise<unknown> {
  if (!input.missionId?.trim()) {
    return { error: 'missionId is required.' };
  }

  const env = ctx.env as unknown as Env;
  const db = drizzle(env.DATABASE, { schema });
  const missionId = input.missionId.trim();

  // Verify ownership via missions → projects join
  const rows = await db
    .select({
      id: schema.missions.id,
      status: schema.missions.status,
      projectId: schema.missions.projectId,
      title: schema.missions.title,
    })
    .from(schema.missions)
    .innerJoin(schema.projects, eq(schema.missions.projectId, schema.projects.id))
    .where(
      and(
        eq(schema.missions.id, missionId),
        eq(schema.projects.userId, ctx.userId),
      ),
    )
    .limit(1);

  const mission = rows[0];
  if (!mission) {
    return { error: 'Mission not found or not owned by you.' };
  }

  const ok = await orchestratorService.cancelMission(env, mission.projectId, missionId);
  if (!ok) {
    return { error: 'Mission could not be cancelled — it may already be in a terminal state.' };
  }

  log.info('sam.cancel_mission.completed', { missionId, projectId: mission.projectId });

  return {
    cancelled: true,
    missionId,
    message: `Mission '${mission.title || missionId}' has been cancelled. Note: already-running tasks continue until explicitly stopped.`,
  };
}
