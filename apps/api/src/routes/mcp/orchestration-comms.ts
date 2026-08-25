/**
 * MCP orchestration communication tools — project-scoped agent messaging and parent → child control.
 *
 * send_message_to_subtask: Injects a user-role message into a running same-project agent's ACP session.
 * stop_subtask: Gracefully stops a child agent's session with an optional warning message.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import { sendPromptToAgentOnNode, stopAgentSessionOnNode } from '../../services/node-agent';
import { persistOrchestrationPrompt } from '../../services/orchestration-prompts';
import * as projectDataService from '../../services/project-data';
import { cleanupTerminalTaskResources } from '../../services/task-terminal-cleanup';
import { syncTriggerExecutionStatus } from '../../services/trigger-execution-sync';
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

// ─── Shared resolution helpers ──────────────────────────────────────────────

interface ResolvedAgentTarget {
  task: {
    id: string;
    status: string;
    workspaceId: string | null;
    projectId: string;
  };
  workspace: {
    id: string;
    nodeId: string;
    nodeStatus: string | null;
    chatSessionId: string | null;
  };
  agentSession: {
    id: string;
  };
}

/**
 * Validate authorization and resolve task → workspace → agent session.
 *
 * Project-scoped communication is intentionally broader than destructive controls:
 * any active task agent in the caller's verified MCP-token project can message any
 * other active task agent in that same project. Destructive lifecycle controls keep
 * direct-parent authorization.
 *
 * Returns a JSON-RPC error response on failure, or the resolved child context on success.
 */
async function resolveAgentTarget(
  requestId: string | number | null,
  targetTaskId: string,
  tokenData: McpTokenData,
  db: DrizzleD1Database<typeof schema>,
  options: {
    authorization: 'same-project-active-agent' | 'direct-child-control';
    targetLabel: string;
  }
): Promise<JsonRpcResponse | ResolvedAgentTarget> {
  // 1. Validate caller is a task agent
  if (!tokenData.taskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Only task agents can use orchestration tools');
  }

  // 2. Query target task in the caller's verified project. This project predicate
  // is the authorization boundary for non-destructive communication.
  const requestedTaskIds = [...new Set([tokenData.taskId, targetTaskId])];
  const taskRows = await db
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
        inArray(schema.tasks.id, requestedTaskIds),
        eq(schema.tasks.projectId, tokenData.projectId)
      )
    );
  const targetTask = taskRows.find((task) => task.id === targetTaskId);
  const callerTask = taskRows.find((task) => task.id === tokenData.taskId);

  if (options.authorization === 'same-project-active-agent') {
    if (!callerTask) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'Calling task was not found in this project');
    }
    if (!ACTIVE_STATUSES.includes(callerTask.status)) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        `Calling task is in '${callerTask.status}' status — only active task agents can send messages`
      );
    }
    if (targetTaskId === tokenData.taskId) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        'Target task must be another active task agent in the same project'
      );
    }
  }

  if (!targetTask) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `${options.targetLabel} not found in this project`
    );
  }

  // 3. Authorization: direct parent only for destructive lifecycle controls.
  if (
    options.authorization === 'direct-child-control' &&
    targetTask.parentTaskId !== tokenData.taskId
  ) {
    log.warn('mcp.orchestration.unauthorized_parent', {
      callerTaskId: tokenData.taskId,
      childTaskId: targetTaskId,
      actualParentTaskId: targetTask.parentTaskId,
      projectId: tokenData.projectId,
    });
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Only the direct parent task can communicate with a child task'
    );
  }

  // 4. Verify target is in an active status
  if (!ACTIVE_STATUSES.includes(targetTask.status)) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `${options.targetLabel} is in '${targetTask.status}' status — only active tasks can receive messages`
    );
  }

  // 5. Resolve workspace. Require the workspace's own project_id to match the
  // caller project as a defence-in-depth consistency check; the task row alone is
  // not enough if stale/relaxed fixtures disagree.
  if (!targetTask.workspaceId) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `${options.targetLabel} has no workspace assigned yet (it may still be provisioning)`
    );
  }

  const [workspace] = await db
    .select({
      id: schema.workspaces.id,
      nodeId: schema.workspaces.nodeId,
      chatSessionId: schema.workspaces.chatSessionId,
      nodeStatus: schema.nodes.status,
    })
    .from(schema.workspaces)
    .leftJoin(schema.nodes, eq(schema.workspaces.nodeId, schema.nodes.id))
    .where(
      and(
        eq(schema.workspaces.id, targetTask.workspaceId),
        eq(schema.workspaces.projectId, tokenData.projectId)
      )
    )
    .limit(1);

  if (!workspace || !workspace.nodeId) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `${options.targetLabel} workspace or node not found`
    );
  }

  // Verify node is reachable — D1 nodes.status uses 'running' for healthy nodes
  // (not 'active'/'warm', which are NodeLifecycle DO states, not D1 column values)
  if (workspace.nodeStatus !== 'running') {
    log.warn('mcp.orchestration.node_not_running', {
      childTaskId: targetTaskId,
      workspaceId: targetTask.workspaceId,
      nodeId: workspace.nodeId,
      nodeStatus: workspace.nodeStatus,
    });
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `${options.targetLabel} workspace node is not running (status: ${workspace.nodeStatus ?? 'unknown'})`
    );
  }

  // 6. Resolve running agent session
  const [agentSession] = await db
    .select({ id: schema.agentSessions.id })
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.workspaceId, workspace.id),
        eq(schema.agentSessions.status, 'running')
      )
    )
    .orderBy(desc(schema.agentSessions.createdAt))
    .limit(1);

  if (!agentSession) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `No running agent session found for ${options.targetLabel.toLowerCase()}`
    );
  }

  return {
    task: {
      id: targetTask.id,
      status: targetTask.status,
      workspaceId: targetTask.workspaceId,
      projectId: targetTask.projectId,
    },
    workspace: {
      id: workspace.id,
      nodeId: workspace.nodeId,
      nodeStatus: workspace.nodeStatus,
      chatSessionId: workspace.chatSessionId,
    },
    agentSession: {
      id: agentSession.id,
    },
  };
}

