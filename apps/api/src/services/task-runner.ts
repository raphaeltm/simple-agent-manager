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
 *
 * TDF-7: Enhanced cleanup idempotency — safe to call multiple times with
 * no side effects. Checks workspace/node state before taking action.
 */

import { DEFAULT_TASK_RUN_CLEANUP_DELAY_MS } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { stopComputeTracking } from './compute-usage';
import { stopWorkspaceOnNode } from './node-agent';
import * as nodeLifecycleService from './node-lifecycle';
import { stopNodeResources } from './nodes';
import {
  claimWorkspaceForCleanup,
  completeWorkspaceCleanupClaim,
  hasAuthorizedWorkspaceSessionLink,
  restoreWorkspaceCleanupClaim,
} from './workspace-cleanup-authorization';

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
 *
 * TDF-7: Fully idempotent — safe to call multiple times. Checks workspace
 * and node state before taking action. No side effects on repeated calls.
 */
export async function cleanupTaskRun(
  taskId: string,
  env: Env,
  warmTimeoutOverrideMs?: number | null,
  requiredUserId?: string,
  requiredProjectId?: string
): Promise<void> {
  const db = drizzle(env.DATABASE, { schema });
  const cleanupDelay = getCleanupDelayMs(env);

  // Wait a bit for any final writes
  if (cleanupDelay > 0) {
    await new Promise((resolve) => setTimeout(resolve, cleanupDelay));
  }

  const taskConditions = [eq(schema.tasks.id, taskId)];
  if (requiredProjectId) {
    taskConditions.push(eq(schema.tasks.projectId, requiredProjectId));
  }

  const [task] = await db
    .select({
      id: schema.tasks.id,
      projectId: schema.tasks.projectId,
      userId: schema.tasks.userId,
      chatSessionId: schema.tasks.chatSessionId,
      workspaceId: schema.tasks.workspaceId,
      taskMode: schema.tasks.taskMode,
      autoProvisionedNodeId: schema.tasks.autoProvisionedNodeId,
    })
    .from(schema.tasks)
    .where(and(...taskConditions))
    .limit(1);

  if (!task || (requiredProjectId && task.projectId !== requiredProjectId) || !task.workspaceId) {
    return;
  }

  const workspaceConditions = [
    eq(schema.workspaces.id, task.workspaceId),
    eq(schema.workspaces.projectId, task.projectId),
  ];
  if (requiredUserId) {
    workspaceConditions.push(eq(schema.workspaces.userId, requiredUserId));
  }

  const [workspace] = await db
    .select({
      id: schema.workspaces.id,
      nodeId: schema.workspaces.nodeId,
      userId: schema.workspaces.userId,
      projectId: schema.workspaces.projectId,
      chatSessionId: schema.workspaces.chatSessionId,
      status: schema.workspaces.status,
    })
    .from(schema.workspaces)
    .where(and(...workspaceConditions))
    .limit(1);

  if (
    !workspace ||
    workspace.id !== task.workspaceId ||
    workspace.projectId !== task.projectId ||
    (requiredUserId && workspace.userId !== requiredUserId) ||
    !hasAuthorizedWorkspaceSessionLink(
      task.chatSessionId,
      workspace.chatSessionId,
      task.taskMode,
      task.userId,
      workspace.userId,
      requiredUserId !== undefined
    )
  ) {
    if (requiredUserId) {
      log.info('task_run.cleanup.skipped_owner_mismatch', {
        taskId,
        workspaceId: task.workspaceId,
        requiredProjectId: task.projectId,
        requiredUserId,
        action: 'skipped',
      });
    } else {
      log.info('task_run.cleanup.skipped_workspace_scope_mismatch', {
        taskId,
        workspaceId: task.workspaceId,
        requiredProjectId: task.projectId,
        action: 'skipped',
      });
    }
    return;
  }

  if (!workspace.nodeId) {
    return;
  }

  // Fall back to the WORKSPACE owner, not the task creator. Now that task lifecycle routes are
  // project-scoped, a member can run or be delegated another member's task, so the workspace/node
  // belong to the runner while `task.userId` stays the original creator. Internal callers (VM-agent
  // status callback, TaskRunner DO, stuck-task cron) pass no requiredUserId; using the creator there
  // makes the node lookup below miss, which silently misclassifies a cf-container as a VM and leaves
  // the container running while D1 records the workspace as stopped.
  // When requiredUserId IS supplied, the workspace WHERE clause above already guarantees
  // workspace.userId === requiredUserId, so this is a no-op for the caller-scoped paths.
  const cleanupUserId = requiredUserId ?? workspace.userId;

  log.info('task_run.cleanup.started', {
    taskId,
    workspaceId: task.workspaceId,
    nodeId: workspace.nodeId,
  });

  const [node] = await db
    .select({
      id: schema.nodes.id,
      runtime: schema.nodes.runtime,
      userId: schema.nodes.userId,
    })
    .from(schema.nodes)
    .where(and(eq(schema.nodes.id, workspace.nodeId), eq(schema.nodes.userId, cleanupUserId)))
    .limit(1);

  if (!node || node.userId !== cleanupUserId) {
    log.warn('task_run.cleanup.node_scope_rejected', {
      taskId,
      workspaceId: workspace.id,
      nodeId: workspace.nodeId,
      cleanupUserId,
      action: 'skipped',
    });
    return;
  }

  const allowedClaimStatuses =
    node.runtime === 'cf-container'
      ? ['running', 'creating', 'pending', 'recovery', 'sleeping', 'stopped']
      : ['running', 'creating', 'pending', 'recovery'];
  const claim = await claimWorkspaceForCleanup(env, {
    workspaceId: workspace.id,
    nodeId: workspace.nodeId,
    userId: cleanupUserId,
    projectId: workspace.projectId,
    allowedStatuses: allowedClaimStatuses,
    taskId,
    source: 'task_run.cleanup',
  });

  if (!claim) {
    return;
  }

  if (node?.runtime === 'cf-container') {
    try {
      const sibling = await env.DATABASE.prepare(
        `SELECT id FROM workspaces
         WHERE node_id = ? AND id != ? AND status != 'deleted'
         LIMIT 1`
      )
        .bind(workspace.nodeId, workspace.id)
        .first<{ id: string }>();
      if (sibling) {
        await restoreWorkspaceCleanupClaim(env, claim);
        log.warn('task_run.cleanup.cf_container_sibling_workspace_rejected', {
          taskId,
          workspaceId: workspace.id,
          nodeId: workspace.nodeId,
          siblingWorkspaceId: sibling.id,
          action: 'skipped',
        });
        return;
      }

      await stopNodeResources(workspace.nodeId, cleanupUserId, env);
      await completeWorkspaceCleanupClaim(env, claim, 'deleted');
      await stopComputeTracking(db, workspace.id);
      log.info('task_run.cleanup.cf_container_destroyed', {
        taskId,
        workspaceId: workspace.id,
        nodeId: workspace.nodeId,
      });
      return;
    } catch (err) {
      await restoreWorkspaceCleanupClaim(
        env,
        claim,
        err instanceof Error ? err.message : String(err)
      );
      throw err;
    }
  }

  // Stop the workspace (idempotent: only if still running/recovery)
  try {
    await stopWorkspaceOnNode(workspace.nodeId, workspace.id, env, cleanupUserId);
    await completeWorkspaceCleanupClaim(env, claim, 'stopped');
    await stopComputeTracking(db, workspace.id);
  } catch (err) {
    log.error('task_run.cleanup.workspace_stop_failed', {
      taskId,
      workspaceId: workspace.id,
      nodeId: workspace.nodeId,
      error: err instanceof Error ? err.message : String(err),
    });
    await restoreWorkspaceCleanupClaim(
      env,
      claim,
      err instanceof Error ? err.message : String(err)
    );
    return;
  }

  // Schedule automatic deletion after TTL (best-effort)
  try {
    const doId = env.NODE_LIFECYCLE.idFromName(workspace.nodeId);
    const stub = env.NODE_LIFECYCLE.get(doId);
    await (
      stub as unknown as import('../durable-objects/node-lifecycle').NodeLifecycle
    ).scheduleWorkspaceDeletion(workspace.id, cleanupUserId);
  } catch (e) {
    log.warn('task_run.cleanup.schedule_deletion_failed', {
      taskId,
      workspaceId: workspace.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // If node was auto-provisioned for this task, check if it can be cleaned up
  if (task.autoProvisionedNodeId) {
    await cleanupAutoProvisionedNode(
      db,
      task.autoProvisionedNodeId,
      cleanupUserId,
      workspace.id,
      env,
      warmTimeoutOverrideMs
    );
  }
}

/**
 * Check if an auto-provisioned node has no other active workspaces.
 * If empty, marks the node as warm (idle) via the NodeLifecycle DO
 * so it stays available for fast reuse. The DO alarm handles eventual
 * teardown if not reclaimed within the warm timeout.
 *
 * TDF-7: Idempotent — checks if node is already warm or stopped before
 * calling markIdle. Running cleanup twice produces no side effects.
 */
async function cleanupAutoProvisionedNode(
  db: ReturnType<typeof drizzle<typeof schema>>,
  nodeId: string,
  userId: string,
  excludeWorkspaceId: string | null,
  env: Env,
  warmTimeoutOverrideMs?: number | null
): Promise<void> {
  // Check current node state first (TDF-7: idempotency guard)
  const [node] = await db
    .select({ id: schema.nodes.id, status: schema.nodes.status, warmSince: schema.nodes.warmSince })
    .from(schema.nodes)
    .where(eq(schema.nodes.id, nodeId))
    .limit(1);

  if (!node) {
    log.info('task_run.cleanup.node_not_found', { nodeId });
    return;
  }

  // Already stopped or deleted — nothing to do
  if (node.status === 'stopped' || node.status === 'deleted') {
    log.info('task_run.cleanup.node_already_stopped', { nodeId, status: node.status });
    return;
  }

  // Already warm — don't re-mark (would reset alarm timer)
  if (node.warmSince) {
    log.info('task_run.cleanup.node_already_warm', { nodeId, warmSince: node.warmSince });
    return;
  }

  // Count active workspaces on this node (excluding the one we're cleaning up)
  const workspaces = await db
    .select({ id: schema.workspaces.id, status: schema.workspaces.status })
    .from(schema.workspaces)
    .where(and(eq(schema.workspaces.nodeId, nodeId), eq(schema.workspaces.userId, userId)));

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
    await nodeLifecycleService.markIdle(env, nodeId, userId, warmTimeoutOverrideMs);
    log.info('task_run.cleanup.node_marked_warm', { nodeId, userId, warmTimeoutOverrideMs });
  } catch (err) {
    log.error('task_run.cleanup.mark_idle_failed', {
      nodeId,
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
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
