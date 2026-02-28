/**
 * Stuck Task Recovery — detects and fails tasks stuck in transient states.
 *
 * Checks for tasks in 'queued', 'delegated', or 'in_progress' that have been
 * in that state longer than their configured timeout. Transitions them to 'failed'
 * with a descriptive error message including the execution step where they stalled.
 *
 * Called from the cron handler alongside node cleanup.
 *
 * TDF-2 compatibility: The TaskRunner DO manages orchestration via alarms and
 * updates `execution_step` + `updated_at` on each step progression in D1.
 * This cron serves as the outer safety net — if the DO dies or its alarms
 * stop firing, the task's `updated_at` will eventually exceed the timeout
 * thresholds and the cron will fail it. The DO uses optimistic locking
 * (`WHERE status = X`) to detect cron intervention and abort gracefully.
 *
 * TDF-7: Enhanced with OBSERVABILITY_DATABASE recording, diagnostic context
 * capture (workspace/node status at recovery time), and TaskRunner DO health
 * checks for post-TDF-2 defense-in-depth.
 */
import { drizzle } from 'drizzle-orm/d1';
import {
  DEFAULT_TASK_STUCK_QUEUED_TIMEOUT_MS,
  DEFAULT_TASK_STUCK_DELEGATED_TIMEOUT_MS,
  DEFAULT_TASK_RUN_MAX_EXECUTION_MS,
} from '@simple-agent-manager/shared';
import type { Env } from '../index';
import * as schema from '../db/schema';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { cleanupTaskRun } from '../services/task-runner';
import { persistError } from '../services/observability';
import type { TaskRunner } from '../durable-objects/task-runner';

function parseMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/** Human-readable descriptions for execution steps */
const STEP_DESCRIPTIONS: Record<string, string> = {
  node_selection: 'selecting a node',
  node_provisioning: 'provisioning a new node',
  node_agent_ready: 'waiting for node agent to start',
  workspace_creation: 'creating workspace on node',
  workspace_ready: 'waiting for workspace to become ready',
  agent_session: 'creating agent session',
  running: 'running (agent active)',
};

function describeStep(step: string | null): string {
  if (!step) return '';
  return STEP_DESCRIPTIONS[step] ?? step;
}

export interface StuckTaskResult {
  failedQueued: number;
  failedDelegated: number;
  failedInProgress: number;
  doHealthChecked: number;
  errors: number;
}

/**
 * Diagnostic context captured at recovery time for a stuck task.
 * Recorded in the OBSERVABILITY_DATABASE to enable post-mortem analysis
 * without manual investigation.
 */
export interface RecoveryDiagnostics {
  taskId: string;
  taskStatus: string;
  executionStep: string | null;
  elapsedMs: number;
  reason: string;
  workspaceId: string | null;
  workspaceStatus: string | null;
  nodeId: string | null;
  nodeStatus: string | null;
  nodeHealthStatus: string | null;
  autoProvisionedNodeId: string | null;
  doState: {
    exists: boolean;
    completed: boolean | null;
    currentStep: string | null;
    retryCount: number | null;
    lastStepAt: number | null;
  } | null;
}

/**
 * Query diagnostic context for a stuck task — workspace status, node status,
 * and TaskRunner DO state. Best-effort: returns whatever context is available.
 */
export async function gatherDiagnostics(
  env: Env,
  task: {
    id: string;
    status: string;
    execution_step: string | null;
    workspace_id: string | null;
    auto_provisioned_node_id: string | null;
  },
  elapsedMs: number,
  reason: string
): Promise<RecoveryDiagnostics> {
  const diagnostics: RecoveryDiagnostics = {
    taskId: task.id,
    taskStatus: task.status,
    executionStep: task.execution_step,
    elapsedMs,
    reason,
    workspaceId: task.workspace_id,
    workspaceStatus: null,
    nodeId: null,
    nodeStatus: null,
    nodeHealthStatus: null,
    autoProvisionedNodeId: task.auto_provisioned_node_id,
    doState: null,
  };

  // Query workspace status
  if (task.workspace_id) {
    try {
      const wsResult = await env.DATABASE.prepare(
        `SELECT id, node_id, status FROM workspaces WHERE id = ?`
      ).bind(task.workspace_id).first<{ id: string; node_id: string | null; status: string }>();

      if (wsResult) {
        diagnostics.workspaceStatus = wsResult.status;
        diagnostics.nodeId = wsResult.node_id;
      }
    } catch {
      // Best-effort
    }
  }

  // Query node status (use workspace's node if available, else auto-provisioned node)
  const nodeIdToCheck = diagnostics.nodeId ?? task.auto_provisioned_node_id;
  if (nodeIdToCheck) {
    try {
      const nodeResult = await env.DATABASE.prepare(
        `SELECT id, status, health_status FROM nodes WHERE id = ?`
      ).bind(nodeIdToCheck).first<{ id: string; status: string; health_status: string | null }>();

      if (nodeResult) {
        diagnostics.nodeId = nodeResult.id;
        diagnostics.nodeStatus = nodeResult.status;
        diagnostics.nodeHealthStatus = nodeResult.health_status;
      }
    } catch {
      // Best-effort
    }
  }

  // Query TaskRunner DO state
  try {
    const doId = env.TASK_RUNNER.idFromName(task.id);
    const stub = env.TASK_RUNNER.get(doId) as DurableObjectStub<TaskRunner>;
    const doStatus = await stub.getStatus();

    diagnostics.doState = {
      exists: doStatus !== null,
      completed: doStatus?.completed ?? null,
      currentStep: doStatus?.currentStep ?? null,
      retryCount: doStatus?.retryCount ?? null,
      lastStepAt: doStatus?.lastStepAt ?? null,
    };
  } catch {
    // DO may not exist or may be unreachable
    diagnostics.doState = { exists: false, completed: null, currentStep: null, retryCount: null, lastStepAt: null };
  }

  return diagnostics;
}

