/**
 * MCP mailbox tools — durable messaging between agents.
 *
 * send_durable_message: Enqueue a message for a child agent with configurable class and delivery.
 * get_pending_messages: Retrieve unacked messages for the calling agent's session.
 * ack_message: Acknowledge receipt of a delivered message.
 */
import type { MessageClass } from '@simple-agent-manager/shared';
import { MESSAGE_CLASSES } from '@simple-agent-manager/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { sendPromptToAgentOnNode } from '../../services/node-agent';
import * as projectDataService from '../../services/project-data';
import {
  ACTIVE_STATUSES,
  getMcpLimits,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
  sanitizeUserInput,
} from './_helpers';

// ─── send_durable_message ────────────────────────────────────────────────────

export async function handleSendDurableMessage(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
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
    return jsonRpcError(requestId, INVALID_PARAMS, `Invalid messageClass. Must be one of: ${MESSAGE_CLASSES.join(', ')}`);
  }

  let metadata: Record<string, unknown> | null = null;
  if (params.metadata && typeof params.metadata === 'object') {
    const serialized = JSON.stringify(params.metadata);
    if (serialized.length > 4096) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'metadata exceeds maximum size (4096 bytes)');
    }
    metadata = params.metadata as Record<string, unknown>;
  }

  // Validate caller is a task agent
  if (!tokenData.taskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Only task agents can use durable messaging tools');
  }

  // Resolve the child task to find its project and session
  const db = drizzle(env.DATABASE, { schema });
  const resolution = await resolveChildForMailbox(requestId, targetTaskId, tokenData, db);
  if ('jsonrpc' in resolution) return resolution;

  // Enqueue the message in the target project's DO
  try {
    const msg = await projectDataService.enqueueMailboxMessage(env, resolution.projectId, {
      targetSessionId: resolution.chatSessionId,
      sourceTaskId: tokenData.taskId,
      senderType: 'agent',
      senderId: tokenData.workspaceId,
      messageClass: messageClass as MessageClass,
      content: message,
      metadata,
      ackTimeoutMs: limits.mailboxAckTimeoutMs,
      ttlMs: limits.mailboxTtlMs,
      maxMessages: limits.mailboxMaxMessagesPerProject,
    });

    // For notify/deliver, attempt immediate delivery
    let delivered = false;
    if (messageClass === 'notify' || messageClass === 'deliver') {
      delivered = await attemptImmediateDelivery(
        env, db, msg.id, resolution, message, tokenData.userId,
      );
    }

    log.info('mcp.send_durable_message.enqueued', {
      messageId: msg.id,
      parentTaskId: tokenData.taskId,
      targetTaskId,
      messageClass,
      delivered,
    });

    return jsonRpcSuccess(requestId, {
      content: [{
        type: 'text',
        text: JSON.stringify({
          messageId: msg.id,
          deliveryState: delivered ? 'delivered' : 'queued',
          delivered,
        }),
      }],
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error('mcp.send_durable_message.failed', {
      parentTaskId: tokenData.taskId,
      targetTaskId,
      error: errorMessage,
    });
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Failed to enqueue message');
  }
}

// ─── get_pending_messages ────────────────────────────────────────────────────

export async function handleGetPendingMessages(
  requestId: string | number | null,
  _params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  // Get this agent's chat session from the DO
  const chatSessionId = await resolveCallerChatSession(tokenData, env);
  if (!chatSessionId) {
    return jsonRpcSuccess(requestId, {
      content: [{
        type: 'text',
        text: JSON.stringify({ messages: [] }),
      }],
    });
  }

  try {
    const messages = await projectDataService.getPendingMailboxMessages(
      env, tokenData.projectId, chatSessionId,
    );

    // Auto-mark as delivered when retrieved
    for (const msg of messages) {
      if (msg.deliveryState === 'queued') {
        await projectDataService.markMailboxMessageDelivered(env, tokenData.projectId, msg.id);
      }
    }

    return jsonRpcSuccess(requestId, {
      content: [{
        type: 'text',
        text: JSON.stringify({ messages }),
      }],
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
  env: Env,
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
      return jsonRpcError(requestId, INVALID_PARAMS, 'Message does not belong to this agent session');
    }

    const acked = await projectDataService.acknowledgeMailboxMessage(
      env, tokenData.projectId, messageId,
    );

    return jsonRpcSuccess(requestId, {
      content: [{
        type: 'text',
        text: JSON.stringify({ acked, messageId }),
      }],
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

// ─── Internal helpers ────────────────────────────────────────────────────────

interface ResolvedMailboxTarget {
  projectId: string;
  chatSessionId: string;
  nodeId: string;
  workspaceId: string;
  agentSessionId: string;
}

/**
 * Resolve a child task to its project, chat session, workspace, and agent session.
 * Validates parent authorization.
 */
async function resolveChildForMailbox(
  requestId: string | number | null,
  childTaskId: string,
  tokenData: McpTokenData,
  db: DrizzleD1Database<typeof schema>,
): Promise<JsonRpcResponse | ResolvedMailboxTarget> {
  // Query child task
  const [childTask] = await db
    .select({
      id: schema.tasks.id,
      status: schema.tasks.status,
      workspaceId: schema.tasks.workspaceId,
      projectId: schema.tasks.projectId,
      parentTaskId: schema.tasks.parentTaskId,
    })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.id, childTaskId),
        eq(schema.tasks.projectId, tokenData.projectId),
      ),
    )
    .limit(1);

  if (!childTask) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Target task not found in this project');
  }

  // Authorization: direct parent only
  if (childTask.parentTaskId !== tokenData.taskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Only the direct parent task can send durable messages to a child');
  }

  // Verify child is in an active status
  if (!ACTIVE_STATUSES.includes(childTask.status)) {
    return jsonRpcError(requestId, INVALID_PARAMS, `Target task is in '${childTask.status}' status — only active tasks can receive messages`);
  }

  if (!childTask.workspaceId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Target task has no workspace assigned yet');
  }

  // Resolve workspace + node
  const [workspace] = await db
    .select({
      id: schema.workspaces.id,
      nodeId: schema.workspaces.nodeId,
      chatSessionId: schema.workspaces.chatSessionId,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, childTask.workspaceId))
    .limit(1);

  if (!workspace || !workspace.nodeId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Target workspace or node not found');
  }

  // Use workspace's chatSessionId (canonical session mapping)
  const chatSessionId = workspace.chatSessionId;
  if (!chatSessionId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Target task has no chat session — messages cannot be queued');
  }

  // Resolve running agent session
  const [agentSession] = await db
    .select({ id: schema.agentSessions.id })
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.workspaceId, workspace.id),
        eq(schema.agentSessions.status, 'running'),
      ),
    )
    .orderBy(desc(schema.agentSessions.createdAt))
    .limit(1);

  return {
    projectId: childTask.projectId,
    chatSessionId,
    nodeId: workspace.nodeId,
    workspaceId: workspace.id,
    agentSessionId: agentSession?.id ?? '',
  };
}

