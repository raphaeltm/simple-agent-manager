/**
 * SAM create_mission tool — create a mission grouping related tasks.
 *
 * Missions are top-level orchestration containers. They live in D1 and
 * are registered with the ProjectOrchestrator DO for scheduling.
 */
import { createMissionRecord, missionTextLimits } from '@simple-agent-manager/operations';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { Env } from '../../../env';
import { log } from '../../../lib/logger';
import { ulid } from '../../../lib/ulid';
import { operationDeps } from '../../../operation-ports';
import type { AnthropicToolDef, ToolContext } from '../types';

export const createMissionDef: AnthropicToolDef = {
  name: 'create_mission',
  description:
    'Create a mission — a group of related tasks with a shared goal. ' +
    'Missions track overall progress across multiple tasks and enable dependency-based scheduling. ' +
    'After creating a mission, dispatch tasks with the missionId to associate them.',
  input_schema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID to create the mission in.',
      },
      title: {
        type: 'string',
        description: 'Short title for the mission.',
      },
      description: {
        type: 'string',
        description: 'Detailed description of the mission goal and scope.',
      },
    },
    required: ['projectId', 'title'],
  },
};

export async function createMission(
  input: { projectId: string; title: string; description?: string },
  ctx: ToolContext
): Promise<unknown> {
  const env = ctx.env as unknown as Env;
  const db = drizzle(env.DATABASE, { schema });

  if (!input.projectId?.trim()) {
    return { error: 'projectId is required.' };
  }
  if (!input.title?.trim()) {
    return { error: 'title is required.' };
  }

  const { titleMaxLength, descriptionMaxLength } = missionTextLimits(env);

  const title = input.title.trim().slice(0, titleMaxLength);
  const description = input.description?.trim().slice(0, descriptionMaxLength) ?? null;

  // ── Verify ownership ──────────────────────────────────────────────────
  const [project] = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, input.projectId), eq(schema.projects.userId, ctx.userId)))
    .limit(1);

  if (!project) {
    return { error: 'Project not found or not owned by you.' };
  }

  const id = ulid();
  const created = await createMissionRecord(operationDeps(env), {
    id,
    projectId: input.projectId,
    userId: ctx.userId,
    title,
    description,
    budgetConfig: null,
    surface: 'sam',
  });
  if (!created.ok) {
    return { error: `Maximum missions per project (${created.maxPerProject}) reached.` };
  }

  log.info('sam.create_mission.created', {
    missionId: id,
    projectId: input.projectId,
    title,
  });

  return {
    missionId: id,
    status: 'planning',
    title,
    message: `Mission created. Dispatch tasks with this missionId to associate them.`,
  };
}
