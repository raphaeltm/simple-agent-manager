/**
 * SAM list_policies tool — list active policies for a project.
 */
import { isPolicyCategory, resolvePolicyLimits } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { Env } from '../../../env';
import * as projectDataService from '../../../services/project-data';
import type { AnthropicToolDef, ToolContext } from '../types';

export const listPoliciesDef: AnthropicToolDef = {
  name: 'list_policies',
  description:
    'List active policies for a project. Policies are rules, constraints, delegations, ' +
    'or preferences that guide agent behavior within the project.',
  input_schema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID.',
      },
      category: {
        type: 'string',
        enum: ['rule', 'constraint', 'delegation', 'preference'],
        description: 'Optional. Filter by policy category.',
      },
    },
    required: ['projectId'],
  },
};

export async function listPolicies(
  input: { projectId: string; category?: string },
  ctx: ToolContext,
): Promise<unknown> {
  if (!input.projectId?.trim()) {
    return { error: 'projectId is required.' };
  }

  const env = ctx.env as unknown as Env;
  const db = drizzle(env.DATABASE, { schema });

  // Verify ownership
  const project = await db
    .select({ id: schema.projects.id })
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

  const category = input.category && isPolicyCategory(input.category)
    ? input.category
    : null;

  const limits = resolvePolicyLimits(env);

  const result = await projectDataService.listPolicies(
    env, input.projectId, category, true, limits.maxPerProject, 0,
  );

  return {
    projectId: input.projectId,
    policies: result.policies,
    total: result.total,
  };
}