export async function recoverStuckTasks(env: Env): Promise<StuckTaskResult> {
  const now = new Date();
  const result: StuckTaskResult = {
    failedQueued: 0,
    failedDelegated: 0,
    failedInProgress: 0,
    doHealthChecked: 0,
    errors: 0,
  };

  const queuedTimeoutMs = parseMs(env.TASK_STUCK_QUEUED_TIMEOUT_MS, DEFAULT_TASK_STUCK_QUEUED_TIMEOUT_MS);
  const delegatedTimeoutMs = parseMs(env.TASK_STUCK_DELEGATED_TIMEOUT_MS, DEFAULT_TASK_STUCK_DELEGATED_TIMEOUT_MS);
  const maxExecutionMs = parseMs(env.TASK_RUN_MAX_EXECUTION_MS, DEFAULT_TASK_RUN_MAX_EXECUTION_MS);

  // Find stuck tasks via raw SQL — include workspace_id and auto_provisioned_node_id
  // for diagnostic context capture.
  const stuckTasks = await env.DATABASE.prepare(
    `SELECT id, project_id, user_id, status, execution_step, updated_at, started_at,
            workspace_id, auto_provisioned_node_id
     FROM tasks
     WHERE status IN ('queued', 'delegated', 'in_progress')
     ORDER BY updated_at ASC`
  ).all<{
    id: string;
    project_id: string;
    user_id: string;
    status: string;
    execution_step: string | null;
    updated_at: string;
    started_at: string | null;
    workspace_id: string | null;
    auto_provisioned_node_id: string | null;
  }>();

  const db = drizzle(env.DATABASE, { schema });

  for (const task of stuckTasks.results) {
    const updatedAt = new Date(task.updated_at).getTime();
    const elapsedMs = now.getTime() - updatedAt;
    let isStuck = false;
    let reason = '';

    const stepInfo = task.execution_step
      ? ` Last step: ${describeStep(task.execution_step)}.`
      : '';

    switch (task.status) {
      case 'queued':
        if (elapsedMs > queuedTimeoutMs) {
          isStuck = true;
          reason = `Task stuck in 'queued' for ${Math.round(elapsedMs / 1000)}s (threshold: ${Math.round(queuedTimeoutMs / 1000)}s).${stepInfo} Node provisioning may have failed silently.`;
        }
        break;
      case 'delegated':
        if (elapsedMs > delegatedTimeoutMs) {
          isStuck = true;
          reason = `Task stuck in 'delegated' for ${Math.round(elapsedMs / 1000)}s (threshold: ${Math.round(delegatedTimeoutMs / 1000)}s).${stepInfo} Workspace may have failed to start.`;
        }
        break;
      case 'in_progress': {
        const startedAt = task.started_at ? new Date(task.started_at).getTime() : updatedAt;
        const executionMs = now.getTime() - startedAt;
        if (executionMs > maxExecutionMs) {
          isStuck = true;
          reason = `Task exceeded max execution time of ${Math.round(maxExecutionMs / 60000)} minutes.${stepInfo}`;
        }
        break;
      }
    }

    // For non-stuck tasks, check DO health as defense-in-depth (TDF-7).
    // If the task has been sitting for at least half its threshold time,
    // proactively verify the DO is still alive and making progress.
    if (!isStuck) {
      const halfThreshold = task.status === 'queued' ? queuedTimeoutMs / 2
        : task.status === 'delegated' ? delegatedTimeoutMs / 2
        : maxExecutionMs / 2;

      if (elapsedMs > halfThreshold) {
        try {
          const doId = env.TASK_RUNNER.idFromName(task.id);
          const stub = env.TASK_RUNNER.get(doId) as DurableObjectStub<TaskRunner>;
          const doStatus = await stub.getStatus();

          if (doStatus && doStatus.completed && task.status !== 'failed' && task.status !== 'completed') {
            // DO thinks it's done but D1 status is still transient — log for investigation
            log.warn('stuck_task.do_completed_but_task_active', {
              taskId: task.id,
              taskStatus: task.status,
              doCurrentStep: doStatus.currentStep,
              doRetryCount: doStatus.retryCount,
            });

            await persistError(env.OBSERVABILITY_DATABASE, {
              source: 'api',
              level: 'warn',
              message: `TaskRunner DO completed but task still in '${task.status}' — possible D1 update failure`,
              context: {
                recoveryType: 'do_task_status_mismatch',
                taskId: task.id,
                taskStatus: task.status,
                executionStep: task.execution_step,
                doCurrentStep: doStatus.currentStep,
                doRetryCount: doStatus.retryCount,
                elapsedMs,
              },
              userId: task.user_id,
            });
          }

          result.doHealthChecked++;
        } catch {
          // DO unreachable — not necessarily an error (may not have been created yet)
        }
      }
      continue;
    }

    try {
      // Gather diagnostic context before recovery
      const diagnostics = await gatherDiagnostics(env, task, elapsedMs, reason);

      log.warn('stuck_task.recovering', {
        taskId: task.id,
        projectId: task.project_id,
        userId: task.user_id,
        status: task.status,
        executionStep: task.execution_step,
        elapsedMs,
        reason,
        workspaceStatus: diagnostics.workspaceStatus,
        nodeStatus: diagnostics.nodeStatus,
        doState: diagnostics.doState,
      });

      // Record recovery in OBSERVABILITY_DATABASE for admin visibility (TDF-7)
      await persistError(env.OBSERVABILITY_DATABASE, {
        source: 'api',
        level: 'warn',
        message: reason,
        context: {
          recoveryType: 'stuck_task',
          taskStatus: task.status,
          executionStep: task.execution_step,
          elapsedMs,
          workspaceId: diagnostics.workspaceId,
          workspaceStatus: diagnostics.workspaceStatus,
          nodeId: diagnostics.nodeId,
          nodeStatus: diagnostics.nodeStatus,
          nodeHealthStatus: diagnostics.nodeHealthStatus,
          autoProvisionedNodeId: diagnostics.autoProvisionedNodeId,
          doState: diagnostics.doState,
        },
        userId: task.user_id,
        nodeId: diagnostics.nodeId,
        workspaceId: diagnostics.workspaceId,
      });

      const nowIso = now.toISOString();
      // Use optimistic locking: only fail the task if it's still in the
      // same status we observed. This prevents TOCTOU races with the
      // TaskRunner DO which may have advanced the task in between our
      // SELECT and this UPDATE.
      const updateResult = await env.DATABASE.prepare(
        `UPDATE tasks SET status = 'failed', execution_step = NULL, error_message = ?, completed_at = ?, updated_at = ?
         WHERE id = ? AND status = ?`
      ).bind(reason, nowIso, nowIso, task.id, task.status).run();

      if (!updateResult.meta.changes || updateResult.meta.changes === 0) {
        // Task was advanced by the DO between our SELECT and UPDATE — skip
        log.info('stuck_task.skipped_optimistic_lock', {
          taskId: task.id,
          expectedStatus: task.status,
        });
        continue;
      }

      await db.insert(schema.taskStatusEvents).values({
        id: ulid(),
        taskId: task.id,
        fromStatus: task.status as 'queued' | 'delegated' | 'in_progress',
        toStatus: 'failed',
        actorType: 'system',
        actorId: null,
        reason,
        createdAt: nowIso,
      });

      // Best-effort cleanup: stop workspace and mark auto-provisioned node as warm.
      // cleanupTaskRun reads the task's workspaceId and autoProvisionedNodeId from DB.
      try {
        await cleanupTaskRun(task.id, env);
      } catch (cleanupErr) {
        log.error('stuck_task.cleanup_failed', {
          taskId: task.id,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });

        // Record cleanup failure in OBSERVABILITY_DATABASE (TDF-7)
        await persistError(env.OBSERVABILITY_DATABASE, {
          source: 'api',
          level: 'error',
          message: `Stuck task cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          stack: cleanupErr instanceof Error ? cleanupErr.stack : undefined,
          context: {
            recoveryType: 'stuck_task_cleanup_failure',
            taskId: task.id,
            taskStatus: task.status,
            executionStep: task.execution_step,
          },
          userId: task.user_id,
          nodeId: diagnostics.nodeId,
          workspaceId: diagnostics.workspaceId,
        });
      }

      switch (task.status) {
        case 'queued': result.failedQueued++; break;
        case 'delegated': result.failedDelegated++; break;
        case 'in_progress': result.failedInProgress++; break;
      }
    } catch (err) {
      log.error('stuck_task.recovery_failed', {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });

      // Record recovery failure in OBSERVABILITY_DATABASE (TDF-7)
      await persistError(env.OBSERVABILITY_DATABASE, {
        source: 'api',
        level: 'error',
        message: `Stuck task recovery failed: ${err instanceof Error ? err.message : String(err)}`,
        stack: err instanceof Error ? err.stack : undefined,
        context: {
          recoveryType: 'stuck_task_recovery_failure',
          taskId: task.id,
          taskStatus: task.status,
          executionStep: task.execution_step,
        },
        userId: task.user_id,
      });

      result.errors++;
    }
  }

  return result;
}
