// FILE SIZE EXCEPTION: ProjectData archive-sharding coordinator — keeping the D1 CAS journal, lease recovery, failure controls, copy-back, and publish/finalize gates in one module preserves the audited migration state-machine order. See .claude/rules/18-file-size-limits.md
import type { ProjectData } from '../durable-objects/project-data';
import type {
  ArchiveSourceInspectIntentResult,
  ArchiveSourcePrepareResult,
  ArchiveTargetInspectResult,
} from '../durable-objects/project-data/archive-sharding';
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
  type ProjectDataArchiveTableName,
} from '../project-data-archive/contract';
import {
  archiveShardProjectDataOwner,
  assertArchiveJournalTransition,
  casArchiveJournalState,
  rootProjectDataOwner,
} from '../services/project-data-archive-routing';

const log = createModuleLogger('scheduled.project_data_archive_sharding');
const PROJECT_DATA_ARCHIVE_DEFAULT_POISON_AFTER_ATTEMPTS = 3;
const PROJECT_DATA_ARCHIVE_MAX_POISON_AFTER_ATTEMPTS = 100;

const ACTIVE_RECLAIMABLE_STATES = [
  'candidate',
  'leased',
  'intent_prepared',
  'target_prepared',
  'copying',
  'target_sealed',
  'recovery_manifest_persisted',
  'failed',
] as const satisfies readonly ProjectDataArchiveJournalState[];

const RECOVERY_GAP_STATES = [
  'source_deleted',
  'published',
] as const satisfies readonly ProjectDataArchiveJournalState[];

type MigrationPhaseProofState = Exclude<
  ProjectDataArchiveJournalState,
  'candidate' | 'failed' | 'poisoned' | 'frozen' | 'published'
>;

const JOURNAL_PHASE_RANK: Record<ProjectDataArchiveJournalState, number> = {
  candidate: 0,
  failed: 0,
  leased: 1,
  intent_prepared: 2,
  target_prepared: 3,
  copying: 4,
  target_sealed: 5,
  recovery_manifest_persisted: 6,
  source_deleted: 7,
  published: 8,
  poisoned: 9,
  frozen: 9,
};

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
  poisonAfterAttempts: number;
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
  lease_owner: string | null;
  lease_epoch: number;
  lease_expires_at: number | null;
  attempt_count: number;
};

type ClaimedMigrationRow = MigrationRow & {
  lease_owner: string;
  lease_expires_at: number;
};

export type ProjectDataArchiveShardingStats = {
  enabled: boolean;
  skipped: boolean;
  skipReason: string | null;
  selected: number;
  migrated: number;
  recoveredCrashGaps: number;
  failed: number;
  poisoned: number;
  chunksCopied: number;
  rowsCopied: number;
};

export type ProjectDataArchiveFrozenIntentInspection = {
  migrationId: string;
  projectId: string;
  sessionId: string;
  journalState: ProjectDataArchiveJournalState;
  locationState: string | null;
  breakerState: string | null;
  sourceIntent:
    | {
        exists: false;
        databaseSizeBytes: number;
      }
    | {
        exists: true;
        state: string;
        terminalVersionSha256: string;
        targetAggregateSha256: string | null;
        r2ManifestKey: string | null;
        messageCount: number;
        sourceDeletedAt: number | null;
        databaseSizeBeforeBytes: number | null;
        databaseSizeAfterBytes: number | null;
        databaseSizeBytes: number;
      }
    | {
        exists: null;
        error: string;
      };
  target:
    | {
        exists: true;
        state: string;
        terminalVersionSha256: string;
        aggregateSha256: string | null;
        messageCount: number;
        chunks: number;
        databaseSizeBytes: number;
      }
    | {
        exists: null;
        error: string;
      };
};

export type ProjectDataArchiveCopyBackResult = {
  migrationId: string;
  projectId: string;
  sessionId: string;
  chunksCopied: number;
  rowsCopied: number;
  restoredToRoot: boolean;
};

type CrashGapRecoveryResult = {
  recovered: number;
  failed: number;
};

export class ProjectDataArchiveCoordinatorStateError extends Error {
  readonly code = 'PROJECT_DATA_ARCHIVE_COORDINATOR_STATE';

  constructor(
    readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = 'ProjectDataArchiveCoordinatorStateError';
  }
}

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
    poisonAfterAttempts: envInt(
      env.PROJECT_DATA_ARCHIVE_POISON_AFTER_ATTEMPTS,
      PROJECT_DATA_ARCHIVE_DEFAULT_POISON_AFTER_ATTEMPTS,
      1,
      PROJECT_DATA_ARCHIVE_MAX_POISON_AFTER_ATTEMPTS
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
    poisoned: 0,
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

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
}

function requireStringField(
  migration: MigrationRow,
  field:
    | 'source_intent_token'
    | 'terminal_version_sha256'
    | 'target_aggregate_sha256'
    | 'r2_manifest_key'
): string {
  const value = migration[field];
  if (typeof value === 'string' && value.length > 0) return value;
  throw new ProjectDataArchiveCoordinatorStateError(
    'missing_journal_field',
    `ProjectData archive migration ${migration.migration_id} is missing ${field}`
  );
}

function sourceInspectInput(migration: MigrationRow) {
  return {
    projectId: migration.project_id,
    sessionId: migration.session_id,
    migrationId: migration.migration_id,
    sourceOwnerName: migration.source_owner_name,
    targetOwnerName: migration.target_owner_name,
    targetGeneration: migration.target_generation,
  };
}

function sourcePrepareInput(
  migration: MigrationRow,
  sourceIntentToken: string,
  now: number,
  sessionGraceMs: number
) {
  return {
    ...sourceInspectInput(migration),
    sourceIntentToken,
    now,
    minTerminalAgeMs: sessionGraceMs,
  };
}

function targetInspectInput(migration: MigrationRow) {
  return {
    projectId: migration.project_id,
    sessionId: migration.session_id,
    migrationId: migration.migration_id,
    targetOwnerName: migration.target_owner_name,
    targetGeneration: migration.target_generation,
  };
}

function targetChunkKey(
  config: ArchiveCoordinatorConfig,
  migration: Pick<MigrationRow, 'project_id' | 'session_id' | 'migration_id'>,
  tableName: ProjectDataArchiveTableName,
  ordinal: number
): string {
  return `${config.r2Prefix}/${migration.project_id}/${migration.session_id}/${migration.migration_id}/${tableName}/${ordinal}.json`;
}

