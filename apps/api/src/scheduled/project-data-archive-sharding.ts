import type { ProjectData } from '../durable-objects/project-data';
import type { Env } from '../env';
import { createModuleLogger, serializeError } from '../lib/logger';
import {
  PROJECT_DATA_ARCHIVE_DEFAULT_CHUNK_BYTES,
  PROJECT_DATA_ARCHIVE_DEFAULT_CHUNK_ROWS,
  PROJECT_DATA_ARCHIVE_DEFAULT_LEASE_MS,
  PROJECT_DATA_ARCHIVE_DEFAULT_R2_PREFIX,
  PROJECT_DATA_ARCHIVE_DEFAULT_SESSION_GRACE_MS,
  PROJECT_DATA_ARCHIVE_DEFAULT_SHARD_COUNT,
  PROJECT_DATA_ARCHIVE_DEFAULT_SWEEP_PROJECTS,
  PROJECT_DATA_ARCHIVE_DEFAULT_SWEEP_SESSIONS,
  PROJECT_DATA_ARCHIVE_DEFAULT_WALL_TIME_MS,
  PROJECT_DATA_ARCHIVE_MAX_CHUNK_BYTES,
  PROJECT_DATA_ARCHIVE_ROUTING_SCHEMA_VERSION,
  PROJECT_DATA_ARCHIVE_TABLES,
  type ProjectDataArchiveChunk,
  type ProjectDataArchiveJournalState,
} from '../project-data-archive/contract';
import {
  archiveShardProjectDataOwner,
  assertArchiveJournalTransition,
  casArchiveJournalState,
  rootProjectDataOwner,
} from '../services/project-data-archive-routing';

const log = createModuleLogger('scheduled.project_data_archive_sharding');

type ArchiveCoordinatorConfig = {
  enabled: boolean;
  shardCount: number;
  sweepProjects: number;
  sweepSessions: number;
  sessionGraceMs: number;
  chunkRows: number;
  chunkBytes: number;
  leaseMs: number;
  wallTimeMs: number;
  r2Prefix: string;
};

type CandidateRow = {
  project_id: string;
  session_id: string;
};

type MigrationRow = {
  migration_id: string;
  project_id: string;
  session_id: string;
  state: ProjectDataArchiveJournalState;
  source_owner_name: string;
  target_owner_name: string;
  target_generation: number;
  source_intent_token: string | null;
  terminal_version_sha256: string | null;
  target_aggregate_sha256: string | null;
  r2_manifest_key: string | null;
};

export type ProjectDataArchiveShardingStats = {
  enabled: boolean;
  skipped: boolean;
  skipReason: string | null;
  selected: number;
  migrated: number;
  recoveredCrashGaps: number;
  failed: number;
  chunksCopied: number;
  rowsCopied: number;
};

function envInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (Number.isSafeInteger(parsed) && parsed >= min) return Math.min(parsed, max);
  return fallback;
}

