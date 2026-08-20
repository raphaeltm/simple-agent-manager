/**
 * Alarm-driven ProjectData session shard migration.
 *
 * Phase 1 migrates immutable stopped-session message payloads. The primary
 * `chat_sessions` row is retained as a facade anchor so existing ACP lineage,
 * linked ideas, and attention rows cannot be removed by ON DELETE CASCADE.
 */
import { createModuleLogger } from '../../lib/logger';
import * as materialization from './materialization';
import {
  chooseShardName,
  estimateStorageSizeBytes,
  getSessionShardName,
  hasShardMigrationCandidate,
  listShardRegistry,
  nextShardName,
  resolveProjectDataShardConfig,
  resolveShardAlarmDelayMs,
} from './sharding';
import type { Env } from './types';

const log = createModuleLogger('project_data.shard_migration');

type SqlValue = string | number | null;

const SESSION_COLUMNS = [
  'id',
  'workspace_id',
  'topic',
  'status',
  'message_count',
  'started_at',
  'ended_at',
  'created_at',
  'updated_at',
  'task_id',
  'agent_completed_at',
  'materialized_at',
  'created_by_user_id',
] as const;

const MESSAGE_COLUMNS = [
  'id',
  'session_id',
  'role',
  'content',
  'tool_metadata',
  'created_at',
  'sequence',
  'origin',
] as const;

const GROUPED_MESSAGE_COLUMNS = ['id', 'session_id', 'role', 'content', 'created_at'] as const;

export interface SessionMigrationBundle {
  sessionId: string;
  session: Record<string, SqlValue>;
  messages: Array<Record<string, SqlValue>>;
  groupedMessages: Array<Record<string, SqlValue>>;
  estimatedSizeBytes: number;
}

export interface ShardReceiveResult {
  sessionId: string;
  messageCount: number;
  groupedMessageCount: number;
  estimatedSizeBytes: number;
}

export interface ShardMigrationHooks {
  getProjectId(): string | null;
  transactionSync<T>(callback: () => T): T;
  getShardStorageSizeBytes(shardName: string): Promise<number>;
  receiveMigratedSessionBundle(
    shardName: string,
    bundle: SessionMigrationBundle
  ): Promise<ShardReceiveResult>;
}

export interface ShardMigrationResult {
  storageBytes: number;
  migratedSessions: number;
  migratedEstimatedBytes: number;
  processedCandidates: number;
  remainingCandidates: boolean;
  shouldRearm: boolean;
  nextDelayMs: number;
}

function toSqlValue(value: unknown, column: string): SqlValue {
  if (value === null || typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`Unsupported SQL value for ${column}`);
}

function toStorageRow<T extends readonly string[]>(
  row: Record<string, unknown>,
  columns: T
): Record<string, SqlValue> {
  const output: Record<string, SqlValue> = {};
  for (const column of columns) output[column] = toSqlValue(row[column], column);
  return output;
}

function rowValues<T extends readonly string[]>(
  row: Record<string, SqlValue>,
  columns: T
): SqlValue[] {
  return columns.map((column) => row[column] ?? null);
}

function estimateValueBytes(value: SqlValue): number {
  if (typeof value === 'string') return value.length * 2;
  if (typeof value === 'number') return 8;
  return 0;
}

function estimateRowsBytes(rows: Array<Record<string, SqlValue>>): number {
  let total = 0;
  for (const row of rows) {
    total += 64;
    for (const value of Object.values(row)) total += estimateValueBytes(value);
  }
  return total;
}

