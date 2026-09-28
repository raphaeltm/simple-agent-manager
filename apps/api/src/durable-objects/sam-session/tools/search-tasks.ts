import { and, desc, eq, like, or, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { Env } from '../../../env';
import { normalizeSearchQuery } from '../../../lib/search-query-limits';
import { getMcpLimits } from '../../../routes/mcp/_helpers';
import type { AnthropicToolDef, ToolContext } from '../types';

const TASK_STATUSES = [
  'draft',
  'queued',
  'in_progress',
  'delegated',
  'awaiting_followup',
  'completed',
  'failed',
  'cancelled',
] as const;

type TaskStatus = (typeof TASK_STATUSES)[number];

function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

function snippet(value: string | null, length: number): string | null {
  if (!value) {
    return null;
  }
  return value.slice(0, length) + (value.length > length ? '...' : '');
}

export const searchTasksDef: AnthropicToolDef = {
  name: 'search_tasks',
  description:
    'Search tasks across all projects owned by the current user. Searches both title and description fields. Over-limit queries are truncated and disclosed in the response.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search text for task titles and descriptions. Over-limit input is truncated.',
      },
      status: {
        type: 'string',
        enum: TASK_STATUSES,
        description: 'Filter by task status. Omit for all statuses.',
      },
      projectId: {
        type: 'string',
        description: 'Filter by project ID.',
      },
      keyword: {
        type: 'string',
        description: 'Deprecated alias for query. Prefer query.',
      },
      limit: {
        type: 'number',
        description: 'Max results to return. Defaults to 10, max 20.',
      },
    },
    required: ['query'],
  },
};

export async function searchTasks(
  input: { status?: string; projectId?: string; query?: string; keyword?: string; limit?: number },
  ctx: ToolContext
): Promise<unknown> {
  const inputQuery =
    typeof input.query === 'string'
      ? input.query.trim()
      : typeof input.keyword === 'string'
        ? input.keyword.trim()
        : '';
  if (!inputQuery) {
    return { error: 'query is required and must be a non-empty string.' };
  }
  if (inputQuery.length < 2) {
    return { error: 'query must be at least 2 characters.' };
  }

  const status = typeof input.status === 'string' ? input.status : undefined;
  if (status && !isTaskStatus(status)) {
    return { error: `status must be one of: ${TASK_STATUSES.join(', ')}` };
  }

  const env = ctx.env as unknown as Env;
  const limits = getMcpLimits(env);
  const normalizedQuery = normalizeSearchQuery(inputQuery, env);
  const query = normalizedQuery.query;
  const requestedLimit =
    typeof input.limit === 'number' && Number.isFinite(input.limit) ? input.limit : 10;
  const searchLimit = Math.min(Math.max(1, Math.round(requestedLimit)), limits.taskSearchMax);

  const db = drizzle(ctx.env.DATABASE as D1Database, { schema });
  const searchPattern = `%${query}%`;

  // Build conditions: always filter by user's projects
  const conditions: SQL[] = [eq(schema.projects.userId, ctx.userId)];
  const titleOrDescriptionMatch = or(
    like(schema.tasks.title, searchPattern),
    like(schema.tasks.description, searchPattern)
  );
  if (titleOrDescriptionMatch) {
    conditions.push(titleOrDescriptionMatch);
  }

  if (status) {
    conditions.push(eq(schema.tasks.status, status));
  }

  const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
  if (projectId) {
    conditions.push(eq(schema.tasks.projectId, projectId));
  }

  const rows = await db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      description: schema.tasks.description,
      status: schema.tasks.status,
      priority: schema.tasks.priority,
      projectId: schema.tasks.projectId,
      projectName: schema.projects.name,
      outputBranch: schema.tasks.outputBranch,
      outputPrUrl: schema.tasks.outputPrUrl,
      outputSummary: schema.tasks.outputSummary,
      updatedAt: schema.tasks.updatedAt,
    })
    .from(schema.tasks)
    .innerJoin(schema.projects, eq(schema.tasks.projectId, schema.projects.id))
    .where(and(...conditions))
    .orderBy(desc(schema.tasks.updatedAt))
    .limit(searchLimit);

  const snippetLength = limits.taskDescriptionSnippetLength;
  const tasks = rows.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    projectId: task.projectId,
    projectName: task.projectName,
    descriptionSnippet: snippet(task.description, snippetLength),
    outputBranch: task.outputBranch,
    outputPrUrl: task.outputPrUrl,
    outputSummary: snippet(task.outputSummary, snippetLength),
    updatedAt: task.updatedAt,
  }));

  return {
    tasks,
    count: tasks.length,
    ...normalizedQuery,
  };
}
