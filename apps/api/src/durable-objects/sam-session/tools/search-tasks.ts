import { and, desc, eq, like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { AnthropicToolDef, ToolContext } from '../types';

export const searchTasksDef: AnthropicToolDef = {
  name: 'search_tasks',
  description:
    'Search tasks across all projects owned by the current user, filterable by status, project, or keyword.',
  input_schema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['queued', 'delegated', 'running', 'completed', 'failed', 'cancelled'],
        description: 'Filter by task status.',
      },
      projectId: {
        type: 'string',
        description: 'Filter by project ID.',
      },
      keyword: {
        type: 'string',
        description: 'Search keyword to match against task title or description.',
      },
      limit: {
        type: 'number',
        description: 'Max results to return. Defaults to 20.',
      },
    },
  },
};

export async function searchTasks(
  input: { status?: string; projectId?: string; keyword?: string; limit?: number },
  ctx: ToolContext,
): Promise<unknown> {
  const db = drizzle(ctx.env.DATABASE as D1Database, { schema });
  const maxResults = Math.min(input.limit || 20, 50);

  // Build conditions: always filter by user's projects
  const conditions = [eq(schema.projects.userId, ctx.userId)];

  if (input.status) {
    conditions.push(eq(schema.tasks.status, input.status));
  }
  if (input.projectId) {
    conditions.push(eq(schema.tasks.projectId, input.projectId));
  }
  if (input.keyword) {
    conditions.push(like(schema.tasks.title, `%${input.keyword}%`));
  }

  const rows = await db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      status: schema.tasks.status,
      projectId: schema.tasks.projectId,
      projectName: schema.projects.name,
      createdAt: schema.tasks.createdAt,
    })
    .from(schema.tasks)
    .innerJoin(schema.projects, eq(schema.tasks.projectId, schema.projects.id))
    .where(and(...conditions))
    .orderBy(desc(schema.tasks.createdAt))
    .limit(maxResults);

  return {
    tasks: rows,
    count: rows.length,
  };
}
