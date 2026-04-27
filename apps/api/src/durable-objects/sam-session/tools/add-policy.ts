/**
 * SAM add_policy tool — add a policy to a project.
 */
import { isPolicyCategory, resolvePolicyLimits } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { Env } from '../../../env';
import * as projectDataService from '../../../services/project-data';
import type { AnthropicToolDef, ToolContext } from '../types';

export const addPolicyDef: AnthropicToolDef = {
  name: 'add_policy',
  description:
    'Add a policy to a project. Policies guide agent behavior — rules are mandatory, ' +
    'constraints are limits, delegations define authority, preferences are soft guidance. ' +
    'Confirm with the user before adding policies.',
  input_schema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID to add the policy to.',
      },
      title: {
        type: 'string',
        description: 'Short title for the policy.',
      },
      content: {
        type: 'string',
        description: 'The full policy text — what the rule/constraint/preference says.',
      },
      category: {
        type: 'string',
        enum: ['rule', 'constraint', 'delegation', 'preference'],
        description: 'The policy category: rule (mandatory), constraint (limit), delegation (authority), preference (soft guidance).',
      },
    },
    required: ['projectId', 'title', 'content', 'category'],
  },
};

export async function addPolicy(
  input: { projectId: string; title: string; content: string; category: string },
  ctx: ToolContext,
): Promise<unknown> {
  if (!input.projectId?.trim()) {
    return { error: 'projectId is required.' };
  }
  if (!input.title?.trim()) {
    return { error: 'title is required.' };
  }
  if (!input.content?.trim()) {
    return { error: 'content is required.' };
  }
  if (!isPolicyCategory(input.category)) {
    return { error: 'category must be one of: rule, constraint, delegation, preference' };
  }

  const env = ctx.env as unknown as Env;
  const db = drizzle(env.DATABASE, { schema });
  const limits = resolvePolicyLimits(env);

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

  const title = input.title.trim().slice(0, limits.titleMaxLength);
  const content = input.content.trim().slice(0, limits.contentMaxLength);

  const result = await projectDataService.createPolicy(
    env, input.projectId,
    input.category as 'rule' | 'constraint' | 'delegation' | 'preference',
    title, content, 'explicit', null, limits.defaultConfidence,
  );

  return {
    id: result.id,
    projectId: input.projectId,
    category: input.category,
    title,
    source: 'explicit',
    confidence: limits.defaultConfidence,
    createdAt: result.now,
  };
}
