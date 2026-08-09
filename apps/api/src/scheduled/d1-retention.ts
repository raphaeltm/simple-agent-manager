import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';

export const DEFAULT_DEPLOYMENT_RELEASE_RETENTION_COUNT = 3;
export const DEFAULT_DEPLOYMENT_RELEASE_RETENTION_BATCH_SIZE = 250;
export const DEFAULT_DEPLOYMENT_RELEASE_RETENTION_INTERVAL_HOURS = 24;
export const DEFAULT_DEPLOYMENT_RELEASE_RETENTION_LAST_RUN_KV_KEY =
  'cleanup:deployment-releases:last-run';

export const DEFAULT_SESSION_SNAPSHOT_PURGE_BATCH_SIZE = 250;
export const DEFAULT_SESSION_SNAPSHOT_PURGE_INTERVAL_HOURS = 24;
export const DEFAULT_SESSION_SNAPSHOT_PURGE_LAST_RUN_KV_KEY = 'cleanup:session-snapshots:last-run';

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
  deletedReleases: number;
}

export interface SessionSnapshotPurgeStats extends ScheduledSweepResult {
  batchSize: number;
  deletedSnapshots: number;
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
    deletedReleases: 0,
    ...overrides,
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
  env: Env
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
    run: () => runDeploymentReleaseRetention(env),
  });
}

function sessionSnapshotPurgeBatchSize(env: Env): number {
  return parsePositiveInt(
    env.SESSION_SNAPSHOT_PURGE_BATCH_SIZE,
    DEFAULT_SESSION_SNAPSHOT_PURGE_BATCH_SIZE
  );
}

function sessionSnapshotPurgeIntervalHours(env: Env): number {
  return parsePositiveInt(
    env.SESSION_SNAPSHOT_PURGE_INTERVAL_HOURS,
    DEFAULT_SESSION_SNAPSHOT_PURGE_INTERVAL_HOURS
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
    ...overrides,
  };
}

/** Purge a bounded page of expired D1 metadata; R2 owns object expiry by lifecycle. */
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
  const result = (await env.DATABASE.prepare(
    `DELETE FROM session_snapshots
     WHERE id IN (
       SELECT id
       FROM session_snapshots
       WHERE expires_at < ?
       ORDER BY expires_at ASC, id ASC
       LIMIT ?
     )`
  )
    .bind(now.toISOString(), batchSize)
    .run()) as D1MutationResult;

  return emptySessionSnapshotPurgeStats(env, {
    batchSize,
    deletedSnapshots: mutationChanges(result),
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

  return runIntervalGatedSweep({
    env,
    now,
    intervalHours: sessionSnapshotPurgeIntervalHours(env),
    lastRunKey: lastRunKey(
      env.SESSION_SNAPSHOT_PURGE_LAST_RUN_KV_KEY,
      DEFAULT_SESSION_SNAPSHOT_PURGE_LAST_RUN_KV_KEY
    ),
    emptyResult: (overrides) => emptySessionSnapshotPurgeStats(env, overrides),
    run: () => runSessionSnapshotPurge(env, now),
  });
}
