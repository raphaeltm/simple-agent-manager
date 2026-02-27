/**
 * Task Runner Service — cleanup and error types.
 *
 * TDF-2: The orchestration logic that was previously in `executeTaskRun()`
 * and `initiateTaskRun()` has been moved to the TaskRunner Durable Object
 * (`src/durable-objects/task-runner.ts`). This file retains only:
 *
 * - `cleanupTaskRun()` — workspace/node cleanup after task completion
 * - `TaskRunError` — typed error class for task run failures
 *
 * These are still used by:
 * - Task callback routes (tasks.ts — on task completion)
 * - Task run routes (task-runs.ts — manual cleanup endpoint)
 * - Stuck-task cron (stuck-tasks.ts — recovery cleanup)
 * - TaskRunner DO (task-runner.ts — failure cleanup)
 */

import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { DEFAULT_TASK_RUN_CLEANUP_DELAY_MS } from '@simple-agent-manager/shared';
import type { Env } from '../index';
import * as schema from '../db/schema';
import { log } from '../lib/logger';
import { stopWorkspaceOnNode } from './node-agent';
import * as nodeLifecycleService from './node-lifecycle';

function getCleanupDelayMs(env: Env): number {
  const value = env.TASK_RUN_CLEANUP_DELAY_MS;
  const parsed = value ? Number.parseInt(value, 10) : DEFAULT_TASK_RUN_CLEANUP_DELAY_MS;
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_TASK_RUN_CLEANUP_DELAY_MS;
  }
  return parsed;
}

/**
 * Clean up a workspace and optionally its auto-provisioned node after task completion.
 * Called when a task run finishes (either success or failure).
 */
export async function cleanupTaskRun(
  taskId: string,
  env: Env
): Promise<void> {
  const db = drizzle(env.DATABASE, { schema });
  const cleanupDelay = getCleanupDelayMs(env);

  // Wait a bit for any final writes
  if (cleanupDelay > 0) {
    await new Promise((resolve) => setTimeout(resolve, cleanupDelay));
  }

  const [task] = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .limit(1);

  if (!task || !task.workspaceId) {
    return;
  }

  const [workspace] = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, task.workspaceId))
    .limit(1);

  if (!workspace || !workspace.nodeId) {
    return;
  }

  log.info('task_run.cleanup.started', { taskId, workspaceId: task.workspaceId, nodeId: workspace.nodeId });

  // Stop the workspace
  if (workspace.status === 'running' || workspace.status === 'recovery') {
    try {
      await stopWorkspaceOnNode(workspace.nodeId, workspace.id, env, task.userId);
    } catch (err) {
      log.error('task_run.cleanup.workspace_stop_failed', {
        taskId,
        workspaceId: workspace.id,
        nodeId: workspace.nodeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await db
      .update(schema.workspaces)
      .set({ status: 'stopped', updatedAt: new Date().toISOString() })
      .where(eq(schema.workspaces.id, workspace.id));
  }

  // If node was auto-provisioned for this task, check if it can be cleaned up
  if (task.autoProvisionedNodeId) {
    await cleanupAutoProvisionedNode(
      db,
      task.autoProvisionedNodeId,
      task.userId,
      workspace.id,
      env
    );
  }
}

/**
 * Check if an auto-provisioned node has no other active workspaces.
 * If empty, marks the node as warm (idle) via the NodeLifecycle DO
 * so it stays available for fast reuse. The DO alarm handles eventual
 * teardown if not reclaimed within the warm timeout.
 */
async function cleanupAutoProvisionedNode(
  db: ReturnType<typeof drizzle<typeof schema>>,
  nodeId: string,
  userId: string,
  excludeWorkspaceId: string | null,
  env: Env
): Promise<void> {
  // Count active workspaces on this node (excluding the one we're cleaning up)
  const workspaces = await db
    .select({ id: schema.workspaces.id, status: schema.workspaces.status })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.nodeId, nodeId),
        eq(schema.workspaces.userId, userId)
      )
    );

  const activeWorkspaces = workspaces.filter(
    (ws) =>
      ws.id !== excludeWorkspaceId &&
      (ws.status === 'running' || ws.status === 'creating' || ws.status === 'recovery')
  );

  if (activeWorkspaces.length > 0) {
    // Other workspaces still running, don't mark idle
    return;
  }

  // No active workspaces — mark node as warm for reuse.
  // The NodeLifecycle DO will schedule an alarm for eventual teardown.
  try {
    await nodeLifecycleService.markIdle(env, nodeId, userId);
    log.info('task_run.cleanup.node_marked_warm', { nodeId, userId });
  } catch (err) {
    log.error('task_run.cleanup.mark_idle_failed', {
      nodeId,
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Fallback: stop node directly if DO fails
    try {
      const { stopNodeResources } = await import('./nodes');
      await stopNodeResources(nodeId, userId, env);
      log.info('task_run.cleanup.node_stopped_fallback', { nodeId, userId });
    } catch (stopErr) {
      // Both markIdle and fallback stop failed — log for cron sweep to catch
      log.error('task_run.cleanup.node_cleanup_total_failure', {
        nodeId,
        userId,
        markIdleError: err instanceof Error ? err.message : String(err),
        stopError: stopErr instanceof Error ? stopErr.message : String(stopErr),
      });
    }
  }
}

/**
 * Typed error for task run failures.
 */
export class TaskRunError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'NOT_FOUND'
      | 'INVALID_STATUS'
      | 'NODE_UNAVAILABLE'
      | 'LIMIT_EXCEEDED'
      | 'PROVISION_FAILED'
      | 'WORKSPACE_CREATION_FAILED'
      | 'WORKSPACE_LOST'
      | 'WORKSPACE_STOPPED'
      | 'WORKSPACE_TIMEOUT'
      | 'EXECUTION_FAILED'
  ) {
    super(message);
    this.name = 'TaskRunError';
  }
}
