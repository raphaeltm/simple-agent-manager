/**
 * SAM send_message_to_subtask tool — send a message to a running agent.
 *
 * Resolves the task → workspace → node → agent session chain,
 * verifies ownership, and injects a user-role message.
 */
import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { Env } from '../../../env';
import { log } from '../../../lib/logger';
import { sendPromptToAgentOnNode } from '../../../services/node-agent';
import * as projectDataService from '../../../services/project-data';
import type { AnthropicToolDef, ToolContext } from '../types';

const ACTIVE_STATUSES = ['queued', 'provisioning', 'running', 'awaiting_followup'];
const DEFAULT_MAX_MESSAGE_LENGTH = 32_000;

export const sendMessageToSubtaskDef: AnthropicToolDef = {
  name: 'send_message_to_subtask',
  description:
    'Send a message to a running agent working on a task. ' +
    'Use this to give additional instructions, redirect the agent, or answer its questions.',
  input_schema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The ID of the running task to message.',
      },
      message: {
        type: 'string',
        description: 'The message to send to the agent.',
      },
    },
    required: ['taskId', 'message'],
  },
};

export async function sendMessageToSubtask(
  input: { taskId: string; message: string },
  ctx: ToolContext,
): Promise<unknown> {
  if (!input.taskId?.trim()) {
    return { error: 'taskId is required.' };
  }
  if (!input.message?.trim()) {
    return { error: 'message is required.' };
  }

  const env = ctx.env as unknown as Env;
  const db = drizzle(env.DATABASE, { schema });
  const taskId = input.taskId.trim();
  const maxLen = Number(env.SAM_MESSAGE_MAX_LENGTH) || DEFAULT_MAX_MESSAGE_LENGTH;
  const message = input.message.trim().slice(0, maxLen);

  // Look up task with ownership verification
  const rows = await db
    .select({
      id: schema.tasks.id,
      status: schema.tasks.status,
      workspaceId: schema.tasks.workspaceId,
      projectId: schema.tasks.projectId,
      title: schema.tasks.title,
    })
    .from(schema.tasks)
    .innerJoin(schema.projects, eq(schema.tasks.projectId, schema.projects.id))
    .where(
      and(
        eq(schema.tasks.id, taskId),
        eq(schema.projects.userId, ctx.userId),
      ),
    )
    .limit(1);

  const task = rows[0];
  if (!task) {
    return { error: 'Task not found or not owned by you.' };
  }

  if (!ACTIVE_STATUSES.includes(task.status)) {
    return { error: `Task is in '${task.status}' status — only active tasks can receive messages.` };
  }

  if (!task.workspaceId) {
    return { error: 'Task has no workspace assigned yet (it may still be provisioning).' };
  }

  // Resolve workspace → node
  const [workspace] = await db
    .select({
      id: schema.workspaces.id,
      nodeId: schema.workspaces.nodeId,
      nodeStatus: schema.nodes.status,
    })
    .from(schema.workspaces)
    .leftJoin(schema.nodes, eq(schema.workspaces.nodeId, schema.nodes.id))
    .where(eq(schema.workspaces.id, task.workspaceId))
    .limit(1);

  if (!workspace?.nodeId) {
    return { error: 'Workspace or node not found.' };
  }

  if (workspace.nodeStatus !== 'running') {
    return { error: `Node is not running (status: ${workspace.nodeStatus ?? 'unknown'}).` };
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

  if (!agentSession) {
    return { error: 'No running agent session found for this task.' };
  }

  // Send the message
  try {
    await sendPromptToAgentOnNode(
      workspace.nodeId,
      workspace.id,
      agentSession.id,
      message,
      env,
      ctx.userId,
    );

    log.info('sam.send_message_to_subtask.delivered', {
      taskId,
      workspaceId: workspace.id,
      agentSessionId: agentSession.id,
      messageLength: message.length,
    });

    return {
      delivered: true,
      taskId,
      message: `Message delivered to agent working on '${task.title || taskId}'.`,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Handle 409 — agent is busy, try queuing via mailbox
    if (errorMessage.includes('409')) {
      log.info('sam.send_message_to_subtask.agent_busy', { taskId, agentSessionId: agentSession.id });

      try {
        const [ws] = await db
          .select({ chatSessionId: schema.workspaces.chatSessionId })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, workspace.id))
          .limit(1);

        if (ws?.chatSessionId) {
          const msg = await projectDataService.enqueueMailboxMessage(env, task.projectId, {
            targetSessionId: ws.chatSessionId,
            sourceTaskId: null,
            senderType: 'human',
            senderId: ctx.userId,
            messageClass: 'deliver',
            content: message,
            metadata: null,
          });

          return {
            delivered: false,
            queued: true,
            messageId: msg.id,
            taskId,
            message: 'Agent is busy — message queued for delivery at next turn boundary.',
          };
        }
      } catch (queueErr) {
        log.warn('sam.send_message_to_subtask.queue_failed', {
          taskId,
          error: queueErr instanceof Error ? queueErr.message : String(queueErr),
        });
      }

      return {
        delivered: false,
        queued: false,
        taskId,
        message: 'Agent is currently busy processing. Try again in a moment.',
      };
    }

    log.error('sam.send_message_to_subtask.failed', {
      taskId,
      error: errorMessage,
    });

    return { error: 'Failed to send message to the agent. The error has been logged.' };
  }
}
