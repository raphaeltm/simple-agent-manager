/**
 * SAM create_idea tool — create a lightweight idea (draft task) for future work.
 *
 * Ideas are stored as tasks with status='draft' in D1.
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { Env } from '../../../env';
import { log } from '../../../lib/logger';
import { ulid } from '../../../lib/ulid';
import type { AnthropicToolDef, ToolContext } from '../types';

const DEFAULT_TITLE_MAX_LENGTH = 200;
const DEFAULT_DESCRIPTION_MAX_LENGTH = 5000;
const DEFAULT_MAX_IDEAS_PER_PROJECT = 500;

export const createIdeaDef: AnthropicToolDef = {
  name: 'create_idea',
  description:
    'Create an idea — a lightweight note or task for future work. ' +
    'Ideas are stored as draft tasks in the project. ' +
    'Use this to capture feature ideas, bugs, or improvements during conversation.',
  input_schema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID to create the idea in.',
      },
      title: {
        type: 'string',
        description: 'Short title for the idea.',
      },
      description: {
        type: 'string',
        description: 'Detailed description of the idea.',
      },
      priority: {
        type: 'number',
        description: 'Priority level (0=normal, higher=more important). Defaults to 0.',
      },
    },
    required: ['projectId', 'title'],
  },
};

export async function createIdea(
  input: { projectId: string; title: string; description?: string; priority?: number },
  ctx: ToolContext,
): Promise<unknown> {
  const env = ctx.env as unknown as Env;
  const db = drizzle(env.DATABASE, { schema });

  if (!input.projectId?.trim()) {
    return { error: 'projectId is required.' };
  }
  if (!input.title?.trim()) {
    return { error: 'title is required.' };
  }

  const titleMaxLen = Number(env.SAM_IDEA_TITLE_MAX_LENGTH) || DEFAULT_TITLE_MAX_LENGTH;
  const descMaxLen = Number(env.SAM_IDEA_DESCRIPTION_MAX_LENGTH) || DEFAULT_DESCRIPTION_MAX_LENGTH;
  const maxIdeas = Number(env.SAM_MAX_IDEAS_PER_PROJECT) || DEFAULT_MAX_IDEAS_PER_PROJECT;

  const title = input.title.trim().slice(0, titleMaxLen);
  const description = input.description?.trim().slice(0, descMaxLen) ?? null;
  const priority = typeof input.priority === 'number'
    ? Math.min(Math.max(0, Math.round(input.priority)), 10)
    : 0;

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

  // Enforce per-project limit
  const countRow = await env.DATABASE.prepare(
    "SELECT COUNT(*) as cnt FROM tasks WHERE project_id = ? AND status = 'draft'",
  ).bind(input.projectId).first<{ cnt: number }>();
  if (countRow && countRow.cnt >= maxIdeas) {
    return { error: `Maximum ideas per project (${maxIdeas}) reached.` };
  }

  // Insert idea as a draft task
  const id = ulid();
  const now = new Date().toISOString();
  await env.DATABASE.prepare(
    `INSERT INTO tasks (id, project_id, user_id, title, description, status, priority, task_mode, dispatch_depth, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, 'task', 0, ?, ?, ?)`,
  ).bind(id, input.projectId, ctx.userId, title, description, priority, ctx.userId, now, now).run();

  log.info('sam.create_idea.created', {
    ideaId: id,
    projectId: input.projectId,
    title,
  });

  return {
    ideaId: id,
    title,
    description: description ? `${description.length} chars` : null,
    priority,
    status: 'draft',
    message: 'Idea created successfully.',
  };
}
