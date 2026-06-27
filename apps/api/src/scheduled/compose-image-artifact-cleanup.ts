/**
 * Compose image artifact cleanup.
 *
 * This intentionally cleans only build/deploy Docker archive artifacts under
 * compose-image-artifacts/. Referenced artifacts are protected globally so
 * currently live, reschedulable, or promotable releases remain safe.
 */
import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';

const log = createModuleLogger('compose-image-artifact-cleanup');

export const COMPOSE_IMAGE_ARTIFACT_PREFIX = 'compose-image-artifacts/';
const DEFAULT_ABANDONED_RETENTION_HOURS = 48;
const DEFAULT_CLEANUP_BATCH_SIZE = 50;
const DEFAULT_CLEANUP_INTERVAL_HOURS = 24;
const DEFAULT_LAST_RUN_KV_KEY = 'cleanup:compose-image-artifacts:last-run';

interface ReleaseManifestRow {
  id: string;
  manifest: string;
}

interface R2ListedObject {
  key: string;
  size: number;
  uploaded: Date;
}

interface R2ListResult {
  objects: R2ListedObject[];
  truncated?: boolean;
  cursor?: string;
}

export interface ComposeImageArtifactCleanupStats {
  enabled: boolean;
  skipped: boolean;
  skipReason: string | null;
  scannedObjects: number;
  referencedKeys: number;
  retainedReferenced: number;
  retainedYoung: number;
  deleteCandidates: number;
  deletedObjects: number;
  deletedBytes: number;
  errors: number;
}

function emptyStats(overrides: Partial<ComposeImageArtifactCleanupStats> = {}): ComposeImageArtifactCleanupStats {
  return {
    enabled: true,
    skipped: false,
    skipReason: null,
    scannedObjects: 0,
    referencedKeys: 0,
    retainedReferenced: 0,
    retainedYoung: 0,
    deleteCandidates: 0,
    deletedObjects: 0,
    deletedBytes: 0,
    errors: 0,
    ...overrides,
  };
}

function cleanupEnabled(env: Env): boolean {
  return env.COMPOSE_IMAGE_ARTIFACT_CLEANUP_ENABLED !== 'false';
}

function retentionHours(env: Env): number {
  return parsePositiveInt(
    env.COMPOSE_IMAGE_ARTIFACT_ABANDONED_RETENTION_HOURS,
    DEFAULT_ABANDONED_RETENTION_HOURS
  );
}

function batchSize(env: Env): number {
  return parsePositiveInt(
    env.COMPOSE_IMAGE_ARTIFACT_CLEANUP_BATCH_SIZE,
    DEFAULT_CLEANUP_BATCH_SIZE
  );
}

function cleanupIntervalHours(env: Env): number {
  return parsePositiveInt(
    env.COMPOSE_IMAGE_ARTIFACT_CLEANUP_INTERVAL_HOURS,
    DEFAULT_CLEANUP_INTERVAL_HOURS
  );
}

function lastRunKey(env: Env): string {
  return env.COMPOSE_IMAGE_ARTIFACT_CLEANUP_LAST_RUN_KV_KEY?.trim() || DEFAULT_LAST_RUN_KV_KEY;
}

function isComposeImageArtifactKey(value: string): boolean {
  return value.startsWith(COMPOSE_IMAGE_ARTIFACT_PREFIX);
}

function collectComposeImageArtifactKeys(value: unknown, keys: Set<string>): void {
  if (typeof value === 'string') {
    if (isComposeImageArtifactKey(value)) {
      keys.add(value);
    }
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectComposeImageArtifactKeys(item, keys);
    }
    return;
  }

  for (const item of Object.values(value as Record<string, unknown>)) {
    collectComposeImageArtifactKeys(item, keys);
  }
}

