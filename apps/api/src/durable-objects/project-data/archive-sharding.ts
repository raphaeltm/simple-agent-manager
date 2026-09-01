// FILE SIZE EXCEPTION: Distributed source/target/rehome fence, hash, and finalize invariants stay co-located so reviewers can audit every destructive transition without cross-module cyclic internals.
import {
  ARCHIVE_AGGREGATE_CHAIN_SEED,
  archiveCanonicalBytes,
  type ArchiveTableName,
  canonicalArchiveHash,
  extendCanonicalAggregateHash,
  sha256Hex,
} from './archive-sharding-canonical';

const TERMINAL_STATUSES = new Set(['stopped', 'failed']);
const ARCHIVE_TABLES: readonly ArchiveTableName[] = [
  'chat_messages',
  'chat_messages_grouped',
  'tool_payload_archives',
];

export interface ArchiveRpcFence {
  projectId: string;
  sessionId: string;
  migrationId: string;
  ownerName: string;
  generation: number;
  leaseToken: string;
  leaseEpoch: number;
  leaseExpiresAt: number;
  terminalVersion: string;
}

export interface ArchiveRehomeSourceFence extends ArchiveRpcFence {
  sourceOwnerName: string;
  sourceGeneration: number;
}

export interface ArchiveChunk {
  table: ArchiveTableName;
  chunkIndex: number;
  rows: Record<string, unknown>[];
  rowCount: number;
  canonicalBytes: number;
  canonicalHash: string;
  nextKey: string | null;
  done: boolean;
}

export interface ArchiveChunkManifestEntry {
  table: ArchiveTableName;
  chunkIndex: number;
  rowCount: number;
  canonicalBytes: number;
  hash: string;
  r2Key: string;
}

export interface ArchiveManifestPage {
  done: boolean;
  pageIndex: number;
  previousPageKey: string | null;
  previousChainHash: string;
  entryCount: number;
  entries: ArchiveChunkManifestEntry[];
}

export interface ArchiveManifestSealState {
  pageCount: number;
  entryCount: number;
  aggregateHash: string;
  headPageKey: string | null;
}

export interface SourceArchiveEligibility {
  eligible: boolean;
  reason: string | null;
  terminalVersion: string | null;
  lastMessageAt: number | null;
  databaseSize: number;
}

export interface SourceDeletedProof {
  state: 'none' | 'migrating' | 'source_deleted' | 'frozen';
  migrationId: string | null;
  aggregateHash: string | null;
  manifestR2Key: string | null;
  sourceDatabaseSizeBefore: number | null;
  sourceDatabaseSizeAfter: number | null;
}

function scalar(row: Record<string, unknown>, name: string): string | number | null {
  const value = row[name];
  if (value === null || typeof value === 'string' || typeof value === 'number') return value;
  throw new Error(`Invalid terminal version column ${name}`);
}

function terminalVersionPreimage(sql: SqlStorage, sessionId: string): string {
  const session = sql
    .exec(
      `SELECT id, status, updated_at, ended_at, message_count,
              (SELECT COUNT(*) FROM chat_messages WHERE session_id = chat_sessions.id) AS raw_count,
              (SELECT COUNT(*) FROM chat_messages_grouped WHERE session_id = chat_sessions.id) AS grouped_count,
              (SELECT COUNT(*) FROM tool_payload_archives WHERE session_id = chat_sessions.id) AS archive_count,
              (SELECT id FROM chat_messages WHERE session_id = chat_sessions.id ORDER BY sequence DESC, id DESC LIMIT 1) AS latest_message_id,
              (SELECT sequence FROM chat_messages WHERE session_id = chat_sessions.id ORDER BY sequence DESC, id DESC LIMIT 1) AS latest_message_sequence,
              (SELECT created_at FROM chat_messages WHERE session_id = chat_sessions.id ORDER BY sequence DESC, id DESC LIMIT 1) AS latest_message_at
         FROM chat_sessions WHERE id = ?`,
      sessionId
    )
    .toArray()[0];
  if (!session) throw new Error('Archive source session does not exist');
  const columns = [
    'id',
    'status',
    'updated_at',
    'ended_at',
    'message_count',
    'raw_count',
    'grouped_count',
    'archive_count',
    'latest_message_id',
    'latest_message_sequence',
    'latest_message_at',
  ];
  return JSON.stringify(
    Object.fromEntries(columns.map((column) => [column, scalar(session, column)]))
  );
}

export async function computeTerminalVersion(sql: SqlStorage, sessionId: string): Promise<string> {
  return sha256Hex(terminalVersionPreimage(sql, sessionId));
}

function count(sql: SqlStorage, statement: string, sessionId: string): number {
  const value = sql.exec(statement, sessionId).toArray()[0]?.cnt;
  if (typeof value !== 'number') throw new Error('Archive dependency count was malformed');
  return value;
}

export async function inspectSourceArchiveEligibility(
  sql: SqlStorage,
  database: D1Database,
  projectId: string,
  sessionId: string,
  now: number,
  terminalGraceMs: number
): Promise<SourceArchiveEligibility> {
  const databaseSize = sql.databaseSize;
  const session = sql
    .exec(
      `SELECT status, ended_at,
              (SELECT MAX(created_at) FROM chat_messages WHERE session_id = chat_sessions.id) AS last_message_at
         FROM chat_sessions WHERE id = ?`,
      sessionId
    )
    .toArray()[0];
  if (!session)
    return {
      eligible: false,
      reason: 'session_missing',
      terminalVersion: null,
      lastMessageAt: null,
      databaseSize,
    };
  if (typeof session.status !== 'string' || !TERMINAL_STATUSES.has(session.status)) {
    return {
      eligible: false,
      reason: 'session_not_terminal',
      terminalVersion: null,
      lastMessageAt: null,
      databaseSize,
    };
  }
  if (typeof session.ended_at !== 'number' || session.ended_at > now - terminalGraceMs) {
    return {
      eligible: false,
      reason: 'terminal_grace_not_elapsed',
      terminalVersion: null,
      lastMessageAt: null,
      databaseSize,
    };
  }
  if (
    count(sql, 'SELECT COUNT(*) AS cnt FROM comment_threads WHERE session_id = ?', sessionId) > 0
  ) {
    return {
      eligible: false,
      reason: 'message_comments_present',
      terminalVersion: null,
      lastMessageAt: null,
      databaseSize,
    };
  }
  if (
    count(
      sql,
      `SELECT COUNT(*) AS cnt FROM tool_payload_cleanup_attempts attempt
        JOIN chat_messages message ON message.id = attempt.message_id
       WHERE message.session_id = ? AND attempt.status NOT IN ('archived', 'no_reclaimable_payload', 'invalid_metadata', 'oversized')`,
      sessionId
    ) > 0
  ) {
    return {
      eligible: false,
      reason: 'tool_cleanup_incomplete',
      terminalVersion: null,
      lastMessageAt: null,
      databaseSize,
    };
  }
  if (
    count(
      sql,
      `SELECT COUNT(*) AS cnt FROM chat_messages
       WHERE session_id = ?
         AND tool_metadata IS NOT NULL
         AND json_valid(tool_metadata) = 0`,
      sessionId
    ) > 0
  ) {
    return {
      eligible: false,
      reason: 'invalid_tool_metadata',
      terminalVersion: null,
      lastMessageAt: null,
      databaseSize,
    };
  }
  if (
    count(
      sql,
      `SELECT COUNT(*) AS cnt FROM chat_messages
       WHERE session_id = ?
         AND tool_metadata IS NOT NULL
         AND json_valid(tool_metadata) = 1
         AND json_type(tool_metadata, '$.content') IS NOT NULL
         AND COALESCE(json_extract(tool_metadata, '$.content'), '') != ''`,
      sessionId
    ) > 0
  ) {
    return {
      eligible: false,
      reason: 'inline_tool_payload_present',
      terminalVersion: null,
      lastMessageAt: null,
      databaseSize,
    };
  }
  const protectedSnapshot = await database
    .prepare(
      `SELECT 1 FROM session_snapshots
        WHERE project_id = ? AND chat_session_id = ?
          AND status IN ('available', 'degraded')
          AND expires_at > ? LIMIT 1`
    )
    .bind(projectId, sessionId, new Date(now).toISOString())
    .first();
  if (protectedSnapshot) {
    return {
      eligible: false,
      reason: 'restorable_snapshot_present',
      terminalVersion: null,
      lastMessageAt: null,
      databaseSize,
    };
  }
  const liveTask = await database
    .prepare(
      `SELECT 1 FROM tasks WHERE project_id = ? AND chat_session_id = ?
        AND status NOT IN ('completed', 'failed', 'cancelled') LIMIT 1`
    )
    .bind(projectId, sessionId)
    .first();
  if (liveTask)
    return {
      eligible: false,
      reason: 'live_task_present',
      terminalVersion: null,
      lastMessageAt: null,
      databaseSize,
    };

  return {
    eligible: true,
    reason: null,
    terminalVersion: await computeTerminalVersion(sql, sessionId),
    lastMessageAt: typeof session.last_message_at === 'number' ? session.last_message_at : null,
    databaseSize,
  };
}

