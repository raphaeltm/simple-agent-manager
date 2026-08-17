import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import * as projectDataService from '../services/project-data';
import { DEFAULT_SESSION_SLEEP_CLAIM_LEASE_MS } from '../services/session-snapshots';
import { destroyVmAgentContainer } from '../services/vm-agent-container';
import { COMPOSE_IMAGE_ARTIFACT_PREFIX } from './compose-image-artifact-cleanup';

export const DEFAULT_DEPLOYMENT_RELEASE_RETENTION_COUNT = 3;
export const DEFAULT_DEPLOYMENT_RELEASE_RETENTION_BATCH_SIZE = 250;
export const DEFAULT_DEPLOYMENT_RELEASE_RETENTION_INTERVAL_HOURS = 24;
export const DEFAULT_DEPLOYMENT_RELEASE_RETENTION_LAST_RUN_KV_KEY =
  'cleanup:deployment-releases:last-run';
export const DEFAULT_DEPLOYMENT_RELEASE_RECONCILIATION_BATCH_SIZE = 50;
export const DEFAULT_DEPLOYMENT_RELEASE_RECONCILIATION_STALE_HOURS = 168;
export const DEFAULT_DEPLOYMENT_RELEASE_RECONCILIATION_ACTIVITY_GRACE_HOURS = 6;

export const DEFAULT_SESSION_SNAPSHOT_PURGE_BATCH_SIZE = 250;

interface D1MutationResult {
  meta?: { changes?: number };
}

interface ScheduledSweepResult {
  enabled: boolean;
  skipped: boolean;
  skipReason: string | null;
}

interface IntervalGateOptions<T extends ScheduledSweepResult> {
  env: Env;
  now: Date;
  intervalHours: number;
  lastRunKey: string;
  emptyResult: (overrides?: Partial<T>) => T;
  run: () => Promise<T>;
}

export interface DeploymentReleaseRetentionStats extends ScheduledSweepResult {
  retentionCount: number;
  batchSize: number;
  reconciliationEnabled: boolean;
  reconciliationBatchSize: number;
  reconciliationStaleHours: number;
  reconciliationActivityGraceHours: number;
  reconciledStaleReleases: number;
  deletedReleases: number;
}

export interface SessionSnapshotPurgeStats extends ScheduledSweepResult {
  batchSize: number;
  deletedSnapshots: number;
  deletedObjects: number;
  errors: number;
}

function isEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() !== 'false';
}

