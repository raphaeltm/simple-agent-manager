// FILE SIZE EXCEPTION: Cross-store lease, R2 evidence, recovery, and publish transitions remain co-located so the destructive ordering can be audited as one external coordinator state machine.
import type {
  ArchiveChunkManifestEntry,
  ArchiveRehomeSourceFence,
  ArchiveRpcFence,
} from '../durable-objects/project-data/archive-sharding';
import {
  ARCHIVE_AGGREGATE_CHAIN_SEED,
  archiveCanonicalBytes,
  extendCanonicalAggregateHash,
  sha256Hex,
} from '../durable-objects/project-data/archive-sharding-canonical';
import { resolveStorageSafetyConfig } from '../durable-objects/project-data/storage-safety';
import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';
import { persistError } from '../services/observability';
import * as projectData from '../services/project-data';
import {
  buildArchiveShardOwnerName,
  MAX_PROJECT_DATA_ARCHIVE_CHUNK_BYTES,
  MAX_PROJECT_DATA_ARCHIVE_CHUNK_MAX_ROWS_HARD_LIMIT,
  MAX_PROJECT_DATA_ARCHIVE_MAX_CHUNKS_HARD_LIMIT,
  type ProjectDataArchiveShardingConfig,
  resolveArchiveShardingConfig,
} from '../services/project-data-archive-types';

const log = createModuleLogger('project_data_archive_sharding');
const TABLES = ['chat_messages', 'chat_messages_grouped', 'tool_payload_archives'] as const;
const MAX_RECOVERY_ROOT_MANIFEST_BYTES = 256 * 1024;
const MAX_RECOVERY_MANIFEST_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_RECOVERY_MANIFEST_PAGES = 100_000;
const MAX_RECOVERY_MANIFEST_ENTRIES = 10_000_000;
const ARCHIVE_SWEEP_FAILURE_IO_RESERVE = 4;
const ARCHIVE_SWEEP_CANDIDATE_IO_RESERVE = 7;
const ARCHIVE_SWEEP_RECONCILE_IO_RESERVE = 8;

type JournalRow = {
  migration_id: string;
  project_id: string;
  session_id: string;
  state: string;
  source_owner_name: string;
  source_generation: number;
  target_owner_name: string;
  target_generation: number;
  lease_token: string | null;
  lease_epoch: number;
  lease_expires_at: number | null;
  terminal_version: string;
  aggregate_hash: string | null;
  manifest_r2_key: string | null;
  next_table_name: string | null;
  next_chunk_index: number;
  next_row_key: string | null;
  failure_count: number;
  source_deleted_at: number | null;
  target_authoritative_at: number | null;
  recovery_verify_page_key: string | null;
  recovery_verify_page_index: number | null;
  recovery_verify_entry_index: number;
  recovery_verify_expected_hash: string | null;
  recovery_verify_entries_seen: number;
  recovery_verified_at: number | null;
  recovery_restore_page_key: string | null;
  recovery_restore_page_index: number | null;
  recovery_restore_entry_index: number;
  recovery_target_reset_at: number | null;
  target_cleanup_at: number | null;
};

type RecoveryRootManifest = {
  headPageKey: string | null;
  pageCount: number;
  entryCount: number;
  aggregateHash: string;
};

type RecoveryManifestPage = {
  pageIndex: number;
  previousPageKey: string | null;
  previousChainHash: string;
  aggregateHashAfterPage: string;
  entries: ArchiveChunkManifestEntry[];
};

type ArchiveSweepBudget = {
  deadlineMs: number;
  remainingIoOps: number;
};

function reserveSweepStage(
  budget: ArchiveSweepBudget,
  worstCaseIoOps: number,
  contingencyIoOps = 0
): boolean {
  if (Date.now() >= budget.deadlineMs || budget.remainingIoOps < worstCaseIoOps + contingencyIoOps)
    return false;
  budget.remainingIoOps -= worstCaseIoOps;
  return true;
}

async function persistArchiveOperatorAlert(
  env: Env,
  row: JournalRow,
  reason: 'circuit_opened' | 'migration_frozen' | 'published_target_frozen',
  error: string
): Promise<void> {
  if (!env.OBSERVABILITY_DATABASE) return;
  await persistError(
    env.OBSERVABILITY_DATABASE,
    {
      source: 'api',
      level: 'error',
      message: `ProjectData terminal archive ${reason.replaceAll('_', ' ')}`,
      context: {
        projectId: row.project_id,
        sessionId: row.session_id,
        migrationId: row.migration_id,
        sourceOwnerName: row.source_owner_name,
        sourceGeneration: row.source_generation,
        targetOwnerName: row.target_owner_name,
        targetGeneration: row.target_generation,
        reason,
        error,
      },
    },
    env
  );
}

function rehomeSourceFence(row: JournalRow, fence: ArchiveRpcFence): ArchiveRehomeSourceFence {
  return {
    ...fence,
    sourceOwnerName: row.source_owner_name,
    sourceGeneration: row.source_generation,
  };
}

export type ProjectDataArchiveSweepResult = {
  enabled: boolean;
  selected: number;
  progressed: number;
  archived: number;
  failed: number;
  frozen: number;
};

async function shardForSession(sessionId: string, shardCount: number): Promise<number> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionId))
  );
  const value = new DataView(digest.buffer).getUint32(0);
  return value % shardCount;
}

function recoveryPrefix(config: ProjectDataArchiveShardingConfig, row: JournalRow): string {
  return `${config.recoveryR2Prefix}/${encodeURIComponent(row.project_id)}/${encodeURIComponent(row.session_id)}/${encodeURIComponent(row.migration_id)}/from-${row.source_generation}-to-${row.target_generation}`;
}

function assertRecoveryObjectKey(
  config: ProjectDataArchiveShardingConfig,
  row: JournalRow,
  key: string,
  kind: 'manifest' | 'manifest page' | 'chunk'
): void {
  const prefix = recoveryPrefix(config, row);
  if (!key.startsWith(`${prefix}/`)) {
    throw new Error(`ProjectData archive recovery ${kind} key is outside its migration prefix`);
  }
  const relative = key.slice(prefix.length);
  const valid =
    kind === 'manifest'
      ? /^\/manifest-[0-9a-f]{64}\.json$/.test(relative)
      : kind === 'manifest page'
        ? /^\/manifest-page-[0-9]+-[0-9a-f]{64}\.json$/.test(relative)
        : /^\/(chat_messages|chat_messages_grouped|tool_payload_archives)\/[0-9]+-[0-9a-f]{64}\.json$/.test(
            relative
          );
  if (!valid) {
    throw new Error(`ProjectData archive recovery ${kind} key is outside its migration prefix`);
  }
}

async function putImmutableRecoveryObject(
  bucket: R2Bucket,
  key: string,
  body: Uint8Array,
  objectHash: string,
  customMetadata: Record<string, string>
): Promise<void> {
  if (body.byteLength > MAX_PROJECT_DATA_ARCHIVE_CHUNK_BYTES) {
    throw new Error('ProjectData archive immutable R2 object exceeds its protocol limit');
  }
  const existing = await bucket.get(key);
  if (existing) {
    if (existing.size !== body.byteLength) {
      throw new Error('ProjectData archive immutable R2 object byte length mismatch');
    }
    const existingHash = await sha256Hex(new Uint8Array(await existing.arrayBuffer()));
    if (existingHash !== objectHash || existing.customMetadata?.objectHash !== objectHash) {
      throw new Error('ProjectData archive immutable R2 object hash mismatch');
    }
    return;
  }
  await bucket.put(key, body, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { ...customMetadata, objectHash },
  });
  const persisted = await bucket.head(key);
  if (!persisted || persisted.customMetadata?.objectHash !== objectHash) {
    throw new Error('ProjectData archive immutable R2 object verification failed');
  }
}

