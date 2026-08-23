/**
 * MCP message-comment tools.
 *
 * These handlers are intentionally thin: ProjectData owns durable storage in the
 * backend sibling PR, while this layer owns token-derived identity, same-session
 * fences, bounded payloads, safe errors, and agent-facing tool contracts.
 */
import type { MessageCommentThreadStatus } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import {
  boundCommentThread,
  boundCommentThreadSummary,
  buildAgentCommentAuthor,
  buildAgentCommentProvenance,
  clampCommentListLimit,
  createProjectDataMessageCommentAdapter,
  getMessageCommentConfig,
  type MessageCommentStorageAdapter,
  normalizeCommentBody,
  normalizeCommentQuote,
} from '../../services/message-comments';
import { INVALID_PARAMS, jsonRpcError, type JsonRpcResponse, type McpTokenData } from './_helpers';
import {
  mapCommentError,
  optionalString,
  parseStatusFilter,
  rejectCallerDerivedFields,
  requiredString,
  toolSuccess,
} from './comment-tool-helpers';

function getStorage(
  env: Env,
  storage?: MessageCommentStorageAdapter
): MessageCommentStorageAdapter {
  return storage ?? createProjectDataMessageCommentAdapter(env);
}

async function resolveCallerSession(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<{ sessionId: string } | JsonRpcResponse> {
  const requestedSessionId = optionalString(params, 'sessionId');
  const currentSessionId =
    tokenData.chatSessionId ?? (await resolveWorkspaceChatSession(env, tokenData));
  if (!currentSessionId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'No chat session found for this agent');
  }
  if (requestedSessionId && requestedSessionId !== currentSessionId) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'sessionId must match the calling agent session'
    );
  }
  return { sessionId: currentSessionId };
}

