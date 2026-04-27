/**
 * SAM resume_mission tool — resume a paused mission.
 *
 * Re-enables the orchestrator's scheduling loop for this mission.
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { Env } from '../../../env';
import { log } from '../../../lib/logger';
import * as orchestratorService from '../../../services/project-orchestrator';
import type { AnthropicToolDef, ToolContext } from '../types';

export const resumeMissionDef: AnthropicToolDef = {
  name: 'resume_mission',
  description:
    'Resume a paused mission. The orchestrator will begin dispatching new tasks again.',
  input_schema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: 'The ID of the mission to resume.',
      },
    },
    required: ['missionId'],
  },
};

export async function resumeMission(
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

  const ok = await orchestratorService.resumeMission(env, mission.projectId, missionId);
  if (!ok) {
    return { error: 'Mission could not be resumed — it may not be in a paused state.' };
  }

  log.info('sam.resume_mission.completed', { missionId, projectId: mission.projectId });

  return {
    resumed: true,
    missionId,
    message: `Mission '${mission.title || missionId}' has been resumed. The orchestrator will dispatch new tasks.`,
  };
}