function chunkKey(config: ArchiveCoordinatorConfig, chunk: ProjectDataArchiveChunk): string {
  return targetChunkKey(
    config,
    {
      project_id: chunk.projectId,
      session_id: chunk.sessionId,
      migration_id: chunk.migrationId,
    },
    chunk.tableName,
    chunk.ordinal
  );
}

function manifestKey(config: ArchiveCoordinatorConfig, migration: MigrationRow): string {
  return `${config.r2Prefix}/${migration.project_id}/${migration.session_id}/${migration.migration_id}/manifest.json`;
}

function manifestForTarget(
  config: ArchiveCoordinatorConfig,
  migration: MigrationRow,
  terminalVersionSha256: string,
  targetAggregateSha256: string,
  chunks: ArchiveTargetInspectResult['chunks'],
  now: number
) {
  return {
    version: PROJECT_DATA_ARCHIVE_ROUTING_SCHEMA_VERSION,
    projectId: migration.project_id,
    sessionId: migration.session_id,
    migrationId: migration.migration_id,
    sourceOwnerName: migration.source_owner_name,
    targetOwnerName: migration.target_owner_name,
    targetGeneration: migration.target_generation,
    terminalVersionSha256,
    aggregateSha256: targetAggregateSha256,
    chunks: chunks.map((chunk) =>
      targetChunkKey(config, migration, chunk.tableName, chunk.ordinal)
    ),
    chunkHashes: chunks.map((chunk) => chunk.sha256),
    createdAt: now,
  };
}

async function readMigration(env: Env, migrationId: string): Promise<MigrationRow | null> {
  return env.DATABASE.prepare(
    `SELECT migration_id, project_id, session_id, state, source_owner_name, target_owner_name,
            target_generation, source_intent_token, terminal_version_sha256,
            target_aggregate_sha256, r2_manifest_key, lease_owner, lease_epoch,
            lease_expires_at, attempt_count
     FROM project_data_archive_migrations
     WHERE migration_id = ?`
  )
    .bind(migrationId)
    .first<MigrationRow>();
}

async function readMigrationOrThrow(env: Env, migrationId: string): Promise<MigrationRow> {
  const migration = await readMigration(env, migrationId);
  if (!migration) {
    throw new ProjectDataArchiveCoordinatorStateError(
      'journal_missing',
      `ProjectData archive migration ${migrationId} is missing`
    );
  }
  return migration;
}

async function selectReclaimableMigrations(
  env: Env,
  limit: number,
  now: number
): Promise<MigrationRow[]> {
  if (limit <= 0) return [];
  const rows = await env.DATABASE.prepare(
    `SELECT m.migration_id, m.project_id, m.session_id, m.state, m.source_owner_name,
            m.target_owner_name, m.target_generation, m.source_intent_token,
            m.terminal_version_sha256, m.target_aggregate_sha256, m.r2_manifest_key,
            m.lease_owner, m.lease_epoch, m.lease_expires_at, m.attempt_count
     FROM project_data_archive_migrations m
     LEFT JOIN project_data_archive_circuit_breakers breaker
       ON breaker.project_id = m.project_id
     WHERE m.state IN (${placeholders(ACTIVE_RECLAIMABLE_STATES.length)})
       AND (m.lease_expires_at IS NULL OR m.lease_expires_at <= ?)
       AND COALESCE(breaker.state, 'closed') = 'closed'
     ORDER BY m.updated_at ASC, m.migration_id ASC
     LIMIT ?`
  )
    .bind(...ACTIVE_RECLAIMABLE_STATES, now, limit)
    .all<MigrationRow>();
  return rows.results ?? [];
}

