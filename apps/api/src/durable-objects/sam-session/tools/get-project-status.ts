import type { OrchestratorStatus } from '@simple-agent-manager/shared';
import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { Env } from '../../../env';
import { log } from '../../../lib/logger';
import * as orchestratorService from '../../../services/project-orchestrator';
import type { AnthropicToolDef, ToolContext } from '../types';

export const getProjectStatusDef: AnthropicToolDef = {
  name: 'get_project_status',
  description:
    'Get detailed status of a specific project including orchestrator status and recent tasks.',
  input_schema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID to check.',
      },
    },
    required: ['projectId'],
  },
};

export async function getProjectStatus(
  input: { projectId: string },
  ctx: ToolContext
): Promise<unknown> {
  // ToolContext.env is the SamSession Durable Object's Worker Env (same cast as get-orchestrator-status).
  const env = ctx.env as unknown as Env;
  const db = drizzle(env.DATABASE, { schema });

  // Verify ownership
  const project = await db
    .select()
    .from(schema.projects)
    .where(and(eq(schema.projects.id, input.projectId), eq(schema.projects.userId, ctx.userId)))
    .get();

  if (!project) {
    return { error: 'Project not found or not owned by you.' };
  }

  // Get recent tasks
  const recentTasks = await db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      status: schema.tasks.status,
      createdAt: schema.tasks.createdAt,
    })
    .from(schema.tasks)
    .where(eq(schema.tasks.projectId, input.projectId))
    .orderBy(desc(schema.tasks.createdAt))
    .limit(10);

  // Orchestrator status is optional context: report null rather than fail the whole tool.
  let orchestratorStatus: OrchestratorStatus | null = null;
  try {
    orchestratorStatus = await orchestratorService.getOrchestratorStatus(env, input.projectId);
  } catch (err) {
    log.warn('sam.get_project_status.orchestrator_status_failed', {
      projectId: input.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    project: {
      id: project.id,
      name: project.name,
      repository: project.repository,
      defaultBranch: project.defaultBranch,
      status: project.status,
      createdAt: project.createdAt,
    },
    recentTasks,
    orchestrator: orchestratorStatus,
  };
}
