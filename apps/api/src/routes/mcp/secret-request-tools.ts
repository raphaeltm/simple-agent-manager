/**
 * MCP adapters for agent-requested runtime secrets (`services/runtime-secret-requests.ts`) and the
 * effective runtime env listing (`services/runtime-env-listing.ts`). Transport only: identity
 * comes from the verified token, and results carry names and IDs, never values.
 */
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { AppError } from '../../middleware/error';
import { listEffectiveRuntimeEnv } from '../../services/runtime-env-listing';
import { createRuntimeSecretRequest } from '../../services/runtime-secret-requests';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';

function textResult(requestId: string | number | null, payload: unknown): JsonRpcResponse {
  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  });
}

function errorResult(
  requestId: string | number | null,
  error: unknown,
  event: string,
  tokenData: McpTokenData
): JsonRpcResponse {
  // AppError messages here are written by the service and never contain a value.
  if (error instanceof AppError && error.statusCode < 500) {
    return jsonRpcError(requestId, INVALID_PARAMS, error.message);
  }
  log.error(event, {
    projectId: tokenData.projectId,
    taskId: tokenData.taskId,
    error: error instanceof Error ? error.message : String(error),
  });
  return jsonRpcError(requestId, INTERNAL_ERROR, 'The secret request could not be recorded');
}

export async function handleRequestSecret(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  if (!tokenData.taskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Only task-backed sessions can request secrets');
  }
  try {
    const db = drizzle(env.DATABASE, { schema });
    const created = await createRuntimeSecretRequest(
      env,
      db,
      {
        projectId: tokenData.projectId,
        userId: tokenData.userId,
        taskId: tokenData.taskId,
        chatSessionId: tokenData.chatSessionId ?? null,
        agentSessionId: tokenData.agentSessionId ?? null,
        workspaceId: tokenData.workspaceId || null,
      },
      { name: params.name, reason: params.reason, ttlSeconds: params.ttlSeconds }
    );
    const { request } = created;
    // JSON so the chat can render this call as the input card: the card reads everything from
    // the server record by ID (SecretRequestCard in apps/web), never from chat text.
    return textResult(requestId, {
      message: created.deduplicated
        ? `An open request for ${request.envKey} already exists in this chat; the person can answer it on the existing card.`
        : `Secret request recorded. A project owner or admin can supply ${request.envKey} on the card in this chat. End your turn or keep working; you will get a notice when it is supplied, declined or expires (${request.expiresAt}). Then use exec_with_secrets with secretNames ["${request.envKey}"].`,
      secretRequest: {
        id: request.id,
        sessionId: request.requestingChatSessionId,
        name: request.envKey,
        status: request.status,
        expiresAt: request.expiresAt,
        ttlSeconds: request.ttlSeconds,
        replacesExisting: created.replacesExisting,
        deduplicated: created.deduplicated,
        notificationSent: created.notificationSent,
      },
    });
  } catch (error) {
    return errorResult(requestId, error, 'mcp.request_secret.failed', tokenData);
  }
}

export async function handleListRuntimeEnv(
  requestId: string | number | null,
  _params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  if (!tokenData.workspaceId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'A running workspace is required');
  }
  try {
    const db = drizzle(env.DATABASE, { schema });
    const listing = await listEffectiveRuntimeEnv(
      db,
      { workspaceId: tokenData.workspaceId, agentSessionId: tokenData.agentSessionId ?? null },
      { userId: tokenData.userId, projectId: tokenData.projectId }
    );
    return textResult(requestId, {
      entries: listing.entries,
      profileId: listing.profileId,
      skillId: listing.skillId,
      note: 'Values are never listed. Use secret names with exec_with_secrets; ask for a missing one with request_secret.',
    });
  } catch (error) {
    if (error instanceof AppError && error.statusCode < 500) {
      return jsonRpcError(requestId, INVALID_PARAMS, error.message);
    }
    log.error('mcp.list_runtime_env.failed', {
      projectId: tokenData.projectId,
      workspaceId: tokenData.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Runtime env could not be listed');
  }
}
