/**
 * SAM search_knowledge tool — search knowledge graph, optionally across all user projects.
 */
import { KNOWLEDGE_ENTITY_TYPES } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { Env } from '../../../env';
import * as projectDataService from '../../../services/project-data';
import type { AnthropicToolDef, ToolContext } from '../types';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export const searchKnowledgeDef: AnthropicToolDef = {
  name: 'search_knowledge',
  description:
    'Search the knowledge graph for stored observations and facts. ' +
    'If projectId is omitted, searches across ALL of the user\'s projects. ' +
    'Use this to recall preferences, context, expertise, and past decisions.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query — matches against entity names and observation content.',
      },
      projectId: {
        type: 'string',
        description: 'Optional. Limit search to a specific project. If omitted, searches all projects.',
      },
      entityType: {
        type: 'string',
        enum: [...KNOWLEDGE_ENTITY_TYPES],
        description: 'Optional. Filter by entity type.',
      },
      limit: {
        type: 'number',
        description: `Max results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
      },
    },
    required: ['query'],
  },
};

export async function searchKnowledge(
  input: { query: string; projectId?: string; entityType?: string; limit?: number },
  ctx: ToolContext,
): Promise<unknown> {
  const query = input.query?.trim();
  if (!query) {
    return { error: 'query is required.' };
  }

  const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const entityType = input.entityType && KNOWLEDGE_ENTITY_TYPES.includes(input.entityType as (typeof KNOWLEDGE_ENTITY_TYPES)[number])
    ? input.entityType
    : null;

  const env = ctx.env as unknown as Env;
  const db = drizzle(env.DATABASE, { schema });

  // Single-project search
  if (input.projectId) {
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

    const results = await projectDataService.searchKnowledgeObservations(
      env, input.projectId, query, entityType, null, limit,
    );

    return {
      projectId: input.projectId,
      results,
      total: results.length,
    };
  }

  // Cross-project search: query all user projects
  const userProjects = await db
    .select({ id: schema.projects.id, name: schema.projects.name })
    .from(schema.projects)
    .where(eq(schema.projects.userId, ctx.userId));

  if (userProjects.length === 0) {
    return { results: [], total: 0 };
  }

  // Search each project in parallel, collect results
  const perProjectLimit = Math.min(limit, DEFAULT_LIMIT);
  const searchPromises = userProjects.map(async (p) => {
    try {
      const results = await projectDataService.searchKnowledgeObservations(
        env, p.id, query, entityType, null, perProjectLimit,
      );
      return results.map((r: Record<string, unknown>) => ({
        ...r,
        projectId: p.id,
        projectName: p.name,
      }));
    } catch {
      return [];
    }
  });

  const allResults = (await Promise.all(searchPromises)).flat();

  // Sort by confidence descending, take top `limit`
  allResults.sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
    ((b.confidence as number) ?? 0) - ((a.confidence as number) ?? 0));
  const trimmed = allResults.slice(0, limit);

  return {
    results: trimmed,
    total: allResults.length,
    projectsSearched: userProjects.length,
  };
}
