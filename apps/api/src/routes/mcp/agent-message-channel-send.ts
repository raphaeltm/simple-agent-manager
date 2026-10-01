/**
 * Preview transport for the existing messaging tools: send_durable_message and
 * send_message_to_subtask route ordinary (notify/deliver) messages over the
 * SAM-managed pair channel when AGENT_MESSAGE_CHANNELS_ENABLED is on. Urgent
 * classes keep stop-and-deliver, which already frames the text as an untrusted
 * agent directive. The recipient gets a SAM-authored notice instead of the raw
 * text, and reads the message with get_event.
 */
import {
  type AgentChannelMessageClass,
  type AgentChannelMessageParticipant,
  type ProjectEventJsonValue,
  type SendAgentChannelMessageResult,
} from '@simple-agent-manager/shared';

import { channelLimits } from '../../durable-objects/project-data/project-event-channels-config';
import { resolveProjectEventLimits } from '../../durable-objects/project-data/project-events-limits';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import {
  AgentMessageRecipientUnavailableError,
  resolveAgentMessageChannelsConfig,
  sendAgentMessageOverChannel,
} from '../../services/agent-message-channels';
import * as projectData from '../../services/project-data';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';
import { resolveCallerChatSession } from './mailbox-target';

export type AgentMessageTool = 'send_durable_message' | 'send_message_to_subtask';

export interface AgentMessageChannelSendRequest {
  tool: AgentMessageTool;
  messageClass: string;
  message: string;
  idempotencyKey: string | undefined;
  metadata: Record<string, unknown> | null;
  senderSourceTaskId: string;
  recipient: AgentChannelMessageParticipant;
}

const RECEIPT_NOTE =
  "Recorded on the shared channel and matched to the recipient's notification subscription. " +
  'This is not proof that the recipient has read or acted on it.';

/** Optional caller retry key; honored only by the agent message channel transport. */
export function parseIdempotencyKeyParam(
  requestId: string | number | null,
  value: unknown,
  env: Env
): { value: string | undefined } | JsonRpcResponse {
  if (value === undefined) return { value: undefined };
  const maxBytes = resolveProjectEventLimits(env).maxFilterStringBytes;
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    new TextEncoder().encode(value.trim()).byteLength > maxBytes
  ) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `idempotencyKey must be a non-empty string of at most ${maxBytes} bytes`
    );
  }
  return { value: value.trim() };
}

/**
 * Send over the agent message channel, or return null so the caller keeps its
 * legacy path (preview off, prerequisites off, or an urgent message class).
 */
