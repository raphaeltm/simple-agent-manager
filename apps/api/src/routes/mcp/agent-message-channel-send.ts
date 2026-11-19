/**
 * The only transport for agent-to-agent text (constitution XV): send_durable_message
 * and send_message_to_subtask publish every message, of every class and delivery
 * intent, on the SAM-managed pair channel. The recipient gets a SAM-authored notice
 * naming the event and reads the text with get_event. When the channel transport is
 * unavailable the send is refused; there is no raw-injection fallback.
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
  type AgentMessageChannelsDisabledReason,
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
  messageClass: AgentChannelMessageClass;
  message: string;
  idempotencyKey: string | undefined;
  metadata: Record<string, unknown> | null;
  senderSourceTaskId: string;
  recipient: AgentChannelMessageParticipant;
}

const RECEIPT_NOTE =
  "Recorded on the shared channel and matched to the recipient's notification subscription. " +
  'This is not proof that the recipient has read or acted on it.';

type ParsedIdempotencyKey = { value: string | undefined } | JsonRpcResponse;

/** Optional caller retry key; honored only by the agent message channel transport. */
export function parseIdempotencyKeyParam(
  requestId: string | number | null,
  value: unknown,
  env: Env
): ParsedIdempotencyKey {
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

const DISABLED_REASON_TEXT: Record<AgentMessageChannelsDisabledReason, string> = {
  flag_off: 'AGENT_MESSAGE_CHANNELS_ENABLED is not "true"',
  project_event_wake_disabled: 'project event wakes are disabled',
  durable_prompt_delivery_disabled: 'durable prompt delivery is disabled',
};

/**
 * Send over the agent message channel. Refuses (fails closed) when the transport is
 * unavailable: posting the text into the recipient's chat instead would make an
 * agent's words indistinguishable from a human's.
 */
export async function sendOverAgentMessageChannel(
  requestId: string | number | null,
  tokenData: McpTokenData,
  env: Env,
  request: AgentMessageChannelSendRequest
): Promise<JsonRpcResponse> {
  const messageClass = request.messageClass;
  const config = resolveAgentMessageChannelsConfig(env);
  if (!config.enabled) {
    log.warn('mcp.agent_message_channels.unavailable', {
      reason: config.reason,
      tool: request.tool,
      projectId: tokenData.projectId,
      senderTaskId: tokenData.taskId,
      recipientTaskId: request.recipient.taskId,
      action: 'rejected',
    });
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Agent messaging is unavailable on this installation: ${DISABLED_REASON_TEXT[config.reason]}. ` +
        'SAM never posts one agent\'s text into another agent\'s chat directly, so the message was not sent.',
      {
        transport: 'agent_message_channel',
        operation: request.tool,
        outcome: 'unavailable',
        reason: config.reason,
        retryable: false,
      }
    );
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
      retiredSubscriptionCount: result.retiredSubscriptionIds.length,
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
  const refusal = classifyRefusal(error);
  if (refusal) {
    // Expected refusals are logged so capacity and recipient failures can be counted.
    log.warn('mcp.agent_message_channels.refused', {
      ...diagnostics,
      projectId: tokenData.projectId,
      senderTaskId: tokenData.taskId,
      outcome: refusal.outcome,
      error: message,
    });
    return jsonRpcError(requestId, INVALID_PARAMS, message, { ...diagnostics, ...refusal });
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

/** Each outcome names the caller's recovery action (rule 72). */
function classifyRefusal(
  error: unknown
): { outcome: string; retryable: boolean; httpStatus?: number } | null {
  if (error instanceof projectData.AgentMessageRecipientUnavailableError) {
    return { outcome: 'recipient_unavailable', retryable: false };
  }
  if (error instanceof projectData.ProjectEventIdempotencyConflictError) {
    return { outcome: 'conflict', httpStatus: 409, retryable: false };
  }
  if (error instanceof projectData.ProjectEventLimitExceededError) {
    return { outcome: 'capacity', httpStatus: 429, retryable: true };
  }
  if (error instanceof projectData.ProjectEventValidationError) {
    return { outcome: 'rejected', retryable: false };
  }
  return null;
}
