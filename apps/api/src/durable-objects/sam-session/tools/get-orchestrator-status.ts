/**
 * SAM get_orchestrator_status tool — get project orchestrator scheduling status.
 *
 * Queries the ProjectOrchestrator DO for active missions, scheduling queue,
 * and recent decisions.
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { Env } from '../../../env';
import { log } from '../../../lib/logger';
import * as orchestratorService from '../../../services/project-orchestrator';
import type { AnthropicToolDef, ToolContext } from '../types';

export const getOrchestratorStatusDef: AnthropicToolDef = {
  name: 'get_orchestrator_status',
  description:
    'Get the orchestrator status for a project — active missions, scheduling queue, and recent decisions. ' +
    'Use this to monitor mission progress and scheduling health.',
  input_schema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID to check orchestrator status for.',
      },
    },
    required: ['projectId'],
  },
};

export async function getOrchestratorStatus(
  input: { projectId: string },
  ctx: ToolContext,
): Promise<unknown> {
  const env = ctx.env as unknown as Env;
  const db = drizzle(env.DATABASE, { schema });

  if (!input.projectId?.trim()) {
    return { error: 'projectId is required.' };
  }

  // Verify ownership
  const [project] = await db
    .select({ id: schema.projects.id, name: schema.projects.name })
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.id, input.projectId),
        eq(schema.projects.userId, ctx.userId),
      ),
    )
    .limit(1);

  if (!project) {
    return { error: 'Project not found or not owned by you.' };
  }

  try {
    const [status, queue] = await Promise.all([
      orchestratorService.getOrchestratorStatus(env, input.projectId),
      orchestratorService.getSchedulingQueue(env, input.projectId),
    ]);

    return {
      projectId: input.projectId,
      projectName: project.name,
      orchestrator: status,
      schedulingQueue: queue,
    };
  } catch (err) {
    log.warn('sam.get_orchestrator_status.failed', {
      projectId: input.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      projectId: input.projectId,
      projectName: project.name,
      orchestrator: null,
      schedulingQueue: [],
      note: 'Orchestrator not available.',
    };
  }
}
