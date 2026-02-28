/**
 * Provisioning Timeout Service
 *
 * Handles detection and marking of workspaces stuck in 'creating' status.
 * Called by cron trigger every 5 minutes.
 *
 * TDF-7: Enhanced with OBSERVABILITY_DATABASE recording and structured
 * logging for admin visibility of provisioning timeout recoveries.
 */

import { drizzle } from 'drizzle-orm/d1';
import { eq, and, lt } from 'drizzle-orm';
import * as schema from '../db/schema';
import { log } from '../lib/logger';
import { persistError } from './observability';

/** Default provisioning timeout in milliseconds (15 minutes).
 * Must be >= WORKSPACE_READY_TIMEOUT_MS to avoid marking workspaces as timed out
 * while the task runner is still waiting for them to become ready. */
const DEFAULT_PROVISIONING_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Get provisioning timeout from env or use default (per constitution principle XI).
 */
export function getProvisioningTimeoutMs(env?: { PROVISIONING_TIMEOUT_MS?: string }): number {
  if (env?.PROVISIONING_TIMEOUT_MS) {
    const timeout = parseInt(env.PROVISIONING_TIMEOUT_MS, 10);
    if (!isNaN(timeout) && timeout > 0) {
      return timeout;
    }
  }
  return DEFAULT_PROVISIONING_TIMEOUT_MS;
}

/**
 * Check for and handle workspaces stuck in 'creating' status.
 * Marks them as 'error' with a descriptive message.
 *
 * @param database - D1 database binding
 * @param env - Environment for reading configurable timeout
 * @param observabilityDb - Optional OBSERVABILITY_DATABASE for recording timeouts (TDF-7)
 * @returns Number of workspaces that timed out
 */
export async function checkProvisioningTimeouts(
  database: D1Database,
  env?: { PROVISIONING_TIMEOUT_MS?: string },
  observabilityDb?: D1Database
): Promise<number> {
  const db = drizzle(database, { schema });
  const now = new Date();
  const timeoutMs = getProvisioningTimeoutMs(env);
  const cutoff = new Date(now.getTime() - timeoutMs);
  const timeoutMinutes = Math.round(timeoutMs / 60000);

  // Find workspaces stuck in 'creating' status past timeout threshold
  // Include node_id and user_id for diagnostic context (TDF-7)
  const stuckWorkspaces = await db
    .select({
      id: schema.workspaces.id,
      nodeId: schema.workspaces.nodeId,
      userId: schema.workspaces.userId,
      createdAt: schema.workspaces.createdAt,
    })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.status, 'creating'),
        lt(schema.workspaces.createdAt, cutoff.toISOString())
      )
    );

  if (stuckWorkspaces.length === 0) {
    return 0;
  }

  // Update all stuck workspaces to error status
  const timeoutMessage = `Provisioning timed out after ${timeoutMinutes} minutes`;
  for (const workspace of stuckWorkspaces) {
    await db
      .update(schema.workspaces)
      .set({
        status: 'error',
        errorMessage: timeoutMessage,
        updatedAt: now.toISOString(),
      })
      .where(eq(schema.workspaces.id, workspace.id));

    log.warn('provisioning_timeout.workspace_timed_out', {
      workspaceId: workspace.id,
      nodeId: workspace.nodeId,
      userId: workspace.userId,
      createdAt: workspace.createdAt,
      timeoutMinutes,
    });

    // Record in OBSERVABILITY_DATABASE (TDF-7)
    if (observabilityDb) {
      await persistError(observabilityDb, {
        source: 'api',
        level: 'warn',
        message: timeoutMessage,
        context: {
          recoveryType: 'provisioning_timeout',
          workspaceId: workspace.id,
          nodeId: workspace.nodeId,
          createdAt: workspace.createdAt,
          timeoutMs,
        },
        userId: workspace.userId,
        nodeId: workspace.nodeId,
        workspaceId: workspace.id,
      });
    }
  }

  log.info('provisioning_timeout.summary', {
    timedOutCount: stuckWorkspaces.length,
    timeoutMinutes,
  });

  return stuckWorkspaces.length;
}
