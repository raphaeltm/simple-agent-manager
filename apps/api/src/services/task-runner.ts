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
import { stopWorkspaceOnNode } from './node-agent';
import { handOffEmptyWorkspaceNode } from './node-warm-handoff';
import { stopNodeResources } from './nodes';
import { sleptFallbackRecord } from './session-sleep-episode';
import { finalizeWorkspaceLifecycleClosure } from './workspace-lifecycle-finalizer';

function getCleanupDelayMs(env: Env): number {
  const value = env.TASK_RUN_CLEANUP_DELAY_MS;
  const parsed = value ? Number.parseInt(value, 10) : DEFAULT_TASK_RUN_CLEANUP_DELAY_MS;
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_TASK_RUN_CLEANUP_DELAY_MS;
  }
  return parsed;
}

/**
 * Clean up a workspace after task completion and hand its node to NodeLifecycle when the
 * node is left empty. Called when a task run finishes (either success or failure).
 *
 * TDF-7: Fully idempotent — safe to call multiple times. Checks workspace
 * and node state before taking action. No side effects on repeated calls.
 */
export async function cleanupTaskRun(
  taskId: string,
  env: Env,
  warmTimeoutOverrideMs?: number | null,
  requiredUserId?: string
): Promise<void> {
  const db = drizzle(env.DATABASE, { schema });
  const cleanupDelay = getCleanupDelayMs(env);

  // Wait a bit for any final writes
  if (cleanupDelay > 0) {
    await new Promise((resolve) => setTimeout(resolve, cleanupDelay));
  }

  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).limit(1);

  if (!task || !task.workspaceId) {
    return;
  }

  const workspaceConditions = [eq(schema.workspaces.id, task.workspaceId)];
  if (requiredUserId) {
    workspaceConditions.push(eq(schema.workspaces.userId, requiredUserId));
  }

  const [workspace] = await db
    .select()
    .from(schema.workspaces)
    .where(and(...workspaceConditions))
    .limit(1);

  if (!workspace || !workspace.nodeId) {
    if (requiredUserId) {
      log.info('task_run.cleanup.skipped_owner_mismatch', {
        taskId,
        workspaceId: task.workspaceId,
        requiredUserId,
        action: 'skipped',
      });
    }
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
    })
    .from(schema.nodes)
    .where(and(eq(schema.nodes.id, workspace.nodeId), eq(schema.nodes.userId, cleanupUserId)))
    .limit(1);

  if (node?.runtime === 'cf-container') {
    const [snapshot] = workspace.chatSessionId
      ? await db
          .select({
            status: schema.sessionSnapshots.status,
            degradation: schema.sessionSnapshots.degradation,
            expiresAt: schema.sessionSnapshots.expiresAt,
            sleepStatus: schema.sessionSnapshots.sleepStatus,
            sleepingAt: schema.sessionSnapshots.sleepingAt,
            sleepFallbackJson: schema.sessionSnapshots.sleepFallbackJson,
            snapshotGeneration: schema.sessionSnapshots.snapshotGeneration,
            workspaceId: schema.sessionSnapshots.workspaceId,
            nodeId: schema.sessionSnapshots.nodeId,
            userId: schema.sessionSnapshots.userId,
            projectId: schema.sessionSnapshots.projectId,
          })
          .from(schema.sessionSnapshots)
          .where(eq(schema.sessionSnapshots.chatSessionId, workspace.chatSessionId))
          .limit(1)
      : [];
    const preserveSleepingSnapshot =
      workspace.status === 'sleeping' &&
      snapshot &&
      Date.parse(snapshot.expiresAt) > Date.now() &&
      ((snapshot.status === 'available' && snapshot.degradation === 'none') ||
        // A committed bounded fallback has already stopped paid compute. Keep
        // its logical Instant identity so a message can start fresh from the
        // transcript. A stopping/unconfirmed or replaced runtime is not proof.
        (snapshot.sleepStatus === 'sleeping' &&
          snapshot.sleepingAt !== null &&
          snapshot.workspaceId === workspace.id &&
          snapshot.nodeId === workspace.nodeId &&
          snapshot.userId === workspace.userId &&
          snapshot.projectId === workspace.projectId &&
          Boolean(sleptFallbackRecord(snapshot))));
    if (preserveSleepingSnapshot) {
      log.info('task_run.cleanup.cf_container_sleep_preserved', {
        taskId,
        workspaceId: workspace.id,
        nodeId: workspace.nodeId,
        snapshotExpiresAt: snapshot.expiresAt,
      });
      return;
    }
    await stopNodeResources(workspace.nodeId, cleanupUserId, env);
    log.info('task_run.cleanup.cf_container_destroyed', {
      taskId,
      workspaceId: workspace.id,
      nodeId: workspace.nodeId,
    });
    return;
  }

  // Stop the workspace (idempotent: only if still running/recovery)
  if (workspace.status === 'running' || workspace.status === 'recovery') {
    try {
      await stopWorkspaceOnNode(workspace.nodeId, workspace.id, env, cleanupUserId);
    } catch (err) {
      log.error('task_run.cleanup.workspace_stop_failed', {
        taskId,
        workspaceId: workspace.id,
        nodeId: workspace.nodeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const stoppedAt = new Date().toISOString();
    await db
      .update(schema.workspaces)
      .set({ status: 'stopped', updatedAt: stoppedAt })
      .where(eq(schema.workspaces.id, workspace.id));
    await finalizeWorkspaceLifecycleClosure(env, {
      workspaceIds: [workspace.id],
      userId: cleanupUserId,
      agentSessionStatus: 'completed',
      nowIso: stoppedAt,
      reason: 'task_run_cleanup_workspace_stopped',
    });
  } else {
    log.info('task_run.cleanup.workspace_already_stopped', {
      taskId,
      workspaceId: workspace.id,
      currentStatus: workspace.status,
    });
  }

  // Schedule automatic deletion after TTL (best-effort)
  if (
    workspace.nodeId &&
    (workspace.status === 'running' ||
      workspace.status === 'recovery' ||
      workspace.status === 'sleeping' ||
      workspace.status === 'stopped')
  ) {
    try {
      const doId = env.NODE_LIFECYCLE.idFromName(workspace.nodeId);
      const stub = env.NODE_LIFECYCLE.get(doId);
      await (
        stub as unknown as import('../durable-objects/node-lifecycle').NodeLifecycle
      ).scheduleWorkspaceDeletion(workspace.nodeId, workspace.id, cleanupUserId);
    } catch (e) {
      log.warn('task_run.cleanup.schedule_deletion_failed', {
        taskId,
        workspaceId: workspace.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Hand the node to NodeLifecycle once this was its last live workspace. Key on the node the
  // workspace ran on: a task pack-placed onto an existing pool node never records
  // autoProvisionedNodeId, and a woken conversation clears it (reactivateSleepingTask), so
  // gating on that pointer left healthy nodes running empty with no teardown path. A
  // provisioning pointer naming a different node is handed off too.
  const handoffNodeIds = new Set([workspace.nodeId]);
  if (task.autoProvisionedNodeId) handoffNodeIds.add(task.autoProvisionedNodeId);
  for (const nodeId of handoffNodeIds) {
    await handOffEmptyWorkspaceNode(env, {
      nodeId,
      expectedUserId: cleanupUserId,
      sourceProjectId: workspace.projectId,
      warmTimeoutOverrideMs,
      reason: 'task_run_cleanup',
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
