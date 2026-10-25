import { parseCompletionEvidenceJson } from '@simple-agent-manager/shared';
import { and, desc, eq, type SQL, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { getSearchQueryLikePatterns, normalizeSearchQuery } from '../lib/search-query-limits';
import { getRecentAssistantMessagesForTask } from '../services/task-final-assistant-message';
import { membershipCondition, operationLink } from './connector-read-core';
import { formatOperationCursor, readOperationCursor } from './cursors';
import { OperationError } from './errors';
import { clampOperationNumber, getPlatformOperationLimits } from './limits';
import type { OperationContext } from './types';

type TaskSearchRow = {
  id: string;
  projectId: string;
  triggeredBy: string | null;
  connectorClientName: string | null;
  title: string;
  status: string;
  priority: number;
  description: string | null;
  outputBranch: string | null;
  outputPrUrl: string | null;
  outputSummary: string | null;
  updatedAt: string;
};

function truncateSnippet(value: string | null, maxLength: number): string | null {
  if (!value) return null;
  return value.slice(0, maxLength) + (value.length > maxLength ? '...' : '');
}

function toTaskSearchResult(task: TaskSearchRow, snippetLength: number, external = false) {
  return {
    id: task.id,
    ...(external
      ? {
          projectId: task.projectId,
          triggeredBy: task.triggeredBy,
          connectorClientName: task.connectorClientName,
        }
      : {}),
    title: task.title,
    status: task.status,
    priority: task.priority,
    descriptionSnippet: truncateSnippet(task.description, snippetLength),
    outputBranch: task.outputBranch,
    outputPrUrl: task.outputPrUrl,
    outputSummary: truncateSnippet(task.outputSummary, snippetLength),
    updatedAt: task.updatedAt,
  };
}

export async function getTask(ctx: OperationContext, projectId: string, taskId: string) {
  const id = typeof taskId === 'string' ? taskId.trim() : '';
  if (!id) throw new OperationError('invalid_input', 'taskId is required');
  const db = drizzle(ctx.env.DATABASE, { schema });
  const rows = await db
    .select({
      id: schema.tasks.id,
      projectId: schema.tasks.projectId,
      triggeredBy: schema.tasks.triggeredBy,
      connectorClientName: schema.tasks.connectorClientName,
      title: schema.tasks.title,
      description: schema.tasks.description,
      status: schema.tasks.status,
      priority: schema.tasks.priority,
      outputBranch: schema.tasks.outputBranch,
      outputPrUrl: schema.tasks.outputPrUrl,
      outputSummary: schema.tasks.outputSummary,
      completionEvidence: schema.tasks.completionEvidence,
      errorMessage: schema.tasks.errorMessage,
      chatSessionId: schema.tasks.chatSessionId,
      createdAt: schema.tasks.createdAt,
      updatedAt: schema.tasks.updatedAt,
      startedAt: schema.tasks.startedAt,
      completedAt: schema.tasks.completedAt,
    })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.id, id), eq(schema.tasks.projectId, projectId)))
    .limit(1);
  const task = rows[0];
  if (!task) throw new OperationError('not_found', 'Task not found in this project');
  // One whole-message read serves both fields: the newest reply is the final message.
  const recent = await getRecentAssistantMessagesForTask(
    ctx.env,
    projectId,
    task.chatSessionId,
    getPlatformOperationLimits(ctx.env).taskDetailRecentMessageLimit
  );
  const finalAssistantMessage = recent[0] ?? null;
  const recentAssistantMessages = recent.map((message) => ({
    ...message,
    role: 'assistant' as const,
  }));
  return {
    id: task.id,
    ...(ctx.actor.via !== 'workspace-agent'
      ? {
          projectId: task.projectId,
          triggeredBy: task.triggeredBy,
          connectorClientName: task.connectorClientName,
          link: operationLink(ctx, task.projectId, task.chatSessionId ?? undefined),
          untrustedContent: true,
        }
      : {}),
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    outputBranch: task.outputBranch,
    outputPrUrl: task.outputPrUrl,
    outputSummary: task.outputSummary,
    completionEvidence: parseCompletionEvidenceJson(task.completionEvidence ?? null),
    finalAssistantMessage,
    errorMessage: task.errorMessage,
    sessionId: task.chatSessionId,
    recentAssistantMessages,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
  };
}

