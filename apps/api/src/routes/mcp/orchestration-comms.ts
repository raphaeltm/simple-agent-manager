/**
 * MCP orchestration communication tools — parent → child agent messaging and control.
 *
 * send_message_to_subtask: Injects a user-role message into a running child agent's ACP session.
 * stop_subtask: Gracefully stops a child agent's session with an optional warning message.
 */
import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../index';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import { sendPromptToAgentOnNode, stopAgentSessionOnNode } from '../../services/node-agent';
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

interface ResolvedChild {
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
  };
  agentSession: {
    id: string;
  };
}

/**
 * Validate parent authorization and resolve child task → workspace → agent session.
 * Returns a JSON-RPC error response on failure, or the resolved child context on success.
 */
async function resolveChildAgent(
  requestId: string | number | null,
  childTaskId: string,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse | ResolvedChild> {
  const db = drizzle(env.DATABASE, { schema });

  // 1. Validate caller is a task agent
  if (!tokenData.taskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Only task agents can use orchestration tools');
  }

  // 2. Query child task
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
    return jsonRpcError(requestId, INVALID_PARAMS, 'Child task not found in this project');
  }

  // 3. Authorization: direct parent only
  if (childTask.parentTaskId !== tokenData.taskId) {
    log.warn('mcp.orchestration.unauthorized_parent', {
      callerTaskId: tokenData.taskId,
      childTaskId,
      actualParentTaskId: childTask.parentTaskId,
      projectId: tokenData.projectId,
    });
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Only the direct parent task can communicate with a child task',
    );
  }

  // 4. Verify child is in an active status
  if (!ACTIVE_STATUSES.includes(childTask.status)) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Child task is in '${childTask.status}' status — only active tasks can receive messages`,
    );
  }

  // 5. Resolve workspace
  if (!childTask.workspaceId) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Child task has no workspace assigned yet (it may still be provisioning)',
    );
  }

  const [workspace] = await db
    .select({
      id: schema.workspaces.id,
      nodeId: schema.workspaces.nodeId,
      nodeStatus: schema.nodes.status,
    })
    .from(schema.workspaces)
    .leftJoin(schema.nodes, eq(schema.workspaces.nodeId, schema.nodes.id))
    .where(eq(schema.workspaces.id, childTask.workspaceId))
    .limit(1);

  if (!workspace || !workspace.nodeId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Child workspace or node not found');
  }

  // Verify node is reachable
  if (workspace.nodeStatus !== 'active' && workspace.nodeStatus !== 'warm') {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Child workspace node is no longer running',
    );
  }

  // 6. Resolve running agent session
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

  if (!agentSession) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'No running agent session found for child task');
  }

  return {
    task: {
      id: childTask.id,
      status: childTask.status,
      workspaceId: childTask.workspaceId,
      projectId: childTask.projectId,
    },
    workspace: {
      id: workspace.id,
      nodeId: workspace.nodeId,
      nodeStatus: workspace.nodeStatus,
    },
    agentSession: {
      id: agentSession.id,
    },
  };
}

/** Type guard: check if the resolution result is an error response. */
function isError(result: JsonRpcResponse | ResolvedChild): result is JsonRpcResponse {
  return 'jsonrpc' in result;
}

// ─── send_message_to_subtask ────────────────────────────────────────────────

export async function handleSendMessageToSubtask(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
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

  // Resolve child agent
  const resolution = await resolveChildAgent(requestId, taskId, tokenData, env);
  if (isError(resolution)) {
    return resolution;
  }

  const { workspace, agentSession } = resolution;

  // Send the prompt to the child agent's running session
  try {
    await sendPromptToAgentOnNode(
      workspace.nodeId,
      workspace.id,
      agentSession.id,
      message,
      env,
      tokenData.userId,
    );

    log.info('mcp.send_message_to_subtask.delivered', {
      parentTaskId: tokenData.taskId,
      childTaskId: taskId,
      workspaceId: workspace.id,
      agentSessionId: agentSession.id,
      messageLength: message.length,
    });

    return jsonRpcSuccess(requestId, {
      content: [{
        type: 'text',
        text: JSON.stringify({ delivered: true }),
      }],
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Handle 409 — agent is busy (HostPrompting state)
    if (errorMessage.includes('409')) {
      log.info('mcp.send_message_to_subtask.agent_busy', {
        parentTaskId: tokenData.taskId,
        childTaskId: taskId,
        agentSessionId: agentSession.id,
      });

      return jsonRpcSuccess(requestId, {
        content: [{
          type: 'text',
          text: JSON.stringify({ delivered: false, reason: 'agent_busy' }),
        }],
      });
    }

    log.error('mcp.send_message_to_subtask.failed', {
      parentTaskId: tokenData.taskId,
      childTaskId: taskId,
      error: errorMessage,
    });

    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to send message to child agent: ${errorMessage}`);
  }
}

// ─── stop_subtask ───────────────────────────────────────────────────────────

export async function handleStopSubtask(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);

  // Validate params
  const taskId = typeof params.taskId === 'string' ? params.taskId.trim() : '';
  if (!taskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'taskId is required');
  }

  const reason = typeof params.reason === 'string'
    ? sanitizeUserInput(params.reason.trim()).slice(0, limits.orchestratorMessageMaxLength)
    : undefined;

  // Resolve child agent
  const resolution = await resolveChildAgent(requestId, taskId, tokenData, env);
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
        tokenData.userId,
      );
    } catch (err) {
      // Best-effort — don't fail the stop if the message can't be delivered (e.g., 409 busy)
      log.warn('mcp.stop_subtask.warning_message_failed', {
        parentTaskId: tokenData.taskId,
        childTaskId: taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Grace period to let the agent process the warning
    await new Promise((resolve) => setTimeout(resolve, limits.orchestratorStopGraceMs));
  }

  // Hard stop the agent session
  try {
    await stopAgentSessionOnNode(
      workspace.nodeId,
      workspace.id,
      agentSession.id,
      env,
      tokenData.userId,
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
      `Failed to stop child agent session: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Update task status to failed with parent-stop reason
  const db = drizzle(env.DATABASE, { schema });
  const now = new Date().toISOString();
  const failReason = reason
    ? `stopped_by_parent: ${reason}`
    : 'stopped_by_parent';

  try {
    await db.update(schema.tasks)
      .set({
        status: 'failed',
        errorMessage: failReason,
        updatedAt: now,
      })
      .where(eq(schema.tasks.id, taskId));

    // Record status event
    await db.insert(schema.taskStatusEvents).values({
      id: ulid(),
      taskId,
      fromStatus: task.status,
      toStatus: 'failed',
      actorType: 'agent',
      actorId: tokenData.workspaceId,
      reason: failReason,
      createdAt: now,
    });
  } catch (err) {
    // Status update failure is non-fatal — the agent session is already stopped
    log.error('mcp.stop_subtask.status_update_failed', {
      parentTaskId: tokenData.taskId,
      childTaskId: taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  log.info('mcp.stop_subtask.completed', {
    parentTaskId: tokenData.taskId,
    childTaskId: taskId,
    workspaceId: workspace.id,
    agentSessionId: agentSession.id,
    reason: failReason,
  });

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({ stopped: true, taskId }),
    }],
  });
}