async function selectCandidates(
  env: Env,
  config: ArchiveCoordinatorConfig,
  now: Date,
  limit: number
): Promise<CandidateRow[]> {
  if (limit <= 0) return [];
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
    .bind(cutoff, nowIso, Math.min(limit, config.sweepProjects * config.sweepSessions))
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

async function selectMigrationWork(
  env: Env,
  config: ArchiveCoordinatorConfig,
  nowDate: Date,
  now: number
): Promise<MigrationRow[]> {
  const reclaimable = await selectReclaimableMigrations(env, config.sweepSessions, now);
  const remaining = config.sweepSessions - reclaimable.length;
  if (remaining <= 0) return reclaimable;
  const candidates = await selectCandidates(env, config, nowDate, remaining);
  const created: MigrationRow[] = [];
  for (const candidate of candidates) {
    const migration = await createCandidateJournal(env, candidate, now);
    if (migration) created.push(migration);
  }
  return [...reclaimable, ...created].slice(0, config.sweepSessions);
}

async function claimMigrationLease(
  env: Env,
  migration: MigrationRow,
  now: number,
  leaseMs: number
): Promise<ClaimedMigrationRow | null> {
  const leaseOwner = crypto.randomUUID();
  const nextState: ProjectDataArchiveJournalState =
    migration.state === 'candidate' || migration.state === 'failed' ? 'leased' : migration.state;
  if (nextState !== migration.state) assertArchiveJournalTransition(migration.state, nextState);
  const result = await env.DATABASE.prepare(
    `UPDATE project_data_archive_migrations
     SET state = ?,
         lease_owner = ?,
         lease_epoch = lease_epoch + 1,
         lease_expires_at = ?,
         attempt_count = attempt_count + 1,
         updated_at = ?
     WHERE migration_id = ?
       AND state = ?
       AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
       AND NOT EXISTS (
         SELECT 1
         FROM project_data_archive_circuit_breakers breaker
         WHERE breaker.project_id = project_data_archive_migrations.project_id
           AND breaker.state != 'closed'
       )`
  )
    .bind(nextState, leaseOwner, now + leaseMs, now, migration.migration_id, migration.state, now)
    .run();
  if ((result.meta.changes ?? 0) === 0) return null;
  const claimed = await readMigrationOrThrow(env, migration.migration_id);
  if (!claimed.lease_owner || claimed.lease_expires_at === null) {
    throw new ProjectDataArchiveCoordinatorStateError(
      'lease_claim_missing',
      `ProjectData archive migration ${migration.migration_id} was claimed without a lease fence`
    );
  }
  return claimed as ClaimedMigrationRow;
}

function assertLeasePresent(migration: MigrationRow): asserts migration is ClaimedMigrationRow {
  if (!migration.lease_owner || migration.lease_expires_at === null) {
    throw new ProjectDataArchiveCoordinatorStateError(
      'missing_active_lease',
      `ProjectData archive migration ${migration.migration_id} is missing an active lease`
    );
  }
}

async function assertLeaseStillHeld(env: Env, migration: ClaimedMigrationRow): Promise<void> {
  const row = await env.DATABASE.prepare(
    `SELECT state, lease_owner, lease_epoch, lease_expires_at
     FROM project_data_archive_migrations
     WHERE migration_id = ?`
  )
    .bind(migration.migration_id)
    .first<{
      state: ProjectDataArchiveJournalState;
      lease_owner: string | null;
      lease_epoch: number;
      lease_expires_at: number | null;
    }>();
  const leaseExpiresAt = row?.lease_expires_at;
  if (
    row?.lease_owner !== migration.lease_owner ||
    row?.lease_epoch !== migration.lease_epoch ||
    leaseExpiresAt !== migration.lease_expires_at ||
    leaseExpiresAt === null ||
    leaseExpiresAt === undefined ||
    leaseExpiresAt <= Date.now()
  ) {
    throw new ProjectDataArchiveCoordinatorStateError(
      'lease_fence_lost',
      `ProjectData archive migration ${migration.migration_id} lost its lease fence`
    );
  }
}

function claimed(migration: MigrationRow): ClaimedMigrationRow {
  assertLeasePresent(migration);
  return migration;
}

async function refreshClaimed(
  env: Env,
  migration: ClaimedMigrationRow
): Promise<ClaimedMigrationRow> {
  const refreshed = await readMigrationOrThrow(env, migration.migration_id);
  if (
    refreshed.lease_owner !== migration.lease_owner ||
    refreshed.lease_epoch !== migration.lease_epoch ||
    refreshed.lease_expires_at !== migration.lease_expires_at
  ) {
    throw new ProjectDataArchiveCoordinatorStateError(
      'lease_fence_lost',
      `ProjectData archive migration ${migration.migration_id} lost its lease fence`
    );
  }
  return claimed(refreshed);
}

async function requireJournalCas(
  env: Env,
  migration: ClaimedMigrationRow,
  input: {
    from: ProjectDataArchiveJournalState;
    to: ProjectDataArchiveJournalState;
    now: number;
    fields?: NonNullable<Parameters<typeof casArchiveJournalState>[1]['fields']>;
  }
): Promise<ClaimedMigrationRow> {
  await assertLeaseStillHeld(env, migration);
  const ok = await casArchiveJournalState(env, {
    migrationId: migration.migration_id,
    from: input.from,
    to: input.to,
    now: input.now,
    fields: input.fields,
  });
  if (!ok) {
    throw new ProjectDataArchiveCoordinatorStateError(
      'journal_cas_miss',
      `ProjectData archive migration ${migration.migration_id} failed CAS ${input.from} -> ${input.to}`
    );
  }
  return refreshClaimed(env, migration);
}

async function persistPreparedJournalFields(
  env: Env,
  migration: ClaimedMigrationRow,
  prepared: ArchiveSourcePrepareResult,
  sourceIntentToken: string,
  now: number
): Promise<ClaimedMigrationRow> {
  const result = await env.DATABASE.prepare(
    `UPDATE project_data_archive_migrations
     SET source_intent_token = ?,
         terminal_version_sha256 = ?,
         updated_at = ?
     WHERE migration_id = ?
       AND state = ?
       AND lease_owner = ?
       AND lease_epoch = ?`
  )
    .bind(
      sourceIntentToken,
      prepared.terminalVersionSha256,
      now,
      migration.migration_id,
      migration.state,
      migration.lease_owner,
      migration.lease_epoch
    )
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    throw new ProjectDataArchiveCoordinatorStateError(
      'journal_field_update_miss',
      `ProjectData archive migration ${migration.migration_id} could not persist source intent fields`
    );
  }
  return refreshClaimed(env, migration);
}

function journalStateFromLocalIntent(
  intent: ArchiveSourceInspectIntentResult
): MigrationPhaseProofState | null {
  if (!intent.exists) return null;
  if (intent.state === 'rehome_exported') return null;
  return intent.state;
}

async function alignJournalToLocalSourceProof(
  env: Env,
  migration: ClaimedMigrationRow,
  intent: ArchiveSourceInspectIntentResult,
  now: number
): Promise<ClaimedMigrationRow> {
  if (!intent.exists) return migration;
  const proofState = journalStateFromLocalIntent(intent);
  if (!proofState || JOURNAL_PHASE_RANK[proofState] <= JOURNAL_PHASE_RANK[migration.state]) {
    return migration;
  }
  const result = await env.DATABASE.prepare(
    `UPDATE project_data_archive_migrations
     SET state = ?,
         source_intent_token = ?,
         terminal_version_sha256 = ?,
         target_aggregate_sha256 = COALESCE(?, target_aggregate_sha256),
         r2_manifest_key = COALESCE(?, r2_manifest_key),
         updated_at = ?,
         intent_prepared_at = CASE
           WHEN ? IN ('intent_prepared', 'target_prepared', 'copying', 'target_sealed',
                      'recovery_manifest_persisted', 'source_deleted')
           THEN COALESCE(intent_prepared_at, ?)
           ELSE intent_prepared_at
         END,
         target_sealed_at = CASE
           WHEN ? IN ('target_sealed', 'recovery_manifest_persisted', 'source_deleted')
           THEN COALESCE(target_sealed_at, ?)
           ELSE target_sealed_at
         END,
         recovery_manifest_persisted_at = CASE
           WHEN ? IN ('recovery_manifest_persisted', 'source_deleted')
           THEN COALESCE(recovery_manifest_persisted_at, ?)
           ELSE recovery_manifest_persisted_at
         END,
         source_deleted_at = CASE
           WHEN ? = 'source_deleted'
           THEN COALESCE(source_deleted_at, ?)
           ELSE source_deleted_at
         END
     WHERE migration_id = ?
       AND state = ?
       AND lease_owner = ?
       AND lease_epoch = ?`
  )
    .bind(
      proofState,
      intent.sourceIntentToken,
      intent.terminalVersionSha256,
      intent.targetAggregateSha256,
      intent.r2ManifestKey,
      now,
      proofState,
      now,
      proofState,
      now,
      proofState,
      now,
      proofState,
      intent.sourceDeletedAt ?? now,
      migration.migration_id,
      migration.state,
      migration.lease_owner,
      migration.lease_epoch
    )
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    throw new ProjectDataArchiveCoordinatorStateError(
      'local_proof_recovery_miss',
      `ProjectData archive migration ${migration.migration_id} could not re-attach journal state from local proof`
    );
  }
  return refreshClaimed(env, migration);
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