function assertSourceFence(
  sql: SqlStorage,
  fence: ArchiveRpcFence,
  now = Date.now()
): Record<string, unknown> {
  const intent = sql
    .exec(
      `SELECT * FROM project_data_archive_source_intents
       WHERE session_id = ? AND project_id = ? AND migration_id = ?
         AND target_owner_name = ? AND target_generation = ?
         AND lease_token = ? AND lease_epoch = ?`,
      fence.sessionId,
      fence.projectId,
      fence.migrationId,
      fence.ownerName,
      fence.generation,
      fence.leaseToken,
      fence.leaseEpoch
    )
    .toArray()[0];
  if (!intent) throw new Error('ProjectData archive source fence mismatch');
  if (intent.lease_expires_at !== fence.leaseExpiresAt || fence.leaseExpiresAt <= now) {
    throw new Error('ProjectData archive source lease expired or changed');
  }
  if (intent.terminal_version !== fence.terminalVersion) {
    throw new Error('ProjectData archive source terminal version mismatch');
  }
  return intent;
}

export function establishSourceIntent(
  sql: SqlStorage,
  transactionSync: <T>(callback: () => T) => T,
  fence: ArchiveRpcFence,
  sourceDatabaseSize: number
): void {
  transactionSync(() => {
    const existing = sql
      .exec(
        'SELECT * FROM project_data_archive_source_intents WHERE session_id = ?',
        fence.sessionId
      )
      .toArray()[0];
    if (existing) {
      if (
        existing.project_id !== fence.projectId ||
        existing.migration_id !== fence.migrationId ||
        existing.target_owner_name !== fence.ownerName ||
        existing.target_generation !== fence.generation ||
        existing.terminal_version !== fence.terminalVersion
      ) {
        throw new Error('ProjectData archive source intent identity mismatch');
      }
      if (existing.state !== 'migrating')
        throw new Error('ProjectData archive source is no longer copyable');
      if (typeof existing.lease_epoch !== 'number' || existing.lease_epoch > fence.leaseEpoch) {
        throw new Error('ProjectData archive source lease epoch is stale');
      }
      sql.exec(
        `UPDATE project_data_archive_source_intents
         SET lease_token = ?, lease_epoch = ?, lease_expires_at = ?, updated_at = ?
         WHERE session_id = ? AND migration_id = ? AND state = 'migrating'`,
        fence.leaseToken,
        fence.leaseEpoch,
        fence.leaseExpiresAt,
        Date.now(),
        fence.sessionId,
        fence.migrationId
      );
      return;
    }
    const preimage = terminalVersionPreimage(sql, fence.sessionId);
    sql.exec(
      `INSERT INTO project_data_archive_source_intents
       (session_id, project_id, migration_id, target_owner_name, target_generation,
        lease_token, lease_epoch, lease_expires_at, terminal_version, state,
        source_database_size_before, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'migrating', ?, ?, ?)`,
      fence.sessionId,
      fence.projectId,
      fence.migrationId,
      fence.ownerName,
      fence.generation,
      fence.leaseToken,
      fence.leaseEpoch,
      fence.leaseExpiresAt,
      fence.terminalVersion,
      sourceDatabaseSize,
      Date.now(),
      Date.now()
    );
    // Capture the concrete version inputs inside the same transaction as the
    // intent. The coordinator supplied hash was computed from this preimage.
    if (!preimage) throw new Error('ProjectData archive terminal version is empty');
  });
}

function tableKeyColumn(table: ArchiveTableName): 'id' | 'message_id' {
  return table === 'tool_payload_archives' ? 'message_id' : 'id';
}

function selectArchiveRows(
  sql: SqlStorage,
  table: ArchiveTableName,
  sessionId: string,
  afterKey: string | null,
  limit: number
): Record<string, unknown>[] {
  const cursor = afterKey ?? '';
  switch (table) {
    case 'chat_messages':
      return sql
        .exec(
          `SELECT id, session_id, role, content, tool_metadata, created_at, sequence, origin
             FROM chat_messages WHERE session_id = ? AND id > ? ORDER BY id LIMIT ?`,
          sessionId,
          cursor,
          limit + 1
        )
        .toArray();
    case 'chat_messages_grouped':
      return sql
        .exec(
          `SELECT id, session_id, role, content, created_at
             FROM chat_messages_grouped WHERE session_id = ? AND id > ? ORDER BY id LIMIT ?`,
          sessionId,
          cursor,
          limit + 1
        )
        .toArray();
    case 'tool_payload_archives':
      return sql
        .exec(
          `SELECT message_id, session_id, r2_key, content_bytes, tool_metadata_bytes,
                  archived_at, message_created_at, message_sequence, archive_version
             FROM tool_payload_archives
            WHERE session_id = ? AND message_id > ? ORDER BY message_id LIMIT ?`,
          sessionId,
          cursor,
          limit + 1
        )
        .toArray();
  }
}

export async function readSourceArchiveChunk(
  sql: SqlStorage,
  fence: ArchiveRpcFence,
  table: ArchiveTableName,
  chunkIndex: number,
  afterKey: string | null,
  maxRows: number,
  maxBytes: number
): Promise<ArchiveChunk> {
  const intent = assertSourceFence(sql, fence);
  if (intent.state !== 'migrating')
    throw new Error('ProjectData archive source is not readable for copy');
  return buildArchiveChunk(sql, fence.sessionId, table, chunkIndex, afterKey, maxRows, maxBytes);
}

async function buildArchiveChunk(
  sql: SqlStorage,
  sessionId: string,
  table: ArchiveTableName,
  chunkIndex: number,
  afterKey: string | null,
  maxRows: number,
  maxBytes: number
): Promise<ArchiveChunk> {
  const candidates = selectArchiveRows(sql, table, sessionId, afterKey, maxRows);
  const bounded = candidates.slice(0, maxRows);
  let low = 0;
  let high = bounded.length;
  while (low < high) {
    const candidateLength = Math.ceil((low + high) / 2);
    if (archiveCanonicalBytes(table, bounded.slice(0, candidateLength)).byteLength <= maxBytes) {
      low = candidateLength;
    } else {
      high = candidateLength - 1;
    }
  }
  if (bounded.length > 0 && low === 0) {
    throw new Error('ProjectData archive row exceeds the configured RPC byte budget');
  }
  const rows = bounded.slice(0, low);
  const canonicalBytes = archiveCanonicalBytes(table, rows).byteLength;
  const key = tableKeyColumn(table);
  const nextKey = rows.length > 0 ? String(rows.at(-1)?.[key]) : afterKey;
  return {
    table,
    chunkIndex,
    rows,
    rowCount: rows.length,
    canonicalBytes,
    canonicalHash: await canonicalArchiveHash(table, rows),
    nextKey: nextKey ?? null,
    done: candidates.length <= rows.length,
  };
}

function assertRehomeSourceFence(
  sql: SqlStorage,
  fence: ArchiveRehomeSourceFence,
  now = Date.now()
): Record<string, unknown> {
  const intent = sql
    .exec(
      `SELECT * FROM project_data_archive_rehome_intents
       WHERE session_id = ? AND project_id = ? AND migration_id = ?
         AND source_owner_name = ? AND source_generation = ?
         AND target_owner_name = ? AND target_generation = ?
         AND lease_token = ? AND lease_epoch = ?`,
      fence.sessionId,
      fence.projectId,
      fence.migrationId,
      fence.sourceOwnerName,
      fence.sourceGeneration,
      fence.ownerName,
      fence.generation,
      fence.leaseToken,
      fence.leaseEpoch
    )
    .toArray()[0];
  if (!intent) throw new Error('ProjectData archive rehome source fence mismatch');
  if (intent.lease_expires_at !== fence.leaseExpiresAt || fence.leaseExpiresAt <= now) {
    throw new Error('ProjectData archive rehome source lease expired or changed');
  }
  if (intent.terminal_version !== fence.terminalVersion) {
    throw new Error('ProjectData archive rehome terminal version mismatch');
  }
  return intent;
}