/** Type guard: check if the resolution result is an error response. */
function isError(result: JsonRpcResponse | ResolvedAgentTarget): result is JsonRpcResponse {
  return 'jsonrpc' in result;
}

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

// ─── stop_subtask ───────────────────────────────────────────────────────────

export async function handleStopSubtask(
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

  const reason =
    typeof params.reason === 'string'
      ? sanitizeUserInput(params.reason.trim()).slice(0, limits.orchestratorMessageMaxLength)
      : undefined;

  // Resolve child agent. stop_subtask is destructive, so it intentionally keeps
  // the direct-parent restriction while send_message_to_subtask is project-scoped.
  const db = drizzle(env.DATABASE, { schema });
  const resolution = await resolveAgentTarget(requestId, taskId, tokenData, db, {
    authorization: 'direct-child-control',
    targetLabel: 'Child task',
  });
  if (isError(resolution)) {
    return resolution;
  }

  const { task, workspace, agentSession } = resolution;

  // If reason provided, inject a final warning message (best-effort)
  if (reason) {
    try {
      await sendPromptToAgentOnNode(
        workspace.nodeId,
        workspace.id,
        agentSession.id,
        `[STOP REQUESTED BY PARENT] ${reason}`,
        env,
        tokenData.userId
      );
    } catch (err) {
      // Best-effort — don't fail the stop if the message can't be delivered (e.g., 409 busy)
      log.warn('mcp.stop_subtask.warning_message_failed', {
        parentTaskId: tokenData.taskId,
        childTaskId: taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Grace period to let the agent process the warning (capped at 30s to prevent misconfiguration)
    const gracePeriodMs = Math.min(limits.orchestratorStopGraceMs, 30_000);
    await new Promise((resolve) => setTimeout(resolve, gracePeriodMs));
  }

  // Hard stop the agent session
  try {
    await stopAgentSessionOnNode(
      workspace.nodeId,
      workspace.id,
      agentSession.id,
      env,
      tokenData.userId
    );
  } catch (err) {
    log.error('mcp.stop_subtask.stop_failed', {
      parentTaskId: tokenData.taskId,
      childTaskId: taskId,
      agentSessionId: agentSession.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonRpcError(
      requestId,
      INTERNAL_ERROR,
      `Failed to stop child agent session: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // An intentional parent stop is a cancellation, not a runtime failure. Use a
  // compare-and-set transition so a concurrent fatal callback keeps the actual
  // failure as the authoritative terminal story.
  const now = new Date().toISOString();
  const stopReason = reason ? `Stopped by parent: ${reason}` : 'Stopped by parent';

  let preservedTerminalStatus: string | null = null;
  try {
    const cancelFromStatus = async (fromStatus: string): Promise<boolean> => {
      const [transition] = await env.DATABASE.batch([
        env.DATABASE.prepare(
          `UPDATE tasks
              SET status = 'cancelled', error_message = ?, completed_at = ?, updated_at = ?
            WHERE id = ? AND status = ?`
        ).bind(stopReason, now, now, taskId, fromStatus),
        env.DATABASE.prepare(
          `INSERT INTO task_status_events
             (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
           SELECT ?, ?, ?, 'cancelled', 'agent', ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM tasks
               WHERE id = ? AND status = 'cancelled' AND completed_at = ?
            )`
        ).bind(ulid(), taskId, fromStatus, tokenData.workspaceId, stopReason, now, taskId, now),
      ]);
      if (!transition) {
        throw new Error('Task cancellation returned no transition result');
      }
      return Boolean(transition.meta.changes);
    };

    let cancelled = false;
    let fromStatus = task.status;
    for (let attempt = 1; attempt <= limits.orchestratorStopCasMaxAttempts; attempt += 1) {
      cancelled = await cancelFromStatus(fromStatus);
      if (cancelled) break;

      const current = await env.DATABASE.prepare('SELECT status FROM tasks WHERE id = ?')
        .bind(taskId)
        .first<{ status: string }>();
      if (!current) throw new Error('Child task disappeared during cancellation');
      if (
        current.status === 'completed' ||
        current.status === 'failed' ||
        current.status === 'cancelled'
      ) {
        log.info('mcp.stop_subtask.terminal_state_preserved', {
          parentTaskId: tokenData.taskId,
          childTaskId: taskId,
          attemptedFromStatus: fromStatus,
          currentStatus: current.status,
        });
        preservedTerminalStatus = current.status;
        break;
      }
      if (!ACTIVE_STATUSES.includes(current.status)) {
        throw new Error(
          `Child task entered unexpected status '${current.status}' during cancellation`
        );
      }
      if (attempt === limits.orchestratorStopCasMaxAttempts) {
        throw new Error(
          `Child task remained active after ${limits.orchestratorStopCasMaxAttempts} cancellation attempts`
        );
      }
      log.warn('mcp.stop_subtask.status_cas_retry', {
        parentTaskId: tokenData.taskId,
        childTaskId: taskId,
        attempt,
        maxAttempts: limits.orchestratorStopCasMaxAttempts,
        attemptedFromStatus: fromStatus,
        currentStatus: current.status,
      });
      fromStatus = current.status;
    }
    if (!cancelled && !preservedTerminalStatus) {
      throw new Error('Task cancellation did not reach a terminal state');
    }
  } catch (err) {
    log.error('mcp.stop_subtask.status_update_failed', {
      parentTaskId: tokenData.taskId,
      childTaskId: taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonRpcError(
      requestId,
      INTERNAL_ERROR,
      'Child agent stopped, but task cancellation failed'
    );
  }

  if (preservedTerminalStatus) {
    return jsonRpcSuccess(requestId, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            stopped: true,
            taskId,
            terminalStatePreserved: true,
            status: preservedTerminalStatus,
          }),
        },
      ],
    });
  }

  await syncTriggerExecutionStatus(env.DATABASE, taskId, 'cancelled');
  try {
    await cleanupTerminalTaskResources(env, taskId, {
      status: 'cancelled',
      errorMessage: stopReason,
      requiredUserId: tokenData.userId,
      logContext: { projectId: task.projectId, source: 'mcp.stop_subtask' },
    });
  } catch (err) {
    log.error('mcp.stop_subtask.terminal_cleanup_failed', {
      parentTaskId: tokenData.taskId,
      childTaskId: taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonRpcError(
      requestId,
      INTERNAL_ERROR,
      'Task was cancelled, but runtime cleanup failed'
    );
  }

  log.info('mcp.stop_subtask.completed', {
    parentTaskId: tokenData.taskId,
    childTaskId: taskId,
    workspaceId: workspace.id,
    agentSessionId: agentSession.id,
    reason: stopReason,
  });

  return jsonRpcSuccess(requestId, {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ stopped: true, taskId }),
      },
    ],
  });
}