async function publishArchivedLocation(
  env: Env,
  migration: MigrationRow,
  now: number
): Promise<boolean> {
  const targetAggregateSha256 = requireStringField(migration, 'target_aggregate_sha256');
  const existing = await env.DATABASE.prepare(
    `SELECT location_state, owner_kind, owner_name, generation, target_aggregate_sha256
     FROM project_data_session_locations
     WHERE project_id = ? AND session_id = ?`
  )
    .bind(migration.project_id, migration.session_id)
    .first<{
      location_state: string;
      owner_kind: string;
      owner_name: string;
      generation: number;
      target_aggregate_sha256: string | null;
    }>();
  if (
    existing?.location_state === 'archive_shard' &&
    existing.owner_kind === 'archive_shard' &&
    existing.owner_name === migration.target_owner_name &&
    existing.generation === migration.target_generation &&
    existing.target_aggregate_sha256 === targetAggregateSha256
  ) {
    return false;
  }
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
       AND location_state IN ('migrating', 'frozen', 'archive_shard')`
  )
    .bind(
      migration.target_owner_name,
      migration.target_generation,
      targetAggregateSha256,
      now,
      now,
      migration.project_id,
      migration.session_id,
      migration.migration_id
    )
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    throw new ProjectDataArchiveCoordinatorStateError(
      'location_publish_miss',
      `ProjectData archive migration ${migration.migration_id} could not publish archive location`
    );
  }
  return true;
}

async function publishSourceDeletedGap(
  env: Env,
  migration: MigrationRow,
  now: number
): Promise<boolean> {
  let current = await readMigrationOrThrow(env, migration.migration_id);
  if (current.state === 'source_deleted') {
    const ok = await casArchiveJournalState(env, {
      migrationId: current.migration_id,
      from: 'source_deleted',
      to: 'published',
      now,
    });
    if (!ok) {
      current = await readMigrationOrThrow(env, current.migration_id);
      if (current.state !== 'published') {
        throw new ProjectDataArchiveCoordinatorStateError(
          'journal_cas_miss',
          `ProjectData archive migration ${current.migration_id} failed CAS source_deleted -> published`
        );
      }
    } else {
      current = await readMigrationOrThrow(env, current.migration_id);
    }
  }
  if (current.state !== 'published') return false;
  await publishArchivedLocation(env, current, now);
  return true;
}

async function recoverCrashGaps(
  env: Env,
  config: ArchiveCoordinatorConfig,
  now: number
): Promise<CrashGapRecoveryResult> {
  const rows = await env.DATABASE.prepare(
    `SELECT m.migration_id, m.project_id, m.session_id, m.state, m.source_owner_name,
            m.target_owner_name, m.target_generation, m.source_intent_token,
            m.terminal_version_sha256, m.target_aggregate_sha256, m.r2_manifest_key,
            m.lease_owner, m.lease_epoch, m.lease_expires_at, m.attempt_count
     FROM project_data_archive_migrations m
     LEFT JOIN project_data_session_locations loc
       ON loc.project_id = m.project_id AND loc.session_id = m.session_id
     WHERE m.state IN (${placeholders(RECOVERY_GAP_STATES.length)})
       AND m.target_aggregate_sha256 IS NOT NULL
       AND m.target_aggregate_sha256 != ''
       AND loc.session_id IS NOT NULL
       AND loc.migration_id = m.migration_id
       AND loc.location_state IN ('migrating', 'frozen', 'archive_shard')
       AND (
         m.state = 'source_deleted'
         OR (
           m.state = 'published'
           AND NOT (
             loc.location_state = 'archive_shard'
             AND loc.owner_kind = 'archive_shard'
             AND loc.owner_name = m.target_owner_name
             AND loc.generation = m.target_generation
             AND loc.target_aggregate_sha256 = m.target_aggregate_sha256
           )
         )
       )
     ORDER BY CASE m.state WHEN 'source_deleted' THEN 0 ELSE 1 END,
              m.updated_at ASC,
              m.migration_id ASC
     LIMIT ?`
  )
    .bind(...RECOVERY_GAP_STATES, config.sweepSessions)
    .all<MigrationRow>();
  let recovered = 0;
  let failed = 0;
  for (const migration of rows.results ?? []) {
    try {
      if (await publishSourceDeletedGap(env, migration, now)) recovered++;
    } catch (error) {
      failed++;
      log.warn('project_data_archive_crash_gap_recovery_failed', {
        migrationId: migration.migration_id,
        projectId: migration.project_id,
        sessionId: migration.session_id,
        ...serializeError(error),
      });
    }
  }
  return { recovered, failed };
}

async function inspectSourceIntent(
  source: DurableObjectStub<ProjectData>,
  migration: MigrationRow
): Promise<ArchiveSourceInspectIntentResult> {
  return source.archiveSourceInspectIntent(sourceInspectInput(migration));
}

async function ensureSourcePrepared(
  env: Env,
  config: ArchiveCoordinatorConfig,
  source: DurableObjectStub<ProjectData>,
  migration: ClaimedMigrationRow,
  now: number
): Promise<{ migration: ClaimedMigrationRow; prepared: ArchiveSourcePrepareResult }> {
  const sourceIntentToken = crypto.randomUUID();
  const prepared = await source.archiveSourcePrepareIntent(
    sourcePrepareInput(migration, sourceIntentToken, now, config.sessionGraceMs)
  );
  const updated =
    migration.state === 'leased'
      ? await requireJournalCas(env, migration, {
          from: 'leased',
          to: 'intent_prepared',
          now,
          fields: {
            sourceIntentToken,
            terminalVersionSha256: prepared.terminalVersionSha256,
          },
        })
      : await persistPreparedJournalFields(env, migration, prepared, sourceIntentToken, now);
  return { migration: updated, prepared };
}

async function ensureTargetPrepared(
  env: Env,
  target: DurableObjectStub<ProjectData>,
  migration: ClaimedMigrationRow,
  prepared: ArchiveSourcePrepareResult,
  now: number
): Promise<ClaimedMigrationRow> {
  await target.archiveTargetPrepare({
    projectId: migration.project_id,
    sessionId: migration.session_id,
    migrationId: migration.migration_id,
    sourceOwnerName: migration.source_owner_name,
    targetOwnerName: migration.target_owner_name,
    targetGeneration: migration.target_generation,
    sourceIntentToken: requireStringField(migration, 'source_intent_token'),
    terminalVersionSha256: prepared.terminalVersionSha256,
    sessionRow: prepared.sessionRow,
    expectedMessageCount: prepared.messageCount,
    now,
  });
  if (migration.state !== 'intent_prepared') return migration;
  return requireJournalCas(env, migration, {
    from: 'intent_prepared',
    to: 'target_prepared',
    now,
  });
}

async function enterCopying(
  env: Env,
  migration: ClaimedMigrationRow,
  now: number
): Promise<ClaimedMigrationRow> {
  if (migration.state !== 'target_prepared') return migration;
  return requireJournalCas(env, migration, {
    from: 'target_prepared',
    to: 'copying',
    now,
  });
}

async function copySourceChunks(
  source: DurableObjectStub<ProjectData>,
  target: DurableObjectStub<ProjectData>,
  config: ArchiveCoordinatorConfig,
  r2: R2Bucket,
  migration: MigrationRow,
  now: number
): Promise<{ chunkHashes: string[]; chunksCopied: number; rowsCopied: number }> {
  const sourceIntentToken = requireStringField(migration, 'source_intent_token');
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
      chunkHashes.push(chunk.sha256);
      chunksCopied++;
      rowsCopied += chunk.rowCount;
      cursor = chunk.hasMore ? chunk.cursor : null;
      ordinal++;
    } while (cursor);
  }
  return { chunkHashes, chunksCopied, rowsCopied };
}

async function sealTargetAndSource(
  env: Env,
  source: DurableObjectStub<ProjectData>,
  target: DurableObjectStub<ProjectData>,
  migration: ClaimedMigrationRow,
  terminalVersionSha256: string,
  expectedChunkHashes: string[],
  now: number
): Promise<ClaimedMigrationRow> {
  const sealed = await target.archiveTargetSeal({
    projectId: migration.project_id,
    sessionId: migration.session_id,
    migrationId: migration.migration_id,
    sourceOwnerName: migration.source_owner_name,
    targetOwnerName: migration.target_owner_name,
    targetGeneration: migration.target_generation,
    sourceIntentToken: requireStringField(migration, 'source_intent_token'),
    terminalVersionSha256,
    expectedChunkHashes,
    now,
  });
  const sourceMarked = await source.archiveSourceMarkTargetSealed({
    sessionId: migration.session_id,
    migrationId: migration.migration_id,
    sourceIntentToken: requireStringField(migration, 'source_intent_token'),
    targetAggregateSha256: sealed.aggregateSha256,
    now,
  });
  if (!sourceMarked) {
    const local = await inspectSourceIntent(source, migration);
    if (
      !local.exists ||
      !['target_sealed', 'recovery_manifest_persisted', 'source_deleted'].includes(local.state) ||
      local.targetAggregateSha256 !== sealed.aggregateSha256
    ) {
      throw new ProjectDataArchiveCoordinatorStateError(
        'source_target_seal_mark_miss',
        `ProjectData archive migration ${migration.migration_id} could not persist source target-sealed proof`
      );
    }
  }
  return requireJournalCas(env, migration, {
    from: 'copying',
    to: 'target_sealed',
    now,
    fields: { targetAggregateSha256: sealed.aggregateSha256 },
  });
}

async function persistRecoveryManifest(
  env: Env,
  config: ArchiveCoordinatorConfig,
  r2: R2Bucket,
  source: DurableObjectStub<ProjectData>,
  target: DurableObjectStub<ProjectData>,
  migration: ClaimedMigrationRow,
  now: number
): Promise<ClaimedMigrationRow> {
  const targetInfo = await target.archiveTargetInspectSession(targetInspectInput(migration));
  const aggregateSha256 =
    targetInfo.aggregateSha256 ?? requireStringField(migration, 'target_aggregate_sha256');
  const terminalVersionSha256 =
    migration.terminal_version_sha256 ?? targetInfo.terminalVersionSha256;
  const recoveryManifestKey = manifestKey(config, migration);
  await putImmutableJson(
    r2,
    recoveryManifestKey,
    manifestForTarget(
      config,
      migration,
      terminalVersionSha256,
      aggregateSha256,
      targetInfo.chunks,
      now
    )
  );
  const sourceMarked = await source.archiveSourceMarkRecoveryManifestPersisted({
    sessionId: migration.session_id,
    migrationId: migration.migration_id,
    sourceIntentToken: requireStringField(migration, 'source_intent_token'),
    targetAggregateSha256: aggregateSha256,
    r2ManifestKey: recoveryManifestKey,
    now,
  });
  if (!sourceMarked) {
    const local = await inspectSourceIntent(source, migration);
    if (
      !local.exists ||
      !['recovery_manifest_persisted', 'source_deleted'].includes(local.state) ||
      local.targetAggregateSha256 !== aggregateSha256 ||
      local.r2ManifestKey !== recoveryManifestKey
    ) {
      throw new ProjectDataArchiveCoordinatorStateError(
        'source_recovery_manifest_mark_miss',
        `ProjectData archive migration ${migration.migration_id} could not persist source recovery-manifest proof`
      );
    }
  }
  return requireJournalCas(env, migration, {
    from: 'target_sealed',
    to: 'recovery_manifest_persisted',
    now,
    fields: { r2ManifestKey: recoveryManifestKey, targetAggregateSha256: aggregateSha256 },
  });
}

async function finalizeSourceAndPublish(
  env: Env,
  config: ArchiveCoordinatorConfig,
  source: DurableObjectStub<ProjectData>,
  migration: ClaimedMigrationRow,
  now: number
): Promise<{ migration: MigrationRow; recoveredCrashGap: boolean }> {
  await assertLeaseStillHeld(env, migration);
  await source.archiveSourceFinalizeDelete({
    projectId: migration.project_id,
    sessionId: migration.session_id,
    migrationId: migration.migration_id,
    sourceOwnerName: migration.source_owner_name,
    targetOwnerName: migration.target_owner_name,
    targetGeneration: migration.target_generation,
    sourceIntentToken: requireStringField(migration, 'source_intent_token'),
    expectedTerminalVersionSha256: requireStringField(migration, 'terminal_version_sha256'),
    targetAggregateSha256: requireStringField(migration, 'target_aggregate_sha256'),
    r2ManifestKey: requireStringField(migration, 'r2_manifest_key'),
    now,
    minTerminalAgeMs: config.sessionGraceMs,
  });
  const casOk = await casArchiveJournalState(env, {
    migrationId: migration.migration_id,
    from: 'recovery_manifest_persisted',
    to: 'source_deleted',
    now,
    fields: {
      targetAggregateSha256: requireStringField(migration, 'target_aggregate_sha256'),
      r2ManifestKey: requireStringField(migration, 'r2_manifest_key'),
    },
  });
  let sourceDeleted = await readMigrationOrThrow(env, migration.migration_id);
  if (!casOk) {
    const local = await inspectSourceIntent(source, migration);
    if (!local.exists || local.state !== 'source_deleted') {
      throw new ProjectDataArchiveCoordinatorStateError(
        'journal_cas_miss',
        `ProjectData archive migration ${migration.migration_id} failed CAS recovery_manifest_persisted -> source_deleted`
      );
    }
    sourceDeleted = await alignJournalToLocalSourceProof(env, migration, local, now);
  }
  if (sourceDeleted.state !== 'source_deleted' && sourceDeleted.state !== 'published') {
    throw new ProjectDataArchiveCoordinatorStateError(
      'journal_cas_miss',
      `ProjectData archive migration ${migration.migration_id} did not reach source_deleted after finalize`
    );
  }
  await publishSourceDeletedGap(env, sourceDeleted, now);
  return {
    migration: await readMigrationOrThrow(env, migration.migration_id),
    recoveredCrashGap: !casOk,
  };
}

async function migrateCandidate(
  env: Env,
  config: ArchiveCoordinatorConfig,
  r2: R2Bucket,
  selected: MigrationRow,
  now: number
): Promise<{
  migrated: boolean;
  recoveredCrashGap: boolean;
  chunksCopied: number;
  rowsCopied: number;
}> {
  let migration = await claimMigrationLease(env, selected, now, config.leaseMs);
  if (!migration) {
    return { migrated: false, recoveredCrashGap: false, chunksCopied: 0, rowsCopied: 0 };
  }
  const source = await ensureOwnerStub(env, migration.source_owner_name, migration.project_id);
  const target = await ensureOwnerStub(env, migration.target_owner_name, migration.project_id);
  let chunksCopied = 0;
  let rowsCopied = 0;

  const local = await inspectSourceIntent(source, migration);
  migration = await alignJournalToLocalSourceProof(env, migration, local, now);
  if (migration.state === 'source_deleted') {
    await publishSourceDeletedGap(env, migration, now);
    return { migrated: true, recoveredCrashGap: true, chunksCopied, rowsCopied };
  }
  if (migration.state === 'published') {
    await publishArchivedLocation(env, migration, now);
    return { migrated: true, recoveredCrashGap: true, chunksCopied, rowsCopied };
  }

  const preparedResult = await ensureSourcePrepared(env, config, source, migration, now);
  migration = preparedResult.migration;
  const prepared = preparedResult.prepared;

  migration = await ensureTargetPrepared(env, target, migration, prepared, now);
  migration = await enterCopying(env, migration, now);

  if (migration.state === 'copying') {
    const copyResult = await copySourceChunks(source, target, config, r2, migration, now);
    chunksCopied += copyResult.chunksCopied;
    rowsCopied += copyResult.rowsCopied;
    migration = await sealTargetAndSource(
      env,
      source,
      target,
      migration,
      prepared.terminalVersionSha256,
      copyResult.chunkHashes,
      now
    );
  }

  if (migration.state === 'target_sealed') {
    migration = await persistRecoveryManifest(env, config, r2, source, target, migration, now);
  }

  if (migration.state === 'recovery_manifest_persisted') {
    const finalized = await finalizeSourceAndPublish(env, config, source, migration, now);
    migration = finalized.migration as ClaimedMigrationRow;
    return {
      migrated: migration.state === 'published',
      recoveredCrashGap: finalized.recoveredCrashGap,
      chunksCopied,
      rowsCopied,
    };
  }

  if (migration.state === 'source_deleted') {
    await publishSourceDeletedGap(env, migration, now);
    return { migrated: true, recoveredCrashGap: true, chunksCopied, rowsCopied };
  }

  return {
    migrated: migration.state === 'published',
    recoveredCrashGap: false,
    chunksCopied,
    rowsCopied,
  };
}

async function markFailed(
  env: Env,
  config: ArchiveCoordinatorConfig,
  migration: MigrationRow,
  now: number,
  error: unknown
): Promise<'failed' | 'poisoned' | 'unchanged'> {
  const current = await readMigration(env, migration.migration_id);
  if (!current || ['source_deleted', 'published', 'poisoned', 'frozen'].includes(current.state)) {
    return 'unchanged';
  }
  if (current.attempt_count >= config.poisonAfterAttempts) {
    await poisonProjectDataArchiveMigration(env, {
      migrationId: current.migration_id,
      projectId: current.project_id,
      reason: `attempts_exhausted:${errorCode(error)}`,
      message: errorMessage(error),
      now,
    });
    return 'poisoned';
  }
  await env.DATABASE.prepare(
    `UPDATE project_data_archive_migrations
     SET state = 'failed',
         error_code = ?,
         error_message = ?,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = ?
     WHERE migration_id = ?
       AND state NOT IN ('source_deleted', 'published', 'poisoned', 'frozen')`
  )
    .bind(errorCode(error), errorMessage(error), now, current.migration_id)
    .run();
  return 'failed';
}

export async function freezeProjectDataArchiveMigration(
  env: Env,
  input: {
    migrationId: string;
    projectId: string;
    reason: string;
    now?: number;
  }
): Promise<boolean> {
  const now = input.now ?? Date.now();
  const result = await env.DATABASE.prepare(
    `UPDATE project_data_archive_migrations
     SET state = 'frozen',
         error_code = 'operator_frozen',
         error_message = ?,
         lease_owner = NULL,
         lease_expires_at = NULL,
         frozen_at = COALESCE(frozen_at, ?),
         updated_at = ?
     WHERE migration_id = ?
       AND project_id = ?
       AND state NOT IN ('source_deleted', 'published', 'poisoned', 'frozen')`
  )
    .bind(input.reason, now, now, input.migrationId, input.projectId)
    .run();
  const changed = (result.meta.changes ?? 0) > 0;
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE project_data_session_locations
       SET location_state = 'frozen',
           updated_at = ?
       WHERE migration_id = ?
         AND project_id = ?
         AND location_state = 'migrating'`
    ).bind(now, input.migrationId, input.projectId),
    env.DATABASE.prepare(
      `INSERT INTO project_data_archive_circuit_breakers (project_id, state, reason, opened_at, updated_at)
       VALUES (?, 'frozen', ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         state = 'frozen',
         reason = excluded.reason,
         opened_at = COALESCE(project_data_archive_circuit_breakers.opened_at, excluded.opened_at),
         updated_at = excluded.updated_at`
    ).bind(input.projectId, input.reason, now, now),
  ]);
  return changed;
}