function lastRunKey(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

function mutationChanges(result: D1MutationResult): number {
  return result.meta?.changes ?? 0;
}

async function runIntervalGatedSweep<T extends ScheduledSweepResult>(
  options: IntervalGateOptions<T>
): Promise<T> {
  const lastRun = await options.env.KV.get(options.lastRunKey);
  const lastRunMs = lastRun ? Date.parse(lastRun) : Number.NaN;
  const intervalMs = options.intervalHours * 60 * 60 * 1000;

  if (Number.isFinite(lastRunMs) && options.now.getTime() - lastRunMs < intervalMs) {
    return options.emptyResult({ skipped: true, skipReason: 'interval-not-elapsed' } as Partial<T>);
  }

  const result = await options.run();
  await options.env.KV.put(options.lastRunKey, options.now.toISOString(), {
    expirationTtl: options.intervalHours * 2 * 60 * 60,
  });
  return result;
}

function deploymentReleaseRetentionCount(env: Env): number {
  return parsePositiveInt(
    env.DEPLOYMENT_RELEASE_RETENTION_COUNT,
    DEFAULT_DEPLOYMENT_RELEASE_RETENTION_COUNT
  );
}

function deploymentReleaseRetentionBatchSize(env: Env): number {
  return parsePositiveInt(
    env.DEPLOYMENT_RELEASE_RETENTION_BATCH_SIZE,
    DEFAULT_DEPLOYMENT_RELEASE_RETENTION_BATCH_SIZE
  );
}

function deploymentReleaseRetentionIntervalHours(env: Env): number {
  return parsePositiveInt(
    env.DEPLOYMENT_RELEASE_RETENTION_INTERVAL_HOURS,
    DEFAULT_DEPLOYMENT_RELEASE_RETENTION_INTERVAL_HOURS
  );
}

function deploymentReleaseReconciliationEnabled(env: Env): boolean {
  return isEnabled(env.DEPLOYMENT_RELEASE_RECONCILIATION_ENABLED);
}

function deploymentReleaseReconciliationBatchSize(env: Env): number {
  return parsePositiveInt(
    env.DEPLOYMENT_RELEASE_RECONCILIATION_BATCH_SIZE,
    DEFAULT_DEPLOYMENT_RELEASE_RECONCILIATION_BATCH_SIZE
  );
}

function deploymentReleaseReconciliationStaleHours(env: Env): number {
  return parsePositiveInt(
    env.DEPLOYMENT_RELEASE_RECONCILIATION_STALE_HOURS,
    DEFAULT_DEPLOYMENT_RELEASE_RECONCILIATION_STALE_HOURS
  );
}

function deploymentReleaseReconciliationActivityGraceHours(env: Env): number {
  return parsePositiveInt(
    env.DEPLOYMENT_RELEASE_RECONCILIATION_ACTIVITY_GRACE_HOURS,
    DEFAULT_DEPLOYMENT_RELEASE_RECONCILIATION_ACTIVITY_GRACE_HOURS
  );
}

function emptyDeploymentReleaseRetentionStats(
  env: Env,
  overrides: Partial<DeploymentReleaseRetentionStats> = {}
): DeploymentReleaseRetentionStats {
  return {
    enabled: true,
    skipped: false,
    skipReason: null,
    retentionCount: deploymentReleaseRetentionCount(env),
    batchSize: deploymentReleaseRetentionBatchSize(env),
    reconciliationEnabled: deploymentReleaseReconciliationEnabled(env),
    reconciliationBatchSize: deploymentReleaseReconciliationBatchSize(env),
    reconciliationStaleHours: deploymentReleaseReconciliationStaleHours(env),
    reconciliationActivityGraceHours: deploymentReleaseReconciliationActivityGraceHours(env),
    reconciledStaleReleases: 0,
    deletedReleases: 0,
    ...overrides,
  };
}

export interface StaleDeploymentReleaseReconciliationStats {
  enabled: boolean;
  batchSize: number;
  staleHours: number;
  activityGraceHours: number;
  reconciledReleases: number;
}

function emptyStaleDeploymentReleaseReconciliationStats(
  env: Env,
  overrides: Partial<StaleDeploymentReleaseReconciliationStats> = {}
): StaleDeploymentReleaseReconciliationStats {
  return {
    enabled: deploymentReleaseReconciliationEnabled(env),
    batchSize: deploymentReleaseReconciliationBatchSize(env),
    staleHours: deploymentReleaseReconciliationStaleHours(env),
    activityGraceHours: deploymentReleaseReconciliationActivityGraceHours(env),
    reconciledReleases: 0,
    ...overrides,
  };
}

function hoursBefore(now: Date, hours: number): string {
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
}

/**
 * Terminalize stale nonterminal compose releases whose R2 image artifacts are
 * otherwise retained forever by manifest references.
 *
 * Race-safety depends on D1-only evidence:
 * - the release came from the compose-publish path;
 * - status activity is older than the stale threshold;
 * - the authenticated deployment node has observed a stable non-applying state
 *   after this release was created;
 * - the release is not the environment's observed applied seq;
 * - no recent release fetch/apply event exists inside the activity lease;
 * - the manifest is valid JSON and actually references compose image artifacts.
 *
 * Unknown statuses, malformed/future timestamps, malformed manifests, and
 * missing/ambiguous observed state fail closed by not matching the update.
 */
export async function runStaleDeploymentReleaseReconciliation(
  env: Env,
  now: Date = new Date()
): Promise<StaleDeploymentReleaseReconciliationStats> {
  const stats = emptyStaleDeploymentReleaseReconciliationStats(env);
  if (!stats.enabled) {
    return stats;
  }

  const staleBefore = hoursBefore(now, stats.staleHours);
  const activeAfter = hoursBefore(now, stats.activityGraceHours);
  const nowIso = now.toISOString();

  const result = (await env.DATABASE.prepare(
    `UPDATE deployment_releases
     SET status = 'failed',
         status_updated_at = ?
     WHERE id IN (
       SELECT release.id
       FROM deployment_releases AS release
       INNER JOIN deployment_environments AS environment
         ON environment.id = release.environment_id
       WHERE release.status IN ('created', 'applying')
         AND release.source = 'compose-publish'
         AND release.manifest LIKE ?
         AND json_valid(release.manifest) = 1
         AND datetime(coalesce(release.status_updated_at, release.created_at)) IS NOT NULL
         AND datetime(coalesce(release.status_updated_at, release.created_at)) <= datetime(?)
         AND datetime(release.created_at) IS NOT NULL
         AND datetime(environment.observed_at) IS NOT NULL
         AND datetime(environment.observed_at) >= datetime(release.created_at)
         AND datetime(environment.observed_at) <= datetime(?)
         AND environment.observed_status IN ('applied', 'failed', 'failed-initial', 'reverted')
         AND (
           environment.observed_applied_seq IS NULL
           OR release.version <> environment.observed_applied_seq
         )
         AND NOT EXISTS (
           SELECT 1
           FROM deployment_release_events AS event
           WHERE (
               event.release_id = release.id
               OR (
                 event.release_id IS NULL
                 AND event.environment_id = release.environment_id
                 AND event.release_version = release.version
               )
             )
             AND datetime(event.created_at) IS NOT NULL
             AND datetime(event.created_at) > datetime(?)
         )
       ORDER BY release.environment_id ASC, release.version ASC, release.id ASC
       LIMIT ?
     )`
  )
    .bind(
      nowIso,
      `%${COMPOSE_IMAGE_ARTIFACT_PREFIX}%`,
      staleBefore,
      nowIso,
      activeAfter,
      stats.batchSize
    )
    .run()) as D1MutationResult;

  return {
    ...stats,
    reconciledReleases: mutationChanges(result),
  };
}

/**
 * Delete a bounded page of superseded terminal releases across every environment.
 *
 * A release is eligible only when N newer versions exist in the same environment.
 * The environment's observed applied version is protected independently, and only
 * known terminal statuses are eligible, so created/applying and future statuses fail
 * closed. Successful candidates leave the set permanently (rule 47).
 */
export async function runDeploymentReleaseRetention(
  env: Env,
  now: Date = new Date()
): Promise<DeploymentReleaseRetentionStats> {
  if (!isEnabled(env.DEPLOYMENT_RELEASE_RETENTION_ENABLED)) {
    return emptyDeploymentReleaseRetentionStats(env, {
      enabled: false,
      skipped: true,
      skipReason: 'disabled',
    });
  }

  const retentionCount = deploymentReleaseRetentionCount(env);
  const batchSize = deploymentReleaseRetentionBatchSize(env);
  const reconciliation = await runStaleDeploymentReleaseReconciliation(env, now);
  const result = (await env.DATABASE.prepare(
    `DELETE FROM deployment_releases
     WHERE id IN (
       SELECT release.id
       FROM deployment_releases AS release
       INNER JOIN deployment_environments AS environment
         ON environment.id = release.environment_id
       WHERE release.status IN ('applied', 'failed')
         AND (
           environment.observed_applied_seq IS NULL
           OR release.version <> environment.observed_applied_seq
         )
         AND (
           SELECT COUNT(*)
           FROM deployment_releases AS newer_release
           WHERE newer_release.environment_id = release.environment_id
             AND newer_release.version > release.version
         ) >= ?
       ORDER BY release.environment_id ASC, release.version ASC, release.id ASC
       LIMIT ?
     )`
  )
    .bind(retentionCount, batchSize)
    .run()) as D1MutationResult;

  return emptyDeploymentReleaseRetentionStats(env, {
    retentionCount,
    batchSize,
    reconciliationEnabled: reconciliation.enabled,
    reconciliationBatchSize: reconciliation.batchSize,
    reconciliationStaleHours: reconciliation.staleHours,
    reconciliationActivityGraceHours: reconciliation.activityGraceHours,
    reconciledStaleReleases: reconciliation.reconciledReleases,
    deletedReleases: mutationChanges(result),
  });
}

export async function runScheduledDeploymentReleaseRetention(
  env: Env,
  now: Date = new Date()
): Promise<DeploymentReleaseRetentionStats> {
  if (!isEnabled(env.DEPLOYMENT_RELEASE_RETENTION_ENABLED)) {
    return emptyDeploymentReleaseRetentionStats(env, {
      enabled: false,
      skipped: true,
      skipReason: 'disabled',
    });
  }

  return runIntervalGatedSweep({
    env,
    now,
    intervalHours: deploymentReleaseRetentionIntervalHours(env),
    lastRunKey: lastRunKey(
      env.DEPLOYMENT_RELEASE_RETENTION_LAST_RUN_KV_KEY,
      DEFAULT_DEPLOYMENT_RELEASE_RETENTION_LAST_RUN_KV_KEY
    ),
    emptyResult: (overrides) => emptyDeploymentReleaseRetentionStats(env, overrides),
    run: () => runDeploymentReleaseRetention(env, now),
  });
}

function sessionSnapshotPurgeBatchSize(env: Env): number {
  return parsePositiveInt(
    env.SESSION_SNAPSHOT_PURGE_BATCH_SIZE,
    DEFAULT_SESSION_SNAPSHOT_PURGE_BATCH_SIZE
  );
}

function emptySessionSnapshotPurgeStats(
  env: Env,
  overrides: Partial<SessionSnapshotPurgeStats> = {}
): SessionSnapshotPurgeStats {
  return {
    enabled: true,
    skipped: false,
    skipReason: null,
    batchSize: sessionSnapshotPurgeBatchSize(env),
    deletedSnapshots: 0,
    deletedObjects: 0,
    errors: 0,
    ...overrides,
  };
}

/** Terminalize expired sessions, remove their R2 state, then purge bounded D1 metadata. */
export async function runSessionSnapshotPurge(
  env: Env,
  now: Date = new Date()
): Promise<SessionSnapshotPurgeStats> {
  if (!isEnabled(env.SESSION_SNAPSHOT_PURGE_ENABLED)) {
    return emptySessionSnapshotPurgeStats(env, {
      enabled: false,
      skipped: true,
      skipReason: 'disabled',
    });
  }

  const batchSize = sessionSnapshotPurgeBatchSize(env);
  const purgeClaimId = crypto.randomUUID();
  const staleClaimBefore = new Date(
    now.getTime() -
      parsePositiveInt(env.SESSION_SLEEP_CLAIM_LEASE_MS, DEFAULT_SESSION_SLEEP_CLAIM_LEASE_MS)
  ).toISOString();
  const candidates = await env.DATABASE.prepare(
    `SELECT id, project_id, workspace_id, node_id, chat_session_id, runtime,
            home_r2_key, wip_r2_key, manifest_r2_key
     FROM session_snapshots
     WHERE expires_at < ?
       AND sleeping_at IS NOT NULL
       AND (
         (status = 'available' AND sleep_status = 'sleeping'
          AND (recovery_status IS NULL OR recovery_status != 'waking'))
         OR
         (status = 'expired' AND sleep_status = 'purging'
          AND (sleep_claimed_at IS NULL OR sleep_claimed_at <= ?))
       )
     ORDER BY expires_at ASC, id ASC
     LIMIT ?`
  )
    .bind(now.toISOString(), staleClaimBefore, batchSize)
    .all<{
      id: string;
      project_id: string | null;
      workspace_id: string | null;
      node_id: string | null;
      chat_session_id: string;
      runtime: string | null;
      home_r2_key: string | null;
      wip_r2_key: string | null;
      manifest_r2_key: string | null;
    }>();
  let deletedSnapshots = 0;
  let deletedObjects = 0;
  let errors = 0;

  for (const candidate of candidates.results ?? []) {
    try {
      const claim = (await env.DATABASE.prepare(
        `UPDATE session_snapshots
         SET status = 'expired', sleep_status = 'purging', sleep_claim_id = ?,
             sleep_claimed_at = ?, updated_at = ?
         WHERE id = ? AND expires_at < ? AND sleeping_at IS NOT NULL
           AND (
             (status = 'available' AND sleep_status = 'sleeping'
              AND (recovery_status IS NULL OR recovery_status != 'waking'))
             OR
             (status = 'expired' AND sleep_status = 'purging'
              AND (sleep_claimed_at IS NULL OR sleep_claimed_at <= ?))
           )`
      )
        .bind(
          purgeClaimId,
          now.toISOString(),
          now.toISOString(),
          candidate.id,
          now.toISOString(),
          staleClaimBefore
        )
        .run()) as D1MutationResult;
      if (mutationChanges(claim) === 0) continue;

      // Once the seven-day restore window expires the chat becomes terminal,
      // preventing a later follow-up from silently starting without its state.
      if (candidate.project_id) {
        await projectDataService.stopSession(env, candidate.project_id, candidate.chat_session_id);
      }
      if (candidate.runtime === 'cf-container' && candidate.node_id) {
        await destroyVmAgentContainer(env, candidate.node_id);
      }

      const objectKeys = [
        candidate.home_r2_key,
        candidate.wip_r2_key,
        candidate.manifest_r2_key,
      ].filter((key): key is string => Boolean(key));
      if (objectKeys.length > 0) {
        await env.R2.delete(objectKeys);
        deletedObjects += objectKeys.length;
      }

      const result = (await env.DATABASE.prepare(
        `DELETE FROM session_snapshots
         WHERE id = ? AND expires_at < ? AND sleeping_at IS NOT NULL
           AND status = 'expired' AND sleep_status = 'purging' AND sleep_claim_id = ?`
      )
        .bind(candidate.id, now.toISOString(), purgeClaimId)
        .run()) as D1MutationResult;
      deletedSnapshots += mutationChanges(result);
    } catch (error) {
      errors++;
      log.warn('session_snapshot_purge.failed', {
        snapshotId: candidate.id,
        projectId: candidate.project_id,
        workspaceId: candidate.workspace_id,
        chatSessionId: candidate.chat_session_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return emptySessionSnapshotPurgeStats(env, {
    batchSize,
    deletedSnapshots,
    deletedObjects,
    errors,
  });
}

export async function runScheduledSessionSnapshotPurge(
  env: Env,
  now: Date = new Date()
): Promise<SessionSnapshotPurgeStats> {
  if (!isEnabled(env.SESSION_SNAPSHOT_PURGE_ENABLED)) {
    return emptySessionSnapshotPurgeStats(env, {
      enabled: false,
      skipped: true,
      skipReason: 'disabled',
    });
  }

  // Expiry is already bounded by SESSION_SNAPSHOT_PURGE_BATCH_SIZE. Run it on
  // every operational cron tick so a seven-day sleeping session is not retained
  // for up to another daily interval.
  return runSessionSnapshotPurge(env, now);
}
