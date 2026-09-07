/**
 * SAM pause_mission tool — pause a running mission.
 *
 * Running tasks continue, but no new tasks are dispatched by the orchestrator.
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { Env } from '../../../env';
import { log } from '../../../lib/logger';
import * as orchestratorService from '../../../services/project-orchestrator';
import type { AnthropicToolDef, ToolContext } from '../types';

export const pauseMissionDef: AnthropicToolDef = {
  name: 'pause_mission',
  description:
    'Pause a running mission. Running tasks continue to completion, but no new tasks will be dispatched. ' +
    'Use resume_mission to resume dispatching.',
  input_schema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: 'The ID of the mission to pause.',
      },
    },
    required: ['missionId'],
  },
};

export async function pauseMission(
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

  const ok = await orchestratorService.pauseMission(env, mission.projectId, missionId);
  if (!ok) {
    return { error: 'Mission could not be paused — it may not be in an active state.' };
  }

  log.info('sam.pause_mission.completed', { missionId, projectId: mission.projectId });

  return {
    paused: true,
    missionId,
    message: `Mission '${mission.title || missionId}' has been paused. Running tasks will continue, but no new tasks will be dispatched.`,
  };
}