export function establishArchiveRehomeSourceIntent(
  sql: SqlStorage,
  transactionSync: <T>(callback: () => T) => T,
  fence: ArchiveRehomeSourceFence
): void {
  transactionSync(() => {
    const source = sql
      .exec(
        `SELECT state, terminal_version FROM project_data_archive_targets
         WHERE session_id = ? AND project_id = ? AND migration_id = ?
           AND owner_name = ? AND generation = ?`,
        fence.sessionId,
        fence.projectId,
        fence.migrationId,
        fence.sourceOwnerName,
        fence.sourceGeneration
      )
      .toArray()[0];
    if (
      !source ||
      source.state !== 'authoritative' ||
      source.terminal_version !== fence.terminalVersion
    ) {
      throw new Error('ProjectData archive rehome source owner/generation mismatch');
    }
    const existing = sql
      .exec(
        `SELECT * FROM project_data_archive_rehome_intents
         WHERE session_id = ? AND source_generation = ?`,
        fence.sessionId,
        fence.sourceGeneration
      )
      .toArray()[0];
    if (existing) {
      if (
        existing.migration_id !== fence.migrationId ||
        existing.source_owner_name !== fence.sourceOwnerName ||
        existing.source_generation !== fence.sourceGeneration ||
        existing.target_owner_name !== fence.ownerName ||
        existing.target_generation !== fence.generation ||
        existing.terminal_version !== fence.terminalVersion ||
        existing.state !== 'migrating' ||
        (typeof existing.lease_epoch === 'number' && existing.lease_epoch > fence.leaseEpoch)
      ) {
        throw new Error('ProjectData archive rehome source intent identity mismatch');
      }
      sql.exec(
        `UPDATE project_data_archive_rehome_intents
         SET lease_token = ?, lease_epoch = ?, lease_expires_at = ?, updated_at = ?
         WHERE session_id = ? AND source_generation = ?
           AND migration_id = ? AND state = 'migrating'`,
        fence.leaseToken,
        fence.leaseEpoch,
        fence.leaseExpiresAt,
        Date.now(),
        fence.sessionId,
        fence.sourceGeneration,
        fence.migrationId
      );
      return;
    }
    sql.exec(
      `INSERT INTO project_data_archive_rehome_intents
       (session_id, project_id, migration_id, source_owner_name, source_generation,
        target_owner_name, target_generation, lease_token, lease_epoch, lease_expires_at,
        terminal_version, state, source_database_size_before, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'migrating', ?, ?, ?)`,
      fence.sessionId,
      fence.projectId,
      fence.migrationId,
      fence.sourceOwnerName,
      fence.sourceGeneration,
      fence.ownerName,
      fence.generation,
      fence.leaseToken,
      fence.leaseEpoch,
      fence.leaseExpiresAt,
      fence.terminalVersion,
      sql.databaseSize,
      Date.now(),
      Date.now()
    );
  });
}

export async function readArchiveRehomeSourceChunk(
  sql: SqlStorage,
  fence: ArchiveRehomeSourceFence,
  table: ArchiveTableName,
  chunkIndex: number,
  afterKey: string | null,
  maxRows: number,
  maxBytes: number
): Promise<ArchiveChunk> {
  const intent = assertRehomeSourceFence(sql, fence);
  if (intent.state !== 'migrating') {
    throw new Error('ProjectData archive rehome source is not readable for copy');
  }
  return buildArchiveChunk(sql, fence.sessionId, table, chunkIndex, afterKey, maxRows, maxBytes);
}

function assertTargetFence(sql: SqlStorage, fence: ArchiveRpcFence): Record<string, unknown> {
  const target = sql
    .exec(
      `SELECT * FROM project_data_archive_targets
       WHERE session_id = ? AND project_id = ? AND migration_id = ?
         AND owner_name = ? AND generation = ? AND terminal_version = ?`,
      fence.sessionId,
      fence.projectId,
      fence.migrationId,
      fence.ownerName,
      fence.generation,
      fence.terminalVersion
    )
    .toArray()[0];
  if (!target) throw new Error('ProjectData archive target fence mismatch');
  return target;
}

function assertTargetWriteFence(
  sql: SqlStorage,
  fence: ArchiveRpcFence,
  now = Date.now()
): Record<string, unknown> {
  const target = assertTargetFence(sql, fence);
  if (
    target.lease_token !== fence.leaseToken ||
    target.lease_epoch !== fence.leaseEpoch ||
    target.lease_expires_at !== fence.leaseExpiresAt ||
    fence.leaseExpiresAt <= now
  ) {
    throw new Error('ProjectData archive target lease expired or changed');
  }
  return target;
}

