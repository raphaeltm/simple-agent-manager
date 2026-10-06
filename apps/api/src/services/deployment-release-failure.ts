/**
 * Deployment release placement failure recording.
 *
 * Extracted from `routes/deployment-release-placement.ts` so that route file
 * stays within the 500/800-line ceiling (`.claude/rules/18-file-size-limits.md`).
 */
import { and, eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';

type DeploymentReleaseDb = ReturnType<typeof drizzle>;

/**
 * SQL predicate for "this environment still has something running on a node".
 *
 * A placement failure concerns the NEW release; it says nothing about the
 * release already applied on the node. Flipping `status` to 'error' in that
 * case is destructive: the node heartbeat treats every environment it reports
 * that is not `active`/`starting` as retired and instructs the VM agent to tear
 * the running app down (compose down, unmount volumes, remove the Caddy site).
 * On 2026-09-21 that destroyed the running v14 of production environment
 * 01M100A361P49T716X6QBV2NV5 within one heartbeat of v15 failing PLACEMENT.
 */
const ENVIRONMENT_HAS_LIVE_DEPLOYMENT_SQL = `deployment_environments.node_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM deployment_releases applied
        WHERE applied.environment_id = deployment_environments.id
          AND applied.status = 'applied'
      )`;

/** Drizzle-fallback mirror of {@link ENVIRONMENT_HAS_LIVE_DEPLOYMENT_SQL}. */
async function environmentHasLiveDeployment(
  db: DeploymentReleaseDb,
  environmentId: string
): Promise<boolean> {
  const envRows = await db
    .select({ nodeId: schema.deploymentEnvironments.nodeId })
    .from(schema.deploymentEnvironments)
    .where(eq(schema.deploymentEnvironments.id, environmentId))
    .limit(1);
  if (!envRows[0]?.nodeId) return false;
  const appliedRows = await db
    .select({ appliedReleaseId: schema.deploymentReleases.id })
    .from(schema.deploymentReleases)
    .where(
      and(
        eq(schema.deploymentReleases.environmentId, environmentId),
        eq(schema.deploymentReleases.status, 'applied')
      )
    )
    .limit(1);
  return appliedRows.length > 0;
}

export async function markDeploymentReleasePlacementFailed(
  db: DeploymentReleaseDb,
  env: Env,
  environmentId: string,
  releaseId: string,
  error: unknown,
  updateEnvironment = true
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const now = new Date().toISOString();
  await db
    .update(schema.deploymentReleases)
    .set({ status: 'failed', statusUpdatedAt: now })
    .where(eq(schema.deploymentReleases.id, releaseId));
  if (updateEnvironment) {
    const observedErrorMessage = `Deployment node placement failed: ${message}`;
    if (typeof env.DATABASE.prepare === 'function') {
      // The failure is always recorded on observed_* so it stays visible; only
      // the destructive `status = 'error'` flip is withheld while a release is
      // still applied on a node.
      await env.DATABASE.prepare(
        `UPDATE deployment_environments
            SET status = CASE
                  WHEN ${ENVIRONMENT_HAS_LIVE_DEPLOYMENT_SQL}
                  THEN status
                  ELSE 'error'
                END,
                observed_status = 'failed',
                observed_error_message = ?, updated_at = ?
          WHERE id = ?
            AND ? = (
              SELECT latest.id FROM deployment_releases latest
              WHERE latest.environment_id = deployment_environments.id
              ORDER BY latest.version DESC
              LIMIT 1
            )`
      )
        .bind(observedErrorMessage, now, environmentId, releaseId)
        .run();
    } else {
      const preserveStatus = await environmentHasLiveDeployment(db, environmentId);
      await db
        .update(schema.deploymentEnvironments)
        .set({
          ...(preserveStatus ? {} : { status: 'error' }),
          observedStatus: 'failed',
          observedErrorMessage,
          updatedAt: now,
        })
        .where(eq(schema.deploymentEnvironments.id, environmentId));
    }
  }
}
