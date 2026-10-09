import { log } from '../lib/logger';
import { sanitizeUserInput } from '../lib/sanitize-user-input';
import { getSearchQueryLikePatterns, normalizeSearchQuery } from '../lib/search-query-limits';
import { ulid } from '../lib/ulid';
import { OperationError } from './errors';
import { clampOperationNumber, getPlatformOperationLimits } from './limits';
import type { OperationContext } from './types';

export type IdeasSearchInput = {
  projectId: string;
  query?: string;
  search?: boolean;
  related?: boolean;
  status?: string;
  limit?: number;
};
export type IdeaCreateInput = {
  projectId: string;
  title: string;
  content?: string;
  priority?: number;
};
export type IdeaUpdateInput = {
  projectId: string;
  ideaId: string;
  title?: string;
  content?: string;
  append?: boolean;
  priority?: number;
  status?: string;
};

function normalizedIdeaQuery(query: unknown, ctx: OperationContext) {
  const value = typeof query === 'string' ? query.trim() : '';
  if (!value) throw new OperationError('invalid_input', 'query is required');
  if (value.length < 2)
    throw new OperationError('invalid_input', 'query must be at least 2 characters');
  return normalizeSearchQuery(value, ctx.env);
}

export async function searchIdeas(ctx: OperationContext, input: IdeasSearchInput) {
  const limits = getPlatformOperationLimits(ctx.env);
  const related = input.related === true;
  const search = related || input.search === true || input.query !== undefined;
  const normalizedQuery = search ? normalizedIdeaQuery(input.query, ctx) : null;
  const requestedLimit =
    typeof input.limit === 'number'
      ? input.limit
      : related
        ? limits.relatedIdeaSearchLimit
        : search
          ? limits.ideaSearchMax
          : limits.ideaListLimit;
  const limit = clampOperationNumber(
    requestedLimit,
    1,
    related ? limits.taskSearchMax : search ? limits.ideaSearchMax : limits.ideaListMax,
    'limit'
  );
  const snippetLength = limits.taskDescriptionSnippetLength;
  if (!search) {
    const results = await ctx.env.DATABASE.prepare(
      'SELECT id, title, description, priority, created_at, updated_at FROM tasks WHERE project_id = ? AND status = ? ORDER BY updated_at DESC LIMIT ?'
    )
      .bind(input.projectId, 'draft', limit)
      .all<{
        id: string;
        title: string;
        description: string | null;
        priority: number;
        created_at: string;
        updated_at: string;
      }>();
    const ideas = (results.results ?? []).map((idea) => ({
      ideaId: idea.id,
      title: idea.title,
      contentSnippet: idea.description
        ? idea.description.slice(0, snippetLength) +
          (idea.description.length > snippetLength ? '...' : '')
        : null,
      priority: idea.priority,
      createdAt: idea.created_at,
      updatedAt: idea.updated_at,
    }));
    return { ideas, count: results.results?.length ?? 0 };
  }
  if (!normalizedQuery) throw new OperationError('invalid_input', 'query is required');
  const patterns = getSearchQueryLikePatterns(normalizedQuery.query);
  const termConditions = patterns
    .map(() => String.raw`(title LIKE ? ESCAPE '\' OR description LIKE ? ESCAPE '\')`)
    .join(' AND ');
  if (related) {
    const statusFilter = typeof input.status === 'string' ? input.status.trim() : 'draft';
    const results = await ctx.env.DATABASE.prepare(
      `SELECT id, title, description, status, priority, updated_at FROM tasks WHERE project_id = ? AND ${termConditions} AND status = ? ORDER BY updated_at DESC LIMIT ?`
    )
      .bind(
        input.projectId,
        ...patterns.flatMap((pattern) => [pattern, pattern]),
        statusFilter,
        limit
      )
      .all<{
        id: string;
        title: string;
        description: string | null;
        status: string;
        priority: number;
        updated_at: string;
      }>();
    const ideas = (results.results ?? []).map((idea) => ({
      taskId: idea.id,
      title: idea.title,
      status: idea.status,
      priority: idea.priority,
      description: idea.description
        ? idea.description.slice(0, snippetLength) +
          (idea.description.length > snippetLength ? '...' : '')
        : null,
      updatedAt: idea.updated_at,
    }));
    return { ideas, count: results.results?.length ?? 0, ...normalizedQuery };
  }
  const results = await ctx.env.DATABASE.prepare(
    `SELECT id, title, description, priority, created_at, updated_at FROM tasks WHERE project_id = ? AND status = ? AND ${termConditions} ORDER BY updated_at DESC LIMIT ?`
  )
    .bind(input.projectId, 'draft', ...patterns.flatMap((pattern) => [pattern, pattern]), limit)
    .all<{
      id: string;
      title: string;
      description: string | null;
      priority: number;
      created_at: string;
      updated_at: string;
    }>();
  const ideas = (results.results ?? []).map((idea) => ({
    ideaId: idea.id,
    title: idea.title,
    contentSnippet: idea.description
      ? idea.description.slice(0, snippetLength) +
        (idea.description.length > snippetLength ? '...' : '')
      : null,
    priority: idea.priority,
    createdAt: idea.created_at,
    updatedAt: idea.updated_at,
  }));
  return { ideas, count: results.results?.length ?? 0, ...normalizedQuery };
}