function resolveConfig(env: Env): ArchiveCoordinatorConfig {
  return {
    enabled: env.PROJECT_DATA_ARCHIVE_SHARDING_ENABLED === 'true',
    shardCount: envInt(
      env.PROJECT_DATA_ARCHIVE_SHARD_COUNT,
      PROJECT_DATA_ARCHIVE_DEFAULT_SHARD_COUNT,
      1,
      4096
    ),
    sweepProjects: envInt(
      env.PROJECT_DATA_ARCHIVE_SWEEP_PROJECTS,
      PROJECT_DATA_ARCHIVE_DEFAULT_SWEEP_PROJECTS,
      1,
      50
    ),
    sweepSessions: envInt(
      env.PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS,
      PROJECT_DATA_ARCHIVE_DEFAULT_SWEEP_SESSIONS,
      1,
      50
    ),
    sessionGraceMs: envInt(
      env.PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS,
      PROJECT_DATA_ARCHIVE_DEFAULT_SESSION_GRACE_MS,
      1,
      365 * 24 * 60 * 60 * 1000
    ),
    chunkRows: envInt(
      env.PROJECT_DATA_ARCHIVE_CHUNK_ROWS,
      PROJECT_DATA_ARCHIVE_DEFAULT_CHUNK_ROWS,
      1,
      PROJECT_DATA_ARCHIVE_DEFAULT_CHUNK_ROWS * 20
    ),
    chunkBytes: envInt(
      env.PROJECT_DATA_ARCHIVE_CHUNK_BYTES,
      PROJECT_DATA_ARCHIVE_DEFAULT_CHUNK_BYTES,
      1,
      PROJECT_DATA_ARCHIVE_MAX_CHUNK_BYTES
    ),
    leaseMs: envInt(
      env.PROJECT_DATA_ARCHIVE_LEASE_MS,
      PROJECT_DATA_ARCHIVE_DEFAULT_LEASE_MS,
      1,
      60 * 60 * 1000
    ),
    wallTimeMs: envInt(
      env.PROJECT_DATA_ARCHIVE_WALL_TIME_MS,
      PROJECT_DATA_ARCHIVE_DEFAULT_WALL_TIME_MS,
      1,
      60_000
    ),
    r2Prefix: env.PROJECT_DATA_ARCHIVE_R2_PREFIX || PROJECT_DATA_ARCHIVE_DEFAULT_R2_PREFIX,
  };
}

function emptyStats(config: ArchiveCoordinatorConfig, skipped: boolean, skipReason: string | null) {
  return {
    enabled: config.enabled,
    skipped,
    skipReason,
    selected: 0,
    migrated: 0,
    recoveredCrashGaps: 0,
    failed: 0,
    chunksCopied: 0,
    rowsCopied: 0,
  } satisfies ProjectDataArchiveShardingStats;
}

function ownerStub(env: Env, ownerName: string): DurableObjectStub<ProjectData> {
  const stub = env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(ownerName)
  ) as DurableObjectStub<ProjectData>;
  return new Proxy(stub, {
    get(target, prop, receiver) {
      return Reflect.get(target, prop, receiver);
    },
  });
}

async function ensureOwnerStub(
  env: Env,
  ownerName: string,
  projectId: string
): Promise<DurableObjectStub<ProjectData>> {
  const stub = ownerStub(env, ownerName);
  await stub.ensureProjectId(projectId);
  return stub;
}

async function selectCandidates(
  env: Env,
  config: ArchiveCoordinatorConfig,
  now: Date
): Promise<CandidateRow[]> {
  const cutoff = now.getTime() - config.sessionGraceMs;
  const nowIso = now.toISOString();
  const rows = await env.DATABASE.prepare(
    `SELECT ss.project_id, ss.id AS session_id
     FROM session_summaries ss
     LEFT JOIN project_data_session_locations loc
       ON loc.project_id = ss.project_id AND loc.session_id = ss.id
     LEFT JOIN project_data_archive_circuit_breakers breaker
       ON breaker.project_id = ss.project_id
     WHERE ss.status IN ('stopped', 'failed')
       AND ss.ended_at IS NOT NULL
       AND ss.ended_at <= ?
       AND (loc.session_id IS NULL OR loc.location_state = 'root')
       AND COALESCE(breaker.state, 'closed') = 'closed'
       AND NOT EXISTS (
         SELECT 1
         FROM session_snapshots snap
         WHERE snap.chat_session_id = ss.id
           AND snap.status IN ('available', 'degraded')
           AND snap.expires_at > ?
       )
     ORDER BY ss.updated_at ASC, ss.id ASC
     LIMIT ?`
  )
    .bind(cutoff, nowIso, config.sweepProjects * config.sweepSessions)
    .all<CandidateRow>();
  return rows.results ?? [];
}

