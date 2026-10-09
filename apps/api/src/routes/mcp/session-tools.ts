/**
 * MCP session tools — list_sessions, get_session_messages, search_messages, update_session_topic.
 *
 * Also exports TokenRow and groupTokensIntoMessages for use by tests and other modules.
 */
import type { Env } from '../../env';
import { runWorkspaceOperation } from '../../operations/workspace-adapter';
import * as projectDataService from '../../services/project-data';
import { getWorkspaceResourceHistory } from '../../services/workspace-resource-history';
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

export async function handleListSessions(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);
  const status = typeof params.status === 'string' ? params.status : null;
  const requestedLimit = typeof params.limit === 'number' ? params.limit : limits.sessionListLimit;
  const limit = Math.min(Math.max(1, Math.round(requestedLimit)), limits.sessionListMax);

  const { sessions, total } = await projectDataService.listSessions(
    env,
    tokenData.projectId,
    status,
    limit
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
// The frontend equivalent is `chatMessagesToConversationItems()` in
// `apps/web/src/components/project-message-view/types.ts` (consecutive assistant
// and thinking tokens merge; tool rows merge by `toolCallId`), followed by
// `groupToolCallItems()` in
// `apps/web/src/components/project-message-view/tool-call-groups.ts`, which folds
// a run of tool/thinking items into one collapsed activity row. The old
// `groupMessages()` helper this used to cite was dead code and has been removed.
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
  env: Env
): Promise<JsonRpcResponse> {
  return runWorkspaceOperation('get_session_messages', requestId, params, tokenData, env);
}

function parseOptionalScope(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function handleGetResourceHistory(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const explicitSessionId = parseOptionalScope(params.sessionId);
  const explicitTaskId = parseOptionalScope(params.taskId);
  const explicitWorkspaceId = parseOptionalScope(params.workspaceId);
  const hasExplicitScope = Boolean(explicitSessionId || explicitTaskId || explicitWorkspaceId);
  const sessionId = hasExplicitScope
    ? explicitSessionId
    : parseOptionalScope(tokenData.chatSessionId);
  const taskId = hasExplicitScope ? explicitTaskId : parseOptionalScope(tokenData.taskId);
  const workspaceId = hasExplicitScope
    ? explicitWorkspaceId
    : parseOptionalScope(tokenData.workspaceId);
  const detailChunkId = parseOptionalScope(params.chunkId);

  if (!sessionId && !taskId && !workspaceId) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Provide sessionId, taskId, or workspaceId, or call from a workspace-scoped MCP token'
    );
  }

  const history = await getWorkspaceResourceHistory(env, {
    projectId: tokenData.projectId,
    sessionId,
    taskId,
    workspaceId,
    detailChunkId,
  });

  return jsonRpcSuccess(requestId, {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            scope: { projectId: tokenData.projectId, sessionId, taskId, workspaceId },
            ...history,
            notes: [
              'Samples are workspace-level cgroup observations, not per-process attribution.',
              'memoryWorkingSetMeanBytes and memoryWorkingSetPeakBytes estimate memory needed by excluding reclaimable inactive file cache; null means the VM agent did not report them.',
              'memoryMeanBytes, memoryPeakBytes, and memoryKernelPeakBytes include cache and remain available for historical comparison.',
              'Tool spans are timestamp correlation windows and may include an ACP kind and metadata-provided tool name; titles and inputs are never returned.',
              'Chunk detail is returned only when chunkId is supplied; summary reads stay bounded.',
            ],
          },
          null,
          2
        ),
      },
    ],
  });
}

export async function handleSearchMessages(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  return runWorkspaceOperation('search_messages', requestId, params, tokenData, env);
}

function parseOptionalTimestamp(
  value: unknown,
  name: string
): { value: number | null; error: string | null } {
  if (value === undefined || value === null) return { value: null, error: null };
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return { value, error: null };
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return { value: null, error: null };
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return { value: parsed, error: null };
  }
  return { value: null, error: `${name} must be an epoch-millisecond number or ISO timestamp` };
}

type ArchivedToolPayloadRequest = {
  messageId: string;
  sessionId: string;
  startTime: number | null;
  endTime: number | null;
  requestedLimit: number | null;
};

function parseArchivedToolPayloadRequest(params: Record<string, unknown>): {
  request: ArchivedToolPayloadRequest | null;
  error: string | null;
} {
  const messageId = typeof params.messageId === 'string' ? params.messageId.trim() : '';
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
  const startTime = parseOptionalTimestamp(params.startTime, 'startTime');
  if (startTime.error) return { request: null, error: startTime.error };
  const endTime = parseOptionalTimestamp(params.endTime, 'endTime');
  if (endTime.error) return { request: null, error: endTime.error };
  if (startTime.value !== null && endTime.value !== null && startTime.value > endTime.value) {
    return { request: null, error: 'startTime must be before or equal to endTime' };
  }
  if (!messageId && !sessionId && startTime.value === null && endTime.value === null) {
    return {
      request: null,
      error: 'Provide messageId, sessionId, startTime, or endTime to bound archive retrieval',
    };
  }

  return {
    request: {
      messageId,
      sessionId,
      startTime: startTime.value,
      endTime: endTime.value,
      requestedLimit: typeof params.limit === 'number' ? params.limit : null,
    },
    error: null,
  };
}

function resolveArchivedToolPayloadLimit(env: Env, requestedLimit: number | null): number {
  const limits = getMcpLimits(env);
  const rawLimit = requestedLimit ?? limits.archivedToolPayloadListLimit;
  return Math.min(Math.max(1, Math.round(rawLimit)), limits.archivedToolPayloadListMax);
}

export async function handleGetArchivedToolPayloads(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const parsed = parseArchivedToolPayloadRequest(params);
  if (parsed.error || parsed.request === null) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      parsed.error ?? 'Invalid archive retrieval request'
    );
  }

  if (parsed.request.sessionId) {
    const session = await projectDataService.getSession(
      env,
      tokenData.projectId,
      parsed.request.sessionId
    );
    if (!session) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'Session not found in this project');
    }
  }

  const limit = resolveArchivedToolPayloadLimit(env, parsed.request.requestedLimit);

  const result = await projectDataService.getArchivedToolPayloads(env, tokenData.projectId, {
    ...(parsed.request.messageId ? { messageId: parsed.request.messageId } : {}),
    ...(parsed.request.sessionId ? { sessionId: parsed.request.sessionId } : {}),
    ...(parsed.request.startTime !== null ? { startTime: parsed.request.startTime } : {}),
    ...(parsed.request.endTime !== null ? { endTime: parsed.request.endTime } : {}),
    limit,
  });

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  });
}

export async function handleUpdateSessionTopic(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const rawTopic = typeof params.topic === 'string' ? params.topic.trim() : '';
  if (!rawTopic) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'topic is required and must be a non-empty string'
    );
  }

  const limits = getMcpLimits(env);
  const topic = sanitizeUserInput(rawTopic).slice(0, limits.sessionTopicMaxLength);

  if (!topic) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'topic must contain visible characters after sanitization'
    );
  }

  // Resolve session ID from workspace
  const sessionId = await resolveSessionId(env, tokenData.workspaceId);
  if (!sessionId) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'No chat session found for the current workspace'
    );
  }

  const updated = await projectDataService.updateSessionTopic(
    env,
    tokenData.projectId,
    sessionId,
    topic
  );

  if (!updated) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Session not found or is no longer active. Only active sessions can be renamed.'
    );
  }

  return jsonRpcSuccess(requestId, {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            updated: true,
            sessionId,
            topic,
          },
          null,
          2
        ),
      },
    ],
  });
}