async function planCandidate(
  env: Env,
  config: ProjectDataArchiveShardingConfig,
  now: number
): Promise<JournalRow | null> {
  const candidate = await env.DATABASE.prepare(
    `SELECT summary.project_id, summary.id AS session_id
       FROM session_summaries summary
       LEFT JOIN project_data_session_locations location
         ON location.project_id = summary.project_id AND location.session_id = summary.id
       LEFT JOIN project_data_archive_circuit_breakers breaker
         ON breaker.project_id = summary.project_id
       LEFT JOIN project_data_archive_candidate_deferrals deferral
         ON deferral.project_id = summary.project_id AND deferral.session_id = summary.id
      WHERE summary.status IN ('stopped', 'failed')
        AND summary.ended_at IS NOT NULL AND summary.ended_at <= ?
        AND location.session_id IS NULL
        AND (breaker.opened_until IS NULL OR breaker.opened_until <= ?)
        AND (deferral.session_id IS NULL OR
             (deferral.poisoned = 0 AND deferral.next_check_at <= ?))
      ORDER BY summary.ended_at, summary.project_id, summary.id LIMIT 1`
  )
    .bind(now - config.terminalGraceMs, now, now)
    .first<{ project_id: string; session_id: string }>();
  if (!candidate) return null;
  const eligibility = await projectData.inspectArchiveSourceEligibility(
    env,
    candidate.project_id,
    candidate.session_id,
    now,
    config.terminalGraceMs
  );
  if (!eligibility.eligible || !eligibility.terminalVersion) {
    const reason = eligibility.reason ?? 'eligibility_unknown';
    const poisoned = reason === 'invalid_tool_metadata' || reason === 'session_missing';
    await env.DATABASE.prepare(
      `INSERT INTO project_data_archive_candidate_deferrals
       (project_id, session_id, reason, poisoned, next_check_at, check_count, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(project_id, session_id) DO UPDATE SET
         reason = excluded.reason,
         poisoned = excluded.poisoned,
         next_check_at = excluded.next_check_at,
         check_count = check_count + 1,
         updated_at = excluded.updated_at`
    )
      .bind(
        candidate.project_id,
        candidate.session_id,
        reason,
        poisoned ? 1 : 0,
        poisoned ? null : now + config.retryMaxMs,
        now
      )
      .run();
    return null;
  }
  const migrationId = crypto.randomUUID();
  const targetOwnerName = buildArchiveShardOwnerName(
    candidate.project_id,
    await shardForSession(candidate.session_id, config.shardCount)
  );
  try {
    await env.DATABASE.batch([
      env.DATABASE.prepare(
        `INSERT INTO project_data_session_locations
         (project_id, session_id, state, owner_kind, owner_name, generation,
          migration_id, routing_version, updated_at)
         VALUES (?, ?, 'migrating', 'root', ?, 0, ?, ?, ?)`
      ).bind(
        candidate.project_id,
        candidate.session_id,
        candidate.project_id,
        migrationId,
        config.routingVersion,
        now
      ),
      env.DATABASE.prepare(
        `INSERT INTO project_data_archive_migrations
         (migration_id, project_id, session_id, state, source_owner_name,
          source_generation, target_owner_name, target_generation, terminal_version,
          next_table_name, next_chunk_index, created_at, updated_at)
         VALUES (?, ?, ?, 'planned', ?, 0, ?, 1, ?, ?, 0, ?, ?)`
      ).bind(
        migrationId,
        candidate.project_id,
        candidate.session_id,
        candidate.project_id,
        targetOwnerName,
        eligibility.terminalVersion,
        TABLES[0],
        now,
        now
      ),
    ]);
  } catch (error) {
    log.info('project_data_archive_candidate_cas_lost', {
      projectId: candidate.project_id,
      sessionId: candidate.session_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  return env.DATABASE.prepare(
    'SELECT * FROM project_data_archive_migrations WHERE migration_id = ?'
  )
    .bind(migrationId)
    .first<JournalRow>();
}

async function selectRecoverableJournal(env: Env, now: number): Promise<JournalRow | null> {
  return env.DATABASE.prepare(
    `SELECT migration.* FROM project_data_archive_migrations migration
     LEFT JOIN project_data_archive_circuit_breakers breaker
       ON breaker.project_id = migration.project_id
     WHERE migration.state IN ('planned', 'copying', 'sealed', 'source_deleted', 'failed')
       AND (migration.next_attempt_at IS NULL OR migration.next_attempt_at <= ?)
       AND (migration.lease_expires_at IS NULL OR migration.lease_expires_at <= ?)
       AND (breaker.opened_until IS NULL OR breaker.opened_until <= ?)
     ORDER BY CASE migration.state WHEN 'source_deleted' THEN 0 WHEN 'sealed' THEN 1 ELSE 2 END,
              migration.updated_at, migration.migration_id LIMIT 1`
  )
    .bind(now, now, now)
    .first<JournalRow>();
}

async function claimJournal(
  env: Env,
  row: JournalRow,
  config: ProjectDataArchiveShardingConfig,
  now: number
): Promise<{ row: JournalRow; fence: ArchiveRpcFence } | null> {
  const token = crypto.randomUUID();
  const expiresAt = now + config.leaseMs;
  const claimed = await env.DATABASE.prepare(
    `UPDATE project_data_archive_migrations
        SET lease_token = ?, lease_epoch = lease_epoch + 1, lease_expires_at = ?,
            state = CASE WHEN state IN ('planned', 'failed') THEN 'copying' ELSE state END,
            next_attempt_at = NULL, updated_at = ?
      WHERE migration_id = ? AND state IN ('planned', 'copying', 'sealed', 'source_deleted', 'failed')
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`
  )
    .bind(token, expiresAt, now, row.migration_id, now)
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) return null;
  const refreshed = await env.DATABASE.prepare(
    'SELECT * FROM project_data_archive_migrations WHERE migration_id = ?'
  )
    .bind(row.migration_id)
    .first<JournalRow>();
  if (!refreshed || refreshed.lease_token !== token) return null;
  return {
    row: refreshed,
    fence: {
      projectId: refreshed.project_id,
      sessionId: refreshed.session_id,
      migrationId: refreshed.migration_id,
      ownerName: refreshed.target_owner_name,
      generation: refreshed.target_generation,
      leaseToken: token,
      leaseEpoch: refreshed.lease_epoch,
      leaseExpiresAt: expiresAt,
      terminalVersion: refreshed.terminal_version,
    },
  };
}

async function guardedJournalUpdate(
  env: Env,
  fence: ArchiveRpcFence,
  statement: string,
  values: unknown[]
): Promise<void> {
  const result = await env.DATABASE.prepare(statement)
    .bind(
      ...values,
      fence.migrationId,
      fence.leaseToken,
      fence.leaseEpoch,
      fence.leaseExpiresAt,
      Date.now()
    )
    .run();
  if ((result.meta.changes ?? 0) < 1)
    throw new Error('ProjectData archive D1 lease/fence was revoked');
}

async function renewJournalLease(
  env: Env,
  config: ProjectDataArchiveShardingConfig,
  fence: ArchiveRpcFence
): Promise<ArchiveRpcFence> {
  const now = Date.now();
  const leaseExpiresAt = now + config.leaseMs;
  const renewed = await env.DATABASE.prepare(
    `UPDATE project_data_archive_migrations
        SET lease_expires_at = ?, updated_at = ?
      WHERE migration_id = ? AND lease_token = ? AND lease_epoch = ?
        AND lease_expires_at = ? AND lease_expires_at > ?
        AND state IN ('copying', 'sealed', 'source_deleted')`
  )
    .bind(
      leaseExpiresAt,
      now,
      fence.migrationId,
      fence.leaseToken,
      fence.leaseEpoch,
      fence.leaseExpiresAt,
      now
    )
    .run();
  if ((renewed.meta.changes ?? 0) !== 1) {
    throw new Error('ProjectData archive D1 lease renewal was revoked');
  }
  return { ...fence, leaseExpiresAt };
}

async function releaseJournalLease(env: Env, fence: ArchiveRpcFence): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE project_data_archive_migrations SET lease_expires_at = 0, updated_at = ?
      WHERE migration_id = ? AND lease_token = ? AND lease_epoch = ?
        AND lease_expires_at = ? AND state IN ('copying', 'sealed', 'source_deleted')`
  )
    .bind(Date.now(), fence.migrationId, fence.leaseToken, fence.leaseEpoch, fence.leaseExpiresAt)
    .run();
}

async function synchronizeDistributedFence(
  env: Env,
  row: JournalRow,
  fence: ArchiveRpcFence
): Promise<void> {
  const rehomeFence = row.source_generation > 0 ? rehomeSourceFence(row, fence) : null;
  const proof = rehomeFence
    ? await projectData.inspectArchiveRehomeSourceProof(env, rehomeFence)
    : await projectData.inspectArchiveSourceProof(env, row.project_id, row.session_id);
  if (proof.state === 'source_deleted') {
    if (row.next_table_name === 'recovery_restore') {
      const anchor = await projectData.getArchiveSourceSessionAnchor(
        env,
        row.project_id,
        row.session_id
      );
      await projectData.prepareArchiveTarget(env, fence, anchor);
    }
    return;
  }
  const anchor = rehomeFence
    ? await projectData.getArchiveRehomeSourceSessionAnchor(env, rehomeFence)
    : await projectData.getArchiveSourceSessionAnchor(env, row.project_id, row.session_id);
  if (rehomeFence) {
    await projectData.establishArchiveRehomeSourceIntent(env, rehomeFence);
  } else {
    await projectData.establishArchiveSourceIntent(env, fence);
  }
  await projectData.prepareArchiveTarget(env, fence, anchor);
}

async function readHashedRecoveryObject(
  env: Env,
  key: string,
  kind: string,
  maxBytes: number
): Promise<Record<string, unknown>> {
  const object = await env.PROJECT_DATA_ARCHIVE_R2.get(key);
  if (!object) throw new Error(`ProjectData archive recovery ${kind} is missing`);
  if (object.size > maxBytes) {
    throw new Error(`ProjectData archive recovery ${kind} exceeds its protocol byte limit`);
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  const objectHash = await sha256Hex(bytes);
  if (object.customMetadata?.objectHash !== objectHash) {
    throw new Error(`ProjectData archive recovery ${kind} hash mismatch`);
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${kind} is not an object`);
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`ProjectData archive recovery ${kind} is malformed`);
  }
}