async function collectReferencedArtifactKeys(db: D1Database): Promise<Set<string>> {
  const referenced = new Set<string>();
  const rows = await db
    .prepare(
      `SELECT id, manifest
       FROM deployment_releases
       WHERE manifest LIKE ?`
    )
    .bind(`%${COMPOSE_IMAGE_ARTIFACT_PREFIX}%`)
    .all<ReleaseManifestRow>();

  for (const row of rows.results) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.manifest);
    } catch (err) {
      throw new Error(
        `Cannot compute compose image artifact references because release ${row.id} has invalid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    collectComposeImageArtifactKeys(parsed, referenced);
  }

  return referenced;
}

function objectIsOlderThan(object: R2ListedObject, cutoffMs: number): boolean {
  const uploadedMs = object.uploaded.getTime();
  return Number.isFinite(uploadedMs) && uploadedMs <= cutoffMs;
}

export async function runComposeImageArtifactCleanup(
  env: Env,
  now: Date = new Date()
): Promise<ComposeImageArtifactCleanupStats> {
  if (!cleanupEnabled(env)) {
    return emptyStats({ enabled: false, skipped: true, skipReason: 'disabled' });
  }

  if (!env.R2) {
    return emptyStats({ skipped: true, skipReason: 'missing-r2-binding', errors: 1 });
  }

  let referenced: Set<string>;
  try {
    referenced = await collectReferencedArtifactKeys(env.DATABASE);
  } catch (err) {
    log.error('reference_collection_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return emptyStats({ skipped: true, skipReason: 'reference-collection-failed', errors: 1 });
  }

  const stats = emptyStats({ referencedKeys: referenced.size });
  const cutoffMs = now.getTime() - retentionHours(env) * 60 * 60 * 1000;
  const maxDeletes = batchSize(env);
  let cursor: string | undefined;

  do {
    let page: R2ListResult;
    try {
      page = (await env.R2.list({
        prefix: COMPOSE_IMAGE_ARTIFACT_PREFIX,
        cursor,
        limit: 1000,
      })) as R2ListResult;
    } catch (err) {
      stats.errors += 1;
      log.error('list_failed', {
        prefix: COMPOSE_IMAGE_ARTIFACT_PREFIX,
        error: err instanceof Error ? err.message : String(err),
      });
      return stats;
    }

    for (const object of page.objects) {
      stats.scannedObjects += 1;

      if (referenced.has(object.key)) {
        stats.retainedReferenced += 1;
        continue;
      }

      if (!objectIsOlderThan(object, cutoffMs)) {
        stats.retainedYoung += 1;
        continue;
      }

      stats.deleteCandidates += 1;
      try {
        await env.R2.delete(object.key);
        stats.deletedObjects += 1;
        stats.deletedBytes += object.size;
      } catch (err) {
        stats.errors += 1;
        log.error('delete_failed', {
          prefix: COMPOSE_IMAGE_ARTIFACT_PREFIX,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (stats.deleteCandidates >= maxDeletes) {
        return stats;
      }
    }

    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return stats;
}

export async function runScheduledComposeImageArtifactCleanup(
  env: Env,
  now: Date = new Date()
): Promise<ComposeImageArtifactCleanupStats> {
  if (!cleanupEnabled(env)) {
    return emptyStats({ enabled: false, skipped: true, skipReason: 'disabled' });
  }

  const key = lastRunKey(env);
  let lastRun: string | null;
  try {
    lastRun = await env.KV.get(key);
  } catch (err) {
    log.error('last_run_read_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return emptyStats({ skipped: true, skipReason: 'last-run-read-failed', errors: 1 });
  }

  const lastRunMs = lastRun ? Date.parse(lastRun) : Number.NaN;
  const intervalMs = cleanupIntervalHours(env) * 60 * 60 * 1000;
  if (Number.isFinite(lastRunMs) && now.getTime() - lastRunMs < intervalMs) {
    return emptyStats({ skipped: true, skipReason: 'interval-not-elapsed' });
  }

  const result = await runComposeImageArtifactCleanup(env, now);

  if (!result.skipped || result.skipReason === 'reference-collection-failed') {
    try {
      await env.KV.put(key, now.toISOString(), {
        expirationTtl: Math.max(cleanupIntervalHours(env) * 2 * 60 * 60, 60 * 60),
      });
    } catch (err) {
      log.error('last_run_write_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      result.errors += 1;
    }
  }

  return result;
}