/**
 * Attempt immediate delivery by sending the message content to the agent via the node.
 */
async function attemptImmediateDelivery(
  env: Env,
  _db: DrizzleD1Database<typeof schema>,
  messageId: string,
  target: ResolvedMailboxTarget,
  content: string,
  userId: string,
): Promise<boolean> {
  if (!target.agentSessionId) return false;

  try {
    await sendPromptToAgentOnNode(
      target.nodeId,
      target.workspaceId,
      target.agentSessionId,
      content,
      env,
      userId,
    );

    // Mark as delivered in the DO
    await projectDataService.markMailboxMessageDelivered(env, target.projectId, messageId);
    return true;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    // 409 means agent busy — message stays queued for alarm-based delivery
    if (errorMessage.includes('409')) {
      log.info('mcp.mailbox.immediate_delivery_busy', { messageId, agentSessionId: target.agentSessionId });
    } else {
      log.warn('mcp.mailbox.immediate_delivery_failed', { messageId, error: errorMessage });
    }
    return false;
  }
}

/**
 * Resolve the calling agent's chat session from its workspace.
 */
async function resolveCallerChatSession(
  tokenData: McpTokenData,
  env: Env,
): Promise<string | null> {
  if (!tokenData.workspaceId) return null;

  const db = drizzle(env.DATABASE, { schema });
  const [workspace] = await db
    .select({ chatSessionId: schema.workspaces.chatSessionId })
    .from(schema.workspaces)
    .where(and(
      eq(schema.workspaces.id, tokenData.workspaceId),
      eq(schema.workspaces.projectId, tokenData.projectId),
    ))
    .limit(1);

  return workspace?.chatSessionId ?? null;
}
