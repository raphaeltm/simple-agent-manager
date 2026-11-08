/**
 * MCP mailbox tools — durable messaging between agents.
 *
 * send_durable_message: Send a same-project agent a message over its pair channel; the recipient
 *   gets a SAM notice naming the event, never the text (constitution XV).
 * get_pending_messages: Retrieve unacked messages for the calling agent's session.
 * ack_message: Acknowledge receipt of a delivered message.
 */
import type { MessageClass } from '@simple-agent-manager/shared';
import {
  canSteerMessageClass,
  MESSAGE_CLASSES,
  PROMPT_DELIVERY_INTENTS,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { expectJsonRecord } from '../../lib/runtime-validation';
import * as projectDataService from '../../services/project-data';
import {
  getMcpLimits,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
  sanitizeUserInput,
} from './_helpers';
import {
  parseIdempotencyKeyParam,
  sendOverAgentMessageChannel,
} from './agent-message-channel-send';
import { resolveCallerChatSession, resolveProjectAgentForMailbox } from './mailbox-target';

// ─── send_durable_message ────────────────────────────────────────────────────

export async function handleSendDurableMessage(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);

  // Validate params
  const targetTaskId = typeof params.targetTaskId === 'string' ? params.targetTaskId.trim() : '';
  if (!targetTaskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'targetTaskId is required');
  }

  const rawMessage = typeof params.message === 'string' ? params.message.trim() : '';
  if (!rawMessage) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'message is required and must be non-empty');
  }

  const message = sanitizeUserInput(rawMessage).slice(0, limits.mailboxMessageMaxLength);

  const messageClass = typeof params.messageClass === 'string' ? params.messageClass : 'deliver';
  if (!(MESSAGE_CLASSES as readonly string[]).includes(messageClass)) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Invalid messageClass. Must be one of: ${MESSAGE_CLASSES.join(', ')}`
    );
  }

  const deliveryIntent =
    typeof params.deliveryIntent === 'string' ? params.deliveryIntent : 'queue';
  if (!(PROMPT_DELIVERY_INTENTS as readonly string[]).includes(deliveryIntent)) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Invalid deliveryIntent. Must be one of: ${PROMPT_DELIVERY_INTENTS.join(', ')}`
    );
  }
  if (deliveryIntent === 'steer' && !canSteerMessageClass(messageClass as MessageClass)) {
    // Stopping a turn is the interrupt path; a steer must never become one.
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'deliveryIntent "steer" requires messageClass "notify" or "deliver"'
    );
  }

  let metadata: Record<string, unknown> | null = null;
  if (params.metadata && typeof params.metadata === 'object') {
    const serialized = JSON.stringify(params.metadata);
    if (serialized.length > 4096) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'metadata exceeds maximum size (4096 bytes)');
    }
    metadata = expectJsonRecord(params.metadata, 'mcp.mailbox.metadata');
  }

  const idempotencyKey = parseIdempotencyKeyParam(requestId, params.idempotencyKey, env);
  if ('jsonrpc' in idempotencyKey) return idempotencyKey;

  // Validate caller is a task agent
  if (!tokenData.taskId) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Only task agents can use durable messaging tools'
    );
  }

  // Resolve the target task to find its project and session
  const db = drizzle(env.DATABASE, { schema });
  const resolution = await resolveProjectAgentForMailbox(requestId, targetTaskId, tokenData, db);
  if ('jsonrpc' in resolution) return resolution;

  // Every class and delivery intent travels over the pair channel (constitution XV):
  // the recipient's chat only ever gets a SAM notice naming the event. Its managed
  // subscription steers into a running turn (#2546), so `steer` needs no path of its
  // own, and an urgent class makes that notice stop-and-deliver.
  return sendOverAgentMessageChannel(requestId, tokenData, env, {
    tool: 'send_durable_message',
    messageClass: messageClass as MessageClass,
    message,
    idempotencyKey: idempotencyKey.value,
    metadata,
    senderSourceTaskId: resolution.callerSourceTaskId,
    recipient: {
      taskId: targetTaskId,
      sourceTaskId: resolution.targetSourceTaskId,
      chatSessionId: resolution.chatSessionId,
    },
  });
}

// ─── get_pending_messages ────────────────────────────────────────────────────

export async function handleGetPendingMessages(
  requestId: string | number | null,
  _params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  // Get this agent's chat session from the DO
  const chatSessionId = await resolveCallerChatSession(tokenData, env);
  if (!chatSessionId) {
    return jsonRpcSuccess(requestId, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ messages: [] }),
        },
      ],
    });
  }

  try {
    const messages = await projectDataService.getPendingMailboxMessages(
      env,
      tokenData.projectId,
      chatSessionId
    );

    // Auto-mark as delivered when retrieved
    for (const msg of messages) {
      if (msg.deliveryState === 'queued') {
        await projectDataService.markMailboxMessageDelivered(env, tokenData.projectId, msg.id);
      }
    }

    return jsonRpcSuccess(requestId, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ messages }),
        },
      ],
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error('mcp.get_pending_messages.failed', {
      projectId: tokenData.projectId,
      chatSessionId,
      error: errorMessage,
    });
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Failed to get pending messages');
  }
}

// ─── ack_message ─────────────────────────────────────────────────────────────

export async function handleAckMessage(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const messageId = typeof params.messageId === 'string' ? params.messageId.trim() : '';
  if (!messageId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'messageId is required');
  }

  // Verify the caller owns this message (session-level isolation)
  const callerChatSessionId = await resolveCallerChatSession(tokenData, env);
  if (!callerChatSessionId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Cannot resolve caller session');
  }

  try {
    // Fetch the message and verify ownership before acknowledging
    const message = await projectDataService.getMailboxMessage(env, tokenData.projectId, messageId);
    if (!message) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'Message not found');
    }
    if (message.targetSessionId !== callerChatSessionId) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        'Message does not belong to this agent session'
      );
    }

    const acked = await projectDataService.acknowledgeMailboxMessage(
      env,
      tokenData.projectId,
      messageId
    );

    return jsonRpcSuccess(requestId, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ acked, messageId }),
        },
      ],
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error('mcp.ack_message.failed', {
      messageId,
      projectId: tokenData.projectId,
      error: errorMessage,
    });
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Failed to acknowledge message');
  }
}