function sessionNumber(bundle: SessionMigrationBundle, key: string): number | null {
  const value = bundle.session[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function selectCandidateSessionIds(sql: SqlStorage, limit: number): string[] {
  return sql
    .exec(
      `SELECT cs.id
       FROM chat_sessions cs
       LEFT JOIN session_shards ss ON ss.session_id = cs.id
       WHERE cs.status = 'stopped'
         AND ss.session_id IS NULL
         AND cs.message_count > 0
       ORDER BY COALESCE(cs.ended_at, cs.started_at), cs.started_at
       LIMIT ?`,
      limit
    )
    .toArray()
    .map((row) => String(row.id));
}

function extractSessionBundle(sql: SqlStorage, sessionId: string): SessionMigrationBundle | null {
  if (getSessionShardName(sql, sessionId)) return null;
  const sessionRow = sql
    .exec(
      `SELECT ${SESSION_COLUMNS.join(', ')}
       FROM chat_sessions
       WHERE id = ? AND status = 'stopped' AND message_count > 0`,
      sessionId
    )
    .toArray()[0];
  if (!sessionRow) return null;

  materialization.materializeSession(sql, sessionId);

  const messageRows = sql
    .exec(
      `SELECT ${MESSAGE_COLUMNS.join(', ')}
       FROM chat_messages
       WHERE session_id = ?
       ORDER BY created_at ASC, sequence ASC`,
      sessionId
    )
    .toArray();
  if (messageRows.length === 0) return null;

  const groupedRows = sql
    .exec(
      `SELECT ${GROUPED_MESSAGE_COLUMNS.join(', ')}
       FROM chat_messages_grouped
       WHERE session_id = ?
       ORDER BY created_at ASC`,
      sessionId
    )
    .toArray();

  const session = toStorageRow(sessionRow, SESSION_COLUMNS);
  const messages = messageRows.map((row) => toStorageRow(row, MESSAGE_COLUMNS));
  const groupedMessages = groupedRows.map((row) => toStorageRow(row, GROUPED_MESSAGE_COLUMNS));
  const estimatedSizeBytes =
    estimateRowsBytes([session]) + estimateRowsBytes(messages) + estimateRowsBytes(groupedMessages);

  return { sessionId, session, messages, groupedMessages, estimatedSizeBytes };
}

function insertRow<T extends readonly string[]>(
  sql: SqlStorage,
  table: string,
  columns: T,
  row: Record<string, SqlValue>,
  insertMode: 'insert' | 'replace' = 'insert'
): void {
  const placeholders = columns.map(() => '?').join(', ');
  const verb = insertMode === 'replace' ? 'INSERT OR REPLACE' : 'INSERT';
  sql.exec(
    `${verb} INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
    ...rowValues(row, columns)
  );
}

function deleteGroupedFtsRows(sql: SqlStorage, sessionId: string): void {
  const rows = sql
    .exec('SELECT rowid, content FROM chat_messages_grouped WHERE session_id = ?', sessionId)
    .toArray();
  for (const row of rows) {
    try {
      sql.exec(
        `INSERT INTO chat_messages_grouped_fts (chat_messages_grouped_fts, rowid, content)
         VALUES ('delete', ?, ?)`,
        toSqlValue(row.rowid, 'rowid'),
        toSqlValue(row.content, 'content')
      );
    } catch {
      return;
    }
  }
}

function insertGroupedFtsRows(sql: SqlStorage, sessionId: string): void {
  const rows = sql
    .exec('SELECT rowid, content FROM chat_messages_grouped WHERE session_id = ?', sessionId)
    .toArray();
  for (const row of rows) {
    try {
      sql.exec(
        'INSERT OR IGNORE INTO chat_messages_grouped_fts (rowid, content) VALUES (?, ?)',
        toSqlValue(row.rowid, 'rowid'),
        toSqlValue(row.content, 'content')
      );
    } catch {
      return;
    }
  }
}

export function receiveMigratedSessionBundle(
  sql: SqlStorage,
  bundle: SessionMigrationBundle
): ShardReceiveResult {
  insertRow(sql, 'chat_sessions', SESSION_COLUMNS, bundle.session, 'replace');
  deleteGroupedFtsRows(sql, bundle.sessionId);
  sql.exec('DELETE FROM chat_messages WHERE session_id = ?', bundle.sessionId);
  sql.exec('DELETE FROM chat_messages_grouped WHERE session_id = ?', bundle.sessionId);

  for (const message of bundle.messages) insertRow(sql, 'chat_messages', MESSAGE_COLUMNS, message);
  for (const grouped of bundle.groupedMessages) {
    insertRow(sql, 'chat_messages_grouped', GROUPED_MESSAGE_COLUMNS, grouped);
  }
  insertGroupedFtsRows(sql, bundle.sessionId);

  const messageCountRow = sql
    .exec('SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?', bundle.sessionId)
    .toArray()[0];
  const groupedCountRow = sql
    .exec(
      'SELECT COUNT(*) AS count FROM chat_messages_grouped WHERE session_id = ?',
      bundle.sessionId
    )
    .toArray()[0];
  return {
    sessionId: bundle.sessionId,
    messageCount: Number(messageCountRow?.count ?? 0),
    groupedMessageCount: Number(groupedCountRow?.count ?? 0),
    estimatedSizeBytes: bundle.estimatedSizeBytes,
  };
}

function updateShardRegistry(
  sql: SqlStorage,
  shardName: string,
  bundle: SessionMigrationBundle
): void {
  const now = Date.now();
  const startedAt = sessionNumber(bundle, 'started_at');
  const endedAt = sessionNumber(bundle, 'ended_at');
  const existing = sql
    .exec('SELECT * FROM shard_registry WHERE shard_name = ?', shardName)
    .toArray()[0];
  if (!existing) {
    sql.exec(
      `INSERT INTO shard_registry (
         shard_name, created_at, session_count, estimated_size_bytes,
         date_range_start, date_range_end
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      shardName,
      now,
      1,
      bundle.estimatedSizeBytes,
      startedAt,
      endedAt
    );
    return;
  }

  const existingStart =
    existing.date_range_start === null ? null : Number(existing.date_range_start);
  const existingEnd = existing.date_range_end === null ? null : Number(existing.date_range_end);
  sql.exec(
    `UPDATE shard_registry
     SET session_count = session_count + 1,
         estimated_size_bytes = estimated_size_bytes + ?,
         date_range_start = ?,
         date_range_end = ?
     WHERE shard_name = ?`,
    bundle.estimatedSizeBytes,
    existingStart === null || startedAt === null
      ? (existingStart ?? startedAt)
      : Math.min(existingStart, startedAt),
    existingEnd === null || endedAt === null
      ? (existingEnd ?? endedAt)
      : Math.max(existingEnd, endedAt),
    shardName
  );
}

function finalizePrimaryMigration(
  sql: SqlStorage,
  shardName: string,
  bundle: SessionMigrationBundle
): boolean {
  const now = Date.now();
  const inserted = sql.exec(
    `INSERT OR IGNORE INTO session_shards (
       session_id, shard_name, migrated_at, session_started_at, session_ended_at
     ) VALUES (?, ?, ?, ?, ?)`,
    bundle.sessionId,
    shardName,
    now,
    sessionNumber(bundle, 'started_at'),
    sessionNumber(bundle, 'ended_at')
  );
  if (inserted.rowsWritten === 0) return false;

  deleteGroupedFtsRows(sql, bundle.sessionId);
  const deletedMessages = sql.exec(
    'DELETE FROM chat_messages WHERE session_id = ?',
    bundle.sessionId
  );
  const deletedGrouped = sql.exec(
    'DELETE FROM chat_messages_grouped WHERE session_id = ?',
    bundle.sessionId
  );
  if (deletedMessages.rowsWritten !== bundle.messages.length) {
    throw new Error(`Primary raw message delete mismatch for ${bundle.sessionId}`);
  }
  if (deletedGrouped.rowsWritten !== bundle.groupedMessages.length) {
    throw new Error(`Primary grouped message delete mismatch for ${bundle.sessionId}`);
  }
  updateShardRegistry(sql, shardName, bundle);
  return true;
}

export async function processShardMigration(
  sql: SqlStorage,
  env: Env,
  hooks: ShardMigrationHooks
): Promise<ShardMigrationResult> {
  const config = resolveProjectDataShardConfig(env);
  const storageBytes = estimateStorageSizeBytes(sql);
  const nextDelayMs = resolveShardAlarmDelayMs(env);
  const projectId = hooks.getProjectId();
  if (!projectId || storageBytes < config.migrationThresholdBytes) {
    return {
      storageBytes,
      migratedSessions: 0,
      migratedEstimatedBytes: 0,
      processedCandidates: 0,
      remainingCandidates: false,
      shouldRearm: false,
      nextDelayMs,
    };
  }

  const targetBytes =
    storageBytes >= config.aggressiveThresholdBytes
      ? config.targetSizeBytes
      : config.migrationThresholdBytes;
  const requiredMoveBytes = Math.max(1, storageBytes - targetBytes);
  const hardBrake = storageBytes >= config.hardBrakeThresholdBytes;
  const candidates = selectCandidateSessionIds(sql, config.migrationBatchSize);
  let migratedSessions = 0;
  let migratedEstimatedBytes = 0;
  let processedCandidates = 0;

  for (const sessionId of candidates) {
    const bundle = hooks.transactionSync(() => extractSessionBundle(sql, sessionId));
    processedCandidates++;
    if (!bundle) continue;

    const registry = listShardRegistry(sql);
    let shardName = chooseShardName(
      projectId,
      registry,
      bundle.estimatedSizeBytes,
      config.maxShardSizeBytes
    );
    const shardStorageBytes = await hooks.getShardStorageSizeBytes(shardName);
    if (shardStorageBytes >= config.maxShardSizeBytes) {
      shardName = nextShardName(projectId, registry);
    }

    const received = await hooks.receiveMigratedSessionBundle(shardName, bundle);
    if (
      received.messageCount !== bundle.messages.length ||
      received.groupedMessageCount !== bundle.groupedMessages.length
    ) {
      throw new Error(`Shard verification failed for ${bundle.sessionId} in ${shardName}`);
    }

    const finalized = hooks.transactionSync(() => finalizePrimaryMigration(sql, shardName, bundle));
    if (finalized) {
      migratedSessions++;
      migratedEstimatedBytes += bundle.estimatedSizeBytes;
    }
    if (!hardBrake && migratedEstimatedBytes >= requiredMoveBytes) break;
  }

  const remainingCandidates = hasShardMigrationCandidate(sql);
  const shouldRearm =
    remainingCandidates &&
    (hardBrake ||
      migratedSessions === config.migrationBatchSize ||
      migratedEstimatedBytes < requiredMoveBytes);

  if (migratedSessions > 0) {
    log.info('migration_batch_completed', {
      migratedSessions,
      migratedEstimatedBytes,
      storageBytes,
      remainingCandidates,
      shouldRearm,
    });
  }

  return {
    storageBytes,
    migratedSessions,
    migratedEstimatedBytes,
    processedCandidates,
    remainingCandidates,
    shouldRearm,
    nextDelayMs,
  };
}