export async function poisonProjectDataArchiveMigration(
  env: Env,
  input: {
    migrationId: string;
    projectId: string;
    reason: string;
    message?: string;
    now?: number;
  }
): Promise<boolean> {
  const now = input.now ?? Date.now();
  const result = await env.DATABASE.prepare(
    `UPDATE project_data_archive_migrations
     SET state = 'poisoned',
         error_code = ?,
         error_message = ?,
         lease_owner = NULL,
         lease_expires_at = NULL,
         poisoned_at = COALESCE(poisoned_at, ?),
         updated_at = ?
     WHERE migration_id = ?
       AND project_id = ?
       AND state NOT IN ('source_deleted', 'published', 'poisoned')`
  )
    .bind(input.reason, input.message ?? input.reason, now, now, input.migrationId, input.projectId)
    .run();
  const changed = (result.meta.changes ?? 0) > 0;
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE project_data_session_locations
       SET location_state = 'frozen',
           updated_at = ?
       WHERE migration_id = ?
         AND project_id = ?
         AND location_state = 'migrating'`
    ).bind(now, input.migrationId, input.projectId),
    env.DATABASE.prepare(
      `INSERT INTO project_data_archive_circuit_breakers (project_id, state, reason, opened_at, updated_at)
       VALUES (?, 'open', ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         state = 'open',
         reason = excluded.reason,
         opened_at = COALESCE(project_data_archive_circuit_breakers.opened_at, excluded.opened_at),
         updated_at = excluded.updated_at`
    ).bind(input.projectId, input.reason, now, now),
  ]);
  return changed;
}

export async function inspectFrozenProjectDataArchiveIntents(
  env: Env,
  input: {
    projectId?: string;
    limit?: number;
  } = {}
): Promise<ProjectDataArchiveFrozenIntentInspection[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const projectPredicate = input.projectId ? 'AND m.project_id = ?' : '';
  const rows = await env.DATABASE.prepare(
    `SELECT m.migration_id, m.project_id, m.session_id, m.state, m.source_owner_name,
            m.target_owner_name, m.target_generation, m.source_intent_token,
            m.terminal_version_sha256, m.target_aggregate_sha256, m.r2_manifest_key,
            m.lease_owner, m.lease_epoch, m.lease_expires_at, m.attempt_count,
            loc.location_state, breaker.state AS breaker_state
     FROM project_data_archive_migrations m
     LEFT JOIN project_data_session_locations loc
       ON loc.project_id = m.project_id AND loc.session_id = m.session_id
     LEFT JOIN project_data_archive_circuit_breakers breaker
       ON breaker.project_id = m.project_id
     WHERE (m.state IN ('failed', 'poisoned', 'frozen') OR loc.location_state = 'frozen')
       ${projectPredicate}
     ORDER BY m.updated_at ASC
     LIMIT ?`
  )
    .bind(...(input.projectId ? [input.projectId] : []), limit)
    .all<MigrationRow & { location_state: string | null; breaker_state: string | null }>();

  const inspections: ProjectDataArchiveFrozenIntentInspection[] = [];
  for (const row of rows.results ?? []) {
    const source = ownerStub(env, row.source_owner_name);
    const target = ownerStub(env, row.target_owner_name);
    let sourceIntent: ProjectDataArchiveFrozenIntentInspection['sourceIntent'];
    let targetInfo: ProjectDataArchiveFrozenIntentInspection['target'];
    try {
      const inspected = await source.archiveSourceInspectIntent(sourceInspectInput(row));
      sourceIntent = inspected.exists
        ? {
            exists: true,
            state: inspected.state,
            terminalVersionSha256: inspected.terminalVersionSha256,
            targetAggregateSha256: inspected.targetAggregateSha256,
            r2ManifestKey: inspected.r2ManifestKey,
            messageCount: inspected.messageCount,
            sourceDeletedAt: inspected.sourceDeletedAt,
            databaseSizeBeforeBytes: inspected.databaseSizeBeforeBytes,
            databaseSizeAfterBytes: inspected.databaseSizeAfterBytes,
            databaseSizeBytes: inspected.databaseSizeBytes,
          }
        : inspected;
    } catch (error) {
      sourceIntent = { exists: null, error: errorMessage(error) };
    }
    try {
      const inspected = await target.archiveTargetInspectSession(targetInspectInput(row));
      targetInfo = {
        exists: true,
        state: inspected.state,
        terminalVersionSha256: inspected.terminalVersionSha256,
        aggregateSha256: inspected.aggregateSha256,
        messageCount: inspected.messageCount,
        chunks: inspected.chunks.length,
        databaseSizeBytes: inspected.databaseSizeBytes,
      };
    } catch (error) {
      targetInfo = { exists: null, error: errorMessage(error) };
    }
    inspections.push({
      migrationId: row.migration_id,
      projectId: row.project_id,
      sessionId: row.session_id,
      journalState: row.state,
      locationState: row.location_state,
      breakerState: row.breaker_state,
      sourceIntent,
      target: targetInfo,
    });
  }
  return inspections;
}

export async function copyBackProjectDataArchiveMigration(
  env: Env,
  input: {
    migrationId: string;
    projectId: string;
    now?: number;
  }
): Promise<ProjectDataArchiveCopyBackResult> {
  const now = input.now ?? Date.now();
  const config = resolveConfig(env);
  const migration = await readMigrationOrThrow(env, input.migrationId);
  if (migration.project_id !== input.projectId) {
    throw new ProjectDataArchiveCoordinatorStateError(
      'migration_project_mismatch',
      `ProjectData archive migration ${input.migrationId} does not belong to project ${input.projectId}`
    );
  }
  const source = await ensureOwnerStub(env, migration.source_owner_name, migration.project_id);
  const target = await ensureOwnerStub(env, migration.target_owner_name, migration.project_id);
  const sourceIntent = await inspectSourceIntent(source, migration);
  if (!sourceIntent.exists || sourceIntent.state !== 'source_deleted') {
    throw new ProjectDataArchiveCoordinatorStateError(
      'copy_back_requires_source_deleted',
      `ProjectData archive migration ${migration.migration_id} cannot copy back before source deletion proof`
    );
  }
  const targetInfo = await target.archiveTargetInspectSession(targetInspectInput(migration));
  if (!targetInfo.aggregateSha256) {
    throw new ProjectDataArchiveCoordinatorStateError(
      'copy_back_target_not_sealed',
      `ProjectData archive migration ${migration.migration_id} target is missing aggregate proof`
    );
  }

  let chunksCopied = 0;
  let rowsCopied = 0;
  for (const tableName of PROJECT_DATA_ARCHIVE_TABLES) {
    let cursor: string | null = null;
    let ordinal = 0;
    do {
      const chunk = await target.archiveTargetExportChunk({
        projectId: migration.project_id,
        sessionId: migration.session_id,
        migrationId: migration.migration_id,
        targetOwnerName: migration.target_owner_name,
        targetGeneration: migration.target_generation,
        tableName,
        ordinal,
        cursor,
        maxRows: config.chunkRows,
        maxBytes: config.chunkBytes,
      });
      await source.archiveSourceRestoreChunk({
        ...chunk,
        sourceOwnerName: migration.source_owner_name,
        targetOwnerName: migration.target_owner_name,
        targetGeneration: migration.target_generation,
        sourceIntentToken: sourceIntent.sourceIntentToken,
        now,
      });
      chunksCopied++;
      rowsCopied += chunk.rowCount;
      cursor = chunk.hasMore ? chunk.cursor : null;
      ordinal++;
    } while (cursor);
  }
  const restored = await source.archiveSourceMarkCopyBackRestored({
    projectId: migration.project_id,
    sessionId: migration.session_id,
    migrationId: migration.migration_id,
    sourceOwnerName: migration.source_owner_name,
    targetOwnerName: migration.target_owner_name,
    targetGeneration: migration.target_generation,
    sourceIntentToken: sourceIntent.sourceIntentToken,
    expectedTerminalVersionSha256: sourceIntent.terminalVersionSha256,
    now,
  });
  if (!restored) {
    throw new ProjectDataArchiveCoordinatorStateError(
      'copy_back_restore_mark_miss',
      `ProjectData archive migration ${migration.migration_id} source copy-back mark failed`
    );
  }
  await target.archiveTargetMarkRehomeExported({
    projectId: migration.project_id,
    sessionId: migration.session_id,
    migrationId: migration.migration_id,
    targetOwnerName: migration.target_owner_name,
    targetGeneration: migration.target_generation,
    now,
  });
  const locationResult = await env.DATABASE.prepare(
    `UPDATE project_data_session_locations
     SET location_state = 'root',
         owner_kind = 'root',
         owner_name = ?,
         generation = 0,
         migration_id = NULL,
         target_aggregate_sha256 = NULL,
         updated_at = ?
     WHERE project_id = ?
       AND session_id = ?
       AND (migration_id = ? OR owner_name = ?)`
  )
    .bind(
      migration.source_owner_name,
      now,
      migration.project_id,
      migration.session_id,
      migration.migration_id,
      migration.target_owner_name
    )
    .run();
  await env.DATABASE.prepare(
    `UPDATE project_data_archive_migrations
     SET state = 'frozen',
         error_code = 'copy_back_restored',
         error_message = 'Archive copy-back restored source rows and routed session back to root',
         lease_owner = NULL,
         lease_expires_at = NULL,
         frozen_at = COALESCE(frozen_at, ?),
         updated_at = ?
     WHERE migration_id = ?`
  )
    .bind(now, now, migration.migration_id)
    .run();
  return {
    migrationId: migration.migration_id,
    projectId: migration.project_id,
    sessionId: migration.session_id,
    chunksCopied,
    rowsCopied,
    restoredToRoot: (locationResult.meta.changes ?? 0) > 0,
  };
}

export async function rehomeProjectDataArchiveMigration(
  env: Env,
  input: {
    migrationId: string;
    projectId: string;
    now?: number;
  }
): Promise<ProjectDataArchiveCopyBackResult> {
  return copyBackProjectDataArchiveMigration(env, input);
}

function recordMigrationFailure(
  stats: ProjectDataArchiveShardingStats,
  failureState: 'failed' | 'poisoned' | 'unchanged'
): void {
  if (failureState === 'poisoned') stats.poisoned++;
  else stats.failed++;
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
  const crashGapRecovery = await recoverCrashGaps(env, config, now);
  stats.recoveredCrashGaps = crashGapRecovery.recovered;
  stats.failed += crashGapRecovery.failed;
  const candidates = await selectMigrationWork(env, config, nowDate, now);
  stats.selected = candidates.length;
  for (const migration of candidates) {
    if (Date.now() - startedAt >= config.wallTimeMs) break;
    try {
      const result = await migrateCandidate(env, config, archiveR2, migration, now);
      if (result.migrated) stats.migrated++;
      if (result.recoveredCrashGap) stats.recoveredCrashGaps++;
      stats.chunksCopied += result.chunksCopied;
      stats.rowsCopied += result.rowsCopied;
    } catch (error) {
      const failureState = await markFailed(env, config, migration, now, error).catch(
        (markError) => {
          log.error('project_data_archive_mark_failed_failed', {
            migrationId: migration.migration_id,
            ...serializeError(markError),
          });
          return 'unchanged' as const;
        }
      );
      recordMigrationFailure(stats, failureState);
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
