/**
 * ProjectData same-class shard routing helpers.
 *
 * The primary ProjectData Durable Object remains the facade. Shards are
 * addressed through the same PROJECT_DATA binding with names like
 * `${projectId}:shard:001`.
 */
import type { SearchResult } from './messages';
import type { Env } from './types';

const GIB = 1024 * 1024 * 1024;

export const DEFAULT_DO_SHARD_MIGRATION_THRESHOLD_BYTES = 7 * GIB;
export const DEFAULT_DO_SHARD_AGGRESSIVE_THRESHOLD_BYTES = Math.floor(8.5 * GIB);
export const DEFAULT_DO_SHARD_HARD_BRAKE_THRESHOLD_BYTES = 9 * GIB;
export const DEFAULT_DO_SHARD_TARGET_SIZE_BYTES = 5 * GIB;
export const DEFAULT_DO_SHARD_MAX_SIZE_BYTES = 2 * GIB;
export const DEFAULT_DO_SHARD_MIGRATION_BATCH_SIZE = 10;
export const DEFAULT_DO_SHARD_CHECK_INTERVAL_MS = 60 * 60 * 1000;

const MAX_DO_SHARD_MIGRATION_BATCH_SIZE = 100;
const MIN_DO_SHARD_CHECK_INTERVAL_MS = 60 * 1000;
const SHARD_NAME_MARKER = ':shard:';

export interface ProjectDataShardConfig {
  migrationThresholdBytes: number;
  aggressiveThresholdBytes: number;
  hardBrakeThresholdBytes: number;
  targetSizeBytes: number;
  maxShardSizeBytes: number;
  migrationBatchSize: number;
  checkIntervalMs: number;
}

export interface SessionShardLocation {
  sessionId: string;
  shardName: string;
  migratedAt: number;
  sessionStartedAt: number | null;
  sessionEndedAt: number | null;
}

export interface ShardRegistryEntry {
  shardName: string;
  createdAt: number;
  sessionCount: number;
  estimatedSizeBytes: number;
  dateRangeStart: number | null;
  dateRangeEnd: number | null;
}

export interface ProjectDataShardRpc {
  getSession(sessionId: string): Promise<Record<string, unknown> | null>;
  getMessages(
    sessionId: string,
    limit?: number,
    before?: number | null,
    after?: number | null,
    roles?: string[],
    compact?: boolean,
    order?: 'asc' | 'desc'
  ): Promise<{ messages: Record<string, unknown>[]; hasMore: boolean }>;
  getMessageToolContent(sessionId: string, messageId: string): Promise<unknown[] | null>;
  getMessageCount(sessionId: string, roles?: string[]): Promise<number>;
  searchMessages(
    query: string,
    sessionId?: string | null,
    roles?: string[] | null,
    limit?: number
  ): Promise<SearchResult[]>;
  getStorageSizeBytes(): Promise<number>;
}

function parsePositiveInt(raw: string | undefined, fallback: number, max?: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return max ? Math.min(parsed, max) : parsed;
}

export function resolveProjectDataShardConfig(env: Env): ProjectDataShardConfig {
  return {
    migrationThresholdBytes: parsePositiveInt(
      env.DO_SHARD_MIGRATION_THRESHOLD_BYTES,
      DEFAULT_DO_SHARD_MIGRATION_THRESHOLD_BYTES
    ),
    aggressiveThresholdBytes: parsePositiveInt(
      env.DO_SHARD_AGGRESSIVE_THRESHOLD_BYTES,
      DEFAULT_DO_SHARD_AGGRESSIVE_THRESHOLD_BYTES
    ),
    hardBrakeThresholdBytes: parsePositiveInt(
      env.DO_SHARD_HARD_BRAKE_THRESHOLD_BYTES,
      DEFAULT_DO_SHARD_HARD_BRAKE_THRESHOLD_BYTES
    ),
    targetSizeBytes: parsePositiveInt(
      env.DO_SHARD_TARGET_SIZE_BYTES,
      DEFAULT_DO_SHARD_TARGET_SIZE_BYTES
    ),
    maxShardSizeBytes: parsePositiveInt(
      env.DO_SHARD_MAX_SIZE_BYTES,
      DEFAULT_DO_SHARD_MAX_SIZE_BYTES
    ),
    migrationBatchSize: parsePositiveInt(
      env.DO_SHARD_MIGRATION_BATCH_SIZE,
      DEFAULT_DO_SHARD_MIGRATION_BATCH_SIZE,
      MAX_DO_SHARD_MIGRATION_BATCH_SIZE
    ),
    checkIntervalMs: parsePositiveInt(
      env.DO_SHARD_CHECK_INTERVAL_MS,
      DEFAULT_DO_SHARD_CHECK_INTERVAL_MS
    ),
  };
}

