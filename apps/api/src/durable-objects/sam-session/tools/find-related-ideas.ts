/**
 * SAM find_related_ideas tool — search ideas by keyword.
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { Env } from '../../../env';
import type { AnthropicToolDef, ToolContext } from '../types';

const DEFAULT_LIMIT = 10;
const DEFAULT_MAX_LIMIT = 50;
const DEFAULT_SNIPPET_LENGTH = 200;

export const findRelatedIdeasDef: AnthropicToolDef = {
  name: 'find_related_ideas',
  description:
    'Search ideas in a project by keyword. Matches against title and description.',
  input_schema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID to search in.',
      },
      query: {
        type: 'string',
        description: 'Search keyword or phrase.',
      },
      limit: {
        type: 'number',
        description: `Max results to return. Defaults to ${DEFAULT_LIMIT}.`,
      },
    },
    required: ['projectId', 'query'],
  },
};

export async function findRelatedIdeas(
  input: { projectId: string; query: string; limit?: number },
  ctx: ToolContext,
): Promise<unknown> {
  const env = ctx.env as unknown as Env;
  const db = drizzle(env.DATABASE, { schema });

  if (!input.projectId?.trim()) {
    return { error: 'projectId is required.' };
  }
  if (!input.query?.trim()) {
    return { error: 'query is required.' };
  }
  if (input.query.trim().length < 2) {
    return { error: 'query must be at least 2 characters.' };
  }

  const maxLimit = Number(env.SAM_IDEA_SEARCH_MAX_LIMIT) || DEFAULT_MAX_LIMIT;
  const limit = Math.min(Math.max(1, Math.round(input.limit || DEFAULT_LIMIT)), maxLimit);
  const snippetLen = Number(env.SAM_IDEA_SNIPPET_LENGTH) || DEFAULT_SNIPPET_LENGTH;

  // Verify ownership
  const [project] = await db
    .select({ id: schema.projects.id })
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

  // LIKE search on title and description (draft ideas only)
  // Escape LIKE metacharacters to prevent semantic mismatch
  const escaped = input.query.trim().replace(/[%_\\]/g, '\\$&');
  const searchPattern = `%${escaped}%`;
  const results = await env.DATABASE.prepare(
    `SELECT id, title, description, status, priority, updated_at
     FROM tasks
     WHERE project_id = ? AND status = 'draft'
       AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
     ORDER BY updated_at DESC
     LIMIT ?`,
  ).bind(project.id, searchPattern, searchPattern, limit)
    .all<{
      id: string;
      title: string;
      description: string | null;
      status: string;
      priority: number;
      updated_at: string;
    }>();

  return {
    ideas: (results.results ?? []).map((r) => ({
      ideaId: r.id,
      title: r.title,
      descriptionSnippet: r.description
        ? r.description.slice(0, snippetLen) + (r.description.length > snippetLen ? '...' : '')
        : null,
      status: r.status,
      priority: r.priority,
      updatedAt: r.updated_at,
    })),
    count: results.results?.length ?? 0,
    query: input.query.trim(),
  };
}
