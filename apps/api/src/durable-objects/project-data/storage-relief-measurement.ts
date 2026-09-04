import type { StorageSafetyConfig } from './storage-safety';
import { projectToolPayloadArchiveRelief } from './tool-payload-archive';
import type { Env } from './types';

export type ProjectDataStorageReliefMeasureCursor = {
  grouped?: {
    sessionId: string;
    createdAt: number;
    id: string;
  };
  toolPayload?: {
    rowId: number;
    sessionId: string;
    createdAt: number;
    sequence: number;
    messageId: string;
  };
};

export type ProjectDataStorageReliefMeasureInput = {
  cursor?: ProjectDataStorageReliefMeasureCursor | null;
  limit?: number | null;
  surface?: 'all' | 'tool_payloads';
  cutoffCreatedAt?: number | null;
  maxEligibleBytes?: number | null;
  deadlineMs?: number | null;
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
    rearchivableOversizedRows: number;
    rearchivableOversizedBytes: number;
    oversizedRows: number;
    oversizedBytes: number;
    archivedRows: number;
    skippedRows: number;
    targets: ProjectDataStorageReliefToolPayloadTarget[];
    byteLimitReached: boolean;
    deadlineReached: boolean;
    sessions: ProjectDataStorageReliefToolPayloadSessionMeasure[];
    nextCursor: ProjectDataStorageReliefMeasureCursor['toolPayload'] | null;
    hasMore: boolean;
  };
};

export type ProjectDataStorageReliefToolPayloadTarget = {
  rowId: number;
  sessionId: string;
  messageId: string;
  messageCreatedAt: number;
  messageSequence: number;
  toolMetadataBytes: number;
  toolMetadataSha256: string;
  projectedReclaimableBytes: number;
};

export type ProjectDataStorageReliefToolPayloadSessionMeasure = {
  sessionId: string;
  rowsExamined: number;
  eligibleRows: number;
  eligibleBytes: number;
  legacyOversizedRows: number;
  legacyOversizedBytes: number;
  rearchivableOversizedRows: number;
  rearchivableOversizedBytes: number;
  oversizedRows: number;
  oversizedBytes: number;
  archivedRows: number;
  skippedRows: number;
};

export function toolPayloadStorageReliefCursorFilter(
  cursor: ProjectDataStorageReliefMeasureCursor['toolPayload'] | null | undefined
): { clause: string; params: Array<string | number> } {
  return cursor
    ? {
        clause: 'WHERE rowid > ?',
        params: [cursor.rowId],
      }
    : { clause: '', params: [] };
}