function parseRecoveryEntry(value: unknown): ArchiveChunkManifestEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ProjectData archive recovery chunk entry is malformed');
  }
  const entry = value as Record<string, unknown>;
  if (
    !TABLES.includes(entry.table as (typeof TABLES)[number]) ||
    !Number.isSafeInteger(entry.chunkIndex) ||
    !Number.isSafeInteger(entry.rowCount) ||
    !Number.isSafeInteger(entry.canonicalBytes) ||
    typeof entry.hash !== 'string' ||
    typeof entry.r2Key !== 'string'
  ) {
    throw new Error('ProjectData archive recovery chunk receipt is malformed');
  }
  return {
    table: entry.table as (typeof TABLES)[number],
    chunkIndex: entry.chunkIndex as number,
    rowCount: entry.rowCount as number,
    canonicalBytes: entry.canonicalBytes as number,
    hash: entry.hash,
    r2Key: entry.r2Key,
  };
}

async function readRecoveryManifest(
  env: Env,
  config: ProjectDataArchiveShardingConfig,
  row: JournalRow,
  aggregateHash: string,
  manifestR2Key: string
): Promise<RecoveryRootManifest> {
  assertRecoveryObjectKey(config, row, manifestR2Key, 'manifest');
  const manifest = await readHashedRecoveryObject(
    env,
    manifestR2Key,
    'manifest',
    MAX_RECOVERY_ROOT_MANIFEST_BYTES
  );
  if (
    manifest.version !== 2 ||
    manifest.projectId !== row.project_id ||
    manifest.sessionId !== row.session_id ||
    manifest.migrationId !== row.migration_id ||
    manifest.sourceOwnerName !== row.source_owner_name ||
    manifest.sourceGeneration !== row.source_generation ||
    manifest.targetOwnerName !== row.target_owner_name ||
    manifest.targetGeneration !== row.target_generation ||
    manifest.terminalVersion !== row.terminal_version ||
    manifest.aggregateHash !== aggregateHash
  ) {
    throw new Error('ProjectData archive recovery manifest identity mismatch');
  }
  if (
    (manifest.headPageKey !== null && typeof manifest.headPageKey !== 'string') ||
    !Number.isSafeInteger(manifest.pageCount) ||
    !Number.isSafeInteger(manifest.entryCount) ||
    (manifest.pageCount as number) < 0 ||
    (manifest.entryCount as number) < 0 ||
    (manifest.pageCount as number) > MAX_RECOVERY_MANIFEST_PAGES ||
    (manifest.entryCount as number) > MAX_RECOVERY_MANIFEST_ENTRIES ||
    ((manifest.pageCount as number) === 0) !== (manifest.headPageKey === null)
  ) {
    throw new Error('ProjectData archive recovery manifest coverage is malformed');
  }
  return {
    headPageKey: manifest.headPageKey as string | null,
    pageCount: manifest.pageCount as number,
    entryCount: manifest.entryCount as number,
    aggregateHash,
  };
}

async function readRecoveryManifestPage(
  env: Env,
  config: ProjectDataArchiveShardingConfig,
  row: JournalRow,
  pageKey: string
): Promise<RecoveryManifestPage> {
  assertRecoveryObjectKey(config, row, pageKey, 'manifest page');
  const page = await readHashedRecoveryObject(
    env,
    pageKey,
    'manifest page',
    MAX_RECOVERY_MANIFEST_PAGE_BYTES
  );
  if (
    page.version !== 2 ||
    page.projectId !== row.project_id ||
    page.sessionId !== row.session_id ||
    page.migrationId !== row.migration_id ||
    page.sourceGeneration !== row.source_generation ||
    page.targetGeneration !== row.target_generation ||
    !Number.isSafeInteger(page.pageIndex) ||
    (page.previousPageKey !== null && typeof page.previousPageKey !== 'string') ||
    typeof page.previousChainHash !== 'string' ||
    typeof page.aggregateHashAfterPage !== 'string' ||
    !Array.isArray(page.entries) ||
    page.entries.length === 0 ||
    page.entries.length > MAX_PROJECT_DATA_ARCHIVE_MAX_CHUNKS_HARD_LIMIT
  ) {
    throw new Error('ProjectData archive recovery manifest page identity is malformed');
  }
  if (typeof page.previousPageKey === 'string') {
    assertRecoveryObjectKey(config, row, page.previousPageKey, 'manifest page');
  }
  const entries = page.entries.map(parseRecoveryEntry);
  for (const entry of entries) assertRecoveryObjectKey(config, row, entry.r2Key, 'chunk');
  const computed = await extendCanonicalAggregateHash(page.previousChainHash, entries);
  if (computed !== page.aggregateHashAfterPage) {
    throw new Error('ProjectData archive recovery manifest page aggregate mismatch');
  }
  return {
    pageIndex: page.pageIndex as number,
    previousPageKey: page.previousPageKey as string | null,
    previousChainHash: page.previousChainHash,
    aggregateHashAfterPage: page.aggregateHashAfterPage,
    entries,
  };
}

async function readRecoveryChunkRows(
  env: Env,
  config: ProjectDataArchiveShardingConfig,
  row: JournalRow,
  entry: ArchiveChunkManifestEntry
): Promise<Record<string, unknown>[]> {
  assertRecoveryObjectKey(config, row, entry.r2Key, 'chunk');
  const chunkObject = await env.PROJECT_DATA_ARCHIVE_R2.get(entry.r2Key);
  if (!chunkObject) throw new Error('ProjectData archive recovery chunk is missing');
  if (
    entry.canonicalBytes < 0 ||
    entry.canonicalBytes > MAX_PROJECT_DATA_ARCHIVE_CHUNK_BYTES ||
    entry.rowCount < 0 ||
    entry.rowCount > MAX_PROJECT_DATA_ARCHIVE_CHUNK_MAX_ROWS_HARD_LIMIT ||
    chunkObject.size !== entry.canonicalBytes
  ) {
    throw new Error('ProjectData archive recovery chunk exceeds its protocol limits');
  }
  const chunkBytes = new Uint8Array(await chunkObject.arrayBuffer());
  if (
    chunkBytes.byteLength !== entry.canonicalBytes ||
    (await sha256Hex(chunkBytes)) !== entry.hash ||
    chunkObject.customMetadata?.objectHash !== entry.hash
  ) {
    throw new Error('ProjectData archive recovery chunk hash/byte mismatch');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(chunkBytes));
  } catch {
    throw new Error('ProjectData archive recovery chunk body is malformed');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ProjectData archive recovery chunk body is malformed');
  }
  const body = parsed as Record<string, unknown>;
  const rows = body.rows;
  if (
    body.table !== entry.table ||
    !Array.isArray(rows) ||
    rows.length !== entry.rowCount ||
    rows.some((item) => !item || typeof item !== 'object' || Array.isArray(item))
  ) {
    throw new Error('ProjectData archive recovery chunk rows are malformed');
  }
  return rows as Record<string, unknown>[];
}

async function verifyNextRecoveryEvidence(
  env: Env,
  config: ProjectDataArchiveShardingConfig,
  row: JournalRow,
  fence: ArchiveRpcFence,
  aggregateHash: string,
  manifestR2Key: string
): Promise<boolean> {
  const manifest = await readRecoveryManifest(env, config, row, aggregateHash, manifestR2Key);
  if (row.recovery_verified_at !== null) return true;
  const pageKey = row.recovery_verify_page_key ?? manifest.headPageKey;
  const pageIndex = row.recovery_verify_page_index ?? manifest.pageCount - 1;
  const expectedHash = row.recovery_verify_expected_hash ?? manifest.aggregateHash;
  if (!pageKey) {
    if (
      manifest.entryCount !== 0 ||
      manifest.pageCount !== 0 ||
      aggregateHash !== ARCHIVE_AGGREGATE_CHAIN_SEED
    ) {
      throw new Error('ProjectData archive empty recovery manifest is inconsistent');
    }
    await guardedJournalUpdate(
      env,
      fence,
      `UPDATE project_data_archive_migrations
          SET recovery_verify_page_index = -1, recovery_verify_expected_hash = ?,
              recovery_verified_at = ?, updated_at = ?
        WHERE migration_id = ? AND lease_token = ? AND lease_epoch = ?
          AND lease_expires_at = ? AND lease_expires_at > ? AND state = 'sealed'
          AND recovery_verified_at IS NULL`,
      [ARCHIVE_AGGREGATE_CHAIN_SEED, Date.now(), Date.now()]
    );
    return false;
  }
  const page = await readRecoveryManifestPage(env, config, row, pageKey);
  if (page.pageIndex !== pageIndex || page.aggregateHashAfterPage !== expectedHash) {
    throw new Error('ProjectData archive recovery verification chain mismatch');
  }
  const entryIndex = row.recovery_verify_entry_index;
  const entry = page.entries[entryIndex];
  if (!entry) throw new Error('ProjectData archive recovery verification cursor is invalid');
  await readRecoveryChunkRows(env, config, row, entry);
  const pageComplete = entryIndex + 1 === page.entries.length;
  const allComplete = pageComplete && page.previousPageKey === null;
  const entriesSeen = row.recovery_verify_entries_seen + 1;
  if (
    allComplete &&
    (pageIndex !== 0 ||
      page.previousChainHash !== ARCHIVE_AGGREGATE_CHAIN_SEED ||
      entriesSeen !== manifest.entryCount)
  ) {
    throw new Error('ProjectData archive recovery verification coverage mismatch');
  }
  await guardedJournalUpdate(
    env,
    fence,
    `UPDATE project_data_archive_migrations
        SET recovery_verify_page_key = ?, recovery_verify_page_index = ?,
            recovery_verify_entry_index = ?, recovery_verify_expected_hash = ?,
            recovery_verify_entries_seen = ?, recovery_verified_at = ?, updated_at = ?
      WHERE migration_id = ? AND lease_token = ? AND lease_epoch = ?
        AND lease_expires_at = ? AND lease_expires_at > ? AND state = 'sealed'
        AND recovery_verified_at IS NULL`,
    [
      pageComplete ? page.previousPageKey : pageKey,
      pageComplete ? pageIndex - 1 : pageIndex,
      pageComplete ? 0 : entryIndex + 1,
      pageComplete ? page.previousChainHash : expectedHash,
      entriesSeen,
      allComplete ? Date.now() : null,
      Date.now(),
    ]
  );
  // Deletion occurs only on a later lease after the root manifest is reread.
  return false;
}

