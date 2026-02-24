/**
 * Stuck Task Recovery — detects and fails tasks stuck in transient states.
 *
 * Checks for tasks in 'queued', 'delegated', or 'in_progress' that have been
 * in that state longer than their configured timeout. Transitions them to 'failed'
 * with a descriptive error message including the execution step where they stalled.
 *
 * Called from the cron handler alongside node cleanup.
 */
import { eq } from 'drizzle-orm';
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
  errors: number;
}

export async function recoverStuckTasks(env: Env): Promise<StuckTaskResult> {
  const now = new Date();
  const result: StuckTaskResult = { failedQueued: 0, failedDelegated: 0, failedInProgress: 0, errors: 0 };

  const queuedTimeoutMs = parseMs(env.TASK_STUCK_QUEUED_TIMEOUT_MS, DEFAULT_TASK_STUCK_QUEUED_TIMEOUT_MS);
  const delegatedTimeoutMs = parseMs(env.TASK_STUCK_DELEGATED_TIMEOUT_MS, DEFAULT_TASK_STUCK_DELEGATED_TIMEOUT_MS);
  const maxExecutionMs = parseMs(env.TASK_RUN_MAX_EXECUTION_MS, DEFAULT_TASK_RUN_MAX_EXECUTION_MS);

  // Find stuck tasks via raw SQL (more efficient than Drizzle for multi-status queries)
  const stuckTasks = await env.DATABASE.prepare(
    `SELECT id, project_id, user_id, status, execution_step, updated_at, started_at
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

    if (!isStuck) continue;

    try {
      log.warn('stuck_task.recovering', {
        taskId: task.id,
        projectId: task.project_id,
        userId: task.user_id,
        status: task.status,
        executionStep: task.execution_step,
        elapsedMs,
        reason,
      });

      const nowIso = now.toISOString();
      await db
        .update(schema.tasks)
        .set({
          status: 'failed',
          executionStep: null,
          errorMessage: reason,
          completedAt: nowIso,
          updatedAt: nowIso,
        })
        .where(eq(schema.tasks.id, task.id));

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
      result.errors++;
    }
  }

  return result;
}
