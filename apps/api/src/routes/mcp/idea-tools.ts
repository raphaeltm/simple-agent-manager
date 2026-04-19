/**
 * MCP idea tools — session-idea linking (link_idea, unlink_idea, list_linked_ideas,
 * find_related_ideas) and idea management (create_idea, update_idea, get_idea,
 * list_ideas, search_ideas).
 */
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import * as projectDataService from '../../services/project-data';
import {
  getMcpLimits,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
  resolveSessionId,
  sanitizeUserInput,
} from './_helpers';

export async function handleLinkIdea(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const taskId = typeof params.taskId === 'string' ? params.taskId.trim() : '';
  if (!taskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'taskId is required');
  }

  const limits = getMcpLimits(env);
  const context = typeof params.context === 'string' ? sanitizeUserInput(params.context.trim()).slice(0, limits.ideaContextMaxLength) : null;

  // Resolve session ID from workspace
  const sessionId = await resolveSessionId(env, tokenData.workspaceId);
  if (!sessionId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'No chat session found for the current workspace');
  }

  // Verify the task exists in this project
  const task = await env.DATABASE.prepare(
    'SELECT id, title FROM tasks WHERE id = ? AND project_id = ?',
  ).bind(taskId, tokenData.projectId).first<{ id: string; title: string }>();

  if (!task) {
    return jsonRpcError(requestId, INVALID_PARAMS, `Idea not found in this project: ${taskId}`);
  }

  await projectDataService.linkSessionIdea(env, tokenData.projectId, sessionId, taskId, context);

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        linked: true,
        sessionId,
        taskId,
        taskTitle: task.title,
        context,
      }, null, 2),
    }],
  });
}

export async function handleUnlinkIdea(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const taskId = typeof params.taskId === 'string' ? params.taskId.trim() : '';
  if (!taskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'taskId is required');
  }

  const sessionId = await resolveSessionId(env, tokenData.workspaceId);
  if (!sessionId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'No chat session found for the current workspace');
  }

  await projectDataService.unlinkSessionIdea(env, tokenData.projectId, sessionId, taskId);

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({ unlinked: true, sessionId, taskId }, null, 2),
    }],
  });
}

export async function handleListLinkedIdeas(
  requestId: string | number | null,
  _params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const sessionId = await resolveSessionId(env, tokenData.workspaceId);
  if (!sessionId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'No chat session found for the current workspace');
  }

  const links = await projectDataService.getIdeasForSession(env, tokenData.projectId, sessionId);

  // Enrich with task details from D1
  const enriched: Array<{
    taskId: string;
    title: string | null;
    status: string | null;
    context: string | null;
    linkedAt: number;
  }> = [];

  if (links.length > 0) {
    // Batch-fetch task details in a single D1 query
    const placeholders = links.map(() => '?').join(', ');
    const rows = await env.DATABASE.prepare(
      `SELECT id, title, status FROM tasks WHERE project_id = ? AND id IN (${placeholders})`,
    ).bind(tokenData.projectId, ...links.map((l) => l.taskId)).all<{ id: string; title: string; status: string }>();

    const taskMap = new Map((rows.results ?? []).map((t) => [t.id, t]));

    for (const link of links) {
      const task = taskMap.get(link.taskId);
      enriched.push({
        taskId: link.taskId,
        title: task?.title ?? null,
        status: task?.status ?? null,
        context: link.context,
        linkedAt: link.createdAt,
      });
    }
  }

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        sessionId,
        ideas: enriched,
        count: enriched.length,
      }, null, 2),
    }],
  });
}

