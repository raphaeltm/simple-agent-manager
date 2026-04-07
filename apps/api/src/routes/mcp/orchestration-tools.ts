/**
 * MCP orchestration tools — parent-to-child agent communication.
 *
 * - send_message_to_subtask: Send a message to a child task's session inbox
 * - stop_subtask: Gracefully stop a child task (cancel → warning → hard stop)
 * - get_inbox_status: Check the caller's session inbox for pending messages
 */
import type { ProjectData } from '../../durable-objects/project-data';
import type { InboxStats } from '../../durable-objects/project-data/inbox';
import type { Env } from '../../index';
import { log } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';
import { cancelAgentSessionOnNode, sendPromptToAgentOnNode, stopAgentSessionOnNode } from '../../services/node-agent';
import {
  ACTIVE_STATUSES,
  DEFAULT_ORCHESTRATOR_CANCEL_SETTLE_MS,
  DEFAULT_ORCHESTRATOR_CANCEL_TIMEOUT_MS,
  DEFAULT_ORCHESTRATOR_CANCEL_WARNING_SETTLE_MS,
  getMcpLimits,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
  sanitizeUserInput,
} from './_helpers';

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

function getCancelWarningSettleMs(env: Env): number {
  return parsePositiveInt(
    env.ORCHESTRATOR_CANCEL_WARNING_SETTLE_MS,
    DEFAULT_ORCHESTRATOR_CANCEL_WARNING_SETTLE_MS,
  );
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

  // Single query: verify ownership + resolve workspace/session context
  const childRow = await env.DATABASE.prepare(`
    SELECT t.project_id, t.user_id, t.parent_task_id, t.status,
           w.id as workspace_id, w.chat_session_id, w.node_id
    FROM tasks t
    LEFT JOIN workspaces w ON w.id = t.workspace_id
    WHERE t.id = ?
  `).bind(taskId.trim()).first<{
    project_id: string;
    user_id: string;
    parent_task_id: string | null;
    status: string;
    workspace_id: string | null;
    chat_session_id: string | null;
    node_id: string | null;
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
    return jsonRpcError(requestId, INVALID_PARAMS, `Child task is not active (status: ${childRow.status})`);
  }

  if (!childRow.workspace_id || !childRow.chat_session_id || !childRow.node_id) {
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Child task has no active workspace or session');
  }

  // Enqueue message to child's session inbox
  const limits = getMcpLimits(env);
  const doId = env.PROJECT_DATA.idFromName(tokenData.projectId);
  const doStub = env.PROJECT_DATA.get(doId) as DurableObjectStub<ProjectData>;

  await doStub.enqueueInboxMessage(
    {
      targetSessionId: childRow.chat_session_id,
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
    sessionId: childRow.chat_session_id,
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

  // Single query: verify ownership + resolve workspace/session context
  const childRow = await env.DATABASE.prepare(`
    SELECT t.project_id, t.user_id, t.parent_task_id, t.status,
           w.id as workspace_id, w.chat_session_id, w.node_id
    FROM tasks t
    LEFT JOIN workspaces w ON w.id = t.workspace_id
    WHERE t.id = ?
  `).bind(taskId.trim()).first<{
    project_id: string;
    user_id: string;
    parent_task_id: string | null;
    status: string;
    workspace_id: string | null;
    chat_session_id: string | null;
    node_id: string | null;
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

  if (!childRow.workspace_id || !childRow.chat_session_id || !childRow.node_id) {
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Child task has no active workspace or session');
  }

  const cancelSettleMs = getCancelSettleMs(env);
  const steps: string[] = [];

  try {
    // Step 1: Cancel any running prompt
    const cancelResult = await cancelAgentSessionOnNode(
      childRow.node_id,
      childRow.workspace_id,
      childRow.chat_session_id,
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
        childRow.node_id,
        childRow.workspace_id,
        childRow.chat_session_id,
        warningMsg,
        env,
        tokenData.userId,
      );
      steps.push('Warning message sent');

      // Give the agent a moment to process the warning
      const timeoutMs = getCancelTimeoutMs(env);
      const warningSettleMs = getCancelWarningSettleMs(env);
      await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, warningSettleMs)));
    } catch {
      steps.push('Warning message delivery failed (agent may be busy)');
    }

    // Step 3: Hard stop the session
    try {
      await stopAgentSessionOnNode(
        childRow.node_id,
        childRow.workspace_id,
        childRow.chat_session_id,
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

// ─── get_inbox_status ──────────────────────────────────────────────────────

export async function handleGetInboxStatus(
  requestId: string | number | null,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  // Resolve the caller's chat session ID from their workspace
  const workspaceRow = await env.DATABASE.prepare(
    'SELECT chat_session_id FROM workspaces WHERE id = ?',
  ).bind(tokenData.workspaceId).first<{ chat_session_id: string | null }>();

  if (!workspaceRow?.chat_session_id) {
    return jsonRpcError(requestId, INTERNAL_ERROR, 'No active session found for this workspace');
  }

  const doId = env.PROJECT_DATA.idFromName(tokenData.projectId);
  const doStub = env.PROJECT_DATA.get(doId) as DurableObjectStub<ProjectData>;
  const stats: InboxStats = await doStub.getInboxStats(workspaceRow.chat_session_id);

  log.info('mcp.get_inbox_status', {
    taskId: tokenData.taskId,
    sessionId: workspaceRow.chat_session_id,
    pending: stats.pending,
    urgentCount: stats.urgentCount,
  });

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        pendingCount: stats.pending,
        urgentCount: stats.urgentCount,
        oldestMessageAgeMs: stats.oldestMessageAgeMs,
      }),
    }],
  });
}