async function createCandidateJournal(
  env: Env,
  candidate: CandidateRow,
  now: number
): Promise<MigrationRow | null> {
  const projectId = candidate.project_id;
  const sessionId = candidate.session_id;
  const source = rootProjectDataOwner(projectId);
  const generationRow = await env.DATABASE.prepare(
    `SELECT COALESCE(MAX(target_generation), 0) + 1 AS generation
     FROM project_data_archive_migrations
     WHERE project_id = ? AND session_id = ?`
  )
    .bind(projectId, sessionId)
    .first<{ generation: number }>();
  const targetGeneration = generationRow?.generation ?? 1;
  const target = archiveShardProjectDataOwner(env, projectId, sessionId, targetGeneration);
  const migrationId = crypto.randomUUID();
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `INSERT INTO project_data_archive_migrations (
         migration_id, project_id, session_id, state, source_owner_name, target_owner_name,
         source_generation, target_generation, lease_epoch, attempt_count,
         candidate_at, created_at, updated_at
       )
       SELECT ?, ?, ?, 'candidate', ?, ?, 0, ?, 0, 0, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1
         FROM project_data_session_locations
         WHERE project_id = ? AND session_id = ? AND location_state != 'root'
       )`
    ).bind(
      migrationId,
      projectId,
      sessionId,
      source.ownerName,
      target.ownerName,
      target.generation,
      now,
      now,
      now,
      projectId,
      sessionId
    ),
    env.DATABASE.prepare(
      `INSERT INTO project_data_session_locations (
         project_id, session_id, location_state, owner_kind, owner_name, generation,
         migration_id, source_owner_name, target_owner_name, routing_schema_version, updated_at
       )
       SELECT ?, ?, 'migrating', 'archive_shard', ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1
         FROM project_data_session_locations
         WHERE project_id = ? AND session_id = ? AND location_state != 'root'
       )
       ON CONFLICT(project_id, session_id) DO UPDATE SET
         location_state = CASE
           WHEN project_data_session_locations.location_state = 'root' THEN 'migrating'
           ELSE project_data_session_locations.location_state
         END,
         owner_kind = CASE
           WHEN project_data_session_locations.location_state = 'root' THEN 'archive_shard'
           ELSE project_data_session_locations.owner_kind
         END,
         owner_name = CASE
           WHEN project_data_session_locations.location_state = 'root' THEN excluded.owner_name
           ELSE project_data_session_locations.owner_name
         END,
         generation = CASE
           WHEN project_data_session_locations.location_state = 'root' THEN excluded.generation
           ELSE project_data_session_locations.generation
         END,
         migration_id = CASE
           WHEN project_data_session_locations.location_state = 'root' THEN excluded.migration_id
           ELSE project_data_session_locations.migration_id
         END,
         source_owner_name = CASE
           WHEN project_data_session_locations.location_state = 'root' THEN excluded.source_owner_name
           ELSE project_data_session_locations.source_owner_name
         END,
         target_owner_name = CASE
           WHEN project_data_session_locations.location_state = 'root' THEN excluded.target_owner_name
           ELSE project_data_session_locations.target_owner_name
         END,
         updated_at = CASE
           WHEN project_data_session_locations.location_state = 'root' THEN excluded.updated_at
           ELSE project_data_session_locations.updated_at
         END`
    ).bind(
      projectId,
      sessionId,
      target.ownerName,
      target.generation,
      migrationId,
      source.ownerName,
      target.ownerName,
      PROJECT_DATA_ARCHIVE_ROUTING_SCHEMA_VERSION,
      now,
      projectId,
      sessionId
    ),
  ]);
  return readMigration(env, migrationId);
}

async function readMigration(env: Env, migrationId: string): Promise<MigrationRow | null> {
  return env.DATABASE.prepare(
    `SELECT migration_id, project_id, session_id, state, source_owner_name, target_owner_name,
            target_generation, source_intent_token, terminal_version_sha256,
            target_aggregate_sha256, r2_manifest_key
     FROM project_data_archive_migrations
     WHERE migration_id = ?`
  )
    .bind(migrationId)
    .first<MigrationRow>();
}

