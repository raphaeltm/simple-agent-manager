import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { COMPOSE_IMAGE_ARTIFACT_PREFIX } from './compose-image-artifact-cleanup';
import {
  type D1MutationResult,
  isEnabled,
  mutationChanges,
  type ScheduledSweepResult,
} from './retention-helpers';

export const DEFAULT_DEPLOYMENT_RELEASE_RETENTION_COUNT = 3;
export const DEFAULT_DEPLOYMENT_RELEASE_RETENTION_BATCH_SIZE = 250;
export const DEFAULT_DEPLOYMENT_RELEASE_RETENTION_INTERVAL_HOURS = 24;
export const DEFAULT_DEPLOYMENT_RELEASE_RETENTION_LAST_RUN_KV_KEY =
  'cleanup:deployment-releases:last-run';
export const DEFAULT_DEPLOYMENT_RELEASE_RECONCILIATION_BATCH_SIZE = 50;
export const DEFAULT_DEPLOYMENT_RELEASE_RECONCILIATION_STALE_HOURS = 168;
export const DEFAULT_DEPLOYMENT_RELEASE_RECONCILIATION_ACTIVITY_GRACE_HOURS = 6;

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

function lastRunKey(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
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
