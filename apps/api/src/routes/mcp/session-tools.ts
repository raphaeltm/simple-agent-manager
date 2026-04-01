/**
 * MCP session tools — list_sessions, get_session_messages, search_messages, update_session_topic.
 *
 * Also exports TokenRow and groupTokensIntoMessages for use by tests and other modules.
 */
import type { Env } from '../../index';
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
  VALID_MESSAGE_ROLES,
  validateRoles,
} from './_helpers';

export async function handleListSessions(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);
  const status = typeof params.status === 'string' ? params.status : null;
  const requestedLimit = typeof params.limit === 'number' ? params.limit : limits.sessionListLimit;
  const limit = Math.min(Math.max(1, Math.round(requestedLimit)), limits.sessionListMax);

  const { sessions, total } = await projectDataService.listSessions(
    env,
    tokenData.projectId,
    status,
    limit,
  );

  const result = sessions.map((s: Record<string, unknown>) => ({
    id: s.id,
    topic: s.topic,
    status: s.status,
    messageCount: s.messageCount,
    taskId: s.taskId,
    workspaceId: s.workspaceId,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
  }));

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify({ sessions: result, total }, null, 2) }],
  });
}

// Roles whose consecutive tokens should be concatenated into a single logical message.
// Mirrors the frontend groupMessages() in ProjectMessageView.tsx.
const GROUPABLE_ROLES = new Set(['assistant', 'tool', 'thinking']);

export interface TokenRow {
  id: string;
  role: string;
  content: string;
  createdAt: number;
}

/**
 * Groups consecutive same-role streaming tokens into logical messages.
 * Each row in chat_messages is an individual streaming chunk ("token").
 * This function concatenates consecutive tokens with the same groupable role
 * (assistant, tool, thinking) into a single message, using the first token's
 * id and createdAt. Non-groupable roles (user, system, plan) pass through as-is.
 */
export function groupTokensIntoMessages(tokens: TokenRow[]): TokenRow[] {
  const grouped: TokenRow[] = [];
  for (const token of tokens) {
    const last = grouped[grouped.length - 1];
    if (last && last.role === token.role && GROUPABLE_ROLES.has(token.role)) {
      last.content += token.content;
    } else {
      grouped.push({ ...token });
    }
  }
  return grouped;
}

export async function handleGetSessionMessages(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
  if (!sessionId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'sessionId is required');
  }

  const limits = getMcpLimits(env);
  const requestedLimit = typeof params.limit === 'number' ? params.limit : limits.messageListLimit;
  const limit = Math.min(Math.max(1, Math.round(requestedLimit)), limits.messageListMax);
  const rolesResult = validateRoles(params.roles);
  if (!rolesResult.valid) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Invalid roles: ${rolesResult.invalid.join(', ')}. Valid roles: ${VALID_MESSAGE_ROLES.join(', ')}`,
    );
  }
  const roles = rolesResult.roles;

  // Verify session belongs to this project
  const session = await projectDataService.getSession(env, tokenData.projectId, sessionId);
  if (!session) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Session not found in this project');
  }

  const { messages, hasMore } = await projectDataService.getMessages(
    env,
    tokenData.projectId,
    sessionId,
    limit,
    null,
    roles,
  );

  // Each row in chat_messages is a streaming token (chunk). Group consecutive
  // same-role tokens into logical messages before returning to agents.
  const tokens = messages.map((m: Record<string, unknown>) => ({
    id: m.id as string,
    role: m.role as string,
    content: m.content as string,
    createdAt: m.createdAt as number,
  }));
  const result = groupTokensIntoMessages(tokens);

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        sessionId,
        topic: session.topic,
        taskId: session.taskId,
        messages: result,
        messageCount: result.length,
        hasMore,
      }, null, 2),
    }],
  });
}

export async function handleSearchMessages(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const query = typeof params.query === 'string' ? params.query.trim() : '';
  if (!query) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'query is required and must be a non-empty string');
  }
  if (query.length < 2) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'query must be at least 2 characters');
  }

  const limits = getMcpLimits(env);
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : null;
  const rolesResult = validateRoles(params.roles);
  if (!rolesResult.valid) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Invalid roles: ${rolesResult.invalid.join(', ')}. Valid roles: ${VALID_MESSAGE_ROLES.join(', ')}`,
    );
  }
  const roles = rolesResult.roles;
  const requestedLimit = typeof params.limit === 'number' ? params.limit : 10;
  const limit = Math.min(Math.max(1, Math.round(requestedLimit)), limits.messageSearchMax);

  const results = await projectDataService.searchMessages(
    env,
    tokenData.projectId,
    query,
    sessionId,
    roles,
    limit,
  );

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        results: results.map((r) => ({
          messageId: r.id,
          sessionId: r.sessionId,
          sessionTopic: r.sessionTopic,
          sessionTaskId: r.sessionTaskId,
          role: r.role,
          snippet: r.snippet,
          createdAt: r.createdAt,
        })),
        count: results.length,
        query,
      }, null, 2),
    }],
  });
}

export async function handleUpdateSessionTopic(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const rawTopic = typeof params.topic === 'string' ? params.topic.trim() : '';
  if (!rawTopic) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'topic is required and must be a non-empty string');
  }

  const limits = getMcpLimits(env);
  const topic = sanitizeUserInput(rawTopic).slice(0, limits.sessionTopicMaxLength);

  if (!topic) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'topic must contain visible characters after sanitization');
  }

  // Resolve session ID from workspace
  const sessionId = await resolveSessionId(env, tokenData.workspaceId);
  if (!sessionId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'No chat session found for the current workspace');
  }

  const updated = await projectDataService.updateSessionTopic(
    env,
    tokenData.projectId,
    sessionId,
    topic,
  );

  if (!updated) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Session not found or is no longer active. Only active sessions can be renamed.',
    );
  }

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        updated: true,
        sessionId,
        topic,
      }, null, 2),
    }],
  });
}
