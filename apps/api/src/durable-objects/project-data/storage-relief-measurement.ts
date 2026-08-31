import type { StorageSafetyConfig } from './storage-safety';

const TOOL_PAYLOAD_CONTENT_NEEDLE = '"content"';

export type ProjectDataStorageReliefMeasureCursor = {
  grouped?: {
    sessionId: string;
    createdAt: number;
    id: string;
  };
  toolPayload?: {
    sessionId: string;
    createdAt: number;
    sequence: number;
    messageId: string;
  };
};

export type ProjectDataStorageReliefMeasureInput = {
  cursor?: ProjectDataStorageReliefMeasureCursor | null;
  limit?: number | null;
};

export type ProjectDataStorageReliefMeasureResult = {
  measuredAt: number;
  databaseSizeBytes: number;
  limit: number;
  grouped: {
    rowsExamined: number;
    rows: number;
    contentBytes: number;
    eligibleRows: number;
    eligibleContentBytes: number;
    ftsRowsPresent: number;
    ftsRowsMissing: number;
    nextCursor: ProjectDataStorageReliefMeasureCursor['grouped'] | null;
    hasMore: boolean;
  };
  toolPayloads: {
    rowsExamined: number;
    eligibleRows: number;
    eligibleBytes: number;
    legacyOversizedRows: number;
    legacyOversizedBytes: number;
    oversizedRows: number;
    oversizedBytes: number;
    archivedRows: number;
    skippedRows: number;
    nextCursor: ProjectDataStorageReliefMeasureCursor['toolPayload'] | null;
    hasMore: boolean;
  };
};

function rawNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function clampLimit(config: StorageSafetyConfig, requested: number | null | undefined): number {
  if (requested === null || requested === undefined) return config.storageReliefMeasureBatchRows;
  if (!Number.isSafeInteger(requested) || requested < 1)
    return config.storageReliefMeasureBatchRows;
  return Math.min(requested, config.storageReliefMeasureMaxBatchRows);
}

function measureGroupedSlice(
  sql: SqlStorage,
  config: StorageSafetyConfig,
  measuredAt: number,
  cursor: ProjectDataStorageReliefMeasureCursor['grouped'] | null | undefined,
  limit: number
): ProjectDataStorageReliefMeasureResult['grouped'] {
  const cutoff = measuredAt - config.groupedFtsCleanupMinSessionAgeMs;
  const rows = sql
    .exec(
      `SELECT
         g.id,
         g.session_id,
         g.created_at,
         length(CAST(g.content AS BLOB)) AS content_bytes,
         CASE WHEN s.status IN ('stopped', 'failed')
                AND s.updated_at <= ?
                AND COALESCE(s.search_index_state, 'complete') != 'grouped_fts_pruned'
              THEN 1 ELSE 0 END AS eligible,
         CASE WHEN f.rowid IS NULL THEN 0 ELSE 1 END AS fts_present
       FROM chat_messages_grouped g
       JOIN chat_sessions s ON s.id = g.session_id
       LEFT JOIN chat_messages_grouped_fts f ON f.rowid = g.rowid
       WHERE (
         ? IS NULL
         OR g.session_id > ?
         OR (
           g.session_id = ?
           AND (
             g.created_at > ?
             OR (g.created_at = ? AND g.id > ?)
           )
         )
       )
       ORDER BY g.session_id ASC, g.created_at ASC, g.id ASC
       LIMIT ?`,
      cutoff,
      cursor?.sessionId ?? null,
      cursor?.sessionId ?? '',
      cursor?.sessionId ?? '',
      cursor?.createdAt ?? 0,
      cursor?.createdAt ?? 0,
      cursor?.id ?? '',
      limit + 1
    )
    .raw();

  let rowsExamined = 0;
  let rowCount = 0;
  let contentBytes = 0;
  let eligibleRows = 0;
  let eligibleContentBytes = 0;
  let ftsRowsPresent = 0;
  let ftsRowsMissing = 0;
  let nextCursor: ProjectDataStorageReliefMeasureCursor['grouped'] | null = null;
  let hasMore = false;

  for (const row of rows) {
    const id = row[0];
    const sessionId = row[1];
    const createdAt = rawNumber(row[2]);
    const rowBytes = rawNumber(row[3]) ?? 0;
    const eligible = rawNumber(row[4]) === 1;
    const ftsPresent = rawNumber(row[5]) === 1;
    if (typeof id !== 'string' || typeof sessionId !== 'string' || createdAt === null) continue;
    if (rowsExamined >= limit) {
      hasMore = true;
      break;
    }
    rowsExamined++;
    rowCount++;
    contentBytes += rowBytes;
    if (eligible) {
      eligibleRows++;
      eligibleContentBytes += rowBytes;
    }
    if (ftsPresent) ftsRowsPresent++;
    else ftsRowsMissing++;
    nextCursor = { sessionId, createdAt, id };
  }

  return {
    rowsExamined,
    rows: rowCount,
    contentBytes,
    eligibleRows,
    eligibleContentBytes,
    ftsRowsPresent,
    ftsRowsMissing,
    nextCursor: hasMore ? nextCursor : null,
    hasMore,
  };
}