type ListTasksInput = {
  projectId?: string;
  query?: string;
  search?: boolean;
  status?: string;
  include_own?: boolean;
  cursor?: string;
  limit?: number;
};

export async function listTasks(ctx: OperationContext, input: ListTasksInput) {
  const limits = getPlatformOperationLimits(ctx.env);
  const search = input.search || input.query !== undefined;
  const inputQuery = typeof input.query === 'string' ? input.query.trim() : '';
  if (search && !inputQuery)
    throw new OperationError('invalid_input', 'query is required and must be a non-empty string');
  if (search && inputQuery.length < 2)
    throw new OperationError('invalid_input', 'query must be at least 2 characters');
  const normalizedQuery = search ? normalizeSearchQuery(inputQuery, ctx.env) : null;
  const requestedLimit =
    typeof input.limit === 'number'
      ? input.limit
      : search
        ? limits.taskSearchLimit
        : limits.taskListLimit;
  const limit = clampOperationNumber(
    requestedLimit,
    1,
    search ? limits.taskSearchMax : limits.taskListMax,
    'limit'
  );
  const db = drizzle(ctx.env.DATABASE, { schema });
  const conditions: SQL[] = input.projectId
    ? [eq(schema.tasks.projectId, input.projectId)]
    : [membershipCondition(ctx, schema.tasks.projectId)];
  if (ctx.actor.workspace)
    conditions.push(eq(schema.tasks.projectId, ctx.actor.workspace.projectId));
  if (search && normalizedQuery) {
    conditions.push(
      ...getSearchQueryLikePatterns(normalizedQuery.query).map(
        (pattern) =>
          sql<boolean>`(${schema.tasks.title} LIKE ${pattern} ESCAPE '\\' OR ${schema.tasks.description} LIKE ${pattern} ESCAPE '\\')`
      )
    );
  }
  if (input.status) conditions.push(eq(schema.tasks.status, input.status));
  const cursor = readOperationCursor(input.cursor);
  if (cursor)
    conditions.push(
      sql`(${schema.tasks.updatedAt} < ${cursor.updatedAt} OR (${schema.tasks.updatedAt} = ${cursor.updatedAt} AND ${schema.tasks.id} < ${cursor.id}))`
    );
  const external = ctx.actor.via !== 'workspace-agent';
  const includeOwn = input.include_own === true;
  // A workspace agent's own task is hidden unless it asks for it. Fetch one row to
  // replace it and one more to learn whether another page exists.
  const ownTaskId = search || includeOwn ? undefined : ctx.actor.workspace?.taskId;
  const fetchLimit = limit + 1 + (ownTaskId ? 1 : 0);
  const rows = await db
    .select({
      id: schema.tasks.id,
      projectId: schema.tasks.projectId,
      triggeredBy: schema.tasks.triggeredBy,
      connectorClientName: schema.tasks.connectorClientName,
      title: schema.tasks.title,
      description: schema.tasks.description,
      status: schema.tasks.status,
      priority: schema.tasks.priority,
      outputBranch: schema.tasks.outputBranch,
      outputPrUrl: schema.tasks.outputPrUrl,
      outputSummary: schema.tasks.outputSummary,
      ...(search ? {} : { createdAt: schema.tasks.createdAt }),
      updatedAt: schema.tasks.updatedAt,
    })
    .from(schema.tasks)
    .where(and(...conditions))
    .orderBy(desc(schema.tasks.updatedAt), desc(schema.tasks.id))
    .limit(fetchLimit);
  const visible = ownTaskId ? rows.filter((task) => task.id !== ownTaskId) : rows;
  const tasks = visible.slice(0, limit);
  const hasMore = visible.length > limit;
  const result = tasks.map((task) => ({
    ...toTaskSearchResult(task, limits.taskDescriptionSnippetLength, external),
    ...(external ? { link: operationLink(ctx, task.projectId) } : {}),
  }));
  const last = tasks[tasks.length - 1];
  const nextCursor = hasMore && last ? formatOperationCursor(last) : null;
  return {
    tasks: result,
    count: result.length,
    ...(normalizedQuery ?? {}),
    // Agents must be able to tell a full page from a complete answer.
    ...(external ? { nextCursor } : { hasMore, nextCursor }),
  };
}
