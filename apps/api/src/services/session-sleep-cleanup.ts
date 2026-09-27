import { and, eq, inArray } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { stopComputeTracking } from './compute-usage';
import { cleanupTaskRun } from './task-runner';

export async function finishSleepingWorkspaceComputeCleanup(
  db: ReturnType<typeof drizzle<typeof schema>>,
  env: Env,
  input: {
    workspaceId: string;
    taskId: string | null;
    warmNodeTimeoutMs: number | null;
  }
): Promise<void> {
  await stopComputeTracking(db, input.workspaceId).catch((error) => {
    log.warn('session_sleep.compute_tracking_stop_failed', {
      workspaceId: input.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  if (input.taskId) {
    await cleanupTaskRun(input.taskId, env, input.warmNodeTimeoutMs).catch((error) => {
      log.warn('session_sleep.task_cleanup_failed', {
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

export async function markWorkspaceNodeWarmIfEmpty(
  db: ReturnType<typeof drizzle<typeof schema>>,
  env: Env,
  input: {
    nodeId: string;
    nodeRole: string;
    runtime: string;
    userId: string;
    warmNodeTimeoutMs: number | null;
  }
): Promise<void> {
  if (input.runtime === 'cf-container' || input.nodeRole !== 'workspace') return;
  try {
    // Generic task cleanup may already have transitioned the node using the
    // project's warm-retention override. In that case, do not reset its timer.
    const [node] = await db
      .select({ status: schema.nodes.status, warmSince: schema.nodes.warmSince })
      .from(schema.nodes)
      .where(eq(schema.nodes.id, input.nodeId))
      .limit(1);
    if (!node || node.warmSince || ['stopped', 'deleted'].includes(node.status)) return;

    const active = await db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.nodeId, input.nodeId),
          inArray(schema.workspaces.status, ['running', 'creating', 'recovery'])
        )
      )
      .limit(1);
    if (active.length > 0) return;

    const stub = env.NODE_LIFECYCLE.get(env.NODE_LIFECYCLE.idFromName(input.nodeId));
    await (stub as unknown as import('../durable-objects/node-lifecycle').NodeLifecycle).markIdle(
      input.nodeId,
      input.userId,
      input.warmNodeTimeoutMs
    );
  } catch (error) {
    log.warn('session_sleep.node_warm_transition_failed', {
      nodeId: input.nodeId,
      userId: input.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
