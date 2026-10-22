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
import { log, serializeError } from '../lib/logger';
import { DEPLOYMENT_RELOCATION_CLAIM_FIELD } from './deployment-environment-state';

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

/**
 * Environment-side conditions under which nothing else will ever place the
 * release bound to the trailing `?`: a release still wants this environment on
 * a node (`active`, or `error` awaiting recovery), no node is linked, no
 * relocation claim is in flight, and the release is still the newest one.
 * Aliased `de`.
 *
 * `starting` is excluded: Start owns that state and records its own failures
 * (`markEnvironmentStartFailed`). `stopping`, `stopped` and `deleting` belong to
 * the Stop and Delete paths.
 */
const STRANDED_PLACEMENT_ENVIRONMENT_SQL = `de.status IN ('active', 'error')
          AND de.node_id IS NULL
          AND CASE
            WHEN json_valid(de.resolved_reservation_json)
            THEN COALESCE(json_extract(de.resolved_reservation_json, '$.${DEPLOYMENT_RELOCATION_CLAIM_FIELD}'), 0)
            ELSE 0
          END = 0
          AND ? = (
            SELECT latest.id FROM deployment_releases latest
            WHERE latest.environment_id = de.id
            ORDER BY latest.version DESC
            LIMIT 1
          )`;

/**
 * Record a cancelled placement that nothing else will finish.
 *
 * Placement cancellations (`isPlacementCancellation`) are normally not written,
 * because the usual causes leave another owner: a newer release superseded this
 * one, the user stopped or deleted the environment, or a concurrent placement
 * linked another node. When none of those holds, the release would stay
 * `created` forever with the previous error still on screen (production
 * environment 01M5HCF0X7Y2S9V74NV0AV3K99, 2026-10-22). Mark it failed and show
 * why, so the next deploy is an informed retry.
 *
 * Both writes run in one D1 batch (a single transaction). The environment
 * write only applies when the release write marked this release in the same
 * batch, so the two rows always agree.
 *
 * Never throws: callers are already handling `error` and rethrow it, so a D1
 * failure here is logged instead of replacing the original error.
 *
 * @returns true when the release was marked failed.
 */
export async function recordStrandedDeploymentReleasePlacement(
  env: Env,
  environmentId: string,
  releaseId: string,
  error: unknown
): Promise<boolean> {
  if (typeof env.DATABASE.prepare !== 'function' || typeof env.DATABASE.batch !== 'function') {
    return false;
  }
  const reason = (error instanceof Error ? error.message : String(error)).replace(/[.\s]+$/, '');
  try {
    const marked = await markStrandedPlacementFailed(
      env.DATABASE,
      environmentId,
      releaseId,
      reason
    );
    if (marked) {
      log.warn('deployment_release.stranded_placement_failed', {
        environmentId,
        releaseId,
        reason,
        action: 'marked_failed',
      });
    } else {
      log.info('deployment_release.placement_cancelled', {
        environmentId,
        releaseId,
        reason,
        action: 'left_to_current_owner',
      });
    }
    return marked;
  } catch (writeError) {
    log.error('deployment_release.stranded_placement_record_failed', {
      environmentId,
      releaseId,
      reason,
      ...serializeError(writeError),
    });
    return false;
  }
}

async function markStrandedPlacementFailed(
  database: D1Database,
  environmentId: string,
  releaseId: string,
  reason: string
): Promise<boolean> {
  const now = new Date().toISOString();
  const [releaseResult] = await database.batch([
    database
      .prepare(
        `UPDATE deployment_releases
            SET status = 'failed', status_updated_at = ?
          WHERE id = ?
            AND environment_id = ?
            AND status = 'created'
            AND EXISTS (
              SELECT 1 FROM deployment_environments de
              WHERE de.id = deployment_releases.environment_id
                AND ${STRANDED_PLACEMENT_ENVIRONMENT_SQL}
            )`
      )
      .bind(now, releaseId, environmentId, releaseId),
    database
      .prepare(
        `UPDATE deployment_environments AS de
            SET status = 'error',
                observed_status = 'failed',
                observed_error_message = ?,
                updated_at = ?
          WHERE de.id = ?
            AND ${STRANDED_PLACEMENT_ENVIRONMENT_SQL}
            AND EXISTS (
              SELECT 1 FROM deployment_releases marked
              WHERE marked.id = ? AND marked.status = 'failed' AND marked.status_updated_at = ?
            )`
      )
      .bind(
        `Deployment node placement stopped before a server was created: ${reason}. Deploy again to retry.`,
        now,
        environmentId,
        releaseId,
        releaseId,
        now
      ),
  ]);
  return (releaseResult?.meta?.changes ?? 0) > 0;
}
