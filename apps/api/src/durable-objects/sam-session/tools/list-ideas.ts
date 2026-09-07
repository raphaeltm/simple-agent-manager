/**
 * SAM list_ideas tool — list draft ideas in a project.
 */
import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { Env } from '../../../env';
import type { AnthropicToolDef, ToolContext } from '../types';

const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_LIMIT = 50;
const DEFAULT_SNIPPET_LENGTH = 200;

export const listIdeasDef: AnthropicToolDef = {
  name: 'list_ideas',
  description:
    'List ideas (draft tasks) in a project. Returns the most recently updated ideas first.',
  input_schema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID to list ideas from.',
      },
      status: {
        type: 'string',
        enum: ['draft', 'ready', 'completed', 'cancelled'],
        description: 'Filter by idea status. Defaults to "draft".',
      },
      limit: {
        type: 'number',
        description: `Max results to return. Defaults to ${DEFAULT_LIMIT}, max ${DEFAULT_MAX_LIMIT}.`,
      },
    },
    required: ['projectId'],
  },
};

export async function listIdeas(
  input: { projectId: string; status?: string; limit?: number },
  ctx: ToolContext,
): Promise<unknown> {
  const env = ctx.env as unknown as Env;
  const db = drizzle(env.DATABASE, { schema });

  if (!input.projectId?.trim()) {
    return { error: 'projectId is required.' };
  }

  const maxLimit = Number(env.SAM_IDEA_LIST_MAX_LIMIT) || DEFAULT_MAX_LIMIT;
  const limit = Math.min(Math.max(1, Math.round(input.limit || DEFAULT_LIMIT)), maxLimit);
  const VALID_STATUSES = ['draft', 'ready', 'completed', 'cancelled'];
  const rawStatus = input.status?.trim() || 'draft';
  const status = VALID_STATUSES.includes(rawStatus) ? rawStatus : 'draft';
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

  // Query ideas (tasks with the given status)
  const rows = await db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      description: schema.tasks.description,
      priority: schema.tasks.priority,
      createdAt: schema.tasks.createdAt,
      updatedAt: schema.tasks.updatedAt,
    })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.projectId, input.projectId),
        eq(schema.tasks.status, status),
      ),
    )
    .orderBy(desc(schema.tasks.updatedAt))
    .limit(limit);

  return {
    ideas: rows.map((r) => ({
      ideaId: r.id,
      title: r.title,
      descriptionSnippet: r.description
        ? r.description.slice(0, snippetLen) + (r.description.length > snippetLen ? '...' : '')
        : null,
      priority: r.priority,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    count: rows.length,
    status,
  };
}