async function restoreNextRecoveryChunk(
  env: Env,
  config: ProjectDataArchiveShardingConfig,
  row: JournalRow,
  fence: ArchiveRpcFence
): Promise<{ sealed: boolean; aggregateHash: string; manifestR2Key: string }> {
  if (!row.aggregate_hash || !row.manifest_r2_key) {
    throw new Error('ProjectData archive forward-fix evidence is missing');
  }
  const manifest = await readRecoveryManifest(
    env,
    config,
    row,
    row.aggregate_hash,
    row.manifest_r2_key
  );
  if (row.recovery_target_reset_at === null) {
    await projectData.resetArchiveTargetFromRecovery(env, fence);
    await guardedJournalUpdate(
      env,
      fence,
      `UPDATE project_data_archive_migrations
          SET recovery_target_reset_at = ?, updated_at = ?
        WHERE migration_id = ? AND lease_token = ? AND lease_epoch = ?
          AND lease_expires_at = ? AND lease_expires_at > ? AND state = 'copying'
          AND recovery_target_reset_at IS NULL`,
      [Date.now(), Date.now()]
    );
    return {
      sealed: false,
      aggregateHash: row.aggregate_hash,
      manifestR2Key: row.manifest_r2_key,
    };
  }
  if (row.recovery_restore_page_index === -1) {
    if (row.next_chunk_index !== manifest.entryCount) {
      throw new Error('ProjectData archive forward-fix restored receipt count mismatch');
    }
    const sealed = await sealCopiedTarget(env, config, row, fence);
    return {
      sealed: Boolean(sealed),
      aggregateHash: row.aggregate_hash,
      manifestR2Key: row.manifest_r2_key,
    };
  }
  const pageKey = row.recovery_restore_page_key ?? manifest.headPageKey;
  const pageIndex = row.recovery_restore_page_index ?? manifest.pageCount - 1;
  if (!pageKey) {
    if (manifest.entryCount !== 0 || pageIndex !== -1) {
      throw new Error('ProjectData archive forward-fix manifest cursor is incomplete');
    }
    await guardedJournalUpdate(
      env,
      fence,
      `UPDATE project_data_archive_migrations
          SET recovery_restore_page_index = -1, updated_at = ?
        WHERE migration_id = ? AND lease_token = ? AND lease_epoch = ?
          AND lease_expires_at = ? AND lease_expires_at > ? AND state = 'copying'`,
      [Date.now()]
    );
    return {
      sealed: false,
      aggregateHash: row.aggregate_hash,
      manifestR2Key: row.manifest_r2_key,
    };
  }
  const page = await readRecoveryManifestPage(env, config, row, pageKey);
  const expectedHash = row.next_row_key ?? manifest.aggregateHash;
  if (page.pageIndex !== pageIndex || page.aggregateHashAfterPage !== expectedHash) {
    throw new Error('ProjectData archive forward-fix manifest chain mismatch');
  }
  const entryIndex = row.recovery_restore_entry_index;
  const entry = page.entries[entryIndex];
  if (!entry) {
    throw new Error('ProjectData archive forward-fix manifest entry cursor is invalid');
  }
  const rows = await readRecoveryChunkRows(env, config, row, entry);
  await projectData.commitArchiveTargetChunk(
    env,
    fence,
    {
      table: entry.table,
      chunkIndex: entry.chunkIndex,
      rows,
      rowCount: entry.rowCount,
      canonicalBytes: entry.canonicalBytes,
      canonicalHash: entry.hash,
      nextKey: null,
      done: true,
    },
    entry.r2Key
  );
  const pageComplete = entryIndex + 1 === page.entries.length;
  if (
    pageComplete &&
    page.previousPageKey === null &&
    page.previousChainHash !== ARCHIVE_AGGREGATE_CHAIN_SEED
  ) {
    throw new Error('ProjectData archive forward-fix manifest chain seed mismatch');
  }
  await guardedJournalUpdate(
    env,
    fence,
    `UPDATE project_data_archive_migrations
          SET next_chunk_index = next_chunk_index + 1,
              recovery_restore_page_key = ?, recovery_restore_page_index = ?,
              recovery_restore_entry_index = ?, next_row_key = ?, updated_at = ?
        WHERE migration_id = ? AND lease_token = ? AND lease_epoch = ?
          AND lease_expires_at = ? AND lease_expires_at > ? AND state = 'copying'`,
    [
      pageComplete ? page.previousPageKey : pageKey,
      pageComplete ? pageIndex - 1 : pageIndex,
      pageComplete ? 0 : entryIndex + 1,
      pageComplete ? page.previousChainHash : expectedHash,
      Date.now(),
    ]
  );
  return {
    sealed: false,
    aggregateHash: row.aggregate_hash,
    manifestR2Key: row.manifest_r2_key,
  };
}

async function copyBoundedChunks(
  env: Env,
  config: ProjectDataArchiveShardingConfig,
  row: JournalRow,
  fence: ArchiveRpcFence,
  budget: ArchiveSweepBudget
): Promise<{ complete: boolean; copied: number; budgetExhausted: boolean }> {
  const rehomeFence = row.source_generation > 0 ? rehomeSourceFence(row, fence) : null;
  // A null cursor is a durable copy-complete proof. Avoid a redundant target
  // inspection here so the 30-op envelope can still seal while retaining the
  // full failure-recording contingency.
  if (row.next_table_name === null) {
    return { complete: true, copied: 0, budgetExhausted: false };
  }
  if (!reserveSweepStage(budget, 2, ARCHIVE_SWEEP_FAILURE_IO_RESERVE)) {
    return { complete: false, copied: 0, budgetExhausted: true };
  }
  const target = await projectData.inspectArchiveTarget(env, fence);
  if (target.state === 'sealing' || target.state === 'sealed' || target.state === 'authoritative') {
    return { complete: true, copied: 0, budgetExhausted: false };
  }
  let tableIndex = Math.max(0, TABLES.indexOf(row.next_table_name as (typeof TABLES)[number]));
  let chunkIndex = row.next_chunk_index;
  let afterKey = row.next_row_key;
  let copied = 0;
  while (tableIndex < TABLES.length && copied < config.maxChunksPerSweep) {
    // Six operations conservatively cover source DO read, immutable R2
    // get-or-put-and-head, target DO commit, cursor CAS, and lease release.
    if (!reserveSweepStage(budget, 6, ARCHIVE_SWEEP_FAILURE_IO_RESERVE)) {
      return { complete: false, copied, budgetExhausted: true };
    }
    const table = TABLES[tableIndex];
    if (!table) break;
    const chunk = rehomeFence
      ? await projectData.readArchiveRehomeSourceChunk(
          env,
          rehomeFence,
          table,
          chunkIndex,
          afterKey,
          config.chunkMaxRows,
          config.chunkMaxBytes
        )
      : await projectData.readArchiveSourceChunk(
          env,
          fence,
          table,
          chunkIndex,
          afterKey,
          config.chunkMaxRows,
          config.chunkMaxBytes
        );
    const key = `${recoveryPrefix(config, row)}/${table}/${chunk.chunkIndex}-${chunk.canonicalHash}.json`;
    const chunkBytes = archiveCanonicalBytes(table, chunk.rows);
    await putImmutableRecoveryObject(
      env.PROJECT_DATA_ARCHIVE_R2,
      key,
      chunkBytes,
      chunk.canonicalHash,
      {
        projectId: row.project_id,
        sessionId: row.session_id,
        migrationId: row.migration_id,
        table,
        chunkIndex: String(chunk.chunkIndex),
        canonicalHash: chunk.canonicalHash,
      }
    );
    await projectData.commitArchiveTargetChunk(env, fence, chunk, key);
    copied++;
    if (chunk.done) {
      tableIndex++;
      chunkIndex = 0;
      afterKey = null;
    } else {
      chunkIndex++;
      afterKey = chunk.nextKey;
    }
    await guardedJournalUpdate(
      env,
      fence,
      `UPDATE project_data_archive_migrations
          SET next_table_name = ?, next_chunk_index = ?, next_row_key = ?, updated_at = ?
        WHERE migration_id = ? AND lease_token = ? AND lease_epoch = ?
          AND lease_expires_at = ? AND lease_expires_at > ? AND state = 'copying'`,
      [TABLES[tableIndex] ?? null, chunkIndex, afterKey, Date.now()]
    );
  }
  return {
    complete: tableIndex >= TABLES.length,
    copied,
    budgetExhausted: false,
  };
}