async function claimLease(
  env: Env,
  migrationId: string,
  now: number,
  leaseMs: number
): Promise<boolean> {
  const leaseOwner = crypto.randomUUID();
  const result = await env.DATABASE.prepare(
    `UPDATE project_data_archive_migrations
     SET state = 'leased',
         lease_owner = ?,
         lease_epoch = lease_epoch + 1,
         lease_expires_at = ?,
         attempt_count = attempt_count + 1,
         updated_at = ?
     WHERE migration_id = ?
       AND state IN ('candidate', 'failed')
       AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`
  )
    .bind(leaseOwner, now + leaseMs, now, migrationId, now)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

async function markFailed(
  env: Env,
  migration: MigrationRow,
  now: number,
  error: unknown
): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE project_data_archive_migrations
     SET state = 'failed',
         error_code = ?,
         error_message = ?,
         lease_expires_at = NULL,
         updated_at = ?
     WHERE migration_id = ? AND state != 'source_deleted' AND state != 'published'`
  )
    .bind(
      error instanceof Error ? error.name : 'Error',
      error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
      now,
      migration.migration_id
    )
    .run();
}

async function putImmutableJson(r2: R2Bucket, key: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value);
  const existing = await r2.get(key);
  if (existing) {
    const existingText = await existing.text();
    if (existingText !== text) {
      throw new Error(`ProjectData archive immutable R2 object conflict at ${key}`);
    }
    return;
  }
  await r2.put(key, text, {
    httpMetadata: { contentType: 'application/json' },
  });
}

function chunkKey(config: ArchiveCoordinatorConfig, chunk: ProjectDataArchiveChunk): string {
  return `${config.r2Prefix}/${chunk.projectId}/${chunk.sessionId}/${chunk.migrationId}/${chunk.tableName}/${chunk.ordinal}.json`;
}

function manifestKey(config: ArchiveCoordinatorConfig, migration: MigrationRow): string {
  return `${config.r2Prefix}/${migration.project_id}/${migration.session_id}/${migration.migration_id}/manifest.json`;
}

async function publishSourceDeletedGap(
  env: Env,
  migration: MigrationRow,
  now: number
): Promise<boolean> {
  if (!migration.target_aggregate_sha256) return false;
  const result = await env.DATABASE.prepare(
    `UPDATE project_data_session_locations
     SET location_state = 'archive_shard',
         owner_kind = 'archive_shard',
         owner_name = ?,
         generation = ?,
         target_aggregate_sha256 = ?,
         published_at = COALESCE(published_at, ?),
         updated_at = ?
     WHERE project_id = ?
       AND session_id = ?
       AND migration_id = ?
       AND location_state = 'migrating'`
  )
    .bind(
      migration.target_owner_name,
      migration.target_generation,
      migration.target_aggregate_sha256,
      now,
      now,
      migration.project_id,
      migration.session_id,
      migration.migration_id
    )
    .run();
  if ((result.meta.changes ?? 0) === 0) return false;
  await casArchiveJournalState(env, {
    migrationId: migration.migration_id,
    from: 'source_deleted',
    to: 'published',
    now,
  });
  return true;
}

async function recoverCrashGaps(
  env: Env,
  config: ArchiveCoordinatorConfig,
  now: number
): Promise<number> {
  const rows = await env.DATABASE.prepare(
    `SELECT migration_id, project_id, session_id, state, source_owner_name, target_owner_name,
            target_generation, source_intent_token, terminal_version_sha256,
            target_aggregate_sha256, r2_manifest_key
     FROM project_data_archive_migrations
     WHERE state = 'source_deleted'
     ORDER BY updated_at ASC
     LIMIT ?`
  )
    .bind(config.sweepSessions)
    .all<MigrationRow>();
  let recovered = 0;
  for (const migration of rows.results ?? []) {
    if (await publishSourceDeletedGap(env, migration, now)) recovered++;
  }
  return recovered;
}

async function migrateCandidate(
  env: Env,
  config: ArchiveCoordinatorConfig,
  r2: R2Bucket,
  migration: MigrationRow,
  now: number
): Promise<{ migrated: boolean; chunksCopied: number; rowsCopied: number }> {
  assertArchiveJournalTransition('candidate', 'leased');
  if (!(await claimLease(env, migration.migration_id, now, config.leaseMs))) {
    return { migrated: false, chunksCopied: 0, rowsCopied: 0 };
  }
  const sourceIntentToken = crypto.randomUUID();
  const source = await ensureOwnerStub(env, migration.source_owner_name, migration.project_id);
  const target = await ensureOwnerStub(env, migration.target_owner_name, migration.project_id);

  const prepared = await source.archiveSourcePrepareIntent({
    projectId: migration.project_id,
    sessionId: migration.session_id,
    migrationId: migration.migration_id,
    sourceOwnerName: migration.source_owner_name,
    targetOwnerName: migration.target_owner_name,
    targetGeneration: migration.target_generation,
    sourceIntentToken,
    now,
    minTerminalAgeMs: config.sessionGraceMs,
  });
  await casArchiveJournalState(env, {
    migrationId: migration.migration_id,
    from: 'leased',
    to: 'intent_prepared',
    now,
    fields: {
      sourceIntentToken,
      terminalVersionSha256: prepared.terminalVersionSha256,
    },
  });

  await target.archiveTargetPrepare({
    projectId: migration.project_id,
    sessionId: migration.session_id,
    migrationId: migration.migration_id,
    sourceOwnerName: migration.source_owner_name,
    targetOwnerName: migration.target_owner_name,
    targetGeneration: migration.target_generation,
    sourceIntentToken,
    terminalVersionSha256: prepared.terminalVersionSha256,
    sessionRow: prepared.sessionRow,
    expectedMessageCount: prepared.messageCount,
    now,
  });
  await casArchiveJournalState(env, {
    migrationId: migration.migration_id,
    from: 'intent_prepared',
    to: 'target_prepared',
    now,
  });
  await casArchiveJournalState(env, {
    migrationId: migration.migration_id,
    from: 'target_prepared',
    to: 'copying',
    now,
  });

  const chunkKeys: string[] = [];
  const chunkHashes: string[] = [];
  let chunksCopied = 0;
  let rowsCopied = 0;
  for (const tableName of PROJECT_DATA_ARCHIVE_TABLES) {
    let cursor: string | null = null;
    let ordinal = 0;
    do {
      const chunk = await source.archiveSourceExportChunk({
        projectId: migration.project_id,
        sessionId: migration.session_id,
        migrationId: migration.migration_id,
        sourceOwnerName: migration.source_owner_name,
        targetOwnerName: migration.target_owner_name,
        targetGeneration: migration.target_generation,
        sourceIntentToken,
        tableName,
        ordinal,
        cursor,
        maxRows: config.chunkRows,
        maxBytes: config.chunkBytes,
      });
      await putImmutableJson(r2, chunkKey(config, chunk), chunk);
      await target.archiveTargetCommitChunk({ ...chunk, now });
      chunkKeys.push(chunkKey(config, chunk));
      chunkHashes.push(chunk.sha256);
      chunksCopied++;
      rowsCopied += chunk.rowCount;
      cursor = chunk.hasMore ? chunk.cursor : null;
      ordinal++;
    } while (cursor);
  }

  const sealed = await target.archiveTargetSeal({
    projectId: migration.project_id,
    sessionId: migration.session_id,
    migrationId: migration.migration_id,
    sourceOwnerName: migration.source_owner_name,
    targetOwnerName: migration.target_owner_name,
    targetGeneration: migration.target_generation,
    sourceIntentToken,
    terminalVersionSha256: prepared.terminalVersionSha256,
    expectedChunkHashes: chunkHashes,
    now,
  });
  await source.archiveSourceMarkTargetSealed({
    sessionId: migration.session_id,
    migrationId: migration.migration_id,
    sourceIntentToken,
    targetAggregateSha256: sealed.aggregateSha256,
    now,
  });
  await casArchiveJournalState(env, {
    migrationId: migration.migration_id,
    from: 'copying',
    to: 'target_sealed',
    now,
    fields: { targetAggregateSha256: sealed.aggregateSha256 },
  });
  const manifest = {
    version: PROJECT_DATA_ARCHIVE_ROUTING_SCHEMA_VERSION,
    projectId: migration.project_id,
    sessionId: migration.session_id,
    migrationId: migration.migration_id,
    sourceOwnerName: migration.source_owner_name,
    targetOwnerName: migration.target_owner_name,
    targetGeneration: migration.target_generation,
    terminalVersionSha256: prepared.terminalVersionSha256,
    aggregateSha256: sealed.aggregateSha256,
    chunks: chunkKeys,
    chunkHashes,
    createdAt: now,
  };
  const recoveryManifestKey = manifestKey(config, migration);
  await putImmutableJson(r2, recoveryManifestKey, manifest);
  await source.archiveSourceMarkRecoveryManifestPersisted({
    sessionId: migration.session_id,
    migrationId: migration.migration_id,
    sourceIntentToken,
    targetAggregateSha256: sealed.aggregateSha256,
    r2ManifestKey: recoveryManifestKey,
    now,
  });
  await casArchiveJournalState(env, {
    migrationId: migration.migration_id,
    from: 'target_sealed',
    to: 'recovery_manifest_persisted',
    now,
    fields: { r2ManifestKey: recoveryManifestKey },
  });
  await source.archiveSourceFinalizeDelete({
    projectId: migration.project_id,
    sessionId: migration.session_id,
    migrationId: migration.migration_id,
    sourceOwnerName: migration.source_owner_name,
    targetOwnerName: migration.target_owner_name,
    targetGeneration: migration.target_generation,
    sourceIntentToken,
    expectedTerminalVersionSha256: prepared.terminalVersionSha256,
    targetAggregateSha256: sealed.aggregateSha256,
    r2ManifestKey: recoveryManifestKey,
    now,
    minTerminalAgeMs: config.sessionGraceMs,
  });
  await casArchiveJournalState(env, {
    migrationId: migration.migration_id,
    from: 'recovery_manifest_persisted',
    to: 'source_deleted',
    now,
    fields: { targetAggregateSha256: sealed.aggregateSha256, r2ManifestKey: recoveryManifestKey },
  });
  await publishSourceDeletedGap(
    env,
    {
      ...migration,
      target_aggregate_sha256: sealed.aggregateSha256,
      r2_manifest_key: recoveryManifestKey,
      source_intent_token: sourceIntentToken,
      terminal_version_sha256: prepared.terminalVersionSha256,
      state: 'source_deleted',
    },
    now
  );
  return { migrated: true, chunksCopied, rowsCopied };
}

export async function runProjectDataArchiveSharding(
  env: Env,
  nowDate = new Date()
): Promise<ProjectDataArchiveShardingStats> {
  const config = resolveConfig(env);
  if (!config.enabled) return emptyStats(config, true, 'disabled');
  const archiveR2 = env.PROJECT_DATA_ARCHIVE_R2;
  if (!archiveR2) return emptyStats(config, true, 'missing_r2_binding');

  const startedAt = Date.now();
  const now = nowDate.getTime();
  const stats = emptyStats(config, false, null);
  stats.recoveredCrashGaps = await recoverCrashGaps(env, config, now);
  const candidates = await selectCandidates(env, config, nowDate);
  stats.selected = candidates.length;
  for (const candidate of candidates.slice(0, config.sweepSessions)) {
    if (Date.now() - startedAt >= config.wallTimeMs) break;
    const migration = await createCandidateJournal(env, candidate, now);
    if (!migration) continue;
    try {
      const result = await migrateCandidate(env, config, archiveR2, migration, now);
      if (result.migrated) stats.migrated++;
      stats.chunksCopied += result.chunksCopied;
      stats.rowsCopied += result.rowsCopied;
    } catch (error) {
      stats.failed++;
      await markFailed(env, migration, now, error).catch((markError) => {
        log.error('project_data_archive_mark_failed_failed', {
          migrationId: migration.migration_id,
          ...serializeError(markError),
        });
      });
      log.warn('project_data_archive_candidate_failed', {
        migrationId: migration.migration_id,
        projectId: migration.project_id,
        sessionId: migration.session_id,
        ...serializeError(error),
      });
    }
  }
  return stats;
}
