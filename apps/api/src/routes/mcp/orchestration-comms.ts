/**
 * MCP orchestration communication tools — project-scoped agent messaging and parent → child control.
 *
 * send_message_to_subtask: Injects a user-role message into a running same-project agent's ACP session.
 * stop_subtask: Gracefully stops a child agent's session with an optional warning message
 * (implemented in ./orchestration-stop, re-exported here for existing importers).
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { sendPromptToAgentOnNode } from '../../services/node-agent';
import { persistOrchestrationPrompt } from '../../services/orchestration-prompts';
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
  trySendOverAgentMessageChannel,
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

  const { workspace, agentSession } = resolution;

  if (!workspace.chatSessionId) {
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Child workspace has no chat session');
  }

  // Preview: the shared pair channel replaces raw prompt injection when enabled.
  const channelResponse = await trySendOverAgentMessageChannel(requestId, tokenData, env, {
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
  if (channelResponse) return channelResponse;

  const { resolveDurableExecutionConfig } =
    await import('../../durable-objects/project-data/durable-execution-config');
  const durableConfig = resolveDurableExecutionConfig(env);
  if (durableConfig.deliveryEnabled) {
    const accepted = await projectDataService.acceptPromptDelivery(env, resolution.task.projectId, {
      targetSessionId: workspace.chatSessionId,
      displayContent: message,
      deliveryContent: message,
      sourceTaskId: tokenData.taskId ?? null,
      senderType: 'agent',
      senderId: tokenData.workspaceId,
      messageClass: 'deliver',
      sourceKind: 'orchestration_handoff',
      ttlMs: durableConfig.ttlMs,
      metadata: {
        parentTaskId: tokenData.taskId,
        childTaskId: taskId,
      },
    });
    return jsonRpcSuccess(requestId, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            delivered: false,
            queued: true,
            accepted: true,
            messageId: accepted.message.id,
          }),
        },
      ],
    });
  }

  if (resolution.task.status === 'sleeping') {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Sleeping targets require durable prompt delivery to be enabled'
    );
  }

  const messageId = await persistOrchestrationPrompt({
    env,
    projectId: resolution.task.projectId,
    chatSessionId: workspace.chatSessionId,
    content: message,
    source: 'parent_agent',
    kind: 'orchestration_prompt',
    parentTaskId: tokenData.taskId,
    childTaskId: taskId,
    senderId: tokenData.workspaceId,
  });

  // Send the prompt to the child agent's running session
  try {
    await sendPromptToAgentOnNode(
      workspace.nodeId,
      workspace.id,
      agentSession.id,
      message,
      env,
      tokenData.userId,
      messageId
    );

    log.info('mcp.send_message_to_subtask.delivered', {
      parentTaskId: tokenData.taskId,
      childTaskId: taskId,
      workspaceId: workspace.id,
      agentSessionId: agentSession.id,
      messageLength: message.length,
      messageId,
    });

    return jsonRpcSuccess(requestId, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ delivered: true }),
        },
      ],
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Handle 409 — agent is busy (HostPrompting state)
    if (errorMessage.includes('409')) {
      log.info('mcp.send_message_to_subtask.agent_busy_queuing', {
        parentTaskId: tokenData.taskId,
        childTaskId: taskId,
        agentSessionId: agentSession.id,
      });

      // Queue for delivery at next turn boundary instead of returning failure
      const [ws] = await db
        .select({ chatSessionId: schema.workspaces.chatSessionId })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspace.id))
        .limit(1);

      const chatSessionId = ws?.chatSessionId;
      if (chatSessionId) {
        try {
          const msg = await projectDataService.enqueueMailboxMessage(
            env,
            resolution.task.projectId,
            {
              targetSessionId: chatSessionId,
              sourceTaskId: tokenData.taskId ?? null,
              senderType: 'agent',
              senderId: tokenData.workspaceId,
              messageClass: 'deliver',
              content: message,
              metadata: null,
            }
          );

          return jsonRpcSuccess(requestId, {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  delivered: false,
                  queued: true,
                  messageId: msg.id,
                  reason: 'agent_busy',
                }),
              },
            ],
          });
        } catch (queueErr) {
          log.warn('mcp.send_message_to_subtask.queue_fallback_failed', {
            parentTaskId: tokenData.taskId,
            childTaskId: taskId,
            error: queueErr instanceof Error ? queueErr.message : String(queueErr),
          });
        }
      }

      // Fallback: return the old response shape if queuing fails
      return jsonRpcSuccess(requestId, {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ delivered: false, reason: 'agent_busy' }),
          },
        ],
      });
    }

    log.error('mcp.send_message_to_subtask.failed', {
      parentTaskId: tokenData.taskId,
      childTaskId: taskId,
      error: errorMessage,
    });

    return jsonRpcError(
      requestId,
      INTERNAL_ERROR,
      `Failed to send message to child agent: ${errorMessage}`
    );
  }
}