async function sealCopiedTarget(
  env: Env,
  config: ProjectDataArchiveShardingConfig,
  row: JournalRow,
  fence: ArchiveRpcFence
): Promise<{ aggregateHash: string; manifestR2Key: string } | null> {
  await projectData.beginArchiveTargetSealing(env, fence);
  const existingTarget = await projectData.inspectArchiveTarget(env, fence);
  if (existingTarget.state === 'sealed' || existingTarget.state === 'authoritative') {
    if (!existingTarget.aggregateHash || !existingTarget.manifestR2Key) {
      throw new Error('ProjectData pre-sealed archive target lacks immutable evidence');
    }
    if (row.next_table_name === 'recovery_restore') {
      await guardedJournalUpdate(
        env,
        fence,
        `UPDATE project_data_archive_migrations SET state = 'sealed', updated_at = ?
          WHERE migration_id = ? AND lease_token = ? AND lease_epoch = ?
            AND lease_expires_at = ? AND lease_expires_at > ? AND state = 'copying'`,
        [Date.now()]
      );
    } else {
      await guardedJournalUpdate(
        env,
        fence,
        `UPDATE project_data_archive_migrations
          SET state = 'sealed', aggregate_hash = ?, manifest_r2_key = ?, updated_at = ?
          WHERE migration_id = ? AND lease_token = ? AND lease_epoch = ?
            AND lease_expires_at = ? AND lease_expires_at > ? AND state = 'copying'`,
        [existingTarget.aggregateHash, existingTarget.manifestR2Key, Date.now()]
      );
    }
    return {
      aggregateHash: existingTarget.aggregateHash,
      manifestR2Key: existingTarget.manifestR2Key,
    };
  }
  const verification = await projectData.verifyNextArchiveTargetChunk(env, fence);
  if (!verification.done) return null;
  const page = await projectData.getNextArchiveTargetManifestPage(
    env,
    fence,
    config.maxChunksPerSweep
  );
  if (!page.done) {
    const aggregateHashAfterPage = await extendCanonicalAggregateHash(
      page.previousChainHash,
      page.entries
    );
    const pageBody = new TextEncoder().encode(
      JSON.stringify({
        version: 2,
        projectId: fence.projectId,
        sessionId: fence.sessionId,
        migrationId: fence.migrationId,
        sourceGeneration: row.source_generation,
        targetGeneration: fence.generation,
        pageIndex: page.pageIndex,
        previousPageKey: page.previousPageKey,
        previousChainHash: page.previousChainHash,
        aggregateHashAfterPage,
        entries: page.entries,
      })
    );
    const pageHash = await sha256Hex(pageBody);
    const pageR2Key = `${recoveryPrefix(config, row)}/manifest-page-${page.pageIndex}-${pageHash}.json`;
    await putImmutableRecoveryObject(env.PROJECT_DATA_ARCHIVE_R2, pageR2Key, pageBody, pageHash, {
      projectId: row.project_id,
      sessionId: row.session_id,
      migrationId: row.migration_id,
      pageIndex: String(page.pageIndex),
      aggregateHash: aggregateHashAfterPage,
    });
    await projectData.commitArchiveTargetManifestPage(
      env,
      fence,
      {
        pageIndex: page.pageIndex,
        previousPageKey: page.previousPageKey,
        previousChainHash: page.previousChainHash,
        entryCount: page.entryCount,
        entries: page.entries,
      },
      pageR2Key,
      aggregateHashAfterPage
    );
    return null;
  }
  const aggregateHash = page.previousChainHash;
  const manifestBody = new TextEncoder().encode(
    JSON.stringify({
      version: 2,
      projectId: fence.projectId,
      sessionId: fence.sessionId,
      migrationId: fence.migrationId,
      sourceOwnerName: row.source_owner_name,
      sourceGeneration: row.source_generation,
      targetOwnerName: fence.ownerName,
      targetGeneration: fence.generation,
      terminalVersion: fence.terminalVersion,
      aggregateHash,
      headPageKey: page.previousPageKey,
      pageCount: page.pageIndex,
      entryCount: page.entryCount,
    })
  );
  const manifestHash = await sha256Hex(manifestBody);
  const manifestR2Key = `${recoveryPrefix(config, row)}/manifest-${manifestHash}.json`;
  await putImmutableRecoveryObject(
    env.PROJECT_DATA_ARCHIVE_R2,
    manifestR2Key,
    manifestBody,
    manifestHash,
    {
      projectId: row.project_id,
      sessionId: row.session_id,
      migrationId: row.migration_id,
      aggregateHash,
    }
  );
  await projectData.sealArchiveTarget(env, fence, aggregateHash, manifestR2Key);
  if (row.next_table_name === 'recovery_restore') {
    await guardedJournalUpdate(
      env,
      fence,
      `UPDATE project_data_archive_migrations SET state = 'sealed', updated_at = ?
        WHERE migration_id = ? AND lease_token = ? AND lease_epoch = ?
          AND lease_expires_at = ? AND lease_expires_at > ? AND state = 'copying'`,
      [Date.now()]
    );
  } else {
    await guardedJournalUpdate(
      env,
      fence,
      `UPDATE project_data_archive_migrations
          SET state = 'sealed', aggregate_hash = ?, manifest_r2_key = ?, updated_at = ?
        WHERE migration_id = ? AND lease_token = ? AND lease_epoch = ?
          AND lease_expires_at = ? AND lease_expires_at > ? AND state = 'copying'`,
      [aggregateHash, manifestR2Key, Date.now()]
    );
  }
  return { aggregateHash, manifestR2Key };
}

async function publishSourceDeleted(
  env: Env,
  config: ProjectDataArchiveShardingConfig,
  row: JournalRow,
  fence: ArchiveRpcFence,
  aggregateHash: string,
  manifestR2Key: string
): Promise<void> {
  const storageLimit = resolveStorageSafetyConfig(env).limitBytes;
  const capacityLimit = Math.floor(storageLimit * config.rootCopyMaxRatio);
  const targetDatabaseSize = await projectData.getArchiveOwnerDatabaseSize(
    env,
    row.project_id,
    fence.ownerName
  );
  if (targetDatabaseSize > capacityLimit) {
    throw new Error('ProjectData archive target exceeds the configured capacity gate');
  }
  const rehomeFence = row.source_generation > 0 ? rehomeSourceFence(row, fence) : null;
  const proof = rehomeFence
    ? await projectData.inspectArchiveRehomeSourceProof(env, rehomeFence)
    : await projectData.inspectArchiveSourceProof(env, row.project_id, row.session_id);
  if (proof.state !== 'source_deleted') {
    if (rehomeFence) {
      await projectData.finalizeArchiveRehomeSource(env, rehomeFence, aggregateHash, manifestR2Key);
    } else {
      await projectData.finalizeArchiveSource(env, fence, aggregateHash, manifestR2Key);
    }
  } else if (
    proof.migrationId !== row.migration_id ||
    proof.aggregateHash !== aggregateHash ||
    proof.manifestR2Key !== manifestR2Key
  ) {
    throw new Error('ProjectData archive source_deleted proof mismatch');
  }
  await guardedJournalUpdate(
    env,
    fence,
    `UPDATE project_data_archive_migrations
        SET state = 'source_deleted', source_deleted_at = COALESCE(source_deleted_at, ?), updated_at = ?
      WHERE migration_id = ? AND lease_token = ? AND lease_epoch = ?
        AND lease_expires_at = ? AND lease_expires_at > ? AND state = 'sealed'`,
    [Date.now(), Date.now()]
  );
}

async function publishArchiveLocation(
  env: Env,
  row: JournalRow,
  fence: ArchiveRpcFence,
  aggregateHash: string
): Promise<void> {
  // Migration state and location pointer publish atomically through the D1
  // trigger installed by migration 0132.
  await guardedJournalUpdate(
    env,
    fence,
    `UPDATE project_data_archive_migrations
        SET state = 'archived', archived_at = ?, updated_at = ?
      WHERE migration_id = ? AND lease_token = ? AND lease_epoch = ?
        AND lease_expires_at = ? AND lease_expires_at > ? AND state = 'source_deleted'`,
    [Date.now(), Date.now()]
  );
  await projectData.markArchiveTargetAuthoritative(env, fence, aggregateHash);
  const authoritativeAt = Date.now();
  const authorityUpdate = await env.DATABASE.prepare(
    `UPDATE project_data_archive_migrations
        SET target_authoritative_at = ?,
            target_cleanup_at = CASE WHEN target_generation > 0 THEN ? ELSE NULL END,
            updated_at = ?
      WHERE migration_id = ? AND state = 'archived'`
  )
    .bind(authoritativeAt, authoritativeAt, authoritativeAt, row.migration_id)
    .run();
  if ((authorityUpdate.meta.changes ?? 0) < 1) {
    throw new Error('ProjectData archive target authority marker CAS was lost');
  }
  if (fence.ownerName === fence.projectId && fence.generation === 0) {
    await projectData.completeArchiveRootCopyback(
      env,
      fence,
      aggregateHash,
      resolveArchiveShardingConfig(env).routingVersion
    );
    const cleanedAt = Date.now();
    const cleanupUpdate = await env.DATABASE.prepare(
      `UPDATE project_data_archive_migrations SET target_cleanup_at = ?, updated_at = ?
        WHERE migration_id = ? AND state = 'archived'
          AND target_authoritative_at IS NOT NULL AND target_cleanup_at IS NULL`
    )
      .bind(cleanedAt, cleanedAt, row.migration_id)
      .run();
    if ((cleanupUpdate.meta.changes ?? 0) < 1) {
      throw new Error('ProjectData archive root cleanup marker CAS was lost');
    }
  }
}

function isIntegrityFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /hash mismatch|coverage mismatch|identity mismatch|terminal version changed|foreign session|receipt mismatch|malformed|recovery .* missing|immutable evidence|exceeds the configured RPC byte budget/i.test(
    message
  );
}

async function recordFailure(
  env: Env,
  config: ProjectDataArchiveShardingConfig,
  row: JournalRow,
  fence: ArchiveRpcFence,
  error: unknown
): Promise<'failed' | 'frozen'> {
  const now = Date.now();
  const message = (error instanceof Error ? error.message : String(error)).slice(
    0,
    config.errorMaxChars
  );
  const frozen = isIntegrityFailure(error);
  const failureCount = row.failure_count + 1;
  const retryExponentCeiling = Math.ceil(
    Math.log2(Math.max(1, config.retryMaxMs / config.retryBaseMs))
  );
  const retryDelay = Math.min(
    config.retryMaxMs,
    config.retryBaseMs * 2 ** Math.min(failureCount - 1, retryExponentCeiling)
  );
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE project_data_archive_migrations
          SET state = ?, failure_count = failure_count + 1,
              next_attempt_at = ?, last_error = ?, lease_expires_at = NULL, updated_at = ?
        WHERE migration_id = ? AND lease_token = ? AND lease_epoch = ?`
    ).bind(
      frozen ? 'frozen' : 'failed',
      frozen ? null : now + retryDelay,
      message,
      now,
      row.migration_id,
      fence.leaseToken,
      fence.leaseEpoch
    ),
    env.DATABASE.prepare(
      `INSERT INTO project_data_archive_circuit_breakers
       (project_id, consecutive_failures, opened_until, last_failure, updated_at)
       VALUES (?, 1, NULL, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         consecutive_failures = consecutive_failures + 1,
         opened_until = CASE
           WHEN consecutive_failures + 1 >= ? THEN ?
           ELSE opened_until
         END,
         last_failure = excluded.last_failure,
         updated_at = excluded.updated_at`
    ).bind(row.project_id, message, now, config.circuitFailures, now + config.circuitOpenMs),
  ]);
  log.error('project_data_archive_migration_failed', {
    projectId: row.project_id,
    sessionId: row.session_id,
    migrationId: row.migration_id,
    frozen,
    error: message,
  });
  if (frozen || failureCount >= config.circuitFailures) {
    await persistArchiveOperatorAlert(
      env,
      row,
      frozen ? 'migration_frozen' : 'circuit_opened',
      message
    );
  }
  return frozen ? 'frozen' : 'failed';
}

async function clearProjectFailure(env: Env, projectId: string): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT INTO project_data_archive_circuit_breakers
     (project_id, consecutive_failures, opened_until, last_failure, updated_at)
     VALUES (?, 0, NULL, NULL, ?)
     ON CONFLICT(project_id) DO UPDATE SET consecutive_failures = 0,
       opened_until = NULL, last_failure = NULL, updated_at = excluded.updated_at`
  )
    .bind(projectId, Date.now())
    .run();
}

