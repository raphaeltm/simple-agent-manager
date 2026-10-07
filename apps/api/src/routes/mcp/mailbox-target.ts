/**
 * Mailbox tool helpers — same-project target resolution, immediate legacy
 * delivery, and caller chat-session lookup shared by the durable messaging tools.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { sendPromptToAgentOnNode } from '../../services/node-agent';
import { persistOrchestrationPrompt } from '../../services/orchestration-prompts';
import * as projectDataService from '../../services/project-data';
import {
  ACTIVE_STATUSES,
  AGENT_TARGET_STATUSES,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  type McpTokenData,
} from './_helpers';

export interface ResolvedMailboxTarget {
  taskStatus: string;
  projectId: string;
  chatSessionId: string;
  nodeId: string;
  workspaceId: string;
  agentSessionId: string;
  /** Stable source-task authority (recovery_source_task_id ?? id) of each participant. */
  callerSourceTaskId: string;
  targetSourceTaskId: string;
}

/**
 * Resolve a same-project active target task to its project, chat session,
 * workspace, and optional running agent session. The caller project comes from
 * the verified MCP token; callers cannot supply or override project identity.
 */
export async function resolveProjectAgentForMailbox(
  requestId: string | number | null,
  targetTaskId: string,
  tokenData: McpTokenData,
  db: DrizzleD1Database<typeof schema>
): Promise<JsonRpcResponse | ResolvedMailboxTarget> {
  // Query target task in the caller's verified project. This project predicate
  // is the authorization boundary for durable agent messaging.
  const requestedTaskIds = [...new Set([tokenData.taskId, targetTaskId])];
  const taskRows = await db
    .select({
      id: schema.tasks.id,
      status: schema.tasks.status,
      workspaceId: schema.tasks.workspaceId,
      projectId: schema.tasks.projectId,
      recoverySourceTaskId: schema.tasks.recoverySourceTaskId,
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

  if (!targetTask) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Target task not found in this project');
  }

  // Verify target is in an active status
  if (!AGENT_TARGET_STATUSES.includes(targetTask.status)) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Target task is in '${targetTask.status}' status — only active tasks can receive messages`
    );
  }

  if (!targetTask.workspaceId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Target task has no workspace assigned yet');
  }

  // Resolve workspace + node. Require the workspace's own project_id to match
  // the caller project as a defence-in-depth consistency check.
  const [workspace] = await db
    .select({
      id: schema.workspaces.id,
      nodeId: schema.workspaces.nodeId,
      chatSessionId: schema.workspaces.chatSessionId,
    })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.id, targetTask.workspaceId),
        eq(schema.workspaces.projectId, tokenData.projectId)
      )
    )
    .limit(1);

  if (!workspace || (!workspace.nodeId && targetTask.status !== 'sleeping')) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Target workspace or node not found');
  }

  // Use workspace's chatSessionId (canonical session mapping)
  const chatSessionId = workspace.chatSessionId;
  if (!chatSessionId) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Target task has no chat session — messages cannot be queued'
    );
  }

  // Resolve running agent session
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

  return {
    taskStatus: targetTask.status,
    projectId: targetTask.projectId,
    chatSessionId,
    nodeId: workspace.nodeId ?? '',
    workspaceId: workspace.id,
    agentSessionId: agentSession?.id ?? '',
    callerSourceTaskId: callerTask.recoverySourceTaskId ?? callerTask.id,
    targetSourceTaskId: targetTask.recoverySourceTaskId ?? targetTask.id,
  };
}

/**
 * Attempt immediate delivery by sending the message content to the agent via the node.
 */
export async function attemptImmediateDelivery(
  env: Env,
  _db: DrizzleD1Database<typeof schema>,
  messageId: string,
  target: ResolvedMailboxTarget,
  content: string,
  userId: string
): Promise<boolean> {
  if (!target.agentSessionId) return false;

  const persistedMessageId = await persistOrchestrationPrompt({
    env,
    projectId: target.projectId,
    chatSessionId: target.chatSessionId,
    content,
    messageId,
    source: 'agent_mailbox',
    kind: 'mailbox_immediate_delivery',
    mailboxMessageId: messageId,
    senderId: userId,
  });

  try {
    await sendPromptToAgentOnNode(
      target.nodeId,
      target.workspaceId,
      target.agentSessionId,
      content,
      env,
      userId,
      persistedMessageId
    );

    // Mark as delivered in the DO
    await projectDataService.markMailboxMessageDelivered(env, target.projectId, messageId);
    return true;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    // 409 means agent busy — message stays queued for alarm-based delivery
    if (errorMessage.includes('409')) {
      log.info('mcp.mailbox.immediate_delivery_busy', {
        messageId,
        agentSessionId: target.agentSessionId,
      });
    } else {
      log.warn('mcp.mailbox.immediate_delivery_failed', { messageId, error: errorMessage });
    }
    return false;
  }
}

/**
 * Resolve the calling agent's chat session from its workspace.
 */
export async function resolveCallerChatSession(
  tokenData: McpTokenData,
  env: Env
): Promise<string | null> {
  if (!tokenData.workspaceId) return null;

  const db = drizzle(env.DATABASE, { schema });
  const [workspace] = await db
    .select({ chatSessionId: schema.workspaces.chatSessionId })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.id, tokenData.workspaceId),
        eq(schema.workspaces.projectId, tokenData.projectId)
      )
    )
    .limit(1);

  return workspace?.chatSessionId ?? null;
}
