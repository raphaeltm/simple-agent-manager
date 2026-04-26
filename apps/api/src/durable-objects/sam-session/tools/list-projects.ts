import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { AnthropicToolDef, ToolContext } from '../types';

export const listProjectsDef: AnthropicToolDef = {
  name: 'list_projects',
  description: 'List all projects owned by the current user with their status and recent activity.',
  input_schema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['active', 'archived', 'all'],
        description: 'Filter by project status. Defaults to active.',
      },
    },
  },
};

export async function listProjects(
  input: { status?: string },
  ctx: ToolContext,
): Promise<unknown> {
  const db = drizzle(ctx.env.DATABASE as D1Database, { schema });
  const filterStatus = input.status || 'active';

  let rows;
  if (filterStatus === 'all') {
    rows = await db
      .select({
        id: schema.projects.id,
        name: schema.projects.name,
        repository: schema.projects.repository,
        defaultBranch: schema.projects.defaultBranch,
        status: schema.projects.status,
        createdAt: schema.projects.createdAt,
      })
      .from(schema.projects)
      .where(eq(schema.projects.userId, ctx.userId));
  } else {
    rows = await db
      .select({
        id: schema.projects.id,
        name: schema.projects.name,
        repository: schema.projects.repository,
        defaultBranch: schema.projects.defaultBranch,
        status: schema.projects.status,
        createdAt: schema.projects.createdAt,
      })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.userId, ctx.userId),
          eq(schema.projects.status, filterStatus),
        ),
      );
  }

  return {
    projects: rows,
    count: rows.length,
  };
}