async function resolveWorkspaceChatSession(
  env: Env,
  tokenData: McpTokenData
): Promise<string | null> {
  if (!tokenData.workspaceId) return null;
  try {
    const row = await env.DATABASE.prepare(
      'SELECT chat_session_id FROM workspaces WHERE id = ? AND project_id = ?'
    )
      .bind(tokenData.workspaceId, tokenData.projectId)
      .first<{ chat_session_id: string | null }>();
    return row?.chat_session_id ?? null;
  } catch (err) {
    log.warn('mcp.comments.session_lookup_failed', {
      projectId: tokenData.projectId,
      workspaceId: tokenData.workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function isRpcError(value: { sessionId: string } | JsonRpcResponse): value is JsonRpcResponse {
  return 'jsonrpc' in value;
}

export async function handleListMessageCommentThreads(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
  storage?: MessageCommentStorageAdapter
): Promise<JsonRpcResponse> {
  const identityError = rejectCallerDerivedFields(requestId, params);
  if (identityError) return identityError;
  const session = await resolveCallerSession(requestId, params, tokenData, env);
  if (isRpcError(session)) return session;
  const status = parseStatusFilter(requestId, params);
  if (typeof status !== 'string') return status;

  const config = getMessageCommentConfig(env);
  const limit = clampCommentListLimit(params.limit, config);
  const messageId = optionalString(params, 'messageId');
  const cursor = optionalString(params, 'cursor');

  try {
    const result = await getStorage(env, storage).listThreads(tokenData.projectId, {
      sessionId: session.sessionId,
      status,
      messageId,
      cursor,
      limit,
    });
    return toolSuccess(requestId, {
      ...result,
      threads: result.threads.map((thread) => boundCommentThreadSummary(thread, config)),
    });
  } catch (err) {
    return mapCommentError(requestId, err, 'mcp.comments.list_failed', {
      projectId: tokenData.projectId,
      sessionId: session.sessionId,
    });
  }
}

export async function handleGetMessageCommentThread(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
  storage?: MessageCommentStorageAdapter
): Promise<JsonRpcResponse> {
  const identityError = rejectCallerDerivedFields(requestId, params);
  if (identityError) return identityError;
  const threadId = requiredString(requestId, params, 'threadId');
  if (typeof threadId !== 'string') return threadId;
  const session = await resolveCallerSession(requestId, params, tokenData, env);
  if (isRpcError(session)) return session;
  const adapter = getStorage(env, storage);
  const config = getMessageCommentConfig(env);
  const author = buildAgentCommentAuthor(tokenData);
  const provenance = buildAgentCommentProvenance(tokenData);

  try {
    const thread = await adapter.getThread({
      projectId: tokenData.projectId,
      sessionId: session.sessionId,
      threadId,
    });
    if (!thread) return jsonRpcError(requestId, INVALID_PARAMS, 'Comment thread not found');
    if (thread.sessionId !== session.sessionId) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'Comment thread belongs to another session');
    }
    await adapter.markThreadObserved({
      projectId: tokenData.projectId,
      sessionId: session.sessionId,
      threadId,
      observer: author,
      provenance,
    });
    return toolSuccess(requestId, { thread: boundCommentThread(thread, config) });
  } catch (err) {
    return mapCommentError(requestId, err, 'mcp.comments.get_failed', {
      projectId: tokenData.projectId,
      sessionId: session.sessionId,
      threadId,
    });
  }
}

export async function handleCreateMessageCommentThread(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
  storage?: MessageCommentStorageAdapter
): Promise<JsonRpcResponse> {
  const identityError = rejectCallerDerivedFields(requestId, params);
  if (identityError) return identityError;
  const messageId = requiredString(requestId, params, 'messageId');
  if (typeof messageId !== 'string') return messageId;
  const bodyRaw = requiredString(requestId, params, 'body');
  if (typeof bodyRaw !== 'string') return bodyRaw;
  const session = await resolveCallerSession(requestId, params, tokenData, env);
  if (isRpcError(session)) return session;
  const config = getMessageCommentConfig(env);
  const body = normalizeCommentBody(bodyRaw, config);
  if (!body) return jsonRpcError(requestId, INVALID_PARAMS, 'body is required');

  try {
    const thread = await getStorage(env, storage).createThread({
      projectId: tokenData.projectId,
      sessionId: session.sessionId,
      messageId,
      quote: normalizeCommentQuote(optionalString(params, 'quote'), config),
      body,
      author: buildAgentCommentAuthor(tokenData),
      provenance: buildAgentCommentProvenance(tokenData),
    });
    return toolSuccess(requestId, { thread: boundCommentThread(thread, config) });
  } catch (err) {
    return mapCommentError(requestId, err, 'mcp.comments.create_failed', {
      projectId: tokenData.projectId,
      sessionId: session.sessionId,
      messageId,
    });
  }
}

export async function handleReplyToMessageCommentThread(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
  storage?: MessageCommentStorageAdapter
): Promise<JsonRpcResponse> {
  const identityError = rejectCallerDerivedFields(requestId, params);
  if (identityError) return identityError;
  const threadId = requiredString(requestId, params, 'threadId');
  if (typeof threadId !== 'string') return threadId;
  const bodyRaw = requiredString(requestId, params, 'body');
  if (typeof bodyRaw !== 'string') return bodyRaw;
  const session = await resolveCallerSession(requestId, params, tokenData, env);
  if (isRpcError(session)) return session;
  const config = getMessageCommentConfig(env);
  const body = normalizeCommentBody(bodyRaw, config);
  if (!body) return jsonRpcError(requestId, INVALID_PARAMS, 'body is required');

  try {
    const thread = await getStorage(env, storage).replyToThread({
      projectId: tokenData.projectId,
      sessionId: session.sessionId,
      threadId,
      body,
      author: buildAgentCommentAuthor(tokenData),
      provenance: buildAgentCommentProvenance(tokenData),
    });
    return toolSuccess(requestId, { thread: boundCommentThread(thread, config) });
  } catch (err) {
    return mapCommentError(requestId, err, 'mcp.comments.reply_failed', {
      projectId: tokenData.projectId,
      sessionId: session.sessionId,
      threadId,
    });
  }
}

async function updateThreadStatus(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
  status: Extract<MessageCommentThreadStatus, 'open' | 'resolved'>,
  storage?: MessageCommentStorageAdapter
): Promise<JsonRpcResponse> {
  const identityError = rejectCallerDerivedFields(requestId, params);
  if (identityError) return identityError;
  const threadId = requiredString(requestId, params, 'threadId');
  if (typeof threadId !== 'string') return threadId;
  const session = await resolveCallerSession(requestId, params, tokenData, env);
  if (isRpcError(session)) return session;
  const config = getMessageCommentConfig(env);

  try {
    const thread = await getStorage(env, storage).updateThreadStatus({
      projectId: tokenData.projectId,
      sessionId: session.sessionId,
      threadId,
      status,
      actor: buildAgentCommentAuthor(tokenData),
      provenance: buildAgentCommentProvenance(tokenData),
    });
    return toolSuccess(requestId, { thread: boundCommentThread(thread, config) });
  } catch (err) {
    return mapCommentError(requestId, err, 'mcp.comments.status_failed', {
      projectId: tokenData.projectId,
      sessionId: session.sessionId,
      threadId,
      status,
    });
  }
}

export function handleResolveMessageCommentThread(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
  storage?: MessageCommentStorageAdapter
): Promise<JsonRpcResponse> {
  return updateThreadStatus(requestId, params, tokenData, env, 'resolved', storage);
}

export function handleReopenMessageCommentThread(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
  storage?: MessageCommentStorageAdapter
): Promise<JsonRpcResponse> {
  return updateThreadStatus(requestId, params, tokenData, env, 'open', storage);
}