export async function handleFindRelatedIdeas(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const query = typeof params.query === 'string' ? params.query.trim() : '';
  if (!query) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'query is required');
  }
  if (query.length < 2) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'query must be at least 2 characters');
  }

  const limits = getMcpLimits(env);
  const requestedLimit = typeof params.limit === 'number' ? params.limit : 10;
  const limit = Math.min(Math.max(1, Math.round(requestedLimit)), limits.taskSearchMax);
  // Default to 'draft' status (ideas) when no explicit status filter is provided
  const statusFilter = typeof params.status === 'string' ? params.status.trim() : 'draft';

  const searchPattern = `%${query}%`;

  let queryStr = `SELECT id, title, description, status, priority, updated_at FROM tasks WHERE project_id = ? AND (title LIKE ? OR description LIKE ?)`;
  const bindParams: unknown[] = [tokenData.projectId, searchPattern, searchPattern];

  queryStr += ' AND status = ?';
  bindParams.push(statusFilter);

  queryStr += ' ORDER BY updated_at DESC LIMIT ?';
  bindParams.push(limit);

  const stmt = env.DATABASE.prepare(queryStr);
  const results = await stmt.bind(...bindParams).all<{
    id: string;
    title: string;
    description: string | null;
    status: string;
    priority: number;
    updated_at: string;
  }>();

  const snippetLength = limits.taskDescriptionSnippetLength;

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        ideas: (results.results ?? []).map((t) => ({
          taskId: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          description: t.description
            ? t.description.slice(0, snippetLength) + (t.description.length > snippetLength ? '...' : '')
            : null,
          updatedAt: t.updated_at,
        })),
        count: results.results?.length ?? 0,
        query,
      }, null, 2),
    }],
  });
}

// ─── Idea management handlers ────────────────────────────────────────────────

export async function handleCreateIdea(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);

  const title = typeof params.title === 'string' ? sanitizeUserInput(params.title.trim()).slice(0, limits.ideaTitleMaxLength) : '';
  if (!title) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'title is required and must be a non-empty string');
  }

  const content = typeof params.content === 'string'
    ? sanitizeUserInput(params.content).slice(0, limits.ideaContentMaxLength)
    : null;

  const priority = typeof params.priority === 'number'
    ? Math.min(Math.max(0, Math.round(params.priority)), limits.dispatchMaxPriority)
    : 0;

  const ideaId = ulid();
  const now = new Date().toISOString();

  await env.DATABASE.prepare(
    `INSERT INTO tasks (id, project_id, user_id, title, description, status, priority, task_mode, dispatch_depth, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, 'task', 0, ?, ?, ?)`,
  ).bind(ideaId, tokenData.projectId, tokenData.userId, title, content, priority, tokenData.userId, now, now).run();

  log.info('mcp.create_idea', {
    ideaId,
    projectId: tokenData.projectId,
    userId: tokenData.userId,
    titleLength: title.length,
    contentLength: content?.length ?? 0,
  });

  // Trial bridge — surface freshly-created ideas as suggestion chips on the
  // /try/:trialId page via the SSE stream. Non-trial projects no-op after a
  // single KV lookup.
  try {
    const { bridgeIdeaCreated } = await import('../../services/trial/bridge');
    await bridgeIdeaCreated(
      env,
      tokenData.projectId,
      ideaId,
      title,
      (content ?? '').slice(0, 280),
    );
  } catch {
    // Bridge errors are logged inside the helper; never block MCP.
  }

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        ideaId,
        title,
        contentLength: content?.length ?? 0,
        priority,
        status: 'draft',
        message: 'Idea created. Use link_idea to associate it with the current session.',
      }, null, 2),
    }],
  });
}

// ─── Idea status transition validation ───────────────────────────────────────

/**
 * Allowed status transitions for the idea lifecycle. This intentionally diverges
 * from the full task lifecycle in task-status.ts because ideas follow a simpler
 * state machine:
 *   draft → ready → completed (or cancelled at any non-terminal stage)
 *
 * Notably:
 * - ready → completed is allowed here but not in task-status.ts (which requires
 *   going through queued/delegated/in_progress first). For ideas, "completed"
 *   means "the idea was executed," not that a task runner finished.
 * - ready → draft allows un-promoting an idea back to exploring.
 * - queued/delegated/in_progress are execution-layer statuses set by the task
 *   runner, not by the idea lifecycle MCP tool.
 */
const IDEA_STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: ['ready', 'cancelled'],
  ready: ['draft', 'completed', 'cancelled'],
  // completed and cancelled are terminal — no transitions out
};

/** Statuses that can be updated (derived from transition map keys). */
const UPDATABLE_IDEA_STATUSES = Object.keys(IDEA_STATUS_TRANSITIONS);