export async function getIdea(ctx: OperationContext, projectId: string, ideaId: string) {
  const id = typeof ideaId === 'string' ? ideaId.trim() : '';
  if (!id) throw new OperationError('invalid_input', 'ideaId is required');
  const idea = await ctx.env.DATABASE.prepare(
    'SELECT id, title, description, status, priority, created_at, updated_at FROM tasks WHERE id = ? AND project_id = ?'
  )
    .bind(id, projectId)
    .first<{
      id: string;
      title: string;
      description: string | null;
      status: string;
      priority: number;
      created_at: string;
      updated_at: string;
    }>();
  if (!idea) throw new OperationError('not_found', `Idea not found in this project: ${id}`);
  return {
    ideaId: idea.id,
    title: idea.title,
    content: idea.description,
    contentLength: idea.description?.length ?? 0,
    priority: idea.priority,
    status: idea.status,
    createdAt: idea.created_at,
    updatedAt: idea.updated_at,
  };
}

export async function createIdea(ctx: OperationContext, input: IdeaCreateInput) {
  const limits = getPlatformOperationLimits(ctx.env);
  const title =
    typeof input.title === 'string'
      ? sanitizeUserInput(input.title.trim()).slice(0, limits.ideaTitleMaxLength)
      : '';
  if (!title)
    throw new OperationError('invalid_input', 'title is required and must be a non-empty string');
  const content =
    typeof input.content === 'string'
      ? sanitizeUserInput(input.content).slice(0, limits.ideaContentMaxLength)
      : null;
  const priority =
    typeof input.priority === 'number'
      ? clampOperationNumber(input.priority, 0, limits.dispatchMaxPriority, 'priority')
      : 0;
  const ideaId = ulid();
  const now = new Date().toISOString();
  await ctx.env.DATABASE.prepare(
    `INSERT INTO tasks (id, project_id, user_id, title, description, status, priority, task_mode, dispatch_depth, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, 'task', 0, ?, ?, ?)`
  )
    .bind(
      ideaId,
      input.projectId,
      ctx.actor.userId,
      title,
      content,
      priority,
      ctx.actor.userId,
      now,
      now
    )
    .run();
  log.info('mcp.create_idea', {
    ideaId,
    projectId: input.projectId,
    userId: ctx.actor.userId,
    titleLength: title.length,
    contentLength: content?.length ?? 0,
  });
  try {
    const { bridgeIdeaCreated } = await import('../services/trial/bridge');
    await bridgeIdeaCreated(ctx.env, input.projectId, ideaId, title, (content ?? '').slice(0, 280));
  } catch {
    /* The trial bridge never blocks idea creation. */
  }
  return {
    ideaId,
    title,
    contentLength: content?.length ?? 0,
    priority,
    status: 'draft',
    message: 'Idea created. Use link_idea to associate it with the current session.',
  };
}

