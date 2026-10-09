/**
 * MCP idea tools — session-idea linking (link_idea, unlink_idea, list_linked_ideas,
 * find_related_ideas) and idea management (create_idea, update_idea, get_idea,
 * list_ideas, search_ideas).
 */
import type { Env } from '../../env';
import { runWorkspaceOperation } from '../../operations/workspace-adapter';
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
  env: Env
): Promise<JsonRpcResponse> {
  const taskId = typeof params.taskId === 'string' ? params.taskId.trim() : '';
  if (!taskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'taskId is required');
  }

  const limits = getMcpLimits(env);
  const context =
    typeof params.context === 'string'
      ? sanitizeUserInput(params.context.trim()).slice(0, limits.ideaContextMaxLength)
      : null;

  // Resolve session ID from workspace
  const sessionId = await resolveSessionId(env, tokenData.workspaceId);
  if (!sessionId) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'No chat session found for the current workspace'
    );
  }

  // Verify the task exists in this project
  const task = await env.DATABASE.prepare(
    'SELECT id, title FROM tasks WHERE id = ? AND project_id = ?'
  )
    .bind(taskId, tokenData.projectId)
    .first<{ id: string; title: string }>();

  if (!task) {
    return jsonRpcError(requestId, INVALID_PARAMS, `Idea not found in this project: ${taskId}`);
  }

  await projectDataService.linkSessionIdea(env, tokenData.projectId, sessionId, taskId, context);

  return jsonRpcSuccess(requestId, {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            linked: true,
            sessionId,
            taskId,
            taskTitle: task.title,
            context,
          },
          null,
          2
        ),
      },
    ],
  });
}

export async function handleUnlinkIdea(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const taskId = typeof params.taskId === 'string' ? params.taskId.trim() : '';
  if (!taskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'taskId is required');
  }

  const sessionId = await resolveSessionId(env, tokenData.workspaceId);
  if (!sessionId) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'No chat session found for the current workspace'
    );
  }

  await projectDataService.unlinkSessionIdea(env, tokenData.projectId, sessionId, taskId);

  return jsonRpcSuccess(requestId, {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ unlinked: true, sessionId, taskId }, null, 2),
      },
    ],
  });
}

export async function handleListLinkedIdeas(
  requestId: string | number | null,
  _params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const sessionId = await resolveSessionId(env, tokenData.workspaceId);
  if (!sessionId) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'No chat session found for the current workspace'
    );
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
      `SELECT id, title, status FROM tasks WHERE project_id = ? AND id IN (${placeholders})`
    )
      .bind(tokenData.projectId, ...links.map((l) => l.taskId))
      .all<{ id: string; title: string; status: string }>();

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
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            sessionId,
            ideas: enriched,
            count: enriched.length,
          },
          null,
          2
        ),
      },
    ],
  });
}

export async function handleFindRelatedIdeas(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  return runWorkspaceOperation('find_related_ideas', requestId, params, tokenData, env);
}

// ─── Idea management handlers ────────────────────────────────────────────────

export async function handleCreateIdea(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  return runWorkspaceOperation('create_idea', requestId, params, tokenData, env);
}

export { validateIdeaStatusTransition } from '../../operations/idea-core';

export async function handleUpdateIdea(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  return runWorkspaceOperation('update_idea', requestId, params, tokenData, env);
}

export async function handleGetIdea(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  return runWorkspaceOperation('get_idea', requestId, params, tokenData, env);
}

export async function handleListIdeas(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  return runWorkspaceOperation('list_ideas', requestId, params, tokenData, env);
}

export async function handleSearchIdeas(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  return runWorkspaceOperation('search_ideas', requestId, params, tokenData, env);
}