export function validateIdeaStatusTransition(
  currentStatus: string,
  newStatus: string,
): string | null {
  const allowed = IDEA_STATUS_TRANSITIONS[currentStatus];
  if (!allowed) {
    return `Cannot update idea in terminal status '${currentStatus}'`;
  }
  if (!allowed.includes(newStatus)) {
    return `Invalid status transition: ${currentStatus} → ${newStatus}. Allowed: ${allowed.join(', ')}`;
  }
  return null;
}

export async function handleUpdateIdea(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);

  const ideaId = typeof params.ideaId === 'string' ? params.ideaId.trim() : '';
  if (!ideaId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'ideaId is required');
  }

  // Fetch the existing idea — must be in a non-terminal status and in this project
  const existing = await env.DATABASE.prepare(
    'SELECT id, title, description, status, priority FROM tasks WHERE id = ? AND project_id = ?',
  ).bind(ideaId, tokenData.projectId).first<{ id: string; title: string; description: string | null; status: string; priority: number }>();

  if (!existing) {
    return jsonRpcError(requestId, INVALID_PARAMS, `Idea not found in this project: ${ideaId}`);
  }

  if (!UPDATABLE_IDEA_STATUSES.includes(existing.status)) {
    return jsonRpcError(requestId, INVALID_PARAMS, `Cannot update idea in terminal status '${existing.status}'`);
  }

  // Build update fields
  const updates: string[] = [];
  const bindValues: unknown[] = [];

  // Status transition
  let statusTransition: { from: string; to: string } | null = null;
  if (typeof params.status === 'string') {
    const newStatus = params.status.trim();
    const transitionError = validateIdeaStatusTransition(existing.status, newStatus);
    if (transitionError) {
      return jsonRpcError(requestId, INVALID_PARAMS, transitionError);
    }
    updates.push('status = ?');
    bindValues.push(newStatus);
    statusTransition = { from: existing.status, to: newStatus };
  }

  // Title update
  if (typeof params.title === 'string') {
    const newTitle = sanitizeUserInput(params.title.trim()).slice(0, limits.ideaTitleMaxLength);
    if (newTitle) {
      updates.push('title = ?');
      bindValues.push(newTitle);
    }
  }

  // Content update (append or replace) — uses atomic SQL CASE for append to avoid race conditions
  if (typeof params.content === 'string') {
    const newContent = sanitizeUserInput(params.content).slice(0, limits.ideaContentMaxLength);
    const append = params.append !== false; // default true

    if (append) {
      // Atomic append: concatenates in SQL to avoid read-then-write races
      updates.push('description = CASE WHEN description IS NULL THEN ? ELSE substr(description || char(10) || char(10) || ?, 1, ?) END');
      bindValues.push(newContent, newContent, limits.ideaContentMaxLength);
    } else {
      updates.push('description = ?');
      bindValues.push(newContent);
    }
  }

  // Priority update
  if (typeof params.priority === 'number') {
    const newPriority = Math.min(Math.max(0, Math.round(params.priority)), limits.dispatchMaxPriority);
    updates.push('priority = ?');
    bindValues.push(newPriority);
  }

  if (updates.length === 0) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'No fields to update. Provide at least one of: title, content, priority, status.');
  }

  updates.push('updated_at = ?');
  const now = new Date().toISOString();
  bindValues.push(now);
  bindValues.push(ideaId, tokenData.projectId);

  const updateStmt = env.DATABASE.prepare(
    `UPDATE tasks SET ${updates.join(', ')} WHERE id = ? AND project_id = ?`,
  ).bind(...bindValues);

  // Use D1 batch to atomically update the task and record the status event
  if (statusTransition) {
    const eventId = ulid();
    const eventStmt = env.DATABASE.prepare(
      `INSERT INTO task_status_events (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
       VALUES (?, ?, ?, ?, 'user', ?, ?, ?)`,
    ).bind(eventId, ideaId, statusTransition.from, statusTransition.to, tokenData.userId, now, now);
    await env.DATABASE.batch([updateStmt, eventStmt]);
  } else {
    await updateStmt.run();
  }

  log.info('mcp.update_idea', {
    ideaId,
    projectId: tokenData.projectId,
    updatedFields: updates.filter((u) => !u.startsWith('updated_at')).map((u) => u.split(' = ')[0]),
    ...(statusTransition ? { statusTransition: `${statusTransition.from} → ${statusTransition.to}` } : {}),
  });

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        updated: true,
        ideaId,
        updatedFields: updates.filter((u) => !u.startsWith('updated_at')).map((u) => u.split(' = ')[0]),
      }, null, 2),
    }],
  });
}