const IDEA_STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: ['ready', 'cancelled'],
  ready: ['draft', 'completed', 'cancelled'],
};
export function validateIdeaStatusTransition(
  currentStatus: string,
  newStatus: string
): string | null {
  const allowed = IDEA_STATUS_TRANSITIONS[currentStatus];
  if (!allowed) return `Cannot update idea in terminal status '${currentStatus}'`;
  if (!allowed.includes(newStatus))
    return `Invalid status transition: ${currentStatus} → ${newStatus}. Allowed: ${allowed.join(', ')}`;
  return null;
}

export async function updateIdea(ctx: OperationContext, input: IdeaUpdateInput) {
  const limits = getPlatformOperationLimits(ctx.env);
  const ideaId = typeof input.ideaId === 'string' ? input.ideaId.trim() : '';
  if (!ideaId) throw new OperationError('invalid_input', 'ideaId is required');
  const existing = await ctx.env.DATABASE.prepare(
    'SELECT id, title, description, status, priority FROM tasks WHERE id = ? AND project_id = ?'
  )
    .bind(ideaId, input.projectId)
    .first<{
      id: string;
      title: string;
      description: string | null;
      status: string;
      priority: number;
    }>();
  if (!existing) throw new OperationError('not_found', `Idea not found in this project: ${ideaId}`);
  if (!(existing.status in IDEA_STATUS_TRANSITIONS))
    throw new OperationError(
      'conflict',
      `Cannot update idea in terminal status '${existing.status}'`
    );
  const updates: string[] = [];
  const bindValues: unknown[] = [];
  let statusTransition: { from: string; to: string } | null = null;
  if (typeof input.status === 'string') {
    const nextStatus = input.status.trim();
    const error = validateIdeaStatusTransition(existing.status, nextStatus);
    if (error) throw new OperationError('conflict', error);
    updates.push('status = ?');
    bindValues.push(nextStatus);
    statusTransition = { from: existing.status, to: nextStatus };
  }
  if (typeof input.title === 'string') {
    const title = sanitizeUserInput(input.title.trim()).slice(0, limits.ideaTitleMaxLength);
    if (title) {
      updates.push('title = ?');
      bindValues.push(title);
    }
  }
  if (typeof input.content === 'string') {
    const content = sanitizeUserInput(input.content).slice(0, limits.ideaContentMaxLength);
    if (input.append !== false) {
      updates.push(
        'description = CASE WHEN description IS NULL THEN ? ELSE substr(description || char(10) || char(10) || ?, 1, ?) END'
      );
      bindValues.push(content, content, limits.ideaContentMaxLength);
    } else {
      updates.push('description = ?');
      bindValues.push(content);
    }
  }
  if (typeof input.priority === 'number') {
    updates.push('priority = ?');
    bindValues.push(
      clampOperationNumber(input.priority, 0, limits.dispatchMaxPriority, 'priority')
    );
  }
  if (updates.length === 0)
    throw new OperationError(
      'invalid_input',
      'No fields to update. Provide at least one of: title, content, priority, status.'
    );
  updates.push('updated_at = ?');
  const now = new Date().toISOString();
  bindValues.push(now, ideaId, input.projectId);
  const statement = ctx.env.DATABASE.prepare(
    `UPDATE tasks SET ${updates.join(', ')} WHERE id = ? AND project_id = ?`
  ).bind(...bindValues);
  if (statusTransition) {
    const event = ctx.env.DATABASE.prepare(
      `INSERT INTO task_status_events (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
       VALUES (?, ?, ?, ?, 'user', ?, ?, ?)`
    ).bind(ulid(), ideaId, statusTransition.from, statusTransition.to, ctx.actor.userId, null, now);
    await ctx.env.DATABASE.batch([statement, event]);
  } else {
    await statement.run();
  }
  const updatedFields = updates
    .filter((update) => !update.startsWith('updated_at'))
    .map((update) => update.split(' = ')[0]);
  log.info('mcp.update_idea', {
    ideaId,
    projectId: input.projectId,
    updatedFields,
    ...(statusTransition
      ? { statusTransition: `${statusTransition.from} → ${statusTransition.to}` }
      : {}),
  });
  return { updated: true, ideaId, updatedFields };
}
