/**
 * SAM get_mission tool — get mission status and task summary.
 *
 * Queries D1 missions table with ownership check via projects join,
 * then aggregates task status counts.
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { AnthropicToolDef, ToolContext } from '../types';

export const getMissionDef: AnthropicToolDef = {
  name: 'get_mission',
  description:
    'Get the status of a mission including task summary by status. ' +
    'Use this to check overall progress of a multi-task effort.',
  input_schema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: 'The mission ID to look up.',
      },
    },
    required: ['missionId'],
  },
};

export async function getMission(
  input: { missionId: string },
  ctx: ToolContext,
): Promise<unknown> {
  if (!input.missionId?.trim()) {
    return { error: 'missionId is required.' };
  }

  const db = drizzle(ctx.env.DATABASE as D1Database, { schema });

  // Query mission and verify ownership via projects join
  const missionRows = await db
    .select({
      id: schema.missions.id,
      title: schema.missions.title,
      description: schema.missions.description,
      status: schema.missions.status,
      projectId: schema.missions.projectId,
      createdAt: schema.missions.createdAt,
      updatedAt: schema.missions.updatedAt,
      projectName: schema.projects.name,
    })
    .from(schema.missions)
    .innerJoin(schema.projects, eq(schema.missions.projectId, schema.projects.id))
    .where(
      and(
        eq(schema.missions.id, input.missionId.trim()),
        eq(schema.projects.userId, ctx.userId),
      ),
    )
    .limit(1);

  const mission = missionRows[0];
  if (!mission) {
    return { error: 'Mission not found or not owned by you.' };
  }

  // Get task summary for this mission
  const DATABASE = ctx.env.DATABASE as D1Database;
  const taskSummary = await DATABASE.prepare(
    `SELECT status, COUNT(*) as cnt FROM tasks WHERE mission_id = ? GROUP BY status`,
  ).bind(input.missionId.trim()).all();

  const tasks: Record<string, number> = {};
  for (const row of taskSummary.results ?? []) {
    const status = row.status as string;
    const count = row.cnt as number;
    tasks[status] = count;
  }

  // Get individual task list for this mission
  const taskRows = await DATABASE.prepare(
    `SELECT id, title, status, updated_at FROM tasks WHERE mission_id = ? ORDER BY created_at`,
  ).bind(input.missionId.trim()).all();

  const taskList = (taskRows.results ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    updatedAt: row.updated_at,
  }));

  return {
    id: mission.id,
    title: mission.title,
    description: mission.description,
    status: mission.status,
    projectId: mission.projectId,
    projectName: mission.projectName,
    taskSummary: tasks,
    tasks: taskList,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
  };
}