export async function trySendOverAgentMessageChannel(
  requestId: string | number | null,
  tokenData: McpTokenData,
  env: Env,
  request: AgentMessageChannelSendRequest
): Promise<JsonRpcResponse | null> {
  const messageClass: AgentChannelMessageClass | null =
    request.messageClass === 'notify' || request.messageClass === 'deliver'
      ? request.messageClass
      : null;
  if (!messageClass) return null;
  const config = resolveAgentMessageChannelsConfig(env);
  if (!config.enabled) {
    if (config.reason !== 'flag_off') {
      log.warn('mcp.agent_message_channels.prerequisite_disabled', {
        reason: config.reason,
        tool: request.tool,
        projectId: tokenData.projectId,
        action: 'legacy_path',
      });
    }
    return null;
  }

  const idempotencyKey = request.idempotencyKey ?? `auto:${ulid()}`;
  const diagnostics = {
    transport: 'agent_message_channel',
    operation: request.tool,
    recipientTaskId: request.recipient.taskId,
    recipientChatSessionId: request.recipient.chatSessionId,
    // Retrying with this key replays the same message instead of sending a second one.
    idempotencyKey,
  };
  const maxBytes = channelLimits(env).messageBytes;
  const messageBytes = new TextEncoder().encode(request.message).byteLength;
  if (messageBytes > maxBytes) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Message is ${messageBytes} bytes; agent message channels carry at most ${maxBytes} bytes. ` +
        'Shorten it, or put the detail in a file, PR or idea and send a pointer.',
      { ...diagnostics, outcome: 'rejected', retryable: false }
    );
  }
  const chatSessionId = tokenData.chatSessionId ?? (await resolveCallerChatSession(tokenData, env));
  if (!chatSessionId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Cannot resolve the calling chat session', {
      ...diagnostics,
      outcome: 'rejected',
      retryable: false,
    });
  }

  try {
    const result = await sendAgentMessageOverChannel(env, {
      projectId: tokenData.projectId,
      actor: {
        userId: tokenData.userId,
        taskId: tokenData.taskId,
        chatSessionId,
        workspaceId: tokenData.workspaceId,
        agentSessionId: tokenData.agentSessionId ?? null,
      },
      senderSourceTaskId: request.senderSourceTaskId,
      recipient: request.recipient,
      message: request.message,
      messageClass,
      idempotencyKey,
      // Already bounded and JSON-validated by the calling tool.
      senderMetadata: request.metadata as Record<string, ProjectEventJsonValue> | null,
    });
    log.info('mcp.agent_message_channels.accepted', {
      ...diagnostics,
      projectId: tokenData.projectId,
      senderTaskId: tokenData.taskId,
      channel: result.channel.name,
      eventId: result.eventId,
      outcome: result.outcome,
      rotatedSubscriptionCount: result.rotatedSubscriptionIds.length,
    });
    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify(receipt(request, idempotencyKey, result)) }],
    });
  } catch (error) {
    return channelSendError(requestId, tokenData, diagnostics, error);
  }
}

function receipt(
  request: AgentMessageChannelSendRequest,
  idempotencyKey: string,
  result: SendAgentChannelMessageResult
) {
  return {
    // Legacy fields keep their meaning: accepted, not delivered.
    accepted: true,
    delivered: false,
    ...(request.tool === 'send_durable_message' ? { deliveryState: 'queued' } : { queued: true }),
    messageId: result.eventId,
    transport: 'agent_message_channel',
    channel: result.channel.name,
    eventId: result.eventId,
    sequence: result.sequence,
    replayed: result.outcome === 'duplicate_replay',
    idempotencyKey,
    recipient: {
      taskId: request.recipient.taskId,
      subscriptionMatched: result.recipientSubscriptionId !== null,
    },
    receipt: RECEIPT_NOTE,
  };
}

function channelSendError(
  requestId: string | number | null,
  tokenData: McpTokenData,
  diagnostics: Record<string, string>,
  error: unknown
): JsonRpcResponse {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof AgentMessageRecipientUnavailableError) {
    return jsonRpcError(requestId, INVALID_PARAMS, message, {
      ...diagnostics,
      outcome: 'recipient_unavailable',
      retryable: false,
    });
  }
  if (error instanceof projectData.ProjectEventIdempotencyConflictError) {
    return jsonRpcError(requestId, INVALID_PARAMS, message, {
      ...diagnostics,
      outcome: 'conflict',
      httpStatus: 409,
      retryable: false,
    });
  }
  if (error instanceof projectData.ProjectEventLimitExceededError) {
    return jsonRpcError(requestId, INVALID_PARAMS, message, {
      ...diagnostics,
      outcome: 'capacity',
      httpStatus: 429,
      retryable: true,
    });
  }
  if (error instanceof projectData.ProjectEventValidationError) {
    return jsonRpcError(requestId, INVALID_PARAMS, message, {
      ...diagnostics,
      outcome: 'rejected',
      retryable: false,
    });
  }
  log.error('mcp.agent_message_channels.send_failed', {
    ...diagnostics,
    projectId: tokenData.projectId,
    senderTaskId: tokenData.taskId,
    error: message,
  });
  return jsonRpcError(requestId, INTERNAL_ERROR, 'Failed to send agent message over its channel', {
    ...diagnostics,
    outcome: 'error',
    retryable: true,
  });
}
