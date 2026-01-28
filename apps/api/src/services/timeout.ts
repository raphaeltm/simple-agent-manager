/**
 * Provisioning Timeout Service
 *
 * Handles detection and marking of workspaces stuck in 'creating' status.
 * Called by cron trigger every 5 minutes.
 */

import { drizzle } from 'drizzle-orm/d1';
import { eq, and, lt } from 'drizzle-orm';
import * as schema from '../db/schema';

/** Provisioning timeout in milliseconds (10 minutes) */
const PROVISIONING_TIMEOUT_MS = 10 * 60 * 1000;

/** Error message for timed out workspaces */
const TIMEOUT_ERROR_MESSAGE = 'Provisioning timed out after 10 minutes';

/**
 * Check for and handle workspaces stuck in 'creating' status.
 * Marks them as 'error' with a descriptive message.
 *
 * @param database - D1 database binding
 * @returns Number of workspaces that timed out
 */
export async function checkProvisioningTimeouts(
  database: D1Database
): Promise<number> {
  const db = drizzle(database, { schema });
  const now = new Date();
  const cutoff = new Date(now.getTime() - PROVISIONING_TIMEOUT_MS);

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
  for (const workspace of stuckWorkspaces) {
    await db
      .update(schema.workspaces)
      .set({
        status: 'error',
        errorMessage: TIMEOUT_ERROR_MESSAGE,
        updatedAt: now.toISOString(),
      })
      .where(eq(schema.workspaces.id, workspace.id));
  }

  console.log(
    `Provisioning timeout: marked ${stuckWorkspaces.length} workspace(s) as error`
  );

  return stuckWorkspaces.length;
}
