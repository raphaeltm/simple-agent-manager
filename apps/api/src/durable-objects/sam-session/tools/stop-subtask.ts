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
import { isSleepingContainerNode } from '../../../services/sleeping-container-runtime';
import { WAKEABLE_TASK_STATUSES } from '../../../services/task-status';
import { cleanupTerminalTaskResources } from '../../../services/task-terminal-cleanup';
import { syncTriggerExecutionStatus } from '../../../services/trigger-execution-sync';
import type { AnthropicToolDef, ToolContext } from '../types';

/**
 * Tasks SAM may stop: every live status plus `sleeping` (TRANSITIONS allows
 * sleeping → cancelled, and the MCP stop_subtask handles it the same way).
 */
const STOPPABLE_STATUSES = WAKEABLE_TASK_STATUSES;

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

export async function stopSubtask(input: { taskId: string }, ctx: ToolContext): Promise<unknown> {
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
    .where(and(eq(schema.tasks.id, taskId), eq(schema.projects.userId, ctx.userId)))
    .limit(1);

  const task = rows[0];
  if (!task) {
    return { error: 'Task not found or not owned by you.' };
  }

  if (!STOPPABLE_STATUSES.includes(task.status)) {
    return {
      error: `Task is already in '${task.status}' status — only active tasks can be stopped.`,
    };
  }

  // Mark task as cancelled first. Compare-and-set on the status read above, so a task
  // that completed or failed meanwhile keeps its real terminal story; the status event
  // is only written when this cancellation actually landed.
  const now = new Date().toISOString();
  let cancelled = false;
  try {
    const [transition] = await env.DATABASE.batch([
      env.DATABASE.prepare(
        `UPDATE tasks SET status = 'cancelled', error_message = 'Stopped by user via SAM', updated_at = ?, completed_at = ?
          WHERE id = ? AND status = ?`
      ).bind(now, now, taskId, task.status),
      env.DATABASE.prepare(
        `INSERT INTO task_status_events (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
         SELECT ?, ?, ?, 'cancelled', 'user', ?, 'Stopped via SAM', ?
          WHERE EXISTS (
            SELECT 1 FROM tasks WHERE id = ? AND status = 'cancelled' AND completed_at = ?
          )`
      ).bind(ulid(), taskId, task.status, ctx.userId, now, taskId, now),
    ]);
    cancelled = Boolean(transition?.meta?.changes);
  } catch (err) {
    log.error('sam.stop_subtask.status_update_failed', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { error: 'Failed to update task status.' };
  }

  if (!cancelled) {
    log.warn('sam.stop_subtask.status_changed', {
      taskId,
      readStatus: task.status,
      action: 'cancel_skipped',
    });
    return {
      error: `Task changed status while stopping (was '${task.status}'). Check its current status before retrying.`,
    };
  }

  // Stop the agent only after the cancel won, so a lost race never leaves a live
  // task with a dead agent. Best-effort; a sleeping task has already released its
  // runtime, so stop it without waking it.
  if (task.workspaceId && task.status !== 'sleeping') {
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
              eq(schema.agentSessions.status, 'running')
            )
          )
          .orderBy(desc(schema.agentSessions.createdAt))
          .limit(1);

        // A slept Instant runtime runs nothing, and the request would restore it just to stop it.
        if (agentSession && !(await isSleepingContainerNode(db, workspace.nodeId))) {
          await stopAgentSessionOnNode(
            workspace.nodeId,
            workspace.id,
            agentSession.id,
            env,
            ctx.userId
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

  // Same as the MCP stop_subtask: a trigger-linked task's execution follows it.
  await syncTriggerExecutionStatus(env.DATABASE, taskId, 'cancelled');

  try {
    await cleanupTerminalTaskResources(env, taskId, {
      status: 'cancelled',
      errorMessage: 'Stopped by user via SAM',
      logContext: { projectId: task.projectId, source: 'sam.stop_subtask' },
    });
  } catch (err) {
    log.error('sam.stop_subtask.terminal_cleanup_failed', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      error: 'Task was cancelled, but runtime cleanup failed. Retry cleanup from the task page.',
    };
  }

  log.info('sam.stop_subtask.completed', { taskId, previousStatus: task.status });

  return {
    stopped: true,
    taskId,
    previousStatus: task.status,
    message: `Task '${task.title || taskId}' has been stopped.`,
  };
}