async function processJournal(
  env: Env,
  config: ProjectDataArchiveShardingConfig,
  selected: JournalRow,
  now: number,
  budget: ArchiveSweepBudget
): Promise<'progressed' | 'archived' | 'failed' | 'frozen'> {
  const claim = await claimJournal(env, selected, config, now);
  if (!claim) return 'progressed';
  const { row } = claim;
  let { fence } = claim;
  try {
    // Inspect source proof, refresh source intent/anchor, and prepare the target.
    // The reservation includes the possible lease release on a safe yield.
    if (!reserveSweepStage(budget, 6, ARCHIVE_SWEEP_FAILURE_IO_RESERVE)) {
      await releaseJournalLease(env, fence);
      return 'progressed';
    }
    await synchronizeDistributedFence(env, row, fence);
    let aggregateHash = row.aggregate_hash;
    let manifestR2Key = row.manifest_r2_key;
    if (row.state === 'copying') {
      const sourceFence = row.source_generation > 0 ? rehomeSourceFence(row, fence) : null;
      const proof = sourceFence
        ? await projectData.inspectArchiveRehomeSourceProof(env, sourceFence)
        : await projectData.inspectArchiveSourceProof(env, row.project_id, row.session_id);
      if (proof.state === 'source_deleted') {
        let restoredTarget = false;
        if (!proof.aggregateHash || !proof.manifestR2Key) {
          throw new Error('ProjectData archive source_deleted proof lacks immutable evidence');
        }
        aggregateHash = proof.aggregateHash;
        manifestR2Key = proof.manifestR2Key;
        if (row.next_table_name === 'recovery_restore') {
          if (!reserveSweepStage(budget, 12, ARCHIVE_SWEEP_FAILURE_IO_RESERVE)) {
            await releaseJournalLease(env, fence);
            return 'progressed';
          }
          const restored = await restoreNextRecoveryChunk(env, config, row, fence);
          aggregateHash = restored.aggregateHash;
          manifestR2Key = restored.manifestR2Key;
          restoredTarget = restored.sealed;
          await releaseJournalLease(env, fence);
          return 'progressed';
        }
        if (!restoredTarget) {
          if (!reserveSweepStage(budget, 3, ARCHIVE_SWEEP_FAILURE_IO_RESERVE)) {
            await releaseJournalLease(env, fence);
            return 'progressed';
          }
          await guardedJournalUpdate(
            env,
            fence,
            `UPDATE project_data_archive_migrations
              SET state = 'source_deleted', aggregate_hash = ?, manifest_r2_key = ?,
                  source_deleted_at = COALESCE(source_deleted_at, ?), updated_at = ?
            WHERE migration_id = ? AND lease_token = ? AND lease_epoch = ?
              AND lease_expires_at = ? AND lease_expires_at > ? AND state = 'copying'`,
            [aggregateHash, manifestR2Key, Date.now(), Date.now()]
          );
          await releaseJournalLease(env, fence);
          return 'progressed';
        }
      } else {
        const copy = await copyBoundedChunks(env, config, row, fence, budget);
        if (copy.copied > 0 || !copy.complete) {
          await releaseJournalLease(env, fence);
          return 'progressed';
        }
        if (!reserveSweepStage(budget, 12, ARCHIVE_SWEEP_FAILURE_IO_RESERVE)) {
          await releaseJournalLease(env, fence);
          return 'progressed';
        }
        fence = await renewJournalLease(env, config, fence);
        await synchronizeDistributedFence(env, row, fence);
        const sealed = await sealCopiedTarget(env, config, row, fence);
        if (!sealed) {
          await releaseJournalLease(env, fence);
          return 'progressed';
        }
        aggregateHash = sealed.aggregateHash;
        manifestR2Key = sealed.manifestR2Key;
        await releaseJournalLease(env, fence);
        return 'progressed';
      }
    }
    if (!aggregateHash || !manifestR2Key) {
      const refreshedTarget = await projectData.inspectArchiveTarget(env, fence);
      aggregateHash = refreshedTarget.aggregateHash;
      manifestR2Key = refreshedTarget.manifestR2Key;
    }
    if (!aggregateHash || !manifestR2Key)
      throw new Error('ProjectData sealed archive evidence is missing');
    if (row.recovery_verified_at === null) {
      if (!reserveSweepStage(budget, 6, ARCHIVE_SWEEP_FAILURE_IO_RESERVE)) {
        await releaseJournalLease(env, fence);
        return 'progressed';
      }
      await verifyNextRecoveryEvidence(env, config, row, fence, aggregateHash, manifestR2Key);
      await releaseJournalLease(env, fence);
      return 'progressed';
    }
    const current = await env.DATABASE.prepare(
      'SELECT state FROM project_data_archive_migrations WHERE migration_id = ?'
    )
      .bind(row.migration_id)
      .first<{ state: string }>();
    if (current?.state === 'sealed') {
      // Root manifest reread, exact target databaseSize measurement, source
      // proof/finalize, D1 CAS, renewals, and a safe lease release.
      if (!reserveSweepStage(budget, 10, ARCHIVE_SWEEP_FAILURE_IO_RESERVE)) {
        await releaseJournalLease(env, fence);
        return 'progressed';
      }
      await verifyNextRecoveryEvidence(env, config, row, fence, aggregateHash, manifestR2Key);
      fence = await renewJournalLease(env, config, fence);
      await synchronizeDistributedFence(env, row, fence);
      await publishSourceDeleted(env, config, row, fence, aggregateHash, manifestR2Key);
      await releaseJournalLease(env, fence);
      return 'progressed';
    }
    const afterDelete = await env.DATABASE.prepare(
      'SELECT state FROM project_data_archive_migrations WHERE migration_id = ?'
    )
      .bind(row.migration_id)
      .first<{ state: string }>();
    if (afterDelete?.state === 'source_deleted') {
      if (!reserveSweepStage(budget, 8, ARCHIVE_SWEEP_FAILURE_IO_RESERVE)) {
        await releaseJournalLease(env, fence);
        return 'progressed';
      }
      await verifyNextRecoveryEvidence(env, config, row, fence, aggregateHash, manifestR2Key);
      fence = await renewJournalLease(env, config, fence);
      await publishArchiveLocation(env, row, fence, aggregateHash);
    }
    await clearProjectFailure(env, row.project_id);
    return 'archived';
  } catch (error) {
    const published = await env.DATABASE.prepare(
      'SELECT state FROM project_data_archive_migrations WHERE migration_id = ?'
    )
      .bind(row.migration_id)
      .first<{ state: string }>();
    if (published?.state === 'archived') {
      log.warn('project_data_archive_target_authority_pending', {
        projectId: row.project_id,
        sessionId: row.session_id,
        migrationId: row.migration_id,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'progressed';
    }
    return recordFailure(env, config, row, fence, error);
  }
}

async function reconcilePublishedTarget(env: Env, budget: ArchiveSweepBudget): Promise<boolean> {
  if (!reserveSweepStage(budget, 1)) return false;
  const row = await env.DATABASE.prepare(
    `SELECT * FROM project_data_archive_migrations
      WHERE state = 'archived' AND (
        target_authoritative_at IS NULL OR
        (target_generation = 0 AND target_cleanup_at IS NULL)
      )
      ORDER BY archived_at LIMIT 1`
  ).first<JournalRow>();
  if (!row || !row.aggregate_hash) return false;
  if (!reserveSweepStage(budget, ARCHIVE_SWEEP_RECONCILE_IO_RESERVE)) return false;
  const fence: ArchiveRpcFence = {
    projectId: row.project_id,
    sessionId: row.session_id,
    migrationId: row.migration_id,
    ownerName: row.target_owner_name,
    generation: row.target_generation,
    leaseToken: row.lease_token ?? '',
    leaseEpoch: row.lease_epoch,
    leaseExpiresAt: row.lease_expires_at ?? 0,
    terminalVersion: row.terminal_version,
  };
  try {
    if (row.target_authoritative_at === null) {
      const inspection = await projectData.inspectArchiveTargetForReconciliation(env, fence);
      if (!inspection.ok || !inspection.target) {
        throw new Error(
          inspection.error ?? 'Published ProjectData archive target inspection failed'
        );
      }
      const target = inspection.target;
      if (target.state === 'sealed') {
        await projectData.markArchiveTargetAuthoritative(env, fence, row.aggregate_hash);
      } else if (target.state !== 'authoritative') {
        throw new Error('Published ProjectData archive target is neither sealed nor authoritative');
      }
      const authoritativeAt = Date.now();
      await env.DATABASE.prepare(
        `UPDATE project_data_archive_migrations
            SET target_authoritative_at = ?,
                target_cleanup_at = CASE WHEN target_generation > 0 THEN ? ELSE NULL END,
                updated_at = ?
          WHERE migration_id = ? AND state = 'archived' AND target_authoritative_at IS NULL`
      )
        .bind(authoritativeAt, authoritativeAt, authoritativeAt, row.migration_id)
        .run();
    }
    if (fence.ownerName === fence.projectId && fence.generation === 0) {
      await projectData.completeArchiveRootCopyback(
        env,
        fence,
        row.aggregate_hash,
        resolveArchiveShardingConfig(env).routingVersion
      );
      const cleanedAt = Date.now();
      await env.DATABASE.prepare(
        `UPDATE project_data_archive_migrations SET target_cleanup_at = ?, updated_at = ?
          WHERE migration_id = ? AND state = 'archived'
            AND target_authoritative_at IS NOT NULL AND target_cleanup_at IS NULL`
      )
        .bind(cleanedAt, cleanedAt, row.migration_id)
        .run();
    }
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(
      0,
      resolveArchiveShardingConfig(env).errorMaxChars
    );
    // The local authority CAS may have committed earlier in this same attempt.
    // Re-read the durable marker so a later root-cleanup failure remains an
    // archived/pending repair instead of being mislabeled as target loss.
    const current = await env.DATABASE.prepare(
      `SELECT state, target_authoritative_at
         FROM project_data_archive_migrations WHERE migration_id = ?`
    )
      .bind(row.migration_id)
      .first<{ state: string; target_authoritative_at: number | null }>();
    const targetAuthorityMissing =
      current?.state === 'archived' && current.target_authoritative_at === null;
    if (targetAuthorityMissing) {
      await env.DATABASE.prepare(
        `UPDATE project_data_archive_migrations
            SET state = 'frozen', failure_count = failure_count + 1,
                last_error = ?, lease_expires_at = NULL, updated_at = ?
          WHERE migration_id = ? AND state = 'archived' AND target_authoritative_at IS NULL`
      )
        .bind(`published_target_reconcile: ${message}`, Date.now(), row.migration_id)
        .run();
      await persistArchiveOperatorAlert(env, row, 'published_target_frozen', message);
    }
    log.error(
      targetAuthorityMissing
        ? 'project_data_archive_published_target_frozen'
        : 'project_data_archive_root_cleanup_pending',
      {
        projectId: row.project_id,
        sessionId: row.session_id,
        migrationId: row.migration_id,
        error: message,
      }
    );
  }
  return true;
}

export type ProjectDataArchiveRehomeResult = {
  migrationId: string;
  sourceOwnerName: string;
  sourceGeneration: number;
  targetOwnerName: string;
  targetGeneration: number;
  rootCopybackRequested: boolean;
  rootCopybackAccepted: boolean;
};

/**
 * Explicit operator-controlled recovery for a frozen journal. The default-off
 * flag applies here too. `retry` preserves a sealed target; `restore_target`
 * fences routing back to migrating and rebuilds the deleted source payload
 * from immutable R2 chunks before publication is retried.
 */
export async function requestProjectDataArchiveForwardFix(
  env: Env,
  migrationId: string,
  mode: 'retry' | 'restore_target'
): Promise<void> {
  const config = resolveArchiveShardingConfig(env);
  if (!config.enabled) throw new Error('ProjectData archive forward-fix is disabled');
  const row = await env.DATABASE.prepare(
    `SELECT migration.*, location.state AS location_state,
            location.owner_kind AS location_owner_kind,
            location.owner_name AS location_owner_name,
            location.generation AS location_generation,
            location.migration_id AS location_migration_id,
            location.routing_version AS location_routing_version
       FROM project_data_archive_migrations migration
       JOIN project_data_session_locations location
         ON location.project_id = migration.project_id
        AND location.session_id = migration.session_id
      WHERE migration.migration_id = ? AND migration.state = 'frozen'`
  )
    .bind(migrationId)
    .first<JournalRow & Record<string, unknown>>();
  if (!row) throw new Error('ProjectData archive frozen journal was not found');
  const now = Date.now();
  if (mode === 'retry') {
    if (
      row.location_state !== 'migrating' ||
      row.location_owner_name !== row.source_owner_name ||
      row.location_generation !== row.source_generation ||
      row.location_migration_id !== row.migration_id ||
      row.location_routing_version !== config.routingVersion
    ) {
      throw new Error('ProjectData archive forward-fix retry location mismatch');
    }
    await env.DATABASE.prepare(
      `UPDATE project_data_archive_migrations
          SET state = 'failed', failure_count = 0, next_attempt_at = 0,
              lease_token = NULL, lease_expires_at = NULL,
              last_error = 'operator_forward_fix_retry', updated_at = ?
        WHERE migration_id = ? AND state = 'frozen'`
    )
      .bind(now, migrationId)
      .run();
    return;
  }
  const targetLocationMatches =
    row.target_generation === 0
      ? row.location_state === 'root' && row.location_owner_kind === 'root'
      : row.location_state === 'archive_shard' && row.location_owner_kind === 'archive_shard';
  const targetMigrationMatches =
    row.target_generation === 0
      ? row.location_migration_id === null
      : row.location_migration_id === row.migration_id;
  if (
    row.source_deleted_at === null ||
    !targetLocationMatches ||
    row.location_owner_name !== row.target_owner_name ||
    row.location_generation !== row.target_generation ||
    !targetMigrationMatches ||
    row.location_routing_version !== config.routingVersion ||
    !row.aggregate_hash ||
    !row.manifest_r2_key
  ) {
    throw new Error('ProjectData archive forward-fix restore evidence/location mismatch');
  }
  await readRecoveryManifest(env, config, row, row.aggregate_hash, row.manifest_r2_key);
  const sourceOwnerKind = row.source_generation === 0 ? 'root' : 'archive_shard';
  const restoreLocation =
    row.target_generation === 0
      ? env.DATABASE.prepare(
          `UPDATE project_data_session_locations
              SET state = 'migrating', owner_kind = ?, owner_name = ?, generation = ?,
                  migration_id = ?, routing_version = ?, updated_at = ?
            WHERE project_id = ? AND session_id = ? AND state = ?
              AND owner_kind = ?
              AND owner_name = ? AND generation = ? AND migration_id IS NULL
              AND routing_version = ?`
        ).bind(
          sourceOwnerKind,
          row.source_owner_name,
          row.source_generation,
          row.migration_id,
          config.routingVersion,
          now,
          row.project_id,
          row.session_id,
          row.location_state,
          row.location_owner_kind,
          row.target_owner_name,
          row.target_generation,
          config.routingVersion
        )
      : env.DATABASE.prepare(
          `UPDATE project_data_session_locations
              SET state = 'migrating', owner_kind = ?, owner_name = ?, generation = ?,
                  migration_id = ?, routing_version = ?, updated_at = ?
            WHERE project_id = ? AND session_id = ? AND state = ?
              AND owner_kind = ?
              AND owner_name = ? AND generation = ? AND migration_id = ?
              AND routing_version = ?`
        ).bind(
          sourceOwnerKind,
          row.source_owner_name,
          row.source_generation,
          row.migration_id,
          config.routingVersion,
          now,
          row.project_id,
          row.session_id,
          row.location_state,
          row.location_owner_kind,
          row.target_owner_name,
          row.target_generation,
          row.migration_id,
          config.routingVersion
        );
  const restored = await env.DATABASE.batch([
    restoreLocation,
    env.DATABASE.prepare(
      `UPDATE project_data_archive_migrations
          SET state = 'copying', next_table_name = 'recovery_restore', next_chunk_index = 0,
              next_row_key = NULL, failure_count = 0, next_attempt_at = 0,
              lease_token = NULL, lease_expires_at = NULL,
              recovery_verify_page_key = NULL, recovery_verify_page_index = NULL,
              recovery_verify_entry_index = 0, recovery_verify_expected_hash = NULL,
              recovery_verify_entries_seen = 0, recovery_verified_at = NULL,
              recovery_restore_page_key = NULL, recovery_restore_page_index = NULL,
              recovery_restore_entry_index = 0, recovery_target_reset_at = NULL,
              target_authoritative_at = NULL, target_cleanup_at = NULL,
              last_error = 'operator_forward_fix_restore_target', updated_at = ?
        WHERE migration_id = ? AND state = 'frozen'`
    ).bind(now, migrationId),
  ]);
  if (restored.some((result) => (result.meta.changes ?? 0) < 1)) {
    throw new Error('ProjectData archive forward-fix restore CAS was lost');
  }
}

/**
 * Explicit external coordinator entry point for rollback/repack. It is never
 * called by a ProjectData alarm and shares the exact disabled-by-default flag.
 */
export async function requestProjectDataArchiveRehome(
  env: Env,
  projectId: string,
  sessionId: string,
  requestedTargetOwnerName: string,
  fallbackTargetOwnerName?: string
): Promise<ProjectDataArchiveRehomeResult> {
  const config = resolveArchiveShardingConfig(env);
  if (!config.enabled) throw new Error('ProjectData archive rehome is disabled');
  const row = await env.DATABASE.prepare(
    `SELECT migration.* FROM project_data_archive_migrations migration
     JOIN project_data_session_locations location
       ON location.project_id = migration.project_id AND location.session_id = migration.session_id
    WHERE migration.project_id = ? AND migration.session_id = ? AND migration.state = 'archived'
      AND location.state = 'archive_shard' AND location.owner_kind = 'archive_shard'
      AND location.owner_name = migration.target_owner_name
      AND location.generation = migration.target_generation
      AND location.migration_id = migration.migration_id AND location.routing_version = ?`
  )
    .bind(projectId, sessionId, config.routingVersion)
    .first<JournalRow>();
  if (!row) throw new Error('ProjectData archive rehome source is not authoritative');

  const storageLimit = resolveStorageSafetyConfig(env).limitBytes;
  const capacityLimit = Math.floor(storageLimit * config.rootCopyMaxRatio);
  const sourceSize = await projectData.getArchiveTargetCanonicalBytes(env, {
    projectId,
    sessionId,
    migrationId: row.migration_id,
    ownerName: row.target_owner_name,
    generation: row.target_generation,
  });
  const plannedSourceSize = Math.ceil(sourceSize * config.copyExpansionRatio);
  const rootCopybackRequested = requestedTargetOwnerName === projectId;
  const configuredShardOwners = new Set(
    Array.from({ length: config.shardCount }, (_, shard) =>
      buildArchiveShardOwnerName(projectId, shard)
    )
  );
  if (!rootCopybackRequested && fallbackTargetOwnerName) {
    throw new Error(
      'ProjectData archive rehome fallback target is only valid for a root copyback request'
    );
  }
  if (
    fallbackTargetOwnerName &&
    (!configuredShardOwners.has(fallbackTargetOwnerName) ||
      fallbackTargetOwnerName === row.target_owner_name)
  ) {
    throw new Error('ProjectData archive rehome fallback target is invalid');
  }
  let targetOwnerName: string | null = null;
  let targetGeneration = row.target_generation + 1;
  if (rootCopybackRequested) {
    const rootSize = await projectData.getArchiveOwnerDatabaseSize(env, projectId, projectId);
    if (rootSize + plannedSourceSize <= capacityLimit) {
      targetOwnerName = projectId;
      targetGeneration = 0;
    }
  }
  if (!targetOwnerName && !rootCopybackRequested) {
    if (
      !configuredShardOwners.has(requestedTargetOwnerName) ||
      requestedTargetOwnerName === row.target_owner_name
    ) {
      throw new Error('ProjectData archive rehome requested target is invalid');
    }
    const targetSize = await projectData.getArchiveOwnerDatabaseSize(
      env,
      projectId,
      requestedTargetOwnerName
    );
    if (targetSize + plannedSourceSize > capacityLimit) {
      throw new Error('ProjectData archive rehome requested target exceeds the capacity gate');
    }
    targetOwnerName = requestedTargetOwnerName;
  }
  if (!targetOwnerName && rootCopybackRequested) {
    if (!fallbackTargetOwnerName) {
      throw new Error(
        'ProjectData archive root copyback exceeds the capacity gate and requires an explicit fallback target'
      );
    }
    const fallbackSize = await projectData.getArchiveOwnerDatabaseSize(
      env,
      projectId,
      fallbackTargetOwnerName
    );
    if (fallbackSize + plannedSourceSize > capacityLimit) {
      throw new Error('ProjectData archive rehome fallback target exceeds the capacity gate');
    }
    targetOwnerName = fallbackTargetOwnerName;
  }
  if (!targetOwnerName) {
    throw new Error('ProjectData archive rehome has no owner below the configured capacity gate');
  }

  const now = Date.now();
  const updated = await env.DATABASE.prepare(
    `UPDATE project_data_archive_migrations
        SET state = 'copying', source_owner_name = ?, source_generation = ?,
            target_owner_name = ?, target_generation = ?, aggregate_hash = NULL,
            manifest_r2_key = NULL, next_table_name = ?, next_chunk_index = 0,
            next_row_key = NULL, lease_token = NULL, lease_expires_at = NULL,
            failure_count = 0, next_attempt_at = NULL, last_error = NULL, source_deleted_at = NULL,
            archived_at = NULL, target_authoritative_at = NULL, target_cleanup_at = NULL,
            recovery_verify_page_key = NULL, recovery_verify_page_index = NULL,
            recovery_verify_entry_index = 0, recovery_verify_expected_hash = NULL,
            recovery_verify_entries_seen = 0, recovery_verified_at = NULL,
            recovery_restore_page_key = NULL, recovery_restore_page_index = NULL,
            recovery_restore_entry_index = 0, recovery_target_reset_at = NULL,
            updated_at = ?
      WHERE migration_id = ? AND state = 'archived'
        AND target_owner_name = ? AND target_generation = ?`
  )
    .bind(
      row.target_owner_name,
      row.target_generation,
      targetOwnerName,
      targetGeneration,
      TABLES[0],
      now,
      row.migration_id,
      row.target_owner_name,
      row.target_generation
    )
    .run();
  // D1 reports trigger side effects in `changes`; at least one change proves
  // the guarded journal row matched, while the rehome trigger fences location.
  if ((updated.meta.changes ?? 0) < 1) {
    throw new Error('ProjectData archive rehome CAS was lost');
  }
  return {
    migrationId: row.migration_id,
    sourceOwnerName: row.target_owner_name,
    sourceGeneration: row.target_generation,
    targetOwnerName,
    targetGeneration,
    rootCopybackRequested,
    rootCopybackAccepted: targetOwnerName === projectId && targetGeneration === 0,
  };
}

export async function runProjectDataArchiveShardingSweep(
  env: Env,
  now = Date.now()
): Promise<ProjectDataArchiveSweepResult> {
  const config = resolveArchiveShardingConfig(env);
  const result: ProjectDataArchiveSweepResult = {
    enabled: config.enabled,
    selected: 0,
    progressed: 0,
    archived: 0,
    failed: 0,
    frozen: 0,
  };
  if (!config.enabled) return result;
  const budget: ArchiveSweepBudget = {
    deadlineMs: Date.now() + config.sweepMaxWallMs,
    remainingIoOps: config.sweepMaxIoOps,
  };
  // The initial lookup costs one D1 operation. A pending row reserves its full
  // target/marker/cleanup/failure path before the first mutable operation.
  await reconcilePublishedTarget(env, budget);
  for (let index = 0; index < config.maxCandidatesPerSweep; index++) {
    // Selection/planning/claim consumes at most seven operations. Four more are
    // retained (not spent) for the catch path: published-state read,
    // failure/circuit batch, and operator alert.
    if (
      !reserveSweepStage(
        budget,
        ARCHIVE_SWEEP_CANDIDATE_IO_RESERVE,
        ARCHIVE_SWEEP_FAILURE_IO_RESERVE
      )
    )
      break;
    const journal =
      (await selectRecoverableJournal(env, now)) ?? (await planCandidate(env, config, now));
    if (!journal) break;
    result.selected++;
    const outcome = await processJournal(env, config, journal, now, budget);
    result[outcome]++;
  }
  return result;
}
