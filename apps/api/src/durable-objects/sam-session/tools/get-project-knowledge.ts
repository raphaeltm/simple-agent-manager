/**
 * SAM get_project_knowledge tool — list knowledge entities in a project.
 */
import { KNOWLEDGE_ENTITY_TYPES } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { Env } from '../../../env';
import * as projectDataService from '../../../services/project-data';
import type { AnthropicToolDef, ToolContext } from '../types';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const getProjectKnowledgeDef: AnthropicToolDef = {
  name: 'get_project_knowledge',
  description:
    'List knowledge entities stored in a project\'s knowledge graph. ' +
    'Returns entities with their observation counts. Use search_knowledge to find specific facts.',
  input_schema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID.',
      },
      entityType: {
        type: 'string',
        enum: [...KNOWLEDGE_ENTITY_TYPES],
        description: 'Optional. Filter by entity type.',
      },
      limit: {
        type: 'number',
        description: `Max entities to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
      },
    },
    required: ['projectId'],
  },
};

export async function getProjectKnowledge(
  input: { projectId: string; entityType?: string; limit?: number },
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

  const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const entityType = input.entityType && KNOWLEDGE_ENTITY_TYPES.includes(input.entityType as (typeof KNOWLEDGE_ENTITY_TYPES)[number])
    ? input.entityType
    : null;

  const result = await projectDataService.listKnowledgeEntities(
    env, input.projectId, entityType, limit, 0,
  );

  return {
    projectId: input.projectId,
    entities: result.entities,
    total: result.total,
  };
}