export function prepareArchiveTarget(
  sql: SqlStorage,
  transactionSync: <T>(callback: () => T) => T,
  fence: ArchiveRpcFence,
  sessionAnchor: Record<string, unknown>
): void {
  transactionSync(() => {
    const existing = sql
      .exec('SELECT * FROM project_data_archive_targets WHERE session_id = ?', fence.sessionId)
      .toArray()[0];
    if (existing) {
      if (
        existing.state === 'replaced' &&
        typeof existing.generation === 'number' &&
        existing.generation < fence.generation
      ) {
        sql.exec(
          'DELETE FROM project_data_archive_chunks WHERE migration_id = ?',
          String(existing.migration_id)
        );
        sql.exec(
          'DELETE FROM project_data_archive_targets WHERE session_id = ? AND state = ?',
          fence.sessionId,
          'replaced'
        );
      } else {
        const target = assertTargetFence(sql, fence);
        if (target.state === 'authoritative' || target.state === 'replaced') return;
        if (typeof target.lease_epoch === 'number' && target.lease_epoch > fence.leaseEpoch) {
          throw new Error('ProjectData archive target lease epoch is stale');
        }
        sql.exec(
          `UPDATE project_data_archive_targets
             SET lease_token = ?, lease_epoch = ?, lease_expires_at = ?, updated_at = ?
           WHERE session_id = ? AND migration_id = ?
             AND state IN ('copying', 'sealing', 'sealed')`,
          fence.leaseToken,
          fence.leaseEpoch,
          fence.leaseExpiresAt,
          Date.now(),
          fence.sessionId,
          fence.migrationId
        );
        return;
      }
    }
    const anchorProjectId = sessionAnchor.project_id;
    if (anchorProjectId !== fence.projectId) {
      throw new Error('ProjectData archive target project identity mismatch');
    }
    sql.exec(
      `INSERT INTO project_data_archive_targets
       (session_id, project_id, migration_id, owner_name, generation, state,
        terminal_version, lease_token, lease_epoch, lease_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'copying', ?, ?, ?, ?, ?, ?)`,
      fence.sessionId,
      fence.projectId,
      fence.migrationId,
      fence.ownerName,
      fence.generation,
      fence.terminalVersion,
      fence.leaseToken,
      fence.leaseEpoch,
      fence.leaseExpiresAt,
      Date.now(),
      Date.now()
    );
    // Target-only non-authoritative anchor for FKs and search joins. Root owns
    // lifecycle metadata permanently; this copy must never be exposed directly.
    sql.exec(
      `INSERT OR IGNORE INTO chat_sessions
       (id, workspace_id, task_id, created_by_user_id, topic, status, message_count,
        started_at, ended_at, created_at, updated_at, agent_completed_at, materialized_at,
        last_message_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      fence.sessionId,
      (sessionAnchor.workspace_id as string | null) ?? null,
      (sessionAnchor.task_id as string | null) ?? null,
      (sessionAnchor.created_by_user_id as string | null) ?? null,
      (sessionAnchor.topic as string | null) ?? null,
      String(sessionAnchor.status),
      Number(sessionAnchor.message_count),
      Number(sessionAnchor.started_at),
      (sessionAnchor.ended_at as number | null) ?? null,
      Number(sessionAnchor.created_at),
      Number(sessionAnchor.updated_at),
      (sessionAnchor.agent_completed_at as number | null) ?? null,
      (sessionAnchor.materialized_at as number | null) ?? null,
      (sessionAnchor.last_message_at as number | null) ?? null
    );
  });
}

function insertArchiveRow(
  sql: SqlStorage,
  table: ArchiveTableName,
  row: Record<string, unknown>
): void {
  if (table === 'chat_messages') {
    sql.exec(
      `INSERT OR IGNORE INTO chat_messages
       (id, session_id, role, content, tool_metadata, created_at, sequence, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id as string,
      row.session_id as string,
      row.role as string,
      row.content as string,
      row.tool_metadata as string | null,
      row.created_at as number,
      row.sequence as number,
      row.origin as string | null
    );
    return;
  }
  if (table === 'chat_messages_grouped') {
    sql.exec(
      `INSERT OR IGNORE INTO chat_messages_grouped
       (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
      row.id as string,
      row.session_id as string,
      row.role as string,
      row.content as string,
      row.created_at as number
    );
    return;
  }
  sql.exec(
    `INSERT OR IGNORE INTO tool_payload_archives
     (message_id, session_id, r2_key, content_bytes, tool_metadata_bytes,
      archived_at, message_created_at, message_sequence, archive_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.message_id as string,
    row.session_id as string,
    row.r2_key as string,
    row.content_bytes as number,
    row.tool_metadata_bytes as number,
    row.archived_at as number,
    row.message_created_at as number,
    row.message_sequence as number,
    row.archive_version as number
  );
}

export async function commitArchiveTargetChunk(
  sql: SqlStorage,
  transactionSync: <T>(callback: () => T) => T,
  fence: ArchiveRpcFence,
  chunk: ArchiveChunk,
  r2Key: string
): Promise<void> {
  if (!ARCHIVE_TABLES.includes(chunk.table)) throw new Error('Unsupported archive target table');
  if (chunk.rows.some((row) => row.session_id !== fence.sessionId)) {
    throw new Error('ProjectData archive chunk contains a foreign session');
  }
  if (
    chunk.rowCount !== chunk.rows.length ||
    chunk.canonicalBytes !== archiveCanonicalBytes(chunk.table, chunk.rows).byteLength
  ) {
    throw new Error('ProjectData archive chunk diagnostics mismatch');
  }
  if ((await canonicalArchiveHash(chunk.table, chunk.rows)) !== chunk.canonicalHash) {
    throw new Error('ProjectData archive chunk input hash mismatch');
  }
  transactionSync(() => {
    const target = assertTargetWriteFence(sql, fence);
    if (target.state !== 'copying')
      throw new Error('ProjectData archive target is not accepting chunks');
    const receipt = sql
      .exec(
        `SELECT row_count, canonical_bytes, canonical_hash, first_row_key, last_row_key, r2_key
           FROM project_data_archive_chunks
          WHERE migration_id = ? AND table_name = ? AND chunk_index = ?`,
        fence.migrationId,
        chunk.table,
        chunk.chunkIndex
      )
      .toArray()[0];
    if (receipt) {
      if (
        receipt.row_count !== chunk.rowCount ||
        receipt.canonical_bytes !== chunk.canonicalBytes ||
        receipt.canonical_hash !== chunk.canonicalHash ||
        receipt.first_row_key !==
          (chunk.rows.length > 0 ? String(chunk.rows[0]?.[tableKeyColumn(chunk.table)]) : null) ||
        receipt.last_row_key !==
          (chunk.rows.length > 0
            ? String(chunk.rows.at(-1)?.[tableKeyColumn(chunk.table)])
            : null) ||
        receipt.r2_key !== r2Key
      ) {
        throw new Error('ProjectData archive idempotency receipt mismatch');
      }
      return;
    }
    for (const row of chunk.rows) insertArchiveRow(sql, chunk.table, row);
    const keys = chunk.rows.map((row) => row[tableKeyColumn(chunk.table)] as string);
    const committed =
      keys.length === 0 ? [] : selectCommittedRows(sql, chunk.table, fence.sessionId, keys);
    const canonicalBytes = archiveCanonicalBytes(chunk.table, committed).byteLength;
    // The synchronous transaction compares the canonical representation. The
    // async SHA was checked immediately before entry, while committed-row hash
    // verification is completed below before returning success.
    if (
      canonicalBytes !== chunk.canonicalBytes ||
      canonicalRowsMismatch(chunk.table, committed, chunk.rows)
    ) {
      throw new Error('ProjectData archive committed rows differ from the source chunk');
    }
    sql.exec(
      `INSERT INTO project_data_archive_chunks
       (migration_id, session_id, table_name, chunk_index, row_count,
        canonical_bytes, canonical_hash, first_row_key, last_row_key, r2_key, committed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      fence.migrationId,
      fence.sessionId,
      chunk.table,
      chunk.chunkIndex,
      chunk.rowCount,
      chunk.canonicalBytes,
      chunk.canonicalHash,
      keys.length > 0 ? keys[0] : null,
      keys.length > 0 ? keys.at(-1) : null,
      r2Key,
      Date.now()
    );
  });
  const committed = selectCommittedRows(
    sql,
    chunk.table,
    fence.sessionId,
    chunk.rows.map((row) => row[tableKeyColumn(chunk.table)] as string)
  );
  if ((await canonicalArchiveHash(chunk.table, committed)) !== chunk.canonicalHash) {
    throw new Error('ProjectData archive committed-row hash mismatch');
  }
}

export function resetArchiveTargetFromRecovery(
  sql: SqlStorage,
  transactionSync: <T>(callback: () => T) => T,
  fence: ArchiveRpcFence
): void {
  transactionSync(() => {
    const target = assertTargetFence(sql, fence);
    if (
      fence.leaseExpiresAt <= Date.now() ||
      (typeof target.lease_epoch === 'number' && target.lease_epoch > fence.leaseEpoch)
    ) {
      throw new Error('ProjectData archive recovery reset fence is stale');
    }
    // This entry point is reached only by the explicit default-off operator
    // forward-fix after D1 CASes the published location back to migrating and
    // the coordinator verifies the immutable root manifest. Rebuild the same
    // generation in place so no corrupt/stuck target state can block recovery.
    deleteSessionPayloadRows(sql, fence.sessionId);
    sql.exec('DELETE FROM project_data_archive_chunks WHERE migration_id = ?', fence.migrationId);
    sql.exec(
      `UPDATE project_data_archive_targets
       SET state = 'copying', aggregate_hash = NULL, manifest_r2_key = NULL,
           manifest_cursor_table = NULL, manifest_cursor_chunk_index = NULL,
           manifest_page_count = 0, manifest_entry_count = 0,
           manifest_chain_hash = NULL, manifest_head_r2_key = NULL,
           lease_token = ?, lease_epoch = ?, lease_expires_at = ?, updated_at = ?
       WHERE migration_id = ?`,
      fence.leaseToken,
      fence.leaseEpoch,
      fence.leaseExpiresAt,
      Date.now(),
      fence.migrationId
    );
  });
}

export function beginArchiveTargetSealing(
  sql: SqlStorage,
  transactionSync: <T>(callback: () => T) => T,
  fence: ArchiveRpcFence
): void {
  transactionSync(() => {
    const target = assertTargetWriteFence(sql, fence);
    if (target.state === 'sealing' || target.state === 'sealed') return;
    if (target.state !== 'copying') {
      throw new Error('ProjectData archive target cannot begin sealing');
    }
    sql.exec(
      `UPDATE project_data_archive_targets
       SET state = 'sealing',
           manifest_chain_hash = COALESCE(manifest_chain_hash, ?), updated_at = ?
       WHERE migration_id = ? AND state = 'copying'`,
      ARCHIVE_AGGREGATE_CHAIN_SEED,
      Date.now(),
      fence.migrationId
    );
  });
}

export async function verifyNextArchiveTargetChunk(
  sql: SqlStorage,
  transactionSync: <T>(callback: () => T) => T,
  fence: ArchiveRpcFence
): Promise<{ done: boolean; verified: boolean }> {
  const target = assertTargetWriteFence(sql, fence);
  if (target.state === 'sealed') return { done: true, verified: false };
  if (target.state !== 'sealing') {
    throw new Error('ProjectData archive target is not sealing');
  }
  const receipt = sql
    .exec(
      `SELECT table_name, chunk_index, row_count, canonical_bytes, canonical_hash,
              first_row_key, last_row_key, r2_key, committed_at
         FROM project_data_archive_chunks
        WHERE migration_id = ? AND verified_at IS NULL
        ORDER BY table_name, chunk_index LIMIT 1`,
      fence.migrationId
    )
    .toArray()[0];
  if (!receipt) return { done: true, verified: false };
  const table = receipt.table_name as ArchiveTableName;
  if (!ARCHIVE_TABLES.includes(table)) {
    throw new Error('ProjectData archive target receipt table is invalid');
  }
  const committed = selectCommittedRange(
    sql,
    table,
    fence.sessionId,
    typeof receipt.first_row_key === 'string' ? receipt.first_row_key : null,
    typeof receipt.last_row_key === 'string' ? receipt.last_row_key : null
  );
  if (
    committed.length !== receipt.row_count ||
    archiveCanonicalBytes(table, committed).byteLength !== receipt.canonical_bytes ||
    (await canonicalArchiveHash(table, committed)) !== receipt.canonical_hash
  ) {
    throw new Error('ProjectData archive seal committed-row hash mismatch');
  }
  transactionSync(() => {
    assertTargetWriteFence(sql, fence);
    const current = selectCommittedRange(
      sql,
      table,
      fence.sessionId,
      typeof receipt.first_row_key === 'string' ? receipt.first_row_key : null,
      typeof receipt.last_row_key === 'string' ? receipt.last_row_key : null
    );
    if (canonicalRowsMismatch(table, current, committed)) {
      throw new Error('ProjectData archive seal rows changed during hash verification');
    }
    const updated = sql.exec(
      `UPDATE project_data_archive_chunks SET verified_at = ?
       WHERE migration_id = ? AND table_name = ? AND chunk_index = ?
         AND canonical_hash = ? AND committed_at = ? AND verified_at IS NULL`,
      Date.now(),
      fence.migrationId,
      table,
      receipt.chunk_index as number,
      receipt.canonical_hash as string,
      receipt.committed_at as number
    );
    if ((updated.rowsWritten ?? 0) !== 1) {
      throw new Error('ProjectData archive seal receipt changed during verification');
    }
  });
  const remaining = sql
    .exec(
      `SELECT COUNT(*) AS cnt FROM project_data_archive_chunks
       WHERE migration_id = ? AND verified_at IS NULL`,
      fence.migrationId
    )
    .toArray()[0]?.cnt;
  return { done: remaining === 0, verified: true };
}

function canonicalRowsMismatch(
  table: ArchiveTableName,
  left: Record<string, unknown>[],
  right: Record<string, unknown>[]
): boolean {
  return (
    new TextDecoder().decode(archiveCanonicalBytes(table, left)) !==
    new TextDecoder().decode(archiveCanonicalBytes(table, right))
  );
}

function selectCommittedRows(
  sql: SqlStorage,
  table: ArchiveTableName,
  sessionId: string,
  keys: string[]
): Record<string, unknown>[] {
  if (keys.length === 0) return [];
  const encodedKeys = JSON.stringify(keys);
  switch (table) {
    case 'chat_messages':
      return sql
        .exec(
          `SELECT id, session_id, role, content, tool_metadata, created_at, sequence, origin
             FROM chat_messages
            WHERE session_id = ? AND id IN (SELECT value FROM json_each(?)) ORDER BY id`,
          sessionId,
          encodedKeys
        )
        .toArray();
    case 'chat_messages_grouped':
      return sql
        .exec(
          `SELECT id, session_id, role, content, created_at
             FROM chat_messages_grouped
            WHERE session_id = ? AND id IN (SELECT value FROM json_each(?)) ORDER BY id`,
          sessionId,
          encodedKeys
        )
        .toArray();
    case 'tool_payload_archives':
      return sql
        .exec(
          `SELECT message_id, session_id, r2_key, content_bytes, tool_metadata_bytes,
                  archived_at, message_created_at, message_sequence, archive_version
             FROM tool_payload_archives
            WHERE session_id = ?
              AND message_id IN (SELECT value FROM json_each(?)) ORDER BY message_id`,
          sessionId,
          encodedKeys
        )
        .toArray();
  }
}

function selectCommittedRange(
  sql: SqlStorage,
  table: ArchiveTableName,
  sessionId: string,
  firstKey: string | null,
  lastKey: string | null
): Record<string, unknown>[] {
  if (firstKey === null || lastKey === null) return [];
  switch (table) {
    case 'chat_messages':
      return sql
        .exec(
          `SELECT id, session_id, role, content, tool_metadata, created_at, sequence, origin
             FROM chat_messages
            WHERE session_id = ? AND id >= ? AND id <= ? ORDER BY id`,
          sessionId,
          firstKey,
          lastKey
        )
        .toArray();
    case 'chat_messages_grouped':
      return sql
        .exec(
          `SELECT id, session_id, role, content, created_at
             FROM chat_messages_grouped
            WHERE session_id = ? AND id >= ? AND id <= ? ORDER BY id`,
          sessionId,
          firstKey,
          lastKey
        )
        .toArray();
    case 'tool_payload_archives':
      return sql
        .exec(
          `SELECT message_id, session_id, r2_key, content_bytes, tool_metadata_bytes,
                  archived_at, message_created_at, message_sequence, archive_version
             FROM tool_payload_archives
            WHERE session_id = ? AND message_id >= ? AND message_id <= ? ORDER BY message_id`,
          sessionId,
          firstKey,
          lastKey
        )
        .toArray();
  }
}

function manifestEntry(row: Record<string, unknown>): ArchiveChunkManifestEntry {
  return {
    table: row.table_name as ArchiveTableName,
    chunkIndex: row.chunk_index as number,
    rowCount: row.row_count as number,
    canonicalBytes: row.canonical_bytes as number,
    hash: row.canonical_hash as string,
    r2Key: row.r2_key as string,
  };
}

function selectNextManifestReceipts(
  sql: SqlStorage,
  migrationId: string,
  cursorTable: string | null,
  cursorChunkIndex: number | null,
  limit: number
): Record<string, unknown>[] {
  return sql
    .exec(
      `SELECT table_name, chunk_index, row_count, canonical_bytes, canonical_hash, r2_key,
              verified_at
       FROM project_data_archive_chunks
       WHERE migration_id = ?
         AND (? IS NULL OR table_name > ? OR (table_name = ? AND chunk_index > ?))
       ORDER BY table_name, chunk_index LIMIT ?`,
      migrationId,
      cursorTable,
      cursorTable,
      cursorTable,
      cursorChunkIndex ?? -1,
      limit
    )
    .toArray();
}

export function getNextArchiveTargetManifestPage(
  sql: SqlStorage,
  fence: ArchiveRpcFence,
  maxEntries: number
): ArchiveManifestPage {
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new Error('ProjectData archive manifest page limit is invalid');
  }
  const target = assertTargetWriteFence(sql, fence);
  if (target.state !== 'sealing') {
    throw new Error('ProjectData archive target is not building a manifest');
  }
  const unverified = sql
    .exec(
      `SELECT 1 AS pending FROM project_data_archive_chunks
       WHERE migration_id = ? AND verified_at IS NULL LIMIT 1`,
      fence.migrationId
    )
    .toArray()[0];
  if (unverified) throw new Error('ProjectData archive manifest has unverified receipts');
  const cursorTable =
    typeof target.manifest_cursor_table === 'string' ? target.manifest_cursor_table : null;
  const cursorChunkIndex =
    typeof target.manifest_cursor_chunk_index === 'number'
      ? target.manifest_cursor_chunk_index
      : null;
  const rows = selectNextManifestReceipts(
    sql,
    fence.migrationId,
    cursorTable,
    cursorChunkIndex,
    maxEntries
  );
  return {
    done: rows.length === 0,
    pageIndex: Number(target.manifest_page_count ?? 0),
    previousPageKey:
      typeof target.manifest_head_r2_key === 'string' ? target.manifest_head_r2_key : null,
    previousChainHash:
      typeof target.manifest_chain_hash === 'string'
        ? target.manifest_chain_hash
        : ARCHIVE_AGGREGATE_CHAIN_SEED,
    entryCount: Number(target.manifest_entry_count ?? 0),
    entries: rows.map(manifestEntry),
  };
}

export async function commitArchiveTargetManifestPage(
  sql: SqlStorage,
  transactionSync: <T>(callback: () => T) => T,
  fence: ArchiveRpcFence,
  page: Omit<ArchiveManifestPage, 'done'>,
  pageR2Key: string,
  aggregateHash: string
): Promise<void> {
  if (page.entries.length === 0 || !pageR2Key) {
    throw new Error('ProjectData archive manifest page is empty or missing its R2 key');
  }
  const computedHash = await extendCanonicalAggregateHash(page.previousChainHash, page.entries);
  if (computedHash !== aggregateHash) {
    throw new Error('ProjectData archive manifest page aggregate mismatch');
  }
  transactionSync(() => {
    const target = assertTargetWriteFence(sql, fence);
    if (
      target.state !== 'sealing' ||
      target.manifest_page_count !== page.pageIndex ||
      target.manifest_entry_count !== page.entryCount ||
      (target.manifest_head_r2_key ?? null) !== page.previousPageKey ||
      (target.manifest_chain_hash ?? ARCHIVE_AGGREGATE_CHAIN_SEED) !== page.previousChainHash
    ) {
      throw new Error('ProjectData archive manifest page fence changed');
    }
    const cursorTable =
      typeof target.manifest_cursor_table === 'string' ? target.manifest_cursor_table : null;
    const cursorChunkIndex =
      typeof target.manifest_cursor_chunk_index === 'number'
        ? target.manifest_cursor_chunk_index
        : null;
    const expected = selectNextManifestReceipts(
      sql,
      fence.migrationId,
      cursorTable,
      cursorChunkIndex,
      page.entries.length
    );
    if (
      expected.some((row) => typeof row.verified_at !== 'number') ||
      JSON.stringify(expected.map(manifestEntry)) !== JSON.stringify(page.entries)
    ) {
      throw new Error('ProjectData archive manifest page receipt coverage mismatch');
    }
    const last = page.entries.at(-1);
    if (!last) throw new Error('ProjectData archive manifest page lost its last receipt');
    sql.exec(
      `UPDATE project_data_archive_targets
       SET manifest_cursor_table = ?, manifest_cursor_chunk_index = ?,
           manifest_page_count = manifest_page_count + 1,
           manifest_entry_count = manifest_entry_count + ?, manifest_chain_hash = ?,
           manifest_head_r2_key = ?, updated_at = ?
       WHERE migration_id = ? AND state = 'sealing'`,
      last.table,
      last.chunkIndex,
      page.entries.length,
      aggregateHash,
      pageR2Key,
      Date.now(),
      fence.migrationId
    );
  });
}

export async function sealArchiveTarget(
  sql: SqlStorage,
  transactionSync: <T>(callback: () => T) => T,
  fence: ArchiveRpcFence,
  aggregateHash: string,
  manifestR2Key: string
): Promise<void> {
  const target = assertTargetFence(sql, fence);
  if (
    target.state === 'sealed' &&
    target.aggregate_hash === aggregateHash &&
    target.manifest_r2_key === manifestR2Key
  )
    return;
  if (target.state !== 'sealing') throw new Error('ProjectData archive target cannot be sealed');
  transactionSync(() => {
    const current = assertTargetWriteFence(sql, fence);
    if (current.state !== 'sealing') {
      throw new Error('ProjectData archive target sealing state changed');
    }
    const receiptState = sql
      .exec(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN verified_at IS NULL THEN 1 ELSE 0 END) AS unverified
           FROM project_data_archive_chunks WHERE migration_id = ?`,
        fence.migrationId
      )
      .toArray()[0];
    if (
      Number(receiptState?.unverified ?? 0) !== 0 ||
      receiptState?.total !== current.manifest_entry_count ||
      current.manifest_chain_hash !== aggregateHash ||
      (Number(receiptState?.total ?? 0) > 0 && typeof current.manifest_head_r2_key !== 'string')
    ) {
      throw new Error('ProjectData archive paged manifest coverage mismatch during seal');
    }
    // FTS is derived from committed grouped rows. Never copy opaque FTS bytes.
    const ftsExists = sql
      .exec(
        `SELECT 1 AS present FROM sqlite_master
          WHERE type = 'table' AND name = 'chat_messages_grouped_fts' LIMIT 1`
      )
      .toArray().length;
    if (ftsExists) {
      sql.exec(
        `INSERT OR IGNORE INTO chat_messages_grouped_fts (rowid, content)
         SELECT rowid, content FROM chat_messages_grouped WHERE session_id = ?`,
        fence.sessionId
      );
    }
    sql.exec(
      `UPDATE project_data_archive_targets
       SET state = 'sealed', aggregate_hash = ?, manifest_r2_key = ?, updated_at = ?
       WHERE migration_id = ? AND state = 'sealing'`,
      aggregateHash,
      manifestR2Key,
      Date.now(),
      fence.migrationId
    );
  });
}

function deleteSessionPayloadRows(sql: SqlStorage, sessionId: string): void {
  // External-content FTS rows must be removed before their grouped content
  // rows. Use one set-based SQLite statement so finalization does not
  // materialize or loop over an unbounded transcript in JavaScript.
  const ftsExists = sql
    .exec(
      `SELECT 1 AS present FROM sqlite_master
        WHERE type = 'table' AND name = 'chat_messages_grouped_fts' LIMIT 1`
    )
    .toArray().length;
  if (ftsExists) {
    sql.exec(
      `INSERT INTO chat_messages_grouped_fts(chat_messages_grouped_fts, rowid, content)
       SELECT 'delete', grouped.rowid, grouped.content
         FROM chat_messages_grouped grouped
         JOIN chat_messages_grouped_fts fts ON fts.rowid = grouped.rowid
        WHERE grouped.session_id = ?`,
      sessionId
    );
  }
  sql.exec('DELETE FROM chat_messages_grouped WHERE session_id = ?', sessionId);
  sql.exec('DELETE FROM tool_payload_archives WHERE session_id = ?', sessionId);
  sql.exec('DELETE FROM chat_messages WHERE session_id = ?', sessionId);
}

function assertLocalFinalizeDependencies(sql: SqlStorage, sessionId: string): void {
  const session = sql.exec('SELECT status FROM chat_sessions WHERE id = ?', sessionId).toArray()[0];
  if (!session || typeof session.status !== 'string' || !TERMINAL_STATUSES.has(session.status)) {
    throw new Error('ProjectData archive finalize rejected because session is not terminal');
  }
  const checks: Array<{ reason: string; statement: string }> = [
    {
      reason: 'message comments exist',
      statement: 'SELECT COUNT(*) AS cnt FROM comment_threads WHERE session_id = ?',
    },
    {
      reason: 'tool cleanup is incomplete',
      statement: `SELECT COUNT(*) AS cnt FROM tool_payload_cleanup_attempts attempt
        JOIN chat_messages message ON message.id = attempt.message_id
       WHERE message.session_id = ?
         AND attempt.status NOT IN ('archived', 'no_reclaimable_payload', 'invalid_metadata', 'oversized')`,
    },
    {
      reason: 'tool metadata is invalid',
      statement: `SELECT COUNT(*) AS cnt FROM chat_messages
       WHERE session_id = ? AND tool_metadata IS NOT NULL AND json_valid(tool_metadata) = 0`,
    },
    {
      reason: 'inline tool payload exists',
      statement: `SELECT COUNT(*) AS cnt FROM chat_messages
       WHERE session_id = ? AND tool_metadata IS NOT NULL AND json_valid(tool_metadata) = 1
         AND json_type(tool_metadata, '$.content') IS NOT NULL
         AND COALESCE(json_extract(tool_metadata, '$.content'), '') != ''`,
    },
  ];
  for (const check of checks) {
    if (count(sql, check.statement, sessionId) > 0) {
      throw new Error(`ProjectData archive finalize rejected because ${check.reason}`);
    }
  }
}

export async function finalizeArchiveSource(
  sql: SqlStorage,
  transactionSync: <T>(callback: () => T) => T,
  database: D1Database,
  fence: ArchiveRpcFence,
  aggregateHash: string,
  manifestR2Key: string,
  _now = Date.now()
): Promise<SourceDeletedProof> {
  // D1 and DO cannot share a transaction. Verify the live lease immediately
  // before entering the one local delete transaction, then re-check the local
  // token/version/dependencies inside that transaction.
  const journal = await database
    .prepare(
      `SELECT migration.state, migration.lease_token, migration.lease_epoch,
              migration.lease_expires_at, migration.terminal_version,
              migration.aggregate_hash, migration.manifest_r2_key
       FROM project_data_archive_migrations migration
       JOIN project_data_session_locations location
         ON location.project_id = migration.project_id
        AND location.session_id = migration.session_id
       WHERE migration.migration_id = ? AND migration.project_id = ? AND migration.session_id = ?
         AND location.state = 'migrating' AND location.owner_kind = 'root'
         AND location.owner_name = migration.source_owner_name
         AND location.generation = migration.source_generation
         AND location.migration_id = migration.migration_id AND location.routing_version = 1
         AND NOT EXISTS (
           SELECT 1 FROM session_snapshots snapshot
            WHERE snapshot.project_id = migration.project_id
              AND snapshot.chat_session_id = migration.session_id
              AND snapshot.status IN ('available', 'degraded') AND snapshot.expires_at > ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM tasks task
            WHERE task.project_id = migration.project_id
              AND task.chat_session_id = migration.session_id
              AND task.status NOT IN ('completed', 'failed', 'cancelled')
         )`
    )
    .bind(fence.migrationId, fence.projectId, fence.sessionId, new Date().toISOString())
    .first<Record<string, unknown>>();
  const checkedAt = Date.now();
  if (
    !journal ||
    journal.state !== 'sealed' ||
    journal.lease_token !== fence.leaseToken ||
    journal.lease_epoch !== fence.leaseEpoch ||
    journal.lease_expires_at !== fence.leaseExpiresAt ||
    typeof journal.lease_expires_at !== 'number' ||
    journal.lease_expires_at <= checkedAt ||
    journal.terminal_version !== fence.terminalVersion ||
    journal.aggregate_hash !== aggregateHash ||
    journal.manifest_r2_key !== manifestR2Key
  ) {
    throw new Error('ProjectData archive D1 finalize fence mismatch');
  }
  const currentPreimage = terminalVersionPreimage(sql, fence.sessionId);
  if ((await sha256Hex(currentPreimage)) !== fence.terminalVersion) {
    throw new Error('ProjectData archive terminal version changed before finalize');
  }
  const proof = transactionSync(() => {
    const destructiveAt = Date.now();
    const intent = assertSourceFence(sql, fence, destructiveAt);
    if (intent.state === 'source_deleted') return inspectSourceDeletedProof(sql, fence.sessionId);
    if (intent.state !== 'migrating') throw new Error('ProjectData archive source is frozen');
    if (terminalVersionPreimage(sql, fence.sessionId) !== currentPreimage) {
      throw new Error('ProjectData archive terminal version changed during finalize');
    }
    assertLocalFinalizeDependencies(sql, fence.sessionId);
    const lastMessage = sql
      .exec(
        'SELECT MAX(created_at) AS last_message_at FROM chat_messages WHERE session_id = ?',
        fence.sessionId
      )
      .toArray()[0];
    const lastMessageAt =
      typeof lastMessage?.last_message_at === 'number' ? lastMessage.last_message_at : null;
    // Raw/grouped transcript and tool-manifest rows are reclaimed together.
    // Root lifecycle, comments, state, ideas, liveness and summary anchors remain.
    deleteSessionPayloadRows(sql, fence.sessionId);
    sql.exec(
      'UPDATE chat_sessions SET last_message_at = ? WHERE id = ?',
      lastMessageAt,
      fence.sessionId
    );
    sql.exec(
      `UPDATE project_data_archive_source_intents
       SET state = 'source_deleted', aggregate_hash = ?, manifest_r2_key = ?,
           last_message_at = ?, source_database_size_after = ?, updated_at = ?
       WHERE session_id = ? AND migration_id = ? AND state = 'migrating'`,
      aggregateHash,
      manifestR2Key,
      lastMessageAt,
      sql.databaseSize,
      destructiveAt,
      fence.sessionId,
      fence.migrationId
    );
    return inspectSourceDeletedProof(sql, fence.sessionId);
  });
  if (proof.state === 'source_deleted') {
    // Measure after the delete transaction committed. `databaseSize` is the DO
    // quota authority; page-count/page-size estimates are intentionally absent.
    sql.exec(
      `UPDATE project_data_archive_source_intents
       SET source_database_size_after = ?, updated_at = ?
       WHERE session_id = ? AND migration_id = ? AND state = 'source_deleted'`,
      sql.databaseSize,
      Date.now(),
      fence.sessionId,
      fence.migrationId
    );
  }
  return inspectSourceDeletedProof(sql, fence.sessionId);
}

export async function finalizeArchiveRehomeSource(
  sql: SqlStorage,
  transactionSync: <T>(callback: () => T) => T,
  database: D1Database,
  fence: ArchiveRehomeSourceFence,
  aggregateHash: string,
  manifestR2Key: string,
  _now = Date.now()
): Promise<SourceDeletedProof> {
  const journal = await database
    .prepare(
      `SELECT migration.state, migration.source_owner_name, migration.source_generation,
              migration.target_owner_name, migration.target_generation,
              migration.lease_token, migration.lease_epoch, migration.lease_expires_at,
              migration.terminal_version, migration.aggregate_hash, migration.manifest_r2_key
         FROM project_data_archive_migrations migration
         JOIN project_data_session_locations location
           ON location.project_id = migration.project_id
          AND location.session_id = migration.session_id
        WHERE migration.migration_id = ? AND migration.project_id = ? AND migration.session_id = ?
          AND location.state = 'migrating' AND location.owner_kind = 'archive_shard'
          AND location.owner_name = migration.source_owner_name
          AND location.generation = migration.source_generation
          AND location.migration_id = migration.migration_id AND location.routing_version = 1
          AND NOT EXISTS (
            SELECT 1 FROM session_snapshots snapshot
             WHERE snapshot.project_id = migration.project_id
               AND snapshot.chat_session_id = migration.session_id
               AND snapshot.status IN ('available', 'degraded') AND snapshot.expires_at > ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM tasks task
             WHERE task.project_id = migration.project_id
               AND task.chat_session_id = migration.session_id
               AND task.status NOT IN ('completed', 'failed', 'cancelled')
          )`
    )
    .bind(fence.migrationId, fence.projectId, fence.sessionId, new Date().toISOString())
    .first<Record<string, unknown>>();
  const checkedAt = Date.now();
  if (
    !journal ||
    journal.state !== 'sealed' ||
    journal.source_owner_name !== fence.sourceOwnerName ||
    journal.source_generation !== fence.sourceGeneration ||
    journal.target_owner_name !== fence.ownerName ||
    journal.target_generation !== fence.generation ||
    journal.lease_token !== fence.leaseToken ||
    journal.lease_epoch !== fence.leaseEpoch ||
    journal.lease_expires_at !== fence.leaseExpiresAt ||
    typeof journal.lease_expires_at !== 'number' ||
    journal.lease_expires_at <= checkedAt ||
    journal.terminal_version !== fence.terminalVersion ||
    journal.aggregate_hash !== aggregateHash ||
    journal.manifest_r2_key !== manifestR2Key
  ) {
    throw new Error('ProjectData archive rehome D1 finalize fence mismatch');
  }
  const proof = transactionSync(() => {
    const destructiveAt = Date.now();
    const intent = assertRehomeSourceFence(sql, fence, destructiveAt);
    if (intent.state === 'source_deleted') {
      return inspectArchiveRehomeSourceProof(sql, fence.sessionId, fence.sourceGeneration);
    }
    if (intent.state !== 'migrating')
      throw new Error('ProjectData archive rehome source is frozen');
    assertLocalFinalizeDependencies(sql, fence.sessionId);
    const source = sql
      .exec(
        `SELECT state, terminal_version FROM project_data_archive_targets
         WHERE session_id = ? AND project_id = ? AND migration_id = ?
           AND owner_name = ? AND generation = ?`,
        fence.sessionId,
        fence.projectId,
        fence.migrationId,
        fence.sourceOwnerName,
        fence.sourceGeneration
      )
      .toArray()[0];
    if (
      !source ||
      source.state !== 'authoritative' ||
      source.terminal_version !== fence.terminalVersion
    ) {
      throw new Error('ProjectData archive rehome source changed before finalize');
    }
    deleteSessionPayloadRows(sql, fence.sessionId);
    sql.exec('DELETE FROM project_data_archive_chunks WHERE migration_id = ?', fence.migrationId);
    sql.exec(
      `UPDATE project_data_archive_targets SET state = 'replaced', updated_at = ?
       WHERE session_id = ? AND migration_id = ? AND state = 'authoritative'`,
      destructiveAt,
      fence.sessionId,
      fence.migrationId
    );
    // Archive owners carry only a non-authoritative root anchor for this
    // session. The authoritative root session remains in the project owner.
    sql.exec('DELETE FROM chat_sessions WHERE id = ?', fence.sessionId);
    sql.exec(
      `UPDATE project_data_archive_rehome_intents
       SET state = 'source_deleted', aggregate_hash = ?, manifest_r2_key = ?,
           source_database_size_after = ?, updated_at = ?
       WHERE session_id = ? AND source_generation = ?
         AND migration_id = ? AND state = 'migrating'`,
      aggregateHash,
      manifestR2Key,
      sql.databaseSize,
      destructiveAt,
      fence.sessionId,
      fence.sourceGeneration,
      fence.migrationId
    );
    return inspectArchiveRehomeSourceProof(sql, fence.sessionId, fence.sourceGeneration);
  });
  if (proof.state === 'source_deleted') {
    sql.exec(
      `UPDATE project_data_archive_rehome_intents
       SET source_database_size_after = ?, updated_at = ?
       WHERE session_id = ? AND source_generation = ?
         AND migration_id = ? AND state = 'source_deleted'`,
      sql.databaseSize,
      Date.now(),
      fence.sessionId,
      fence.sourceGeneration,
      fence.migrationId
    );
  }
  return inspectArchiveRehomeSourceProof(sql, fence.sessionId, fence.sourceGeneration);
}

export function inspectArchiveRehomeSourceProof(
  sql: SqlStorage,
  sessionId: string,
  sourceGeneration: number
): SourceDeletedProof {
  const row = sql
    .exec(
      `SELECT state, migration_id, aggregate_hash, manifest_r2_key,
              source_database_size_before, source_database_size_after
       FROM project_data_archive_rehome_intents
       WHERE session_id = ? AND source_generation = ?`,
      sessionId,
      sourceGeneration
    )
    .toArray()[0];
  if (!row) {
    return {
      state: 'none',
      migrationId: null,
      aggregateHash: null,
      manifestR2Key: null,
      sourceDatabaseSizeBefore: null,
      sourceDatabaseSizeAfter: null,
    };
  }
  if (row.state !== 'migrating' && row.state !== 'source_deleted' && row.state !== 'frozen') {
    throw new Error('ProjectData archive rehome source proof state is invalid');
  }
  return {
    state: row.state,
    migrationId: typeof row.migration_id === 'string' ? row.migration_id : null,
    aggregateHash: typeof row.aggregate_hash === 'string' ? row.aggregate_hash : null,
    manifestR2Key: typeof row.manifest_r2_key === 'string' ? row.manifest_r2_key : null,
    sourceDatabaseSizeBefore:
      typeof row.source_database_size_before === 'number' ? row.source_database_size_before : null,
    sourceDatabaseSizeAfter:
      typeof row.source_database_size_after === 'number' ? row.source_database_size_after : null,
  };
}

export function inspectSourceDeletedProof(sql: SqlStorage, sessionId: string): SourceDeletedProof {
  const row = sql
    .exec(
      `SELECT state, migration_id, aggregate_hash, manifest_r2_key,
              source_database_size_before, source_database_size_after
       FROM project_data_archive_source_intents WHERE session_id = ?`,
      sessionId
    )
    .toArray()[0];
  if (!row) {
    return {
      state: 'none',
      migrationId: null,
      aggregateHash: null,
      manifestR2Key: null,
      sourceDatabaseSizeBefore: null,
      sourceDatabaseSizeAfter: null,
    };
  }
  if (row.state !== 'migrating' && row.state !== 'source_deleted' && row.state !== 'frozen') {
    throw new Error('ProjectData archive source proof state is invalid');
  }
  return {
    state: row.state,
    migrationId: typeof row.migration_id === 'string' ? row.migration_id : null,
    aggregateHash: typeof row.aggregate_hash === 'string' ? row.aggregate_hash : null,
    manifestR2Key: typeof row.manifest_r2_key === 'string' ? row.manifest_r2_key : null,
    sourceDatabaseSizeBefore:
      typeof row.source_database_size_before === 'number' ? row.source_database_size_before : null,
    sourceDatabaseSizeAfter:
      typeof row.source_database_size_after === 'number' ? row.source_database_size_after : null,
  };
}

export function markArchiveTargetAuthoritative(
  sql: SqlStorage,
  transactionSync: <T>(callback: () => T) => T,
  fence: ArchiveRpcFence,
  aggregateHash: string
): void {
  transactionSync(() => {
    const target = assertTargetFence(sql, fence);
    if (target.state === 'authoritative' && target.aggregate_hash === aggregateHash) return;
    if (target.state !== 'sealed' || target.aggregate_hash !== aggregateHash) {
      throw new Error('ProjectData archive target is not sealed with the published hash');
    }
    sql.exec(
      `UPDATE project_data_archive_targets SET state = 'authoritative', updated_at = ?
       WHERE migration_id = ? AND state = 'sealed'`,
      Date.now(),
      fence.migrationId
    );
  });
}

export async function completeArchiveRootCopyback(
  sql: SqlStorage,
  transactionSync: <T>(callback: () => T) => T,
  database: D1Database,
  fence: ArchiveRpcFence,
  aggregateHash: string,
  routingVersion: number
): Promise<void> {
  if (fence.ownerName !== fence.projectId || fence.generation !== 0) {
    throw new Error('ProjectData archive root copyback owner identity mismatch');
  }
  const authority = await database
    .prepare(
      `SELECT migration.state, migration.target_owner_name, migration.target_generation,
              migration.aggregate_hash, location.state AS location_state,
              location.owner_kind AS location_owner_kind,
              location.owner_name AS location_owner_name,
              location.generation AS location_generation,
              location.migration_id AS location_migration_id,
              location.routing_version AS location_routing_version
         FROM project_data_archive_migrations migration
         JOIN project_data_session_locations location
           ON location.project_id = migration.project_id
          AND location.session_id = migration.session_id
        WHERE migration.migration_id = ? AND migration.project_id = ?
          AND migration.session_id = ?`
    )
    .bind(fence.migrationId, fence.projectId, fence.sessionId)
    .first<Record<string, unknown>>();
  if (
    !authority ||
    authority.state !== 'archived' ||
    authority.target_owner_name !== fence.ownerName ||
    authority.target_generation !== fence.generation ||
    authority.aggregate_hash !== aggregateHash ||
    authority.location_state !== 'root' ||
    authority.location_owner_kind !== 'root' ||
    authority.location_owner_name !== fence.ownerName ||
    authority.location_generation !== fence.generation ||
    authority.location_migration_id !== null ||
    authority.location_routing_version !== routingVersion
  ) {
    throw new Error('ProjectData archive root copyback D1 authority mismatch');
  }
  transactionSync(() => {
    const targetExists = sql
      .exec(
        `SELECT 1 AS present FROM project_data_archive_targets
         WHERE session_id = ? AND migration_id = ?`,
        fence.sessionId,
        fence.migrationId
      )
      .toArray()[0];
    if (targetExists) {
      const target = assertTargetFence(sql, fence);
      if (target.state !== 'authoritative' || target.aggregate_hash !== aggregateHash) {
        throw new Error('ProjectData archive root copyback target is not authoritative');
      }
    } else {
      const orphanedChunks = sql
        .exec(
          `SELECT COUNT(*) AS count FROM project_data_archive_chunks
           WHERE migration_id = ?`,
          fence.migrationId
        )
        .toArray()[0];
      if (orphanedChunks?.count !== 0) {
        throw new Error('ProjectData archive root copyback cleanup proof mismatch');
      }
    }
    const source = sql
      .exec(
        `SELECT state FROM project_data_archive_source_intents
         WHERE session_id = ? AND migration_id = ?`,
        fence.sessionId,
        fence.migrationId
      )
      .toArray()[0];
    if (source && source.state !== 'source_deleted') {
      throw new Error('ProjectData archive root copyback source proof mismatch');
    }
    sql.exec('DELETE FROM project_data_archive_chunks WHERE migration_id = ?', fence.migrationId);
    sql.exec(
      'DELETE FROM project_data_archive_targets WHERE session_id = ? AND migration_id = ?',
      fence.sessionId,
      fence.migrationId
    );
    sql.exec(
      `DELETE FROM project_data_archive_source_intents
       WHERE session_id = ? AND migration_id = ? AND state = 'source_deleted'`,
      fence.sessionId,
      fence.migrationId
    );
  });
}

export function inspectArchiveTarget(
  sql: SqlStorage,
  fence: ArchiveRpcFence
): { state: string; aggregateHash: string | null; manifestR2Key: string | null } {
  const target = assertTargetFence(sql, fence);
  return {
    state: String(target.state),
    aggregateHash: typeof target.aggregate_hash === 'string' ? target.aggregate_hash : null,
    manifestR2Key: typeof target.manifest_r2_key === 'string' ? target.manifest_r2_key : null,
  };
}

export function getArchiveTargetCanonicalBytes(
  sql: SqlStorage,
  expected: {
    projectId: string;
    sessionId: string;
    migrationId: string;
    ownerName: string;
    generation: number;
  }
): number {
  assertArchiveExactReadAllowed(sql, expected);
  const row = sql
    .exec(
      `SELECT COALESCE(SUM(canonical_bytes), 0) AS bytes
       FROM project_data_archive_chunks
       WHERE migration_id = ? AND session_id = ?`,
      expected.migrationId,
      expected.sessionId
    )
    .toArray()[0];
  if (typeof row?.bytes !== 'number' || !Number.isSafeInteger(row.bytes) || row.bytes < 0) {
    throw new Error('ProjectData archive target canonical byte total is malformed');
  }
  return row.bytes;
}

export function assertRootSessionReadAllowed(sql: SqlStorage, sessionId: string): void {
  const source = sql
    .exec('SELECT state FROM project_data_archive_source_intents WHERE session_id = ?', sessionId)
    .toArray()[0];
  if (source)
    throw new Error(`ProjectData exact read rejected: source session is ${String(source.state)}`);
  const target = sql
    .exec('SELECT state FROM project_data_archive_targets WHERE session_id = ?', sessionId)
    .toArray()[0];
  if (target)
    throw new Error('ProjectData exact read requires an expected archive owner and generation');
}

export function assertRootSessionWriteAllowed(sql: SqlStorage, sessionId: string): void {
  const source = sql
    .exec('SELECT state FROM project_data_archive_source_intents WHERE session_id = ?', sessionId)
    .toArray()[0];
  if (source)
    throw new Error(`ProjectData write rejected: archive source is ${String(source.state)}`);
  const target = sql
    .exec('SELECT state FROM project_data_archive_targets WHERE session_id = ?', sessionId)
    .toArray()[0];
  if (target) throw new Error('ProjectData archive target is immutable');
}

export function assertArchiveExactReadAllowed(
  sql: SqlStorage,
  expected: {
    projectId: string;
    sessionId: string;
    migrationId: string;
    ownerName: string;
    generation: number;
  }
): void {
  const rehome = sql
    .exec(
      `SELECT state FROM project_data_archive_rehome_intents
       WHERE session_id = ? AND source_generation = ? AND migration_id = ?`,
      expected.sessionId,
      expected.generation,
      expected.migrationId
    )
    .toArray()[0];
  if (rehome) {
    throw new Error(
      `ProjectData archive exact read rejected: rehome source is ${String(rehome.state)}`
    );
  }
  const target = sql
    .exec(
      `SELECT state FROM project_data_archive_targets
       WHERE project_id = ? AND session_id = ? AND migration_id = ?
         AND owner_name = ? AND generation = ?`,
      expected.projectId,
      expected.sessionId,
      expected.migrationId,
      expected.ownerName,
      expected.generation
    )
    .toArray()[0];
  if (!target || target.state !== 'authoritative') {
    throw new Error('ProjectData archive exact read owner/generation mismatch');
  }
}

export function assertCommentAnchorAvailable(sql: SqlStorage, sessionId: string): void {
  const source = sql
    .exec('SELECT state FROM project_data_archive_source_intents WHERE session_id = ?', sessionId)
    .toArray()[0];
  if (source) {
    throw new Error(
      `Message comments are unavailable because session ${sessionId} is ${String(source.state)} in terminal archive placement`
    );
  }
}

export function getArchiveSessionAnchor(
  sql: SqlStorage,
  sessionId: string
): Record<string, unknown> {
  const row = sql
    .exec(
      `SELECT id, workspace_id, task_id, created_by_user_id, topic, status, message_count,
              started_at, ended_at, created_at, updated_at, agent_completed_at, materialized_at,
              (SELECT MAX(created_at) FROM chat_messages WHERE session_id = chat_sessions.id) AS last_message_at
       FROM chat_sessions WHERE id = ?`,
      sessionId
    )
    .toArray()[0];
  if (!row) throw new Error('ProjectData archive source session is missing');
  return row;
}

export function getDatabaseSize(sql: SqlStorage): number {
  return sql.databaseSize;
}