export function toolPayloadStorageReliefRawWindowQuery(
  cursor: ProjectDataStorageReliefMeasureCursor['toolPayload'] | null | undefined
): { sql: string; params: Array<string | number> } {
  const cursorFilter = toolPayloadStorageReliefCursorFilter(cursor);
  return {
    sql: `WITH raw_window AS MATERIALIZED (
      SELECT rowid AS physical_rowid, id, session_id, role, created_at, sequence,
             length(CAST(tool_metadata AS BLOB)) AS tool_metadata_bytes
      FROM chat_messages
      ${cursorFilter.clause}
      ORDER BY rowid ASC
      LIMIT ?
    )
    SELECT rw.physical_rowid, rw.id, rw.session_id, rw.role, rw.created_at, rw.sequence,
           rw.tool_metadata_bytes,
           CASE WHEN archived.message_id IS NULL THEN 0 ELSE 1 END AS archived,
           attempt.status AS attempt_status,
           attempt.next_attempt_at
    FROM raw_window rw
    LEFT JOIN tool_payload_archives archived ON archived.message_id = rw.id
    LEFT JOIN tool_payload_cleanup_attempts attempt ON attempt.message_id = rw.id
    ORDER BY rw.physical_rowid ASC`,
    params: cursorFilter.params,
  };
}

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

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function measureToolPayloadSlice(
  sql: SqlStorage,
  env: Env,
  config: StorageSafetyConfig,
  measuredAt: number,
  cursor: ProjectDataStorageReliefMeasureCursor['toolPayload'] | null | undefined,
  limit: number,
  cutoffCreatedAt?: number | null,
  maxEligibleBytes?: number | null,
  deadlineMs?: number | null
): Promise<ProjectDataStorageReliefMeasureResult['toolPayloads']> {
  const cutoff =
    typeof cutoffCreatedAt === 'number' &&
    Number.isSafeInteger(cutoffCreatedAt) &&
    cutoffCreatedAt >= 0 &&
    cutoffCreatedAt <= measuredAt
      ? cutoffCreatedAt
      : measuredAt - config.toolPayloadArchiveRetentionMs;
  const remainingEligibleBytes =
    typeof maxEligibleBytes === 'number' && Number.isSafeInteger(maxEligibleBytes)
      ? Math.max(maxEligibleBytes, 0)
      : Number.MAX_SAFE_INTEGER;
  const readToolMetadata = (messageId: string): string | null => {
    const row = sql
      .exec(
        `SELECT tool_metadata
         FROM chat_messages
         WHERE id = ?
           AND tool_metadata IS NOT NULL
           AND length(CAST(tool_metadata AS BLOB)) <= ?
         LIMIT 1`,
        messageId,
        config.toolPayloadArchiveMaxMetadataBytes
      )
      .raw()
      .next();
    return !row.done && typeof row.value[0] === 'string' ? row.value[0] : null;
  };
  const rawWindow = toolPayloadStorageReliefRawWindowQuery(cursor);
  const rows = sql.exec(rawWindow.sql, ...rawWindow.params, limit + 1).raw();

  let rowsExamined = 0;
  let eligibleRows = 0;
  let eligibleBytes = 0;
  let legacyOversizedRows = 0;
  let legacyOversizedBytes = 0;
  let rearchivableOversizedRows = 0;
  let rearchivableOversizedBytes = 0;
  let oversizedRows = 0;
  let oversizedBytes = 0;
  let archivedRows = 0;
  let skippedRows = 0;
  const targets: ProjectDataStorageReliefToolPayloadTarget[] = [];
  let byteLimitReached = false;
  let deadlineReached = false;
  let nextCursor: ProjectDataStorageReliefMeasureCursor['toolPayload'] | null = null;
  let hasMore = false;
  const sessions = new Map<string, ProjectDataStorageReliefToolPayloadSessionMeasure>();

  for (const row of rows) {
    const previousCursor = nextCursor;
    const rowId = rawNumber(row[0]);
    const messageId = row[1];
    const sessionId = row[2];
    const role = row[3];
    const createdAt = rawNumber(row[4]);
    const sequence = rawNumber(row[5]);
    const bytes = rawNumber(row[6]) ?? 0;
    const archived = rawNumber(row[7]) === 1;
    const attemptStatus = typeof row[8] === 'string' ? row[8] : null;
    const nextAttemptAt = rawNumber(row[9]);
    if (
      rowId === null ||
      typeof messageId !== 'string' ||
      typeof sessionId !== 'string' ||
      createdAt === null
    ) {
      continue;
    }
    if (rowsExamined >= limit) {
      hasMore = true;
      break;
    }
    if (deadlineMs !== null && deadlineMs !== undefined && Date.now() >= deadlineMs) {
      hasMore = true;
      deadlineReached = true;
      break;
    }
    rowsExamined++;
    nextCursor = {
      rowId,
      sessionId,
      createdAt,
      sequence: sequence ?? -1,
      messageId,
    };
    let session = sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        rowsExamined: 0,
        eligibleRows: 0,
        eligibleBytes: 0,
        legacyOversizedRows: 0,
        legacyOversizedBytes: 0,
        rearchivableOversizedRows: 0,
        rearchivableOversizedBytes: 0,
        oversizedRows: 0,
        oversizedBytes: 0,
        archivedRows: 0,
        skippedRows: 0,
      };
      sessions.set(sessionId, session);
    }
    session.rowsExamined++;
    if (role !== 'tool' || sequence === null || bytes <= 0 || createdAt >= cutoff || archived) {
      if (archived) {
        archivedRows++;
        session.archivedRows++;
      }
      continue;
    }
    if (attemptStatus === 'no_reclaimable_payload' || attemptStatus === 'invalid_metadata') {
      skippedRows++;
      session.skippedRows++;
    } else if (bytes > config.toolPayloadArchiveMaxMetadataBytes) {
      oversizedRows++;
      oversizedBytes += bytes;
      session.oversizedRows++;
      session.oversizedBytes += bytes;
    } else if (
      attemptStatus === 'retryable_failure' &&
      nextAttemptAt !== null &&
      nextAttemptAt > measuredAt
    ) {
      skippedRows++;
      session.skippedRows++;
    } else {
      const toolMetadata = readToolMetadata(messageId);
      if (toolMetadata === null) {
        skippedRows++;
        session.skippedRows++;
        continue;
      }
      const projection = projectToolPayloadArchiveRelief({
        env,
        toolMetadata,
        archivedAt: measuredAt,
      });
      if (!projection) {
        skippedRows++;
        session.skippedRows++;
        continue;
      }
      if (eligibleBytes + projection.reclaimableBytes > remainingEligibleBytes) {
        hasMore = true;
        byteLimitReached = true;
        nextCursor = previousCursor ?? cursor ?? null;
        break;
      }
      const toolMetadataSha256 = await sha256Text(toolMetadata);
      targets.push({
        rowId,
        sessionId,
        messageId,
        messageCreatedAt: createdAt,
        messageSequence: sequence,
        toolMetadataBytes: bytes,
        toolMetadataSha256,
        projectedReclaimableBytes: projection.reclaimableBytes,
      });
      if (attemptStatus === 'oversized') {
        rearchivableOversizedRows++;
        rearchivableOversizedBytes += projection.reclaimableBytes;
        session.rearchivableOversizedRows++;
        session.rearchivableOversizedBytes += projection.reclaimableBytes;
      }
      if (bytes > config.toolPayloadCleanupMaxRowBytes) {
        legacyOversizedRows++;
        legacyOversizedBytes += bytes;
        session.legacyOversizedRows++;
        session.legacyOversizedBytes += bytes;
      }
      eligibleRows++;
      eligibleBytes += projection.reclaimableBytes;
      session.eligibleRows++;
      session.eligibleBytes += projection.reclaimableBytes;
    }
  }

  return {
    rowsExamined,
    eligibleRows,
    eligibleBytes,
    legacyOversizedRows,
    legacyOversizedBytes,
    rearchivableOversizedRows,
    rearchivableOversizedBytes,
    oversizedRows,
    oversizedBytes,
    archivedRows,
    skippedRows,
    targets,
    byteLimitReached,
    deadlineReached,
    sessions: [...sessions.values()],
    nextCursor: hasMore ? nextCursor : null,
    hasMore,
  };
}

export async function measureProjectDataStorageReliefSlice(
  sql: SqlStorage,
  env: Env,
  config: StorageSafetyConfig,
  input: ProjectDataStorageReliefMeasureInput = {}
): Promise<ProjectDataStorageReliefMeasureResult> {
  const measuredAt = Date.now();
  const limit = clampLimit(config, input.limit);
  const toolPayloadOnly = input.surface === 'tool_payloads';
  return {
    measuredAt,
    databaseSizeBytes: sql.databaseSize,
    limit,
    grouped: toolPayloadOnly
      ? {
          rowsExamined: 0,
          rows: 0,
          contentBytes: 0,
          eligibleRows: 0,
          eligibleContentBytes: 0,
          ftsRowsPresent: 0,
          ftsRowsMissing: 0,
          nextCursor: null,
          hasMore: false,
        }
      : measureGroupedSlice(sql, config, measuredAt, input.cursor?.grouped, limit),
    toolPayloads: await measureToolPayloadSlice(
      sql,
      env,
      config,
      measuredAt,
      input.cursor?.toolPayload,
      limit,
      input.cutoffCreatedAt,
      input.maxEligibleBytes,
      input.deadlineMs
    ),
  };
}