export async function handleGetIdea(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const ideaId = typeof params.ideaId === 'string' ? params.ideaId.trim() : '';
  if (!ideaId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'ideaId is required');
  }

  const idea = await env.DATABASE.prepare(
    'SELECT id, title, description, status, priority, created_at, updated_at FROM tasks WHERE id = ? AND project_id = ?',
  ).bind(ideaId, tokenData.projectId).first<{
    id: string;
    title: string;
    description: string | null;
    status: string;
    priority: number;
    created_at: string;
    updated_at: string;
  }>();

  if (!idea) {
    return jsonRpcError(requestId, INVALID_PARAMS, `Idea not found in this project: ${ideaId}`);
  }

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        ideaId: idea.id,
        title: idea.title,
        content: idea.description,
        contentLength: idea.description?.length ?? 0,
        priority: idea.priority,
        status: idea.status,
        createdAt: idea.created_at,
        updatedAt: idea.updated_at,
      }, null, 2),
    }],
  });
}

export async function handleListIdeas(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);
  const requestedLimit = typeof params.limit === 'number' ? params.limit : limits.ideaListLimit;
  const limit = Math.min(Math.max(1, Math.round(requestedLimit)), limits.ideaListMax);

  const snippetLength = limits.taskDescriptionSnippetLength;

  const results = await env.DATABASE.prepare(
    'SELECT id, title, description, priority, created_at, updated_at FROM tasks WHERE project_id = ? AND status = ? ORDER BY updated_at DESC LIMIT ?',
  ).bind(tokenData.projectId, 'draft', limit).all<{
    id: string;
    title: string;
    description: string | null;
    priority: number;
    created_at: string;
    updated_at: string;
  }>();

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        ideas: (results.results ?? []).map((idea) => ({
          ideaId: idea.id,
          title: idea.title,
          contentSnippet: idea.description
            ? idea.description.slice(0, snippetLength) + (idea.description.length > snippetLength ? '...' : '')
            : null,
          priority: idea.priority,
          createdAt: idea.created_at,
          updatedAt: idea.updated_at,
        })),
        count: results.results?.length ?? 0,
      }, null, 2),
    }],
  });
}

export async function handleSearchIdeas(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const query = typeof params.query === 'string' ? params.query.trim() : '';
  if (!query) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'query is required');
  }
  if (query.length < 2) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'query must be at least 2 characters');
  }

  const limits = getMcpLimits(env);
  const requestedLimit = typeof params.limit === 'number' ? params.limit : limits.ideaSearchMax;
  const limit = Math.min(Math.max(1, Math.round(requestedLimit)), limits.ideaSearchMax);
  const snippetLength = limits.taskDescriptionSnippetLength;

  const searchPattern = `%${query}%`;

  const results = await env.DATABASE.prepare(
    'SELECT id, title, description, priority, created_at, updated_at FROM tasks WHERE project_id = ? AND status = ? AND (title LIKE ? OR description LIKE ?) ORDER BY updated_at DESC LIMIT ?',
  ).bind(tokenData.projectId, 'draft', searchPattern, searchPattern, limit).all<{
    id: string;
    title: string;
    description: string | null;
    priority: number;
    created_at: string;
    updated_at: string;
  }>();

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        ideas: (results.results ?? []).map((idea) => ({
          ideaId: idea.id,
          title: idea.title,
          contentSnippet: idea.description
            ? idea.description.slice(0, snippetLength) + (idea.description.length > snippetLength ? '...' : '')
            : null,
          priority: idea.priority,
          createdAt: idea.created_at,
          updatedAt: idea.updated_at,
        })),
        count: results.results?.length ?? 0,
        query,
      }, null, 2),
    }],
  });
}
