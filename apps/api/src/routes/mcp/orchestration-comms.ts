/**
 * MCP orchestration communication tools — project-scoped agent messaging and parent → child control.
 *
 * send_message_to_subtask: Sends a running same-project agent a message over its pair channel; the
 *   target gets a SAM notice naming the event, never the text (constitution XV).
 * stop_subtask: Gracefully stops a child agent's session with an optional warning message
 * (implemented in ./orchestration-stop, re-exported here for existing importers).
 */
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import {
  getMcpLimits,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  type McpTokenData,
  sanitizeUserInput,
} from './_helpers';
import {
  parseIdempotencyKeyParam,
  sendOverAgentMessageChannel,
} from './agent-message-channel-send';
import { isError, resolveAgentTarget } from './orchestration-target';

export { handleStopSubtask } from './orchestration-stop';

// ─── send_message_to_subtask ────────────────────────────────────────────────

export async function handleSendMessageToSubtask(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);

  // Validate params
  const taskId = typeof params.taskId === 'string' ? params.taskId.trim() : '';
  if (!taskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'taskId is required');
  }

  const rawMessage = typeof params.message === 'string' ? params.message.trim() : '';
  if (!rawMessage) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'message is required and must be non-empty');
  }

  const message = sanitizeUserInput(rawMessage).slice(0, limits.orchestratorMessageMaxLength);
  const idempotencyKey = parseIdempotencyKeyParam(requestId, params.idempotencyKey, env);
  if ('jsonrpc' in idempotencyKey) return idempotencyKey;

  // Resolve same-project target agent
  const db = drizzle(env.DATABASE, { schema });
  const resolution = await resolveAgentTarget(requestId, taskId, tokenData, db, {
    authorization: 'same-project-active-agent',
    targetLabel: 'Target task',
  });
  if (isError(resolution)) {
    return resolution;
  }

  const { workspace } = resolution;

  if (!workspace.chatSessionId) {
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Child workspace has no chat session');
  }

  // The pair channel is the only transport for agent text (constitution XV): the target
  // gets a SAM notice naming the event and reads the message with get_event.
  return sendOverAgentMessageChannel(requestId, tokenData, env, {
    tool: 'send_message_to_subtask',
    messageClass: 'deliver',
    message,
    idempotencyKey: idempotencyKey.value,
    metadata: null,
    senderSourceTaskId: resolution.callerSourceTaskId ?? tokenData.taskId,
    recipient: {
      taskId,
      sourceTaskId: resolution.task.sourceTaskId,
      chatSessionId: workspace.chatSessionId,
    },
  });
}
