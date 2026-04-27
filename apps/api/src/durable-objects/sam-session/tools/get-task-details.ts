/**
 * SAM get_task_details tool — get full details of a task.
 *
 * Queries D1 tasks table with ownership verification via projects join.
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { AnthropicToolDef, ToolContext } from '../types';

export const getTaskDetailsDef: AnthropicToolDef = {
  name: 'get_task_details',
  description:
    'Get full details of a specific task including output, PR URL, error message, and timing. ' +
    'Use this to check on task progress or investigate failures.',
  input_schema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The task ID to look up.',
      },
    },
    required: ['taskId'],
  },
};

export async function getTaskDetails(
  input: { taskId: string },
  ctx: ToolContext,
): Promise<unknown> {
  if (!input.taskId?.trim()) {
    return { error: 'taskId is required.' };
  }

  const db = drizzle(ctx.env.DATABASE as D1Database, { schema });

  // Join tasks with projects to verify the user owns the project
  const rows = await db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      description: schema.tasks.description,
      status: schema.tasks.status,
      priority: schema.tasks.priority,
      outputBranch: schema.tasks.outputBranch,
      outputPrUrl: schema.tasks.outputPrUrl,
      outputSummary: schema.tasks.outputSummary,
      errorMessage: schema.tasks.errorMessage,
      executionStep: schema.tasks.executionStep,
      createdAt: schema.tasks.createdAt,
      updatedAt: schema.tasks.updatedAt,
      startedAt: schema.tasks.startedAt,
      completedAt: schema.tasks.completedAt,
      projectId: schema.tasks.projectId,
      projectName: schema.projects.name,
    })
    .from(schema.tasks)
    .innerJoin(schema.projects, eq(schema.tasks.projectId, schema.projects.id))
    .where(
      and(
        eq(schema.tasks.id, input.taskId.trim()),
        eq(schema.projects.userId, ctx.userId),
      ),
    )
    .limit(1);

  const task = rows[0];
  if (!task) {
    return { error: 'Task not found or not owned by you.' };
  }

  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    executionStep: task.executionStep,
    priority: task.priority,
    outputBranch: task.outputBranch,
    outputPrUrl: task.outputPrUrl,
    outputSummary: task.outputSummary,
    errorMessage: task.errorMessage,
    projectId: task.projectId,
    projectName: task.projectName,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
  };
}
