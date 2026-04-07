/**
 * MCP orchestration tools — parent-to-child agent communication.
 *
 * - send_message_to_subtask: Send a message to a child task's session inbox
 * - stop_subtask: Gracefully stop a child task (cancel → warning → hard stop)
 */
import type { ProjectData } from '../../durable-objects/project-data';
import type { Env } from '../../index';
import { log } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';
import { cancelAgentSessionOnNode, sendPromptToAgentOnNode, stopAgentSessionOnNode } from '../../services/node-agent';
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

/** Default wait time (ms) after cancel before sending warning/re-prompt. */
const DEFAULT_ORCHESTRATOR_CANCEL_SETTLE_MS = 2000;

/** Default timeout (ms) for the full cancel→stop sequence. */
const DEFAULT_ORCHESTRATOR_CANCEL_TIMEOUT_MS = 5000;

function getCancelSettleMs(env: Env): number {
  return parsePositiveInt(
    env.ORCHESTRATOR_CANCEL_SETTLE_MS,
    DEFAULT_ORCHESTRATOR_CANCEL_SETTLE_MS,
  );
}

function getCancelTimeoutMs(env: Env): number {
  return parsePositiveInt(
    env.ORCHESTRATOR_CANCEL_TIMEOUT_MS,
    DEFAULT_ORCHESTRATOR_CANCEL_TIMEOUT_MS,
  );
}

/**
 * Resolve a child task's active agent session context.
 * Returns null if the child task has no workspace, session, or node.
 */
async function resolveChildAgentContext(
  db: D1Database,
  childTaskId: string,
  parentProjectId: string,
  parentUserId: string,
): Promise<{
  workspaceId: string;
  chatSessionId: string;
  nodeId: string;
} | null> {
  const row = await db.prepare(`
    SELECT t.project_id, t.user_id, t.status, w.id as workspace_id, w.chat_session_id, w.node_id
    FROM tasks t
    LEFT JOIN workspaces w ON w.id = t.workspace_id
    WHERE t.id = ?
  `).bind(childTaskId).first<{
    project_id: string;
    user_id: string;
    status: string;
    workspace_id: string | null;
    chat_session_id: string | null;
    node_id: string | null;
  }>();

  if (!row) return null;

  // Verify same project and user
  if (row.project_id !== parentProjectId || row.user_id !== parentUserId) {
    return null;
  }

  if (!row.workspace_id || !row.chat_session_id || !row.node_id) {
    return null;
  }

  return {
    workspaceId: row.workspace_id,
    chatSessionId: row.chat_session_id,
    nodeId: row.node_id,
  };
}

// ─── send_message_to_subtask ────────────────────────────────────────────────

export async function handleSendMessageToSubtask(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const taskId = params.taskId;
  if (typeof taskId !== 'string' || !taskId.trim()) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'taskId is required and must be a non-empty string');
  }

  const message = params.message;
  if (typeof message !== 'string' || !message.trim()) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'message is required and must be a non-empty string');
  }

  const priority = params.priority === 'urgent' ? 'urgent' as const : 'normal' as const;

  const sanitizedMessage = sanitizeUserInput(message.trim());

  // Verify the child task belongs to the same project and user
  const childRow = await env.DATABASE.prepare(
    'SELECT project_id, user_id, parent_task_id, status FROM tasks WHERE id = ?',
  ).bind(taskId.trim()).first<{
    project_id: string;
    user_id: string;
    parent_task_id: string | null;
    status: string;
  }>();

  if (!childRow) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Child task not found');
  }

  if (childRow.project_id !== tokenData.projectId || childRow.user_id !== tokenData.userId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Child task does not belong to this project or user');
  }

  // Verify calling agent is the parent
  if (childRow.parent_task_id !== tokenData.taskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'You are not the parent of this task');
  }

  if (!(ACTIVE_STATUSES as readonly string[]).includes(childRow.status)) {
    return jsonRpcError(requestId, INVALID_PARAMS, `Child task is not active (status: ${childRow.status})`);
  }

  // Resolve the child task's workspace/session to find its project
  const childCtx = await resolveChildAgentContext(
    env.DATABASE,
    taskId.trim(),
    tokenData.projectId,
    tokenData.userId,
  );

  if (!childCtx) {
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Child task has no active workspace or session');
  }

  // Enqueue message to child's session inbox
  const limits = getMcpLimits(env);
  const doId = env.PROJECT_DATA.idFromName(tokenData.projectId);
  const doStub = env.PROJECT_DATA.get(doId) as DurableObjectStub<ProjectData>;

  await doStub.enqueueInboxMessage(
    {
      targetSessionId: childCtx.chatSessionId,
      sourceTaskId: tokenData.taskId,
      messageType: 'parent_message',
      content: sanitizedMessage,
      priority,
    },
    limits.inboxMaxSize,
    limits.inboxMessageMaxLength,
  );

  log.info('mcp.send_message_to_subtask', {
    parentTaskId: tokenData.taskId,
    childTaskId: taskId.trim(),
    priority,
    sessionId: childCtx.chatSessionId,
  });

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: `Message enqueued to sub-task ${taskId.trim()} (priority: ${priority}). The sub-task agent will receive it when it next goes idle${priority === 'urgent' ? ' or via interrupt if busy' : ''}.`,
    }],
  });
}