export function resolveShardAlarmDelayMs(env: Env): number {
  return Math.max(
    resolveProjectDataShardConfig(env).checkIntervalMs,
    MIN_DO_SHARD_CHECK_INTERVAL_MS
  );
}

function numericPragmaValue(row: Record<string, unknown> | undefined, key: string): number {
  const value = row?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function estimateStorageSizeBytesFromPragmas(sql: SqlStorage): number {
  const pageCountRow = sql.exec('PRAGMA page_count').toArray()[0];
  const pageSizeRow = sql.exec('PRAGMA page_size').toArray()[0];
  const pageCount = numericPragmaValue(pageCountRow, 'page_count');
  const pageSize = numericPragmaValue(pageSizeRow, 'page_size');
  return pageCount * pageSize;
}

export function estimateStorageSizeBytes(sql: SqlStorage): number {
  try {
    return estimateStorageSizeBytesFromPragmas(sql);
  } catch {
    return sql.databaseSize;
  }
}

export function getSessionShardName(sql: SqlStorage, sessionId: string): string | null {
  const row = sql
    .exec('SELECT shard_name FROM session_shards WHERE session_id = ?', sessionId)
    .toArray()[0];
  return typeof row?.shard_name === 'string' ? row.shard_name : null;
}

export function listShardRegistry(sql: SqlStorage): ShardRegistryEntry[] {
  return sql
    .exec(
      `SELECT shard_name, created_at, session_count, estimated_size_bytes,
              date_range_start, date_range_end
       FROM shard_registry
       ORDER BY created_at ASC, shard_name ASC`
    )
    .toArray()
    .map((row) => ({
      shardName: String(row.shard_name),
      createdAt: Number(row.created_at),
      sessionCount: Number(row.session_count ?? 0),
      estimatedSizeBytes: Number(row.estimated_size_bytes ?? 0),
      dateRangeStart: row.date_range_start === null ? null : Number(row.date_range_start),
      dateRangeEnd: row.date_range_end === null ? null : Number(row.date_range_end),
    }));
}

export function listShardNames(sql: SqlStorage): string[] {
  return listShardRegistry(sql).map((entry) => entry.shardName);
}

export function hasShardMigrationCandidate(sql: SqlStorage): boolean {
  const row = sql
    .exec(
      `SELECT cs.id
       FROM chat_sessions cs
       LEFT JOIN session_shards ss ON ss.session_id = cs.id
       WHERE cs.status = 'stopped'
         AND ss.session_id IS NULL
         AND cs.message_count > 0
       ORDER BY COALESCE(cs.ended_at, cs.started_at), cs.started_at
       LIMIT 1`
    )
    .toArray()[0];
  return !!row;
}

export function computeShardMigrationAlarmTime(
  sql: SqlStorage,
  env: Env,
  projectId: string | null
): number | null {
  if (!projectId) return null;
  const config = resolveProjectDataShardConfig(env);
  if (estimateStorageSizeBytes(sql) < config.migrationThresholdBytes) return null;
  if (!hasShardMigrationCandidate(sql)) return null;
  return Date.now() + resolveShardAlarmDelayMs(env);
}

export function buildShardName(projectId: string, ordinal: number): string {
  return `${projectId}${SHARD_NAME_MARKER}${ordinal.toString().padStart(3, '0')}`;
}

export function parseShardOrdinal(projectId: string, shardName: string): number | null {
  const prefix = `${projectId}${SHARD_NAME_MARKER}`;
  if (!shardName.startsWith(prefix)) return null;
  const parsed = Number.parseInt(shardName.slice(prefix.length), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function nextShardName(projectId: string, registry: ShardRegistryEntry[]): string {
  let maxOrdinal = 0;
  for (const entry of registry) {
    const ordinal = parseShardOrdinal(projectId, entry.shardName);
    if (ordinal && ordinal > maxOrdinal) maxOrdinal = ordinal;
  }
  return buildShardName(projectId, maxOrdinal + 1);
}

export function chooseShardName(
  projectId: string,
  registry: ShardRegistryEntry[],
  sessionEstimateBytes: number,
  maxShardSizeBytes: number
): string {
  const existing = registry.find(
    (entry) => entry.estimatedSizeBytes + sessionEstimateBytes <= maxShardSizeBytes
  );
  return existing?.shardName ?? nextShardName(projectId, registry);
}

export function mergeSearchResults(resultSets: SearchResult[][], limit: number): SearchResult[] {
  const deduped = new Map<string, SearchResult>();
  for (const result of resultSets.flat()) {
    const key = `${result.sessionId}:${result.id}`;
    const existing = deduped.get(key);
    if (!existing || result.createdAt > existing.createdAt) deduped.set(key, result);
  }
  return [...deduped.values()]
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .slice(0, limit);
}