function measureToolPayloadSlice(
  sql: SqlStorage,
  config: StorageSafetyConfig,
  measuredAt: number,
  cursor: ProjectDataStorageReliefMeasureCursor['toolPayload'] | null | undefined,
  limit: number
): ProjectDataStorageReliefMeasureResult['toolPayloads'] {
  const cutoff = measuredAt - config.toolPayloadArchiveRetentionMs;
  const rows = sql
    .exec(
      `SELECT
         m.id,
         m.session_id,
         m.created_at,
         COALESCE(m.sequence, 0) AS sequence,
         length(CAST(m.tool_metadata AS BLOB)) AS tool_metadata_bytes,
         CASE WHEN archived.message_id IS NULL THEN 0 ELSE 1 END AS archived,
         CASE WHEN attempt.message_id IS NULL THEN 0 ELSE 1 END AS skipped
       FROM chat_messages m
       LEFT JOIN tool_payload_archives archived ON archived.message_id = m.id
       LEFT JOIN tool_payload_cleanup_attempts attempt ON attempt.message_id = m.id
       WHERE m.role = 'tool'
         AND m.tool_metadata IS NOT NULL
         AND instr(m.tool_metadata, ?) > 0
         AND m.created_at < ?
         AND (
           ? IS NULL
           OR m.session_id > ?
           OR (
             m.session_id = ?
             AND (
               m.created_at > ?
               OR (m.created_at = ? AND COALESCE(m.sequence, 0) > ?)
               OR (m.created_at = ? AND COALESCE(m.sequence, 0) = ? AND m.id > ?)
             )
           )
         )
       ORDER BY m.session_id ASC, m.created_at ASC, sequence ASC, m.id ASC
       LIMIT ?`,
      TOOL_PAYLOAD_CONTENT_NEEDLE,
      cutoff,
      cursor?.sessionId ?? null,
      cursor?.sessionId ?? '',
      cursor?.sessionId ?? '',
      cursor?.createdAt ?? 0,
      cursor?.createdAt ?? 0,
      cursor?.sequence ?? 0,
      cursor?.createdAt ?? 0,
      cursor?.sequence ?? 0,
      cursor?.messageId ?? '',
      limit + 1
    )
    .raw();

  let rowsExamined = 0;
  let eligibleRows = 0;
  let eligibleBytes = 0;
  let legacyOversizedRows = 0;
  let legacyOversizedBytes = 0;
  let oversizedRows = 0;
  let oversizedBytes = 0;
  let archivedRows = 0;
  let skippedRows = 0;
  let nextCursor: ProjectDataStorageReliefMeasureCursor['toolPayload'] | null = null;
  let hasMore = false;

  for (const row of rows) {
    const messageId = row[0];
    const sessionId = row[1];
    const createdAt = rawNumber(row[2]);
    const sequence = rawNumber(row[3]);
    const bytes = rawNumber(row[4]) ?? 0;
    const archived = rawNumber(row[5]) === 1;
    const skipped = rawNumber(row[6]) === 1;
    if (
      typeof messageId !== 'string' ||
      typeof sessionId !== 'string' ||
      createdAt === null ||
      sequence === null
    ) {
      continue;
    }
    if (rowsExamined >= limit) {
      hasMore = true;
      break;
    }
    rowsExamined++;
    if (archived) archivedRows++;
    else if (skipped) skippedRows++;
    else if (bytes > config.toolPayloadArchiveMaxMetadataBytes) {
      oversizedRows++;
      oversizedBytes += bytes;
    } else {
      if (bytes > config.toolPayloadCleanupMaxRowBytes) {
        legacyOversizedRows++;
        legacyOversizedBytes += bytes;
      }
      eligibleRows++;
      eligibleBytes += bytes;
    }
    nextCursor = { sessionId, createdAt, sequence, messageId };
  }

  return {
    rowsExamined,
    eligibleRows,
    eligibleBytes,
    legacyOversizedRows,
    legacyOversizedBytes,
    oversizedRows,
    oversizedBytes,
    archivedRows,
    skippedRows,
    nextCursor: hasMore ? nextCursor : null,
    hasMore,
  };
}

export function measureProjectDataStorageReliefSlice(
  sql: SqlStorage,
  config: StorageSafetyConfig,
  input: ProjectDataStorageReliefMeasureInput = {}
): ProjectDataStorageReliefMeasureResult {
  const measuredAt = Date.now();
  const limit = clampLimit(config, input.limit);
  return {
    measuredAt,
    databaseSizeBytes: sql.databaseSize,
    limit,
    grouped: measureGroupedSlice(sql, config, measuredAt, input.cursor?.grouped, limit),
    toolPayloads: measureToolPayloadSlice(
      sql,
      config,
      measuredAt,
      input.cursor?.toolPayload,
      limit
    ),
  };
}