// ─── stop_subtask ───────────────────────────────────────────────────────────

export async function handleStopSubtask(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const taskId = params.taskId;
  if (typeof taskId !== 'string' || !taskId.trim()) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'taskId is required and must be a non-empty string');
  }

  const reason = typeof params.reason === 'string' ? params.reason.trim() : 'Stopped by parent task';

  // Verify the child task belongs to the same project and user
  const childRow = await env.DATABASE.prepare(
    'SELECT project_id, user_id, parent_task_id, status FROM tasks WHERE id = ?',
  ).bind(taskId.trim()).first<{
    project_id: string;
    user_id: string;
    parent_task_id: string | null;
    status: string;
  }>();

  if (!childRow) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Child task not found');
  }

  if (childRow.project_id !== tokenData.projectId || childRow.user_id !== tokenData.userId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Child task does not belong to this project or user');
  }

  if (childRow.parent_task_id !== tokenData.taskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'You are not the parent of this task');
  }

  if (!(ACTIVE_STATUSES as readonly string[]).includes(childRow.status)) {
    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: `Sub-task ${taskId.trim()} is already in terminal state: ${childRow.status}` }],
    });
  }

  const childCtx = await resolveChildAgentContext(
    env.DATABASE,
    taskId.trim(),
    tokenData.projectId,
    tokenData.userId,
  );

  if (!childCtx) {
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Child task has no active workspace or session');
  }

  const cancelSettleMs = getCancelSettleMs(env);
  const steps: string[] = [];

  try {
    // Step 1: Cancel any running prompt
    const cancelResult = await cancelAgentSessionOnNode(
      childCtx.nodeId,
      childCtx.workspaceId,
      childCtx.chatSessionId,
      env,
      tokenData.userId,
    );

    if (cancelResult.success) {
      steps.push('Cancelled running prompt');
      // Wait for the cancel to settle
      await new Promise((resolve) => setTimeout(resolve, cancelSettleMs));
    } else if (cancelResult.status === 409) {
      steps.push('No prompt in flight (agent was idle)');
    } else {
      steps.push(`Cancel returned status ${cancelResult.status}`);
    }

    // Step 2: Try to send a warning message
    try {
      const warningMsg = `[System] You are being stopped by your parent task. Reason: ${sanitizeUserInput(reason)}. Save your work and finish up.`;
      await sendPromptToAgentOnNode(
        childCtx.nodeId,
        childCtx.workspaceId,
        childCtx.chatSessionId,
        warningMsg,
        env,
        tokenData.userId,
      );
      steps.push('Warning message sent');

      // Give the agent a moment to process the warning
      const timeoutMs = getCancelTimeoutMs(env);
      await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 3000)));
    } catch {
      steps.push('Warning message delivery failed (agent may be busy)');
    }

    // Step 3: Hard stop the session
    try {
      await stopAgentSessionOnNode(
        childCtx.nodeId,
        childCtx.workspaceId,
        childCtx.chatSessionId,
        env,
        tokenData.userId,
      );
      steps.push('Session stopped');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      steps.push(`Session stop failed: ${errMsg}`);
    }

    log.info('mcp.stop_subtask', {
      parentTaskId: tokenData.taskId,
      childTaskId: taskId.trim(),
      steps,
    });

    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: `Sub-task ${taskId.trim()} stop sequence completed:\n${steps.map((s) => `- ${s}`).join('\n')}` }],
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error('mcp.stop_subtask.error', {
      parentTaskId: tokenData.taskId,
      childTaskId: taskId.trim(),
      error: errMsg,
      steps,
    });
    return jsonRpcError(requestId, INTERNAL_ERROR, `Stop sub-task failed: ${errMsg}`);
  }
}
