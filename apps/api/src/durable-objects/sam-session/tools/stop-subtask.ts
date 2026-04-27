/**
 * SAM stop_subtask tool — stop a running task.
 *
 * Looks up the task, verifies the project is owned by the user,
 * stops the running agent session on the VM, and marks the task as cancelled.
 */
import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { Env } from '../../../env';
import { log } from '../../../lib/logger';
import { ulid } from '../../../lib/ulid';
import { stopAgentSessionOnNode } from '../../../services/node-agent';
import * as projectDataService from '../../../services/project-data';
import type { AnthropicToolDef, ToolContext } from '../types';

const ACTIVE_STATUSES = ['queued', 'provisioning', 'running', 'awaiting_followup'];

export const stopSubtaskDef: AnthropicToolDef = {
  name: 'stop_subtask',
  description:
    'Stop a running task. Terminates the agent session and marks the task as cancelled. ' +
    'Use this when a task is stuck, going in the wrong direction, or no longer needed.',
  input_schema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The ID of the task to stop.',
      },
    },
    required: ['taskId'],
  },
};

export async function stopSubtask(
  input: { taskId: string },
  ctx: ToolContext,
): Promise<unknown> {
  if (!input.taskId?.trim()) {
    return { error: 'taskId is required.' };
  }

  const env = ctx.env as unknown as Env;
  const db = drizzle(env.DATABASE, { schema });
  const taskId = input.taskId.trim();

  // Look up task with ownership verification via projects join
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
    return { error: `Task is already in '${task.status}' status — only active tasks can be stopped.` };
  }

  // Try to stop the agent session on the VM (best-effort)
  if (task.workspaceId) {
    try {
      const [workspace] = await db
        .select({
          id: schema.workspaces.id,
          nodeId: schema.workspaces.nodeId,
        })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, task.workspaceId))
        .limit(1);

      if (workspace?.nodeId) {
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

        if (agentSession) {
          await stopAgentSessionOnNode(
            workspace.nodeId,
            workspace.id,
            agentSession.id,
            env,
            ctx.userId,
          );
        }
      }
    } catch (err) {
      // Best-effort — we still mark the task as cancelled even if session stop fails
      log.warn('sam.stop_subtask.session_stop_failed', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Mark task as cancelled
  const now = new Date().toISOString();
  try {
    await env.DATABASE.prepare(
      `UPDATE tasks SET status = 'cancelled', error_message = 'Stopped by user via SAM', updated_at = ?, completed_at = ? WHERE id = ?`,
    ).bind(now, now, taskId).run();

    await env.DATABASE.prepare(
      `INSERT INTO task_status_events (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
       VALUES (?, ?, ?, 'cancelled', 'user', ?, 'Stopped via SAM', ?)`,
    ).bind(ulid(), taskId, task.status, ctx.userId, now).run();
  } catch (err) {
    log.error('sam.stop_subtask.status_update_failed', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { error: 'Failed to update task status.' };
  }

  // Stop chat session (best-effort)
  if (task.workspaceId && task.projectId) {
    try {
      const [ws] = await db
        .select({ chatSessionId: schema.workspaces.chatSessionId })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, task.workspaceId))
        .limit(1);
      if (ws?.chatSessionId) {
        await projectDataService.stopSession(env, task.projectId, ws.chatSessionId);
      }
    } catch {
      // Best-effort
    }
  }

  log.info('sam.stop_subtask.completed', { taskId, previousStatus: task.status });

  return {
    stopped: true,
    taskId,
    previousStatus: task.status,
    message: `Task '${task.title || taskId}' has been stopped.`,
  };
}
