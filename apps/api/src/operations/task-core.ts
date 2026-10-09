import { parseCompletionEvidenceJson } from '@simple-agent-manager/shared';
import { and, desc, eq, type SQL, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { log } from '../lib/logger';
import { getSearchQueryLikePatterns, normalizeSearchQuery } from '../lib/search-query-limits';
import * as projectDataService from '../services/project-data';
import { getLatestAssistantMessageForTask } from '../services/task-final-assistant-message';
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

async function loadRecentAssistantMessages(
  ctx: OperationContext,
  projectId: string,
  sessionId: string | null
) {
  if (!sessionId) return [];
  try {
    const { messages } = await projectDataService.getMessages(
      ctx.env,
      projectId,
      sessionId,
      getPlatformOperationLimits(ctx.env).taskDetailRecentMessageLimit,
      null,
      null,
      ['assistant'],
      false,
      'desc'
    );
    return messages
      .filter((message) => message.role === 'assistant' && typeof message.content === 'string')
      .map((message) => ({
        id: String(message.id),
        role: 'assistant' as const,
        content:
          truncateSnippet(
            message.content as string,
            getPlatformOperationLimits(ctx.env).taskDetailMessageSnippetLength
          ) ?? '',
        createdAt:
          typeof message.createdAt === 'number' || typeof message.createdAt === 'string'
            ? message.createdAt
            : null,
      }));
  } catch (error) {
    log.warn('mcp.get_task_details.recent_assistant_messages_failed', {
      projectId,
      sessionId,
      error: String(error),
    });
    return [];
  }
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
  const recentAssistantMessages = await loadRecentAssistantMessages(
    ctx,
    projectId,
    task.chatSessionId
  );
  const finalAssistantMessage = await getLatestAssistantMessageForTask(
    ctx.env,
    projectId,
    task.chatSessionId
  );
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
  const fetchLimit = external ? limit + 1 : search || includeOwn ? limit : limit + 1;
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
  const tasks = (
    search || includeOwn ? rows : rows.filter((task) => task.id !== ctx.actor.workspace?.taskId)
  ).slice(0, limit);
  const result = tasks.map((task) => ({
    ...toTaskSearchResult(task, limits.taskDescriptionSnippetLength, external),
    ...(external ? { link: operationLink(ctx, task.projectId) } : {}),
  }));
  const last = tasks[tasks.length - 1];
  return {
    tasks: result,
    count: result.length,
    ...(normalizedQuery ?? {}),
    ...(external
      ? { nextCursor: rows.length > limit && last ? formatOperationCursor(last) : null }
      : {}),
  };
}
