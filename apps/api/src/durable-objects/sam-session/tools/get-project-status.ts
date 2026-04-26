import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
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
  ctx: ToolContext,
): Promise<unknown> {
  const db = drizzle(ctx.env.DATABASE as D1Database, { schema });

  // Verify ownership
  const project = await db
    .select()
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.id, input.projectId),
        eq(schema.projects.userId, ctx.userId),
      ),
    )
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

  // Try to get orchestrator status
  let orchestratorStatus = null;
  try {
    const orchNs = ctx.env.PROJECT_ORCHESTRATOR as DurableObjectNamespace;
    const orchId = orchNs.idFromName(input.projectId);
    const orchStub = orchNs.get(orchId);
    const resp = await orchStub.fetch('https://orch/status');
    if (resp.ok) {
      orchestratorStatus = await resp.json();
    }
  } catch {
    // Orchestrator not available — not critical
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
