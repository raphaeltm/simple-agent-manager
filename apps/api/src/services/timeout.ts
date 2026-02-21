/**
 * Provisioning Timeout Service
 *
 * Handles detection and marking of workspaces stuck in 'creating' status.
 * Called by cron trigger every 5 minutes.
 */

import { drizzle } from 'drizzle-orm/d1';
import { eq, and, lt } from 'drizzle-orm';
import * as schema from '../db/schema';

/** Default provisioning timeout in milliseconds (15 minutes) */
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
 * @returns Number of workspaces that timed out
 */
export async function checkProvisioningTimeouts(
  database: D1Database,
  env?: { PROVISIONING_TIMEOUT_MS?: string }
): Promise<number> {
  const db = drizzle(database, { schema });
  const now = new Date();
  const timeoutMs = getProvisioningTimeoutMs(env);
  const cutoff = new Date(now.getTime() - timeoutMs);
  const timeoutMinutes = Math.round(timeoutMs / 60000);

  // Find workspaces stuck in 'creating' status past timeout threshold
  const stuckWorkspaces = await db
    .select({ id: schema.workspaces.id })
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
  }

  console.log(
    `Provisioning timeout: marked ${stuckWorkspaces.length} workspace(s) as error`
  );

  return stuckWorkspaces.length;
}
